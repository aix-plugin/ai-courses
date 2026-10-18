/* ============================================================================
 * 存储层（05 §5 / ADR-0006）
 *
 * 设计要点：
 *   1. **唯一写入口**：所有落盘都经过本模块，别处不许直接写文件
 *   2. **按 courseId 串行化**：同一课程的写排队，避免读-改-写竞态
 *   3. **原子写**：交给宿主 `fs.writeText`（自带原子语义 + `expected` 乐观并发守卫），
 *      **不在插件里手工 temp+rename** —— 手工实现会绕过守卫与 FsWriteOutcome
 *   4. **损坏恢复**：单文件解析失败 → 该文件降级为空 + 原文件另存 `.corrupt-<时间戳>`，
 *      不影响其他课程（05 §5.6）
 *   5. **版本守卫**：读到更高 schemaVersion → 只读降级，不静默改写用户数据（05 §8）
 *   6. **内容正文读失败 = 未生成**（T-5b）：正文 `.md` 缺失/损坏时按「未生成」处理，不是"课程损坏"
 *
 * 本模块只看得到 `fs` 端口（`readText` / `writeText` / `mkdir` / `list` / `exists` / `remove`），
 * 因此可以在 DSH 之外用 node:fs 适配后跑冒烟（见 scripts/smoke.mjs）。
 * ========================================================================== */

export const SCHEMA_VERSION = 1

/* ------------------------------------------------------------ 路径与根目录 */

/** 展开 `~`；其余原样。Windows 上 `~` 也展开为 home。 */
export function expandRoot (root, home) {
  const r = String(root ?? '').trim() || '~/.dsh/ai-courses'
  if (r === '~') return home
  if (r.startsWith('~/') || r.startsWith('~\\')) return home + r.slice(1)
  return r
}

const COURSE_ID_RE = /^c-\d{14}-[0-9a-f]{4}$/

/** 绝对路径判定（不 import node:path：存储层只依赖 fs 端口，保持可注入）。 */
const isAbsolutePath = (p) => typeof p === 'string' && (p.startsWith('/') || /^[A-Za-z]:[\\/]/.test(p))

/** 课程 id 由「时间戳 + 随机后缀」构成。**只生成、不解析**语义（05 §4）。 */
export function newCourseId (now = new Date(), rand = Math.random) {
  const p = (n, w = 2) => String(n).padStart(w, '0')
  const ts =
    now.getFullYear() + p(now.getMonth() + 1) + p(now.getDate()) +
    p(now.getHours()) + p(now.getMinutes()) + p(now.getSeconds())
  let hex = ''
  while (hex.length < 4) hex += Math.floor(rand() * 16).toString(16)
  return `c-${ts}-${hex.slice(0, 4)}`
}

export function isCourseId (v) {
  return typeof v === 'string' && COURSE_ID_RE.test(v)
}

/* ------------------------------------------------------------------ 错误 */

export class StoreError extends Error {
  constructor (code, message, detail) {
    super(message)
    this.name = 'StoreError'
    this.code = code
    this.detail = detail
  }
}

/* ------------------------------------------------------------ 串行化队列 */

/**
 * 按 key 串行化：同一 key 的异步任务排队执行，不同 key 并行。
 * 用于保证「同一课程」的读-改-写不会交叉。
 */
export function createSerialQueue () {
  const tails = new Map()
  function run (key, task) {
    const prev = tails.get(key) ?? Promise.resolve()
    const next = prev.then(task, task)
    // 让队列不因单次失败而卡死：把结果吞掉，只保留"完成"信号
    tails.set(key, next.then(() => undefined, () => undefined))
    return next
  }
  /** 等当前所有在途写完成（切换课程库根目录前用，避免写到一半换根）。 */
  run.drain = () => Promise.all([...tails.values()]).then(() => undefined)
  return run
}

/* ------------------------------------------------------------ 损坏恢复 */

function stamp (now) {
  const p = (n) => String(n).padStart(2, '0')
  return (
    now.getFullYear() + p(now.getMonth() + 1) + p(now.getDate()) +
    p(now.getHours()) + p(now.getMinutes()) + p(now.getSeconds())
  )
}

/* ------------------------------------------------------------------ Store */

/**
 * @param {object} deps
 * @param {object} deps.fs     fs 端口：{ readText, writeText, mkdir, list, exists, remove, join }
 * @param {string} deps.root   已展开的 courseRoot
 * @param {() => Date} [deps.now]
 */
export function createStore ({ fs, root, now = () => new Date() }) {
  const run = createSerialQueue()
  const corruptions = []          // 供界面提示：本次进程内发生的降级
  /* 根目录**可切换**：配置界面改 courseRoot 后立即生效，不要求重启宿主。
     所有路径都从 currentRoot 现算，不要在创建 store 时缓存绝对路径。 */
  let currentRoot = root

  const courseDir = (courseId) => {
    if (!isCourseId(courseId)) {
      throw new StoreError('bad-course-id', `非法的课程 id：${String(courseId)}`)
    }
    return fs.join(currentRoot, courseId)
  }

  /**
   * 读一个课程目录内的 JSON 文件。
   * 失败语义：不存在 → `{ value: null, missing: true }`；解析失败 → 降级为空 + 另存损坏副本。
   */
  async function readJson (courseId, fileName) {
    const path = fs.join(courseDir(courseId), fileName)
    let raw
    try {
      raw = await fs.readText(path)
    } catch (err) {
      if (err && (err.code === 'ENOENT' || err.code === 'not-found' || err.code === 'FS_NOT_FOUND')) {
        return { value: null, missing: true, path }
      }
      throw err
    }
    let parsed
    try {
      parsed = JSON.parse(raw)
    } catch {
      const backup = `${path}.corrupt-${stamp(now())}`
      try { await fs.writeText(backup, raw) } catch { /* 备份失败不掩盖主流程 */ }
      corruptions.push({ courseId, file: fileName, backup })
      return { value: null, corrupt: true, backup, path }
    }
    // 版本守卫：更高版本 → 只读降级，不静默改写
    const v = Number(parsed && parsed.schemaVersion)
    if (Number.isFinite(v) && v > SCHEMA_VERSION) {
      return { value: parsed, path, readOnly: true, version: v }
    }
    return { value: parsed, path }
  }

  /**
   * 不加锁的原始写。**只允许在已持有该课程锁的上下文里调用**（即 `writeJson` 内部
   * 或 `transact` 的回调里）。直接对外暴露它会让并发写绕过串行化。
   */
  async function writeJsonRaw (courseId, fileName, value) {
    const dir = courseDir(courseId)
    await fs.mkdir(dir)
    const path = fs.join(dir, fileName)
    const payload = { ...value, schemaVersion: SCHEMA_VERSION }
    await fs.writeText(path, JSON.stringify(payload, null, 2) + '\n')
    return path
  }

  /** 写一个课程目录内的 JSON 文件（唯一写入口，自动加锁）。 */
  function writeJson (courseId, fileName, value) {
    return run(courseId, () => writeJsonRaw(courseId, fileName, value))
  }

  /* -------------------------------------------------- 课程文件 course.json */

  async function readCourse (courseId) {
    const r = await readJson(courseId, 'course.json')
    return r
  }

  async function writeCourse (courseId, course) {
    return writeJson(courseId, 'course.json', course)
  }

  /** 列出课程库里所有课程（按 id 排序）。损坏的课程降级为空结构，不影响其他课程。 */
  async function listCourses () {
    let entries = []
    try {
      entries = await fs.list(currentRoot)
    } catch (err) {
      if (err && (err.code === 'ENOENT' || err.code === 'not-found' || err.code === 'FS_NOT_FOUND')) return []
      throw err
    }
    /* 并发读：课程之间互相独立（store 只对**写**按 courseId 串行），
       串行 await 会让课程库加载时间随课程数线性增长。 */
    const out = await Promise.all(entries.filter((name) => isCourseId(name)).map(async (name) => {
      const r = await readCourse(name)
      /* 更新时间 = `course.json` 的 mtime + `progress.json` 的 mtime 取**较晚**者：
         改大纲（写 course.json）与标记学习进度（写 progress.json）都算「最近动过」。
         注意**不直接统计**内容资产的 mtime；但 duration 回填会写 course.json，
         所以「生成完」仍可能把课程顶到最前 —— 这一条留到 P1/P2 再收敛（见 doc/13 §0.1）。 */
      const [courseAt, progressAt] = await Promise.all([
        readMtime(name, 'course.json'),
        readMtime(name, 'progress.json'),
      ])
      const updatedAt = Math.max(courseAt, progressAt)
      return r.value
        ? { id: name, course: r.value, readOnly: !!r.readOnly, corrupt: !!r.corrupt, updatedAt }
        : { id: name, course: null, corrupt: !!r.corrupt, missing: !!r.missing, updatedAt }
    }))
    out.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    return out
  }

  /* ------------------------------------------------------- 进度 progress.json */

  /** 课程目录内某个文件的 mtime（毫秒）；文件不存在或端口不支持 → `0`。 */
  /**
   * 读**课程库之外**的任意绝对路径文本（只给「引用资源」用，见 07-sources）。
   *
   * 为什么单独一个方法：其余读接口都以「课程 id + 课程内相对路径」为口径（越界有校验），
   * 而引用资料在用户自己的目录里 —— 那是另一类信任边界，混进 `readRelBytes` 会把
   * 「课程目录内」这个不变量弄坏。这里要求**绝对路径**，且只读文本。
   */
  async function readTextAbs (absPath) {
    if (typeof absPath !== 'string' || !isAbsolutePath(absPath)) {
      throw new Error(`引用资源需要绝对路径，收到：${JSON.stringify(absPath)}`)
    }
    return fs.readText(absPath)
  }

  async function readMtime (courseId, fileName) {
    if (typeof fs.mtime !== 'function') return 0
    try {
      return await fs.mtime(fs.join(courseDir(courseId), fileName))
    } catch {
      return 0
    }
  }

  async function readProgress (courseId) {
    const r = await readJson(courseId, 'progress.json')
    return (r.value && r.value.kp) ? r.value : { kp: {} }
  }

  async function writeProgress (courseId, progress) {
    return writeJson(courseId, 'progress.json', progress)
  }

  /* ------------------------------------------------ 内容正文（T-5b） */

  /**
   * 读内容正文。**正文缺失或不合法一律返回 null** —— 调用方据此显示「未生成」，
   * 而不是把它当成"课程损坏"（05 §5.6：内容层失败不上升为结构层失败）。
   */
  async function readContentText (courseId, relPath) {
    const path = fs.join(courseDir(courseId), relPath)
    try {
      const text = await fs.readText(path)
      return typeof text === 'string' && text.trim() ? text : null
    } catch (err) {
      if (err && (err.code === 'ENOENT' || err.code === 'not-found' || err.code === 'FS_NOT_FOUND')) return null
      return null
    }
  }

  async function writeContentText (courseId, relPath, text) {
    return run(courseId, async () => {
      const path = fs.join(courseDir(courseId), relPath)
      await fs.mkdir(fs.join(courseDir(courseId), relPath.split('/').slice(0, -1).join('/')))
      await fs.writeText(path, text)
      return path
    })
  }

  /* -------------------------------------------- 内容资产的 JSON 与目录列举 */

  /**
   * 读课程目录内的一个 JSON（内容层用：资产信封 `content-assets/<kpId>.json`、`tasks.json`）。
   * 与 `readJson` 同一套降级语义：不存在 → `null`；解析失败 → 另存 `.corrupt-*` 后回 `null`。
   * ⚠️ 不做版本守卫（信封的 `schemaVersion` 与课程不同轴，由资产层自己判）。
   */
  async function readContentJson (courseId, relPath) {
    const path = fs.join(courseDir(courseId), relPath)
    let raw
    try {
      raw = await fs.readText(path)
    } catch (err) {
      if (err && (err.code === 'ENOENT' || err.code === 'not-found' || err.code === 'FS_NOT_FOUND')) return null
      throw err
    }
    try {
      return JSON.parse(raw)
    } catch {
      const backup = `${path}.corrupt-${stamp(now())}`
      try { await fs.writeText(backup, raw) } catch { /* 备份失败不掩盖主流程 */ }
      corruptions.push({ courseId, file: relPath, backup })
      return null
    }
  }

  /** 写课程目录内的一个 JSON（内容层用；走唯一写入口的串行化）。 */
  function writeContentJson (courseId, relPath, value) {
    return run(courseId, async () => {
      const path = fs.join(courseDir(courseId), relPath)
      await fs.mkdir(fs.join(courseDir(courseId), relPath.split('/').slice(0, -1).join('/')))
      await fs.writeText(path, JSON.stringify({ ...value, schemaVersion: SCHEMA_VERSION }, null, 2) + '\n')
      return path
    })
  }

  /** 列课程目录下的一个子目录（不存在 → `[]`）。 */
  async function listDirRel (courseId, relPath) {
    try {
      return await fs.list(fs.join(courseDir(courseId), relPath))
    } catch (err) {
      if (err && (err.code === 'ENOENT' || err.code === 'not-found' || err.code === 'FS_NOT_FOUND')) return []
      return []
    }
  }

  /** 课程目录内的相对路径 → 绝对路径（越界路径直接抛；媒体读取与列目录共用）。 */
  function joinRel (courseId, relPath) {
    const rel = String(relPath ?? '')
    if (!rel || rel.startsWith('/') || rel.startsWith('\\') || rel.indexOf('\\') >= 0 ||
        !rel.split('/').every((seg) => seg && seg !== '.' && seg !== '..')) {
      throw new StoreError('bad-path', `非法的相对路径：${rel}`)
    }
    return fs.join(courseDir(courseId), rel)
  }

  /**
   * 读一个相对路径的媒体内容。
   * 有 `readBytes` 就用它（二进制安全）；端口只有 `readText` 时回退到文本（v1 的媒体是 SVG，文本即可）。
   */
  async function readRelBytes (courseId, relPath) {
    const path = joinRel(courseId, relPath)
    return fs.readBytes ? fs.readBytes(path) : fs.readText(path)
  }

  /** 删除课程目录内的**一个**相对路径文件（走 `joinRel` 越界校验；目录不存在的删除是幂等的）。 */
  async function removeRel (courseId, relPath) {
    return run(courseId, () => fs.remove(joinRel(courseId, relPath)))
  }

  /** 删除整门课 = 删除该课程目录（FR-10：单点操作，结构化数据与内容都在里面）。 */
  async function removeCourse (courseId) {
    return run(courseId, () => fs.remove(courseDir(courseId)))
  }

  return {
    /** 当前课程库根目录；切换后所有读写立即走新根。 */
    get root () { return currentRoot },
    /** 切换课程库根目录（配置界面用）。调用方应先用 drain() 等在途写结束。 */
    setRoot (next) { currentRoot = next },
    /** 等在途写结束（切根前用）。 */
    drain: () => run.drain(),
    courseDir,
    readJson,
    writeJson,
    readCourse,
    writeCourse,
    listCourses,
    readProgress,
    writeProgress,
    readTextAbs,
    readContentText,
    writeContentText,
    readContentJson,
    writeContentJson,
    listDirRel,
    joinRel,
    readRelBytes,
    removeRel,
    removeCourse,
    corruptions,
    /**
     * 串行地把一次「读-改-写」做完；并发调用同一课程会排队。
     *
     * 回调收到的是**已持有锁**的操作集（`tx.writeCourse` 等直接落盘、不再进队列）。
     * ⚠️ 回调里**不要**调用 `store.writeCourse` / `store.transact` 等公开方法 ——
     * 它们会再次申请同一把锁，**自我死锁**（这个坑刚被冒烟测出来）。
     */
    transact (courseId, fn) {
      return run(courseId, () =>
        fn({
          readCourse: () => readCourse(courseId),
          writeCourse: (course) => writeJsonRaw(courseId, 'course.json', course),
          readProgress: () => readProgress(courseId),
          writeProgress: (p) => writeJsonRaw(courseId, 'progress.json', p),
          writeContentText: async (relPath, text) => {
            const path = fs.join(courseDir(courseId), relPath)
            await fs.mkdir(fs.join(courseDir(courseId), relPath.split('/').slice(0, -1).join('/')))
            await fs.writeText(path, text)
            return path
          },
          writeContentJson: async (relPath, value) => {
            const path = fs.join(courseDir(courseId), relPath)
            await fs.mkdir(fs.join(courseDir(courseId), relPath.split('/').slice(0, -1).join('/')))
            await fs.writeText(path, JSON.stringify({ ...value, schemaVersion: SCHEMA_VERSION }, null, 2) + '\n')
            return path
          },
          readContentJson: (relPath) => readContentJson(courseId, relPath),
        }))
    },
  }
}
