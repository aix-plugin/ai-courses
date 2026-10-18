#!/usr/bin/env node
/**
 * 课程库设置冒烟：验证配置界面的 host 侧行为。
 *
 * 直接调用**构建产物**里的 `buildContext`（它依赖拼接后才存在的跨段函数，
 * 不能从 `src/host/50-methods.mjs` 单独 import）。
 *
 * 覆盖：
 *   · courseRoot 初始来自 profile 配置，设置文件可覆盖；
 *   · 切换根目录立即生效，旧根课程不会跟过来、旧目录也不会被搬动；
 *   · 模拟重启后仍读设置文件；
 *   · 相对路径被拒；有生成任务在跑时拒绝切换。
 *
 * 运行前需要先 `node scripts/build.mjs`。
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { buildContext } from '../package/index.mjs'

let pass = 0
let fail = 0
const ck = (name, ok, ev) => {
  ok ? pass++ : fail++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ev ? '  → ' + ev : ''}`)
}

const rootA = await mkdtemp(join(tmpdir(), 'aic-settings-a-'))
const rootB = await mkdtemp(join(tmpdir(), 'aic-settings-b-'))
const profile = await mkdtemp(join(tmpdir(), 'aic-settings-profile-'))
const settingsFile = join(profile, 'ai-courses.settings.json')
const oldProfile = process.env.DSH_PROFILE_DIR
process.env.DSH_PROFILE_DIR = profile

const ctx = { get: () => null, logger: { info () {}, warn () {} } }

try {
  const c1 = buildContext(ctx, { courseRoot: rootA })
  const i1 = c1.configInfo()
  ck('初始 courseRoot 来自 profile 配置', i1.courseRoot === rootA, i1.courseRoot)
  ck('初始 source=config', i1.source === 'config', i1.source)
  ck('默认目录单独暴露给界面', i1.defaultRoot !== rootA, i1.defaultRoot)

  const idA = 'c-20261018120000-abcd'
  await c1.store.writeCourse(idA, { id: idA, name: '旧根课程', outline: { chapters: [] } })
  ck('旧根里有一门课', (await c1.store.listCourses()).some((r) => r.id === idA))
  const runnerA = c1.runners.for(idA)
  ck('切换前任务运行器按课程缓存', c1.runners.for(idA) === runnerA)

  const i2 = await c1.setCourseRoot(rootB)
  ck('切换后立即返回新根', i2.courseRoot === rootB, i2.courseRoot)
  ck('切换后 source=settings', i2.source === 'settings', i2.source)
  ck('store.root 立即切换', c1.store.root === rootB, c1.store.root)
  ck('新根为空（旧根课程不会跟过来）', (await c1.store.listCourses()).length === 0)
  ck('切根后任务运行器缓存被清空（旧任务状态不会写进新根）', c1.runners.for(idA) !== runnerA)
  ck('设置文件已落盘', existsSync(settingsFile), settingsFile)

  const c2 = buildContext(ctx, { courseRoot: rootA })
  const i3 = c2.configInfo()
  ck('模拟重启后仍用设置文件里的 rootB', i3.courseRoot === rootB && i3.source === 'settings', i3.courseRoot)
  ck('重启后 store 指向 rootB', c2.store.root === rootB, c2.store.root)

  let invalid = null
  try {
    await c1.setCourseRoot('relative/path')
  } catch (err) {
    invalid = err
  }
  ck('相对路径被拒（invalid-input）', !!invalid && invalid.code === 'invalid-input', invalid && invalid.code)

  c1.runners.listActive = () => [{ courseId: idA, task: { id: 't' } }]
  let conflict = null
  try {
    await c1.setCourseRoot(rootA)
  } catch (err) {
    conflict = err
  }
  ck('有生成任务在跑时拒绝切根（conflict）', !!conflict && conflict.code === 'conflict', conflict && conflict.code)

  c1.runners.listActive = () => []
  c1.status.start('session-test', { commandId: 'cmd', request: '用 3 章讲清 RSC' })
  let deriving = null
  try {
    await c1.setCourseRoot(rootA)
  } catch (err) {
    deriving = err
  }
  ck('有课程推导在跑时拒绝切根（conflict）', !!deriving && deriving.code === 'conflict', deriving && deriving.code)
} finally {
  if (oldProfile === undefined) delete process.env.DSH_PROFILE_DIR
  else process.env.DSH_PROFILE_DIR = oldProfile
  await rm(rootA, { recursive: true, force: true })
  await rm(rootB, { recursive: true, force: true })
  await rm(profile, { recursive: true, force: true })
}

console.log(`\n${fail ? fail + ' 项失败' : '全部通过'}   （PASS ${pass} / FAIL ${fail}）`)
process.exit(fail ? 1 : 0)
