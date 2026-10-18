/* ==================== src/client/20-widgets.js ====================
 * 小组件：图标、两套状态图标、时长、进度条、通知条、面包屑
 *
 * 全部是纯展示组件（无副作用、不取数），类名与 preview 的 DOM 一一对应 ——
 * 06 号文档说「以 preview 的真实渲染为准」，所以这里不改信息结构，只换成 React 元素。
 * ========================================================================== */

/* ------------------------------------------------------------------ 图标 */
/* 路径逐字取自 preview/app.js 的 ICONS 表（20×20 viewBox、描边、currentColor）。
   键用 ASCII：中文键会让「组件代码里不许有中文字面量」这条断言无法机械检查。 */
const AIC_ICONS = {
  article: ['M11.5 3H6.5A1.5 1.5 0 0 0 5 4.5v11A1.5 1.5 0 0 0 6.5 17h7a1.5 1.5 0 0 0 1.5-1.5V6.5z', 'M11.5 3v3.5H15', 'M7.5 10.5h5', 'M7.5 13.5h3.5'],
  slides: ['M3.5 4.5h13v9h-13z', 'M10 13.5v3', 'M7 16.5h6'],
  audio: ['M4.5 12v-2a5.5 5.5 0 0 1 11 0v2', 'M4.5 11.5h1.8v4H5.6a1.1 1.1 0 0 1-1.1-1.1z', 'M15.5 11.5h-1.8v4h.7a1.1 1.1 0 0 0 1.1-1.1z'],
  video: ['M3.5 5.5h13v9h-13z', 'M8.5 8.2l3.8 2.3-3.8 2.3z'],
  code: ['M7.8 6.5L4.3 10l3.5 3.5', 'M12.2 6.5L15.7 10l-3.5 3.5'],
  quiz: ['M4.5 4.5h11v11h-11z', 'M7.3 10.2l1.7 1.7 3.7-3.7'],
  generate: ['M10 3.2l1.5 4.1 4.1 1.5-4.1 1.5L10 14.4l-1.5-4.1L4.4 8.8l4.1-1.5z', 'M15 13.5l.7 1.8 1.8.7-1.8.7-.7 1.8-.7-1.8-1.8-.7 1.8-.7z'],
  edit: ['M13.2 4.6l2.2 2.2L7.6 14.6H5.4v-2.2z', 'M12.1 5.7l2.2 2.2'],
  /* 编辑 + 生成**合一**的入口：铅笔（编辑）+ 右下角小星芒（生成，字形取自 generate 的第二段）。
     为什么要合成一个图标：大纲里原来并排两个图标按钮（编辑 / 生成），既占地方又让人分不清
     该点哪个 —— 两件事本来就发生在同一个弹窗里（06 §4.2）。 */
  compose: [
    'M11.6 4.4l2.2 2.2L6.2 14.2H4v-2.2z',
    'M10.6 5.4l2.2 2.2',
    'M14.8 11.6l.7 1.8 1.8.7-1.8.7-.7 1.8-.7-1.8-1.8-.7 1.8-.7z',
  ],
  back: ['M15.2 10H4.8', 'M9.3 5.5L4.8 10l4.5 4.5'],
  close: ['M5.5 5.5l9 9', 'M14.5 5.5l-9 9'],
  drawer: ['M3.5 4.5h13v11h-13z', 'M12 4.5v11'],
  clock: ['M10 3.5a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13z', 'M10 6.6V10l2.4 1.5'],
  outline: ['M4.5 6h11', 'M7.5 10h8', 'M7.5 14h8'],
  /* 章节编辑（结构模式）：列表 + 加号 —— 「在这里增删结构」 */
  structure: ['M3.5 5.5h7', 'M3.5 10h7', 'M3.5 14.5h5', 'M14.5 12.5v5', 'M12 15h5'],
  plus: ['M10 5.5v9', 'M5.5 10h9'],
  minus: ['M5.5 10h9'],
  learn: ['M7.9 5.9l6.7 4.1-6.7 4.1z'],
  prev: ['M12.5 5.5l-5 4.5 5 4.5'],
  trash: ['M4.5 6.5h11', 'M8 6.5V5a1 1 0 0 1 1-1h2a1 1 0 0 1 1 1v1.5', 'M6 6.5l.7 8a1 1 0 0 0 1 .9h4.6a1 1 0 0 0 1-.9l.7-8', 'M8.6 9.5v3.4', 'M11.4 9.5v3.4'],
  next: ['M7.5 5.5l5 4.5-5 4.5'],
}

/** 内容类型 → 图标键（未知类型回退「图文」的图标，06 §5）。 */
const AIC_TYPE_ICON = {
  '图文': 'article', '幻灯片': 'slides', '音频': 'audio', '视频': 'video', '代码': 'code', '测验': 'quiz',
}

/** 描边式图标；`aria-hidden` —— 可访问名一律由调用方（title/aria-label 或可见文字）承担。 */
function Icon (props) {
  const size = props.size || 15
  const paths = AIC_ICONS[props.name] || []
  return h(
    'svg',
    {
      viewBox: '0 0 20 20',
      width: String(size),
      height: String(size),
      fill: 'none',
      stroke: 'currentColor',
      strokeWidth: '1.5',
      strokeLinecap: 'round',
      strokeLinejoin: 'round',
      'aria-hidden': 'true',
      focusable: 'false',
    },
    paths.map((d, i) => h('path', { key: i, d: d })),
  )
}

/** 状态字形：只有「未生成」是空心，其余实心（06 §4.3）。 */
function StateGlyph (props) {
  const kind = props.kind
  if (kind === 'check') {
    return h(
      'svg',
      { viewBox: '0 0 20 20', width: '15', height: '15', fill: 'none', stroke: 'currentColor', strokeWidth: '1.8', strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': 'true', focusable: 'false' },
      h('path', { key: 'c', d: 'M5.4 10.4l3.1 3.1 6.1-6.6' }),
    )
  }
  if (kind === 'spin') {
    /* 生成中：转动的圆弧（颜色仍由 `.aic-genstate--warn` 决定，与原来的橙色一致） */
    return h(
      'svg',
      { className: 'aic-genstate__spin', viewBox: '0 0 20 20', width: '15', height: '15', fill: 'none', stroke: 'currentColor', strokeWidth: '2', strokeLinecap: 'round', 'aria-hidden': 'true', focusable: 'false' },
      h('path', { key: 's', d: 'M10 2.8a7.2 7.2 0 1 1-7.2 7.2' }),
    )
  }
  if (kind === 'play') {
    return h(
      'svg',
      { viewBox: '0 0 20 20', width: '15', height: '15', fill: 'none', stroke: 'currentColor', strokeWidth: '1.6', strokeLinejoin: 'round', 'aria-hidden': 'true', focusable: 'false' },
      h('path', { key: 'p', d: 'M7.4 5.6l7.2 4.4-7.2 4.4z' }),
    )
  }
  if (kind === 'pause') {
    return h(
      'svg',
      { viewBox: '0 0 20 20', width: '15', height: '15', fill: 'none', stroke: 'currentColor', strokeWidth: '1.6', strokeLinecap: 'round', 'aria-hidden': 'true', focusable: 'false' },
      [h('path', { key: 'a', d: 'M8.2 6v8' }), h('path', { key: 'b', d: 'M11.8 6v8' })],
    )
  }
  const solid = kind === 'solid'
  const attrs = {
    viewBox: '0 0 20 20', width: '15', height: '15', fill: 'none', stroke: 'currentColor', strokeWidth: '1.6',
    'aria-hidden': 'true', focusable: 'false',
  }
  if (solid) { attrs.fill = 'currentColor'; attrs.stroke = 'none' }
  return h('svg', attrs, h('circle', { key: 'c', cx: '10', cy: '10', r: solid ? '4.1' : '5.2' }))
}

/* --------------------------------------------------------- 两套状态图标 */
/* ⚠️ `aic-genstate--<mod>` 只是**语义标记类**（CSS 不为它定义规则，颜色由 `--<color>` 承担），
   scripts/check.mjs 里有一份显式白名单说明这件事。 */
function GenIcon (props) {
  const spec = AIC_COURSES_CORE.genSpec(props.state)
  const t = props.t
  const scope = props.scope ? t('a11y.scope' + props.scope) : ''
  const label = t('a11y.genState', { scope: scope, state: t(AIC_COURSES_CORE.GEN_STATE_KEY[spec.key]) })
  return h(
    'span',
    {
      className: 'aic-genstate ' + AIC_COURSES_CORE.GEN_CLASS[spec.key],
      role: 'img',
      'aria-label': label,
      title: label,
    },
    h(StateGlyph, { kind: spec.glyph }),
  )
}

function LearnIcon (props) {
  const spec = AIC_COURSES_CORE.learnSpec(props.state)
  const t = props.t
  const scope = props.scope ? t('a11y.scope' + props.scope) : ''
  const label = t('a11y.learnState', { scope: scope, state: t(AIC_COURSES_CORE.LEARN_STATE_KEY[spec.key]) })
  return h(
    'span',
    {
      className: 'aic-learnstate ' + AIC_COURSES_CORE.LEARN_CLASS[spec.key],
      role: 'img',
      'aria-label': label,
      title: label,
    },
    h(StateGlyph, { kind: spec.glyph }),
  )
}

function TypeIcon (props) {
  const label = props.t('a11y.type', { type: props.type })
  return h(
    'span',
    { className: 'aic-kp__type', role: 'img', 'aria-label': label, title: label },
    h(Icon, { name: AIC_TYPE_ICON[props.type] || 'article' }),
  )
}

/* --------------------------------------------------------------- 小控件 */
/** 纯图标按钮：**必须有** title + aria-label（06 §8）。
 *
 * 类名一律写**字面量**（不拼接）：`scripts/check.mjs` 靠它断言「用到的类都有样式规则」。
 * `tone: 'structure'` 是「章节编辑」这个开关专用的外观：**默认灰、选中黑**，
 * 且不铺底色（靠 `[aria-pressed]` 区隔），与行内其它图标按钮的「按下变底」区分开。 */
function IconButton (props) {
  const cls = props.tone === 'structure'
    ? 'aic-iconbtn aic-iconbtn--structure'
    : props.pressed ? 'aic-iconbtn aic-iconbtn--on' : 'aic-iconbtn'
  return h(
    'button',
    {
      className: cls,
      type: 'button',
      title: props.label,
      'aria-label': props.label,
      'aria-pressed': props.pressed === undefined ? undefined : String(!!props.pressed),
      disabled: props.disabled ? true : undefined,
      onClick: props.onClick,
    },
    h(Icon, { name: props.name }),
  )
}

/** 学习时长；`duration` 缺失时**整行不渲染**（06 §5 / AC-24）。 */
function DurationLabel (props) {
  const minutes = props.minutes
  if (!minutes) return null
  return h(
    'span',
    { className: 'aic-duration' },
    h(Icon, { name: 'clock' }),
    h('span', { className: 'aic-sr-only' }, props.t('lesson.duration')),
    h('span', null, props.t('lesson.minutes', { n: minutes })),
  )
}

/**
 * 旋转的加载图标（生成中）。
 *
 * 为什么单独一个组件：生成进度**不用进度条** —— 逐项生成时完成了多少并不能反映"还要多久"
 * （一个知识点可能比三个还慢），一根条形反而给人错误的预期；转动的图标只表达"还在跑"。
 * `prefers-reduced-motion` 下不转（06 §8）。
 */
function Spinner (props) {
  return h(
    'span',
    { className: 'aic-spinner', role: 'img', 'aria-label': props.label || '' },
    h(
      'svg',
      { viewBox: '0 0 20 20', width: '16', height: '16', fill: 'none', stroke: 'currentColor', strokeWidth: '1.8', strokeLinecap: 'round', 'aria-hidden': 'true', focusable: 'false' },
      h('path', { d: 'M10 2.8a7.2 7.2 0 1 1-7.2 7.2' }),
    ),
  )
}

/** 进度条：语义是**已完成 / 总数**（06 §3.2 的卡片进度与 §4.4 的生成进度共用）。 */
function ProgressBar (props) {
  const pct = Math.round(Math.max(0, Math.min(1, Number(props.ratio) || 0)) * 100)
  return h(
    'div',
    {
      className: 'aic-progress',
      role: 'progressbar',
      'aria-valuenow': String(pct),
      'aria-valuemin': '0',
      'aria-valuemax': '100',
      'aria-label': props.t('a11y.progress', { pct: pct }),
    },
    h('div', { className: 'aic-progress__bar', style: { width: pct + '%' } }),
  )
}

/** 通知条（降级 / 提示 / 告警）。 */
function Notice (props) {
  return h(
    'div',
    { className: 'aic-notice' },
    h('span', { className: 'aic-notice__mark', 'aria-hidden': 'true' }, '!'),
    h('span', null, props.children),
  )
}

/**
 * 面包屑（自写，不复制宿主控件）：`有 onClick 的段是链接，没有的是当前段`。
 * 末段用**页面名**而不是实体标题 —— 实体标题由紧邻的 h1 承担（06 §4.1）。
 */
function Breadcrumb (props) {
  return h(
    'nav',
    { className: 'aic-crumbs', 'aria-label': props.t('a11y.crumbs') },
    h(
      'ol',
      { className: 'aic-crumbs__list' },
      (props.items || []).map((it, i) =>
        h(
          'li',
          { className: 'aic-crumbs__item', key: i },
          i > 0 ? h('span', { className: 'aic-crumbs__sep', 'aria-hidden': 'true' }, '›') : null,
          it.onClick
            ? h('button', { className: 'aic-crumbs__link', type: 'button', onClick: it.onClick }, it.label)
            : h('span', { className: 'aic-crumbs__current', 'aria-current': 'page' }, it.label),
        ),
      ),
    ),
  )
}
