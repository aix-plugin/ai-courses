import { StoreError } from './20-store.mjs'
import { CourseError } from './30-courses.mjs'
import { CONTENT_TYPES } from './05-constants.mjs'
import { parseContent, stripFrontmatter, estimateMinutes } from './30-generate.mjs'
import { writeAsset } from './28-assets.mjs'
import { RpcError, invoke } from './40-rpc.mjs'

/* ============================================================================
 * 模型工具（T-8）
 *
 * 三个工具（07 §「工具清单」）：`course_read` / `course_generate` / `course_content_asset_put`。
 * 参数与语义**必须**和 UI 动作一致：`course_generate` 直接调**同一个** RPC 方法
 * （`generation.start`，见 50-methods），`course_content_asset_put` 复用**同一个**资产层
 * （28-assets + 30-generate 的正文规范化），不存在「工具专用路径」。
 *
 * 并发安全：写课程库的工具**不声明** `isConcurrencySafe` —— 默认 fail-closed 为 exclusive，
 * 只有显式 `true` 才并行。`course_read` 是只读，显式声明为并发安全。
 *
 * ⚠️ **工具定义的字段名**（2026-10-14 对着在装可用的 `dsh-notes-plugin/index.mjs` 抄的，
 *   不要凭感觉改）：
 *     { name, description, parameters: <JSON Schema>, output: { schema, render }, execute(input) }
 *   · 输入 schema 的键是 **`parameters`**（不是 `input`）
 *   · 处理器叫 **`execute`**（不是 `handler`）
 *   · **必须**有 `output: { schema, render }`；`render(args, value)` 返回内容块数组，
 *     否则 `tools.register` 直接抛 `must declare output { schema, render, presentationMeta? }`
 *   这三处我最初都写错了 —— 语法合法、离线冒烟也过（冒烟用的是我的假设），只有装上才炸。
 *
 * 状态：`course_read` 已实现（依赖 T-7）。
 *       `course_generate` / `course_content_asset_put` 依赖 T-11 的任务表与资产生成，
 *       当前注册了**完整 schema**，handler 回结构化的 `not-implemented` 并指名计划任务 ——
 *       不是静默失败，也不是假装可用（冒烟里有断言钉住这一点）。
 * ========================================================================== */

/** 所有工具共用的输出声明：schema 宽松（additionalProperties），render 把结构化结果转成文本块。 */
export const TEXT_OUTPUT = {
  schema: { type: 'object', additionalProperties: true },
  render: (args, value) => [{
    type: 'text',
    text: value && typeof value.text === 'string' ? value.text : JSON.stringify(value, null, 2),
  }],
}

function toolText (text) { return { text } }

/** 大纲的紧凑文本块（07 §「output.render 返回」）——给模型读，不是给人读。 */
export function renderCourseBlock (course, scope = 'course', targetIds = []) {
  const lines = []
  const inScope = (id) => !targetIds.length || targetIds.indexOf(id) >= 0
  lines.push(`课程：${course.name}`)
  if (course.description) lines.push(`描述：${course.description}`)
  if (course.difficulty) lines.push(`难度：${course.difficulty}`)
  if (course.tags?.length) lines.push(`标签：${course.tags.join('、')}`)
  const chapters = course.outline?.chapters ?? []
  for (const ch of chapters) {
    if (scope === 'chapter' && !inScope(ch.id)) continue
    lines.push('')
    lines.push(`${ch.order}. ${ch.name}${ch.description ? ' — ' + ch.description : ''}`)
    for (const kp of ch.knowledgePoints ?? []) {
      if (scope === 'kp' && !inScope(kp.id)) continue
      /* 学习时长可能还没有（大纲阶段不估计，内容生成后回填）→ 只显示类型，不印 "undefined 分钟" */
      const dur = kp.duration ? ` · ${kp.duration} 分钟` : ''
      lines.push(`   ${ch.order}.${kp.order} ${kp.name}  [${kp.contentType}${dur}] (${kp.id})`)
    }
  }
  return lines.join('\n')
}

export function createToolDefinitions ({ deps, table }) {
  const { courses, store } = deps

  /* 复用 RPC 方法表：**同一条路径**验一遍输入，保证工具与 UI 的语义不会漂移 */
  const callRpc = (name, input) =>
    invoke(table, name, input, { logger: undefined }).then((r) => {
      if (r.status === 200 && r.body.ok) return r.body.data
      const e = r.body.error ?? { code: 'internal', message: '调用失败' }
      throw new RpcError(e.code, e.message, e.detail)
    })

  return [
    {
      name: 'course_read',
      description:
        '读取已存在的课程、大纲与学习进度。在生成内容前必须先读，以获得章节与知识点的确切上下文。',
      parameters: {
        type: 'object',
        properties: {
          courseId: { type: 'string', description: '课程 id（c-… 形式）' },
          scope: { type: 'string', enum: ['course', 'chapter', 'kp'], description: '只读某个范围；省略则整门课' },
          targetIds: { type: 'array', items: { type: 'string' }, description: 'scope 为 chapter/kp 时要读的目标 id' },
        },
        required: ['courseId'],
      },
      output: TEXT_OUTPUT,
      /* 只读 → 显式声明并发安全 */
      isConcurrencySafe: true,
      async execute (input) {
        const data = await callRpc('courses.read', { courseId: input.courseId })
        const progress = await store.readProgress(input.courseId)
        const text = renderCourseBlock(data.course, input.scope ?? 'course', input.targetIds ?? [])
        const done = Object.entries(progress.kp ?? {}).filter(([, v]) => v === '已掌握').length
        return toolText(`${text}\n\n学习进度：已掌握 ${done} 个知识点`)
      },
    },
    {
      name: 'course_generate',
      description:
        '为整门课、某一章或某些知识点发起内容生成。生成在后台进行，进度可查询。批量范围只覆盖已支持类型（图文/幻灯片）。',
      parameters: {
        type: 'object',
        properties: {
          courseId: { type: 'string' },
          scope: { type: 'string', enum: ['course', 'chapter', 'kp'] },
          targetIds: { type: 'array', items: { type: 'string' } },
          prompt: { type: 'string', description: '额外的生成提示（可留空）' },
        },
        required: ['courseId', 'scope'],
      },
      output: TEXT_OUTPUT,
      /* 写课程库 → **不**声明 isConcurrencySafe（默认 exclusive，fail-closed） */
      async execute (input, exec) {
        assertScope(input, true)
        /* 把工具上下文里的 Agent 换成 id 传下去；RPC 再按 id 换回 Agent。
           不在这里改共享状态（并发工具调用会互相覆盖）。 */
        const agent = deps.resolveAgent
          ? deps.resolveAgent(exec && exec.agent)
          : (exec && exec.agent)
        /* 与 UI 走**同一个** RPC 方法：语义、校验、任务表完全一致（07 §2 的「一份实现」） */
        const data = await callRpc('generation.start', {
          courseId: input.courseId,
          scope: input.scope,
          targetIds: input.targetIds ?? [],
          prompt: input.prompt ?? '',
          agentId: agent && agent.id ? String(agent.id) : '',
        })
        const t = data.task
        return toolText(
          `${data.alreadyRunning ? '这门课已有任务在跑，沿用：' : '已发起生成：'}${t.id}\n`
          + `范围 ${t.scope} · 目标 ${data.count} 个知识点 · 状态 ${t.state}\n`
          + '生成在后台进行，进度可用 course_read 之外的方式查询（界面会自动刷新）。',
        )
      },
    },
    {
      name: 'course_content_asset_put',
      description:
        '写回某个知识点的内容资产。正文一律传 Markdown；「图文」「幻灯片」有完整格式，其余四种类型按 Markdown 降级。内容类型必须与该知识点在大纲里的类型一致。',
      parameters: {
        type: 'object',
        properties: {
          courseId: { type: 'string' },
          kpId: { type: 'string' },
          contentType: { type: 'string', enum: CONTENT_TYPES },
          markdown: { type: 'string' },
          mediaRefs: { type: 'array', items: { type: 'string' } },
        },
        required: ['courseId', 'kpId', 'contentType', 'markdown'],
      },
      output: TEXT_OUTPUT,
      async execute (input) {
        if (CONTENT_TYPES.indexOf(input.contentType) < 0) {
          throw new RpcError('invalid-input', `内容类型非法：${input.contentType}`, { allowed: CONTENT_TYPES })
        }
        /* ⚠️ 工具写的是**某门课里某个已存在的知识点**：
           不校验课程/知识点存在性，会给任意 courseId 创建幽灵目录；
           不校验类型，会写出与大纲不一致、界面永远读不到的信封。 */
        const read = await courses.read(input.courseId)
        if (!read) throw new RpcError('not-found', `课程不存在：${input.courseId}`)
        if (read.readOnly) throw new RpcError('read-only', '这门课由更高版本写入，本版只读，不能写内容')
        let kp = null
        for (const ch of read.course.outline.chapters) {
          for (const k of ch.knowledgePoints || []) if (k.id === input.kpId) kp = k
        }
        if (!kp) throw new RpcError('not-found', `知识点不存在：${input.kpId}`)
        if (input.contentType !== kp.contentType) {
          throw new RpcError(
            'invalid-input',
            `内容类型与大纲不一致：知识点是「${kp.contentType}」，工具传入「${input.contentType}」。请先在大纲里改类型，或按当前类型写。`,
          )
        }
        /* 正文的规范化（frontmatter / H1 剥离 / 补一张示意图）与**生成链路共用同一段代码**，
           免得「模型写的」与「工具写的」两套正文规则漂移。 */
        let parsed
        try {
          const titleFromMd = String(input.markdown || '').match(/^---[\s\S]*?title:\s*(.+)$/m)?.[1]
          parsed = parseContent(
            JSON.stringify({ title: titleFromMd || kp.name, body: stripFrontmatter(input.markdown || '') }),
            { kp, contentType: input.contentType, kpId: input.kpId },
          )
        } catch (err) {
          throw new RpcError('invalid-input', `正文不合法：${(err && err.message) || err}`)
        }
        const written = await writeAsset(store, input.courseId, {
          kpId: input.kpId,
          contentType: input.contentType,
          title: parsed.title,
          body: parsed.body,
          media: parsed.media,
        })
        /* 与生成链路一致：内容落库后按正文回填时长；失败不影响写入结果 */
        try {
          await courses.setDuration(input.courseId, input.kpId, estimateMinutes(parsed.body, input.contentType))
        } catch { /* 时长是展示派生值，不能反过来把写入判失败 */ }
        return toolText(`已写入内容资产：${input.kpId}（${input.contentType}）→ ${written.relPath}${written.mediaRefs.length ? `，媒体 ${written.mediaRefs.length} 个` : ''}`)
      },
    },
  ]
}

function assertScope (input, requireTargets) {
  if (input.scope === 'course') return
  if (!Array.isArray(input.targetIds) || input.targetIds.length === 0) {
    if (requireTargets) throw new RpcError('invalid-input', `scope=${input.scope} 时必须给 targetIds`)
  }
}

/** 注册到宿主 `tools` 服务（E-3：`register(ToolDefinition)` → disposer）。 */
export function registerTools (ctx, defs) {
  return defs.map((d) => ctx.tools.register(d))
}
