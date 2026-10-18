#!/usr/bin/env node
/**
 * 一次性修复：把**已经落盘**的 SVG 媒体按当前的清洗规则重洗一遍。
 *
 * ## 为什么需要它（背景）
 *
 * 早期版本的 `sanitizeSvg` 有两个 bug，写进课程库的 SVG **不是合法 XML**：
 *   · 自闭合标签的 `/` 被吃掉（`<path …>`）→ `mismatched tag`；
 *   · `xmlns` 被补了两次 → `duplicate attribute`。
 * 浏览器用 `<img src="*.svg">` 载入时按**严格 XML** 解析，于是「文件在、路由通、图就是不显示」（E-36）。
 *
 * 修好清洗器之后，**旧文件不会自己变好** —— 它们是按旧规则写下去的字节。这个脚本负责回填。
 * 它不是常规流程的一部分：只在这次修复时需要，跑完即可删。
 *
 * ## 用法
 *
 *   node scripts/repair-media.mjs                 # 预演（只报告，不写）
 *   node scripts/repair-media.mjs --write         # 实际写回（自动备份 .bak）
 *   node scripts/repair-media.mjs --root <dir>    # 指定课程库根（默认取插件配置/内置默认）
 *   node scripts/repair-media.mjs --no-backup     # 不备份（不推荐）
 *
 * 安全约定：
 *   · **只碰** `<课程>/content-assets/media/` 下的 `*.svg`，别的文件一律不动；
 *   · 每个文件写回前先备份成 `<name>.bak`（已存在则加序号，不覆盖旧备份）；
 *   · 洗不出合法 XML 的（`sanitizeSvg` 回 null）**不写**，只在报告里列出来 —— 那种只能重新生成；
 *   · 内容没变化的不写（避免无意义的 mtime 变动，也就不会打乱课程库「最近更新」排序）。
 */
import { readdir, readFile, writeFile, stat, copyFile, access } from 'node:fs/promises'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { homedir } from 'node:os'
import { sanitizeSvg, isWellFormedSvg } from '../src/host/30-generate.mjs'

const args = process.argv.slice(2)
const write = args.includes('--write')
const backup = !args.includes('--no-backup')
const rootArg = args.indexOf('--root') >= 0 ? args[args.indexOf('--root') + 1] : ''

/** 课程库根：优先 `--root`，其次插件默认（`~/.dsh/ai-courses`）。 */
const COURSE_ROOT = resolve(rootArg || join(homedir(), '.dsh', 'ai-courses'))
const IS_COURSE_ID = /^c-[A-Za-z0-9_-]+$/

const exists = (p) => access(p).then(() => true, () => false)

/** 备份名：`x.svg` → `x.svg.bak`；已被占用就 `x.svg.bak-2`、`-3`… */
async function backupPath (file) {
  let candidate = file + '.bak'
  let n = 2
  while (await exists(candidate)) candidate = `${file}.bak-${n++}`
  return candidate
}

let scanned = 0
const fixed = []
const alreadyOk = []
const unfixable = []
const skipped = []

async function walkCourses () {
  let names = []
  try { names = await readdir(COURSE_ROOT) } catch (err) {
    console.error(`[repair] 读不到课程库：${COURSE_ROOT}（${err.message}）`)
    console.error('[repair] 用 --root 指定课程库目录，或先在应用里确认它存在。')
    process.exit(1)
  }
  return names.filter((n) => IS_COURSE_ID.test(n)).sort()
}

async function repairFile (courseId, filePath, fileName) {
  scanned++
  const label = `${courseId}/content-assets/media/${fileName}`
  const raw = await readFile(filePath, 'utf8')
  if (isWellFormedSvg(raw)) { alreadyOk.push(label); return }
  const cleaned = sanitizeSvg(raw)
  if (!cleaned) { unfixable.push(label); return }
  if (!isWellFormedSvg(cleaned)) { unfixable.push(label); return }
  if (cleaned === raw) { alreadyOk.push(label); return }
  fixed.push({ label, file: filePath, cleaned, bytes: Buffer.byteLength(cleaned, 'utf8') })
  if (!write) return
  if (backup) await copyFile(filePath, await backupPath(filePath))
  await writeFile(filePath, cleaned, 'utf8')
}

const courses = await walkCourses()
for (const courseId of courses) {
  const dir = join(COURSE_ROOT, courseId, 'content-assets', 'media')
  let files = []
  try { files = await readdir(dir) } catch { continue }        // 这门课还没生成过内容
  files = files.filter((f) => f.toLowerCase().endsWith('.svg') && !f.includes('.bak')).sort()
  for (const f of files) {
    try {
      await repairFile(courseId, join(dir, f), f)
    } catch (err) {
      skipped.push(`${courseId}/content-assets/media/${f}（${err.message}）`)
    }
  }
}

/* ------------------------------------------------------------------ 报告 */

const line = (s) => console.log(s)
line(`[repair] 课程库：${COURSE_ROOT}`)
line(`[repair] 课程 ${courses.length} 门 · 扫描 SVG ${scanned} 个`)
line(`[repair] 已经合法（跳过）  ${alreadyOk.length}`)
line(`[repair] ${write ? '已修复' : '可修复（预演）'}  ${fixed.length}`)
for (const f of fixed) line(`   · ${f.label}（${(f.bytes / 1024).toFixed(1)} KB）`)
if (unfixable.length) {
  line(`[repair] 洗不出合法 XML（**未改动**，这些只能重新生成）  ${unfixable.length}`)
  for (const f of unfixable) line(`   ! ${f}`)
}
if (skipped.length) {
  line(`[repair] 读写出错  ${skipped.length}`)
  for (const f of skipped) line(`   ! ${f}`)
}
if (!write && fixed.length) line('[repair] 预演模式：加 --write 才会真正写回（会先备份 .bak）')
if (write && fixed.length) line(`[repair] 已写回${backup ? '（原文件备份为 .bak）' : '（未备份）'} —— 刷新学习页即可看到图`)
if (!scanned) line('[repair] 没有找到任何 SVG 媒体：课程可能还没生成过内容')
