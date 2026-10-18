/* ============================================================================
 * 内容生成链路（T-11 / FR-2·FR-3·FR-4）
 *
 * 分四段，每段都可单独测：
 *   ① `buildContentPrompt` —— 给模型的指令 + 上下文（纯字符串）
 *   ② `parseContent`       —— 解析并**规范化**模型回包（纯函数，含 H1 剥离、SVG 清洗）
 *   ③ `selectTargets`      —— 三种粒度（课程 / 章节 / 知识点）→ 实际要生成的知识点列表
 *   ④ `generateOne`        —— 调模型 → 解析 → 一个事务里落正文 + 信封 + 媒体
 *
 * 只有 ④ 里的「调模型」需要宿主 `subagents`，因此注入成 `callModel`（冒烟传假的）。
 *
 * 三条硬约束（05 §5.4 / §5.4.1 / Q-7）：
 *   · 正文**不得**出现 `h1`（页面标题已经展示了知识点名称）；`幻灯片` 除外（每页的 `#` 是页标题）
 *   · `图文`/`幻灯片` 的 `mediaRefs` **至少 1 个** → 生成时必须产出一张 SVG 示意图（纯本地、无外部依赖）
 *   · 路径一律由宿主计算，模型只给「内容」
 * ========================================================================== */

import {
  MARKDOWN_TYPES, SLIDEV_TYPES, nextMediaRelPath, writeAsset, readAssetPayload,
} from './28-assets.mjs'
import { formatSourcesBlock, extractRefs, mergeSources, MAX_SOURCES } from './07-sources.mjs'

/** v1「Markdown 降级」的四种类型：格式未定稿，先按 Markdown 生成，界面标注「格式待定」。 */
/**
 * v1 按「Markdown 降级」处理的四种类型（Q-19 的后续口径：格式未定稿，先让它们能用，
 * 界面上标注「格式待定」）。名字刻意不与 28-assets 的 `MARKDOWN_TYPES` 相同 ——
 * 构建会把各段拼进**同一个模块**，同名 `const` 会直接让 import 失败（踩过）。
 */
export const FALLBACK_TYPES = ['音频', '视频', '代码', '测验']

/** 生成内容的 JSON 形状（给模型看的契约）。 */
export const CONTENT_SHAPE = `// body 只覆盖「← 本次」那一个知识点；不要写同章节其他知识点或其他章节的内容
{
  "title": "知识点名称（原样照抄，不要改写）",
  "body": "正文 Markdown（见下面的规则）",
  "diagram": { "alt": "这张图的说明", "svg": "<svg …>…</svg> 的完整内容" }
}`

export const CONTENT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['title', 'body'],
  properties: {
    title: { type: 'string' },
    body: { type: 'string' },
    /* `diagram` 不放进 required：宽松一点，缺图时由解析层兜底（补一张占位示意图），
       不让「少一张图」升级成「整次生成失败」 */
    diagram: {
      type: 'object',
      additionalProperties: false,
      required: ['alt', 'svg'],
      properties: {
        alt: { type: 'string' },
        svg: { type: 'string' },
      },
    },
  },
}

/* ---------------------------------------------------------------- ① 提示词 */

const COMMON_RULES = `你在为一个「本地 AI 课程」应用写**一个知识点**的学习内容。必须遵守：

1. **范围由课程大纲界定**（见下方「课程大纲」与「本次要写的知识点」）：
   - 只写**标记为「← 本次」的那一个**知识点，不要写别的知识点，也不要替它们**预告内容**；
   - **不许越界**：出现在其他章节里的知识点，即使与本次相关，本次也只做**一句话的衔接**，
     不展开讲解（它们各自有专门的内容）；
   - 如果本次知识点需要先解释某个前置概念，而那个概念**是另一个知识点**，就把读者引到那一节，
     而不是把它写一遍；
   - 不要重复标题（页面标题已经展示它）。
2. 语言与课程一致（默认中文），面向**已经会一点、但不熟悉这个主题**的读者。
3. 正文必须自足：读者只看这一段就能理解，不依赖外部链接。
4. **不要写任何图片链接**（图片由后面的 diagram 字段提供，宿主会自己插入）。
5. 只回一个 JSON 对象，不要解释、不要 Markdown 代码围栏之外的内容。`

const MARKDOWN_RULES = `正文是 **Markdown 子集**，规则：
- **不要写 H1（一级标题）**，也不要开头再写一遍知识点名称（页面标题已经展示它）；层级从 \`##\` 开始。
- 可用：\`##\`/\`###\` 标题、段落、有序/无序列表、\`**粗体**\`、行内代码、围栏代码块（带语言）、引用、**表格**。
- **表格用 Markdown 管道表**（\`| 列 | 列 |\` + \`|---|---|\` 分隔行）；**不要写 HTML 标签**
  （\`<table>\`、\`<div>\`、\`<br>\` 这类都不渲染 —— 页面只认 Markdown 子集）。
- 长度：**400~900 字**为宜（含代码/表格）。短而准，不要灌水。
- 结构建议：先给一句「这是什么/为什么重要」，再分 2~4 个小节讲清机制与边界，最后给一个常见误区或小结。`

const SLIDEV_RULES = `正文是 **Slidev 方言 Markdown**（本应用只支持它的一个子集），规则：
- 文件以 headmatter 开头：

  ---
  title: <知识点名称>
  ---

- **分页**用一行**恰好**是 \`---\`；每页开头可选一个 frontmatter 块（只支持 \`layout\` / \`title\`）。
- 每页用 \`#\` 写**本页**标题（这里是允许的，它是页标题不是页面标题）。
- 支持的 \`layout\`：\`default\`、\`cover\`、\`center\`、\`two-cols\`、\`two-cols-header\`、\`image-right\`、\`image-left\`、\`quote\`。
- 讲稿（演讲者备注）写在**该页末尾**的 HTML 注释块里：\`<!-- 讲稿文字 -->\`。
- 页数 **4~8 页**：封面 1 页 + 内容 3~6 页 + 小结 1 页。
- **表格用 Markdown 管道表**（\`| 列 | 列 |\` + \`|---|---|\` 分隔行）。**不要写 HTML 标签**
  （\`<table>\` / \`<div>\` / \`<br>\` 这类一律不要 —— 页面只渲染 Markdown 子集）。
- 每页正文建议 **3~6 个要点/段落**，别把一页塞满：版式是固定画布。
- 不要使用 Slidev 的交互特性（\`<v-click>\`、\`:::\`、组件、代码运行）；**Mermaid 除外**（见下）。`

const DIAGRAM_RULES = `**图表优先级**：凡是结构类信息（流程 / 时序 / 状态 / 关系 / 分层），**先**在正文里用
**Mermaid 代码块**表达（\`\`\`mermaid 围栏 + \`flowchart TD\` / \`sequenceDiagram\` / \`stateDiagram-v2\` /
\`classDiagram\` / \`erDiagram\`）—— 它是最直接可渲染的 Markdown 图表，应用会画出来。
这种情况**可以不写** \`diagram\`；只有 Mermaid 表达不了（精确空间位置、插画式示意）才补一张 SVG。

另外可以再给一张**示意图**（\`diagram\`，可选）：
- \`svg\` 是**完整的内联 SVG 元素**（\`<svg viewBox="0 0 640 360" …>…</svg>\`）。
- 只用：\`rect\` \`circle\` \`ellipse\` \`line\` \`path\` \`polygon\` \`polyline\` \`text\` \`tspan\` \`g\` \`defs\` \`marker\`。
- **禁止**：\`<script>\`、\`<style>\`、\`<foreignObject>\`、\`<image>\`、\`on*\` 事件属性、\`javascript:\`、外部链接。
- 颜色用 \`currentColor\` 或 \`#333\`/\`#888\`/\`#e5e7eb\` 这类中性色（要能在深色主题下看清），**不要**用大面积纯白背景。
- 文字用 \`font-size="14"\` 左右、\`fill="currentColor"\`；整体是一张**结构/流程示意图**，不要装饰性花纹。
- \`alt\` 是一句中文说明（会作为无障碍替代文本）。`

/**
 * 课程大纲区块：把**整门课**的结构贴给模型，并标出「本次要写的位置」。
 *
 * 为什么必须给：
 *   · **防越界** —— 不问大纲时，模型会把相邻知识点（甚至整章）的内容一起写了，
 *     于是同一门课里出现多段重复正文；把大纲 + 当前位置摆出来，边界才是可判定的。
 *   · **防重复** —— 章节内其他知识点与别的章节的标题都看得见，措辞自然会避重。
 *
 * 体积控制：知识点很多时只做**保守截断**（默认 60 个），且**当前章节永远完整保留**
 * —— 上下文比「列全」更重要，但当前章节的边界不能因为截断而丢失。
 *
 * @param {object} input `{ course, chapter, kp, limit? }`
 * @returns {string} 多行文本（`## 课程大纲` + 章节与知识点清单）
 */
export function buildOutlineBlock ({ course, chapter, kp, limit = 60 } = {}) {
  const chapters = (course && course.outline && course.outline.chapters) || []
  const total = chapters.reduce((n, ch) => n + ((ch.knowledgePoints || []).length), 0)
  const lines = []
  lines.push('课程大纲（`← 本次` 是**唯一**要写的知识点；其他条目只是边界参照）：')
  for (const ch of chapters) {
    const kps = ch.knowledgePoints || []
    const isHere = chapter && ch.id === chapter.id
    /* 当前章节永不截断；其他章节在超限时只列标题 */
    const showAll = isHere || total <= limit
    lines.push(`${ch.order}. ${ch.name}${isHere ? '   ← 本次所在章节' : ''}`)
    if (!showAll) {
      lines.push('   （略：本章知识点与本次无关，只作边界参照）')
      continue
    }
    for (const k of kps) {
      const mark = isHere && kp && k.id === kp.id ? '   ← 本次' : ''
      lines.push(`   ${ch.order}.${k.order} ${k.name}${mark}`)
    }
  }
  if (total > limit) lines.push(`（整门课共 ${total} 个知识点，上面只展开了本次所在章节，其余章节按标题列出。）`)
  return lines.join('\n')
}

/**
 * 给模型的完整指令。
 * @param {object} input
 *   `{ kp, chapter, course, contentType, prompt }` —— `course` 必须带完整 `outline`，
 *   因为 prompt 里会贴**整门课的大纲**并标出「本次」位置（防越界、防重复）。
 */
export function buildContentPrompt ({ kp, chapter, course, contentType, prompt, sources = [], existing = null }) {
  const lines = []
  lines.push(COMMON_RULES)
  lines.push('')
  lines.push(SLIDEV_TYPES.indexOf(contentType) >= 0 ? SLIDEV_RULES : MARKDOWN_RULES)
  /* **追加模式**：这个知识点已经有内容，这次只写"新增的部分" ——
     明确告诉模型现有结构（标题清单），避免复述已经讲过的段落。 */
  if (existing && existing.body) {
    const heads = String(existing.body).split('\n')
      .map((l) => /^#{2,4}\s+(.+)$/.exec(l))
      .filter(Boolean)
      .map((m) => m[1].trim())
      .slice(0, 20)
    lines.push('')
    lines.push('⚠️ **已有内容会被保留**，你这次生成的内容会**追加**在它后面。所以：')
    lines.push('- 只写**补充**：新的角度、更深的机制、额外的示例/边界、常见坑；')
    lines.push('- **不要**重复已有的小节标题与结论，也不要重写导语；')
    lines.push('- 新内容是独立可读的一段，标题层级接在 `##` 之后。')
    if (heads.length) {
      lines.push('')
      lines.push('已有内容的小节（不要重复这些主题）：')
      for (const h of heads) lines.push(`- ${h}`)
    }
  }

  /* 每种类型都要一张示意图：图文/幻灯片是硬约束（Q-7），其余类型也一起给（同一套体验） */
  lines.push('')
  lines.push(DIAGRAM_RULES)
  if (FALLBACK_TYPES.indexOf(contentType) >= 0) {
    lines.push('')
    lines.push(`⚠️ 这个知识点的内容类型是「${contentType}」，该类型的专用格式**尚未定稿**：请按上面的 Markdown 规则写出可用于学习的正文，应用会按「格式待定」降级展示。`)
  }
  lines.push('')
  lines.push('---')
  lines.push('')
  lines.push(`课程：${course.name}`)
  /* **大纲会话的题面**：建课时用户原话。带上它，知识点生成与大纲生成共享同一份上下文，
     不必每次从零推断"用户到底想要什么"（也避免把风格/深度理解偏）。 */
  if (course.request) {
    lines.push(`课程原始诉求（用户建课时的原话，用来对齐深浅与风格）：${String(course.request).trim()}`)
  }
  if (course.description) lines.push(`课程说明：${course.description}`)
  if (course.difficulty) lines.push(`难度：${course.difficulty}`)
  if (Array.isArray(course.tags) && course.tags.length) lines.push(`领域标签：${course.tags.join('、')}`)
  lines.push(`所属章节：第 ${chapter.order} 章 ${chapter.name}`)
  if (chapter.description) lines.push(`章节说明：${chapter.description}`)
  lines.push('')
  lines.push(buildOutlineBlock({ course, chapter, kp }))
  lines.push('')
  lines.push(`本次要写的知识点：**${kp.name}**（内容类型 ${contentType}，建议学习时长 ${kp.duration} 分钟）`
    + '\n（就是大纲里标着 `← 本次` 的那一条：只写它，不许写到别的条目上。）')
  /* 引用资料（用户诉求/大纲里提到的文件）：放在正文要求**之前**，让它成为写作依据 */
  if (Array.isArray(sources) && sources.length) {
    const block = formatSourcesBlock(sources)
    if (block) {
      lines.push('')
      lines.push(block)
    }
  }
  if (prompt && String(prompt).trim()) {
    lines.push('')
    lines.push('用户对这次生成的额外要求（优先满足）：')
    lines.push(String(prompt).trim())
  }
  lines.push('')
  lines.push('请严格按下面的 JSON 形状输出：')
  lines.push(CONTENT_SHAPE)
  return lines.join('\n')
}

/* ------------------------------------------------------------ ② 解析回包 */

const H1_LINE = /^\s{0,3}#\s+\S/
const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/

/** 从围栏里抠 JSON（容忍裸 JSON / ```json 围栏 / 正文里夹一个对象）。 */
export function parseJsonLoose (text) {
  let raw = String(text ?? '').trim()
  if (!raw) throw new Error('模型返回为空')
  /* ⚠️ **只在整段被围栏包住时**才脱围栏：旧写法（任意位置的 ``` … ```）会把
     「JSON 里含一个代码块」的正文从第一个 ``` 截到最后一个 ```，把整个 JSON 撕碎
     （真实回包里 `body` 就常带 ```js 代码块 —— 踩过）。 */
  const fenced = /^\s*```(?:json)?\s*\r?\n([\s\S]*?)\r?\n?```\s*$/i.exec(raw)
  if (fenced) raw = fenced[1].trim()
  try {
    return JSON.parse(raw)
  } catch {
    const s = raw.indexOf('{')
    const e = raw.lastIndexOf('}')
    if (s < 0 || e <= s) throw new Error('模型返回里找不到 JSON 对象')
    try { return JSON.parse(raw.slice(s, e + 1)) } catch { throw new Error('模型返回的 JSON 无法解析') }
  }
}

/* -- SVG 清洗：白名单元素/属性，剔除脚本与外部引用（正文是不可信输入，06 §7.1 的同一条原则） -- */

const SVG_ALLOWED_TAGS = new Set(['svg', 'g', 'defs', 'marker', 'rect', 'circle', 'ellipse', 'line', 'path', 'polygon', 'polyline', 'text', 'tspan', 'title', 'desc'])

/** SVG 里**没有子节点**的元素：必须自闭合（`<path … />`），否则就是非法 XML（E-36）。 */
const SVG_VOID_TAGS = new Set(['path', 'rect', 'circle', 'ellipse', 'line', 'polygon', 'polyline'])
/* 属性名**大小写敏感**：SVG 是 XML，`viewBox` 写成 `viewbox` 在浏览器里不生效（图会塌成 0 高）。
   所以白名单按小写匹配，但输出时用**规范大小写**。 */
const SVG_ATTR_CANON = {
  viewbox: 'viewBox', preserveaspectratio: 'preserveAspectRatio', markerwidth: 'markerWidth',
  markerheight: 'markerHeight', gradientunits: 'gradientUnits', patternunits: 'patternUnits',
  textanchor: 'textAnchor', dominantbaseline: 'dominantBaseline', fontsize: 'fontSize',
  fontfamily: 'fontFamily', fontweight: 'fontWeight', strokewidth: 'strokeWidth',
  strokedasharray: 'strokeDasharray', strokelinecap: 'strokeLinecap', strokelinejoin: 'strokeLinejoin',
  strokeopacity: 'strokeOpacity', fillopacity: 'fillOpacity', fillrule: 'fillRule',
  markerend: 'markerEnd', markerstart: 'markerStart', markermid: 'markerMid',
}

const SVG_ALLOWED_ATTRS = new Set([
  'viewbox', 'width', 'height', 'x', 'y', 'x1', 'y1', 'x2', 'y2', 'cx', 'cy', 'r', 'rx', 'ry',
  'd', 'points', 'transform', 'fill', 'fill-opacity', 'fill-rule', 'stroke', 'stroke-width',
  'stroke-opacity', 'stroke-dasharray', 'stroke-linecap', 'stroke-linejoin', 'opacity',
  'font-size', 'font-family', 'font-weight', 'text-anchor', 'dominant-baseline', 'marker-end',
  'marker-start', 'marker-mid', 'id', 'refx', 'refy', 'markerwidth', 'markerheight', 'orient',
  'preserveaspectratio', 'xmlns',
])

/**
 * 把模型给的 SVG 洗成**安全的内联 SVG**。
 * 返回 `null` 表示「不可用」（调用方会退回占位示意图，而不是让整次生成失败）。
 */
export function sanitizeSvg (input) {
  let svg = String(input ?? '').trim()
  if (!svg) return null
  const start = svg.indexOf('<svg')
  const end = svg.lastIndexOf('</svg>')
  if (start < 0 || end < 0) return null
  svg = svg.slice(start, end + 6)
  /* 先整体拒掉最危险的构造（避免"解析器没识别出来就放行"） */
  if (/<script|javascript:|<foreignObject|<iframe|<image\b|<!ENTITY|<\?xml-stylesheet/i.test(svg)) return null
  if (/\son[a-z]+\s*=/i.test(svg)) return null
  if (!/viewBox\s*=/i.test(svg)) return null

  /* 逐标签过白名单：不在白名单里的元素整段丢弃（含内容），属性不在白名单里就删掉。
     ⚠️ 自闭合必须保住：`<path … />` 的 `/` 一旦丢了，产出就是**非法 XML**
     （`mismatched tag`）—— 浏览器用 `<img>` 载入 SVG 时要求严格 XML，直接**不显示**。
     真机上就是这样：媒体文件都在、路由也通，图却一张都不出来（见 E-36）。 */
  const out = []
  const tagRe = /<\/?([A-Za-z][\w:-]*)((?:"[^"]*"|'[^']*'|[^>"'])*?)(\/?)>/g
  let last = 0
  let m
  while ((m = tagRe.exec(svg)) !== null) {
    out.push(svg.slice(last, m.index))
    last = tagRe.lastIndex
    const name = m[1].toLowerCase()
    if (!SVG_ALLOWED_TAGS.has(name)) continue
    if (m[0].startsWith('</')) {
      /* 空元素（path/rect/…）在 SVG 语义里**不可能有子节点**：模型多写一个 `</path>`
         就丢掉，否则会变成标签错配（也是非法 XML） */
      if (!SVG_VOID_TAGS.has(name)) out.push(`</${name}>`)
      continue
    }
    const attrs = []
    /* 同一元素上同名属性只留第一个：重复属性是非法 XML（`duplicate attribute`，E-36） */
    const seen = new Set()
    const attrRe = /([A-Za-z_:][\w:.-]*)\s*=\s*("([^"]*)"|'([^']*)')/g
    let a
    while ((a = attrRe.exec(m[2] || '')) !== null) {
      const key = a[1].toLowerCase()
      if (!SVG_ALLOWED_ATTRS.has(key) || seen.has(key)) continue
      seen.add(key)
      const value = (a[3] !== undefined ? a[3] : a[4]).replace(/"/g, '&quot;')
      attrs.push(`${SVG_ATTR_CANON[key] || key}="${value}"`)
    }
    /* 空元素**一律**写成自闭合：这既是规范写法，也能把「丢过 `/`」的旧文件洗回合法 XML */
    const selfClose = m[3] || SVG_VOID_TAGS.has(name)
    out.push(`<${name}${attrs.length ? ' ' + attrs.join(' ') : ''}${selfClose ? ' />' : '>'}`)
  }
  out.push(svg.slice(last))
  let cleaned = out.join('')
  /* ⚠️ 两次见到同一个属性会产出非法 XML（`<svg xmlns=… xmlns=…>`）——模型几乎总会自己带 `xmlns`，
     所以**只有缺的时候才补**（早期版本无条件补，落盘的 SVG 是重复属性，严格 XML 解析器会报错）。 */
  if (!/<svg[^>]*\sxmlns\s*=/i.test(cleaned)) cleaned = cleaned.replace(/<svg/i, '<svg xmlns="http://www.w3.org/2000/svg"')
  /* 最后一道：**形状自检**。不合格就回 null（调用方落占位示意图），绝不把坏 SVG 写进课程库。
     坏图比没图更糟：文件在、路由通、浏览器就是不显示，排查成本极高。 */
  return isWellFormedSvg(cleaned) ? cleaned : null
}

/**
 * SVG「形状自检」：不依赖 DOM，检查严格 XML 的关键几条。
 *
 * 为什么不能只信解析器：宿主侧没有 DOM（也不引第三方解析器），而这里产出会被浏览器
 * 当作**严格 XML** 解析（`<img src="*.svg">`）。所以只校最致命的三种：
 *   ① 没有 `<script>` / 外部引用（安全检查已有，这里兜底）；
 *   ② 每个开标签都闭合（`<path>` 必须有 `/>` 或 `</path>`）；
 *   ③ 没有重复属性（同一元素上同名属性出现两次 → XML 非法）。
 *
 * @param {string} text 已清洗的 SVG 文本
 * @returns {boolean}
 */
export function isWellFormedSvg (text) {
  const s = String(text || '')
  if (!/^<svg[\s>]/i.test(s.trim())) return false
  if (!/viewBox\s*=/i.test(s)) return false
  const VOID_OK = new Set(['path', 'rect', 'circle', 'ellipse', 'line', 'polygon', 'polyline'])
  const stack = []
  const tagRe = /<(\/?)([A-Za-z][\w:-]*)((?:"[^"]*"|'[^']*'|[^>"'])*?)(\/?)>/g
  let m
  let count = 0
  while ((m = tagRe.exec(s)) !== null) {
    count++
    const [, close, rawName, rawAttrs, selfClose] = m
    const name = rawName.toLowerCase()
    /* 重复属性检查（只对带值的属性；`xmlns` 这种也查） */
    const seen = new Set()
    const attrRe = /([A-Za-z_:][\w:.-]*)\s*=/g
    let a
    while ((a = attrRe.exec(rawAttrs || '')) !== null) {
      const key = a[1].toLowerCase()
      if (seen.has(key)) return false
      seen.add(key)
    }
    if (close) {
      if (!stack.length || stack.pop() !== name) return false
      continue
    }
    if (selfClose) continue
    if (VOID_OK.has(name)) {
      /* 自闭合写法的空元素必须写 `/>`；写成 `<path>` 就是未闭合 → 非法 */
      return false
    }
    stack.push(name)
  }
  if (count === 0) return false
  return stack.length === 0
}

/**
 * 按**实际正文**估算学习时长（分钟）。
 *
 * 为什么在生成之后算：大纲阶段的「估计」和正文毫无关系 —— 之前每个知识点都显示
 * 一个凭空来的 10 分钟。真正能支撑这个数字的只有已经写出来的内容。
 *
 * 口径（可解释、可调）：
 *   · 中文正文 **250 字/分钟**、英文 **150 词/分钟**、代码 **20 行/分钟**；
 *   · 再乘 **1.5** 的「学习系数」—— 时长是**学会**的时间，不是通读一遍的时间
 *     （只按阅读速度算，400~900 字的正文会得出 2 分钟，明显偏短）；
 *   · 幻灯片另按 **1 页 ≈ 0.8 分钟**讲授节奏，与字数取**较大者**；
 *   · 四舍五入到整数分钟，夹在 **1..180**。
 *
 * @param {string} body 正文（可带 frontmatter / 围栏）
 * @param {string} [contentType] 用于幻灯片口径
 * @returns {number} 正整数分钟
 */
export function estimateMinutes (body, contentType) {
  const text = String(body ?? '')
  /* 代码围栏单独算：里面的字符不该按「读散文」的速度计 */
  const codeLines = []
  let prose = text
  const fenceRe = /^```[^\n]*\n([\s\S]*?)^```/gm
  let m
  while ((m = fenceRe.exec(text)) !== null) codeLines.push(m[1].split('\n').length)
  prose = prose.replace(fenceRe, ' ')
  /* 去掉 frontmatter（它不是给人读的正文） */
  prose = prose.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, ' ')
  const cjk = (prose.match(/[\u3400-\u9fff\uf900-\ufaff]/g) || []).length
  const words = (prose.replace(/[\u3400-\u9fff\uf900-\ufaff]/g, ' ').match(/[A-Za-z0-9_]+/g) || []).length
  const code = codeLines.reduce((n, v) => n + v, 0)
  /* 1.5 是「学习系数」：按时长=通读速度算出来的数字太短（见上面的口径说明） */
  let minutes = (cjk / 250 + words / 150 + code / 20) * 1.5
  if (SLIDEV_TYPES.indexOf(contentType) >= 0) {
    const pages = Math.max(1, (text.match(/^---\s*$/gm) || []).length + 1)
    minutes = Math.max(minutes, pages * 0.8)
  }
  return Math.min(180, Math.max(1, Math.round(minutes)))
}

/** 极简占位示意图（模型没给图或图不可用时用它兜底，保证「图文必须 ≥1 媒体」这条约束成立）。 */
export function placeholderSvg (title) {
  /* 标题来自模型/用户编辑，**必须转义**：`</text><script>…` 这类输入会把占位图变成注入点。
     占位图是宿主自己拼的、不走 sanitizeSvg，所以这里是唯一一道防线。 */
  const text = String(title || '示意图').slice(0, 28)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 640 200" width="640" height="200">`
    + '<rect x="1" y="1" width="638" height="198" rx="12" fill="none" stroke="#888" stroke-dasharray="6 6" stroke-width="2"/>'
    + `<text x="320" y="105" text-anchor="middle" font-size="20" font-family="sans-serif" fill="currentColor">${text}</text>`
    + '</svg>'
}

/** 剥掉模型可能自己加的 frontmatter（正文 frontmatter 由宿主统一写）。 */
export function stripFrontmatter (body) {
  return String(body ?? '').replace(FRONTMATTER, '')
}

/** 剥掉 H1 行（05 §5.4.1：正文里不得出现 `h1`，层级从 h2 开始）。 */
export function stripH1 (body) {
  return String(body ?? '')
    .split('\n')
    .filter((line) => !H1_LINE.test(line))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/** 去掉正文里所有图片引用（图由宿主插入，避免模型给出不可用的外部路径）。 */
export function stripImages (body) {
  return String(body ?? '')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/** 在正文的第一个段落之后插入图片引用（位置稳定、可断言）。 */
export function insertFigure (body, relFromBody, alt) {
  /* alt 来自模型/用户编辑：去 `[]`（会破坏图片语法）、压掉换行与连续空白（会拆散一行） */
  const altText = String(alt || '').replace(/[\[\]]/g, '').replace(/\r?\n/g, ' ').replace(/\s+/g, ' ').trim()
  const line = `![${altText}](${relFromBody})`
  const lines = String(body ?? '').split('\n')
  let i = 0
  let seen = 0
  while (i < lines.length) {
    const isBlank = lines[i].trim() === ''
    if (!isBlank && (i === 0 || lines[i - 1].trim() === '')) {
      /* 一个段落的开始：往下跳到它的结尾 */
      let j = i
      while (j < lines.length && lines[j].trim() !== '') j++
      seen++
      if (seen === 1) {
        return [...lines.slice(0, j), '', line, ...lines.slice(j)].join('\n')
      }
      i = j
      continue
    }
    i++
  }
  return lines.join('\n') + '\n\n' + line
}

/**
 * 把示意图插进**某一页幻灯片**。
 *
 * 选页顺序（确定性，便于断言）：
 *   ① 版式为 `image-right` / `image-left` / `two-cols` 的页（模型显然为图留了位置）
 *   ② 否则倒数**第二**页（末页通常是小结，封面不该放图）；只有一页时就用那一页
 *   ③ 一页都没有时 → 什么都没有（调用方会用空讲义报错）
 * 不重复插入：该页已经有图片引用就直接返回。
 */
export function insertSlideFigure (slides, figure) {
  const list = Array.isArray(slides) ? slides.slice() : []
  if (!figure || !figure.figureRel || list.length === 0) return list
  const altText = String(figure.alt || '').replace(/[\[\]]/g, '').replace(/\r?\n/g, ' ').replace(/\s+/g, ' ').trim()
  const line = `![${altText}](${figure.figureRel})`
  const hasImg = (s) => /!\[[^\]]*\]\([^)]*\)/.test(s)
  let target = list.findIndex((s) => /layout:\s*(image-right|image-left|two-cols|two-cols-header)/.test(s))
  if (target < 0) target = list.length >= 2 ? list.length - 2 : 0
  if (hasImg(list[target])) return list
  list[target] = `${list[target]}\n\n${line}`
  return list
}

/** 正文写入文件时统一补 frontmatter（05 §5.4.1：`title` 让文件脱离应用也自描述）。 */
export function withFrontmatter (title, body) {
  /* 标题里的换行会破坏 YAML frontmatter（`title: a\nb` 变成两个键）；
     压成单行，其余字符（含 `:`）由本插件的解析器按「第一个冒号后整段取值」处理。 */
  const t = String(title || '').replace(/"/g, "'").replace(/\r?\n/g, ' ').replace(/\s+/g, ' ').trim()
  return `---\ntitle: ${t}\n---\n\n${String(body ?? '').trim()}\n`
}

/* -- 幻灯片规范化：补 headmatter、保证有分页、校验收尾 -- */

export function normalizeSlidev (raw, title, figure) {
  const body = String(raw ?? '').trim()
  /* 模型可能自己带了 headmatter（`title` 也可能漏）—— 一律丢给宿主重写，
     保证 headmatter 的形状与 `title` 逐字来自课程数据，而不是模型的自述。 */
  const head = body.match(FRONTMATTER)
  const slidesSource = head ? body.slice(head[0].length) : body
  const slides = slidesSource
    .split(/\r?\n---\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean)
  if (slides.length === 0) throw new Error('幻灯片正文为空（没有任何一页）')
  const titleText = String(title || '封面').replace(/\r?\n/g, ' ').replace(/\s+/g, ' ').trim()
  const fixed = slides.map((s, i) => {
    if (i === 0 && !/^#\s/m.test(s)) return `# ${titleText}\n\n${s}`
    return s
  })
  const withFigure = insertSlideFigure(fixed, figure)
  return withFrontmatter(titleText, withFigure.join('\n\n---\n\n'))
}

/* --------------------------------------------------- ②' 规范化 + 校验 */

/**
 * 把模型回包规范化成可落库的形状。
 * @returns `{ title, body, media: [{ rel, text }], contentType, fallback }`
 * @throws 结构化错误（原因直接可展示给用户）
 */
export function parseContent (text, { kp, contentType, kpId } = {}) {
  const obj = parseJsonLoose(text)
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) throw new Error('模型返回的不是 JSON 对象')
  const title = String(obj.title || (kp && kp.name) || '').trim()
  const rawBody = String(obj.body || '')
  if (!title) throw new Error('模型没有给出标题')
  if (!rawBody.trim()) throw new Error('模型没有给出正文')

  /* 图表：正文里**已经有 Mermaid 图**时就不再产媒体、不再插图 ——
     Mermaid 是纯文本、随正文一起渲染，比外部 SVG「更直接可渲染」（用户口径）。
     否则退回 `diagram.svg`（模型没给或图不可用 → 占位示意图，保证「图文/幻灯片 ≥1 媒体」）。 */
  const hasMermaid = /```\s*mermaid\b/i.test(rawBody)
  const svg = hasMermaid ? '' : (sanitizeSvg(obj.diagram && obj.diagram.svg) || placeholderSvg(title))
  const rel = hasMermaid ? '' : nextMediaRelPath(kpId, [])
  const media = hasMermaid ? [] : [{ rel, text: svg }]
  const alt = (obj.diagram && obj.diagram.alt) || `${title} 示意图`

  let body
  if (SLIDEV_TYPES.indexOf(contentType) >= 0) {
    /* 幻灯片：每页的 `#` 是页标题，**不做** H1 剥离；示意图要**真的插进某一页**，
       否则文件生成了、mediaRefs 也登记了，但讲义里看不到图（漏过一次）。 */
    body = normalizeSlidev(rawBody, title, hasMermaid ? null : { figureRel: rel.replace('content-assets/', ''), alt })
  } else {
    /* Markdown：剥 frontmatter / H1 / 模型自己写的图片链接。
       有 Mermaid 时**不**再插图引用（正文自足）；没有才在首段之后插入宿主算好的图。 */
    const clean = stripImages(stripH1(stripFrontmatter(rawBody)))
    body = withFrontmatter(title, hasMermaid ? clean : insertFigure(clean, rel.replace('content-assets/', ''), alt))
  }

  return {
    title,
    body,
    media,
    contentType,
    fallback: FALLBACK_TYPES.indexOf(contentType) >= 0,
  }
}

/* --------------------------------------------------------- ③ 目标选择 */

/**
 * 三种粒度 → 实际要生成的知识点列表。
 * - `course`：整门课的全部知识点
 * - `chapter`：`targetIds` 里各章节的知识点
 * - `kp`：`targetIds` 里的知识点本身
 * @returns `[{ ch, kp }]`（保持课程顺序；找不到的目标**静默忽略**，由调用方比对数量给出提示）
 */
export function selectTargets (course, scope, targetIds) {
  const ids = Array.isArray(targetIds) ? targetIds : []
  const chapters = (course && course.outline && course.outline.chapters) || []
  const out = []
  for (const ch of chapters) {
    for (const kp of ch.knowledgePoints || []) {
      if (scope === 'course') out.push({ ch, kp })
      else if (scope === 'chapter' && ids.indexOf(ch.id) >= 0) out.push({ ch, kp })
      else if (scope === 'kp' && ids.indexOf(kp.id) >= 0) out.push({ ch, kp })
    }
  }
  return out
}

/* ------------------------------------------------------- ④ 生成 + 落库 */

/**
 * 生成一个知识点并落库。
 *
 * @param {object} deps
 *   `{ store, courses, now? }`
 * @param {object} input
 *   `{ courseId, kpId, contentType?, prompt?, callModel }`
 *   `callModel(prompt, { kp, contentType }) → Promise<string>`（默认由 30-generate 接线到子 agent）
 * @returns `{ envelope, relPath, mediaRefs, title, fallback }`
 */
export async function generateOne ({ store, courses, callModel }, { courseId, kpId, contentType, prompt, signal, keepExisting = false }) {
  const read = await courses.read(courseId)
  if (!read) throw new Error(`课程不存在：${courseId}`)
  if (read.readOnly) throw new Error('这门课由更高版本写入，本版只读，不能生成内容')
  let found = null
  for (const ch of read.course.outline.chapters) {
    for (const kp of ch.knowledgePoints || []) if (kp.id === kpId) found = { ch, kp }
  }
  if (!found) throw new Error(`知识点不存在：${kpId}`)
  const type = contentType || found.kp.contentType
  /* 整份课程大纲随 prompt 一起发（`buildContentPrompt` 内部调 `buildOutlineBlock`），
     因此不再单独传「同章节其他知识点」—— 大纲里已经全有了，而且带当前位置标记。 */
  /* **引用资源**（T-14）：课程级（诉求/附件，用户主动提供）＋ 章节与知识点描述里提到的路径
     （模型生成/用户后来编辑的内容）。两者的信任级别不同：
       · 用户引用（course.sources）→ 允许读任意文本路径（用户自己点名的资料）；
       · 内容引用（描述/名称）→ 只允许工作区 / 课程库 / 临时目录，防提示注入读 `~/.config/x.json`。
     只读文本、单文件与总量都限量、读失败静默跳过 —— 资料是"参考"，不能把生成搞挂。 */
  const refList = []
  const seenRefs = new Set()
  const pushRefs = (list, allowExternal) => {
    for (const item of list || []) {
      const ref = String((item && item.ref) || item || '').trim()
      if (!ref) continue
      const key = ref.toLowerCase()
      if (seenRefs.has(key) || refList.length >= MAX_SOURCES) continue
      seenRefs.add(key)
      refList.push({ ref: ref, name: (item && item.name) || ref.split('/').pop() || ref, allowExternal })
    }
  }
  pushRefs(mergeSources((read.course && read.course.sources) || []), true)
  pushRefs(mergeSources(
    extractRefs(found.ch && found.ch.description),
    extractRefs(found.kp && found.kp.description),
    extractRefs(found.kp && found.kp.name),
  ), false)
  const sources = []
  if (refList.length && courses && typeof courses.readSource === 'function') {
    for (const ref of refList) {
      const got = await courses.readSource(ref.ref, { allowExternal: ref.allowExternal }).catch(() => null)
      if (got && got.ok) sources.push({ ref: ref.ref, name: ref.name, text: got.text, truncated: got.truncated })
    }
  }
  /* **追加模式**：这个知识点已有内容时，把旧正文一起给模型（并告它别重复） */
  const existing = keepExisting
    ? await readAssetPayload(store, courseId, kpId, type).catch(() => null)
    : null
  const existingAsset = existing && existing.hasAsset ? existing : null
  const promptText = buildContentPrompt({
    kp: found.kp,
    chapter: found.ch,
    course: read.course,
    contentType: type,
    prompt,
    sources,
    existing: existingAsset,
  })
  const raw = await callModel(promptText, { kp: found.kp, chapter: found.ch, course: read.course, contentType: type, signal })
  const parsed = parseContent(raw, { kp: found.kp, contentType: type, kpId, courseId })
  /* 追加模式：正文拼在旧内容之后，媒体**追加**而不是覆盖 ——
     · 旧图必须原样留在信封里（文件不动，内容读出来再写同一个路径，保证 writeAsset 的契约）；
     · 新图用下一个空序号（`nextMediaRelPath` 会跳过已占用的名字）。 */
  let body = parsed.body
  let media = parsed.media
  if (existingAsset) {
    /* ⚠️ `nextMediaRelPath` 的 `existing` 要的是**完整相对路径**（`content-assets/media/x.svg`），
       而 `readAssetPayload` 回来的 `m.path` 正是这个形状 —— 早期把前缀剥掉再传，导致新图又用了
       `-01.svg` 把旧图覆盖掉（实测两条 mediaRefs 指向同一个文件）。 */
    const oldPaths = (existingAsset.media || []).map((m) => String(m.path || '')).filter(Boolean)
    const kept = []
    for (const rel of oldPaths) {
      const text = await store.readContentText(courseId, rel).catch(() => '')
      if (text) kept.push({ rel, text })
    }
    const fresh = []
    for (const m of parsed.media) {
      const rel = nextMediaRelPath(kpId, oldPaths.concat(fresh.map((f) => f.rel)))
      fresh.push({ rel, text: m.text })
    }
    const isDeck = SLIDEV_TYPES.indexOf(type) >= 0
    /* 幻灯片：新讲义**去掉 headmatter**后接在后面（用 `---` 分页）；图文：一条分隔线 */
    const appended = isDeck
      ? String(parsed.body || '').replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '').trim()
      : String(parsed.body || '').trim()
    body = `${String(existingAsset.body || '').replace(/\s+$/, '')}\n\n${isDeck ? '' : '---\n\n'}${appended}\n`
    media = kept.concat(fresh)
  }
  const written = await writeAsset(store, courseId, {
    kpId,
    contentType: type,
    title: parsed.title,
    body,
    media,
  })
  /* **回填学习时长**：大纲阶段不估计（见 10-prompt 规则 5），只有内容写出来了才有依据。
     失败不影响内容落库（时长是展示用的派生值，不能反过来把生成判失败）。 */
  let duration = null
  if (courses && typeof courses.setDuration === 'function') {
    try {
      duration = estimateMinutes(parsed.body, type)
      await courses.setDuration(courseId, kpId, duration)
    } catch (err) {
      duration = null
      /* 不抛：内容已经原子落盘，时长回填失败只是少一个数字 */
    }
  }
  return {
    envelope: written.envelope,
    relPath: written.relPath,
    mediaRefs: written.mediaRefs,
    title: parsed.title,
    fallback: parsed.fallback,
    duration,
  }
}
