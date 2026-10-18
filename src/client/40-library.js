/* ==================== src/client/40-library.js ====================
 * 视图：课程库（06 §3）
 *
 * 五种页面状态：加载中（骨架）/ 读取失败 / 空库 / 无结果 / 就绪（按分类分组的卡片网格）。
 * 筛选三条件可叠加（分类 + 名称 + 标签多选），标签行**不是卡片**（无边框/圆角/底色/内边距）。
 * ========================================================================== */

const AIC_LIB_SKELETON_COUNT = 6

/** 一张课程卡片：名称 → 描述 → 难度徽标 + 标签 → 满宽进度 → 两个右对齐入口。 */
function CourseCard (props) {
  const t = props.t
  const c = props.course
  const broken = !c.name
  const deriving = !broken && (c.chapterCount || 0) === 0
  const pct = Math.round(AIC_COURSES_CORE.progressRatio(c.kpTotal, c.kpMastered) * 100)
  const tags = c.tags || []
  return h(
    'div',
    { className: 'aic-card' },
    h(
      'div',
      { className: 'aic-card__name' },
      h('span', null, broken ? t('library.cardCorrupt') : c.name),
      deriving ? h('span', { className: 'aic-badge aic-badge--type' }, t('library.cardDeriving')) : null,
    ),
    h('div', { className: 'aic-card__desc' }, broken ? t('library.cardCorruptHint') : c.description || ''),
    h(
      'div',
      { className: 'aic-card__meta' },
      broken || !c.difficulty ? null : h('span', { className: 'aic-badge' }, t('library.cardDifficulty', { level: c.difficulty })),
      /* 已生成内容的知识点数：**只在宿主确实回了这个字段时**才渲染
         （老宿主没有 → 不显示，而不是显示 0/undefined） */
      Number(c.kpGenerated) > 0
        ? h('span', { className: 'aic-badge aic-badge--type' }, t('library.cardGenerated', { n: c.kpGenerated, total: c.kpTotal || 0 }))
        : null,
      c.readOnly ? h('span', { className: 'aic-badge aic-badge--type' }, t('library.cardReadOnly')) : null,
      tags.map((tag) => h('span', { className: props.selectedTags.indexOf(tag) >= 0 ? 'aic-tag aic-tag--on' : 'aic-tag', key: tag }, tag)),
    ),
    h(
      'div',
      { className: 'aic-card__progress' },
      h(
        'div',
        { className: 'aic-card__meta' },
        h('span', { className: 'aic-muted' }, t('library.cardProgress')),
        h('span', { className: 'aic-muted', style: { marginLeft: 'auto' } }, pct + '%'),
      ),
      h(ProgressBar, { ratio: pct / 100, t: t }),
    ),
    h(
      'div',
      { className: 'aic-card__actions' },
      /* 删除：**纯图标按钮、灰显**（06 §3.2）—— 只在卡片上出现（破坏性操作只给用户 + 二次确认；
         模型没有这个工具，04 §5）。左对齐并用 `margin-right: auto` 与两个入口分开，降低误点；
         图标按钮**必须有** title + aria-label（06 §8）。 */
      h(
        'button',
        {
          className: 'aic-btn aic-btn--sm aic-btn--quiet aic-btn--muted aic-card__delete',
          type: 'button',
          disabled: broken,
          title: t('library.cardDelete'),
          'aria-label': t('library.cardDelete'),
          onClick: () => props.onDelete(c),
        },
        h(Icon, { name: 'trash' }),
      ),
      h(
        'button',
        {
          className: 'aic-btn aic-btn--sm',
          type: 'button',
          disabled: broken || deriving,
          title: deriving ? t('library.cardDerivingHint') : undefined,
          onClick: () => props.onOpenOutline(c.id),
        },
        h(Icon, { name: 'outline' }),
        h('span', null, t('library.cardOutline')),
      ),
      /* 学习：**全部知识点都没内容**时才灰显（06 §3.2）—— 只要有一个能学，就该能进去。
         ⚠️ 兜底很重要：宿主 `courses.list` 是**较新**才带 `hasContent` 的字段。
         老宿主返回 undefined 时，`!c.hasContent` 会恒为真 → **整库全灰**（真机上踩过）。
         所以：字段缺失（undefined/null）一律**不**灰显；只有明确 `false` 才灰显。 */
      h(
        'button',
        {
          className: 'aic-btn aic-btn--sm',
          type: 'button',
          disabled: broken || deriving || c.hasContent === false,
          title: broken || deriving
            ? t('library.cardDerivingHint')
            : (c.hasContent === false ? t('library.cardLearnNoContent') : undefined),
          onClick: () => props.onOpenLesson(c.id),
        },
        h(Icon, { name: 'learn' }),
        h('span', null, t('library.cardLearn')),
      ),
    ),
  )
}

function LibraryView (props) {
  const t = props.t
  const core = AIC_COURSES_CORE
  /* 排序在**最前面**：后面的筛选项、分组、计数都以这个顺序为准（06 §3.2 更新时间降序） */
  const rows = core.sortCoursesByUpdated(props.courses || [])
  const filter = props.filter
  const selected = filter.tags || []
  const categories = core.allCategories(rows)
  const tags = core.allTags(rows)
  const matched = core.filterCourses(rows, filter)
  const loading = props.status === 'loading' && !rows.length
  const grouped = core.groupByCategory(matched)
  const [copied, setCopied] = React.useState(false)

  const subtitle = (() => {
    if (props.status === 'error') return ''
    const n = matched.length
    if (n === rows.length) return t('library.subtitleAll', { n: n })
    return t('library.subtitleFiltered', { n: n, total: rows.length })
  })()

  const copyExample = () => {
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(t('library.emptyHint'))
      }
    } catch (err) { /* 剪贴板不可用不影响主流程 */ }
    setCopied(true)
  }

  /* 状态分支顺序：加载中 → 读取失败 → 空库 → 无结果 → 就绪（预览同序） */
  let body = null
  if (loading) {
    body = h('div', { className: 'aic-grid' }, Array.from({ length: AIC_LIB_SKELETON_COUNT }, (_, i) => h('div', { className: 'aic-skel', key: i })))
  } else if (props.status === 'error') {
    body = h(
      'div',
      { className: 'aic-error' },
      h('div', { className: 'aic-error__title' }, t('library.errorTitle')),
      h('div', { className: 'aic-muted' }, t('library.errorBody')),
      h('div', null, h('code', null, props.error && props.error.message ? props.error.message : t('library.errorPath'))),
      h('div', { style: { marginTop: '10px' } }, h('button', { className: 'aic-btn', type: 'button', onClick: props.onRetry }, t('library.retry'))),
    )
  } else if (!rows.length) {
    body = h(
      'div',
      { className: 'aic-empty' },
      h('div', { className: 'aic-empty__title' }, t('library.emptyTitle')),
      h('div', null, t('library.emptyBody')),
      h('div', { className: 'aic-empty__hint' }, t('library.emptyHint')),
      h('div', { style: { marginTop: '12px' } },
        h('button', { className: 'aic-btn aic-btn--sm', type: 'button', onClick: copyExample },
          copied ? t('library.emptyActionDone') : t('library.emptyAction'))),
    )
  } else if (!matched.length) {
    body = h(
      'div',
      { className: 'aic-empty' },
      h('div', { className: 'aic-empty__title' }, t('library.nomatchTitle')),
      h('div', null, t('library.nomatchBody')),
      h('div', { style: { marginTop: '12px' } },
        h('button', { className: 'aic-btn aic-btn--sm', type: 'button', onClick: props.onClearFilters }, t('library.nomatchAction'))),
    )
  } else {
    body = h(
      'div',
      null,
      grouped.map((g) =>
        h(
          'div',
          { className: 'aic-group', key: g.category || '_' },
          h(
            'div',
            { className: 'aic-group__head' },
            h('span', null, g.category || t('library.groupUncategorized')),
            h('span', { className: 'aic-muted' }, t('library.groupCount', { n: g.courses.length })),
          ),
          h(
            'div',
            { className: 'aic-grid' },
            g.courses.map((c) =>
              h(CourseCard, {
                key: c.id,
                course: c,
                t: t,
                selectedTags: selected,
                onOpenOutline: props.onOpenOutline,
                onOpenLesson: props.onOpenLesson,
                onDelete: props.onDelete,
              }),
            ),
          ),
        ),
      ),
    )
  }

  return h(
    'div',
    { className: 'aic-library' },
    h(
      'div',
      { className: 'aic-pagehead' },
      h('div', null,
        h('h1', { className: 'aic-h1' }, t('library.title')),
        subtitle ? h('p', { className: 'aic-sub' }, subtitle) : null),
      h('button', { className: 'aic-btn aic-btn--primary', type: 'button', onClick: props.onNewCourse }, t('library.newCourse')),
    ),
    props.notice ? h(Notice, null, props.notice) : null,
    h(
      'div',
      { className: 'aic-toolbar' },
      h(
        'select',
        {
          className: 'aic-select',
          value: filter.category,
          'aria-label': t('library.categoryLabel'),
          onChange: (ev) => props.onFilter({ category: ev.target.value }),
        },
        h('option', { value: '' }, t('library.categoryAll')),
        categories.map((c) => h('option', { value: c, key: c }, c)),
      ),
      h('input', {
        className: 'aic-input',
        type: 'search',
        value: filter.query,
        placeholder: t('library.searchPlaceholder'),
        'aria-label': t('library.searchLabel'),
        onChange: (ev) => props.onFilter({ query: ev.target.value }),
      }),
    ),
    h(
      'div',
      { className: 'aic-tagbar' },
      h('span', { className: 'aic-tagbar__label' }, t('library.tagbarLabel')),
      h(
        'div',
        { className: 'aic-tagbar__list' },
        tags.map((tag) => {
          const on = selected.indexOf(tag) >= 0
          return h(
            'button',
            {
              className: 'aic-chip',
              type: 'button',
              key: tag,
              'aria-pressed': String(on),
              title: on ? t('library.tagUnpick') : t('library.tagPick'),
              onClick: () => props.onFilter({ tags: on ? selected.filter((x) => x !== tag) : selected.concat([tag]) }),
            },
            h('span', null, tag),
            h('span', { className: 'aic-chip__count' }, String(core.tagCount(rows, tag))),
          )
        }),
      ),
      selected.length
        ? h('div', { className: 'aic-tagbar__clear' },
            h('button', { className: 'aic-btn aic-btn--sm aic-btn--quiet', type: 'button', onClick: () => props.onFilter({ tags: [] }) },
              t('library.tagbarClear', { n: selected.length })))
        : null,
      h('span', { className: 'aic-tagbar__count' }, t('library.tagbarCount', { n: selected.length, total: tags.length })),
    ),
    body,
  )
}
