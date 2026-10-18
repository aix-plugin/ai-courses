/* ==================== src/client/30-rpc.js ====================
 * client ↔ host 的唯一数据通道（ADR-0001）：精确 HTTP 路由 + 方法表校验。
 *
 * 形状约定（见 src/host/40-rpc.mjs）：
 *   POST <前缀><方法名>  body = JSON 对象
 *   → 200 { ok: true, data }  |  4xx/5xx { ok: false, error: { code, message, detail? } }
 *
 * 前缀必须与 host 的 `RPC_PREFIX` 完全一致（scripts/check.mjs 会比对两端产物）。
 * ========================================================================== */

const AIC_RPC_PREFIX = '/dsh-ai-courses/rpc/'
/** RPC 默认超时：宿主的读写/生成发起都是毫秒级；20s 足够兜住极端慢盘，又不让 UI 永远转圈。 */
const AIC_RPC_TIMEOUT_MS = 20000

/**
 * 调一个 host 方法。失败一律抛出带 `code` 的 Error —— 界面按 code 决定文案。
 *
 * `opts.signal` 支持取消（组件卸载/弹窗关闭时 abort）；`opts.timeoutMs` 缺省 20s。
 * 超时给 `code:'timeout'`，外部取消给 `code:'aborted'`，其余网络错误给 `code:'network'`。
 */
async function aicRpc (name, input, opts = {}) {
  const signal = opts && opts.signal
  const timeoutMs = (opts && typeof opts.timeoutMs === 'number') ? opts.timeoutMs : AIC_RPC_TIMEOUT_MS
  const ctrl = typeof AbortController === 'function' ? new AbortController() : null
  let timer = null
  const onExternalAbort = () => { if (ctrl && !ctrl.signal.aborted) ctrl.abort() }
  if (ctrl && signal) {
    if (signal.aborted) ctrl.abort()
    else signal.addEventListener('abort', onExternalAbort, { once: true })
  }
  if (ctrl) timer = setTimeout(() => ctrl.abort(), timeoutMs)
  let res
  try {
    res = await fetch(AIC_RPC_PREFIX + name, {
      method: 'POST',
      /* 自定义头：挡住跨源简单请求（浏览器会预检，服务端不返回 CORS 头）。
         与 host 的 RPC_HEADER 常量必须一致（check.mjs 会比对）。 */
      headers: { 'content-type': 'application/json', 'x-dsh-ai-courses': '1' },
      body: JSON.stringify(input || {}),
      signal: ctrl ? ctrl.signal : (signal || undefined),
    })
  } catch (err) {
    const aborted = ctrl && ctrl.signal.aborted
    /* 只用 `code` 区分，界面按 code 走词表；这里的英文 message 是技术值，不直接给用户看。 */
    const e = new Error(aborted
      ? (signal && signal.aborted ? 'request aborted' : 'request timeout')
      : String((err && err.message) || err))
    e.code = aborted ? (signal && signal.aborted ? 'aborted' : 'timeout') : 'network'
    throw e
  } finally {
    if (timer) clearTimeout(timer)
    if (ctrl && signal) signal.removeEventListener('abort', onExternalAbort)
  }
  let body = null
  try { body = await res.json() } catch (err) { body = null }
  if (body && body.ok === true) return body.data
  const info = (body && body.error) || {}
  const e = new Error(info.message || ('HTTP ' + res.status))
  e.code = info.code || 'http-' + res.status
  e.detail = info.detail
  throw e
}

/**
 * 取数 hook：`status` ∈ loading | ready | error；`reload()` 重新取。
 * 加载中保留上一份数据（避免整页闪回骨架）；**失败时清空 data** —— 依赖（如 courseId）
 * 已经变了，留着上一份数据会让界面把旧课程当新课程显示。
 */
function useResource (loader, deps) {
  const [state, setState] = React.useState({ status: 'loading', data: null, error: null })
  const [nonce, setNonce] = React.useState(0)
  const key = JSON.stringify([nonce].concat(deps || []))
  React.useEffect(() => {
    let alive = true
    setState((prev) => ({ status: 'loading', data: prev.data, error: null }))
    Promise.resolve()
      .then(() => loader())
      .then(
        (data) => { if (alive) setState({ status: 'ready', data: data, error: null }) },
        (error) => { if (alive) setState({ status: 'error', data: null, error: error }) },
      )
    return () => { alive = false }
    /* eslint-disable-next-line */
  }, [key])
  return [state, () => setNonce((n) => n + 1)]
}

const AIC_MEDIA_PREFIX = '/dsh-ai-courses/media/'

/** 课程目录内的相对路径 → 媒体 URL（host 的 GET 路由）。越界路径一律回空（不产出坏 URL）。 */
function aicMediaUrl (courseId, baseDir, rawPath) {
  const rel = String(rawPath || '').split('?')[0].split('#')[0].trim()
  if (!rel || rel.indexOf('://') >= 0 || rel.startsWith('/') || rel.startsWith('\\')) return ''
  /* 归一化；`..` **不许越过基准目录**（越界直接回空 —— 服务端也会拒，这里先挡一道，
     免得界面上出现一个看着像资源、实际 404 的 URL） */
  const baseLen = String(baseDir || '').split('/').filter((x) => x && x !== '.').length
  const merged = []
  for (const seg of (String(baseDir || '').split('/').concat(rel.split('/')))) {
    if (!seg || seg === '.') continue
    if (seg === '..') {
      if (merged.length <= baseLen) return ''
      merged.pop()
      continue
    }
    merged.push(seg)
  }
  if (!merged.length) return ''
  return AIC_MEDIA_PREFIX + encodeURIComponent(courseId) + '/' + merged.map(encodeURIComponent).join('/')
}
