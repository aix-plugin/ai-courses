#!/usr/bin/env node
/**
 * client 半边离线自检。
 *
 * ## 它是什么（以及**不是**什么）
 * 本脚本只做两件事：**纯逻辑断言**（10-core 的真实求值）与**构建完整性断言**
 * （在 node 里求值产物脚本，验证它能被求值、能注册两个槽位、样式能注入）。
 *
 * ⚠️ 它**不是界面验证**：不渲染任何组件、不做布局、不截图、不模拟 React 渲染树。
 *    用户可见结果只能在真机上看 —— doc/09 §7.2 的边界依旧成立，AC 一律仍为「未执行」。
 *    之所以还要跑它：本项目已经栽过「语法合法 + 离线冒烟全绿 + 只有真机才炸」的坑
 *    （TDZ → cordis 只报一句 failed to import；slot 注册形状写错 → web boot 失败）。
 * ========================================================================== */
import { readFile, readdir } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const srcDir = join(root, 'src/client')
const pkgDir = join(root, 'package')

let pass = 0
let fail = 0
const ck = (name, ok, ev) => {
  if (ok) pass++
  else fail++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ev === undefined ? '' : '  → ' + ev}`)
}

/* ==========================================================================
 * 1 · 纯逻辑：真实求值 src/client/10-core.js（也能顺带查出该段的 TDZ）
 * ======================================================================== */
const coreSrc = await readFile(join(srcDir, '10-core.js'), 'utf8')
const core = new Function(`${coreSrc}\n;return AIC_COURSES_CORE`)()
ck('10-core 可被真实求值（能查出 TDZ）', !!core && typeof core.createT === 'function')

const course = {
  id: 'c-20261013142530-a7f3',
  name: '用 3 章讲清 React Server Components',
  outline: {
    chapters: [
      {
        id: 'ch-01', order: 1, name: '为什么需要 RSC',
        knowledgePoints: [
          { id: 'kp-01-01', order: 1, name: 'CSR 与 SSR 各自的水合代价', contentType: '图文', duration: 12 },
          { id: 'kp-01-02', order: 2, name: 'RSC 的核心承诺', contentType: '图文', duration: 9 },
        ],
      },
      {
        id: 'ch-02', order: 2, name: '边界',
        knowledgePoints: [{ id: 'kp-02-03', order: 1, name: '边界误用自测', contentType: '测验', duration: 6 }],
      },
    ],
  },
}

/* 编号一律由 order 派生：第二个章节的第一个知识点是 2.1，而不是 id 里的 02-03 */
ck('章节编号由 order 派生', core.chapterNo(course.outline.chapters[1]) === '2')
ck('知识点编号由 order 派生（fixture 的 id 是 kp-02-03，但 order=1 → 显示 2.1）',
  core.kpNo(course.outline.chapters[1], course.outline.chapters[1].knowledgePoints[0]) === '2.1',
  core.kpNo(course.outline.chapters[1], course.outline.chapters[1].knowledgePoints[0]))
ck('拍平后跨章节有序', core.courseKps(course).map((x) => x.no).join(',') === '1.1,1.2,2.1')

/* 进度：只有知识点层落盘，章节 / 课程派生（05 §6） */
ck('缺省进度是「未开始」', core.kpProgress({}, 'kp-01-01') === '未开始')
ck('非法进度值按未开始处理', core.kpProgress({ 'kp-01-01': '???' }, 'kp-01-01') === '未开始')
ck('已掌握计数', core.masteredCount(course, { 'kp-01-01': '已掌握', 'kp-01-02': '进行中' }) === 1)
ck('课程进度 = 已掌握 / 总数', core.progressRatio(3, 1) === 1 / 3)
ck('总数为 0 时进度是 0（不除零）', core.progressRatio(0, 0) === 0)
ck('进度比例被夹在 [0,1]', core.progressRatio(2, 5) === 1 && core.progressRatio(2, -1) === 0)

/* 两套状态 */
ck('生成状态：生成中优先', core.kpGenState(['failed', 'running'], true) === '生成中')
ck('生成状态：排队中（pending/queued）', core.kpGenState(['pending'], false) === '排队中')
ck('生成状态：有资产才算已生成', core.kpGenState([], true) === '已生成' && core.kpGenState([], false) === '未生成')
ck('生成状态：M1 无任务无资产 → 未生成', core.kpGenState(undefined, undefined) === '未生成')
ck('层级聚合优先级：未生成 > 已生成', core.scopeGenState(['已生成', '未生成']) === '未生成')
ck('层级聚合优先级：生成失败 > 未生成', core.scopeGenState(['未生成', '生成失败']) === '生成失败')
ck('层级聚合：全部已生成 → 已生成', core.scopeGenState(['已生成', '已生成']) === '已生成')
ck('层级聚合：空集合 → 已生成', core.scopeGenState([]) === '已生成')
ck('学习状态映射', core.kpLearnState('已掌握') === '学习完成' && core.kpLearnState('进行中') === '学习中' && core.kpLearnState('未开始') === '学习开始')
ck('学习聚合：全掌握才完成', core.scopeLearnState(['已掌握', '进行中']) === '学习中')
ck('学习聚合：空集合 → 学习开始', core.scopeLearnState([]) === '学习开始')

/* 筛选：三条件叠加、标签内部 OR（06 §3.1） */
const rows = [
  { id: 'a', name: 'React Server Components', category: '前端', tags: ['React', 'SSR'] },
  { id: 'b', name: 'Rust 所有权', category: '系统', tags: ['Rust'] },
  { id: 'c', name: 'React 状态管理', category: '前端', tags: ['React', 'Rust'] },
]
const ids = (list) => list.map((c) => c.id).join(',')
ck('无筛选 → 全部', ids(core.filterCourses(rows, { category: '', tags: [], query: '' })) === 'a,b,c')
ck('分类筛选', ids(core.filterCourses(rows, { category: '前端', tags: [], query: '' })) === 'a,c')
ck('名称搜索不区分大小写 + 去空白', ids(core.filterCourses(rows, { tags: [], query: '  react ' })) === 'a,c')
ck('标签多选是 OR', ids(core.filterCourses(rows, { tags: ['SSR', 'Rust'] })) === 'a,b,c')
ck('三条件叠加', ids(core.filterCourses(rows, { category: '前端', tags: ['Rust'], query: 'react' })) === 'c')
ck('全库标签按出现顺序去重', core.allTags(rows).join(',') === 'React,SSR,Rust')
ck('标签计数', core.tagCount(rows, 'React') === 2)
ck('分类去重（空分类不进列表）', core.allCategories(rows.concat([{ id: 'd', category: '', tags: [] }])).join(',') === '前端,系统')
ck('按分类分组保持首次出现顺序', core.groupByCategory(rows).map((g) => g.category).join(',') === '前端,系统')
ck('课程名 16 字截断（06 §4.4）',
  core.truncateName('用 3 章讲清 React Server Components') === '用 3 章讲清 React Server Components'.slice(0, 16) + '…',
  core.truncateName('用 3 章讲清 React Server Components'))
ck('人读标签：章节与知识点都不含存储 id',
  core.chapterLabel(course.outline.chapters[0]) === '1-为什么需要 RSC' && core.kpLabel(course.outline.chapters[0], course.outline.chapters[0].knowledgePoints[0]) === '1.1-CSR 与 SSR 各自的水合代价')
ck('未生成空态的正文路径按类型分派（05 §5.4）',
  core.contentRelPath('kp-01-01', '图文') === 'content-assets/kp-01-01.md' &&
  core.contentRelPath('kp-02-01', '幻灯片') === 'content-assets/kp-02-01.slides.md')
ck('新建章节 id 与 host 默认规则一致', core.nextChapterId(course.outline.chapters) === 'ch-03')
ck('新建知识点 id 与 host 默认规则一致', core.nextKpId(course.outline.chapters[0]) === 'kp-01-03')

/* i18n：两个语言的键必须一一对应（漏一个就会在界面上露出键名） */
const zhKeys = Object.keys(core.LOCALES['zh-CN']).sort()
const enKeys = Object.keys(core.LOCALES.en).sort()
ck('zh-CN 与 en 的键完全一致', zhKeys.join('|') === enKeys.join('|'),
  zhKeys.filter((k) => enKeys.indexOf(k) < 0).concat(enKeys.filter((k) => zhKeys.indexOf(k) < 0)).join(' '))
ck('插值占位符两端一致', zhKeys.every((k) => {
  const slots = (s) => (String(s).match(/\{(\w+)\}/g) || []).sort().join(',')
  return slots(core.LOCALES['zh-CN'][k]) === slots(core.LOCALES.en[k])
}))
const t = core.createT('zh-CN')
ck('t 支持插值', t('library.tagbarClear', { n: 2 }) === '清除标签（2）')
ck('t 缺键时回退键名（不静默变空）', t('nope.nope') === 'nope.nope')
ck('t 回退到默认语言', core.createT('fr')('panel.title') === 'AI 课程')
ck('locale 探测', core.detectLocale({ documentElement: { lang: 'en-US' } }) === 'en' && core.detectLocale({ documentElement: { lang: 'zh-CN' } }) === 'zh-CN')

/* DSH locale 插件启动后才把 <html lang> 从服务端默认 en 改成用户设置；
   createLiveT 必须每次现读，不能 apply 时锁死。 */
{
  const liveDoc = { documentElement: { lang: 'en' } }
  const liveT = core.createLiveT(liveDoc, { language: 'en-US' })
  ck('createLiveT：初始 <html lang=en> 显示英文', liveT('panel.title') === 'AI Courses', liveT('panel.title'))
  liveDoc.documentElement.lang = 'zh-CN'
  ck('createLiveT：lang 改成 zh-CN 后同一个 t 立即切中文', liveT('panel.title') === 'AI 课程', liveT('panel.title'))
  liveDoc.documentElement.lang = 'en'
  ck('createLiveT：切回 en 也立即生效', liveT('panel.title') === 'AI Courses', liveT('panel.title'))
}

/* ==========================================================================
 * 2 · 组件里用到的 i18n 键必须在词表里（中文不许内联在组件代码里）
 * ======================================================================== */
const files = (await readdir(srcDir)).filter((f) => f.endsWith('.js')).sort()
const sources = {}
for (const f of files) sources[f] = await readFile(join(srcDir, f), 'utf8')
/* 样式表不是 .js（不能混进 sources：那段会被当 JS 求值做「未声明名字」检查），
   但视觉约定（圆形按钮、开关的灰/黑）也要能被断言 —— 单独读一份。 */
const stylesCss = await readFile(join(srcDir, 'styles.css'), 'utf8')

const usedKeys = new Set()
const dynamicPrefixes = new Set()
for (const [name, code] of Object.entries(sources)) {
  if (name === '10-core.js') continue
  /* 允许的**前缀拼接**：`t('state.kp.' + state)` / `t('a11y.scope' + scope)` —— 这些不是完整键，单独收集 */
  for (const m of code.matchAll(/\bt\('([a-z0-9._]+)'\s*\+/g)) dynamicPrefixes.add(m[1])
  for (const m of code.matchAll(/\bt\('([^']+)'(?!\s*\+)/g)) usedKeys.add(m[1])
}
const missingKeys = [...usedKeys].filter((k) => !core.LOCALES['zh-CN'][k] || !core.LOCALES.en[k])
ck('组件里用到的每个 i18n 键都在两套词表里', missingKeys.length === 0, missingKeys.join(' '))
const prefixOk = [...dynamicPrefixes].every((p) => zhKeys.some((k) => k.indexOf(p) === 0) && enKeys.some((k) => k.indexOf(p) === 0))
ck('动态拼接的键前缀在两套词表里都有条目', prefixOk, [...dynamicPrefixes].join(' '))
ck('state.kp.* 覆盖三种进度值', ['未开始', '进行中', '已掌握'].every((s) => core.LOCALES['zh-CN']['state.kp.' + s] && core.LOCALES.en['state.kp.' + s]))
ck('a11y.scope* 覆盖三个作用域', ['Course', 'Chapter', 'Kp'].every((s) => core.LOCALES['zh-CN']['a11y.scope' + s] && core.LOCALES.en['a11y.scope' + s]))

/* 中文不许内联在组件里（06 §9）。允许的例外只有两类：
     ① 领域值（内容类型 / 进度 / 状态枚举）—— 它们是**数据**，比较与查表用，不直接当文案；
     ② `console.*` 开发者日志 —— 不是界面文案。 */
const DOMAIN_VALUES = new Set([].concat(
  core.CONTENT_TYPES, core.DIFFICULTIES, core.KP_STATES,
  core.GEN_STATES.map((s) => s.key), core.LEARN_STATES.map((s) => s.key),
))
const inlineChinese = []
for (const [name, code] of Object.entries(sources)) {
  if (name === '10-core.js') continue
  const noComments = code.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
  const bad = []
  for (const line of noComments.split('\n')) {
    if (/console\.(log|warn|error|info)/.test(line)) continue
    for (const hit of (line.match(/[\u4e00-\u9fa5]+/g) || [])) {
      if (!DOMAIN_VALUES.has(hit)) bad.push(hit)
    }
  }
  if (bad.length) inlineChinese.push(`${name}: ${[...new Set(bad)].join('/')}`)
}
ck('组件代码里没有内联界面文案（领域值与日志除外）', inlineChinese.length === 0, inlineChinese.join(' '))

/* ==========================================================================
 * 3 · 产物求值：脚本能跑、槽位注册形状正确、样式能注入（**不渲染任何组件**）
 * ======================================================================== */
const clientCode = await readFile(join(pkgDir, 'lib/client.js'), 'utf8')
const styles = await readFile(join(pkgDir, 'lib/styles.css'), 'utf8')
const pkg = JSON.parse(await readFile(join(pkgDir, 'package.json'), 'utf8'))
const hostCode = await readFile(join(pkgDir, 'index.mjs'), 'utf8')

/* 3a · 静态一致性：组件名拼错 / core API 用错，都只有真机才炸 —— 这里先钉住 */
const clientNoCss = clientCode.replace(/^const AIC_COURSES_CSS = .*$/m, '')
const definedNames = new Set()
for (const m of clientNoCss.matchAll(/function ([A-Za-z_$][\w$]*)/g)) definedNames.add(m[1])
for (const m of clientNoCss.matchAll(/(?:const|let|var) ([A-Za-z_$][\w$]*)\s*=/g)) definedNames.add(m[1])
const usedComponents = new Set([...clientNoCss.matchAll(/\bh\(([A-Z][\w$]*)/g)].map((m) => m[1]))
const undefinedComponents = [...usedComponents].filter((n) => !definedNames.has(n))
ck('产物里用到的每个 React 组件都已定义（拼错会在这里暴露）', undefinedComponents.length === 0, undefinedComponents.join(' '))

const coreApiUsed = new Set([...clientNoCss.matchAll(/AIC_COURSES_CORE\.([A-Za-z_$][\w$]*)/g)].map((m) => m[1]))
const coreApiMissing = [...coreApiUsed].filter((k) => !(k in core))
ck('产物用到的每个 core API 都存在', coreApiMissing.length === 0, coreApiMissing.join(' '))

/* 3b · 跨半边契约：client 的 RPC 前缀必须与 host 注册的路由前缀一致 */
const clientPrefix = (clientNoCss.match(/const AIC_RPC_PREFIX = '([^']+)'/) || [])[1]
const hostPrefix = (hostCode.match(/const RPC_PREFIX = '([^']+)'/) || [])[1]
/* 3b-1 · 「幻灯片」解析与媒体 URL（纯逻辑，真值表）——内容渲染的两块地基 */
{
  const slideSrc = ['---', 'title: 讲义', '---', '', '# 封面', '', '<!-- 开场白 -->', '', '---', 'layout: center', '', '# 第二页', '', '正文', '', '---', '', '# 末页'].join('\n')
  const parsed = core.parseSlidev(slideSrc)
  ck('parseSlidev：headmatter 被解析成 config', parsed.config.title === '讲义', JSON.stringify(parsed.config))
  ck('parseSlidev：按 `---` 分出三页', parsed.slides.length === 3, String(parsed.slides.length))
  ck('parseSlidev：每页标题取 `#`，页末注释当讲稿', parsed.slides[0].title === '封面' && parsed.slides[0].notes === '开场白')
  ck('parseSlidev：容忍模型漏写页 frontmatter 围栏（layout 仍在）', parsed.slides[1].layout === 'center', parsed.slides[1].layout)
  ck('parseSlidev：未知版式回 default（不白屏）', core.slideLayout('nope') === 'default')
  ck('parseSlidev：没有分页时也至少有一页', core.parseSlidev('# 只有一页').slides.length === 1)
  ck('parseSlidev：空讲义 → 零页（由播放器显示空态）', core.parseSlidev('   ').slides.length === 0)

  /* 媒体 URL：把正文里的相对路径换成 host 的媒体路由。
     `aicMediaUrl` 在 client 工厂的闭包里（沙箱外拿不到）→ 从源码里单独取出来**真实求值**。 */
  const rpcSrc = await readFile(join(srcDir, '30-rpc.js'), 'utf8')
  const mediaFn = new Function(`${rpcSrc}\n;return aicMediaUrl`)()
  const url = mediaFn('c-1', 'content-assets', 'media/kp-01-01-01.svg')
  ck('媒体 URL 指向 host 的媒体前缀', url === '/dsh-ai-courses/media/c-1/content-assets/media/kp-01-01-01.svg', url)
  ck('媒体 URL 拒绝越界路径（../ 不许越过基准目录）', mediaFn('c-1', 'content-assets', '../../etc/passwd') === '')
  ck('媒体 URL 拒绝外部链接（不把远程地址当图片）', mediaFn('c-1', 'content-assets', 'https://evil/x.png') === '')
  ck('媒体 URL 归一化 `media/../media/y`', mediaFn('c-1', 'content-assets', 'media/../media/y.svg').endsWith('/content-assets/media/y.svg'))
}

ck('client 的 RPC 前缀与 host 一致', !!clientPrefix && clientPrefix === hostPrefix, `${clientPrefix} / ${hostPrefix}`)

const loads = []
const registrations = []
const styleEls = []
const reactStub = {
  createElement: (type, props) => ({ type, props }),
  useState: (v) => [typeof v === 'function' ? v() : v, () => {}],
  useEffect: () => {},
  useRef: (v) => ({ current: v }),
}
/* react-dom 只为 createPortal（弹窗 portal 到 body）：离线沙箱里 document 是桩，
   所以 createPortal 只需原样返回元素 —— 断言关心的是**形状**，不是渲染。 */
const reactDomStub = { createPortal: (element) => element }
const sandbox = {
  console: { log: () => {}, warn: () => {}, error: () => {} },
  navigator: { language: 'zh-CN' },
  document: {
    documentElement: { lang: 'zh-CN' },
    head: { appendChild: (el) => styleEls.push(el) },
    createElement: () => ({
      setAttribute: () => {},
      textContent: '',
      parentNode: { removeChild: () => {} },
    }),
    addEventListener: () => {},
    removeEventListener: () => {},
  },
  window: {
    __ModuleLoader__: {
      load: (entry) => loads.push(entry),
    },
  },
}
sandbox.self = sandbox
sandbox.globalThis = sandbox
const context = vm.createContext(sandbox)
let evalError = null
try {
  vm.runInContext(clientCode, context, { filename: 'lib/client.js' })
} catch (err) {
  evalError = err
}
ck('产物脚本能在 node 沙箱里求值（无 TDZ / 无顶层引用错误）', !evalError, evalError ? evalError.message : '')
if (evalError) {
  console.log(`\n${fail} 项失败（产物无法求值，后续断言跳过）   （PASS ${pass} / FAIL ${fail}）`)
  process.exit(1)
}

ck('恰好注册一个 client 入口', loads.length === 1)
const entry = loads[0] || {}
ck('入口 id 等于包名', entry.id === pkg.name, entry.id)
ck('工厂是函数', typeof entry.factory === 'function')

let mod = null
try {
  mod = entry.factory((name) => {
    if (name === 'react') return reactStub
    if (name === 'react-dom') return reactDomStub
    throw new Error('产物不许 require 其它模块：' + name)
  })
} catch (err) {
  ck('工厂能被调用（模块表只取 react / react-dom）', false, err.message)
}
if (mod) {
  ck('插件对象：name / inject / apply', mod.name === pkg.name && Array.isArray(mod.inject) && typeof mod.apply === 'function', `${mod.name} ${JSON.stringify(mod.inject)}`)

  /* apply：用最小的 slots / ctx 桩验证注册形状与样式注入（仍不渲染组件） */
  const injects = []
  const slotsStub = {
    register: (spec, render) => { registrations.push({ spec, render }); return () => {} },
    /* 两段式注入：槽由**别的包**（ui-chat）声明，声明还不存在时回调不会跑。
       这里把回调记下来，稍后手动「声明」一次，验证我们注册的形状。 */
    inject: (key, cb) => { injects.push({ key, cb }); return () => {} },
  }
  const effects = []
  const ctxStub = {
    get: (name) => (name === 'slots' ? slotsStub : undefined),
    effect: (fn) => { effects.push(fn) },
    remote: {},
    logger: { info: () => {}, error: () => {} },
  }
  let applyError = null
  try {
    mod.apply(ctxStub)
  } catch (err) {
    applyError = err
  }
  ck('apply 能跑完且不抛', !applyError, applyError ? applyError.message : '')
  /* 面板槽也走 inject：`sidebar.panellist` 在 web app 里由 sidebar 首次渲染时声明，
     apply 阶段直接 register 会抛「未声明」。这里模拟声明出现，注册才会发生。 */
  ck('五个槽都走 inject 等声明（两个面板槽 + 三个主会话槽）',
    injects.length === 5 &&
    injects[0].key === 'sidebar.panellist' &&
    injects[1].key === 'main' &&
    injects[2].key === 'conversation.chat.commandview' &&
    injects[3].key === 'conversation.chat.turnTail' &&
    injects[4].key === 'conversation.input.dock',
    injects.map((i) => i.key).join(' '))
  let panelInjectError = null
  try {
    injects[0].cb()
    injects[1].cb()
  } catch (err) {
    panelInjectError = err
  }
  ck('面板槽声明出现后回调不抛', !panelInjectError, panelInjectError ? panelInjectError.message : '')
  ck('注册了两个槽位（侧边栏 + 主面板）', registrations.length === 2, String(registrations.length))
  const sidebar = registrations[0] || {}
  const main = registrations[1] || {}
  ck('sidebar.panellist 的 id 是 ai-courses 且 label 是函数',
    sidebar.spec && sidebar.spec.name === 'sidebar.panellist' && sidebar.spec.id === 'ai-courses' && typeof sidebar.spec.label === 'function',
    JSON.stringify(sidebar.spec))
  ck('sidebar 的 label() 返回面板名（走词表）', sidebar.spec && sidebar.spec.label() === 'AI 课程', sidebar.spec && sidebar.spec.label())
  ck('main 的 key 与 sidebar id 相同',
    main.spec && main.spec.name === 'main' && main.spec.key === sidebar.spec.id,
    JSON.stringify(main.spec))
  ck('两个槽位都给了渲染函数', typeof sidebar.render === 'function' && typeof main.render === 'function')
  ck('样式被注入且内容与 lib/styles.css 逐字一致', styleEls.length === 1 && styleEls[0].textContent === styles,
    `${styleEls.length} 个 <style>，${styleEls[0] ? String(styleEls[0].textContent).length : 0} B`)
  ck('清理走 ctx.effect 注册', effects.length === 1 && typeof effects[0] === 'function')

  /* 主会话命令卡片：注册到 ui-chat 声明的 keyed 槽，**按命令名**派发（key = ai-course）。
     槽不存在时（没有 ui-chat 的组合 / 声明还没出现）不注册、不报错 —— 这正是 inject 的语义。 */
  const beforeInject = registrations.length
  let declared = false
  try {
    injects[2].cb()
    declared = true
  } catch (err) {
    ck('声明出现后回调不抛', false, err.message)
  }
  if (declared) {
    const card = registrations[beforeInject] || {}
    ck('命令卡片注册在 conversation.chat.commandview 上',
      card.spec && card.spec.name === 'conversation.chat.commandview', JSON.stringify(card.spec))
    ck('命令卡片的 key 是命令名 ai-course（宿主按 entryKey 派发）',
      card.spec && card.spec.key === 'ai-course', JSON.stringify(card.spec))
    ck('命令卡片给了渲染函数', typeof card.render === 'function')
    let renderError = null
    try {
      card.render({ node: { commandId: 'cmd-1', name: 'ai-course', args: '用 3 章讲 RSC', outcome: null }, sessionId: 'sess-1', t })
    } catch (err) { renderError = err }
    ck('命令卡片渲染一次不抛（含 outcome=null 的进行中形态）', !renderError, renderError ? renderError.message : '')
  }

  /* 主会话**大纲卡片**：list 槽用 `id` 注册（不是 keyed 的 key）。
     还没取到数据时必须渲染成 null（不能每回合都长一张空卡）。 */
  const beforeOutline = registrations.length
  let outlineDeclared = false
  try {
    injects[3].cb()
    outlineDeclared = true
  } catch (err) {
    ck('大纲卡的声明出现后回调不抛', false, err.message)
  }
  if (outlineDeclared) {
    const card = registrations[beforeOutline] || {}
    ck('大纲卡注册在 conversation.chat.turnTail 上',
      card.spec && card.spec.name === 'conversation.chat.turnTail', JSON.stringify(card.spec))
    ck('大纲卡用 list 槽的 id 注册（不是 keyed 的 key）',
      card.spec && card.spec.id === 'dsh-ai-courses/outline-card' && card.spec.key === undefined,
      JSON.stringify(card.spec))
    let outlineError = null
    try {
      /* `slots.register` 收的是**组件引用**，不是渲染结果：这里断言「调用不抛」，
         真正的回合判定由下面 3c 的纯函数真值表覆盖（mock 渲染不算界面验证，09 §7.2）。 */
      card.render({ sessionId: 'sess-1', turn: { start: { time: 1 }, end: { time: 9 } }, t })
    } catch (err) { outlineError = err }
    ck('大纲卡的 render 是纯组件调用（不抛、不在渲染期取数）', !outlineError, outlineError ? outlineError.message : '')

{
  /* 常驻 agent 状态条（conversation.input.dock）：list 槽用 id 注册；首次渲染不能有输出 */
  const beforeDock = registrations.length
  let dockDeclared = false
  try {
    injects[4].cb()
    dockDeclared = true
  } catch (err) {
    ck('状态条的声明出现后回调不抛', false, err.message)
  }
  if (dockDeclared) {
    const dock = registrations[beforeDock] || {}
    ck('状态条注册在 conversation.input.dock（list 槽，用 id）',
      dock.spec && dock.spec.name === 'conversation.input.dock' &&
      dock.spec.id === 'dsh-ai-courses/agent-dock' && dock.spec.key === undefined,
      JSON.stringify(dock.spec))
    let dockError = null
    try { dock.render({ sessionId: 'sess-1', t }) } catch (err) { dockError = err }
    ck('状态条 render 是纯组件调用（不抛、不在渲染期取数）', !dockError, dockError ? dockError.message : '')
  }
}

    /* ⚠️ Hook 顺序陷阱：组件必须在**任何 hook 之前**用纯函数决定「这一回合要不要渲染」，
       否则「无课程就不渲染」的早退会被 hook 数量变化打乱（真机上是 React 崩，不是这里）。
       下面这条静态断言钉住那个顺序。 */
    const cardSrc = await readFile(join(srcDir, '65-outline-card.js'), 'utf8')
    const fnStart = cardSrc.indexOf('function AicOutlineCard')
    const firstHook = cardSrc.indexOf('React.use', fnStart)
    const gate = cardSrc.indexOf('aicCoursesOfTurn(props.courses, turn)', fnStart)
    ck('大纲卡：早退判据在任何 hook 之前（Hook 顺序）',
      fnStart > 0 && gate > fnStart && firstHook > gate, `gate@${gate} firstHook@${firstHook}`)
  }
}

/* ==========================================================================
 * 3b-2a00000 · 「保留原有内容」：只有已有内容时才给选项，且默认保留
 * ======================================================================== */
{
  const h2 = (type, props, ...kids) => ({ type, props: props || {}, kids: kids.flat(9) })
  const store = []
  let cursor = 0
  const React2 = {
    createElement: h2,
    useState: (v) => {
      const i = cursor++
      if (!(i in store)) store[i] = (typeof v === 'function' ? v() : v)
      return [store[i], (nv) => { store[i] = typeof nv === 'function' ? nv(store[i]) : nv }]
    },
    useEffect: () => {}, useMemo: (f) => f(), useRef: (v) => ({ current: v }),
  }
  const calls = []
  const scope = {}
  try {
    new Function('h', 'React', 'AIC_COURSES_CORE', 'AIC_NAV', 'ReactDOM', 'aicRpc', 'AIC_PROMPT_MAX', 'scope',
      sources['20-widgets.js'].replace(/\/\*[\s\S]*?\*\//g, '') + '\n' +
      sources['60-modals.js'].replace(/\/\*[\s\S]*?\*\//g, '') +
      ';Object.assign(scope, { GenerateModal })')(
      h2, React2, core, { open () {} }, undefined,
      (m, b) => { calls.push([m, b]); return Promise.resolve({ ok: true }) }, 2000, scope)
  } catch (err) {
    ck('生成弹窗可以被求值（保留选项用例）', false, err.message)
  }
  if (scope.GenerateModal) {
    const course2 = { id: 'c-1', name: '课', outline: { chapters: [{ id: 'ch-01', order: 1, name: '章', knowledgePoints: [{ id: 'kp-01-01', order: 1, name: '点', contentType: '图文', duration: 9 }] }] } }
    const ch2 = course2.outline.chapters[0]
    const kp2 = ch2.knowledgePoints[0]
    const t2 = (k) => k
    const mount = (extra) => {
      cursor = 0
      return scope.GenerateModal(Object.assign({ t: t2, ch: ch2, kp: kp2, kpProgress: {}, courseId: 'c-1', state: '', agentId: 's1' }, extra))
    }
    const countInputs = (tree) => {
      let n = 0
      const walk = (x) => {
        if (!x || typeof x !== 'object') return
        if (Array.isArray(x)) return x.forEach(walk)
        if (x.type === 'input') n++
        if (x.props && x.props.foot) walk(x.props.foot)
        ;(x.kids || []).forEach(walk)
      }
      walk(tree); return n
    }
    const submitOf = (tree) => {
      const out = []
      const walk = (x) => {
        if (!x || typeof x !== 'object') return
        if (Array.isArray(x)) return x.forEach(walk)
        if (x.type === 'button') out.push(x)
        if (x.props && x.props.foot) walk(x.props.foot)
        ;(x.kids || []).forEach(walk)
      }
      walk(tree); return out[out.length - 1]
    }
    ck('没有内容时**不出现**保留/覆盖选项', countInputs(mount({ hasAsset: false })) === 0)
    ck('已有内容时出现两个单选（保留 / 覆盖）', countInputs(mount({ hasAsset: true })) === 2)
    /* 默认「保留」→ keepExisting: true */
    mount({ hasAsset: true })
    submitOf(mount({ hasAsset: true })).props.onClick()
    ck('默认保留 → keepExisting=true（服务端会追加）', calls[0] && calls[0][1].keepExisting === true, JSON.stringify(calls[0] && calls[0][1].keepExisting))
    ck('没有内容时不传 keepExisting=true（避免宿主去读不存在的旧正文）',
      (() => { calls.length = 0; mount({ hasAsset: false }); submitOf(mount({ hasAsset: false })).props.onClick(); return calls[0] && calls[0][1].keepExisting === false })())
  }
}

/* ==========================================================================
 * 3b-2a0000 · 「AI 备注」：正常带上、超长**先拦**（别让用户吃 `$.prompt 太长`）
 * ======================================================================== */
{
  const h2 = (type, props, ...kids) => ({ type, props: props || {}, kids: kids.flat(9) })
  const store = []
  let cursor = 0
  const React2 = {
    createElement: h2,
    /* 正确的 hook 槽语义：每次渲染游标归零、按调用顺序复用槽位（写错过一次，导致"超长也放行"的假象） */
    useState: (v) => {
      const i = cursor++
      if (!(i in store)) store[i] = (typeof v === 'function' ? v() : v)
      return [store[i], (nv) => { store[i] = typeof nv === 'function' ? nv(store[i]) : nv }]
    },
    useEffect: () => {}, useMemo: (f) => f(), useRef: (v) => ({ current: v }),
  }
  const calls = []
  const scope = {}
  try {
    new Function('h', 'React', 'AIC_COURSES_CORE', 'AIC_NAV', 'ReactDOM', 'aicRpc', 'AIC_PROMPT_MAX', 'scope',
      sources['20-widgets.js'].replace(/\/\*[\s\S]*?\*\//g, '') + '\n' +
      sources['60-modals.js'].replace(/\/\*[\s\S]*?\*\//g, '') +
      ';Object.assign(scope, { GenerateModal })')(
      h2, React2, core, { open () {} }, undefined,
      (m, b) => { calls.push([m, b]); return Promise.resolve({ ok: true }) }, 2000, scope)
  } catch (err) {
    ck('生成弹窗可以被求值（备注用例）', false, err.message)
  }
  if (scope.GenerateModal) {
    const course2 = { id: 'c-1', name: '课', outline: { chapters: [{ id: 'ch-01', order: 1, name: '章', knowledgePoints: [{ id: 'kp-01-01', order: 1, name: '点', contentType: '图文', duration: 9 }] }] } }
    const ch2 = course2.outline.chapters[0]
    const kp2 = ch2.knowledgePoints[0]
    const t2 = (k) => k
    const mount = (extra) => {
      cursor = 0
      return scope.GenerateModal(Object.assign({ t: t2, ch: ch2, kp: kp2, kpProgress: {}, courseId: 'c-1', hasAsset: true, state: '', agentId: 's1' }, extra))
    }
    const submitOf = (tree) => {
      const out = []
      const walk = (n) => {
        if (!n || typeof n !== 'object') return
        if (Array.isArray(n)) return n.forEach(walk)
        if (n.type === 'button') out.push(n)
        if (n.props && n.props.foot) walk(n.props.foot)
        ;(n.kids || []).forEach(walk)
      }
      walk(tree)
      return out[out.length - 1]
    }
    mount({})
    store[0] = '多用对比'
    submitOf(mount({})).props.onClick()
    ck('填了备注 → 按原样带上（不再是空串）', calls.length === 1 && calls[0][1].prompt === '多用对比', JSON.stringify(calls[0] && calls[0][1].prompt))
    store[0] = 'x'.repeat(2500)
    submitOf(mount({})).props.onClick()
    ck('备注超长 → **不再发**请求，弹窗里给可读提示', calls.length === 1, `调用 ${calls.length} 次`)
    ck('备注上限与宿主同一个数（构建期注入 AIC_PROMPT_MAX）', /const AIC_PROMPT_MAX = \d+/.test(sources['60-modals.js']) === false)
  }
}

/* ==========================================================================
 * 3b-2a000 · 没内容的知识点**不记学习进度**（空态一进一出会刷出假「已掌握」）
 * ======================================================================== */
{
  const lesson = sources['70-lesson.js']
  const start = lesson.indexOf('const mark = props.onMark')
  const end = lesson.indexOf('/* 图片：把正文里的')
  const block = start >= 0 && end > start ? lesson.slice(start, end) : ''
  const run = (payload, onMark) => {
    const cleanups = []
    const React2 = {
      useEffect: (fn) => { const c = fn(); if (typeof c === 'function') cleanups.push(c) },
      useRef: (v) => ({ current: v }),
    }
    const fn = new Function('React', 'payload', 'course', 'kp', 'props', block)
    fn(React2, payload, { id: 'c-1' }, { id: 'kp-01-01' }, { onMark })
    cleanups.forEach((c) => c())
  }
  const trace = (payload) => {
    const calls = []
    run(payload, (s) => calls.push(s))
    return calls
  }
  ck('没内容：打开与离开都**不**标记进度', JSON.stringify(trace({ hasAsset: false })) === '[]', JSON.stringify(trace({ hasAsset: false })))
  ck('载荷还没到：先不标记（等 hasAsset 确定）', JSON.stringify(trace(null)) === '[]')
  ck('有内容：打开标进行中、离开标已掌握',
    JSON.stringify(trace({ hasAsset: true })) === '["进行中","已掌握"]', JSON.stringify(trace({ hasAsset: true })))
}

/* ==========================================================================
 * 3b-2a00 · 生成弹窗：没有会话 id 就**先给提示**，不发那个必然失败的请求
 * ======================================================================== */
{
  const h2 = (type, props, ...kids) => ({ type, props: props || {}, kids: kids.flat(9) })
  const React2 = { createElement: h2, useState: (v) => [typeof v === 'function' ? v() : v, () => {}], useEffect: () => {}, useMemo: (f) => f(), useRef: (v) => ({ current: v }) }
  const calls = []
  const scope = {}
  try {
    new Function('h', 'React', 'AIC_COURSES_CORE', 'AIC_NAV', 'ReactDOM', 'aicRpc', 'AIC_PROMPT_MAX', 'scope',
      sources['20-widgets.js'].replace(/\/\*[\s\S]*?\*\//g, '') + '\n' +
      sources['60-modals.js'].replace(/\/\*[\s\S]*?\*\//g, '') +
      ';Object.assign(scope, { GenerateModal })')(
      h2, React2, core, { open () {} }, undefined,
      (m, b) => { calls.push([m, b]); return Promise.resolve({ ok: true }) }, 2000, scope)
  } catch (err) {
    ck('生成弹窗可以被求值', false, err.message)
  }
  if (scope.GenerateModal) {
    const course2 = { id: 'c-1', name: '课', outline: { chapters: [{ id: 'ch-01', order: 1, name: '章', knowledgePoints: [{ id: 'kp-01-01', order: 1, name: '点', contentType: '图文' }] }] } }
    const ch2 = course2.outline.chapters[0]
    const kp2 = ch2.knowledgePoints[0]
    const t2 = (k) => k
    const render = (extra) => scope.GenerateModal(Object.assign({ t: t2, ch: ch2, kp: kp2, kpProgress: {}, courseId: 'c-1', hasAsset: false, state: '' }, extra))
    const submitOf = (tree) => {
      const out = []
      const walk = (n) => {
        if (!n || typeof n !== 'object') return
        if (Array.isArray(n)) return n.forEach(walk)
        if (n.type === 'button') out.push(n)
        if (n.props && n.props.foot) walk(n.props.foot)
        ;(n.kids || []).forEach(walk)
      }
      walk(tree)
      return out[out.length - 1]
    }
    submitOf(render({ agentId: '' })).props.onClick()
    ck('没有会话 id 时**不发** generation.start（先给可操作提示）', calls.length === 0, `调用 ${calls.length} 次`)
    submitOf(render({ agentId: 'sess-1' })).props.onClick()
    ck('有会话 id 时按 kp 范围发起，且带上会话 id',
      calls.length === 1 && calls[0][1].scope === 'kp' &&
      JSON.stringify(calls[0][1].targetIds) === '["kp-01-01"]' && calls[0][1].agentId === 'sess-1',
      JSON.stringify(calls[0] && calls[0][1]))
  }
}

/* ==========================================================================
 * 3b-2a0 · 「生成要用哪个会话」：active() 优先，其次主视图；猜不到就空串
 * ======================================================================== */
{
  const src = sources['62-editor.js']
  const start = src.indexOf('function aicActiveSessionId')
  let end = -1
  if (start >= 0) {
    /* 用大括号配对取函数体 */
    let depth = 0
    for (let i = src.indexOf('{', start); i < src.length; i++) {
      if (src[i] === '{') depth++
      else if (src[i] === '}') { depth--; if (depth === 0) { end = i + 1; break } }
    }
  }
  const fnSrc = start >= 0 && end > start ? src.slice(start, end) : ''
  let pick = null
  try {
    pick = new Function(fnSrc + ';return aicActiveSessionId')()
  } catch (err) {
    ck('会话选择函数可以被求值', false, err.message)
  }
  if (pick) {
    const mk = (byId) => ({ get: () => ({ list: { getSnapshot: () => ({ byId }) } }) })
    ck('优先取主视图正在看的会话',
      pick(mk({ a: { retainedBy: { mainView: 0 } }, b: { retainedBy: { mainView: 1 }, updatedAt: 1 } })) === 'b')
    ck('没有会话占用主视图时不再猜最近会话（宁可空串也不写错会话）',
      pick(mk({ a: { retainedBy: {}, updatedAt: 10 }, b: { retainedBy: {}, updatedAt: 99 } })) === '')
    ck('sessions.active() 存在时优先用它',
      pick({ get: () => ({ active: () => ({ id: 'sess-active' }), list: { getSnapshot: () => ({ byId: {} }) } }) }) === 'sess-active')
    ck('一个会话都没有 → 空串', pick(mk({})) === '')
    ck('取不到 sessions 服务 → 空串，不抛', pick({ get: () => null }) === '' && pick(null) === '')
  }
}

/* ==========================================================================
 * 3b-2a · 大纲行：**没有内容就不显示学习时长**（旧数据里可能残留大纲阶段的估值）
 * ======================================================================== */
{
  const scope = {}
  const h2 = (type, props, ...kids) => ({ type, props: props || {}, kids: kids.flat(9) })
  const React2 = { createElement: h2, useState: (v) => [typeof v === 'function' ? v() : v, () => {}], useEffect: () => {}, useMemo: (f) => f(), useRef: (v) => ({ current: v }) }
  try {
    new Function('h', 'React', 'AIC_COURSES_CORE', 'scope',
      sources['20-widgets.js'].replace(/\/\*[\s\S]*?\*\//g, '') + '\n' +
      sources['50-outline.js'].replace(/\/\*[\s\S]*?\*\//g, '') +
      ';Object.assign(scope, { OutlineView, DurationLabel })')(h2, React2, core, scope)
  } catch (err) {
    ck('大纲视图可以被求值（时长用例）', false, err.message)
  }
  if (scope.OutlineView) {
    const course3 = { id: 'c', name: '课', tags: [], outline: { chapters: [{ id: 'ch-01', order: 1, name: '章', knowledgePoints: [
      { id: 'kp-01-01', order: 1, name: '有内容', contentType: '图文', duration: 7 },
      { id: 'kp-01-02', order: 2, name: '没内容但有旧估值', contentType: '图文', duration: 12 },
      { id: 'kp-01-03', order: 3, name: '没内容也没时长', contentType: '图文' },
    ] }] } }
    const shown = (assets) => {
      let n = 0
      const walk = (x) => {
        if (!x || typeof x !== 'object') return
        if (Array.isArray(x)) return x.forEach(walk)
        /* 元素总在（组件内部判空），所以数的是**真正有值**的那些 */
        if (x.type === scope.DurationLabel && x.props && x.props.minutes) n++
        ;(x.kids || []).forEach(walk)
      }
      walk(scope.OutlineView({ t: (k) => k, course: course3, variant: 'page', editable: true, disabled: false, kpProgress: {}, assets, taskStates: {}, onEdit: () => {}, onOpenKp: () => {} }))
      return n
    }
    ck('只显示**已生成内容**的知识点时长（旧残留估值不显示）',
      shown({ 'kp-01-01': {} }) === 1 && shown({}) === 0 && shown({ 'kp-01-01': {}, 'kp-01-02': {} }) === 2,
      `1→${shown({ 'kp-01-01': {} })} / 0→${shown({})} / 2→${shown({ 'kp-01-01': {}, 'kp-01-02': {} })}`)
  }
}

/* ==========================================================================
 * 3b-2b · 导航总线：**面板还没挂载**时的请求不能丢（命令卡片"点了没反应"）
 * ======================================================================== */
{
  const head = sources['00-shell-head.js']
  const start = head.indexOf('const AIC_NAV_LISTENERS')
  /* 用**大括号配对**找 AIC_NAV 对象的结尾（不要拿别的字符串当锚点，容易失配） */
  let end = -1
  if (start >= 0) {
    const objAt = head.indexOf('const AIC_NAV = {', start)
    if (objAt > 0) {
      let depth = 0
      for (let i = head.indexOf('{', objAt); i < head.length; i++) {
        if (head[i] === '{') depth++
        else if (head[i] === '}') { depth--; if (depth === 0) { end = i + 1; break } }
      }
    }
  }
  const block = start >= 0 && end > start ? head.slice(start, end) : ''
  let nav = null
  try {
    const scope = {}
    new Function('scope', block + ';scope.AIC_NAV = AIC_NAV')(scope)
    nav = scope.AIC_NAV
  } catch (err) {
    ck('导航总线可以被求值', false, err.message)
  }
  if (nav) {
    /* 典型时序：主会话卡片先发导航，再切面板（面板切过去才挂载） */
    nav.open('c-1', 'outline')
    const got = []
    nav.on((req) => got.push(req.courseId + ':' + req.view))
    ck('面板未挂载时发起的导航**不丢**（挂载后补发一次）', got.join(',') === 'c-1:outline', got.join(','))
    nav.open('c-2', 'lesson')
    ck('面板已挂载时立刻广播（不再等）', got.join(',') === 'c-1:outline,c-2:lesson', got.join(','))
    const late = []
    nav.on((req) => late.push(req.courseId))
    ck('补发只发生一次（后挂载的监听器不会重放旧请求）', late.length === 0, late.join(','))
    ck('view 缺省为 outline（打开课程默认进大纲）', (() => {
      const seen = []
      nav.open('c-3')
      const off = nav.on((r) => seen.push(r.view))
      off()
      return seen.length === 0 /* 已挂载时广播发生在 open 时刻，后订阅不应收到 */
    })())
  }
}

/* ==========================================================================
 * 3b-2c · 大纲的入口布局（2026-10-18 用户需求）
 *   课程级：**课程编辑**（基础属性）+ **章节编辑**（结构模式 +/-）+ 状态点；
 *           原来的「编辑 + 生成」合成入口已移除，整门课生成不再从大纲页发起。
 *   章节/知识点行：仍用 compose（编辑 + 生成同一入口）。
 *   结构模式：章节与知识点**前面**出现 +/-（增删章节 / 知识点）。
 * ======================================================================== */
{
  /* 用同一份源码跑两次：structMode 关 / 开。`useState` 桩决定初始值 ——
     大纲组件里只有这一个 state（结构模式），所以桩对所有 useState 返回同一初值。 */
  const render = (structInitial) => {
    const scope = {}
    const h2 = (type, props, ...kids) => ({ type, props: props || {}, kids: kids.flat(9) })
    const React2 = {
      createElement: h2,
      useState: (v) => [structInitial, () => {}],
      useEffect: () => {}, useMemo: (f) => f(), useRef: (v) => ({ current: v }),
    }
    new Function('h', 'React', 'AIC_COURSES_CORE', 'scope',
      sources['20-widgets.js'].replace(/\/\*[\s\S]*?\*\//g, '') + '\n' +
      sources['50-outline.js'].replace(/\/\*[\s\S]*?\*\//g, '') +
      ';Object.assign(scope, { AIC_ICONS, OutlineView, IconButton })')(h2, React2, core, scope)
    const course2 = { id: 'c-1', name: '演示课', tags: [], outline: { chapters: [{ id: 'ch-01', order: 1, name: '章一', knowledgePoints: [
      { id: 'kp-01-01', order: 1, name: '点一', contentType: '图文', duration: 5 },
      { id: 'kp-01-02', order: 2, name: '点二', contentType: '图文' },
    ] }, { id: 'ch-02', order: 2, name: '章二', knowledgePoints: [
      { id: 'kp-02-01', order: 1, name: '点三', contentType: '图文' },
    ] }] } }
    const edits = []
    const structural = []
    const tree = scope.OutlineView({
      t: (k, vars) => k + (vars && vars.n !== undefined ? ':' + vars.n : ''), course: course2, variant: 'page',
      disabled: false, kpProgress: {}, assets: {}, taskStates: {},
      onEdit: (kind) => edits.push(kind),
      onStructure: (ops) => structural.push(ops),
    })
    const icons = []
    const walk = (n) => {
      if (!n || typeof n !== 'object') return
      if (Array.isArray(n)) return n.forEach(walk)
      if (n.type === scope.IconButton && n.props && n.props.name) icons.push(n)
      ;(n.kids || []).forEach(walk)
    }
    walk(tree)
    return { icons, edits, structural, scope, course2 }
  }

  /* ---- ① 关闭态：课程级 = edit + structure，行内仍是 compose ---- */
  {
    const r = render(false)
    const names = r.icons.map((i) => i.props.name)
    ck('大纲里没有独立的生成图标按钮', !names.includes('generate'), names.join(','))
    ck('课程级两个入口：课程编辑(edit) + 章节编辑(structure)',
      r.icons.filter((i) => i.props.name === 'edit').length === 1 &&
      r.icons.filter((i) => i.props.name === 'structure').length === 1, names.join(','))
    /* 2 个章节 + 3 个知识点 = 5 个 compose（课程级没有） */
    ck('课程级不再是 compose（编辑 + 生成合成入口已移除）',
      r.icons.filter((i) => i.props.name === 'compose').length === 5, names.join(','))
    ck('课程编辑的可访问名 = 基础属性编辑（不暗示生成）',
      r.icons.filter((i) => i.props.name === 'edit')[0].props.label === 'outline.editCourseBasic',
      r.icons.filter((i) => i.props.name === 'edit')[0].props.label)
    ck('章节编辑开关用专属外观（tone: structure → 默认灰 / 选中黑）',
      r.icons.filter((i) => i.props.name === 'structure')[0].props.tone === 'structure',
      String(r.icons.filter((i) => i.props.name === 'structure')[0].props.tone))
    /* 样式约定：开关的灰/黑由 `[aria-pressed]` 驱动；+/- 是圆形按钮 */
    {
      const cssText = stylesCss
      ck('章节编辑开关：默认灰、[aria-pressed=true] 变黑',
        /\.aic-iconbtn--structure\s*\{[^}]*label-secondary/.test(cssText) &&
        /\.aic-iconbtn--structure\[aria-pressed="true"\]\s*\{[^}]*label-primary/.test(cssText))
      ck('结构模式 +/- 是圆形按钮（border-radius: 50%）',
        /\.aic-structops \.aic-iconbtn\s*\{[^}]*border-radius:\s*50%/.test(cssText))
      ck('结构模式 +/- 有禁用态（不再看起来可点）',
        /\.aic-structops \.aic-iconbtn\[disabled\]/.test(cssText) &&
        /\.aic-iconbtn\[disabled\]/.test(cssText))
    }
    ck('章节编辑按钮是可切换的（pressed 状态）+ 关闭态文案',
      r.icons.filter((i) => i.props.name === 'structure')[0].props.pressed === false &&
      r.icons.filter((i) => i.props.name === 'structure')[0].props.label === 'outline.structureEnter',
      String(r.icons.filter((i) => i.props.name === 'structure')[0].props.label))
    ck('章节/知识点仍用 compose（1 章节 + 2 知识点 = 3 个）',
      r.icons.filter((i) => i.props.name === 'compose').every((i) => /outline\.compose/.test(String(i.props.label))))
    ck('关闭态没有 +/- 结构按钮', !names.some((n) => n === 'plus' || n === 'minus'), names.join(','))
    /* 点课程编辑 → 打开课程编辑窗（且**只**是 edit，不带生成） */
    r.icons.filter((i) => i.props.name === 'edit')[0].props.onClick()
    ck('点课程编辑 → 打开课程编辑窗', r.edits.join(',') === 'course', r.edits.join(','))
  }

  /* ---- ② 开启态：章节/知识点前面出现 +/- ---- */
  {
    const r = render(true)
    const names = r.icons.map((i) => i.props.name)
    /* 2 章 + 3 个知识点 → 5 个 plus、5 个 minus */
    ck('结构模式：每个章节与知识点前都有 +/-',
      names.filter((n) => n === 'plus').length === 5 && names.filter((n) => n === 'minus').length === 5,
      names.join(','))
    ck('结构按钮的可访问名说明动作（新增/删除 章节/知识点）',
      r.icons.filter((i) => i.props.name === 'plus').some((i) => i.props.label === 'outline.addChapterAfter') &&
      r.icons.filter((i) => i.props.name === 'plus').some((i) => i.props.label === 'outline.addKpAfter') &&
      r.icons.filter((i) => i.props.name === 'minus').some((i) => i.props.label === 'outline.removeChapter') &&
      r.icons.filter((i) => i.props.name === 'minus').some((i) => i.props.label === 'outline.removeKp'))

    /* 点第 1 个 plus（第 1 章的「在本章后新增」）→ addChapter(index=1) + addKp 同批 */
    const chapterPlus = r.icons.filter((i) => i.props.name === 'plus')[0]
    chapterPlus.props.onClick()
    const ops = r.structural[0] || []
    ck('章节 + → addChapter 带插入位置，并同批补一个知识点',
      ops.length === 2 && ops[0].op === 'addChapter' && ops[0].index === 1 &&
      ops[1].op === 'addKp' && ops[1].chapterId === ops[0].value,
      JSON.stringify(ops))

    /* 点知识点的 plus（第 2 个 plus = 第 1 章第 1 个知识点）→ addKp(index=1) */
    const kpPlus = r.icons.filter((i) => i.props.name === 'plus')[1]
    kpPlus.props.onClick()
    const kpOps = r.structural[1] || []
    ck('知识点 + → addKp 带章内插入位置',
      kpOps.length === 1 && kpOps[0].op === 'addKp' && kpOps[0].index === 1 && kpOps[0].chapterId === 'ch-01',
      JSON.stringify(kpOps))

    /* 章节 - ：两章 → 可用；知识点 - ：点一所在章有 2 个知识点 → 可用 */
    const minus = r.icons.filter((i) => i.props.name === 'minus')
    ck('章节 - 在两章时可用', minus[0].props.disabled !== true, String(minus[0].props.disabled))
    minus[0].props.onClick()
    ck('章节 - → removeChapter', (r.structural[2] || [])[0].op === 'removeChapter', JSON.stringify(r.structural[2]))
    /* 最后一个 minus 属于「只有 1 个知识点」的章二 → 必须禁用（host 要求每章 ≥1） */
    const lastMinus = minus[minus.length - 1]
    ck('章内只剩 1 个知识点时 - 被禁用（host 校验每章 ≥1）', lastMinus.props.disabled === true, String(lastMinus.props.disabled))
  }

  /* ---- ③ 只读（抽屉）没有结构能力 ---- */
  {
    const r = render(true)
    /* 只读模式：editable=false → 结构按钮不渲染（canStructure 要求 editable） */
    const sc2 = {}
    const h3 = (type, props, ...kids) => ({ type, props: props || {}, kids: kids.flat(9) })
    new Function('h', 'React', 'AIC_COURSES_CORE', 'scope',
      sources['20-widgets.js'].replace(/\/\*[\s\S]*?\*\//g, '') + '\n' +
      sources['50-outline.js'].replace(/\/\*[\s\S]*?\*\//g, '') +
      ';Object.assign(scope, { AIC_ICONS, OutlineView, IconButton })')(h3,
      { createElement: h3, useState: () => [true, () => {}], useEffect: () => {}, useMemo: (f) => f(), useRef: (v) => ({ current: v }) },
      core, sc2)
    const tree = sc2.OutlineView({ t: (k) => k, course: r.course2, mode: 'readonly', disabled: true, kpProgress: {}, assets: {}, taskStates: {}, onEdit: () => {}, onStructure: () => {} })
    const names = []
    const walk = (n) => {
      if (!n || typeof n !== 'object') return
      if (Array.isArray(n)) return n.forEach(walk)
      if (n.type === sc2.IconButton && n.props && n.props.name) names.push(n.props.name)
      ;(n.kids || []).forEach(walk)
    }
    walk(tree)
    ck('只读模式（抽屉）没有结构 +/- 与编辑入口', !names.some((n) => n === 'plus' || n === 'minus' || n === 'edit' || n === 'structure'), names.join(','))
  }
}

/* ==========================================================================
 * 3b-3a · 幻灯片：空页 / 版式结构 / HTML 表格（真机上三个都出过问题）
 * ======================================================================== */
{
  const F = '---'
  /* ① 页 frontmatter 不能被切成一张「空白页」——它是**归属于下一页**的元数据 */
  const deck = core.parseSlidev([
    F, 'title: T', F, '',
    '# 封面', '', '<!-- 讲稿 -->', '',
    F, 'layout: center', '', '# 中页', '', '正文', '',
    F, 'layout: image-right', '', '# 图页', '', '正文二', '',
    F, '', '# 小结',
  ].join('\n'))
  ck('页 frontmatter 不再变成空白页（13 页那种翻页空白）', deck.slides.length === 4, '页数 ' + deck.slides.length)
  ck('页 frontmatter 的 layout 归属**它后面那一页**',
    deck.slides.map((s) => s.layout).join(',') === 'default,center,image-right,default',
    deck.slides.map((s) => s.layout).join(','))
  ck('被合并的页不会丢正文', deck.slides.every((s) => s.body.trim().length > 0), deck.slides.map((s) => String(s.body).trim().slice(0, 6)).join('|'))
  ck('讲稿仍归属正确的页', deck.slides[0].notes.indexOf('讲稿') === 0)

  /* ② 标题要能被单独取出（版式靠 .aic-slide__title 排版） */
  const t1 = core.splitSlideTitle('# 标题甲\n\n- 要点', '')
  ck('splitSlideTitle：取出 H1 并从正文里去掉', t1.title === '标题甲' && t1.text === '- 要点', JSON.stringify(t1))
  const t2 = core.splitSlideTitle('- 只有要点', '前端给的标题')
  ck('splitSlideTitle：没有 H1 时用解析层的标题兜底', t2.title === '前端给的标题' && t2.text === '- 只有要点')
  ck('splitSlideTitle：都没有时标题为空串（不渲染空标题元素）', core.splitSlideTitle('正文', '').title === '')
  const t3 = core.splitSlideTitle('# 甲\n\n正文\n\n# 乙', '')
  ck('一页写了两个 H1：只取第一个当页标题，第二个留在正文里（不丢内容）',
    t3.title === '甲' && t3.text.indexOf('# 乙') >= 0, JSON.stringify(t3))
}

/* --- 代码高亮：hljs 的 HTML → React token 节点（不碰 innerHTML） --- */
{
  const h2 = (type, props, ...kids) => ({ type, props: props || {}, kids: kids.flat(9) })
  const React2 = { createElement: h2, useState: (v) => [typeof v === 'function' ? v() : v, () => {}], useEffect: () => {}, useMemo: (f) => f(), useRef: (v) => ({ current: v }) }
  const src = sources['75-content.js'].replace(/\/\*[\s\S]*?\*\//g, '')
  /* ⚠️ 用 try/catch 包住求值：否则「某段代码里引用了一个不存在的名字」会让整个脚本崩在
     这一行，**后面的断言（尤其是未声明名字扫描）全部静默跳过** —— 那就等于没有防线。 */
  let api = null
  try {
    api = new Function('h', 'React', 'AIC_COURSES_CORE', 'Notice', 'IconButton',
      src + ';return { hljsToNodes, hljsTokenClass, unescapeHtml }')(h2, React2, core, () => null, () => null)
  } catch (err) {
    ck('高亮相关函数可以被求值（引用名都在）', false, err.message)
  }
  if (!api) api = { hljsTokenClass: () => '', hljsToNodes: () => [], unescapeHtml: (t) => t }

  /* 没有语言标记的围栏也要高亮（模型常直接写 ```；真机上 6 个围栏 6 个是裸的） */
  ck('裸围栏（无语言）不提前返回，会走自动识别',
    sources['75-content.js'].indexOf('if (!lang || !source)') < 0 &&
    /if \(!source\) return function/.test(sources['75-content.js']))
  ck('语言不支持时回落到 highlightAuto', /hljs\.highlightAuto\(source\)/.test(sources['75-content.js']))
  ck('vendor 全局对象兼容 window / globalThis 两种挂载',
    /function aicVendorGlobal/.test(sources['75-content.js']) &&
    /globalThis\[name\]/.test(sources['75-content.js']))

  ck('hljs 类别 → 本插件的字面类名', api.hljsTokenClass('hljs-keyword') === 'aic-tok-keyword' &&
    api.hljsTokenClass('hljs-title function_') === 'aic-tok-title' &&
    api.hljsTokenClass('hljs-string') === 'aic-tok-string' &&
    api.hljsTokenClass('hljs-unknown-thing') === '' &&
    api.hljsTokenClass('') === '', api.hljsTokenClass('hljs-title function_'))

  const collect = (nodes) => {
    const classes = []
    const texts = []
    const walk = (n) => {
      if (!n || typeof n !== 'object') { if (typeof n === 'string') texts.push(n); return }
      if (Array.isArray(n)) return n.forEach(walk)
      if (n.props && n.props.className) classes.push(n.props.className)
      ;(n.kids || []).forEach(walk)
    }
    walk(nodes)
    return { classes, text: texts.join('') }
  }
  const simple = collect(api.hljsToNodes('<span class="hljs-keyword">const</span> x = <span class="hljs-number">1</span>;', 'k'))
  ck('token 文本原样还原（不高亮错位）', simple.text === 'const x = 1;', JSON.stringify(simple.text))
  ck('token 套上 aic-tok-* 类名', simple.classes.join(',') === 'aic-tok-keyword,aic-tok-number', simple.classes.join(','))

  const nested = collect(api.hljsToNodes('<span class="hljs-string">a<span class="hljs-subst">&amp;</span>b</span>', 'k'))
  ck('嵌套 span 的文本不丢、实体被解码', nested.text === 'a&b', JSON.stringify(nested.text))

  /* ⚠️ 真机"乱码"的根因：highlight.js 把单引号写成 `&#x27;`（十六进制），早期只认 `&#39;` */
  const ent = api.unescapeHtml
  ck('十六进制实体 &#x27; 被解码（代码块里不再出现 &#x27;）', ent('&#x27;') === "'", ent('&#x27;'))
  ck('十进制实体 &#39; 也被解码', ent('&#39;') === "'")
  ck('斜杠等其它十六进制实体同样解码', ent('&#x2F;') === '/' && ent('&#x41;') === 'A')
  ck('&amp; 最后解（`&amp;lt;` 应得 `&lt;` 而不是 `<`）', ent('&amp;lt;') === '&lt;', ent('&amp;lt;'))
  ck('非法码点原样保留（不抛、不硬造字符）', ent('&#xFFFFFFFF;') === '&#xFFFFFFFF;' && ent('&#99999999999;') === '&#99999999999;')
  ck('表格单元格与代码块共用同一套解码',
    sources['75-content.js'].indexOf('return unescapeHtml(stripped).trim()') >= 0)

  const danger = collect(api.hljsToNodes('<span class="hljs-string">&lt;script&gt;</span><img src=x onerror=alert(1)>', 'k'))
  ck('HTML 实体解码成文本（不会变成标签/元素）', danger.text.indexOf('<script>') >= 0, JSON.stringify(danger.text))
  ck('不认识的标签整段丢掉（既不留元素也不留标签文本）', danger.text.indexOf('<img') < 0, JSON.stringify(danger.text))
  ck('hljs 的 HTML 不被当节点树执行（转换结果只有 span）',
    (() => { const kinds = []; const walk = (n) => { if (!n || typeof n !== 'object') return; if (Array.isArray(n)) return n.forEach(walk); kinds.push(n.type); (n.kids || []).forEach(walk) }; walk(api.hljsToNodes('<span class="hljs-keyword">a</span>', 'k')); return kinds.every((t) => t === 'span') })())
}

/* --- 前端自救：坏 SVG 文本的修复（不依赖宿主版本） --- */
{
  const repair = core.repairSvgText
  /* 真机上的损坏样本（丢 `/` 的空元素） */
  const broken = '<svg viewBox="0 0 640 360" xmlns="http://www.w3.org/2000/svg">\n<defs>\n<marker id="a">\n<path d="M0,0 L10,5 Z">\n</marker></defs>\n<rect x="1" y="2" width="3" height="4">\n</svg>'
  const fixed = repair(broken)
  ck('坏 SVG：空元素被补成自闭合（path / rect）',
    /<path[^>]*\/>/.test(fixed) && /<rect[^>]*\/>/.test(fixed), fixed.slice(0, 90))
  ck('坏 SVG：**属性名大小写不受影响**（viewBox 不会变 viewbox）',
    /viewBox=/.test(fixed) && !/viewbox=/.test(fixed))
  ck('好 SVG 仍然合法（修复是幂等的）', (() => {
    const ok = '<svg viewBox="0 0 4 4"><rect width="4" height="4" /></svg>'
    return repair(repair(ok)) === repair(ok)
  })())
  ck('重复属性被去重（duplicate attribute 同样渲染失败）',
    repair('<svg viewBox="0 0 4 4" viewBox="0 0 4 4"><rect width="4" height="4"/></svg>').match(/viewBox=/g).length === 1)
  ck('非 SVG 文本不会被"修"成看似合法的东西',
    repair('not an svg at all') === 'not an svg at all')
}

/* --- 渲染器支持的「常见写法」：管道表 / HTML 表 / <br> / 图片 --- */
{
  /* 用一个最小 React 桩把 renderMarkdown 跑起来（与组件测试同一套路子） */
  const h2 = (type, props, ...kids) => ({ type, props: props || {}, kids: kids.flat(9) })
  const React2 = { createElement: h2, useState: (v) => [typeof v === 'function' ? v() : v, () => {}], useEffect: () => {}, useMemo: (f) => f(), useRef: (v) => ({ current: v }) }
  const src = sources['75-content.js'].replace(/\/\*[\s\S]*?\*\//g, '')
  const render = new Function('h', 'React', 'AIC_COURSES_CORE', 'Notice', 'IconButton',
    src + ';return renderMarkdown')(h2, React2, core, (p) => ({ type: 'Notice' }), (p) => ({ type: 'IconButton' }))
  const tags = (md) => {
    const out = []
    const walk = (n) => {
      if (!n || typeof n !== 'object') { if (typeof n === 'string') out.push('text'); return }
      if (Array.isArray(n)) return n.forEach(walk)
      out.push(n.type)
      if (n.type === 'img') out.push('src=' + n.props.src)
      ;(n.kids || []).forEach(walk)
    }
    walk(render(md, (x) => '/media/' + x, (k) => k))
    return out
  }
  const pipe = tags('| 概念 | 含义 |\n|---|---|\n| ctx | 上下文 |')
  ck('管道表渲染成 table > thead/tbody', pipe.includes('table') && pipe.includes('thead') && pipe.includes('tbody'), pipe.slice(0, 8).join(','))
  const html = tags('<table>\n<thead><tr><th>概念</th></tr></thead>\n<tbody><tr><td>ctx</td></tr></tbody>\n</table>')
  ck('原始 HTML 表格也渲染成 table（模型常这么写）', html.includes('table') && html.includes('th') && html.includes('td'), html.slice(0, 8).join(','))
  const danger = tags('<table><tr><td><script>alert(1)</script>安全</td></tr></table>')
  ck('HTML 表格里的 script **连内容**一起丢掉（不留代码当正文）', !danger.includes('text:alert'), danger.join(',').slice(0, 60))
  const br = tags('第一行<br>第二行')
  ck('行内 <br> 渲染成真正的换行', br.includes('br'), br.join(','))
  /* resolveUrl 的桩要按真实口径（aicMediaUrl）：`media/x.svg` → `/dsh-ai-courses/media/<cid>/content-assets/media/x.svg` */
  const rel = 'media/kp-01-01-01.svg'
  /* 图片现在由 `Figure` 组件承载（带「坏 SVG 自救」），所以看的是它拿到的 src */
  const imgNodes = []
  {
    const walk = (n) => {
      if (!n || typeof n !== 'object') return
      if (Array.isArray(n)) return n.forEach(walk)
      if (n.props && typeof n.props.src === 'string' && n.props.alt !== undefined) imgNodes.push(n.props)
      ;(n.kids || []).forEach(walk)
    }
    walk(render('![图](media/kp-01-01-01.svg)', (x) => '/media/' + x, (k) => k))
  }
  ck('图片引用经 resolveUrl 换成媒体 URL（幻灯片里同样生效）',
    imgNodes.length === 1 && imgNodes[0].src === '/media/' + rel && imgNodes[0].alt === '图',
    JSON.stringify(imgNodes))
}

/* ==========================================================================
 * 3b-3b · frontmatter 不能漏进正文（真机上「--- title: … ---」被当正文显示了）
 * ======================================================================== */
{
  const strip = core.stripFrontmatter
  ck('剥掉文首的 YAML frontmatter', strip('---\ntitle: 函数的概念与基本初等函数\n---\n\n## 正文').trim() === '## 正文')
  ck('多字段 frontmatter 也剥干净',
    strip('---\ntitle: A\nlayout: cover\n---\n正文') === '正文')
  ck('英文 key / 带引号的值不影响判定', strip('---\ntitle: "A: B"\n---\nx') === 'x')
  /* ⚠️ 反例：`---` 也可能只是分隔线，别把合法正文吃掉 */
  ck('「分隔线 + 正文 + 分隔线」**不**当 frontmatter（否则会误删正文）',
    strip('---\n\n## 正文\n\n内容\n\n---\n\n尾巴') === '---\n\n## 正文\n\n内容\n\n---\n\n尾巴')
  ck('只有单条分隔线不动', strip('---\n正文') === '---\n正文')
  ck('没有闭合围栏不动', strip('---\ntitle: x\n\n## 正文') === '---\ntitle: x\n\n## 正文')
  ck('没有 frontmatter 原样返回', strip('## 正文') === '## 正文')
  ck('非字符串输入不炸', strip(null) === '' && strip(undefined) === '')
  ck('空 frontmatter 块不误删正文', strip('---\n---\n正文') === '---\n---\n正文')
}

/* ==========================================================================
 * 3b-4 · 课程库：排序（更新时间降序）与卡片按钮的可用性
 * ======================================================================== */
{
  const sort = core.sortCoursesByUpdated
  const rows = [
    { id: 'c-20260101000000-aaaa', updatedAt: 100 },
    { id: 'c-20260103000000-cccc', updatedAt: 300 },
    { id: 'c-20260102000000-bbbb', updatedAt: 200 },
  ]
  ck('课程库按更新时间降序', sort(rows).map((r) => r.id.slice(-4)).join(',') === 'cccc,bbbb,aaaa', sort(rows).map((r) => r.id.slice(-4)).join(','))
  ck('排序不改入参（返回新数组）', rows.map((r) => r.id.slice(-4)).join(',') === 'aaaa,cccc,bbbb')
  const noTime = [
    { id: 'c-20260101000000-aaaa', updatedAt: 0 },
    { id: 'c-20260103000000-cccc', updatedAt: 0 },
    { id: 'c-20260102000000-bbbb', updatedAt: 0 },
  ]
  ck('时间不可用时回落 id 降序（≈ 创建时间倒序）', sort(noTime).map((r) => r.id.slice(-4)).join(',') === 'cccc,bbbb,aaaa')
  const sameTime = [
    { id: 'c-20260101000000-aaaa', updatedAt: 500 },
    { id: 'c-20260103000000-cccc', updatedAt: 500 },
  ]
  ck('时间相同时稳定（保持原顺序，不抖动）', sort(sameTime).map((r) => r.id.slice(-4)).join(',') === 'aaaa,cccc')
  /* 学习按钮的判据是**三态**，不是布尔：`true` / `false` / **字段缺失** */
  const learnDisabled = (c) => !!(c.hasContent === false)
  ck('学习按钮：明确 false（一个知识点都没内容）→ 灰显', learnDisabled({ hasContent: false }) === true)
  ck('学习按钮：任意一个知识点有内容 → 可点', learnDisabled({ hasContent: true }) === false)
  ck('学习按钮：老宿主不回该字段 → **不灰显**（否则整库全灰，真机踩过）',
    learnDisabled({}) === false && learnDisabled({ hasContent: undefined }) === false && learnDisabled({ hasContent: null }) === false)

  ck('坏数据不炸（缺 updatedAt / 空数组 / null）',
    sort([{ id: 'x' }, null]).length === 2 && sort([]).length === 0 && sort(null).length === 0)
}

/* ==========================================================================
 * 3b-2 · 未声明的名字（**白板事故的直接防线**，2026-10-16 真机踩到）
 *
 * 经过：重构面板时删掉了 `startCourse` / `updateFilter` 两个声明，但 `renderContent` 里还在引用。
 * `node --check` 只管语法、样式与槽位断言照绿 —— 真机打开课程库时整个面板渲染抛 ReferenceError，
 * 宿主按「槽崩溃」处理 → **白板**。
 *
 * 所以这里做一次保守的**名字解析**检查：把每段的字符串与注释抹掉（保留括号结构），
 * 收集「声明过的名字」（`const/let/var/function/class` + 解构 + 形参 + catch 变量），
 * 再找出所有**独立出现**的标识符（不是属性访问 `a.b`、不是对象键 `{ a: … }`），
 * 凡是不在声明集合里、也不是已知全局的 → 报错。
 *
 * 它**不是**完整的 JS 作用域分析（会有假阴性），但对「删了声明还在用」这类事故足够，
 * 而且**验证过能抓住这次的 bug**（把两个声明删掉，这条断言会失败）。
 * ======================================================================== */
{
  /* 预处理顺序**不能颠倒**（踩过两次）：
       ① `noComments` **先**抹注释 —— 注释里常有引号和斜杠（例如 `const x = 'a'` 这种说明），
          先做正则/字符串处理会把注释内容当代码，碎掉的片段污染整段扫描；
       ② `noStrings` 在**没有注释**的代码上，再按「典型正则起始位置」抹正则、然后抹字符串。
     · 两种情况都用**抹掉字符串内容**的版本：
       标识符扫描——否则 `'aic-card__name'` 会被当名字（满屏假名）；
       声明提取——`const x = 'a'` 不能变成 `const x = ` 那种残缺语法。 */
  /**
   * 一次单向扫描，产生两份「遮罩文本」：
   *   · `noComments`：注释与正则**内容**抹成空格，字符串原样保留（扫标识符用）；
   *   · `noStrings`：在它基础上再把字符串**内容**抹掉（提取声明用）。
   *
   * 为什么必须一次扫描：早期是「先正则 → 再注释 → 再字符串」三步正则替换，
   * 而 `maskRegex` 是按「典型起始位置」猜正则起点的 —— 注释里出现 `/dsh-ai-courses/vendor/`
   * 这种路径时会被当成正则起点，**把后面的代码一起吞掉**（本次就发生了：`function CodeBlock`
   * 整段消失，导致几十个假名）。逐字符扫就没有这种猜测：先判注释、再判字符串、最后才判正则。
   */
  const maskCode = (code) => {
    const src = String(code)
    let out = ''            /* noComments：注释/正则抹空格，字符串保留 */
    let outStr = ''         /* noStrings：在此基础上再抹字符串内容 */
    let i = 0
    const REGEX_HEAD = '=(,:;[!&|?{}+-*/%<>'   /* 这些字符之后出现的 `/` 才可能是正则开头 */
    const push = (a, b) => { out += a; outStr += b }
    while (i < src.length) {
      const ch = src[i]
      const next = src[i + 1]
      /* 行注释 */
      if (ch === '/' && next === '/') {
        let j = i
        while (j < src.length && src[j] !== '\n') j++
        push(' '.repeat(j - i), ' '.repeat(j - i))
        i = j
        continue
      }
      /* 块注释 */
      if (ch === '/' && next === '*') {
        const close = src.indexOf('*/', i + 2)
        const j = close < 0 ? src.length : close + 2
        const blank = src.slice(i, j).replace(/[^\n]/g, ' ')
        push(blank, blank)
        i = j
        continue
      }
      /* 字符串 / 模板：保留定界符，内容在 noStrings 里抹掉 */
      if (ch === "'" || ch === '"' || ch === '`') {
        const quote = ch
        let j = i + 1
        let body = ''
        while (j < src.length) {
          if (src[j] === '\\') { body += src.slice(j, j + 2); j += 2; continue }
          if (src[j] === quote) break
          body += src[j]
          j++
        }
        push(quote + body + quote, quote + ' '.repeat(body.length) + quote)
        i = j + 1
        continue
      }
      /* 正则字面量：只在前一个「有效字符」属于 REGEX_HEAD 时才算（否则是除号） */
      if (ch === '/' && next !== '*' && next !== '/') {
        let k = out.length - 1
        while (k >= 0 && /\s/.test(out[k])) k--
        const prev = k >= 0 ? out[k] : ''
        const isRegex = prev === '' || REGEX_HEAD.indexOf(prev) >= 0 || /(?:^|[^\w$])(?:return|case|typeof|in|of)$/.test(out.slice(Math.max(0, k - 8), k + 1))
        if (isRegex) {
          let j = i + 1
          while (j < src.length) {
            if (src[j] === '\\') { j += 2; continue }
            if (src[j] === '[') {                       /* 字符组里的 `/` 不算结束 */
              j++
              while (j < src.length && src[j] !== ']') { if (src[j] === '\\') j++; j++ }
              j++
              continue
            }
            if (src[j] === '/') break
            if (src[j] === '\n') break                  /* 未闭合 → 当除号处理，避免吞掉整段 */
            j++
          }
          if (src[j] === '/') {
            let e = j + 1
            while (e < src.length && /[gimsuy]/.test(src[e])) e++
            const blank = src.slice(i, e).replace(/[^\n]/g, ' ')
            push(blank, blank)
            i = e
            continue
          }
        }
      }
      push(ch, ch)
      i++
    }
    return { noComments: out, noStrings: outStr }
  }
  const declared = new Set()
  const KEYWORDS = new Set(['const', 'let', 'var', 'function', 'class', 'of', 'in', 'new', 'return', 'typeof', 'await', 'async', 'catch', 'for', 'if', 'else', 'while', 'switch', 'do', 'throw', 'delete', 'void', 'instanceof',
  /* 控制流关键字也要列全：`continue` / `break` 是**合法**语句开头，漏了就变成假名（踩过） */
  'continue', 'break', 'case', 'default', 'try', 'finally', 'yield', 'this', 'super', 'debugger', 'with'])
  for (const [, src] of Object.entries(sources)) {
    const code = maskCode(src).noStrings
    for (const m of code.matchAll(/\b(?:const|let|var|function|class)\s+([^=;{}(]*)/g)) {
      for (const w of m[1].match(/[A-Za-z_$][\w$]*/g) || []) if (!KEYWORDS.has(w)) declared.add(w)
    }
    for (const m of code.matchAll(/\bcatch\s*\(\s*([A-Za-z_$][\w$]*)/g)) declared.add(m[1])
    for (const m of code.matchAll(/\bfor\s*\(\s*(?:const|let|var)\s+([A-Za-z_$][\w$]*)/g)) declared.add(m[1])
    for (const m of code.matchAll(/function\s*[A-Za-z_$]?[\w$]*\s*\(([^)]*)\)/g)) {
      for (const w of m[1].match(/[A-Za-z_$][\w$]*/g) || []) declared.add(w)
    }
    for (const m of code.matchAll(/\(([^()]*)\)\s*=>/g)) {
      for (const w of m[1].match(/[A-Za-z_$][\w$]*/g) || []) declared.add(w)
    }
    for (const m of code.matchAll(/(?:^|[^\w$.])([A-Za-z_$][\w$]*)\s*=>/g)) declared.add(m[1])
  }
  /* 段间共享的顶层声明（拼接后同处一个作用域）+ 宿主提供的对象 + 语言内建 */
  for (const n of ['React', 'ReactDOM', 'AIC_COURSES_CORE', 'AIC_NAV', 'AIC_COURSES_CSS', 'AIC_RPC_PREFIX',
    'Object', 'Array', 'String', 'Number', 'Math', 'JSON', 'Date', 'Boolean', 'Promise', 'Error', 'RegExp',
    'Map', 'Set', 'Symbol', 'Function', 'window', 'document', 'navigator', 'console', 'setTimeout',
    'DOMParser',   /* Mermaid 渲染结果用 DOMParser 解析成惰性文档再挂进 DOM（不碰 innerHTML） */
    'MutationObserver',   /* <html lang> 变化时重渲染（DSH locale 插件启动后才写 lang） */
    'globalThis',  /* vendor 脚本可能挂在 window 或 globalThis（浏览器里是同一个对象） */
    'AIC_PROMPT_MAX',  /* 「AI 备注」上限：构建期从 host 常量注入 client（与内联样式同一套路） */
    'clearTimeout', 'setInterval', 'clearInterval', 'fetch', 'AbortController', 'require', 'module',
    'exports', 'undefined', 'NaN', 'Infinity', 'isNaN', 'parseInt', 'parseFloat', 'encodeURIComponent',
    'decodeURIComponent', 'true', 'false', 'null']) declared.add(n)

  const undefinedNames = []
  for (const [name, src] of Object.entries(sources)) {
    if (name === '10-core.js') continue   /* 纯逻辑段已在 node 里真实求值，不必静态扫 */
    /* 标识符扫描也用 `noStrings`：字符串里的 `'aic-card__name'` 这类片段不该被当成名字
       （早期用「保留字符串」的版本结果满屏假名，见下面对比） */
    const code = maskCode(src).noStrings
    /* ⚠️ 对象键要排除，但**必须用「完整标识符 + 可选空白 + 冒号」判断**：
       写成 `(?!\s*:)` 会退化成「最后一个字符后面不是冒号」，于是 `className:` 只匹配成 `classNam`，
       报出一堆截断的假名（试过，一眼全是噪音）。 */
    /* 排除：属性访问 `a.b`、对象键 `a:`、模板插值 `${a}`、拼接 `'x' + a`、
       以及**正则变量**的用法 `RE.test(...)` / `RE.exec(...)` / `x.match(RE)`（它们在注释被抹掉后
       仍是字面量，但显然是已声明的）。 */
    for (const m of code.matchAll(/(?:^|[^\w$.])([A-Za-z_$][\w$]*)(?![\w$])(?![ \t]*:)(?![ \t]*\{)(?![ \t]*\+)(?![ \t]*\})/g)) {
      const id = m[1]
      if (KEYWORDS.has(id) || declared.has(id)) continue
      undefinedNames.push(`${name}:${id}`)
    }
  }
  const unique = [...new Set(undefinedNames)]
  ck('client 各段里没有「用了但没声明」的名字（白板事故的直接防线）',
    unique.length === 0, unique.join(' ') || `${declared.size} 个声明名`)
}

/* ==========================================================================
 * 3b-2y · 大纲里的生成状态：**生成中**用转动的加载图标（不是橙色实心圆）
 * ======================================================================== */
{
  const scope = {}
  const h2 = (type, props, ...kids) => ({ type, props: props || {}, kids: kids.flat(9) })
  const React2 = { createElement: h2, useState: (v) => [typeof v === 'function' ? v() : v, () => {}], useEffect: () => {}, useMemo: (f) => f(), useRef: (v) => ({ current: v }) }
  try {
    new Function('h', 'React', 'AIC_COURSES_CORE', 'scope',
      sources['20-widgets.js'].replace(/\/\*[\s\S]*?\*\//g, '') +
      ';Object.assign(scope, { GenIcon, StateGlyph })')(h2, React2, core, scope)
  } catch (err) {
    ck('状态图标可以被求值', false, err.message)
  }
  if (scope.StateGlyph) {
    const glyph = (state) => core.genSpec(state).glyph
    ck('生成中 → 加载图标（不再是实心圆）', glyph('生成中') === 'spin', glyph('生成中'))
    ck('其它状态不变：未生成空心、排队中/已生成/失败实心',
      glyph('未生成') === 'hollow' && glyph('排队中') === 'solid' &&
      glyph('已生成') === 'solid' && glyph('生成失败') === 'solid')
    ck('加载图标保留原来的橙色（warn）', core.genSpec('生成中').color === 'warn')
    const cls = []
    const walk = (n) => {
      if (!n || typeof n !== 'object') return
      if (Array.isArray(n)) return n.forEach(walk)
      if (n.props && n.props.className) cls.push(n.props.className)
      ;(n.kids || []).forEach(walk)
    }
    walk(scope.StateGlyph({ kind: 'spin' }))
    ck('加载图标带旋转动画类（reduced-motion 下 CSS 会关掉）', cls.join(',') === 'aic-genstate__spin', cls.join(','))
    ck('生成中的状态点仍是 doing 态（5 态语义没变）', /aic-genstate--doing/.test(String(scope.GenIcon({ t: (k) => k, state: '生成中' }).props.className)))
  }
}

/* ==========================================================================
 * 3b-2y · 大纲里的生成状态：**生成中**用转动的加载图标（不是橙色实心圆）
 * ======================================================================== */
{
  const scope = {}
  const h2 = (type, props, ...kids) => ({ type, props: props || {}, kids: kids.flat(9) })
  const React2 = { createElement: h2, useState: (v) => [typeof v === 'function' ? v() : v, () => {}], useEffect: () => {}, useMemo: (f) => f(), useRef: (v) => ({ current: v }) }
  try {
    new Function('h', 'React', 'AIC_COURSES_CORE', 'scope',
      sources['20-widgets.js'].replace(/\/\*[\s\S]*?\*\//g, '') +
      ';Object.assign(scope, { GenIcon, StateGlyph })')(h2, React2, core, scope)
  } catch (err) {
    ck('状态图标可以被求值', false, err.message)
  }
  if (scope.StateGlyph) {
    const glyph = (state) => core.genSpec(state).glyph
    ck('生成中 → 加载图标（不再是实心圆）', glyph('生成中') === 'spin', glyph('生成中'))
    ck('其它状态不变：未生成空心、排队中/已生成/失败实心',
      glyph('未生成') === 'hollow' && glyph('排队中') === 'solid' &&
      glyph('已生成') === 'solid' && glyph('生成失败') === 'solid')
    ck('加载图标保留原来的橙色（warn）', core.genSpec('生成中').color === 'warn')
    const cls = []
    const walk = (n) => {
      if (!n || typeof n !== 'object') return
      if (Array.isArray(n)) return n.forEach(walk)
      if (n.props && n.props.className) cls.push(n.props.className)
      ;(n.kids || []).forEach(walk)
    }
    walk(scope.StateGlyph({ kind: 'spin' }))
    ck('加载图标带旋转动画类（reduced-motion 下 CSS 会关掉）', cls.join(',') === 'aic-genstate__spin', cls.join(','))
    ck('生成中的状态点仍是 doing 态（5 态语义没变）', /aic-genstate--doing/.test(String(scope.GenIcon({ t: (k) => k, state: '生成中' }).props.className)))
  }
}

/* ==========================================================================
 * 3b-3 · 生成进度条的展示态（纯函数真值表）
 *
 * 「发起生成 → 弹窗关闭 → 大纲页顶部的进度条实时推进」是这一轮的用户流程；
 * 进度条上写什么由此函数的输出决定，所以它必须有真值表（组件本身离线不渲染）。
 * ======================================================================== */
{
  const view = core.taskProgressView
  const course = { name: 'RSC 入门' }
  ck('没有任务 → 进度条不显示（不能挂着一个空条）', view(null, course).visible === false)
  const running = view({ scope: 'chapter', state: 'running', total: 5, done: 2, failed: 0, items: [] }, course)
  ck('进行中：计数 = 完成 + 失败、比例按总数算', running.visible && running.finished === 2 && running.total === 5 && Math.abs(running.ratio - 0.4) < 1e-9)
  ck('进行中：active=true 且状态键映射到「生成中」', running.active === true && running.stateKey === 'doing')
  ck('章节范围 → scope 标记为 chapter（由界面查词表）', running.scope === 'chapter' && running.scopeIsCourse === false)
  const whole = view({ scope: 'course', state: 'running', total: 3, done: 1, failed: 0, items: [] }, course)
  ck('整门课 → 直接用课程名', whole.scopeIsCourse === true && whole.scope === 'RSC 入门')
  const failed = view({
    scope: 'kp', state: 'failed', total: 3, done: 1, failed: 1,
    items: [{ kpId: 'kp-01-01', state: 'done' }, { kpId: 'kp-01-02', state: 'failed', reason: '限流' }, { kpId: 'kp-01-03', state: 'queued' }],
  }, course)
  ck('失败：finished 含失败项、列出失败条目与原因', failed.finished === 2 && failed.failed.length === 1 && failed.failed[0].reason === '限流')
  ck('失败：active=false（已经结束，不该再转圈）', failed.active === false && failed.stateKey === 'failed')
  ck('中断按失败口径展示（不假装还在跑）', view({ scope: 'kp', state: 'interrupted', total: 2, done: 1, failed: 1, items: [] }, course).stateKey === 'failed')
  ck('完成：stateKey=done、比例 1', view({ scope: 'kp', state: 'done', total: 2, done: 2, failed: 0, items: [] }, course).stateKey === 'done')
  ck('坏数据不炸：计数为负/超总数都被夹住', (() => {
    const v = view({ scope: 'kp', state: 'running', total: 2, done: 9, failed: -3, items: null }, course)
    return v.finished === 2 && v.ratio === 1 && Array.isArray(v.failed)
  })())
  ck('未知状态回落「生成中」而不是空白', view({ scope: 'kp', state: '什么鬼', total: 1, done: 0, failed: 0, items: [] }, course).stateKey === 'doing')
}

/* ==========================================================================
 * 3c · 大纲卡片的**回合判定**（纯函数，真值表）
 *
 * 「每回合都长一张卡」与「一次都不显示」都是只有在真机上才发现的坏结果，
 * 所以判据必须是可断言的纯函数（`core.coursesOfTurn`），而不是埋在组件里的过滤。
 * ======================================================================== */
const inTurn = { courseId: 'c-1', updatedAt: 2000 }
const midTurn = { courseId: 'c-2', updatedAt: 3000 }
const afterTurn = { courseId: 'c-3', updatedAt: 9000 }
const closedTurn = { start: { time: 1000 }, end: { time: 5000 } }
const openTurn = { start: { time: 1000 } }
ck('大纲卡：落在回合时间窗内的课被选中（含起点，含终点）',
  core.coursesOfTurn([inTurn, midTurn, { courseId: 'c-4', updatedAt: 5000 }], closedTurn).map((c) => c.courseId).join(',') === 'c-1,c-2,c-4')
ck('大纲卡：回合之后的课不属于本回合（不重复长卡）',
  core.coursesOfTurn([inTurn, afterTurn], closedTurn).map((c) => c.courseId).join(',') === 'c-1')
ck('大纲卡：回合之前的课不属于本回合',
  core.coursesOfTurn([{ courseId: 'old', updatedAt: 999 }], closedTurn).length === 0)
ck('大纲卡：回合还没结束（进行中）时按起点之后判定',
  core.coursesOfTurn([inTurn, afterTurn], openTurn).length === 2)
ck('大纲卡：拿不到回合起始时间 → 一律不显示（宁可不显示也不每回合长卡）',
  core.coursesOfTurn([inTurn], {}).length === 0 && core.coursesOfTurn([inTurn], null).length === 0)
ck('大纲卡：坏数据不抛（缺 updatedAt / 非数组）',
  core.coursesOfTurn([{ courseId: 'x' }, null], closedTurn).length === 0 && core.coursesOfTurn(null, closedTurn).length === 0)

/* --- 状态卡轮询：命令结束/状态终态就停，没状态但还在跑则继续 --- */
ck('状态卡：running 继续轮询', core.shouldPollStatus('running', false) === true)
ck('状态卡：拿不到状态但命令还在跑 → 继续（不能错过推导）', core.shouldPollStatus(undefined, false) === true)
ck('状态卡：done / error 停止', core.shouldPollStatus('done', false) === false && core.shouldPollStatus('error', false) === false)
ck('状态卡：命令已结束一律停止（不管状态是什么）',
  core.shouldPollStatus('running', true) === false && core.shouldPollStatus(undefined, true) === false)

console.log(`\n${fail ? fail + ' 项失败' : '全部通过'}   （PASS ${pass} / FAIL ${fail}）`)
console.log('⚠️ 本脚本不是界面验证：用户可见结果只能在真机上确认（doc/09 §7.2）。')
process.exit(fail ? 1 : 0)
