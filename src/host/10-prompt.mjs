import { extractRefs, mergeSources } from './07-sources.mjs'

import { CONTENT_TYPES, SUPPORTED_TYPES } from './05-constants.mjs'

/* ============================================================================
 * 领域约束提示词 + `/ai-course` 推导链路（T-10）
 *
 * 分三段，**每段都可单独测**：
 *   ① `DERIVATION_RULES` / `buildDerivationPrompt`  —— 给模型的约束与请求（纯字符串）
 *   ② `parseDerivation`                             —— 解析模型回包（纯函数，容忍噪声）
 *   ③ `applyDerivation`                             —— 校验 + 落库（走 T-7 的领域层）
 *
 * 只有「真正把提示词发给模型」这一步需要宿主 `agents` 服务，因此注入成 `derive`：
 * 默认实现调宿主，冒烟测试传假的。**这样除了那一次调用之外，链路全部可离线验证。**
 *
 * ⚠️ 待 T-4 安装后才能验证：真实 `/ai-course` 端到端跑通并落库（`derive` 的宿主实现）。
 * ========================================================================== */

/** 给模型的领域约束（同时也会作为 systemPrompt 片段注入，见 registerSystemPrompt）。 */
export const DERIVATION_RULES = `你在为一个「本地 AI 课程」应用推导课程结构。必须遵守：

1. 只产出结构，**不要生成任何正文内容**（内容由后续单独的内容生成流程负责）。
2. 层级：课程 → 1..n 章节 → 每章 1..n 知识点。**知识点不能游离在章节之外**。
3. 顺序：章节 order 从 1 连续；知识点 order 在**本章内**从 1 连续。不要跳号。
4. 知识点是**原子**学习单元 —— 一个知识点只讲一件事。是否原子由你判断（不设机器规则）。
5. 每个知识点必须给出：
   - name：简洁的中文名称
   - contentType：只能是 图文 / 幻灯片 / 音频 / 视频 / 代码 / 测验，但**默认一律 图文**：
     只有用户明确要求某种类型，或这一节本质上是「一页页讲」的演示（封面 / 要点 / 对比页）时，才用 幻灯片；
     音频 / 视频 / 代码 / 测验 这四种 v1 还没有生成与展示设计，**不要用**
   - **不要**给 duration（学习时长）：它在**内容生成之后**按实际正文回填，
    大纲阶段凭空估计只会得到一个和正文对不上的数字
6. 难度 difficulty 只能是 入门 / 中级 / 高级。
7. category（分类）：**固定输出空字符串**（JSON 里就是 "category": ""）—— 分类由用户以后自己决定，
   生成阶段一律留空。
8. tags 只给 **2..3 个**，且必须是**范围大**的领域标签（用于课程库的分类浏览与筛选），例如
   「前端」「后端」「数据库」「机器学习」「分布式系统」「产品设计」；
   **不要**写具体技术名、版本、框架名或长短语（反例：React 19、RSC 水合、用 3 章讲清边界）。
   宁可给 2 个宽的，也不要给 5 个窄的。
9. 章节数量与知识点粒度要匹配诉求：诉求说「三章」就恰好三章。
10. 只回一个 JSON 对象，不要解释、不要 Markdown 代码围栏之外的内容。`

/** 模型要产出的 JSON 形状（给模型看的契约）。`category` **保留但恒为空**（见规则 7）。 */
export const DERIVATION_SHAPE = `{
  "name": "课程名称（≤60 字）",
  "description": "一句话描述",
  "difficulty": "入门 | 中级 | 高级",
  "category": "（固定为空字符串）",
  "tags": ["2..3 个范围大的领域标签"],
  "outline": {
    "chapters": [
      { "name": "章节名", "description": "可选",
        "knowledgePoints": [
          { "name": "知识点名", "contentType": "图文" }
        ] }
    ]
  }
}`

export function buildDerivationPrompt (request, attachments = []) {
  const lines = []
  /* 领域约束**随 prompt 一起发**，不依赖 systemPrompt 服务 ——
     `subagents.start` 的 prompt 本来就是自包含的，这样也少一个未核实的依赖。 */
  lines.push(DERIVATION_RULES)
  lines.push('')
  lines.push('---')
  lines.push('')
  lines.push('学习诉求：')
  lines.push(String(request ?? '').trim() || '（用户未填写诉求，请根据附件判断）')
  if (attachments.length) {
    lines.push('')
    lines.push('参考资料：')
    for (const a of attachments) lines.push(`- ${a.name ?? a.path ?? String(a)}`)
  }
  lines.push('')
  lines.push('请严格按下面的 JSON 形状输出课程结构：')
  lines.push(DERIVATION_SHAPE)
  return lines.join('\n')
}

/* ------------------------------------------------------------- 解析回包 */

/**
 * 从模型回包里取出 JSON。容忍三种常见包装：裸 JSON、```json 围栏、正文里夹一个对象。
 * 解析失败返回 `{ ok:false, error }`，不抛 —— 命令层要把失败说给用户听。
 */
export function parseDerivation (text) {
  const bad = (message) => ({ ok: false, error: { code: 'bad-derivation', message } })
  let raw = String(text ?? '').trim()
  if (!raw) return bad('模型返回为空')

  const fence = raw.match(/```(?:json)?\s*([\s\S]*?)```/i)
  if (fence) raw = fence[1].trim()

  let obj
  try {
    obj = JSON.parse(raw)
  } catch {
    const start = raw.indexOf('{')
    const end = raw.lastIndexOf('}')
    if (start < 0 || end <= start) return bad('模型返回里找不到 JSON 对象')
    try { obj = JSON.parse(raw.slice(start, end + 1)) } catch { return bad('模型返回的 JSON 无法解析') }
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return bad('模型返回的不是 JSON 对象')
  return { ok: true, value: obj }
}

/**
 * 把模型回包**规范化**成领域层能接受的形状：
 *   · 补 id（章节 `ch-NN`、知识点 `kp-NN-MM`）
 *   · **重排 order**（模型经常跳号或从 0 开始；领域层会拒绝非连续 order）
 *   · 丢弃多余字段（不许模型顺手塞进 payload 之类的内部结构）
 * **`duration` 一律丢弃**（包括模型硬塞进来的）：学习时长在内容生成后按实际正文回填
 * （`estimateMinutes`），大纲阶段不该有值 —— 早先会给 10 分钟兜底，结果每张卡片都显示
 * 一个与正文无关的数字。
 */
export function normalizeDerivation (obj, { now = () => new Date(), sources = [], request = '' } = {}) {
  const chaptersIn = Array.isArray(obj?.outline?.chapters) ? obj.outline.chapters : []
  const chapters = chaptersIn.map((ch, ci) => {
    const chNo = String(ci + 1).padStart(2, '0')
    const kpsIn = Array.isArray(ch?.knowledgePoints) ? ch.knowledgePoints : []
    const kps = kpsIn.map((kp, ki) => {
      const ct = String(kp?.contentType ?? '').trim()
      return {
        id: `kp-${chNo}-${String(ki + 1).padStart(2, '0')}`,
        order: ki + 1,
        name: String(kp?.name ?? '').trim(),
        /* **默认 图文**（用户需求 2026-10-18）：
           ① 模型没给 / 给了空串 → 图文；
           ② 给了 v1 尚未支持的四类（音频/视频/代码/测验）→ 也收敛为 图文 —— 它们即使落库也生成不了
              （界面禁用生成、工具拒绝写入），留着只会得到一个点不动的知识点；
           ③ 幻灯片是 v1 支持的第二种展示形态，**保留**模型的选择。
           `SUPPORTED_TYPES` = ['图文', '幻灯片']（05 §5.4 / Q-19）。 */
        contentType: SUPPORTED_TYPES.indexOf(ct) >= 0 ? ct : '图文',
        /* 刻意**不写** duration（连 key 都不出现）：没生成内容之前它没有可信来源 */
      }
    })
    return {
      id: `ch-${chNo}`,
      order: ci + 1,
      name: String(ch?.name ?? '').trim(),
      description: ch?.description ? String(ch.description) : undefined,
      knowledgePoints: kps,
    }
  })
  const difficulty = ['入门', '中级', '高级'].indexOf(obj?.difficulty) >= 0 ? obj.difficulty : '入门'
  return {
    /* 引用资源**不来自模型**，来自用户诉求/附件（见 runCourseDerivation） */
    sources: Array.isArray(sources) ? sources.slice() : [],
    request: String(request || ''),
    name: String(obj?.name ?? '').trim().slice(0, 60),
    description: obj?.description ? String(obj.description).slice(0, 2000) : '',
    difficulty,
    /* 分类：**字段保留、生成阶段恒为空**（用户需求）。域名层与界面都支持分类
       （`outline.revise` 的 setCategory / 课程库的分类下拉），只是推导不产出它 ——
       所以这里无条件写空，而不是把字段从结构里去掉。 */
    category: '',
    /* 标签：规则里要 2..3 个，这里**再兜一道**（模型偶尔会多给）—— 超过 3 个就截断 */
    tags: Array.isArray(obj?.tags)
      ? obj.tags.map((t) => String(t).trim()).filter(Boolean).slice(0, 3)
      : [],
    outline: { chapters },
  }
}

/* --------------------------------------------------- 校验 + 落库（T-7） */

/**
 * 解析 → 规范化 → 校验 → 落库。任一步失败都**不落库**（FR-1 边界）。
 * 返回 `{ ok:true, course }` 或 `{ ok:false, error }`。
 */
export async function applyDerivation (courses, text, opts = {}) {
  const parsed = parseDerivation(text)
  if (!parsed.ok) return { ok: false, error: parsed.error }
  const normalized = normalizeDerivation(parsed.value, opts)
  try {
    const course = await courses.create(normalized)
    return { ok: true, course }
  } catch (err) {
    /* 领域层的拒绝理由要原样带给用户（"哪一条不满足"），不要吞成通用错误 */
    return { ok: false, error: { code: err.code ?? 'invalid-outline', message: err.message, detail: err.detail } }
  }
}

/* --------------------------------------------------------------- 接线 */

/**
 * 尽力而为地把领域约束也注入 systemPrompt。
 *
 * ⚠️ **`ctx.systemPrompt.register` 并不存在**（2026-10-14 由浏览器 Console 实测：
 * `TypeError: ctx.systemPrompt.register is not a function`）。原先按文档猜的这个方法
 * 让整个插件激活失败。现在：
 *   · 先 `typeof` 检查，服务没有该方法就**跳过**，不影响激活
 *   · 真正保证模型看到约束的是 `buildDerivationPrompt`（约束随 prompt 一起发）
 * `systemPrompt` 的确切可用方法仍是未确认项（doc/04 的 U-17）。
 */
export function registerSystemPrompt (ctx) {
  try {
    const sp = ctx.get ? ctx.get('systemPrompt') : ctx.systemPrompt
    if (!sp || typeof sp.register !== 'function') return undefined
    return sp.register({ id: 'dsh-ai-courses/derivation-rules', text: DERIVATION_RULES })
  } catch {
    return undefined
  }
}

/**
 * `/ai-course` 的推导链路。`derive` 默认走宿主 agent；测试时注入假的。
 * 返回给用户的话术由这里统一组织（成功/失败都给出下一步）。
 */
/** 课程结构的 JSON Schema（交给 `subagents.start` 的 `outputSchema`，让模型直接产出结构化结果）。 */
export const DERIVATION_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['name', 'outline'],
  properties: {
    name: { type: 'string' },
    description: { type: 'string' },
    difficulty: { type: 'string', enum: ['入门', '中级', '高级'] },
    /* 分类**保留在 schema 里**（字段不删），但生成阶段恒为空：约束里要求输出 `""`，
       落到课程时由 normalizeDerivation 无条件写空 —— 双保险，模型填了也不算数。
       也**没有**给 tags 加 `maxItems: 3` —— 结构化输出里强行卡上限可能让整次输出被判非法，
       截断改在 normalizeDerivation 里做（宽进严出）。 */
    category: { type: 'string', description: '固定为空字符串' },
    tags: { type: 'array', items: { type: 'string' } },
    outline: {
      type: 'object',
      additionalProperties: false,
      required: ['chapters'],
      properties: {
        chapters: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['name', 'knowledgePoints'],
            properties: {
              name: { type: 'string' },
              description: { type: 'string' },
              knowledgePoints: {
                type: 'array',
                items: {
                  type: 'object',
                  additionalProperties: false,
                  /* duration **不在 required 里**（大纲阶段不估计时长，见规则 5）；
                     仍允许出现，但 `normalizeDerivation` 会**丢掉**它 —— 统一由内容生成回填。 */
                  required: ['name', 'contentType'],
                  properties: {
                    name: { type: 'string' },
                    contentType: { type: 'string', enum: CONTENT_TYPES },
                    duration: { type: 'integer' },
                  },
                },
              },
            },
          },
        },
      },
    },
  },
}

/**
 * 默认的 `derive`：走宿主的**一次性子 agent**（E-21，2026-10-14 由 `subagents` 契约核实，U-5 关闭）。
 *
 *   const run = await ctx.subagents.start(provider, {
 *     label: 'ai-courses/derivation',
 *     prompt: [{ type: 'text', text: prompt }],
 *     parent,                     // = { id: SessionId }，**必填**
 *     signal,
 *     outputSchema: DERIVATION_SCHEMA,   // 给了它，结构化结果在 run.result.structured
 *   })
 *   const res = await run.result
 *   await run.dispose()
 *   返回：res.structured 有值就用它（序列化后走统一解析），否则回退到 res.output 的文本
 *
 * `provider` 取 `ctx.subagents.list()[0]`（provider 名由组合决定，不硬编码）。
 * ⚠️ 仍需确认的一点：`parent` 从哪里来（命令处理器 `exec` 上是否带 Agent）。取不到时**报明确错误**，不猜。
 */
export function defaultDerive (ctx, { provider, parent, signal } = {}) {
  return async function derive (prompt) {
    return callSubagent(ctx, { provider, parent, signal, prompt, label: 'ai-courses/derivation', outputSchema: DERIVATION_SCHEMA, json: true })
  }
}

/**
 * 调一次性子 agent 的**唯一实现**（推导与内容生成共用）。
 *
 * ⚠️ `parent` 必填（`subagents.start` 的硬要求）；拿不到就报明确错误，不猜。
 * `outputSchema` 给了就用 `res.structured`（`json:true` 时序列化成字符串返回）；
 * 没给（内容生成）就直接回文本 —— 正文本来就是 Markdown，套一层 JSON 只会多一次编解码。
 */
export async function callSubagent (ctx, { provider, parent, signal, prompt, label, outputSchema, json = false } = {}) {
  if (!parent || !parent.id) {
    throw new Error('拿不到当前会话的 Agent（subagents.start 的 parent 是必填），其来源待确认')
  }
  const name = provider ?? (ctx.subagents && typeof ctx.subagents.list === 'function' ? ctx.subagents.list()[0] : undefined)
  if (!name) throw new Error('没有可用的 subagents provider')
  const run = await ctx.subagents.start(name, {
    label: label || 'ai-courses/task',
    prompt: [{ type: 'text', text: prompt }],
    parent,
    signal: signal ?? new AbortController().signal,
    ...(outputSchema ? { outputSchema } : {}),
  })
  try {
    const res = await run.result
    if (json && res && res.structured !== undefined && res.structured !== null) {
      return JSON.stringify(res.structured)
    }
    const text = (res?.output ?? []).filter((b) => b.type === 'text').map((b) => b.text).join('\n')
    if (text && text.trim()) return text
    if (res && res.structured !== undefined && res.structured !== null) return res.structured
    throw new Error(res?.diagnostic || `子 agent 没有产出内容（stopReason=${res?.stopReason}）`)
  } finally {
    await run.dispose?.()
  }
}

export async function runCourseDerivation ({ deps, request, attachments = [], derive, commandId = '', sessionId = '' }) {
  /* 实时状态：主会话的命令卡片轮询它（`status.get`）。**只上报状态，不参与判定** ——
     status 表的任何失败都被它自己吞掉（见 15-status.mjs），不会让推导失败。 */
  const live = deps && deps.status
  const track = (fn, ...args) => { try { live && live[fn] && live[fn](sessionId, ...args) } catch { /* 观测面 */ } }
  track('start', { commandId: commandId || '', request: request })

  /* **引用资源**：诉求里点名的路径/链接 + 附件。推导阶段只记下来（不读正文），
     生成知识点内容时再读（07-sources.mjs 的边界：只读文本、限量、失败不阻断）。 */
  const attachmentRefs = (attachments || []).map((a) => {
    const ref = (a && (a.path || a.url || a.ref)) || ''
    return ref ? { ref: String(ref), name: (a && a.name) || String(ref).split('/').pop() } : null
  }).filter(Boolean)
  const sources = mergeSources(extractRefs(request), attachmentRefs)

  const prompt = buildDerivationPrompt(request, attachments)
  let text
  try {
    text = await derive(prompt)
  } catch (err) {
    const message = err && err.message ? err.message : '未知错误'
    track('fail', message)
    return { kind: 'error', text: `课程推导失败：${message}。诉求与附件都已保留，可以重试。` }
  }
  track('step', 'derived', '已拿到课程结构，正在校验')
  const applied = await applyDerivation(deps.courses, text, { sources, request })
  if (!applied.ok) {
    track('fail', applied.error.message)
    return {
      kind: 'error',
      text: `模型返回的课程结构不合法，已拒绝落库（没有产生半成品）：${applied.error.message}\n\n可以重试，或把诉求写得更具体一些。`,
    }
  }
  track('step', 'saving', '正在写入课程库')
  const c = applied.course
  const kpCount = c.outline.chapters.reduce((n, ch) => n + ch.knowledgePoints.length, 0)
  track('finish', { courseId: c.id, courseName: c.name, chapterCount: c.outline.chapters.length, kpCount: kpCount })
  return {
    kind: 'success',
    text: `已生成课程《${c.name}》：${c.outline.chapters.length} 个章节、${kpCount} 个知识点（全部为「未生成」）。\n\n下一步：在课程库打开它，逐个生成内容。`,
    courseId: c.id,
  }
}
