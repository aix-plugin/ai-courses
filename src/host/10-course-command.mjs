import { runCourseDerivation, defaultDerive, registerSystemPrompt } from './10-prompt.mjs'
import { renderCourseBlock } from './60-tools.mjs'

/**
 * `/ai-course <请求> [+附件]` —— 发起课程生成。
 *
 * M0 只做「命令可解析、生命周期可见」：真正的推导链路在 M1（T-10）。
 */
function registerCourseCommand (ctx, deps) {
  return ctx.commands.register({
    name: 'ai-course',
    description: '把一个学习诉求变成结构化课程（课程 / 大纲 / 章节 / 知识点），不生成内容资产',
    input: {
      hint: '用 3 章讲清 React Server Components，我熟悉 Vue 不熟 React',
      attachments: true,
    },
    async handler (exec) {
      const request = (exec.rawInput || '').trim()
      if (!request) {
        return {
          kind: 'error',
          text: '请说明你想学什么：`/ai-course <学习诉求>`，也可以附上参考资料（PDF / 笔记）。',
        }
      }
      /* Q-2：同一诉求重复 /ai-course 时，先展示已有相关课程的大纲并询问，而不是直接新建 */
      const dup = await findSimilarCourse(deps.courses, request)
      if (dup) {
        return {
          kind: 'success',
          text:
            `已经有一门相关课程《${dup.name}》（${dup.chapterCount} 章），大纲如下：\n\n` +
            `${renderCourseBlock(dup.course)}\n\n` +
            '要继续生成**新课程**吗？回一句确认我就开始；或者直接说想在这门课上补什么。',
        }
      }
      return runCourseDerivation({
        deps,
        request,
        attachments: exec.attachments ?? [],
        /* 实时状态以**会话 id** 为键（同一会话同时只有一个命令在跑），
           `commandId` 一并回给前端，避免把上一轮的残留状态当成这一轮（15-status.mjs） */
        sessionId: exec.agent && exec.agent.id ? String(exec.agent.id) : '',
        commandId: exec.commandId ? String(exec.commandId) : '',
        /* E-22：CommandInvocation 上就有 agent 与 signal —— 正是 subagents.start 需要的 */
        derive: defaultDerive(ctx, { parent: exec.agent, signal: exec.signal }),
      })
    },
  })
}

/**
 * Q-2：「同一诉求」的判据**尚未定案**（是文本完全一致？还是让模型判相似？）。
 * 这里只做**保守**的实现：课程名与诉求完全一致（去空白、忽略大小写）才算重复 ——
 * 宁可漏判（多建一门课）也不误判（挡住用户真想新建的课程）。
 * 定案后替换此函数即可，行为（展示大纲 + 询问）已经由命令层固定。
 */
async function findSimilarCourse (courses, request) {
  const norm = (s) => String(s ?? '').replace(/\s+/g, '').toLowerCase()
  const want = norm(request)
  if (!want) return null
  const rows = await courses.list()
  for (const r of rows) {
    if (!r.course) continue
    if (norm(r.course.name) === want) {
      return {
        id: r.id,
        name: r.course.name,
        chapterCount: r.course.outline?.chapters?.length ?? 0,
        course: r.course,
      }
    }
  }
  return null
}
