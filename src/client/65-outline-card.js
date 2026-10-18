/* ==================== src/client/65-outline-card.js ====================
 * **主会话里的课程大纲卡片**：`/ai-course` 生成大纲后，把大纲视图作为独立控件展示在回复末尾
 *
 * 挂载点：`conversation.chat.turnTail`（ui-chat 声明的 list / session 槽）——
 * 宿主在每个回合末尾渲染它，`owner` 给 `{ turn, seq, openFile }`，框架另给 `sessionId`。
 *
 * 「哪一轮该显示」由**时间**判定，不靠猜：
 *   状态表里记着这次推导的 `startedAt` / `updatedAt`，而 turn 上有 `start` / `end` 事件时间
 *   → 只有「推导落在本回合时间内」的那个回合才渲染卡片。于是：
 *     · 一次 `/ai-course` 最多出现一张卡片（不会每回合都长一张）
 *     · 刷新页面后仍在（状态表在宿主内存里；DSH 重启后不显示 —— 与进度卡同一口径）
 *     · 同一会话连做几次推导，各自落在各自的回合里
 *
 * 编辑能力**不是**这里另写一套：`CourseEditor`（62-editor.js）与课程面板共用同一份，
 * 改完 `outline.revise` 成功后卡片自己重取 `courses.read`。
 * ========================================================================== */

/**
 * 本回合生成的那几门课（按落库时间落在 turn 的时间窗内判定）。
 *
 * 实现放在 `10-core.js` 的 `coursesOfTurn` 里 —— 那一段是**纯逻辑段**，能在 node 里
 * 真实求值并断言（doc/09 §7.2：不许拿 mock 渲染当验证）。这里只做一次转手，
 * 让组件代码读起来仍然自明。
 */
function aicCoursesOfTurn (courses, turn) {
  return AIC_COURSES_CORE.coursesOfTurn(courses, turn)
}

/** 卡片头部的书本图标（与侧边栏面板图标同款外形，尺寸更小）。 */
function OutlineCardIcon () {
  return h(
    'svg',
    {
      className: 'aic-outcard__icon', width: 16, height: 16, viewBox: '0 0 24 24', fill: 'none',
      stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round', strokeLinejoin: 'round',
      'aria-hidden': 'true', focusable: 'false',
    },
    h('path', { key: 'a', d: 'M4 5.5A1.5 1.5 0 0 1 5.5 4H10a2 2 0 0 1 2 2v13a1.5 1.5 0 0 0-1.5-1.5H5.5A1.5 1.5 0 0 1 4 16V5.5Z' }),
    h('path', { key: 'b', d: 'M20 5.5A1.5 1.5 0 0 0 18.5 4H14a2 2 0 0 0-2 2v13a1.5 1.5 0 0 1 1.5-1.5h5A1.5 1.5 0 0 0 20 16V5.5Z' }),
  )
}

/**
 * 一张课程大纲卡片。
 * @param {object} props 槽给的 props（`sessionId`、`turn`、`seq`）+ 本插件注入的 `t` / `ctx`
 */
function AicOutlineCard (props) {
  const t = props.t
  const core = AIC_COURSES_CORE
  const sessionId = props.sessionId
  const turn = props.turn
  /* 本回合该显示的课程 —— 在**任何 hook 之前**先算（拿不到就整卡不渲染，避免每回合长一张空卡） */
  const mine = aicCoursesOfTurn(props.courses, turn)
  const latest = mine.length ? mine[mine.length - 1] : null

  const [status, setStatus] = React.useState(null)
  const [loaded, setLoaded] = React.useState(false)
  const [refreshToken, setRefreshToken] = React.useState(0)
  const [collapsed, setCollapsed] = React.useState(false)

  /* 取本会话的推导状态（含课程列表）。挂载时取一次 + 每次编辑成功后重取：
     卡片不需要轮询 —— 进度由 55-status-card 负责，这里只关心「有没有生成过课」。 */
  React.useEffect(() => {
    if (!sessionId) return undefined
    let alive = true
    aicRpc('status.get', { sessionId: sessionId })
      .then((value) => { if (alive) { setStatus(value || null); setLoaded(true) } })
      .catch(() => { if (alive) { setStatus(null); setLoaded(true) } })
    return () => { alive = false }
  }, [sessionId, refreshToken])

  if (!latest) return null

  const onChanged = () => setRefreshToken((n) => n + 1)

  /* 课程数据 + 弹窗 + 修订提交都走共享编辑器；这里只画卡片外壳。 */
  return h(CourseEditor, { courseId: latest.courseId, t: t, onChanged: onChanged }, (ed) => {
    const course = ed.course
    const total = Number(latest.kpCount) || 0
    const mastered = course ? core.masteredCount(course, ed.kpProgress || {}) : 0
    const ratio = total > 0 ? mastered / total : 0
    const chapters = course ? ((course.outline && course.outline.chapters) || []) : []

    return h(
      'section',
      { className: 'aic-outcard', 'aria-label': t('outcard.title') },
      h(
        'header',
        { className: 'aic-outcard__head' },
        h(OutlineCardIcon),
        h('span', { className: 'aic-outcard__title' }, t('outcard.title')),
        /* 课程名优先用**现取**的（改名后立刻正确），拿不到才回落到状态表里的快照 */
        h('span', { className: 'aic-outcard__name' }, (course && course.name) || latest.courseName),
        h('span', { className: 'aic-outcard__badge' }, t('outcard.editable')),
        h(
          'span',
          { className: 'aic-outcard__tools' },
          h('button', {
            className: 'aic-btn aic-btn--sm',
            type: 'button',
            disabled: !course,
            /* 与命令卡/状态条一致：导航 + 切面板（否则面板没打开时点了没反应） */
            onClick: () => aicOpenCourseIn(props.ctx, latest.courseId, 'outline'),
          }, t('outcard.openOutline')),
          h(IconButton, {
            name: 'prev',
            label: collapsed ? t('outcard.expand') : t('outcard.collapse'),
            pressed: collapsed,
            onClick: () => setCollapsed((v) => !v),
          }),
        ),
      ),

      /* 规模与学习进度：数据取状态表（会话级事实）与 courses.read（当前事实） */
      h(
        'div',
        { className: 'aic-outcard__meta' },
        h('span', null, t('outcard.scale', { chapters: chapters.length || Number(latest.chapterCount) || 0, kps: total })),
        h('span', { className: 'aic-outcard__progress' },
          h('span', null, t('outcard.progress')),
          h(ProgressBar, { t: t, ratio: ratio })),
        course && course.difficulty ? h('span', { className: 'aic-tag' }, course.difficulty) : null,
        course && (course.tags || []).length
          ? h('span', { className: 'aic-outcard__tags' },
              (course.tags || []).map((tag) => h('span', { className: 'aic-tag', key: tag }, tag)))
          : null,
      ),

      ed.notice ? h(Notice, null, ed.notice) : null,
      ed.state === 'error' && !course
        ? h(Notice, null, t('outcard.loadFailed'))
        : null,

      collapsed
        ? null
        : h(
            'div',
            { className: 'aic-outcard__body' },
            course
              ? h(OutlineView, {
                  t: t,
                  course: course,
                  kpProgress: ed.kpProgress || {},
                  variant: 'embed',
                  mode: 'edit',
                  readOnly: ed.readOnly,
                  corrupt: ed.corrupt,
                  disabled: ed.disabled,
                  onEdit: ed.openEdit,
                  /* 结构模式（章节编辑）在这张卡片上也保留 —— 它和面板用的是同一棵树 */
                  onStructure: ed.submitOps,
                  /* 课程/章节级的「生成」在面板里也是「M2 未接」的提示，这里保持一致 */
                  onGenerateCourse: () => ed.setNotice(t('outline.generateM2', { label: t('outline.generateCourse') })),
                  onGenerateChapter: () => ed.setNotice(t('outline.generateM2', { label: t('outline.generateChapter') })),
                  onGenerateKp: ed.openGenerate,
                })
              : h('div', { className: 'aic-muted' }, t('outcard.loading')),
          ),
    )
  })
}

/**
 * 注册到大纲卡槽。
 * `turnTail` 也是**别的包声明**的槽（ui-chat 的 turn-tail 节点声明它），因此同样走 `slots.inject`。
 */
function aicRegisterOutlineCard (ctx, slots, t) {
  const disposers = []
  if (!slots || typeof slots.inject !== 'function') return disposers
  disposers.push(
    slots.inject('conversation.chat.turnTail', () => slots.register(
      { name: 'conversation.chat.turnTail', id: 'dsh-ai-courses/outline-card' },
      (props) => h(AicOutlineCard, Object.assign({}, props, { ctx: ctx, t: t })),
    )),
  )
  return disposers
}
