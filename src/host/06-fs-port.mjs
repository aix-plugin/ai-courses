/* ============================================================================
 * 课程库的文件端口（T-5 的存储层只看这个端口，不关心底下是谁）
 *
 * ## 为什么不用宿主的 `ctx.fs`（2026-10-16 真机实测，证据记在 doc/04 E-24…E-27）
 *
 * 原设计把 `ctx.fs` 当作硬依赖，真机一打就露出三条硬伤：
 *
 *   1. **它是沙箱化的**（实例是 `SandboxedFileSystem`）。当前策略
 *      `{ mode: 'workspace-write', workspaceRoot: <会话工作区> }` 下，可写根只有
 *      「工作区 + /tmp + os.tmpdir()」；默认课程库 `~/.dsh/ai-courses` 落在这些根之外 →
 *      `writeText` 直接回 `FsError: FS_SANDBOX_DENIED "file access denied under workspace-write mode"`。
 *      读（`readText`/`listDir`/`stat`）不设栅栏，但课程库显然是要写的。
 *   2. **它没有删除能力**：`LocalFileSystem` 的原型上只有
 *      `watch / withLock / resolve / processPath / processPathFromHostPath / fileUrl / contains /
 *       stat / lstat / readText / streamText / readBytes / readByteRange / listDir / writeText /
 *       editText / versionAfterWrite` —— **没有** `remove` / `unlink` / `rmdir`。
 *      而 FR-10 的「删除课程 = 删除该课程目录」必须能删目录。
 *   3. **形状不匹配**：`resolve()` 是 async 且返回描述对象（`{targetKey, displayPath}`），
 *      `listDir()` 返回对象数组（`[{name, type, target, version?, size?}]`）——
 *      存储层要的是「字符串路径 + 名字字符串」，用它就得每处来回翻译。
 *
 * 因此课程库直接用内建的 `node:fs/promises`：零依赖、路径即用户配置的 `courseRoot`、
 * 删除与自建父目录都在。**这与在装先例一致**：`dsh-notes-plugin` 同样用 node:fs 直接读写
 * `~/.dsh/notes`（它的 host 入口里 `fsNode.existsSync` / `readFileSync` 就是干这个的）。
 *
 * ## 端口形状（存储层只依赖这些）
 *   join(...parts) / list(dir) / readText(path) / writeText(path, text) / mkdir(dir) /
 *   exists(path) / mtime(path) / remove(path)
 * 语义约定：
 *   · **路径必须是绝对路径**（相对路径一律报错并点名是谁传的）—— 课程库不接受相对路径
 *   · `list` 只回**名字**（不含路径）；目录不存在回 `[]`（课程库空 ≠ 出错）
 *   · `readText` 缺文件抛错（错误码 `ENOENT`），由存储层决定「按未生成处理」
 * ========================================================================== */

import { promises as fsp } from 'node:fs'
import { join as pathJoin, isAbsolute, dirname } from 'node:path'

/** 路径守卫：绝对路径才放行，失败时报出「哪个方法 + 收到什么」。 */
function guardPath (name, p) {
  if (typeof p !== 'string' || !p || !isAbsolute(p)) {
    throw new Error(`[ai-courses] fs.${name} 需要绝对路径，收到：${JSON.stringify(p)}`)
  }
  return p
}

let tmpSeq = 0

/**
 * 建一个基于 node:fs 的端口。
 * @param {object} [deps] 允许注入 fs 实现（冒烟测试用）
 */
export function createNodeFsPort (deps = {}) {
  const fs = deps.fs ?? fsp
  return {
    join: (...parts) => pathJoin(...parts),

    list: async (dir) => {
      const p = guardPath('list', dir)
      try {
        return await fs.readdir(p)
      } catch (err) {
        /* 目录不存在 = 课程库为空，不是错误 */
        if (err && (err.code === 'ENOENT' || err.code === 'ENOTDIR')) return []
        throw err
      }
    },

    readText: (p) => fs.readFile(guardPath('readText', p), 'utf8'),

    /**
     * 写文本。两个语义要点：
     *   ① **自建父目录**（宿主 `ctx.fs.writeText` 也这样；`node:fs.writeFile` 不建，
     *      漏一次 mkdir 就是一个只在真机才炸的 bug，所以在这里统一兜住）。
     *   ② **临时文件 + rename 的原子写**：05 §5 原本把原子性交给宿主 `fs.writeText`
     *      的语义；改用 node:fs 后那层保障没有了，所以在这里自己补上（同目录 rename 是原子的），
     *      崩溃时最坏留下一个 `.tmp-*` 垃圾文件，**不会**留下写坏一半的 JSON。
     */
    writeText: async (p, text) => {
      const k = guardPath('writeText', p)
      await fs.mkdir(dirname(k), { recursive: true })
      const tmp = `${k}.tmp-${process.pid}-${++tmpSeq}`
      await fs.writeFile(tmp, text, 'utf8')
      try {
        await fs.rename(tmp, k)
      } catch (err) {
        try { await fs.rm(tmp, { force: true }) } catch { /* 清理失败不掩盖主错误 */ }
        throw err
      }
      return k
    },

    mkdir: async (dir) => {
      const p = guardPath('mkdir', dir)
      await fs.mkdir(p, { recursive: true })
    },

    exists: async (p) => {
      try {
        await fs.stat(guardPath('exists', p))
        return true
      } catch {
        return false
      }
    },

    /**
     * 文件的修改时间（毫秒）；拿不到（缺文件 / 端口不支持）一律回 `0`。
     *
     * 用途：课程库按「最近更新」排序（06 §3.2）。`0` 表示「时间不可用」——
     * 排序时由调用方决定怎么兜底（本插件用 id 降序，近似等于创建顺序）。
     * **不抛错**是刻意的：排序是装饰性能力，不能因为它把课程库整体打挂。
     */
    mtime: async (p) => {
      try {
        const st = await fs.stat(guardPath('mtime', p))
        return Number(st && st.mtimeMs) || 0
      } catch {
        return 0
      }
    },

    /** 删除整门课 = 删除这一个目录（含内容资产）。递归删除，目录不存在不算错。 */
    remove: async (p) => {
      const k = guardPath('remove', p)
      await fs.rm(k, { recursive: true, force: true })
    },
  }
}
