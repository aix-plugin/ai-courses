#!/usr/bin/env node
/** T-10 冒烟：提示词/解析/规范化/落库链路。除「调模型」那一步外全部离线可验。 */
import { mkdtemp, mkdir, readFile, writeFile, readdir, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createStore } from '../src/host/20-store.mjs'
import { createCourseApi } from '../src/host/30-courses.mjs'
import { DERIVATION_RULES, DERIVATION_SHAPE, DERIVATION_SCHEMA, buildDerivationPrompt, parseDerivation, normalizeDerivation, applyDerivation, runCourseDerivation } from '../src/host/10-prompt.mjs'

let pass = 0, fail = 0
const ck = (n, ok, ev) => { ok ? pass++ : fail++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${ev ? '  → ' + ev : ''}`) }
const fsPort = {
  join: (...p) => join(...p), readText: (p) => readFile(p, 'utf8'),
  writeText: async (p, s) => { await mkdir(join(p, '..'), { recursive: true }); await writeFile(p, s, 'utf8') },
  mkdir: async (p) => { if (p) await mkdir(p, { recursive: true }) },
  list: (p) => readdir(p), exists: async (p) => { try { await stat(p); return true } catch { return false } },
  remove: (p) => rm(p, { recursive: true, force: true }),
}
const root = await mkdtemp(join(tmpdir(), 'aic-t10-'))
const store = createStore({ fs: fsPort, root })
const courses = createCourseApi({ store, now: () => new Date('2026-10-13T16:00:00Z') })

/* --- 提示词 --- */
ck('约束里写清了「只产出结构、不生成正文」', /不要生成任何正文内容/.test(DERIVATION_RULES))
ck('约束里写清了层级与「知识点不能游离」', /知识点不能游离/.test(DERIVATION_RULES))
ck('约束里写清了 order 连续性（含「本章内」）', /order 在\*\*本章内\*\*从 1 连续/.test(DERIVATION_RULES))
ck('约束里明确**不要**给 duration（大纲阶段不估计时长）',
  /不要\*\*给 duration/.test(DERIVATION_RULES) && !/duration：\*\*正整数分钟\*\*/.test(DERIVATION_RULES))
ck('JSON 形状里没有 duration 字段', !/"duration"/.test(DERIVATION_SHAPE))
/* 口径随「默认 图文」调整：不再说"四种请尽量少用"，而是明确"默认一律 图文 + 四种不要用" */
ck('约束里交代了知识点类型默认 图文、四种待定类型不要用',
  /默认一律 图文/.test(DERIVATION_RULES) && /v1 还没有生成与展示设计，\*\*不要用\*\*/.test(DERIVATION_RULES))
ck('约束里点名原子性由模型自行判断（Q-6）', /是否原子由你判断/.test(DERIVATION_RULES))
const p1 = buildDerivationPrompt('用 3 章讲清 RSC', [{ name: 'notes.pdf' }])
ck('提示词含诉求', p1.includes('用 3 章讲清 RSC'))
ck('提示词**自带**领域约束（不依赖 systemPrompt 服务）', p1.includes('知识点不能游离') && p1.indexOf('知识点不能游离') < p1.indexOf('用 3 章讲清 RSC'))
ck('提示词含附件名', p1.includes('notes.pdf'))
ck('提示词含 JSON 形状契约', p1.includes('"knowledgePoints"'))
ck('无附件时不出现「参考资料」段', !buildDerivationPrompt('x').includes('参考资料'))
ck('诉求为空时给出兜底话术', buildDerivationPrompt('').includes('用户未填写诉求'))

/* --- 解析容错 --- */
const good = { name: 'C', difficulty: '中级', outline: { chapters: [{ name: '第一章', knowledgePoints: [{ name: 'K1', contentType: '图文' }] }] } }
ck('裸 JSON 可解析', parseDerivation(JSON.stringify(good)).ok)
ck('```json 围栏可解析', parseDerivation('```json\n' + JSON.stringify(good) + '\n```').ok)
ck('无围栏但前后有废话可解析', parseDerivation('好的，这是结构：\n' + JSON.stringify(good) + '\n希望有帮助').ok)
ck('空回包 → 结构化错误', parseDerivation('').error.code === 'bad-derivation')
ck('纯文本无 JSON → 结构化错误', parseDerivation('我做不到').error.code === 'bad-derivation')
ck('JSON 数组被拒', parseDerivation('[1,2]').ok === false)
ck('解析失败不抛异常', (() => { try { parseDerivation('{oops'); return true } catch { return false } })())

/* --- 规范化：重排 order + 补 id + 丢多余字段 --- */
const messy = { name: 'X'.repeat(80), difficulty: '大师', outline: { chapters: [
  { name: ' A ', rank: 99, knowledgePoints: [{ name: ' K ', duration: 0, junk: 1 }, { name: 'K2', contentType: '幻灯片' }] },
  { name: 'B', knowledgePoints: [{ name: 'K3' }] } ] }, secret: 'should-be-dropped' }
const n = normalizeDerivation(messy, { fallbackDuration: 9 })
ck('课程名截断到 60 字', n.name.length === 60)
ck('非法难度回落「入门」', n.difficulty === '入门')
ck('章节 order 被重排为 1..n', n.outline.chapters.map((c) => c.order).join(',') === '1,2')
ck('知识点 order 在本章内重排为 1..n', n.outline.chapters[0].knowledgePoints.map((k) => k.order).join(',') === '1,2')
ck('id 按顺序派生 ch-NN / kp-NN-MM', n.outline.chapters[0].id === 'ch-01' && n.outline.chapters[0].knowledgePoints[1].id === 'kp-01-02')
/* duration 在大纲阶段**一律丢弃**（连模型硬塞的也不留），改由内容生成后回填 */
ck('模型硬塞的 duration 被丢弃（大纲阶段不该有值）',
  n.outline.chapters[0].knowledgePoints[0].duration === undefined, String(n.outline.chapters[0].knowledgePoints[0].duration))
ck('duration 缺失时也不兜默认值（不再出现「每个都是 10 分钟」）',
  n.outline.chapters[1].knowledgePoints[0].duration === undefined)
ck('contentType 缺失 → 默认 图文', n.outline.chapters[1].knowledgePoints[0].contentType === '图文')
/* 知识点类型**默认 图文**（2026-10-18 用户需求）：
   缺失 → 图文；四种待定类型 → 收敛为图文（否则会落库一个"生成不了"的知识点）；幻灯片保留。 */
{
  const norm = (ct) => normalizeDerivation({ name: 'X', outline: { chapters: [
    { name: 'C', knowledgePoints: [{ name: 'K', contentType: ct }] } ] } }).outline.chapters[0].knowledgePoints[0].contentType
  ck('幻灯片是 v1 支持的展示形态 → 保留模型的选择', norm('幻灯片') === '幻灯片', norm('幻灯片'))
  ck('音频 / 视频 / 代码 / 测验 → 收敛为 图文（v1 生成不了）',
    ['音频', '视频', '代码', '测验'].every((ct) => norm(ct) === '图文'),
    ['音频', '视频', '代码', '测验'].map(norm).join(','))
  ck('大小写/空白不影响判定（" 图文 " 也认）', norm(' 图文 ') === '图文')
  ck('完全未知的类型 → 图文（不落库非法值）', norm('播客') === '图文', norm('播客'))
}
ck('提示词把 图文 写成默认（不是"六选一"）',
  /默认一律 图文/.test(DERIVATION_RULES) && /不要用/.test(DERIVATION_RULES))
ck('多余字段被丢弃（不许模型塞内部结构）', n.secret === undefined && n.outline.chapters[0].rank === undefined && n.outline.chapters[0].knowledgePoints[0].junk === undefined)

/* --- 分类与标签的产出规则（用户需求：默认不给分类；标签 2~3 个、范围大） --- */
ck('给模型的 JSON 形状里**保留** category（字段不删）', /"category"/.test(DERIVATION_SHAPE))
ck('结构化 schema 里也**保留** category（字段不删）', 'category' in DERIVATION_SCHEMA.properties, Object.keys(DERIVATION_SCHEMA.properties).join(','))
ck('提示词要求 category 固定输出空字符串', /category（分类）：\*\*固定输出空字符串/.test(DERIVATION_RULES))
ck('提示词要求 tags 只给 2..3 个且范围大', /tags 只给 \*\*2\.\.3 个\*\*/.test(DERIVATION_RULES) && /范围大/.test(DERIVATION_RULES))
const tagNorm = normalizeDerivation({ name: 'X', outline: { chapters: [] }, tags: [' 前端 ', '', 'React 19', '数据库', '第五个'] })
ck('标签去空白、丢空项', tagNorm.tags.indexOf('') < 0 && tagNorm.tags[0] === '前端', JSON.stringify(tagNorm.tags))
ck('标签超过 3 个 → 服务端截断到 3（模型多给也不落库）', tagNorm.tags.length === 3, JSON.stringify(tagNorm.tags))
ck('推导产出的 category 恒为空（模型填了也不算数）',
  normalizeDerivation({ name: 'X', category: '前端', outline: { chapters: [] } }).category === '')
ck('category 字段存在且是字符串（不是 undefined）',
  typeof normalizeDerivation({ name: 'X', outline: { chapters: [] } }).category === 'string')
ck('tags 缺失 → 空数组（不是 undefined）', Array.isArray(normalizeDerivation({ name: 'X', outline: { chapters: [] } }).tags))

/* --- 落库：合法 → 建课程；非法 → 拒绝且不落库 --- */
const okApply = await applyDerivation(courses, JSON.stringify(good))
ck('合法回包 → 落库成功', okApply.ok === true && okApply.course.id)
ck('落库后知识点全部为「未生成」', Object.keys(JSON.parse(await readFile(join(store.courseDir(okApply.course.id), 'progress.json'), 'utf8')).kp).length === 0)
const nBefore = (await readdir(root)).length
const badApply = await applyDerivation(courses, JSON.stringify({ name: 'Y', outline: { chapters: [] } }))
ck('空大纲 → 拒绝（不落库）', badApply.ok === false && (await readdir(root)).length === nBefore)
ck('拒绝理由来自领域层（可读）', /至少/.test(badApply.error.message), badApply.error.message)
const brokenApply = await applyDerivation(courses, '模型胡言乱语')
ck('回包不可解析 → 拒绝且不落库', brokenApply.ok === false && (await readdir(root)).length === nBefore)

/* --- 端到端（注入假 derive，替代真实模型调用）--- */
const run = await runCourseDerivation({ deps: { courses }, request: '用 1 章讲 A', derive: async () => JSON.stringify(good) })
ck('runCourseDerivation 成功 → 回话带课程名与计数', /已生成课程《C》/.test(run.text) && /1 个章节、1 个知识点/.test(run.text), run.text.split('\n')[0])
ck('runCourseDerivation 返回 courseId', !!run.courseId)
ck('成功返回 kind=success（CommandResult 契约）', run.kind === 'success', run.kind)
const runFail = await runCourseDerivation({ deps: { courses }, request: 'x', derive: async () => '垃圾' })
ck('模型回包不合法 → kind=error 且说明「已拒绝落库、没有半成品」', runFail.kind === 'error' && /已拒绝落库/.test(runFail.text) && /没有产生半成品/.test(runFail.text), runFail.kind)
const runThrow = await runCourseDerivation({ deps: { courses }, request: 'x', derive: async () => { throw new Error('限流') } })
ck('模型调用抛错 → kind=error 且含原因、可重试', runThrow.kind === 'error' && /限流/.test(runThrow.text) && /可以重试/.test(runThrow.text), runThrow.kind)

await rm(root, { recursive: true, force: true })

/* --- defaultDerive：按 E-21 的 subagents 契约（注入假 ctx 验证调用形状）--- */
import { defaultDerive } from '../src/host/10-prompt.mjs'
const calls = []
const fakeCtx = { subagents: {
  list: () => ['in-process'],
  start: async (name, req) => {
    calls.push({ name, req })
    return { id: 's1', result: Promise.resolve({ output: [], structured: { name: 'S', outline: { chapters: [{ name: 'C', knowledgePoints: [{ name: 'K', contentType: '图文' }] }] } } }), dispose: async () => { calls.push({ disposed: true }) } }
  },
} }
const out = await defaultDerive(fakeCtx, { parent: { id: 'sess-1' } })('提示词')
ck('defaultDerive 走 subagents.start', calls.length >= 1 && calls[0].name === 'in-process')
ck('请求里带 prompt 文本块', calls[0].req.prompt[0].type === 'text' && calls[0].req.prompt[0].text === '提示词')
ck('请求里带必填的 parent', calls[0].req.parent.id === 'sess-1')
ck('请求里带 outputSchema（结构化输出）', !!calls[0].req.outputSchema && calls[0].req.outputSchema.type === 'object')
ck('请求里带 signal', !!calls[0].req.signal)
ck('structured 优先 → 回 JSON 字符串', JSON.parse(out).name === 'S')
ck('用后 dispose（不留运行实例）', calls.some((c) => c.disposed === true))
ck('拿不到 parent 时报明确错误（不猜）', await (async () => { try { await defaultDerive(fakeCtx, {})('x'); return false } catch (e) { return /拿不到当前会话的 Agent/.test(e.message) } })())
ck('没有 provider 时报明确错误', await (async () => { try { await defaultDerive({ subagents: { list: () => [] } }, { parent: { id: 's' } })('x'); return false } catch (e) { return /没有可用的 subagents provider/.test(e.message) } })())
ck('结构化缺失时回退到 output 文本', await (async () => {
  const c2 = { subagents: { list: () => ['p'], start: async () => ({ result: Promise.resolve({ output: [{ type: 'text', text: '{"name":"T"}' }], stopReason: 'completed' }), dispose: async () => {} }) } }
  return JSON.parse(await defaultDerive(c2, { parent: { id: 's' } })('x')).name === 'T'
})())
/* callSubagent：推导与内容生成共用的那一个实现（生成侧不给 outputSchema、直接回文本） */
import { callSubagent } from '../src/host/10-prompt.mjs'
ck('callSubagent：给了 outputSchema 就带上、并回 JSON 字符串', await (async () => {
  const calls = []
  const c = { subagents: { list: () => ['p'], start: async (n, r) => { calls.push(r); return { result: Promise.resolve({ structured: { name: 'S' } }), dispose: async () => {} } } } }
  const out = await callSubagent(c, { parent: { id: 's' }, prompt: 'x', outputSchema: { type: 'object' }, json: true })
  return JSON.parse(out).name === 'S' && !!calls[0].outputSchema
})())
ck('callSubagent：不给 schema 时**不带** outputSchema，直接把文本当结果', await (async () => {
  const calls = []
  const c = { subagents: { list: () => ['p'], start: async (n, r) => { calls.push(r); return { result: Promise.resolve({ output: [{ type: 'text', text: '## 正文' }] }), dispose: async () => {} } } } }
  const out = await callSubagent(c, { parent: { id: 's' }, prompt: 'x' })
  return out === '## 正文' && calls[0].outputSchema === undefined
})())
ck('callSubagent：拿不到 parent 时报明确错误', await (async () => {
  try { await callSubagent({ subagents: { list: () => ['p'] } }, { prompt: 'x' }); return false } catch (e) { return /拿不到当前会话的 Agent/.test(e.message) }
})())

/* registerSystemPrompt 必须「服务不可用也不炸」——这是插件起不来的直接原因 */
import { registerSystemPrompt } from '../src/host/10-prompt.mjs'
ck('systemPrompt 没有 register 方法时不抛（只跳过）', registerSystemPrompt({ systemPrompt: {} }) === undefined)
ck('systemPrompt 服务整体缺失时不抛', registerSystemPrompt({ get: () => undefined }) === undefined)
ck('有 register 时才调用，并返回其 disposer', (() => {
  const d = () => {}
  return registerSystemPrompt({ get: () => ({ register: () => d }) }) === d
})())
console.log(`\n（含 defaultDerive）PASS ${pass} / FAIL ${fail}`)
process.exit(fail ? 1 : 0)
