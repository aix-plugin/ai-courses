/* ==================== src/client/70-lesson.js ====================
 * 视图：学习页（06 §5）—— **M1 只落骨架**
 *
 * M1 范围（T-9）：面包屑、h1、学习时长、「未生成」空态（含路径提示与生成入口）、
 * 底部「上一节 / 下一节」导航卡（跨章节顺序 + 首末节等宽占位）。
 *
 * 明确留给 M2（T-12 / T-13）：
 *   · `图文` / `幻灯片` 渲染器与四种待定类型的安全网降级（AC-10 / AC-14 ~ AC-16）
 *   · 右侧只读大纲抽屉（`sidebarRightTabs` 两段式 API，AC-18 / AC-22 / AC-34）
 *   · 进度标记（打开 → 进行中、离开 → 已掌握，AC-9）
 * M1 的宿主也还没有内容资产通道，所以内容区**必然**是「未生成」空态 —— 这是真实状态，不是占位假数据。
 * ========================================================================== */

/** 上一节 / 下一节导航卡：首末节缺失的一侧用**等宽空占位**保持两列对齐（06 §5）。 */
function LessonNav (props) {
  const t = props.t
  const core = AIC_COURSES_CORE
  const list = core.courseKps(props.course)
  const idx = list.findIndex((x) => x.kp.id === props.kp.id)
  if (idx < 0) return null
  const prev = idx > 0 ? list[idx - 1] : null
  const next = idx < list.length - 1 ? list[idx + 1] : null
  /* 完整字面量类名（不拼接）：check.mjs 的「类名都有规则」断言依赖它 */
  const cardCls = { prev: 'aic-navcard aic-navcard--prev', next: 'aic-navcard aic-navcard--next' }
  const card = (item, dir, label, icon) =>
    item
      ? h(
          'button',
          {
            className: cardCls[dir],
            type: 'button',
            onClick: () => props.onOpenKp(item.ch, item.kp),
          },
          h('span', { className: 'aic-navcard__dir' }, h(Icon, { name: icon }), h('span', null, label)),
          h('span', { className: 'aic-navcard__name' }, item.kp.name),
        )
      : h('span', { className: 'aic-navcard aic-navcard--empty', 'aria-hidden': 'true' })
  return h(
    'nav',
    { className: 'aic-lesson__nav', 'aria-label': t('lesson.navAria') },
    card(prev, 'prev', t('lesson.navPrev'), 'prev'),
    card(next, 'next', t('lesson.navNext'), 'next'),
  )
}

/**
 * 学习页（06 §5）。
 *
 * 数据：`contentAssets.get`（正文 + 媒体清单）。**进度由「打开 / 离开」驱动**（05 §6.1 / Q-14）：
 * 打开 → `进行中`（已掌握不回退）；离开/切换 → `已掌握`。没有「标记已掌握」按钮。
 */
function LessonView (props) {
  const t = props.t
  const core = AIC_COURSES_CORE
  const course = props.course
  const ch = props.ch
  const kp = props.kp
  const relPath = core.contentRelPath(kp.id, kp.contentType)

  const [payload, setPayload] = React.useState(null)
  const [loadError, setLoadError] = React.useState('')

  /* 取内容资产（切知识点时重取；上一份内容不保留 —— 换知识点必须换内容，避免串课） */
  React.useEffect(() => {
    let alive = true
    setPayload(null)
    setLoadError('')
    aicRpc('contentAssets.get', { courseId: course.id, kpId: kp.id })
      .then((res) => { if (alive) setPayload(res) },
        (err) => { if (alive) setLoadError(String((err && err.message) || err)) })
    return () => { alive = false }
  }, [course.id, kp.id, props.version])

  /* 进度：打开 → 进行中；离开（卸载/切换）→ 已掌握。都**不阻塞界面**（fire-and-forget）。
     ⚠️ **只有内容已生成**才记：还没生成内容的知识点，"学过/学完"没有意义（05 §6.1）——
     否则空态页一进一出就给这门课刷出「已掌握 N 个」，进度全是假的。
     所以要等载荷到、并确认 `hasAsset` 才标记；离开时的「已掌握」也只在本组件真的标过之后发。 */
  const mark = props.onMark
  const markedRef = React.useRef(false)
  const hadAsset = !!(payload && payload.hasAsset)
  React.useEffect(() => {
    markedRef.current = false
    if (!mark || !hadAsset) return undefined
    mark('进行中')
    markedRef.current = true
    return () => {
      if (markedRef.current) mark('已掌握')
      markedRef.current = false
    }
  }, [course.id, kp.id, hadAsset])

  /* 图片：把正文里的**相对路径**换成 host 的媒体路由 URL（图片只从课程目录里取） */
  const bodyDir = 'content-assets'
  const resolveUrl = (raw) => aicMediaUrl(course.id, bodyDir, raw)

  const hasAsset = !!(payload && payload.hasAsset)
  const content = (() => {
    if (loadError) {
      return h('div', { className: 'aic-error' },
        h('div', { className: 'aic-error__title' }, t('lesson.loadErrorTitle')),
        h('div', { className: 'aic-muted' }, loadError),
        h('div', { style: { marginTop: '10px' } },
          h('button', { className: 'aic-btn', type: 'button', onClick: () => props.onRegenerate(ch, kp) }, t('lesson.regenerate'))))
    }
    if (!payload) return h(PageState, { title: t('lesson.contentLoading'), retry: '', onRetry: () => {} })
    if (hasAsset) {
      return h(ContentView, {
        t: t,
        payload: payload,
        formatPending: !!payload.formatPending,
        resolveUrl: resolveUrl,
      })
    }
    return h(
      'div',
      { className: 'aic-empty' },
      h('div', { className: 'aic-empty__title' }, t('lesson.emptyTitle')),
      h('div', null, t('lesson.emptyBody')),
      h('div', { className: 'aic-empty__hint' }, relPath),
      h('div', { style: { marginTop: '12px' } },
        h('button', { className: 'aic-btn', type: 'button', onClick: () => props.onGenerate(ch, kp) }, t('lesson.emptyAction'))),
    )
  })()

  return h(
    'div',
    { className: 'aic-lesson' },
    h(
      'div',
      { className: 'aic-pagehead' },
      h(
        'div',
        null,
        h(Breadcrumb, {
          t: t,
          items: [
            { label: t('library.title'), onClick: props.onBack },
            { label: course.name, onClick: () => props.onOpenOutline(course.id) },
            { label: ch.name },
          ],
        }),
        h('h1', { className: 'aic-h1' }, kp.name),
        /* 教学时长按**实际正文**算（host 在 contentAssets.get 里给 `minutes`）；
           `kp.duration` 只是入库时的值，旧数据可能是大纲阶段的估值，仅作兜底。 */
        h('div', { className: 'aic-lesson__meta' },
          h(DurationLabel, { t: t, minutes: (payload && payload.minutes) || kp.duration })),
      ),
      h(
        'span',
        { className: 'aic-row__right' },
        hasAsset
          ? h(IconButton, { name: 'generate', label: t('lesson.regenerate'), onClick: () => props.onRegenerate(ch, kp) })
          : null,
        h(GenIcon, { t: t, state: core.kpGenState(props.itemStates, hasAsset), scope: 'Kp' }),
      ),
    ),
    h(
      'div',
      { className: 'aic-lesson__body' },
      h(
        'div',
        { className: 'aic-lesson__inner' },
        h('div', { className: 'aic-lesson__content' }, content),
        h(LessonNav, { t: t, course: course, kp: kp, onOpenKp: props.onOpenKp }),
      ),
    ),
  )
}
