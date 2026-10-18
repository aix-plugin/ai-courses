#!/usr/bin/env node
/** 产物自检：manifest 字段核对 + patch 形态 + 入口语法 + id 一致性。 */
import { readFile, readdir, access } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { pathToFileURL } from 'node:url'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const pkgDir = join(root, 'package')
let pass = 0, fail = 0
const ck = (name, ok, ev) => { ok ? pass++ : fail++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ev ? '  → ' + ev : ''}`) }

const pkg = JSON.parse(await readFile(join(pkgDir, 'package.json'), 'utf8'))
ck('包名是 dsh-ai-courses', pkg.name === 'dsh-ai-courses', pkg.name)
ck('version 存在', /^\d+\.\d+\.\d+$/.test(pkg.version), pkg.version)
ck('type = module', pkg.type === 'module')
ck('dsh.bundle.patch 指向 ./cordis.patch.yml', pkg.dsh?.bundle?.patch === './cordis.patch.yml', pkg.dsh?.bundle?.patch)
ck('dsh.client.platform = web', pkg.dsh?.client?.platform === 'web', pkg.dsh?.client?.platform)
ck('dsh.client.inject = ["@deepseek-ai/dsh-client-runtime"]',
  JSON.stringify(pkg.dsh?.client?.inject) === JSON.stringify(['@deepseek-ai/dsh-client-runtime']),
  JSON.stringify(pkg.dsh?.client?.inject))
ck('未声明 dsh.client.external', pkg.dsh?.client?.external === undefined)
ck('未声明 dependencies（零运行时依赖）', pkg.dependencies === undefined)
ck('exports 导出 ./package.json 与 ./locale/*.json',
  pkg.exports?.['./package.json'] && pkg.exports?.['./locale/*.json'])

/* files 覆盖到的每个路径都必须真实存在（`*` 按目录检查） */
for (const f of pkg.files ?? []) {
  const p = f.includes('*') ? join(pkgDir, f.split('/')[0]) : join(pkgDir, f)
  try { await access(p); ck('files 覆盖存在：' + f, true) } catch { ck('files 覆盖存在：' + f, false, '缺失') }
}

/* patch：顶层 YAML 数组，insert 行带 id 与 name */
const patch = await readFile(join(pkgDir, 'cordis.patch.yml'), 'utf8')
const lines = patch.split('\n').filter((l) => !/^\s*#/.test(l) && l.trim())
ck('patch 顶层是数组（首行以 - 开头）', lines[0].startsWith('- '), lines[0])
/* YAML 是缩进结构：insert 行是 `- insert:`，其下 `    - id: …` / `      name: …` */
ck('patch 含 insert 行', lines.some((l) => l.trim() === '- insert:'), lines[0])
ck('insert 行下有 id: ai-courses', lines.some((l) => l.trim() === '- id: ai-courses'))
ck('patch 含 name: dsh-ai-courses', lines.some((l) => l.trim() === 'name: dsh-ai-courses'))

/* 入口语法 */
for (const f of ['index.mjs', 'lib/client.js']) {
  try { execFileSync(process.execPath, ['--check', join(pkgDir, f)], { stdio: 'pipe' }); ck('node --check ' + f, true) }
  catch (e) { ck('node --check ' + f, false, String(e.stderr || e).slice(0, 120)) }
}

/* ⚠️ `node --check` 只查语法，**查不出 TDZ**：拼接后若某段顶层引用了后面才声明的 const，
   语法合法、check 通过，但 import 会抛 "Cannot access 'X' before initialization"，
   而 cordis 只报一句 "failed to import"（这个坑刚踩过，排查了好几轮）。
   所以必须**真的 import 一次**。 */
try {
  const m = await import(pathToFileURL(join(pkgDir, 'index.mjs')).href)
  ck('产物能被真正 import（能查出 TDZ）', typeof m.apply === 'function', Object.keys(m).length + ' 个导出')
  ck('导出 inject 数组', Array.isArray(m.inject) && m.inject.length > 0, JSON.stringify(m.inject))
  ck('导出 Config 且带 Standard Schema 的 ~standard',
    !!(m.Config && m.Config['~standard'] && typeof m.Config['~standard'].validate === 'function'))
  ck('Config[~standard].validate 返回同步结果（cordis 显式拒绝 Promise）',
    typeof m.Config['~standard'].validate({}).then !== 'function')
} catch (err) {
  ck('产物能被真正 import（能查出 TDZ）', false, err.constructor.name + ': ' + err.message)
}

/* id 一致性：sidebar.panellist.id 必须等于 main.key（宿主按 list id 寻址 main 面板） */
const client = await readFile(join(pkgDir, 'lib/client.js'), 'utf8')
const panelId = client.match(/name:\s*'sidebar\.panellist',\s*id:\s*'([^']+)'/)?.[1]
const mainKey = client.match(/name:\s*'main',\s*key:\s*'([^']+)'/)?.[1]
ck('sidebar.panellist.id 与 main.key 是同一字符串', !!panelId && panelId === mainKey, `${panelId} / ${mainKey}`)
ck('面板 id 是 ai-courses（不是已被占用的 course）', panelId === 'ai-courses', panelId)
ck('client 工厂 id 等于包名',
  client.match(/__ModuleLoader__\.load\(\{[\s\S]{0,80}?id:\s*'([^']+)'/)?.[1] === pkg.name)
ck('client 不 require 任何 Harness Client 包',
  !/require\(\s*['"]@deepseek-ai\/dsh-client/.test(client))
/* **先裁掉内联的第三方**（highlight.js），再剥注释：
   第三方代码里有大量块注释与字符串，naive 剥注释会把后面的**我们自己的代码一起吞掉**
   （踩过：裁不干净 → 「渲染路径无 innerHTML」误报）。裁剪要在**原始文本**上做。 */
const VENDOR_BANNER = '/* ==================== 内联第三方：'
const vendorAtRaw = client.indexOf(VENDOR_BANNER)
const clientOwnRaw = vendorAtRaw >= 0 ? client.slice(0, vendorAtRaw) : client
/* 先剥注释，否则注释里提到的 require('react') 会被算进来（这个坑刚踩过） */
const clientCode = clientOwnRaw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
/* ⚠️ 这两条是「能装上但起不来」的直接原因，必须钉住：
   ① package.json 缺 main → host 入口解析不到
   ② client 的插件对象缺 inject: ['slots'] → apply 在 slots 就绪前跑，ctx.slots 不存在 → 整个应用 web boot 失败 */
/* 命令名：必须注册为 ai-course（v4.10 由 /course 改名），且不得残留旧名 */
const hostSrc = await readFile(join(pkgDir, 'index.mjs'), 'utf8')
/* 跨源防线：client 必须带 host 校验的那个自定义头；两边常量漂移会让人以为是 CORS 问题 */
ck('client RPC 带上 host 要求的自定义头（x-dsh-ai-courses: 1）',
  /RPC_HEADER = 'x-dsh-ai-courses'/.test(hostSrc) && /'x-dsh-ai-courses': '1'/.test(clientCode))
ck('client RPC 有超时/取消（AbortController + timeout，不无限转圈）',
  /AIC_RPC_TIMEOUT_MS/.test(clientCode) && /new AbortController/.test(clientCode) && /code = aborted \?/.test(clientCode))
ck('host 注册的命令名是 ai-course', /name:\s*'ai-course'/.test(hostSrc), (hostSrc.match(/name:\s*'[a-z-]*course[a-z-]*'/) || ['无'])[0])
ck('host 里不再有 name: \'course\'（旧命令名）', !/name:\s*'course'/.test(hostSrc))
ck('命令的 help 文案用 /ai-course', /\/ai-course/.test(hostSrc))
/* P1-3 / P1-4：读接口不夹带生成状态；列表只数信封文件，不逐个读资产 */
ck('courses.read 不再夹带 taskStates（生成状态由 generation.status 单独取）',
  !/taskStates:\s*runners/.test(hostSrc) && /const taskStates = live\.states/.test(clientCode))
ck('课程列表只数信封文件（countAssetFiles），不逐个读资产',
  /countAssetFiles\(store, r\.id\)/.test(hostSrc) && /export async function countAssetFiles/.test(hostSrc))

/* --- 分类与标签（用户需求：默认不给分类；标签 2~3 个、范围大） --- */
ck('推导的 JSON 形状里**保留** category（字段不删，只是恒为空）',
  /"category"/.test(hostSrc.match(/const DERIVATION_SHAPE = `([\s\S]*?)`/)?.[1] || ''))
/* ⚠️ 只看 `DERIVATION_SCHEMA` 那一段：`category` 在**别处**是合法的（课程领域模型、
   `outline.revise` 的 setCategory 动作都还能收分类，只是推导不产出它） */
const stripComments = (text) => text.replace(/\/\*[\s\S]*?\*\//g, ' ')
/* ⚠️ 用**代码锚点**取 schema 段，不要用注释文本做锚点：注释在构建/改写时会变，
   锚点失配会让 `slice(i, -1)` 悄悄退化成「几乎整份产物」，于是别的合法 `category` 也会被算进来
   （这次就是这么误报的）。 */
const schemaFrom = hostSrc.indexOf('const DERIVATION_SCHEMA')
const derivationSchemaSrc = stripComments(hostSrc.slice(schemaFrom, hostSrc.indexOf('\n}', schemaFrom) + 2))
ck('结构化 schema 里也保留 category（字段不删）',
  /category:\s*\{\s*type:\s*'string'/.test(derivationSchemaSrc),
  (derivationSchemaSrc.match(/category:\s*\{[^}]*\}/) || ['无'])[0])
ck('推导落库时 category 无条件写空（模型填了也不算数）',
  /category:\s*''/.test(hostSrc), (hostSrc.match(/category:\s*[^,\n]*/) || ['无'])[0])
ck('host 把标签截断到 3 个（模型多给也不落库）', /slice\(0, 3\)/.test(hostSrc))
/* 注释里提到 `modal.fieldCategory`（解释「为什么没有这个字段」）不算 —— 先剥注释再断言 */
/* 看**组件段**而不是整份产物：词表里保留一个用不到的键是死重量（已一并删掉），
   但真正要钉的是「EditModal 里没有分类输入框」 */
const editModalSrc = stripComments(client.slice(client.indexOf('function EditModal'), client.indexOf('function GenerateModal')))
ck('client 的编辑表单里没有分类输入（分类字段已从表单移除）',
  editModalSrc.length > 200 && !/fieldCategory/.test(editModalSrc) && !/form\.category/.test(editModalSrc))

/* --- 删除课程（破坏性、仅用户、必须二次确认） --- */
ck('client 调用了 host 的删除方法 courses.remove', /aicRpc\('courses\.remove'/.test(client))
ck('删除前必须先确认（确认弹窗组件存在且被渲染）',
  /function ConfirmModal/.test(client) && /h\(ConfirmModal,/.test(client))
ck('删除入口挂在课程卡片上（卡片调用 props.onDelete）',
  /props\.onDelete\(c\)/.test(client) && /onDelete: requestDelete/.test(client))
ck('删除成功后刷新列表并退出已被删掉的课程', /reloadLib\(\)/.test(client) && /setCourseId\(null\)/.test(client))
ck('删除按钮有可访问名（aria-label 走词表）', /'aria-label': t\('library\.cardDelete'\)/.test(client))

/* --- 内容生成（T-11）：host 提供方法，client 真的在调，两边名字必须逐字一致 --- */
const GENERATION_RPCS = ['generation.start', 'generation.status', 'contentAssets.get', 'progress.mark']
ck('host 注册了内容生成/读取/进度四个方法',
  GENERATION_RPCS.every((n) => new RegExp("name:\\s*'" + n.replace('.', '\\.') + "'").test(hostSrc)),
  GENERATION_RPCS.filter((n) => !new RegExp("name:\\s*'" + n.replace('.', '\\.') + "'").test(hostSrc)).join(' '))
ck('client 调用的生成方法名与 host 完全一致',
  /aicRpc\('generation\.start'/.test(client) && /aicRpc\('generation\.status'/.test(client) &&
  /aicRpc\('contentAssets\.get'/.test(client) && /aicRpc\('progress\.mark'/.test(client))
ck('媒体路由前缀与 client 的媒体 URL 前缀一致',
  (() => {
    const hostPrefix = (hostSrc.match(/MEDIA_PREFIX = '([^']+)'/) || [])[1]
    const clientPrefix = (client.match(/AIC_MEDIA_PREFIX = '([^']+)'/) || [])[1]
    return !!hostPrefix && hostPrefix === clientPrefix
  })(),
  ((hostSrc.match(/MEDIA_PREFIX = '([^']+)'/) || [])[1] || '?') + ' / ' + ((client.match(/AIC_MEDIA_PREFIX = '([^']+)'/) || [])[1] || '?'))
/* ⚠️ 注册用的路径必须去掉结尾斜杠 —— 宿主按 `${prefix}/` 匹配，自带斜杠就永远 404（真机踩过） */
ck('媒体路由注册路径无结尾斜杠（否则请求永远落到 fallback 404）',
  /MEDIA_ROUTE_PATH = MEDIA_PREFIX\.replace\(\/\\\/\+\$\/, ''\)/.test(hostSrc) &&
  /path: MEDIA_ROUTE_PATH/.test(hostSrc),
  (hostSrc.match(/path: MEDIA_ROUTE_PATH/) || ['未使用 MEDIA_ROUTE_PATH'])[0])
ck('待定类型不再被「不开放生成」挡住（已改为 Markdown 降级）',
  !/unsupported-type/.test(client) && /FALLBACK_TYPES/.test(hostSrc))
ck('生成任务落盘的 tasks.json 在课程目录内（随课程一起删）',
  /TASKS_FILE = 'tasks.json'/.test(hostSrc))
ck('学习页不再用「渲染器在 M2」占位（内容区已接真实渲染）',
  !/lesson\.rendererM2/.test(client) && /function ContentView/.test(client))
ck('渲染路径不用 dangerouslySetInnerHTML（正文是不可信输入）',
  !/dangerouslySetInnerHTML/.test(stripComments(client)))

/* --- 两条 prompt 的**文档同步**：`doc/11-prompts.md` 由脚本生成，必须是代码的当下快照 --- */
const promptDoc = await readFile(join(root, 'doc/11-prompts.md'), 'utf8')
const promptRules = (label, ...needles) => {
  const missing = needles.filter((n) => promptDoc.indexOf(n) < 0)
  ck(`${label}的规则在 doc/11-prompts.md 里都有（文档没过期）`, missing.length === 0, missing.join(' | '))
}
promptRules('课程大纲', '知识点不能游离在章节之外', 'order 在**本章内**从 1 连续',
  '固定输出空字符串', 'tags 只给 **2..3 个**', '章节数量与知识点粒度要匹配诉求',
  /* 知识点类型默认 图文（2026-10-18 用户需求）：这条口径必须同时存在于文档快照里 */
  '默认一律 图文', 'v1 还没有生成与展示设计，**不要用**')
promptRules('图文内容', 'Markdown 子集', '不要写 H1（一级标题）', '400~900 字',
  '图表优先级', 'Mermaid 代码块', '另外可以再给一张**示意图**')
promptRules('幻灯片内容', 'Slidev 方言 Markdown', '分页', '讲稿（演讲者备注）', '4~8 页', '**Mermaid 除外**')
promptRules('待定类型内容', '尚未定稿', '请按上面的 Markdown 规则', '「格式待定」降级展示')
promptRules('内容生成的大纲区块（防越界）', '课程大纲（`← 本次` 是**唯一**要写的知识点',
  '← 本次所在章节', '2.3 RSC 的核心承诺   ← 本次', '范围由课程大纲界定', '不许越界')
ck('prompt 文档里三类正文方言都各有一份', ['### 2.1 `图文`', '### 2.2 `幻灯片`', '### 2.3 `代码（待定类型）`'].every((h) => promptDoc.indexOf(h) >= 0))

/* --- 生成状态的**唯一轮询点** + 发起后关窗（这一轮的用户流程） --- */
ck('轮询只有一处：`generation.status` 的调用点唯一',
  (stripComments(client).match(/aicRpc\('generation\.status'/g) || []).length === 1,
  String((stripComments(client).match(/aicRpc\('generation\.status'/g) || []).length))
ck('轮询在面板层（`useGenerationStatus`），不是生成弹窗里',
  /function useGenerationStatus/.test(stripComments(client)) &&
  !/function GenerateModal[\s\S]{0,2000}?generation\.status/.test(stripComments(client)))
ck('生成弹窗成功后关闭（onStarted 里 setModal(null)）',
  /onStarted: \(\) => \{ setModal\(null\)/.test(stripComments(client)))
ck('发起失败时弹窗留在原地给原因（catch 里 setError）',
  /function GenerateModal[\s\S]{0,2500}?catch\(\(err\) => \{[\s\S]{0,200}?setError\(/.test(stripComments(client)))
/* 生成进度**只在主会话的常驻状态条**上展示（06 §3.6）：大纲页不再有第二份。 */
ck('大纲页不再有生成进度控件（没有 GenerationProgress / aic-job 区块）',
  !/function GenerationProgress/.test(stripComments(client)) &&
  !/props\.task \? h\(GenerationProgress/.test(stripComments(client)) &&
  !/task: ed\.task/.test(stripComments(client)))
ck('主会话的常驻状态条仍在（唯一的进度展示处）',
  /function AicAgentDock/.test(stripComments(client)) &&
  /taskProgressView\(task, null\)/.test(stripComments(client)))
ck('进度控件不再有「收起」行（也不再有 ProgressBar）',
  !/outline\.progressHide/.test(stripComments(client)) &&
  !/h\(ProgressBar, \{ t: t, ratio: v\.ratio \}\)/.test(client))
ck('任务结束时会重取课程数据（状态点翻成「已生成」）',
  /settledRef\.current === true && !active/.test(stripComments(client)))
ck('任务结束时也通知调用方（正在看的学习页会重取正文）',
  /useGenerationStatus\(props\.courseId, \(\) => \{ refresh\(\); changed\(\) \}\)/.test(stripComments(client)))

/* --- 课程库卡片：排序判据、删除按钮只留图标、学习按钮按「有没有内容」灰显 --- */
/* duration 在**三个层面**都要允许缺省：推导形状 / 领域校验 / RPC 入参 schema。
   少修一层，大纲生成就会在 create 那一步被 schema 挡掉（本次实测踩过）。 */
ck('RPC 入参 schema 里 duration 不是必填（否则大纲生成在 create 就被挡）',
  /duration: \{ type: 'number', integer: true, min: 1, max: 600 \}/.test(hostSrc) &&
  !/duration: \{ type: 'number', required: true/.test(hostSrc))

ck('host 的 courses.list 回传 updatedAt 与 hasContent（排序与灰显的判据都在宿主侧算好）',
  /updatedAt: r\.updatedAt \?\? 0/.test(hostSrc) && /hasContent: contentCount > 0/.test(hostSrc))
ck('host 的更新时间取 course.json / progress.json 的较晚者',
  /Math\.max\(courseAt, progressAt\)/.test(hostSrc))
ck('删除按钮是纯图标（没有可见文字标签）',
  /'aria-label': t\('library\.cardDelete'\)/.test(client) &&
  !/h\('span', null, t\('library\.cardDelete'\)\)/.test(client))
ck('删除按钮灰显（用了 muted 类）', /aic-btn--muted aic-card__delete/.test(client))
/* ⚠️ 必须是 `hasContent === false` 才灰显：老宿主不回这个字段时 `!undefined === true` 会**整库全灰**
   （真机踩过）。所以这里连「判据写法」一起钉住。 */
ck('学习按钮只在「明确没有内容」时灰显（hasContent === false）',
  /disabled: broken \|\| deriving \|\| c\.hasContent === false/.test(client) &&
  /* 反向写法（`!c.hasContent`）会让「老宿主不回该字段」变成**整库全灰**，必须没有 */
  !/\|\|\s*!c\.hasContent/.test(client))
ck('学习按钮的灰显原因同样按「明确 false」判断',
  /c\.hasContent === false \? t\('library\.cardLearnNoContent'\)/.test(client))
ck('host 另外回了 kpGenerated（已生成内容的知识点数，与 hasContent 同源）',
  /kpGenerated: contentCount/.test(hostSrc))
ck('学习按钮灰显时给出原因（title 走词表）', /library\.cardLearnNoContent/.test(client))
ck('课程库列表按更新时间降序（排序发生在筛选/分组之前）',
  /const rows = core\.sortCoursesByUpdated\(props\.courses \|\| \[\]\)/.test(client))

/* --- 主会话常驻 agent 状态条（知识点生成不产生回合，所以要挂在输入框上方的槽里） --- */
ck('host 注册了「所有课程当前任务」的只读方法 generation.active',
  /name:\s*'generation\.active'/.test(hostSrc))
ck('client 轮询 generation.active 并渲染状态条',
  /aicRpc\('generation\.active'/.test(stripComments(client)) && /function AicAgentDock/.test(stripComments(client)))
ck('状态条注册在 conversation.input.dock（常驻、与回合无关），list 槽用 id',
  /name:\s*'conversation\.input\.dock',\s*id:\s*'dsh-ai-courses\/agent-dock'/.test(client) &&
  /slots\.inject\(\s*'conversation\.input\.dock'/.test(client))
ck('状态条空闲时把轮询间隔拉长（不无限快轮询）',
  /AIC_DOCK_BUSY_MS = 1500/.test(client) && /AIC_DOCK_IDLE_MS = 20000/.test(client) &&
  /list\.length \? AIC_DOCK_BUSY_MS : AIC_DOCK_IDLE_MS/.test(client))
ck('状态条点「查看大纲」走统一的「导航 + 切面板」入口',
  /aicOpenCourseIn\(props\.ctx, row\.courseId, 'outline'\)/.test(client) &&
  /function aicOpenCourseIn/.test(client))

/* 主会话实时状态（`/ai-course` 命令卡片）：host 必须有客户端轮询的那个只读方法 */
ck('host 注册了状态查询方法 status.get', /name:\s*'status\.get'/.test(hostSrc), (hostSrc.match(/name:\s*'status\.[a-z]+'/) || ['无'])[0])
ck('host 的状态查询按会话键查（sessionId 必填）',
  /name:\s*'status\.get'[\s\S]{0,400}?sessionId:\s*\{\s*type:\s*'string',\s*required:\s*true/.test(hostSrc))
ck('client 调用的状态方法名与 host 一致',
  /aicRpc\('status\.get'/.test(client) && /name:\s*'status\.get'/.test(hostSrc))
/* 卡片按**命令名**派发：槽的 key 必须等于注册的命令名（写错就永远不渲染） */
const cardKey = client.match(/name:\s*'conversation\.chat\.commandview',\s*key:\s*'([^']+)'/)?.[1]
const commandName = hostSrc.match(/name:\s*'(ai-course)'/)?.[1]
ck('命令卡片的槽 key 等于命令名（宿主按 entryKey 派发）', !!cardKey && cardKey === commandName, `${cardKey} / ${commandName}`)
ck('client 用 slots.inject 等槽声明（直接 register 会在未声明时抛）',
  /slots\.inject\(\s*'conversation\.chat\.commandview'/.test(client))
ck('状态卡用纯函数决定是否继续轮询（命令结束即停，不空转 10 分钟）',
  /shouldPollStatus\(/.test(clientCode) && /function shouldPollStatus/.test(clientCode))
ck('useGenerationStatus 失败会退避重试（不是一次失败永久停表）',
  /retryDelays/.test(clientCode) && /setTimeout\(tick, wait\)/.test(clientCode))
/* ⚠️ 「不许在渲染里拼 aic- 类名」由 `client 里没有半截的 aic- 类名` 那条断言机械覆盖，
   这里**不**再写正则：`className: 'aic-genstate ' + GEN_CLASS[...]` 这类「静态基名 + 查表后缀」
   是本项目既有且安全的写法，用正则只会误伤（试过，误报了两处合法代码）。 */

/* 主会话的大纲卡片（`conversation.chat.turnTail`）：list 槽用 id，且同样要等声明 */
ck('大纲卡注册在 conversation.chat.turnTail（list 槽，用 id）',
  /name:\s*'conversation\.chat\.turnTail',\s*id:\s*'dsh-ai-courses\/outline-card'/.test(client))
ck('大纲卡也走 slots.inject 等槽声明', /slots\.inject\(\s*'conversation\.chat\.turnTail'/.test(client))
/* 编辑能力**一份实现**：面板与卡片都通过 CourseEditor 拿数据与提交，不许各写一套 outline.revise */
const reviseCallers = (client.match(/aicRpc\('outline\.revise'/g) || []).length
ck('outline.revise 只有一个调用点（共享编辑器，避免两条真相）', reviseCallers === 1, String(reviseCallers))
ck('面板与大纲卡都复用 CourseEditor',
  /return h\(CourseEditor,/.test(client) && /h\(CourseEditor, \{ courseId: latest\.courseId/.test(client))
/* 卡片必须在任何 hook 之前决定「这一回合要不要渲染」（Hook 顺序），否则真机 React 崩 */
const cardStart = client.indexOf('function AicOutlineCard')
const cardGate = client.indexOf('aicCoursesOfTurn(props.courses, turn)', cardStart)
const cardHook = client.indexOf('React.use', cardStart)
ck('大纲卡的早退判据在任何 hook 之前', cardStart > 0 && cardGate > cardStart && cardHook > cardGate,
  `gate@${cardGate} hook@${cardHook}`)

/* 命令卡片的文案在 manifest locale 里必须齐（两处都会被人改，容易漂移） */
const zhLocale = JSON.parse(await readFile(join(pkgDir, 'locale/zh-CN.json'), 'utf8'))
const enLocale = JSON.parse(await readFile(join(pkgDir, 'locale/en.json'), 'utf8'))
const CMD_KEYS = ['cmd.title', 'cmd.deriving', 'cmd.done', 'cmd.failed', 'cmd.stalled', 'cmd.stalledHint',
  'cmd.elapsed', 'cmd.elapsedMin', 'cmd.ofCourse', 'cmd.open',
  'cmd.step.start', 'cmd.step.derived', 'cmd.step.saving', 'cmd.step.done']
ck('manifest 两套 locale 的 cmd.* 键一致',
  Object.keys(zhLocale).filter((k) => k.startsWith('cmd.')).sort().join('|') ===
  Object.keys(enLocale).filter((k) => k.startsWith('cmd.')).sort().join('|'))
ck('命令卡片用到的每个 cmd.* 键：manifest 两套 locale 都有，且 client 代码里在用它',
  CMD_KEYS.every((k) => zhLocale[k] && enLocale[k] && new RegExp("'" + k.replace(/\./g, '\\.') + "'").test(client)),
  CMD_KEYS.filter((k) => !zhLocale[k] || !enLocale[k]).join(' '))

ck('package.json 有 main 指向 index.mjs', pkg.main === './index.mjs', String(pkg.main))
ck('client 返回的插件对象声明了 inject: [\'slots\']',
  /inject:\s*\[\s*'slots'\s*\]/.test(client), (client.match(/inject:\s*\[[^\]]*\]/) || ['无'])[0])
ck('client 用 ctx.get(\'slots\') 并优雅降级（不直接 ctx.slots）',
  /ctx\.get\(\s*'slots'\s*\)/.test(client) && /if \(!slots\)/.test(client))
ck('sidebar.panellist 的 label 是函数（先例如此，字符串会导致激活失败）',
  /label:\s*\(\)\s*=>/.test(client), (client.match(/label:[^,}]*/) || ['无'])[0])
ck('清理走 ctx.effect，不从 apply 返回 disposer',
  /ctx\.effect\(/.test(client) && !/^\s*return \(\) => disposers/m.test(client))
ck('client 返回的插件对象带 name',
  /name:\s*'dsh-ai-courses'/.test(client))
/* client 只允许从模块表取 React 与 react-dom（后者只为 createPortal，见 60-modals.js）。
   其余一律不许 require —— 少一个依赖就少一个「宿主没这个模块」的炸点。 */
const requires = (clientCode.match(/require\([^)]*\)/g) || []).map((s) => s.replace(/require\(\s*['"]|['"]\s*\)/g, ''))
ck('client 只 require react 与 react-dom（后者只为 createPortal）',
  requires.length === 2 && requires.indexOf('react') >= 0 && requires.indexOf('react-dom') >= 0,
  requires.join(' '))
ck('portal 只在弹窗外壳里用（不许别处直接碰 react-dom）',
  (clientCode.match(/ReactDOM\.createPortal\(overlay, host\)/g) || []).length === 1 && /function ModalShell/.test(clientCode))
ck('弹窗有焦点管理（打开聚焦 + Tab 陷阱 + 关闭归还焦点）',
  /previouslyFocused/.test(clientCode) && /ev\.key === 'Tab'/.test(clientCode) && /onCloseRef\.current/.test(clientCode))

/* ---------------------------------------------------------------------------
 * client 样式与静态安全（对应 doc/09 §3 的静态检查）
 *
 * ⚠️ 这几条是「界面裸奔但测试全绿」的直接防线：控件类名写错、样式整块误删、
 *    少数颜色抄成字面值，语法检查与冒烟**都看不出**。
 * ------------------------------------------------------------------------- */

/* 构建期把 src/client/styles.css 内联成 client.js 里的一个常量（见 doc/03 §6） */
const styles = await readFile(join(pkgDir, 'lib/styles.css'), 'utf8')
const cssLine = client.match(/^const AIC_COURSES_CSS = (".*")$/m)
ck('client 内联了样式常量 AIC_COURSES_CSS', !!cssLine)
if (cssLine) {
  let inlined = null
  try { inlined = JSON.parse(cssLine[1]) } catch { /* 下面断言会失败并给出原因 */ }
  ck('内联样式与 lib/styles.css 逐字一致', inlined === styles,
    inlined === null ? 'JSON 解析失败' : `${inlined.length} B vs ${styles.length} B`)
}

/* 类名覆盖率：**先剥注释**（注释里提到类名不该算使用），再剥掉内联样式那一行
   （否则所有类名都能在 CSS 里找到自己），然后统计代码里出现的完整类名。 */
const clientNoCss = clientCode.replace(/^const AIC_COURSES_CSS = .*$/m, '')
/* 「渲染路径不许 innerHTML」约束的是**本插件**的代码；highlight.js 内部自己会写 `.innerHTML`。
   `clientCode` 已经是「裁掉第三方 + 剥注释」的版本，这里给它一个语义名字，读代码时更清楚。 */
const clientOwn = clientCode
/* **按段**取代码：`clientOwn` 里 banner 注释已被剥掉，所以要在**未剥**的 `clientOwnRaw` 上按 banner 切段。
   ⚠️ 必须用「**行首** banner」这条口径：`styles.css` 被构建期内联成一个字符串常量，
   里面的注释也提到了 `src/client/55-status-card.js` —— 用普通 indexOf/宽松正则会把 CSS 里那次命中
   当成段头，切出一段只有 78 字节的空壳（踩过）。 */
const SEGMENT_BANNER = /^\/\* =+ (src\/client\/[\w.-]+) =+ \*\//gm
const SEGMENTS = (() => {
  const map = new Map()
  const hits = []
  let m
  SEGMENT_BANNER.lastIndex = 0
  while ((m = SEGMENT_BANNER.exec(clientOwnRaw)) !== null) hits.push({ file: m[1].split('/').pop(), at: m.index })
  hits.forEach((h, i) => {
    const end = i + 1 < hits.length ? hits[i + 1].at : clientOwnRaw.length
    map.set(h.file, clientOwnRaw.slice(h.at, end))
  })
  return map
})()
const segmentOf = (file) => SEGMENTS.get(file) || ''

/* --- 大纲里的「生成中」用加载图标 --- */
ck('「生成中」的图标是转动圆弧（不再是橙色实心圆）',
  /key: '生成中', mod: 'doing', glyph: 'spin'/.test(clientOwn) &&
  /kind === 'spin'/.test(clientOwn) && /aic-genstate__spin/.test(styles))
ck('生成中的加载图标尊重 reduced-motion', /prefers-reduced-motion[\s\S]{0,120}aic-genstate__spin/.test(styles))

/* --- 生成进度：加载图标（不用进度条） --- */
ck('生成进度控件里不再出现进度条（学习进度条仍在课程卡片上）',
  !/h\(ProgressBar, \{ t: t, ratio: v\.ratio \}\)/.test(clientOwn) &&
  /function Spinner/.test(clientOwn) && /aic-spinner/.test(styles))
ck('加载图标尊重 reduced-motion', /prefers-reduced-motion[\s\S]{0,120}aic-spinner/.test(styles))

/* --- 「保留原有内容」：追加而不是覆盖 --- */
ck('生成弹窗在已有内容时给「保留 / 覆盖」单选（默认保留）',
  /modal\.keepLabel/.test(clientOwn) && /if \\(props\.hasAsset\\)/.test(clientOwn) === false && /props\.hasAsset\s*\n?\s*\?/.test(clientOwn))
ck('RPC 接受 keepExisting，并落进任务表', /keepExisting: \{ type: 'boolean' \}/.test(hostSrc) && /keepExisting: !!keepExisting/.test(hostSrc))
ck('追加模式在生成侧实现（拼接正文 + 媒体累加）',
  /已有内容会被保留/.test(hostSrc) && /nextMediaRelPath\(kpId, oldPaths\.concat/.test(hostSrc))

/* --- 「AI 备注」：上限一处定义、两端共用；超长先拦 --- */
ck('备注上限由 host 常量统一定义', /export const PROMPT_MAX = \d+/.test(hostSrc))
ck('构建期把同一数值注入 client（两端不会漂移）',
  /const AIC_PROMPT_MAX = \d+/.test(clientOwn) && /maxLength: AIC_PROMPT_MAX/.test(clientOwn))
ck('备注超长时前端先拦（不发请求）', /prompt\.length > AIC_PROMPT_MAX/.test(clientOwn))
ck('校验报错用字段名（不再出现 `$.prompt`）', /spec\.label \|\| path/.test(hostSrc))

/* --- 没内容的知识点不记学习进度（前端 + 宿主两层） --- */
ck('学习页只在「有内容」时才标记进度',
  /const hadAsset = !!\(payload && payload\.hasAsset\)/.test(clientOwn) &&
  /if \(!mark \|\| !hadAsset\) return undefined/.test(clientOwn))
ck('宿主 progress.mark 对「没有内容」的知识点直接跳过（skipped: no-content）',
  /skipped: 'no-content'/.test(hostSrc) && /readAssetPayload\(store, i\.courseId, i\.kpId, kp\.contentType\)/.test(hostSrc))
ck('大纲行不展示没内容知识点的残留学习状态',
  /\(learnState === '学习完成' && props\.assets && props\.assets\[kp\.id\]\)/.test(clientOwn))

/* --- 生成弹窗的预检（没会话就别发那个必然失败的请求） --- */
ck('生成弹窗在缺会话 id 时先给提示、不发请求',
  /if \(!props\.agentId\)/.test(clientOwn) && /modal\.needSession/.test(clientOwn))
ck('openGenerate 兼容 (ch, kp) 与只给 kp 两种口径',
  /const target = \(kp && kp\.id\) \? kp/.test(clientOwn))

/* --- 上下文共享：大纲的「题面」随课程落库、并进知识点 prompt --- */
ck('课程存下建课时的原始诉求（request）', /request: String\(input\.request/.test(hostSrc))
ck('推导把 request 带进课程结构', /applyDerivation\(deps\.courses, text, \{ sources, request \}\)/.test(hostSrc))
ck('知识点 prompt 带上课程原始诉求', /课程原始诉求/.test(hostSrc))

/* --- 生成时的「会话解析」：换不到会话要**可读地拒绝**，而不是挂错会话 --- */
ck('宿主解析 agent 只做精确 id 查找（不再兜底到任意可用 agent，避免写进错误会话）',
  !/function anyAgent/.test(hostSrc) && /resolveAgent \(input\)/.test(hostSrc))
ck('解析结果必须「像 agent」（对象 + id 字符串 + 不是 Promise）',
  /const isAgent = \(a\) => !!a && typeof a === 'object' && typeof a\.id === 'string'/.test(hostSrc))
ck('错误码映射不再把 no-agent / read-only / already-running 压成 500',
  /'read-only': 403/.test(hostSrc) && /conflict: 409/.test(hostSrc) && /'no-agent': 400/.test(hostSrc))
ck('client 选会话：主视图优先，其次最近更新的（面板全屏时 mainView 为 0 是正常状态）',
  /lastActivityAt/.test(clientOwn) || /updatedAt/.test(clientOwn))

/* --- 引用资源（T-14）：从诉求/大纲带到内容生成 --- */
ck('host 有独立的引用资源模块（识别 / 限量 / 拼块）',
  /export function extractRefs/.test(hostSrc) && /export function formatSourcesBlock/.test(hostSrc) &&
  /MAX_SOURCES = 6/.test(hostSrc))
ck('课程里存 sources（不是只存在 prompt 里）',
  /sources: Array\.isArray\(input\.sources\)/.test(hostSrc) &&
  /async function setSources/.test(hostSrc) && /async function readSource/.test(hostSrc))
ck('推导时把诉求/附件里的引用收集起来落库',
  /mergeSources\(extractRefs\(request\), attachmentRefs\)/.test(hostSrc) &&
  /applyDerivation\(deps\.courses, text, \{ sources, request \}\)/.test(hostSrc))
ck('生成知识点时读取引用原文并注入 prompt（读不到不阻断）',
  /courses\.readSource\(ref\.ref, \{ allowExternal: ref\.allowExternal \}\)/.test(hostSrc) && /formatSourcesBlock\(sources\)/.test(hostSrc))
ck('引用资源只读文本、且单文件/总量都限量',
  /isTextRef\(raw\)/.test(hostSrc) && /MAX_SOURCE_CHARS/.test(hostSrc) && /MAX_TOTAL_SOURCE_CHARS/.test(hostSrc))

/* --- 学习时长：**没内容就不显示**（旧数据里可能残留大纲阶段的估值） --- */
ck('大纲行只在有内容信封时给时长',
  /\(props\.assets && props\.assets\[kp\.id\]\) \? kp\.duration : undefined/.test(clientOwn))
ck('生成弹窗同样按 hasAsset 判断（不显示残留估值）',
  /\(props\.hasAsset && kp\.duration\)/.test(clientOwn))
ck('学习页优先用 host 按正文算出的实际时长（payload.minutes）',
  /payload\.minutes\) \|\| kp\.duration/.test(clientOwn))
ck('host 在 contentAssets.get 里回传 minutes（按正文估算，不读大纲里的旧值）',
  /const minutes = payload\.hasAsset/.test(hostSrc) && /estimateMinutes\(payload\.body/.test(hostSrc))

/* --- 命令卡片的「打开课程」：标签与跳转目标 --- */
ck('卡片按钮文案是「打开课程」（不再是「打开课程库」）',
  /'cmd\.open': '打开课程'/.test(clientOwn) && !/'cmd\.open': '打开课程库'/.test(clientOwn))
/* 外壳头（00-shell-head）**没有** `/* == src/client/00-shell-head.js ==` 那种 banner，
   所以这里不能用 `segmentOf` 取段 —— 直接用整份自有代码比位置（两个字符串都唯一）。 */
ck('「打开课程」统一走外壳里的 aicOpenCourseIn（先导航、再切面板）',
  (() => {
    const open = clientOwn.indexOf('AIC_NAV.open(courseId')
    const panel = clientOwn.indexOf("selectPanel('ai-courses')")
    return open > 0 && panel > open &&
      /aicOpenCourseIn\(ctx, courseId, 'outline'\)/.test(clientOwn) &&
      /aicOpenCourseIn\(props\.ctx, latest\.courseId, 'outline'\)/.test(clientOwn) &&
      /aicOpenCourseIn\(props\.ctx, row\.courseId, 'outline'\)/.test(clientOwn)
  })())
ck('导航总线支持「面板未挂载时挂起、挂载后补发」',
  /AIC_NAV_PENDING/.test(clientOwn) && /if \(AIC_NAV_PENDING\)/.test(clientOwn))

/* --- 图片：坏 SVG 的**前端自救**（不依赖宿主版本） --- */
ck('图片由 Figure 承载（不再裸 <img>），失败时自己取文本修复',
  /function Figure/.test(clientOwn) && /repairSvgText\(text\)/.test(clientOwn) && /onError: onError/.test(clientOwn))
ck('自救后改成内联 SVG，并且清掉 script / 事件属性 / 外部引用',
  /importNode\(root, true\)/.test(clientOwn) &&
  /function hardenInlineSvg/.test(clientOwn) &&
  /hardenInlineSvg\(root\)/.test(clientOwn) &&
  /startsWith\('on'\)/.test(clientOwn) &&
  /querySelectorAll\('script,foreignObject,iframe,image,use,style'\)/.test(clientOwn))
ck('前端修复函数在 core 里（纯函数、可断言）', /function repairSvgText/.test(clientOwn))

/* --- 大纲里的「编辑 + 生成」合成一个入口（用户需求） --- */
/* 只查**大纲段**：学习页（70-lesson）仍保留一个「重新生成」图标，那是另一处入口，不能一起禁 */
{
  const outlineSrc = segmentOf('50-outline.js')
  ck('大纲里不再有独立的生成图标按钮（学习页的「重新生成」另算）',
    outlineSrc.length > 0 && !/name: 'generate'/.test(outlineSrc),
    outlineSrc ? String((outlineSrc.match(/name: '\w+'/g) || []).join(',')) : '未取到大纲段')
}
ck('编辑入口改用 compose 图标（铅笔 + 星芒）', /compose: \[/.test(clientOwn) && /name: 'compose'/.test(clientOwn))
ck('编辑弹窗底部有「生成」按钮（按 kind 给文案）',
  /onGenerate\(kind, target\)/.test(client) && /modal\.generateCourse/.test(client) &&
  /modal\.generateChapter/.test(client) && /modal\.generateKp/.test(client))
ck('章节/整门课生成走二次确认（会覆盖已有内容）',
  /confirmScope/.test(client) && /genScopeTitle/.test(client) && /ConfirmModal/.test(client))
ck('知识点生成从编辑弹窗进入生成弹窗（不连带保存表单）',
  /onGenerate: \(\) => setModal\(\{ kind: 'generate'/.test(client))

/* 生成 / 学习状态的 `--<mod>` 与导航卡的 `--prev` 是**语义标记类**（与 preview 同款）：
   样式由同一节点上的 `--<color>` 类（或默认样式）承担，styles.css 有意不为这些名字定义规则。
   除白名单以外不许有例外 —— 这条断言就是用来抓「控件类名写错但测试全绿」的。 */
const MARKER_CLASSES = [
  'aic-genstate--none', 'aic-genstate--queued', 'aic-genstate--doing', 'aic-genstate--done', 'aic-genstate--failed',
  'aic-learnstate--start', 'aic-learnstate--doing', 'aic-learnstate--done',
  'aic-navcard--prev',
  /* 围栏代码块的**语言标记类**：只标记语言，规则由 .aic-prose pre 统一承担 */
  'aic-code--lang',
]
const usedClasses = new Set(clientNoCss.match(/aic-[a-z0-9-]+/g) || [])
const dynamicClasses = [...usedClasses].filter((c) => c.endsWith('-') || c.endsWith('__'))
ck('client 里没有半截的 aic- 类名（禁止动态拼 class）', dynamicClasses.length === 0, dynamicClasses.join(' '))
const ruleClasses = new Set((styles.match(/\.aic-[a-z0-9-]+/g) || []).map((s) => s.slice(1)))
const missingRules = [...usedClasses].filter((c) => !ruleClasses.has(c) && MARKER_CLASSES.indexOf(c) < 0)
ck('client 用到的每个 aic- 类都有样式规则（语义标记类除外）', missingRules.length === 0,
  missingRules.length ? '缺规则：' + missingRules.join(' ') : `${usedClasses.size} 个类`)

/* 字面颜色零出现（artwork 除外，见 06 §7）；组件代码同样不许出现 */
for (const [name, text] of [['lib/styles.css', styles], ['lib/client.js 代码', clientNoCss]]) {
  const literals = [...new Set(text.match(/#[0-9a-fA-F]{3,8}\b|rgba?\(|hsla?\(/g) || [])]
  ck(`${name} 无字面颜色`, literals.length === 0, literals.join(' '))
}

/* 只用宿主 14 个主题 token（06 §7） */
/* 宿主的**布局变量**（不是配色 token）：宽度/字号这类尺寸由宿主提供，插件只读不写。
   单独一张白名单，避免把「配色只用 14 个 token」这条约束稀释掉。 */
const ALLOWED_LAYOUT_VARS = [
  '--dsh-chat-content-width',      /* 会话内容列宽度 */
  '--dsh-composer-card-max-width', /* 输入卡片的最大宽度（= 内容列 + 32px），状态条要跟它对齐 */
  '--dsh-content-font-size',       /* 正文基准字号 */
]
const ALLOWED_TOKENS = [
  '--dsw-alias-bg-base', '--dsw-alias-bg-layer-1', '--dsw-alias-bg-layer-2', '--dsw-alias-bg-overlay',
  '--dsw-alias-border-l1', '--dsw-alias-border-l2', '--dsw-alias-brand-primary',
  '--dsw-alias-label-primary', '--dsw-alias-label-secondary',
  '--dsw-alias-state-error-primary', '--dsw-alias-state-idle-primary',
  '--dsw-alias-state-success-primary', '--dsw-alias-state-warn-primary',
  '--dsw-specific-sidebar-fill',
]
const usedTokens = [...new Set((styles.match(/var\((--[a-z0-9-]+)\)/g) || []).map((s) => s.slice(4, -1)))]
const badTokens = usedTokens.filter((t) => ALLOWED_TOKENS.indexOf(t) < 0 && ALLOWED_LAYOUT_VARS.indexOf(t) < 0)
ck('样式只消费宿主的配色 token 与布局变量',
  badTokens.length === 0, badTokens.join(' ') || `${usedTokens.length} 个`)

/* --- 主会话状态条的宽度与输入框一致 --- */
ck('状态条按输入卡片的宽度对齐（用宿主布局变量，不自己猜）',
  /\.aic-dock \{[^}]*max-width: var\(--dsh-composer-card-max-width/.test(styles) &&
  /\.aic-dock \{[^}]*box-sizing: border-box/.test(styles) &&
  /\.aic-dock \{[^}]*width: 100%/.test(styles))


/* 学习页宽度与**滚动层级**（用户报过「滚动条右边还有空白」） */
{
  const rule = (sel) => (styles.match(new RegExp('\\.' + sel + ' \\{[^}]*\\}')) || [''])[0]
  const lessonRule = rule('aic-lesson')
  ck('学习页宽度跟随所在容器（.aic-lesson 用 width:100%，不再有 max-width 限宽）',
    /width:\s*100%/.test(lessonRule) && !/max-width/.test(lessonRule), lessonRule.replace(/\s+/g, ' ').slice(0, 80))
  ck('学习页用 min-height:100%（短内容也撑满一屏，导航卡落底）',
    /min-height:\s*100%/.test(lessonRule) && !/(^|[^-])height:\s*100%/.test(lessonRule), lessonRule.replace(/\s+/g, ' ').slice(0, 80))
  /* ⚠️ 关键：**只能有一层滚动**。内层再开 overflow:auto 会得到「内滚动条 + 外层 padding-right」，
     正是用户看到的右侧空白；外层也会跟着滚（双层滚动）。 */
  ck('学习页内容区**不再**自己滚动（滚动统一交给 .aic-main）',
    !/overflow/.test(rule('aic-lesson__body')), rule('aic-lesson__body').replace(/\s+/g, ' '))
  ck('.aic-main 是唯一滚动容器，且预留滚动条槽位（内容长短不抖动）',
    /overflow-y:\s*auto/.test(rule('aic-main')) && /scrollbar-gutter:\s*stable/.test(rule('aic-main')))
  ck('学习页内容列仍然撑满（.aic-lesson__content 不引入新的宽度限制）',
    /min-width:\s*0/.test(rule('aic-lesson__content')))
  ck('正文里的图片不会被拉爆（.aic-prose img 仍限宽 100%）',
    /max-width:\s*100%/.test((styles.match(/\.aic-prose img \{[^}]*\}/) || [''])[0]))
}

/* 渲染路径不得使用 innerHTML（AC-17：正文是不可信输入） */
ck('client 渲染路径无 innerHTML（只查本插件代码；内联的第三方不计）', !/innerHTML/.test(clientOwn))

/* --- 幻灯片：页 frontmatter 归位、版式结构、HTML 表格 --- */
ck('页 frontmatter 不会被切成空白页（pending 合并进下一页）',
  /let pending = \{\}/.test(clientCode) && /pending = merged/.test(clientCode))
ck('幻灯片标题单独成元素（版式靠 .aic-slide__title 排版）',
  /splitSlideTitle/.test(clientCode) && /aic-slide__title/.test(clientCode))
ck('两栏 / 左右图版式真的产出 .aic-slide__cols 结构',
  /aic-slide__cols/.test(clientCode) && /splitFigureCols/.test(clientCode) && /splitHalf/.test(clientCode))
ck('渲染器支持原始 HTML 表格（逐格取文本，不 innerHTML）',
  /parseHtmlTableRows/.test(clientOwn) && /htmlTableNode/.test(clientOwn) && !/innerHTML/.test(clientOwn))
ck('HTML 单元格里的 script/style 连内容一起丢弃',
  /<\(script\|style\)/.test(clientCode))
ck('行内 <br> 渲染成换行元素', /INLINE_RE = [^\n]*<br/.test(clientCode))
ck('幻灯片里的图与表格都不撑破版式（样式有对应规则）',
  /\.aic-slide \.aic-prose table/.test(styles) && /\.aic-slide > \.aic-prose img/.test(styles))

/* --- 代码高亮（按需加载 highlight.js；token 类名是字面量，禁用动态拼） --- */
ck('代码块走 CodeBlock（带高亮），不是裸 <code>',
  /function CodeBlock/.test(clientCode) && /h\(CodeBlock, \{ key: k\(\), lang: lang, source: source \}\)/.test(clientCode))
ck('highlight.js 的 token → 本插件字面类名（不做动态拼 class）',
  /const HLJS_TOKEN_CLASS = \{/.test(clientCode) && /aic-tok-keyword/.test(clientCode) &&
  /hljsTokenClass/.test(clientCode))
ck('高亮结果用 token 状态机转 React 节点（不碰 innerHTML）',
  /function hljsToNodes/.test(clientCode) && !/innerHTML/.test(clientCode))
ck('拿不到高亮器时退回纯文本（不白屏）',
  /* 注释在 clientCode 里已被剥掉，这句要看**未剥注释**的产物 */
  /加载失败：保持纯文本/.test(client) && /tokens \|\| source/.test(clientCode))
ck('highlight.js **内联**进 client.js（不依赖宿主路由 → 刷新前端即生效）',
  /Highlight\.js v11/.test(client) && /globalThis\.hljs = hljs/.test(client),
  `${(Buffer.byteLength(client) / 1024).toFixed(0)} KB`)
ck('vendor 里的 highlight.js 仍在（可单独取用，不影响内联）',
  existsSync(join(root, 'package/vendor/highlight.min.js')), 'yes')

/* --- frontmatter 不进正文（真机上 `--- title: … ---` 被当正文字面显示了） --- */
ck('client 渲染前剥 frontmatter（core.stripFrontmatter）',
  /stripFrontmatter: stripFrontmatter|stripFrontmatter,\s*$|function stripFrontmatter/.test(clientCode) &&
  /AIC_COURSES_CORE\.stripFrontmatter\(text\)/.test(clientCode))
ck('host 写文件时仍会加 frontmatter（文件脱离应用也自描述）',
  /export function withFrontmatter/.test(hostSrc) && /withFrontmatter\(title/.test(hostSrc))

/* --- Mermaid（正文里的 ```mermaid 围栏）：按需加载 + 三级降级 --- */
ck('client 从宿主 vendor 路由按需加载第三方脚本（不是 import 裸包 —— 客户端模块表里没有它）',
  /AIC_VENDOR_BASE = '\/dsh-ai-courses\/vendor\/'/.test(clientCode) &&
  /document\.createElement\('script'\)/.test(clientCode) &&
  /aicLoadVendor\('mermaid\.min\.js', 'mermaid'\)/.test(clientCode) &&
  /aicLoadVendor\('highlight\.min\.js', 'hljs'\)/.test(clientCode) &&
  !/from 'mermaid'|require\('mermaid'\)|from 'highlight/.test(clientCode))
ck('Mermaid 渲染器用 strict 安全级别（不可信输入）',
  /securityLevel: 'strict'/.test(clientCode) && /htmlLabels: false/.test(clientCode))
ck('图表渲染失败会降级成源码块（不白屏、内容仍可读）',
  /aic-mermaid--failed/.test(clientCode) && /lesson\.diagramFallback/.test(clientCode))
ck('```mermaid 围栏由 MermaidChart 接管，其余语言仍是普通代码块',
  /lang\.toLowerCase\(\) === 'mermaid'/.test(clientCode) && /h\(MermaidChart/.test(clientCode))
ck('host 有 vendor 路由，注册在 apply 里',
  /export function registerVendorRoute/.test(hostSrc) && /registerVendorRoute\(ctx\)/.test(hostSrc))
ck('媒体路由对历史坏 SVG **读取时自愈**（旧文件不必重新生成）',
  /sanitizeSvg\(text\)/.test(hostSrc) && /isWellFormedSvg\(text\)/.test(hostSrc) && /const healed = sanitizeSvg/.test(hostSrc))
ck('媒体路由对 well-formed 的恶意 SVG 也会拒绝/清洗（安全与形状分开看）',
  /dangerous/.test(hostSrc) && /SVG 含不安全构造，拒绝送出/.test(hostSrc))

ck('vendor 只送白名单文件（不做目录列举）',
  /const VENDOR_FILES = \{/.test(hostSrc) &&
  /'mermaid\.min\.js':/.test(hostSrc) && /'highlight\.min\.js':/.test(hostSrc))
ck('发布产物里有 vendor/mermaid.min.js（浏览器拿不到源码目录）',
  existsSync(join(root, 'package/vendor/mermaid.min.js')),
  existsSync(join(root, 'package/vendor/mermaid.min.js')) ? 'yes' : 'missing（跑 node scripts/vendor-mermaid.mjs）')

/* --- vendor 资源必须**真的能读出来**（2026-10-18 的教训） ---
   构建曾经把 `node:fs/promises` 的 import 吞掉 → `readFileAsync is not defined` →
   `/dsh-ai-courses/vendor/mermaid.min.js` 永远 404 → **所有 mermaid 图静默降级成源码块**
   （用户看到的就是「flowchart 渲染失败」）。而源码、语法检查、其它冒烟全部正常。
   这里 import 产物并真的读一遍，把这条路径钉在离线。 */
const vendorMod = await import(pathToFileURL(join(pkgDir, 'index.mjs')).href)
ck('产物导出 readVendorAsset（vendor 读取可被离线断言）', typeof vendorMod.readVendorAsset === 'function')
try {
  const asset = await vendorMod.readVendorAsset('mermaid.min.js')
  ck('产物能真的读出 vendor/mermaid.min.js', asset.text.length > 500 * 1024,
    `${(asset.text.length / 1024 / 1024).toFixed(2)} MB`)
  ck('vendor 的 content-type 是 JS', asset.type === 'text/javascript; charset=utf-8', asset.type)
  ck('mermaid 产物确实是 UMD/可执行脚本（不是错误页）', /function|=>/.test(asset.text.slice(0, 2000)) && !/^\s*</.test(asset.text))
} catch (err) {
  ck('产物能真的读出 vendor/mermaid.min.js', false, `${err.code || ''} ${err.message}`)
}
try {
  await vendorMod.readVendorAsset('../../package.json')
  ck('vendor 只送白名单文件（路径穿越/未知名被拒）', false)
} catch (err) {
  ck('vendor 只送白名单文件（路径穿越/未知名被拒）', err.code === 'not-found', err.message)
}

/* --- import 完整性：src/host 的**非相对** import 必须都出现在产物顶部 ---
   （构建已自带门禁；这里对**产物本身**再断一次，防「用旧 build 产物打包」） */
const srcHostDir = join(root, 'src/host')
const srcSpecs = new Set()
for (const f of await readdir(srcHostDir)) {
  if (!f.endsWith('.mjs')) continue
  const text = await readFile(join(srcHostDir, f), 'utf8')
  for (const m of text.matchAll(/from\s*'([^']+)'/g)) if (!m[1].startsWith('.')) srcSpecs.add(m[1])
}
const artifactSpecs = new Set([...hostSrc.matchAll(/^import\s+(?:[\s\S]*?\s+from\s+)?'([^']+)'/gm)].map((m) => m[1]))
const lostSpecs = [...srcSpecs].filter((x) => !artifactSpecs.has(x))
ck('产物包含 src/host 的全部非相对 import（构建不得吞 import）', lostSpecs.length === 0,
  lostSpecs.length ? '缺：' + lostSpecs.join(' ') : [...artifactSpecs].join(' '))
ck('产物里没有残留跨段相对 import', !/from\s*'\.\/[^']+'/.test(hostSrc))

/* 枚举必须与 host 常量一致（两边硬编码，漂移了界面会给出 host 会拒的取值） */
const enumOf = (text, name) => (text.match(new RegExp(`const ${name} = (\\[[^\\]]*\\])`)) || [])[1]
const squash = (s) => String(s || '').replace(/['"\s]/g, '')
for (const name of ['CONTENT_TYPES', 'DIFFICULTIES']) {
  const hostEnum = enumOf(hostSrc, name)
  const clientEnum = enumOf(clientNoCss, name)
  ck(`client 的 ${name} 与 host 常量一致`, !!hostEnum && !!clientEnum && squash(hostEnum) === squash(clientEnum),
    `host=${hostEnum} client=${clientEnum}`)
}


console.log(`\n${fail ? fail + ' 项失败' : '全部通过'}   （PASS ${pass} / FAIL ${fail}）`)
process.exit(fail ? 1 : 0)
