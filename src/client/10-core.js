/* ==================== src/client/10-core.js ====================
 * 纯逻辑层（client 半边的地基）
 *
 * 约定（为什么这么组织）：
 *   1. **不碰 React、不碰 DOM** —— 只做 i18n、编号派生、筛选、状态派生这些可断言的纯计算。
 *      于是 scripts/client-smoke.mjs 能在 node 里把它单独取出来跑断言，
 *      **不需要模拟 React/DOM**（doc/09 §7.2 明确禁止把模拟渲染当作界面验证）。
 *   2. 以 IIFE 暴露成 `AIC_COURSES_CORE`：拼接后与其它段共享同一个脚本作用域，
 *      名字带前缀，避免与宿主 / 其他插件的脚本级绑定撞车。
 *   3. 界面文案一律走键值表（06 §9）：中文只出现在 locale 表里，组件代码里一个中文字面量都没有。
 *
 * ⚠️ 枚举必须与 host 的 src/host/05-constants.mjs 逐字一致（scripts/check.mjs 会比对产物）。
 * ========================================================================== */

const AIC_COURSES_CORE = (function () {
  'use strict'

  /* ---------------------------------------------------------------- 枚举 */
  const CONTENT_TYPES = ['图文', '幻灯片', '音频', '视频', '代码', '测验']
  const SUPPORTED_TYPES = ['图文', '幻灯片']
  const DEFERRED_TYPES = CONTENT_TYPES.filter((t) => SUPPORTED_TYPES.indexOf(t) < 0)
  const DIFFICULTIES = ['入门', '中级', '高级']

  /** 知识点进度取值（05 §6）。 */
  const KP_STATES = ['未开始', '进行中', '已掌握']

  /* ------------------------------------------------- 状态表（06 §4.3） */
  /* AI 生成状态：5 态。**只有「未生成」是空心**；其余 4 态只靠颜色区分，
     颜色不足以区分的地方由 title / aria-label 兜底（06 §8）。 */
  const GEN_STATES = [
    { key: '未生成', mod: 'none', glyph: 'hollow', color: 'idle' },
    { key: '排队中', mod: 'queued', glyph: 'solid', color: 'idle' },
    /* **生成中**用转动的加载图标，而不是橙色实心圆：圆点看不出"还在动"，
       而大纲里最需要传达的恰恰是"它正在跑"（06 §4.3）。 */
    { key: '生成中', mod: 'doing', glyph: 'spin', color: 'warn' },
    { key: '已生成', mod: 'done', glyph: 'solid', color: 'success' },
    { key: '生成失败', mod: 'failed', glyph: 'solid', color: 'error' },
  ]
  /* 学习状态：3 态；行内**只显示「学习完成」**，另两态用于章节/课程聚合。 */
  const LEARN_STATES = [
    { key: '学习开始', mod: 'start', glyph: 'play', color: 'primary' },
    { key: '学习中', mod: 'doing', glyph: 'pause', color: 'primary' },
    { key: '学习完成', mod: 'done', glyph: 'check', color: 'success' },
  ]
  /** 状态点的修饰类（任务项行用；M2 的任务表落地时才渲染）。 */
  const STATE_DOT_CLASS = { '已掌握': 'aic-dot--done', '进行中': 'aic-dot--doing', '未开始': '' }

  /** 生成状态优先级（06 §4.3）：进行中的动作与最近的失败，都比「有内容」更该被看到。 */
  const GEN_PRIORITY = ['生成中', '排队中', '生成失败', '未生成', '已生成']

  /** 每态对应的 i18n 键（状态名本身是领域值，展示时走文案表）。 */
  const GEN_STATE_KEY = { '未生成': 'state.gen.none', '排队中': 'state.gen.queued', '生成中': 'state.gen.doing', '已生成': 'state.gen.done', '生成失败': 'state.gen.failed' }
  const LEARN_STATE_KEY = { '学习开始': 'state.learn.start', '学习中': 'state.learn.doing', '学习完成': 'state.learn.done' }

  /* 类名一律写成**完整字面量**（不做字符串拼接）：
     scripts/check.mjs 会据此断言「代码里出现的每个 aic- 类都能在 styles.css 里找到规则」，
     拼接产生的半截名（`aic-genstate--`）会让那条断言失去意义。 */
  const GEN_CLASS = {
    '未生成': 'aic-genstate--none aic-genstate--idle',
    '排队中': 'aic-genstate--queued aic-genstate--idle',
    '生成中': 'aic-genstate--doing aic-genstate--warn',
    '已生成': 'aic-genstate--done aic-genstate--success',
    '生成失败': 'aic-genstate--failed aic-genstate--error',
  }
  const LEARN_CLASS = {
    '学习开始': 'aic-learnstate--start aic-learnstate--primary',
    '学习中': 'aic-learnstate--doing aic-learnstate--primary',
    '学习完成': 'aic-learnstate--done aic-learnstate--success',
  }

  const genSpec = (key) => GEN_STATES.filter((s) => s.key === key)[0] || GEN_STATES[0]
  const learnSpec = (key) => LEARN_STATES.filter((s) => s.key === key)[0] || LEARN_STATES[0]

  /* ----------------------------------------------------------- i18n */
  const LOCALES = {
    'zh-CN': {
      'panel.title': 'AI 课程',

      'library.title': '课程库',
      'library.subtitleAll': '{n} 门课程 · 全部保存在本机',
      'library.subtitleFiltered': '{n} / {total} 门课程（已按筛选显示）',
      'library.config': '课程库设置',
      'config.title': '课程库设置',
      'config.courseRootLabel': '课程库目录（courseRoot）',
      'config.courseRootHint': '默认 ~/.dsh/ai-courses；支持 ~ 展开；必须是绝对路径。保存后立即切换，旧目录里的课程不会被移动或删除。',
      'config.current': '当前生效：{path}',
      'config.source': '来源：{source}',
      'config.sourceDefault': '默认值',
      'config.sourceConfig': 'profile 插件配置',
      'config.sourceSettings': '界面设置',
      'config.defaultAction': '填入默认路径',
      'config.save': '保存并切换',
      'config.saving': '正在切换…',
      'config.loading': '正在读取当前配置…',
      'config.empty': '课程库目录不能为空',
      'config.unsupported': '当前宿主不支持在线修改课程库目录；请升级插件，或在 profile 的 cordis.patch.yml 里修改 courseRoot。',
      'config.saved': '课程库已切换到 {path}。',
      'config.settingsPath': '配置保存位置：{path}',
      'config.tasksHint': '有生成或课程推导任务在跑时不能切换目录，等任务结束后再试。',
      'config.writeFailed': '无法保存课程库设置：{message}',
      'library.categoryLabel': '分类：',
      'library.categoryAll': '全部分类',
      'library.searchPlaceholder': '按名称搜索…',
      'library.searchLabel': '按名称搜索课程',
      'library.tagbarLabel': '标签：',
      'library.tagbarCount': '已选 {n} / {total}',
      'library.tagbarClear': '清除标签（{n}）',
      'library.tagPick': '按该标签过滤',
      'library.tagUnpick': '取消选择该标签',
      'library.groupCount': '· {n}',
      'library.groupUncategorized': '未分类',
      'library.cardDifficulty': '难度 {level}',
      'library.cardDeriving': '推导中',
      'library.cardDerivingHint': '大纲还没生成，两个入口暂不可用',
      'library.cardCorrupt': '课程文件损坏',
      'library.cardCorruptHint': '解析失败已按空降级，原文件另存为 .corrupt-<时间戳>；其他课程不受影响。',
      'library.cardReadOnly': '只读降级：这门课由更高版本写入',
      'library.cardProgress': '学习进度',
      'library.cardOutline': '大纲',
      'library.cardGenerated': '已生成 {n}/{total}',
      'lesson.diagram': '图表',
      'lesson.diagramLoading': '正在绘制图表…',
      'lesson.diagramFallback': '图表渲染失败（{reason}），下面是它的源码：',
      'library.cardLearn': '学习',
      'library.cardLearnNoContent': '这个知识点还没有内容：先在「大纲」里生成内容，再进来学习',
      'library.cardDelete': '删除',
      'library.deleteTitle': '删除课程',
      'library.deleteBody': '确定删除《{name}》吗？',
      'library.deleteDetail': '会连同它的章节、知识点、内容资产与学习进度**一起删掉**（整个课程目录），且**无法撤销**。',
      'library.deleteConfirm': '删除',
      'library.deleted': '已删除《{name}》。',
      'library.loading': '正在读取课程库…',
      'library.errorTitle': '课程库读取失败',
      'library.errorBody': '目录不可读或格式损坏。原文件已保留为 .corrupt-<时间戳>，不影响其他课程。',
      'library.errorPath': '<courseRoot> 不可读',
      'library.retry': '重试',
      'library.emptyTitle': '还没有课程',
      'library.emptyBody': '在主会话的输入框里说出你的学习诉求，agent 会先生成大纲与知识点。',
      'library.emptyHint': '/ai-course 用 3 章讲清 React Server Components',
      'library.emptyAction': '复制示例',
      'library.emptyActionDone': '已复制',
      'library.nomatchTitle': '没有匹配的课程',
      'library.nomatchBody': '当前筛选条件下没有结果 —— 与「课程库为空」是两种不同状态。',
      'library.nomatchAction': '清除筛选',

      'outline.crumbPage': '大纲',
      'outline.generateCourse': '生成整门课',
      'outline.composeCourse': '编辑课程信息 / 生成整门课内容',
      'outline.composeChapter': '编辑章节 / 生成本章内容',
      'outline.composeKp': '编辑知识点 / 生成内容',
      'outline.composeKpDone': '编辑知识点 / 重新生成内容',
      /* 课程级只保留「基础属性编辑」与「章节编辑（结构模式）」两个入口（用户需求 2026-10-18） */
      'outline.editCourseBasic': '编辑课程信息（名称 / 描述 / 标签 / 难度）',
      'outline.structureEnter': '章节编辑：显示章节与知识点的增删按钮',
      'outline.structureExit': '退出章节编辑',
      'outline.addChapterAfter': '在本章后新增章节',
      'outline.removeChapter': '删除本章',
      'outline.addKpAfter': '在本知识点后新增知识点',
      'outline.removeKp': '删除本知识点',
      'outline.editCourse': '编辑课程',
      'outline.generateChapter': '生成本章',
      'outline.editChapter': '编辑章节',
      'outline.generateKp': '生成内容',
      'outline.regenerateKp': '重新生成内容',
      'outline.editKp': '编辑知识点',
      'dock.generating': '正在生成《{course}》的知识点内容',
      'dock.finished': '《{course}》的知识点内容已生成',
      'dock.unknownCourse': '课程',
      'dock.writingKp': '· 正在写：{kp}',
      'dock.count': '{done} / {total}',
      'dock.openCourse': '查看大纲',
      'outline.progressFailed': '{n} 个知识点生成失败：',
      'outline.generateM2': '{label}：生成链路在 M2 接入，当前宿主没有 generation.start 方法。',
      'outline.chapterEmpty': '本章还没有知识点',
      'outline.loading': '正在读取课程…',
      'outline.errorTitle': '读取课程失败',
      'outline.notFoundTitle': '课程不存在',
      'outline.readOnlyNotice': '只读降级：这门课由更高版本写入，本版只浏览、不改写它的数据。',
      'outline.corruptNotice': '课程文件损坏：已按空降级并另存 .corrupt-<时间戳>，其他课程不受影响。',

      /* 主会话回复末尾的大纲卡片（65-outline-card.js） */
      'outcard.title': '课程大纲',
      'outcard.editable': '可在对话内修改',
      'outcard.scale': '{chapters} 章 · {kps} 个知识点',
      'outcard.progress': '学习进度',
      'outcard.openOutline': '打开完整大纲',
      'outcard.collapse': '收起大纲',
      'outcard.expand': '展开大纲',
      'outcard.loading': '正在读取课程…',
      'outcard.loadFailed': '课程读取失败：大纲暂时显示不出来，可稍后重试或用「打开完整大纲」查看。',

      'modal.cancel': '取消',
      'modal.save': '保存',
      'modal.close': '关闭',
      'modal.editCourseTitle': '编辑课程',
      'modal.editChapterTitle': '编辑章节',
      'modal.editKpTitle': '编辑知识点',
      'modal.fieldName': '名称',
      'modal.fieldDescription': '描述',
      'modal.fieldDifficulty': '难度',
      'modal.fieldTags': '标签',
      'modal.fieldTagsHint': '2~3 个范围大一点的标签最好用（例如：前端、数据库），用逗号或顿号分隔',
      'modal.deleting': '正在删除…',
      'modal.fieldType': '内容类型',
      'modal.structureTitle': '结构',
      'modal.newKpName': '新知识点',
      'modal.moveUp': '上移',
      'modal.moveDown': '下移',
      'modal.addChapter': '在下方新增章节',
      'modal.removeChapter': '删除本章',
      'modal.removeKp': '删除本知识点',
      'modal.removeLastChapterHint': '至少要有一个章节',
      'modal.removeLastKpHint': '每个章节至少要有一个知识点',
      'modal.generateTitle': '生成内容',
      'modal.generatePromptLabel': 'AI 生成提示（可留空）',
      'modal.generatePromptPlaceholder': '补充对这次生成的要求，例如：多用对比表格，先讲代价再讲收益；面向熟悉 Vue 的读者…',
      'modal.generatePromptAria': 'AI 生成提示',
      'modal.generateSubmit': '生成',
      'modal.keepLabel': '这个知识点已经有内容了，这次怎么处理？',
      'modal.keepOn': '保留原有内容，新内容追加在后面（推荐）',
      'modal.keepOff': '用新内容覆盖原有内容',
      'modal.keepHint': '旧正文会保留，新内容接在末尾；旧示意图也不会被覆盖。',
      'modal.overwriteHint': '原有正文与示意图会被替换，不可撤销。',
      'modal.promptCount': '{n} / {max} 字',
      'modal.promptTooLong': 'AI 备注太长了：最多 {max} 个字符（当前 {n}）',
      'modal.needSession': '还不知道要用哪个会话：先在左侧打开任意一个会话（新建一个也行），再回来点生成 —— 生成要由一个会话承载模型调用。',
      'modal.generate': '生成',
      'modal.generateKp': '生成这个知识点',
      'modal.generateChapter': '生成本章全部内容',
      'modal.generateCourse': '生成整门课内容',
      'modal.genScopeTitle': '批量生成内容',
      'modal.genScopeBody': '将对{scope}下的 {n} 个知识点逐个生成内容。',
      'modal.genScopeDetail': '已生成过的知识点会被覆盖。生成在后台进行，可以继续浏览。',
      'modal.genScopeConfirm': '开始生成',
      'modal.generating': '生成中…',
      'modal.generateAfterClose': '点「生成」后**弹窗会关闭**：进度与结果显示在大纲页顶部的进度条与每行行末的状态点上。',
      'modal.generateFallback': '「{type}」的专用格式尚未定稿：将按 Markdown 生成并展示（格式定稿后再补专用展示）。',
      'modal.taskState': '生成进度',
      'modal.taskStateValue': '{done} / {total} 个知识点已完成',
      'modal.taskFailed': '失败项',
      'modal.generateDeferred': '「{type}」的 **Markdown 格式尚未确认**，v1 不开放生成；格式定稿后再补生成与展示（05 §5.4 / 02 FR-7）。',
      'modal.generateM2': '生成链路在 M2 接入：宿主当前没有 generation.start 方法。',
      'modal.factKp': '知识点',
      'modal.factNo': '编号',
      'modal.factType': '内容类型',
      'modal.factDuration': '学习时长',
      'modal.factChapter': '所属章节',
      'modal.factAsset': '内容状态',
      'modal.factDurationNone': '未标注',
      'modal.factChapterValue': '第 {n} 章 · {name}',
      'modal.factStatusGenerated': '已生成',
      'modal.factStatusNotGenerated': '未生成',
      'modal.factLearnProgress': '学习进度：{state}',
      'modal.minutes': '{n} 分钟',

      'lesson.navPrev': '上一节',
      'lesson.navNext': '下一节',
      'lesson.navAria': '知识点导航',
      'lesson.duration': '学习时长 ',
      'lesson.minutes': '{n} 分钟',
      'lesson.emptyTitle': '尚未生成内容',
      'lesson.emptyBody': '这个知识点的内容资产还没有生成。生成后正文会落成本地 Markdown 文件，可以直接编辑。',
      'lesson.emptyAction': '生成此知识点',
      'lesson.contentLoading': '正在读取内容…',
      'lesson.loadErrorTitle': '内容读取失败',
      'lesson.regenerate': '重新生成内容',
      'lesson.slideNo': '第 {n} / {total} 页',
      'lesson.slideLabel': '第 {n} 页',
      'lesson.slidePos': '{n} / {total}',
      'lesson.slidePrev': '上一页',
      'lesson.slideNext': '下一页',
      'lesson.slideEmpty': '这份讲义里没有可展示的页面',
      'lesson.slideLayoutUnknown': '未知版式「{layout}」已按默认版式渲染。',
      'lesson.notes': '讲稿',
      'lesson.mediaCount': '本知识点含 {n} 个媒体文件（本地挂载）。',
      'lesson.formatPending': '「{type}」的专用格式尚未定稿：当前按 Markdown 降级展示。',
      'lesson.imageFallback': '（图片）',
      'lesson.imageAlt': '插图',
      'lesson.loading': '正在读取知识点…',
      'lesson.errorTitle': '读取知识点失败',
      'lesson.notFoundTitle': '知识点不存在',

      'state.gen.none': '未生成',
      'state.gen.queued': '排队中',
      'state.gen.doing': '生成中',
      'state.gen.done': '已生成',
      'state.gen.failed': '生成失败',
      'state.learn.start': '学习开始',
      'state.learn.doing': '学习中',
      'state.learn.done': '学习完成',
      'state.kp.未开始': '未开始',
      'state.kp.进行中': '进行中',
      'state.kp.已掌握': '已掌握',

      /* 主会话命令卡片（/ai-course 的实时状态）：阶段名与状态名 */
      'cmd.title': 'AI 课程',
      'cmd.deriving': '正在推导课程结构',
      'cmd.done': '已完成',
      'cmd.failed': '已失败',
      'cmd.step.start': '已收到诉求，正在交给模型',
      'cmd.step.derived': '已拿到课程结构，正在校验',
      'cmd.step.saving': '正在写入课程库',
      'cmd.step.done': '课程已生成',
      'cmd.stalled': '主程序已重启，状态已失效',
      'cmd.stalledHint': '这次推导的进度已经找不回来了',
      'cmd.elapsed': '已用时 {s} 秒',
      'cmd.elapsedMin': '已用时 {m} 分 {s} 秒',
      'cmd.ofCourse': '《{name}》',
      'cmd.open': '打开课程',

      'a11y.crumbs': '面包屑',
      'a11y.type': '类型：{type}',
      'a11y.progress': '学习进度 {pct}%',
      'a11y.genState': '{scope}生成状态：{state}',
      'a11y.learnState': '{scope}学习状态：{state}',
      'a11y.close': '关闭',
      'a11y.scopeCourse': '课程',
      'a11y.scopeChapter': '本章',
      'a11y.scopeKp': '知识点',
    },
    en: {
      'panel.title': 'AI Courses',

      'library.title': 'Course Library',
      'library.subtitleAll': '{n} courses · all stored locally',
      'library.subtitleFiltered': '{n} / {total} courses (filtered)',
      'library.config': 'Course library settings',
      'config.title': 'Course library settings',
      'config.courseRootLabel': 'Course library directory (courseRoot)',
      'config.courseRootHint': 'Default: ~/.dsh/ai-courses; ~ is expanded; must be an absolute path. Saving switches immediately; courses in the old directory are not moved or deleted.',
      'config.current': 'In effect: {path}',
      'config.source': 'Source: {source}',
      'config.sourceDefault': 'default',
      'config.sourceConfig': 'profile plugin config',
      'config.sourceSettings': 'UI setting',
      'config.defaultAction': 'Use default path',
      'config.save': 'Save and switch',
      'config.saving': 'Switching…',
      'config.loading': 'Reading current configuration…',
      'config.empty': 'The course library directory cannot be empty',
      'config.unsupported': 'This host cannot change the course library directory online; upgrade the plugin or edit courseRoot in the profile cordis.patch.yml.',
      'config.saved': 'Course library switched to {path}.',
      'config.settingsPath': 'Settings saved at: {path}',
      'config.tasksHint': 'A generation or course-derivation task is running; wait for it to finish before switching directories.',
      'config.writeFailed': 'Could not save the course library settings: {message}',
      'library.categoryLabel': 'Category:',
      'library.categoryAll': 'All categories',
      'library.searchPlaceholder': 'Search by name…',
      'library.searchLabel': 'Search courses by name',
      'library.tagbarLabel': 'Tags:',
      'library.tagbarCount': '{n} / {total} selected',
      'library.tagbarClear': 'Clear tags ({n})',
      'library.tagPick': 'Filter by this tag',
      'library.tagUnpick': 'Deselect this tag',
      'library.groupCount': '· {n}',
      'library.groupUncategorized': 'Uncategorized',
      'library.cardDifficulty': 'Difficulty {level}',
      'library.cardDeriving': 'Deriving',
      'library.cardDerivingHint': 'The outline is not ready yet, so both entries are disabled',
      'library.cardCorrupt': 'Course file is corrupt',
      'library.cardCorruptHint': 'Parsing failed, so it was degraded to empty; the original was kept as .corrupt-<timestamp>. Other courses are unaffected.',
      'library.cardReadOnly': 'Read-only: written by a newer version',
      'library.cardProgress': 'Learning progress',
      'library.cardOutline': 'Outline',
      'library.cardGenerated': '{n}/{total} generated',
      'lesson.diagram': 'Diagram',
      'lesson.diagramLoading': 'Drawing diagram…',
      'lesson.diagramFallback': 'Could not render the diagram ({reason}); its source is below:',
      'library.cardLearn': 'Learn',
      'library.cardLearnNoContent': 'No content yet: generate content from the outline first',
      'library.cardDelete': 'Delete',
      'library.deleteTitle': 'Delete course',
      'library.deleteBody': 'Delete “{name}”?',
      'library.deleteDetail': 'Its chapters, knowledge points, content assets and learning progress are removed **together** (the whole course directory), and this **cannot be undone**.',
      'library.deleteConfirm': 'Delete',
      'library.deleted': 'Deleted “{name}”.',
      'library.loading': 'Loading the course library…',
      'library.errorTitle': 'Failed to read the course library',
      'library.errorBody': 'The directory is unreadable or corrupt. The original file was kept as .corrupt-<timestamp>; other courses are unaffected.',
      'library.errorPath': '<courseRoot> is unreadable',
      'library.retry': 'Retry',
      'library.emptyTitle': 'No courses yet',
      'library.emptyBody': 'Describe your learning goal in the main session input box; the agent will generate the outline and knowledge points first.',
      'library.emptyHint': '/ai-course Explain React Server Components in 3 chapters',
      'library.emptyAction': 'Copy example',
      'library.emptyActionDone': 'Copied',
      'library.nomatchTitle': 'No matching courses',
      'library.nomatchBody': 'No results for the current filters — a different state from “the library is empty”.',
      'library.nomatchAction': 'Clear filters',

      'outline.crumbPage': 'Outline',
      'outline.generateCourse': 'Generate whole course',
      'outline.composeCourse': 'Edit course / generate all content',
      'outline.composeChapter': 'Edit chapter / generate its content',
      'outline.composeKp': 'Edit knowledge point / generate content',
      'outline.composeKpDone': 'Edit knowledge point / regenerate content',
      'outline.editCourseBasic': 'Edit course info (name / description / tags / difficulty)',
      'outline.structureEnter': 'Chapter editing: show add/remove buttons for chapters and knowledge points',
      'outline.structureExit': 'Exit chapter editing',
      'outline.addChapterAfter': 'Add a chapter after this one',
      'outline.removeChapter': 'Delete this chapter',
      'outline.addKpAfter': 'Add a knowledge point after this one',
      'outline.removeKp': 'Delete this knowledge point',
      'outline.editCourse': 'Edit course',
      'outline.generateChapter': 'Generate this chapter',
      'outline.editChapter': 'Edit chapter',
      'outline.generateKp': 'Generate content',
      'outline.regenerateKp': 'Regenerate content',
      'outline.editKp': 'Edit knowledge point',
      'dock.generating': 'Generating knowledge-point content for “{course}”',
      'dock.finished': 'Knowledge-point content ready for “{course}”',
      'dock.unknownCourse': 'course',
      'dock.writingKp': '· writing: {kp}',
      'dock.count': '{done} / {total}',
      'dock.openCourse': 'View outline',
      'outline.progressFailed': '{n} knowledge point(s) failed:',
      'outline.generateM2': '{label}: generation arrives in M2 — the host has no generation.start method yet.',
      'outline.chapterEmpty': 'This chapter has no knowledge point yet',
      'outline.loading': 'Loading the course…',
      'outline.errorTitle': 'Failed to read the course',
      'outline.notFoundTitle': 'Course not found',
      'outline.readOnlyNotice': 'Read-only: this course was written by a newer version, so this build only browses it.',
      'outline.corruptNotice': 'Course file is corrupt: degraded to empty and kept as a .corrupt-<timestamp> backup. Other courses are unaffected.',

      /* Main-session outline card (65-outline-card.js) */
      'outcard.title': 'Course outline',
      'outcard.editable': 'Editable here',
      'outcard.scale': '{chapters} chapters · {kps} knowledge points',
      'outcard.progress': 'Learning progress',
      'outcard.openOutline': 'Open the full outline',
      'outcard.collapse': 'Collapse the outline',
      'outcard.expand': 'Expand the outline',
      'outcard.loading': 'Loading the course…',
      'outcard.loadFailed': 'Could not read the course, so the outline is unavailable right now. Retry later or use “Open the full outline”.',

      'modal.cancel': 'Cancel',
      'modal.save': 'Save',
      'modal.close': 'Close',
      'modal.editCourseTitle': 'Edit course',
      'modal.editChapterTitle': 'Edit chapter',
      'modal.editKpTitle': 'Edit knowledge point',
      'modal.fieldName': 'Name',
      'modal.fieldDescription': 'Description',
      'modal.fieldDifficulty': 'Difficulty',
      'modal.fieldTags': 'Tags',
      'modal.fieldTagsHint': 'Two or three broad tags work best (for example: frontend, databases); separate them with commas',
      'modal.deleting': 'Deleting…',
      'modal.fieldType': 'Content type',
      'modal.structureTitle': 'Structure',
      'modal.newKpName': 'New knowledge point',
      'modal.moveUp': 'Move up',
      'modal.moveDown': 'Move down',
      'modal.addChapter': 'Add chapter below',
      'modal.removeChapter': 'Delete this chapter',
      'modal.removeKp': 'Delete this knowledge point',
      'modal.removeLastChapterHint': 'A course needs at least one chapter',
      'modal.removeLastKpHint': 'A chapter needs at least one knowledge point',
      'modal.generateTitle': 'Generate content',
      'modal.generatePromptLabel': 'AI prompt (optional)',
      'modal.generatePromptPlaceholder': 'Add requirements, e.g. prefer comparison tables, costs before benefits; for readers familiar with Vue…',
      'modal.generatePromptAria': 'AI prompt',
      'modal.generateSubmit': 'Generate',
      'modal.keepLabel': 'This knowledge point already has content — what should happen?',
      'modal.keepOn': 'Keep existing content and append the new part (recommended)',
      'modal.keepOff': 'Replace existing content with the new one',
      'modal.keepHint': 'The old body stays; new content is appended. Existing diagrams are preserved.',
      'modal.overwriteHint': 'The old body and diagrams will be replaced. This cannot be undone.',
      'modal.promptCount': '{n} / {max} characters',
      'modal.promptTooLong': 'The note is too long: at most {max} characters (currently {n})',
      'modal.needSession': 'No session to run the model call: open any session in the sidebar first (a new one works), then come back and generate.',
      'modal.generate': 'Generate',
      'modal.generateKp': 'Generate this knowledge point',
      'modal.generateChapter': 'Generate this chapter',
      'modal.generateCourse': 'Generate the whole course',
      'modal.genScopeTitle': 'Generate in batch',
      'modal.genScopeBody': 'This generates content for all {n} knowledge points in {scope}.',
      'modal.genScopeDetail': 'Existing content will be overwritten. Generation runs in the background.',
      'modal.genScopeConfirm': 'Start generating',
      'modal.generating': 'Generating…',
      'modal.generateAfterClose': 'After you press Generate **this dialog closes**: progress and results appear in the outline’s progress bar and each row’s status dot.',
      'modal.generateFallback': 'The dedicated format for “{type}” is not final yet: it will be generated and shown as Markdown.',
      'modal.taskState': 'Progress',
      'modal.taskStateValue': '{done} / {total} knowledge points done',
      'modal.taskFailed': 'Failed item',
      'modal.generateDeferred': 'The **Markdown format for “{type}” is not confirmed**, so v1 does not generate it; generation and presentation will follow once the format is settled (05 §5.4 / 02 FR-7).',
      'modal.generateM2': 'Generation arrives in M2: the host has no generation.start method yet.',
      'modal.factKp': 'Knowledge point',
      'modal.factNo': 'Number',
      'modal.factType': 'Content type',
      'modal.factDuration': 'Study duration',
      'modal.factChapter': 'Chapter',
      'modal.factAsset': 'Content status',
      'modal.factDurationNone': 'Not specified',
      'modal.factChapterValue': 'Chapter {n} · {name}',
      'modal.factStatusGenerated': 'Generated',
      'modal.factStatusNotGenerated': 'Not generated',
      'modal.factLearnProgress': 'Progress: {state}',
      'modal.minutes': '{n} min',

      'lesson.navPrev': 'Previous lesson',
      'lesson.navNext': 'Next lesson',
      'lesson.navAria': 'Knowledge point navigation',
      'lesson.duration': 'Study time ',
      'lesson.minutes': '{n} min',
      'lesson.emptyTitle': 'Content not generated yet',
      'lesson.emptyBody': 'This knowledge point has no content asset yet. Once generated, its body becomes a local Markdown file you can edit directly.',
      'lesson.emptyAction': 'Generate this knowledge point',
      'lesson.contentLoading': 'Loading the content…',
      'lesson.loadErrorTitle': 'Failed to load the content',
      'lesson.regenerate': 'Regenerate the content',
      'lesson.slideNo': 'Slide {n} / {total}',
      'lesson.slideLabel': 'Slide {n}',
      'lesson.slidePos': '{n} / {total}',
      'lesson.slidePrev': 'Previous slide',
      'lesson.slideNext': 'Next slide',
      'lesson.slideEmpty': 'This deck has no slide to show',
      'lesson.slideLayoutUnknown': 'Unknown layout “{layout}” was rendered with the default layout.',
      'lesson.notes': 'Speaker notes',
      'lesson.mediaCount': 'This knowledge point carries {n} local media file(s).',
      'lesson.formatPending': 'The dedicated format for “{type}” is not final yet: this is a Markdown fallback.',
      'lesson.imageFallback': '(image)',
      'lesson.imageAlt': 'Illustration',
      'lesson.loading': 'Loading the knowledge point…',
      'lesson.errorTitle': 'Failed to read the knowledge point',
      'lesson.notFoundTitle': 'Knowledge point not found',

      'state.gen.none': 'Not generated',
      'state.gen.queued': 'Queued',
      'state.gen.doing': 'Generating',
      'state.gen.done': 'Generated',
      'state.gen.failed': 'Generation failed',
      'state.learn.start': 'Not started',
      'state.learn.doing': 'In progress',
      'state.learn.done': 'Completed',
      'state.kp.未开始': 'Not started',
      'state.kp.进行中': 'In progress',
      'state.kp.已掌握': 'Mastered',

      /* Main-session command card (/ai-course live status): phase and state names */
      'cmd.title': 'AI Courses',
      'cmd.deriving': 'Deriving the course structure',
      'cmd.done': 'Done',
      'cmd.failed': 'Failed',
      'cmd.step.start': 'Request received, handing it to the model',
      'cmd.step.derived': 'Structure received, validating it',
      'cmd.step.saving': 'Writing to the course library',
      'cmd.step.done': 'Course created',
      'cmd.stalled': 'The host restarted, so this status is stale',
      'cmd.stalledHint': 'This run’s progress can no longer be recovered',
      'cmd.elapsed': '{s}s elapsed',
      'cmd.elapsedMin': '{m}m {s}s elapsed',
      'cmd.ofCourse': '“{name}”',
      'cmd.open': 'Open the course',

      'a11y.crumbs': 'Breadcrumb',
      'a11y.type': 'Type: {type}',
      'a11y.progress': 'Learning progress {pct}%',
      'a11y.genState': '{scope}generation status: {state}',
      'a11y.learnState': '{scope}study status: {state}',
      'a11y.close': 'Close',
      'a11y.scopeCourse': 'Course ',
      'a11y.scopeChapter': 'Chapter ',
      'a11y.scopeKp': 'Knowledge point ',
    },
  }

  const DEFAULT_LOCALE = 'zh-CN'

  /** 生成 `t(key, vars)`：查不到回退默认语言，再回退键名本身（不静默变空白）。 */
  function createT (locale) {
    const dict = LOCALES[locale] || LOCALES[DEFAULT_LOCALE]
    return function t (key, vars) {
      let s = dict[key]
      if (s === undefined) s = LOCALES[DEFAULT_LOCALE][key]
      if (s === undefined) return key
      if (!vars) return s
      return s.replace(/\{(\w+)\}/g, (m, name) => (vars[name] === undefined ? m : String(vars[name])))
    }
  }

  /** 宿主语言 → 本插件的 locale 键。取不到一律默认 zh-CN。 */
  function detectLocale (doc, nav) {
    const raw = String((doc && doc.documentElement && doc.documentElement.lang) || (nav && nav.language) || '').toLowerCase()
    if (raw.indexOf('en') === 0) return 'en'
    if (raw.indexOf('zh') === 0) return 'zh-CN'
    return DEFAULT_LOCALE
  }

  /**
   * 动态 `t(key, vars)`：**每次调用现读**宿主语言。
   *
   * 为什么不能在 apply 时 `createT(detectLocale(...))` 一次定死：
   * DSH 的 locale 插件在启动后才把 `<html lang>` 从服务端默认的 `en` 改成用户设置
   * （profile patch 里 `locale.preference: zh` 的情况）。apply 时读到的还是 `en`，
   * 于是整个面板一直显示英文。这里按 locale 缓存翻译器，语言变了下一次渲染就切过来。
   */
  function createLiveT (doc, nav) {
    const cache = new Map()
    return function t (key, vars) {
      const locale = detectLocale(doc, nav)
      let tr = cache.get(locale)
      if (!tr) {
        tr = createT(locale)
        cache.set(locale, tr)
      }
      return tr(key, vars)
    }
  }

  /* --------------------------------------------------- 编号（绝不解析 id） */
  /** 章节的人类编号：由 `order` 派生（05 §4 / 06 §4.2）。 */
  function chapterNo (ch) {
    const n = Number(ch && ch.order)
    return Number.isFinite(n) ? String(n) : ''
  }

  /** 知识点的人类编号：`<章节 order>.<知识点 order>`（**不是** kpId 里的数字）。 */
  function kpNo (ch, kp) {
    const c = Number(ch && ch.order)
    const k = Number(kp && kp.order)
    if (!Number.isFinite(c) || !Number.isFinite(k)) return ''
    return c + '.' + k
  }

  /** 大纲拍平成有序的 `[{ ch, kp, no }]`（学习页的上一节 / 下一节按它跨章节走）。 */
  function courseKps (course) {
    const out = []
    for (const ch of (course && course.outline && course.outline.chapters) || []) {
      for (const kp of ch.knowledgePoints || []) out.push({ ch: ch, kp: kp, no: kpNo(ch, kp) })
    }
    return out
  }

  /* ------------------------------------------------------------- 进度 */
  /** 知识点进度：缺省「未开始」（progress.json 只存知识点层，05 §5.3）。 */
  function kpProgress (kpProgressMap, kpId) {
    const v = (kpProgressMap || {})[kpId]
    return KP_STATES.indexOf(v) >= 0 ? v : '未开始'
  }

  function masteredCount (course, kpProgressMap) {
    return courseKps(course).reduce((n, x) => n + (kpProgress(kpProgressMap, x.kp.id) === '已掌握' ? 1 : 0), 0)
  }

  /** 课程进度 = 已掌握 / 总数；总数为 0 时定义为 0%（05 §6 的边界）。 */
  function progressRatio (total, mastered) {
    const t = Number(total) || 0
    if (t <= 0) return 0
    return Math.max(0, Math.min(1, (Number(mastered) || 0) / t))
  }

  /* --------------------------------------------------- 两套状态的派生 */
  /**
   * 单个知识点的生成状态。
   * @param {string[]} itemStates 该知识点在 tasks.json 里的任务项状态（running/pending/failed…），M2 才有
   * @param {boolean} hasAsset   内容资产信封是否存在（「已生成」的凭据，05 §5.4）
   *
   * M1 的宿主还没有任务表与内容资产（T-11），传进来恒为空 → 一律「未生成」。
   * 状态只由**真实证据**派生，这里不编造数据。
   */
  function kpGenState (itemStates, hasAsset) {
    const states = itemStates || []
    if (states.indexOf('running') >= 0) return '生成中'
    if (states.indexOf('pending') >= 0 || states.indexOf('queued') >= 0) return '排队中'
    if (states.indexOf('failed') >= 0) return '生成失败'
    if (hasAsset) return '已生成'
    return '未生成'
  }

  /**
   * 课程库排序：**更新时间降序**（06 §3.2）。
   *
   * 时间来自 `courses.list` 的 `updatedAt`（宿主取 `course.json` 与 `progress.json` 的 mtime 较晚者）。
   * 拿不到时间（`0`，例如端口不支持 mtime）时回落到 **id 降序** —— id 是 `c-<时间戳>-<hex>`，
   * 按 id 降序 ≈ 创建时间的倒序，是唯一可用的近似。
   * **稳定排序**：时间相同时保持原顺序（不抖动）。
   *
   * @param {Array} rows `courses.list` 的行
   * @returns {Array} 新数组（不改入参）
   */
  function sortCoursesByUpdated (rows) {
    const list = (rows || []).slice()
    return list
      .map((r, i) => ({ r: r, i: i }))
      .sort((a, b) => {
        const ta = Number(a.r && a.r.updatedAt) || 0
        const tb = Number(b.r && b.r.updatedAt) || 0
        /* 两端都有时间 → 按时间降序；时间**相同**就保持输入顺序（稳定，列表不抖动） */
        if (ta > 0 && tb > 0) return ta === tb ? a.i - b.i : tb - ta
        /* 时间不可用（0）→ 用 id 降序近似「创建时间倒序」（id 是 `c-<时间戳>-<hex>`） */
        if (ta !== tb) return tb - ta
        const ia = String((a.r && a.r.id) || '')
        const ib = String((b.r && b.r.id) || '')
        if (ia !== ib) return ia < ib ? 1 : -1
        return a.i - b.i
      })
      .map((x) => x.r)
  }

  /** 章节 / 课程级生成状态：按优先级聚合（06 §4.3）。 */
  function scopeGenState (states) {
    const list = states || []
    for (const want of GEN_PRIORITY) {
      if (list.indexOf(want) >= 0) return want
    }
    return '已生成'
  }

  /**
   * **本回合**生成的那几门课（主会话大纲卡片的判据，65-outline-card.js）。
   *
   * 为什么按时间而不是按 id：会话日志里没有「课程 ↔ 回合」的关联事件可用（04 号文档 E-30），
   * 所以用「落库时间落在回合时间窗内」判定 —— 精确到毫秒，且同一会话连做几次推导时
   * 每次各自落在自己的回合里。取不到回合起始时间时**返回空**（宁可不显示，也不每回合长一张卡）。
   *
   * @param {Array} courses 状态表给的课程摘要（`updatedAt` = 落库时间）
   * @param {object} turn   会话时间线上的回合（`start` / `end` 是 turn/start、turn/end 事件）
   */
  function coursesOfTurn (courses, turn) {
    const list = Array.isArray(courses) ? courses : []
    const startAt = turn && turn.start ? Number(turn.start.time) : NaN
    const endAt = turn && turn.end ? Number(turn.end.time) : NaN
    if (!Number.isFinite(startAt)) return []
    return list.filter((c) => {
      const at = Number(c && c.updatedAt)
      if (!Number.isFinite(at)) return false
      if (at < startAt) return false
      if (Number.isFinite(endAt) && at > endAt) return false
      return true
    })
  }

  /** 知识点学习状态（未开始 / 进行中 / 已掌握 → 三个展示态）。 */
  function kpLearnState (state) {
    if (state === '已掌握') return '学习完成'
    if (state === '进行中') return '学习中'
    return '学习开始'
  }

  /** 章节 / 课程级学习状态：全掌握 → 完成；任一非未开始 → 进行中；否则未开始。 */
  function scopeLearnState (states) {
    const list = states || []
    if (list.length > 0 && list.every((s) => s === '已掌握')) return '学习完成'
    if (list.some((s) => s !== '未开始')) return '学习中'
    return '学习开始'
  }

  /* ------------------------------------------------------------ 筛选 */
  /** 全库标签（按出现顺序去重）——标签 chip 行的数据源（06 §3.1）。 */
  function allTags (courses) {
    const seen = {}
    const out = []
    for (const c of courses || []) {
      for (const t of (c && c.tags) || []) {
        if (!seen[t]) { seen[t] = 1; out.push(t) }
      }
    }
    return out
  }

  function tagCount (courses, tag) {
    return (courses || []).filter((c) => ((c && c.tags) || []).indexOf(tag) >= 0).length
  }

  /**
   * 三个条件**叠加**：分类相等 + 名称包含（不区分大小写）+ 标签命中任一（OR）。
   * 纯函数：不读全局、不改入参（预览里读全局 `AIC.courses`，移植时收成显式入参）。
   */
  function filterCourses (courses, filter) {
    const f = filter || {}
    const q = String(f.query || '').trim().toLowerCase()
    const tags = f.tags || []
    return (courses || []).filter((c) => {
      if (f.category && c.category !== f.category) return false
      if (q && String(c.name || '').toLowerCase().indexOf(q) === -1) return false
      if (tags.length && !((c.tags || []).some((t) => tags.indexOf(t) >= 0))) return false
      return true
    })
  }

  /** 分类下拉的取值：按出现顺序去重，空分类不进列表。 */
  function allCategories (courses) {
    const seen = {}
    const out = []
    for (const c of courses || []) {
      const v = String((c && c.category) || '').trim()
      if (v && !seen[v]) { seen[v] = 1; out.push(v) }
    }
    return out
  }

  /** 按分类分组（顺序 = 过滤后首次出现），卡片网格按组渲染。 */
  function groupByCategory (courses) {
    const order = []
    const map = {}
    for (const c of courses || []) {
      const key = String((c && c.category) || '').trim()
      if (!map[key]) { map[key] = []; order.push(key) }
      map[key].push(c)
    }
    return order.map((key) => ({ category: key, courses: map[key] }))
  }

  /* ------------------------------------------------------------ 文案拼装 */
  /** 课程名最长 16 字，超出截断为 `…`（06 §4.4；与 host 的 NAME_MAX 同值）。 */
  const NAME_MAX = 16
  function truncateName (name) {
    const t = String(name === undefined || name === null ? '' : name)
    return t.length > NAME_MAX ? t.slice(0, NAME_MAX) + '…' : t
  }

  /** 进度控件里的章节标签：`<章节编号>-<章节名称>`。 */
  const chapterLabel = (ch) => chapterNo(ch) + '-' + String((ch && ch.name) || '')
  /** 进度控件里的知识点标签：`<知识点编号>-<知识点名称>`。 */
  const kpLabel = (ch, kp) => kpNo(ch, kp) + '-' + String((kp && kp.name) || '')

  /** 内容资产正文的相对路径（05 §5.1）——「未生成」空态要把它显示给用户。 */
  function contentRelPath (kpId, contentType) {
    return contentType === '幻灯片'
      ? 'content-assets/' + kpId + '.slides.md'
      : 'content-assets/' + kpId + '.md'
  }

  /* ------------------------------------------------- 「幻灯片」解析（05 §5.4.2 的子集） */

  /**
   * 解析 Slidev 方言的讲义：headmatter + 分页 + 每页 frontmatter + 页末讲稿。
   *
   * 为什么在客户端解析：host 只负责**存**（正文是权威内容，信封只是指针），
   * 播放器的分页 / 版式 / 讲稿是**展示**问题 —— 放这里就不必为「翻页」再往返一次 RPC。
   * 解析口径与 05 §5.4.2 的表格逐条对应，冒烟有真值表断言。
   *
   * @param {string} text 讲义 Markdown（含可有可无的 headmatter）
   * @returns `{ config, slides: [{ layout, title, body, notes, index }] }`
   */
  /**
   * 修复「不是合法 XML」的 SVG 文本（浏览器渲染 `<img src="*.svg">` 时按**严格 XML** 解析）。
   *
   * 只修一种真实出现过的损坏：**空元素没自闭合** —— 早期清洗器把 `<path … />` 写成 `<path …>`，
   * 于是 `mismatched tag`，图片静默不显示。这在真机上出现过三次，其中两次是「宿主进程还是旧代码」，
   * 所以这里给前端一条**不依赖宿主**的自救路径（媒体路由也有一份服务端自愈）。
   *
   * 纯函数、不碰 DOM；修完由调用方再用 DOMParser 校验。
   *
   * @param {string} text 磁盘上的 SVG 文本
   * @returns {string} 修复后的文本（本来就合法则原样返回）
   */
  function repairSvgText (text) {
    const src = String(text ?? '')
    /* ① 空元素补自闭合。**保留原名大小写**（`<path>` 就写 `<path />`）——
       早期版本这里把标签名写回小写，连 `viewBox` 都被顺手改成 `viewbox`，等于把图改坏。 */
    const VOID = new Set(['path', 'rect', 'circle', 'ellipse', 'line', 'polygon', 'polyline'])
    let out = src.replace(/<([A-Za-z][\w:-]*)((?:"[^"]*"|[^>"'])*?)(\/?)>/g, (m, rawName, attrs, selfClose) => {
      const name = rawName.toLowerCase()
      if (!VOID.has(name)) return m
      const a = String(attrs || '').replace(/\s+$/, '')
      return selfClose ? '<' + rawName + a + ' />' : '<' + rawName + a + ' />'
    })
    /* ② 同一元素重复属性 → 留第一个（`duplicate attribute` 也会让浏览器拒绝渲染）。
       **属性名保持原样大小写**（`viewBox` 不能变 `viewbox`）。 */
    out = out.replace(/<([A-Za-z][\w:-]*)((?:\s+[^\s=/>]+\s*=\s*(?:"[^"]*"|'[^']*'))+)\s*(\/?)>/g, (m, rawName, attrs, selfClose) => {
      const seen = new Set()
      const kept = []
      const re = /([^\s=/>]+)(\s*=\s*)("[^"]*"|'[^']*')/g
      let a
      while ((a = re.exec(attrs)) !== null) {
        const key = a[1].toLowerCase()
        if (seen.has(key)) continue
        seen.add(key)
        kept.push(a[1] + a[2] + a[3])
      }
      return '<' + rawName + (kept.length ? ' ' + kept.join(' ') : '') + (selfClose ? ' />' : '>')
    })
    return out
  }

  /**
   * 剥掉文首的 YAML frontmatter（`---` … `---`）。
   *
   * 为什么客户端也要做一遍：宿主**写文件时**会加 frontmatter（05 §5.4.1，让文件脱离应用也自描述），
   * 但学习页是按「文件正文」渲染的 —— 不剥就会把
   * ```
   * ---
   * title: 函数的概念与基本初等函数
   * ---
   * ```
   * 当成「分隔线 + 一段字面文本 + 分隔线」显示出来（真机上就是这样）。
   *
   * 判定要**窄**：必须①在文首；②闭合行存在；③块内每一非空行都像 `key: value`。
   * 否则像「`---` 分隔线 + 正文 + `---` 分隔线」这种合法正文会被误吃。
   */
  function stripFrontmatter (text) {
    const src = String(text ?? '')
    const head = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(src)
    if (!head) return src
    const lines = head[1].split('\n').map((l) => l.trim()).filter(Boolean)
    if (!lines.length) return src
    if (!lines.every((l) => /^[A-Za-z][\w-]*\s*:/.test(l))) return src
    return src.slice(head[0].length)
  }

  function parseSlidev (text) {
    const src = String(text ?? '')
    const config = {}
    let body = src
    const head = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(src)
    if (head) {
      for (const line of head[1].split('\n')) {
        const m = line.match(/^\s*([A-Za-z][\w-]*)\s*:\s*(.*)$/)
        if (m) config[m[1]] = m[2].trim().replace(/^["']|["']$/g, '')
      }
      body = src.slice(head[0].length)
    }
    const chunks = body.split(/\r?\n---\r?\n/)
    const slides = []
    /* ⚠️ Slidev 的**页 frontmatter** 写法是
         ```
         ---
         layout: center
         ---
         # 标题
         ```
       而按 `\n---\n` 切分时，那个 `--- … ---` 块会被切成**单独的一段**，段里只有
       `layout: center` 而没有任何正文 —— 早期版本会把它当成一张内容为空的幻灯片推进结果，
       于是每两页里就多出一张**空白页**（真机上「翻页时页面是空的」就是这么来的）。
       正确语义：页 frontmatter 属于**它后面的那一页**。所以这里把「只有元数据、没有正文」的段
       累积到 `pending`，合并进下一张真正的幻灯片。 */
    let pending = {}
    chunks.forEach((chunk, index) => {
      let text2 = String(chunk || '').trim()
      if (!text2) return
      const page = {}
      /* 页 frontmatter：优先认 `---` 块；**也容忍模型漏写围栏**（直接以 `layout: x` 开头）——
         两种都见过，容错比报错好（未知版式本来就会降级成 default）。 */
      const pf = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text2)
      let meta = pf ? pf[1] : ''
      if (pf) {
        text2 = text2.slice(pf[0].length).trim()
      } else {
        const loose = /^((?:[A-Za-z][\w-]*\s*:[^\n]*\n?)+)/.exec(text2)
        if (loose) {
          meta = loose[1]
          text2 = text2.slice(loose[0].length).trim()
        }
      }
      for (const line of meta.split('\n')) {
        const m = line.match(/^\s*([A-Za-z][\w-]*)\s*:\s*(.*)$/)
        if (m) page[m[1]] = m[2].trim().replace(/^["']|["']$/g, '')
      }
      /* 讲稿：该页**末尾**的 HTML 注释（页中注释不算，与 05 §5.4.2 一致） */
      let notes = ''
      const noteMatch = text2.match(/<!--([\s\S]*?)-->\s*$/)
      if (noteMatch) {
        notes = noteMatch[1].trim()
        text2 = text2.slice(0, noteMatch.index).trim()
      }
      /* 只有元数据、没有正文（也不带讲稿）→ 挂起，合并进下一张真幻灯片 */
      const merged = Object.assign({}, pending, page)
      if (!text2 && !notes) {
        pending = merged
        return
      }
      pending = {}
      const titleMatch = text2.match(/^#\s+(.+)$/m)
      slides.push({
        index: slides.length,
        layout: merged.layout || config.layout || 'default',
        title: merged.title || (titleMatch ? titleMatch[1].trim() : ''),
        body: text2,
        notes,
      })
    })
    return { config, slides }
  }

  /**
   * 从一页的正文里分出**页标题**（首个 `# …` 行）。
   *
   * 分开的理由：版式（`cover` / `center` / `two-cols` / `image-right` …）要靠
   * `.aic-slide__title` 这个**独立元素**来排版；标题如果混在正文流里，
   * 版式规则就无处可施（真机上「换版式看不出区别」就是这么来的）。
   *
   * @param {string} body 该页正文
   * @param {string} [fallback] 解析层已经取到的标题（页 frontmatter 的 `title:`）
   * @returns `{ title, text }` —— `text` 是**去掉标题行**之后的正文
   */
  function splitSlideTitle (body, fallback) {
    const src = String(body ?? '')
    /* 行首 H1；用 `[^\n]` 而不是 `.`+`$`（没有 `m` 标志时 `$` 只认串尾/末尾换行，会整个匹配不上） */
    const m = /^[ \t]*#[ \t]+([^\n]+?)[ \t]*(?:\n|$)/.exec(src)
    if (!m) return { title: String(fallback || '').trim(), text: src.trim() }
    return { title: String(fallback || m[1]).trim(), text: src.slice(m[0].length).trim() }
  }

  /** 版式子集（05 §5.4.2 → 06 §7.1）：未知一律按 `default` 渲染并给出提示。 */
  const SLIDE_LAYOUTS = ['default', 'cover', 'center', 'two-cols', 'two-cols-header', 'image-right', 'image-left', 'quote']
  function slideLayout (name) {
    const n = String(name || '').trim()
    return SLIDE_LAYOUTS.indexOf(n) >= 0 ? n : 'default'
  }

  /* ------------------------------------------------- 生成任务的展示态（06 §4.5） */

  /**
   * 生成任务快照 → 进度条要的展示数据（纯函数，可断言）。
   *
   * 为什么单独抽出来：「进度条上写了什么」是用户唯一能看到的生成状态，值得有真值表断言；
   * 而 React 组件本身离线不可渲染（09 §7.2 不做 mock 渲染）。
   *
   * @param {object|null} task `generation.status` 的任务快照
   * @param {object|null} course 当前课程（`scope=course` 时用它的名字）
   * @returns `{ visible, title, scope, finished, total, ratio, stateKey, active, failed: [] }`
   */
  function taskProgressView (task, course) {
    if (!task) return { visible: false, title: '', scope: '', finished: 0, total: 0, ratio: 0, stateKey: 'doing', active: false, failed: [] }
    const total = Number(task.total) || 0
    const done = Math.min(total, Math.max(0, Number(task.done) || 0))
    const failedCount = Math.min(total, Math.max(0, Number(task.failed) || 0))
    const finished = Math.min(total, done + failedCount)
    const stateKey = ({ queued: 'queued', running: 'doing', done: 'done', failed: 'failed', interrupted: 'failed' })[task.state] || 'doing'
    const scope = task.scope === 'course'
      ? (course && course.name ? course.name : '')
      : task.scope === 'chapter' ? 'chapter' : 'kp'
    return {
      visible: true,
      scope: scope,
      scopeIsCourse: task.scope === 'course',
      finished: finished,
      total: total,
      ratio: total ? finished / total : 0,
      stateKey: stateKey,
      active: task.state === 'queued' || task.state === 'running',
      failed: (task.items || []).filter((it) => it && it.state === 'failed'),
    }
  }

  /**
   * 状态卡还要不要继续轮询？
   *
   * 规则：
   *   · 命令已经结束（`command/done` 已到）→ 停；
   *   · 拿到状态且 phase 不是 running（done / error）→ 停；
   *   · 拿不到状态（宿主重启/还没写入）但命令还在跑 → **继续**（否则会错过整段推导）；
   *   · 状态仍是 running 且命令未结束 → 继续。
   */
  function shouldPollStatus (phase, settled) {
    if (settled) return false
    return !phase || phase === 'running'
  }

  /**
   * 新建章节时按 host 的默认规则算出的 id（`ch-NN`）；由客户端显式传给 addChapter。
   *
   * ⚠️ 不能用 `length + 1`：删掉中间章节后它会与已有 id 撞车
   * （[ch-01, ch-02, ch-03] 删 ch-02 后 length=2 → 又生成 ch-03）。
   * 取「已有数字后缀的最大值 + 1」，与 host 的 allocateId 同一口径。
   */
  function nextChapterId (chapters) {
    let max = 0
    for (const c of chapters || []) {
      const m = /^ch-(\d+)$/.exec(String((c && c.id) || ''))
      if (m) max = Math.max(max, Number(m[1]))
    }
    return 'ch-' + String(max + 1).padStart(2, '0')
  }

  /** 新建知识点时按 host 的默认规则算出的 id（`kp-<章节号>-NN`），避免同章重名。 */
  function nextKpId (ch) {
    /* 章节号优先从 **章节 id** 解析（host 的 addKp 也这么做）：
       · ch-100 → 100（`slice(-2)` 会退化成 00）；
       · 章节重排后 id 不变，KP id 前缀不会与别的章节撞车（order 会变）。 */
    const m = /^ch-(\d{2,3})$/.exec(String((ch && ch.id) || ''))
    const fromOrder = Number(ch && ch.order)
    const chNo = m
      ? m[1]
      : String(Number.isFinite(fromOrder) && fromOrder > 0 ? fromOrder : '0').padStart(2, '0')
    const re = new RegExp('^kp-' + chNo + '-(\\d+)$')
    let max = 0
    for (const k of (ch && ch.knowledgePoints) || []) {
      const km = re.exec(String((k && k.id) || ''))
      if (km) max = Math.max(max, Number(km[1]))
    }
    return 'kp-' + chNo + '-' + String(max + 1).padStart(2, '0')
  }

  return {
    CONTENT_TYPES,
    SUPPORTED_TYPES,
    DEFERRED_TYPES,
    DIFFICULTIES,
    KP_STATES,
    GEN_STATES,
    LEARN_STATES,
    STATE_DOT_CLASS,
    GEN_STATE_KEY,
    LEARN_STATE_KEY,
    GEN_CLASS,
    LEARN_CLASS,
    LOCALES,
    DEFAULT_LOCALE,
    createT,
    createLiveT,
    detectLocale,
    genSpec,
    learnSpec,
    chapterNo,
    kpNo,
    courseKps,
    kpProgress,
    masteredCount,
    progressRatio,
    kpGenState,
    scopeGenState,
    coursesOfTurn,
    kpLearnState,
    scopeLearnState,
    allTags,
    allCategories,
    groupByCategory,
    tagCount,
    filterCourses,
    NAME_MAX,
    truncateName,
    chapterLabel,
    kpLabel,
    contentRelPath,
    parseSlidev,
    taskProgressView,
    sortCoursesByUpdated,
    stripFrontmatter,
    repairSvgText,
    splitSlideTitle,
    slideLayout,
    SLIDE_LAYOUTS,
    nextChapterId,
    nextKpId,
    shouldPollStatus,
  }
})()
