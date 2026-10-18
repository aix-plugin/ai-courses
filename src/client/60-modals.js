/* ==================== src/client/60-modals.js ====================
 * 两类弹窗（06 §6）：编辑弹窗（按数据类型分派字段）与生成弹窗（属性 + AI 提示）
 *
 * 共用外壳 `.aic-modal` + `.aic-modal__panel` + `__head` + `__body` + `__foot`；
 * 都有 role="dialog" + aria-modal，支持 Escape 与遮罩点击关闭；
 * **引用失效时不弹窗**（由调用方在打开前与渲染前各校验一次）。
 *
 * ⚠️ 与预览的一处**有意偏离**：弹窗标题不再拼接存储 id（`编辑章节 · ch-01`）——
 *    05 §4 与 06 §4.4 明确要求界面不出现存储 id，预览那处是已知的不一致。
 * ⚠️ 结构操作（增删 / 调序）放在编辑弹窗内：AC-8 要求增删与调序可用，而 06 §4.2
 *    把行内元素固定为「生成 / 编辑 / 生成状态」，所以能力进弹窗、行内不变。
 * ========================================================================== */

/** 弹窗外壳：遮罩点击关闭（仅当点在遮罩本体上）+ Escape 关闭（文档级监听）。
 *
 *  ⚠️ **必须走 portal**（与宿主 ui-chat 的用量面板同一做法）：对话流的滚动容器上带
 *  `container-type: inline-size`，它会成为 `position: fixed` 的**包含块** —— 弹窗直接渲染在
 *  卡片里就会被裁在那个滚动条内部（真机上表现为「弹窗跑到看不见的地方」）。
 *  portal 到 `document.body` 一次性解决；顺带把层级从对话流里拿出来。 */
function ModalShell (props) {
  const [host] = React.useState(() => (typeof document === 'undefined' ? null : document.createElement('div')))
  const panelRef = React.useRef(null)
  const onCloseRef = React.useRef(props.onClose)
  onCloseRef.current = props.onClose
  React.useEffect(() => {
    const parent = typeof document === 'undefined' ? null : document.body
    if (!host || !parent || !parent.appendChild) return undefined
    parent.appendChild(host)
    return () => { if (host.parentNode) host.parentNode.removeChild(host) }
  }, [host])
  /* Escape + Tab 焦点陷阱 + 打开聚焦 + 关闭归还焦点。
     用 `[]` 依赖、经 ref 读最新 onClose —— 之前每次 render 都重挂监听器，
     而且没有焦点管理：键盘流会跑到弹窗后面的文档里。 */
  React.useEffect(() => {
    if (typeof document === 'undefined') return undefined
    const previouslyFocused = document.activeElement
    const focusables = () => {
      const panel = panelRef.current
      if (!panel || typeof panel.querySelectorAll !== 'function') return []
      return Array.from(panel.querySelectorAll('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'))
        .filter((el) => !el.disabled)
    }
    /* 打开时聚焦第一个可聚焦元素（若无，聚焦面板本身，保证键盘流有落点） */
    const list = focusables()
    if (list.length) list[0].focus()
    else if (panelRef.current && typeof panelRef.current.focus === 'function') panelRef.current.focus()
    const onKey = (ev) => {
      if (ev.key === 'Escape') { ev.preventDefault(); onCloseRef.current(); return }
      if (ev.key === 'Tab') {
        const els = focusables()
        if (!els.length) return
        const first = els[0]
        const last = els[els.length - 1]
        if (ev.shiftKey && document.activeElement === first) { last.focus(); ev.preventDefault() }
        else if (!ev.shiftKey && document.activeElement === last) { first.focus(); ev.preventDefault() }
      }
    }
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('keydown', onKey)
      if (previouslyFocused && typeof previouslyFocused.focus === 'function') previouslyFocused.focus()
    }
  }, [host])
  const overlay = h(
    'div',
    {
      className: 'aic-modal',
      role: 'dialog',
      'aria-modal': 'true',
      'aria-label': props.title,
      onClick: (ev) => { if (ev.target === ev.currentTarget) props.onClose() },
    },
    h(
      'div',
      { className: 'aic-modal__panel', ref: panelRef },
      h(
        'div',
        { className: 'aic-modal__head' },
        h('h2', { className: 'aic-h2' }, props.title),
        h(IconButton, { name: 'close', label: props.t('modal.close'), onClick: props.onClose }),
      ),
      props.children,
      h(
        'div',
        { className: 'aic-modal__foot' },
        h('button', { className: 'aic-btn', type: 'button', onClick: props.onClose }, props.t('modal.cancel')),
        props.foot,
      ),
    ),
  )
  /* 没有 DOM（离线冒烟）时直接回元素，便于断言 */
  if (!host || typeof ReactDOM === 'undefined' || typeof ReactDOM.createPortal !== 'function') return overlay
  return ReactDOM.createPortal(overlay, host)
}

function FieldLabel (props) {
  return h('label', { className: 'aic-field__label' }, props.children)
}

/**
 * 二次确认弹窗（破坏性操作专用：目前只有「删除课程」）。
 *
 * 与编辑/生成弹窗共用同一套外壳（`ModalShell`）：Escape / 遮罩点击 = 取消。
 * 确认按钮是**危险色**，默认焦点落在「取消」上 —— 避免一个回车就把课删了。
 */
function ConfirmModal (props) {
  const t = props.t
  const loading = !!props.loading
  return h(
    ModalShell,
    {
      t: t,
      title: props.title,
      onClose: loading ? () => {} : props.onClose,
      foot: h(
        'span',
        { className: 'aic-modal__footrow' },
        h('button', {
          className: 'aic-btn',
          type: 'button',
          autoFocus: true,
          disabled: loading,
          onClick: props.onClose,
        }, t('modal.cancel')),
        h('button', {
          className: 'aic-btn aic-btn--danger',
          type: 'button',
          disabled: loading,
          onClick: props.onConfirm,
        }, loading ? t('modal.deleting') : props.confirmLabel),
      ),
    },
    h(
      'div',
      { className: 'aic-modal__body' },
      h('div', null, props.body),
      props.detail ? h('div', { className: 'aic-muted' }, props.detail) : null,
      props.error ? h(Notice, null, props.error) : null,
    ),
  )
}

/**
 * 编辑弹窗。
 * @param {object} props.target { course } | { ch } | { ch, kp } 由 kind 决定
 */
function EditModal (props) {
  const t = props.t
  const core = AIC_COURSES_CORE
  const kind = props.kind
  const isCourse = kind === 'course'
  const isChapter = kind === 'chapter'
  const target = isCourse ? props.course : isChapter ? props.ch : props.kp

  const [form, setForm] = React.useState(() => ({
    name: target.name || '',
    description: target.description || '',
    difficulty: isCourse ? (target.difficulty || core.DIFFICULTIES[0]) : '',
    /* 分类**不在编辑表单里**：推导默认不给分类（用户需求）。`setCategory` 这个 host 动作仍在，
       是给「以后想加回分类」留的口子 —— 到时候在这里补一个字段即可。 */
    tags: isCourse ? (target.tags || []).join('、') : '',
    contentType: isChapter ? '' : (target.contentType || core.CONTENT_TYPES[0]),
  }))
  const set = (patch) => setForm((prev) => Object.assign({}, prev, patch))

  /* 当前字段对应的修订动作（host 的 outline.revise 收的是**动作列表**，不是整棵树） */
  const fieldOps = () => {
    if (isCourse) {
      return [
        { op: 'renameCourse', value: form.name },
        { op: 'setDescription', value: form.description },
        { op: 'setDifficulty', value: form.difficulty },
        { op: 'setTags', value: form.tags },
      ]
    }
    if (isChapter) {
      return [
        { op: 'renameChapter', chapterId: target.id, value: form.name },
        { op: 'setChapterDescription', chapterId: target.id, value: form.description },
      ]
    }
    return [
      { op: 'renameKp', chapterId: props.ch.id, kpId: target.id, value: form.name },
      { op: 'setKpType', chapterId: props.ch.id, kpId: target.id, value: form.contentType },
    ]
  }

  const submit = () => props.onSubmit(fieldOps())

  /* 结构操作：与字段改动**一起**提交，避免「点一下上移就丢掉刚改的名字」 */
  const structure = (ops) => props.onSubmit(fieldOps().concat(ops))

  const chapters = (props.course.outline && props.course.outline.chapters) || []
  const chIndex = isChapter ? chapters.findIndex((c) => c.id === target.id) : -1
  const chKps = isChapter ? [] : ((props.ch && props.ch.knowledgePoints) || [])
  const kpIndex = isChapter ? -1 : chKps.findIndex((k) => k.id === target.id)

  const structureButtons = []
  if (isChapter) {
    structureButtons.push(h('button', {
      className: 'aic-btn aic-btn--sm', type: 'button', key: 'up', disabled: chIndex <= 0,
      onClick: () => structure([{ op: 'moveChapter', chapterId: target.id, index: chIndex - 1 }]),
    }, t('modal.moveUp')))
    structureButtons.push(h('button', {
      className: 'aic-btn aic-btn--sm', type: 'button', key: 'down', disabled: chIndex < 0 || chIndex >= chapters.length - 1,
      onClick: () => structure([{ op: 'moveChapter', chapterId: target.id, index: chIndex + 1 }]),
    }, t('modal.moveDown')))
    structureButtons.push(h('button', {
      className: 'aic-btn aic-btn--sm', type: 'button', key: 'remove',
      disabled: chapters.length <= 1,
      title: chapters.length <= 1 ? t('modal.removeLastChapterHint') : undefined,
      onClick: () => structure([{ op: 'removeChapter', chapterId: target.id }]),
    }, t('modal.removeChapter')))
    const newId = core.nextChapterId(chapters)
    structureButtons.push(h('button', {
      className: 'aic-btn aic-btn--sm', type: 'button', key: 'add',
      /* addChapter 产出的章节是**空**的，而 host 校验要求每章至少 1 个知识点（05 §3）
         → 必须同批补一个知识点，否则整批被拒（这个坑在写的时候撞到过）。 */
      onClick: () => structure([
        { op: 'addChapter', value: newId },
        { op: 'addKp', chapterId: newId, value: t('modal.newKpName') },
      ]),
    }, t('modal.addChapter')))
  } else {
    structureButtons.push(h('button', {
      className: 'aic-btn aic-btn--sm', type: 'button', key: 'up', disabled: kpIndex <= 0,
      onClick: () => structure([{ op: 'moveKp', chapterId: props.ch.id, kpId: target.id, index: kpIndex - 1 }]),
    }, t('modal.moveUp')))
    structureButtons.push(h('button', {
      className: 'aic-btn aic-btn--sm', type: 'button', key: 'down', disabled: kpIndex < 0 || kpIndex >= chKps.length - 1,
      onClick: () => structure([{ op: 'moveKp', chapterId: props.ch.id, kpId: target.id, index: kpIndex + 1 }]),
    }, t('modal.moveDown')))
    structureButtons.push(h('button', {
      className: 'aic-btn aic-btn--sm', type: 'button', key: 'remove', disabled: chKps.length <= 1,
      title: chKps.length <= 1 ? t('modal.removeLastKpHint') : undefined,
      onClick: () => structure([{ op: 'removeKp', chapterId: props.ch.id, kpId: target.id }]),
    }, t('modal.removeKp')))
  }

  const fields = []
  fields.push(h('div', { className: 'aic-field', key: 'name' },
    h(FieldLabel, null, t('modal.fieldName')),
    h('input', { className: 'aic-input aic-input--block', value: form.name, onChange: (ev) => set({ name: ev.target.value }) })))
  /* 字段顺序（06 §6）：课程 = 名称/描述/难度/标签；章节 = 名称/描述；知识点 = 名称/内容类型。
     分类已从表单移除（推导不产出分类），`setCategory` 动作保留但界面上没有入口。 */
  if (kind !== 'kp') {
    fields.push(h('div', { className: 'aic-field', key: 'description' },
      h(FieldLabel, null, t('modal.fieldDescription')),
      h('textarea', { className: 'aic-input aic-input--block aic-input--area', rows: 3, value: form.description, onChange: (ev) => set({ description: ev.target.value }) })))
  }
  if (isCourse) {
    fields.push(h('div', { className: 'aic-field', key: 'difficulty' },
      h(FieldLabel, null, t('modal.fieldDifficulty')),
      h('select', { className: 'aic-select aic-select--block', value: form.difficulty, onChange: (ev) => set({ difficulty: ev.target.value }) },
        core.DIFFICULTIES.map((c) => h('option', { value: c, key: c }, c)))))
    fields.push(h('div', { className: 'aic-field', key: 'tags' },
      h(FieldLabel, null, t('modal.fieldTags')),
      h('input', { className: 'aic-input aic-input--block', value: form.tags, onChange: (ev) => set({ tags: ev.target.value }) }),
      h('div', { className: 'aic-muted' }, t('modal.fieldTagsHint'))))
  }
  if (kind === 'kp') {
    fields.push(h('div', { className: 'aic-field', key: 'type' },
      h(FieldLabel, null, t('modal.fieldType')),
      h('select', { className: 'aic-select aic-select--block', value: form.contentType, onChange: (ev) => set({ contentType: ev.target.value }) },
        core.CONTENT_TYPES.map((c) => h('option', { value: c, key: c }, c)))))
  }

  const title = isCourse ? t('modal.editCourseTitle') : isChapter ? t('modal.editChapterTitle') : t('modal.editKpTitle')

  return h(
    ModalShell,
    {
      t: t,
      title: title,
      onClose: props.onClose,
      foot: h(
        'span',
        { className: 'aic-modal__footrow' },
        /* **生成**与编辑同一入口（06 §4.2）：这里只负责「发起」，具体流程由调用方决定
           （知识点 → 生成弹窗；章节/整门课 → 二次确认后直接排队）。 */
        props.onGenerate
          ? h('button', {
              className: 'aic-btn',
              type: 'button',
              disabled: props.disabled || props.generating,
              onClick: () => props.onGenerate(kind, target),
            }, props.generating ? t('modal.generating') : t('modal.generate' + (isCourse ? 'Course' : isChapter ? 'Chapter' : 'Kp')))
          : null,
        h('button', { className: 'aic-btn aic-btn--primary', type: 'button', disabled: props.disabled, onClick: submit }, t('modal.save')),
      ),
    },
    h(
      'div',
      { className: 'aic-modal__body' },
      fields,
      h('div', { className: 'aic-field' },
        h(FieldLabel, null, t('modal.structureTitle')),
        h('div', { style: { display: 'flex', gap: '8px', flexWrap: 'wrap' } }, structureButtons)),
    ),
  )
}

/**
 * 生成弹窗（06 §6）：属性表 + AI 提示 + 发起。
 *
 * **发起成功后立即关闭**：进度与结果在大纲视图上实时展示（顶部进度条 + 行末 5 态），
 * 不占着弹窗。发起**失败**时弹窗留在原地并显示原因（这时用户需要看到它）。
 */
function GenerateModal (props) {
  const t = props.t
  const core = AIC_COURSES_CORE
  const ch = props.ch
  const kp = props.kp
  const state = core.kpProgress(props.kpProgress, kp.id)
  /* 四种待定类型：**可以生成**（按 Markdown 降级），只是要如实告诉用户「格式待定」 */
  const formatPending = core.DEFERRED_TYPES.indexOf(kp.contentType) >= 0
  const [prompt, setPrompt] = React.useState('')
  /* 默认**保留**：重新生成通常是想「补充」，而不是把已经看过的内容抹掉（覆盖要显式选） */
  const [keep, setKeep] = React.useState(true)
  const [error, setError] = React.useState('')
  const [busy, setBusy] = React.useState(false)

  const rows = [
    [t('modal.factKp'), kp.name],
    [t('modal.factNo'), core.kpNo(ch, kp)],
    [t('modal.factType'), kp.contentType],
    /* 学习时长：**内容已生成**才有实际值可报。没内容时哪怕 kp.duration 有残留数值
       （旧进程写下的估值）也不显示 —— 那是凭空的时间。 */
    [t('modal.factDuration'), (props.hasAsset && kp.duration) ? t('modal.minutes', { n: kp.duration }) : t('modal.factDurationNone')],
    [t('modal.factChapter'), t('modal.factChapterValue', { n: ch.order, name: ch.name })],
    [t('modal.factAsset'), t(props.hasAsset ? 'modal.factStatusGenerated' : 'modal.factStatusNotGenerated') + ' · ' + t('modal.factLearnProgress', { state: t('state.kp.' + state) })],
  ]

  const submit = () => {
    setError('')
    /* **预检**：没有会话 id 就直接给可操作的提示，不发这次请求 ——
       否则用户只会看到一个跟"点生成"毫无关系的报错（真机上就是"点了报错"）。
       会话 id 由面板算（`aicActiveSessionId`），宿主侧还有一层兜底。 */
    if (!props.agentId) {
      setError(t('modal.needSession'))
      return
    }
    if (prompt.length > AIC_PROMPT_MAX) {
      setError(t('modal.promptTooLong', { max: AIC_PROMPT_MAX, n: prompt.length }))
      return
    }
    setBusy(true)
    aicRpc('generation.start', {
      courseId: props.courseId,
      scope: 'kp',
      targetIds: [kp.id],
      prompt: prompt,
      agentId: props.agentId || '',
      /* 只有已有内容时才有意义；没内容时传 false（否则宿主会去读不存在的旧正文） */
      keepExisting: !!props.hasAsset && keep,
    })
      .then(() => {
        setBusy(false)
        /* 关窗 + 让大纲视图立刻进入「实时状态」（面板层轮询接管） */
        if (props.onStarted) props.onStarted()
        else props.onClose()
      })
      .catch((err) => {
        setBusy(false)
        const missing = err && (err.code === 'unknown-method' || err.code === 'http-404')
        setError(missing ? t('modal.generateM2') : String((err && err.message) || err))
      })
  }

  return h(
    ModalShell,
    {
      t: t,
      title: t('modal.generateTitle'),
      onClose: props.onClose,
      foot: h('button', { className: 'aic-btn aic-btn--primary', type: 'button', disabled: busy, onClick: submit },
        busy ? t('modal.generating') : t('modal.generateSubmit')),
    },
    h(
      'div',
      null,
      h('dl', { className: 'aic-facts' },
        rows.map(([label, value]) => h('div', { className: 'aic-facts__row', key: label },
          h('dt', { className: 'aic-facts__label' }, label),
          h('dd', { className: 'aic-facts__value' }, value)))),
      /* **已有内容时**给一个「保留 / 覆盖」选择（06 §6）：保留 → 新内容追加在旧内容之后 */
      props.hasAsset
        ? h('div', { className: 'aic-field' },
            h(FieldLabel, null, t('modal.keepLabel')),
            h('div', { className: 'aic-choices' },
              h('label', { className: 'aic-choice' },
                h('input', {
                  type: 'radio',
                  name: 'keep-existing',
                  checked: keep,
                  onChange: () => setKeep(true),
                }),
                h('span', null, t('modal.keepOn'))),
              h('label', { className: 'aic-choice' },
                h('input', {
                  type: 'radio',
                  name: 'keep-existing',
                  checked: !keep,
                  onChange: () => setKeep(false),
                }),
                h('span', null, t('modal.keepOff')))),
            h('div', { className: 'aic-muted' }, keep ? t('modal.keepHint') : t('modal.overwriteHint')))
        : null,
      h('div', { className: 'aic-field' },
        h(FieldLabel, null, t('modal.generatePromptLabel')),
        h('textarea', {
          className: 'aic-input aic-input--block aic-input--area',
          rows: 3,
          value: prompt,
          /* `maxLength` 与宿主校验**同一个数**（AIC_PROMPT_MAX 由构建期从 host 常量注入）：
             浏览器直接截断，用户不会先写了一千字再被服务端拒掉。 */
          maxLength: AIC_PROMPT_MAX,
          placeholder: t('modal.generatePromptPlaceholder'),
          'aria-label': t('modal.generatePromptAria'),
          onChange: (ev) => setPrompt(ev.target.value),
        }),
        h('div', { className: 'aic-muted' },
          t('modal.promptCount', { n: prompt.length, max: AIC_PROMPT_MAX }))),
      formatPending ? h(Notice, null, t('modal.generateFallback', { type: kp.contentType })) : null,
      h('div', { className: 'aic-muted' }, t('modal.generateAfterClose')),
      error ? h(Notice, null, error) : null,
    ),
  )
}
