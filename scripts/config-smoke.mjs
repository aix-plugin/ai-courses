#!/usr/bin/env node
/** Config 契约冒烟：cordis 的 resolveConfig 直接读 Config["~standard"].validate。 */
import { Config, CONFIG_DEFAULTS, normalizeConfig } from '../src/host/00-head.mjs'
let pass = 0, fail = 0
const ck = (n, ok, ev) => { ok ? pass++ : fail++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${ev ? '  → ' + ev : ''}`) }
const S = Config['~standard']
ck('Config 提供 ~standard（cordis 读的就是它）', !!S)
ck('~standard.version = 1', S.version === 1)
ck('validate 存在且是函数', typeof S.validate === 'function')
const empty = S.validate(undefined)
ck('空配置 → { value: 默认值 }（不是 issues）', empty.value && empty.value.courseRoot === CONFIG_DEFAULTS.courseRoot, JSON.stringify(empty.value))
ck('返回同步对象（cordis 显式拒绝 Promise）', typeof empty.then !== 'function')
ck('合法配置被接受', S.validate({ courseRoot: '/tmp/x', maxParallelGenerations: 3 }).value.maxParallelGenerations === 3)
ck('非法 courseRoot → { issues }', Array.isArray(S.validate({ courseRoot: '' }).issues))
ck('非法 maxParallelGenerations → { issues }', Array.isArray(S.validate({ maxParallelGenerations: 0 }).issues))
ck('非法 defaultContentType → { issues }', Array.isArray(S.validate({ defaultContentType: '播客' }).issues))
ck('issues 带 message 与 path', (() => { const i = S.validate({ courseRoot: 1 }).issues[0]; return !!i.message && Array.isArray(i.path) })())
ck('非对象配置 → { issues }', Array.isArray(S.validate('x').issues))
ck('normalizeConfig 直接可用（apply 会再兜一次底）', normalizeConfig({}).courseRoot === CONFIG_DEFAULTS.courseRoot)
console.log(`\n${fail ? fail + ' 项失败' : '全部通过'}   （PASS ${pass} / FAIL ${fail}）`)
process.exit(fail ? 1 : 0)
