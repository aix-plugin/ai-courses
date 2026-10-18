#!/usr/bin/env node
/**
 * 把**实际发送给模型的两条 prompt** 打印出来（不是手抄，是用真函数生成）。
 *
 * 为什么要脚本而不是文档里贴一份：
 *   prompt 会随代码演进，手抄的那份一定会过期。这里直接调
 *   `buildDerivationPrompt`（课程大纲）与 `buildContentPrompt`（知识点内容），
 *   用一组**固定的示例输入**渲染，产出 `doc/11-prompts.md` 的正文部分。
 *
 *   `node scripts/print-prompts.mjs           # 打印到标准输出`
 *   `node scripts/print-prompts.mjs --write   # 同时写入 doc/11-prompts.md`
 */
import { writeFile } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildDerivationPrompt } from '../src/host/10-prompt.mjs'
import { buildContentPrompt } from '../src/host/30-generate.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

/* ---------------------------------------------------------------- 示例输入 */

/** 课程大纲：一条带附件的学习诉求。 */
const DERIVE_INPUT = {
  request: '用 3 章讲清 React Server Components，我熟悉 Vue 但不熟 React',
  attachments: [{ name: '我的笔记.pdf' }, { name: 'rsc-会议纪要.md' }],
}

/** 知识点内容：一门真实的课 + 一个知识点（三种正文方言各给一份）。 */
/* 大纲也必须给全：prompt 里会贴整门课的结构（这是「防越界」的关键，见 07 §4.4.2） */
const COURSE = {
  name: '用 3 章讲清 React Server Components',
  description: '给熟悉 Vue、不熟 React 的工程师讲清 RSC 的取舍与边界',
  difficulty: '中级',
  category: '',
  tags: ['前端', '框架'],
  outline: { chapters: [
    { id: 'ch-01', order: 1, name: '为什么需要 RSC', description: '从 CSR/SSR 的水合代价说起', knowledgePoints: [
      { id: 'kp-01-01', order: 1, name: 'CSR 与 SSR 各自的水合代价', contentType: '图文', duration: 12 },
      { id: 'kp-01-02', order: 2, name: 'RSC 的核心承诺', contentType: '图文', duration: 9 },
    ] },
    { id: 'ch-02', order: 2, name: '边界与心智模型', description: '什么时候该用、什么时候别用', knowledgePoints: [
      { id: 'kp-02-01', order: 1, name: 'use client 到底标在哪里', contentType: '图文', duration: 10 },
      { id: 'kp-02-02', order: 2, name: 'Server Action 与 RPC 的区别', contentType: '幻灯片', duration: 8 },
      { id: 'kp-02-03', order: 3, name: 'RSC 的核心承诺', contentType: '图文', duration: 12 },
    ] },
    { id: 'ch-03', order: 3, name: '落地与取舍', knowledgePoints: [
      { id: 'kp-03-01', order: 1, name: '数据获取放在哪一层', contentType: '图文', duration: 11 },
      { id: 'kp-03-02', order: 2, name: '什么时候不该用 RSC', contentType: '幻灯片', duration: 9 },
    ] },
  ] },
}
const CHAPTER = COURSE.outline.chapters[1]
const NEIGHBORS = CHAPTER.knowledgePoints.filter((k) => k.id !== 'kp-02-03').map((k) => k.name)

const CONTENT_CASES = [
  { key: '图文', kp: COURSE.outline.chapters[1].knowledgePoints[2] },
  { key: '幻灯片', kp: { ...COURSE.outline.chapters[1].knowledgePoints[2], contentType: '幻灯片' } },
  { key: '代码（待定类型）', kp: { ...COURSE.outline.chapters[1].knowledgePoints[2], contentType: '代码' } },
]

/* ------------------------------------------------------------------ 渲染 */

const fence = (text, lang = '') => '```' + (lang || 'text') + '\n' + text.replace(/\s+$/, '') + '\n```'

function render () {
  const out = []
  out.push('# 11 · 发给模型的 prompt（自动生成）')
  out.push('')
  out.push('> **本文件由 `node scripts/print-prompts.mjs --write` 生成，请勿手改。**')
  out.push('> 内容是**真函数**（`buildDerivationPrompt` / `buildContentPrompt`）配固定示例输入渲染出来的，')
  out.push('> 因此它永远等于代码当下真正发出去的东西。规则怎么来的、为什么这么定，见 `07-agent-integration.md` §4.3 / §4.4。')
  out.push('')

  /* ---- 一、课程大纲 ---- */
  out.push('## 1. 课程大纲推导（`/ai-course`）')
  out.push('')
  out.push('拼装点：`src/host/10-prompt.mjs` 的 `buildDerivationPrompt(request, attachments)`。')
  out.push('同时 `DERIVATION_RULES` 还会**尽力而为**地注入 systemPrompt（`registerSystemPrompt`，')
  out.push('但宿主没有 `systemPrompt.register` 时会跳过 —— 所以约束**必须**随 prompt 一起发，这就是上面这份自包含的原因）。')
  out.push('')
  out.push('示例输入：')
  out.push('')
  out.push('- 学习诉求：`' + DERIVE_INPUT.request + '`')
  out.push('- 附件：' + DERIVE_INPUT.attachments.map((a) => '`' + a.name + '`').join('、'))
  out.push('')
  out.push('实际发送的 prompt：')
  out.push('')
  out.push(fence(buildDerivationPrompt(DERIVE_INPUT.request, DERIVE_INPUT.attachments)))
  out.push('')

  /* ---- 二、知识点内容 ---- */
  out.push('## 2. 知识点内容生成（生成弹窗 / 大纲行内生成 / `course_generate`）')
  out.push('')
  out.push('拼装点：`src/host/30-generate.mjs` 的 `buildContentPrompt({ kp, chapter, course, contentType, prompt, neighbors })`。')
  out.push('三种正文方言由 `contentType` 分派：`图文` 走 Markdown 规则、`幻灯片` 走 Slidev 规则、')
  out.push('`音频/视频/代码/测验` 走「Markdown 降级 + 格式待定」提示。')
  out.push('')
  out.push('公共上下文（三门示例课共用）：')
  out.push('')
  out.push('- 课程：`' + COURSE.name + '`（' + COURSE.difficulty + '，标签 ' + COURSE.tags.join('/') + '）')
  out.push('- 章节：`第 ' + CHAPTER.order + ' 章 ' + CHAPTER.name + '`')
  out.push('- 本次知识点：`' + CHAPTER.knowledgePoints[2].name + '`（第 2 章第 3 个）')
  out.push('- 课程大纲：' + COURSE.outline.chapters.length + ' 章 / ' +
    COURSE.outline.chapters.reduce((n, c) => n + c.knowledgePoints.length, 0) + ' 个知识点 —— **整份大纲会随 prompt 一起发**（防越界，见 07 §4.4.2）')
  out.push('')
  for (const c of CONTENT_CASES) {
    out.push('### 2.' + (CONTENT_CASES.indexOf(c) + 1) + ' `' + c.key + '`')
    out.push('')
    out.push(fence(buildContentPrompt({
      kp: c.kp,
      chapter: CHAPTER,
      course: COURSE,
      contentType: c.kp.contentType,
      neighbors: NEIGHBORS,
      prompt: '读者熟悉 Vue，请多用对比的方式说明',
    })))
    out.push('')
  }

  /* ---- 三、结构化输出 schema ---- */
  out.push('## 3. 模型必须回的结构化形状（两条链路都一样）')
  out.push('')
  out.push('prompt 末尾贴着形状，同时通过 `subagents.start` 的 `outputSchema` **再约束一次**')
  out.push('（结构化结果直接落在 `run.result.structured`，不必从散文里抠 JSON）。')
  out.push('')
  out.push('- 课程大纲：`DERIVATION_SCHEMA`（`10-prompt.mjs`）')
  out.push('- 知识点内容：`CONTENT_SCHEMA`（`30-generate.mjs`）')
  out.push('')
  out.push('两条链路都遵守同一套「宽进严出」：schema 只做**宽松**约束，')
  out.push('每个字段的兜底都在解析层（`normalizeDerivation` / `parseContent`：截断、补默认、剥多余），')
  out.push('不让一个装饰性字段把整次生成判成非法。')
  out.push('')
  return out.join('\n')
}

const text = render()
if (process.argv.indexOf('--write') >= 0) {
  const file = join(root, 'doc/11-prompts.md')
  await writeFile(file, text, 'utf8')
  console.log('[print-prompts] 已写入 ' + file + '（' + text.split('\n').length + ' 行，' + Buffer.byteLength(text) + ' B）')
} else {
  console.log(text)
}
