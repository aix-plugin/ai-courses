/* ==================== src/client/75-content.js ====================
 * 内容渲染（06 §5 / §7.1）：`图文`（Markdown 子集）与 `幻灯片`（Slidev 子集播放器）
 *
 * 安全与降级（AC-16 / AC-17）：
 *   · 渲染路径**不用 `innerHTML`**，也不用 `dangerouslySetInnerHTML` —— 全部走 React 元素。
 *   · 正文是不可信输入：HTML 标签一律当**纯文本**显示（不当 HTML 执行）。
 *   · 未知版式 → 按 `default` 渲染并给出提示，**绝不白屏**。
 *   · 图片只认「课程目录内的相对路径」，经 host 的媒体路由取回；外部 URL 不渲染成图。
 * ========================================================================== */

/* ------------------------------------------------------------------ 行内 */

/* 标题标签用**字面量表**而不是 `'h' + level`：本项目禁止动态拼类名/标签，
   静态断言（scripts/check.mjs）才能继续机械地守住这条线。 */
const HEADING_TAGS = { 1: 'h2', 2: 'h2', 3: 'h3', 4: 'h4', 5: 'h5', 6: 'h6' }

/* 版式 → DOM 修饰类：**全部写成完整字面量**（不拼字符串），
   这样 `scripts/check.mjs` 的「每个 aic- 类都有规则」断言还能继续守住。 */
const SLIDE_CLASS = {
  default: 'aic-slide aic-slide--default',
  cover: 'aic-slide aic-slide--cover',
  center: 'aic-slide aic-slide--center',
  'two-cols': 'aic-slide aic-slide--two-cols',
  'two-cols-header': 'aic-slide aic-slide--two-cols-header',
  'image-right': 'aic-slide aic-slide--image-right',
  'image-left': 'aic-slide aic-slide--image-left',
  quote: 'aic-slide aic-slide--quote',
}

const INLINE_RE = /(`[^`]+`)|(\*\*[^*]+\*\*)|(\*[^*\n]+\*)|(!?\[[^\]]*\]\([^)\s]+\))|(<br\s*\/?>)/gi

/** 行内元素 → React 片段（**不经 innerHTML**）。`resolveUrl` 把相对路径换成媒体路由 URL。 */
function inlineNodes (text, keyPrefix, resolveUrl, t) {
  const out = []
  let last = 0
  let i = 0
  const src = String(text ?? '')
  INLINE_RE.lastIndex = 0
  let m
  while ((m = INLINE_RE.exec(src)) !== null) {
    if (m.index > last) out.push(src.slice(last, m.index))
    const token = m[0]
    const key = keyPrefix + '-' + (i++)
    if (token.startsWith('`')) {
      out.push(h('code', { key: key }, token.slice(1, -1)))
    } else if (token.startsWith('**')) {
      out.push(h('strong', { key: key }, token.slice(2, -2)))
    } else if (token.startsWith('*')) {
      out.push(h('em', { key: key }, token.slice(1, -1)))
    } else if (/^<br/i.test(token)) {
      /* 模型常在单元格/段落里写 `<br>` 换行：渲染成真正的换行，而不是字面文本 */
      out.push(h('br', { key: key }))
    } else {
      const isImg = token.startsWith('!')
      const mm = token.match(/^!?\[([^\]]*)\]\(([^)\s]+)\)$/)
      if (!mm) { out.push(token); }
      else {
        const label = mm[1]
        const url = resolveUrl(mm[2])
        if (isImg) {
          out.push(url
            ? h(Figure, { key: key, src: url, alt: label, t: t })
            : h('span', { key: key, className: 'aic-muted' }, label || t('lesson.imageFallback')))
        } else {
          /* 只允许相对/站内链接；外部链接当纯文本（v1 不做外链跳转，避免点了跑掉） */
          out.push(url && url.startsWith('/')
            ? h('a', { key: key, className: 'aic-link', href: url }, label || url)
            : h('span', { key: key, className: 'aic-link' }, label || mm[2]))
        }
      }
    }
    last = m.index + token.length
  }
  if (last < src.length) out.push(src.slice(last))
  return out
}

/* ------------------------------------------------------------------ 块级 */

/** fenced code block 的开头（``` 或 ~~~，可带语言）。 */
const FENCE_RE = /^\s*(`{3,}|~{3,})\s*([\w+-]*)\s*$/

/** 单元格里的 HTML → 纯文本：删标签、`<br>` 变空格、解几个常见实体。 */
function htmlCellText (html) {
  const stripped = String(html ?? '')
    /* script/style **连内容一起**丢掉：只删标签会把里面的代码当正文留在单元格里 */
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, '')
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<[^>]*>/g, '')
  /* 实体解码与代码块**共用一套**（`&#x27;` 这类十六进制实体两处都要认） */
  return unescapeHtml(stripped).trim()
}

/** 解析原始 HTML 表格 → `[{ header, cells }]`（只认 table 相关的几个标签）。 */
function parseHtmlTableRows (html) {
  const src = String(html ?? '')
  const rows = []
  const rowRe = /<tr\b[^>]*>([\s\S]*?)<\/tr\s*>/gi
  let m
  while ((m = rowRe.exec(src)) !== null) {
    const cells = []
    const cellRe = /<(th|td)\b[^>]*>([\s\S]*?)<\/\1\s*>/gi
    let c
    let header = false
    while ((c = cellRe.exec(m[1])) !== null) {
      if (c[1].toLowerCase() === 'th') header = true
      cells.push(htmlCellText(c[2]))
    }
    if (cells.length) rows.push({ header: header, cells: cells })
  }
  return rows
}

/** 统一成和管道表**完全一样**的 table 元素（样式只需一套）。 */
function htmlTableNode (rows, k, resolveUrl, t) {
  const headRow = rows.find((r) => r.header)
  const bodyRows = rows.filter((r) => r !== headRow)
  let cols = 0
  for (const r of rows) cols = Math.max(cols, r.cells.length)
  const pad = (cells) => {
    const out = cells.slice()
    while (out.length < cols) out.push('')
    return out
  }
  return h(
    'table',
    { key: k() },
    headRow
      ? h('thead', null, h('tr', null, pad(headRow.cells).map((c, ci) => h('th', { key: ci }, inlineNodes(c, k(), resolveUrl, t)))))
      : null,
    h('tbody', null, bodyRows.map((r, ri) =>
      h('tr', { key: ri }, pad(r.cells).map((c, ci) => h('td', { key: ci }, inlineNodes(c, k(), resolveUrl, t)))))),
  )
}

function isTableRow (line) { return /^\s*\|.*\|\s*$/.test(line) }
function isTableSep (line) { return /^\s*\|[\s:|-]+\|\s*$/.test(line) && /-/.test(line) }

/**
 * Markdown 子集 → React 元素数组。
 * 支持：`##`/`###` 标题、段落、无序/有序列表、围栏代码块、引用、表格、图片、行内粗体/斜体/代码/链接。
 */
function renderMarkdown (text, resolveUrl, t) {
  /* 学习页渲染的是**文件正文**，而宿主写文件时会加 YAML frontmatter（`title:` 等）——
     不剥就会把那段当「分隔线 + 字面文本」显示出来。剥离规则在 core 里（纯函数、有真值表）。 */
  const clean = AIC_COURSES_CORE.stripFrontmatter(text)
  const lines = String(clean ?? '').replace(/\r\n/g, '\n').split('\n')
  const out = []
  let i = 0
  let key = 0
  const k = () => 'md-' + (key++)

  while (i < lines.length) {
    const line = lines[i]

    /* 空行 */
    if (!line.trim()) { i++; continue }

    /* 围栏代码块 */
    const fence = FENCE_RE.exec(line)
    if (fence) {
      const marker = fence[1][0]
      const lang = fence[2] || ''
      const buf = []
      i++
      while (i < lines.length && !new RegExp('^\\s*' + marker + '{3,}\\s*$').test(lines[i])) { buf.push(lines[i]); i++ }
      i++ /* 吃掉收尾围栏（没有也照样收口，不吞后面的内容） */
      const source = buf.join('\n')
      /* mermaid 走**图表渲染**（按需加载渲染器，失败降级成源码块）；
         其余语言只当**标记类**（CSS 有意不为每种语言定义规则），不拼字符串、用字面量 */
      if (lang.toLowerCase() === 'mermaid') {
        out.push(h(MermaidChart, { key: k(), t: t, source: source }))
      } else {
        /* 代码块**带高亮**（按需加载 highlight.js；拿不到就退回纯文本，不白屏） */
        out.push(h(CodeBlock, { key: k(), lang: lang, source: source }))
      }
      continue
    }

    /* 标题（正文里不应有 h1，但真出现了也照原样降级成 h2，绝不吞掉内容） */
    const heading = /^(#{1,6})\s+(.*)$/.exec(line)
    if (heading) {
      const tag = HEADING_TAGS[Math.min(6, Math.max(1, heading[1].length))] || 'h3'
      out.push(h(tag, { key: k() }, inlineNodes(heading[2], k(), resolveUrl, t)))
      i++
      continue
    }

    /* 原始 HTML 表格：模型经常直接写 `<table><tr><td>…`（管道表之外的另一种常见写法）。
       **不用 innerHTML**：只认 table/thead/tbody/tr/th/td，逐格取出纯文本再走行内解析 ——
       夹带的其他标签只会被当文本剥掉，不会执行。 */
    if (/^\s*<table\b/i.test(line)) {
      const buf = []
      while (i < lines.length) {
        buf.push(lines[i])
        if (/<\/table\s*>/i.test(lines[i])) { i++; break }
        i++
      }
      const rows = parseHtmlTableRows(buf.join('\n'))
      if (rows.length) out.push(htmlTableNode(rows, k, resolveUrl, t))
      continue
    }

    /* 表格（管道表） */
    if (isTableRow(line) && i + 1 < lines.length && isTableSep(lines[i + 1])) {
      const head = line.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim())
      i += 2
      const rows = []
      while (i < lines.length && isTableRow(lines[i])) {
        rows.push(lines[i].trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim()))
        i++
      }
      out.push(h('table', { key: k() },
        h('thead', null, h('tr', null, head.map((c, ci) => h('th', { key: ci }, inlineNodes(c, k(), resolveUrl, t))))),
        h('tbody', null, rows.map((r, ri) => h('tr', { key: ri }, r.map((c, ci) => h('td', { key: ci }, inlineNodes(c, k(), resolveUrl, t))))))))
      continue
    }

    /* 引用 */
    if (/^\s*>\s?/.test(line)) {
      const buf = []
      while (i < lines.length && /^\s*>\s?/.test(lines[i])) { buf.push(lines[i].replace(/^\s*>\s?/, '')); i++ }
      out.push(h('blockquote', { key: k() }, renderMarkdown(buf.join('\n'), resolveUrl, t)))
      continue
    }

    /* 列表（连续同类项合成一个列表） */
    const ul = /^\s*[-*+]\s+(.*)$/.exec(line)
    const ol = /^\s*\d+[.)]\s+(.*)$/.exec(line)
    if (ul || ol) {
      const ordered = !!ol
      const items = []
      while (i < lines.length) {
        const m = ordered ? /^\s*\d+[.)]\s+(.*)$/.exec(lines[i]) : /^\s*[-*+]\s+(.*)$/.exec(lines[i])
        if (!m) break
        items.push(m[1])
        i++
      }
      const Tag = ordered ? 'ol' : 'ul'
      out.push(h(Tag, { key: k() }, items.map((item, ti) => h('li', { key: ti }, inlineNodes(item, k(), resolveUrl, t)))))
      continue
    }

    /* 段落：合并到下一个空行 */
    const buf = [line]
    i++
    while (i < lines.length && lines[i].trim() &&
           !FENCE_RE.test(lines[i]) && !/^(#{1,6})\s+/.test(lines[i]) &&
           !/^\s*>\s?/.test(lines[i]) && !/^\s*[-*+]\s+/.test(lines[i]) &&
           !/^\s*\d+[.)]\s+/.test(lines[i]) && !isTableRow(lines[i])) {
      buf.push(lines[i])
      i++
    }
    out.push(h('p', { key: k() }, inlineNodes(buf.join('\n'), k(), resolveUrl, t)))
  }
  return out
}

/* --------------------------------------------------------------- 图片 */

/**
 * 把要内联进文档的 SVG 再"卸一遍武装"。
 *
 * 为什么不能只删 `<script>`：SVG 里的事件属性（`onload` / `onerror`）、`href` /
 * `xlink:href`（`javascript:` 或外部图片）、`foreignObject`、`<image>`、`<use>`、
 * `<style>`（`@import` / `url()`）都能在元素被 `importNode` 进文档后产生副作用。
 * host 的 media 路由已经挡了一层；这里是**客户端兜底**（历史文件、进程未重启、
 * 用户手工放进课程库的文件都可能绕过 host 的清洗）。
 *
 * 只用于「图片 onError 后的自救内联」；Mermaid 的 SVG 有自己的 strict 输出与样式，
 * 不走这个函数（删掉它的 `<style>` 会让图表失去配色）。
 */
function hardenInlineSvg (root) {
  if (!root || !root.querySelectorAll) return root
  const nodes = [root].concat(Array.from(root.querySelectorAll('*')))
  for (const el of nodes) {
    const attrs = el.attributes ? Array.from(el.attributes) : []
    for (const attr of attrs) {
      const name = String(attr.name || '').toLowerCase()
      const value = String(attr.value || '')
      const isEvent = name.startsWith('on')
      const isLink = name === 'href' || name === 'xlink:href' || name === 'src'
      const isBadStyle = name === 'style' && /url\s*\(|expression|javascript:/i.test(value)
      if (isEvent || isLink || isBadStyle) el.removeAttribute(attr.name)
    }
  }
  const bad = root.querySelectorAll('script,foreignObject,iframe,image,use,style')
  for (const el of bad) if (el.parentNode) el.parentNode.removeChild(el)
  return root
}

/**
 * 一张图片。
 *
 * 为什么要包一层：课程库里的 SVG 可能**不是合法 XML**（早期清洗器的 bug），而浏览器用
 * `<img src="*.svg">` 载入时按**严格 XML** 解析 → 图静默不显示，页面上只有一块空白。
 * 这里在 `onError` 时**自己去取文本、修一次、改成内联 SVG**，于是：
 *   · 宿主已经修好的文件 → 走正常 `<img>`（有缓存、有懒加载）；
 *   · 宿主的修复还没生效（进程是旧的）→ 前端自救，图照样显示。
 * 都失败才露出 alt 文本，不白屏。
 */
function Figure (props) {
  const t = props.t
  const [mode, setMode] = React.useState('img')      /* img | inline | broken */
  const hostRef = React.useRef(null)

  React.useEffect(function () { setMode('img') }, [props.src])

  const onError = function () {
    if (mode !== 'img') return
    const url = props.src
    if (typeof fetch !== 'function') { setMode('broken'); return }
    fetch(url, { credentials: 'same-origin' })
      .then(function (res) { if (!res.ok) throw new Error('http-' + res.status); return res.text() })
      .then(function (text) {
        const fixed = AIC_COURSES_CORE.repairSvgText(text)
        if (typeof DOMParser !== 'function') throw new Error('no-domparser')
        const doc = new DOMParser().parseFromString(fixed, 'image/svg+xml')
        const root = doc && doc.documentElement
        if (!root || root.nodeName.toLowerCase() === 'parsererror') throw new Error('still-bad')
        hardenInlineSvg(root)
        setMode('inline')
        setTimeout(function () {
          const el = hostRef.current
          if (!el) return
          while (el.firstChild) el.removeChild(el.firstChild)
          el.appendChild(document.importNode(root, true))
        }, 0)
      })
      .catch(function () { setMode('broken') })
  }

  if (mode === 'inline') {
    return h('span', { className: 'aic-figure', role: 'img', 'aria-label': props.alt || t('lesson.diagram'), ref: hostRef })
  }
  if (mode === 'broken') {
    return h('span', { className: 'aic-muted aic-figure--broken' }, props.alt || t('lesson.imageFallback'))
  }
  return h('img', { className: 'aic-figure', src: props.src, alt: props.alt, loading: 'lazy', onError: onError })
}

/* ---------------------------------------------------------------- Mermaid */

/**
 * Mermaid 渲染器的**按需加载器**（同一个页面只加载一次）。
 *
 * 为什么从宿主路由加载、而不是 `import('mermaid')`：
 *   客户端模块表只认「启动图里的行」或平台种子，第三方裸包**不在其中**（实测会报
 *   `cannot resolve`）。所以 Mermaid 作为**插件自带的静态资源**由宿主送出去，
 *   用 `<script>` 注入 —— 与「按需」天然契合（没图就不下载这 3.4 MB）。
 */
const AIC_VENDOR_BASE = '/dsh-ai-courses/vendor/'
/* 每个 vendor 脚本只注入一次；失败则清掉缓存，下次用到时重试 */
const aicVendorLoads = {}

/**
 * 按需注入一个 vendor 脚本，并等它挂到 `window[globalName]` 上。
 *
 * 为什么要注入 `<script>` 而不是 `import()`：客户端模块表只认启动图里的行，
 * 第三方裸包不在其中（E-37）；而它们体积不小（Mermaid 3.4 MB、highlight.js 130 KB），
 * 塞进 client bundle 会让每次插件迭代都重下。
 */
/** 取脚本挂上来的全局对象（浏览器里 `window === globalThis`；也照顾只在 globalThis 上挂的情况）。 */
function aicVendorGlobal (name) {
  if (typeof window !== 'undefined' && window && window[name]) return window[name]
  if (typeof globalThis !== 'undefined' && globalThis && globalThis[name]) return globalThis[name]
  return undefined
}

function aicLoadVendor (file, globalName) {
  const ready = aicVendorGlobal(globalName)
  if (ready) return Promise.resolve(ready)
  if (aicVendorLoads[file]) return aicVendorLoads[file]
  aicVendorLoads[file] = new Promise(function (resolve, reject) {
    if (typeof document === 'undefined' || !document.head) { reject(new Error('no-dom')); return }
    const el = document.createElement('script')
    el.src = AIC_VENDOR_BASE + file
    el.async = true
    el.onload = function () {
      const mod = aicVendorGlobal(globalName)
      if (mod) resolve(mod)
      else reject(new Error('missing-global'))
    }
    el.onerror = function () { reject(new Error('script-load-failed')) }
    document.head.appendChild(el)
  }).catch(function (err) {
    aicVendorLoads[file] = null
    throw err
  })
  return aicVendorLoads[file]
}

/** Mermaid 渲染器（3.4 MB，只有出现图表时才加载）。 */
function aicLoadMermaid () { return aicLoadVendor('mermaid.min.js', 'mermaid') }
/** 代码高亮器（130 KB，只有出现代码块时才加载）。 */
function aicLoadHljs () { return aicLoadVendor('highlight.min.js', 'hljs') }

/**
 * 一张 Mermaid 图（` ```mermaid ` 围栏）。
 *
 * 三级降级，**任何一级都不白屏**：
 *   ① 渲染成功 → 内联 SVG（跟随主题色）；
 *   ② 渲染器加载不到 / 语法错 → 提示 + **源码代码块**（内容仍可读、可复制）；
 *   ③ 还在加载 → 占位文案。
 *
 * 安全：`securityLevel: 'strict'`（Mermaid 官方对不可信输入的建议），`htmlLabels: false`。
 */
function MermaidChart (props) {
  const t = props.t
  const [state, setState] = React.useState({ status: 'loading', error: '' })
  const hostRef = React.useRef(null)
  const svgRef = React.useRef('')

  React.useEffect(() => {
    let alive = true
    setState({ status: 'loading', error: '' })
    svgRef.current = ''
    aicLoadMermaid()
      .then(function (mermaid) {
        if (!alive) return null
        try { mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', htmlLabels: false, theme: 'base' }) } catch { /* 初始化失败照样试渲染 */ }
        /* id 只用 mermaid 自己的命名空间：`aic-` 是**类名**前缀，动态拼它会被
           「禁止动态拼 class」那条静态检查拦住（而且也不该拼） */
        const id = 'mmd-' + Date.now() + '-' + Math.floor(Math.random() * 1e6)
        return Promise.resolve(mermaid.render(id, props.source)).then(function (out) {
          if (!alive) return
          const svg = typeof out === 'string' ? out : (out && out.svg) || ''
          if (!svg) throw new Error('empty-render')
          svgRef.current = svg
          setState({ status: 'ok', error: '' })
        })
      })
      .catch(function (err) {
        if (!alive) return
        setState({ status: 'error', error: String((err && err.message) || err) })
      })
    return function () { alive = false }
  }, [props.source])

  /* 注入放在**独立的 effect** 里：effect 一定在容器提交到 DOM 之后运行，
     所以 `hostRef.current` 必然已挂上 —— 不再依赖 `setTimeout(0)` 的时序
     （那一步在 React 18 并发渲染下可能先于 commit 执行，导致图静默不显示）。 */
  React.useEffect(() => {
    if (state.status !== 'ok') return
    const el = hostRef.current
    const svg = svgRef.current
    if (!el || !svg || typeof DOMParser !== 'function') return
    /* 不用 innerHTML / insertAdjacentHTML：正文与图表都是不可信输入（AC-17）。
       用 DOMParser 解析成**惰性**文档 → 剥掉 script → importNode 挂进来。 */
    const doc = new DOMParser().parseFromString(svg, 'image/svg+xml')
    const root = doc && doc.documentElement
    if (!root || root.nodeName.toLowerCase() === 'parsererror') return
    const scripts = root.querySelectorAll ? root.querySelectorAll('script') : []
    for (const sc of scripts) sc.parentNode.removeChild(sc)
    /* 清掉上一次的图：同一容器可能因 source 变化重渲染，不清会叠加 */
    while (el.firstChild) el.removeChild(el.firstChild)
    el.appendChild(document.importNode(root, true))
  }, [state.status])

  if (state.status === 'ok') {
    /* 只放 Mermaid **自己产出**的 SVG，并且用 **DOM API** 注入（不是 `dangerouslySetInnerHTML`）：
       正文是**不可信输入**（AC-17），渲染产物同样不该走那条路；
       Mermaid 侧另有 `securityLevel: 'strict'` 兜底。 */
    return h('div', {
      className: 'aic-mermaid',
      role: 'img',
      'aria-label': t('lesson.diagram'),
      ref: hostRef,
    })
  }
  if (state.status === 'loading') {
    return h('div', { className: 'aic-mermaid aic-mermaid--pending' }, t('lesson.diagramLoading'))
  }
  return h(
    'div',
    { className: 'aic-mermaid aic-mermaid--failed' },
    h(Notice, null, t('lesson.diagramFallback', { reason: state.error })),
    h('pre', { className: 'aic-mermaid__source' }, h('code', null, props.source)),
  )
}

/* --------------------------------------------------------------- 代码高亮 */

/**
 * highlight.js 的 token 类名 → 本插件自己的**字面**类名。
 *
 * 为什么再映射一层而不是直接用 `hljs-*`：
 *   ① 样式只消费宿主的 14 个主题 token（06 §7），需要自己挑语义色；
 *   ② 本插件要求 `aic-` 前缀的**字面**类名，禁止动态拼 class（静态检查会拦）。
 * 键是 highlight.js 的类别（取最后一个 `.` 之前的部分）。
 */
const HLJS_TOKEN_CLASS = {
  keyword: 'aic-tok-keyword',
  literal: 'aic-tok-keyword',
  built_in: 'aic-tok-keyword',
  string: 'aic-tok-string',
  regexp: 'aic-tok-string',
  symbol: 'aic-tok-string',
  char: 'aic-tok-string',
  number: 'aic-tok-number',
  comment: 'aic-tok-comment',
  quote: 'aic-tok-comment',
  title: 'aic-tok-title',
  section: 'aic-tok-title',
  function: 'aic-tok-title',
  attr: 'aic-tok-attr',
  attribute: 'aic-tok-attr',
  property: 'aic-tok-attr',
  variable: 'aic-tok-attr',
  params: 'aic-tok-attr',
  type: 'aic-tok-type',
  class: 'aic-tok-type',
  tag: 'aic-tok-type',
  name: 'aic-tok-type',
  meta: 'aic-tok-meta',
  operator: 'aic-tok-punct',
  punctuation: 'aic-tok-punct',
}

/** highlight.js 的类别名 → 本插件的类名（未知类别不加类，保留原色）。 */
function hljsTokenClass (rawClasses) {
  const parts = String(rawClasses || '').split(/\s+/)
  for (const p of parts) {
    if (p.indexOf('hljs-') !== 0) continue
    const base = p.slice(5).split('.')[0]
    if (Object.prototype.hasOwnProperty.call(HLJS_TOKEN_CLASS, base)) return HLJS_TOKEN_CLASS[base]
  }
  return ''
}

/**
 * HTML 实体 → 字符。
 *
 * ⚠️ 必须支持**数字实体**：highlight.js 把 `'` 写成 `&#x27;`（十六进制）、有时用 `&#39;`。
 * 早期只认 `&quot;` 与 `&#39;`，于是单引号在代码块里显示成 `&#x27;` —— 真机上就是这么"乱码"的。
 * 顺序也有讲究：数字实体先解，`&amp;` **最后**解（否则 `&amp;lt;` 会被解成 `<`）。
 */
function unescapeHtml (text) {
  const fromCode = (n) => {
    if (!Number.isFinite(n) || n < 0 || n > 0x10ffff) return null
    try { return String.fromCodePoint(n) } catch { return null }
  }
  return String(text ?? '')
    .replace(/&#x([0-9a-fA-F]+);/g, (m, hex) => {
      const ch = fromCode(parseInt(hex, 16))
      return ch === null ? m : ch
    })
    .replace(/&#(\d+);/g, (m, dec) => {
      const ch = fromCode(parseInt(dec, 10))
      return ch === null ? m : ch
    })
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')     /* 必须最后 */
}

/**
 * 把 highlight.js 的**HTML 片段**转成 React 节点（**不碰 innerHTML**，AC-17）。
 *
 * highlight.js 的产出形状是受控的：只有 `<span class="hljs-…">`、`</span>` 和文本。
 * 所以用一个小状态机就够，不需要 DOMParser，也不必担心夹带别的标签 ——
 * 任何不认识的标签都会被**当文本丢掉**，不会变成元素。
 *
 * @param {string} html `hljs.highlight(...).value`
 * @param {string} keyPrefix React key 前缀
 * @returns {Array} React 子节点
 */
function hljsToNodes (html, keyPrefix) {
  const src = String(html ?? '')
  const out = []
  const stack = []
  const tagRe = /<span\b([^>]*)>|<\/span\s*>|<[^>]*>/gi
  let last = 0
  let n = 0
  let m
  const pushText = (text) => {
    if (!text) return
    const cls = stack.length ? stack[stack.length - 1] : ''
    const value = unescapeHtml(text)
    out.push(cls ? h('span', { key: keyPrefix + '-' + (n++), className: cls }, value) : value)
  }
  while ((m = tagRe.exec(src)) !== null) {
    if (m.index > last) pushText(src.slice(last, m.index))
    last = tagRe.lastIndex
    if (m[0].charAt(1) === '/') { stack.pop(); continue }
    const clsMatch = /class\s*=\s*"([^"]*)"/i.exec(m[1] || '')
    if (m[0].indexOf('<span') === 0 && m[0].charAt(1) !== '/') {
      stack.push(hljsTokenClass(clsMatch ? clsMatch[1] : ''))
    } else {
      /* 其他任何标签：整段丢掉（既不留元素，也不留标签文本） */
      stack.push('')
      stack.pop()
    }
  }
  if (last < src.length) pushText(src.slice(last))
  return out
}

/**
 * 一个代码块：优先**高亮**，拿不到高亮器就退回纯文本（不白屏）。
 *
 * 三级降级：① 高亮成功 → 带 token 类的 `span`；② 加载失败/语言不支持 → 纯文本；
 * ③ 还在加载 → 先显示纯文本（**不留空白**，避免"闪一下"）。
 */
function CodeBlock (props) {
  const lang = String(props.lang || '')
  const source = String(props.source ?? '')
  const [tokens, setTokens] = React.useState(null)

  React.useEffect(() => {
    let alive = true
    setTokens(null)
    /* 空内容没什么可高亮的；但**没有语言标记**照样要试 —— 模型经常直接写 ```
       （真机上 6 个围栏里有 6 个是裸的），否则「有内容却不亮」看起来像坏了。 */
    if (!source) return function () { alive = false }
    aicLoadHljs()
      .then(function (hljs) {
        if (!alive || !hljs) return
        let html = ''
        try {
          const known = lang && typeof hljs.getLanguage === 'function' && hljs.getLanguage(lang)
          /* 有语言且被支持 → 按语言高亮；否则（没写语言 / 语言不支持）→ 自动识别 */
          html = known
            ? hljs.highlight(source, { language: lang, ignoreIllegals: true }).value
            : hljs.highlightAuto(source).value
        } catch (err) {
          html = ''
        }
        if (html) setTokens(hljsToNodes(html, 'tok'))
      })
      .catch(function () { /* 加载失败：保持纯文本 */ })
    return function () { alive = false }
  }, [lang, source])

  return h(
    'pre',
    { className: 'aic-code' },
    h('code', { className: lang ? 'aic-code--lang' : undefined, 'data-lang': lang || undefined }, tokens || source),
  )
}

/* ------------------------------------------------------------------ 播放器 */

/** 只含一张图片的段落（`p > img`）——版式要把它抽到侧栏去。 */
function isFigureNode (node) {
  if (!node || typeof node !== 'object') return false
  if (node.type === 'img') return true
  if (node.type !== 'p') return false
  const kids = (node.kids || []).filter((k) => k !== null && k !== undefined && k !== '')
  return kids.length === 1 && kids[0] && kids[0].type === 'img'
}

/** 把一页拆成两栏：`[正文, 图]`（`image-left` 的 CSS 会把第一栏换到右侧）。 */
function splitFigureCols (nodes) {
  const at = nodes.findIndex(isFigureNode)
  if (at < 0) return null
  const figure = nodes[at]
  const text = nodes.filter((n, i) => i !== at)
  if (!text.length) return null                     /* 只有图：不必分栏（否则左栏空一大块） */
  return { text: text, figure: figure }
}

/** 两栏版式：把正文按**元素个数**对半切开（够用且可预测；不做语义切分）。 */
function splitHalf (nodes) {
  if (nodes.length < 2) return null
  const mid = Math.ceil(nodes.length / 2)
  return { left: nodes.slice(0, mid), right: nodes.slice(mid) }
}

/**
 * 一页幻灯片；`layout` 未知一律按 `default` 渲染（06 §7.1，AC-16）。
 *
 * 版式靠**结构**生效（CSS 里 `two-cols` / `image-right` 等规则都指向 `.aic-slide__cols`），
 * 所以这里必须真的产出那个结构：
 *   · `two-cols` / `two-cols-header` → 正文对半成两栏；
 *   · `image-right` / `image-left`   → 正文 + 图两栏（抽不到图就退回单栏，不硬造空栏）；
 *   · 其余版式 → 单栏。
 * 标题单独渲染成 `.aic-slide__title`（版式的字号/居中规则都挂在它上面）。
 */
function SlidePage (props) {
  const t = props.t
  const core = AIC_COURSES_CORE
  const layout = core.slideLayout(props.slide.layout)
  const unknown = layout !== props.slide.layout
  const split = core.splitSlideTitle(props.slide.body, props.slide.title)
  const nodes = renderMarkdown(split.text, props.resolveUrl, t)

  let cols = null
  if (layout === 'two-cols' || layout === 'two-cols-header') {
    const halves = splitHalf(nodes)
    if (halves) cols = [halves.left, halves.right]
  } else if (layout === 'image-right' || layout === 'image-left') {
    const fig = splitFigureCols(nodes)
    if (fig) cols = [fig.text, [fig.figure]]
  }

  const prose = cols
    ? h('div', { className: 'aic-slide__cols' },
        cols.map((part, ci) => h('div', { className: 'aic-prose', key: ci }, part)))
    : h('div', { className: 'aic-prose' }, nodes)

  return h(
    'section',
    { className: SLIDE_CLASS[layout], 'aria-label': t('lesson.slideLabel', { n: props.index + 1 }) },
    h('div', { className: 'aic-slide__no' }, t('lesson.slideNo', { n: props.index + 1, total: props.total })),
    unknown ? h(Notice, null, t('lesson.slideLayoutUnknown', { layout: String(props.slide.layout) })) : null,
    split.title ? h('h2', { className: 'aic-slide__title' }, split.title) : null,
    prose,
  )
}

/** 幻灯片播放器：上一页 / 页码 / 下一页 + 当前页讲稿（06 §5）。 */
function SlidevPlayer (props) {
  const t = props.t
  const core = AIC_COURSES_CORE
  const parsed = React.useMemo(() => core.parseSlidev(props.text), [props.text])
  const [at, setAt] = React.useState(0)
  const slides = parsed.slides
  React.useEffect(() => { setAt(0) }, [props.text])
  if (!slides.length) {
    return h('div', { className: 'aic-empty' }, h('div', { className: 'aic-empty__title' }, t('lesson.slideEmpty')))
  }
  const index = Math.max(0, Math.min(slides.length - 1, at))
  const slide = slides[index]
  return h(
    'div',
    null,
    h('div', { className: 'aic-player' }, h(SlidePage, { t: t, slide: slide, index: index, total: slides.length, resolveUrl: props.resolveUrl })),
    h(
      'div',
      { className: 'aic-player__bar' },
      h(IconButton, { name: 'prev', label: t('lesson.slidePrev'), disabled: index === 0, onClick: () => setAt(index - 1) }),
      h('span', { className: 'aic-player__pos', 'aria-live': 'polite' }, t('lesson.slidePos', { n: index + 1, total: slides.length })),
      h(IconButton, { name: 'next', label: t('lesson.slideNext'), disabled: index === slides.length - 1, onClick: () => setAt(index + 1) }),
    ),
    slide.notes
      ? h('div', { className: 'aic-notes' }, h('h2', { className: 'aic-h2' }, t('lesson.notes')), h('div', { className: 'aic-prose' }, renderMarkdown(slide.notes, props.resolveUrl, t)))
      : null,
  )
}

/**
 * 内容区：按 `render` 口径分派。
 * @param {object} props `{ t, payload, formatPending, resolveUrl }`
 */
function ContentView (props) {
  const t = props.t
  const payload = props.payload || {}
  if (!payload.hasAsset) return null
  return h(
    'div',
    { className: 'aic-content' },
    props.formatPending ? h(Notice, null, t('lesson.formatPending', { type: payload.contentType })) : null,
    payload.render === 'slidev'
      ? h(SlidevPlayer, { t: t, text: payload.body, resolveUrl: props.resolveUrl })
      : h('div', { className: 'aic-prose' }, renderMarkdown(payload.body, props.resolveUrl, t)),
    (payload.media || []).length
      ? h('div', { className: 'aic-muted aic-content__media' }, t('lesson.mediaCount', { n: payload.media.length }))
      : null,
  )
}
