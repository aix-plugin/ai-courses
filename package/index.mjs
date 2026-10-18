import { existsSync, promises as fsp, readFileSync } from 'node:fs'
import { readFile as readFileAsync, realpath } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { dirname, isAbsolute, join, join as pathJoin, relative as relativePath, resolve, resolve as resolvePath } from 'node:path'

/* ============================================================================
 * dsh-ai-courses — host 半边
 * 由 scripts/build.mjs 按文件名顺序拼接 src/host/*.mjs 生成 package/index.mjs
 * 零构建、零运行时依赖；只依赖宿主服务。
 * ========================================================================== */

/* 跨段 import：只在**单独 import 本段**（如冒烟测试）时需要，拼接时由 build 剥掉。 */

/** 宿主服务依赖。
 *  ⚠️ **`fs` 已移出**：课程库改用内建 node:fs（宿主的 `ctx.fs` 是沙箱化的：写不进工作区外的
 *  默认课程库、且原型上没有删除能力）。真机实测见 06-fs-port.mjs 的文件头与 doc/04 E-24…E-27。
 *  `webServer` 是 client↔host 数据通道的载体（ADR-0001）。
 *  `subagents` 用于 `/ai-course` 的推导（E-21）。
 *
 *  ⚠️ **凡是要读的服务都必须列在这里**：cordis 对未 inject 的服务属性访问会**直接抛**
 *  （实测 `cannot get property "env" without inject`）。这类错误语法检查与离线冒烟都看不出，
 *  只有装上才暴露。 */
export const inject = ['tools', 'commands', 'systemPrompt', 'agents', 'webServer', 'subagents']

/**
 * 插件配置的默认值。
 *
 * `Config` 仍然导出（见文件末尾），但 cordis **不认普通 `validate`** —— 它读 Standard Schema
 * 的 `Config["~standard"].validate`。真正的默认值兜底在这里，`Config` 只做格式校验。
 * 配置来自 patch 行的 `config`，会原样传给 `apply(ctx, config)`。
 */
export const CONFIG_DEFAULTS = {
  courseRoot: '~/.dsh/ai-courses',
  /* ⚠️ 下面两项**目前没有被运行时代码消费**，只在 Config 校验/归一化里保留：
     保留是为了让用户 patch 里的历史配置不报错、也为了将来接上线时 schema 不变。
     接上线前不要把它们当「能限流 / 能改默认类型」的开关（见 doc/13 §P1-9）。 */
  maxParallelGenerations: 2,
  defaultContentType: '图文',
}

export function normalizeConfig (input) {
  const c = { ...CONFIG_DEFAULTS, ...(input ?? {}) }
  if (typeof c.courseRoot !== 'string' || !c.courseRoot.trim()) c.courseRoot = CONFIG_DEFAULTS.courseRoot
  const n = Number(c.maxParallelGenerations)
  c.maxParallelGenerations = Number.isFinite(n) && n >= 1 ? Math.floor(n) : CONFIG_DEFAULTS.maxParallelGenerations
  if (CONTENT_TYPES.indexOf(c.defaultContentType) < 0) c.defaultContentType = CONFIG_DEFAULTS.defaultContentType
  return c
}

/**
 * cordis 的 `resolveConfig` **不认普通的 `validate`**，它读的是
 * [Standard Schema](https://standardschema.dev) 接口 `Config["~standard"].validate`：
 *
 *   function resolveConfig(runtime, config) {
 *     if (!runtime.Config) return config
 *     const result = runtime.Config["~standard"].validate(config)   // ← 就是这里
 *     if ("then" in result) throw new TypeError("Async config validation is not supported")
 *     if (result.issues) throw new ValidationError(result.issues)
 *     else return result.value
 *   }
 *
 * （2026-10-14 从 `app.asar` 内 `@deepseek-ai/cordis/lib/index.js` 读出，非猜测。）
 * 因此 `Config` 必须提供 `~standard`；否则 `undefined.validate` → 激活失败。
 * 校验返回**同步**结果（返回 Promise 会被显式拒绝），失败回 `{ issues: [...] }`。
 */
export const Config = {
  '~standard': {
    version: 1,
    vendor: 'dsh-ai-courses',
    validate (value) {
      const issues = []
      const v = value === undefined || value === null ? {} : value
      if (typeof v !== 'object' || Array.isArray(v)) {
        return { issues: [{ message: 'config 必须是对象', path: [] }] }
      }
      if (v.courseRoot !== undefined && (typeof v.courseRoot !== 'string' || !v.courseRoot.trim())) {
        issues.push({ message: 'courseRoot 必须是非空字符串', path: ['courseRoot'] })
      }
      if (v.maxParallelGenerations !== undefined) {
        const n = Number(v.maxParallelGenerations)
        if (!Number.isInteger(n) || n < 1) {
          issues.push({ message: 'maxParallelGenerations 必须是 ≥1 的整数', path: ['maxParallelGenerations'] })
        }
      }
      if (v.defaultContentType !== undefined && CONTENT_TYPES.indexOf(v.defaultContentType) < 0) {
        issues.push({ message: `defaultContentType 必须是 ${CONTENT_TYPES.join('/')} 之一`, path: ['defaultContentType'] })
      }
      if (issues.length) return { issues }
      return { value: normalizeConfig(v) }      /* 回填默认值后的配置 */
    },
  },
}

/* ============================================================================
 * 领域常量（必须放在**最前面**）
 *
 * 拼接顺序是按文件名排的。这些常量会被**其它段的顶层**引用（例如 10-prompt 的
 * `DERIVATION_SCHEMA` 里 `enum: CONTENT_TYPES`），所以必须在任何顶层求值之前就绪 ——
 * 否则 `const` 的 TDZ 会让整个模块 import 失败，而 `node --check` **查不出来**
 * （语法是合法的），表现为 cordis 只报一句 "failed to import"。
 * ========================================================================== */

export const CONTENT_TYPES = ['图文', '幻灯片', '音频', '视频', '代码', '测验']
/** v1 只有这两种有完整的生成与展示设计（Q-19）；其余进 DEFERRED。 */
export const SUPPORTED_TYPES = ['图文', '幻灯片']
export const DEFERRED_TYPES = CONTENT_TYPES.filter((t) => SUPPORTED_TYPES.indexOf(t) < 0)
export const DIFFICULTIES = ['入门', '中级', '高级']

/** 「AI 备注」的最大长度：前端 textarea 与宿主校验**共用同一个数**（避免两边不一致）。 */
export const PROMPT_MAX = 2000

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

/* ============================================================================
 * 课程「引用资源」（T-14）
 *
 * ## 要解决的问题
 *
 * 用户用 `/ai-course` 建课时，诉求里常带路径或链接（`@docs/spec.md`、`./notes.md`、
 * `https://…`）；**大纲**里也会写「参考 XX 文档」。这些引用在**大纲阶段**只用来决定结构，
 * 到了**知识点内容生成**阶段就没影了 —— 于是正文只能靠模型自己编，与用户手里那份资料无关。
 *
 * 这里做三件事（全部是纯函数，便于真值表断言）：
 *   ① `extractRefs`  ：从文本里认出「文件路径 / URL」
 *   ② `mergeSources` ：去重、限量（最多 6 个），保留来源标签
 *   ③ `formatSourcesBlock`：把读到的原文拼成 prompt 里的一段（带截断说明与总长上限）
 *
 * ## 边界
 *
 *   · **只读**：永远不写这些文件；读失败（不存在/无权限/是二进制）就跳过，绝不让生成失败；
 *   · **限量**：单文件 6 KB、单次生成合计 24 KB —— 引用资料是"参考"，不该挤掉正文篇幅；
 *   · **不信任**：路径只接受普通文本扩展名（md/txt/json/yaml/ts/js/py/csv…），
 *     目录穿越交给 `fs` 层（绝对路径 + 存在性检查），不做递归遍历。
 * ========================================================================== */

/** 最多引用几个资源（再多会挤掉正文篇幅）。 */
export const MAX_SOURCES = 6

/** 单个资源最多读多少字符（超出截断，并在 prompt 里注明）。 */
export const MAX_SOURCE_CHARS = 6000

/** 一次生成最多带多少参考资料字符（合计上限）。 */
export const MAX_TOTAL_SOURCE_CHARS = 24000

/** 认作文本的扩展名（其余一律跳过：读二进制既没意义，还会污染 prompt）。 */
const TEXT_EXT = [
  'md', 'markdown', 'txt', 'text', 'rst', 'adoc',
  'json', 'jsonl', 'yaml', 'yml', 'toml', 'ini',
  'csv', 'tsv',
  'ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'py', 'go', 'rs', 'java', 'kt', 'rb', 'sh',
  'sql', 'css', 'scss', 'html', 'xml', 'svg',
]

/** URL（http/https）—— 只记录，不在生成时抓取（离线优先，抓网页需要网络与超时策略）。 */
const URL_RE = /\bhttps?:\/\/[^\s<>"'）)】\]]+/gi

/**
 * 取「候选引用」：按分隔符切成 token，再筛出「像文件路径」的。
 *
 * 为什么不用一条大正则：路径可能以 `~` `./` `../` `/` 开头，也可能就是 `src/index.ts`
 * —— 一条正则里同时表达「至少一个 `/`」和这些前缀会变得很难读、也很难测。
 * 切 token + `isTextRef` 过滤更好验证（真值表见 generate-smoke）。
 */
const TOKEN_SPLIT = /[\s，。、；：""''（）()【】\[\]<>「」《》|]+/

/** 取扩展名（小写，不带点）。 */
export function extOf (ref) {
  const s = String(ref ?? '')
  const m = /\.([A-Za-z0-9]+)$/.exec(s.split(/[?#]/)[0])
  return m ? m[1].toLowerCase() : ''
}

/** 是不是 URL。 */
export function isUrl (ref) {
  return /^https?:\/\//i.test(String(ref ?? ''))
}

/** 是不是我们愿意读的文本文件（按扩展名判断）。 */
export function isTextRef (ref) {
  if (isUrl(ref)) return false
  return TEXT_EXT.indexOf(extOf(ref)) >= 0
}

/**
 * 从一段文本里认出引用（文件路径 / URL）。
 *
 * @param {string} text 用户诉求 / 大纲描述 / 附件说明
 * @returns {string[]} 去重后的引用（保持出现顺序）
 */
export function extractRefs (text) {
  const src = String(text ?? '')
  const out = []
  const push = (ref) => {
    const r = String(ref || '').replace(/[.,;:!?]+$/, '')
    if (!r) return
    if (out.indexOf(r) < 0) out.push(r)
  }
  let m
  URL_RE.lastIndex = 0
  while ((m = URL_RE.exec(src)) !== null) push(m[0])
  for (const rawToken of src.split(TOKEN_SPLIT)) {
    /* `@path`（DSH 里常见的引用写法）、`./a.md`、`~/a.md`、`src/index.ts` 都认；
       纯文件名（`notes.md`）不算 —— 正文里随手写的词太容易误判。 */
    const token = String(rawToken || '').replace(/^[@「]+/, '').replace(/^[(（]+/, '')
    if (!token || token.indexOf('/') < 0) continue
    if (isUrl(token)) continue
    if (!isTextRef(token)) continue
    push(token)
  }
  return out
}

/**
 * 合并多处的引用（诉求、附件、章节描述…），去重并限量。
 * @param {...Array} lists 每个元素是 `string[]` 或 `{ref, name}`
 * @returns {Array<{ref: string, name: string, kind: string}>}
 */
export function mergeSources (...lists) {
  const out = []
  const seen = new Set()
  for (const list of lists) {
    for (const item of list || []) {
      const ref = String((item && item.ref) || item || '').trim()
      if (!ref) continue
      const key = ref.toLowerCase()
      if (seen.has(key)) continue
      seen.add(key)
      out.push({
        ref,
        name: String((item && item.name) || ref.split('/').pop() || ref),
        kind: isUrl(ref) ? 'url' : 'file',
      })
      if (out.length >= MAX_SOURCES) return out
    }
  }
  return out
}

/**
 * 把「引用 + 已读到的原文」拼成 prompt 里的一段。
 *
 * @param {Array<{ref, name, text, truncated?, error?}>} sources
 * @returns {string} 空串表示没有任何可用资料（调用方据此不加这一节）
 */
export function formatSourcesBlock (sources) {
  const usable = (sources || []).filter((s) => s && s.text && String(s.text).trim())
  if (!usable.length) return ''
  const lines = []
  lines.push('## 参考资料（用户引用／课程大纲引用的原文）')
  lines.push('')
  lines.push('下面是**用户提供的资料摘录**，请把它当作事实依据来写这个知识点：')
  lines.push('- 与本次知识点相关的部分要**用上**（术语、结论、示例可以对齐它）；')
  lines.push('- **不要整段照抄**，也不要大段复述与本次知识点无关的章节；')
  lines.push('- 资料与本知识点无关时**忽略它**，不要硬凑。')
  lines.push('')
  let total = 0
  for (const s of usable) {
    const body = String(s.text)
    const take = Math.min(body.length, MAX_SOURCE_CHARS, Math.max(0, MAX_TOTAL_SOURCE_CHARS - total))
    if (take <= 0) break
    total += take
    lines.push(`### 引用：${s.name || s.ref}（${s.ref}）`)
    lines.push('```text')
    lines.push(body.slice(0, take))
    lines.push('```')
    if (take < body.length) lines.push(`（以上为节选，原文共 ${body.length} 字符）`)
    lines.push('')
  }
  return lines.join('\n').trim()
}


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

    /** 是否有会话正在推导课程（切换课程库根目录前用）。 */
    hasRunning () {
      clean()   /* 过期的 running 行不该永久挡住换根 */
      for (const row of rows.values()) {
        if (row.phase === 'running') return true
      }
      return false
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

/* ============================================================================
 * 内容资产层（05 §5.4 / §5.4.3）
 *
 * 一句话口径：**正文文件是权威内容，信封里的 `path` 只是指针**（05 §5.6）。
 *   · 信封 `content-assets/<kpId>.json` 是「已生成」的**凭据**；没有信封 = 未生成。
 *   · 正文 `content-assets/<kpId>.md` / `<kpId>.slides.md`；媒体在 `content-assets/media/`。
 *   · 路径**一律由宿主按 kpId + contentType 算**，绝不接受前端/模型传入（否则等于把
 *     路径穿越入口交给不可信输入）。校验在 `assertRel` / `assertSafeRel`。
 *
 * 本层只做「读 / 写 / 校验」，不碰模型 —— 生成链路见 30-generate.mjs。
 * ========================================================================== */

export class AssetError extends Error {
  constructor (code, message, detail) {
    super(message)
    this.name = 'AssetError'
    this.code = code
    this.detail = detail
  }
}

/** 只有这两种类型有完整的正文格式定义；其余四种按「Markdown 降级」处理（Q-19 的后续口径）。 */
export const MARKDOWN_TYPES = ['图文', '音频', '视频', '代码', '测验']
export const SLIDEV_TYPES = ['幻灯片']

/** 知识点 id 的安全形状（`kp-<章节号>-<序号>`）。 */
const KP_ID_RE = /^kp-\d{2,3}-\d{2,3}$/
/** 课程目录内的相对路径：不许绝对路径、不许 `..`、不许反斜杠、不许空段。 */
export function isSafeRel (rel) {
  if (typeof rel !== 'string' || !rel) return false
  if (rel.startsWith('/') || rel.startsWith('\\')) return false
  if (rel.indexOf('\\') >= 0) return false
  return rel.split('/').every((seg) => seg !== '' && seg !== '.' && seg !== '..')
}

export function assertKpId (kpId) {
  if (typeof kpId !== 'string' || !KP_ID_RE.test(kpId)) {
    throw new AssetError('bad-kp-id', `非法的知识点 id：${String(kpId)}`)
  }
  return kpId
}

function assertSafeRel (rel) {
  if (!isSafeRel(rel)) throw new AssetError('bad-path', `非法的相对路径：${String(rel)}`)
  return rel
}

/** 正文相对路径（与客户端 `core.contentRelPath` 必须逐字一致）。 */
export function contentRelPath (kpId, contentType) {
  return SLIDEV_TYPES.indexOf(contentType) >= 0
    ? `content-assets/${kpId}.slides.md`
    : `content-assets/${kpId}.md`
}

/** 信封相对路径。 */
export const assetRelPath = (kpId) => `content-assets/${kpId}.json`

/**
 * 新媒体的相对路径：`media/<kpId>-NN.svg`（NN 从 01 起，避开已有文件）。
 * **由宿主计算**，模型只能给「内容」不能给「路径」。
 */
export function nextMediaRelPath (kpId, existing) {
  /* `existing` 既接受字符串也接受 `{rel}`：早期只认对象，传字符串数组时 `used` 恒为空 ——
     于是追加生成的新图又拿到 `-01`，把旧图覆盖掉（实测 mediaRefs 两条指向同一文件）。 */
  const used = new Set((existing || []).map((m) => (typeof m === 'string' ? m : String((m && m.rel) || ''))).filter(Boolean))
  for (let i = 1; i <= 99; i++) {
    const rel = `content-assets/media/${kpId}-${String(i).padStart(2, '0')}.svg`
    if (!used.has(rel)) return rel
  }
  throw new AssetError('too-many-media', '同一个知识点的媒体文件过多（>99）')
}

/** 从信封里取某个 kpId 的资产（不存在 → `{}`）。 */
export function assetsOf (envelopes) {
  const out = {}
  for (const env of envelopes || []) {
    if (env && typeof env.kpId === 'string' && env.contentType) out[env.kpId] = env
  }
  return out
}

/**
 * 列出课程目录里的资产信封（`content-assets/*.json`）。
 * 读不动/坏文件一律跳过（内容层失败不上升为结构层失败）。
 */
export async function listAssets (store, courseId) {
  let names = []
  try {
    names = await store.listDirRel(courseId, 'content-assets')
  } catch {
    return []
  }
  const out = []
  for (const name of names) {
    if (!name.endsWith('.json')) continue
    const rel = assertSafeRel(`content-assets/${name}`)
    const env = await store.readContentJson(courseId, rel)
    if (env && typeof env.kpId === 'string') out.push(env)
  }
  return out
}

/**
 * 只数资产信封**文件个数**，不读内容。
 *
 * 课程库列表只需要「已生成 N / 有没有内容」，不需要每个信封的 contentType；
 * `listAssets` 会逐个读+解析 JSON，N 门课 × M 个资产就是 O(N×M) 次磁盘读。
 * 这里只看目录 + 文件名（`kp-<章节>-<序号>.json`），把列表页降到 O(N)。
 * 单个损坏信封可能被多算 1 个；真正的读取路径（学习页 / courses.read）仍会判内容。
 */
export async function countAssetFiles (store, courseId) {
  let names = []
  try {
    names = await store.listDirRel(courseId, 'content-assets')
  } catch {
    return 0
  }
  const re = /^kp-\d{2,3}-\d{2,3}\.json$/
  let n = 0
  for (const name of names) if (re.test(name)) n++
  return n
}

/**
 * 删除一组知识点的内容资产（正文 + 信封 + 媒体）。
 *
 * 调用方：`outline.revise` 里 `removeKp` / `removeChapter` 之后。删除是**尽力而为**
 * （文件不存在/读不到就跳过），绝不因为清理失败把一次成功的大纲修订判成失败。
 */
export async function removeAssets (store, courseId, kpIds) {
  for (const kpId of kpIds) {
    let env = null
    try { env = await store.readContentJson(courseId, assetRelPath(kpId)) } catch { /* 信封读不到就按无媒体处理 */ }
    const rels = new Set([
      assetRelPath(kpId),
      contentRelPath(kpId, '图文'),
      contentRelPath(kpId, '幻灯片'),
    ])
    if (env && Array.isArray(env.mediaRefs)) {
      for (const m of env.mediaRefs) {
        const p = m && m.path
        if (typeof p === 'string' && isSafeRel(p)) rels.add(p)
      }
    }
    for (const rel of rels) {
      try { await store.removeRel(courseId, rel) } catch { /* 清理失败不阻断 */ }
    }
  }
}

/**
 * 组装**学习页要的**内容载荷。
 *
 * 一致性口径（05 §5.6）：信封在、正文缺 → 按「未生成」；正文在、信封缺 → 同样「未生成」。
 * 因此判据是**两者都在**：`{ hasAsset, asset, body, media }`。
 */
export async function readAssetPayload (store, courseId, kpId, contentType) {
  assertKpId(kpId)
  const env = await store.readContentJson(courseId, assetRelPath(kpId))
  if (!env || env.kpId !== kpId || env.contentType !== contentType) {
    return { hasAsset: false, asset: null, body: null, media: [] }
  }
  const declaredPath = env.payload && typeof env.payload.path === 'string' ? env.payload.path : ''
  const rel = isSafeRel(declaredPath) ? declaredPath : contentRelPath(kpId, contentType)
  /* 路径穿越（或人为改坏的相对路径）→ 拒绝读取，按未生成处理 */
  if (!isSafeRel(rel)) return { hasAsset: false, asset: null, body: null, media: [] }
  const body = await store.readContentText(courseId, rel)
  if (!body) return { hasAsset: false, asset: null, body: null, media: [] }
  const media = (Array.isArray(env.mediaRefs) ? env.mediaRefs : [])
    .filter((m) => m && typeof m.path === 'string' && isSafeRel(m.path))
    .map((m) => ({ kind: m.kind || 'image', path: m.path, caption: m.caption || '' }))
  return { hasAsset: true, asset: env, body, media }
}

/**
 * 落一次生成结果（正文 + 信封 + 媒体）。
 *
 * **必须在一个事务里做完**：正文写成功而信封没写 = 用户看到「未生成」但磁盘上有孤儿正文；
 * 信封写成功而正文没写 = 点进去是空的（05 §5.6 明令禁止这种无定义状态）。
 *
 * @param {object} input
 *   `{ kpId, contentType, title, body, media: [{ rel, text }] }`
 */
export async function writeAsset (store, courseId, input) {
  const kpId = assertKpId(input.kpId)
  const contentType = String(input.contentType || '')
  const knownTypes = MARKDOWN_TYPES.concat(SLIDEV_TYPES)
  if (knownTypes.indexOf(contentType) < 0) {
    throw new AssetError('invalid-content-type', `内容类型非法：${contentType}`, { allowed: knownTypes })
  }
  const rel = contentRelPath(kpId, contentType)
  assertSafeRel(rel)
  const body = String(input.body ?? '')
  const media = (input.media || []).map((m) => ({ rel: assertSafeRel(m.rel), text: String(m.text ?? '') }))
  for (const m of media) {
    if (!m.text.trim()) throw new AssetError('empty-media', `媒体文件内容为空：${m.rel}`)
  }
  /* 图文/幻灯片必须有 ≥1 媒体；唯一的例外是正文里已经有 Mermaid 图（纯文本、随正文渲染）。 */
  const needsMedia = contentType === '图文' || SLIDEV_TYPES.indexOf(contentType) >= 0
  if (needsMedia && media.length === 0 && !/```\s*mermaid\b/i.test(body)) {
    throw new AssetError('missing-media', `${contentType} 必须至少有一个媒体文件（或在正文里使用 mermaid 图）`)
  }
  const envelope = {
    kpId,
    contentType,
    payload: {
      format: SLIDEV_TYPES.indexOf(contentType) >= 0 ? 'slidev-markdown' : 'markdown',
      path: rel,
    },
    mediaRefs: media.map((m) => ({
      kind: m.rel.endsWith('.svg') ? 'image' : 'file',
      path: m.rel,
      /* 引用写进正文时要用的**相对正文文件**的路径（05 §5.4.1：`![](media/…)`） */
    })),
    generatedAt: new Date().toISOString(),
    model: input.model || undefined,
  }
  await store.transact(courseId, async (tx) => {
    /* 检查放在**事务内**：避免「读时课程还在、写时已被删除/改成只读」的 TOCTOU。
       `writeAsset` 是唯一的资产写入口，不能靠调用方各自记得检查。 */
    const cur = await tx.readCourse()
    if (!cur.value) throw new AssetError('not-found', `课程不存在：${courseId}`)
    if (cur.readOnly) throw new AssetError('read-only', '该课程由更高版本写入，本版只读')
    await tx.writeContentText(rel, body)
    for (const m of media) await tx.writeContentText(m.rel, m.text)
    await tx.writeContentJson(assetRelPath(kpId), envelope)
  })
  return {
    envelope,
    mediaRefs: envelope.mediaRefs.map((m) => ({ kind: m.kind, path: m.path })),
    relPath: rel,
  }
}

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

/* ============================================================================
 * 内容生成链路（T-11 / FR-2·FR-3·FR-4）
 *
 * 分四段，每段都可单独测：
 *   ① `buildContentPrompt` —— 给模型的指令 + 上下文（纯字符串）
 *   ② `parseContent`       —— 解析并**规范化**模型回包（纯函数，含 H1 剥离、SVG 清洗）
 *   ③ `selectTargets`      —— 三种粒度（课程 / 章节 / 知识点）→ 实际要生成的知识点列表
 *   ④ `generateOne`        —— 调模型 → 解析 → 一个事务里落正文 + 信封 + 媒体
 *
 * 只有 ④ 里的「调模型」需要宿主 `subagents`，因此注入成 `callModel`（冒烟传假的）。
 *
 * 三条硬约束（05 §5.4 / §5.4.1 / Q-7）：
 *   · 正文**不得**出现 `h1`（页面标题已经展示了知识点名称）；`幻灯片` 除外（每页的 `#` 是页标题）
 *   · `图文`/`幻灯片` 的 `mediaRefs` **至少 1 个** → 生成时必须产出一张 SVG 示意图（纯本地、无外部依赖）
 *   · 路径一律由宿主计算，模型只给「内容」
 * ========================================================================== */


/** v1「Markdown 降级」的四种类型：格式未定稿，先按 Markdown 生成，界面标注「格式待定」。 */
/**
 * v1 按「Markdown 降级」处理的四种类型（Q-19 的后续口径：格式未定稿，先让它们能用，
 * 界面上标注「格式待定」）。名字刻意不与 28-assets 的 `MARKDOWN_TYPES` 相同 ——
 * 构建会把各段拼进**同一个模块**，同名 `const` 会直接让 import 失败（踩过）。
 */
export const FALLBACK_TYPES = ['音频', '视频', '代码', '测验']

/** 生成内容的 JSON 形状（给模型看的契约）。 */
export const CONTENT_SHAPE = `// body 只覆盖「← 本次」那一个知识点；不要写同章节其他知识点或其他章节的内容
{
  "title": "知识点名称（原样照抄，不要改写）",
  "body": "正文 Markdown（见下面的规则）",
  "diagram": { "alt": "这张图的说明", "svg": "<svg …>…</svg> 的完整内容" }
}`

export const CONTENT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['title', 'body'],
  properties: {
    title: { type: 'string' },
    body: { type: 'string' },
    /* `diagram` 不放进 required：宽松一点，缺图时由解析层兜底（补一张占位示意图），
       不让「少一张图」升级成「整次生成失败」 */
    diagram: {
      type: 'object',
      additionalProperties: false,
      required: ['alt', 'svg'],
      properties: {
        alt: { type: 'string' },
        svg: { type: 'string' },
      },
    },
  },
}

/* ---------------------------------------------------------------- ① 提示词 */

const COMMON_RULES = `你在为一个「本地 AI 课程」应用写**一个知识点**的学习内容。必须遵守：

1. **范围由课程大纲界定**（见下方「课程大纲」与「本次要写的知识点」）：
   - 只写**标记为「← 本次」的那一个**知识点，不要写别的知识点，也不要替它们**预告内容**；
   - **不许越界**：出现在其他章节里的知识点，即使与本次相关，本次也只做**一句话的衔接**，
     不展开讲解（它们各自有专门的内容）；
   - 如果本次知识点需要先解释某个前置概念，而那个概念**是另一个知识点**，就把读者引到那一节，
     而不是把它写一遍；
   - 不要重复标题（页面标题已经展示它）。
2. 语言与课程一致（默认中文），面向**已经会一点、但不熟悉这个主题**的读者。
3. 正文必须自足：读者只看这一段就能理解，不依赖外部链接。
4. **不要写任何图片链接**（图片由后面的 diagram 字段提供，宿主会自己插入）。
5. 只回一个 JSON 对象，不要解释、不要 Markdown 代码围栏之外的内容。`

const MARKDOWN_RULES = `正文是 **Markdown 子集**，规则：
- **不要写 H1（一级标题）**，也不要开头再写一遍知识点名称（页面标题已经展示它）；层级从 \`##\` 开始。
- 可用：\`##\`/\`###\` 标题、段落、有序/无序列表、\`**粗体**\`、行内代码、围栏代码块（带语言）、引用、**表格**。
- **表格用 Markdown 管道表**（\`| 列 | 列 |\` + \`|---|---|\` 分隔行）；**不要写 HTML 标签**
  （\`<table>\`、\`<div>\`、\`<br>\` 这类都不渲染 —— 页面只认 Markdown 子集）。
- 长度：**400~900 字**为宜（含代码/表格）。短而准，不要灌水。
- 结构建议：先给一句「这是什么/为什么重要」，再分 2~4 个小节讲清机制与边界，最后给一个常见误区或小结。`

const SLIDEV_RULES = `正文是 **Slidev 方言 Markdown**（本应用只支持它的一个子集），规则：
- 文件以 headmatter 开头：

  ---
  title: <知识点名称>
  ---

- **分页**用一行**恰好**是 \`---\`；每页开头可选一个 frontmatter 块（只支持 \`layout\` / \`title\`）。
- 每页用 \`#\` 写**本页**标题（这里是允许的，它是页标题不是页面标题）。
- 支持的 \`layout\`：\`default\`、\`cover\`、\`center\`、\`two-cols\`、\`two-cols-header\`、\`image-right\`、\`image-left\`、\`quote\`。
- 讲稿（演讲者备注）写在**该页末尾**的 HTML 注释块里：\`<!-- 讲稿文字 -->\`。
- 页数 **4~8 页**：封面 1 页 + 内容 3~6 页 + 小结 1 页。
- **表格用 Markdown 管道表**（\`| 列 | 列 |\` + \`|---|---|\` 分隔行）。**不要写 HTML 标签**
  （\`<table>\` / \`<div>\` / \`<br>\` 这类一律不要 —— 页面只渲染 Markdown 子集）。
- 每页正文建议 **3~6 个要点/段落**，别把一页塞满：版式是固定画布。
- 不要使用 Slidev 的交互特性（\`<v-click>\`、\`:::\`、组件、代码运行）；**Mermaid 除外**（见下）。`

const DIAGRAM_RULES = `**图表优先级**：凡是结构类信息（流程 / 时序 / 状态 / 关系 / 分层），**先**在正文里用
**Mermaid 代码块**表达（\`\`\`mermaid 围栏 + \`flowchart TD\` / \`sequenceDiagram\` / \`stateDiagram-v2\` /
\`classDiagram\` / \`erDiagram\`）—— 它是最直接可渲染的 Markdown 图表，应用会画出来。
这种情况**可以不写** \`diagram\`；只有 Mermaid 表达不了（精确空间位置、插画式示意）才补一张 SVG。

另外可以再给一张**示意图**（\`diagram\`，可选）：
- \`svg\` 是**完整的内联 SVG 元素**（\`<svg viewBox="0 0 640 360" …>…</svg>\`）。
- 只用：\`rect\` \`circle\` \`ellipse\` \`line\` \`path\` \`polygon\` \`polyline\` \`text\` \`tspan\` \`g\` \`defs\` \`marker\`。
- **禁止**：\`<script>\`、\`<style>\`、\`<foreignObject>\`、\`<image>\`、\`on*\` 事件属性、\`javascript:\`、外部链接。
- 颜色用 \`currentColor\` 或 \`#333\`/\`#888\`/\`#e5e7eb\` 这类中性色（要能在深色主题下看清），**不要**用大面积纯白背景。
- 文字用 \`font-size="14"\` 左右、\`fill="currentColor"\`；整体是一张**结构/流程示意图**，不要装饰性花纹。
- \`alt\` 是一句中文说明（会作为无障碍替代文本）。`

/**
 * 课程大纲区块：把**整门课**的结构贴给模型，并标出「本次要写的位置」。
 *
 * 为什么必须给：
 *   · **防越界** —— 不问大纲时，模型会把相邻知识点（甚至整章）的内容一起写了，
 *     于是同一门课里出现多段重复正文；把大纲 + 当前位置摆出来，边界才是可判定的。
 *   · **防重复** —— 章节内其他知识点与别的章节的标题都看得见，措辞自然会避重。
 *
 * 体积控制：知识点很多时只做**保守截断**（默认 60 个），且**当前章节永远完整保留**
 * —— 上下文比「列全」更重要，但当前章节的边界不能因为截断而丢失。
 *
 * @param {object} input `{ course, chapter, kp, limit? }`
 * @returns {string} 多行文本（`## 课程大纲` + 章节与知识点清单）
 */
export function buildOutlineBlock ({ course, chapter, kp, limit = 60 } = {}) {
  const chapters = (course && course.outline && course.outline.chapters) || []
  const total = chapters.reduce((n, ch) => n + ((ch.knowledgePoints || []).length), 0)
  const lines = []
  lines.push('课程大纲（`← 本次` 是**唯一**要写的知识点；其他条目只是边界参照）：')
  for (const ch of chapters) {
    const kps = ch.knowledgePoints || []
    const isHere = chapter && ch.id === chapter.id
    /* 当前章节永不截断；其他章节在超限时只列标题 */
    const showAll = isHere || total <= limit
    lines.push(`${ch.order}. ${ch.name}${isHere ? '   ← 本次所在章节' : ''}`)
    if (!showAll) {
      lines.push('   （略：本章知识点与本次无关，只作边界参照）')
      continue
    }
    for (const k of kps) {
      const mark = isHere && kp && k.id === kp.id ? '   ← 本次' : ''
      lines.push(`   ${ch.order}.${k.order} ${k.name}${mark}`)
    }
  }
  if (total > limit) lines.push(`（整门课共 ${total} 个知识点，上面只展开了本次所在章节，其余章节按标题列出。）`)
  return lines.join('\n')
}

/**
 * 给模型的完整指令。
 * @param {object} input
 *   `{ kp, chapter, course, contentType, prompt }` —— `course` 必须带完整 `outline`，
 *   因为 prompt 里会贴**整门课的大纲**并标出「本次」位置（防越界、防重复）。
 */
export function buildContentPrompt ({ kp, chapter, course, contentType, prompt, sources = [], existing = null }) {
  const lines = []
  lines.push(COMMON_RULES)
  lines.push('')
  lines.push(SLIDEV_TYPES.indexOf(contentType) >= 0 ? SLIDEV_RULES : MARKDOWN_RULES)
  /* **追加模式**：这个知识点已经有内容，这次只写"新增的部分" ——
     明确告诉模型现有结构（标题清单），避免复述已经讲过的段落。 */
  if (existing && existing.body) {
    const heads = String(existing.body).split('\n')
      .map((l) => /^#{2,4}\s+(.+)$/.exec(l))
      .filter(Boolean)
      .map((m) => m[1].trim())
      .slice(0, 20)
    lines.push('')
    lines.push('⚠️ **已有内容会被保留**，你这次生成的内容会**追加**在它后面。所以：')
    lines.push('- 只写**补充**：新的角度、更深的机制、额外的示例/边界、常见坑；')
    lines.push('- **不要**重复已有的小节标题与结论，也不要重写导语；')
    lines.push('- 新内容是独立可读的一段，标题层级接在 `##` 之后。')
    if (heads.length) {
      lines.push('')
      lines.push('已有内容的小节（不要重复这些主题）：')
      for (const h of heads) lines.push(`- ${h}`)
    }
  }

  /* 每种类型都要一张示意图：图文/幻灯片是硬约束（Q-7），其余类型也一起给（同一套体验） */
  lines.push('')
  lines.push(DIAGRAM_RULES)
  if (FALLBACK_TYPES.indexOf(contentType) >= 0) {
    lines.push('')
    lines.push(`⚠️ 这个知识点的内容类型是「${contentType}」，该类型的专用格式**尚未定稿**：请按上面的 Markdown 规则写出可用于学习的正文，应用会按「格式待定」降级展示。`)
  }
  lines.push('')
  lines.push('---')
  lines.push('')
  lines.push(`课程：${course.name}`)
  /* **大纲会话的题面**：建课时用户原话。带上它，知识点生成与大纲生成共享同一份上下文，
     不必每次从零推断"用户到底想要什么"（也避免把风格/深度理解偏）。 */
  if (course.request) {
    lines.push(`课程原始诉求（用户建课时的原话，用来对齐深浅与风格）：${String(course.request).trim()}`)
  }
  if (course.description) lines.push(`课程说明：${course.description}`)
  if (course.difficulty) lines.push(`难度：${course.difficulty}`)
  if (Array.isArray(course.tags) && course.tags.length) lines.push(`领域标签：${course.tags.join('、')}`)
  lines.push(`所属章节：第 ${chapter.order} 章 ${chapter.name}`)
  if (chapter.description) lines.push(`章节说明：${chapter.description}`)
  lines.push('')
  lines.push(buildOutlineBlock({ course, chapter, kp }))
  lines.push('')
  lines.push(`本次要写的知识点：**${kp.name}**（内容类型 ${contentType}，建议学习时长 ${kp.duration} 分钟）`
    + '\n（就是大纲里标着 `← 本次` 的那一条：只写它，不许写到别的条目上。）')
  /* 引用资料（用户诉求/大纲里提到的文件）：放在正文要求**之前**，让它成为写作依据 */
  if (Array.isArray(sources) && sources.length) {
    const block = formatSourcesBlock(sources)
    if (block) {
      lines.push('')
      lines.push(block)
    }
  }
  if (prompt && String(prompt).trim()) {
    lines.push('')
    lines.push('用户对这次生成的额外要求（优先满足）：')
    lines.push(String(prompt).trim())
  }
  lines.push('')
  lines.push('请严格按下面的 JSON 形状输出：')
  lines.push(CONTENT_SHAPE)
  return lines.join('\n')
}

/* ------------------------------------------------------------ ② 解析回包 */

const H1_LINE = /^\s{0,3}#\s+\S/
const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/

/** 从围栏里抠 JSON（容忍裸 JSON / ```json 围栏 / 正文里夹一个对象）。 */
export function parseJsonLoose (text) {
  let raw = String(text ?? '').trim()
  if (!raw) throw new Error('模型返回为空')
  /* ⚠️ **只在整段被围栏包住时**才脱围栏：旧写法（任意位置的 ``` … ```）会把
     「JSON 里含一个代码块」的正文从第一个 ``` 截到最后一个 ```，把整个 JSON 撕碎
     （真实回包里 `body` 就常带 ```js 代码块 —— 踩过）。 */
  const fenced = /^\s*```(?:json)?\s*\r?\n([\s\S]*?)\r?\n?```\s*$/i.exec(raw)
  if (fenced) raw = fenced[1].trim()
  try {
    return JSON.parse(raw)
  } catch {
    const s = raw.indexOf('{')
    const e = raw.lastIndexOf('}')
    if (s < 0 || e <= s) throw new Error('模型返回里找不到 JSON 对象')
    try { return JSON.parse(raw.slice(s, e + 1)) } catch { throw new Error('模型返回的 JSON 无法解析') }
  }
}

/* -- SVG 清洗：白名单元素/属性，剔除脚本与外部引用（正文是不可信输入，06 §7.1 的同一条原则） -- */

const SVG_ALLOWED_TAGS = new Set(['svg', 'g', 'defs', 'marker', 'rect', 'circle', 'ellipse', 'line', 'path', 'polygon', 'polyline', 'text', 'tspan', 'title', 'desc'])

/** SVG 里**没有子节点**的元素：必须自闭合（`<path … />`），否则就是非法 XML（E-36）。 */
const SVG_VOID_TAGS = new Set(['path', 'rect', 'circle', 'ellipse', 'line', 'polygon', 'polyline'])
/* 属性名**大小写敏感**：SVG 是 XML，`viewBox` 写成 `viewbox` 在浏览器里不生效（图会塌成 0 高）。
   所以白名单按小写匹配，但输出时用**规范大小写**。 */
const SVG_ATTR_CANON = {
  viewbox: 'viewBox', preserveaspectratio: 'preserveAspectRatio', markerwidth: 'markerWidth',
  markerheight: 'markerHeight', gradientunits: 'gradientUnits', patternunits: 'patternUnits',
  textanchor: 'textAnchor', dominantbaseline: 'dominantBaseline', fontsize: 'fontSize',
  fontfamily: 'fontFamily', fontweight: 'fontWeight', strokewidth: 'strokeWidth',
  strokedasharray: 'strokeDasharray', strokelinecap: 'strokeLinecap', strokelinejoin: 'strokeLinejoin',
  strokeopacity: 'strokeOpacity', fillopacity: 'fillOpacity', fillrule: 'fillRule',
  markerend: 'markerEnd', markerstart: 'markerStart', markermid: 'markerMid',
}

const SVG_ALLOWED_ATTRS = new Set([
  'viewbox', 'width', 'height', 'x', 'y', 'x1', 'y1', 'x2', 'y2', 'cx', 'cy', 'r', 'rx', 'ry',
  'd', 'points', 'transform', 'fill', 'fill-opacity', 'fill-rule', 'stroke', 'stroke-width',
  'stroke-opacity', 'stroke-dasharray', 'stroke-linecap', 'stroke-linejoin', 'opacity',
  'font-size', 'font-family', 'font-weight', 'text-anchor', 'dominant-baseline', 'marker-end',
  'marker-start', 'marker-mid', 'id', 'refx', 'refy', 'markerwidth', 'markerheight', 'orient',
  'preserveaspectratio', 'xmlns',
])

/**
 * 把模型给的 SVG 洗成**安全的内联 SVG**。
 * 返回 `null` 表示「不可用」（调用方会退回占位示意图，而不是让整次生成失败）。
 */
export function sanitizeSvg (input) {
  let svg = String(input ?? '').trim()
  if (!svg) return null
  const start = svg.indexOf('<svg')
  const end = svg.lastIndexOf('</svg>')
  if (start < 0 || end < 0) return null
  svg = svg.slice(start, end + 6)
  /* 先整体拒掉最危险的构造（避免"解析器没识别出来就放行"） */
  if (/<script|javascript:|<foreignObject|<iframe|<image\b|<!ENTITY|<\?xml-stylesheet/i.test(svg)) return null
  if (/\son[a-z]+\s*=/i.test(svg)) return null
  if (!/viewBox\s*=/i.test(svg)) return null

  /* 逐标签过白名单：不在白名单里的元素整段丢弃（含内容），属性不在白名单里就删掉。
     ⚠️ 自闭合必须保住：`<path … />` 的 `/` 一旦丢了，产出就是**非法 XML**
     （`mismatched tag`）—— 浏览器用 `<img>` 载入 SVG 时要求严格 XML，直接**不显示**。
     真机上就是这样：媒体文件都在、路由也通，图却一张都不出来（见 E-36）。 */
  const out = []
  const tagRe = /<\/?([A-Za-z][\w:-]*)((?:"[^"]*"|'[^']*'|[^>"'])*?)(\/?)>/g
  let last = 0
  let m
  while ((m = tagRe.exec(svg)) !== null) {
    out.push(svg.slice(last, m.index))
    last = tagRe.lastIndex
    const name = m[1].toLowerCase()
    if (!SVG_ALLOWED_TAGS.has(name)) continue
    if (m[0].startsWith('</')) {
      /* 空元素（path/rect/…）在 SVG 语义里**不可能有子节点**：模型多写一个 `</path>`
         就丢掉，否则会变成标签错配（也是非法 XML） */
      if (!SVG_VOID_TAGS.has(name)) out.push(`</${name}>`)
      continue
    }
    const attrs = []
    /* 同一元素上同名属性只留第一个：重复属性是非法 XML（`duplicate attribute`，E-36） */
    const seen = new Set()
    const attrRe = /([A-Za-z_:][\w:.-]*)\s*=\s*("([^"]*)"|'([^']*)')/g
    let a
    while ((a = attrRe.exec(m[2] || '')) !== null) {
      const key = a[1].toLowerCase()
      if (!SVG_ALLOWED_ATTRS.has(key) || seen.has(key)) continue
      seen.add(key)
      const value = (a[3] !== undefined ? a[3] : a[4]).replace(/"/g, '&quot;')
      attrs.push(`${SVG_ATTR_CANON[key] || key}="${value}"`)
    }
    /* 空元素**一律**写成自闭合：这既是规范写法，也能把「丢过 `/`」的旧文件洗回合法 XML */
    const selfClose = m[3] || SVG_VOID_TAGS.has(name)
    out.push(`<${name}${attrs.length ? ' ' + attrs.join(' ') : ''}${selfClose ? ' />' : '>'}`)
  }
  out.push(svg.slice(last))
  let cleaned = out.join('')
  /* ⚠️ 两次见到同一个属性会产出非法 XML（`<svg xmlns=… xmlns=…>`）——模型几乎总会自己带 `xmlns`，
     所以**只有缺的时候才补**（早期版本无条件补，落盘的 SVG 是重复属性，严格 XML 解析器会报错）。 */
  if (!/<svg[^>]*\sxmlns\s*=/i.test(cleaned)) cleaned = cleaned.replace(/<svg/i, '<svg xmlns="http://www.w3.org/2000/svg"')
  /* 最后一道：**形状自检**。不合格就回 null（调用方落占位示意图），绝不把坏 SVG 写进课程库。
     坏图比没图更糟：文件在、路由通、浏览器就是不显示，排查成本极高。 */
  return isWellFormedSvg(cleaned) ? cleaned : null
}

/**
 * SVG「形状自检」：不依赖 DOM，检查严格 XML 的关键几条。
 *
 * 为什么不能只信解析器：宿主侧没有 DOM（也不引第三方解析器），而这里产出会被浏览器
 * 当作**严格 XML** 解析（`<img src="*.svg">`）。所以只校最致命的三种：
 *   ① 没有 `<script>` / 外部引用（安全检查已有，这里兜底）；
 *   ② 每个开标签都闭合（`<path>` 必须有 `/>` 或 `</path>`）；
 *   ③ 没有重复属性（同一元素上同名属性出现两次 → XML 非法）。
 *
 * @param {string} text 已清洗的 SVG 文本
 * @returns {boolean}
 */
export function isWellFormedSvg (text) {
  const s = String(text || '')
  if (!/^<svg[\s>]/i.test(s.trim())) return false
  if (!/viewBox\s*=/i.test(s)) return false
  const VOID_OK = new Set(['path', 'rect', 'circle', 'ellipse', 'line', 'polygon', 'polyline'])
  const stack = []
  const tagRe = /<(\/?)([A-Za-z][\w:-]*)((?:"[^"]*"|'[^']*'|[^>"'])*?)(\/?)>/g
  let m
  let count = 0
  while ((m = tagRe.exec(s)) !== null) {
    count++
    const [, close, rawName, rawAttrs, selfClose] = m
    const name = rawName.toLowerCase()
    /* 重复属性检查（只对带值的属性；`xmlns` 这种也查） */
    const seen = new Set()
    const attrRe = /([A-Za-z_:][\w:.-]*)\s*=/g
    let a
    while ((a = attrRe.exec(rawAttrs || '')) !== null) {
      const key = a[1].toLowerCase()
      if (seen.has(key)) return false
      seen.add(key)
    }
    if (close) {
      if (!stack.length || stack.pop() !== name) return false
      continue
    }
    if (selfClose) continue
    if (VOID_OK.has(name)) {
      /* 自闭合写法的空元素必须写 `/>`；写成 `<path>` 就是未闭合 → 非法 */
      return false
    }
    stack.push(name)
  }
  if (count === 0) return false
  return stack.length === 0
}

/**
 * 按**实际正文**估算学习时长（分钟）。
 *
 * 为什么在生成之后算：大纲阶段的「估计」和正文毫无关系 —— 之前每个知识点都显示
 * 一个凭空来的 10 分钟。真正能支撑这个数字的只有已经写出来的内容。
 *
 * 口径（可解释、可调）：
 *   · 中文正文 **250 字/分钟**、英文 **150 词/分钟**、代码 **20 行/分钟**；
 *   · 再乘 **1.5** 的「学习系数」—— 时长是**学会**的时间，不是通读一遍的时间
 *     （只按阅读速度算，400~900 字的正文会得出 2 分钟，明显偏短）；
 *   · 幻灯片另按 **1 页 ≈ 0.8 分钟**讲授节奏，与字数取**较大者**；
 *   · 四舍五入到整数分钟，夹在 **1..180**。
 *
 * @param {string} body 正文（可带 frontmatter / 围栏）
 * @param {string} [contentType] 用于幻灯片口径
 * @returns {number} 正整数分钟
 */
export function estimateMinutes (body, contentType) {
  const text = String(body ?? '')
  /* 代码围栏单独算：里面的字符不该按「读散文」的速度计 */
  const codeLines = []
  let prose = text
  const fenceRe = /^```[^\n]*\n([\s\S]*?)^```/gm
  let m
  while ((m = fenceRe.exec(text)) !== null) codeLines.push(m[1].split('\n').length)
  prose = prose.replace(fenceRe, ' ')
  /* 去掉 frontmatter（它不是给人读的正文） */
  prose = prose.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, ' ')
  const cjk = (prose.match(/[\u3400-\u9fff\uf900-\ufaff]/g) || []).length
  const words = (prose.replace(/[\u3400-\u9fff\uf900-\ufaff]/g, ' ').match(/[A-Za-z0-9_]+/g) || []).length
  const code = codeLines.reduce((n, v) => n + v, 0)
  /* 1.5 是「学习系数」：按时长=通读速度算出来的数字太短（见上面的口径说明） */
  let minutes = (cjk / 250 + words / 150 + code / 20) * 1.5
  if (SLIDEV_TYPES.indexOf(contentType) >= 0) {
    const pages = Math.max(1, (text.match(/^---\s*$/gm) || []).length + 1)
    minutes = Math.max(minutes, pages * 0.8)
  }
  return Math.min(180, Math.max(1, Math.round(minutes)))
}

/** 极简占位示意图（模型没给图或图不可用时用它兜底，保证「图文必须 ≥1 媒体」这条约束成立）。 */
export function placeholderSvg (title) {
  /* 标题来自模型/用户编辑，**必须转义**：`</text><script>…` 这类输入会把占位图变成注入点。
     占位图是宿主自己拼的、不走 sanitizeSvg，所以这里是唯一一道防线。 */
  const text = String(title || '示意图').slice(0, 28)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 640 200" width="640" height="200">`
    + '<rect x="1" y="1" width="638" height="198" rx="12" fill="none" stroke="#888" stroke-dasharray="6 6" stroke-width="2"/>'
    + `<text x="320" y="105" text-anchor="middle" font-size="20" font-family="sans-serif" fill="currentColor">${text}</text>`
    + '</svg>'
}

/** 剥掉模型可能自己加的 frontmatter（正文 frontmatter 由宿主统一写）。 */
export function stripFrontmatter (body) {
  return String(body ?? '').replace(FRONTMATTER, '')
}

/** 剥掉 H1 行（05 §5.4.1：正文里不得出现 `h1`，层级从 h2 开始）。 */
export function stripH1 (body) {
  return String(body ?? '')
    .split('\n')
    .filter((line) => !H1_LINE.test(line))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/** 去掉正文里所有图片引用（图由宿主插入，避免模型给出不可用的外部路径）。 */
export function stripImages (body) {
  return String(body ?? '')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/** 在正文的第一个段落之后插入图片引用（位置稳定、可断言）。 */
export function insertFigure (body, relFromBody, alt) {
  /* alt 来自模型/用户编辑：去 `[]`（会破坏图片语法）、压掉换行与连续空白（会拆散一行） */
  const altText = String(alt || '').replace(/[\[\]]/g, '').replace(/\r?\n/g, ' ').replace(/\s+/g, ' ').trim()
  const line = `![${altText}](${relFromBody})`
  const lines = String(body ?? '').split('\n')
  let i = 0
  let seen = 0
  while (i < lines.length) {
    const isBlank = lines[i].trim() === ''
    if (!isBlank && (i === 0 || lines[i - 1].trim() === '')) {
      /* 一个段落的开始：往下跳到它的结尾 */
      let j = i
      while (j < lines.length && lines[j].trim() !== '') j++
      seen++
      if (seen === 1) {
        return [...lines.slice(0, j), '', line, ...lines.slice(j)].join('\n')
      }
      i = j
      continue
    }
    i++
  }
  return lines.join('\n') + '\n\n' + line
}

/**
 * 把示意图插进**某一页幻灯片**。
 *
 * 选页顺序（确定性，便于断言）：
 *   ① 版式为 `image-right` / `image-left` / `two-cols` 的页（模型显然为图留了位置）
 *   ② 否则倒数**第二**页（末页通常是小结，封面不该放图）；只有一页时就用那一页
 *   ③ 一页都没有时 → 什么都没有（调用方会用空讲义报错）
 * 不重复插入：该页已经有图片引用就直接返回。
 */
export function insertSlideFigure (slides, figure) {
  const list = Array.isArray(slides) ? slides.slice() : []
  if (!figure || !figure.figureRel || list.length === 0) return list
  const altText = String(figure.alt || '').replace(/[\[\]]/g, '').replace(/\r?\n/g, ' ').replace(/\s+/g, ' ').trim()
  const line = `![${altText}](${figure.figureRel})`
  const hasImg = (s) => /!\[[^\]]*\]\([^)]*\)/.test(s)
  let target = list.findIndex((s) => /layout:\s*(image-right|image-left|two-cols|two-cols-header)/.test(s))
  if (target < 0) target = list.length >= 2 ? list.length - 2 : 0
  if (hasImg(list[target])) return list
  list[target] = `${list[target]}\n\n${line}`
  return list
}

/** 正文写入文件时统一补 frontmatter（05 §5.4.1：`title` 让文件脱离应用也自描述）。 */
export function withFrontmatter (title, body) {
  /* 标题里的换行会破坏 YAML frontmatter（`title: a\nb` 变成两个键）；
     压成单行，其余字符（含 `:`）由本插件的解析器按「第一个冒号后整段取值」处理。 */
  const t = String(title || '').replace(/"/g, "'").replace(/\r?\n/g, ' ').replace(/\s+/g, ' ').trim()
  return `---\ntitle: ${t}\n---\n\n${String(body ?? '').trim()}\n`
}

/* -- 幻灯片规范化：补 headmatter、保证有分页、校验收尾 -- */

export function normalizeSlidev (raw, title, figure) {
  const body = String(raw ?? '').trim()
  /* 模型可能自己带了 headmatter（`title` 也可能漏）—— 一律丢给宿主重写，
     保证 headmatter 的形状与 `title` 逐字来自课程数据，而不是模型的自述。 */
  const head = body.match(FRONTMATTER)
  const slidesSource = head ? body.slice(head[0].length) : body
  const slides = slidesSource
    .split(/\r?\n---\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean)
  if (slides.length === 0) throw new Error('幻灯片正文为空（没有任何一页）')
  const titleText = String(title || '封面').replace(/\r?\n/g, ' ').replace(/\s+/g, ' ').trim()
  const fixed = slides.map((s, i) => {
    if (i === 0 && !/^#\s/m.test(s)) return `# ${titleText}\n\n${s}`
    return s
  })
  const withFigure = insertSlideFigure(fixed, figure)
  return withFrontmatter(titleText, withFigure.join('\n\n---\n\n'))
}

/* --------------------------------------------------- ②' 规范化 + 校验 */

/**
 * 把模型回包规范化成可落库的形状。
 * @returns `{ title, body, media: [{ rel, text }], contentType, fallback }`
 * @throws 结构化错误（原因直接可展示给用户）
 */
export function parseContent (text, { kp, contentType, kpId } = {}) {
  const obj = parseJsonLoose(text)
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) throw new Error('模型返回的不是 JSON 对象')
  const title = String(obj.title || (kp && kp.name) || '').trim()
  const rawBody = String(obj.body || '')
  if (!title) throw new Error('模型没有给出标题')
  if (!rawBody.trim()) throw new Error('模型没有给出正文')

  /* 图表：正文里**已经有 Mermaid 图**时就不再产媒体、不再插图 ——
     Mermaid 是纯文本、随正文一起渲染，比外部 SVG「更直接可渲染」（用户口径）。
     否则退回 `diagram.svg`（模型没给或图不可用 → 占位示意图，保证「图文/幻灯片 ≥1 媒体」）。 */
  const hasMermaid = /```\s*mermaid\b/i.test(rawBody)
  const svg = hasMermaid ? '' : (sanitizeSvg(obj.diagram && obj.diagram.svg) || placeholderSvg(title))
  const rel = hasMermaid ? '' : nextMediaRelPath(kpId, [])
  const media = hasMermaid ? [] : [{ rel, text: svg }]
  const alt = (obj.diagram && obj.diagram.alt) || `${title} 示意图`

  let body
  if (SLIDEV_TYPES.indexOf(contentType) >= 0) {
    /* 幻灯片：每页的 `#` 是页标题，**不做** H1 剥离；示意图要**真的插进某一页**，
       否则文件生成了、mediaRefs 也登记了，但讲义里看不到图（漏过一次）。 */
    body = normalizeSlidev(rawBody, title, hasMermaid ? null : { figureRel: rel.replace('content-assets/', ''), alt })
  } else {
    /* Markdown：剥 frontmatter / H1 / 模型自己写的图片链接。
       有 Mermaid 时**不**再插图引用（正文自足）；没有才在首段之后插入宿主算好的图。 */
    const clean = stripImages(stripH1(stripFrontmatter(rawBody)))
    body = withFrontmatter(title, hasMermaid ? clean : insertFigure(clean, rel.replace('content-assets/', ''), alt))
  }

  return {
    title,
    body,
    media,
    contentType,
    fallback: FALLBACK_TYPES.indexOf(contentType) >= 0,
  }
}

/* --------------------------------------------------------- ③ 目标选择 */

/**
 * 三种粒度 → 实际要生成的知识点列表。
 * - `course`：整门课的全部知识点
 * - `chapter`：`targetIds` 里各章节的知识点
 * - `kp`：`targetIds` 里的知识点本身
 * @returns `[{ ch, kp }]`（保持课程顺序；找不到的目标**静默忽略**，由调用方比对数量给出提示）
 */
export function selectTargets (course, scope, targetIds) {
  const ids = Array.isArray(targetIds) ? targetIds : []
  const chapters = (course && course.outline && course.outline.chapters) || []
  const out = []
  for (const ch of chapters) {
    for (const kp of ch.knowledgePoints || []) {
      if (scope === 'course') out.push({ ch, kp })
      else if (scope === 'chapter' && ids.indexOf(ch.id) >= 0) out.push({ ch, kp })
      else if (scope === 'kp' && ids.indexOf(kp.id) >= 0) out.push({ ch, kp })
    }
  }
  return out
}

/* ------------------------------------------------------- ④ 生成 + 落库 */

/**
 * 生成一个知识点并落库。
 *
 * @param {object} deps
 *   `{ store, courses, now? }`
 * @param {object} input
 *   `{ courseId, kpId, contentType?, prompt?, callModel }`
 *   `callModel(prompt, { kp, contentType }) → Promise<string>`（默认由 30-generate 接线到子 agent）
 * @returns `{ envelope, relPath, mediaRefs, title, fallback }`
 */
export async function generateOne ({ store, courses, callModel }, { courseId, kpId, contentType, prompt, signal, keepExisting = false }) {
  const read = await courses.read(courseId)
  if (!read) throw new Error(`课程不存在：${courseId}`)
  if (read.readOnly) throw new Error('这门课由更高版本写入，本版只读，不能生成内容')
  let found = null
  for (const ch of read.course.outline.chapters) {
    for (const kp of ch.knowledgePoints || []) if (kp.id === kpId) found = { ch, kp }
  }
  if (!found) throw new Error(`知识点不存在：${kpId}`)
  const type = contentType || found.kp.contentType
  /* 整份课程大纲随 prompt 一起发（`buildContentPrompt` 内部调 `buildOutlineBlock`），
     因此不再单独传「同章节其他知识点」—— 大纲里已经全有了，而且带当前位置标记。 */
  /* **引用资源**（T-14）：课程级（诉求/附件，用户主动提供）＋ 章节与知识点描述里提到的路径
     （模型生成/用户后来编辑的内容）。两者的信任级别不同：
       · 用户引用（course.sources）→ 允许读任意文本路径（用户自己点名的资料）；
       · 内容引用（描述/名称）→ 只允许工作区 / 课程库 / 临时目录，防提示注入读 `~/.config/x.json`。
     只读文本、单文件与总量都限量、读失败静默跳过 —— 资料是"参考"，不能把生成搞挂。 */
  const refList = []
  const seenRefs = new Set()
  const pushRefs = (list, allowExternal) => {
    for (const item of list || []) {
      const ref = String((item && item.ref) || item || '').trim()
      if (!ref) continue
      const key = ref.toLowerCase()
      if (seenRefs.has(key) || refList.length >= MAX_SOURCES) continue
      seenRefs.add(key)
      refList.push({ ref: ref, name: (item && item.name) || ref.split('/').pop() || ref, allowExternal })
    }
  }
  pushRefs(mergeSources((read.course && read.course.sources) || []), true)
  pushRefs(mergeSources(
    extractRefs(found.ch && found.ch.description),
    extractRefs(found.kp && found.kp.description),
    extractRefs(found.kp && found.kp.name),
  ), false)
  const sources = []
  if (refList.length && courses && typeof courses.readSource === 'function') {
    for (const ref of refList) {
      const got = await courses.readSource(ref.ref, { allowExternal: ref.allowExternal }).catch(() => null)
      if (got && got.ok) sources.push({ ref: ref.ref, name: ref.name, text: got.text, truncated: got.truncated })
    }
  }
  /* **追加模式**：这个知识点已有内容时，把旧正文一起给模型（并告它别重复） */
  const existing = keepExisting
    ? await readAssetPayload(store, courseId, kpId, type).catch(() => null)
    : null
  const existingAsset = existing && existing.hasAsset ? existing : null
  const promptText = buildContentPrompt({
    kp: found.kp,
    chapter: found.ch,
    course: read.course,
    contentType: type,
    prompt,
    sources,
    existing: existingAsset,
  })
  const raw = await callModel(promptText, { kp: found.kp, chapter: found.ch, course: read.course, contentType: type, signal })
  const parsed = parseContent(raw, { kp: found.kp, contentType: type, kpId, courseId })
  /* 追加模式：正文拼在旧内容之后，媒体**追加**而不是覆盖 ——
     · 旧图必须原样留在信封里（文件不动，内容读出来再写同一个路径，保证 writeAsset 的契约）；
     · 新图用下一个空序号（`nextMediaRelPath` 会跳过已占用的名字）。 */
  let body = parsed.body
  let media = parsed.media
  if (existingAsset) {
    /* ⚠️ `nextMediaRelPath` 的 `existing` 要的是**完整相对路径**（`content-assets/media/x.svg`），
       而 `readAssetPayload` 回来的 `m.path` 正是这个形状 —— 早期把前缀剥掉再传，导致新图又用了
       `-01.svg` 把旧图覆盖掉（实测两条 mediaRefs 指向同一个文件）。 */
    const oldPaths = (existingAsset.media || []).map((m) => String(m.path || '')).filter(Boolean)
    const kept = []
    for (const rel of oldPaths) {
      const text = await store.readContentText(courseId, rel).catch(() => '')
      if (text) kept.push({ rel, text })
    }
    const fresh = []
    for (const m of parsed.media) {
      const rel = nextMediaRelPath(kpId, oldPaths.concat(fresh.map((f) => f.rel)))
      fresh.push({ rel, text: m.text })
    }
    const isDeck = SLIDEV_TYPES.indexOf(type) >= 0
    /* 幻灯片：新讲义**去掉 headmatter**后接在后面（用 `---` 分页）；图文：一条分隔线 */
    const appended = isDeck
      ? String(parsed.body || '').replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '').trim()
      : String(parsed.body || '').trim()
    body = `${String(existingAsset.body || '').replace(/\s+$/, '')}\n\n${isDeck ? '' : '---\n\n'}${appended}\n`
    media = kept.concat(fresh)
  }
  const written = await writeAsset(store, courseId, {
    kpId,
    contentType: type,
    title: parsed.title,
    body,
    media,
  })
  /* **回填学习时长**：大纲阶段不估计（见 10-prompt 规则 5），只有内容写出来了才有依据。
     失败不影响内容落库（时长是展示用的派生值，不能反过来把生成判失败）。 */
  let duration = null
  if (courses && typeof courses.setDuration === 'function') {
    try {
      duration = estimateMinutes(parsed.body, type)
      await courses.setDuration(courseId, kpId, duration)
    } catch (err) {
      duration = null
      /* 不抛：内容已经原子落盘，时长回填失败只是少一个数字 */
    }
  }
  return {
    envelope: written.envelope,
    relPath: written.relPath,
    mediaRefs: written.mediaRefs,
    title: parsed.title,
    fallback: parsed.fallback,
    duration,
  }
}


/* ============================================================================
 * RPC 层（T-6）
 *
 * client 与 host 之间**只有这一条数据通道**（ADR-0001）。设计约束：
 *   1. **精确路由**：一个方法一条 `kind: 'exact'` 路由，不用前缀/通配 ——
 *      路由表 = 方法表，看得见、可枚举、冲突会在注册时抛错（E-4：重复 (kind,path) 抛错）
 *   2. **方法表驱动**：每个方法自带 `input` 校验与 `handle`，不散落 if/else
 *   3. **输入校验前置**：非法输入**在进 handler 之前**就被拒，回结构化错误
 *   4. **结构化错误**：一律 `{ ok:false, error:{ code, message, detail? } }`，
 *      不把异常栈透给前端；handler 抛错也只回 code
 *   5. **不信任前端**：路径、课程 id、文件路径都由 host 计算或校验（05 §9）
 * ========================================================================== */

export const RPC_PREFIX = '/dsh-ai-courses/rpc/'

export class RpcError extends Error {
  constructor (code, message, detail) {
    super(message)
    this.name = 'RpcError'
    this.code = code
    this.detail = detail
  }
}

/**
 * 领域错误码 → HTTP 状态。覆盖 `RpcError`、`CourseError`、`StoreError`、`AssetError`
 * 以及未来新增的「带 code 的错误」；不在表里的按 500 处理（不透传消息）。
 */
const RPC_STATUS = {
  'not-found': 404,
  'invalid-input': 400,
  'invalid-outline': 400,
  'bad-course-id': 400,
  'bad-path': 400,
  'bad-kp-id': 400,
  'invalid-content-type': 400,
  'empty-media': 400,
  'missing-media': 400,
  'too-many-media': 400,
  'no-agent': 400,
  'no-targets': 400,
  'body-too-large': 413,
  forbidden: 403,
  'read-only': 403,
  conflict: 409,
  'already-running': 409,
  'settings-write-failed': 500,
}

/* ------------------------------------------------------------ 输入校验器 */
/*
 * 极小的声明式校验：够用、零依赖、可单测。
 * spec: { type:'string'|'number'|'boolean'|'object'|'array', required?, enum?, maxLength?,
 *         min?, max?, items?, fields?:{ [k]: spec }, allowUnknown? }
 * 返回 { ok:true, value }（value 是**清洗后**的值，未知键被丢弃）或 { ok:false, error }
 */
export function validate (spec, input, path = '$') {
  const bad = (code, message, detail) => ({ ok: false, error: { code, message, detail } })
  const t = spec.type

  if (input === undefined || input === null) {
    if (spec.required) return bad('invalid-input', `${path} 是必填项`)
    return { ok: true, value: spec.default }
  }
  if (t === 'string') {
    /* `label` 让错误文案用**用户看得懂的名字**（`AI 备注`）而不是 JSON 路径（`$.prompt`）。
       真机上用户贴了一段长备注，看到的是 `$.prompt 超过最大长度 2000` —— 完全不知道该干什么。 */
    const name = spec.label || path
    if (typeof input !== 'string') return bad('invalid-input', `${name} 必须是字符串`)
    if (spec.maxLength && input.length > spec.maxLength) {
      return bad('invalid-input', `${name} 太长了：最多 ${spec.maxLength} 个字符（当前 ${input.length}）`)
    }
    if (spec.enum && spec.enum.indexOf(input) < 0) {
      return bad('invalid-input', `${path} 不是允许的取值`, { allowed: spec.enum })
    }
    const v = spec.trim === false ? input : input.trim()
    if (spec.required && !v) return bad('invalid-input', `${path} 不能为空`)
    return { ok: true, value: v }
  }
  if (t === 'number') {
    const n = typeof input === 'number' ? input : Number(input)
    if (!Number.isFinite(n)) return bad('invalid-input', `${path} 必须是数字`)
    if (spec.integer && !Number.isInteger(n)) return bad('invalid-input', `${path} 必须是整数`)
    if (spec.min !== undefined && n < spec.min) return bad('invalid-input', `${path} 不能小于 ${spec.min}`)
    if (spec.max !== undefined && n > spec.max) return bad('invalid-input', `${path} 不能大于 ${spec.max}`)
    return { ok: true, value: n }
  }
  if (t === 'boolean') {
    if (typeof input !== 'boolean') return bad('invalid-input', `${path} 必须是布尔值`)
    return { ok: true, value: input }
  }
  if (t === 'array') {
    if (!Array.isArray(input)) return bad('invalid-input', `${path} 必须是数组`)
    if (spec.maxItems && input.length > spec.maxItems) {
      return bad('invalid-input', `${path} 最多 ${spec.maxItems} 项`)
    }
    const out = []
    for (let i = 0; i < input.length; i++) {
      const r = validate(spec.items, input[i], `${path}[${i}]`)
      if (!r.ok) return r
      out.push(r.value)
    }
    return { ok: true, value: out }
  }
  if (t === 'object') {
    if (typeof input !== 'object' || Array.isArray(input)) return bad('invalid-input', `${path} 必须是对象`)
    const out = {}
    for (const [k, s] of Object.entries(spec.fields ?? {})) {
      const r = validate(s, input[k], `${path}.${k}`)
      if (!r.ok) return r
      if (r.value !== undefined) out[k] = r.value
    }
    /* 未知键一律丢弃（前端多传字段不报错，但也不会进 handler） */
    return { ok: true, value: out }
  }
  return { ok: true, value: input }
}

/* --------------------------------------------------------------- 方法表 */

/**
 * 一个方法：{ name, input, handle(ctx, input) }
 * `handle` 的返回值会被包成 `{ ok:true, data }`；抛出的 RpcError 变成结构化错误。
 */
export function createMethodTable (methods) {
  const table = new Map()
  for (const m of methods) {
    if (!m || typeof m.name !== 'string' || !m.name) throw new Error('RPC 方法必须有 name')
    if (table.has(m.name)) throw new Error(`RPC 方法重复：${m.name}`)
    if (typeof m.handle !== 'function') throw new Error(`RPC 方法 ${m.name} 缺少 handle`)
    table.set(m.name, m)
  }
  return table
}

/* ------------------------------------------------- 请求体与响应（可单测） */

export function parseBody (raw) {
  if (raw === undefined || raw === null || raw === '') return { ok: true, value: {} }
  if (typeof raw === 'object') return { ok: true, value: raw }
  try {
    const v = JSON.parse(String(raw))
    if (v === null || typeof v !== 'object' || Array.isArray(v)) {
      return { ok: false, error: { code: 'invalid-body', message: '请求体必须是 JSON 对象' } }
    }
    return { ok: true, value: v }
  } catch {
    return { ok: false, error: { code: 'invalid-json', message: '请求体不是合法 JSON' } }
  }
}

/**
 * 纯函数形式的调用入口 —— 路由与 HTTP 细节在外面，这里只做「方法解析 → 校验 → 执行」。
 * 这样它可以脱离 HTTP 单测（见 scripts/rpc-smoke.mjs）。
 */
export async function invoke (table, methodName, rawBody, ctx) {
  const method = table.get(methodName)
  if (!method) {
    return {
      status: 404,
      body: { ok: false, error: { code: 'unknown-method', message: `未知方法：${methodName}` } },
    }
  }
  const parsed = parseBody(rawBody)
  if (!parsed.ok) return { status: 400, body: { ok: false, error: parsed.error } }

  const checked = validate(method.input ?? { type: 'object', fields: {} }, parsed.value)
  if (!checked.ok) return { status: 400, body: { ok: false, error: checked.error } }

  try {
    const data = await method.handle(ctx, checked.value)
    return { status: 200, body: { ok: true, data: data ?? null } }
  } catch (err) {
    /* 状态码按**用户能不能自己解决**分：参数错 400、越权 403、冲突 409、不存在 404，其余 500。
       ⚠️ 这里按 `err.code` 统一映射，不要求方法先包 `wrap`：
       否则 `media.check` 这类没包 wrap 的方法抛 `CourseError` 会变成 500「服务器内部错误」，
       用户完全不知道是课程 id 不存在。 */
    const code = err && typeof err.code === 'string' ? err.code : ''
    const status = RPC_STATUS[code]
    if (status) {
      return { status, body: { ok: false, error: { code, message: err.message, detail: err.detail } } }
    }
    /* 未预期异常：记日志、回笼统错误码，**不透传栈** */
    ctx?.logger?.error?.('[ai-courses] RPC %s 未预期失败：%s', methodName, err && err.message)
    return { status: 500, body: { ok: false, error: { code: 'internal', message: '服务器内部错误' } } }
  }
}

/* ------------------------------------------------------------ 注册到宿主 */

/**
 * 给方法表里每个方法注册一条**精确** HTTP 路由：`POST <prefix><name>`。
 * E-4：同一 (kind, path) 重复注册会抛错 —— 所以方法名唯一即可保证路由不冲突。
 */
export function registerRoutes (ctx, table) {
  const disposers = []
  for (const name of table.keys()) {
    const path = RPC_PREFIX + name
    disposers.push(
      ctx.webServer.register({
        kind: 'exact',
        path,
        handler: async (req, res) => {
          try {
            /* 自定义头是**跨源防线**：浏览器发它一定触发 CORS 预检，而本服务不返回 CORS 头，
               恶意网页的 fetch/form 都到不了 handler。它不是密码，但能挡住 CSRF。
               （E-26 说的"无鉴权"仍然成立：本机进程直接发请求可以自己加这个头。） */
            const headers = (req && req.headers) || {}
            const fetchSite = String(headers['sec-fetch-site'] || '').toLowerCase()
            const origin = String(headers.origin || '')
            const host = String(headers.host || '')
            const sameOrigin = fetchSite === 'same-origin' ||
              (!!origin && !!host && (origin === 'http://' + host || origin === 'https://' + host))
            const hasHeader = String(headers[RPC_HEADER] || headers['X-DSH-AI-COURSES'] || '') === '1'
            /* 自定义头是主防线；`Sec-Fetch-Site: same-origin` / 同源 Origin 是给
               「升级宿主的瞬间、浏览器还缓存着旧 client」留的兼容通道 ——
               旧 client 不带自定义头，但它发出的同源请求会被浏览器标成 same-origin。 */
            if (!hasHeader && !sameOrigin) {
              sendJson(res, 403, { ok: false, error: { code: 'forbidden', message: `缺少 ${RPC_HEADER} 头，且不是同源请求` } })
              return
            }
            const raw = await readRequestBody(req)
            /* ⚠️ 精确路由**没有会话上下文**（E-26：无凭证也能直连）。内容生成需要「用哪个会话的
               Agent 起子 agent」，所以由客户端在请求体里带 `agentId`，方法自己用 `ctx.agents.get(id)`
               换回 Agent —— 换不到就报明确错误，不猜（见 50-methods 的 generation.start）。 */
            const out = await invoke(table, name, raw, ctx)
            sendJson(res, out.status, out.body)
          } catch (err) {
            if (err && err.code === 'body-too-large') {
              sendJson(res, 413, { ok: false, error: { code: 'body-too-large', message: err.message } })
              return
            }
            ctx?.logger?.error?.('[ai-courses] RPC %s 路由处理失败：%s', name, err && err.message)
            sendJson(res, 500, { ok: false, error: { code: 'internal', message: '服务器内部错误' } })
          }
        },
      }),
    )
  }
  return disposers
}

/** RPC 请求体上限（1 MB）：课程/大纲的输入远小于它；附件不走 RPC。 */
export const MAX_RPC_BODY_BYTES = 1024 * 1024

/** 自定义头：浏览器跨源请求带不上它（会触发预检），从而挡住"任意网页 POST 删除课程"。 */
export const RPC_HEADER = 'x-dsh-ai-courses'

function readRequestBody (req, maxBytes = MAX_RPC_BODY_BYTES) {
  return new Promise((resolve, reject) => {
    const tooLarge = () => {
      const err = new Error(`请求体超过上限（${maxBytes} 字节）`)
      err.code = 'body-too-large'
      return err
    }
    if (req.body !== undefined) {
      const raw = typeof req.body === 'string' ? req.body : JSON.stringify(req.body)
      if (Buffer.byteLength(raw) > maxBytes) { reject(tooLarge()); return }
      resolve(raw)
      return
    }
    let buf = ''
    let size = 0
    let settled = false
    req.on?.('data', (c) => {
      if (settled) return
      size += Buffer.byteLength(String(c))
      if (size > maxBytes) { settled = true; reject(tooLarge()); return }
      buf += c
    })
    req.on?.('end', () => { if (!settled) { settled = true; resolve(buf) } })
    req.on?.('error', (err) => { if (!settled) { settled = true; reject(err) } })
    if (!req.on) resolve('')
  })
}

function sendJson (res, status, body) {
  const text = JSON.stringify(body)
  if (typeof res.writeHead === 'function') {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
    res.end(text)
  } else {
    res.status = status
    res.body = text
  }
}

/* ------------------------------------------------------------------ 媒体 */

/**
 * 媒体 URL 前缀（**带**结尾斜杠：客户端拼 URL 用它）。
 *
 * ⚠️ **注册路由时必须去掉结尾斜杠** —— 宿主的匹配是
 * `pathname.startsWith(`${prefix}/`)`（`dsh-host-webserver`），
 * 若前缀自带 `/`，拼出来是 `/media//`，**永远匹配不上**，请求会落到 fallback 的 404。
 * 这个坑真机上吃过一次：媒体文件都落盘了，但浏览器里一张图都看不到。
 */
export const MEDIA_PREFIX = '/dsh-ai-courses/media/'
/** 注册用的路径（无结尾斜杠）。 */
export const MEDIA_ROUTE_PATH = MEDIA_PREFIX.replace(/\/+$/, '')

const MEDIA_TYPES = {
  '.svg': 'image/svg+xml; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.m4a': 'audio/mp4',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.txt': 'text/plain; charset=utf-8',
}

/** 路径 → content-type（未知一律 `application/octet-stream`，不猜）。 */
export function mediaContentType (path) {
  const m = String(path || '').toLowerCase().match(/(\.[a-z0-9]+)$/)
  return (m && MEDIA_TYPES[m[1]]) || 'application/octet-stream'
}

/* ------------------------------------------------------------------ Vendor */

/**
 * 浏览器侧静态资源前缀（目前只有 Mermaid 的 UMD 构建）。
 * 同样是 **prefix** 路由、注册路径**不带**结尾斜杠（见 E-33）。
 * 与媒体路由分开的**唯一原因**：媒体是「课程目录内的相对路径」，而 vendor 是插件自带的文件，
 * 不属于任何课程 —— 混在一起会让 `courseId` 这个必填段变成可选项，安全校验也更绕。
 */
export const VENDOR_PREFIX = '/dsh-ai-courses/vendor/'
export const VENDOR_ROUTE_PATH = VENDOR_PREFIX.replace(/\/+$/, '')

/** 白名单：只送这几个文件（不做目录列举，也不接受任意文件名）。 */
const VENDOR_FILES = {
  'mermaid.min.js': 'text/javascript; charset=utf-8',      /* 图表渲染（3.4 MB，按需） */
  'highlight.min.js': 'text/javascript; charset=utf-8',    /* 代码高亮（130 KB，按需） */
}

/**
 * 读一个 vendor 资源（**纯函数**，供路由与离线自检共用）。
 *
 * 为什么单独抽出来：`scripts/check.mjs` 会 import 产物并**真的读一遍**这个文件。
 * 2026-10-18 真机暴露过一类问题：构建把 `node:fs/promises` 的 import 吞了，导致这里
 * `readFileAsync is not defined` —— 图表渲染器永远加载不到、所有 mermaid 图降级成源码，
 * 而源码 import、语法检查、离线冒烟全部正常。抽出纯函数就是为了让自检能直接打这条路径。
 */
export async function readVendorAsset (name) {
  const type = VENDOR_FILES[name]
  if (!type) {
    const e = new Error('未知的 vendor 资源')
    e.code = 'not-found'
    throw e
  }
  /* 本模块与 `vendor/` 的相对位置在**两种布局下不同**：
       · 构建产物：`package/index.mjs`     → `package/vendor/<name>`
       · 直接跑源码：`src/host/40-rpc.mjs` → `<repo>/vendor/<name>`
     所以按候选列表依次试。 */
  const candidates = [new URL('./vendor/' + name, import.meta.url), new URL('../../vendor/' + name, import.meta.url)]
  const tried = []
  for (const url of candidates) {
    try {
      return { type, text: await readFileAsync(url, 'utf8'), url: url.href }
    } catch (err) {
      tried.push(url.href + ' :: ' + String((err && err.code) || (err && err.message)))
    }
  }
  const e = new Error('vendor 资源缺失（运行 node scripts/vendor-mermaid.mjs 补齐）')
  e.code = 'not-found'
  /* 路径只进日志/自检，**不进 HTTP 响应体** */
  e.detail = { name, tried }
  throw e
}

/**
 * 注册 vendor 路由：`GET /dsh-ai-courses/vendor/<file>`。
 *
 * 为什么走宿主：浏览器拿不到插件的 `package/` 目录；而 Mermaid 是**按需加载**的 3.4 MB
 * 单文件，不能塞进 client bundle（否则每次换插件都要重下整个 client 包）。
 * 文件缺失回 404 —— 客户端据此**优雅降级**（图表以源码形式显示，不白屏）。
 */
export function registerVendorRoute (ctx) {
  return ctx.webServer.register({
    kind: 'prefix',
    path: VENDOR_ROUTE_PATH,
    handler: async (req, res) => {
      let name = ''
      try {
        /* decodeURIComponent 必须在 try 里：畸形编码不能变成未捕获异常 */
        name = decodeURIComponent(String((req && req.url) || '').split('?')[0].slice(VENDOR_PREFIX.length))
        const asset = await readVendorAsset(name)
        if (typeof res.writeHead === 'function') {
          res.writeHead(200, { 'content-type': asset.type, 'cache-control': 'private, max-age=3600' })
          res.end(asset.text)
        } else {
          res.status = 200
          res.body = asset.text
        }
      } catch (err) {
        ctx.logger?.warn?.('[ai-courses] vendor 资源不可读 %s :: %s', name,
          err && err.detail ? JSON.stringify(err.detail) : String(err && err.message))
        sendJson(res, 404, {
          ok: false,
          error: { code: 'not-found', message: String((err && err.message) || 'vendor 资源不可读') },
        })
      }
    },
  })
}

/**
 * 注册**一条**媒体读取路由：`GET /dsh-ai-courses/media/<courseId>/<relPath>`。
 *
 * 为什么需要它：课程库在 `~/.dsh/ai-courses`（工作区外），宿主静态目录服务不到；
 * 而学习页的正文里用的是**相对路径**图片（05 §5.4.1）。所以由插件自己按「课程 id + 课程目录内
 * 相对路径」把文件送出去 —— 路径两段都过 `store.joinRel` 的越界校验（绝对路径 / `..` / 反斜杠一律拒）。
 *
 * ⚠️ 与 RPC 一样，这条路由**没有鉴权**（E-26）。因此：只读、只送课程目录内的文件、不做目录列举。
 */
export function registerMediaRoute (ctx, { store }) {
  return ctx.webServer.register({
    kind: 'prefix',
    /* 无结尾斜杠：见 `MEDIA_ROUTE_PATH` 的说明（这是真机白图那一轮的根因） */
    path: MEDIA_ROUTE_PATH,
    handler: async (req, res) => {
      let courseId = ''
      let relPath = ''
      try {
        const url = String((req && req.url) || '')
        /* decodeURIComponent 必须在 try 里：畸形 `%E0%A4%A` 会抛，不能让它变成未捕获异常 */
        const rest = decodeURIComponent(url.split('?')[0].slice(MEDIA_PREFIX.length))
        const slash = rest.indexOf('/')
        courseId = slash > 0 ? rest.slice(0, slash) : ''
        relPath = slash > 0 ? rest.slice(slash + 1) : ''
        if (!courseId || !relPath) throw new Error('缺少课程或路径')
        /* 路由这一层就挡住穿越：`store.joinRel` 也会拒，但**不把安全托付给下游** ——
           这样无论 store 怎么实现、坏路径都不会变成一次文件读取。 */
        if (relPath.startsWith('/') || relPath.indexOf('\\') >= 0 ||
            !relPath.split('/').every((seg) => seg && seg !== '.' && seg !== '..')) {
          throw new Error('非法路径')
        }
        let data = await store.readRelBytes(courseId, relPath)
        if (data === undefined || data === null) throw new Error('文件不存在')
        if (/svg/i.test(relPath)) {
          const text = String(data)
          /* **well-formed 不等于安全**：`isWellFormedSvg` 只查 XML 形状，不查脚本/事件属性。
             带 script / on* / foreignObject / image / javascript: 的文件即使 XML 合法，
             也不能原样送出（客户端 Figure 的兜底会把它内联进文档）。 */
          const dangerous = /<script\b|<foreignObject\b|<iframe\b|<image\b|<use\b|<style\b|javascript:|<!ENTITY|\son[a-z]+\s*=/i.test(text)
          if (dangerous) {
            const healed = sanitizeSvg(text)
            if (!healed) throw new Error('SVG 含不安全构造，拒绝送出')
            data = healed
            ctx.logger?.warn?.('[ai-courses] 媒体 SVG 含不安全构造，已清洗后送出：%s/%s', courseId, relPath)
          } else if (!isWellFormedSvg(text)) {
            /* **读取时自愈**：早期版本写进课程库的 SVG 不是合法 XML（丢 `/`、重复属性），
               浏览器用 `<img>` 载入时要求严格 XML，于是「文件在、路由通、图就是不显示」。
               这里在送出前再洗一次 —— 旧文件不用重新生成、也不用等谁重启。
               （只读路径，不改磁盘；要持久化修好请跑 `scripts/repair-media.mjs --write`。） */
            const healed = sanitizeSvg(text)
            if (healed) {
              data = healed
              ctx.logger?.warn?.('[ai-courses] 媒体是历史坏文件，已即时修复后送出：%s/%s', courseId, relPath)
            }
          }
        }
        sendBinary(res, 200, data, mediaContentType(relPath))
        ctx.logger?.debug?.('[ai-courses] 媒体命中 %s/%s', courseId, relPath)
      } catch (err) {
        /* 失败**可诊断**：把 courseId / 相对路径 / 原因记一行（默认级别，便于用户报错时取证）。
           注意：这里只在**真的到了处理器**时才打印 —— 如果请求根本没匹配上路由，
           日志里就不会有这一行，正好用来区分「路由没注册」与「文件读不到」。 */
        ctx.logger?.warn?.('[ai-courses] 媒体未命中 %s :: %s :: %s', courseId || '(缺课程)', relPath || '(缺路径)', err && err.message)
        sendJson(res, 404, { ok: false, error: { code: 'not-found', message: '媒体文件不可读' } })
      }
    },
  })
}

function sendBinary (res, status, data, contentType) {
  const buf = Buffer.isBuffer(data) ? data : Buffer.from(String(data), 'utf8')
  if (typeof res.writeHead === 'function') {
    res.writeHead(status, {
      'content-type': contentType,
      'content-length': String(buf.length),
      /* 内容按 kpId+时间命名、生成后不再改动 → 允许长缓存；换图会换文件名 */
      'cache-control': 'private, max-age=3600',
    })
    res.end(buf)
  } else {
    res.status = status
    res.body = buf
  }
}


/* ============================================================================
 * RPC 方法表（T-6 × T-7 的接线）
 * client 只能调动这里列出的方法；每个方法自带输入校验。
 * ========================================================================== */

const SETTINGS_FILE = 'ai-courses.settings.json'
const SETTINGS_VERSION = 1

/** 课程库根目录必须是绝对路径（与 30-courses 的路径校验同一口径）。 */
function isAbsoluteCourseRoot (p) {
  return typeof p === 'string' && /^([/\\]|[A-Za-z]:[\\/])/.test(p)
}

/**
 * 读界面保存的 courseRoot 覆盖。
 *
 * `apply` 是同步的，这个文件又很小，所以启动时同步读；读坏了**不影响插件启动**，
 * 按「没有设置」处理并留一条 warn（课程库回退到 profile 配置 / 默认值）。
 */
function readRootOverride (file, home, logger) {
  try {
    if (!existsSync(file)) return null
    const parsed = JSON.parse(readFileSync(file, 'utf8'))
    const version = Number(parsed && parsed.schemaVersion)
    if (Number.isFinite(version) && version > SETTINGS_VERSION) {
      logger?.warn?.('[ai-courses] %s 的 schemaVersion=%s 比本版新，已忽略这份设置', file, String(version))
      return null
    }
    const raw = parsed && typeof parsed.courseRoot === 'string' ? parsed.courseRoot.trim() : ''
    if (!raw) return null
    const expanded = expandRoot(raw, home)
    if (!isAbsoluteCourseRoot(expanded)) {
      logger?.warn?.('[ai-courses] %s 里的 courseRoot 不是绝对路径，已忽略：%s', file, raw)
      return null
    }
    return expanded
  } catch (err) {
    logger?.warn?.('[ai-courses] 读取 %s 失败（按未设置处理）：%s', file, err && err.message)
    return null
  }
}

export function buildContext (ctx, config) {
  config = normalizeConfig(config)
  /* ⚠️ **不要访问未 inject 的服务**：cordis 会在读取 `ctx.env` 这类属性时直接抛
     `cannot get property "env" without inject` —— 这是在装上实测才暴露的（语法与离线冒烟都看不出）。
     home 只从进程环境取：课程库是插件自己的数据目录，与宿主 fs 服务无关。 */
  /* home 必须拿到**绝对路径**：相对路径会让课程库落到进程 cwd 下（位置不确定）。 */
  const home = process.env.HOME || process.env.USERPROFILE || homedir()
  const configuredRoot = expandRoot(config?.courseRoot, home)
  if (!isAbsoluteCourseRoot(configuredRoot)) {
    throw new Error(`[ai-courses] 课程库根目录必须是绝对路径，实际解析为：${JSON.stringify(configuredRoot)}（courseRoot=${JSON.stringify(config?.courseRoot)}, home=${JSON.stringify(home)}）`)
  }

  /* 配置界面保存的覆盖值：按 profile 放，避免 web/desktop 两个 profile 互相改。
     DSH_PROFILE_DIR 优先；没有的话用 DSH_PROFILE 拼；再没有才落到 DSH_HOME。 */
  const dshHome = process.env.DSH_HOME || join(home, '.dsh')
  const profileDir = process.env.DSH_PROFILE_DIR ||
    (process.env.DSH_PROFILE ? join(dshHome, 'profiles', process.env.DSH_PROFILE) : '')
  const settingsPath = resolve(profileDir || dshHome, SETTINGS_FILE)
  const savedRoot = readRootOverride(settingsPath, home, ctx.logger)
  let hasOverride = !!savedRoot
  const root = savedRoot || configuredRoot
  const defaultRoot = expandRoot(CONFIG_DEFAULTS.courseRoot, home)

  /* 课程库用 node:fs 端口：宿主 `ctx.fs` 是**沙箱化**的（workpace-write 下写不进工作区外的
     `~/.dsh/ai-courses`，且原型上没有删除能力）。真机实测见 06-fs-port.mjs 文件头与 doc/04 E-24…E-27。 */
  const fsPort = createNodeFsPort()
  const store = createStore({ fs: fsPort, root })

  /* 会话工作区：只用于「内容里的引用」的 allowlist（不是课程库位置）。
     用 `ctx.get` 而不是 `ctx.sandboxPolicy`：后者不在 inject 里，裸访问会抛；
     取不到就回空串，readSource 会退回到「课程库 + 临时目录」这个更窄的白名单。 */
  let workspaceRoot = ''
  try {
    const sp = ctx.get ? ctx.get('sandboxPolicy') : null
    const info = sp && typeof sp.resolve === 'function' ? sp.resolve() : null
    if (info && typeof info.workspaceRoot === 'string') workspaceRoot = info.workspaceRoot
  } catch { /* 可选服务取不到不影响课程库 */ }
  const courses = createCourseApi({ store, workspaceRoot })
  /* `/ai-course` 的会话级实时状态（主会话命令卡片轮询的那张表，见 15-status.mjs） */
  const status = createStatusStore()

  /* 内容生成的任务表 + 逐项执行（25-tasks）+ 单个知识点的生成与落库（30-generate）。
     两者用 `generateOne` 接线：任务只负责状态机与落盘 tasks.json，生成只负责「一个知识点」。

     ⚠️ 生成上下文（agent / signal）**按任务传**，不放在闭包里共享：
     不同课程的任务可以并发，共享一个 `gen.agent` 会让 A 任务用到 B 的会话
     （真机上表现为"内容写到了别的会话/别的模型"）。 */
  const runners = createTaskRunners({
    store,
    generateOne: (task, item, kpId, runCtx = {}) => {
      const agent = runCtx.agent
      if (!agent) {
        throw new Error('拿不到当前会话的 Agent：请在课程面板里打开知识点后再点生成（面板走 RPC 时会带上会话）')
      }
      const callModel = (prompt) => callSubagent(ctx, {
        parent: agent,
        signal: runCtx.signal,
        prompt,
        label: 'ai-courses/content',
        outputSchema: CONTENT_SCHEMA,
        json: true,
      })
      return generateOne(
        { store, courses, callModel },
        {
          courseId: task.courseId, kpId,
          contentType: task.contentType || undefined,
          prompt: task.prompt,
          keepExisting: !!task.keepExisting,
        },
      )
    },
    logger: ctx.logger,
  })

  /** 当前课程库配置（配置界面读取）。 */
  function configInfo () {
    const source = hasOverride
      ? 'settings'
      : (config.courseRoot === CONFIG_DEFAULTS.courseRoot ? 'default' : 'config')
    return {
      courseRoot: store.root,
      configuredRoot,
      defaultRoot,
      source,
      settingsPath,
      hasOverride,
    }
  }

  /**
   * 切换课程库根目录（配置界面保存）。
   *
   * 顺序很重要：**先验证目标目录可写 → 再写设置 → 最后换内存根**。
   * 任何一步失败都保持旧根不动，避免「设置写了一半、课程库已经换了」。
   * 有生成任务在跑时直接拒绝：任务持有的是旧根下的 courseId/目录，切根会让它写到新根。
   */
  async function setCourseRoot (raw) {
    const next = expandRoot(String(raw == null ? '' : raw).trim(), home)
    if (!isAbsoluteCourseRoot(next)) {
      throw new RpcError('invalid-input', `课程库目录必须是绝对路径：${next}`)
    }
    if (next === store.root) return configInfo()

    const active = runners.listActive()
    if (active.length) {
      throw new RpcError('conflict', '有生成任务正在运行，等它结束再切换课程库目录', { active: active.length })
    }
    /* `/ai-course` 的推导也会往课程库里写（课程/大纲/进度）；推导中途换根会让一次建课
       跨两个目录。它不在任务表里，单独用会话状态表拦一下。 */
    if (status.hasRunning()) {
      throw new RpcError('conflict', '有课程正在推导，等它完成再切换课程库目录')
    }
    await store.drain()

    try {
      await fsPort.mkdir(next)
      const probe = fsPort.join(next, `.aic-write-probe-${process.pid}-${Date.now()}`)
      await fsPort.writeText(probe, '')
      await fsPort.remove(probe).catch(() => {})
    } catch (err) {
      throw new RpcError('invalid-input', `课程库目录不可写：${next}`, { reason: String(err && err.message) })
    }

    try {
      await fsPort.writeText(settingsPath, JSON.stringify({ schemaVersion: SETTINGS_VERSION, courseRoot: next }, null, 2) + '\n')
    } catch (err) {
      throw new RpcError('settings-write-failed', `无法保存课程库设置：${settingsPath}`, { reason: String(err && err.message) })
    }

    store.setRoot(next)
    /* 任务运行器按 courseId 缓存、持有同一个 store；换根后必须重建，
       否则复制/搬迁课程库时会把旧根的任务快照写进新根。 */
    runners.reset()
    hasOverride = true
    try { ctx.logger?.info?.('[ai-courses] 课程库已切换到 %s', next) } catch { /* logger 不是硬依赖 */ }
    return configInfo()
  }

  return {
    store,
    courses,
    get root () { return store.root },
    status,
    runners,
    configInfo,
    setCourseRoot,
    /* 把「要用的会话」解析成 `subagents.start` 需要的 `Agent`。
       两条入口共用：RPC 从请求体的 `agentId`（精确路由没有会话上下文，E-26）、
       模型工具从 `exec.agent`（工具执行时本来就在会话里）。
       路径有三种形状：`{ id }`（E-22）或 `sessions.get(id)` / `agents.get(id)`。 */
    /**
     * 把 `agentId` / Agent 换成 `subagents.start` 需要的 `parent`。
     *
     * ⚠️ **不再兜底到「任意可用 agent」**：RPC 精确路由没有会话上下文，客户端只能
     * 猜「当前会话」；一旦猜错，内容会写进别的会话、用错模型，且完全静默。
     * 所以这里只做「精确按 id 换」，换不到就回 null，由调用方给出**可读**的拒绝理由。
     *
     * 判定「是不是 agent」有明确口径：**对象且 `id` 是字符串**。
     * 为什么必须判：这些服务在换不到时可能回 `undefined`、也可能回一个 retain 引用（truthy），
     * 直接拿来当 parent 会在后面抛一个跟"没会话"毫无关系的错。
     */
    resolveAgent (input) {
      const isAgent = (a) => !!a && typeof a === 'object' && typeof a.id === 'string' && typeof a.then !== 'function'
      if (isAgent(input)) return input
      const id = typeof input === 'string' ? input : ''
      if (!id) return null
      for (const svc of ['agents', 'sessions']) {
        const s = ctx[svc]
        if (s && typeof s.get === 'function') {
          try {
            const got = s.get(id)
            if (isAgent(got)) return got
          } catch { /* 换不到就继续试下一个 */ }
        }
      }
      return null
    },
  }
}

const OUTLINE_SCHEMA = {
  type: 'object',
  fields: {
    chapters: {
      type: 'array',
      items: {
        type: 'object',
        fields: {
          id: { type: 'string', required: true, maxLength: 64 },
          order: { type: 'number', required: true, integer: true, min: 1 },
          name: { type: 'string', required: true, maxLength: 120 },
          description: { type: 'string', maxLength: 2000 },
          knowledgePoints: {
            type: 'array',
            items: {
              type: 'object',
              fields: {
                id: { type: 'string', required: true, maxLength: 64 },
                order: { type: 'number', required: true, integer: true, min: 1 },
                name: { type: 'string', required: true, maxLength: 200 },
                contentType: { type: 'string', required: true, enum: CONTENT_TYPES },
                /* **不 required**：大纲阶段不给学习时长（内容生成后按正文回填）。
                   有值时仍校验范围 —— 旧数据/手工编辑都合法。 */
                duration: { type: 'number', integer: true, min: 1, max: 600 },
              },
            },
          },
        },
      },
    },
  },
}

export function createMethodTableFor (deps) {
  const { courses, status, store, runners, resolveAgent, configInfo, setCourseRoot } = deps
  /* 领域层的错误码 → RPC 错误码（40-rpc 按 code 决定 HTTP 状态） */
  const wrap = (fn) => async (ctx, input) => {
    try {
      return await fn(ctx, input)
    } catch (err) {
      if (err instanceof CourseError || err instanceof StoreError) {
        throw new RpcError(toRpcCode(err), err.message, err.detail)
      }
      throw err
    }
  }

  return createMethodTable([
    {
      name: 'config.get',
      input: { type: 'object', fields: {} },
      handle: wrap(async () => configInfo()),
    },
    {
      name: 'config.set',
      input: {
        type: 'object',
        fields: {
          /* 目录路径：只做「非空/长度」校验；绝对路径与可写性由 setCourseRoot 现场验。 */
          courseRoot: { type: 'string', required: true, maxLength: 4096 },
        },
      },
      handle: wrap(async (ctx, i) => setCourseRoot(i.courseRoot)),
    },
    {
      name: 'courses.list',
      input: { type: 'object', fields: {} },
      handle: wrap(async () => {
        const rows = await courses.listSummaries()
        /* 只数信封文件，**不读每个信封**：列表页只需要「有没有内容 / 已生成 N」，
           读内容会把 N 门课 × M 个资产变成 O(N×M) 次磁盘读。
           `hasContent` / `contentCount` / `kpGenerated` 三者同源，口径不打架。 */
        return Promise.all(rows.map(async (r) => {
          const contentCount = r.course ? await countAssetFiles(store, r.id) : 0
          return {
            id: r.id,
            name: r.course?.name ?? null,
            description: r.course?.description ?? '',
            difficulty: r.course?.difficulty ?? null,
            category: r.course?.category ?? '',
            tags: r.course?.tags ?? [],
            chapterCount: r.course?.outline?.chapters?.length ?? 0,
            /* 卡片进度（06 §3.2）：课程进度**派生**自知识点层，不落盘（05 §6） */
            kpTotal: r.kpTotal ?? 0,
            kpMastered: r.kpMastered ?? 0,
            /* 更新时间（ms）与「有内容可学」：卡片排序与学习按钮灰显的判据。
             `kpGenerated` = 已有内容信封的知识点数（信封是「已生成」的唯一凭据，05 §5.4）。 */
            updatedAt: r.updatedAt ?? 0,
            hasContent: contentCount > 0,
            contentCount,
            kpGenerated: contentCount,
            corrupt: !!r.corrupt,
            missing: !!r.missing,
            readOnly: !!r.readOnly,
          }
        }))
      }),
    },
    {
      name: 'courses.read',
      input: { type: 'object', fields: { courseId: { type: 'string', required: true, maxLength: 64 } } },
      handle: wrap(async (ctx, i) => {
        const r = await courses.read(i.courseId)
        if (!r) throw new CourseError('not-found', `课程不存在：${i.courseId}`)
        /* 只带「已生成」映射（资产是课程域的事实）。
           「生成中/失败」属于任务表，由客户端单独调 `generation.status` 取 ——
           这样 courses.read 不依赖生成链路，宿主重启后首次读也不会因为任务表未加载而空。 */
        const envelopes = await listAssets(store, i.courseId)
        const assets = {}
        for (const env of envelopes) assets[env.kpId] = env.contentType
        return { ...r, assets }
      }),
    },
    {
      name: 'courses.create',
      input: {
        type: 'object',
        fields: {
          name: { type: 'string', required: true, maxLength: 60 },
          description: { type: 'string', maxLength: 2000 },
          difficulty: { type: 'string', enum: DIFFICULTIES },
          category: { type: 'string', maxLength: 40 },
          tags: { type: 'array', maxItems: 20, items: { type: 'string', maxLength: 24 } },
          outline: OUTLINE_SCHEMA,
        },
      },
      handle: wrap(async (ctx, i) => courses.create(i)),
    },
    {
      name: 'outline.revise',
      input: {
        type: 'object',
        fields: {
          courseId: { type: 'string', required: true, maxLength: 64 },
          /* 修订用「动作列表」而不是整棵大纲：避免前端把整棵树回传（也就避免了并发覆盖） */
          operations: {
            type: 'array',
            required: true,
            maxItems: 200,
            items: {
              type: 'object',
              fields: {
                op: { type: 'string', required: true, enum: ['renameCourse', 'setDescription', 'setDifficulty', 'setCategory', 'setTags', 'renameChapter', 'setChapterDescription', 'addChapter', 'removeChapter', 'moveChapter', 'renameKp', 'setKpType', 'setKpDuration', 'addKp', 'removeKp', 'moveKp'] },
                chapterId: { type: 'string', maxLength: 64 },
                kpId: { type: 'string', maxLength: 64 },
                value: { type: 'string', maxLength: 2000 },
                index: { type: 'number', integer: true, min: 0, max: 500 },
              },
            },
          },
        },
      },
      handle: wrap(async (ctx, i) => {
        /* 修订前先取一份旧大纲，用来算「被删掉的知识点」；读不到就让 reviseOutline 去抛 not-found */
        const before = await courses.read(i.courseId).catch(() => null)
        const next = await courses.reviseOutline(i.courseId, (course) => {
          /* 同一批操作共享 id 映射：addChapter 若因重复被改名，同批的 addKp 跟着改投 */
          const batch = { idMap: new Map() }
          for (const op of i.operations) applyOutlineOp(course, op, batch)
          return course
        })
        /* 删知识点/删章节后，`content-assets/<kpId>.*` 是孤儿文件：级联清掉，避免越积越多 */
        const removed = before && before.course ? removedKpIds(before.course, next) : []
        if (removed.length) {
          try {
            await removeAssets(store, i.courseId, removed)
          } catch (err) {
            ctx?.logger?.warn?.('[ai-courses] 清理已删除知识点的资产失败（不影响大纲修订）：%s', err && err.message)
          }
        }
        return { id: next.id, name: next.name, chapterCount: next.outline.chapters.length }
      }),
    },
    {
      name: 'courses.remove',
      input: { type: 'object', fields: { courseId: { type: 'string', required: true, maxLength: 64 } } },
      handle: wrap(async (ctx, i) => ({ removed: await courses.remove(i.courseId) })),
    },
    {
      /* 发起内容生成（三种粒度）。任务在后台跑，这里**立刻**回 taskId（界面按它轮询）。 */
      name: 'generation.start',
      input: {
        type: 'object',
        fields: {
          courseId: { type: 'string', required: true, maxLength: 64 },
          scope: { type: 'string', required: true, enum: ['course', 'chapter', 'kp'] },
          targetIds: { type: 'array', maxItems: 500, items: { type: 'string', maxLength: 64 } },
          contentType: { type: 'string', maxLength: 24 },
          prompt: { type: 'string', maxLength: PROMPT_MAX, label: 'AI 备注' },
          /* 已有内容时：true = 追加到旧内容之后；false/缺省 = 覆盖（旧行为） */
          keepExisting: { type: 'boolean' },
          /* 精确路由没有会话上下文（E-26）→ 客户端把要用的会话 id 带上来，
             宿主用 `ctx.agents.get(id)` 换回 Agent 给 `subagents.start` 当 parent。 */
          agentId: { type: 'string', maxLength: 128 },
        },
      },
      handle: wrap(async (ctx, i) => {
        const read = await courses.read(i.courseId)
        if (!read) throw new CourseError('not-found', `课程不存在：${i.courseId}`)
        if (read.readOnly) throw new CourseError('read-only', '这门课由更高版本写入，本版只读，不能生成内容')
        const picked = selectTargets(read.course, i.scope, i.targetIds)
        if (picked.length === 0) {
          throw new CourseError('no-targets', '没有匹配到知识点：请检查目标（整门课 / 章节 / 知识点）是否还存在')
        }
        /* 生成要用会话的 Agent 起子 agent。取不到就**先拒绝**（而不是等任务跑起来再失败） */
        const agent = resolveAgent(i.agentId)
        if (!agent) {
          throw new CourseError('no-agent', '拿不到当前会话：请在课程面板里打开这门课再发起生成（生成的模型调用需要一个会话）')
        }
        const kpIds = picked.map((x) => x.kp.id)
        try {
          const task = await runners.for(i.courseId).create({
            courseId: i.courseId,
            scope: i.scope,
            targetIds: i.targetIds || [],
            kpIds,
            prompt: i.prompt || '',
            contentType: i.contentType || '',
            keepExisting: !!i.keepExisting,
            /* 生成上下文按任务携带，不能放进共享闭包（并发时会串会话） */
            agent,
            agentId: agent.id,
          })
          return { task, count: kpIds.length }
        } catch (err) {
          if (err && err.code === 'already-running') {
            return { task: err.task, count: kpIds.length, alreadyRunning: true }
          }
          throw err
        }
      }),
    },
    {
      /* 任务进度（界面轮询；`states` 是这门课每个知识点的当前状态，供行末状态点用）。 */
      name: 'generation.status',
      input: {
        type: 'object',
        fields: {
          courseId: { type: 'string', required: true, maxLength: 64 },
          taskId: { type: 'string', maxLength: 64 },
        },
      },
      handle: async (ctx, i) => {
        const runner = runners.for(i.courseId)
        await runner.ensureLoaded()
        const task = i.taskId ? runner.get(i.taskId) : runner.activeOf(i.courseId)
        return { task, active: runner.activeOf(i.courseId), states: runner.itemStates(i.courseId) }
      },
    },
    {
      /* **所有课程当前在跑的任务**（主会话的常驻状态条用）。
         只读、不含正文；带课程名与「正在写哪个知识点」的名称，界面不必再查一遍。 */
      name: 'generation.active',
      input: { type: 'object', fields: {} },
      handle: async (ctx) => {
        const active = runners.listActive()
        if (!active.length) return { tasks: [] }
        const out = []
        for (const row of active) {
          const read = await courses.read(row.courseId)
          const t = row.task
          const current = (t.items || []).find((it) => it.state === 'running')
          let kpName = ''
          if (read && current) {
            for (const ch of read.course.outline.chapters) {
              for (const k of ch.knowledgePoints || []) if (k.id === current.kpId) kpName = k.name
            }
          }
          out.push({
            courseId: row.courseId,
            courseName: read ? read.course.name : '',
            kpName: kpName,
            task: t,
          })
        }
        return { tasks: out }
      },
    },
    {
      /* 某门课的任务历史（「重试失败项」与审计用）。 */
      name: 'generation.list',
      input: { type: 'object', fields: { courseId: { type: 'string', required: true, maxLength: 64 } } },
      handle: async (ctx, i) => {
        const runner = runners.for(i.courseId)
        await runner.ensureLoaded()
        return { tasks: runner.list(i.courseId, 10) }
      },
    },
    {
      /* 读一个知识点的内容资产（学习页正文 + 媒体清单）。没有 → `hasAsset:false`（未生成）。 */
      name: 'contentAssets.get',
      input: {
        type: 'object',
        fields: {
          courseId: { type: 'string', required: true, maxLength: 64 },
          kpId: { type: 'string', required: true, maxLength: 32 },
          contentType: { type: 'string', maxLength: 24 },
        },
      },
      handle: wrap(async (ctx, i) => {
        const read = await courses.read(i.courseId)
        if (!read) throw new CourseError('not-found', `课程不存在：${i.courseId}`)
        let kp = null
        for (const ch of read.course.outline.chapters) {
          for (const k of ch.knowledgePoints || []) if (k.id === i.kpId) kp = k
        }
        if (!kp) throw new CourseError('not-found', `知识点不存在：${i.kpId}`)
        const payload = await readAssetPayload(store, i.courseId, i.kpId, i.contentType || kp.contentType)
        /* **实际学习时长**：按正文估算（`estimateMinutes`），而不是读大纲里那个可能来自旧数据的值。
           这样即使历史数据里的 `duration` 是过时的估计，学习页显示的也是"这份内容要读多久"。 */
        const minutes = payload.hasAsset
          ? estimateMinutes(payload.body, i.contentType || kp.contentType)
          : 0
        return {
          ...payload,
          kpId: i.kpId,
          contentType: i.contentType || kp.contentType,
          minutes,
          /* 每种类型的展示口径：`幻灯片` 走播放器；其余 Markdown；四种待定类型标注「格式待定」 */
          render: payload.hasAsset
            ? (((i.contentType || kp.contentType) === '幻灯片') ? 'slidev' : 'markdown')
            : 'none',
          formatPending: DEFERRED_TYPES.indexOf(i.contentType || kp.contentType) >= 0,
        }
      }),
    },
    {
      /* 学习进度的标记（05 §6.1：打开 → 进行中、离开 → 已掌握，由界面驱动）。 */
      name: 'progress.mark',
      input: {
        type: 'object',
        fields: {
          courseId: { type: 'string', required: true, maxLength: 64 },
          kpId: { type: 'string', required: true, maxLength: 32 },
          state: { type: 'string', required: true, enum: ['未开始', '进行中', '已掌握'] },
        },
      },
      handle: wrap(async (ctx, i) => {
        const read = await courses.read(i.courseId)
        if (!read) throw new CourseError('not-found', `课程不存在：${i.courseId}`)
        /* 只读课程（更高版本写入）不能被本版改进度：写 progress.json 会让用户以为数据被改坏了 */
        if (read.readOnly) throw new CourseError('read-only', '该课程由更高版本写入，本版只读')
        /* **没有内容就不记进度**：一个还没生成内容的知识点，"学过/学完"没有意义 ——
           进度表的语义是「对这份内容的学习状态」（05 §6.1）。这里直接空操作，
           而不是写一个 未开始（那会把已有进度也抹掉），也不是报错（用户没做错什么）。 */
        let kp = null
        for (const ch of read.course.outline.chapters) {
          for (const k of ch.knowledgePoints || []) if (k.id === i.kpId) kp = k
        }
        if (!kp) throw new CourseError('not-found', `知识点不存在：${i.kpId}`)
        const payload = await readAssetPayload(store, i.courseId, i.kpId, kp.contentType)
        if (!payload.hasAsset) {
          return { courseId: i.courseId, kpId: i.kpId, state: '', skipped: 'no-content' }
        }
        /* 进度**不**走大纲修订：单独一个事务写 progress.json（05 §5.3）。
           `tx` 已经持有该课程的锁，因此读-改-写不会与生成任务交叉。 */
        await store.transact(i.courseId, async (tx) => {
          const prog = await tx.readProgress()
          const kp = { ...(prog.kp || {}) }
          if (i.state === '未开始') delete kp[i.kpId]
          else kp[i.kpId] = i.state
          await tx.writeProgress({ kp })
        })
        return { courseId: i.courseId, kpId: i.kpId, state: i.state }
      }),
    },
    {
      /* **只读诊断**：把「渲染一个知识点需要一个媒体 URL，而这条 URL 到底通不通」一次问清楚。
         为什么需要它：媒体 404 有两个完全不同的原因 ——（a）路由没注册，（b）文件读不到；
         光看浏览器的 404 分不出来。这里让**宿主自己**回答，省掉一轮猜。
         它只读、只回状态码，不泄露文件内容。 */
      name: 'media.check',
      input: {
        type: 'object',
        fields: {
          courseId: { type: 'string', required: true, maxLength: 64 },
          kpId: { type: 'string', required: true, maxLength: 32 },
        },
      },
      handle: async (ctx, i) => {
        const read = await courses.read(i.courseId)
        if (!read) throw new CourseError('not-found', `课程不存在：${i.courseId}`)
        let kp = null
        for (const ch of read.course.outline.chapters) {
          for (const k of ch.knowledgePoints || []) if (k.id === i.kpId) kp = k
        }
        if (!kp) throw new CourseError('not-found', `知识点不存在：${i.kpId}`)
        const payload = await readAssetPayload(store, i.courseId, i.kpId, kp.contentType)
        const checks = []
        for (const m of payload.media || []) {
          const rel = String(m.path || '').replace(/^content-assets\//, '')
          let ok = false
          let reason = ''
          try {
            const data = await store.readRelBytes(i.courseId, 'content-assets/' + rel)
            ok = data !== undefined && data !== null && String(data).length > 0
            if (!ok) reason = '文件为空'
          } catch (err) {
            reason = String((err && err.message) || err)
          }
          checks.push({ declared: m.path, url: MEDIA_PREFIX + i.courseId + '/content-assets/' + rel, readable: ok, reason: reason })
        }
        return {
          hasAsset: payload.hasAsset,
          contentType: kp.contentType,
          mediaRefs: (payload.media || []).length,
          media: checks,
        }
      },
    },
    {
      /* 主会话命令卡片的实时状态（只读；状态表是内存态，见 15-status.mjs）。
         `sessionId` 由客户端从会话作用域取（卡的 props 上就有），宿主不反查会话。 */
      name: 'status.get',
      input: { type: 'object', fields: { sessionId: { type: 'string', required: true, maxLength: 128 } } },
      handle: async (ctx, i) => (status && typeof status.read === 'function' ? status.read(i.sessionId) : null),
    },
  ])
}

/** 单个大纲修订动作。order 由数组位置**重排后**重新编号，保证连续（05 §3）。
 *  `export` 是为了让 scripts/courses-smoke.mjs 能直接断言这些动作（界面「结构」按钮发的就是它们）。 */
const ID_RE = { chapter: /^ch-\d{2,3}$/ }

/**
 * 大纲修订前后相比，被删掉的知识点 id。
 *
 * 用于 `outline.revise` 之后级联清理内容资产：删知识点/删章节都会让知识点消失，
 * 但大纲只改 `course.json`，`content-assets/<kpId>.*` 会变成孤儿文件。
 */
export function removedKpIds (before, after) {
  const afterIds = new Set()
  for (const ch of (after && after.outline && after.outline.chapters) || []) {
    for (const kp of ch.knowledgePoints || []) if (kp && kp.id) afterIds.add(kp.id)
  }
  const out = new Set()
  for (const ch of (before && before.outline && before.outline.chapters) || []) {
    for (const kp of ch.knowledgePoints || []) {
      if (kp && kp.id && !afterIds.has(kp.id)) out.add(kp.id)
    }
  }
  return [...out]
}

function escapeRegExp (s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * 分配一个**当前集合里不存在**的 id：`<prefix>-NN`。
 *
 * 为什么不是 `length + 1`：删掉中间一项再新增时，`length + 1` 会撞上已有的最后一项
 * （[ch-01, ch-02, ch-03] 删 ch-02 后 length=2 → 又生成 ch-03）。
 * 取「已有数字后缀的最大值 + 1」才不会撞。
 */
function allocateId (ids, prefix, width = 2) {
  const re = new RegExp('^' + escapeRegExp(prefix) + '-(\\d+)$')
  let max = 0
  for (const id of ids || []) {
    const m = re.exec(String(id || ''))
    if (m) max = Math.max(max, Number(m[1]))
  }
  return prefix + '-' + String(max + 1).padStart(width, '0')
}

/**
 * 应用一个单步大纲操作。
 *
 * `batch.idMap` 只在**同一批** `outline.revise` 里有效：客户端"新增章节"会先
 * `addChapter(value: newId)` 再 `addKp(chapterId: newId)`；如果 `newId` 已被占用，
 * host 会分配一个新 id，并把 `newId → 实际 id` 记下来，让同批的 `addKp` 跟着改投。
 * 不依赖客户端先查重，也不会把重复 id 写进课程。
 */
export function applyOutlineOp (course, op, batch = {}) {
  const chapters = course.outline.chapters
  const idMap = batch.idMap instanceof Map ? batch.idMap : new Map()
  const resolveChapterId = (id) => idMap.get(id) || id
  const findCh = () => chapters.find((c) => c.id === resolveChapterId(op.chapterId))
  const findKp = () => { for (const c of chapters) { const k = (c.knowledgePoints ?? []).find((x) => x.id === op.kpId); if (k) return { c, k } } return null }
  const renumber = () => {
    chapters.forEach((c, i) => {
      c.order = i + 1
      ;(c.knowledgePoints ?? []).forEach((k, j) => { k.order = j + 1 })
    })
  }
  switch (op.op) {
    case 'renameCourse': course.name = String(op.value ?? '').slice(0, 60); break
    case 'setDescription': course.description = op.value ?? ''; break
    case 'setDifficulty':
      if (DIFFICULTIES.indexOf(op.value) < 0) throw new CourseError('invalid-outline', `难度非法：${op.value}`)
      course.difficulty = op.value; break
    case 'setCategory': course.category = String(op.value ?? '').slice(0, 40); break
    /* 标签：`,` 是落库口径；`、`/`，`/空白 是中文输入法下的常见分隔，一并接受（界面上是顿号连接） */
    case 'setTags': course.tags = String(op.value ?? '').split(/[,，、\s]+/).map((s) => s.trim()).filter(Boolean).slice(0, 20); break
    case 'renameChapter': { const c = findCh(); if (!c) throw new CourseError('not-found', `章节不存在：${op.chapterId}`); c.name = String(op.value ?? '').slice(0, 120); break }
    case 'setChapterDescription': { const c = findCh(); if (!c) throw new CourseError('not-found', `章节不存在：${op.chapterId}`); c.description = op.value ?? ''; break }
    case 'addChapter': {
      /* 客户端建议的 id 只在「格式合法且未被占用」时采纳；否则由 host 分配。
         无论采纳与否都记进 idMap，同批的 addKp / renameChapter 才能跟上。 */
      const requested = typeof op.value === 'string' ? op.value.trim() : ''
      let id = requested && ID_RE.chapter.test(requested) && !chapters.some((c) => c.id === requested)
        ? requested
        : allocateId(chapters.map((c) => c.id), 'ch')
      /* 极小的竞态兜底：allocateId 只看当前集合，理论上不会撞；再查一次不亏 */
      while (chapters.some((c) => c.id === id)) id = allocateId([...chapters.map((c) => c.id), id], 'ch')
      if (requested) idMap.set(requested, id)
      const chapter = { id, order: chapters.length + 1, name: '新章节', knowledgePoints: [] }
      /* `index` = **插入位置**（大纲页的「在本章后新增」用的就是它）；缺省追加到末尾。
         插到中间时 order 由末尾的 renumber() 统一重排，因此这里不用管 order。 */
      const at = Number.isInteger(op.index) ? Math.max(0, Math.min(op.index, chapters.length)) : chapters.length
      chapters.splice(at, 0, chapter)
      break
    }
    case 'removeChapter': { const id = resolveChapterId(op.chapterId); const i = chapters.findIndex((c) => c.id === id); if (i < 0) throw new CourseError('not-found', `章节不存在：${op.chapterId}`); chapters.splice(i, 1); break }
    case 'moveChapter': { const id = resolveChapterId(op.chapterId); const i = chapters.findIndex((c) => c.id === id); if (i < 0) throw new CourseError('not-found', `章节不存在：${op.chapterId}`); const [x] = chapters.splice(i, 1); chapters.splice(Math.min(op.index ?? 0, chapters.length), 0, x); break }
    case 'renameKp': { const f = findKp(); if (!f) throw new CourseError('not-found', `知识点不存在：${op.kpId}`); f.k.name = String(op.value ?? '').slice(0, 200); break }
    case 'setKpType': { const f = findKp(); if (!f) throw new CourseError('not-found', `知识点不存在：${op.kpId}`); if (CONTENT_TYPES.indexOf(op.value) < 0) throw new CourseError('invalid-outline', `类型非法：${op.value}`); f.k.contentType = op.value; break }
    case 'setKpDuration': { const f = findKp(); if (!f) throw new CourseError('not-found', `知识点不存在：${op.kpId}`); const n = Number(op.value); if (!Number.isInteger(n) || n <= 0) throw new CourseError('invalid-outline', '学习时长必须是正整数分钟'); f.k.duration = n; break }
    case 'addKp': {
      const c = findCh()
      if (!c) throw new CourseError('not-found', `章节不存在：${op.chapterId}`)
      const kps = (c.knowledgePoints ??= [])
      /* 章节号从 **章节 id** 解析（不是 order、也不是 id 末两位）：
         · ch-100 → 100（末两位会退化成 00）；
         · 章节重排后 id 不变，KP id 前缀不会与别的章节撞车（order 会变）。
         解析不出来再退回 order；分配时用**全课程**已用的 KP id 去重，双保险。 */
      const chMatch = /^ch-(\d{2,3})$/.exec(String(c.id || ''))
      const chNo = chMatch ? chMatch[1] : String(c.order).padStart(2, '0')
      const allKpIds = chapters.flatMap((ch) => (ch.knowledgePoints || []).map((k) => k.id))
      const id = allocateId(allKpIds, 'kp-' + chNo)
      const kp = { id, order: kps.length + 1, name: String(op.value || '新知识点').slice(0, 200), contentType: '图文' }
      /* `index` = 在本章内的**插入位置**（「在本知识点后新增」）；缺省追加到末尾。 */
      const at = Number.isInteger(op.index) ? Math.max(0, Math.min(op.index, kps.length)) : kps.length
      kps.splice(at, 0, kp)
      break
    }   /* 时长等生成内容后回填 */
    case 'removeKp': { const f = findKp(); if (!f) throw new CourseError('not-found', `知识点不存在：${op.kpId}`); const i = f.c.knowledgePoints.findIndex((x) => x.id === op.kpId); f.c.knowledgePoints.splice(i, 1); break }
    case 'moveKp': { const f = findKp(); if (!f) throw new CourseError('not-found', `知识点不存在：${op.kpId}`); const i = f.c.knowledgePoints.findIndex((x) => x.id === op.kpId); const [x] = f.c.knowledgePoints.splice(i, 1); f.c.knowledgePoints.splice(Math.min(op.index ?? 0, f.c.knowledgePoints.length), 0, x); break }
    default: throw new CourseError('invalid-input', `未知的大纲操作：${op.op}`)
  }
  renumber()
}


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


/* ---------------------------------------------------------------- apply */
export function apply (ctx, config) {
  const disposers = []
  try {
    /* RPC：client ↔ host 的唯一数据通道 */
    const deps = buildContext(ctx, config)
    const table = createMethodTableFor(deps)
    registerRoutes(ctx, table).forEach((d) => disposers.push(d))
    /* 媒体的 GET 路由（学习页正文里的相对路径图片）：与 RPC 同一个 webServer，路径前缀独立 */
    disposers.push(registerMediaRoute(ctx, deps))
    /* 浏览器按需加载的静态资源（Mermaid）。缺文件只影响图表渲染，客户端会降级成源码块 */
    disposers.push(registerVendorRoute(ctx))
    disposers.push(registerSystemPrompt(ctx))
    disposers.push(registerCourseCommand(ctx, deps))

    /* 模型工具：与 UI 走同一张方法表，保证语义不漂移 */
    const toolDefs = createToolDefinitions({ deps, table })
    registerTools(ctx, toolDefs).forEach((d) => disposers.push(d))
    /* logger 走 try/catch：它不是 inject 服务，取不到也不该让激活失败 */
    try { ctx.logger?.info?.('[ai-courses] RPC %d 个方法、%d 个工具；courseRoot=%s', table.size, toolDefs.length, deps.root) } catch {}

  } catch (err) {
    disposers.forEach((d) => { try { d() } catch {} })
    throw err
  }
  return () => { disposers.forEach((d) => { try { d() } catch {} }) }
}
