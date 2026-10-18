#!/usr/bin/env node
/** T-6 冒烟：方法表 + 输入校验 + 精确路由 + 结构化错误。 */
import { createMethodTable, invoke, validate, parseBody, RpcError, RPC_PREFIX, registerRoutes, MAX_RPC_BODY_BYTES } from '../src/host/40-rpc.mjs'

let pass = 0, fail = 0
const ck = (n, ok, ev) => { ok ? pass++ : fail++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${ev ? '  → ' + ev : ''}`) }
const S = (b) => JSON.stringify(b)

/* --- 校验器 --- */
ck('必填缺失被拒', validate({ type: 'string', required: true }, undefined).ok === false)
ck('类型不符被拒', validate({ type: 'string' }, 42).error.code === 'invalid-input')
ck('超长被拒', validate({ type: 'string', maxLength: 3 }, 'abcd').ok === false)
ck('枚举外被拒且回 allowed', (() => { const r = validate({ type: 'string', enum: ['a','b'] }, 'c'); return !r.ok && r.error.detail.allowed.length === 2 })())
ck('数字范围被拒', validate({ type: 'number', min: 1, max: 2 }, 5).ok === false && validate({ type: 'number', min: 1, max: 2 }, 2).ok === true)
ck('整数校验', validate({ type: 'number', integer: true }, 1.5).ok === false)
ck('数组元素逐个校验（错误路径带下标）',
  validate({ type: 'array', items: { type: 'string' } }, ['a', 7]).error.message.includes('[1]'),
  validate({ type: 'array', items: { type: 'string' } }, ['a', 7]).error.message)
ck('未知键被丢弃（不报错也不进 handler）',
  S(validate({ type: 'object', fields: { a: { type: 'string' } } }, { a: 'x', evil: 1 }).value) === '{"a":"x"}')
ck('嵌套字段路径可定位',
  validate({ type: 'object', fields: { kp: { type: 'object', fields: { id: { type: 'string', required: true } } } } }, { kp: {} }).error.message.includes('$.kp.id'))

/* --- 请求体 --- */
ck('空体视为 {}', parseBody('').ok && S(parseBody('').value) === '{}')
ck('非法 JSON 回 invalid-json', parseBody('{oops').error.code === 'invalid-json')
ck('数组体被拒', parseBody('[1,2]').error.code === 'invalid-body')

/* --- 方法表 --- */
const ctx = { logger: { error: () => {} } }
const table = createMethodTable([
  { name: 'courses.read', input: { type: 'object', fields: { courseId: { type: 'string', required: true, maxLength: 32 } } },
    handle: async (c, i) => ({ id: i.courseId, name: '示例课程' }) },
  { name: 'ping', input: { type: 'object', fields: {} }, handle: async () => 'pong' },
  { name: 'boom.rpc', input: { type: 'object', fields: {} }, handle: async () => { throw new RpcError('not-found', '课程不存在') } },
  { name: 'boom.raw', input: { type: 'object', fields: {} }, handle: async () => { throw new Error('内部细节不该外泄') } },
])
ck('重复方法名在注册时抛错', (() => { try { createMethodTable([{ name: 'x', handle () {} }, { name: 'x', handle () {} }]); return false } catch { return true } })())
ck('缺 handle 在注册时抛错', (() => { try { createMethodTable([{ name: 'y' }]); return false } catch { return true } })())

/* --- 调用：成功 / 未知方法 / 非法输入 / 业务错误 / 未预期错误 --- */
const ok = await invoke(table, 'courses.read', { courseId: 'c-1' }, ctx)
ck('正常调用 → 200 + ok:true + data', ok.status === 200 && ok.body.ok && ok.body.data.name === '示例课程')
const unknown = await invoke(table, 'nope', {}, ctx)
ck('未知方法 → 404 + unknown-method', unknown.status === 404 && unknown.body.error.code === 'unknown-method', S(unknown.body.error.code))
const bad = await invoke(table, 'courses.read', {}, ctx)
ck('缺必填 → 400 + invalid-input', bad.status === 400 && bad.body.error.code === 'invalid-input', bad.body.error.message)
const badJson = await invoke(table, 'courses.read', '{oops', ctx)
ck('非法 JSON → 400 + invalid-json', badJson.status === 400 && badJson.body.error.code === 'invalid-json')
const notFound = await invoke(table, 'boom.rpc', {}, ctx)
ck('handler 抛 RpcError(not-found) → 404 + 该 code', notFound.status === 404 && notFound.body.error.code === 'not-found')
const raw = await invoke(table, 'boom.raw', {}, ctx)
ck('未预期异常 → 500 + 笼统 internal（**不透传消息**）',
  raw.status === 500 && raw.body.error.code === 'internal' && !/内部细节/.test(S(raw.body)),
  S(raw.body.error))
const extra = await invoke(table, 'ping', { junk: 'x' }, ctx)
ck('多余字段被丢弃，调用仍成功', extra.status === 200 && extra.body.data === 'pong')

/* 没包 wrap 的方法抛领域错误，也要按 code 给状态（否则 media.check 坏课程会变 500） */
const domainTable = createMethodTable([
  { name: 'domain.nf', input: { type: 'object', fields: {} }, handle: async () => { throw new CourseError('not-found', '课程不存在') } },
  { name: 'domain.invalid', input: { type: 'object', fields: {} }, handle: async () => { throw new CourseError('invalid-outline', '大纲不合法') } },
  { name: 'domain.readonly', input: { type: 'object', fields: {} }, handle: async () => { throw new CourseError('read-only', '只读') } },
])
const dnf = await invoke(domainTable, 'domain.nf', {}, ctx)
ck('未包 wrap 的 CourseError(not-found) → 404', dnf.status === 404 && dnf.body.error.code === 'not-found', S(dnf.body))
const dinv = await invoke(domainTable, 'domain.invalid', {}, ctx)
ck('未包 wrap 的 CourseError(invalid-outline) → 400', dinv.status === 400 && dinv.body.error.code === 'invalid-outline', S(dinv.body))
const dro = await invoke(domainTable, 'domain.readonly', {}, ctx)
ck('未包 wrap 的 CourseError(read-only) → 403', dro.status === 403 && dro.body.error.code === 'read-only', S(dro.body))

/* --- 精确路由 --- */
const reg = []
registerRoutes({ webServer: { register (r) { reg.push(r); return () => {} } }, logger: ctx.logger }, table)
ck('每个方法注册一条路由', reg.length === table.size, `${reg.length} / ${table.size}`)
ck('全部是 kind=exact', reg.every((r) => r.kind === 'exact'))
ck('路径是前缀 + 方法名（无通配）',
  reg.every((r) => r.path.startsWith(RPC_PREFIX) && !/[*:{]/.test(r.path)),
  reg.map((r) => r.path).join(' '))
ck('路由路径两两不同（E-4 重复会抛错）', new Set(reg.map((r) => r.path)).size === reg.length)

/* --- 路由的跨源防线与 body 上限 --- */
{
  const route = reg.find((r) => r.path === RPC_PREFIX + 'ping')
  const callRoute = (headers, body) => new Promise((resolve) => {
    route.handler(
      { headers, body },
      { writeHead (status, h) { this.status = status; this.headers = h }, end (text) { resolve({ status: this.status, text: String(text) }) } },
    )
  })
  const noHeader = await callRoute({}, '{}')
  ck('缺少自定义头 → 403（跨源表单/fetch 带不上这个头）',
    noHeader.status === 403 && /forbidden/.test(noHeader.text), noHeader.text)
  const goodHeader = await callRoute({ 'x-dsh-ai-courses': '1' }, '{}')
  ck('带自定义头 → 200', goodHeader.status === 200 && /"data":"pong"/.test(goodHeader.text), goodHeader.text)
  const sameSite = await callRoute({ 'sec-fetch-site': 'same-origin' }, '{}')
  ck('同源请求（旧 client 升级窗口）→ 200', sameSite.status === 200 && /"data":"pong"/.test(sameSite.text), sameSite.text)
  const crossSite = await callRoute({ 'sec-fetch-site': 'cross-site' }, '{}')
  ck('跨源请求即使没有自定义头 → 403', crossSite.status === 403 && /forbidden/.test(crossSite.text), crossSite.text)
  const huge = await callRoute({ 'x-dsh-ai-courses': '1' }, 'x'.repeat(MAX_RPC_BODY_BYTES + 1))
  ck('请求体超过上限 → 413（不把内存吃满）',
    huge.status === 413 && /body-too-large/.test(huge.text), huge.text)
}

/* --- 媒体 GET 路由：学习页的图片靠它取回（内容生成落盘后要能在界面上看到） --- */
import { toRpcCode, CourseError } from '../src/host/30-courses.mjs'
import { registerMediaRoute, registerVendorRoute, mediaContentType, MEDIA_PREFIX, MEDIA_ROUTE_PATH, VENDOR_PREFIX, VENDOR_ROUTE_PATH } from '../src/host/40-rpc.mjs'
/* --- 校验文案：用**字段名**而不是 JSON 路径（用户看不懂 `$.prompt 超过最大长度 2000`） --- */
{
  const spec = { type: 'object', fields: { prompt: { type: 'string', maxLength: 5, label: 'AI 备注' } } }
  const tooLong = validate(spec, { prompt: 'x'.repeat(9) })
  ck('超长报错用字段名（不再出现 `$.prompt`）',
    tooLong.ok === false && /AI 备注/.test(tooLong.error.message) && !/\$\./.test(tooLong.error.message),
    tooLong.ok ? '' : tooLong.error.message)
  ck('报错里带上「当前多少字」（用户知道要删多少）', /当前 9/.test(tooLong.error.message))
  const okv = validate(spec, { prompt: 'abc' })
  ck('未超长照常通过', okv.ok === true && okv.value.prompt === 'abc')
  /* 顶层字段的 path 就是 `$`，只有嵌套字段才带 `.xxx`；没配 label 时退回 path */
  const noLabel = validate({ type: 'object', fields: { name: { type: 'string', maxLength: 3 } } }, { name: 'abcd' })
  ck('没配 label 时退回路径（向后兼容）', noLabel.ok === false && /\$\.name/.test(noLabel.error.message), noLabel.ok ? '' : noLabel.error.message)
}

/* --- 错误码 → HTTP 状态（"拿不到会话"不能变成 500「服务器内部错误」） --- */
{
  ck('not-found → 404', toRpcCode(new CourseError('not-found', 'x')) === 'not-found')
  ck('no-agent → invalid-input（可读、可行动，不是 500）',
    toRpcCode(new CourseError('no-agent', 'x')) === 'invalid-input')
  ck('no-targets → invalid-input', toRpcCode(new CourseError('no-targets', 'x')) === 'invalid-input')
  ck('read-only → forbidden', toRpcCode(new CourseError('read-only', 'x')) === 'forbidden')
  ck('already-running → conflict', toRpcCode(new CourseError('already-running', 'x')) === 'conflict')
  ck('未知异常仍是 internal', toRpcCode(new Error('boom')) === 'internal')
}

/* --- vendor 路由（浏览器按需加载的静态资源，目前是 Mermaid） --- */
{
  const routes = []
  registerVendorRoute({ webServer: { register (r) { routes.push(r); return () => {} } }, logger: { warn () {} } })
  ck('vendor 路由也是 prefix，注册路径无结尾斜杠（与媒体同一条口径）',
    routes.length === 1 && routes[0].kind === 'prefix' && routes[0].path === VENDOR_ROUTE_PATH &&
    VENDOR_ROUTE_PATH === '/dsh-ai-courses/vendor' && VENDOR_PREFIX === VENDOR_ROUTE_PATH + '/',
    routes[0] && routes[0].path)
  const send = (name) => new Promise((resolve) => {
    routes[0].handler(
      { url: VENDOR_PREFIX + name },
      { writeHead (status, headers) { this.status = status; this.headers = headers }, end (body) { resolve({ status: this.status, headers: this.headers, body: String(body) }) } },
    )
  })
  const good = await send('mermaid.min.js')
  ck('存在的 vendor 文件 → 200 且 content-type 是 JS',
    good.status === 200 && /javascript/.test(good.headers['content-type'] || '') && good.body.length > 1000,
    `${good.status} / ${(good.body.length / 1024).toFixed(0)} KB`)
  const bad = await send('secret.txt')
  ck('未知文件名 → 404（白名单，不列举目录）', bad.status === 404 && /not-found/.test(bad.body), bad.body.slice(0, 50))
  const trav = await send('../index.mjs')
  ck('带 ../ 的请求 → 404（不在白名单，走不到文件读取）', trav.status === 404 && !/export /.test(trav.body))
}

ck('媒体 content-type 按扩展名判定', mediaContentType('a/b/x.svg') === 'image/svg+xml; charset=utf-8' && mediaContentType('x.mp4') === 'video/mp4')
ck('未知扩展名 → octet-stream（不猜）', mediaContentType('x.bin') === 'application/octet-stream')
{
  const reads = []
  const fakeStore = {
    readRelBytes: async (courseId, rel) => { reads.push(courseId + '/' + rel); return '<svg viewBox="0 0 1 1"/>' },
  }
  const routes = []
  registerMediaRoute({ webServer: { register (r) { routes.push(r); return () => {} } } }, { store: fakeStore })
  ck('媒体路由是 prefix 路由且路径带插件前缀', routes.length === 1 && routes[0].kind === 'prefix' && routes[0].path === MEDIA_ROUTE_PATH, routes[0] && routes[0].path)
  /* ⚠️ 真机上吃过一次的坑：注册路径**不能带结尾斜杠**。宿主匹配是
     `pathname.startsWith(`${prefix}/`)`，自带 `/` 就拼成 `//`，永远匹配不上 → 图片全 404。
     这条断言把它钉死（含 URL 前缀仍带斜杠，给客户端用）。 */
  ck('注册路径无结尾斜杠（否则宿主的 prefix+"/" 拼接永远匹配不上）',
    MEDIA_ROUTE_PATH === '/dsh-ai-courses/media' && MEDIA_PREFIX === MEDIA_ROUTE_PATH + '/',
    `${routes[0] && routes[0].path} / ${MEDIA_PREFIX}`)
  ck('按宿主口径能匹配到媒体路由（pathname 以 `路径 + /` 开头）',
    (() => {
      const prefix = routes[0].path
      const p1 = MEDIA_PREFIX + 'c-1/a/b.svg'
      const p2 = '/dsh-ai-courses/media'
      const hit = (pathname) => pathname === prefix || pathname.startsWith(prefix + '/')
      return hit(p1) && hit(p2) && !hit('/dsh-ai-courses/mediax/a')
    })())
  const send = (url) => new Promise((resolve) => {
    const req = { url: url }
    const res = { writeHead (status, headers) { this.status = status; this.headers = headers }, end (body) { resolve({ status: this.status, headers: this.headers, body: String(body) }) } }
    routes[0].handler(req, res)
  })
  /* **读取时自愈**：历史坏文件（丢 `/`、重复属性）也要能显示 */
  {
    const brokenStore = {
      readRelBytes: async () => '<svg viewBox="0 0 640 360" xmlns="http://www.w3.org/2000/svg"><defs><marker id="a"><path d="M0,0 L10,5 Z"></marker></defs><rect x="1" y="2" width="3" height="4"></svg>',
    }
    const rs = []
    registerMediaRoute({ webServer: { register (r) { rs.push(r); return () => {} } }, logger: { warn () {} } }, { store: brokenStore })
    const got = await new Promise((resolve) => {
      rs[0].handler(
        { url: MEDIA_PREFIX + 'c-20260101000000-aaaa/content-assets/media/kp-01-01-01.svg' },
        { writeHead (status, headers) { this.status = status; this.headers = headers }, end (b) { resolve({ status: this.status, body: String(b) }) } },
      )
    })
    ck('历史坏 SVG 在送出前被即时修复（丢的 `/` 补回、标签闭合）',
      got.status === 200 && /<path[^>]*\/>/.test(got.body) && /<rect[^>]*\/>/.test(got.body) && /<\/svg>/.test(got.body),
      got.body.slice(0, 80))
  }
  /* well-formed 但含脚本/事件属性的 SVG 不能原样送出（客户端 Figure 兜底会内联它） */
  {
    const unsafeStore = {
      readRelBytes: async () => '<svg viewBox="0 0 640 360" xmlns="http://www.w3.org/2000/svg" onload="alert(1)"><script>alert(1)</script><rect x="1" y="2" width="3" height="4"/></svg>',
    }
    const rs = []
    registerMediaRoute({ webServer: { register (r) { rs.push(r); return () => {} } }, logger: { warn () {} } }, { store: unsafeStore })
    const got = await new Promise((resolve) => {
      rs[0].handler(
        { url: MEDIA_PREFIX + 'c-20260101000000-aaaa/content-assets/media/kp-01-01-01.svg' },
        { writeHead (status, headers) { this.status = status; this.headers = headers }, end (b) { resolve({ status: this.status, body: String(b) }) } },
      )
    })
    ck('well-formed 的恶意 SVG 被拒/清洗（不把 script/onload 原样送出）',
      (got.status === 404 || !/<script|onload\s*=/i.test(got.body)), `${got.status} ${got.body.slice(0, 60)}`)
  }
  /* 安全的复杂 SVG（渐变等）不因为"没在白名单"就被破坏 */
  {
    const svg = '<svg viewBox="0 0 10 10" xmlns="http://www.w3.org/2000/svg"><defs><linearGradient id="g"><stop offset="0" stop-color="#000"/></linearGradient></defs><rect width="10" height="10" fill="url(#g)"/></svg>'
    const rs = []
    registerMediaRoute({ webServer: { register (r) { rs.push(r); return () => {} } }, logger: { warn () {} } }, { store: { readRelBytes: async () => svg } })
    const got = await new Promise((resolve) => {
      rs[0].handler(
        { url: MEDIA_PREFIX + 'c-20260101000000-aaaa/content-assets/media/kp-01-01-01.svg' },
        { writeHead (status, headers) { this.status = status; this.headers = headers }, end (b) { resolve({ status: this.status, body: String(b) }) } },
      )
    })
    ck('安全的复杂 SVG 原样送出（渐变不被清洗掉）', got.status === 200 && /linearGradient/.test(got.body), got.body.slice(0, 60))
  }

  const ok = await send(MEDIA_PREFIX + 'c-20260101000000-aaaa/content-assets/media/kp-01-01-01.svg')
  ck('媒体路由按 courseId + 相对路径取文件并回 200', ok.status === 200 && /svg/.test(ok.body) && reads[0] === 'c-20260101000000-aaaa/content-assets/media/kp-01-01-01.svg', reads[0])
  ck('媒体路由回图片 content-type 与长度', /image\/svg/.test(ok.headers['content-type']) && ok.headers['content-length'] === String(ok.body.length))
  const bad = await send(MEDIA_PREFIX + 'c-20260101000000-aaaa/../../etc/passwd')
  ck('媒体路由拒越界路径（404，且**没有**真的去读）', bad.status === 404 && reads.length === 1)
  const empty = await send(MEDIA_PREFIX)
  ck('媒体路由缺课程/路径 → 404（不崩）', empty.status === 404)
}

/* --- 真实方法表：`status.get` 必须真的存在、走校验、并且路由落位 --- */
import { createMethodTableFor } from '../src/host/50-methods.mjs'
import { createStatusStore } from '../src/host/15-status.mjs'
const live = createStatusStore()
live.start('sess-1', { commandId: 'cmd-1', request: '用 3 章讲 RSC' })
const realTable = createMethodTableFor({ courses: {}, status: live })
ck('真实方法表里有 status.get（客户端轮询的就是它）', realTable.has('status.get'))
ck('真实方法表里原有方法没被改掉',
  ['courses.list', 'courses.read', 'courses.create', 'outline.revise', 'courses.remove'].every((n) => realTable.has(n)),
  [...realTable.keys()].join(' '))
const noSession = await invoke(realTable, 'status.get', {}, ctx)
ck('status.get 缺 sessionId → 400（不靠前端自觉）', noSession.status === 400 && noSession.body.error.code === 'invalid-input')
const gotStatus = await invoke(realTable, 'status.get', { sessionId: 'sess-1' }, ctx)
ck('status.get 命中 → 200 且带回该会话的阶段',
  gotStatus.status === 200 && gotStatus.body.data.phase === 'running' && gotStatus.body.data.commandId === 'cmd-1',
  S(gotStatus.body.data))
const missStatus = await invoke(realTable, 'status.get', { sessionId: 'nope' }, ctx)
ck('没有该会话时回 ok:true + data:null（前端据此走占位）',
  missStatus.status === 200 && missStatus.body.ok === true && missStatus.body.data === null)
const noStore = await invoke(createMethodTableFor({ courses: {} }), 'status.get', { sessionId: 'sess-1' }, ctx)
ck('状态表缺失时回 null 而不是 500（可选观测面）', noStore.status === 200 && noStore.body.data === null)
const reg2 = []
registerRoutes({ webServer: { register (r) { reg2.push(r); return () => {} } }, logger: ctx.logger }, realTable)
ck('status.get 注册了精确路由 /dsh-ai-courses/rpc/status.get',
  reg2.some((r) => r.kind === 'exact' && r.path === RPC_PREFIX + 'status.get'),
  reg2.map((r) => r.path).slice(0, 3).join(' ') + ' …')
console.log(`\n${fail ? fail + ' 项失败' : '全部通过'}   （PASS ${pass} / FAIL ${fail}）`)
process.exit(fail ? 1 : 0)
