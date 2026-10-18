/* ============================================================================
 * dsh-ai-courses — host 半边
 * 由 scripts/build.mjs 按文件名顺序拼接 src/host/*.mjs 生成 package/index.mjs
 * 零构建、零运行时依赖；只依赖宿主服务。
 * ========================================================================== */

import { CONTENT_TYPES } from './05-constants.mjs'
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
