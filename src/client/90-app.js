/* ==================== src/client/90-app.js ====================
 * 面板根组件 + 插件外壳（apply / createPlugin）
 *
 * 一个 `main` 面板内含三页（课程库 / 大纲 / 学习），靠面板内导航切换（06 §1）。
 * 课程数据只有两个来源：`courses.list`（卡片）与 `courses.read`（大纲与学习页）——
 * 都是 host 方法表里已有的方法，UI 不自造数据、不缓存第二份真相。
 * ========================================================================== */

/** 课程内按 id 找一个知识点（**必须带课程上下文**：kpId 只在课程内唯一，05 §4）。 */
function aicFindKp (course, kpId) {
  for (const x of AIC_COURSES_CORE.courseKps(course)) {
    if (x.kp.id === kpId) return x
  }
  return null
}

/** 侧边栏面板图标（M0 起就在用；`props.size` 由宿主传入）。 */
function CoursePanelIcon (props) {
  const size = (props && props.size) || 20
  return h(
    'svg',
    {
      width: size, height: size, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor',
      strokeWidth: 1.6, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': 'true', focusable: 'false',
    },
    h('path', { key: 'a', d: 'M4 5.5A1.5 1.5 0 0 1 5.5 4H10a2 2 0 0 1 2 2v13a1.5 1.5 0 0 0-1.5-1.5H5.5A1.5 1.5 0 0 1 4 16V5.5Z' }),
    h('path', { key: 'b', d: 'M20 5.5A1.5 1.5 0 0 0 18.5 4H14a2 2 0 0 0-2 2v13a1.5 1.5 0 0 1 1.5-1.5h5A1.5 1.5 0 0 0 20 16V5.5Z' }),
  )
}

/** 加载中 / 读失败 的整页态（课程库之外的两种页面共用）。 */
function PageState (props) {
  return h(
    'div',
    { className: 'aic-library' },
    props.error
      ? h(
          'div',
          { className: 'aic-error' },
          h('div', { className: 'aic-error__title' }, props.title),
          h('div', { className: 'aic-muted' }, props.body || ''),
          h('div', { style: { marginTop: '10px' } },
            h('button', { className: 'aic-btn', type: 'button', onClick: props.onRetry }, props.retry)),
        )
      : h('div', { className: 'aic-empty' }, h('div', { className: 'aic-empty__title' }, props.title)),
  )
}

function AicCoursesApp (props) {
  const t = props.t
  const core = AIC_COURSES_CORE
  const [view, setView] = React.useState('library')
  const [courseId, setCourseId] = React.useState(null)
  const [kpId, setKpId] = React.useState(null)
  const [filter, setFilter] = React.useState({ category: '', tags: [], query: '' })
  const [notice, setNotice] = React.useState('')
  const [version, setVersion] = React.useState(0)
  /* 删除课程：`{ id, name }`（待确认的目标）、进行中标记、失败原因 */
  /* 内容版本号：生成任务跑完后自增 → 学习页重新取一次内容资产（不必手动刷新） */
  const [contentVersion, setContentVersion] = React.useState(0)
  const [pendingDelete, setPendingDelete] = React.useState(null)
  const [deleting, setDeleting] = React.useState(false)
  const [deleteError, setDeleteError] = React.useState('')
  const [configOpen, setConfigOpen] = React.useState(false)

  const [libState, reloadLib] = useResource(() => aicRpc('courses.list', {}), [version])

  const refresh = () => setVersion((v) => v + 1)
  const updateFilter = (patch) => setFilter((prev) => Object.assign({}, prev, patch))

  /* 课程库设置保存成功：旧根下的课程可能已经不存在，退回课程库并重新取数。
     切换后**不重启**宿主即可看到新目录（host 的 store 已换根）。 */
  const configSaved = (info) => {
    setConfigOpen(false)
    setCourseId(null)
    setKpId(null)
    setView('library')
    setFilter({ category: '', tags: [], query: '' })
    setNotice(t('config.saved', { path: info.courseRoot }))
    reloadLib()
  }

  /**
   * 删除课程（**破坏性、仅用户**，07 号文档 OP-7）：先确认再删。
   *
   * 走 `courses.remove` —— host 侧删除的是**整个课程目录**（course.json / progress.json /
   * content-assets / media 全部一起走，E-27 的 node:fs 递归删除），删完刷新列表；
   * 如果删的正是当前打开的那门课，一并退回到课程库。
   */
  const requestDelete = (course) => { setDeleteError(''); setPendingDelete({ id: course.id, name: course.name || '' }) }
  const confirmDelete = () => {
    if (!pendingDelete) return
    const target = pendingDelete
    setDeleting(true)
    setDeleteError('')
    aicRpc('courses.remove', { courseId: target.id }).then(
      () => {
        setDeleting(false)
        setPendingDelete(null)
        setNotice(t('library.deleted', { name: target.name || target.id }))
        if (courseId === target.id) {
          setCourseId(null)
          setKpId(null)
          setView('library')
        }
        reloadLib()
      },
      (err) => {
        setDeleting(false)
        setDeleteError(String((err && err.message) || err))
      },
    )
  }

  /* 主会话的大纲卡片 →「打开完整大纲 / 学习」：卡片发一条插件内导航请求，这里切页。
     面板没挂载时（composed out）没有订阅者，`AIC_NAV.open` 静默丢弃 —— 卡片不是唯一入口。 */
  React.useEffect(() => AIC_NAV.on((req) => {
    if (!req || !req.courseId) return
    setNotice('')
    setCourseId(req.courseId)
    setKpId(req.kpId || null)
    setView(req.view === 'lesson' ? 'lesson' : 'outline')
  }), [])

  /* 课程数据、弹窗与修订提交都在 **CourseEditor**（62-editor.js）里 —— 主会话的大纲卡片用同一份实现，
     避免「面板能改、卡片不能改」的两条真相。导航与课程库仍由本组件负责。 */
  const renderContent = (ed) => {
    const course = ed.course
    const t = props.t
    const core = AIC_COURSES_CORE
    const rows = (libState.data || [])
    const kpProgress = ed.kpProgress
    const readOnly = ed.readOnly
    const corrupt = ed.corrupt

    /* 导航 */
    const openOutline = (id) => { ed.setNotice(''); setCourseId(id); setKpId(null); setView('outline') }
    const openLesson = (id, kp) => { ed.setNotice(''); setCourseId(id); setKpId(kp ? kp.id : null); setView('lesson') }
    const backToLibrary = () => { ed.setNotice(''); setView('library'); reloadLib() }

    /* ------------------------------------------------------------ 渲染 */
    let body = null
    if (view === 'library') {
      body = h(LibraryView, {
        t: t,
        courses: rows,
        status: libState.status,
        error: libState.error,
        filter: filter,
        notice: notice,
        onFilter: updateFilter,
        onClearFilters: () => setFilter({ category: '', tags: [], query: '' }),
        onOpenOutline: openOutline,
        onOpenLesson: (id) => openLesson(id, null),
        onOpenConfig: () => setConfigOpen(true),
        onRetry: reloadLib,
        onDelete: requestDelete,
      })
    } else if (ed.state === 'error' && !course) {
      const notFound = ed.error && ed.error.code === 'not-found'
      body = h(PageState, {
        title: notFound ? t('outline.notFoundTitle') : t('outline.errorTitle'),
        body: notFound ? '' : String((ed.error && ed.error.message) || ''),
        retry: t('library.retry'),
        error: !notFound,
        /* 课程不存在 → 回课程库（刷新列表）；其它读失败 → 重试这次读 */
        onRetry: () => (notFound ? (setView('library'), reloadLib()) : ed.refresh()),
      })
    } else if (!course) {
      body = h(PageState, { title: t('outline.loading'), retry: '', onRetry: () => {} })
    } else if (view === 'outline') {
      body = h(
        'div',
        null,
        ed.notice ? h(Notice, null, ed.notice) : null,
        h(OutlineView, {
          t: t,
          course: course,
          kpProgress: kpProgress,
          /* 行末 5 态的两项证据：任务状态（生成中/排队中/失败）与「已生成」凭据（信封存在） */
          taskStates: ed.taskStates,
          assets: ed.assets,
          /* 生成进度**只在主会话的常驻状态条**上展示（06 §3.6）——
             大纲页不再重复一份，避免同一件事两处显示、两处不一致。 */
          mode: 'edit',
          readOnly: readOnly,
          corrupt: corrupt,
          disabled: readOnly,
          onBack: backToLibrary,
          onEdit: ed.openEdit,
          /* 结构模式（章节编辑）的 +/- 走同一批修订事务 */
          onStructure: ed.submitOps,
          onGenerateCourse: () => ed.setNotice(t('outline.generateM2', { label: t('outline.generateCourse') })),
          onGenerateChapter: () => ed.setNotice(t('outline.generateM2', { label: t('outline.generateChapter') })),
          onGenerateKp: ed.openGenerate,
          onOpenLesson: (ch, kp) => openLesson(course.id, kp),
        }),
      )
    } else {
      const list = core.courseKps(course)
      const active = kpId ? (aicFindKp(course, kpId) || list[0]) : list[0]
      body = active
        ? h(LessonView, {
            t: t,
            course: course,
            ch: active.ch,
            kp: active.kp,
            itemStates: (ed.taskStates || {})[active.kp.id],
            version: contentVersion,
            onBack: backToLibrary,
            onOpenOutline: openOutline,
            onOpenKp: (ch, kp) => openLesson(course.id, kp),
            onGenerate: ed.openGenerate,
            onRegenerate: ed.openGenerate,
            /* 进度标记（05 §6.1 / Q-14）：打开 → 进行中；离开 → 已掌握 */
            onMark: (state) => {
              aicRpc('progress.mark', { courseId: course.id, kpId: active.kp.id, state: state }).catch(() => {})
            },
          })
        : h(PageState, { title: t('lesson.notFoundTitle'), retry: '', onRetry: () => {} })
    }

    return h(
      'div',
      { className: 'aic-root' },
      h('div', { className: 'aic-shell' }, h('div', { className: 'aic-main' }, body)),
    )
  }

  /* 面板外壳：课程数据 / 弹窗 / 修订全交给共享编辑器（62-editor.js）。
     删除确认弹窗挂在**这一层**（课程库与大纲页都可能触发），与编辑器的弹窗各管各的。 */
  return h(
    React.Fragment,
    null,
    h(CourseEditor, {
      courseId: courseId || '',
      t: props.t,
      ctx: props.ctx,
      /* 内容落库后：刷新课程数据（行末状态点变「已生成」）并让学习页重取正文 */
      onChanged: () => { refresh(); setContentVersion((v) => v + 1) },
    }, renderContent),
    pendingDelete
      ? h(ConfirmModal, {
          t: props.t,
          title: props.t('library.deleteTitle'),
          body: props.t('library.deleteBody', { name: pendingDelete.name || pendingDelete.id }),
          detail: props.t('library.deleteDetail'),
          confirmLabel: props.t('library.deleteConfirm'),
          loading: deleting,
          error: deleteError,
          onClose: () => { if (!deleting) { setPendingDelete(null); setDeleteError('') } },
          onConfirm: confirmDelete,
        })
      : null,
    configOpen
      ? h(ConfigModal, {
          t: props.t,
          onClose: () => setConfigOpen(false),
          onSaved: configSaved,
        })
      : null,
  )
}


/* ------------------------------------------------------------ 插件外壳 */

/**
 * 客户端插件对象。
 * ⚠️ 形状逐行抄自在装可用先例（dsh-notes-plugin / dsh-course-plugin，2026-10-14 实测生效）：
 *    `inject: ['slots']` 必须声明（否则 apply 在 slots 就绪前跑，整个 web boot 失败）；
 *    清理一律走 `ctx.effect`，**不要**从 apply 返回 disposer。
 */
function createPlugin () {
  return { name: 'dsh-ai-courses', inject: ['slots'], apply: aicCoursesApply }
}

function aicCoursesApply (ctx) {
  /* `ctx.get('slots')` + 优雅降级：直接访问 `ctx.slots` 在服务未就绪时会抛 */
  const slots = ctx.get('slots')
  if (!slots) {
    console.error('[ai-courses] slots 服务不可用，课程面板未注册')
    return
  }

  const doc = typeof document === 'undefined' ? null : document
  const nav = typeof navigator === 'undefined' ? null : navigator
  const t = AIC_COURSES_CORE.createT(AIC_COURSES_CORE.detectLocale(doc, nav))

  /* 样式：构建期内联（宿主不会自动加载包内 lib/styles.css —— 见 doc/03 §6 的定案），
     挂一个 <style> 并在停用/卸载时移除；不用 innerHTML。 */
  let styleEl = null
  try {
    if (doc && doc.createElement && doc.head) {
      styleEl = doc.createElement('style')
      styleEl.setAttribute('data-dsh-plugin', 'ai-courses')
      styleEl.textContent = AIC_COURSES_CSS
      doc.head.appendChild(styleEl)
    }
  } catch (err) {
    console.warn('[ai-courses] 样式注入失败：', err && err.message)
  }

  const disposers = []

  /* 侧边栏面板图标 / 主面板：**等槽声明后再注册**。
     `sidebar.panellist` 由 `@deepseek-ai/dsh-client-ui-sidebar` 声明；在 `dsh web` 里这个声明
     发生在 sidebar 首次渲染时，比插件 apply 晚 —— 直接 `slots.register` 会抛
     「slot "sidebar.panellist" is not declared」，整个 client entry 被标 failed（真机踩到）。
     用 `slots.inject` 等声明；老宿主没有 inject 时退回直接注册。 */
  if (slots && typeof slots.inject === 'function') {
    /* `id` 必须与 `main` 的 `key` 是同一字符串（宿主按 list id 寻址 main 面板，E-8）；
       `label` 必须是函数。 */
    disposers.push(
      slots.inject('sidebar.panellist', () => slots.register(
        { name: 'sidebar.panellist', id: 'ai-courses', order: 30, label: () => t('panel.title') },
        (props) => h(CoursePanelIcon, props),
      )),
    )
    /* 主面板。key = 'ai-courses'（**不能**用 'course'：那是 dsh-course-plugin 的格位） */
    disposers.push(
      slots.inject('main', () => slots.register(
        { name: 'main', key: 'ai-courses' },
        () => h(AicCoursesApp, { t: t, ctx: ctx }),
      )),
    )
  } else {
    disposers.push(
      slots.register(
        { name: 'sidebar.panellist', id: 'ai-courses', order: 30, label: () => t('panel.title') },
        (props) => h(CoursePanelIcon, props),
      ),
    )
    disposers.push(
      slots.register({ name: 'main', key: 'ai-courses' }, () => h(AicCoursesApp, { t: t, ctx: ctx })),
    )
  }

  /* 主会话里的 `/ai-course` 实时状态卡片（conversation.chat.commandview，见 55-status-card.js）：
     宿主 ui-chat 声明该槽，用 inject 等声明出现再注册（直接 register 会抛「未声明」）。 */
  aicRegisterStatusCard(ctx, slots, t).forEach((d) => disposers.push(d))

  /* 主会话回复末尾的**课程大纲卡片**（conversation.chat.turnTail，见 65-outline-card.js）：
     同样是宿主声明的槽，同样用 inject 等声明。 */
  aicRegisterOutlineCard(ctx, slots, t).forEach((d) => disposers.push(d))

  /* 主会话的**常驻 agent 状态条**（conversation.input.dock，见 58-agent-dock.js）：
     生成知识点内容不产生回合，所以要挂在「输入框上方」这个与回合无关的槽里。 */
  aicRegisterAgentDock(ctx, slots, t).forEach((d) => disposers.push(d))

  ctx.effect(() => () => {
    for (const d of disposers) {
      try { if (typeof d === 'function') d() } catch (err) { console.warn('[ai-courses] 清理失败：', err && err.message) }
    }
    if (styleEl && styleEl.parentNode) styleEl.parentNode.removeChild(styleEl)
  })

  console.log('[ai-courses] 客户端已就绪（sidebar/main 等槽声明后注册；主会话槽已注册）')
}
