/* ==================== src/client/58-agent-dock.js ====================
 * **主会话的常驻 agent 状态条**（`conversation.input.dock`）
 *
 * 诉求：生成知识点内容时，要像 `/ai-course` 那样在主会话窗口里看见 agent 在跑。
 *
 * 它与另外两块的分工：
 *   · `55-status-card`：斜杠命令卡片（`/ai-course` 那条命令的过程），**只在命令那条回合**；
 *   · `65-outline-card`：回合末尾的大纲卡片（产物）；
 *   · **本文件**：一个**常驻**状态条 —— 生成**不产生回合**，所以它挂在输入框上方那个
 *     list/session 槽（`conversation.input.dock`）里，切到任何面板都能看见「agent 正在写什么」。
 *
 * 槽位选择依据（04 号文档 E-35）：该槽 `kind: list` / `scope: session`，由 ui-conversation 声明，
 * 位置在输入框之上一行，**与「当前回合」无关**。
 * ========================================================================== */

/** Ai 课程的面板 id（点状态条跳过去用）。 */
const AIC_PANEL_ID = 'ai-courses'

/** 轮询节奏：有任务在跑时 1.5s；空闲时把间隔拉长（只为发现「别处发起的生成」）。 */
const AIC_DOCK_BUSY_MS = 1500
const AIC_DOCK_IDLE_MS = 20000

/**
 * 主会话里的 agent 状态条。
 * @param {object} props 槽给的 props（`sessionId`）+ 本插件注入的 `t` / `ctx`
 */
function AicAgentDock (props) {
  const t = props.t
  const [rows, setRows] = React.useState([])
  const [loaded, setLoaded] = React.useState(false)

  React.useEffect(() => {
    let alive = true
    let timer = null
    const tick = () => {
      aicRpc('generation.active', {})
        .then((res) => {
          if (!alive) return
          const list = (res && res.tasks) || []
          setRows(list)
          setLoaded(true)
          /* 有任务 → 快速跟；没有 → 慢速探（发现「别处刚发起」的生成），不再无限快轮询 */
          timer = setTimeout(tick, list.length ? AIC_DOCK_BUSY_MS : AIC_DOCK_IDLE_MS)
        })
        .catch(() => {
          if (!alive) return
          setLoaded(true)
          timer = setTimeout(tick, AIC_DOCK_IDLE_MS)
        })
    }
    tick()
    return () => { alive = false; if (timer) clearTimeout(timer) }
  }, [])

  if (!loaded || !rows.length) return null

  return h(
    'div',
    { className: 'aic-dock', role: 'status', 'aria-live': 'polite' },
    rows.map((row) => {
      const task = row.task || {}
      /* 与大纲页顶部进度条**共用**同一个纯函数：计数 / 比例 / active / 失败项口径不允许两套 */
      const v = AIC_COURSES_CORE.taskProgressView(task, null)
      if (!v.visible) return null
      return h(
        'div',
        { className: 'aic-dock__row', key: row.courseId + ':' + (task.id || '') },
        h(
          'span',
          { className: 'aic-dock__main' },
          h(GenIcon, {
            t: t,
            state: v.stateKey === 'done' ? '已生成' : (v.stateKey === 'failed' ? '生成失败' : '生成中'),
            scope: 'Kp',
          }),
          h('span', { className: 'aic-dock__label' },
            t(v.active ? 'dock.generating' : 'dock.finished', { course: row.courseName || t('dock.unknownCourse') })),
          row.kpName && v.active
            ? h('span', { className: 'aic-dock__kp' }, t('dock.writingKp', { kp: row.kpName }))
            : failedSummary(h, t, v),
          h('span', { className: 'aic-muted' }, t('dock.count', { done: v.finished, total: v.total })),
        ),
        h(
          'span',
          { className: 'aic-dock__tools' },
          h('button', {
            className: 'aic-btn aic-btn--sm',
            type: 'button',
            /* **导航 + 切面板**一起做：只发导航的话，面板没打开时"点了没反应"（真机踩过） */
            onClick: () => aicOpenCourseIn(props.ctx, row.courseId, 'outline'),
          }, t('dock.openCourse')),
        ),
      )
    }),
  )
}

/** 跑完（或没在跑）时显示失败摘要；没失败就什么都不显示。 */
function failedSummary (h, t, v) {
  if (!v.failed.length) return null
  return h('span', { className: 'aic-dock__failed' }, t('outline.progressFailed', { n: v.failed.length }))
}

/** 注册主会话的常驻状态条（槽由 ui-conversation 声明 → 必须 inject 等声明）。 */
function aicRegisterAgentDock (ctx, slots, t) {
  const disposers = []
  if (!slots || typeof slots.inject !== 'function') return disposers
  disposers.push(
    slots.inject('conversation.input.dock', () => slots.register(
      { name: 'conversation.input.dock', id: 'dsh-ai-courses/agent-dock' },
      (props) => h(AicAgentDock, Object.assign({}, props, { ctx: ctx, t: t })),
    )),
  )
  return disposers
}
