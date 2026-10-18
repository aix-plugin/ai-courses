import { readFile as readFileAsync } from 'node:fs/promises'
import { sanitizeSvg, isWellFormedSvg } from './30-generate.mjs'

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
