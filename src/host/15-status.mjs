/* ============================================================================
 * `/ai-course` 的**会话级实时状态表**（主会话可见的推导进度）
 *
 * 为什么需要它：
 *   `command/run` → `command/done` 之间，宿主只在**处理完**才写会话日志，命令卡片
 *   因此在整个推导期间都是「无进度」的空窗（可能几十秒）。DSH 没有给插件「边跑边写
 *   会话流」的公开接口，所以状态放在**插件自己的内存表**里，由客户端的命令卡片轮询
 *   （`status.get`，见 50-methods.mjs / src/client/55-status-card.js）。
 *
 * 设计约束（与 04 号文档的口径一致）：
 *   1. **只存内存、不落盘**：进度是瞬时事实，DSH 重启后残留的 `running` 无意义
 *      （页面刷新后卡片按 `updatedAt` 判超时，见客户端）。
 *   2. **键是会话 id**（`exec.agent.id`）：同一会话同一时刻只有一个命令在跑，
 *      一条记录够用；命令 id 一并回给前端，防止「上一轮的结果」被当成这一轮的。
 *   3. **绝不抛错**：状态只是观测面，任何状态写入失败都不该让课程推导失败。
 *      所有方法对坏输入/坏状态静默降级 —— 调用方（10-prompt）不需要包 try/catch。
 * ========================================================================== */

/**
 * @param {{ now?: () => number, ttlMs?: number, limit?: number }} [opts]
 *   `ttlMs` 是记录寿命：超过它没被更新的记录在读取时**惰性淘汰**（前端因此收到 null，
 *   显示「状态已失效」而不是一份不会动的死进度）。
 */
/** 一次会话最多记多少门课的摘要（防止长会话把内存表撑大；卡片只需要最近的那一轮）。 */
const COURSE_HISTORY = 20

export function createStatusStore ({ now = () => Date.now(), ttlMs = 30 * 60 * 1000, limit = 64 } = {}) {
  const rows = new Map()

  /** 线程内同步变更；`value` 一律是**脱敏后的纯 JSON**（不含课程正文）。 */
  function emit (sessionId, value) {
    if (!sessionId) return
    try {
      rows.set(sessionId, { phase: 'running', key: '', label: '', ...value })
      clean()
    } catch { /* 观测面失败不影响主流程 */ }
  }

  function clean () {
    const t = now()
    for (const [id, row] of rows) {
      if (t - Number(row.updatedAt || 0) > ttlMs) rows.delete(id)
    }
    /* 兜底上限：会话数极多时也不让这块内存无限增长（Map 保序 = 插入序） */
    while (rows.size > limit) rows.delete(rows.keys().next().value)
  }

  return {
    /** 一次推导开始（命令卡片据此从「无进度」切到「进行中」）。 */
    start (sessionId, { commandId, request } = {}) {
      const t = now()
      const prev = rows.get(sessionId)
      emit(sessionId, {
        commandId: commandId ?? '',
        request: clip(request, 120),
        phase: 'running',
        key: 'start',
        label: '已收到诉求',
        startedAt: t,
        updatedAt: t,
        /* 本次会话**已生成过**的课程 —— 再跑一次时**保留**，不清空：
           主会话的大纲卡片按「课程列表 + 回合时间」决定每张卡显示什么（65-outline-card.js）。 */
        courses: (prev && Array.isArray(prev.courses)) ? prev.courses : [],
      })
    },

    /** 推进到下一个阶段（`key` 是机器可判定的阶段名，`label` 是给人看的文案）。 */
    step (sessionId, key, label, extra) {
      const prev = rows.get(sessionId)
      if (!prev) return
      emit(sessionId, { ...prev, key: key ?? prev.key, label: label ?? prev.label, updatedAt: now(), ...(extra || {}) })
    },

    /** 落库成功：进度卡转「已完成」，并把这门课**追加**进会话的课程列表（大纲卡片据此渲染）。 */
    finish (sessionId, { courseId, courseName, chapterCount, kpCount } = {}) {
      const prev = rows.get(sessionId)
      if (!prev) return
      const t = now()
      const entry = {
        courseId: courseId ?? '',
        courseName: clip(courseName, 60),
        chapterCount: Number(chapterCount) || 0,
        kpCount: Number(kpCount) || 0,
        at: t,
      }
      const courses = (Array.isArray(prev.courses) ? prev.courses : []).concat(entry).slice(-COURSE_HISTORY)
      emit(sessionId, {
        ...prev,
        phase: 'done',
        key: 'done',
        label: '课程已生成',
        updatedAt: t,
        courses: courses,
      })
    },

    /** 失败或取消：卡片转错误态，并带上可读原因。 */
    fail (sessionId, message) {
      const prev = rows.get(sessionId)
      if (!prev) return
      emit(sessionId, {
        ...prev,
        phase: 'error',
        key: 'error',
        label: '推导失败',
        error: clip(message, 300),
        updatedAt: now(),
      })
    },

    /** 读一条状态（脱敏后的普通对象；没有或已过期则 null）。 */
    read (sessionId) {
      const row = rows.get(sessionId)
      if (!row) return null
      /* 惰性淘汰：过期记录**不**回给前端（前端据此显示「状态已失效」而不是一份死进度） */
      if (now() - Number(row.updatedAt || 0) > ttlMs) {
        rows.delete(sessionId)
        return null
      }
      const courses = (Array.isArray(row.courses) ? row.courses : []).map((c) => ({
        courseId: c.courseId,
        courseName: c.courseName,
        chapterCount: c.chapterCount,
        kpCount: c.kpCount,
        updatedAt: c.at,
      }))
      const last = courses.length ? courses[courses.length - 1] : null
      return {
        commandId: row.commandId,
        request: row.request,
        phase: row.phase,
        key: row.key,
        label: row.label,
        error: row.error ?? '',
        startedAt: row.startedAt,
        updatedAt: row.updatedAt,
        /* 本次会话生成的课程（按落库顺序；`updatedAt` = 落库时间，供卡片按回合筛选） */
        courses: courses,
        /* 最近一门课的摘要（进度卡只用它，等价于 `courses` 的最后一项） */
        courseId: last ? last.courseId : '',
        courseName: last ? last.courseName : '',
        chapterCount: last ? last.chapterCount : 0,
        kpCount: last ? last.kpCount : 0,
      }
    },
  }
}

function clip (s, max) {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim()
  return t.length > max ? t.slice(0, max) + '…' : t
}
