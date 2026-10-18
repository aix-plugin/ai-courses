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
