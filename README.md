# AI 课程（dsh-ai-courses）

把「一个学习诉求 + 手头资料」变成一门**结构化、可讲授、可反复翻阅、纯本地**的 AI 课程。

在 DeepSeek Harness 里用 `/ai-course` 建课，在侧边栏「AI 课程」里管课、按章节/知识点生成内容，在学习页里阅读图文、幻灯片与图表。课程数据全部落在本地文件里，可以直接打开、diff、备份或整目录拷贝。

> 适用：DeepSeek Harness `>= 0.2.0-rc.2`，Web UI（含桌面端的 Web 界面）。  
> 运行形态：host + client 双半插件；包本身零运行时依赖。

---

## 目录

- [功能一览](#功能一览)
- [安装](#安装)
- [快速开始](#快速开始)
- [参考资料与附件](#参考资料与附件)
- [配置](#配置)
- [数据与备份](#数据与备份)
- [升级、停用与卸载](#升级停用与卸载)
- [已知限制](#已知限制)
- [故障排查](#故障排查)
- [从源码开发](#从源码开发)
- [License](#license)

---

## 功能一览

- **`/ai-course` 建课**：一句学习诉求（可带附件/资料路径）→ 课程、章节、知识点大纲。
  命令卡片显示推导阶段与用时；成功后同一条回复末尾出现可编辑的大纲卡片。
- **三种粒度生成内容**：整门课 / 某一章 / 单个知识点。后台任务，刷新页面不丢；
  宿主重启后残留任务标记为 `interrupted`，不会假装还在跑。
- **内容类型**：`图文`（Markdown）、`幻灯片`（Slidev 方言）。`音频` / `视频` / `代码` / `测验`
  目前按 Markdown 降级生成，界面标注「格式待定」。
- **学习页**：Markdown 子集、Slidev 播放器、Mermaid 图表、代码高亮、本地媒体。
  打开**有内容**的知识点 → `进行中`，离开 → `已掌握`；章节/课程进度自动聚合。
- **课程库**：按标签/分类过滤、按名称搜索、打开大纲、进入学习、删除课程（整个课程目录）。
- **课程库设置**：右上角配置按钮可直接修改 `courseRoot`，保存后立即切换目录，无需重启。
- **纯本地数据**：`<courseRoot>/<courseId>/` 下的 JSON + Markdown；无外部存储 backend。
- **引用资料**：建课诉求/附件里点名的文本文件会随课程保存，生成内容时作为「参考资料」注入 prompt。
- **不占用旧 `course` 格位**：面板与 slot id 是 `ai-courses`，可与在装的 `dsh-course-plugin` 共存。

### Agent 工具

模型在会话里可以直接调用三个工具；UI 与工具走同一张 RPC 方法表，语义一致：

| 工具 | 用途 |
|---|---|
| `course_read` | 读取课程、大纲与学习进度；生成内容前先读上下文 |
| `course_generate` | 为整门课 / 某一章 / 某些知识点发起后台生成 |
| `course_content_asset_put` | 写回某个知识点的内容资产（正文一律 Markdown） |

---

## 安装

### 前置条件

- 已安装并启动 DeepSeek Harness **0.2.0-rc.2 或更新版本**。
- 使用 **Web UI**：`dsh web`，或桌面端内置的 Web 界面。
  TUI / headless 没有课程面板（client half 的 `platform` 是 `web`）。
- DSH 进程对课程库目录有读写权限；默认是 `~/.dsh/ai-courses`。
- 内容生成需要可用的模型与会话（生成动作由某个会话承载模型调用）。
- 从源码构建时另需 Node.js 20+。

### 方式一：npm / CLI

```bash
dsh plugin --profile web add dsh-ai-courses
```

桌面端把 `web` 换成 `desktop`：

```bash
dsh plugin --profile desktop add dsh-ai-courses
```

这条命令会同时写入 profile 的依赖与 `dsh.profile.bundles`，不需要手工编辑 profile。

> **已知版本问题**：
> ① 0.1.2 及更早在 `dsh web` 下，客户端在 sidebar 槽声明之前就注册 `sidebar.panellist`，
> 会报 `dsh-ai-courses: failed` —— **0.1.3 已修复**；
> ② 0.1.3 及更早在中文 DSH 下仍可能显示英文 —— apply 时把 `<html lang>` 的初始 `en` 锁死，
> **0.1.4 起修复**（动态读取语言）。
> 建议安装 **0.1.4 或更新版本**。

> 如果 registry 上还搜不到 `dsh-ai-courses`（首次发布尚未完成），用方式三或方式四。

### 方式二：插件市场（推荐）

先确认已安装插件市场：

```bash
dsh plugin --profile web add dshmarket
```

重启 `dsh web`，打开 **设置 → 插件市场**，搜索「AI 课程」并安装。

> 桌面端通常已内置插件市场；没有的话把 `web` 换成 `desktop` 装一次。
> 如果市场里还搜不到，说明尚未收录；用下面的 npm 或本地方式。

### 方式三：从源码构建安装

```bash
git clone https://github.com/aix-plugin/ai-courses.git
cd ai-courses

# Mermaid 是浏览器按需加载的 vendor 文件；仓库已带，缺失时下载
node scripts/vendor-mermaid.mjs

# src/ → package/
node scripts/build.mjs

# 安装的是构建产物 package/，不是仓库根目录
dsh plugin --profile web add "$PWD/package"
```

> ⚠️ 仓库根目录没有 `package.json`，`dsh plugin add` 必须指向 `package/`。

### 方式四：本地 tarball（内网/离线分发）

```bash
cd ai-courses/package
npm pack
# 产出 dsh-ai-courses-<version>.tgz
# 注意用绝对路径：dsh plugin 在 profile 目录里执行 pnpm，相对路径会解析错
dsh plugin --profile web add "$PWD/dsh-ai-courses-<version>.tgz"
```

### 安装后确认

1. **完全退出并重新打开 DSH**。新装 bundle 有时能热加载，但**替换/升级必须重启**才能加载新的 JS 模块。
2. 打开 **设置 → 插件**，确认 `dsh-ai-courses` 存在且已启用。
3. 侧边栏出现「AI 课程」面板。
4. 在会话里输入 `/`，能看到 `/ai-course`。

如果只有面板没有命令，或只有命令没有面板，通常是 host/client 有一半没加载：重启并查看宿主日志。

---

## 快速开始

### 1. 建课

在任意会话里发送：

```
/ai-course 用 3 章讲清 React Server Components，我熟悉 Vue 不熟 React
```

也可以带上资料：

```
/ai-course 根据 ./docs/rsc-spec.md 和附件，用 3 章讲清 React Server Components
```

建课时会发生：

- 命令卡片显示「已收到诉求，正在交给模型 / 已拿到课程结构，正在校验 / 正在写入课程库」等阶段与用时。
- 成功后回复末尾出现**课程大纲卡片**：章节、知识点、类型、时长（内容生成后回填）、生成状态、学习进度。
- 可以直接在卡片里改名、增删章节与知识点，也可以点「打开完整大纲」。
- 如果已存在同名课程，会先展示已有大纲并询问是否新建，避免误建重复课程。

### 2. 管理课程

打开侧边栏「AI 课程」：

- 课程库：按标签/分类过滤，按名称搜索。
- 课程库右上角的配置图标：修改 `courseRoot`，保存后立即切换（见[配置](#配置)）。
- 课程卡片：名称、描述、标签、学习进度、大纲入口、学习入口、删除。
- 大纲页：修正章节/知识点，发起内容生成。

### 3. 生成内容

在大纲页、学习页或生成弹窗里选择范围：

- 生成整门课内容
- 生成本章全部内容
- 生成这个知识点

说明：

- 生成在后台进行，界面按约 1.5s 轮询进度；刷新页面不丢任务。
- 已有内容时会询问「保留并追加」还是「覆盖」。
- 生成需要由一个会话承载模型调用；如果提示「先打开任意会话」，先在左侧新建/打开一个会话。
- 宿主重启后，未完成的任务会标记为 `interrupted`，可以重新发起。
- 输入框上方的常驻状态条会显示「正在为哪门课写哪个知识点 / 已完成几个」，切换面板也能看到。

### 4. 学习

点击课程卡片上的「学习」，或在大纲里点某个已生成内容的知识点：

- `图文`：本地 Markdown 正文；支持 Mermaid 图表、代码高亮、示意图。
- `幻灯片`：Slidev 方言 Markdown，按页播放，支持讲稿。
- `音频` / `视频` / `代码` / `测验`：当前按 Markdown 降级展示，标注「格式待定」。
- 打开**有内容**的知识点 → `进行中`；离开/切换 → `已掌握`。没有额外的「标记已掌握」按钮。

### 5. 删除课程

课程卡片底部 → 删除 → 二次确认。

删除会连同该课程的章节、知识点、内容资产、生成任务、学习进度**一起删掉**（删除整个课程目录），且不可撤销。如果只是暂时不用这个插件，先在设置里停用它，不要删课程数据。

---

## 参考资料与附件

建课时可以通过两种方式提供资料：

1. **附件**：输入框的附件按钮，或 `@` 选择文件。
2. **诉求里的路径**：例如 `./docs/spec.md`、`@/tmp/notes.md`、`~/notes/spec.yaml`。

边界：

- 只读取**文本类**文件（md / txt / json / yaml / ts / py / csv 等）。
- 图片、二进制、URL 不会被抓取；不联网抓网页。
- 最多 **6 个**引用；单文件 **6000 字符**、单次合计 **24000 字符**，超出会截断并在 prompt 里标注「以上为节选」。
- 文件不存在 / 不是文本 / 无权限时**静默跳过**，不会阻断建课或生成。
- 诉求原文与附件副本会存进课程目录的 `sources/`，之后生成知识点时继续作为参考资料。

---

## 配置

### `courseRoot`

默认课程库：

```
~/.dsh/ai-courses
```

### 从界面修改（推荐）

课程库右上角 → **配置图标** → 修改「课程库目录（courseRoot）」→ **保存并切换**。

- 保存后**立即生效**，不需要重启 DSH；课程库会刷新到新目录。
- 旧目录里的课程**不会被移动或删除**；切回旧路径仍然能看到。
- 有生成任务或课程推导在跑时不允许切换，等任务结束再试。
- 设置保存在当前 profile 目录的 `ai-courses.settings.json`，**优先于** profile patch 里的 `courseRoot`。
- 目录必须是绝对路径；`~` 会展开；目标目录必须可写（host 会自动创建并做一次写探测）。
- 弹窗里会显示「当前生效」目录、来源（默认值 / profile 配置 / 界面设置）和设置文件位置。

### 从 profile patch 修改（默认/回退）

没有界面设置时，`courseRoot` 取自对应 profile 的 patch（web 示例）：

```yaml
# ~/.dsh/profiles/web/cordis.patch.yml
- id: ai-courses
  name: dsh-ai-courses
  config:
    courseRoot: /Users/you/Documents/ai-courses
```

桌面端对应 `~/.dsh/profiles/desktop/cordis.patch.yml`。

规则：

- 支持 `~` 展开；展开后必须是**绝对路径**，相对路径会被拒绝。
- patch 里的 `config` 是**整体替换**，不是深合并；插件会自动回填缺省值。
- 改完重启 DSH 生效。
- 一旦在界面里保存过设置，`ai-courses.settings.json` 会覆盖 patch 值；删掉该文件并重启，才会回到 patch 值。
- `maxParallelGenerations`、`defaultContentType` 目前只是配置兼容保留，**不改变运行时行为**，不要把它们当开关。

### 其他

- 插件包名：`dsh-ai-courses`
- bundle patch 行 id：`ai-courses`
- client platform：`web`
- 零运行时依赖；不写会话事件

---

## 数据与备份

### 目录结构

```
<courseRoot>/                         默认 ~/.dsh/ai-courses
└── c-20261013142530-a7f3/            课程 id = 目录名
    ├── course.json                   课程元数据 + 大纲 + schemaVersion
    ├── progress.json                 学习进度（只存知识点层）
    ├── tasks.json                    内容生成任务
    ├── content-assets/
    │   ├── <kpId>.json               内容资产信封（元数据、mediaRefs）
    │   ├── <kpId>.md                 图文正文
    │   ├── <kpId>.slides.md          幻灯片正文
    │   └── media/                    示意图等本地媒体
    └── sources/                      诉求原文与附件副本
        ├── request.md
        └── <附件文件名>
```

- `course.json` 里内联章节与知识点；`progress.json` 只存知识点进度，章节/课程进度由它派生。
- 正文里的媒体引用是**课程目录内的相对路径**，整个课程目录可以搬走。
- 删除课程 = 删除这一个目录，不存在跨系统的非原子删除。

### 备份与迁移

直接复制整个 `<courseRoot>`：

```bash
cp -R ~/.dsh/ai-courses ~/backup/ai-courses-$(date +%F)
```

换机器时把目录拷过去，然后在课程库右上角的配置里把 `courseRoot` 指到新位置（或删掉 `ai-courses.settings.json` 后改 profile patch、重启）。

### 版本与损坏

- 每个结构化 JSON 文件都有 `schemaVersion`；`course.json` / `progress.json` 带版本守卫。
- 如果 `course.json` / `progress.json` 来自**更新版本**的插件，旧代码会**只读降级**：可浏览、禁止写入，不会静默改写你的数据。
- JSON 解析失败时，该文件降级为空，并把原文件另存为 `.corrupt-<时间戳>`，其他课程不受影响。
- 早期版本写入的 SVG 可能不是合法 XML，浏览器不显示。在仓库内跑一次清洗器（会先预演并备份 `.bak`）：

```bash
node scripts/repair-media.mjs --write
```

---

## 升级、停用与卸载

| 场景 | 操作 | 说明 |
|---|---|---|
| 升级（npm） | `dsh plugin --profile web add dsh-ai-courses@latest` | 重启 DSH |
| 升级（市场） | 插件市场 → 更新 | 按提示重启 |
| 升级（本地 link） | `git pull && node scripts/build.mjs` | 重启 DSH |
| 升级（tarball） | 重新 `npm pack` 后 `dsh plugin add` 新 tgz | 重启 DSH |
| 临时停用 | 设置 → 插件 → 关闭 | 界面消失，课程数据保留 |
| 卸载 | 设置 → 插件 → 卸载（推荐）；或 `dsh plugin --profile web remove dsh-ai-courses`，并确认 `dsh.profile.bundles` 里没有残留 | **不会删除课程数据** |
| 删除数据 | 手动删除 `<courseRoot>` | 不可撤销，先备份 |

升级注意：

- **替换已安装包必须重启**才能加载新的 JavaScript 模块；只刷新页面不够。
- slot id 没变不代表浏览器端代码已更新，以重启后的界面为准。
- 升级不会动课程数据；但如果 `schemaVersion` 升了，回滚到旧版本会让数据变成只读（这是刻意的保护）。
- 回滚最快的方式是先在「设置 → 插件」里停用，而不是卸载。

---

## 已知限制

- `音频` / `视频` / `代码` / `测验` 目前只按 Markdown 降级生成，标注「格式待定」。
- `测验` 只展示题目与答案，不能作答判分。
- 音频/视频不做合成，只支持本地挂载素材。
- 课程数据纯本地，没有云同步；换机器需手动拷贝 `courseRoot`。
- 进度是轮询更新（约 1.5s），不是实时推送。
- 内容生成依赖模型与会话；模型不可用时无法生成。
- 幻灯片使用 Slidev 方言，但不是完整的 Slidev 运行时；只支持本插件实现的版式与能力。
- Mermaid 渲染器约 3.4 MB，按需加载；拿不到 vendor 文件时图表会降级成源码块，不会白屏。
- 删除课程不可撤销。

---

## 故障排查

| 现象 | 排查 |
|---|---|
| 侧边栏没有「AI 课程」 | 设置 → 插件里确认已启用；重启 DSH；确认用的是 web profile，不是 TUI/headless |
| 有面板但没有 `/ai-course` | host half 没激活；重启并查看宿主日志；确认 patch 行 `ai-courses` 未被 disabled |
| 生成按钮提示先打开会话 | 生成需要会话承载模型调用；先在左侧打开/新建一个会话 |
| 生成一直转圈 | 看输入框上方状态条；刷新页面后任务仍在；宿主重启后任务会变 `interrupted`，重新发起即可 |
| 图表显示成代码块 | `vendor/mermaid.min.js` 缺失或未随包发布；重新安装，或在源码目录跑 `node scripts/vendor-mermaid.mjs` 后重新 build |
| 课程变成只读 | 数据 `schemaVersion` 比当前插件新；升级插件，不要用旧版本硬写 |
| 某个课程 JSON 损坏 | 同目录下找 `.corrupt-<时间戳>` 备份；该文件会按空处理，其他课程不受影响 |
| 旧示意图不显示 | 跑 `node scripts/repair-media.mjs --write`（先预演、自动备份 `.bak`） |
| 改课程库目录失败 | 必须是绝对路径且目标目录可写；有生成/课程推导任务在跑时先等任务结束；错误原因会显示在配置弹窗里 |
| `web boot: 1 entry did not activate / dsh-ai-courses: failed` | 0.1.2 及更早在 `dsh web` 下的 sidebar 槽时序 bug；升级到 0.1.3+，或先用本地 `package/` 链接 |
| DSH 设置中文但插件显示英文 | 0.1.3 及更早在 apply 时把 `<html lang>` 的初始 `en` 锁死；升级到 0.1.4+（动态读取语言） |
| 页面 404 / 路由不存在 | 确认插件已启用并重启；确认安装的是 `package/` 产物，而不是仓库源码目录 |
| npm 安装报 404 | `dsh-ai-courses` 还没发布到你的 registry；改用「从源码构建」或本地 tarball |

---

## 从源码开发

### 构建与自检

```bash
task build
```

产物在 `package/`。**不要手改 `package/`**：每次 build 会整目录重建；要改就改 `src/`。

> `check.mjs` 会读 `doc/11-prompts.md` 做提示词同步校验。`doc/` 是本地开发文档，不随仓库发布；
> 干净克隆里缺这个文件时，先补齐 `doc/11-prompts.md`，或暂时只跑 build + smoke。

### 发版

```bash
task release
```

npm 账号开了 2FA 时，publish 需要 OTP 或带 `bypass 2fa` 的 granular access token：

```bash
NPM_CONFIG_OTP=123456 node scripts/release.mjs --publish-only --yes
```

### 源码结构

| 路径 | 作用 |
|---|---|
| `src/host/*.mjs` | host 半边源码，按文件名顺序拼接为 `package/index.mjs` |
| `src/client/*.js` | client 半边源码，拼接为 `package/lib/client.js` |
| `src/client/styles.css` | 构建期内联进 client，同时作为真实文件随包发布 |
| `src/manifest/` | `package.json`、`cordis.patch.yml`、`icon.svg`、`locale/` |
| `scripts/` | 构建、自检、冒烟、发版脚本 |
| `vendor/` | 浏览器按需加载的第三方单文件（Mermaid、highlight.js 源） |
| `package/` | 构建产物，也是 `dsh plugin add` 的安装目标 |
| `doc/`、`preview/`、`dist/` | 本地开发产物，不随仓库发布 |

版本号只改 `src/manifest/package.json` 的 `version`；数据 schema 版本在 `src/host/20-store.mjs` 的 `SCHEMA_VERSION`，两者不是一回事，不要一起 bump。

### 开发循环

```bash
node scripts/build.mjs
# 桌面端：完全退出并重新打开
# Web：重启 dsh web
```

host 代码改动必须重启宿主；client 改动在重启后会随新的 client 包加载。

---

## License

MIT。见 `package/package.json` 的 `license` 字段。
