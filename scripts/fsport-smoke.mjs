#!/usr/bin/env node
/**
 * 课程库文件端口冒烟（T-5）。
 *
 * 这里测的是**生产端口本身**（node:fs），不是替身：端口语义 = 真机语义，
 * 因此离线就能覆盖「缺目录 / 缺文件 / 建父目录 / 递归删除 / 相对路径拒绝」这些
 * 过去只有真机才暴露的行为（2026-10-16 真机实测：宿主 `ctx.fs` 写不进工作区外、
 * 且没有删除能力，故改为 node:fs —— 见 src/host/06-fs-port.mjs 的文件头）。
 */
import { mkdtemp, stat, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createNodeFsPort } from '../src/host/06-fs-port.mjs'

let pass = 0
let fail = 0
const ck = (n, ok, ev) => { ok ? pass++ : fail++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${ev ? '  → ' + ev : ''}`) }
const fails = async (fn, re) => { try { await fn(); return false } catch (e) { return re ? re.test(e.message) : true } }

const port = createNodeFsPort()
const root = await mkdtemp(join(tmpdir(), 'aic-fsport-'))

/* 绝对路径守卫：课程库不接受相对路径（否则会落到进程 cwd 下，位置不确定） */
ck('list 拒绝相对路径并点名方法', await fails(() => port.list('relative/dir'), /fs\.list 需要绝对路径/))
ck('readText 拒绝相对路径', await fails(() => port.readText('x.json'), /fs\.readText 需要绝对路径/))
ck('writeText 拒绝相对路径', await fails(() => port.writeText('x.json', 'x'), /fs\.writeText 需要绝对路径/))
ck('remove 拒绝相对路径', await fails(() => port.remove('dir'), /fs\.remove 需要绝对路径/))
ck('空串路径被拒（不是"当前目录"）', await fails(() => port.list(''), /需要绝对路径/))

/* 缺目录 = 空课程库，不是错误 */
ck('目录不存在时 list 回空数组（课程库为空 ≠ 出错）', JSON.stringify(await port.list(join(root, 'nope'))) === '[]')
ck('exists 对不存在的路径回 false（不抛）', (await port.exists(join(root, 'nope'))) === false)
ck('exists 对存在的目录回 true', (await port.exists(root)) === true)

/* 写：writeText 自建父目录（宿主 ctx.fs.writeText 也这样；node:fs.writeFile 不建，
   所以端口里统一兜住 —— 少了这一步就是「只在真机才炸」的一类 bug） */
const deep = join(root, 'c-1', 'content-assets', 'kp-01-01.md')
await port.writeText(deep, '# 正文\n')
ck('writeText 自动建父目录（无需 mkdir）', (await stat(deep)).isFile())
ck('readText 往返一致', (await port.readText(deep)) === '# 正文\n')
ck('原子写：目录里不留 .tmp-* 垃圾（正常路径）',
  (await port.list(join(root, 'c-1', 'content-assets'))).every((n) => !n.includes('.tmp-')), JSON.stringify(await port.list(join(root, 'c-1', 'content-assets'))))
ck('原子写：覆盖已有文件内容正确', await (async () => {
  const again = join(root, 'c-1', 'content-assets', 'kp-01-01.md')
  await port.writeText(again, '# 正文 v2\n')
  return (await port.readText(again)) === '# 正文 v2\n'
})())
ck('readText 缺文件抛错（错误码 ENOENT，由存储层决定按未生成处理）',
  await fails(() => port.readText(join(root, 'c-1', 'nope.md')), /ENOENT/))
ck('mkdir 幂等（已存在的目录不抛）', await (async () => { await port.mkdir(join(root, 'c-1')); await port.mkdir(join(root, 'c-1')); return true })())

/* list 只回名字（存储层据此挑出课程目录） */
await port.writeText(join(root, 'c-2', 'course.json'), '{}\n')
const names = await port.list(root)
ck('list 只回名字且按内容可见', names.sort().join(',') === 'c-1,c-2', names.join(','))

/* 删除课程 = 递归删除该目录（FR-10 / AC-13；宿主 fs 端口做不到这件事） */
await port.remove(join(root, 'c-1'))
ck('remove 递归删除整个课程目录', (await port.exists(join(root, 'c-1'))) === false)
ck('remove 目录不存在时不算错（幂等）', await (async () => { await port.remove(join(root, 'c-1')); return true })())
ck('删除一门课不影响其他课程', (await port.exists(join(root, 'c-2', 'course.json'))) === true)

/* 原子性说明：写入依赖 fs.writeFile（不是 tmp+rename），这里只钉住「写坏一半不会出现」的边界 */
await port.writeText(join(root, 'c-2', 'progress.json'), '{"kp":{}}\n')
ck('同目录多文件互不干扰', JSON.parse(await readFile(join(root, 'c-2', 'progress.json'), 'utf8')).kp !== undefined)

await rm(root, { recursive: true, force: true })
console.log(`\n${fail ? fail + ' 项失败' : '全部通过'}   （PASS ${pass} / FAIL ${fail}）`)
process.exit(fail ? 1 : 0)
