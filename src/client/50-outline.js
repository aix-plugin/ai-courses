/* ==================== src/client/50-outline.js ====================
 * 视图：大纲页（06 §4）—— 编辑模式（主面板）与只读模式（右侧抽屉）共用一棵目录树
 *
 * 课程级入口（2026-10-18）：**课程编辑**（基础属性）+ **章节编辑**（结构模式 +/-）+ 生成状态；
 * 整门课生成的界面入口已移除（能力仍在 host 的 generation.start）。
 *
 * 两套状态彼此独立：
 *   ① AI 生成状态（行末 5 态，两种模式都显示）
 *   ② 学习状态（只在知识点名称之后，且**只显示「学习完成」**）
 * 编号一律由 `order` 派生（`1` / `1.1`），**绝不解析存储 id**。
 * ========================================================================== */

function OutlineView (props) {
  const t = props.t
  const core = AIC_COURSES_CORE
  const course = props.course
  const editable = props.mode !== 'readonly'
  const kpProgressMap = props.kpProgress || {}
  /* 「章节编辑」= 结构模式（2026-10-18 用户需求）：点开后，章节与知识点**前面**出现 +/-，
     分别用于增删章节与知识点。默认关闭 —— 浏览时不该被结构按钮干扰。
     状态放组件内：数据刷新（生成中轮询）时不会被打回关闭。 */
  const [structMode, setStructMode] = React.useState(false)
  const canStructure = editable && typeof props.onStructure === 'function'

  /* 生成状态由**两项真实证据**派生：任务项状态（生成中/排队中/失败）与内容信封是否存在（已生成）。
     调用方不给（例如只读抽屉只关心「有没有内容」）时一律按「未生成」——不编造状态。 */
  const genOfKp = (kp) => core.kpGenState(props.taskStates && props.taskStates[kp.id], !!(props.assets && props.assets[kp.id]))
  const genOfScope = (kps) => core.scopeGenState(kps.map(genOfKp))

  const chapters = (course && course.outline && course.outline.chapters) || []

  /* 「在本章后新增」：addChapter 现在支持 `index`（插入位置），再加一个知识点 ——
     新章节不能是空的（host 校验：每章 ≥1 个知识点，05 §3），所以两步必须同批提交。 */
  const addChapterAfter = (ch) => {
    const at = chapters.findIndex((c) => c.id === ch.id)
    const newId = core.nextChapterId(chapters)
    props.onStructure([
      { op: 'addChapter', value: newId, index: at + 1 },
      { op: 'addKp', chapterId: newId, value: t('modal.newKpName') },
    ])
  }
  /* 「在本知识点后新增」：addKp 的 `index` 是**章内**插入位置。 */
  const addKpAfter = (ch, kp) => {
    const at = (ch.knowledgePoints || []).findIndex((k) => k.id === kp.id)
    props.onStructure([{ op: 'addKp', chapterId: ch.id, value: t('modal.newKpName'), index: at + 1 }])
  }

  /* `variant: 'embed'` —— 同一棵树嵌进**主会话的大纲卡片**：
     卡片自己有表头（标题 + 课程名 + 入口按钮），这里就不能再画面包屑与整页标题，
     否则界面上出现两个标题、两层导航。行内控件与弹窗入口完全一致。 */
  const embedded = props.variant === 'embed'

  const head = embedded ? null : !editable
    ? null
    : h(
        'div',
        { className: 'aic-outline__head' },
        h(Breadcrumb, {
          t: t,
          items: [{ label: t('library.title'), onClick: props.onBack }, { label: t('outline.crumbPage') }],
        }),
        h(
          'div',
          { className: 'aic-outline__titlerow' },
          h('h1', { className: 'aic-h1' }, course.name),
          h(
            'span',
            { className: 'aic-row__right' },
            /* 课程级只有两个入口（2026-10-18 用户需求）：
               ① 课程编辑 —— 名称 / 描述 / 标签 / 难度等**基础属性**（不含生成）；
               ② 章节编辑 —— 切换结构模式，在章节/知识点前显示 +/- 增删。
               原先的「编辑 + 生成」合成入口已移除；整门课的生成不再从大纲页发起。 */
            h(IconButton, {
              name: 'edit',
              label: t('outline.editCourseBasic'),
              disabled: props.disabled,
              onClick: () => props.onEdit('course', null),
            }),
            canStructure
              ? h(IconButton, {
                  name: 'structure',
                  /* 默认灰、选中黑（不铺底色）—— 结构模式开关的专属外观，见 20-widgets 的 tone */
                  tone: 'structure',
                  label: structMode ? t('outline.structureExit') : t('outline.structureEnter'),
                  pressed: structMode,
                  disabled: props.disabled,
                  onClick: () => setStructMode((v) => !v),
                })
              : null,
            h(GenIcon, { t: t, state: genOfScope(core.courseKps(course).map((x) => x.kp)), scope: 'Course' }),
          ),
        ),
        course.description ? h('p', { className: 'aic-sub' }, course.description) : null,
        (course.tags || []).length
          ? h('div', { className: 'aic-card__meta', style: { marginTop: '8px' } },
              (course.tags || []).map((tag) => h('span', { className: 'aic-tag', key: tag }, tag)))
          : null,
      )

  /* 嵌进卡片时表头由卡片承担，但**课程描述与课程级操作**不能丢：单独一行小字 + 编辑入口。 */
  const embedHead = !embedded
    ? null
    : h(
        'div',
        { className: 'aic-outline__embedhead' },
        course.description ? h('p', { className: 'aic-sub' }, course.description) : null,
        h(
          'div',
          { className: 'aic-outline__embedrow' },
          h('button', {
            className: 'aic-btn aic-btn--sm',
            type: 'button',
            disabled: props.disabled,
            onClick: () => props.onEdit('course', null),
          }, t('outline.editCourse')),
          h(GenIcon, { t: t, state: genOfScope(core.courseKps(course).map((x) => x.kp)), scope: 'Course' }),
        ),
      )

  return h(
    'div',
    { className: 'aic-outline' },
    head,
    embedHead,
    props.readOnly ? h(Notice, null, t('outline.readOnlyNotice')) : null,
    props.corrupt ? h(Notice, null, t('outline.corruptNotice')) : null,
    chapters.map((ch) =>
      h(
        'div',
        { className: 'aic-chapter', key: ch.id },
        h(
          'div',
          { className: 'aic-chapter__head' },
          /* 结构模式：章节**前面**的 +（在本章后新增章节）/ -（删除本章） */
          structMode && canStructure
            ? h(
                'span',
                { className: 'aic-structops' },
                h(IconButton, { name: 'plus', label: t('outline.addChapterAfter'), disabled: props.disabled, onClick: () => addChapterAfter(ch) }),
                h(IconButton, {
                  name: 'minus',
                  label: t('outline.removeChapter'),
                  disabled: props.disabled || chapters.length <= 1,
                  onClick: () => props.onStructure([{ op: 'removeChapter', chapterId: ch.id }]),
                }),
              )
            : null,
          h('span', { className: 'aic-chapter__no' }, core.chapterNo(ch)),
          h('span', { className: 'aic-chapter__title' }, ch.name),
          h(
            'span',
            { className: 'aic-row__right' },
            editable
              ? h(IconButton, { name: 'compose', label: t('outline.composeChapter'), disabled: props.disabled, onClick: () => props.onEdit('chapter', ch) })
              : null,
            h(GenIcon, { t: t, state: genOfScope(ch.knowledgePoints || []), scope: 'Chapter' }),
          ),
        ),
        h(
          'div',
          { className: 'aic-chapter__body' },
          (ch.knowledgePoints || []).length === 0
            ? h('div', { className: 'aic-muted' }, t('outline.chapterEmpty'))
            : (ch.knowledgePoints || []).map((kp) => {
                const state = core.kpProgress(kpProgressMap, kp.id)
                const learnState = core.kpLearnState(state)
                /* 名字是否可点进学习页由**调用方是否给了能力**决定：
                   课程面板给 `onOpenLesson` → 可点；主会话的大纲卡片没有学习页 → 纯文本。
                   （不能只看 `editable`：卡片是可编辑的，但它没有学习页可跳。） */
                const openable = typeof props.onOpenLesson === 'function'
                const open = () => { if (openable) props.onOpenLesson(ch, kp) }
                const kpList = ch.knowledgePoints || []
                return h(
                  'div',
                  { className: 'aic-kp', key: kp.id },
                  /* 结构模式：知识点**前面**的 +（在本知识点后新增）/ -（删除本知识点） */
                  structMode && canStructure
                    ? h(
                        'span',
                        { className: 'aic-structops' },
                        h(IconButton, { name: 'plus', label: t('outline.addKpAfter'), disabled: props.disabled, onClick: () => addKpAfter(ch, kp) }),
                        h(IconButton, {
                          name: 'minus',
                          label: t('outline.removeKp'),
                          disabled: props.disabled || kpList.length <= 1,
                          onClick: () => props.onStructure([{ op: 'removeKp', chapterId: ch.id, kpId: kp.id }]),
                        }),
                      )
                    : null,
                  h('span', { className: 'aic-kp__no' }, core.kpNo(ch, kp)),
                  h(TypeIcon, { t: t, type: kp.contentType }),
                  h(
                    'span',
                    {
                      className: 'aic-kp__name',
                      role: openable ? 'button' : undefined,
                      tabIndex: openable ? 0 : undefined,
                      onClick: openable ? open : undefined,
                      onKeyDown: openable
                        ? (ev) => {
                            if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); open() }
                          }
                        : undefined,
                    },
                    h('span', null, kp.name),
                    /* 学习状态只对**有内容**的知识点有意义（没内容时的残留进度不展示） */
                    (learnState === '学习完成' && props.assets && props.assets[kp.id])
                      ? h(LearnIcon, { t: t, state: learnState, scope: 'Kp' })
                      : null,
                  ),
                  h(
                    'span',
                    { className: 'aic-row__right' },
                    /* 学习时长：**只有内容已生成**才显示（06 §5）。
                       为什么不只看 `kp.duration`：旧进程/旧数据里可能还带着大纲阶段的估值，
                       而那时根本没有内容 —— 显示出来就是「凭空的时间」。
                       判据用**内容信封**（`assets` 里有没有这个 kp），与卡片「已生成」同源。 */
                    h(DurationLabel, { t: t, minutes: (props.assets && props.assets[kp.id]) ? kp.duration : undefined }),
                    editable
                      ? h(IconButton, {
                          name: 'compose',
                          /* 编辑 + 生成**一个入口**：弹窗里既能改属性，也能发起生成（06 §4.2）。 */
                          label: genOfKp(kp) === '已生成' ? t('outline.composeKpDone') : t('outline.composeKp'),
                          disabled: props.disabled,
                          onClick: () => props.onEdit('kp', { ch: ch, kp: kp }),
                        })
                      : null,
                    h(GenIcon, { t: t, state: genOfKp(kp), scope: 'Kp' }),
                  ),
                )
              }),
        ),
      ),
    ),
  )
}
