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

