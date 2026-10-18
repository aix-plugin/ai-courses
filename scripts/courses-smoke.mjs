#!/usr/bin/env node
/** T-7 冒烟：层级约束、拒绝路径、修订事务、进度剪枝、可读标签。 */
import { mkdtemp, mkdir, readFile, writeFile, readdir, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createStore } from '../src/host/20-store.mjs'
import { createCourseApi, assertCourse, CourseError, humanizeRef, truncateName } from '../src/host/30-courses.mjs'
import { applyOutlineOp, removedKpIds } from '../src/host/50-methods.mjs'
import { DEFERRED_TYPES, SUPPORTED_TYPES } from '../src/host/05-constants.mjs'

let pass = 0, fail = 0
const ck = (n, ok, ev) => { ok ? pass++ : fail++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${ev ? '  → ' + ev : ''}`) }
const throws = async (fn, code) => { try { await fn(); return false } catch (e) { return code ? e.code === code : true } }

const fsPort = {
  join: (...p) => join(...p),
  readText: (p) => readFile(p, 'utf8'),
  writeText: async (p, s) => { await mkdir(join(p, '..'), { recursive: true }); await writeFile(p, s, 'utf8') },
  mkdir: async (p) => { if (p) await mkdir(p, { recursive: true }) },
  list: (p) => readdir(p),
  exists: async (p) => { try { await stat(p); return true } catch { return false } },
  remove: (p) => rm(p, { recursive: true, force: true }),
}
const root = await mkdtemp(join(tmpdir(), 'aic-t7-'))
const store = createStore({ fs: fsPort, root })
const api = createCourseApi({ store, now: () => new Date('2026-10-13T16:00:00Z') })

const good = () => ({
  name: 'RSC 入门', description: '三章', difficulty: '中级', category: '前端', tags: ['React'],
  outline: { chapters: [
    { id: 'ch-01', order: 1, name: '为什么', knowledgePoints: [
      { id: 'kp-01-01', order: 1, name: 'CSR 与 SSR', contentType: '图文', duration: 12 },
      { id: 'kp-01-02', order: 2, name: '水合', contentType: '幻灯片', duration: 8 } ] },
    { id: 'ch-02', order: 2, name: '边界', knowledgePoints: [
      { id: 'kp-02-01', order: 1, name: 'use client', contentType: '图文', duration: 15 } ] } ] },
})

/* --- 约束：拒绝路径 --- */
ck('合法课程通过校验', assertCourse(good()) === true)
ck('无章节被拒', await throws(() => assertCourse({ name: 'x', outline: { chapters: [] } }), 'invalid-outline'))
ck('章节 order 不连续被拒', await throws(() => assertCourse({ ...good(), outline: { chapters: [{ ...good().outline.chapters[0], order: 2 }] } }), 'invalid-outline'))
ck('空章节（0 个知识点）被拒', await throws(() => assertCourse({ name: 'x', outline: { chapters: [{ id: 'c', order: 1, name: 'c', knowledgePoints: [] }] } }), 'invalid-outline'))
ck('知识点 order 必须**本章内**从 1 连续',
  await throws(() => { const c = good(); c.outline.chapters[1].knowledgePoints[0].order = 5; return assertCourse(c) }, 'invalid-outline'))
ck('contentType 非法被拒', await throws(() => { const c = good(); c.outline.chapters[0].knowledgePoints[0].contentType = '播客'; return assertCourse(c) }, 'invalid-outline'))
/* duration 现在**允许缺省**（大纲阶段不估计时长，内容生成后按正文回填）——旧断言反过来 */
ck('duration 缺失**被接受**（大纲阶段不估计时长）',
  !(await throws(() => { const c = good(); delete c.outline.chapters[0].knowledgePoints[0].duration; return assertCourse(c) })))
ck('duration 一旦有值就仍要合法（0 被拒）',
  await throws(() => { const c = good(); c.outline.chapters[0].knowledgePoints[0].duration = 0; return assertCourse(c) }, 'invalid-outline'))
ck('duration 非正整数被拒（0 / 负数 / 小数）',
  await throws(() => { const c = good(); c.outline.chapters[0].knowledgePoints[0].duration = 0; return assertCourse(c) }) &&
  await throws(() => { const c = good(); c.outline.chapters[0].knowledgePoints[0].duration = -3; return assertCourse(c) }) &&
  await throws(() => { const c = good(); c.outline.chapters[0].knowledgePoints[0].duration = 1.5; return assertCourse(c) }))
ck('难度非法被拒', await throws(() => assertCourse({ ...good(), difficulty: '大师' }), 'invalid-outline'))
ck('课程名超 60 字被拒', await throws(() => assertCourse({ ...good(), name: 'x'.repeat(61) }), 'invalid-outline'))

/* --- 拒绝路径**不落库**（关键：不是"尽力而为"） --- */
const before = (await readdir(root)).length
await throws(() => api.create({ ...good(), outline: { chapters: [] } }))
ck('校验失败时不落库（目录数不变）', (await readdir(root)).length === before, `${before} → ${(await readdir(root)).length}`)

/* --- create / read / list --- */
const course = await api.create(good())
ck('create 返回带 id 的课程', /^c-\d{14}-[0-9a-f]{4}$/.test(course.id), course.id)
ck('create 同时写入空的 progress.json',
  JSON.stringify(JSON.parse(await readFile(join(store.courseDir(course.id), 'progress.json'), 'utf8')).kp) === '{}')
ck('read 往返一致', (await api.read(course.id)).course.name === 'RSC 入门')
ck('read 非法 id 抛 bad-course-id', await throws(() => api.read('../../etc'), 'bad-course-id'))
ck('read 不存在的课程回 null', (await api.read('c-20260101000000-aaaa')) === null)
ck('list 含新建课程', (await api.list()).some((c) => c.id === course.id))

/* --- 列表摘要 / 读课程带进度：卡片进度与行内「已完成」勾的数据来源（06 §3.2 / §4.2） --- */
await store.writeProgress(course.id, { kp: { 'kp-01-01': '已掌握', 'kp-01-02': '已掌握', 'kp-02-01': '进行中', 'kp-99-99': '已掌握' } })
const summaries = await api.listSummaries()
const mine = summaries.filter((r) => r.id === course.id)[0]
ck('listSummaries 回知识点总数（孤儿进度键不计入）', mine && mine.kpTotal === 3, mine && String(mine.kpTotal))
ck('listSummaries 回已掌握数', mine && mine.kpMastered === 2, mine && String(mine.kpMastered))
ck('listSummaries 保留 course 本体（/ai-course 查重路径仍可用）', !!(mine && mine.course && mine.course.outline))
const readBack = await api.read(course.id)
ck('read 一并回知识点层进度', readBack.kpProgress['kp-01-01'] === '已掌握' && readBack.kpProgress['kp-02-01'] === '进行中',
  JSON.stringify(readBack.kpProgress))

/* --- reviseOutline：事务 + 校验 + 进度剪枝 --- */
await store.writeProgress(course.id, { kp: { 'kp-01-01': '已掌握', 'kp-01-02': '进行中', 'kp-99-99': '已掌握' } })
const revised = await api.reviseOutline(course.id, (c) => {
  c.outline.chapters[0].knowledgePoints.splice(1, 1)          // 删掉 kp-01-02
  c.name = 'RSC 入门（改）'
  return c
})
ck('修订后课程已改名', revised.name === 'RSC 入门（改）')
ck('修订已落库', (await api.read(course.id)).course.name === 'RSC 入门（改）')
const prog = JSON.parse(await readFile(join(store.courseDir(course.id), 'progress.json'), 'utf8'))
ck('删掉的知识点进度被剪枝', prog.kp['kp-01-02'] === undefined && prog.kp['kp-01-01'] === '已掌握', JSON.stringify(prog.kp))
ck('孤儿键（不属于任何知识点）也被剪掉', prog.kp['kp-99-99'] === undefined, JSON.stringify(prog.kp))

const nameBefore = (await api.read(course.id)).course.name
ck('修订校验失败时**不改库**',
  (await throws(() => api.reviseOutline(course.id, (c) => { c.outline.chapters = []; return c }), 'invalid-outline')) &&
  (await api.read(course.id)).course.name === nameBefore)
ck('修订不存在的课程抛 not-found', await throws(() => api.reviseOutline('c-20260101000000-aaaa', (c) => c), 'not-found'))

/* --- 可读标签（与 06 §4.4 同规则） --- */
const c2 = (await api.read(course.id)).course
ck('course 范围 → 课程名（≤16 字，超长截断）', humanizeRef({ name: 'x'.repeat(30), outline: { chapters: [] } }, 'course', []) === 'x'.repeat(16) + '…')
ck('chapter 范围 → 章节编号-名称', humanizeRef(c2, 'chapter', ['ch-02']) === '2-边界', humanizeRef(c2, 'chapter', ['ch-02']))
ck('kp 范围 → 知识点编号-名称', humanizeRef(c2, 'kp', ['kp-02-01']) === '2.1-use client', humanizeRef(c2, 'kp', ['kp-02-01']))
ck('找不到目标时退回 id（不静默空白）', humanizeRef(c2, 'chapter', ['ch-99']) === 'ch-99')
ck('truncateName 不超长时不截断', truncateName('短名') === '短名')

/* --- 类型分档 --- */
ck('v1 只支持两种类型', SUPPORTED_TYPES.join(',') === '图文,幻灯片', SUPPORTED_TYPES.join(','))
ck('其余四种进 DEFERRED', DEFERRED_TYPES.join(',') === '音频,视频,代码,测验', DEFERRED_TYPES.join(','))

/* --- 大纲修订动作（50-methods 的 applyOutlineOp）：界面上的「编辑弹窗 + 结构按钮」走的就是它们 --- */
const draft = () => good()
ck('setCategory 生效', (() => { const c = draft(); applyOutlineOp(c, { op: 'setCategory', value: '系统' }); return c.category === '系统' })())
ck('setCategory 超 40 字被截断', (() => { const c = draft(); applyOutlineOp(c, { op: 'setCategory', value: 'x'.repeat(60) }); return c.category.length === 40 })())
ck('setTags 接受顿号 / 全角逗号 / 逗号 / 空格',
  (() => { const c = draft(); applyOutlineOp(c, { op: 'setTags', value: 'React、SSR，前端, RSC 水合' }); return c.tags.join('|') === 'React|SSR|前端|RSC|水合' })(),
  (() => { const c = draft(); applyOutlineOp(c, { op: 'setTags', value: 'React、SSR' }); return c.tags.join('|') })())
ck('setTags 最多 20 个', (() => { const c = draft(); applyOutlineOp(c, { op: 'setTags', value: Array.from({ length: 30 }, (_, i) => 't' + i).join(',') }); return c.tags.length === 20 })())
ck('addChapter 单独用会被校验拒绝（新章节是空的，05 §3 要求每章 ≥1 个知识点）',
  (() => {
    const c = draft()
    applyOutlineOp(c, { op: 'addChapter', value: 'ch-03' })
    try { assertCourse(c); return false } catch (e) { return e.code === 'invalid-outline' }
  })())
ck('addChapter + addKp 同批提交才合法（界面就是这么发的）',
  (() => {
    const c = draft()
    applyOutlineOp(c, { op: 'addChapter', value: 'ch-03' })
    applyOutlineOp(c, { op: 'addKp', chapterId: 'ch-03', value: '新知识点' })
    /* 新知识点**不带时长**（大纲阶段不估计；内容生成后回填），所以这里不再断言 duration */
    return assertCourse(c) === true && c.outline.chapters.length === 3 &&
      c.outline.chapters[2].knowledgePoints.length === 1 &&
      c.outline.chapters[2].knowledgePoints[0].duration === undefined
  })())
ck('moveKp 用 index 表达目标位置（第 1 个移到末尾）',
  (() => { const c = draft(); applyOutlineOp(c, { op: 'moveKp', chapterId: 'ch-01', kpId: 'kp-01-01', index: 2 }); return c.outline.chapters[0].knowledgePoints.map((k) => k.id).join(',') === 'kp-01-02,kp-01-01' })())
ck('moveKp 后 order 重新编号（连续）',
  (() => { const c = draft(); applyOutlineOp(c, { op: 'moveKp', chapterId: 'ch-01', kpId: 'kp-01-01', index: 2 }); return c.outline.chapters[0].knowledgePoints.map((k) => k.order).join(',') === '1,2' })())
ck('moveChapter 用 index 表达目标位置',
  (() => { const c = draft(); applyOutlineOp(c, { op: 'moveChapter', chapterId: 'ch-01', index: 2 }); return c.outline.chapters.map((x) => x.id).join(',') === 'ch-02,ch-01' })())
ck('removeKp 生效且 order 重排',
  (() => { const c = draft(); applyOutlineOp(c, { op: 'removeKp', chapterId: 'ch-01', kpId: 'kp-01-01' }); return c.outline.chapters[0].knowledgePoints.length === 1 && c.outline.chapters[0].knowledgePoints[0].order === 1 })())
/* --- addChapter / addKp 的插入位置（index）：大纲页「在本章后 / 在本知识点后新增」用它 --- */
ck('addChapter 带 index → 插到指定位置（不是永远追加）',
  (() => {
    const c = draft()
    applyOutlineOp(c, { op: 'addChapter', value: 'ch-03', index: 1 })
    applyOutlineOp(c, { op: 'addKp', chapterId: 'ch-03', value: '新知识点' })
    const ids = c.outline.chapters.map((x) => x.id)
    /* draft 是 [ch-01, ch-02]；插到 index 1 → [ch-01, ch-03, ch-02] */
    return ids.join(',') === 'ch-01,ch-03,ch-02'
  })())
ck('addChapter 插到中间后 order 重新编号（连续 1..n）',
  (() => {
    const c = draft()
    applyOutlineOp(c, { op: 'addChapter', value: 'ch-03', index: 1 })
    applyOutlineOp(c, { op: 'addKp', chapterId: 'ch-03', value: '新知识点' })
    return c.outline.chapters.map((x) => x.order).join(',') === '1,2,3' &&
      c.outline.chapters[1].id === 'ch-03'
  })())
ck('addChapter 的 index 越界会被夹住（不抛、不产生空洞）',
  (() => {
    const c = draft()
    applyOutlineOp(c, { op: 'addChapter', value: 'ch-03', index: 99 })
    applyOutlineOp(c, { op: 'addKp', chapterId: 'ch-03', value: '新知识点' })
    return c.outline.chapters.length === 3 && c.outline.chapters[2].id === 'ch-03'
  })())
ck('addKp 带 index → 插到章内指定位置',
  (() => {
    const c = draft()
    applyOutlineOp(c, { op: 'addKp', chapterId: 'ch-01', value: '新知识点', index: 1 })
    const kps = c.outline.chapters[0].knowledgePoints
    /* draft 的 ch-01 是 [kp-01-01, kp-01-02]；插到 index 1 → 新点在第 2 位 */
    return kps.length === 3 && kps[0].id === 'kp-01-01' && kps[1].name === '新知识点' && kps[2].id === 'kp-01-02'
  })())
ck('addKp 插到中间后章内 order 重新编号（连续 1..n）',
  (() => {
    const c = draft()
    applyOutlineOp(c, { op: 'addKp', chapterId: 'ch-01', value: '新知识点', index: 1 })
    return c.outline.chapters[0].knowledgePoints.map((k) => k.order).join(',') === '1,2,3'
  })())

ck('未知 op 被拒（不静默忽略）',
  (() => { const c = draft(); try { applyOutlineOp(c, { op: 'rm -rf' }); return false } catch (e) { return e.code === 'invalid-input' } })())
ck('引用不存在的章节被拒',
  (() => { const c = draft(); try { applyOutlineOp(c, { op: 'renameChapter', chapterId: 'ch-99', value: 'x' }); return false } catch (e) { return e.code === 'not-found' } })())
ck('难度非法被拒（弹窗下拉只给三个合法值）',
  (() => { const c = draft(); try { applyOutlineOp(c, { op: 'setDifficulty', value: '大师' }); return false } catch (e) { return e.code === 'invalid-outline' } })())

/* --- P0-1：删除后新增不能产生重复 id --- */
ck('删除中间章节后新增：请求的重复 id 被改名，同批 addKp 跟到新章节',
  (() => {
    const c = draft()
    applyOutlineOp(c, { op: 'removeChapter', chapterId: 'ch-01' })
    const batch = { idMap: new Map() }
    /* 客户端此时只会剩 ch-02，nextChapterId 会再次给出 ch-02（重复） */
    applyOutlineOp(c, { op: 'addChapter', value: 'ch-02' }, batch)
    applyOutlineOp(c, { op: 'addKp', chapterId: 'ch-02', value: '新知识点' }, batch)
    const ids = c.outline.chapters.map((x) => x.id)
    return ids.join(',') === 'ch-02,ch-03' &&
      new Set(ids).size === ids.length &&
      c.outline.chapters[0].knowledgePoints.length === 1 &&
      c.outline.chapters[1].knowledgePoints.length === 1 &&
      c.outline.chapters[1].knowledgePoints[0].id === 'kp-03-01'
  })())

ck('删除中间知识点后新增：id 取最大后缀 +1，不与已有 id 撞车',
  (() => {
    const c = draft()
    applyOutlineOp(c, { op: 'removeKp', chapterId: 'ch-01', kpId: 'kp-01-01' })
    applyOutlineOp(c, { op: 'addKp', chapterId: 'ch-01', value: '新知识点' })
    const ids = c.outline.chapters[0].knowledgePoints.map((x) => x.id)
    return ids.join(',') === 'kp-01-02,kp-01-03' && new Set(ids).size === ids.length
  })())

ck('章节号从章节 id 解析（ch-100 → kp-100-01），不用 id 末两位',
  (() => {
    const c = {
      name: 'x', description: '', difficulty: '入门', category: '', tags: [],
      outline: { chapters: [{ id: 'ch-100', order: 100, name: '百章', knowledgePoints: [] }] },
    }
    applyOutlineOp(c, { op: 'addKp', chapterId: 'ch-100', value: '第一个' })
    return c.outline.chapters[0].knowledgePoints[0].id === 'kp-100-01'
  })())

/* --- P1-8：大纲修订前后差出被删的知识点（供级联清理资产） --- */
ck('removedKpIds：删知识点被差出来', (() => {
  const before = draft()
  const after = JSON.parse(JSON.stringify(before))
  applyOutlineOp(after, { op: 'removeKp', chapterId: 'ch-01', kpId: 'kp-01-01' })
  return removedKpIds(before, after).join(',') === 'kp-01-01'
})())
ck('removedKpIds：删章节把整章知识点都差出来', (() => {
  const before = draft()
  const after = JSON.parse(JSON.stringify(before))
  applyOutlineOp(after, { op: 'removeChapter', chapterId: 'ch-01' })
  return removedKpIds(before, after).sort().join(',') === 'kp-01-01,kp-01-02'
})())
ck('removedKpIds：纯改名不改知识点 → 空', (() => {
  const before = draft()
  const after = JSON.parse(JSON.stringify(before))
  after.name = '改名'
  return removedKpIds(before, after).length === 0
})())

/* --- P0-2：setDuration / setSources 走事务 + 只读守卫 --- */
const concurrent = await api.create(good())
await Promise.all([
  api.reviseOutline(concurrent.id, (c) => { c.name = '并发改名'; return c }),
  api.setDuration(concurrent.id, 'kp-01-01', 20),
])
const afterConcurrent = (await api.read(concurrent.id)).course
ck('并发「修订大纲」与「回填时长」两边都保留（不丢更新）',
  afterConcurrent.name === '并发改名' &&
  afterConcurrent.outline.chapters[0].knowledgePoints[0].duration === 20,
  `${afterConcurrent.name} / ${afterConcurrent.outline.chapters[0].knowledgePoints[0].duration}`)

const future = await api.create(good())
/* 手工写成更高 schemaVersion，模拟「更高版本写入」的课程 */
await writeFile(join(root, future.id, 'course.json'), JSON.stringify({ ...future, schemaVersion: 999 }, null, 2) + '\n')
ck('更高版本课程：setDuration 拒绝且不改文件',
  await throws(() => api.setDuration(future.id, 'kp-01-01', 30), 'read-only'))
ck('更高版本课程：setSources 拒绝',
  await throws(() => api.setSources(future.id, ['docs/x.md']), 'read-only'))
ck('更高版本课程：remove 拒绝（不可逆操作不能由旧版本做）',
  await throws(() => api.remove(future.id), 'read-only'))

/* --- P0-5：内容里的引用只能读允许根；用户引用不受此限 --- */
/* 没有 sandboxPolicy 时，内容引用的基准是课程库；在课程库下放一份文档来验证允许路径 */
await mkdir(join(root, 'docs'), { recursive: true })
await writeFile(join(root, 'docs', 'x.md'), '参考资料正文\n', 'utf8')
const allowedRead = await api.readSource('./docs/x.md', { allowExternal: false })
ck('内容引用：课程库/工作区内的文本文件允许读（相对路径以课程库为基准）',
  allowedRead.ok === true && /参考资料正文/.test(allowedRead.text || ''), allowedRead.error)
const deniedHome = await api.readSource('~/Documents/notes.md', { allowExternal: false })
ck('内容引用：家目录路径被拒（提示注入不能把 ~/.config 读进 prompt）',
  deniedHome.ok === false && /允许根/.test(deniedHome.error || ''), deniedHome.error)
const deniedConfig = await api.readSource('~/.config/x.json', { allowExternal: false })
ck('内容引用：~/.config 被拒', deniedConfig.ok === false && /允许根/.test(deniedConfig.error || ''), deniedConfig.error)
const userRead = await api.readSource('~/.config/x.json', { allowExternal: true })
ck('用户主动引用不受允许根限制（读不到也只是文件不存在，不是 allowlist 拒绝）',
  userRead.ok === false && !/允许根/.test(userRead.error || ''), userRead.error)

await rm(root, { recursive: true, force: true })
console.log(`\n${fail ? fail + ' 项失败' : '全部通过'}   （PASS ${pass} / FAIL ${fail}）`)
process.exit(fail ? 1 : 0)
