#!/usr/bin/env node
/**
 * 构建：src/ → package/（被 install_bundle 安装的是 package/，不是工作区目录）
 * 零构建工具链：只做「按序拼接 + 拷贝」。
 *
 * host  ：src/host/*.mjs 按文件名顺序拼接为 package/index.mjs
 * client：src/client/00-shell-head.js + [内联样式] + 其余 src/client/*.js（按文件名顺序）
 *         + src/client/99-shell-tail.js → package/lib/client.js
 *
 * 样式为什么内联：宿主**不会**自动加载插件包里的 lib/styles.css（在装先例 dsh-notes-plugin
 * 是通过自己的 host 通道下发 CSS 的，见 doc/03 §6 的取舍）。本插件按 doc/03 的定案，在构建期
 * 把 src/client/styles.css 内联成 client.js 里的一个字符串常量，由 apply() 注入一个 <style>。
 * 同一个文件仍以真实文件形式发布（files 含 lib/styles.css），便于人工查看与排错。
 */
import { readdir, readFile, writeFile, mkdir, cp, rm } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const src = join(root, 'src')
const out = join(root, 'package')

const read = (p) => readFile(join(root, p), 'utf8')
const parts = async (dir, ext) =>
  (await readdir(join(src, dir))).filter((f) => f.endsWith(ext)).sort()

/* vendor（浏览器按需加载的第三方单文件，目前只有 Mermaid）先兜在内存里：
   下面的 `rm -rf package` 会把它一起删掉，所以构建完再原样写回。
   缺失不报错 —— 运行时优雅降级（图表显示为源码），发布前用
   `node scripts/vendor-mermaid.mjs --require` 做门禁。 */
/* ⚠️ 源在**仓库根** `vendor/`，不在 `package/` —— 因为下一行的 `rm -rf package` 会把 package 下的东西
   全删掉。早期版本把源放在 `package/vendor`，第一次构建后源就没了（自食其果）。 */
const VENDOR_DIR = join(root, 'vendor')
const vendorFiles = await readdir(VENDOR_DIR).catch(() => [])
const vendorBlobs = []
for (const f of vendorFiles) vendorBlobs.push([f, await readFile(join(VENDOR_DIR, f))])

await rm(out, { recursive: true, force: true })
await mkdir(join(out, 'lib'), { recursive: true })
await mkdir(join(out, 'locale'), { recursive: true })
if (vendorBlobs.length) {
  await mkdir(join(out, 'vendor'), { recursive: true })
  for (const [f, blob] of vendorBlobs) await writeFile(join(out, 'vendor', f), blob)
}

/* --- host：src/host/*.mjs 按文件名顺序拼接 --- */
const hostParts = await parts('host', '.mjs')
if (!hostParts.length) throw new Error('src/host/ 下没有 .mjs')

/**
 * 拼接 host 段的 import 处理：**非相对 import 统一提升到产物顶部并去重**，跨段 import 直接丢掉。
 *
 * 为什么不是「就地剥掉跨段 import、其余原样保留」：
 *   ① 跨行正则匹配会把前面的 `node:*` import 一起吞掉（`readFileAsync is not defined`，
 *      vendor 资源永远 404 —— 这条真机才炸，坑了一整轮）；
 *   ② 就地保留还会撞**重复声明**：`06-fs-port` 与 `30-courses` 都 `import { isAbsolute }`，
 *      拼成单模块就是 `Identifier 'isAbsolute' has already been declared`。
 * 提升 + 合并后，同名绑定只声明一次；同一个模块的多条 import 也会合并成一条。
 */
function parseImportStatement (stmt) {
  const se = stmt.match(/^import\s*'([^']+)'\s*;?$/)
  if (se) return { spec: se[1], names: [], bare: true }
  const m = stmt.match(/^import\s+([\s\S]*?)\s*from\s*'([^']+)'\s*;?$/)
  if (!m) return null
  const spec = m[2]
  const clause = m[1].trim()
  const names = []
  if (clause.startsWith('{')) {
    const inner = clause.slice(1, clause.lastIndexOf('}'))
    for (const part of inner.split(',')) {
      const t = part.trim()
      if (!t) continue
      const mm = t.match(/^([A-Za-z_$][\w$]*)(?:\s+as\s+([A-Za-z_$][\w$]*))?$/)
      if (!mm) throw new Error('[build] 无法解析 import 名字：' + t)
      names.push({ kind: 'named', imported: mm[1], local: mm[2] || mm[1] })
    }
  } else if (clause.startsWith('*')) {
    const mm = clause.match(/^\*\s+as\s+([A-Za-z_$][\w$]*)$/)
    if (!mm) throw new Error('[build] 无法解析 namespace import：' + clause)
    names.push({ kind: 'ns', local: mm[1] })
  } else {
    names.push({ kind: 'default', local: clause })
  }
  return { spec, names, bare: false }
}

/** 把各段的 import 拆掉，返回 { code（去掉 import 的本体）, imports（按模块聚合） }。 */
function hoistImports (code) {
  const lines = code.split('\n')
  const kept = []
  const byBind = new Map()   // local 名 → spec（用于检测真冲突）
  const specs = new Map()    // spec → { named: Map(local→imported), ns: [], default: [] , bare }
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (!/^import\s/.test(line)) { kept.push(line); continue }
    let j = i
    let stmt = line
    while (j < lines.length - 1 && !/from\s*'[^']*'\s*;?\s*$|^import\s*'[^']*'\s*;?\s*$/.test(stmt)) {
      j += 1
      stmt += '\n' + lines[j]
    }
    const parsed = parseImportStatement(stmt)
    i = j
    if (!parsed) throw new Error('[build] 无法解析 import 语句：' + stmt.split('\n')[0])
    /* 跨段 import（'./NN-*'）在拼接后由同一作用域直接共享，丢掉 */
    if (parsed.spec.startsWith('./')) continue
    if (!specs.has(parsed.spec)) specs.set(parsed.spec, { named: new Map(), ns: [], default: [], bare: false })
    const slot = specs.get(parsed.spec)
    if (parsed.bare) { slot.bare = true; continue }
    for (const n of parsed.names) {
      const prev = byBind.get(n.local)
      if (prev && prev !== parsed.spec) {
        throw new Error(`[build] import 冲突：\`${n.local}\` 同时来自 '${prev}' 与 '${parsed.spec}'`)
      }
      byBind.set(n.local, parsed.spec)
      if (n.kind === 'named') slot.named.set(n.local, n.imported)
      else if (n.kind === 'ns') slot.ns.push(n.local)
      else slot.default.push(n.local)
    }
  }
  return { code: kept.join('\n'), specs }
}

const host = []
const importSpecs = new Map()
for (const f of hostParts) {
  const code = (await read(`src/host/${f}`)).trimEnd()
  const { code: stripped, specs } = hoistImports(code)
  for (const [spec, slot] of specs) {
    if (!importSpecs.has(spec)) importSpecs.set(spec, { named: new Map(), ns: [], default: [], bare: false })
    const target = importSpecs.get(spec)
    for (const [local, imported] of slot.named) target.named.set(local, imported)
    for (const x of slot.ns) if (target.ns.indexOf(x) < 0) target.ns.push(x)
    for (const x of slot.default) if (target.default.indexOf(x) < 0) target.default.push(x)
    if (slot.bare) target.bare = true
  }
  host.push(stripped.trimEnd())
}

/* 每个模块一条 import：默认导入 → namespace → 具名（按 local 名排序，产出稳定可 diff） */
const prologue = []
for (const spec of [...importSpecs.keys()].sort()) {
  const slot = importSpecs.get(spec)
  const parts = []
  for (const d of slot.default) parts.push(d)
  for (const ns of slot.ns) parts.push('* as ' + ns)
  const named = [...slot.named.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : 1))
    .map(([local, imported]) => (local === imported ? local : imported + ' as ' + local))
  if (named.length) parts.push('{ ' + named.join(', ') + ' }')
  if (!parts.length) { prologue.push(`import '${spec}'`); continue }
  prologue.push(`import ${parts.join(', ')} from '${spec}'`)
}

const hostArtifact = (prologue.length ? prologue.join('\n') + '\n\n' : '') + host.join('\n\n') + '\n'

/* 门禁①：源码里每条**非相对** import 的模块必须出现在产物顶部 */
const artifactSpecs = new Set([...hostArtifact.matchAll(/^import\s+(?:[\s\S]*?\s+from\s+)?'([^']+)'/gm)].map((m) => m[1]))
const lostSpecs = [...importSpecs.keys()].filter((s) => !artifactSpecs.has(s))
if (lostSpecs.length) throw new Error(`[build] 产物丢失了这些 import：${lostSpecs.join(', ')}`)
/* 门禁②：产物里不许残留跨段相对 import */
const strayRelative = [...hostArtifact.matchAll(/from\s*'(\.\/[^']+)'/g)].map((m) => m[1])
if (strayRelative.length) throw new Error(`[build] 产物里还残留相对 import：${strayRelative.join(', ')}`)

await writeFile(join(out, 'index.mjs'), hostArtifact)
/* 门禁③：拼接后**真的**过一遍语法检查。重复声明、坏括号这类问题在这里就该失败 ——
   `Identifier 'x' has already been declared` 曾经因为"吞 import"被掩盖了整整一轮。 */
try {
  execFileSync(process.execPath, ['--check', join(out, 'index.mjs')], { stdio: 'pipe' })
} catch (err) {
  throw new Error(`[build] 产物语法检查失败：${String((err.stderr || err.message)).split('\n').slice(0, 4).join(' ')}`)
}

/* --- client：外壳头 + 内联样式 + 各段 + 外壳尾 --- */
const HEAD = '00-shell-head.js'
const clientParts = await parts('client', '.js')
if (!clientParts.includes(HEAD)) throw new Error(`src/client/${HEAD} 缺失`)
if (!clientParts.includes('99-shell-tail.js')) throw new Error('src/client/99-shell-tail.js 缺失')

const css = await read('src/client/styles.css')
/* highlight.js **内联**进 client（130 KB）：
   它是核心展示能力，且「静态资源由宿主路由送出」这条路踩过两次版本滞后（改了前端的看不到效果，
   必须重启宿主）。代价可控，换来「只要前端刷新就生效」。Mermaid 3.4 MB 太大，仍然按需加载。 */
const hljsSource = await read('vendor/highlight.min.js').catch(() => '')
/* 「AI 备注」上限：host 常量 → client 常量（两边同一个数，避免一边 2000 一边 500） */
const promptMax = Number((await read('src/host/05-constants.mjs')).match(/PROMPT_MAX = (\d+)/)?.[1] || 2000)
const segments = []
for (const f of clientParts) {
  if (f === HEAD) continue
  const code = (await read(`src/client/${f}`)).trimEnd()
  segments.push(`/* ==================== src/client/${f} ==================== */\n\n${code}`)
}
const vendorSegment = hljsSource
  ? `/* ==================== 内联第三方：highlight.js（${(Buffer.byteLength(hljsSource) / 1024).toFixed(0)} KB） ==================== */
/* 为什么内联而不是按需加载：高亮是核心展示能力，而「静态资源走宿主路由」要求宿主先带上新代码，
   改完前端看不到效果、必须重启宿主 —— 这条已经踩过两次。130 KB 换来「刷新即生效」。 */
${hljsSource}
/* 挂到全局：客户端按 \`globalThis[name]\` 取（浏览器里 window === globalThis） */
if (typeof globalThis !== 'undefined' && !globalThis.hljs) globalThis.hljs = hljs`
  : `/* 未内联 highlight.js：vendor/highlight.min.js 缺失（代码块将不高亮） */`

const client = [
  (await read(`src/client/${HEAD}`)).trimEnd(),
  '/* ---- 样式：构建期内联（同一个文件也以真实文件随包发布）---- */',
  `const AIC_COURSES_CSS = ${JSON.stringify(css)}`,
  `/* 「AI 备注」上限（构建期从 src/host/05-constants.mjs 的 PROMPT_MAX 注入） */\nconst AIC_PROMPT_MAX = ${promptMax}`,
  ...segments,
  vendorSegment,
].join('\n\n') + '\n'
await writeFile(join(out, 'lib/client.js'), client)
await cp(join(src, 'client/styles.css'), join(out, 'lib/styles.css'))

/* --- manifest --- */
await cp(join(src, 'manifest/package.json'), join(out, 'package.json'))
await cp(join(src, 'manifest/cordis.patch.yml'), join(out, 'cordis.patch.yml'))
await cp(join(src, 'manifest/icon.svg'), join(out, 'icon.svg'))
for (const f of await readdir(join(src, 'manifest/locale'))) {
  await cp(join(src, 'manifest/locale', f), join(out, 'locale', f))
}
await writeFile(join(out, 'README.md'), `# dsh-ai-courses

AI 课程 —— 把学习诉求与手头资料变成结构化、可讲授、纯本地的课程。

- 命令：\`/ai-course <学习诉求> [+附件]\`
- 数据：\`<courseRoot>/<courseId>/\` 下的 JSON + Markdown（默认 \`~/.dsh/ai-courses\`）
- 无外部服务依赖、零运行时依赖

> 包内 README 与工作区的产品输入 \`README.md\` 是两份不同文件。
`)

if (vendorBlobs.length) console.log(`[build] vendor: ${vendorBlobs.map(([f, b]) => `${f} (${(b.length / 1024 / 1024).toFixed(2)} MB)`).join(', ')} → vendor/`)
else console.log('[build] vendor: 无（图表将降级为源码块；发布前跑 node scripts/vendor-mermaid.mjs）')
console.log(`[build] host: ${hostParts.length} 段 → index.mjs`)
console.log(`[build] client: ${clientParts.length} 段 + 内联样式 ${Buffer.byteLength(css)} B` +
  (hljsSource ? ` + 内联 highlight.js ${(Buffer.byteLength(hljsSource) / 1024).toFixed(0)} KB` : '') +
  ' → lib/client.js')
console.log('[build] 产物 → package/')
