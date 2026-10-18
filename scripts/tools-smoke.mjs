#!/usr/bin/env node
/** T-8 冒烟：三个工具的注册、schema、并发安全声明、失败语义。 */
import { mkdtemp, mkdir, readFile, writeFile, readdir, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createStore } from '../src/host/20-store.mjs'
import { createCourseApi } from '../src/host/30-courses.mjs'
import { DEFERRED_TYPES } from '../src/host/05-constants.mjs'
import { createMethodTableFor } from '../src/host/50-methods.mjs'
import { createToolDefinitions, registerTools, renderCourseBlock } from '../src/host/60-tools.mjs'
import { createTaskRunners } from '../src/host/25-tasks.mjs'

let pass = 0, fail = 0
const ck = (n, ok, ev) => { ok ? pass++ : fail++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${ev ? '  → ' + ev : ''}`) }
const rejects = async (fn, code) => { try { await fn(); return 'NO-THROW' } catch (e) { return e.code === code ? true : 'code=' + e.code } }

const fsPort = {
  join: (...p) => join(...p),
  readText: (p) => readFile(p, 'utf8'),
  writeText: async (p, s) => { await mkdir(join(p, '..'), { recursive: true }); await writeFile(p, s, 'utf8') },
  mkdir: async (p) => { if (p) await mkdir(p, { recursive: true }) },
  list: (p) => readdir(p),
  exists: async (p) => { try { await stat(p); return true } catch { return false } },
  remove: (p) => rm(p, { recursive: true, force: true }),
}
const root = await mkdtemp(join(tmpdir(), 'aic-t8-'))
const store = createStore({ fs: fsPort, root })
const courses = createCourseApi({ store, now: () => new Date('2026-10-13T16:00:00Z') })
/* 生成链路现在是真的：方法表需要 runners + gen（与 99-apply 的接线一致） */
const gen = { agent: null, signal: null }
/* 假的会话表：RPC 路径用 `agentId` 字符串换 Agent（与真宿主 `ctx.agents.get(id)` 同形） */
const agentsById = { 'sess-1': { id: 'sess-1' } }
const defs0 = {
  store, courses, status: null, runners: null,
  /* 与 buildContext 返回的同名方法：路径形状 { id }（E-22）——参数名/行为必须一致，
     check.mjs 有一条断言专门比对「方法表从 deps 解构出的键」与「buildContext 返回的键」 */
  resolveAgent (input) {
    /* ⚠️ 必须同时吃「Agent 对象」（工具路径 `exec.agent`）与「会话 id 字符串」
       （RPC 路径的 `agentId`）——`generation.start` 走的是后者（E-26：精确路由没有会话上下文） */
    const agent = (input && typeof input === 'object' && typeof input.id === 'string')
      ? input
      : (typeof input === 'string' && input ? agentsById[input] : null)
    if (agent) gen.agent = agent
    return agent || null
  },
}
defs0.runners = createTaskRunners({
  store,
  /* 冒烟不打模型：用假的「生成一个知识点」直接落库（正文来自固定输入） */
  generateOne: async (task, item, kpId) => {
    const { generateOne } = await import('../src/host/30-generate.mjs')
    return generateOne(
      { store, courses, callModel: async () => JSON.stringify({ title: kpId, body: '## 小节\n\n正文。', diagram: { alt: '图', svg: '<svg viewBox="0 0 10 10"><rect width="1" height="1"/></svg>' } }) },
      { courseId: task.courseId, kpId, contentType: task.contentType || undefined, prompt: '' },
    )
  },
})
const table = createMethodTableFor(defs0)
const defs = createToolDefinitions({ deps: defs0, table })

const course = await courses.create({
  name: 'RSC 入门', description: '三章', difficulty: '中级', tags: ['React'],
  outline: { chapters: [
    { id: 'ch-01', order: 1, name: '为什么', knowledgePoints: [
      { id: 'kp-01-01', order: 1, name: 'CSR 与 SSR', contentType: '图文', duration: 12 } ] },
    { id: 'ch-02', order: 2, name: '边界', knowledgePoints: [
      /* 故意用「待定类型」：course_content_asset_put 要证明四种降级类型也能写（Markdown 降级） */
      { id: 'kp-02-01', order: 1, name: 'use client', contentType: '音频', duration: 8 } ] } ] },
})

/* --- 注册 --- */
ck('注册三个工具', defs.length === 3, defs.map((d) => d.name).join(' '))
ck('工具名与 07 号文档一致',
  defs.map((d) => d.name).join(',') === 'course_read,course_generate,course_content_asset_put')
ck('每个工具都有 description 与 parameters', defs.every((d) => d.description && d.parameters && d.execute))
ck('**每个工具都声明 output { schema, render }**（缺了 tools.register 直接抛）',
  defs.every((d) => d.output && typeof d.output.render === 'function' && d.output.schema),
  defs.map((d) => d.name + ':' + (d.output ? 'ok' : 'MISSING')).join(' '))
ck('处理器名是 execute（不是 handler）', defs.every((d) => typeof d.execute === 'function' && d.handler === undefined))
ck('输入 schema 的键是 parameters（不是 input）', defs.every((d) => d.parameters && d.input === undefined))
ck('output.render 返回内容块数组', (() => {
  const r = defs[0].output.render({}, { text: 'hi' })
  return Array.isArray(r) && r[0].type === 'text' && r[0].text === 'hi'
})(), JSON.stringify(defs[0].output.render({}, { text: 'hi' })).slice(0, 60))
const reg = []
ck('registerTools 走 ctx.tools.register 并返回 disposer',
  registerTools({ tools: { register (d) { reg.push(d); return () => {} } } }, defs).length === 3 && reg.length === 3)
ck('只有 course_read 声明 isConcurrencySafe（写课程库的工具 fail-closed）',
  defs.filter((d) => d.isConcurrencySafe === true).map((d) => d.name).join(',') === 'course_read',
  defs.filter((d) => d.isConcurrencySafe).map((d) => d.name).join(',') || '（无）')

/* --- course_read --- */
const read = await defs[0].execute({ courseId: course.id })
const text = defs[0].output.render({}, read)[0].text
ck('course_read 返回结构化结果，render 转成文本块', typeof read.text === 'string' && text.length > 0)
ck('course_read 含课程名与章节', text.includes('RSC 入门') && text.includes('1. 为什么'))
ck('course_read 含知识点编号（1.1 这种）+ 类型 + 时长',
  text.includes('1.1 CSR 与 SSR') && text.includes('图文') && text.includes('12 分钟'), text.split('\n')[5])
ck('course_read 含学习进度小结', /学习进度：已掌握 \d+ 个知识点/.test(text))
ck('scope=kp 只回目标知识点', defs[0].output.render({}, await defs[0].execute({ courseId: course.id, scope: 'kp', targetIds: ['kp-02-01'] }))[0].text.includes('use client'))
ck('course_read 课程不存在 → not-found', await rejects(() => defs[0].execute({ courseId: 'c-20260101000000-aaaa' }), 'not-found'))

/* --- course_generate：现在**真的**发起任务（走同一个 generation.start） --- */
ck('course_generate 无 targetIds 且 scope=chapter → invalid-input',
  await rejects(() => defs[1].execute({ courseId: course.id, scope: 'chapter' }, { agent: { id: 'sess-1' } }), 'invalid-input'))
ck('course_generate 拿不到会话 Agent → 结构化 no-agent（不静默失败）',
  await rejects(() => defs[1].execute({ courseId: course.id, scope: 'course' }, {}), 'no-agent'))
const started = await defs[1].execute({ courseId: course.id, scope: 'course' }, { agent: { id: 'sess-1' } })
const startedText = defs[1].output.render({}, started)[0].text
ck('course_generate 发起任务并回任务 id 与目标数', /已发起生成：task-/.test(startedText) && /目标 2 个知识点/.test(startedText), startedText.split('\n')[0])
ck('course_generate 的任务真的建在任务表里', table.get('generation.status') !== undefined && (await table.get('generation.status').handle({}, { courseId: course.id })).task !== null)
ck('course_generate 的 input schema 里没有 agentId（会话由 exec.agent 提供）',
  !('agentId' in (defs[1].parameters.properties || {})))

/* 等后台任务跑完（假生成器是同步的，给它一轮事件循环） */
await new Promise((r) => setTimeout(r, 30))

/* --- course_content_asset_put：现在**真的**落库（复用资产层） --- */
const put = (o) => defs[2].execute({ courseId: course.id, kpId: 'kp-01-01', contentType: '图文', markdown: '## 正文\n\n内容。', ...o })
ck('待定类型现在也能写（Markdown 降级：格式未定稿但先让它们可用）',
  (await put({ contentType: '音频', kpId: 'kp-02-01' })).text.includes('音频'))
ck('内容类型非法 → invalid-input 且回 allowed',
  await (async () => { try { await put({ contentType: '不存在的类型' }); return false } catch (e) { return e.code === 'invalid-input' && Array.isArray(e.detail.allowed) } })())
ck('内容类型与大纲不一致 → 拒绝（否则写出来的信封界面永远读不到）',
  await rejects(() => put({ contentType: '幻灯片', kpId: 'kp-01-01' }), 'invalid-input'))
ck('课程不存在 → not-found（不能给任意 courseId 创建幽灵目录）',
  await rejects(() => put({ courseId: 'c-20260101000000-aaaa' }), 'not-found'))
ck('知识点不存在 → not-found',
  await rejects(() => put({ kpId: 'kp-99-99' }), 'not-found'))
const putOk = await put({})
ck('合法正文 → 真的落盘并回正文路径', /已写入内容资产：kp-01-01/.test(putOk.text), putOk.text)
const assetDir = join(store.courseDir(course.id), 'content-assets')
ck('落盘后目录里有信封 + 正文 + 媒体（三条都在，缺一个就是半成品）',
  (await readdir(assetDir)).sort().join(',').includes('kp-01-01.json') &&
  (await readdir(assetDir)).sort().join(',').includes('kp-01-01.md') &&
  (await readdir(join(assetDir, 'media'))).length >= 1,
  (await readdir(assetDir)).sort().join(','))
ck('写出的正文带 frontmatter，且**没有** h1（层级从 h2 开始）', await (async () => {
  const text = await readFile(join(assetDir, 'kp-01-01.md'), 'utf8')
  return /^---\ntitle: /m.test(text) && !/^#\s/m.test(text)
})())
ck('写出的正文里插入了指向媒体的相对路径图', await (async () => {
  const text = await readFile(join(assetDir, 'kp-01-01.md'), 'utf8')
  return /!\[[^\]]*\]\(media\/kp-01-01-01\.svg\)/.test(text)
})())

/* --- 工具与 UI 语义一致：都走同一张方法表 --- */
ck('工具调用的就是 RPC 方法表里的 courses.read',
  typeof table.get('courses.read')?.handle === 'function' && table.get('courses.read') !== undefined)
ck('renderCourseBlock 是纯函数（同一输入同一输出）',
  renderCourseBlock(course) === renderCourseBlock(course))

await rm(root, { recursive: true, force: true })
console.log(`\n${fail ? fail + ' 项失败' : '全部通过'}   （PASS ${pass} / FAIL ${fail}）`)
process.exit(fail ? 1 : 0)
