#!/usr/bin/env node
/**
 * 发版自动化 —— 把「以后每次发版的固定动作」收成一条命令。
 *
 * 默认（本地发版，不联网）：
 *   预检 → 改版本 → vendor 门禁 → build → check → 全部离线冒烟
 *        → npm pack → git commit + tag
 *
 * 加 --publish（公开上架）：
 *   构建与自检通过后，先停下做一次「真机验证确认」→ git commit + tag
 *   → git push → npm publish
 *
 * 刻意**不**自动化的事：
 *   · 重启 DSH、点界面 —— --publish 会停在这里等你确认（脚本不能替你判断界面对不对）
 *   · doc/10-release-checklist.md 的版本行 —— doc/ 被 .gitignore 忽略，改了也不会进提交
 *   · 市场条目 —— 收录后的版本由 npm 自动发现，不需要每次改 yml
 *
 * 用法：
 *   node scripts/release.mjs patch
 *   node scripts/release.mjs minor --publish
 *   node scripts/release.mjs 0.2.0-rc.1 --publish --yes
 *   node scripts/release.mjs current --publish   # 首次发布当前版本
 *   node scripts/release.mjs patch --dry-run
 *   node scripts/release.mjs --publish-only     # 本地已发版，验证后单独发布
 *
 * 选项：
 *   --publish-only 不再改版本/构建，直接发布当前 HEAD 上已打 tag 的版本
 *   --publish      本地发版后 push + npm publish
 *   --no-push      与 --publish 同用时，只发 npm 不推送
 *   --yes          跳过「真机验证」确认（CI / 无人值守）
 *   --no-smoke     跳过 10 个离线冒烟（只跑 check；不推荐用于正式发版）
 *   --no-commit    只改版本 + 构建 + 打包，不 commit、不打 tag
 *   --allow-dirty  允许已跟踪文件有未提交改动（仅调试；默认拒绝）
 *   --dry-run      只做预检并打印计划，不改任何文件
 *   --help
 */
import { readFile, writeFile, mkdir, rm } from 'node:fs/promises'
import { existsSync, readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import readline from 'node:readline/promises'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const MANIFEST = join(root, 'src/manifest/package.json')
const PKG_DIR = join(root, 'package')
const DIST_DIR = join(root, 'dist')
const TAG_PREFIX = 'v'

/* 离线冒烟：全部不依赖宿主、不联网。check.mjs 是硬门禁，这些是它的补充。 */
const SMOKES = [
  'smoke.mjs',
  'client-smoke.mjs',
  'config-smoke.mjs',
  'fsport-smoke.mjs',
  'courses-smoke.mjs',
  'derive-smoke.mjs',
  'generate-smoke.mjs',
  'rpc-smoke.mjs',
  'status-smoke.mjs',
  'tools-smoke.mjs',
]

/* ------------------------------------------------------------------ 工具 */

/* 先于参数解析定义：参数校验会 throw ReleaseError，class 在 TDZ 里会变成
   "Cannot access 'ReleaseError' before initialization"（这个仓库踩过同类坑）。 */
class ReleaseError extends Error {
  constructor (message, detail) {
    super(message)
    this.name = 'ReleaseError'
    this.detail = detail
  }
}

const fail = (message, detail) => { throw new ReleaseError(message, detail) }
const log = (message) => console.log(`[release] ${message}`)
const warn = (message) => console.warn(`[release] ⚠️  ${message}`)

/* ------------------------------------------------------------------ 参数 */

const HELP = `发版自动化（scripts/release.mjs）

用法：
  node scripts/release.mjs <patch|minor|major|x.y.z> [选项]
  node scripts/release.mjs current --publish     # 首次发布：直接发当前版本，不再加一位
  node scripts/release.mjs --publish-only [选项]

  预发布版本直接写完整版本号，例如 0.2.0-rc.1；patch/minor/major 只做稳定版递增。

选项：
  --publish-only 不再改版本/构建，直接发布当前 HEAD 上已打 tag 的版本
  --publish      本地发版后 git push + npm publish
  --no-push      与 --publish 同用时，只发 npm 不推送
  --yes          跳过「真机验证」确认（无人值守）
  --no-smoke     跳过离线冒烟（只跑 check）
  --no-commit    只改版本 + 构建 + 打包
  --allow-dirty  允许已跟踪文件有未提交改动（仅调试）
  --dry-run      只预检并打印计划
  --help
`

const opts = {
  yes: false,
  publish: false,
  publishOnly: false,
  noPush: false,
  noSmoke: false,
  noCommit: false,
  allowDirty: false,
  dryRun: false,
  help: false,
}

const positional = []

/** 参数解析放进 main() 里调用：解析期的 ReleaseError 也要走统一的错误出口，
    否则会变成一坨未捕获栈（这个仓库对 TDZ / 顶层抛错的坑有前科）。 */
function parseArgs () {
  for (const arg of process.argv.slice(2)) {
    if (arg === '--yes' || arg === '-y') opts.yes = true
    else if (arg === '--publish') opts.publish = true
    else if (arg === '--publish-only') { opts.publishOnly = true; opts.publish = true }
    else if (arg === '--no-push') opts.noPush = true
    else if (arg === '--no-smoke') opts.noSmoke = true
    else if (arg === '--no-commit') opts.noCommit = true
    else if (arg === '--allow-dirty') opts.allowDirty = true
    else if (arg === '--dry-run') opts.dryRun = true
    else if (arg === '--help' || arg === '-h') opts.help = true
    else if (arg.startsWith('-')) throw new ReleaseError(`未知参数：${arg}`, '看 node scripts/release.mjs --help')
    else positional.push(arg)
  }

  if (opts.help) {
    console.log(HELP)
    process.exit(0)
  }
  if (opts.publishOnly) {
    if (positional.length) throw new ReleaseError('--publish-only 不接受版本参数', '它发布的是当前 HEAD 上已打 tag 的版本')
    if (opts.noCommit) throw new ReleaseError('--publish-only 与 --no-commit 不能同时使用')
  } else if (positional.length !== 1) {
    console.error(HELP)
    throw new ReleaseError('需要且只需要一个版本参数', '例如：node scripts/release.mjs patch；或只发布已发版版本：--publish-only')
  }
  if (opts.publish && opts.noCommit) {
    throw new ReleaseError('--publish 与 --no-commit 不能同时使用', '公开发布必须留下 commit 与 tag，否则源码与 npm 包对不上')
  }
  if (opts.noPush && !opts.publish) {
    throw new ReleaseError('--no-push 只和 --publish 一起用')
  }
}

/* ------------------------------------------------------------------ 工具 */

function run (cmd, args, options = {}) {
  return execFileSync(cmd, args, {
    cwd: options.cwd ?? root,
    encoding: options.encoding ?? 'utf8',
    stdio: options.stdio ?? ['ignore', 'pipe', 'pipe'],
    env: options.env ?? process.env,
  })
}

function gitOut (args) {
  return run('git', args).trim()
}

function gitRun (args) {
  execFileSync('git', args, { cwd: root, stdio: 'inherit' })
}

/* npm 走独立 cache：既避开 ~/.npm 的权限问题，也不污染用户默认缓存。
   登录态仍从 ~/.npmrc 读，和 cache 无关。 */
const NPM_CACHE = process.env.npm_config_cache || join(tmpdir(), 'dsh-ai-courses-npm-cache')
const npmEnv = () => ({ ...process.env, npm_config_cache: NPM_CACHE })

function npmOut (args) {
  return run('npm', args, { cwd: PKG_DIR, env: npmEnv() }).trim()
}

function npmRun (args) {
  execFileSync('npm', args, { cwd: PKG_DIR, stdio: 'inherit', env: npmEnv() })
}

/* ------------------------------------------------------------------ 版本 */

const SEMVER_RE = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/

function parseVersion (value) {
  const m = SEMVER_RE.exec(String(value).trim())
  if (!m) return null
  return {
    core: [Number(m[1]), Number(m[2]), Number(m[3])],
    pre: m[4] ? m[4].split('.') : [],
  }
}

/** semver 预发布比较：无预发布 > 有预发布；数字段按数字比，数字 < 字母，字母按字典序。 */
function comparePre (a, b) {
  if (!a.length && !b.length) return 0
  if (!a.length) return 1
  if (!b.length) return -1
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if (a[i] === undefined) return -1
    if (b[i] === undefined) return 1
    const an = /^\d+$/.test(a[i])
    const bn = /^\d+$/.test(b[i])
    if (an && bn) {
      if (Number(a[i]) !== Number(b[i])) return Number(a[i]) < Number(b[i]) ? -1 : 1
    } else if (an) return -1
    else if (bn) return 1
    else if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1
  }
  return 0
}

function compareVersion (a, b) {
  const pa = parseVersion(a)
  const pb = parseVersion(b)
  if (!pa || !pb) return 0
  for (let i = 0; i < 3; i++) {
    if (pa.core[i] !== pb.core[i]) return pa.core[i] < pb.core[i] ? -1 : 1
  }
  return comparePre(pa.pre, pb.pre)
}

function resolveVersion (current, kind) {
  if (kind === 'current') return current
  if (parseVersion(kind)) return kind
  if (!['patch', 'minor', 'major'].includes(kind)) {
    fail(`无法识别的版本参数：${kind}`, '用 patch / minor / major，或完整版本号（如 0.2.0）')
  }
  const p = parseVersion(current)
  if (!p) fail(`当前版本不是合法 semver：${current}`)
  const [x, y, z] = p.core
  if (kind === 'patch') return `${x}.${y}.${z + 1}`
  if (kind === 'minor') return `${x}.${y + 1}.0`
  return `${x + 1}.0.0`
}

/* ------------------------------------------------------------------ 步骤 */

function gate (script, label) {
  try {
    const out = run(process.execPath, [join(root, 'scripts', script)])
    const summary = out.split('\n').find((line) => /PASS\s+\d+\s*\/\s*FAIL\s+\d+|全部通过/.test(line))
    log(`✓ ${label}${summary ? ' — ' + summary.trim() : ''}`)
  } catch (err) {
    /* 失败时只回放 FAIL 行和末尾摘要，不把几百行 PASS 再刷一遍 */
    const stdout = String(err.stdout || '')
    const fails = stdout.split('\n').filter((line) => /^FAIL|项失败/.test(line))
    if (fails.length) console.error(fails.join('\n'))
    else if (stdout) console.error(stdout.trim().split('\n').slice(-40).join('\n'))
    if (err.stderr) process.stderr.write(err.stderr)
    fail(`${label} 未通过`, `失败命令：node scripts/${script}`)
  }
}

async function confirmBeforePublish (version) {
  if (opts.yes) return
  if (!process.stdin.isTTY) {
    fail('需要人工确认，但当前不是交互终端',
      `已在本地构建 v${version}，但还没提交。确认已在 DSH 里验证过后加 --yes；要回退：git checkout -- src/manifest/package.json package && rm -rf dist`)
  }
  console.log('')
  log(`请现在重启 DSH（完全退出再打开），验证 v${version}：`)
  console.log('         · 侧边栏出现「AI 课程」，/ai-course 能收到指令')
  console.log('         · 课程库能读出旧课程，随便打开一个知识点')
  console.log('')
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
  const answer = await rl.question(`[release] 验证完成后按 Enter 继续发布 v${version}；输入 n 取消：`)
  rl.close()
  if (answer.trim() && !/^y(es)?$/i.test(answer.trim())) {
    fail('已取消发布',
      `未提交、未打 tag。要回到发版前：git checkout -- src/manifest/package.json package && rm -rf dist`)
  }
}

async function bumpManifest (target) {
  const raw = await readFile(MANIFEST, 'utf8')
  let hits = 0
  const next = raw.replace(/("version"\s*:\s*")[^"]*(")/, (_, open, close) => {
    hits += 1
    return open + target + close
  })
  if (hits !== 1) fail(`src/manifest/package.json 里找到 ${hits} 处 "version"，预期恰好 1 处`)
  const parsed = JSON.parse(next)
  if (parsed.version !== target) fail(`写入版本失败：期望 ${target}，实际 ${parsed.version}`)
  await writeFile(MANIFEST, next)
}

async function pack (name, version) {
  await mkdir(DIST_DIR, { recursive: true })
  const tgz = join(DIST_DIR, `${name}-${version}.tgz`)
  await rm(tgz, { force: true })
  npmRun(['pack', '--pack-destination', DIST_DIR])
  if (!existsSync(tgz)) fail(`npm pack 没有产出预期文件：${tgz}`)
  return tgz
}

/** git 层的共同前置：在仓库里、不在游离 HEAD、工作区干净。 */
function checkGitState () {
  try {
    gitOut(['rev-parse', '--is-inside-work-tree'])
  } catch {
    fail('当前目录不是 git 仓库', '先 git init 并提交；发版脚本依赖干净的 git 历史')
  }

  const branch = gitOut(['rev-parse', '--abbrev-ref', 'HEAD'])
  if (branch === 'HEAD') fail('HEAD 处于 detached 状态', '切回一个分支再发版，否则 tag 会挂在游离提交上')
  log(`当前分支：${branch}`)

  const dirty = gitOut(['status', '--porcelain', '--untracked-files=no'])
  if (dirty) {
    if (!opts.allowDirty) {
      fail('已跟踪文件有未提交改动，先提交或 stash 再发版', dirty + '\n确认无碍可加 --allow-dirty')
    }
    warn('已跟踪文件有未提交改动（--allow-dirty）：' + dirty.split('\n')[0])
  }

  const untracked = gitOut(['status', '--porcelain', '--untracked-files=normal'])
    .split('\n')
    .filter((line) => line.startsWith('??'))
  if (untracked.length) warn(`有未跟踪文件（不会被本次提交带走）：${untracked.map((l) => l.slice(3)).join(', ')}`)
}

/** 发布层的共同前置（联网）：npm 身份、远程仓库、目标版本是否已存在。 */
function publishPreflight (ctx) {
  if (ctx.manifest.private === true) {
    fail('src/manifest/package.json 还是 "private": true，npm 会拒绝发布', '改成 false 后再发版')
  }
  try {
    gitOut(['remote', 'get-url', 'origin'])
  } catch {
    fail('没有 origin 远程仓库，无法 push', '先 git remote add origin <url>')
  }
  try {
    const who = npmOut(['whoami', '--silent'])
    log(`npm 身份：${who}`)
  } catch (err) {
    const why = [err.stderr, err.stdout, err.message]
      .map((part) => String(part || '').trim())
      .filter(Boolean)
      .join('\n')
    fail('npm 未登录（npm whoami 失败）', why + '\n先运行 npm login；2FA 用户建议设置 NPM_CONFIG_OTP')
  }

  /* 注意：npm view 的 E404 是「还没发布过」，是正常路径；但 fail() 不能被下面的
     catch 顺带吞掉 —— 先拿到结果，再在 try 外面判断。 */
  let already = ''
  try {
    already = npmOut(['view', `${ctx.manifest.name}@${ctx.target}`, 'version', '--silent'])
  } catch (err) {
    const text = String([err.stderr, err.stdout, err.message].filter(Boolean).join('\n'))
    if (!/E404|404|not found/i.test(text)) warn('查询 npm 上的版本失败，继续尝试发布：' + text.split('\n')[0])
  }
  if (already) fail(`${ctx.manifest.name}@${ctx.target} 已经发布过`, '换一个版本号')
}

function releasePreflight (ctx) {
  log('预检')
  checkGitState()

  const tag = TAG_PREFIX + ctx.target
  if (gitOut(['tag', '--list', tag])) fail(`tag ${tag} 已存在`, '换个版本号，或先删除旧 tag（git tag -d ' + tag + '）')

  if (!existsSync(MANIFEST)) fail('缺 src/manifest/package.json')
  if (!existsSync(PKG_DIR)) fail('缺 package/ 目录', '先运行 node scripts/build.mjs')

  /* check.mjs 会把 doc/11-prompts.md 和代码里的提示词做同步断言。
     doc/ 在 .gitignore 里 —— 新克隆的工作区没有它，check 会直接 ENOENT。
     这里提前说清楚，别让人看到一句没头没脑的栈。 */
  if (!existsSync(join(root, 'doc/11-prompts.md'))) {
    fail('缺 doc/11-prompts.md，check.mjs 无法完成提示词同步校验',
      'doc/ 被 .gitignore 忽略，新克隆里没有；从主工作区拷贝 doc/，或把 11-prompts.md 纳入版本管理')
  }

  if (opts.publish) publishPreflight(ctx)
}

/** --publish-only 的前置：版本、产物、tag 必须指向同一个 HEAD。 */
function publishOnlyPreflight (ctx) {
  log('预检（只发布）')
  checkGitState()

  let built
  try {
    built = JSON.parse(readFileSync(join(PKG_DIR, 'package.json'), 'utf8'))
  } catch {
    fail('读不到 package/package.json', '先跑一次本地发版：node scripts/release.mjs <version>')
  }
  if (built.name !== ctx.manifest.name) {
    fail('package/ 与 src/manifest 的包名不一致', '先重新构建：node scripts/build.mjs')
  }
  if (built.version !== ctx.manifest.version) {
    fail(`package/ 是 ${built.version}，src/manifest 是 ${ctx.manifest.version}`,
      '产物与源码对不上；先重新构建或重新发版')
  }

  const tag = TAG_PREFIX + ctx.manifest.version
  if (!gitOut(['tag', '--list', tag])) {
    fail(`tag ${tag} 不存在`, '--publish-only 只发布已经本地发版（commit + tag）的版本；先跑 node scripts/release.mjs <version>')
  }
  const tagCommit = gitOut(['rev-list', '-n', '1', tag])
  const head = gitOut(['rev-parse', 'HEAD'])
  if (tagCommit !== head) {
    fail(`tag ${tag} 不在 HEAD 上`, `tag 指向 ${tagCommit.slice(0, 8)}，HEAD 是 ${head.slice(0, 8)}；先切到该提交`)
  }

  publishPreflight(ctx)
}

function printPlan (ctx) {
  log(ctx.bump
    ? `计划：${ctx.current} → ${ctx.target}（tag ${TAG_PREFIX}${ctx.target}）`
    : `计划：发布当前版本 ${ctx.target}（不再递增，tag ${TAG_PREFIX}${ctx.target}）`)
  console.log('        1. ' + (ctx.bump ? '改写 src/manifest/package.json 的 version' : '保持当前版本（不改 version）'))
  console.log('        2. node scripts/vendor-mermaid.mjs --require')
  console.log('        3. node scripts/build.mjs')
  console.log('        4. node scripts/check.mjs')
  if (!opts.noSmoke) console.log(`        5. ${SMOKES.length} 个离线冒烟`)
  console.log(`        6. npm pack → dist/${ctx.manifest.name}-${ctx.target}.tgz`)
  if (!opts.noCommit) {
    console.log('        7. git add src/manifest/package.json package && git commit && git tag')
  } else {
    console.log('        7. （--no-commit）不提交、不打 tag')
  }
  if (opts.publish) console.log('        8. 人工真机验证 → git push → npm publish')
  log('--dry-run：没有修改任何文件')
}

/** 推送 + 发布。调用前必须已经确认过真机验证。 */
async function pushAndPublish (ctx) {
  if (opts.noPush) {
    warn('--no-push：跳过了 git push（npm 包会先于源码公开）')
  } else {
    log('推送 commit 与 tag')
    try {
      gitRun(['push', 'origin', 'HEAD'])
      gitRun(['push', 'origin', TAG_PREFIX + ctx.target])
    } catch {
      fail('git push 失败', '本地 commit/tag 已保留；修好后运行 node scripts/release.mjs --publish-only 重试')
    }
  }
  log('npm publish')
  try {
    npmRun(['publish'])
  } catch {
    fail('npm publish 失败', '本地 commit/tag 已保留；修好后运行 node scripts/release.mjs --publish-only 重试')
  }
}

/* ------------------------------------------------------------------ 主流程 */

async function main () {
  parseArgs()
  const manifest = JSON.parse(await readFile(MANIFEST, 'utf8'))

  if (opts.publishOnly) {
    const version = String(manifest.version || '')
    if (!parseVersion(version)) fail(`src/manifest/package.json 的 version 不是合法 semver：${version}`)
    const ctx = { manifest, current: version, target: version }
    if (opts.dryRun) {
      publishOnlyPreflight(ctx)
      log(`计划：发布已发版版本 ${version}（不构建、不改版本）`)
      console.log(`        1. git push origin HEAD + ${TAG_PREFIX}${version}${opts.noPush ? '（--no-push：跳过）' : ''}`)
      console.log('        2. npm publish')
      log('--dry-run：没有修改任何文件')
      return
    }
    publishOnlyPreflight(ctx)
    await confirmBeforePublish(version)
    await pushAndPublish(ctx)
    console.log('')
    log(`发布完成：${TAG_PREFIX}${version}`)
    console.log(`        npm：https://www.npmjs.com/package/${manifest.name}/v/${version}`)
    return
  }

  const current = String(manifest.version || '')
  if (!parseVersion(current)) fail(`src/manifest/package.json 的 version 不是合法 semver：${current}`)

  const target = resolveVersion(current, positional[0])
  const bump = positional[0] !== 'current'
  if (!parseVersion(target)) fail(`目标版本不是合法 semver：${target}`)
  if (bump && compareVersion(target, current) <= 0) {
    fail(`目标版本 ${target} 不高于当前版本 ${current}`, '版本号只能往前走；首次发布当前版本用 current')
  }

  const ctx = { manifest, current, target, bump }
  releasePreflight(ctx)
  if (opts.dryRun) return printPlan(ctx)

  log(bump ? `改版本：${current} → ${target}` : `保持版本：${target}（首次发布当前版本）`)
  await bumpManifest(target)

  log('Mermaid 门禁')
  run(process.execPath, [join(root, 'scripts/vendor-mermaid.mjs'), '--require'], { stdio: 'inherit' })

  log('构建 package/')
  run(process.execPath, [join(root, 'scripts/build.mjs')], { stdio: 'inherit' })

  const built = JSON.parse(await readFile(join(PKG_DIR, 'package.json'), 'utf8'))
  if (built.version !== target) fail(`构建产物版本不对：package/package.json 是 ${built.version}，期望 ${target}`)
  if (built.private === true && opts.publish) fail('构建产物仍是 private:true')

  log('产物自检')
  gate('check.mjs', 'check.mjs')

  if (!opts.noSmoke) {
    log(`离线冒烟（${SMOKES.length} 个）`)
    for (const script of SMOKES) gate(script, script)
  }

  const tgz = await pack(built.name, target)
  log(`打包：${tgz.replace(root + '/', '')}`)

  /* 确认放在 commit/tag 之前：用户在 DSH 里验完再落版本。
     取消时不会留下 commit/tag，只有可回滚的工作区改动。 */
  if (opts.publish) await confirmBeforePublish(target)

  if (opts.noCommit) {
    warn('--no-commit：跳过了 git commit 与 tag')
  } else {
    log('提交并打 tag')
    gitRun(['add', 'src/manifest/package.json', 'package'])
    const staged = gitOut(['diff', '--cached', '--name-only'])
    if (!staged) {
      /* current 模式可能一次构建都没改动（版本没变、产物已是最新）——
         这时直接在当前 HEAD 上打 tag，不必造一个空提交。 */
      if (bump) fail('没有可提交的改动（版本与产物都没变？）')
      log('工作区没有新改动，直接在当前 HEAD 上打 tag')
    } else {
      try {
        gitRun(['commit', '-m', `release: ${TAG_PREFIX}${target}`])
      } catch {
        fail('git commit 失败', '检查 git user.name / user.email 是否配置：git config --global user.name …')
      }
    }
    try {
      gitRun(['tag', '-a', TAG_PREFIX + target, '-m', TAG_PREFIX + target])
    } catch {
      fail('git tag 失败', 'tag 可能已存在；git tag -d ' + TAG_PREFIX + target + ' 后重试')
    }
    log(`已打 tag：${TAG_PREFIX}${target}`)
  }

  if (opts.publish) await pushAndPublish(ctx)

  console.log('')
  log(`完成：${TAG_PREFIX}${target}`)
  console.log(`        包：${tgz.replace(root + '/', '')}`)
  console.log(`        产物：package/`)
  if (opts.publish) {
    console.log(`        npm：https://www.npmjs.com/package/${built.name}/v/${target}`)
  } else if (opts.noCommit) {
    console.log('        注意：--no-commit 没有 commit/tag，不能走 --publish-only；正式发版请去掉该参数')
  } else {
    console.log('        下一步：重启 DSH 验证；确认无误后跑 node scripts/release.mjs --publish-only 发布')
  }
  console.log('        提醒：doc/10-release-checklist.md 的版本行是手写的（doc/ 被 .gitignore 忽略）')
}

main().catch((err) => {
  console.error(`\n[release] ✗ ${err.message}`)
  if (err.detail) {
    for (const line of String(err.detail).split('\n')) console.error(`         ${line}`)
  }
  process.exit(1)
})
