/* ==================== src/client/55-status-card.js ====================
 * 主会话里的 `/ai-course` 实时状态卡片
 *
 * 挂载点：`conversation.chat.commandview`（keyed / session 作用域）—— 宿主 ui-chat 的
 * 命令节点把每条斜杠命令渲染成一张卡，并按**命令名**派发到这个槽（`entryKey = command.name`，
 * 见 dsh-client-ui-chat 的 CommandNodeView）。我们只接管 `ai-course`，其他命令仍走宿主的通用卡。
 *
 * 实时性从哪来：
 *   `/ai-course` 的处理期间宿主只在**结束时**写会话日志（`command/done`），中间没有任何
 *   公开的推送面。所以状态由 host 的会话级状态表维护（src/host/15-status.mjs），这里按
 *   `sessionId` 轮询 `status.get`。轮询**只在需要时进行**：
 *     · 卡片处于「进行中」→ 每 1.2s 一次
 *     · 已结束（`command/done` 已到）或状态已失效 → 立即停表
 *   `sessionId` 来自槽的框架 props（ui-session 的 `props: ['sessionId']`），不猜、不从 DOM 抠。
 *
 * 不变量：
 *   · 只读：卡片从不写课程库；点「打开课程」是纯导航（先 `AIC_NAV.open` 再 `layout.selectPanel`）
 *   · 文案全部走 locale 表（组件代码里零中文字面量，脚本会断言）
 *   · 任何取数失败都不打断界面：降级成一行「推导中…」而不是白屏
 * ========================================================================== */

/* 轮询节奏：推导通常 ≥10s，1.2s 足够「实时」，也不至于把 RPC 打满 */
const AIC_STATUS_POLL_MS = 1200
/* 兜底停表：即使状态一直停在 running，也不会无限轮询（10 分钟后交给「已失效」文案） */
const AIC_STATUS_MAX_POLLS = 500
/* 超过这个时长没有更新，视为宿主重启后残留的状态 */
const AIC_STATUS_STALE_MS = 5 * 60 * 1000

/* 类名一律写成**完整字面量**（不做字符串拼接）：scripts/check.mjs 据此断言
   「代码里出现的每个 aic- 类都能在 styles.css 里找到规则」，拼出来的半截名会让那条断言失效。 */
const AIC_CMD_CLASS = {
  running: 'aic-cmd aic-cmd--running',
  done: 'aic-cmd aic-cmd--done',
  error: 'aic-cmd aic-cmd--error',
}

/** 秒 → 人读的「已用时 N 秒 / N 分 M 秒」。 */
function aicElapsedText (t, seconds) {
  const s = Math.max(0, Math.floor(Number(seconds) || 0))
  if (s < 60) return t('cmd.elapsed', { s: s })
  return t('cmd.elapsedMin', { m: Math.floor(s / 60), s: s % 60 })
}

/** 卡片图标：进行中转圈、完成对勾、失败叹号（全部 currentColor，跟随状态色）。 */
function AicStatusGlyph (props) {
  if (props.phase === 'done') {
    return h('svg', { className: 'aic-cmd__glyph', viewBox: '0 0 16 16', 'aria-hidden': 'true' },
      h('path', { d: 'M3.5 8.6l3 3 6-7', fill: 'none', stroke: 'currentColor', strokeWidth: '1.6', strokeLinecap: 'round', strokeLinejoin: 'round' }))
  }
  if (props.phase === 'error') {
    return h('svg', { className: 'aic-cmd__glyph', viewBox: '0 0 16 16', 'aria-hidden': 'true' },
      h('path', { d: 'M8 3.6v5.2', fill: 'none', stroke: 'currentColor', strokeWidth: '1.6', strokeLinecap: 'round' }),
      h('path', { d: 'M8 11.6v.6', fill: 'none', stroke: 'currentColor', strokeWidth: '1.8', strokeLinecap: 'round' }))
  }
  return h('svg', { className: 'aic-cmd__glyph aic-cmd__glyph--spin', viewBox: '0 0 16 16', 'aria-hidden': 'true' },
    h('circle', { cx: '8', cy: '8', r: '5.4', fill: 'none', stroke: 'currentColor', strokeWidth: '1.6', strokeOpacity: '0.25' }),
    h('path', { d: 'M8 2.6a5.4 5.4 0 0 1 5.4 5.4', fill: 'none', stroke: 'currentColor', strokeWidth: '1.6', strokeLinecap: 'round' }))
}

/**
 * 一条 `/ai-course` 命令的卡片。
 * `props.node` 由宿主传入（`{ commandId, name, args, outcome }`），`props.sessionId` 来自会话作用域。
 */
function AicCourseCommandCard (props) {
  const t = props.t
  const command = props.node || {}
  const sessionId = props.sessionId
  const commandId = command.commandId === undefined || command.commandId === null ? '' : String(command.commandId)
  const settled = command.outcome !== null && command.outcome !== undefined

  const [status, setStatus] = React.useState(null)
  /* `now` 只用于「已用时」推进：每次轮询都能重算，不需要单独的秒表 */
  const [nowMs, setNowMs] = React.useState(() => Date.now())
  /* `settled` 由 props 计算，但轮询 effect 只依赖 sessionId；
     用 ref 让 tick 读到最新值，命令一结束就停表（不再空转 10 分钟）。 */
  const settledRef = React.useRef(settled)
  settledRef.current = settled

  React.useEffect(() => {
    if (!sessionId) return undefined
    let alive = true
    let timer = null
    let polls = 0
    let stopped = false
    const tick = () => {
      polls += 1
      aicRpc('status.get', { sessionId: sessionId })
        .then((value) => {
          if (!alive) return
          setStatus(value || null)
          /* 命令结束 / 状态已 done|error → 这一轮之后不再排下一次；
             拿不到状态但命令还在跑（宿主还没写入）→ 继续等，否则会错过整段推导。 */
          if (!AIC_COURSES_CORE.shouldPollStatus(value && value.phase, settledRef.current)) stopped = true
        })
        .catch(() => {
          if (!alive) return
          setStatus(null)
          /* 取数失败：命令已结束就停；否则继续重试 */
          if (settledRef.current) stopped = true
        })
        .then(() => {
          if (!alive || stopped || polls >= AIC_STATUS_MAX_POLLS) return
          timer = setTimeout(tick, AIC_STATUS_POLL_MS)
        })
    }
    tick()
    return () => { alive = false; if (timer) clearTimeout(timer) }
  }, [sessionId])

  /* 「已用时」的心跳：只在状态还算新鲜时推进，避免给一份死状态计时 */
  const livePhase = status ? status.phase : ''
  React.useEffect(() => {
    if (settled || livePhase !== 'running') return undefined
    const id = setInterval(() => setNowMs(Date.now()), 1000)
    return () => clearInterval(id)
  }, [settled, livePhase])

  /* 卡片只认**这一条命令**的状态：命令 id 对不上（上一轮的残留）就什么也不显示 */
  const fresh = !!status && (!status.commandId || !commandId || status.commandId === commandId)
  const stale = fresh && !settled && status.phase === 'running'
    && nowMs - Number(status.updatedAt || 0) > AIC_STATUS_STALE_MS

  if (!fresh) {
    /* 拿不到状态（宿主重启 / RPC 不可达 / 还没写上）→ 一行最小占位，不猜进度 */
    return h('div', { className: 'aic-cmd' },
      h('div', { className: 'aic-cmd__row' },
        h(AicStatusGlyph, { phase: settled ? 'done' : 'running' }),
        h('span', { className: 'aic-cmd__title' }, t('cmd.title')),
        h('span', { className: 'aic-cmd__step' }, t('cmd.deriving')),
      ))
  }

  const phase = status.phase === 'done' ? 'done' : status.phase === 'error' ? 'error' : 'running'
  const step = t('cmd.step.' + (status.key || 'start'))
  const seconds = settled || phase !== 'running' || stale
    ? Math.max(0, (Number(status.updatedAt || 0) - Number(status.startedAt || 0)) / 1000)
    : Math.max(0, (nowMs - Number(status.startedAt || 0)) / 1000)
  const badge = phase === 'done' ? t('cmd.done') : phase === 'error' ? t('cmd.failed') : t('cmd.deriving')
  const courseName = status.courseName ? t('cmd.ofCourse', { name: status.courseName }) : ''
  /* 视觉态：失效（stale）优先于「进行中」，免得卡片看起来还在跑 */
  const viewPhase = stale ? 'error' : phase

  return h('div', { className: AIC_CMD_CLASS[viewPhase] },
    h('div', { className: 'aic-cmd__row' },
      h(AicStatusGlyph, { phase: viewPhase }),
      h('span', { className: 'aic-cmd__title' }, t('cmd.title')),
      h('span', { className: 'aic-cmd__badge' }, stale ? t('cmd.stalled') : badge),
    ),
    h('div', { className: 'aic-cmd__row aic-cmd__row--sub' },
      h('span', { className: 'aic-cmd__step' }, stale ? t('cmd.stalledHint') : step),
      h('span', { className: 'aic-cmd__meta' },
        aicElapsedText(t, seconds),
        courseName ? ' · ' + courseName : '',
      ),
    ),
    phase === 'error' && status.error
      ? h('div', { className: 'aic-cmd__error' }, status.error)
      : null,
    phase === 'done' && status.courseId
      ? h('div', { className: 'aic-cmd__row aic-cmd__row--act' },
        h('button', {
          className: 'aic-cmd__open',
          type: 'button',
          onClick: () => aicOpenCourse(props.ctx, status.courseId),
        }, t('cmd.open')))
      : null,
  )
}

/**
 * 「打开课程」：切到课程面板 **并** 直接进这门课的**大纲**（不是停在课程库列表）。
 *
 * 顺序很重要：**先发导航请求，再切面板** —— 面板是切过去才挂载的，
 * 反过来的话广播时还没有监听器，请求会丢掉（`AIC_NAV` 里有挂起补发兜底）。
 * `ctx.layout.selectPanel(id)` 是 doc/04 §2.3 记录过的客户端服务；取不到就只做导航
 * （侧边栏图标一直在，用户仍能自己点过去）。
 */
function aicOpenCourse (ctx, courseId) {
  /* 统一走外壳里的 `aicOpenCourseIn`：导航 + 切面板（顺序与兜底都在那里） */
  aicOpenCourseIn(ctx, courseId, 'outline')
}

/**
 * 注册到主会话的命令卡槽。
 * 槽由 ui-chat 在它的命令节点里声明（keyed），用 `inject` 等到声明出现再注册 ——
 * 直接 `register` 会在槽尚未声明时抛「slot ... is not declared」。
 */
function aicRegisterStatusCard (ctx, slots, t) {
  const disposers = []
  if (!slots || typeof slots.inject !== 'function') return disposers
  disposers.push(
    slots.inject('conversation.chat.commandview', () => slots.register(
      { name: 'conversation.chat.commandview', key: 'ai-course' },
      (props) => h(AicCourseCommandCard, Object.assign({}, props, { ctx: ctx, t: t })),
    )),
  )
  return disposers
}
