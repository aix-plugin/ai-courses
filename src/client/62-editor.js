/* ==================== src/client/62-editor.js ====================
 * **可复用的课程编辑器**：编辑弹窗 + 生成弹窗 + 提交/刷新一套逻辑
 *
 * 为什么单独一段：**两个宿主**要用同一套编辑能力 ——
 *   ① 课程面板的大纲页（`90-app.js` 的 `AicCoursesApp`）
 *   ② 主会话里的**大纲卡片**（`65-outline-card.js`，本期新增）
 * 复制一份出来会立刻产生两条真相（字段、动作列表、失败文案都会漂移），
 * 所以做成组件：谁用谁传 `courseId` 与 `onChanged`。
 *
 * 边界（有意为之）：
 *   · 组件**自己**管弹窗开关、自己调 `outline.revise` 与 `courses.read` 刷新 ——
 *     调用方不必知道 host 的动作列表长什么样。
 *   · 弹窗目标每次都按 **courseId 现查的数据**重新解析；引用失效就不弹（06 §6）。
 *   · `disabled`（只读降级）时保存与结构操作一律禁用。
 * ========================================================================== */

/**
 * 课程编辑器（无 UI 外壳，只负责「弹窗 + 提交」）。
 * @param {object} props
 *   `{ courseId, t, disabled?, onChanged?, children(api) }`
 *   `onChanged` 在每次成功提交后调用（调用方据此重新取数）。
 *   `children` 收到 `{ course, refresh, openEdit, openGenerate, notice }`。
 */
/**
 * **生成状态的唯一轮询点**（面板这一层）。
 *
 * 为什么不能只放在生成弹窗里：`/ai-course` 那种「发起后关掉弹窗」的流程下，弹窗一卸，
 * 轮询就没了 —— 界面上什么都不会动。放在这里之后：
 *   · 有活跃任务 → 1.5s 一次 `generation.status`；
 *   · 任务**刚结束** → 立刻回调 `onSettled`（调用方据此重取课程数据，状态点翻成「已生成」）；
 *   · 没有活跃任务 → 停表，零请求。
 *
 * @param {string} courseId
 * @param {() => void} onSettled 任务从「活跃」变成「结束」时调用一次
 * @param {number} [nonce] 外部「踢一下」轮询：空闲停表后，发起生成时自增它重启轮询
 * @returns `{ task, states }`：`task` 是当前/最近一条任务快照（给进度条用），
 *          `states` 是 `kpId → queued|running|done|failed`（给行末状态点用）
 */
function useGenerationStatus (courseId, onSettled, nonce) {
  const [task, setTask] = React.useState(null)
  const [states, setStates] = React.useState({})
  /* 用 ref 记住「上一次是不是还在跑」，避免把 onSettled 放进依赖里造成重复轮询 */
  const settledRef = React.useRef(null)
  const onSettledRef = React.useRef(onSettled)
  onSettledRef.current = onSettled

  React.useEffect(() => {
    if (!courseId) return undefined
    let alive = true
    let timer = null
    /* 失败退避：网络抖动/宿主重启不应该让状态永久停在旧值 */
    let failures = 0
    const retryDelays = [2000, 5000, 10000]
    const tick = () => {
      aicRpc('generation.status', { courseId: courseId })
        .then((res) => {
          if (!alive) return
          if (!res) throw new Error('empty-status')
          failures = 0
          const next = res.task || null
          setTask(next)
          if (res.states) setStates(res.states)
          const active = !!(res.active && (res.active.state === 'queued' || res.active.state === 'running'))
          /* 从「活跃」翻到「不活跃」→ 通知调用方重取一次（拿正文与「已生成」） */
          if (settledRef.current === true && !active) {
            settledRef.current = false
            if (onSettledRef.current) onSettledRef.current()
          }
          if (active) settledRef.current = true
          if (active) timer = setTimeout(tick, 1500)
        })
        .catch((err) => {
          if (!alive) return
          const code = err && err.code
          /* 方法不存在 / 被拒 / 没有会话：重试也没用，静默停下（界面不谎报进度） */
          if (code === 'unknown-method' || code === 'http-404' || code === 'forbidden' || code === 'no-agent') return
          if (failures < retryDelays.length) {
            const wait = retryDelays[failures++]
            timer = setTimeout(tick, wait)
          }
        })
    }
    tick()
    return () => { alive = false; if (timer) clearTimeout(timer) }
    /* `courseId` 变化时重起；`nonce` 变化 = 刚发起了一次生成（空闲时轮询已停表，
       必须重启一次，否则任务开始了也没人再去问状态）。
       `tick` 自己按「是否活跃」决定要不要继续排下一次 */
  }, [courseId, nonce])

  return { task: task, states: states }
}

/**
 * 取「主视图正在看」的会话 id（生成要用它当 `agentId`）。
 *
 * ⚠️ **不再退而取「最近更新的会话」**：面板全屏时 mainView 为 0 是正常状态，
 * 拿最近更新的会话当生成目标，内容会写进用户根本没想到的那个会话。猜不到就回空串，
 * 由 GenerateModal 给出「请先打开一个会话」的可操作提示，而不是静默挂错会话。
 *
 * 顺序：`sessions.active()`（若有）→ 快照里 `retainedBy.mainView > 0` 的那个。
 */
function aicActiveSessionId (ctx) {
  try {
    const sessions = ctx && typeof ctx.get === 'function' ? ctx.get('sessions') : null
    if (!sessions) return ''
    if (typeof sessions.active === 'function') {
      const active = sessions.active()
      if (active && typeof active.id === 'string' && active.id) return active.id
    }
    if (!sessions.list || typeof sessions.list.getSnapshot !== 'function') return ''
    const snap = sessions.list.getSnapshot() || {}
    const byId = snap.byId || {}
    for (const id of Object.keys(byId)) {
      if ((byId[id] && byId[id].retainedBy && byId[id].retainedBy.mainView) > 0) return id
    }
    return ''
  } catch {
    return ''
  }
}

function CourseEditor (props) {
  const t = props.t
  const [version, setVersion] = React.useState(0)
  const [modal, setModal] = React.useState(null)
  const [notice, setNotice] = React.useState('')

  /* 编辑期间**保留上一份数据**（useResource 的既有语义）：加载中不闪、弹窗里的表单不被卸载，
     所以「改完立刻重取」不会把正在编辑的字段打回原值。 */
  const [state, reload] = useResource(
    () => (props.courseId ? aicRpc('courses.read', { courseId: props.courseId }) : Promise.resolve(null)),
    [props.courseId, version],
  )
  const data = state.data
  const course = data && data.course ? data.course : null
  const kpProgress = (data && data.kpProgress) || {}
  const readOnly = !!(data && data.readOnly)
  const corrupt = !!(data && data.corrupt)
  const disabled = !!props.disabled || readOnly

  const refresh = () => setVersion((v) => v + 1)
  const changed = () => { if (typeof props.onChanged === 'function') props.onChanged() }

  /* 发起生成后自增：轮询在空闲时会停表，不踢一下它就不会知道刚创建的任务。
     这是「点开始生成 → 回到大纲页看不到生成状态」的根因修复。 */
  const [genNonce, setGenNonce] = React.useState(0)
  const kickGeneration = () => setGenNonce((n) => n + 1)

  /* 生成状态：`courses.read` 带回「已生成」/「生成中」两张映射；**有活跃任务时按 1.5s 轮询**
     （空闲时零请求）。轮询放在编辑器这一层，于是「大纲页 / 学习页 / 生成弹窗」看到的是**同一份**
     实时状态。任务一结束就 `refresh()` 重取课程数据（行末状态点翻成「已生成」）**并且**通知
     调用方（面板借此自增 `contentVersion`，让**正在看的学习页**也重取正文，不必手动刷新）。 */
  const live = useGenerationStatus(props.courseId, () => { refresh(); changed() }, genNonce)
  const taskStates = live.states
  const assets = (data && data.assets) || {}

  /** 提交一批修订动作：整批一个事务，失败给出原因（不落库）。 */
  const submitOps = (ops) => {
    setModal(null)
    aicRpc('outline.revise', { courseId: course.id, operations: ops }).then(
      () => { setNotice(''); refresh(); changed() },
      (err) => setNotice(String((err && err.message) || err)),
    )
  }

  /** 发起「整章 / 整门课」的批量生成（二次确认之后调用）。 */
  const startScope = (scope, chapterId) => {
    setModal(null)
    aicRpc('generation.start', {
      courseId: props.courseId,
      scope: scope,
      targetIds: chapterId ? [chapterId] : [],
      prompt: '',
      agentId: aicActiveSessionId(props.ctx),
    }).then(
      () => { setNotice(''); refresh(); changed(); kickGeneration() },
      (err) => setNotice(String((err && err.message) || err)),
    )
  }
  /** 批量生成会覆盖已生成内容 → 先确认；确认框里写清范围与数量。 */
  const confirmScope = (scope, ch) => {
    const kps = scope === 'course' ? AIC_COURSES_CORE.courseKps(course) : (ch ? ch.knowledgePoints || [] : [])
    const label = scope === 'course'
      ? (course ? course.name : '')
      : (ch ? t('modal.factChapterValue', { n: ch.order, name: ch.name }) : '')
    return h(ConfirmModal, {
      key: 'confirm-gen-' + scope,
      t: t,
      title: t('modal.genScopeTitle'),
      body: t('modal.genScopeBody', { scope: label, n: kps.length }),
      detail: t('modal.genScopeDetail'),
      confirmLabel: t('modal.genScopeConfirm'),
      onClose: () => setModal(null),
      onConfirm: () => startScope(scope, scope === 'chapter' && ch ? ch.id : ''),
    })
  }

  let modalNode = null
  if (modal && course) {
    if (modal.kind === 'confirm') {
      const next = modal.next || {}
      const ch = next.chapterId
        ? ((course.outline && course.outline.chapters) || []).filter((c) => c.id === next.chapterId)[0]
        : null
      modalNode = confirmScope(next.scope || 'course', ch)
    } else if (modal.kind === 'generate') {
      const found = aicFindKp(course, modal.kpId)
      if (found) {
        modalNode = h(GenerateModal, {
          key: 'generate-' + found.kp.id,
          t: t, ch: found.ch, kp: found.kp, kpProgress: kpProgress,
          courseId: props.courseId,
          /* 生成要用会话的 Agent（精确路由没有会话上下文，E-26）→ 带上主视图当前会话 id */
          agentId: aicActiveSessionId(props.ctx),
          hasAsset: !!assets[found.kp.id],
          state: taskStates[found.kp.id] || '',
          onClose: () => setModal(null),
          /* 发起成功 → **关闭弹窗**（状态在大纲视图上看）；关掉后由 `useGenerationStatus`
             继续轮询，行末状态点与顶部进度条实时推进；任务结束由 hook 回调 `refresh` 重取数据。 */
          onStarted: () => { setModal(null); refresh(); changed(); kickGeneration() },
        })
      }
    } else if (modal.type === 'course') {
      modalNode = h(EditModal, {
        key: 'edit-course',
        t: t, kind: 'course', course: course, disabled: disabled,
        onClose: () => setModal(null), onSubmit: submitOps,
        /* **不给 onGenerate**：课程级只编辑基础属性（名称/描述/标签/难度）。
           整门课的生成入口已按用户需求从大纲页移除（2026-10-18）；
           内容生成仍可按章节 / 按知识点发起（各自的编辑窗底部）。 */
      })
    } else if (modal.type === 'chapter') {
      const ch = ((course.outline && course.outline.chapters) || []).filter((c) => c.id === modal.chapterId)[0]
      if (ch) {
        modalNode = h(EditModal, {
          key: 'edit-chapter-' + ch.id,
          t: t, kind: 'chapter', course: course, ch: ch, disabled: disabled,
          onClose: () => setModal(null), onSubmit: submitOps,
          onGenerate: () => setModal({ kind: 'confirm', next: { kind: 'genScope', scope: 'chapter', chapterId: ch.id } }),
        })
      }
    } else {
      const found = aicFindKp(course, modal.kpId)
      if (found) {
        modalNode = h(EditModal, {
          key: 'edit-kp-' + found.kp.id,
          t: t, kind: 'kp', course: course, ch: found.ch, kp: found.kp, disabled: disabled,
          onClose: () => setModal(null), onSubmit: submitOps,
          /* 知识点生成：改完属性直接进入生成弹窗（属性变更在这里**不自动保存**，
             避免"只想生成"却把半填的表单写进去） */
          onGenerate: () => setModal({ kind: 'generate', kpId: found.kp.id }),
        })
      }
    }
  }
  /* 目标消失（例如别处删掉了）→ 清掉弹窗状态，避免下一次数据更新又把它弹出来 */
  React.useEffect(() => {
    if (modal && course && !modalNode) setModal(null)
  })

  const api = {
    course: course,
    taskStates: taskStates,
    assets: assets,
    task: live.task,
    data: data,
    state: state.status,
    error: state.error,
    kpProgress: kpProgress,
    readOnly: readOnly,
    corrupt: corrupt,
    disabled: disabled,
    notice: notice,
    setNotice: setNotice,
    refresh: refresh,
    /* 批量修订：大纲的「章节编辑」（+/-）直接用它 —— 与弹窗保存走**同一条** outline.revise
       事务与同一次数据刷新，避免出现"弹窗保存会刷新、+/- 不刷新"的两套行为。 */
    submitOps: submitOps,
    openEdit: (type, target) => {
      if (type === 'course') setModal({ kind: 'edit', type: 'course' })
      else if (type === 'chapter') setModal({ kind: 'edit', type: 'chapter', chapterId: target.id })
      else setModal({ kind: 'edit', type: 'kp', kpId: target.kp.id })
    },
    /* 打开生成弹窗。**两种调用口径都收**：大纲/学习页传 `(ch, kp)`，卡片式调用可能只给 kp。
       签名不一致会让"点了没反应/报 undefined"——这里统一成 kpId。 */
    openGenerate: (ch, kp) => {
      /* 两种调用口径：大纲/学习页传 `(ch, kp)`；防御性地接受「只给 kp」。 */
      const target = (kp && kp.id) ? kp : (ch && ch.id && ch.contentType ? ch : null)
      if (!target) {
        /* 参数不对是**代码**问题，不该弹给用户；记一笔并返回，不打开空弹窗 */
        console.warn('[ai-courses] openGenerate 缺少知识点参数')
        return
      }
      setModal({ kind: 'generate', kpId: target.id })
    },
    /* 供调用方复用同一套「失败给原因」的通道（例如卡片里点生成但宿主还没有链路） */
    submit: submitOps,
  }

  return h(React.Fragment, null, props.children(api), modalNode)
}
