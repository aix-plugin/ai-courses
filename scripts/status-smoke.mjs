#!/usr/bin/env node
/**
 * 主会话实时状态（`/ai-course` 命令卡片的数据面）冒烟。
 *
 * 覆盖两件事：
 *   ① `createStatusStore` 的生命周期与**健壮性**（状态只是观测面，坏了不能影响推导）
 *   ② `runCourseDerivation` 真的按阶段写状态（start → derived → saving → finish/fail），
 *      并且写入的状态里**不含**课程正文（只回摘要字段）
 */
import { mkdtemp, mkdir, readFile, writeFile, readdir, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createStore } from '../src/host/20-store.mjs'
import { createCourseApi } from '../src/host/30-courses.mjs'
import { createStatusStore } from '../src/host/15-status.mjs'
import { runCourseDerivation } from '../src/host/10-prompt.mjs'

let pass = 0, fail = 0
const ck = (n, ok, ev) => { ok ? pass++ : fail++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${ev ? '  → ' + ev : ''}`) }

const fsPort = {
  join: (...p) => join(...p), readText: (p) => readFile(p, 'utf8'),
  writeText: async (p, s) => { await mkdir(join(p, '..'), { recursive: true }); await writeFile(p, s, 'utf8') },
  mkdir: async (p) => { if (p) await mkdir(p, { recursive: true }) },
  list: (p) => readdir(p), exists: async (p) => { try { await stat(p); return true } catch { return false } },
  remove: (p) => rm(p, { recursive: true, force: true }),
}

/* --- ① 状态表本身 --- */
let clock = 1000
const store = createStatusStore({ now: () => clock })
ck('没有记录时 read → null', store.read('s1') === null)
ck('对没有记录的会话 step/finish/fail 都不抛（也不造记录）', (() => {
  store.step('nope', 'x', 'y'); store.finish('nope', {}); store.fail('nope', 'e')
  return store.read('nope') === null
})())

store.start('s1', { commandId: 'cmd-1', request: '用 3 章讲 RSC' })
const started = store.read('s1')
ck('start 后 phase=running 且带回 commandId', started.phase === 'running' && started.commandId === 'cmd-1')
ck('start 后 startedAt/updatedAt 都写了', started.startedAt === 1000 && started.updatedAt === 1000)
ck('start 记下了诉求（截断后的摘要）', started.request === '用 3 章讲 RSC')

clock = 1500
store.step('s1', 'derived', '已拿到课程结构，正在校验')
const stepped = store.read('s1')
ck('step 推进阶段并刷新 updatedAt', stepped.key === 'derived' && stepped.updatedAt === 1500 && stepped.phase === 'running')
ck('step 保留 commandId 与 startedAt（不覆盖成新记录）', stepped.commandId === 'cmd-1' && stepped.startedAt === 1000)

clock = 2000
store.finish('s1', { courseId: 'c-1', courseName: 'RSC 入门', chapterCount: 3, kpCount: 11 })
const done = store.read('s1')
ck('finish 后 phase=done 且带回课程摘要', done.phase === 'done' && done.courseId === 'c-1' && done.courseName === 'RSC 入门')
ck('finish 带回规模计数', done.chapterCount === 3 && done.kpCount === 11)
ck('finish 后 updatedAt 是结束时间', done.updatedAt === 2000)

/* 大纲卡片的判据：会话里**生成过哪些课**（含落库时间），不止「最近一门」 */
ck('start 时课程列表是空的（还没落库）', started.courses.length === 0)
ck('finish 把课程追加进会话课程列表', done.courses.length === 1 && done.courses[0].courseId === 'c-1')
ck('课程条目带落库时间（卡片按它判回合）', done.courses[0].updatedAt === 2000)
ck('最近一门课的摘要与列表末项一致', done.courseId === done.courses[done.courses.length - 1].courseId)

clock = 2500
store.start('s1', { commandId: 'cmd-2', request: '再讲一门' })
store.finish('s1', { courseId: 'c-2', courseName: '第二门', chapterCount: 1, kpCount: 2 })
const twice = store.read('s1')
ck('同一会话连做两次 → 两门课都在列表里（按落库顺序）',
  twice.courses.length === 2 && twice.courses[0].courseId === 'c-1' && twice.courses[1].courseId === 'c-2',
  twice.courses.map((c) => c.courseId).join(','))
ck('最近一门摘要跟着更新', twice.courseId === 'c-2' && twice.courseName === '第二门')
ck('旧课的落库时间不被改写（回合筛选要精确）', twice.courses[0].updatedAt === 2000 && twice.courses[1].updatedAt === 2500)

/* 上限：长会话不会把课程列表撑大（只留最近 N 门）。
   用一个独立的状态表跑，免得污染上面用例里的 s1/s2 断言。 */
const capStore = createStatusStore({ now: () => clock })
for (let i = 1; i <= 25; i++) {
  capStore.start('long', { commandId: 'cmd-' + i })
  capStore.finish('long', { courseId: 'c-' + i, courseName: 'C' + i, chapterCount: 1, kpCount: 1 })
}
const capped = capStore.read('long')
ck('课程列表有上限（不会无限增长）', capped.courses.length <= 20 && capped.courses[capped.courses.length - 1].courseId === 'c-25', String(capped.courses.length))

clock = 3000
store.start('s2', { commandId: 'cmd-2' })
store.fail('s2', '限流：请稍后重试')
const failed = store.read('s2')
ck('fail 后 phase=error 且带可读原因', failed.phase === 'error' && /限流/.test(failed.error))

/* 会话之间互不串台：s1 有两门课、s2 只有失败状态（没有课程） */
ck('两个会话各自一条、互不影响',
  store.read('s1').courseName === '第二门' && store.read('s1').courses.length === 2 && store.read('s2').courses.length === 0)

/* 淘汰：ttl 过期即删除（读取不回过期记录） */
const t0 = 500000
clock = t0
const store2 = createStatusStore({ now: () => clock, ttlMs: 100 })
store2.start('old', {})
ck('未过期时能读到', store2.read('old') !== null)
clock = t0 + 101
ck('过期记录被淘汰（读取回 null）', store2.read('old') === null)

/* 上限：条目数不会无限增长 */
const store3 = createStatusStore({ now: () => clock, limit: 3 })
for (let i = 0; i < 6; i++) store3.start('sess-' + i, {})
ck('超过上限时淘汰最早的一条', store3.read('sess-0') === null && store3.read('sess-5') !== null)

/* 坏输入不该抛（观测面失败不能影响推导） */
ck('sessionId 为空时静默跳过', (() => { store.start('', {}); store.start(null, {}); return true })())
ck('坏状态字段不抛（例如 undefined 的 now）', (() => { try { createStatusStore({ now: () => 0 }).start('x', {}); return true } catch { return false } })())

/* --- ② 推导链路真的按阶段写状态 --- */
const root = await mkdtemp(join(tmpdir(), 'aic-status-'))
const courses = createCourseApi({ store: createStore({ fs: fsPort, root }), now: () => new Date('2026-10-16T10:00:00Z') })
const live = createStatusStore()
const good = { name: 'C', outline: { chapters: [{ name: '第一章', knowledgePoints: [{ name: 'K1', contentType: '图文', duration: 12 }] }] } }

const runOk = await runCourseDerivation({
  deps: { courses, status: live },
  request: '用 1 章讲 A',
  sessionId: 'sess-ok',
  commandId: 'cmd-ok',
  derive: async () => JSON.stringify(good),
})
const stOk = live.read('sess-ok')
ck('推导成功 → 状态为 done', runOk.kind === 'success' && stOk.phase === 'done')
ck('成功状态带回 courseId 与课程名', stOk.courseId === runOk.courseId && stOk.courseName === 'C')
ck('成功状态带回章节/知识点计数', stOk.chapterCount === 1 && stOk.kpCount === 1)
ck('成功状态绑定的是一次调用自己的 commandId', stOk.commandId === 'cmd-ok')

const live2 = createStatusStore()
const runBad = await runCourseDerivation({
  deps: { courses, status: live2 }, request: 'x', sessionId: 'sess-bad', commandId: 'cmd-bad',
  derive: async () => '不是 JSON',
})
const stBad = live2.read('sess-bad')
ck('回包不合法 → 状态为 error（卡片能显示失败）', runBad.kind === 'error' && stBad.phase === 'error')
ck('失败原因进了状态（前端可直接显示）', /JSON|结构/.test(stBad.error), stBad.error)

const live3 = createStatusStore()
const runThrow = await runCourseDerivation({
  deps: { courses, status: live3 }, request: 'x', sessionId: 'sess-throw', commandId: 'cmd-throw',
  derive: async () => { throw new Error('限流') },
})
ck('模型抛错 → 状态为 error 且原因是原文', runThrow.kind === 'error' && /限流/.test(live3.read('sess-throw').error))

/* 没传 status（旧调用方/别的宿主）时，推导照常成功 —— 状态是可选观测面 */
const runNoStatus = await runCourseDerivation({ deps: { courses }, request: 'x', derive: async () => JSON.stringify(good) })
ck('没有 status 依赖时推导照常成功（可选观测面）', runNoStatus.kind === 'success')

/* 状态里不含课程正文：只回摘要字段（卡片只需要这些） */
const keys = Object.keys(stOk).sort().join(',')
ck('状态是固定字段集合（没有夹带正文/大纲）', !/outline|chapters|content|markdown/.test(keys), keys)

await rm(root, { recursive: true, force: true })

console.log(`\n全部通过   （PASS ${pass} / FAIL ${fail}）`)
process.exit(fail ? 1 : 0)
