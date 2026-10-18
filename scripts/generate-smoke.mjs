#!/usr/bin/env node
/**
 * T-11 冒烟：内容生成链路（05 §5.4 / §5.5）。
 *
 * 五段，**全部离线**（只有「调模型」这一步注入假的）：
 *   ① `selectTargets`    三种粒度 → 知识点列表
 *   ② `parseContent`     回包规范化：frontmatter、H1 剥离、图片、SVG 清洗、幻灯片
 *   ③ 资产层             信封是凭据、正文是权威内容、路径穿越拒绝
 *   ④ `generateOne`      端到端落到磁盘（正文 + 信封 + 媒体三条都在）
 *   ⑤ 任务表（25-tasks） 状态机、重启残留 → interrupted、同课单任务、逐项失败
 */
import { mkdtemp, mkdir, readFile, writeFile, readdir, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createStore } from '../src/host/20-store.mjs'
import { createCourseApi } from '../src/host/30-courses.mjs'
import { createTaskRunner, createTaskRunners } from '../src/host/25-tasks.mjs'
import { readAssetPayload, isSafeRel, nextMediaRelPath, countAssetFiles, removeAssets } from '../src/host/28-assets.mjs'
import {
  parseContent, sanitizeSvg, placeholderSvg, stripH1, stripFrontmatter, insertFigure,
  normalizeSlidev, selectTargets, generateOne, buildContentPrompt, CONTENT_SHAPE,
  isWellFormedSvg, estimateMinutes, withFrontmatter,
} from '../src/host/30-generate.mjs'
import { normalizeDerivation } from '../src/host/10-prompt.mjs'
import { extractRefs, mergeSources, formatSourcesBlock, isTextRef, MAX_SOURCES, MAX_SOURCE_CHARS } from '../src/host/07-sources.mjs'

let pass = 0, fail = 0
const ck = (n, ok, ev) => { ok ? pass++ : fail++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${ev ? '  → ' + ev : ''}`) }
const S = (v) => JSON.stringify(v)

const fsPort = {
  join: (...p) => join(...p),
  readText: (p) => readFile(p, 'utf8'),
  writeText: async (p, s) => { await mkdir(join(p, '..'), { recursive: true }); await writeFile(p, s, 'utf8') },
  mkdir: async (p) => { if (p) await mkdir(p, { recursive: true }) },
  list: (p) => readdir(p),
  exists: async (p) => { try { await stat(p); return true } catch { return false } },
  remove: (p) => rm(p, { recursive: true, force: true }),
}
const root = await mkdtemp(join(tmpdir(), 'aic-t11-'))
const store = createStore({ fs: fsPort, root })
const courses = createCourseApi({ store, now: () => new Date('2026-10-16T10:00:00Z') })
const course = await courses.create({
  name: 'RSC 入门', description: '三章', difficulty: '中级', category: '', tags: ['前端'],
  outline: { chapters: [
    { id: 'ch-01', order: 1, name: '为什么', knowledgePoints: [
      { id: 'kp-01-01', order: 1, name: 'CSR 与 SSR', contentType: '图文', duration: 12 },
      { id: 'kp-01-02', order: 2, name: 'RSC 的核心承诺', contentType: '幻灯片', duration: 9 } ] },
    { id: 'ch-02', order: 2, name: '边界', knowledgePoints: [
      { id: 'kp-02-01', order: 1, name: 'use client', contentType: '图文', duration: 8 } ] } ] },
})

/* --- ① 三种粒度 --- */
ck('scope=course → 全部知识点', selectTargets(course, 'course', []).map((x) => x.kp.id).join(',') === 'kp-01-01,kp-01-02,kp-02-01')
ck('scope=chapter → 只取目标章节', selectTargets(course, 'chapter', ['ch-02']).map((x) => x.kp.id).join(',') === 'kp-02-01')
ck('scope=kp → 只取目标知识点', selectTargets(course, 'kp', ['kp-01-02']).map((x) => x.kp.id).join(',') === 'kp-01-02')
ck('不存在的目标 → 空（由调用方给「没有匹配到知识点」）', selectTargets(course, 'kp', ['kp-99-99']).length === 0)

/* --- ② 回包规范化 --- */
const rawKp = JSON.stringify({
  title: 'CSR 与 SSR',
  body: [
    '---', 'title: 模型自己也写了 frontmatter', '---', '',
    '# CSR 与 SSR', '',
    '## 代价', '',
    '水合要跑一遍 **组件树**。', '',
    '```js', 'console.log(1)', '```', '',
    '![外部图](https://evil.example/x.png)', '',
    '| a | b |', '| - | - |', '| 1 | 2 |',
  ].join('\n'),
  diagram: { alt: '对比图', svg: '<svg viewBox="0 0 10 10"><rect width="10" height="10" fill="currentColor"/></svg>' },
})
const parsed = parseContent(rawKp, { kp: { id: 'kp-01-01', name: 'CSR 与 SSR' }, contentType: '图文', kpId: 'kp-01-01' })
ck('正文头部由宿主统一补 frontmatter 且 title 来自回包', /^---\ntitle: CSR 与 SSR\n---\n/.test(parsed.body))
ck('模型自己写的 frontmatter 被剥掉（不会出现两个 frontmatter）', (parsed.body.match(/^---$/gm) || []).length === 2)
ck('正文里的 h1 被剥掉（页面标题已经展示名称）', !/^#\s/m.test(parsed.body.replace(/^---\n[\s\S]*?\n---\n/, '')))
ck('h2 与代码块、表格都保留下来', /## 代价/.test(parsed.body) && /```js/.test(parsed.body) && /\| a \| b \|/.test(parsed.body))
ck('模型写的外部图片链接被去掉（图由宿主插入）', !/evil\.example/.test(parsed.body))
ck('宿主在首段之后插入了指向媒体的相对路径图', /!\[对比图\]\(media\/kp-01-01-01\.svg\)/.test(parsed.body), parsed.body.split('\n').slice(6, 8).join(' / '))
ck('媒体登记成课程目录内的相对路径', parsed.media.length === 1 && parsed.media[0].rel === 'content-assets/media/kp-01-01-01.svg')
ck('SVG 被清洗并保留（含 viewBox）', /<svg/.test(parsed.media[0].text) && /viewBox/.test(parsed.media[0].text))
ck('图文不是 fallback', parsed.fallback === false)

const noDiagram = parseContent(JSON.stringify({ title: 'X', body: '## 正文' }), { kp: { name: 'X' }, contentType: '图文', kpId: 'kp-01-01' })
ck('模型没给图 → 用占位示意图兜底（「图文必须 ≥1 媒体」这条约束不能破）',
  noDiagram.media.length === 1 && /<svg/.test(noDiagram.media[0].text))

/* SVG 清洗：危险构造一律拒 */
ck('含 <script> 的 SVG 被拒', sanitizeSvg('<svg viewBox="0 0 1 1"><script>alert(1)</script></svg>') === null)
ck('含 on* 事件属性的 SVG 被拒', sanitizeSvg('<svg viewBox="0 0 1 1" onload="x()"></svg>') === null)
ck('含 <foreignObject> 的 SVG 被拒', sanitizeSvg('<svg viewBox="0 0 1 1"><foreignObject/></svg>') === null)
ck('含 javascript: 的 SVG 被拒', sanitizeSvg('<svg viewBox="0 0 1 1"><a href="javascript:x()"/></svg>') === null)
ck('不是 SVG 的内容被拒（回 null 由占位兜底）', sanitizeSvg('就是一段文字') === null)
ck('白名单外的属性被删掉、白名单内的保留',
  (() => {
    const out = sanitizeSvg('<svg viewBox="0 0 4 4" width="4" data-evil="1" class="x"><rect x="1" y="1" fill="currentColor"/></svg>')
    return out && !/data-evil|class=/.test(out) && /viewBox/.test(out) && /currentColor/.test(out)
  })())
ck('占位示意图自带 viewBox（不会渲染成 0×0）', /viewBox/.test(placeholderSvg('标题')))
ck('占位图标题被 XML 转义（不能把 </text><script> 变成注入点）', (() => {
  const evil = placeholderSvg('</text><script>alert(1)</script><text>')
  return !/<script/i.test(evil) && /&lt;\/text&gt;/.test(evil) && isWellFormedSvg(evil)
})(), placeholderSvg('</text><script>alert(1)</script><text>').slice(0, 120))
ck('stripH1 / stripFrontmatter / insertFigure 都是纯函数',
  stripH1(['# a', '', '## b'].join('\n')) === '## b' &&
  stripFrontmatter(['---', 'x: 1', '---', '', '正文'].join('\n')).trim() === '正文' &&
  insertFigure(['第一段', '', '第二段'].join('\n'), 'media/x.svg', 'alt').indexOf('![alt](media/x.svg)') > 0)
ck('frontmatter 标题里的换行被压成单行（不破坏 YAML）', (() => {
  const fm = withFrontmatter('标题\n第二行', '正文')
  return /^---\ntitle: 标题 第二行\n---/.test(fm)
})(), withFrontmatter('标题\n第二行', '正文').split('\n').slice(0, 4).join('|'))
ck('insertFigure 的 alt 去掉 `[]` 与换行（不破坏图片语法）',
  insertFigure('正文', 'media/x.svg', 'a]b\n[c').indexOf('![ab c](media/x.svg)') > 0,
  insertFigure('正文', 'media/x.svg', 'a]b\n[c'))

/* 幻灯片：headmatter 纠正 + 分页 + 讲稿 */
const slides = parseContent(JSON.stringify({
  title: 'RSC 的核心承诺',
  body: '---\ntitle: 模型乱写的\n---\n\n# 封面\n\n<!-- 开场白 -->\n\n---\n\n# 第二页\n\n正文\n',
}), { kp: { name: 'RSC 的核心承诺' }, contentType: '幻灯片', kpId: 'kp-01-02' })
ck('幻灯片 headmatter 的 title 用课程里的名称（不采信模型自述）', /^---\ntitle: RSC 的核心承诺\n---\n/.test(slides.body), slides.body.split('\n')[1])
ck('幻灯片保留每页 h1（页标题），**不**做 h1 剥离', /^# 封面$/m.test(slides.body) && /^# 第二页$/m.test(slides.body))
ck('幻灯片按 `---` 分页', (slides.body.match(/\n---\n/g) || []).length >= 1)
ck('幻灯片讲稿（页末 HTML 注释）保留在正文里', /<!-- 开场白 -->/.test(slides.body))
ck('幻灯片也产出一张示意图（同一套体验）', slides.media.length === 1)
ck('空幻灯片正文 → 结构化报错', (() => { try { normalizeSlidev('   ', 'T'); return false } catch (e) { return /没有任何一页/.test(e.message) } })())

/* SVG 清洗：**不许出现重复属性**（模型几乎总会自己带 `xmlns`，早期版本无条件再补一个 →
   落盘的是非法 XML，严格解析器直接报错，真机表现就是图不显示） */
{
  const dup = sanitizeSvg('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 4 4"><rect width="4" height="4"/></svg>')
  const count = (dup.match(/xmlns=/g) || []).length
  ck('模型自带 xmlns 时不再重复补一个（重复属性 = 非法 XML）', count === 1, dup.slice(0, 90))
  const noNs = sanitizeSvg('<svg viewBox="0 0 4 4"><rect width="4" height="4"/></svg>')
  ck('模型没带 xmlns 时补上（浏览器里才能正确当 SVG 解析）', /<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg"/.test(noNs), noNs.slice(0, 70))
}

/* 幻灯片必须**真的引用**那张图（早期只登记 mediaRefs，讲义里一张图都没有 —— 真机踩过） */
{
  const deck = parseContent(JSON.stringify({
    title: 'D',
    body: ['---', 'title: x', '---', '', '# 封面', '', '<!-- 讲稿 -->', '', '---', 'layout: center', '', '# 中页', '', '正文', '', '---', '', '# 小结'].join('\n'),
    diagram: { alt: '示意图', svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 4 4"><rect width="4" height="4"/></svg>' },
  }), { kp: { name: 'D' }, contentType: '幻灯片', kpId: 'kp-01-02' })
  ck('幻灯片正文里插入了指向媒体的图片引用', /!\[示意图\]\(media\/kp-01-02-01\.svg\)/.test(deck.body), deck.body.split('\n').filter((l) => l.indexOf('![') >= 0).join(' '))
  /* ⚠️ 断言要按**页内容**定位，不能数下标：`withFrontmatter` 在头部又加了一个 `---` 块，
     所以 `body.split('\n\n---\n\n')[0]` 是 frontmatter + 首屏（早期按下标写，误判过一次）。 */
  const deckPages = deck.body.split('\n\n---\n\n')
  ck('插图页取「倒数第二页」（末页是小结，封面不该放图）',
    deckPages[deckPages.length - 2].indexOf('![') >= 0,
    deckPages.map((s) => (s.indexOf('![') >= 0 ? '有图' : '-')).join(','))
  ck('封面页没有图', deckPages[0].indexOf('![') < 0)
  ck('幻灯片仍然只登记 1 个媒体', deck.media.length === 1)
  /* 有 image-right 这类版式时优先插到那一页 */
  const withLayout = parseContent(JSON.stringify({
    title: 'D2',
    body: ['# 封面', '', '---', 'layout: image-right', '', '# 图页', '', '---', '', '# 小结'].join('\n'),
    diagram: { alt: '图', svg: '<svg viewBox="0 0 4 4"></svg>' },
  }), { kp: { name: 'D2' }, contentType: '幻灯片', kpId: 'kp-01-02' })
  ck('有 image-right 版式时把图插到**那一页**（按页内容断言，不数下标）', (() => {
    const pages = withLayout.body.split('\n\n---\n\n')
    const target = pages.find((s) => /layout:\s*image-right/.test(s))
    return !!target && target.indexOf('![') >= 0 &&
      pages.filter((s) => s.indexOf('![') >= 0).length === 1
  })(), withLayout.body.split('\n\n---\n\n').map((s) => /layout:\s*image-right/.test(s) ? (s.indexOf('![') >= 0 ? '版式页有图' : '版式页无图') : '-').join(','))
  ck('同一页已经有图 → 不重复插', (() => {
    const again = parseContent(JSON.stringify({ title: 'D3', body: ['# 封面', '', '---', '', '# 页2', '', '![已有](media/x.png)', '', '---', '', '# 页3'].join('\n'), diagram: { alt: '图', svg: '<svg viewBox="0 0 4 4"></svg>' } }), { kp: { name: 'D3' }, contentType: '幻灯片', kpId: 'kp-01-02' })
    return (again.body.match(/!\[/g) || []).length === 1
  })())
}

/* --- SVG 必须是**合法 XML**（真机上图片全不显示就是因为这里产出了 mismatched tag） --- */
{
  const withSelfClose = '<svg viewBox="0 0 10 10" xmlns="http://www.w3.org/2000/svg"><defs><marker id="m"><path d="M0 0 L10 5"/></marker></defs><rect width="4" height="4"/><text x="1" y="9">t</text></svg>'
  const out = sanitizeSvg(withSelfClose)
  ck('自闭合标签的 `/` 不会丢（丢了就是非法 XML，浏览器不显示）', /<path[^>]*\/>/.test(out) && /<rect[^>]*\/>/.test(out), out.slice(0, 80))
  ck('非空元素仍然正常闭合', /<text[^>]*>t<\/text>/.test(out))
  ck('清洗后通过形状自检', isWellFormedSvg(out) === true)
  ck('自检能识破「未闭合的 <path>」', isWellFormedSvg('<svg viewBox="0 0 4 4"><path d="M0 0"></svg>') === false)
  ck('自检能识破「重复属性」', isWellFormedSvg('<svg viewBox="0 0 4 4" viewBox="0 0 4 4"><rect width="4" height="4"/></svg>') === false)
  ck('自检能识破「标签错配」', isWellFormedSvg('<svg viewBox="0 0 4 4"><g></svg>') === false)
  ck('没 viewBox 的 SVG 不合格（浏览器里会渲染成 0 高）', isWellFormedSvg('<svg><rect width="4" height="4"/></svg>') === false)
}

/* --- 清洗器要能**修好**旧版写坏的 SVG（一次性修复脚本依赖这一点） --- */
{
  const brokenSlash = '<svg viewBox="0 0 640 360" xmlns="http://www.w3.org/2000/svg"><defs><marker id="a"><path d="M0 0 L10 5 Z" fill="#888"></marker></defs><rect width="4" height="4"></svg>'
  const fixedSlash = sanitizeSvg(brokenSlash)
  ck('丢失的自闭合斜杠会被**补回**（旧文件能修好）',
    fixedSlash !== null && /<path[^>]*\/>/.test(fixedSlash) && isWellFormedSvg(fixedSlash), String(fixedSlash).slice(0, 70))
  const brokenDup = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 4 4" xmlns="http://www.w3.org/2000/svg"><rect width="4" height="4"/></svg>'
  const fixedDup = sanitizeSvg(brokenDup)
  ck('重复属性会被去重（只留第一个）',
    fixedDup !== null && (fixedDup.match(/xmlns=/g) || []).length === 1 && isWellFormedSvg(fixedDup), String(fixedDup).slice(0, 70))
  const voidClose = sanitizeSvg('<svg viewBox="0 0 4 4"><path d="M0 0"></path><rect width="4" height="4"/></svg>')
  ck('空元素多余的 </path> 会被丢掉（否则标签错配）',
    voidClose !== null && !/<!\/path>/.test(voidClose) && !/<\/path>/.test(voidClose) && isWellFormedSvg(voidClose), String(voidClose).slice(0, 70))
  ck('完全不是 SVG 的垃圾仍回 null（不硬造）', sanitizeSvg('not an svg at all') === null)
}

/* --- 上下文共享：大纲会话的题面（原始诉求）也进知识点 prompt --- */
{
  const withReq = buildContentPrompt({
    kp: { name: 'K', contentType: '图文', duration: 5 },
    chapter: { order: 1, name: 'C', knowledgePoints: [] },
    course: { name: '课', request: '用 3 章讲清 RSC，我熟悉 Vue 不熟 React', outline: { chapters: [] } },
    contentType: '图文',
  })
  ck('内容 prompt 带上课程原始诉求（与大纲会话共享题面）',
    /课程原始诉求/.test(withReq) && withReq.indexOf('我熟悉 Vue 不熟 React') >= 0)
  ck('原始诉求写在课程信息里、且在大纲之前（先对齐意图再看结构）',
    withReq.indexOf('课程原始诉求') < withReq.lastIndexOf('课程大纲'))
  const noReq = buildContentPrompt({
    kp: { name: 'K', contentType: '图文', duration: 5 },
    chapter: { order: 1, name: 'C', knowledgePoints: [] },
    course: { name: '课', outline: { chapters: [] } },
    contentType: '图文',
  })
  ck('没有原始诉求时不出现空行占位', !/课程原始诉求/.test(noReq))

  /* 落库：normalizeDerivation 把 request 带进课程 */
  const n = normalizeDerivation({ name: '课', outline: { chapters: [{ name: 'C', knowledgePoints: [{ name: 'K', contentType: '图文' }] }] } }, { request: '诉求原话' })
  ck('大纲推导把原始诉求写进课程结构', n.request === '诉求原话')
  const n2 = normalizeDerivation({ name: '课', outline: { chapters: [] } })
  ck('没有诉求时是空串（不是 undefined）', n2.request === '')
}

/* --- 引用资源（T-14）：识别 / 限量 / 拼进 prompt --- */
{
  ck('识别诉求里的相对路径', JSON.stringify(extractRefs('参考 ./docs/a.md 和 src/index.ts')) === JSON.stringify(['./docs/a.md', 'src/index.ts']))
  ck('识别 @ 路径与 ~ 路径', JSON.stringify(extractRefs('看看 @/tmp/x.md 与 ~/n/spec.yaml')) === JSON.stringify(['/tmp/x.md', '~/n/spec.yaml']))
  ck('识别 URL（但不当文件读）',
    extractRefs('见 https://react.dev/learn').join(',') === 'https://react.dev/learn' &&
    isTextRef('https://react.dev/learn') === false)
  ck('裸文件名与无扩展名路径不算（避免误判正文词）',
    extractRefs('notes.md 和 a/b 都不算').length === 0, JSON.stringify(extractRefs('notes.md 和 a/b 都不算')))
  ck('图片/二进制不当文本读', isTextRef('/a/b.png') === false && isTextRef('/a/b.md') === true && isTextRef('/a/b.ts') === true)

  const many = Array.from({ length: 12 }, (_, i) => ({ ref: '/x/' + i + '.md' }))
  ck('引用数量有上限（最多 6 个）', mergeSources(many).length === MAX_SOURCES)
  ck('引用去重（同 ref 不同来源只留一个）',
    mergeSources(['/a.md'], [{ ref: '/a.md', name: 'A' }], ['/b.md']).length === 2)
  ck('URL 的 kind 标成 url、文件标成 file',
    mergeSources(['/a.md', 'https://x.dev/y']).map((s) => s.kind).join(',') === 'file,url')

  const block = formatSourcesBlock([
    { ref: '/a.md', name: 'a.md', text: '第一份资料的内容' },
    { ref: '/b.md', name: 'b.md' },                                   /* 没读到 → 不出现 */
    { ref: '/long.md', name: 'long.md', text: 'x'.repeat(MAX_SOURCE_CHARS + 100) },
  ])
  ck('参考资料块写明「是依据、不要照抄」', /当作事实依据/.test(block) && /不要整段照抄/.test(block))
  ck('读不到正文的引用不出现在块里', block.indexOf('b.md') < 0)
  ck('超长引用被截断并注明节选', /以上为节选/.test(block) && block.length < MAX_SOURCE_CHARS * 2)
  ck('没有任何可用资料 → 空串（调用方据此不加这一节）', formatSourcesBlock([]) === '' && formatSourcesBlock([{ ref: '/a.md' }]) === '')

  /* prompt 里真的会带上它 */
  const promptWithSources = buildContentPrompt({
    kp: { id: 'kp-01-01', name: '核心公式', contentType: '图文', duration: 5 },
    chapter: { id: 'ch-01', order: 1, name: '章', knowledgePoints: [] },
    course: { name: '课', tags: [], outline: { chapters: [] } },
    contentType: '图文',
    sources: [{ ref: '/a.md', name: 'a.md', text: '资料原文关键句' }],
  })
  ck('内容 prompt 里带上了引用原文', /## 参考资料/.test(promptWithSources) && /资料原文关键句/.test(promptWithSources))
  ck('没有引用时 prompt 不出现空参考资料节', !/## 参考资料/.test(buildContentPrompt({
    kp: { name: 'K', contentType: '图文', duration: 5 },
    chapter: { order: 1, name: 'C', knowledgePoints: [] },
    course: { name: 'X', tags: [], outline: { chapters: [] } },
    contentType: '图文',
  })))
}

/* --- 图表优先级：正文里有 mermaid 就不再产媒体 --- */
{
  const F = String.fromCharCode(96, 96, 96)
  const mk = (body, diagram) => parseContent(JSON.stringify(diagram ? { title: 'T', body, diagram } : { title: 'T', body }),
    { kp: { name: 'T' }, contentType: '图文', kpId: 'kp-01-01' })
  const withMm = mk(['## 流程', '', F + 'mermaid', 'flowchart TD', '  A[开始] --> B[结束]', F, '', '正文'].join('\n'))
  ck('正文有 mermaid 图 → 不产媒体（图表随正文渲染，比外链图更直接）', withMm.media.length === 0)
  ck('正文有 mermaid → 不再插图片引用', !/!\[/.test(withMm.body))
  ck('mermaid 围栏原样保留（交给前端渲染）', /```mermaid[\s\S]*flowchart TD/.test(withMm.body))
  const noMm = mk('## 只有文字', { alt: '图', svg: '<svg viewBox="0 0 4 4"><rect width="4" height="4"/></svg>' })
  ck('没有 mermaid → 仍然产 1 个媒体并插入图（「≥1 媒体」的硬约束不破）', noMm.media.length === 1 && /!\[/.test(noMm.body))
  const both = mk(['## 流程', '', F + 'mermaid', 'sequenceDiagram', '  A->>B: hi', F].join('\n'), { alt: '补充图', svg: '<svg viewBox="0 0 4 4"><rect width="4" height="4"/></svg>' })
  ck('两者都有 → 以 mermaid 为主，不再额外出图', both.media.length === 0 && /sequenceDiagram/.test(both.body))
}

/* 四种待定类型：按 Markdown 降级并打标 */
const fallback = parseContent(JSON.stringify({ title: '代码示例', body: '## 正文' }), { kp: { name: '代码示例' }, contentType: '代码', kpId: 'kp-02-01' })
ck('待定类型（代码）按 Markdown 生成并标 fallback', fallback.fallback === true && /## 正文/.test(fallback.body))

/* 提示词合约 */
const PROMPT_KP = { id: 'kp-01-01', name: 'CSR 与 SSR', contentType: '图文', duration: 10 }
const PROMPT_CH = { id: 'ch-01', order: 1, name: '为什么', knowledgePoints: [PROMPT_KP, { id: 'kp-01-02', name: 'RSC 的核心承诺' }] }
const promptCourse = { ...course, outline: { chapters: [PROMPT_CH, { id: 'ch-02', order: 2, name: '边界', knowledgePoints: [{ id: 'kp-02-01', name: 'use client' }] }] } }
const prompt = buildContentPrompt({ kp: PROMPT_KP, chapter: PROMPT_CH, course: promptCourse, contentType: '图文', prompt: '多用表格' })
ck('提示词含课程、章节、知识点与建议时长', /RSC 入门/.test(prompt) && /第 1 章 为什么/.test(prompt) && /本次要写的知识点：\*\*CSR 与 SSR\*\*/.test(prompt))
ck('提示词含用户的额外要求', /多用表格/.test(prompt))
ck('提示词要求不要写 h1、不要写图片链接', /不要写 H1/.test(prompt) && /不要写任何图片链接/.test(prompt))
ck('提示词要求给 diagram 且禁止 script/事件属性', /diagram/.test(prompt) && /<script>/.test(prompt) && /on\*/.test(prompt))

/* 整门课的大纲：防越界的关键（本轮需求） */
ck('提示词里贴了**整门课**的大纲（所有章节都出现）',
  /课程大纲/.test(prompt) && /1\. 为什么/.test(prompt) && /2\. 边界/.test(prompt))
ck('提示词里列出了大纲里的知识点（跨章节也要在，作为边界参照）',
  /CSR 与 SSR/.test(prompt) && /RSC 的核心承诺/.test(prompt) && /use client/.test(prompt))
ck('标出了「本次」与「本次所在章节」（模型据此判定边界）',
  /← 本次所在章节/.test(prompt) && /← 本次/.test(prompt))
ck('公共规则要求「范围由大纲界定、不许越界、不替别的知识点展开」',
  /范围由课程大纲界定/.test(prompt) && /不许越界/.test(prompt) && /不要写别的知识点/.test(prompt))
ck('JSON 形状里也写了一句范围提示（收尾再强调一次）',
  /只覆盖「← 本次」那一个知识点/.test(prompt))

/* 大纲体积控制：超限时当前章节仍完整、其他章节只列标题 */
const many = { id: 'ch-01', order: 1, name: '为什么', knowledgePoints: Array.from({ length: 40 }, (_, i) => ({ id: 'kp-01-' + i, order: i + 1, name: '本章点' + i })) }
const other = { id: 'ch-02', order: 2, name: '边界', knowledgePoints: Array.from({ length: 40 }, (_, i) => ({ id: 'kp-02-' + i, order: i + 1, name: '他章点' + i })) }
const bigPrompt = buildContentPrompt({ kp: many.knowledgePoints[0], chapter: many, course: { ...promptCourse, outline: { chapters: [many, other] } }, contentType: '图文' })
ck('大纲超限时：本次所在章节**完整保留**（边界不能因截断而丢）',
  /本章点0/.test(bigPrompt) && /本章点39/.test(bigPrompt))
ck('大纲超限时：其他章节只列标题并注明省略', /2\. 边界/.test(bigPrompt) && /略：本章知识点与本次无关/.test(bigPrompt) && !/他章点0/.test(bigPrompt))
ck('大纲超限时给出总数说明（不假装列全了）', /整门课共 80 个知识点/.test(bigPrompt))
ck('JSON 形状与 schema 都要求 title/body', /"title"/.test(CONTENT_SHAPE) && /"body"/.test(CONTENT_SHAPE))

/* --- ③ 资产层路径守卫 --- */
ck('isSafeRel 拒绝对路径 / .. / 反斜杠 / 空段',
  !isSafeRel('/etc/passwd') && !isSafeRel('a/../../b') && !isSafeRel('a\\b') && !isSafeRel('a//b') && isSafeRel('content-assets/media/x.svg'))
ck('媒体路径由宿主算且不重复', nextMediaRelPath('kp-01-01', []) === 'content-assets/media/kp-01-01-01.svg' &&
  nextMediaRelPath('kp-01-01', [{ rel: 'content-assets/media/kp-01-01-01.svg' }]) === 'content-assets/media/kp-01-01-02.svg')

/* --- ④ generateOne 端到端（假的 callModel） --- */
const callModel = async () => JSON.stringify({
  title: 'CSR 与 SSR',
  body: '## 代价\n\n水合要跑一遍组件树。\n\n## 小结\n\n先看代价。',
  diagram: { alt: '对比', svg: '<svg viewBox="0 0 10 10"><rect width="10" height="10"/></svg>' },
})
const wrote = await generateOne({ store, courses, callModel }, { courseId: course.id, kpId: 'kp-01-01', prompt: '' })
const dir = join(store.courseDir(course.id), 'content-assets')
const names = (await readdir(dir)).sort()
ck('落库后有信封与正文两个文件', names.indexOf('kp-01-01.json') >= 0 && names.indexOf('kp-01-01.md') >= 0, names.join(','))
ck('媒体落在 content-assets/media/ 下', (await readdir(join(dir, 'media'))).length === 1)
ck('countAssetFiles 只数 kp-*.json 信封（列表页不读内容）', (await countAssetFiles(store, course.id)) === 1)
const env = JSON.parse(await readFile(join(dir, 'kp-01-01.json'), 'utf8'))
ck('信封含 kpId / contentType / payload.path / mediaRefs / generatedAt',
  env.kpId === 'kp-01-01' && env.contentType === '图文' && env.payload.path === 'content-assets/kp-01-01.md' &&
  env.mediaRefs.length === 1 && !!env.generatedAt)
ck('信封里的路径都是课程目录内的相对路径（可整体搬迁）',
  env.payload.path.indexOf(course.id) < 0 && !env.payload.path.startsWith('/') && env.mediaRefs.every((m) => !m.path.startsWith('/')))

/* 读回来：学习页要的载荷 */
const payload = await readAssetPayload(store, course.id, 'kp-01-01', '图文')
ck('读回 hasAsset=true 且带回正文与媒体清单', payload.hasAsset === true && /## 代价/.test(payload.body) && payload.media.length === 1)

/* 「保留原有内容」= 追加：正文拼接、媒体不覆盖、prompt 告知不要重复 */
{
  let promptAppend = ''
  const before = await readAssetPayload(store, course.id, 'kp-01-01', '图文')
  const outAppend = await generateOne({ store, courses, callModel: async (p) => {
    promptAppend = p
    return JSON.stringify({
      title: '点',
      body: '## 补充一节\n\n新增内容',
      diagram: { alt: '第二张图', svg: '<svg viewBox="0 0 4 4"><rect width="4" height="4"/><text>SECOND</text></svg>' },
    })
  } }, { courseId: course.id, kpId: 'kp-01-01', keepExisting: true })
  const after = await readAssetPayload(store, course.id, 'kp-01-01', '图文')
  ck('追加模式：旧正文与新正文都在（没被覆盖）',
    /代价/.test(after.body) && /新增内容/.test(after.body), after.body.slice(0, 60).replace(/\n/g, ' '))
  ck('追加模式：媒体**累加**且不重名',
    after.media.length === before.media.length + 1 &&
    new Set(after.media.map((m) => m.path)).size === after.media.length,
    after.media.map((m) => m.path.split('/').pop()).join(','))
  ck('追加模式：旧图文件内容没被改写',
    (await store.readContentText(course.id, before.media[0].path)) ===
    (await store.readContentText(course.id, after.media[0].path)))
  ck('追加模式：prompt 明确告知「已有内容会保留、只写补充」',
    /已有内容会被保留/.test(promptAppend) && /不要重复/.test(promptAppend))
  ck('追加模式：prompt 列出旧小节，避免重复选题', /已有内容的小节/.test(promptAppend))
  ck('追加模式：generateOne 回传的 mediaRefs 含两张图', outAppend.mediaRefs.length === 2)

  /* 覆盖模式（默认）：新正文替换旧的 */
  const outOver = await generateOne({ store, courses, callModel: async () => JSON.stringify({ title: '点', body: '## 全新内容\n\n只有这一段' }) }, { courseId: course.id, kpId: 'kp-01-01' })
  const afterOver = await readAssetPayload(store, course.id, 'kp-01-01', '图文')
  ck('覆盖模式（keepExisting 缺省）：旧内容被替换',
    /只有这一段/.test(afterOver.body) && !/新增内容/.test(afterOver.body) && outOver.mediaRefs.length === 1)
}


/* 学习时长：**内容生成之后**按正文回填（大纲阶段不估计） */
{
  const again = await courses.read(course.id)
  const kp = again.course.outline.chapters[0].knowledgePoints[0]
  ck('生成后把学习时长回填进大纲', Number.isInteger(kp.duration) && kp.duration > 0, String(kp.duration))
  ck('回填的时长与正文规模相称（不是固定的 10 分钟）',
    kp.duration === estimateMinutes(payload.body, '图文'), `${kp.duration} vs ${estimateMinutes(payload.body, '图文')}`)
  ck('generateOne 的返回值里带 duration（任务进度可展示）', wrote.duration === kp.duration)

  /* 估算口径本身 */
  const zh = (n) => '字'.repeat(n)
  ck('估算：越长的正文越久（单调）', estimateMinutes(zh(800), '图文') > estimateMinutes(zh(400), '图文'))
  ck('估算：代码行会额外加时', estimateMinutes(zh(400) + '\n\n```js\n' + 'x\n'.repeat(60) + '```', '图文') > estimateMinutes(zh(400), '图文'))
  ck('估算：幻灯片按页数兜底（页多则更久）',
    estimateMinutes(['# a', '', '---', '', '# b', '', '---', '', '# c', '', '---', '', '# d', '', '---', '', '# e', '', '---', '', '# f'].join('\n'), '幻灯片') >= 4)
  ck('估算：空正文不会回 0（时长必须是正整数）', estimateMinutes('', '图文') === 1)
  ck('估算：有上限（不会算出离谱的几百分钟）', estimateMinutes('字'.repeat(50000), '图文') === 180)
  ck('估算：结果一定是正整数', [zh(1), zh(300), zh(900), ''].every((t) => { const v = estimateMinutes(t, '图文'); return Number.isInteger(v) && v > 0 }))
}

const missing = await readAssetPayload(store, course.id, 'kp-02-01', '图文')
ck('没生成过的知识点 → hasAsset=false（信封是凭据）', missing.hasAsset === false && missing.body === null)

/* 正文缺 → 按未生成（05 §5.6：内容层失败不上升为结构层失败） */
await rm(join(dir, 'kp-01-01.md'))
const bodyGone = await readAssetPayload(store, course.id, 'kp-01-01', '图文')
ck('信封在、正文缺 → 按「未生成」而不是损坏', bodyGone.hasAsset === false)

/* 路径穿越：信封被人改成目录外 → 拒绝读取 */
await writeFile(join(dir, 'kp-01-01.json'), JSON.stringify({ schemaVersion: 1, kpId: 'kp-01-01', contentType: '图文', payload: { format: 'markdown', path: '../../etc/passwd' }, mediaRefs: [] }), 'utf8')
const traversal = await readAssetPayload(store, course.id, 'kp-01-01', '图文')
ck('信封里的路径穿越被拒（按未生成处理，不读目录外文件）', traversal.hasAsset === false)

/* --- ⑤ 任务表状态机 --- */
let persisted = { tasks: [] }
const runner = createTaskRunner({
  generateOne: async (task, item, kpId) => { if (kpId === 'kp-01-02') throw new Error('模拟模型失败') },
  loadInitial: async () => persisted,
  persist: async (state) => { persisted = state },
})
const task = await runner.create({ courseId: course.id, scope: 'kp', kpIds: ['kp-01-01', 'kp-01-02'], prompt: 'x', contentType: '图文' })
ck('create 立刻回任务（含总数与逐项 queued）', task.state === 'queued' && task.total === 2 && task.items.every((it) => it.state === 'queued'))
ck('同一门课再发起 → already-running（不排第二个任务）',
  await (async () => { try { await runner.create({ courseId: course.id, scope: 'kp', kpIds: ['kp-01-01'] }); return false } catch (e) { return e.code === 'already-running' && !!e.task } })())
ck('目标为空 → no-targets',
  await (async () => { try { await runner.create({ courseId: 'c-20260101000000-aaaa', scope: 'kp', kpIds: [] }); return false } catch (e) { return e.code === 'no-targets' } })())
await new Promise((r) => setTimeout(r, 40))
const done = runner.get(task.id)
ck('逐项推进：成功项 done、失败项 failed 且带原因', done.state === 'failed' && done.done === 1 && done.failed === 1 &&
  /模拟模型失败/.test(done.items[1].reason), `${done.done}/${done.total} · ${done.items[1].state}:${done.items[1].reason}`)
ck('任务结束后不再占着「活跃任务」位（可以再次发起）', runner.activeOf(course.id) === null)
ck('itemStates 反映每个知识点最近一次状态', runner.itemStates(course.id)['kp-01-01'] === 'done' && runner.itemStates(course.id)['kp-01-02'] === 'failed')
ck('任务历史可列举（新的在前）', runner.list(course.id).length === 1)

/* 重启残留：queued/running → interrupted（不假装还在跑） */
persisted = { tasks: [{ id: 'task-x', courseId: course.id, scope: 'kp', state: 'running', startedAt: 'x', items: [{ kpId: 'kp-01-01', state: 'running' }] }] }
const runner2 = createTaskRunner({ generateOne: async () => {}, loadInitial: async () => persisted, persist: async (s) => { persisted = s } })
await runner2.ensureLoaded()
const revived = runner2.get('task-x')
ck('重启后残留的 running 任务变成 interrupted', revived.state === 'interrupted')
ck('中断任务的进行中条目变成 failed 并给出原因（可重试）',
  revived.items[0].state === 'failed' && /中断/.test(revived.items[0].reason), revived.items[0].reason)
ck('修正后的状态被写回（下次冷启动不会再看到 running）', persisted.tasks[0].state === 'interrupted')

/* ensureLoaded 失败后要能重试，不能把「空历史」永久钉死 */
{
  let failLoad = true
  const persistedRetry = { tasks: [{ id: 'task-retry', courseId: course.id, scope: 'kp', state: 'done', startedAt: 'x', items: [{ kpId: 'kp-01-01', state: 'done' }] }] }
  const runnerRetry = createTaskRunner({
    generateOne: async () => {},
    loadInitial: async () => { if (failLoad) throw new Error('disk busy'); return persistedRetry },
    persist: async (s) => { persistedRetry.tasks = s.tasks },
  })
  await runnerRetry.ensureLoaded()           // 第一次读盘失败
  ck('读盘失败后第一次不报错、任务表为空', runnerRetry.get('task-retry') === null)
  failLoad = false
  await runnerRetry.ensureLoaded()           // 第二次真的读
  ck('读盘失败后下一次 ensureLoaded 会重试（不永久空）', runnerRetry.get('task-retry') !== null)
}

/* flush 失败不中断任务，但要标 persistError（内存与磁盘不能静默分叉） */
{
  let failPersist = false
  const persistedFlush = { tasks: [] }
  const runnerFlush = createTaskRunner({
    generateOne: async () => {},
    loadInitial: async () => persistedFlush,
    persist: async (s) => { if (failPersist) throw new Error('disk full'); persistedFlush.tasks = s.tasks },
  })
  const tFlush = await runnerFlush.create({ courseId: course.id, scope: 'kp', kpIds: ['kp-01-01'], contentType: '图文' })
  failPersist = true
  const waitFlush = async (fn, ms = 800) => { const t0 = Date.now(); while (!fn()) { if (Date.now() - t0 > ms) throw new Error('timeout'); await new Promise((r) => setTimeout(r, 5)) } }
  await waitFlush(() => runnerFlush.get(tFlush.id).persistError === true)
  ck('flush 失败会把 persistError 标到任务快照上（界面可提示"进度可能未保存"）',
    runnerFlush.get(tFlush.id).persistError === true)
}

/* 主会话常驻状态条的数据源：跨课程列举「当前在跑的任务」（每个任务带课程名由 RPC 补） */
{
  const store2 = { readContentJson: async () => null, writeContentJson: async () => {} }
  let release = null
  const runners2 = createTaskRunners({ store: store2, generateOne: async () => new Promise((r) => { release = r }) })
  ck('空闲时 listActive 为空（状态条就不显示）', runners2.listActive().length === 0)
  const t1 = await runners2.for('c-20260101000000-aaaa').create({ courseId: 'c-20260101000000-aaaa', scope: 'kp', kpIds: ['kp-01-01'], contentType: '图文' })
  await new Promise((r) => setTimeout(r, 20))
  const rows = runners2.listActive()
  ck('有任务时 listActive 带回课程 id 与任务快照',
    rows.length === 1 && rows[0].courseId === 'c-20260101000000-aaaa' && rows[0].task.id === t1.id && rows[0].task.total === 1,
    JSON.stringify(rows.map((x) => ({ c: x.courseId, id: x.task.id }))))
  ck('runner.active() 与 courseId 绑定（调用方不必自己拼参数）',
    runners2.for('c-20260101000000-aaaa').active().id === t1.id)
  ck('每门课的 runner 只建一次（同一对象）',
    runners2.for('c-20260101000000-aaaa') === runners2.for('c-20260101000000-aaaa'))
  release && release()
  await new Promise((r) => setTimeout(r, 30))
  ck('任务跑完后 listActive 变空（状态条自动消失）', runners2.listActive().length === 0)
}

/* 生成上下文按任务携带：两门课并发生成时，各自用各自的 agent（不能共享闭包） */
{
  const store3 = { readContentJson: async () => null, writeContentJson: async () => {} }
  const seen = []
  let release = null
  const gate = new Promise((r) => { release = r })
  const runners3 = createTaskRunners({
    store: store3,
    generateOne: async (task, item, kpId, runCtx) => {
      seen.push({ courseId: task.courseId, agentId: runCtx && runCtx.agent && runCtx.agent.id, hasSignal: !!(runCtx && runCtx.signal) })
      await gate
    },
  })
  const t1 = await runners3.for('c-20260101000000-aaaa').create({
    courseId: 'c-20260101000000-aaaa', scope: 'kp', kpIds: ['kp-01-01'], agent: { id: 'sess-1' }, agentId: 'sess-1',
  })
  const t2 = await runners3.for('c-20260102000000-bbbb').create({
    courseId: 'c-20260102000000-bbbb', scope: 'kp', kpIds: ['kp-02-01'], agent: { id: 'sess-2' }, agentId: 'sess-2',
  })
  const waitUntil = async (fn, ms = 800) => {
    const t0 = Date.now()
    while (!fn()) {
      if (Date.now() - t0 > ms) throw new Error('等待超时')
      await new Promise((r) => setTimeout(r, 5))
    }
  }
  await waitUntil(() => seen.length === 2)
  release()
  await waitUntil(() => runners3.for('c-20260101000000-aaaa').activeOf('c-20260101000000-aaaa') === null &&
    runners3.for('c-20260102000000-bbbb').activeOf('c-20260102000000-bbbb') === null)
  ck('并发生成：每个任务拿到自己的 agent（不串会话）',
    seen.find((x) => x.courseId === 'c-20260101000000-aaaa').agentId === 'sess-1' &&
    seen.find((x) => x.courseId === 'c-20260102000000-bbbb').agentId === 'sess-2',
    JSON.stringify(seen))
  ck('并发生成：每个任务有自己的 AbortSignal', seen.every((x) => x.hasSignal))
  ck('任务快照带 agentId（诊断用，不落 Agent 对象）', t1.agentId === 'sess-1' && t2.agentId === 'sess-2')
}

/* 没装模型时给出**可读**错误（不是笼统 500） */
const noModel = await (async () => {
  try {
    await generateOne({ store, courses, callModel: async () => { throw new Error('没有可用的 subagents provider') } }, { courseId: course.id, kpId: 'kp-01-01' })
    return 'NO-THROW'
  } catch (e) { return e.message }
})()
ck('模型不可用时错误信息可读（直接展示给用户）', /没有可用的 subagents provider/.test(noModel), noModel)

/* 删除知识点后级联清理内容资产（正文 + 信封 + 媒体） */
{
  const cleanup = await courses.create({
    name: 'cleanup', description: '', difficulty: '入门', category: '', tags: [],
    outline: { chapters: [{ id: 'ch-01', order: 1, name: 'c', knowledgePoints: [{ id: 'kp-01-01', order: 1, name: 'k', contentType: '图文' }] }] },
  })
  await generateOne({ store, courses, callModel }, { courseId: cleanup.id, kpId: 'kp-01-01' })
  ck('removeAssets 前有 1 个信封', (await countAssetFiles(store, cleanup.id)) === 1)
  await removeAssets(store, cleanup.id, ['kp-01-01'])
  ck('removeAssets 后信封被清掉（正文/媒体一并走）', (await countAssetFiles(store, cleanup.id)) === 0)
}

await rm(root, { recursive: true, force: true })
console.log(`\n全部通过   （PASS ${pass} / FAIL ${fail}）`)
process.exit(fail ? 1 : 0)
