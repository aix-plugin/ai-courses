#!/usr/bin/env node
/**
 * 把 Mermaid 的**预构建 UMD 单文件**落到 `package/vendor/mermaid.min.js`。
 *
 * 为什么是 vendored 文件、而不是 package.json 里的 dependency：
 *   · 这是**浏览器侧**的渲染引擎（浏览器没法 import 宿主 node_modules 里的裸包，客户端模块表只认启动图）；
 *   · 3.4 MB 进 `lib/client.js` 会让每次换插件都重新下载整个 client 包；
 *   · 它只在「这个知识点里真的有 mermaid 图」时才需要 —— 做成**按需加载**的静态资源最合适。
 *
 * 该文件**不进 git 语义的关键路径**：缺失时 `node scripts/build.mjs` 只是跳过 +
 * 运行时优雅降级（图表源码仍以代码块显示）。`--require` 用于发布前校验。
 *
 *   node scripts/vendor-mermaid.mjs           # 缺失才下载
 *   node scripts/vendor-mermaid.mjs --force   # 强制重下
 *   node scripts/vendor-mermaid.mjs --require # 缺失即失败（发布门禁）
 */
import { mkdir, writeFile, readFile, stat } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
/* 落到**仓库根** `vendor/`：`package/` 是构建产物，每次 `build.mjs` 会整目录重建 */
const dest = join(root, 'vendor/mermaid.min.js')
const URL = 'https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.min.js'
const MIN_BYTES = 500 * 1024

const args = process.argv.slice(2)
const force = args.includes('--force')
const requireIt = args.includes('--require')

const exists = await stat(dest).then((s) => s.size >= MIN_BYTES).catch(() => false)
if (exists && !force) {
  const size = (await stat(dest)).size
  console.log(`[vendor] 已存在，跳过：${dest}（${(size / 1024 / 1024).toFixed(2)} MB）`)
  process.exit(0)
}
if (requireIt) {
  console.error(`[vendor] 缺少 ${dest} —— 发布前请运行 node scripts/vendor-mermaid.mjs`)
  process.exit(1)
}
try {
  const res = await fetch(URL, { redirect: 'follow' })
  if (!res.ok) throw new Error('HTTP ' + res.status)
  const text = await res.text()
  if (text.length < MIN_BYTES) throw new Error('下载内容过小（' + text.length + ' B）')
  if (!/globalThis\["mermaid"\]/.test(text)) throw new Error('不是预期的 mermaid UMD 构建（找不到 globalThis.mermaid）')
  await mkdir(dirname(dest), { recursive: true })
  await writeFile(dest, text, 'utf8')
  console.log(`[vendor] 已写入 ${dest}（${(text.length / 1024 / 1024).toFixed(2)} MB）`)
} catch (err) {
  console.error('[vendor] 下载失败：' + (err && err.message))
  console.error('[vendor] 不影响使用：缺这个文件时，图表会以源码形式显示（客户端优雅降级）')
  process.exit(0)
}
