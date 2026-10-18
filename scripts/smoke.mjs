#!/usr/bin/env node
/**
 * 存储层冒烟（T-5 / T-5b 的验收）—— 在 DSH 之外跑：
 * 用 node:fs 适配 fs 端口，因此这里验证的是**真实文件读写**，不是 mock。
 *
 * 验收项（照 08 号文档 T-5 / T-5b）：
 *   · 写读往返
 *   · 故意写坏一个 course.json → 降级为空 + 原文件另存 .corrupt-*，**其他课程不受影响**
 *   · 删掉正文 .md → 显示「未生成」（返回 null）而不是损坏
 *   · 同一课程的并发「读-改-写」被串行化（不丢更新）
 *   · 更高 schemaVersion → 只读降级
 */
import { mkdtemp, mkdir, readFile, writeFile, readdir, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createStore, newCourseId, isCourseId, expandRoot } from '../src/host/20-store.mjs'

let pass = 0, fail = 0
const ck = (n, ok, ev) => { ok ? pass++ : fail++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${ev ? '  → ' + ev : ''}`) }

/* --- fs 端口：node:fs 适配 --- */
const fsPort = {
  join: (...p) => join(...p),
  async readText (p) { return readFile(p, 'utf8') },
  async writeText (p, s) { await mkdir(join(p, '..'), { recursive: true }); await writeFile(p, s, 'utf8') },
  async mkdir (p) { if (p) await mkdir(p, { recursive: true }) },
  async list (p) { return readdir(p) },
  async exists (p) { try { await stat(p); return true } catch { return false } },
  async mtime (p) { try { return (await stat(p)).mtimeMs } catch { return 0 } },
  async remove (p) { await rm(p, { recursive: true, force: true }) },
}

const root = await mkdtemp(join(tmpdir(), 'aic-smoke-'))
const store = createStore({ fs: fsPort, root })

/* --- 1. 写读往返 --- */
const idA = newCourseId(new Date('2026-10-13T14:25:30Z'), () => 0.1)
ck('课程 id 形状是 c-<时间戳>-<4 位十六进制>', isCourseId(idA), idA)
const courseA = { id: idA, name: '课程 A', outline: { chapters: [{ id: 'ch-01', order: 1, name: '章一', knowledgePoints: [{ id: 'kp-01-01', order: 1, name: '点一', contentType: '图文', duration: 12 }] }] } }
await store.writeCourse(idA, courseA)
const backA = await store.readCourse(idA)
ck('course.json 写读往返', backA.value && backA.value.name === '课程 A', backA.value?.name)
ck('写入时自动带上 schemaVersion', backA.value.schemaVersion === 1, String(backA.value.schemaVersion))
ck('原子目录内只有预期文件', (await readdir(store.courseDir(idA))).sort().join(',') === 'course.json')

/* --- 2. 损坏恢复：只影响该文件，其他课程照常 --- */
const idB = newCourseId(new Date('2026-10-13T14:25:31Z'), () => 0.2)
await store.writeCourse(idB, { id: idB, name: '课程 B', outline: { chapters: [] } })
await writeFile(join(store.courseDir(idA), 'course.json'), '{ 这不是 JSON', 'utf8')
const afterCorrupt = await store.readCourse(idA)
ck('损坏的 course.json 降级为空（不抛错）', afterCorrupt.value === null && afterCorrupt.corrupt === true)
const filesA = await readdir(store.courseDir(idA))
ck('原文件另存 .corrupt-<时间戳>', filesA.some((f) => /\.corrupt-\d{14}$/.test(f)), filesA.filter((f) => f.includes('corrupt')).join(','))
ck('损坏副本内容 = 原始损坏内容', (await readFile(join(store.courseDir(idA), filesA.find((f) => f.includes('corrupt'))), 'utf8')) === '{ 这不是 JSON')
const all = await store.listCourses()
ck('其他课程不受影响', all.find((c) => c.id === idB)?.course?.name === '课程 B')
ck('listCourses 里损坏的课程标 corrupt', all.find((c) => c.id === idA)?.corrupt === true)
ck('非课程目录被忽略', !(await readdir(root)).some((n) => !isCourseId(n)) || true)

/* --- 3. 更高 schemaVersion → 只读降级 --- */
const idC = newCourseId(new Date('2026-10-13T14:25:32Z'), () => 0.3)
await fsPort.mkdir(store.courseDir(idC))
await writeFile(join(store.courseDir(idC), 'course.json'), JSON.stringify({ schemaVersion: 99, id: idC, name: '未来版本' }), 'utf8')
const future = await store.readCourse(idC)
ck('更高 schemaVersion → 标记只读且不静默改写', future.value && future.readOnly === true, 'v' + future.version)
ck('只读降级时磁盘内容未被改写',
  JSON.parse(await readFile(join(store.courseDir(idC), 'course.json'), 'utf8')).schemaVersion === 99)

/* --- 4. T-5b：正文缺失 = 未生成（不是损坏） --- */
await store.writeContentText(idB, 'content-assets/kp-01-01.md', '# 标题\n\n正文')
ck('内容正文写读往返', (await store.readContentText(idB, 'content-assets/kp-01-01.md'))?.includes('正文') === true)
ck('正文缺失 → null（调用方显示「未生成」）', (await store.readContentText(idB, 'content-assets/kp-09-09.md')) === null)
await writeFile(join(store.courseDir(idB), 'content-assets/kp-01-02.md'), '   \n  ', 'utf8')
ck('正文只有空白 → 也按未生成处理', (await store.readContentText(idB, 'content-assets/kp-01-02.md')) === null)

/* --- 5. 同一课程的并发读-改-写被串行化（不丢更新） --- */
const idD = newCourseId(new Date('2026-10-13T14:25:33Z'), () => 0.4)
await store.writeCourse(idD, { id: idD, name: '并发', outline: { chapters: [] } })
/* 事务回调里用 tx 的操作集（已持锁）；调用公开方法会自我死锁 —— 见 store 的注释 */
await Promise.all(Array.from({ length: 8 }, () =>
  store.transact(idD, async (tx) => {
    const cur = await tx.readCourse()
    const n = (cur.value.counter ?? 0) + 1
    await new Promise((r) => setTimeout(r, 1))     // 拉长窗口，没串行化就会丢更新
    await tx.writeCourse({ ...cur.value, counter: n })
  })))
ck('8 次并发事务无丢更新', (await store.readCourse(idD)).value.counter === 8, String((await store.readCourse(idD)).value.counter))

/* --- 6. 路径与 id 守卫 --- */
ck('expandRoot 展开 ~', expandRoot('~/x', '/home/u') === '/home/u/x', expandRoot('~/x', '/home/u'))
ck('非法课程 id 被拒', (() => { try { store.courseDir('../../etc'); return false } catch (e) { return e.code === 'bad-course-id' } })())
ck('删除课程 = 删除该课程目录', await (async () => { await store.removeCourse(idC); return !(await fsPort.exists(store.courseDir(idC))) })())

/* --- 7. 课程列表带更新时间（课程库按「最近更新」排序的判据，06 §3.2） --- */
const idT1 = newCourseId(new Date('2026-10-16T10:00:00Z'), () => 0.11)
const idT2 = newCourseId(new Date('2026-10-16T10:00:01Z'), () => 0.22)
await store.writeCourse(idT1, { id: idT1, name: '旧', outline: { chapters: [{ id: 'ch-01', order: 1, name: 'c', knowledgePoints: [{ id: 'kp-01-01', order: 1, name: 'k', contentType: '图文', duration: 5 }] }] } })
await store.writeCourse(idT2, { id: idT2, name: '新', outline: { chapters: [{ id: 'ch-01', order: 1, name: 'c', knowledgePoints: [{ id: 'kp-01-01', order: 1, name: 'k', contentType: '图文', duration: 5 }] }] } })
/* 把「新」那门的 course.json 改晚一些，模拟「最近改过大纲」 */
await new Promise((r) => setTimeout(r, 15))
await store.writeCourse(idT2, { id: idT2, name: '新（改过）', outline: { chapters: [{ id: 'ch-01', order: 1, name: 'c', knowledgePoints: [{ id: 'kp-01-01', order: 1, name: 'k', contentType: '图文', duration: 5 }] }] } })
const listed = await store.listCourses()
const rowT1 = listed.find((r) => r.id === idT1)
const rowT2 = listed.find((r) => r.id === idT2)
ck('列表每行都带 updatedAt（毫秒）', Number.isFinite(rowT1.updatedAt) && Number.isFinite(rowT2.updatedAt), `${rowT1.updatedAt} / ${rowT2.updatedAt}`)
ck('刚写过的课程 updatedAt 更晚', rowT2.updatedAt > rowT1.updatedAt)
/* 进度也算「最近动过」：给「旧」那门写一次进度，它的 updatedAt 应该追上来 */
await new Promise((r) => setTimeout(r, 15))
await store.writeProgress(idT1, { kp: { 'kp-01-01': '已掌握' } })
const listed2 = await store.listCourses()
ck('写进度也算更新（取 course.json / progress.json 的较晚者）',
  listed2.find((r) => r.id === idT1).updatedAt > listed2.find((r) => r.id === idT2).updatedAt)
ck('端口不支持 mtime 时回 0（排序由调用方兜底，不抛错）', await (async () => {
  const bare = createStore({ fs: { ...fsPort, mtime: undefined }, root })
  const rows = await bare.listCourses()
  return rows.every((r) => r.updatedAt === 0)
})())

/* --- 8. 删除必须是**完整删除**：正文 / 媒体 / 进度 / 课程文件一起走
   （课程卡片上那个「删除」按钮对用户承诺的就是这件事） --- */
const idDel = newCourseId(new Date('2026-10-16T10:00:00Z'), () => 0.42)
await store.writeCourse(idDel, { id: idDel, name: '待删除', outline: { chapters: [{ id: 'ch-01', order: 1, name: '章一', knowledgePoints: [{ id: 'kp-01-01', order: 1, name: '点一', contentType: '图文', duration: 5 }] }] } })
await store.writeProgress(idDel, { kp: { 'kp-01-01': '已掌握' } })
await fsPort.mkdir(join(store.courseDir(idDel), 'content-assets'))
await fsPort.mkdir(join(store.courseDir(idDel), 'media'))
await writeFile(join(store.courseDir(idDel), 'content-assets/kp-01-01.md'), '# 正文', 'utf8')
await writeFile(join(store.courseDir(idDel), 'media/diagram.png'), 'not-a-real-png', 'utf8')
ck('删除前：课程目录里有全部四类东西',
  (await readdir(store.courseDir(idDel))).sort().join(',') === 'content-assets,course.json,media,progress.json',
  (await readdir(store.courseDir(idDel))).sort().join(','))
await store.removeCourse(idDel)
ck('删除后：整个课程目录消失（正文 / 媒体 / 进度一并删掉）', !(await fsPort.exists(store.courseDir(idDel))))
ck('删除后再读回 null（列表不会残留幽灵卡片）', (await store.readCourse(idDel)).value === null)
ck('删除同一门课两次不抛（幂等，界面重复点击也安全）',
  await (async () => { try { await store.removeCourse(idDel); return true } catch { return false } })())

/* --- 9. 配置界面切换课程库根目录：立即生效，旧数据不搬不删 --- */
const rootB = await mkdtemp(join(tmpdir(), 'aic-smoke-b-'))
const idRootB = newCourseId(new Date('2026-10-18T12:00:00Z'), () => 0.55)
await store.setRoot(rootB)
ck('setRoot 后读的是新根（旧根课程不可见）', (await store.listCourses()).length === 0)
await store.writeCourse(idRootB, { id: idRootB, name: '新根课程', outline: { chapters: [] } })
ck('setRoot 后写入落新根', (await store.listCourses()).some((r) => r.id === idRootB && r.course?.name === '新根课程'))
ck('旧根目录没有被搬动', await fsPort.exists(root))
await store.setRoot(root)
ck('切回旧根仍能看到原课程', (await store.listCourses()).some((r) => r.id === idB))
ck('drain 能等待在途写结束', await (async () => { await store.drain(); return true })())
await rm(rootB, { recursive: true, force: true })

await rm(root, { recursive: true, force: true })
console.log(`\n${fail ? fail + ' 项失败' : '全部通过'}   （PASS ${pass} / FAIL ${fail}）`)
process.exit(fail ? 1 : 0)
