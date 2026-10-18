import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { createStore, StoreError, expandRoot } from './20-store.mjs'
import { createCourseApi, CourseError, toRpcCode } from './30-courses.mjs'
import { createStatusStore } from './15-status.mjs'
import { createTaskRunners } from './25-tasks.mjs'
import { listAssets, countAssetFiles, readAssetPayload, removeAssets, AssetError } from './28-assets.mjs'
import { generateOne, selectTargets, CONTENT_SCHEMA, estimateMinutes } from './30-generate.mjs'
import { callSubagent } from './10-prompt.mjs'
import { CONTENT_TYPES, DIFFICULTIES, DEFERRED_TYPES, PROMPT_MAX } from './05-constants.mjs'
import { RpcError, createMethodTable } from './40-rpc.mjs'

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
