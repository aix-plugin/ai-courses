/* ============================================================================
 * 内容生成的任务表与队列（05 §5.5 / FR-9）
 *
 * 职责边界：
 *   · **只管任务**：建任务、逐项推进、落 `tasks.json`、把状态给界面看。不碰模型、不碰正文。
 *   · 「一个知识点怎么生成 + 怎么落库」由 30-generate.mjs 注入成 `generateOne`，
 *     于是本模块可以完全离线冒烟（不打模型也能断言状态机）。
 *
 * 状态机（05 §5.5）：
 *   任务： queued → running → done | failed；进程重启后残留的 queued/running → interrupted
 *   条目： queued → running → done | failed
 *
 * 并发口径（**有意保守**）：
 *   · 同一门课**同时只跑一个任务**（重复发起 → 抛 `already-running`，界面提示「正在生成」）；
 *   · 不同课程各自排队，互不阻塞。
 *   理由：一次任务会连续写正文与信封，串行才能保证「任务记录 ↔ 落盘内容」始终一致。
 * ========================================================================== */

export const TASK_STATES = ['queued', 'running', 'done', 'failed', 'interrupted']
export const ITEM_STATES = ['queued', 'running', 'done', 'failed']

export function newTaskId (now = new Date(), rand = Math.random) {
  const p = (n, w = 2) => String(n).padStart(w, '0')
  const ts = now.getFullYear() + p(now.getMonth() + 1) + p(now.getDate()) + p(now.getHours()) + p(now.getMinutes()) + p(now.getSeconds())
  let hex = ''
  while (hex.length < 4) hex += Math.floor(rand() * 16).toString(16)
  return `task-${ts}-${hex.slice(0, 4)}`
}

/** 任务的内存视图 → 给 RPC 的**纯 JSON 摘要**（不含正文）。 */
function snapshot (task) {
  return {
    id: task.id,
    courseId: task.courseId,
    scope: task.scope,
    targetIds: task.targetIds,
    contentType: task.contentType || '',
    /* 只回会话 id（诊断用）；不回 Agent 对象，也不回正文 */
    agentId: task.agentId || '',
    state: task.state,
    generatedAt: task.generatedAt || '',
    startedAt: task.startedAt,
    finishedAt: task.finishedAt,
    persistError: !!task.persistError,
    total: task.items.length,
    done: task.items.filter((it) => it.state === 'done').length,
    failed: task.items.filter((it) => it.state === 'failed').length,
    items: task.items.map((it) => ({ kpId: it.kpId, state: it.state, reason: it.reason || '' })),
  }
}

/**
 * @param {object} deps
 * @param {(task: object, item: object, kpId: string, runCtx: { agent: object, signal: AbortSignal }) => Promise<void>} deps.generateOne
 *   跑一个知识点：调模型、落正文与信封。抛错 → 该条目 `failed`（不中断整批）。
 *   `runCtx` 是**每个任务自己的**生成上下文（agent / signal），不能放进闭包共享。
 * @param {() => Promise<object>} deps.loadInitial  读 `tasks.json`（通常是 `{ tasks: [] }`）
 * @param {(state: object) => Promise<void>} deps.persist  落 `tasks.json`
 * @param {() => string} [deps.nowIso]
 */
export function createTaskRunner ({ generateOne, loadInitial, persist, nowIso = () => new Date().toISOString(), logger }) {
  /** @type {Map<string, object>} taskId → 任务（内存最新视图；落盘是它的快照） */
  const tasks = new Map()
  /** 正在跑的课：courseId → taskId */
  const running = new Map()
  let loaded = false
  let marking = null

  /** 首次访问读盘；残留的 queued/running 一律改成 interrupted（不假装还在跑）。 */
  function ensureLoaded () {
    if (loaded) return Promise.resolve()
    /* 正在读就复用同一次（避免并发 create/status 各读一遍）；读失败则**下次重试**，
       而不是把「空历史」永久钉死在内存里。 */
    if (marking) return marking
    marking = Promise.resolve()
      .then(() => loadInitial())
      .then(async (raw) => {
        const list = (raw && Array.isArray(raw.tasks)) ? raw.tasks : []
        let stale = false
        for (const t of list) {
          if (!t || typeof t.id !== 'string') continue
          if (t.state === 'queued' || t.state === 'running') {
            stale = true
            tasks.set(t.id, {
              ...t,
              state: 'interrupted',
              finishedAt: t.finishedAt || nowIso(),
              items: (t.items || []).map((it) => (
                it.state === 'running' || it.state === 'queued'
                  ? { ...it, state: 'failed', reason: '宿主重启，任务已中断' }
                  : it
              )),
            })
          } else {
            tasks.set(t.id, t)
          }
        }
        if (stale) {
          await persist({ tasks: [...tasks.values()] }).catch((err) => {
            logger?.warn?.('[ai-courses] 修正中断任务时落盘失败：%s', err && err.message)
          })
        }
        loaded = true
      })
      .catch((err) => {
        logger?.warn?.('[ai-courses] 读 tasks.json 失败（按空历史继续，下次访问重试）：%s', err && err.message)
        /* 关键：失败后重置标记，下一次 ensureLoaded 会真的再读一次盘 */
        loaded = false
        marking = null
      })
    return marking
  }

  const flush = () => persist({ tasks: [...tasks.values()] })

  /** 落盘失败**不中断任务**，但要记录成可诊断的标记（否则内存态与磁盘静默分叉）。 */
  const flushQuiet = (task) => flush().catch((err) => {
    if (task) task.persistError = true
    logger?.warn?.('[ai-courses] 任务落盘失败（进度可能未保存）：%s', err && err.message)
  })

  /** 某门课当前未结束的任务（界面用它显示「生成中」）。 */
  function activeOf (courseId) {
    for (const t of tasks.values()) {
      if (t.courseId === courseId && (t.state === 'queued' || t.state === 'running')) return t
    }
    return null
  }

  /**
   * 建任务并**立刻返回**（生成在后台跑，界面按 taskId 轮询）。
   * @throws {Error & { code:'already-running'|'no-targets' }}
   */
  async function create ({ courseId, scope, targetIds, kpIds, prompt, contentType, keepExisting = false, agent = null, agentId = '', signal = null }) {
    await ensureLoaded()
    const existing = activeOf(courseId)
    if (existing) {
      const err = new Error(`这门课还有任务在跑（${existing.id}），等它结束再发起`)
      err.code = 'already-running'
      err.task = snapshot(existing)
      throw err
    }
    if (!Array.isArray(kpIds) || kpIds.length === 0) {
      const err = new Error('没有可生成的知识点（目标为空）')
      err.code = 'no-targets'
      throw err
    }
    const task = {
      id: newTaskId(),
      courseId,
      scope,
      targetIds: targetIds || [],
      prompt: String(prompt || ''),
      contentType: contentType || '',
      /* 「保留原有内容、把新内容追加在后面」（06 §6）：落进任务表，进度卡片与审计都看得到 */
      keepExisting: !!keepExisting,
      /* 会话 id 只用于诊断（**不要把 Agent 对象落盘**：它不是纯 JSON，且可能带运行时引用） */
      agentId: String(agentId || (agent && agent.id) || ''),
      state: 'queued',
      startedAt: nowIso(),
      finishedAt: null,
      generatedAt: '',
      items: kpIds.map((kpId) => ({ kpId, state: 'queued', reason: '', at: null })),
    }
    tasks.set(task.id, task)
    await flush()
    /* 每个任务一份运行上下文：并发任务各自持有自己的 agent/signal，互不覆盖。 */
    const controller = signal ? null : new AbortController()
    const runCtx = { agent, signal: signal || controller.signal, controller }
    /* 不 await 执行体：RPC 要立刻把 taskId 交给界面 */
    Promise.resolve()
      .then(() => execute(task, kpIds, runCtx))
      .catch((err) => { logger?.error?.('[ai-courses] 生成任务异常：%s', err && err.message) })
    return snapshot(task)
  }

  async function execute (task, kpIds, runCtx) {
    running.set(task.courseId, task.id)
    task.state = 'running'
    await flushQuiet(task)
    try {
      for (let i = 0; i < kpIds.length; i++) {
        const item = task.items[i]
        item.state = 'running'
        item.at = nowIso()
        await flushQuiet(task)
        try {
          await generateOne(task, item, kpIds[i], runCtx)
          item.state = 'done'
          item.reason = ''
        } catch (err) {
          item.state = 'failed'
          item.reason = String((err && err.message) || err).slice(0, 300)
        }
        item.at = nowIso()
        await flushQuiet(task)
      }
      task.state = task.items.some((it) => it.state === 'failed') ? 'failed' : 'done'
    } finally {
      task.finishedAt = nowIso()
      running.delete(task.courseId)
      await flushQuiet(task)
    }
    return snapshot(task)
  }

  return {
    ensureLoaded,
    activeOf,
    create,
    /** 任务快照；找不到回 null。 */
    get (taskId) {
      const task = tasks.get(taskId)
      return task ? snapshot(task) : null
    },

    /** 某门课最近若干条任务（新的在前）。 */
    list (courseId, limit = 10) {
      return [...tasks.values()]
        .filter((task) => task.courseId === courseId)
        .sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1))
        .slice(0, limit)
        .map(snapshot)
    },
    /** 某门课「每个知识点的生成状态」映射（界面行末状态点用它）。 */
    itemStates (courseId) {
      const out = {}
      for (const task of [...tasks.values()].sort((a, b) => (a.startedAt > b.startedAt ? -1 : 1))) {
        if (task.courseId !== courseId) continue
        for (const it of task.items) if (out[it.kpId] === undefined) out[it.kpId] = it.state
      }
      return out
    },
  }
}

export const TASKS_FILE = 'tasks.json'

/**
 * **每门课一个**任务运行器（内存一份，读盘延后到首次使用）。
 *
 * 为什么按课程分：`tasks.json` 落在**该课程目录**里（05 §5.5），所以「读盘 / 落盘」都必须知道
 * 是哪个 courseId。做成 per-course 之后，运行器内部不再需要传 courseId，也不会把两门课的
 * 任务状态混在一张表里（曾经用过「当前课程 id」这种共享可变状态，多课并发生成时会互相写坏）。
 */
export function createTaskRunners ({ store, generateOne, logger }) {
  const runners = new Map()
  const make = (courseId) => {
    const runner = createTaskRunner({
      generateOne,
      loadInitial: () => store.readContentJson(courseId, TASKS_FILE),
      persist: (state) => store.writeContentJson(courseId, TASKS_FILE, state),
      logger,
    })
    /* 绑上课 id：调用方（RPC / 界面）只管问「这门课现在在跑什么」，不必自己拼参数 */
    return Object.assign(runner, {
      courseId,
      active: () => {
        const t = runner.activeOf(courseId)
        return t ? runner.get(t.id) : null
      },
    })
  }
  return {
    for (courseId) {
      let r = runners.get(courseId)
      if (!r) { r = make(courseId); runners.set(courseId, r) }
      return r
    },
    /** **所有课程**当前在跑的任务（给主会话的常驻状态条用；每个任务带课程名）。 */
    listActive () {
      const out = []
      for (const [courseId, r] of runners) {
        const t = r.active()
        if (t) out.push({ courseId: courseId, task: t })
      }
      return out
    },
    /**
     * 清空按 courseId 缓存的运行器。
     *
     * 切换课程库根目录时**必须**清：运行器的 loadInitial/persist 持有同一个 store，
     * 换根后如果不重建，旧根的任务快照会被当成新根同一 courseId 的任务，
     * 下一次落盘就会把旧状态写进新根（复制/搬迁课程库时最容易踩）。
     * 调用前必须确认没有活跃任务（setCourseRoot 已用 listActive 守住）。
     */
    reset () {
      runners.clear()
    },
  }
}
