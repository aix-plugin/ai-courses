import { homedir, tmpdir } from 'node:os'
import { isAbsolute, relative as relativePath, resolve as resolvePath } from 'node:path'
import { realpath } from 'node:fs/promises'
import { MAX_SOURCES, MAX_SOURCE_CHARS, isTextRef, mergeSources } from './07-sources.mjs'
import { CONTENT_TYPES, SUPPORTED_TYPES, DEFERRED_TYPES, DIFFICULTIES } from './05-constants.mjs'
/* ============================================================================
 * 课程领域层（T-7）
 *
 * 只做「层级约束 + 落库」，不碰 UI、不碰生成链路。所有写操作走 store（唯一写入口）。
 *
 * 层级约束（05 §3）：
 *   课程 → 1..n 章节 → 每章 1..n 知识点
 *   · 章节 order 从 1 连续；知识点 order 在**本章内**从 1 连续
 *   · 知识点必须属于某个章节（没有游离知识点）
 *   · `duration` **可选**；有值时必须是正整数分钟（内容生成后按正文回填）；`contentType` 必须在枚举内
 *   · TODO（Q-7）：`图文`/`幻灯片`/`音频`/`视频` 必须有 ≥1 个 `mediaRefs` ——
 *     该约束在**内容资产落库**时校验，不在大纲阶段（大纲阶段还没有资产）
 *
 * 拒绝路径（不是"尽力而为"）：约束不满足 → 抛 `CourseError`，**不落库**（FR-1 边界）。
 * 原子性由 Q-6 定案：**由 AI 自行判断**，本层不做原子性校验。
 * ========================================================================== */

import { StoreError, newCourseId, isCourseId } from './20-store.mjs'


export class CourseError extends Error {
  constructor (code, message, detail) {
    super(message)
    this.name = 'CourseError'
    this.code = code
    this.detail = detail
  }
}

/* --------------------------------------------------------------- 校验 */

function bad (msg, detail) { throw new CourseError('invalid-outline', msg, detail) }

function checkChapter (ch, i) {
  if (!ch || typeof ch !== 'object') bad(`第 ${i + 1} 个章节不是对象`)
  if (typeof ch.name !== 'string' || !ch.name.trim()) bad(`第 ${i + 1} 个章节缺少名称`)
  if (ch.order !== i + 1) bad(`章节 order 必须从 1 连续：第 ${i + 1} 个章节的 order 是 ${ch.order}`, { expected: i + 1 })
  const kps = ch.knowledgePoints
  if (!Array.isArray(kps) || kps.length === 0) bad(`章节「${ch.name}」必须至少有 1 个知识点`)
  kps.forEach((kp, j) => checkKp(kp, j, ch))
}

function checkKp (kp, j, ch) {
  if (!kp || typeof kp !== 'object') bad(`章节「${ch.name}」的第 ${j + 1} 个知识点不是对象`)
  if (typeof kp.name !== 'string' || !kp.name.trim()) bad(`章节「${ch.name}」的第 ${j + 1} 个知识点缺少名称`)
  if (kp.order !== j + 1) {
    bad(`知识点 order 必须在**本章内**从 1 连续：「${kp.name}」的 order 是 ${kp.order}`, { expected: j + 1 })
  }
  if (CONTENT_TYPES.indexOf(kp.contentType) < 0) {
    bad(`知识点「${kp.name}」的 contentType 非法：${kp.contentType}`, { allowed: CONTENT_TYPES })
  }
  /* duration **允许缺省**（大纲阶段不估计时长）；一旦有值就必须是正整数分钟。
     这样「旧数据有值」与「新数据无值」都能通过校验，不用迁移。 */
  if (kp.duration !== undefined && kp.duration !== null &&
      (!Number.isInteger(kp.duration) || kp.duration <= 0)) {
    bad(`知识点「${kp.name}」的 duration 一旦提供就必须是正整数分钟`, { got: kp.duration })
  }
}

/** 引用资源 → 绝对路径（`~` 展开、相对路径按 `baseDir` 解析，默认进程工作目录）。 */
function resolveRef (ref, baseDir = process.cwd()) {
  const raw = String(ref ?? '').trim()
  if (raw === '~') return homedir()
  if (raw.startsWith('~/')) return resolvePath(homedir(), raw.slice(2))
  return isAbsolute(raw) ? raw : resolvePath(baseDir, raw)
}

/** `p` 是否落在 `root` 之内（按路径段判断，不做字符串前缀匹配）。 */
function isWithin (root, p) {
  const rel = relativePath(root, p)
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

/**
 * 「内容里的引用」允许读取的根。
 *
 * 为什么需要它：用户诉求/附件里的引用是**用户主动给的**，可以读任意文本文件；
 * 但章节/知识点描述是**模型生成**的，提示注入可以让模型写一个 `~/.config/x.json`，
 * 生成时把内容读进 prompt 发给模型提供方。所以内容里的引用只允许**会话工作区**、
 * 课程库、`/tmp` 与 `os.tmpdir()` 这几个根，且 realpath 之后再做前缀判断（防符号链接逃逸）。
 *
 * ⚠️ 不用 `process.cwd()`：宿主进程的 cwd 可能就是用户 home（甚至 `/`），
 * 拿它当白名单等于把整个家目录放进来。
 */
async function allowedSourceRoots (courseRoot, workspaceRoot) {
  const candidates = [workspaceRoot, courseRoot, '/tmp', tmpdir()].filter(Boolean)
  const out = []
  for (const c of candidates) {
    try { out.push(await realpath(c)) } catch { out.push(resolvePath(c)) }
  }
  return [...new Set(out)]
}

/** 校验整棵大纲。任一条不满足即抛错（**不落库**）。 */
export function assertOutline (outline) {
  if (!outline || typeof outline !== 'object') bad('缺少 outline')
  const chapters = outline.chapters
  if (!Array.isArray(chapters) || chapters.length === 0) bad('课程必须至少有 1 个章节')
  chapters.forEach(checkChapter)
  return true
}

export function assertCourse (course) {
  if (!course || typeof course !== 'object') bad('课程不是对象')
  if (typeof course.name !== 'string' || !course.name.trim()) bad('课程缺少名称')
  if (course.name.length > 60) bad('课程名称最长 60 字', { got: course.name.length })
  if (course.difficulty !== undefined && DIFFICULTIES.indexOf(course.difficulty) < 0) {
    bad(`难度非法：${course.difficulty}`, { allowed: DIFFICULTIES })
  }
  if (course.tags !== undefined && !Array.isArray(course.tags)) bad('tags 必须是数组')
  assertOutline(course.outline)
  return true
}

/* ------------------------------------------------------------ 领域操作 */

export function createCourseApi ({ store, now = () => new Date(), workspaceRoot = '' }) {
  const emptyProgress = () => ({ kp: {} })

  /** 新建课程：校验 → 落 course.json + 空的 progress.json。 */
  async function create (input) {
    const course = {
      id: input.id && isCourseId(input.id) ? input.id : newCourseId(now(), Math.random),
      name: String(input.name ?? '').trim(),
      description: input.description ?? '',
      difficulty: input.difficulty ?? '入门',
      category: input.category ?? '',
      tags: Array.isArray(input.tags) ? input.tags.slice() : [],
      outline: input.outline,
      /* **引用资源**（T-14）：用户在 `/ai-course` 诉求里点名的文件/链接、以及大纲描述里引用的资料。
         生成知识点内容时会把它们的原文当参考（07-sources.mjs）；这里只存引用，不存正文。 */
      sources: Array.isArray(input.sources) ? input.sources.slice(0, MAX_SOURCES) : [],
      /* 建课时的**原始诉求**：大纲会话的"题面"。生成知识点时带上它，
         父子两级生成就共享同一份上下文，而不是各自从零开始（见 07 §4.4.8）。 */
      request: String(input.request ?? '').slice(0, 4000),
      createdAt: now().toISOString(),
    }
    assertCourse(course)
    await store.writeCourse(course.id, course)
    await store.writeProgress(course.id, emptyProgress())
    return course
  }

  /** 课程内的全部知识点（大纲内联在 course.json 里，遍历一次即可）。 */
  function collectKps (course) {
    const out = []
    for (const ch of course?.outline?.chapters ?? []) {
      for (const kp of ch.knowledgePoints ?? []) out.push(kp)
    }
    return out
  }

  /**
   * 读课程；缺失或损坏时回 null（由界面决定显示空态还是错误态）。
   * 一并回**知识点层进度**（章节 / 课程进度不落盘，见 05 §6）——界面据此渲染行内「已完成」勾。
   */
  async function read (courseId) {
    if (!isCourseId(courseId)) throw new CourseError('bad-course-id', `非法的课程 id：${courseId}`)
    const r = await store.readCourse(courseId)
    if (!r.value) return null
    const progress = await store.readProgress(courseId)
    return {
      course: r.value,
      readOnly: !!r.readOnly,
      corrupt: !!r.corrupt,
      kpProgress: progress.kp ?? {},
    }
  }

  async function list () {
    return store.listCourses()
  }

  /**
   * 列表摘要：课程卡片要显示「已掌握 / 总数」（06 §3.2），而进度只落知识点层（05 §6）——
   * 所以这里把课程级进度**派生**出来，不新增任何落盘字段。
   * （`list()` 保持原样：`/ai-course` 的查重路径只关心 `course` 本身。）
   */
  async function listSummaries () {
    /* 课程之间互相独立，并发读进度；store 的串行队列只约束**写**，
       读不会互相阻塞。 */
    return Promise.all((await list()).map(async (r) => {
      const kps = r.course ? collectKps(r.course) : []
      const prog = r.course ? ((await store.readProgress(r.id)).kp ?? {}) : {}
      return {
        ...r,
        kpTotal: kps.length,
        kpMastered: kps.reduce((n, kp) => n + (prog[kp.id] === '已掌握' ? 1 : 0), 0),
      }
    }))
  }

  /**
   * 修订大纲（FR-5：改名 / 改描述 / 增删 / 调整归属与顺序）。
   * 整个修订在**一个事务**里完成：读 → 改 → 校验 → 写。校验失败不落库。
   */
  async function reviseOutline (courseId, mutate) {
    if (!isCourseId(courseId)) throw new CourseError('bad-course-id', `非法的课程 id：${courseId}`)
    return store.transact(courseId, async (tx) => {
      const cur = await tx.readCourse()
      if (!cur.value) throw new CourseError('not-found', `课程不存在：${courseId}`)
      if (cur.readOnly) throw new CourseError('read-only', '该课程由更高版本写入，本版只读')
      const next = mutate(JSON.parse(JSON.stringify(cur.value)))
      assertCourse(next)
      await tx.writeCourse(next)
      /* 大纲增删后可能留下孤儿进度键 → 只保留仍存在的知识点（05 §5.3） */
      const live = new Set()
      ;(next.outline.chapters || []).forEach((ch) => (ch.knowledgePoints || []).forEach((kp) => live.add(kp.id)))
      const prog = await tx.readProgress()
      const pruned = {}
      for (const [kpId, v] of Object.entries(prog.kp ?? {})) if (live.has(kpId)) pruned[kpId] = v
      if (Object.keys(pruned).length !== Object.keys(prog.kp ?? {}).length) {
        await tx.writeProgress({ kp: pruned })
      }
      return next
    })
  }

  /** 删除课程 = 删除课程目录（FR-10）。 */
  async function remove (courseId) {
    if (!isCourseId(courseId)) throw new CourseError('bad-course-id', `非法的课程 id：${courseId}`)
    /* 更高版本写入的课程不让本版整门删除：删了就不可逆，且本版未必理解它的字段。
       课程不存在时保持幂等（重复点击删除不报错）。 */
    const cur = await store.readCourse(courseId)
    if (cur && cur.value && cur.readOnly) {
      throw new CourseError('read-only', '该课程由更高版本写入，本版只读，不能删除')
    }
    await store.removeCourse(courseId)
    return true
  }

  /**
   * 回填某个知识点的学习时长（内容生成之后调用）。
   *
   * 为什么单独一个方法、而不是走 `outline.revise`：那条路是**用户编辑**的入口
   * （有整套 operations 协议与校验），而这是**系统派生值**的写回 —— 两者混用会让
   * 「谁改了大纲」变得不可分辨。这里只改 `duration` 一个字段，其余原样写回。
   *
   * @returns 写入的分钟数
   */
  async function setDuration (courseId, kpId, minutes) {
    const n = Number(minutes)
    if (!Number.isInteger(n) || n <= 0) throw new CourseError('invalid-input', `非法时长：${minutes}`)
    /* ⚠️ 必须走事务：生成结束回填时长时，用户可能正在修订大纲；
       锁外读 + 锁内写整份会把用户刚改的内容覆盖掉（丢更新）。
       同时检查 readOnly：更高版本写入的课程不能被本版降级重写。 */
    return store.transact(courseId, async (tx) => {
      const cur = await tx.readCourse()
      if (!cur.value) throw new CourseError('not-found', `课程不存在：${courseId}`)
      if (cur.readOnly) throw new CourseError('read-only', '该课程由更高版本写入，本版只读')
      const course = cur.value
      let hit = null
      for (const ch of course.outline?.chapters || []) {
        for (const kp of ch.knowledgePoints || []) if (kp.id === kpId) hit = kp
      }
      if (!hit) throw new CourseError('not-found', `知识点不存在：${kpId}`)
      if (hit.duration === n) return n          /* 值没变就不写，避免无意义地刷新「最近更新」 */
      hit.duration = n
      course.updatedAt = now().toISOString()
      await tx.writeCourse(course)
      return n
    })
  }

  /**
   * 补充/更新引用资源（例如用户后来在大纲里加了「参考 docs/x.md」）。
   * 去重后存回课程；返回最终列表。
   */
  async function setSources (courseId, refs) {
    return store.transact(courseId, async (tx) => {
      const cur = await tx.readCourse()
      if (!cur.value) throw new CourseError('not-found', `课程不存在：${courseId}`)
      if (cur.readOnly) throw new CourseError('read-only', '该课程由更高版本写入，本版只读')
      const course = cur.value
      const merged = mergeSources(Array.isArray(refs) ? refs : [], course.sources || [])
      const before = JSON.stringify(course.sources || [])
      if (JSON.stringify(merged) === before) return merged
      course.sources = merged
      course.updatedAt = now().toISOString()
      await tx.writeCourse(course)
      return merged
    })
  }

  /**
   * 读一个引用资源的**原文**（只读、限量）。
   *
   * 约定：
   *   · `~` 展开成 home；相对路径按**进程工作目录**解析（尽力而为，找不到就算了）；
   *   · 只读文本类扩展名（`isTextRef`），URL 不抓取（离线优先，见 07-sources 的说明）；
   *   · 任何失败都回 `{ ok:false }`，**绝不抛** —— 引用资料是"参考"，不能让它把生成搞挂。
   *
   * @param {string} ref `/abs/x.md`、`~/x.md`、`./x.md`、`src/x.ts`
   * @param {object} [opts]
   * @param {number} [opts.maxChars]
   * @param {boolean} [opts.allowExternal=true] 是否允许读允许根之外的绝对/家目录路径。
   *   **默认 true 只为了兼容既有调用**；`generateOne` 对「模型生成的内容里的引用」必须传 false。
   * @returns `{ ok, ref, path, text, truncated, error? }`
   */
  async function readSource (ref, { maxChars = MAX_SOURCE_CHARS, allowExternal = true } = {}) {
    const raw = String(ref ?? '').trim()
    if (!isTextRef(raw)) return { ok: false, ref: raw, error: '不是可读的文本文件（或是不抓取的 URL）' }
    /* 内容里的相对路径以**会话工作区**为基准（没有就以课程库为基准），
       与 allowlist 的口径一致；用户引用仍按进程 cwd 解析。 */
    const baseDir = allowExternal ? process.cwd() : (workspaceRoot || store.root)
    const abs = resolveRef(raw, baseDir)
    if (!allowExternal) {
      /* 内容里的引用（模型写的章节/知识点描述）只能读允许根之内；
         先 realpath 再判断，符号链接指向外部也会被拒。 */
      const roots = await allowedSourceRoots(store.root, workspaceRoot)
      let real = abs
      try { real = await realpath(abs) } catch { /* 文件不存在：后面的 readTextAbs 会回 ok:false */ }
      if (!roots.some((root) => isWithin(root, real))) {
        return {
          ok: false,
          ref: raw,
          path: abs,
          error: `引用路径不在允许根内（只允许工作区 / 课程库 / 临时目录）：${raw}`,
        }
      }
    }
    try {
      const text = await store.readTextAbs(abs)
      const cut = text.length > maxChars
      return { ok: true, ref: raw, path: abs, text: cut ? text.slice(0, maxChars) : text, truncated: cut }
    } catch (err) {
      return { ok: false, ref: raw, path: abs, error: String((err && err.message) || err) }
    }
  }

  return { create, read, list, listSummaries, reviseOutline, setDuration, setSources, readSource, remove }
}

/* ------------------------------------------------- 模型工具用的「可读标签」 */
/*
 * 界面**不出现**存储 id（06 §4.4）：编号一律由 order 派生。
 * 这里同时供 host 侧生成提示词/进度文案使用，保证两端一致。
 */
export const NAME_MAX = 16

export function truncateName (name) {
  const t = String(name ?? '')
  return t.length > NAME_MAX ? t.slice(0, NAME_MAX) + '…' : t
}

export function humanizeRef (course, scope, targetIds) {
  const ids = targetIds ?? []
  if (scope === 'course') return truncateName(course ? course.name : ids[0])
  if (!course) return ids.join('、')
  if (scope === 'chapter') {
    const ch = (course.outline?.chapters ?? []).find((c) => ids.indexOf(c.id) >= 0)
    return ch ? `${ch.order}-${ch.name}` : ids.join('、')
  }
  if (scope === 'kp') {
    const out = []
    for (const ch of course.outline?.chapters ?? []) {
      for (const kp of ch.knowledgePoints ?? []) {
        if (ids.indexOf(kp.id) >= 0) out.push(`${ch.order}.${kp.order}-${kp.name}`)
      }
    }
    return out.length ? out.join('、') : ids.join('、')
  }
  return ids.join('、')
}

/** 把 store 的错误码映射成 RPC 能用的错误（40-rpc 会按 code 给 HTTP 状态）。 */
export function toRpcCode (err) {
  if (err instanceof CourseError) {
    /* 领域错误码**原样**映射到 HTTP 语义：只把 not-found 之外的一律压成 invalid-input 会把
       「拿不到会话 / 没有目标」这类可操作的原因变成 500「服务器内部错误」（真机踩过）。 */
    if (err.code === 'not-found') return 'not-found'
    if (err.code === 'read-only') return 'forbidden'
    if (err.code === 'already-running') return 'conflict'
    return 'invalid-input'
  }
  if (err instanceof StoreError) return 'invalid-input'
  return 'internal'
}
