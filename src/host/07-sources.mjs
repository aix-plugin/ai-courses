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
