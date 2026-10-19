/* ============================================================================
 * dsh-ai-courses — client 半边（外壳头）
 *
 * classic script：由宿主 clientModules 注入浏览器后立即执行。
 * 零构建工具链、零运行时依赖；React 从浏览器模块表 require('react') 获取。
 *
 * ⚠️ 本文件是**外壳**：`window.__ModuleLoader__.load({ id, factory })` 的形状逐行抄自
 *    在装可用的 dsh-notes-plugin / dsh-course-plugin（2026-10-14 实测生效）。
 *    `id` 必须等于包名；`label` 必须是函数；清理走 `ctx.effect`，不要从 apply 返回 disposer。
 *
 * package/lib/client.js = 本文件 + [构建期内联样式] + src/client/10…90*.js + 99-shell-tail.js
 * （由 scripts/build.mjs 拼接，**不要手改产物**）
 * ========================================================================== */

window.__ModuleLoader__.load({
  /* id 必须等于包名（宿主按它寻址本插件的 client 半边） */
  id: 'dsh-ai-courses',

  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    'use strict'

    const React = require('react')
    /* react-dom 只为 `createPortal`：弹窗 portal 到 body（对话流的滚动容器带容器查询，
       会成为 `position: fixed` 的包含块 —— 见 60-modals.js 的说明）。 */
    const ReactDOM = require('react-dom')
    const h = React.createElement

    /* ---------------------------------------------------------------------- */
    /* 插件内导航总线（供「主会话的大纲卡片」→「课程面板」跳转）。
       卡片与面板是**同一插件的两个槽位实例**，各自持有 React 状态、彼此没有父子关系，
       而面板的导航状态在 `AicCoursesApp` 内部。一条极小的订阅表就够；
       它只活在本插件自己的脚本作用域里，**不挂 window**、不外泄。 */
    /**
     * 打开某门课的某个视图：**先发导航、再切面板**。
     *
     * 为什么必须是这个顺序：课程面板是「切过去才挂载」的，反过来的话广播时还没有监听器
     * （`AIC_NAV` 有挂起补发兜底，但顺序对了就不必依赖它）。
     * 为什么要有这个函数：主会话里**三个入口**（命令卡片 / 大纲卡片 / 常驻状态条）都要跳课程，
     * 早先各自只调了 `AIC_NAV.open`，面板没打开时就"点了没反应"（真机踩过）。
     */
    function aicOpenCourseIn (ctx, courseId, view) {
      try {
        if (courseId) AIC_NAV.open(courseId, view || 'outline')
      } catch (err) {
        console.warn('[ai-courses] 打开课程失败：', err && err.message)
      }
      try {
        const layout = ctx && typeof ctx.get === 'function' ? ctx.get('layout') : null
        if (layout && typeof layout.selectPanel === 'function') layout.selectPanel('ai-courses')
      } catch (err) {
        console.warn('[ai-courses] 切换面板失败：', err && err.message)
      }
    }

    const AIC_NAV_LISTENERS = new Set()
    /* 面板**还没挂载**时先存下这次请求：从主会话卡片点「打开课程」会先发导航、再切面板，
       而面板是切过去才挂载 —— 直接广播会丢掉这一次（真机上就是"点了没反应"）。 */
    let AIC_NAV_PENDING = null
    const AIC_NAV = {
      /** 请求把课程面板切到某门课的某个视图（`outline` / `lesson`）。 */
      open: function (courseId, view, kpId) {
        const req = { courseId: courseId, view: view || 'outline', kpId: kpId || null }
        if (!AIC_NAV_LISTENERS.size) AIC_NAV_PENDING = req
        AIC_NAV_LISTENERS.forEach(function (fn) {
          try { fn(req) } catch (err) {
            console.warn('[ai-courses] 导航监听器失败：', err && err.message)
          }
        })
      },
      /** 订阅；返回退订函数（组件卸载时调用）。挂载时若有**挂起**的请求，立刻补发一次。 */
      on: function (fn) {
        AIC_NAV_LISTENERS.add(fn)
        if (AIC_NAV_PENDING) {
          const req = AIC_NAV_PENDING
          AIC_NAV_PENDING = null
          try { fn(req) } catch (err) {
            console.warn('[ai-courses] 导航监听器失败：', err && err.message)
          }
        }
        return function () { AIC_NAV_LISTENERS.delete(fn) }
      },
    }

/* ---- 样式：构建期内联（同一个文件也以真实文件随包发布）---- */

const AIC_COURSES_CSS = "/* ============================================================================\n   AI 课程插件样式（交付物：package/lib/styles.css）\n   由 scripts/build.mjs 内联进 lib/client.js，同时以真实文件形式随包发布\n\n   约束（来自 06-ui-design.md §4）：\n     · 只用 14 个宿主主题 token；字面颜色零出现（artwork 除外）\n     · 所有 class 带 aic- 前缀（与宿主/其他插件共用同一文档）\n     · 需要「比边框更醒目又不写字面色」时，朝前景色混色 —— 两个主题自动正确\n     · 明暗两套都成立\n   ============================================================================ */\n\n.aic-root,\n.aic-shell {\n  color: var(--dsw-alias-label-primary);\n  background: var(--dsw-alias-bg-base);\n  font-size: 13px;\n  line-height: 1.55;\n  -webkit-font-smoothing: antialiased;\n}\n\n.aic-root { height: 100%; }\n\n/* 高度链：html/body → .aic-root → .aic-shell 都是确定高度，\n   这样页面内部的 height:100% 才有参照物（百分比高度在 auto 父级上会被当成 auto）。 */\n.aic-shell {\n  display: flex;\n  height: 100%;\n  min-height: 0;\n}\n\n.aic-main {\n  flex: 1 1 auto;\n  min-width: 0;\n  min-height: 0;\n  /* **唯一的滚动容器**（课程库 / 大纲 / 学习三页共用）：\n     `scrollbar-gutter: stable` 预留给滚动条，避免内容一长一短时整列横向抖动 */\n  overflow-y: auto;\n  overflow-x: hidden;\n  scrollbar-gutter: stable;\n  padding: 20px 24px 40px;\n}\n\n/* --- 大纲页根容器：高度默认 100%（撑满所在列，内容更高时由列滚动） --- */\n.aic-outline {\n  height: 100%;\n  min-height: 0;\n  display: flex;\n  flex-direction: column;\n}\n\n/* --- 大纲页头 --- */\n.aic-outline__head { margin-bottom: 16px; }\n.aic-outline__titlerow { display: flex; align-items: center; gap: 12px; }\n.aic-outline__titlerow .aic-h1 { flex: 1 1 auto; min-width: 0; margin: 0; }\n\n/* --- 通用排版 --- */\n.aic-h1 { font-size: 17px; font-weight: 600; margin: 0 0 2px; }\n.aic-h2 { font-size: 14px; font-weight: 600; margin: 0 0 8px; }\n.aic-sub { color: var(--dsw-alias-label-secondary); margin: 0; }\n.aic-muted { color: var(--dsw-alias-label-secondary); }\n.aic-pagehead {\n  display: flex;\n  align-items: flex-start;\n  justify-content: space-between;\n  gap: 16px;\n  margin-bottom: 16px;\n}\n\n/* --- 工具栏 --- */\n.aic-toolbar {\n  display: flex;\n  gap: 8px;\n  align-items: center;\n  flex-wrap: wrap;\n  margin-bottom: 16px;\n}\n.aic-input,\n.aic-select {\n  height: 30px;\n  padding: 0 10px;\n  font: inherit;\n  color: var(--dsw-alias-label-primary);\n  background: var(--dsw-alias-bg-layer-1);\n  border: 1px solid var(--dsw-alias-border-l2);\n  border-radius: 6px;\n}\n.aic-input { min-width: 200px; }\n.aic-input::placeholder { color: var(--dsw-alias-label-secondary); }\n.aic-input:focus-visible,\n.aic-select:focus-visible,\n.aic-btn:focus-visible,\n.aic-navbtn:focus-visible {\n  outline: 2px solid var(--dsw-alias-brand-primary);\n  outline-offset: 1px;\n}\n\n.aic-btn {\n  /* inline-flex + gap：让「图标 + 文字」的按钮能对齐；纯文字按钮同样正常 */\n  display: inline-flex;\n  align-items: center;\n  gap: 6px;\n  height: 30px;\n  padding: 0 12px;\n  font: inherit;\n  border-radius: 6px;\n  border: 1px solid var(--dsw-alias-border-l2);\n  background: var(--dsw-alias-bg-layer-1);\n  color: var(--dsw-alias-label-primary);\n  cursor: pointer;\n  white-space: nowrap;\n}\n.aic-btn:hover { background: var(--dsw-alias-bg-layer-2); }\n.aic-btn--primary {\n  background: var(--dsw-alias-brand-primary);\n  color: var(--dsw-alias-bg-base);\n  border-color: var(--dsw-alias-brand-primary);\n}\n.aic-btn--primary:hover { opacity: .88; } /* 悬停用不透明度，避免引入字面色 */\n.aic-btn--quiet { border-color: transparent; background: transparent; }\n.aic-btn--quiet:hover { background: var(--dsw-alias-bg-layer-2); }\n.aic-btn[disabled] { opacity: .5; cursor: not-allowed; }\n.aic-btn--sm { height: 24px; padding: 0 8px; font-size: 12px; }\n\n/* --- 标签筛选行（取代原来的标签下拉） --- */\n/* 标签控制区**不是卡片**：无边框、无圆角、无底色、无内边距 ——\n   内容与工具栏、分组标题左对齐，直接排在页面上。 */\n.aic-tagbar {\n  display: flex;\n  align-items: flex-start;\n  gap: 8px;\n  flex-wrap: wrap;\n  margin-bottom: 16px;\n}\n.aic-tagbar__label {\n  color: var(--dsw-alias-label-secondary);\n  flex: 0 0 auto;\n  padding-top: 2px;\n}\n.aic-tagbar__list { display: flex; gap: 6px; flex-wrap: wrap; flex: 1 1 auto; min-width: 0; }\n.aic-tagbar__clear { flex: 0 0 auto; }\n.aic-tagbar__count {\n  flex: 0 0 auto;\n  color: var(--dsw-alias-label-secondary);\n}\n\n/* 标签控件：选中态即过滤条件 */\n.aic-chip {\n  font: inherit;\n  font-size: 12px;\n  height: 24px;\n  padding: 0 10px;\n  border-radius: 999px;\n  cursor: pointer;\n  border: 1px solid var(--dsw-alias-border-l2);\n  background: var(--dsw-alias-bg-layer-1);\n  color: var(--dsw-alias-label-secondary);\n}\n.aic-chip:hover { background: var(--dsw-alias-bg-layer-2); }\n.aic-chip[aria-pressed=\"true\"] {\n  background: var(--dsw-alias-brand-primary);\n  border-color: var(--dsw-alias-brand-primary);\n  color: var(--dsw-alias-bg-base);   /* brand-primary 的天然反色，明暗两套都成立 */\n  font-weight: 600;\n}\n.aic-chip__count { opacity: .7; margin-left: 4px; }\n.aic-chip:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 1px; }\n\n/* --- 徽标 / 标签 --- */\n.aic-badge {\n  display: inline-flex;\n  align-items: center;\n  gap: 4px;\n  height: 20px;\n  padding: 0 7px;\n  border-radius: 5px;\n  font-size: 11px;\n  border: 1px solid var(--dsw-alias-border-l2);\n  color: var(--dsw-alias-label-secondary);\n  background: var(--dsw-alias-bg-layer-2);\n}\n.aic-badge--type { color: var(--dsw-alias-label-primary); }\n.aic-tag--on {\n  border-color: var(--dsw-alias-brand-primary);\n  color: var(--dsw-alias-label-primary);\n}\n.aic-tag {\n  display: inline-block;\n  padding: 1px 7px;\n  border-radius: 999px;\n  font-size: 11px;\n  color: var(--dsw-alias-label-secondary);\n  border: 1px solid var(--dsw-alias-border-l2);\n}\n\n/* 进度状态点：用状态 token，且**不只用颜色**表达（06 §8 无障碍） */\n.aic-dot {\n  width: 7px; height: 7px; border-radius: 50%;\n  flex: 0 0 auto;\n  background: var(--dsw-alias-state-idle-primary);\n}\n.aic-dot--doing { background: var(--dsw-alias-state-warn-primary); }\n.aic-dot--done  { background: var(--dsw-alias-state-success-primary); }\n.aic-dot--fail  { background: var(--dsw-alias-state-error-primary); }\n\n/* --- 进度条 --- */\n.aic-progress {\n  height: 6px;\n  border-radius: 999px;\n  background: var(--dsw-alias-state-idle-primary);\n  overflow: hidden;\n}\n.aic-progress__bar {\n  height: 100%;\n  background: var(--dsw-alias-brand-primary);\n  border-radius: 999px;\n}\n/* 课程卡片里的进度：占满卡片内容宽度，标签在上、条在下 */\n.aic-card__progress { display: flex; flex-direction: column; gap: 4px; }\n.aic-card__progress .aic-progress { width: 100%; }\n\n/* --- 课程卡片 --- */\n.aic-group { margin-bottom: 22px; }\n.aic-group__head {\n  display: flex; align-items: baseline; gap: 8px;\n  margin: 0 0 8px;\n  color: var(--dsw-alias-label-secondary);\n  font-size: 12px;\n}\n.aic-grid {\n  display: grid;\n  grid-template-columns: repeat(auto-fill, minmax(300px, 1fr));\n  gap: 10px;\n}\n.aic-card {\n  border: 1px solid var(--dsw-alias-border-l2);\n  border-radius: 10px;\n  padding: 12px 13px;\n  background: var(--dsw-alias-bg-layer-1);\n  display: flex;\n  flex-direction: column;\n  gap: 8px;\n}\n.aic-card__name { font-weight: 600; font-size: 13.5px; }\n.aic-card__desc {\n  color: var(--dsw-alias-label-secondary);\n  display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical;\n  overflow: hidden;\n}\n.aic-card__meta { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }\n.aic-card__actions { display: flex; gap: 6px; margin-top: 2px; justify-content: flex-end; }\n\n/* --- 大纲：章节与知识点（章节**不是卡片**：无边框、无圆角、无底色） --- */\n.aic-chapter { margin-bottom: 22px; }\n.aic-chapter__head {\n  display: flex; align-items: center; gap: 10px;\n  padding: 0 0 8px;\n  border-bottom: 1px solid var(--dsw-alias-border-l2);   /* 分隔线，不是卡片边框 */\n}\n.aic-chapter__no {\n  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;\n  font-size: 11px;\n  color: var(--dsw-alias-label-secondary);\n  flex: 0 0 auto;\n}\n.aic-chapter__title { font-weight: 600; font-size: 14px; flex: 1 1 auto; min-width: 0; }\n.aic-chapter__body { padding: 0; }\n.aic-kp {\n  display: flex; align-items: center; gap: 10px;\n  padding: 8px 0 8px 14px;                                /* 左缩进表达从属关系 */\n}\n.aic-kp__no {\n  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;\n  font-size: 11px;\n  color: var(--dsw-alias-label-secondary);\n  flex: 0 0 auto;\n  min-width: 31px;   /* 原来是 62px —— 编号后的留白太大，减半 */\n}\n.aic-kp__type {\n  display: inline-flex; align-items: center;\n  color: var(--dsw-alias-label-secondary);\n  flex: 0 0 auto;\n}\n\n/* 知识点状态图标：4 态（未生成 / 已生成未开始 / 已生成进行中 / 已生成已掌握）\n   ⚠️ 其中「已生成未开始」与「已生成进行中」形状相同（实心圆），只靠颜色区分\n      —— 这两态对色觉障碍用户不可分；缓解手段是 aria-label/title 给全文字。\n      详见 06 号文档 §3.5.5。 */\n/* ---- 两套状态图标（生成 / 学习），互不替代 ---- */\n.aic-genstate, .aic-learnstate { display: inline-flex; align-items: center; flex: 0 0 auto; }\n.aic-genstate { margin-left: 6px; }\n.aic-learnstate { margin-left: 6px; }\n/* ① AI 生成状态：未生成/排队中 = 灰空心；生成中 = 橙实心；已生成 = 绿实心；生成失败 = 红空心 */\n.aic-genstate--idle { color: var(--dsw-alias-state-idle-primary); }\n.aic-genstate--warn { color: var(--dsw-alias-state-warn-primary); }\n.aic-genstate--success { color: var(--dsw-alias-state-success-primary); }\n.aic-genstate--error { color: var(--dsw-alias-state-error-primary); }\n/* ② 学习状态：学习开始/学习中 = 黑（前景色）；学习完成 = 绿 */\n.aic-learnstate--primary { color: var(--dsw-alias-label-primary); }\n.aic-learnstate--success { color: var(--dsw-alias-state-success-primary); }\n\n/* 行内右侧成组对齐：进度 / 图标按钮 / 状态点 */\n/* 结构模式（章节编辑）里的 +/- 按钮组：排在编号**前面**，与右侧行内控件分开 */\n.aic-structops {\n  display: inline-flex;\n  align-items: center;\n  gap: 2px;\n  margin-right: 6px;\n}\n/* 结构模式的 +/-：**圆形**按钮（描边圆 + 居中字形）。\n   为什么不用默认的圆角方块：它们排在编号前面、成对出现，圆形读起来像「加减一个条目」，\n   与右侧那些「打开某个东西」的方形图标按钮在形状上就能区分开。 */\n.aic-structops .aic-iconbtn {\n  width: 20px; height: 20px;\n  border-radius: 50%;\n  border: 1px solid var(--dsw-alias-border-l2);\n  background: transparent;\n  color: var(--dsw-alias-label-secondary);\n}\n.aic-structops .aic-iconbtn:hover:not([disabled]) {\n  border-color: var(--dsw-alias-label-secondary);\n  color: var(--dsw-alias-label-primary);\n  background: transparent;\n}\n.aic-structops .aic-iconbtn[disabled] {\n  color: var(--dsw-alias-state-idle-primary);\n  border-color: var(--dsw-alias-border-l1);\n  cursor: default;\n}\n.aic-structops .aic-iconbtn svg { width: 11px; height: 11px; }\n\n.aic-row__right {\n  display: inline-flex; align-items: center; gap: 8px;\n  flex: 0 0 auto;\n}\n\n/* 图标按钮：无边框、无底色；悬停/聚焦才出现反馈（工具提示由 title + aria-label 承担） */\n.aic-iconbtn {\n  display: inline-grid; place-items: center;\n  width: 24px; height: 24px;\n  padding: 0;\n  border: 0;\n  border-radius: 6px;\n  background: transparent;\n  color: var(--dsw-alias-label-secondary);\n  cursor: pointer;\n}\n.aic-iconbtn:hover { background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-primary); }\n.aic-iconbtn--on { background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-primary); }\n.aic-iconbtn:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 1px; }\n/* 图标按钮禁用态（结构模式的 +/- 会用到）：收敛为灰、不给悬停反馈 */\n.aic-iconbtn[disabled] { color: var(--dsw-alias-state-idle-primary); cursor: default; }\n.aic-iconbtn[disabled]:hover { background: transparent; color: var(--dsw-alias-state-idle-primary); }\n\n/* 「章节编辑」开关：**默认灰、选中黑**，不铺底色（用户需求 2026-10-18）。\n   用 `[aria-pressed]` 而不是再加一个类：状态本来就由 aria 表达，样式跟着它走不会跑偏。 */\n.aic-iconbtn--structure { color: var(--dsw-alias-label-secondary); background: transparent; }\n.aic-iconbtn--structure[aria-pressed=\"true\"] { color: var(--dsw-alias-label-primary); background: transparent; }\n.aic-iconbtn--structure:hover { background: var(--dsw-alias-bg-layer-2); }\n.aic-iconbtn--structure[aria-pressed=\"true\"]:hover { color: var(--dsw-alias-label-primary); }\n.aic-kp + .aic-kp { border-top: 1px solid var(--dsw-alias-border-l1); }\n/* 本章最后一行的下方也要有线：把知识点列表「收口」，否则末行看着像悬空 */\n.aic-chapter__body > .aic-kp:last-child { border-bottom: 1px solid var(--dsw-alias-border-l1); }\n.aic-kp__name { flex: 1 1 auto; min-width: 0; }\n.aic-kp__name[role=\"button\"] { cursor: pointer; }\n.aic-kp__name[role=\"button\"]:hover { text-decoration: underline; }\n.aic-kp__tools { display: flex; gap: 6px; align-items: center; }\n\n/* --- 面包屑（学习页顶部区域） --- */\n.aic-crumbs { margin-bottom: 8px; }\n.aic-crumbs__list {\n  display: flex; flex-wrap: wrap; align-items: center;\n  gap: 4px; margin: 0; padding: 0; list-style: none;\n}\n.aic-crumbs__item { display: inline-flex; align-items: center; gap: 4px; }\n.aic-crumbs__sep { color: var(--dsw-alias-label-secondary); }\n.aic-crumbs__link {\n  font: inherit; padding: 0; border: 0; border-radius: 3px;\n  background: transparent; cursor: pointer;\n  color: var(--dsw-alias-label-secondary);\n}\n.aic-crumbs__link:hover { color: var(--dsw-alias-label-primary); text-decoration: underline; }\n.aic-crumbs__link:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 2px; }\n.aic-crumbs__current { color: var(--dsw-alias-label-primary); }\n\n/* --- 学习页 meta 行（学习时长） --- */\n.aic-lesson__meta { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }\n.aic-duration {\n  display: inline-flex; align-items: center; gap: 5px;\n  color: var(--dsw-alias-label-secondary);\n}\n\n/* 只给读屏用的文本：视觉隐藏但不脱离可访问树 */\n.aic-sr-only {\n  position: absolute;\n  width: 1px; height: 1px;\n  margin: -1px; padding: 0; border: 0;\n  overflow: hidden;\n  clip: rect(0 0 0 0);\n  clip-path: inset(50%);\n  white-space: nowrap;\n}\n\n/* --- 学习页 --- */\n/* 学习页：**宽度 100% 撑满所在容器**（不再限宽 860px —— 内容列跟着面板宽度走）。\n *\n * ⚠️ **滚动只留一层**（`.aic-main`）。这里曾经给 `.aic-lesson` 定了 `height:100%`、\n * 又给 `.aic-lesson__body` 加 `overflow:auto`，于是出现**两个滚动容器**：\n *   · 内层（body）的滚动条左边是内容、右边还有 `.aic-main` 的 `padding-right: 24px` ——\n *     正是用户看到的「滚动条右侧仍有空白区」；\n *   · 内层高度还是「`.aic-main` 的内容高 − pagehead」，算出来常常比实际可见高度长，\n *     于是外层也跟着能滚（双层滚动）。\n * 现在：`.aic-lesson` 用 `min-height: 100%`（短内容仍撑满一屏、导航卡落底），\n * 高度不给上限、内部不滚动 —— 长内容自然撑高，滚动统一交给 `.aic-main`（垫到一个滚动条宽，\n * 布局不会随滚动条出现/消失而横向跳动）。 */\n.aic-lesson {\n  width: 100%;\n  min-height: 100%;\n  display: flex;\n  flex-direction: column;\n}\n.aic-lesson__body { flex: 1 1 auto; min-height: 0; }\n/* 内容列跟着撑高；导航卡在内容短时仍被推到底部 */\n.aic-lesson__inner { flex: 1 1 auto; display: flex; flex-direction: column; }\n.aic-lesson__content { flex: 1 1 auto; min-width: 0; }\n\n/* --- 内容底部：上一节 / 下一节 导航卡 --- */\n.aic-lesson__nav {\n  display: grid;\n  grid-template-columns: 1fr 1fr;\n  gap: 12px;\n  margin-top: 24px;\n  padding-top: 18px;\n  border-top: 1px solid var(--dsw-alias-border-l2);   /* 与正文划分区域 */\n}\n.aic-navcard {\n  display: flex; flex-direction: column; gap: 4px;\n  min-width: 0; padding: 10px 12px;\n  font: inherit; text-align: left;\n  border: 1px solid var(--dsw-alias-border-l1);\n  border-radius: 8px;\n  background: var(--dsw-alias-bg-layer-1);\n  color: var(--dsw-alias-label-primary);\n  cursor: pointer;\n}\n.aic-navcard:hover { border-color: var(--dsw-alias-border-l2); background: var(--dsw-alias-bg-layer-2); }\n.aic-navcard:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 2px; }\n.aic-navcard--next { text-align: right; }\n.aic-navcard--next .aic-navcard__dir { justify-content: flex-end; }\n.aic-navcard__dir {\n  display: inline-flex; align-items: center; gap: 5px;\n  color: var(--dsw-alias-label-secondary); font-size: 12px;\n}\n.aic-navcard__name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }\n/* 首节/末节没有相邻项 → 等宽占位，保持两列对齐 */\n.aic-navcard--empty { visibility: hidden; }\n.aic-lesson__head {\n  display: flex; align-items: center; gap: 8px;\n  margin-bottom: 14px; flex-wrap: wrap;\n}\n.aic-prose { font-size: 13.5px; }\n.aic-prose h1 { font-size: 19px; margin: 18px 0 8px; }\n.aic-prose h2 { font-size: 16px; margin: 16px 0 6px; }\n.aic-prose h3 { font-size: 14px; margin: 14px 0 6px; }\n.aic-prose p { margin: 8px 0; }\n.aic-prose ul, .aic-prose ol { margin: 8px 0; padding-left: 22px; }\n.aic-prose li { margin: 3px 0; }\n.aic-prose code {\n  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;\n  font-size: 12px;\n  padding: 1px 5px;\n  border-radius: 4px;\n  background: var(--dsw-alias-bg-layer-2);\n  border: 1px solid var(--dsw-alias-border-l1);\n}\n.aic-prose pre {\n  margin: 10px 0;\n  padding: 11px 13px;\n  border-radius: 8px;\n  overflow: auto;\n  background: var(--dsw-alias-bg-layer-2);\n  border: 1px solid var(--dsw-alias-border-l2);\n}\n.aic-prose pre code { border: 0; background: transparent; padding: 0; }\n\n/* --- 代码高亮 token（映射自 highlight.js；只用宿主主题 token，见 check.mjs 的白名单） ---\n   为什么不用 highlight.js 自带主题：那些主题写的是字面色值，与本插件「零字面颜色 +\n   只用 14 个主题 token」的约束冲突。这里按语义挑色，深浅主题都能看清。 */\n.aic-code { position: relative; }\n.aic-tok-keyword { color: var(--dsw-alias-brand-primary); font-weight: 600; }\n.aic-tok-string { color: var(--dsw-alias-state-success-primary); }\n.aic-tok-number { color: var(--dsw-alias-state-warn-primary); }\n.aic-tok-comment { color: var(--dsw-alias-label-secondary); font-style: italic; }\n.aic-tok-title { color: var(--dsw-alias-brand-primary); }\n.aic-tok-attr { color: var(--dsw-alias-label-primary); font-weight: 500; }\n.aic-tok-type { color: var(--dsw-alias-state-error-primary); }\n.aic-tok-meta { color: var(--dsw-alias-state-idle-primary); }\n.aic-tok-punct { color: var(--dsw-alias-label-secondary); }\n.aic-prose blockquote {\n  margin: 10px 0; padding: 2px 0 2px 12px;\n  border-left: 3px solid var(--dsw-alias-border-l2);\n  color: var(--dsw-alias-label-secondary);\n}\n.aic-prose table { border-collapse: collapse; margin: 10px 0; }\n.aic-prose th, .aic-prose td {\n  border: 1px solid var(--dsw-alias-border-l2);\n  padding: 5px 9px; text-align: left;\n}\n.aic-prose th { background: var(--dsw-alias-bg-layer-2); font-weight: 600; }\n.aic-prose img { max-width: 100%; border-radius: 8px; }\n.aic-figure {\n  margin: 10px 0; padding: 10px;\n  border: 1px dashed var(--dsw-alias-border-l2);\n  border-radius: 8px;\n  color: var(--dsw-alias-label-secondary);\n  text-align: center;\n  font-size: 12px;\n}\n.aic-link { color: var(--dsw-alias-label-primary); text-underline-offset: 2px; }\n\n/* --- 幻灯片（Slidev 子集）：播放器形态 --- */\n/* 上部展示区：一次只放一页 */\n.aic-player {\n  border: 1px solid var(--dsw-alias-border-l2);\n  border-radius: 10px;\n  background: var(--dsw-alias-bg-layer-1);\n  padding: 14px;\n}\n.aic-player .aic-slide { border: 0; background: transparent; padding: 12px 16px; }\n/* 控制条：上一页 / 页码 / 下一页 */\n.aic-player__bar {\n  display: flex; align-items: center; justify-content: center; gap: 12px;\n  margin-top: 12px;\n}\n.aic-player__pos {\n  color: var(--dsw-alias-label-secondary);\n  font-variant-numeric: tabular-nums;\n  min-width: 56px; text-align: center;\n}\n/* 下部：当前页讲稿 */\n.aic-notes {\n  margin-top: 20px;\n  padding-top: 14px;\n  border-top: 1px solid var(--dsw-alias-border-l2);\n}\n.aic-notes .aic-h2 { margin: 0 0 8px; font-size: 13px; color: var(--dsw-alias-label-secondary); font-weight: 600; }\n.aic-slide {\n  aspect-ratio: 16 / 9;\n  border: 1px solid var(--dsw-alias-border-l2);\n  border-radius: 10px;\n  background: var(--dsw-alias-bg-layer-1);\n  padding: 26px 30px;\n  overflow: auto;\n  display: flex;\n  flex-direction: column;\n  gap: 10px;\n}\n.aic-slide__no {\n  font-size: 11px;\n  color: var(--dsw-alias-label-secondary);\n  display: flex; gap: 8px; align-items: center;\n}\n.aic-slide--cover { justify-content: center; text-align: center; }\n.aic-slide--cover .aic-slide__title { font-size: 26px; }\n.aic-slide__title { font-size: 20px; font-weight: 600; margin: 0; }\n.aic-slide--center { justify-content: center; text-align: center; }\n.aic-slide--quote { justify-content: center; }\n.aic-slide--quote blockquote {\n  font-size: 18px; margin: 0; padding-left: 16px;\n  border-left: 3px solid var(--dsw-alias-border-l2);\n  color: var(--dsw-alias-label-secondary);\n}\n.aic-slide--two-cols > .aic-slide__cols,\n.aic-slide--two-cols-header > .aic-slide__cols {\n  display: grid; grid-template-columns: 1fr 1fr; gap: 20px; flex: 1 1 auto;\n}\n.aic-slide--image-right > .aic-slide__cols { display: grid; grid-template-columns: 1fr 1fr; gap: 20px; flex: 1 1 auto; }\n.aic-slide--image-left  > .aic-slide__cols { display: grid; grid-template-columns: 1fr 1fr; gap: 20px; flex: 1 1 auto; }\n.aic-slide--image-left  > .aic-slide__cols > :first-child { order: 1; }\n\n/* --- 代码 / 测验 --- */\n/* --- 通知条（降级 / 告警 / 提示；`__mark` 是行首的记号） --- */\n.aic-notice {\n  display: flex; align-items: flex-start; gap: 8px;\n  margin: 10px 0; padding: 8px 10px;\n  border: 1px solid var(--dsw-alias-border-l2);\n  border-left-width: 3px;\n  border-radius: 6px;\n  background: var(--dsw-alias-bg-layer-1);\n}\n.aic-notice__mark { color: var(--dsw-alias-state-warn-primary); font-weight: 700; flex: 0 0 auto; }\n\n/* --- 空态 / 骨架 / 错误态（课程库的几种页面状态） --- */\n.aic-library { min-width: 0; }\n.aic-empty {\n  display: flex; flex-direction: column; align-items: center; gap: 6px;\n  padding: 48px 16px; text-align: center;\n  border: 1px dashed var(--dsw-alias-border-l2);\n  border-radius: 10px;\n  color: var(--dsw-alias-label-secondary);\n}\n.aic-empty__title { color: var(--dsw-alias-label-primary); font-weight: 600; }\n.aic-empty__hint { font-size: 12px; }\n.aic-skel {\n  height: 92px; margin-bottom: 12px;\n  border: 1px solid var(--dsw-alias-border-l1);\n  border-radius: 10px;\n  background: var(--dsw-alias-bg-layer-1);\n}\n.aic-error {\n  display: flex; flex-direction: column; gap: 6px;\n  padding: 20px 16px;\n  border: 1px solid var(--dsw-alias-state-error-primary);\n  border-radius: 10px;\n}\n.aic-error__title { color: var(--dsw-alias-state-error-primary); font-weight: 600; }\n\n/* --- 编辑 / 生成弹窗（三套弹窗共用外壳，只有字段不同） --- */\n.aic-modal {\n  position: fixed; inset: 0; z-index: 40;\n  display: grid; place-items: center;\n  padding: 24px;\n  background: var(--dsw-alias-bg-overlay);\n}\n.aic-modal__panel {\n  width: min(460px, 100%);\n  max-height: 100%;\n  overflow: auto;\n  border: 1px solid var(--dsw-alias-border-l2);\n  border-radius: 12px;\n  background: var(--dsw-alias-bg-base);\n  padding: 14px 16px 16px;\n}\n.aic-modal__head { display: flex; align-items: center; gap: 10px; margin-bottom: 12px; }\n.aic-modal__head .aic-h2 { flex: 1 1 auto; margin: 0; }\n.aic-modal__body { display: flex; flex-direction: column; gap: 10px; }\n.aic-modal__foot {\n  display: flex; justify-content: flex-end; gap: 8px;\n  margin-top: 16px; padding-top: 12px;\n  border-top: 1px solid var(--dsw-alias-border-l1);\n}\n.aic-field { display: flex; flex-direction: column; gap: 4px; }\n.aic-field__label { color: var(--dsw-alias-label-secondary); font-size: 12px; }\n.aic-input--block, .aic-select--block { width: 100%; box-sizing: border-box; }\n.aic-input--area { height: auto; padding: 8px 10px; resize: vertical; line-height: 1.5; }\n\n/* --- 生成弹窗里的属性表 --- */\n.aic-facts {\n  margin: 0 0 14px;\n  display: flex; flex-direction: column; gap: 6px;\n  padding-bottom: 12px;\n  border-bottom: 1px solid var(--dsw-alias-border-l1);\n}\n.aic-facts__row { display: flex; gap: 12px; align-items: baseline; }\n.aic-facts__label { flex: 0 0 72px; color: var(--dsw-alias-label-secondary); font-size: 12px; }\n.aic-facts__value { margin: 0; flex: 1 1 auto; min-width: 0; }\n\n/* --- 右侧抽屉（只读大纲） --- */\n.aic-drawer {\n  flex: 0 0 340px;\n  width: 340px;\n  border-left: 1px solid var(--dsw-alias-border-l2);\n  background: var(--dsw-alias-bg-base);\n  display: flex;\n  flex-direction: column;\n  min-height: 0;\n}\n/* `display: flex` + 关闭按钮上的 `margin-left:auto` 才能把它推到**最右**；\n   这条规则曾经被整块误删，于是关闭图标挤在「只读」徽标后面。 */\n.aic-drawer__head {\n  display: flex; align-items: center; gap: 8px;\n  padding: 12px 14px;\n  border-bottom: 1px solid var(--dsw-alias-border-l2);\n}\n.aic-drawer__title { font-weight: 600; }\n.aic-drawer__body { padding: 14px; overflow: auto; flex: 1 1 auto; }\n.aic-drawer__body .aic-row__right { gap: 4px; }\n\n/* ============================================================================\n   主会话里的 `/ai-course` 实时状态卡片（src/client/55-status-card.js）\n\n   这张卡渲染在**宿主的对话流里**（`conversation.chat.commandview`），不在 `.aic-root`\n   容器内 —— 所以规则自带颜色与排版，不依赖父级继承。\n   仍遵守同一套约束：只用宿主主题 token、字面颜色零出现、class 全带 aic- 前缀。\n   ============================================================================ */\n\n.aic-cmd {\n  display: flex;\n  flex-direction: column;\n  gap: 2px;\n  min-width: 0;\n  padding: 2px 0;\n  color: var(--dsw-alias-label-primary);\n  font-size: calc(var(--dsh-content-font-size, 14px) - 2px);\n  line-height: 1.5;\n}\n\n.aic-cmd__row { display: flex; align-items: center; gap: 8px; min-width: 0; }\n.aic-cmd__row--sub {\n  padding-left: 24px;\n  color: var(--dsw-alias-label-secondary);\n  font-size: calc(var(--dsh-content-font-size, 14px) - 3px);\n}\n.aic-cmd__row--act { padding-left: 24px; margin-top: 4px; }\n\n.aic-cmd__glyph { flex: none; width: 16px; height: 16px; color: var(--dsw-alias-brand-primary); }\n.aic-cmd__glyph--spin { animation: aic-cmd-spin 0.9s linear infinite; }\n@keyframes aic-cmd-spin { to { transform: rotate(360deg); } }\n@media (prefers-reduced-motion: reduce) {\n  .aic-cmd__glyph--spin { animation: none; }\n}\n\n.aic-cmd__title { flex: none; font-weight: 600; }\n\n.aic-cmd__badge {\n  flex: none;\n  padding: 0 8px;\n  border-radius: 999px;\n  color: var(--dsw-alias-brand-primary);\n  background: var(--dsw-alias-bg-layer-2);\n  font-size: calc(var(--dsh-content-font-size, 14px) - 4px);\n}\n\n.aic-cmd__step { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }\n.aic-cmd__meta { flex: none; color: var(--dsw-alias-label-secondary); font-variant-numeric: tabular-nums; }\n.aic-cmd__error { padding-left: 24px; color: var(--dsw-alias-state-error-primary); }\n\n.aic-cmd__open {\n  height: 24px;\n  padding: 0 10px;\n  font: inherit;\n  color: var(--dsw-alias-label-primary);\n  background: var(--dsw-alias-bg-layer-1);\n  border: 1px solid var(--dsw-alias-border-l2);\n  border-radius: 6px;\n  cursor: pointer;\n}\n.aic-cmd__open:hover { background: var(--dsw-alias-bg-layer-2); }\n\n.aic-cmd--done .aic-cmd__badge { color: var(--dsw-alias-state-success-primary); }\n.aic-cmd--done .aic-cmd__glyph { color: var(--dsw-alias-state-success-primary); }\n.aic-cmd--error .aic-cmd__badge { color: var(--dsw-alias-state-error-primary); }\n.aic-cmd--error .aic-cmd__glyph { color: var(--dsw-alias-state-error-primary); }\n.aic-cmd--running .aic-cmd__badge { color: var(--dsw-alias-brand-primary); }\n\n/* ============================================================================\n   主会话回复末尾的**课程大纲卡片**（src/client/65-outline-card.js）\n\n   与进度卡（55-status-card.js）同样渲染在宿主的对话流里：规则自带颜色与排版。\n   约束不变：只用宿主主题 token、字面颜色零出现、class 全带 aic- 前缀。\n   ============================================================================ */\n\n.aic-outcard {\n  display: flex;\n  flex-direction: column;\n  gap: 8px;\n  min-width: 0;\n  max-width: 100%;\n  margin-top: 4px;\n  padding: 12px 14px;\n  border: 1px solid var(--dsw-alias-border-l2);\n  border-radius: 10px;\n  background: var(--dsw-alias-bg-layer-1);\n  color: var(--dsw-alias-label-primary);\n  font-size: calc(var(--dsh-content-font-size, 14px) - 2px);\n  line-height: 1.5;\n}\n\n.aic-outcard__head { display: flex; align-items: center; gap: 8px; min-width: 0; }\n.aic-outcard__icon { flex: none; width: 16px; height: 16px; color: var(--dsw-alias-brand-primary); }\n.aic-outcard__title { flex: none; font-weight: 600; }\n.aic-outcard__name {\n  min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;\n  color: var(--dsw-alias-label-secondary);\n}\n.aic-outcard__badge {\n  flex: none;\n  padding: 0 8px;\n  border-radius: 999px;\n  color: var(--dsw-alias-label-secondary);\n  background: var(--dsw-alias-bg-layer-2);\n  font-size: calc(var(--dsh-content-font-size, 14px) - 4px);\n}\n.aic-outcard__tools { margin-left: auto; flex: none; display: inline-flex; align-items: center; gap: 6px; }\n\n.aic-outcard__meta {\n  display: flex; align-items: center; gap: 12px; flex-wrap: wrap;\n  color: var(--dsw-alias-label-secondary);\n  font-size: calc(var(--dsh-content-font-size, 14px) - 3px);\n}\n.aic-outcard__progress { display: inline-flex; align-items: center; gap: 6px; }\n.aic-outcard__progress .aic-progress { width: 96px; }\n.aic-outcard__tags { display: inline-flex; align-items: center; gap: 4px; flex-wrap: wrap; }\n\n/* 卡片内的大纲树：外面已经有一层卡片，这里不再加边框/底色，只收紧留白 */\n.aic-outcard__body { min-width: 0; }\n.aic-outcard__body .aic-chapter { margin-bottom: 14px; }\n.aic-outcard__body .aic-chapter:last-child { margin-bottom: 0; }\n.aic-outcard__body .aic-kp { padding-left: 10px; }\n/* 嵌入态：补充课程描述与课程级操作（表头由卡片承担） */\n.aic-outline__embedhead { margin: 0 0 10px; }\n.aic-outline__embedrow { display: flex; align-items: center; gap: 8px; margin-top: 6px; }\n\n/* --- 删除（破坏性操作）：确认按钮 + 卡片左下角的删除入口 --- */\n/* 危险色只用宿主 token；卡片的删除按钮靠 `margin-right:auto` 与两个入口分开，降低误点 */\n.aic-btn--danger {\n  color: var(--dsw-alias-state-error-primary);\n  border-color: var(--dsw-alias-state-error-primary);\n  background: var(--dsw-alias-bg-layer-1);\n}\n.aic-btn--danger:hover { background: var(--dsw-alias-bg-layer-2); }\n.aic-btn--danger:disabled:hover { background: var(--dsw-alias-bg-layer-1); }\n.aic-card__delete { margin-right: auto; }\n/* 弹窗底部的动作组：把「生成 / 恢复默认 + 保存」收成一组，排在**外壳渲染的取消**右侧。\n   「取消」不在这里（每个弹窗只有外壳那一个），所以别再往组里放取消按钮。 */\n.aic-modal__footrow { display: inline-flex; align-items: center; gap: 8px; }\n\n\n/* --- 内容区（学习页的图文 / 幻灯片） --- */\n.aic-content { min-width: 0; }\n.aic-content__media { margin-top: 10px; font-size: 12px; }\n/* 围栏代码块的语言标记类：有意不定义规则（只是标记，配色/排版由 .aic-prose pre 承担） */\n.aic-code--lang { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }\n/* Slidev 版式修饰类中唯一没有专门规则的那个：`default` 就是「不加修饰」 */\n.aic-slide--default { /* 默认版式：靠 .aic-slide 的基础样式 */ }\n\n/* --- 版式的结构件（SlidePage 产出的 .aic-slide__cols 两栏） --- */\n/* 两栏都要能收缩：`min-width:0` 否则长单词/表格会把栅格撑破 */\n.aic-slide__cols > * { min-width: 0; }\n/* 侧栏里的图：限高、居中、不拉爆版面（幻灯片是固定比例的画布） */\n.aic-slide__cols .aic-prose { min-height: 0; }\n.aic-slide__cols img {\n  max-width: 100%;\n  max-height: 240px;\n  object-fit: contain;\n  display: block;\n  margin: 0 auto;\n  border-radius: 8px;\n}\n/* 单栏版式里的图同样限高，避免一张竖图把整页顶出画布 */\n.aic-slide > .aic-prose img { max-height: 260px; object-fit: contain; }\n/* 幻灯片里的表格：容器内可横向滚动，不撑破版式 */\n.aic-slide .aic-prose table { display: block; overflow-x: auto; }\n\n/* --- 大纲页顶部的生成进度条（06 §4.5） --- */\n\n/* --- 主会话的常驻 agent 状态条（58-agent-dock.js） --- */\n/* 渲染在输入框上方：自带颜色与排版（不在 .aic-root 里），与对话流里的两张卡片同款约束 */\n.aic-dock {\n  display: flex;\n  flex-direction: column;\n  gap: 2px;\n  /* **宽度与输入框一致**：宿主把输入卡片约束成 `max-width: var(--dsh-composer-card-max-width)`\n     （= `--dsh-chat-content-width` + 32px），早先我们按 `--dsh-chat-content-width` 走，\n     结果比输入框窄一截、右侧对不齐。`box-sizing` 保证内边距不会撑破这个宽度。 */\n  box-sizing: border-box;\n  width: 100%;\n  max-width: var(--dsh-composer-card-max-width, 100%);\n  margin: 0 auto 6px;\n  padding: 6px 10px;\n  border: 1px solid var(--dsw-alias-border-l2);\n  border-radius: 8px;\n  background: var(--dsw-alias-bg-layer-1);\n  color: var(--dsw-alias-label-primary);\n  font-size: calc(var(--dsh-content-font-size, 14px) - 3px);\n}\n.aic-dock__row { display: flex; align-items: center; gap: 8px; min-width: 0; }\n.aic-dock__main { display: inline-flex; align-items: center; gap: 6px; min-width: 0; }\n.aic-dock__label { font-weight: 600; }\n.aic-dock__kp { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--dsw-alias-label-secondary); }\n.aic-dock__failed { color: var(--dsw-alias-state-error-primary); }\n.aic-dock__tools { margin-left: auto; flex: none; }\n\n/* --- 灰显按钮（卡片上的纯图标删除按钮用它）：不可用时明确「弱一级」，但仍是可点的图标按钮 --- */\n.aic-btn--muted { color: var(--dsw-alias-label-secondary); }\n.aic-btn--muted:hover { color: var(--dsw-alias-label-primary); }\n.aic-btn--muted[disabled] { color: var(--dsw-alias-state-idle-primary); }\n/* 纯图标按钮不留多余内边距，保持与右侧两个入口的视觉分组 */\n.aic-card__delete.aic-btn--sm { padding: 0 6px; }\n\n/* --- Mermaid 图表（lesson 正文里的 ```mermaid 围栏） --- */\n.aic-mermaid {\n  margin: 12px 0;\n  padding: 10px 12px;\n  border: 1px solid var(--dsw-alias-border-l1);\n  border-radius: 8px;\n  background: var(--dsw-alias-bg-layer-1);\n  overflow-x: auto;\n}\n/* Mermaid 自己产出的 SVG：撑满可用宽度、高度自适应 */\n.aic-mermaid svg { max-width: 100%; height: auto; display: block; margin: 0 auto; }\n.aic-mermaid--pending { color: var(--dsw-alias-label-secondary); font-size: 12px; }\n.aic-mermaid--failed { border-style: dashed; }\n.aic-mermaid__source {\n  margin: 8px 0 0;\n  padding: 8px 10px;\n  overflow: auto;\n  border-radius: 6px;\n  background: var(--dsw-alias-bg-layer-2);\n  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;\n  font-size: 12px;\n}\n\n/* --- 图片（含「内联 SVG 自救」后的容器） --- */\n.aic-figure { display: block; max-width: 100%; }\n.aic-figure svg { max-width: 100%; height: auto; display: block; margin: 0 auto; }\n.aic-figure--broken { font-size: 12px; }\n\n/* --- 「保留原有内容 / 覆盖」单选（生成弹窗） --- */\n.aic-choices { display: flex; flex-direction: column; gap: 6px; }\n.aic-choice { display: flex; align-items: flex-start; gap: 8px; cursor: pointer; }\n.aic-choice input { margin: 3px 0 0; flex: none; }\n\n/* --- 生成中的加载图标（不用进度条，见 06 §4.4） --- */\n.aic-spinner { display: inline-flex; align-items: center; color: var(--dsw-alias-brand-primary); }\n.aic-spinner svg { animation: aic-spin 0.9s linear infinite; }\n@keyframes aic-spin { to { transform: rotate(360deg); } }\n@media (prefers-reduced-motion: reduce) {\n  .aic-spinner svg { animation: none; }\n}\n\n/* --- 生成中：转动的加载图标替代橙色实心圆（06 §4.3） --- */\n.aic-genstate__spin { animation: aic-spin 0.9s linear infinite; }\n@media (prefers-reduced-motion: reduce) {\n  .aic-genstate__spin { animation: none; }\n}\n"

/* 「AI 备注」上限（构建期从 src/host/05-constants.mjs 的 PROMPT_MAX 注入） */
const AIC_PROMPT_MAX = 2000

/* ==================== src/client/10-core.js ==================== */

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

/* ==================== src/client/20-widgets.js ==================== */

/* ==================== src/client/20-widgets.js ====================
 * 小组件：图标、两套状态图标、时长、进度条、通知条、面包屑
 *
 * 全部是纯展示组件（无副作用、不取数），类名与 preview 的 DOM 一一对应 ——
 * 06 号文档说「以 preview 的真实渲染为准」，所以这里不改信息结构，只换成 React 元素。
 * ========================================================================== */

/* ------------------------------------------------------------------ 图标 */
/* 路径逐字取自 preview/app.js 的 ICONS 表（20×20 viewBox、描边、currentColor）。
   键用 ASCII：中文键会让「组件代码里不许有中文字面量」这条断言无法机械检查。 */
const AIC_ICONS = {
  article: ['M11.5 3H6.5A1.5 1.5 0 0 0 5 4.5v11A1.5 1.5 0 0 0 6.5 17h7a1.5 1.5 0 0 0 1.5-1.5V6.5z', 'M11.5 3v3.5H15', 'M7.5 10.5h5', 'M7.5 13.5h3.5'],
  slides: ['M3.5 4.5h13v9h-13z', 'M10 13.5v3', 'M7 16.5h6'],
  audio: ['M4.5 12v-2a5.5 5.5 0 0 1 11 0v2', 'M4.5 11.5h1.8v4H5.6a1.1 1.1 0 0 1-1.1-1.1z', 'M15.5 11.5h-1.8v4h.7a1.1 1.1 0 0 0 1.1-1.1z'],
  video: ['M3.5 5.5h13v9h-13z', 'M8.5 8.2l3.8 2.3-3.8 2.3z'],
  code: ['M7.8 6.5L4.3 10l3.5 3.5', 'M12.2 6.5L15.7 10l-3.5 3.5'],
  quiz: ['M4.5 4.5h11v11h-11z', 'M7.3 10.2l1.7 1.7 3.7-3.7'],
  generate: ['M10 3.2l1.5 4.1 4.1 1.5-4.1 1.5L10 14.4l-1.5-4.1L4.4 8.8l4.1-1.5z', 'M15 13.5l.7 1.8 1.8.7-1.8.7-.7 1.8-.7-1.8-1.8-.7 1.8-.7z'],
  edit: ['M13.2 4.6l2.2 2.2L7.6 14.6H5.4v-2.2z', 'M12.1 5.7l2.2 2.2'],
  /* 编辑 + 生成**合一**的入口：铅笔（编辑）+ 右下角小星芒（生成，字形取自 generate 的第二段）。
     为什么要合成一个图标：大纲里原来并排两个图标按钮（编辑 / 生成），既占地方又让人分不清
     该点哪个 —— 两件事本来就发生在同一个弹窗里（06 §4.2）。 */
  compose: [
    'M11.6 4.4l2.2 2.2L6.2 14.2H4v-2.2z',
    'M10.6 5.4l2.2 2.2',
    'M14.8 11.6l.7 1.8 1.8.7-1.8.7-.7 1.8-.7-1.8-1.8-.7 1.8-.7z',
  ],
  back: ['M15.2 10H4.8', 'M9.3 5.5L4.8 10l4.5 4.5'],
  close: ['M5.5 5.5l9 9', 'M14.5 5.5l-9 9'],
  drawer: ['M3.5 4.5h13v11h-13z', 'M12 4.5v11'],
  clock: ['M10 3.5a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13z', 'M10 6.6V10l2.4 1.5'],
  outline: ['M4.5 6h11', 'M7.5 10h8', 'M7.5 14h8'],
  /* 章节编辑（结构模式）：列表 + 加号 —— 「在这里增删结构」 */
  structure: ['M3.5 5.5h7', 'M3.5 10h7', 'M3.5 14.5h5', 'M14.5 12.5v5', 'M12 15h5'],
  plus: ['M10 5.5v9', 'M5.5 10h9'],
  minus: ['M5.5 10h9'],
  learn: ['M7.9 5.9l6.7 4.1-6.7 4.1z'],
  prev: ['M12.5 5.5l-5 4.5 5 4.5'],
  trash: ['M4.5 6.5h11', 'M8 6.5V5a1 1 0 0 1 1-1h2a1 1 0 0 1 1 1v1.5', 'M6 6.5l.7 8a1 1 0 0 0 1 .9h4.6a1 1 0 0 0 1-.9l.7-8', 'M8.6 9.5v3.4', 'M11.4 9.5v3.4'],
  next: ['M7.5 5.5l5 4.5-5 4.5'],
  /* 课程库设置：三条滑杆 + 三个旋钮（比齿轮更像「可调参数」） */
  settings: ['M3.5 6h13', 'M3.5 10h13', 'M3.5 14h13', 'M7 4.2v3.6', 'M13 8.2v3.6', 'M9 12.2v3.6'],
}

/** 内容类型 → 图标键（未知类型回退「图文」的图标，06 §5）。 */
const AIC_TYPE_ICON = {
  '图文': 'article', '幻灯片': 'slides', '音频': 'audio', '视频': 'video', '代码': 'code', '测验': 'quiz',
}

/** 描边式图标；`aria-hidden` —— 可访问名一律由调用方（title/aria-label 或可见文字）承担。 */
function Icon (props) {
  const size = props.size || 15
  const paths = AIC_ICONS[props.name] || []
  return h(
    'svg',
    {
      viewBox: '0 0 20 20',
      width: String(size),
      height: String(size),
      fill: 'none',
      stroke: 'currentColor',
      strokeWidth: '1.5',
      strokeLinecap: 'round',
      strokeLinejoin: 'round',
      'aria-hidden': 'true',
      focusable: 'false',
    },
    paths.map((d, i) => h('path', { key: i, d: d })),
  )
}

/** 状态字形：只有「未生成」是空心，其余实心（06 §4.3）。 */
function StateGlyph (props) {
  const kind = props.kind
  if (kind === 'check') {
    return h(
      'svg',
      { viewBox: '0 0 20 20', width: '15', height: '15', fill: 'none', stroke: 'currentColor', strokeWidth: '1.8', strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': 'true', focusable: 'false' },
      h('path', { key: 'c', d: 'M5.4 10.4l3.1 3.1 6.1-6.6' }),
    )
  }
  if (kind === 'spin') {
    /* 生成中：转动的圆弧（颜色仍由 `.aic-genstate--warn` 决定，与原来的橙色一致） */
    return h(
      'svg',
      { className: 'aic-genstate__spin', viewBox: '0 0 20 20', width: '15', height: '15', fill: 'none', stroke: 'currentColor', strokeWidth: '2', strokeLinecap: 'round', 'aria-hidden': 'true', focusable: 'false' },
      h('path', { key: 's', d: 'M10 2.8a7.2 7.2 0 1 1-7.2 7.2' }),
    )
  }
  if (kind === 'play') {
    return h(
      'svg',
      { viewBox: '0 0 20 20', width: '15', height: '15', fill: 'none', stroke: 'currentColor', strokeWidth: '1.6', strokeLinejoin: 'round', 'aria-hidden': 'true', focusable: 'false' },
      h('path', { key: 'p', d: 'M7.4 5.6l7.2 4.4-7.2 4.4z' }),
    )
  }
  if (kind === 'pause') {
    return h(
      'svg',
      { viewBox: '0 0 20 20', width: '15', height: '15', fill: 'none', stroke: 'currentColor', strokeWidth: '1.6', strokeLinecap: 'round', 'aria-hidden': 'true', focusable: 'false' },
      [h('path', { key: 'a', d: 'M8.2 6v8' }), h('path', { key: 'b', d: 'M11.8 6v8' })],
    )
  }
  const solid = kind === 'solid'
  const attrs = {
    viewBox: '0 0 20 20', width: '15', height: '15', fill: 'none', stroke: 'currentColor', strokeWidth: '1.6',
    'aria-hidden': 'true', focusable: 'false',
  }
  if (solid) { attrs.fill = 'currentColor'; attrs.stroke = 'none' }
  return h('svg', attrs, h('circle', { key: 'c', cx: '10', cy: '10', r: solid ? '4.1' : '5.2' }))
}

/* --------------------------------------------------------- 两套状态图标 */
/* ⚠️ `aic-genstate--<mod>` 只是**语义标记类**（CSS 不为它定义规则，颜色由 `--<color>` 承担），
   scripts/check.mjs 里有一份显式白名单说明这件事。 */
function GenIcon (props) {
  const spec = AIC_COURSES_CORE.genSpec(props.state)
  const t = props.t
  const scope = props.scope ? t('a11y.scope' + props.scope) : ''
  const label = t('a11y.genState', { scope: scope, state: t(AIC_COURSES_CORE.GEN_STATE_KEY[spec.key]) })
  return h(
    'span',
    {
      className: 'aic-genstate ' + AIC_COURSES_CORE.GEN_CLASS[spec.key],
      role: 'img',
      'aria-label': label,
      title: label,
    },
    h(StateGlyph, { kind: spec.glyph }),
  )
}

function LearnIcon (props) {
  const spec = AIC_COURSES_CORE.learnSpec(props.state)
  const t = props.t
  const scope = props.scope ? t('a11y.scope' + props.scope) : ''
  const label = t('a11y.learnState', { scope: scope, state: t(AIC_COURSES_CORE.LEARN_STATE_KEY[spec.key]) })
  return h(
    'span',
    {
      className: 'aic-learnstate ' + AIC_COURSES_CORE.LEARN_CLASS[spec.key],
      role: 'img',
      'aria-label': label,
      title: label,
    },
    h(StateGlyph, { kind: spec.glyph }),
  )
}

function TypeIcon (props) {
  const label = props.t('a11y.type', { type: props.type })
  return h(
    'span',
    { className: 'aic-kp__type', role: 'img', 'aria-label': label, title: label },
    h(Icon, { name: AIC_TYPE_ICON[props.type] || 'article' }),
  )
}

/* --------------------------------------------------------------- 小控件 */
/** 纯图标按钮：**必须有** title + aria-label（06 §8）。
 *
 * 类名一律写**字面量**（不拼接）：`scripts/check.mjs` 靠它断言「用到的类都有样式规则」。
 * `tone: 'structure'` 是「章节编辑」这个开关专用的外观：**默认灰、选中黑**，
 * 且不铺底色（靠 `[aria-pressed]` 区隔），与行内其它图标按钮的「按下变底」区分开。 */
function IconButton (props) {
  const cls = props.tone === 'structure'
    ? 'aic-iconbtn aic-iconbtn--structure'
    : props.pressed ? 'aic-iconbtn aic-iconbtn--on' : 'aic-iconbtn'
  return h(
    'button',
    {
      className: cls,
      type: 'button',
      title: props.label,
      'aria-label': props.label,
      'aria-pressed': props.pressed === undefined ? undefined : String(!!props.pressed),
      disabled: props.disabled ? true : undefined,
      onClick: props.onClick,
    },
    h(Icon, { name: props.name }),
  )
}

/** 学习时长；`duration` 缺失时**整行不渲染**（06 §5 / AC-24）。 */
function DurationLabel (props) {
  const minutes = props.minutes
  if (!minutes) return null
  return h(
    'span',
    { className: 'aic-duration' },
    h(Icon, { name: 'clock' }),
    h('span', { className: 'aic-sr-only' }, props.t('lesson.duration')),
    h('span', null, props.t('lesson.minutes', { n: minutes })),
  )
}

/**
 * 旋转的加载图标（生成中）。
 *
 * 为什么单独一个组件：生成进度**不用进度条** —— 逐项生成时完成了多少并不能反映"还要多久"
 * （一个知识点可能比三个还慢），一根条形反而给人错误的预期；转动的图标只表达"还在跑"。
 * `prefers-reduced-motion` 下不转（06 §8）。
 */
function Spinner (props) {
  return h(
    'span',
    { className: 'aic-spinner', role: 'img', 'aria-label': props.label || '' },
    h(
      'svg',
      { viewBox: '0 0 20 20', width: '16', height: '16', fill: 'none', stroke: 'currentColor', strokeWidth: '1.8', strokeLinecap: 'round', 'aria-hidden': 'true', focusable: 'false' },
      h('path', { d: 'M10 2.8a7.2 7.2 0 1 1-7.2 7.2' }),
    ),
  )
}

/** 进度条：语义是**已完成 / 总数**（06 §3.2 的卡片进度与 §4.4 的生成进度共用）。 */
function ProgressBar (props) {
  const pct = Math.round(Math.max(0, Math.min(1, Number(props.ratio) || 0)) * 100)
  return h(
    'div',
    {
      className: 'aic-progress',
      role: 'progressbar',
      'aria-valuenow': String(pct),
      'aria-valuemin': '0',
      'aria-valuemax': '100',
      'aria-label': props.t('a11y.progress', { pct: pct }),
    },
    h('div', { className: 'aic-progress__bar', style: { width: pct + '%' } }),
  )
}

/** 通知条（降级 / 提示 / 告警）。 */
function Notice (props) {
  return h(
    'div',
    { className: 'aic-notice' },
    h('span', { className: 'aic-notice__mark', 'aria-hidden': 'true' }, '!'),
    h('span', null, props.children),
  )
}

/**
 * 面包屑（自写，不复制宿主控件）：`有 onClick 的段是链接，没有的是当前段`。
 * 末段用**页面名**而不是实体标题 —— 实体标题由紧邻的 h1 承担（06 §4.1）。
 */
function Breadcrumb (props) {
  return h(
    'nav',
    { className: 'aic-crumbs', 'aria-label': props.t('a11y.crumbs') },
    h(
      'ol',
      { className: 'aic-crumbs__list' },
      (props.items || []).map((it, i) =>
        h(
          'li',
          { className: 'aic-crumbs__item', key: i },
          i > 0 ? h('span', { className: 'aic-crumbs__sep', 'aria-hidden': 'true' }, '›') : null,
          it.onClick
            ? h('button', { className: 'aic-crumbs__link', type: 'button', onClick: it.onClick }, it.label)
            : h('span', { className: 'aic-crumbs__current', 'aria-current': 'page' }, it.label),
        ),
      ),
    ),
  )
}

/* ==================== src/client/30-rpc.js ==================== */

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

/* ==================== src/client/40-library.js ==================== */

/* ==================== src/client/40-library.js ====================
 * 视图：课程库（06 §3）
 *
 * 五种页面状态：加载中（骨架）/ 读取失败 / 空库 / 无结果 / 就绪（按分类分组的卡片网格）。
 * 筛选三条件可叠加（分类 + 名称 + 标签多选），标签行**不是卡片**（无边框/圆角/底色/内边距）。
 * ========================================================================== */

const AIC_LIB_SKELETON_COUNT = 6

/** 一张课程卡片：名称 → 描述 → 难度徽标 + 标签 → 满宽进度 → 两个右对齐入口。 */
function CourseCard (props) {
  const t = props.t
  const c = props.course
  const broken = !c.name
  const deriving = !broken && (c.chapterCount || 0) === 0
  const pct = Math.round(AIC_COURSES_CORE.progressRatio(c.kpTotal, c.kpMastered) * 100)
  const tags = c.tags || []
  return h(
    'div',
    { className: 'aic-card' },
    h(
      'div',
      { className: 'aic-card__name' },
      h('span', null, broken ? t('library.cardCorrupt') : c.name),
      deriving ? h('span', { className: 'aic-badge aic-badge--type' }, t('library.cardDeriving')) : null,
    ),
    h('div', { className: 'aic-card__desc' }, broken ? t('library.cardCorruptHint') : c.description || ''),
    h(
      'div',
      { className: 'aic-card__meta' },
      broken || !c.difficulty ? null : h('span', { className: 'aic-badge' }, t('library.cardDifficulty', { level: c.difficulty })),
      /* 已生成内容的知识点数：**只在宿主确实回了这个字段时**才渲染
         （老宿主没有 → 不显示，而不是显示 0/undefined） */
      Number(c.kpGenerated) > 0
        ? h('span', { className: 'aic-badge aic-badge--type' }, t('library.cardGenerated', { n: c.kpGenerated, total: c.kpTotal || 0 }))
        : null,
      c.readOnly ? h('span', { className: 'aic-badge aic-badge--type' }, t('library.cardReadOnly')) : null,
      tags.map((tag) => h('span', { className: props.selectedTags.indexOf(tag) >= 0 ? 'aic-tag aic-tag--on' : 'aic-tag', key: tag }, tag)),
    ),
    h(
      'div',
      { className: 'aic-card__progress' },
      h(
        'div',
        { className: 'aic-card__meta' },
        h('span', { className: 'aic-muted' }, t('library.cardProgress')),
        h('span', { className: 'aic-muted', style: { marginLeft: 'auto' } }, pct + '%'),
      ),
      h(ProgressBar, { ratio: pct / 100, t: t }),
    ),
    h(
      'div',
      { className: 'aic-card__actions' },
      /* 删除：**纯图标按钮、灰显**（06 §3.2）—— 只在卡片上出现（破坏性操作只给用户 + 二次确认；
         模型没有这个工具，04 §5）。左对齐并用 `margin-right: auto` 与两个入口分开，降低误点；
         图标按钮**必须有** title + aria-label（06 §8）。 */
      h(
        'button',
        {
          className: 'aic-btn aic-btn--sm aic-btn--quiet aic-btn--muted aic-card__delete',
          type: 'button',
          disabled: broken,
          title: t('library.cardDelete'),
          'aria-label': t('library.cardDelete'),
          onClick: () => props.onDelete(c),
        },
        h(Icon, { name: 'trash' }),
      ),
      h(
        'button',
        {
          className: 'aic-btn aic-btn--sm',
          type: 'button',
          disabled: broken || deriving,
          title: deriving ? t('library.cardDerivingHint') : undefined,
          onClick: () => props.onOpenOutline(c.id),
        },
        h(Icon, { name: 'outline' }),
        h('span', null, t('library.cardOutline')),
      ),
      /* 学习：**全部知识点都没内容**时才灰显（06 §3.2）—— 只要有一个能学，就该能进去。
         ⚠️ 兜底很重要：宿主 `courses.list` 是**较新**才带 `hasContent` 的字段。
         老宿主返回 undefined 时，`!c.hasContent` 会恒为真 → **整库全灰**（真机上踩过）。
         所以：字段缺失（undefined/null）一律**不**灰显；只有明确 `false` 才灰显。 */
      h(
        'button',
        {
          className: 'aic-btn aic-btn--sm',
          type: 'button',
          disabled: broken || deriving || c.hasContent === false,
          title: broken || deriving
            ? t('library.cardDerivingHint')
            : (c.hasContent === false ? t('library.cardLearnNoContent') : undefined),
          onClick: () => props.onOpenLesson(c.id),
        },
        h(Icon, { name: 'learn' }),
        h('span', null, t('library.cardLearn')),
      ),
    ),
  )
}

function LibraryView (props) {
  const t = props.t
  const core = AIC_COURSES_CORE
  /* 排序在**最前面**：后面的筛选项、分组、计数都以这个顺序为准（06 §3.2 更新时间降序） */
  const rows = core.sortCoursesByUpdated(props.courses || [])
  const filter = props.filter
  const selected = filter.tags || []
  const categories = core.allCategories(rows)
  const tags = core.allTags(rows)
  const matched = core.filterCourses(rows, filter)
  const loading = props.status === 'loading' && !rows.length
  const grouped = core.groupByCategory(matched)
  const [copied, setCopied] = React.useState(false)

  const subtitle = (() => {
    if (props.status === 'error') return ''
    const n = matched.length
    if (n === rows.length) return t('library.subtitleAll', { n: n })
    return t('library.subtitleFiltered', { n: n, total: rows.length })
  })()

  const copyExample = () => {
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(t('library.emptyHint'))
      }
    } catch (err) { /* 剪贴板不可用不影响主流程 */ }
    setCopied(true)
  }

  /* 状态分支顺序：加载中 → 读取失败 → 空库 → 无结果 → 就绪（预览同序） */
  let body = null
  if (loading) {
    body = h('div', { className: 'aic-grid' }, Array.from({ length: AIC_LIB_SKELETON_COUNT }, (_, i) => h('div', { className: 'aic-skel', key: i })))
  } else if (props.status === 'error') {
    body = h(
      'div',
      { className: 'aic-error' },
      h('div', { className: 'aic-error__title' }, t('library.errorTitle')),
      h('div', { className: 'aic-muted' }, t('library.errorBody')),
      h('div', null, h('code', null, props.error && props.error.message ? props.error.message : t('library.errorPath'))),
      h('div', { style: { marginTop: '10px' } }, h('button', { className: 'aic-btn', type: 'button', onClick: props.onRetry }, t('library.retry'))),
    )
  } else if (!rows.length) {
    body = h(
      'div',
      { className: 'aic-empty' },
      h('div', { className: 'aic-empty__title' }, t('library.emptyTitle')),
      h('div', null, t('library.emptyBody')),
      h('div', { className: 'aic-empty__hint' }, t('library.emptyHint')),
      h('div', { style: { marginTop: '12px' } },
        h('button', { className: 'aic-btn aic-btn--sm', type: 'button', onClick: copyExample },
          copied ? t('library.emptyActionDone') : t('library.emptyAction'))),
    )
  } else if (!matched.length) {
    body = h(
      'div',
      { className: 'aic-empty' },
      h('div', { className: 'aic-empty__title' }, t('library.nomatchTitle')),
      h('div', null, t('library.nomatchBody')),
      h('div', { style: { marginTop: '12px' } },
        h('button', { className: 'aic-btn aic-btn--sm', type: 'button', onClick: props.onClearFilters }, t('library.nomatchAction'))),
    )
  } else {
    body = h(
      'div',
      null,
      grouped.map((g) =>
        h(
          'div',
          { className: 'aic-group', key: g.category || '_' },
          h(
            'div',
            { className: 'aic-group__head' },
            h('span', null, g.category || t('library.groupUncategorized')),
            h('span', { className: 'aic-muted' }, t('library.groupCount', { n: g.courses.length })),
          ),
          h(
            'div',
            { className: 'aic-grid' },
            g.courses.map((c) =>
              h(CourseCard, {
                key: c.id,
                course: c,
                t: t,
                selectedTags: selected,
                onOpenOutline: props.onOpenOutline,
                onOpenLesson: props.onOpenLesson,
                onDelete: props.onDelete,
              }),
            ),
          ),
        ),
      ),
    )
  }

  return h(
    'div',
    { className: 'aic-library' },
    h(
      'div',
      { className: 'aic-pagehead' },
      h('div', null,
        h('h1', { className: 'aic-h1' }, t('library.title')),
        subtitle ? h('p', { className: 'aic-sub' }, subtitle) : null),
      h(IconButton, { name: 'settings', label: t('library.config'), onClick: props.onOpenConfig }),
    ),
    props.notice ? h(Notice, null, props.notice) : null,
    h(
      'div',
      { className: 'aic-toolbar' },
      h(
        'select',
        {
          className: 'aic-select',
          value: filter.category,
          'aria-label': t('library.categoryLabel'),
          onChange: (ev) => props.onFilter({ category: ev.target.value }),
        },
        h('option', { value: '' }, t('library.categoryAll')),
        categories.map((c) => h('option', { value: c, key: c }, c)),
      ),
      h('input', {
        className: 'aic-input',
        type: 'search',
        value: filter.query,
        placeholder: t('library.searchPlaceholder'),
        'aria-label': t('library.searchLabel'),
        onChange: (ev) => props.onFilter({ query: ev.target.value }),
      }),
    ),
    h(
      'div',
      { className: 'aic-tagbar' },
      h('span', { className: 'aic-tagbar__label' }, t('library.tagbarLabel')),
      h(
        'div',
        { className: 'aic-tagbar__list' },
        tags.map((tag) => {
          const on = selected.indexOf(tag) >= 0
          return h(
            'button',
            {
              className: 'aic-chip',
              type: 'button',
              key: tag,
              'aria-pressed': String(on),
              title: on ? t('library.tagUnpick') : t('library.tagPick'),
              onClick: () => props.onFilter({ tags: on ? selected.filter((x) => x !== tag) : selected.concat([tag]) }),
            },
            h('span', null, tag),
            h('span', { className: 'aic-chip__count' }, String(core.tagCount(rows, tag))),
          )
        }),
      ),
      selected.length
        ? h('div', { className: 'aic-tagbar__clear' },
            h('button', { className: 'aic-btn aic-btn--sm aic-btn--quiet', type: 'button', onClick: () => props.onFilter({ tags: [] }) },
              t('library.tagbarClear', { n: selected.length })))
        : null,
      h('span', { className: 'aic-tagbar__count' }, t('library.tagbarCount', { n: selected.length, total: tags.length })),
    ),
    body,
  )
}

/* ==================== src/client/50-outline.js ==================== */

/* ==================== src/client/50-outline.js ====================
 * 视图：大纲页（06 §4）—— 编辑模式（主面板）与只读模式（右侧抽屉）共用一棵目录树
 *
 * 课程级入口（2026-10-18）：**课程编辑**（基础属性）+ **章节编辑**（结构模式 +/-）+ 生成状态；
 * 整门课生成的界面入口已移除（能力仍在 host 的 generation.start）。
 *
 * 两套状态彼此独立：
 *   ① AI 生成状态（行末 5 态，两种模式都显示）
 *   ② 学习状态（只在知识点名称之后，且**只显示「学习完成」**）
 * 编号一律由 `order` 派生（`1` / `1.1`），**绝不解析存储 id**。
 * ========================================================================== */

function OutlineView (props) {
  const t = props.t
  const core = AIC_COURSES_CORE
  const course = props.course
  const editable = props.mode !== 'readonly'
  const kpProgressMap = props.kpProgress || {}
  /* 「章节编辑」= 结构模式（2026-10-18 用户需求）：点开后，章节与知识点**前面**出现 +/-，
     分别用于增删章节与知识点。默认关闭 —— 浏览时不该被结构按钮干扰。
     状态放组件内：数据刷新（生成中轮询）时不会被打回关闭。 */
  const [structMode, setStructMode] = React.useState(false)
  const canStructure = editable && typeof props.onStructure === 'function'

  /* 生成状态由**两项真实证据**派生：任务项状态（生成中/排队中/失败）与内容信封是否存在（已生成）。
     调用方不给（例如只读抽屉只关心「有没有内容」）时一律按「未生成」——不编造状态。 */
  const genOfKp = (kp) => core.kpGenState(props.taskStates && props.taskStates[kp.id], !!(props.assets && props.assets[kp.id]))
  const genOfScope = (kps) => core.scopeGenState(kps.map(genOfKp))

  const chapters = (course && course.outline && course.outline.chapters) || []

  /* 「在本章后新增」：addChapter 现在支持 `index`（插入位置），再加一个知识点 ——
     新章节不能是空的（host 校验：每章 ≥1 个知识点，05 §3），所以两步必须同批提交。 */
  const addChapterAfter = (ch) => {
    const at = chapters.findIndex((c) => c.id === ch.id)
    const newId = core.nextChapterId(chapters)
    props.onStructure([
      { op: 'addChapter', value: newId, index: at + 1 },
      { op: 'addKp', chapterId: newId, value: t('modal.newKpName') },
    ])
  }
  /* 「在本知识点后新增」：addKp 的 `index` 是**章内**插入位置。 */
  const addKpAfter = (ch, kp) => {
    const at = (ch.knowledgePoints || []).findIndex((k) => k.id === kp.id)
    props.onStructure([{ op: 'addKp', chapterId: ch.id, value: t('modal.newKpName'), index: at + 1 }])
  }

  /* `variant: 'embed'` —— 同一棵树嵌进**主会话的大纲卡片**：
     卡片自己有表头（标题 + 课程名 + 入口按钮），这里就不能再画面包屑与整页标题，
     否则界面上出现两个标题、两层导航。行内控件与弹窗入口完全一致。 */
  const embedded = props.variant === 'embed'

  const head = embedded ? null : !editable
    ? null
    : h(
        'div',
        { className: 'aic-outline__head' },
        h(Breadcrumb, {
          t: t,
          items: [{ label: t('library.title'), onClick: props.onBack }, { label: t('outline.crumbPage') }],
        }),
        h(
          'div',
          { className: 'aic-outline__titlerow' },
          h('h1', { className: 'aic-h1' }, course.name),
          h(
            'span',
            { className: 'aic-row__right' },
            /* 课程级只有两个入口（2026-10-18 用户需求）：
               ① 课程编辑 —— 名称 / 描述 / 标签 / 难度等**基础属性**（不含生成）；
               ② 章节编辑 —— 切换结构模式，在章节/知识点前显示 +/- 增删。
               原先的「编辑 + 生成」合成入口已移除；整门课的生成不再从大纲页发起。 */
            h(IconButton, {
              name: 'edit',
              label: t('outline.editCourseBasic'),
              disabled: props.disabled,
              onClick: () => props.onEdit('course', null),
            }),
            canStructure
              ? h(IconButton, {
                  name: 'structure',
                  /* 默认灰、选中黑（不铺底色）—— 结构模式开关的专属外观，见 20-widgets 的 tone */
                  tone: 'structure',
                  label: structMode ? t('outline.structureExit') : t('outline.structureEnter'),
                  pressed: structMode,
                  disabled: props.disabled,
                  onClick: () => setStructMode((v) => !v),
                })
              : null,
            h(GenIcon, { t: t, state: genOfScope(core.courseKps(course).map((x) => x.kp)), scope: 'Course' }),
          ),
        ),
        course.description ? h('p', { className: 'aic-sub' }, course.description) : null,
        (course.tags || []).length
          ? h('div', { className: 'aic-card__meta', style: { marginTop: '8px' } },
              (course.tags || []).map((tag) => h('span', { className: 'aic-tag', key: tag }, tag)))
          : null,
      )

  /* 嵌进卡片时表头由卡片承担，但**课程描述与课程级操作**不能丢：单独一行小字 + 编辑入口。 */
  const embedHead = !embedded
    ? null
    : h(
        'div',
        { className: 'aic-outline__embedhead' },
        course.description ? h('p', { className: 'aic-sub' }, course.description) : null,
        h(
          'div',
          { className: 'aic-outline__embedrow' },
          h('button', {
            className: 'aic-btn aic-btn--sm',
            type: 'button',
            disabled: props.disabled,
            onClick: () => props.onEdit('course', null),
          }, t('outline.editCourse')),
          h(GenIcon, { t: t, state: genOfScope(core.courseKps(course).map((x) => x.kp)), scope: 'Course' }),
        ),
      )

  return h(
    'div',
    { className: 'aic-outline' },
    head,
    embedHead,
    props.readOnly ? h(Notice, null, t('outline.readOnlyNotice')) : null,
    props.corrupt ? h(Notice, null, t('outline.corruptNotice')) : null,
    chapters.map((ch) =>
      h(
        'div',
        { className: 'aic-chapter', key: ch.id },
        h(
          'div',
          { className: 'aic-chapter__head' },
          /* 结构模式：章节**前面**的 +（在本章后新增章节）/ -（删除本章） */
          structMode && canStructure
            ? h(
                'span',
                { className: 'aic-structops' },
                h(IconButton, { name: 'plus', label: t('outline.addChapterAfter'), disabled: props.disabled, onClick: () => addChapterAfter(ch) }),
                h(IconButton, {
                  name: 'minus',
                  label: t('outline.removeChapter'),
                  disabled: props.disabled || chapters.length <= 1,
                  onClick: () => props.onStructure([{ op: 'removeChapter', chapterId: ch.id }]),
                }),
              )
            : null,
          h('span', { className: 'aic-chapter__no' }, core.chapterNo(ch)),
          h('span', { className: 'aic-chapter__title' }, ch.name),
          h(
            'span',
            { className: 'aic-row__right' },
            editable
              ? h(IconButton, { name: 'compose', label: t('outline.composeChapter'), disabled: props.disabled, onClick: () => props.onEdit('chapter', ch) })
              : null,
            h(GenIcon, { t: t, state: genOfScope(ch.knowledgePoints || []), scope: 'Chapter' }),
          ),
        ),
        h(
          'div',
          { className: 'aic-chapter__body' },
          (ch.knowledgePoints || []).length === 0
            ? h('div', { className: 'aic-muted' }, t('outline.chapterEmpty'))
            : (ch.knowledgePoints || []).map((kp) => {
                const state = core.kpProgress(kpProgressMap, kp.id)
                const learnState = core.kpLearnState(state)
                /* 名字是否可点进学习页由**调用方是否给了能力**决定：
                   课程面板给 `onOpenLesson` → 可点；主会话的大纲卡片没有学习页 → 纯文本。
                   （不能只看 `editable`：卡片是可编辑的，但它没有学习页可跳。） */
                const openable = typeof props.onOpenLesson === 'function'
                const open = () => { if (openable) props.onOpenLesson(ch, kp) }
                const kpList = ch.knowledgePoints || []
                return h(
                  'div',
                  { className: 'aic-kp', key: kp.id },
                  /* 结构模式：知识点**前面**的 +（在本知识点后新增）/ -（删除本知识点） */
                  structMode && canStructure
                    ? h(
                        'span',
                        { className: 'aic-structops' },
                        h(IconButton, { name: 'plus', label: t('outline.addKpAfter'), disabled: props.disabled, onClick: () => addKpAfter(ch, kp) }),
                        h(IconButton, {
                          name: 'minus',
                          label: t('outline.removeKp'),
                          disabled: props.disabled || kpList.length <= 1,
                          onClick: () => props.onStructure([{ op: 'removeKp', chapterId: ch.id, kpId: kp.id }]),
                        }),
                      )
                    : null,
                  h('span', { className: 'aic-kp__no' }, core.kpNo(ch, kp)),
                  h(TypeIcon, { t: t, type: kp.contentType }),
                  h(
                    'span',
                    {
                      className: 'aic-kp__name',
                      role: openable ? 'button' : undefined,
                      tabIndex: openable ? 0 : undefined,
                      onClick: openable ? open : undefined,
                      onKeyDown: openable
                        ? (ev) => {
                            if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); open() }
                          }
                        : undefined,
                    },
                    h('span', null, kp.name),
                    /* 学习状态只对**有内容**的知识点有意义（没内容时的残留进度不展示） */
                    (learnState === '学习完成' && props.assets && props.assets[kp.id])
                      ? h(LearnIcon, { t: t, state: learnState, scope: 'Kp' })
                      : null,
                  ),
                  h(
                    'span',
                    { className: 'aic-row__right' },
                    /* 学习时长：**只有内容已生成**才显示（06 §5）。
                       为什么不只看 `kp.duration`：旧进程/旧数据里可能还带着大纲阶段的估值，
                       而那时根本没有内容 —— 显示出来就是「凭空的时间」。
                       判据用**内容信封**（`assets` 里有没有这个 kp），与卡片「已生成」同源。 */
                    h(DurationLabel, { t: t, minutes: (props.assets && props.assets[kp.id]) ? kp.duration : undefined }),
                    editable
                      ? h(IconButton, {
                          name: 'compose',
                          /* 编辑 + 生成**一个入口**：弹窗里既能改属性，也能发起生成（06 §4.2）。 */
                          label: genOfKp(kp) === '已生成' ? t('outline.composeKpDone') : t('outline.composeKp'),
                          disabled: props.disabled,
                          onClick: () => props.onEdit('kp', { ch: ch, kp: kp }),
                        })
                      : null,
                    h(GenIcon, { t: t, state: genOfKp(kp), scope: 'Kp' }),
                  ),
                )
              }),
        ),
      ),
    ),
  )
}

/* ==================== src/client/55-status-card.js ==================== */

/* ==================== src/client/55-status-card.js ====================
 * 主会话里的 `/ai-course` 实时状态卡片
 *
 * 挂载点：`conversation.chat.commandview`（keyed / session 作用域）—— 宿主 ui-chat 的
 * 命令节点把每条斜杠命令渲染成一张卡，并按**命令名**派发到这个槽（`entryKey = command.name`，
 * 见 dsh-client-ui-chat 的 CommandNodeView）。我们只接管 `ai-course`，其他命令仍走宿主的通用卡。
 *
 * 实时性从哪来：
 *   `/ai-course` 的处理期间宿主只在**结束时**写会话日志（`command/done`），中间没有任何
 *   公开的推送面。所以状态由 host 的会话级状态表维护（src/host/15-status.mjs），这里按
 *   `sessionId` 轮询 `status.get`。轮询**只在需要时进行**：
 *     · 卡片处于「进行中」→ 每 1.2s 一次
 *     · 已结束（`command/done` 已到）或状态已失效 → 立即停表
 *   `sessionId` 来自槽的框架 props（ui-session 的 `props: ['sessionId']`），不猜、不从 DOM 抠。
 *
 * 不变量：
 *   · 只读：卡片从不写课程库；点「打开课程」是纯导航（先 `AIC_NAV.open` 再 `layout.selectPanel`）
 *   · 文案全部走 locale 表（组件代码里零中文字面量，脚本会断言）
 *   · 任何取数失败都不打断界面：降级成一行「推导中…」而不是白屏
 * ========================================================================== */

/* 轮询节奏：推导通常 ≥10s，1.2s 足够「实时」，也不至于把 RPC 打满 */
const AIC_STATUS_POLL_MS = 1200
/* 兜底停表：即使状态一直停在 running，也不会无限轮询（10 分钟后交给「已失效」文案） */
const AIC_STATUS_MAX_POLLS = 500
/* 超过这个时长没有更新，视为宿主重启后残留的状态 */
const AIC_STATUS_STALE_MS = 5 * 60 * 1000

/* 类名一律写成**完整字面量**（不做字符串拼接）：scripts/check.mjs 据此断言
   「代码里出现的每个 aic- 类都能在 styles.css 里找到规则」，拼出来的半截名会让那条断言失效。 */
const AIC_CMD_CLASS = {
  running: 'aic-cmd aic-cmd--running',
  done: 'aic-cmd aic-cmd--done',
  error: 'aic-cmd aic-cmd--error',
}

/** 秒 → 人读的「已用时 N 秒 / N 分 M 秒」。 */
function aicElapsedText (t, seconds) {
  const s = Math.max(0, Math.floor(Number(seconds) || 0))
  if (s < 60) return t('cmd.elapsed', { s: s })
  return t('cmd.elapsedMin', { m: Math.floor(s / 60), s: s % 60 })
}

/** 卡片图标：进行中转圈、完成对勾、失败叹号（全部 currentColor，跟随状态色）。 */
function AicStatusGlyph (props) {
  if (props.phase === 'done') {
    return h('svg', { className: 'aic-cmd__glyph', viewBox: '0 0 16 16', 'aria-hidden': 'true' },
      h('path', { d: 'M3.5 8.6l3 3 6-7', fill: 'none', stroke: 'currentColor', strokeWidth: '1.6', strokeLinecap: 'round', strokeLinejoin: 'round' }))
  }
  if (props.phase === 'error') {
    return h('svg', { className: 'aic-cmd__glyph', viewBox: '0 0 16 16', 'aria-hidden': 'true' },
      h('path', { d: 'M8 3.6v5.2', fill: 'none', stroke: 'currentColor', strokeWidth: '1.6', strokeLinecap: 'round' }),
      h('path', { d: 'M8 11.6v.6', fill: 'none', stroke: 'currentColor', strokeWidth: '1.8', strokeLinecap: 'round' }))
  }
  return h('svg', { className: 'aic-cmd__glyph aic-cmd__glyph--spin', viewBox: '0 0 16 16', 'aria-hidden': 'true' },
    h('circle', { cx: '8', cy: '8', r: '5.4', fill: 'none', stroke: 'currentColor', strokeWidth: '1.6', strokeOpacity: '0.25' }),
    h('path', { d: 'M8 2.6a5.4 5.4 0 0 1 5.4 5.4', fill: 'none', stroke: 'currentColor', strokeWidth: '1.6', strokeLinecap: 'round' }))
}

/**
 * 一条 `/ai-course` 命令的卡片。
 * `props.node` 由宿主传入（`{ commandId, name, args, outcome }`），`props.sessionId` 来自会话作用域。
 */
function AicCourseCommandCard (props) {
  const t = props.t
  const command = props.node || {}
  const sessionId = props.sessionId
  const commandId = command.commandId === undefined || command.commandId === null ? '' : String(command.commandId)
  const settled = command.outcome !== null && command.outcome !== undefined

  const [status, setStatus] = React.useState(null)
  /* `now` 只用于「已用时」推进：每次轮询都能重算，不需要单独的秒表 */
  const [nowMs, setNowMs] = React.useState(() => Date.now())
  /* `settled` 由 props 计算，但轮询 effect 只依赖 sessionId；
     用 ref 让 tick 读到最新值，命令一结束就停表（不再空转 10 分钟）。 */
  const settledRef = React.useRef(settled)
  settledRef.current = settled

  React.useEffect(() => {
    if (!sessionId) return undefined
    let alive = true
    let timer = null
    let polls = 0
    let stopped = false
    const tick = () => {
      polls += 1
      aicRpc('status.get', { sessionId: sessionId })
        .then((value) => {
          if (!alive) return
          setStatus(value || null)
          /* 命令结束 / 状态已 done|error → 这一轮之后不再排下一次；
             拿不到状态但命令还在跑（宿主还没写入）→ 继续等，否则会错过整段推导。 */
          if (!AIC_COURSES_CORE.shouldPollStatus(value && value.phase, settledRef.current)) stopped = true
        })
        .catch(() => {
          if (!alive) return
          setStatus(null)
          /* 取数失败：命令已结束就停；否则继续重试 */
          if (settledRef.current) stopped = true
        })
        .then(() => {
          if (!alive || stopped || polls >= AIC_STATUS_MAX_POLLS) return
          timer = setTimeout(tick, AIC_STATUS_POLL_MS)
        })
    }
    tick()
    return () => { alive = false; if (timer) clearTimeout(timer) }
  }, [sessionId])

  /* 「已用时」的心跳：只在状态还算新鲜时推进，避免给一份死状态计时 */
  const livePhase = status ? status.phase : ''
  React.useEffect(() => {
    if (settled || livePhase !== 'running') return undefined
    const id = setInterval(() => setNowMs(Date.now()), 1000)
    return () => clearInterval(id)
  }, [settled, livePhase])

  /* 卡片只认**这一条命令**的状态：命令 id 对不上（上一轮的残留）就什么也不显示 */
  const fresh = !!status && (!status.commandId || !commandId || status.commandId === commandId)
  const stale = fresh && !settled && status.phase === 'running'
    && nowMs - Number(status.updatedAt || 0) > AIC_STATUS_STALE_MS

  if (!fresh) {
    /* 拿不到状态（宿主重启 / RPC 不可达 / 还没写上）→ 一行最小占位，不猜进度 */
    return h('div', { className: 'aic-cmd' },
      h('div', { className: 'aic-cmd__row' },
        h(AicStatusGlyph, { phase: settled ? 'done' : 'running' }),
        h('span', { className: 'aic-cmd__title' }, t('cmd.title')),
        h('span', { className: 'aic-cmd__step' }, t('cmd.deriving')),
      ))
  }

  const phase = status.phase === 'done' ? 'done' : status.phase === 'error' ? 'error' : 'running'
  const step = t('cmd.step.' + (status.key || 'start'))
  const seconds = settled || phase !== 'running' || stale
    ? Math.max(0, (Number(status.updatedAt || 0) - Number(status.startedAt || 0)) / 1000)
    : Math.max(0, (nowMs - Number(status.startedAt || 0)) / 1000)
  const badge = phase === 'done' ? t('cmd.done') : phase === 'error' ? t('cmd.failed') : t('cmd.deriving')
  const courseName = status.courseName ? t('cmd.ofCourse', { name: status.courseName }) : ''
  /* 视觉态：失效（stale）优先于「进行中」，免得卡片看起来还在跑 */
  const viewPhase = stale ? 'error' : phase

  return h('div', { className: AIC_CMD_CLASS[viewPhase] },
    h('div', { className: 'aic-cmd__row' },
      h(AicStatusGlyph, { phase: viewPhase }),
      h('span', { className: 'aic-cmd__title' }, t('cmd.title')),
      h('span', { className: 'aic-cmd__badge' }, stale ? t('cmd.stalled') : badge),
    ),
    h('div', { className: 'aic-cmd__row aic-cmd__row--sub' },
      h('span', { className: 'aic-cmd__step' }, stale ? t('cmd.stalledHint') : step),
      h('span', { className: 'aic-cmd__meta' },
        aicElapsedText(t, seconds),
        courseName ? ' · ' + courseName : '',
      ),
    ),
    phase === 'error' && status.error
      ? h('div', { className: 'aic-cmd__error' }, status.error)
      : null,
    phase === 'done' && status.courseId
      ? h('div', { className: 'aic-cmd__row aic-cmd__row--act' },
        h('button', {
          className: 'aic-cmd__open',
          type: 'button',
          onClick: () => aicOpenCourse(props.ctx, status.courseId),
        }, t('cmd.open')))
      : null,
  )
}

/**
 * 「打开课程」：切到课程面板 **并** 直接进这门课的**大纲**（不是停在课程库列表）。
 *
 * 顺序很重要：**先发导航请求，再切面板** —— 面板是切过去才挂载的，
 * 反过来的话广播时还没有监听器，请求会丢掉（`AIC_NAV` 里有挂起补发兜底）。
 * `ctx.layout.selectPanel(id)` 是 doc/04 §2.3 记录过的客户端服务；取不到就只做导航
 * （侧边栏图标一直在，用户仍能自己点过去）。
 */
function aicOpenCourse (ctx, courseId) {
  /* 统一走外壳里的 `aicOpenCourseIn`：导航 + 切面板（顺序与兜底都在那里） */
  aicOpenCourseIn(ctx, courseId, 'outline')
}

/**
 * 注册到主会话的命令卡槽。
 * 槽由 ui-chat 在它的命令节点里声明（keyed），用 `inject` 等到声明出现再注册 ——
 * 直接 `register` 会在槽尚未声明时抛「slot ... is not declared」。
 */
function aicRegisterStatusCard (ctx, slots, t) {
  const disposers = []
  if (!slots || typeof slots.inject !== 'function') return disposers
  disposers.push(
    slots.inject('conversation.chat.commandview', () => slots.register(
      { name: 'conversation.chat.commandview', key: 'ai-course' },
      (props) => h(AicCourseCommandCard, Object.assign({}, props, { ctx: ctx, t: t })),
    )),
  )
  return disposers
}

/* ==================== src/client/58-agent-dock.js ==================== */

/* ==================== src/client/58-agent-dock.js ====================
 * **主会话的常驻 agent 状态条**（`conversation.input.dock`）
 *
 * 诉求：生成知识点内容时，要像 `/ai-course` 那样在主会话窗口里看见 agent 在跑。
 *
 * 它与另外两块的分工：
 *   · `55-status-card`：斜杠命令卡片（`/ai-course` 那条命令的过程），**只在命令那条回合**；
 *   · `65-outline-card`：回合末尾的大纲卡片（产物）；
 *   · **本文件**：一个**常驻**状态条 —— 生成**不产生回合**，所以它挂在输入框上方那个
 *     list/session 槽（`conversation.input.dock`）里，切到任何面板都能看见「agent 正在写什么」。
 *
 * 槽位选择依据（04 号文档 E-35）：该槽 `kind: list` / `scope: session`，由 ui-conversation 声明，
 * 位置在输入框之上一行，**与「当前回合」无关**。
 * ========================================================================== */

/** Ai 课程的面板 id（点状态条跳过去用）。 */
const AIC_PANEL_ID = 'ai-courses'

/** 轮询节奏：有任务在跑时 1.5s；空闲时把间隔拉长（只为发现「别处发起的生成」）。 */
const AIC_DOCK_BUSY_MS = 1500
const AIC_DOCK_IDLE_MS = 20000

/**
 * 主会话里的 agent 状态条。
 * @param {object} props 槽给的 props（`sessionId`）+ 本插件注入的 `t` / `ctx`
 */
function AicAgentDock (props) {
  const t = props.t
  const [rows, setRows] = React.useState([])
  const [loaded, setLoaded] = React.useState(false)

  React.useEffect(() => {
    let alive = true
    let timer = null
    const tick = () => {
      aicRpc('generation.active', {})
        .then((res) => {
          if (!alive) return
          const list = (res && res.tasks) || []
          setRows(list)
          setLoaded(true)
          /* 有任务 → 快速跟；没有 → 慢速探（发现「别处刚发起」的生成），不再无限快轮询 */
          timer = setTimeout(tick, list.length ? AIC_DOCK_BUSY_MS : AIC_DOCK_IDLE_MS)
        })
        .catch(() => {
          if (!alive) return
          setLoaded(true)
          timer = setTimeout(tick, AIC_DOCK_IDLE_MS)
        })
    }
    tick()
    return () => { alive = false; if (timer) clearTimeout(timer) }
  }, [])

  if (!loaded || !rows.length) return null

  return h(
    'div',
    { className: 'aic-dock', role: 'status', 'aria-live': 'polite' },
    rows.map((row) => {
      const task = row.task || {}
      /* 与大纲页顶部进度条**共用**同一个纯函数：计数 / 比例 / active / 失败项口径不允许两套 */
      const v = AIC_COURSES_CORE.taskProgressView(task, null)
      if (!v.visible) return null
      return h(
        'div',
        { className: 'aic-dock__row', key: row.courseId + ':' + (task.id || '') },
        h(
          'span',
          { className: 'aic-dock__main' },
          h(GenIcon, {
            t: t,
            state: v.stateKey === 'done' ? '已生成' : (v.stateKey === 'failed' ? '生成失败' : '生成中'),
            scope: 'Kp',
          }),
          h('span', { className: 'aic-dock__label' },
            t(v.active ? 'dock.generating' : 'dock.finished', { course: row.courseName || t('dock.unknownCourse') })),
          row.kpName && v.active
            ? h('span', { className: 'aic-dock__kp' }, t('dock.writingKp', { kp: row.kpName }))
            : failedSummary(h, t, v),
          h('span', { className: 'aic-muted' }, t('dock.count', { done: v.finished, total: v.total })),
        ),
        h(
          'span',
          { className: 'aic-dock__tools' },
          h('button', {
            className: 'aic-btn aic-btn--sm',
            type: 'button',
            /* **导航 + 切面板**一起做：只发导航的话，面板没打开时"点了没反应"（真机踩过） */
            onClick: () => aicOpenCourseIn(props.ctx, row.courseId, 'outline'),
          }, t('dock.openCourse')),
        ),
      )
    }),
  )
}

/** 跑完（或没在跑）时显示失败摘要；没失败就什么都不显示。 */
function failedSummary (h, t, v) {
  if (!v.failed.length) return null
  return h('span', { className: 'aic-dock__failed' }, t('outline.progressFailed', { n: v.failed.length }))
}

/** 注册主会话的常驻状态条（槽由 ui-conversation 声明 → 必须 inject 等声明）。 */
function aicRegisterAgentDock (ctx, slots, t) {
  const disposers = []
  if (!slots || typeof slots.inject !== 'function') return disposers
  disposers.push(
    slots.inject('conversation.input.dock', () => slots.register(
      { name: 'conversation.input.dock', id: 'dsh-ai-courses/agent-dock' },
      (props) => h(AicAgentDock, Object.assign({}, props, { ctx: ctx, t: t })),
    )),
  )
  return disposers
}

/* ==================== src/client/60-modals.js ==================== */

/* ==================== src/client/60-modals.js ====================
 * 两类弹窗（06 §6）：编辑弹窗（按数据类型分派字段）与生成弹窗（属性 + AI 提示）
 *
 * 共用外壳 `.aic-modal` + `.aic-modal__panel` + `__head` + `__body` + `__foot`；
 * 都有 role="dialog" + aria-modal，支持 Escape 与遮罩点击关闭；
 * **引用失效时不弹窗**（由调用方在打开前与渲染前各校验一次）。
 *
 * ⚠️ 与预览的一处**有意偏离**：弹窗标题不再拼接存储 id（`编辑章节 · ch-01`）——
 *    05 §4 与 06 §4.4 明确要求界面不出现存储 id，预览那处是已知的不一致。
 * ⚠️ 结构操作（增删 / 调序）放在编辑弹窗内：AC-8 要求增删与调序可用，而 06 §4.2
 *    把行内元素固定为「生成 / 编辑 / 生成状态」，所以能力进弹窗、行内不变。
 * ========================================================================== */

/** 弹窗外壳：遮罩点击关闭（仅当点在遮罩本体上）+ Escape 关闭（文档级监听）。
 *
 *  ⚠️ **必须走 portal**（与宿主 ui-chat 的用量面板同一做法）：对话流的滚动容器上带
 *  `container-type: inline-size`，它会成为 `position: fixed` 的**包含块** —— 弹窗直接渲染在
 *  卡片里就会被裁在那个滚动条内部（真机上表现为「弹窗跑到看不见的地方」）。
 *  portal 到 `document.body` 一次性解决；顺带把层级从对话流里拿出来。 */
function ModalShell (props) {
  const [host] = React.useState(() => (typeof document === 'undefined' ? null : document.createElement('div')))
  const panelRef = React.useRef(null)
  const cancelRef = React.useRef(null)
  const onCloseRef = React.useRef(props.onClose)
  onCloseRef.current = props.onClose
  React.useEffect(() => {
    const parent = typeof document === 'undefined' ? null : document.body
    if (!host || !parent || !parent.appendChild) return undefined
    parent.appendChild(host)
    return () => { if (host.parentNode) host.parentNode.removeChild(host) }
  }, [host])
  /* Escape + Tab 焦点陷阱 + 打开聚焦 + 关闭归还焦点。
     用 `[]` 依赖、经 ref 读最新 onClose —— 之前每次 render 都重挂监听器，
     而且没有焦点管理：键盘流会跑到弹窗后面的文档里。 */
  React.useEffect(() => {
    if (typeof document === 'undefined') return undefined
    const previouslyFocused = document.activeElement
    const focusables = () => {
      const panel = panelRef.current
      if (!panel || typeof panel.querySelectorAll !== 'function') return []
      return Array.from(panel.querySelectorAll('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'))
        .filter((el) => !el.disabled)
    }
    /* 打开时聚焦：破坏性弹窗（`focusCancel`）优先落在**取消**上（避免一个回车就删了），
       其余聚焦第一个可聚焦元素；都没有则聚焦面板本身，保证键盘流有落点。 */
    const list = focusables()
    const wanted = props.focusCancel && cancelRef.current && !cancelRef.current.disabled ? cancelRef.current : list[0]
    if (wanted) wanted.focus()
    else if (panelRef.current && typeof panelRef.current.focus === 'function') panelRef.current.focus()
    const onKey = (ev) => {
      if (ev.key === 'Escape') { ev.preventDefault(); onCloseRef.current(); return }
      if (ev.key === 'Tab') {
        const els = focusables()
        if (!els.length) return
        const first = els[0]
        const last = els[els.length - 1]
        if (ev.shiftKey && document.activeElement === first) { last.focus(); ev.preventDefault() }
        else if (!ev.shiftKey && document.activeElement === last) { first.focus(); ev.preventDefault() }
      }
    }
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('keydown', onKey)
      if (previouslyFocused && typeof previouslyFocused.focus === 'function') previouslyFocused.focus()
    }
  }, [host])
  const overlay = h(
    'div',
    {
      className: 'aic-modal',
      role: 'dialog',
      'aria-modal': 'true',
      'aria-label': props.title,
      onClick: (ev) => { if (ev.target === ev.currentTarget) props.onClose() },
    },
    h(
      'div',
      { className: 'aic-modal__panel', ref: panelRef },
      h(
        'div',
        { className: 'aic-modal__head' },
        h('h2', { className: 'aic-h2' }, props.title),
        h(IconButton, { name: 'close', label: props.t('modal.close'), onClick: props.onClose }),
      ),
      props.children,
      h(
        'div',
        { className: 'aic-modal__foot' },
        /* 「取消」只由外壳渲染**一个**：各弹窗的 `foot` 只放自己的动作按钮
           （保存 / 生成 / 删除确认 …），不要再自带取消 —— 否则会出现两个取消。 */
        h('button', {
          className: 'aic-btn',
          type: 'button',
          ref: cancelRef,
          disabled: !!props.cancelDisabled,
          onClick: props.onClose,
        }, props.t('modal.cancel')),
        props.foot,
      ),
    ),
  )
  /* 没有 DOM（离线冒烟）时直接回元素，便于断言 */
  if (!host || typeof ReactDOM === 'undefined' || typeof ReactDOM.createPortal !== 'function') return overlay
  return ReactDOM.createPortal(overlay, host)
}

function FieldLabel (props) {
  return h('label', { className: 'aic-field__label' }, props.children)
}

/**
 * 二次确认弹窗（破坏性操作专用：删除课程 / 批量生成前的覆盖确认）。
 *
 * 与编辑/生成弹窗共用同一套外壳（`ModalShell`）：Escape / 遮罩点击 = 取消。
 * 「取消」由外壳渲染（全项目只有这一处），这里只放**确认**按钮；确认按钮是危险色，
 * 默认焦点落在取消上（`focusCancel`）—— 避免一个回车就把课删了。
 */
function ConfirmModal (props) {
  const t = props.t
  const loading = !!props.loading
  return h(
    ModalShell,
    {
      t: t,
      title: props.title,
      onClose: loading ? () => {} : props.onClose,
      /* 提交中禁用取消（也一并挡住 Escape / 遮罩关闭，onClose 此时是空操作） */
      cancelDisabled: loading,
      /* 破坏性操作：打开时聚焦「取消」 */
      focusCancel: true,
      foot: h('button', {
        className: 'aic-btn aic-btn--danger',
        type: 'button',
        disabled: loading,
        onClick: props.onConfirm,
      }, loading ? t('modal.deleting') : props.confirmLabel),
    },
    h(
      'div',
      { className: 'aic-modal__body' },
      h('div', null, props.body),
      props.detail ? h('div', { className: 'aic-muted' }, props.detail) : null,
      props.error ? h(Notice, null, props.error) : null,
    ),
  )
}

/** config.* 的 RPC 错误 → 界面文案（老宿主没有这两个方法时给出可执行的替代路径）。 */
function aicConfigErrorText (t, err) {
  const code = err && err.code
  if (code === 'unknown-method' || code === 'http-404') return t('config.unsupported')
  if (code === 'conflict') return t('config.tasksHint')
  if (code === 'invalid-input') {
    const reason = err && err.detail && err.detail.reason ? String(err.detail.reason) : ''
    return String((err && err.message) || err) + (reason ? `（${reason}）` : '')
  }
  if (code === 'settings-write-failed') {
    const reason = err && err.detail && err.detail.reason ? String(err.detail.reason) : ''
    return t('config.writeFailed', { message: reason || String((err && err.message) || err) })
  }
  return String((err && err.message) || err)
}

/**
 * 课程库设置弹窗（06 §3 的配置入口）：修改 `courseRoot`。
 *
 * 保存成功后 host 会**立即换根**（store.setRoot），所以这里只需要通知上层刷新列表，
 * 不提示重启。旧目录里的课程不会被移动/删除；切回去仍然能看到。
 *
 * 三个前置约束：
 *   · 目录必须是绝对路径（`~` 会展开）；
 *   · 目标目录必须可写（host 会 mkdir + 写一个探针文件再删掉）；
 *   · 有生成任务在跑时不允许切换（任务持有旧根下的课程目录）。
 */
function ConfigModal (props) {
  const t = props.t
  const [path, setPath] = React.useState('')
  const [info, setInfo] = React.useState(null)
  const [loading, setLoading] = React.useState(true)
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState('')
  const alive = React.useRef(true)
  React.useEffect(() => () => { alive.current = false }, [])

  const load = () => {
    setLoading(true)
    setError('')
    aicRpc('config.get', {}).then(
      (data) => {
        if (!alive.current) return
        setInfo(data)
        setPath(data && data.courseRoot ? data.courseRoot : '')
        setLoading(false)
      },
      (err) => {
        if (!alive.current) return
        setLoading(false)
        setError(aicConfigErrorText(t, err))
      },
    )
  }
  React.useEffect(() => { load() }, [])

  const save = () => {
    const value = String(path || '').trim()
    if (!value) { setError(t('config.empty')); return }
    setBusy(true)
    setError('')
    aicRpc('config.set', { courseRoot: value }).then(
      (data) => {
        if (!alive.current) return
        setBusy(false)
        if (props.onSaved) props.onSaved(data)
      },
      (err) => {
        if (!alive.current) return
        setBusy(false)
        setError(aicConfigErrorText(t, err))
      },
    )
  }

  const sourceLabel = info
    ? (info.source === 'settings'
        ? t('config.sourceSettings')
        : info.source === 'config' ? t('config.sourceConfig') : t('config.sourceDefault'))
    : ''

  return h(
    ModalShell,
    {
      t: t,
      title: t('config.title'),
      onClose: busy ? () => {} : props.onClose,
      foot: h(
        'span',
        { className: 'aic-modal__footrow' },
        h('button', {
          className: 'aic-btn aic-btn--sm aic-btn--quiet',
          type: 'button',
          disabled: busy || loading || !info,
          onClick: () => setPath((info && info.defaultRoot) || ''),
        }, t('config.defaultAction')),
        h('button', {
          className: 'aic-btn aic-btn--primary',
          type: 'button',
          disabled: busy || loading,
          onClick: save,
        }, busy ? t('config.saving') : t('config.save')),
      ),
    },
    h(
      'div',
      { className: 'aic-modal__body' },
      loading ? h('div', { className: 'aic-muted' }, t('config.loading')) : null,
      h(
        'div',
        { className: 'aic-field' },
        h(FieldLabel, null, t('config.courseRootLabel')),
        h('input', {
          className: 'aic-input aic-input--block',
          type: 'text',
          value: path,
          placeholder: '~/.dsh/ai-courses',
          'aria-label': t('config.courseRootLabel'),
          disabled: busy || loading,
          onChange: (ev) => setPath(ev.target.value),
        }),
        h('div', { className: 'aic-muted' }, t('config.courseRootHint')),
      ),
      info && !loading
        ? h('div', { className: 'aic-muted', style: { wordBreak: 'break-all' } },
            t('config.current', { path: info.courseRoot }))
        : null,
      info && !loading
        ? h('div', { className: 'aic-muted' }, t('config.source', { source: sourceLabel }))
        : null,
      info && !loading
        ? h('div', { className: 'aic-muted', style: { wordBreak: 'break-all' } },
            t('config.settingsPath', { path: info.settingsPath }))
        : null,
      error ? h(Notice, null, error) : null,
      !loading && !info
        ? h('div', null, h('button', { className: 'aic-btn aic-btn--sm', type: 'button', onClick: load }, t('library.retry')))
        : null,
    ),
  )
}

/**
 * 编辑弹窗。
 * @param {object} props.target { course } | { ch } | { ch, kp } 由 kind 决定
 */
function EditModal (props) {
  const t = props.t
  const core = AIC_COURSES_CORE
  const kind = props.kind
  const isCourse = kind === 'course'
  const isChapter = kind === 'chapter'
  const target = isCourse ? props.course : isChapter ? props.ch : props.kp

  const [form, setForm] = React.useState(() => ({
    name: target.name || '',
    description: target.description || '',
    difficulty: isCourse ? (target.difficulty || core.DIFFICULTIES[0]) : '',
    /* 分类**不在编辑表单里**：推导默认不给分类（用户需求）。`setCategory` 这个 host 动作仍在，
       是给「以后想加回分类」留的口子 —— 到时候在这里补一个字段即可。 */
    tags: isCourse ? (target.tags || []).join('、') : '',
    contentType: isChapter ? '' : (target.contentType || core.CONTENT_TYPES[0]),
  }))
  const set = (patch) => setForm((prev) => Object.assign({}, prev, patch))

  /* 当前字段对应的修订动作（host 的 outline.revise 收的是**动作列表**，不是整棵树） */
  const fieldOps = () => {
    if (isCourse) {
      return [
        { op: 'renameCourse', value: form.name },
        { op: 'setDescription', value: form.description },
        { op: 'setDifficulty', value: form.difficulty },
        { op: 'setTags', value: form.tags },
      ]
    }
    if (isChapter) {
      return [
        { op: 'renameChapter', chapterId: target.id, value: form.name },
        { op: 'setChapterDescription', chapterId: target.id, value: form.description },
      ]
    }
    return [
      { op: 'renameKp', chapterId: props.ch.id, kpId: target.id, value: form.name },
      { op: 'setKpType', chapterId: props.ch.id, kpId: target.id, value: form.contentType },
    ]
  }

  const submit = () => props.onSubmit(fieldOps())

  /* 结构操作：与字段改动**一起**提交，避免「点一下上移就丢掉刚改的名字」 */
  const structure = (ops) => props.onSubmit(fieldOps().concat(ops))

  const chapters = (props.course.outline && props.course.outline.chapters) || []
  const chIndex = isChapter ? chapters.findIndex((c) => c.id === target.id) : -1
  const chKps = isChapter ? [] : ((props.ch && props.ch.knowledgePoints) || [])
  const kpIndex = isChapter ? -1 : chKps.findIndex((k) => k.id === target.id)

  const structureButtons = []
  if (isChapter) {
    structureButtons.push(h('button', {
      className: 'aic-btn aic-btn--sm', type: 'button', key: 'up', disabled: chIndex <= 0,
      onClick: () => structure([{ op: 'moveChapter', chapterId: target.id, index: chIndex - 1 }]),
    }, t('modal.moveUp')))
    structureButtons.push(h('button', {
      className: 'aic-btn aic-btn--sm', type: 'button', key: 'down', disabled: chIndex < 0 || chIndex >= chapters.length - 1,
      onClick: () => structure([{ op: 'moveChapter', chapterId: target.id, index: chIndex + 1 }]),
    }, t('modal.moveDown')))
    structureButtons.push(h('button', {
      className: 'aic-btn aic-btn--sm', type: 'button', key: 'remove',
      disabled: chapters.length <= 1,
      title: chapters.length <= 1 ? t('modal.removeLastChapterHint') : undefined,
      onClick: () => structure([{ op: 'removeChapter', chapterId: target.id }]),
    }, t('modal.removeChapter')))
    const newId = core.nextChapterId(chapters)
    structureButtons.push(h('button', {
      className: 'aic-btn aic-btn--sm', type: 'button', key: 'add',
      /* addChapter 产出的章节是**空**的，而 host 校验要求每章至少 1 个知识点（05 §3）
         → 必须同批补一个知识点，否则整批被拒（这个坑在写的时候撞到过）。 */
      onClick: () => structure([
        { op: 'addChapter', value: newId },
        { op: 'addKp', chapterId: newId, value: t('modal.newKpName') },
      ]),
    }, t('modal.addChapter')))
  } else {
    structureButtons.push(h('button', {
      className: 'aic-btn aic-btn--sm', type: 'button', key: 'up', disabled: kpIndex <= 0,
      onClick: () => structure([{ op: 'moveKp', chapterId: props.ch.id, kpId: target.id, index: kpIndex - 1 }]),
    }, t('modal.moveUp')))
    structureButtons.push(h('button', {
      className: 'aic-btn aic-btn--sm', type: 'button', key: 'down', disabled: kpIndex < 0 || kpIndex >= chKps.length - 1,
      onClick: () => structure([{ op: 'moveKp', chapterId: props.ch.id, kpId: target.id, index: kpIndex + 1 }]),
    }, t('modal.moveDown')))
    structureButtons.push(h('button', {
      className: 'aic-btn aic-btn--sm', type: 'button', key: 'remove', disabled: chKps.length <= 1,
      title: chKps.length <= 1 ? t('modal.removeLastKpHint') : undefined,
      onClick: () => structure([{ op: 'removeKp', chapterId: props.ch.id, kpId: target.id }]),
    }, t('modal.removeKp')))
  }

  const fields = []
  fields.push(h('div', { className: 'aic-field', key: 'name' },
    h(FieldLabel, null, t('modal.fieldName')),
    h('input', { className: 'aic-input aic-input--block', value: form.name, onChange: (ev) => set({ name: ev.target.value }) })))
  /* 字段顺序（06 §6）：课程 = 名称/描述/难度/标签；章节 = 名称/描述；知识点 = 名称/内容类型。
     分类已从表单移除（推导不产出分类），`setCategory` 动作保留但界面上没有入口。 */
  if (kind !== 'kp') {
    fields.push(h('div', { className: 'aic-field', key: 'description' },
      h(FieldLabel, null, t('modal.fieldDescription')),
      h('textarea', { className: 'aic-input aic-input--block aic-input--area', rows: 3, value: form.description, onChange: (ev) => set({ description: ev.target.value }) })))
  }
  if (isCourse) {
    fields.push(h('div', { className: 'aic-field', key: 'difficulty' },
      h(FieldLabel, null, t('modal.fieldDifficulty')),
      h('select', { className: 'aic-select aic-select--block', value: form.difficulty, onChange: (ev) => set({ difficulty: ev.target.value }) },
        core.DIFFICULTIES.map((c) => h('option', { value: c, key: c }, c)))))
    fields.push(h('div', { className: 'aic-field', key: 'tags' },
      h(FieldLabel, null, t('modal.fieldTags')),
      h('input', { className: 'aic-input aic-input--block', value: form.tags, onChange: (ev) => set({ tags: ev.target.value }) }),
      h('div', { className: 'aic-muted' }, t('modal.fieldTagsHint'))))
  }
  if (kind === 'kp') {
    fields.push(h('div', { className: 'aic-field', key: 'type' },
      h(FieldLabel, null, t('modal.fieldType')),
      h('select', { className: 'aic-select aic-select--block', value: form.contentType, onChange: (ev) => set({ contentType: ev.target.value }) },
        core.CONTENT_TYPES.map((c) => h('option', { value: c, key: c }, c)))))
  }

  const title = isCourse ? t('modal.editCourseTitle') : isChapter ? t('modal.editChapterTitle') : t('modal.editKpTitle')

  return h(
    ModalShell,
    {
      t: t,
      title: title,
      onClose: props.onClose,
      foot: h(
        'span',
        { className: 'aic-modal__footrow' },
        /* **生成**与编辑同一入口（06 §4.2）：这里只负责「发起」，具体流程由调用方决定
           （知识点 → 生成弹窗；章节/整门课 → 二次确认后直接排队）。 */
        props.onGenerate
          ? h('button', {
              className: 'aic-btn',
              type: 'button',
              disabled: props.disabled || props.generating,
              onClick: () => props.onGenerate(kind, target),
            }, props.generating ? t('modal.generating') : t('modal.generate' + (isCourse ? 'Course' : isChapter ? 'Chapter' : 'Kp')))
          : null,
        h('button', { className: 'aic-btn aic-btn--primary', type: 'button', disabled: props.disabled, onClick: submit }, t('modal.save')),
      ),
    },
    h(
      'div',
      { className: 'aic-modal__body' },
      fields,
      h('div', { className: 'aic-field' },
        h(FieldLabel, null, t('modal.structureTitle')),
        h('div', { style: { display: 'flex', gap: '8px', flexWrap: 'wrap' } }, structureButtons)),
    ),
  )
}

/**
 * 生成弹窗（06 §6）：属性表 + AI 提示 + 发起。
 *
 * **发起成功后立即关闭**：进度与结果在大纲视图上实时展示（顶部进度条 + 行末 5 态），
 * 不占着弹窗。发起**失败**时弹窗留在原地并显示原因（这时用户需要看到它）。
 */
function GenerateModal (props) {
  const t = props.t
  const core = AIC_COURSES_CORE
  const ch = props.ch
  const kp = props.kp
  const state = core.kpProgress(props.kpProgress, kp.id)
  /* 四种待定类型：**可以生成**（按 Markdown 降级），只是要如实告诉用户「格式待定」 */
  const formatPending = core.DEFERRED_TYPES.indexOf(kp.contentType) >= 0
  const [prompt, setPrompt] = React.useState('')
  /* 默认**保留**：重新生成通常是想「补充」，而不是把已经看过的内容抹掉（覆盖要显式选） */
  const [keep, setKeep] = React.useState(true)
  const [error, setError] = React.useState('')
  const [busy, setBusy] = React.useState(false)

  const rows = [
    [t('modal.factKp'), kp.name],
    [t('modal.factNo'), core.kpNo(ch, kp)],
    [t('modal.factType'), kp.contentType],
    /* 学习时长：**内容已生成**才有实际值可报。没内容时哪怕 kp.duration 有残留数值
       （旧进程写下的估值）也不显示 —— 那是凭空的时间。 */
    [t('modal.factDuration'), (props.hasAsset && kp.duration) ? t('modal.minutes', { n: kp.duration }) : t('modal.factDurationNone')],
    [t('modal.factChapter'), t('modal.factChapterValue', { n: ch.order, name: ch.name })],
    [t('modal.factAsset'), t(props.hasAsset ? 'modal.factStatusGenerated' : 'modal.factStatusNotGenerated') + ' · ' + t('modal.factLearnProgress', { state: t('state.kp.' + state) })],
  ]

  const submit = () => {
    setError('')
    /* **预检**：没有会话 id 就直接给可操作的提示，不发这次请求 ——
       否则用户只会看到一个跟"点生成"毫无关系的报错（真机上就是"点了报错"）。
       会话 id 由面板算（`aicActiveSessionId`），宿主侧还有一层兜底。 */
    if (!props.agentId) {
      setError(t('modal.needSession'))
      return
    }
    if (prompt.length > AIC_PROMPT_MAX) {
      setError(t('modal.promptTooLong', { max: AIC_PROMPT_MAX, n: prompt.length }))
      return
    }
    setBusy(true)
    aicRpc('generation.start', {
      courseId: props.courseId,
      scope: 'kp',
      targetIds: [kp.id],
      prompt: prompt,
      agentId: props.agentId || '',
      /* 只有已有内容时才有意义；没内容时传 false（否则宿主会去读不存在的旧正文） */
      keepExisting: !!props.hasAsset && keep,
    })
      .then(() => {
        setBusy(false)
        /* 关窗 + 让大纲视图立刻进入「实时状态」（面板层轮询接管） */
        if (props.onStarted) props.onStarted()
        else props.onClose()
      })
      .catch((err) => {
        setBusy(false)
        const missing = err && (err.code === 'unknown-method' || err.code === 'http-404')
        setError(missing ? t('modal.generateM2') : String((err && err.message) || err))
      })
  }

  return h(
    ModalShell,
    {
      t: t,
      title: t('modal.generateTitle'),
      onClose: props.onClose,
      foot: h('button', { className: 'aic-btn aic-btn--primary', type: 'button', disabled: busy, onClick: submit },
        busy ? t('modal.generating') : t('modal.generateSubmit')),
    },
    h(
      'div',
      null,
      h('dl', { className: 'aic-facts' },
        rows.map(([label, value]) => h('div', { className: 'aic-facts__row', key: label },
          h('dt', { className: 'aic-facts__label' }, label),
          h('dd', { className: 'aic-facts__value' }, value)))),
      /* **已有内容时**给一个「保留 / 覆盖」选择（06 §6）：保留 → 新内容追加在旧内容之后 */
      props.hasAsset
        ? h('div', { className: 'aic-field' },
            h(FieldLabel, null, t('modal.keepLabel')),
            h('div', { className: 'aic-choices' },
              h('label', { className: 'aic-choice' },
                h('input', {
                  type: 'radio',
                  name: 'keep-existing',
                  checked: keep,
                  onChange: () => setKeep(true),
                }),
                h('span', null, t('modal.keepOn'))),
              h('label', { className: 'aic-choice' },
                h('input', {
                  type: 'radio',
                  name: 'keep-existing',
                  checked: !keep,
                  onChange: () => setKeep(false),
                }),
                h('span', null, t('modal.keepOff')))),
            h('div', { className: 'aic-muted' }, keep ? t('modal.keepHint') : t('modal.overwriteHint')))
        : null,
      h('div', { className: 'aic-field' },
        h(FieldLabel, null, t('modal.generatePromptLabel')),
        h('textarea', {
          className: 'aic-input aic-input--block aic-input--area',
          rows: 3,
          value: prompt,
          /* `maxLength` 与宿主校验**同一个数**（AIC_PROMPT_MAX 由构建期从 host 常量注入）：
             浏览器直接截断，用户不会先写了一千字再被服务端拒掉。 */
          maxLength: AIC_PROMPT_MAX,
          placeholder: t('modal.generatePromptPlaceholder'),
          'aria-label': t('modal.generatePromptAria'),
          onChange: (ev) => setPrompt(ev.target.value),
        }),
        h('div', { className: 'aic-muted' },
          t('modal.promptCount', { n: prompt.length, max: AIC_PROMPT_MAX }))),
      formatPending ? h(Notice, null, t('modal.generateFallback', { type: kp.contentType })) : null,
      h('div', { className: 'aic-muted' }, t('modal.generateAfterClose')),
      error ? h(Notice, null, error) : null,
    ),
  )
}

/* ==================== src/client/62-editor.js ==================== */

/* ==================== src/client/62-editor.js ====================
 * **可复用的课程编辑器**：编辑弹窗 + 生成弹窗 + 提交/刷新一套逻辑
 *
 * 为什么单独一段：**两个宿主**要用同一套编辑能力 ——
 *   ① 课程面板的大纲页（`90-app.js` 的 `AicCoursesApp`）
 *   ② 主会话里的**大纲卡片**（`65-outline-card.js`，本期新增）
 * 复制一份出来会立刻产生两条真相（字段、动作列表、失败文案都会漂移），
 * 所以做成组件：谁用谁传 `courseId` 与 `onChanged`。
 *
 * 边界（有意为之）：
 *   · 组件**自己**管弹窗开关、自己调 `outline.revise` 与 `courses.read` 刷新 ——
 *     调用方不必知道 host 的动作列表长什么样。
 *   · 弹窗目标每次都按 **courseId 现查的数据**重新解析；引用失效就不弹（06 §6）。
 *   · `disabled`（只读降级）时保存与结构操作一律禁用。
 * ========================================================================== */

/**
 * 课程编辑器（无 UI 外壳，只负责「弹窗 + 提交」）。
 * @param {object} props
 *   `{ courseId, t, disabled?, onChanged?, children(api) }`
 *   `onChanged` 在每次成功提交后调用（调用方据此重新取数）。
 *   `children` 收到 `{ course, refresh, openEdit, openGenerate, notice }`。
 */
/**
 * **生成状态的唯一轮询点**（面板这一层）。
 *
 * 为什么不能只放在生成弹窗里：`/ai-course` 那种「发起后关掉弹窗」的流程下，弹窗一卸，
 * 轮询就没了 —— 界面上什么都不会动。放在这里之后：
 *   · 有活跃任务 → 1.5s 一次 `generation.status`；
 *   · 任务**刚结束** → 立刻回调 `onSettled`（调用方据此重取课程数据，状态点翻成「已生成」）；
 *   · 没有活跃任务 → 停表，零请求。
 *
 * @param {string} courseId
 * @param {() => void} onSettled 任务从「活跃」变成「结束」时调用一次
 * @returns `{ task, states }`：`task` 是当前/最近一条任务快照（给进度条用），
 *          `states` 是 `kpId → queued|running|done|failed`（给行末状态点用）
 */
function useGenerationStatus (courseId, onSettled) {
  const [task, setTask] = React.useState(null)
  const [states, setStates] = React.useState({})
  /* 用 ref 记住「上一次是不是还在跑」，避免把 onSettled 放进依赖里造成重复轮询 */
  const settledRef = React.useRef(null)
  const onSettledRef = React.useRef(onSettled)
  onSettledRef.current = onSettled

  React.useEffect(() => {
    if (!courseId) return undefined
    let alive = true
    let timer = null
    /* 失败退避：网络抖动/宿主重启不应该让状态永久停在旧值 */
    let failures = 0
    const retryDelays = [2000, 5000, 10000]
    const tick = () => {
      aicRpc('generation.status', { courseId: courseId })
        .then((res) => {
          if (!alive) return
          if (!res) throw new Error('empty-status')
          failures = 0
          const next = res.task || null
          setTask(next)
          if (res.states) setStates(res.states)
          const active = !!(res.active && (res.active.state === 'queued' || res.active.state === 'running'))
          /* 从「活跃」翻到「不活跃」→ 通知调用方重取一次（拿正文与「已生成」） */
          if (settledRef.current === true && !active) {
            settledRef.current = false
            if (onSettledRef.current) onSettledRef.current()
          }
          if (active) settledRef.current = true
          if (active) timer = setTimeout(tick, 1500)
        })
        .catch((err) => {
          if (!alive) return
          const code = err && err.code
          /* 方法不存在 / 被拒 / 没有会话：重试也没用，静默停下（界面不谎报进度） */
          if (code === 'unknown-method' || code === 'http-404' || code === 'forbidden' || code === 'no-agent') return
          if (failures < retryDelays.length) {
            const wait = retryDelays[failures++]
            timer = setTimeout(tick, wait)
          }
        })
    }
    tick()
    return () => { alive = false; if (timer) clearTimeout(timer) }
    /* `courseId` 变化时重起；`tick` 自己按「是否活跃」决定要不要继续排下一次 */
  }, [courseId])

  return { task: task, states: states }
}

/**
 * 取「主视图正在看」的会话 id（生成要用它当 `agentId`）。
 *
 * ⚠️ **不再退而取「最近更新的会话」**：面板全屏时 mainView 为 0 是正常状态，
 * 拿最近更新的会话当生成目标，内容会写进用户根本没想到的那个会话。猜不到就回空串，
 * 由 GenerateModal 给出「请先打开一个会话」的可操作提示，而不是静默挂错会话。
 *
 * 顺序：`sessions.active()`（若有）→ 快照里 `retainedBy.mainView > 0` 的那个。
 */
function aicActiveSessionId (ctx) {
  try {
    const sessions = ctx && typeof ctx.get === 'function' ? ctx.get('sessions') : null
    if (!sessions) return ''
    if (typeof sessions.active === 'function') {
      const active = sessions.active()
      if (active && typeof active.id === 'string' && active.id) return active.id
    }
    if (!sessions.list || typeof sessions.list.getSnapshot !== 'function') return ''
    const snap = sessions.list.getSnapshot() || {}
    const byId = snap.byId || {}
    for (const id of Object.keys(byId)) {
      if ((byId[id] && byId[id].retainedBy && byId[id].retainedBy.mainView) > 0) return id
    }
    return ''
  } catch {
    return ''
  }
}

function CourseEditor (props) {
  const t = props.t
  const [version, setVersion] = React.useState(0)
  const [modal, setModal] = React.useState(null)
  const [notice, setNotice] = React.useState('')

  /* 编辑期间**保留上一份数据**（useResource 的既有语义）：加载中不闪、弹窗里的表单不被卸载，
     所以「改完立刻重取」不会把正在编辑的字段打回原值。 */
  const [state, reload] = useResource(
    () => (props.courseId ? aicRpc('courses.read', { courseId: props.courseId }) : Promise.resolve(null)),
    [props.courseId, version],
  )
  const data = state.data
  const course = data && data.course ? data.course : null
  const kpProgress = (data && data.kpProgress) || {}
  const readOnly = !!(data && data.readOnly)
  const corrupt = !!(data && data.corrupt)
  const disabled = !!props.disabled || readOnly

  const refresh = () => setVersion((v) => v + 1)
  const changed = () => { if (typeof props.onChanged === 'function') props.onChanged() }

  /* 生成状态：`courses.read` 带回「已生成」/「生成中」两张映射；**有活跃任务时按 1.5s 轮询**
     （空闲时零请求）。轮询放在编辑器这一层，于是「大纲页 / 学习页 / 生成弹窗」看到的是**同一份**
     实时状态。任务一结束就 `refresh()` 重取课程数据（行末状态点翻成「已生成」）**并且**通知
     调用方（面板借此自增 `contentVersion`，让**正在看的学习页**也重取正文，不必手动刷新）。 */
  const live = useGenerationStatus(props.courseId, () => { refresh(); changed() })
  const taskStates = live.states
  const assets = (data && data.assets) || {}

  /** 提交一批修订动作：整批一个事务，失败给出原因（不落库）。 */
  const submitOps = (ops) => {
    setModal(null)
    aicRpc('outline.revise', { courseId: course.id, operations: ops }).then(
      () => { setNotice(''); refresh(); changed() },
      (err) => setNotice(String((err && err.message) || err)),
    )
  }

  /** 发起「整章 / 整门课」的批量生成（二次确认之后调用）。 */
  const startScope = (scope, chapterId) => {
    setModal(null)
    aicRpc('generation.start', {
      courseId: props.courseId,
      scope: scope,
      targetIds: chapterId ? [chapterId] : [],
      prompt: '',
      agentId: aicActiveSessionId(props.ctx),
    }).then(
      () => { setNotice(''); refresh(); changed() },
      (err) => setNotice(String((err && err.message) || err)),
    )
  }
  /** 批量生成会覆盖已生成内容 → 先确认；确认框里写清范围与数量。 */
  const confirmScope = (scope, ch) => {
    const kps = scope === 'course' ? AIC_COURSES_CORE.courseKps(course) : (ch ? ch.knowledgePoints || [] : [])
    const label = scope === 'course'
      ? (course ? course.name : '')
      : (ch ? t('modal.factChapterValue', { n: ch.order, name: ch.name }) : '')
    return h(ConfirmModal, {
      key: 'confirm-gen-' + scope,
      t: t,
      title: t('modal.genScopeTitle'),
      body: t('modal.genScopeBody', { scope: label, n: kps.length }),
      detail: t('modal.genScopeDetail'),
      confirmLabel: t('modal.genScopeConfirm'),
      onClose: () => setModal(null),
      onConfirm: () => startScope(scope, scope === 'chapter' && ch ? ch.id : ''),
    })
  }

  let modalNode = null
  if (modal && course) {
    if (modal.kind === 'confirm') {
      const next = modal.next || {}
      const ch = next.chapterId
        ? ((course.outline && course.outline.chapters) || []).filter((c) => c.id === next.chapterId)[0]
        : null
      modalNode = confirmScope(next.scope || 'course', ch)
    } else if (modal.kind === 'generate') {
      const found = aicFindKp(course, modal.kpId)
      if (found) {
        modalNode = h(GenerateModal, {
          key: 'generate-' + found.kp.id,
          t: t, ch: found.ch, kp: found.kp, kpProgress: kpProgress,
          courseId: props.courseId,
          /* 生成要用会话的 Agent（精确路由没有会话上下文，E-26）→ 带上主视图当前会话 id */
          agentId: aicActiveSessionId(props.ctx),
          hasAsset: !!assets[found.kp.id],
          state: taskStates[found.kp.id] || '',
          onClose: () => setModal(null),
          /* 发起成功 → **关闭弹窗**（状态在大纲视图上看）；关掉后由 `useGenerationStatus`
             继续轮询，行末状态点与顶部进度条实时推进；任务结束由 hook 回调 `refresh` 重取数据。 */
          onStarted: () => { setModal(null); refresh(); changed() },
        })
      }
    } else if (modal.type === 'course') {
      modalNode = h(EditModal, {
        key: 'edit-course',
        t: t, kind: 'course', course: course, disabled: disabled,
        onClose: () => setModal(null), onSubmit: submitOps,
        /* **不给 onGenerate**：课程级只编辑基础属性（名称/描述/标签/难度）。
           整门课的生成入口已按用户需求从大纲页移除（2026-10-18）；
           内容生成仍可按章节 / 按知识点发起（各自的编辑窗底部）。 */
      })
    } else if (modal.type === 'chapter') {
      const ch = ((course.outline && course.outline.chapters) || []).filter((c) => c.id === modal.chapterId)[0]
      if (ch) {
        modalNode = h(EditModal, {
          key: 'edit-chapter-' + ch.id,
          t: t, kind: 'chapter', course: course, ch: ch, disabled: disabled,
          onClose: () => setModal(null), onSubmit: submitOps,
          onGenerate: () => setModal({ kind: 'confirm', next: { kind: 'genScope', scope: 'chapter', chapterId: ch.id } }),
        })
      }
    } else {
      const found = aicFindKp(course, modal.kpId)
      if (found) {
        modalNode = h(EditModal, {
          key: 'edit-kp-' + found.kp.id,
          t: t, kind: 'kp', course: course, ch: found.ch, kp: found.kp, disabled: disabled,
          onClose: () => setModal(null), onSubmit: submitOps,
          /* 知识点生成：改完属性直接进入生成弹窗（属性变更在这里**不自动保存**，
             避免"只想生成"却把半填的表单写进去） */
          onGenerate: () => setModal({ kind: 'generate', kpId: found.kp.id }),
        })
      }
    }
  }
  /* 目标消失（例如别处删掉了）→ 清掉弹窗状态，避免下一次数据更新又把它弹出来 */
  React.useEffect(() => {
    if (modal && course && !modalNode) setModal(null)
  })

  const api = {
    course: course,
    taskStates: taskStates,
    assets: assets,
    task: live.task,
    data: data,
    state: state.status,
    error: state.error,
    kpProgress: kpProgress,
    readOnly: readOnly,
    corrupt: corrupt,
    disabled: disabled,
    notice: notice,
    setNotice: setNotice,
    refresh: refresh,
    /* 批量修订：大纲的「章节编辑」（+/-）直接用它 —— 与弹窗保存走**同一条** outline.revise
       事务与同一次数据刷新，避免出现"弹窗保存会刷新、+/- 不刷新"的两套行为。 */
    submitOps: submitOps,
    openEdit: (type, target) => {
      if (type === 'course') setModal({ kind: 'edit', type: 'course' })
      else if (type === 'chapter') setModal({ kind: 'edit', type: 'chapter', chapterId: target.id })
      else setModal({ kind: 'edit', type: 'kp', kpId: target.kp.id })
    },
    /* 打开生成弹窗。**两种调用口径都收**：大纲/学习页传 `(ch, kp)`，卡片式调用可能只给 kp。
       签名不一致会让"点了没反应/报 undefined"——这里统一成 kpId。 */
    openGenerate: (ch, kp) => {
      /* 两种调用口径：大纲/学习页传 `(ch, kp)`；防御性地接受「只给 kp」。 */
      const target = (kp && kp.id) ? kp : (ch && ch.id && ch.contentType ? ch : null)
      if (!target) {
        /* 参数不对是**代码**问题，不该弹给用户；记一笔并返回，不打开空弹窗 */
        console.warn('[ai-courses] openGenerate 缺少知识点参数')
        return
      }
      setModal({ kind: 'generate', kpId: target.id })
    },
    /* 供调用方复用同一套「失败给原因」的通道（例如卡片里点生成但宿主还没有链路） */
    submit: submitOps,
  }

  return h(React.Fragment, null, props.children(api), modalNode)
}

/* ==================== src/client/65-outline-card.js ==================== */

/* ==================== src/client/65-outline-card.js ====================
 * **主会话里的课程大纲卡片**：`/ai-course` 生成大纲后，把大纲视图作为独立控件展示在回复末尾
 *
 * 挂载点：`conversation.chat.turnTail`（ui-chat 声明的 list / session 槽）——
 * 宿主在每个回合末尾渲染它，`owner` 给 `{ turn, seq, openFile }`，框架另给 `sessionId`。
 *
 * 「哪一轮该显示」由**时间**判定，不靠猜：
 *   状态表里记着这次推导的 `startedAt` / `updatedAt`，而 turn 上有 `start` / `end` 事件时间
 *   → 只有「推导落在本回合时间内」的那个回合才渲染卡片。于是：
 *     · 一次 `/ai-course` 最多出现一张卡片（不会每回合都长一张）
 *     · 刷新页面后仍在（状态表在宿主内存里；DSH 重启后不显示 —— 与进度卡同一口径）
 *     · 同一会话连做几次推导，各自落在各自的回合里
 *
 * 编辑能力**不是**这里另写一套：`CourseEditor`（62-editor.js）与课程面板共用同一份，
 * 改完 `outline.revise` 成功后卡片自己重取 `courses.read`。
 * ========================================================================== */

/**
 * 本回合生成的那几门课（按落库时间落在 turn 的时间窗内判定）。
 *
 * 实现放在 `10-core.js` 的 `coursesOfTurn` 里 —— 那一段是**纯逻辑段**，能在 node 里
 * 真实求值并断言（doc/09 §7.2：不许拿 mock 渲染当验证）。这里只做一次转手，
 * 让组件代码读起来仍然自明。
 */
function aicCoursesOfTurn (courses, turn) {
  return AIC_COURSES_CORE.coursesOfTurn(courses, turn)
}

/** 卡片头部的书本图标（与侧边栏面板图标同款外形，尺寸更小）。 */
function OutlineCardIcon () {
  return h(
    'svg',
    {
      className: 'aic-outcard__icon', width: 16, height: 16, viewBox: '0 0 24 24', fill: 'none',
      stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round', strokeLinejoin: 'round',
      'aria-hidden': 'true', focusable: 'false',
    },
    h('path', { key: 'a', d: 'M4 5.5A1.5 1.5 0 0 1 5.5 4H10a2 2 0 0 1 2 2v13a1.5 1.5 0 0 0-1.5-1.5H5.5A1.5 1.5 0 0 1 4 16V5.5Z' }),
    h('path', { key: 'b', d: 'M20 5.5A1.5 1.5 0 0 0 18.5 4H14a2 2 0 0 0-2 2v13a1.5 1.5 0 0 1 1.5-1.5h5A1.5 1.5 0 0 0 20 16V5.5Z' }),
  )
}

/**
 * 一张课程大纲卡片。
 * @param {object} props 槽给的 props（`sessionId`、`turn`、`seq`）+ 本插件注入的 `t` / `ctx`
 */
function AicOutlineCard (props) {
  const t = props.t
  const core = AIC_COURSES_CORE
  const sessionId = props.sessionId
  const turn = props.turn
  /* 本回合该显示的课程 —— 在**任何 hook 之前**先算（拿不到就整卡不渲染，避免每回合长一张空卡） */
  const mine = aicCoursesOfTurn(props.courses, turn)
  const latest = mine.length ? mine[mine.length - 1] : null

  const [status, setStatus] = React.useState(null)
  const [loaded, setLoaded] = React.useState(false)
  const [refreshToken, setRefreshToken] = React.useState(0)
  const [collapsed, setCollapsed] = React.useState(false)

  /* 取本会话的推导状态（含课程列表）。挂载时取一次 + 每次编辑成功后重取：
     卡片不需要轮询 —— 进度由 55-status-card 负责，这里只关心「有没有生成过课」。 */
  React.useEffect(() => {
    if (!sessionId) return undefined
    let alive = true
    aicRpc('status.get', { sessionId: sessionId })
      .then((value) => { if (alive) { setStatus(value || null); setLoaded(true) } })
      .catch(() => { if (alive) { setStatus(null); setLoaded(true) } })
    return () => { alive = false }
  }, [sessionId, refreshToken])

  if (!latest) return null

  const onChanged = () => setRefreshToken((n) => n + 1)

  /* 课程数据 + 弹窗 + 修订提交都走共享编辑器；这里只画卡片外壳。 */
  return h(CourseEditor, { courseId: latest.courseId, t: t, onChanged: onChanged }, (ed) => {
    const course = ed.course
    const total = Number(latest.kpCount) || 0
    const mastered = course ? core.masteredCount(course, ed.kpProgress || {}) : 0
    const ratio = total > 0 ? mastered / total : 0
    const chapters = course ? ((course.outline && course.outline.chapters) || []) : []

    return h(
      'section',
      { className: 'aic-outcard', 'aria-label': t('outcard.title') },
      h(
        'header',
        { className: 'aic-outcard__head' },
        h(OutlineCardIcon),
        h('span', { className: 'aic-outcard__title' }, t('outcard.title')),
        /* 课程名优先用**现取**的（改名后立刻正确），拿不到才回落到状态表里的快照 */
        h('span', { className: 'aic-outcard__name' }, (course && course.name) || latest.courseName),
        h('span', { className: 'aic-outcard__badge' }, t('outcard.editable')),
        h(
          'span',
          { className: 'aic-outcard__tools' },
          h('button', {
            className: 'aic-btn aic-btn--sm',
            type: 'button',
            disabled: !course,
            /* 与命令卡/状态条一致：导航 + 切面板（否则面板没打开时点了没反应） */
            onClick: () => aicOpenCourseIn(props.ctx, latest.courseId, 'outline'),
          }, t('outcard.openOutline')),
          h(IconButton, {
            name: 'prev',
            label: collapsed ? t('outcard.expand') : t('outcard.collapse'),
            pressed: collapsed,
            onClick: () => setCollapsed((v) => !v),
          }),
        ),
      ),

      /* 规模与学习进度：数据取状态表（会话级事实）与 courses.read（当前事实） */
      h(
        'div',
        { className: 'aic-outcard__meta' },
        h('span', null, t('outcard.scale', { chapters: chapters.length || Number(latest.chapterCount) || 0, kps: total })),
        h('span', { className: 'aic-outcard__progress' },
          h('span', null, t('outcard.progress')),
          h(ProgressBar, { t: t, ratio: ratio })),
        course && course.difficulty ? h('span', { className: 'aic-tag' }, course.difficulty) : null,
        course && (course.tags || []).length
          ? h('span', { className: 'aic-outcard__tags' },
              (course.tags || []).map((tag) => h('span', { className: 'aic-tag', key: tag }, tag)))
          : null,
      ),

      ed.notice ? h(Notice, null, ed.notice) : null,
      ed.state === 'error' && !course
        ? h(Notice, null, t('outcard.loadFailed'))
        : null,

      collapsed
        ? null
        : h(
            'div',
            { className: 'aic-outcard__body' },
            course
              ? h(OutlineView, {
                  t: t,
                  course: course,
                  kpProgress: ed.kpProgress || {},
                  variant: 'embed',
                  mode: 'edit',
                  readOnly: ed.readOnly,
                  corrupt: ed.corrupt,
                  disabled: ed.disabled,
                  onEdit: ed.openEdit,
                  /* 结构模式（章节编辑）在这张卡片上也保留 —— 它和面板用的是同一棵树 */
                  onStructure: ed.submitOps,
                  /* 课程/章节级的「生成」在面板里也是「M2 未接」的提示，这里保持一致 */
                  onGenerateCourse: () => ed.setNotice(t('outline.generateM2', { label: t('outline.generateCourse') })),
                  onGenerateChapter: () => ed.setNotice(t('outline.generateM2', { label: t('outline.generateChapter') })),
                  onGenerateKp: ed.openGenerate,
                })
              : h('div', { className: 'aic-muted' }, t('outcard.loading')),
          ),
    )
  })
}

/**
 * 注册到大纲卡槽。
 * `turnTail` 也是**别的包声明**的槽（ui-chat 的 turn-tail 节点声明它），因此同样走 `slots.inject`。
 */
function aicRegisterOutlineCard (ctx, slots, t) {
  const disposers = []
  if (!slots || typeof slots.inject !== 'function') return disposers
  disposers.push(
    slots.inject('conversation.chat.turnTail', () => slots.register(
      { name: 'conversation.chat.turnTail', id: 'dsh-ai-courses/outline-card' },
      (props) => h(AicOutlineCard, Object.assign({}, props, { ctx: ctx, t: t })),
    )),
  )
  return disposers
}

/* ==================== src/client/70-lesson.js ==================== */

/* ==================== src/client/70-lesson.js ====================
 * 视图：学习页（06 §5）—— **M1 只落骨架**
 *
 * M1 范围（T-9）：面包屑、h1、学习时长、「未生成」空态（含路径提示与生成入口）、
 * 底部「上一节 / 下一节」导航卡（跨章节顺序 + 首末节等宽占位）。
 *
 * 明确留给 M2（T-12 / T-13）：
 *   · `图文` / `幻灯片` 渲染器与四种待定类型的安全网降级（AC-10 / AC-14 ~ AC-16）
 *   · 右侧只读大纲抽屉（`sidebarRightTabs` 两段式 API，AC-18 / AC-22 / AC-34）
 *   · 进度标记（打开 → 进行中、离开 → 已掌握，AC-9）
 * M1 的宿主也还没有内容资产通道，所以内容区**必然**是「未生成」空态 —— 这是真实状态，不是占位假数据。
 * ========================================================================== */

/** 上一节 / 下一节导航卡：首末节缺失的一侧用**等宽空占位**保持两列对齐（06 §5）。 */
function LessonNav (props) {
  const t = props.t
  const core = AIC_COURSES_CORE
  const list = core.courseKps(props.course)
  const idx = list.findIndex((x) => x.kp.id === props.kp.id)
  if (idx < 0) return null
  const prev = idx > 0 ? list[idx - 1] : null
  const next = idx < list.length - 1 ? list[idx + 1] : null
  /* 完整字面量类名（不拼接）：check.mjs 的「类名都有规则」断言依赖它 */
  const cardCls = { prev: 'aic-navcard aic-navcard--prev', next: 'aic-navcard aic-navcard--next' }
  const card = (item, dir, label, icon) =>
    item
      ? h(
          'button',
          {
            className: cardCls[dir],
            type: 'button',
            onClick: () => props.onOpenKp(item.ch, item.kp),
          },
          h('span', { className: 'aic-navcard__dir' }, h(Icon, { name: icon }), h('span', null, label)),
          h('span', { className: 'aic-navcard__name' }, item.kp.name),
        )
      : h('span', { className: 'aic-navcard aic-navcard--empty', 'aria-hidden': 'true' })
  return h(
    'nav',
    { className: 'aic-lesson__nav', 'aria-label': t('lesson.navAria') },
    card(prev, 'prev', t('lesson.navPrev'), 'prev'),
    card(next, 'next', t('lesson.navNext'), 'next'),
  )
}

/**
 * 学习页（06 §5）。
 *
 * 数据：`contentAssets.get`（正文 + 媒体清单）。**进度由「打开 / 离开」驱动**（05 §6.1 / Q-14）：
 * 打开 → `进行中`（已掌握不回退）；离开/切换 → `已掌握`。没有「标记已掌握」按钮。
 */
function LessonView (props) {
  const t = props.t
  const core = AIC_COURSES_CORE
  const course = props.course
  const ch = props.ch
  const kp = props.kp
  const relPath = core.contentRelPath(kp.id, kp.contentType)

  const [payload, setPayload] = React.useState(null)
  const [loadError, setLoadError] = React.useState('')

  /* 取内容资产（切知识点时重取；上一份内容不保留 —— 换知识点必须换内容，避免串课） */
  React.useEffect(() => {
    let alive = true
    setPayload(null)
    setLoadError('')
    aicRpc('contentAssets.get', { courseId: course.id, kpId: kp.id })
      .then((res) => { if (alive) setPayload(res) },
        (err) => { if (alive) setLoadError(String((err && err.message) || err)) })
    return () => { alive = false }
  }, [course.id, kp.id, props.version])

  /* 进度：打开 → 进行中；离开（卸载/切换）→ 已掌握。都**不阻塞界面**（fire-and-forget）。
     ⚠️ **只有内容已生成**才记：还没生成内容的知识点，"学过/学完"没有意义（05 §6.1）——
     否则空态页一进一出就给这门课刷出「已掌握 N 个」，进度全是假的。
     所以要等载荷到、并确认 `hasAsset` 才标记；离开时的「已掌握」也只在本组件真的标过之后发。 */
  const mark = props.onMark
  const markedRef = React.useRef(false)
  const hadAsset = !!(payload && payload.hasAsset)
  React.useEffect(() => {
    markedRef.current = false
    if (!mark || !hadAsset) return undefined
    mark('进行中')
    markedRef.current = true
    return () => {
      if (markedRef.current) mark('已掌握')
      markedRef.current = false
    }
  }, [course.id, kp.id, hadAsset])

  /* 图片：把正文里的**相对路径**换成 host 的媒体路由 URL（图片只从课程目录里取） */
  const bodyDir = 'content-assets'
  const resolveUrl = (raw) => aicMediaUrl(course.id, bodyDir, raw)

  const hasAsset = !!(payload && payload.hasAsset)
  const content = (() => {
    if (loadError) {
      return h('div', { className: 'aic-error' },
        h('div', { className: 'aic-error__title' }, t('lesson.loadErrorTitle')),
        h('div', { className: 'aic-muted' }, loadError),
        h('div', { style: { marginTop: '10px' } },
          h('button', { className: 'aic-btn', type: 'button', onClick: () => props.onRegenerate(ch, kp) }, t('lesson.regenerate'))))
    }
    if (!payload) return h(PageState, { title: t('lesson.contentLoading'), retry: '', onRetry: () => {} })
    if (hasAsset) {
      return h(ContentView, {
        t: t,
        payload: payload,
        formatPending: !!payload.formatPending,
        resolveUrl: resolveUrl,
      })
    }
    return h(
      'div',
      { className: 'aic-empty' },
      h('div', { className: 'aic-empty__title' }, t('lesson.emptyTitle')),
      h('div', null, t('lesson.emptyBody')),
      h('div', { className: 'aic-empty__hint' }, relPath),
      h('div', { style: { marginTop: '12px' } },
        h('button', { className: 'aic-btn', type: 'button', onClick: () => props.onGenerate(ch, kp) }, t('lesson.emptyAction'))),
    )
  })()

  return h(
    'div',
    { className: 'aic-lesson' },
    h(
      'div',
      { className: 'aic-pagehead' },
      h(
        'div',
        null,
        h(Breadcrumb, {
          t: t,
          items: [
            { label: t('library.title'), onClick: props.onBack },
            { label: course.name, onClick: () => props.onOpenOutline(course.id) },
            { label: ch.name },
          ],
        }),
        h('h1', { className: 'aic-h1' }, kp.name),
        /* 教学时长按**实际正文**算（host 在 contentAssets.get 里给 `minutes`）；
           `kp.duration` 只是入库时的值，旧数据可能是大纲阶段的估值，仅作兜底。 */
        h('div', { className: 'aic-lesson__meta' },
          h(DurationLabel, { t: t, minutes: (payload && payload.minutes) || kp.duration })),
      ),
      h(
        'span',
        { className: 'aic-row__right' },
        hasAsset
          ? h(IconButton, { name: 'generate', label: t('lesson.regenerate'), onClick: () => props.onRegenerate(ch, kp) })
          : null,
        h(GenIcon, { t: t, state: core.kpGenState(props.itemStates, hasAsset), scope: 'Kp' }),
      ),
    ),
    h(
      'div',
      { className: 'aic-lesson__body' },
      h(
        'div',
        { className: 'aic-lesson__inner' },
        h('div', { className: 'aic-lesson__content' }, content),
        h(LessonNav, { t: t, course: course, kp: kp, onOpenKp: props.onOpenKp }),
      ),
    ),
  )
}

/* ==================== src/client/75-content.js ==================== */

/* ==================== src/client/75-content.js ====================
 * 内容渲染（06 §5 / §7.1）：`图文`（Markdown 子集）与 `幻灯片`（Slidev 子集播放器）
 *
 * 安全与降级（AC-16 / AC-17）：
 *   · 渲染路径**不用 `innerHTML`**，也不用 `dangerouslySetInnerHTML` —— 全部走 React 元素。
 *   · 正文是不可信输入：HTML 标签一律当**纯文本**显示（不当 HTML 执行）。
 *   · 未知版式 → 按 `default` 渲染并给出提示，**绝不白屏**。
 *   · 图片只认「课程目录内的相对路径」，经 host 的媒体路由取回；外部 URL 不渲染成图。
 * ========================================================================== */

/* ------------------------------------------------------------------ 行内 */

/* 标题标签用**字面量表**而不是 `'h' + level`：本项目禁止动态拼类名/标签，
   静态断言（scripts/check.mjs）才能继续机械地守住这条线。 */
const HEADING_TAGS = { 1: 'h2', 2: 'h2', 3: 'h3', 4: 'h4', 5: 'h5', 6: 'h6' }

/* 版式 → DOM 修饰类：**全部写成完整字面量**（不拼字符串），
   这样 `scripts/check.mjs` 的「每个 aic- 类都有规则」断言还能继续守住。 */
const SLIDE_CLASS = {
  default: 'aic-slide aic-slide--default',
  cover: 'aic-slide aic-slide--cover',
  center: 'aic-slide aic-slide--center',
  'two-cols': 'aic-slide aic-slide--two-cols',
  'two-cols-header': 'aic-slide aic-slide--two-cols-header',
  'image-right': 'aic-slide aic-slide--image-right',
  'image-left': 'aic-slide aic-slide--image-left',
  quote: 'aic-slide aic-slide--quote',
}

const INLINE_RE = /(`[^`]+`)|(\*\*[^*]+\*\*)|(\*[^*\n]+\*)|(!?\[[^\]]*\]\([^)\s]+\))|(<br\s*\/?>)/gi

/** 行内元素 → React 片段（**不经 innerHTML**）。`resolveUrl` 把相对路径换成媒体路由 URL。 */
function inlineNodes (text, keyPrefix, resolveUrl, t) {
  const out = []
  let last = 0
  let i = 0
  const src = String(text ?? '')
  INLINE_RE.lastIndex = 0
  let m
  while ((m = INLINE_RE.exec(src)) !== null) {
    if (m.index > last) out.push(src.slice(last, m.index))
    const token = m[0]
    const key = keyPrefix + '-' + (i++)
    if (token.startsWith('`')) {
      out.push(h('code', { key: key }, token.slice(1, -1)))
    } else if (token.startsWith('**')) {
      out.push(h('strong', { key: key }, token.slice(2, -2)))
    } else if (token.startsWith('*')) {
      out.push(h('em', { key: key }, token.slice(1, -1)))
    } else if (/^<br/i.test(token)) {
      /* 模型常在单元格/段落里写 `<br>` 换行：渲染成真正的换行，而不是字面文本 */
      out.push(h('br', { key: key }))
    } else {
      const isImg = token.startsWith('!')
      const mm = token.match(/^!?\[([^\]]*)\]\(([^)\s]+)\)$/)
      if (!mm) { out.push(token); }
      else {
        const label = mm[1]
        const url = resolveUrl(mm[2])
        if (isImg) {
          out.push(url
            ? h(Figure, { key: key, src: url, alt: label, t: t })
            : h('span', { key: key, className: 'aic-muted' }, label || t('lesson.imageFallback')))
        } else {
          /* 只允许相对/站内链接；外部链接当纯文本（v1 不做外链跳转，避免点了跑掉） */
          out.push(url && url.startsWith('/')
            ? h('a', { key: key, className: 'aic-link', href: url }, label || url)
            : h('span', { key: key, className: 'aic-link' }, label || mm[2]))
        }
      }
    }
    last = m.index + token.length
  }
  if (last < src.length) out.push(src.slice(last))
  return out
}

/* ------------------------------------------------------------------ 块级 */

/** fenced code block 的开头（``` 或 ~~~，可带语言）。 */
const FENCE_RE = /^\s*(`{3,}|~{3,})\s*([\w+-]*)\s*$/

/** 单元格里的 HTML → 纯文本：删标签、`<br>` 变空格、解几个常见实体。 */
function htmlCellText (html) {
  const stripped = String(html ?? '')
    /* script/style **连内容一起**丢掉：只删标签会把里面的代码当正文留在单元格里 */
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, '')
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<[^>]*>/g, '')
  /* 实体解码与代码块**共用一套**（`&#x27;` 这类十六进制实体两处都要认） */
  return unescapeHtml(stripped).trim()
}

/** 解析原始 HTML 表格 → `[{ header, cells }]`（只认 table 相关的几个标签）。 */
function parseHtmlTableRows (html) {
  const src = String(html ?? '')
  const rows = []
  const rowRe = /<tr\b[^>]*>([\s\S]*?)<\/tr\s*>/gi
  let m
  while ((m = rowRe.exec(src)) !== null) {
    const cells = []
    const cellRe = /<(th|td)\b[^>]*>([\s\S]*?)<\/\1\s*>/gi
    let c
    let header = false
    while ((c = cellRe.exec(m[1])) !== null) {
      if (c[1].toLowerCase() === 'th') header = true
      cells.push(htmlCellText(c[2]))
    }
    if (cells.length) rows.push({ header: header, cells: cells })
  }
  return rows
}

/** 统一成和管道表**完全一样**的 table 元素（样式只需一套）。 */
function htmlTableNode (rows, k, resolveUrl, t) {
  const headRow = rows.find((r) => r.header)
  const bodyRows = rows.filter((r) => r !== headRow)
  let cols = 0
  for (const r of rows) cols = Math.max(cols, r.cells.length)
  const pad = (cells) => {
    const out = cells.slice()
    while (out.length < cols) out.push('')
    return out
  }
  return h(
    'table',
    { key: k() },
    headRow
      ? h('thead', null, h('tr', null, pad(headRow.cells).map((c, ci) => h('th', { key: ci }, inlineNodes(c, k(), resolveUrl, t)))))
      : null,
    h('tbody', null, bodyRows.map((r, ri) =>
      h('tr', { key: ri }, pad(r.cells).map((c, ci) => h('td', { key: ci }, inlineNodes(c, k(), resolveUrl, t)))))),
  )
}

function isTableRow (line) { return /^\s*\|.*\|\s*$/.test(line) }
function isTableSep (line) { return /^\s*\|[\s:|-]+\|\s*$/.test(line) && /-/.test(line) }

/**
 * Markdown 子集 → React 元素数组。
 * 支持：`##`/`###` 标题、段落、无序/有序列表、围栏代码块、引用、表格、图片、行内粗体/斜体/代码/链接。
 */
function renderMarkdown (text, resolveUrl, t) {
  /* 学习页渲染的是**文件正文**，而宿主写文件时会加 YAML frontmatter（`title:` 等）——
     不剥就会把那段当「分隔线 + 字面文本」显示出来。剥离规则在 core 里（纯函数、有真值表）。 */
  const clean = AIC_COURSES_CORE.stripFrontmatter(text)
  const lines = String(clean ?? '').replace(/\r\n/g, '\n').split('\n')
  const out = []
  let i = 0
  let key = 0
  const k = () => 'md-' + (key++)

  while (i < lines.length) {
    const line = lines[i]

    /* 空行 */
    if (!line.trim()) { i++; continue }

    /* 围栏代码块 */
    const fence = FENCE_RE.exec(line)
    if (fence) {
      const marker = fence[1][0]
      const lang = fence[2] || ''
      const buf = []
      i++
      while (i < lines.length && !new RegExp('^\\s*' + marker + '{3,}\\s*$').test(lines[i])) { buf.push(lines[i]); i++ }
      i++ /* 吃掉收尾围栏（没有也照样收口，不吞后面的内容） */
      const source = buf.join('\n')
      /* mermaid 走**图表渲染**（按需加载渲染器，失败降级成源码块）；
         其余语言只当**标记类**（CSS 有意不为每种语言定义规则），不拼字符串、用字面量 */
      if (lang.toLowerCase() === 'mermaid') {
        out.push(h(MermaidChart, { key: k(), t: t, source: source }))
      } else {
        /* 代码块**带高亮**（按需加载 highlight.js；拿不到就退回纯文本，不白屏） */
        out.push(h(CodeBlock, { key: k(), lang: lang, source: source }))
      }
      continue
    }

    /* 标题（正文里不应有 h1，但真出现了也照原样降级成 h2，绝不吞掉内容） */
    const heading = /^(#{1,6})\s+(.*)$/.exec(line)
    if (heading) {
      const tag = HEADING_TAGS[Math.min(6, Math.max(1, heading[1].length))] || 'h3'
      out.push(h(tag, { key: k() }, inlineNodes(heading[2], k(), resolveUrl, t)))
      i++
      continue
    }

    /* 原始 HTML 表格：模型经常直接写 `<table><tr><td>…`（管道表之外的另一种常见写法）。
       **不用 innerHTML**：只认 table/thead/tbody/tr/th/td，逐格取出纯文本再走行内解析 ——
       夹带的其他标签只会被当文本剥掉，不会执行。 */
    if (/^\s*<table\b/i.test(line)) {
      const buf = []
      while (i < lines.length) {
        buf.push(lines[i])
        if (/<\/table\s*>/i.test(lines[i])) { i++; break }
        i++
      }
      const rows = parseHtmlTableRows(buf.join('\n'))
      if (rows.length) out.push(htmlTableNode(rows, k, resolveUrl, t))
      continue
    }

    /* 表格（管道表） */
    if (isTableRow(line) && i + 1 < lines.length && isTableSep(lines[i + 1])) {
      const head = line.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim())
      i += 2
      const rows = []
      while (i < lines.length && isTableRow(lines[i])) {
        rows.push(lines[i].trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim()))
        i++
      }
      out.push(h('table', { key: k() },
        h('thead', null, h('tr', null, head.map((c, ci) => h('th', { key: ci }, inlineNodes(c, k(), resolveUrl, t))))),
        h('tbody', null, rows.map((r, ri) => h('tr', { key: ri }, r.map((c, ci) => h('td', { key: ci }, inlineNodes(c, k(), resolveUrl, t))))))))
      continue
    }

    /* 引用 */
    if (/^\s*>\s?/.test(line)) {
      const buf = []
      while (i < lines.length && /^\s*>\s?/.test(lines[i])) { buf.push(lines[i].replace(/^\s*>\s?/, '')); i++ }
      out.push(h('blockquote', { key: k() }, renderMarkdown(buf.join('\n'), resolveUrl, t)))
      continue
    }

    /* 列表（连续同类项合成一个列表） */
    const ul = /^\s*[-*+]\s+(.*)$/.exec(line)
    const ol = /^\s*\d+[.)]\s+(.*)$/.exec(line)
    if (ul || ol) {
      const ordered = !!ol
      const items = []
      while (i < lines.length) {
        const m = ordered ? /^\s*\d+[.)]\s+(.*)$/.exec(lines[i]) : /^\s*[-*+]\s+(.*)$/.exec(lines[i])
        if (!m) break
        items.push(m[1])
        i++
      }
      const Tag = ordered ? 'ol' : 'ul'
      out.push(h(Tag, { key: k() }, items.map((item, ti) => h('li', { key: ti }, inlineNodes(item, k(), resolveUrl, t)))))
      continue
    }

    /* 段落：合并到下一个空行 */
    const buf = [line]
    i++
    while (i < lines.length && lines[i].trim() &&
           !FENCE_RE.test(lines[i]) && !/^(#{1,6})\s+/.test(lines[i]) &&
           !/^\s*>\s?/.test(lines[i]) && !/^\s*[-*+]\s+/.test(lines[i]) &&
           !/^\s*\d+[.)]\s+/.test(lines[i]) && !isTableRow(lines[i])) {
      buf.push(lines[i])
      i++
    }
    out.push(h('p', { key: k() }, inlineNodes(buf.join('\n'), k(), resolveUrl, t)))
  }
  return out
}

/* --------------------------------------------------------------- 图片 */

/**
 * 把要内联进文档的 SVG 再"卸一遍武装"。
 *
 * 为什么不能只删 `<script>`：SVG 里的事件属性（`onload` / `onerror`）、`href` /
 * `xlink:href`（`javascript:` 或外部图片）、`foreignObject`、`<image>`、`<use>`、
 * `<style>`（`@import` / `url()`）都能在元素被 `importNode` 进文档后产生副作用。
 * host 的 media 路由已经挡了一层；这里是**客户端兜底**（历史文件、进程未重启、
 * 用户手工放进课程库的文件都可能绕过 host 的清洗）。
 *
 * 只用于「图片 onError 后的自救内联」；Mermaid 的 SVG 有自己的 strict 输出与样式，
 * 不走这个函数（删掉它的 `<style>` 会让图表失去配色）。
 */
function hardenInlineSvg (root) {
  if (!root || !root.querySelectorAll) return root
  const nodes = [root].concat(Array.from(root.querySelectorAll('*')))
  for (const el of nodes) {
    const attrs = el.attributes ? Array.from(el.attributes) : []
    for (const attr of attrs) {
      const name = String(attr.name || '').toLowerCase()
      const value = String(attr.value || '')
      const isEvent = name.startsWith('on')
      const isLink = name === 'href' || name === 'xlink:href' || name === 'src'
      const isBadStyle = name === 'style' && /url\s*\(|expression|javascript:/i.test(value)
      if (isEvent || isLink || isBadStyle) el.removeAttribute(attr.name)
    }
  }
  const bad = root.querySelectorAll('script,foreignObject,iframe,image,use,style')
  for (const el of bad) if (el.parentNode) el.parentNode.removeChild(el)
  return root
}

/**
 * 一张图片。
 *
 * 为什么要包一层：课程库里的 SVG 可能**不是合法 XML**（早期清洗器的 bug），而浏览器用
 * `<img src="*.svg">` 载入时按**严格 XML** 解析 → 图静默不显示，页面上只有一块空白。
 * 这里在 `onError` 时**自己去取文本、修一次、改成内联 SVG**，于是：
 *   · 宿主已经修好的文件 → 走正常 `<img>`（有缓存、有懒加载）；
 *   · 宿主的修复还没生效（进程是旧的）→ 前端自救，图照样显示。
 * 都失败才露出 alt 文本，不白屏。
 */
function Figure (props) {
  const t = props.t
  const [mode, setMode] = React.useState('img')      /* img | inline | broken */
  const hostRef = React.useRef(null)

  React.useEffect(function () { setMode('img') }, [props.src])

  const onError = function () {
    if (mode !== 'img') return
    const url = props.src
    if (typeof fetch !== 'function') { setMode('broken'); return }
    fetch(url, { credentials: 'same-origin' })
      .then(function (res) { if (!res.ok) throw new Error('http-' + res.status); return res.text() })
      .then(function (text) {
        const fixed = AIC_COURSES_CORE.repairSvgText(text)
        if (typeof DOMParser !== 'function') throw new Error('no-domparser')
        const doc = new DOMParser().parseFromString(fixed, 'image/svg+xml')
        const root = doc && doc.documentElement
        if (!root || root.nodeName.toLowerCase() === 'parsererror') throw new Error('still-bad')
        hardenInlineSvg(root)
        setMode('inline')
        setTimeout(function () {
          const el = hostRef.current
          if (!el) return
          while (el.firstChild) el.removeChild(el.firstChild)
          el.appendChild(document.importNode(root, true))
        }, 0)
      })
      .catch(function () { setMode('broken') })
  }

  if (mode === 'inline') {
    return h('span', { className: 'aic-figure', role: 'img', 'aria-label': props.alt || t('lesson.diagram'), ref: hostRef })
  }
  if (mode === 'broken') {
    return h('span', { className: 'aic-muted aic-figure--broken' }, props.alt || t('lesson.imageFallback'))
  }
  return h('img', { className: 'aic-figure', src: props.src, alt: props.alt, loading: 'lazy', onError: onError })
}

/* ---------------------------------------------------------------- Mermaid */

/**
 * Mermaid 渲染器的**按需加载器**（同一个页面只加载一次）。
 *
 * 为什么从宿主路由加载、而不是 `import('mermaid')`：
 *   客户端模块表只认「启动图里的行」或平台种子，第三方裸包**不在其中**（实测会报
 *   `cannot resolve`）。所以 Mermaid 作为**插件自带的静态资源**由宿主送出去，
 *   用 `<script>` 注入 —— 与「按需」天然契合（没图就不下载这 3.4 MB）。
 */
const AIC_VENDOR_BASE = '/dsh-ai-courses/vendor/'
/* 每个 vendor 脚本只注入一次；失败则清掉缓存，下次用到时重试 */
const aicVendorLoads = {}

/**
 * 按需注入一个 vendor 脚本，并等它挂到 `window[globalName]` 上。
 *
 * 为什么要注入 `<script>` 而不是 `import()`：客户端模块表只认启动图里的行，
 * 第三方裸包不在其中（E-37）；而它们体积不小（Mermaid 3.4 MB、highlight.js 130 KB），
 * 塞进 client bundle 会让每次插件迭代都重下。
 */
/** 取脚本挂上来的全局对象（浏览器里 `window === globalThis`；也照顾只在 globalThis 上挂的情况）。 */
function aicVendorGlobal (name) {
  if (typeof window !== 'undefined' && window && window[name]) return window[name]
  if (typeof globalThis !== 'undefined' && globalThis && globalThis[name]) return globalThis[name]
  return undefined
}

function aicLoadVendor (file, globalName) {
  const ready = aicVendorGlobal(globalName)
  if (ready) return Promise.resolve(ready)
  if (aicVendorLoads[file]) return aicVendorLoads[file]
  aicVendorLoads[file] = new Promise(function (resolve, reject) {
    if (typeof document === 'undefined' || !document.head) { reject(new Error('no-dom')); return }
    const el = document.createElement('script')
    el.src = AIC_VENDOR_BASE + file
    el.async = true
    el.onload = function () {
      const mod = aicVendorGlobal(globalName)
      if (mod) resolve(mod)
      else reject(new Error('missing-global'))
    }
    el.onerror = function () { reject(new Error('script-load-failed')) }
    document.head.appendChild(el)
  }).catch(function (err) {
    aicVendorLoads[file] = null
    throw err
  })
  return aicVendorLoads[file]
}

/** Mermaid 渲染器（3.4 MB，只有出现图表时才加载）。 */
function aicLoadMermaid () { return aicLoadVendor('mermaid.min.js', 'mermaid') }
/** 代码高亮器（130 KB，只有出现代码块时才加载）。 */
function aicLoadHljs () { return aicLoadVendor('highlight.min.js', 'hljs') }

/**
 * 一张 Mermaid 图（` ```mermaid ` 围栏）。
 *
 * 三级降级，**任何一级都不白屏**：
 *   ① 渲染成功 → 内联 SVG（跟随主题色）；
 *   ② 渲染器加载不到 / 语法错 → 提示 + **源码代码块**（内容仍可读、可复制）；
 *   ③ 还在加载 → 占位文案。
 *
 * 安全：`securityLevel: 'strict'`（Mermaid 官方对不可信输入的建议），`htmlLabels: false`。
 */
function MermaidChart (props) {
  const t = props.t
  const [state, setState] = React.useState({ status: 'loading', error: '' })
  const hostRef = React.useRef(null)
  const svgRef = React.useRef('')

  React.useEffect(() => {
    let alive = true
    setState({ status: 'loading', error: '' })
    svgRef.current = ''
    aicLoadMermaid()
      .then(function (mermaid) {
        if (!alive) return null
        try { mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', htmlLabels: false, theme: 'base' }) } catch { /* 初始化失败照样试渲染 */ }
        /* id 只用 mermaid 自己的命名空间：`aic-` 是**类名**前缀，动态拼它会被
           「禁止动态拼 class」那条静态检查拦住（而且也不该拼） */
        const id = 'mmd-' + Date.now() + '-' + Math.floor(Math.random() * 1e6)
        return Promise.resolve(mermaid.render(id, props.source)).then(function (out) {
          if (!alive) return
          const svg = typeof out === 'string' ? out : (out && out.svg) || ''
          if (!svg) throw new Error('empty-render')
          svgRef.current = svg
          setState({ status: 'ok', error: '' })
        })
      })
      .catch(function (err) {
        if (!alive) return
        setState({ status: 'error', error: String((err && err.message) || err) })
      })
    return function () { alive = false }
  }, [props.source])

  /* 注入放在**独立的 effect** 里：effect 一定在容器提交到 DOM 之后运行，
     所以 `hostRef.current` 必然已挂上 —— 不再依赖 `setTimeout(0)` 的时序
     （那一步在 React 18 并发渲染下可能先于 commit 执行，导致图静默不显示）。 */
  React.useEffect(() => {
    if (state.status !== 'ok') return
    const el = hostRef.current
    const svg = svgRef.current
    if (!el || !svg || typeof DOMParser !== 'function') return
    /* 不用 innerHTML / insertAdjacentHTML：正文与图表都是不可信输入（AC-17）。
       用 DOMParser 解析成**惰性**文档 → 剥掉 script → importNode 挂进来。 */
    const doc = new DOMParser().parseFromString(svg, 'image/svg+xml')
    const root = doc && doc.documentElement
    if (!root || root.nodeName.toLowerCase() === 'parsererror') return
    const scripts = root.querySelectorAll ? root.querySelectorAll('script') : []
    for (const sc of scripts) sc.parentNode.removeChild(sc)
    /* 清掉上一次的图：同一容器可能因 source 变化重渲染，不清会叠加 */
    while (el.firstChild) el.removeChild(el.firstChild)
    el.appendChild(document.importNode(root, true))
  }, [state.status])

  if (state.status === 'ok') {
    /* 只放 Mermaid **自己产出**的 SVG，并且用 **DOM API** 注入（不是 `dangerouslySetInnerHTML`）：
       正文是**不可信输入**（AC-17），渲染产物同样不该走那条路；
       Mermaid 侧另有 `securityLevel: 'strict'` 兜底。 */
    return h('div', {
      className: 'aic-mermaid',
      role: 'img',
      'aria-label': t('lesson.diagram'),
      ref: hostRef,
    })
  }
  if (state.status === 'loading') {
    return h('div', { className: 'aic-mermaid aic-mermaid--pending' }, t('lesson.diagramLoading'))
  }
  return h(
    'div',
    { className: 'aic-mermaid aic-mermaid--failed' },
    h(Notice, null, t('lesson.diagramFallback', { reason: state.error })),
    h('pre', { className: 'aic-mermaid__source' }, h('code', null, props.source)),
  )
}

/* --------------------------------------------------------------- 代码高亮 */

/**
 * highlight.js 的 token 类名 → 本插件自己的**字面**类名。
 *
 * 为什么再映射一层而不是直接用 `hljs-*`：
 *   ① 样式只消费宿主的 14 个主题 token（06 §7），需要自己挑语义色；
 *   ② 本插件要求 `aic-` 前缀的**字面**类名，禁止动态拼 class（静态检查会拦）。
 * 键是 highlight.js 的类别（取最后一个 `.` 之前的部分）。
 */
const HLJS_TOKEN_CLASS = {
  keyword: 'aic-tok-keyword',
  literal: 'aic-tok-keyword',
  built_in: 'aic-tok-keyword',
  string: 'aic-tok-string',
  regexp: 'aic-tok-string',
  symbol: 'aic-tok-string',
  char: 'aic-tok-string',
  number: 'aic-tok-number',
  comment: 'aic-tok-comment',
  quote: 'aic-tok-comment',
  title: 'aic-tok-title',
  section: 'aic-tok-title',
  function: 'aic-tok-title',
  attr: 'aic-tok-attr',
  attribute: 'aic-tok-attr',
  property: 'aic-tok-attr',
  variable: 'aic-tok-attr',
  params: 'aic-tok-attr',
  type: 'aic-tok-type',
  class: 'aic-tok-type',
  tag: 'aic-tok-type',
  name: 'aic-tok-type',
  meta: 'aic-tok-meta',
  operator: 'aic-tok-punct',
  punctuation: 'aic-tok-punct',
}

/** highlight.js 的类别名 → 本插件的类名（未知类别不加类，保留原色）。 */
function hljsTokenClass (rawClasses) {
  const parts = String(rawClasses || '').split(/\s+/)
  for (const p of parts) {
    if (p.indexOf('hljs-') !== 0) continue
    const base = p.slice(5).split('.')[0]
    if (Object.prototype.hasOwnProperty.call(HLJS_TOKEN_CLASS, base)) return HLJS_TOKEN_CLASS[base]
  }
  return ''
}

/**
 * HTML 实体 → 字符。
 *
 * ⚠️ 必须支持**数字实体**：highlight.js 把 `'` 写成 `&#x27;`（十六进制）、有时用 `&#39;`。
 * 早期只认 `&quot;` 与 `&#39;`，于是单引号在代码块里显示成 `&#x27;` —— 真机上就是这么"乱码"的。
 * 顺序也有讲究：数字实体先解，`&amp;` **最后**解（否则 `&amp;lt;` 会被解成 `<`）。
 */
function unescapeHtml (text) {
  const fromCode = (n) => {
    if (!Number.isFinite(n) || n < 0 || n > 0x10ffff) return null
    try { return String.fromCodePoint(n) } catch { return null }
  }
  return String(text ?? '')
    .replace(/&#x([0-9a-fA-F]+);/g, (m, hex) => {
      const ch = fromCode(parseInt(hex, 16))
      return ch === null ? m : ch
    })
    .replace(/&#(\d+);/g, (m, dec) => {
      const ch = fromCode(parseInt(dec, 10))
      return ch === null ? m : ch
    })
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')     /* 必须最后 */
}

/**
 * 把 highlight.js 的**HTML 片段**转成 React 节点（**不碰 innerHTML**，AC-17）。
 *
 * highlight.js 的产出形状是受控的：只有 `<span class="hljs-…">`、`</span>` 和文本。
 * 所以用一个小状态机就够，不需要 DOMParser，也不必担心夹带别的标签 ——
 * 任何不认识的标签都会被**当文本丢掉**，不会变成元素。
 *
 * @param {string} html `hljs.highlight(...).value`
 * @param {string} keyPrefix React key 前缀
 * @returns {Array} React 子节点
 */
function hljsToNodes (html, keyPrefix) {
  const src = String(html ?? '')
  const out = []
  const stack = []
  const tagRe = /<span\b([^>]*)>|<\/span\s*>|<[^>]*>/gi
  let last = 0
  let n = 0
  let m
  const pushText = (text) => {
    if (!text) return
    const cls = stack.length ? stack[stack.length - 1] : ''
    const value = unescapeHtml(text)
    out.push(cls ? h('span', { key: keyPrefix + '-' + (n++), className: cls }, value) : value)
  }
  while ((m = tagRe.exec(src)) !== null) {
    if (m.index > last) pushText(src.slice(last, m.index))
    last = tagRe.lastIndex
    if (m[0].charAt(1) === '/') { stack.pop(); continue }
    const clsMatch = /class\s*=\s*"([^"]*)"/i.exec(m[1] || '')
    if (m[0].indexOf('<span') === 0 && m[0].charAt(1) !== '/') {
      stack.push(hljsTokenClass(clsMatch ? clsMatch[1] : ''))
    } else {
      /* 其他任何标签：整段丢掉（既不留元素，也不留标签文本） */
      stack.push('')
      stack.pop()
    }
  }
  if (last < src.length) pushText(src.slice(last))
  return out
}

/**
 * 一个代码块：优先**高亮**，拿不到高亮器就退回纯文本（不白屏）。
 *
 * 三级降级：① 高亮成功 → 带 token 类的 `span`；② 加载失败/语言不支持 → 纯文本；
 * ③ 还在加载 → 先显示纯文本（**不留空白**，避免"闪一下"）。
 */
function CodeBlock (props) {
  const lang = String(props.lang || '')
  const source = String(props.source ?? '')
  const [tokens, setTokens] = React.useState(null)

  React.useEffect(() => {
    let alive = true
    setTokens(null)
    /* 空内容没什么可高亮的；但**没有语言标记**照样要试 —— 模型经常直接写 ```
       （真机上 6 个围栏里有 6 个是裸的），否则「有内容却不亮」看起来像坏了。 */
    if (!source) return function () { alive = false }
    aicLoadHljs()
      .then(function (hljs) {
        if (!alive || !hljs) return
        let html = ''
        try {
          const known = lang && typeof hljs.getLanguage === 'function' && hljs.getLanguage(lang)
          /* 有语言且被支持 → 按语言高亮；否则（没写语言 / 语言不支持）→ 自动识别 */
          html = known
            ? hljs.highlight(source, { language: lang, ignoreIllegals: true }).value
            : hljs.highlightAuto(source).value
        } catch (err) {
          html = ''
        }
        if (html) setTokens(hljsToNodes(html, 'tok'))
      })
      .catch(function () { /* 加载失败：保持纯文本 */ })
    return function () { alive = false }
  }, [lang, source])

  return h(
    'pre',
    { className: 'aic-code' },
    h('code', { className: lang ? 'aic-code--lang' : undefined, 'data-lang': lang || undefined }, tokens || source),
  )
}

/* ------------------------------------------------------------------ 播放器 */

/** 只含一张图片的段落（`p > img`）——版式要把它抽到侧栏去。 */
function isFigureNode (node) {
  if (!node || typeof node !== 'object') return false
  if (node.type === 'img') return true
  if (node.type !== 'p') return false
  const kids = (node.kids || []).filter((k) => k !== null && k !== undefined && k !== '')
  return kids.length === 1 && kids[0] && kids[0].type === 'img'
}

/** 把一页拆成两栏：`[正文, 图]`（`image-left` 的 CSS 会把第一栏换到右侧）。 */
function splitFigureCols (nodes) {
  const at = nodes.findIndex(isFigureNode)
  if (at < 0) return null
  const figure = nodes[at]
  const text = nodes.filter((n, i) => i !== at)
  if (!text.length) return null                     /* 只有图：不必分栏（否则左栏空一大块） */
  return { text: text, figure: figure }
}

/** 两栏版式：把正文按**元素个数**对半切开（够用且可预测；不做语义切分）。 */
function splitHalf (nodes) {
  if (nodes.length < 2) return null
  const mid = Math.ceil(nodes.length / 2)
  return { left: nodes.slice(0, mid), right: nodes.slice(mid) }
}

/**
 * 一页幻灯片；`layout` 未知一律按 `default` 渲染（06 §7.1，AC-16）。
 *
 * 版式靠**结构**生效（CSS 里 `two-cols` / `image-right` 等规则都指向 `.aic-slide__cols`），
 * 所以这里必须真的产出那个结构：
 *   · `two-cols` / `two-cols-header` → 正文对半成两栏；
 *   · `image-right` / `image-left`   → 正文 + 图两栏（抽不到图就退回单栏，不硬造空栏）；
 *   · 其余版式 → 单栏。
 * 标题单独渲染成 `.aic-slide__title`（版式的字号/居中规则都挂在它上面）。
 */
function SlidePage (props) {
  const t = props.t
  const core = AIC_COURSES_CORE
  const layout = core.slideLayout(props.slide.layout)
  const unknown = layout !== props.slide.layout
  const split = core.splitSlideTitle(props.slide.body, props.slide.title)
  const nodes = renderMarkdown(split.text, props.resolveUrl, t)

  let cols = null
  if (layout === 'two-cols' || layout === 'two-cols-header') {
    const halves = splitHalf(nodes)
    if (halves) cols = [halves.left, halves.right]
  } else if (layout === 'image-right' || layout === 'image-left') {
    const fig = splitFigureCols(nodes)
    if (fig) cols = [fig.text, [fig.figure]]
  }

  const prose = cols
    ? h('div', { className: 'aic-slide__cols' },
        cols.map((part, ci) => h('div', { className: 'aic-prose', key: ci }, part)))
    : h('div', { className: 'aic-prose' }, nodes)

  return h(
    'section',
    { className: SLIDE_CLASS[layout], 'aria-label': t('lesson.slideLabel', { n: props.index + 1 }) },
    h('div', { className: 'aic-slide__no' }, t('lesson.slideNo', { n: props.index + 1, total: props.total })),
    unknown ? h(Notice, null, t('lesson.slideLayoutUnknown', { layout: String(props.slide.layout) })) : null,
    split.title ? h('h2', { className: 'aic-slide__title' }, split.title) : null,
    prose,
  )
}

/** 幻灯片播放器：上一页 / 页码 / 下一页 + 当前页讲稿（06 §5）。 */
function SlidevPlayer (props) {
  const t = props.t
  const core = AIC_COURSES_CORE
  const parsed = React.useMemo(() => core.parseSlidev(props.text), [props.text])
  const [at, setAt] = React.useState(0)
  const slides = parsed.slides
  React.useEffect(() => { setAt(0) }, [props.text])
  if (!slides.length) {
    return h('div', { className: 'aic-empty' }, h('div', { className: 'aic-empty__title' }, t('lesson.slideEmpty')))
  }
  const index = Math.max(0, Math.min(slides.length - 1, at))
  const slide = slides[index]
  return h(
    'div',
    null,
    h('div', { className: 'aic-player' }, h(SlidePage, { t: t, slide: slide, index: index, total: slides.length, resolveUrl: props.resolveUrl })),
    h(
      'div',
      { className: 'aic-player__bar' },
      h(IconButton, { name: 'prev', label: t('lesson.slidePrev'), disabled: index === 0, onClick: () => setAt(index - 1) }),
      h('span', { className: 'aic-player__pos', 'aria-live': 'polite' }, t('lesson.slidePos', { n: index + 1, total: slides.length })),
      h(IconButton, { name: 'next', label: t('lesson.slideNext'), disabled: index === slides.length - 1, onClick: () => setAt(index + 1) }),
    ),
    slide.notes
      ? h('div', { className: 'aic-notes' }, h('h2', { className: 'aic-h2' }, t('lesson.notes')), h('div', { className: 'aic-prose' }, renderMarkdown(slide.notes, props.resolveUrl, t)))
      : null,
  )
}

/**
 * 内容区：按 `render` 口径分派。
 * @param {object} props `{ t, payload, formatPending, resolveUrl }`
 */
function ContentView (props) {
  const t = props.t
  const payload = props.payload || {}
  if (!payload.hasAsset) return null
  return h(
    'div',
    { className: 'aic-content' },
    props.formatPending ? h(Notice, null, t('lesson.formatPending', { type: payload.contentType })) : null,
    payload.render === 'slidev'
      ? h(SlidevPlayer, { t: t, text: payload.body, resolveUrl: props.resolveUrl })
      : h('div', { className: 'aic-prose' }, renderMarkdown(payload.body, props.resolveUrl, t)),
    (payload.media || []).length
      ? h('div', { className: 'aic-muted aic-content__media' }, t('lesson.mediaCount', { n: payload.media.length }))
      : null,
  )
}

/* ==================== src/client/90-app.js ==================== */

/* ==================== src/client/90-app.js ====================
 * 面板根组件 + 插件外壳（apply / createPlugin）
 *
 * 一个 `main` 面板内含三页（课程库 / 大纲 / 学习），靠面板内导航切换（06 §1）。
 * 课程数据只有两个来源：`courses.list`（卡片）与 `courses.read`（大纲与学习页）——
 * 都是 host 方法表里已有的方法，UI 不自造数据、不缓存第二份真相。
 * ========================================================================== */

/** 课程内按 id 找一个知识点（**必须带课程上下文**：kpId 只在课程内唯一，05 §4）。 */
function aicFindKp (course, kpId) {
  for (const x of AIC_COURSES_CORE.courseKps(course)) {
    if (x.kp.id === kpId) return x
  }
  return null
}

/** 侧边栏面板图标（M0 起就在用；`props.size` 由宿主传入）。 */
function CoursePanelIcon (props) {
  const size = (props && props.size) || 20
  return h(
    'svg',
    {
      width: size, height: size, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor',
      strokeWidth: 1.6, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': 'true', focusable: 'false',
    },
    h('path', { key: 'a', d: 'M4 5.5A1.5 1.5 0 0 1 5.5 4H10a2 2 0 0 1 2 2v13a1.5 1.5 0 0 0-1.5-1.5H5.5A1.5 1.5 0 0 1 4 16V5.5Z' }),
    h('path', { key: 'b', d: 'M20 5.5A1.5 1.5 0 0 0 18.5 4H14a2 2 0 0 0-2 2v13a1.5 1.5 0 0 1 1.5-1.5h5A1.5 1.5 0 0 0 20 16V5.5Z' }),
  )
}

/** 加载中 / 读失败 的整页态（课程库之外的两种页面共用）。 */
function PageState (props) {
  return h(
    'div',
    { className: 'aic-library' },
    props.error
      ? h(
          'div',
          { className: 'aic-error' },
          h('div', { className: 'aic-error__title' }, props.title),
          h('div', { className: 'aic-muted' }, props.body || ''),
          h('div', { style: { marginTop: '10px' } },
            h('button', { className: 'aic-btn', type: 'button', onClick: props.onRetry }, props.retry)),
        )
      : h('div', { className: 'aic-empty' }, h('div', { className: 'aic-empty__title' }, props.title)),
  )
}

/**
 * `<html lang>` 变化时强制重渲染。
 *
 * DSH 的 locale 插件在启动后才把服务端默认的 `en` 改成用户设置；`t` 本身是
 * `createLiveT`（每次调用现读），但组件需要一次 re-render 才会重新取词。
 */
function useLocaleRefresh () {
  const [, setTick] = React.useState(0)
  React.useEffect(() => {
    if (typeof document === 'undefined' || typeof MutationObserver !== 'function') return undefined
    const el = document.documentElement
    if (!el || typeof el.getAttribute !== 'function') return undefined
    const obs = new MutationObserver(() => setTick((n) => n + 1))
    obs.observe(el, { attributes: true, attributeFilter: ['lang'] })
    return () => obs.disconnect()
  }, [])
}

function AicCoursesApp (props) {
  const t = props.t
  const core = AIC_COURSES_CORE
  useLocaleRefresh()
  const [view, setView] = React.useState('library')
  const [courseId, setCourseId] = React.useState(null)
  const [kpId, setKpId] = React.useState(null)
  const [filter, setFilter] = React.useState({ category: '', tags: [], query: '' })
  const [notice, setNotice] = React.useState('')
  const [version, setVersion] = React.useState(0)
  /* 删除课程：`{ id, name }`（待确认的目标）、进行中标记、失败原因 */
  /* 内容版本号：生成任务跑完后自增 → 学习页重新取一次内容资产（不必手动刷新） */
  const [contentVersion, setContentVersion] = React.useState(0)
  const [pendingDelete, setPendingDelete] = React.useState(null)
  const [deleting, setDeleting] = React.useState(false)
  const [deleteError, setDeleteError] = React.useState('')
  const [configOpen, setConfigOpen] = React.useState(false)

  const [libState, reloadLib] = useResource(() => aicRpc('courses.list', {}), [version])

  const refresh = () => setVersion((v) => v + 1)
  const updateFilter = (patch) => setFilter((prev) => Object.assign({}, prev, patch))

  /* 课程库设置保存成功：旧根下的课程可能已经不存在，退回课程库并重新取数。
     切换后**不重启**宿主即可看到新目录（host 的 store 已换根）。 */
  const configSaved = (info) => {
    setConfigOpen(false)
    setCourseId(null)
    setKpId(null)
    setView('library')
    setFilter({ category: '', tags: [], query: '' })
    setNotice(t('config.saved', { path: info.courseRoot }))
    reloadLib()
  }

  /**
   * 删除课程（**破坏性、仅用户**，07 号文档 OP-7）：先确认再删。
   *
   * 走 `courses.remove` —— host 侧删除的是**整个课程目录**（course.json / progress.json /
   * content-assets / media 全部一起走，E-27 的 node:fs 递归删除），删完刷新列表；
   * 如果删的正是当前打开的那门课，一并退回到课程库。
   */
  const requestDelete = (course) => { setDeleteError(''); setPendingDelete({ id: course.id, name: course.name || '' }) }
  const confirmDelete = () => {
    if (!pendingDelete) return
    const target = pendingDelete
    setDeleting(true)
    setDeleteError('')
    aicRpc('courses.remove', { courseId: target.id }).then(
      () => {
        setDeleting(false)
        setPendingDelete(null)
        setNotice(t('library.deleted', { name: target.name || target.id }))
        if (courseId === target.id) {
          setCourseId(null)
          setKpId(null)
          setView('library')
        }
        reloadLib()
      },
      (err) => {
        setDeleting(false)
        setDeleteError(String((err && err.message) || err))
      },
    )
  }

  /* 主会话的大纲卡片 →「打开完整大纲 / 学习」：卡片发一条插件内导航请求，这里切页。
     面板没挂载时（composed out）没有订阅者，`AIC_NAV.open` 静默丢弃 —— 卡片不是唯一入口。 */
  React.useEffect(() => AIC_NAV.on((req) => {
    if (!req || !req.courseId) return
    setNotice('')
    setCourseId(req.courseId)
    setKpId(req.kpId || null)
    setView(req.view === 'lesson' ? 'lesson' : 'outline')
  }), [])

  /* 课程数据、弹窗与修订提交都在 **CourseEditor**（62-editor.js）里 —— 主会话的大纲卡片用同一份实现，
     避免「面板能改、卡片不能改」的两条真相。导航与课程库仍由本组件负责。 */
  const renderContent = (ed) => {
    const course = ed.course
    const t = props.t
    const core = AIC_COURSES_CORE
    const rows = (libState.data || [])
    const kpProgress = ed.kpProgress
    const readOnly = ed.readOnly
    const corrupt = ed.corrupt

    /* 导航 */
    const openOutline = (id) => { ed.setNotice(''); setCourseId(id); setKpId(null); setView('outline') }
    const openLesson = (id, kp) => { ed.setNotice(''); setCourseId(id); setKpId(kp ? kp.id : null); setView('lesson') }
    const backToLibrary = () => { ed.setNotice(''); setView('library'); reloadLib() }

    /* ------------------------------------------------------------ 渲染 */
    let body = null
    if (view === 'library') {
      body = h(LibraryView, {
        t: t,
        courses: rows,
        status: libState.status,
        error: libState.error,
        filter: filter,
        notice: notice,
        onFilter: updateFilter,
        onClearFilters: () => setFilter({ category: '', tags: [], query: '' }),
        onOpenOutline: openOutline,
        onOpenLesson: (id) => openLesson(id, null),
        onOpenConfig: () => setConfigOpen(true),
        onRetry: reloadLib,
        onDelete: requestDelete,
      })
    } else if (ed.state === 'error' && !course) {
      const notFound = ed.error && ed.error.code === 'not-found'
      body = h(PageState, {
        title: notFound ? t('outline.notFoundTitle') : t('outline.errorTitle'),
        body: notFound ? '' : String((ed.error && ed.error.message) || ''),
        retry: t('library.retry'),
        error: !notFound,
        /* 课程不存在 → 回课程库（刷新列表）；其它读失败 → 重试这次读 */
        onRetry: () => (notFound ? (setView('library'), reloadLib()) : ed.refresh()),
      })
    } else if (!course) {
      body = h(PageState, { title: t('outline.loading'), retry: '', onRetry: () => {} })
    } else if (view === 'outline') {
      body = h(
        'div',
        null,
        ed.notice ? h(Notice, null, ed.notice) : null,
        h(OutlineView, {
          t: t,
          course: course,
          kpProgress: kpProgress,
          /* 行末 5 态的两项证据：任务状态（生成中/排队中/失败）与「已生成」凭据（信封存在） */
          taskStates: ed.taskStates,
          assets: ed.assets,
          /* 生成进度**只在主会话的常驻状态条**上展示（06 §3.6）——
             大纲页不再重复一份，避免同一件事两处显示、两处不一致。 */
          mode: 'edit',
          readOnly: readOnly,
          corrupt: corrupt,
          disabled: readOnly,
          onBack: backToLibrary,
          onEdit: ed.openEdit,
          /* 结构模式（章节编辑）的 +/- 走同一批修订事务 */
          onStructure: ed.submitOps,
          onGenerateCourse: () => ed.setNotice(t('outline.generateM2', { label: t('outline.generateCourse') })),
          onGenerateChapter: () => ed.setNotice(t('outline.generateM2', { label: t('outline.generateChapter') })),
          onGenerateKp: ed.openGenerate,
          onOpenLesson: (ch, kp) => openLesson(course.id, kp),
        }),
      )
    } else {
      const list = core.courseKps(course)
      const active = kpId ? (aicFindKp(course, kpId) || list[0]) : list[0]
      body = active
        ? h(LessonView, {
            t: t,
            course: course,
            ch: active.ch,
            kp: active.kp,
            itemStates: (ed.taskStates || {})[active.kp.id],
            version: contentVersion,
            onBack: backToLibrary,
            onOpenOutline: openOutline,
            onOpenKp: (ch, kp) => openLesson(course.id, kp),
            onGenerate: ed.openGenerate,
            onRegenerate: ed.openGenerate,
            /* 进度标记（05 §6.1 / Q-14）：打开 → 进行中；离开 → 已掌握 */
            onMark: (state) => {
              aicRpc('progress.mark', { courseId: course.id, kpId: active.kp.id, state: state }).catch(() => {})
            },
          })
        : h(PageState, { title: t('lesson.notFoundTitle'), retry: '', onRetry: () => {} })
    }

    return h(
      'div',
      { className: 'aic-root' },
      h('div', { className: 'aic-shell' }, h('div', { className: 'aic-main' }, body)),
    )
  }

  /* 面板外壳：课程数据 / 弹窗 / 修订全交给共享编辑器（62-editor.js）。
     删除确认弹窗挂在**这一层**（课程库与大纲页都可能触发），与编辑器的弹窗各管各的。 */
  return h(
    React.Fragment,
    null,
    h(CourseEditor, {
      courseId: courseId || '',
      t: props.t,
      ctx: props.ctx,
      /* 内容落库后：刷新课程数据（行末状态点变「已生成」）并让学习页重取正文 */
      onChanged: () => { refresh(); setContentVersion((v) => v + 1) },
    }, renderContent),
    pendingDelete
      ? h(ConfirmModal, {
          t: props.t,
          title: props.t('library.deleteTitle'),
          body: props.t('library.deleteBody', { name: pendingDelete.name || pendingDelete.id }),
          detail: props.t('library.deleteDetail'),
          confirmLabel: props.t('library.deleteConfirm'),
          loading: deleting,
          error: deleteError,
          onClose: () => { if (!deleting) { setPendingDelete(null); setDeleteError('') } },
          onConfirm: confirmDelete,
        })
      : null,
    configOpen
      ? h(ConfigModal, {
          t: props.t,
          onClose: () => setConfigOpen(false),
          onSaved: configSaved,
        })
      : null,
  )
}


/* ------------------------------------------------------------ 插件外壳 */

/**
 * 客户端插件对象。
 * ⚠️ 形状逐行抄自在装可用先例（dsh-notes-plugin / dsh-course-plugin，2026-10-14 实测生效）：
 *    `inject: ['slots']` 必须声明（否则 apply 在 slots 就绪前跑，整个 web boot 失败）；
 *    清理一律走 `ctx.effect`，**不要**从 apply 返回 disposer。
 */
function createPlugin () {
  return { name: 'dsh-ai-courses', inject: ['slots'], apply: aicCoursesApply }
}

function aicCoursesApply (ctx) {
  /* `ctx.get('slots')` + 优雅降级：直接访问 `ctx.slots` 在服务未就绪时会抛 */
  const slots = ctx.get('slots')
  if (!slots) {
    console.error('[ai-courses] slots 服务不可用，课程面板未注册')
    return
  }

  const doc = typeof document === 'undefined' ? null : document
  const nav = typeof navigator === 'undefined' ? null : navigator
  /* 动态语言：`<html lang>` 由 DSH locale 插件在启动后改成用户设置，
     不能在这里一次性 detectLocale 后锁死（否则中文设置下一直显示英文）。 */
  const t = AIC_COURSES_CORE.createLiveT(doc, nav)

  /* 样式：构建期内联（宿主不会自动加载包内 lib/styles.css —— 见 doc/03 §6 的定案），
     挂一个 <style> 并在停用/卸载时移除；不用 innerHTML。 */
  let styleEl = null
  try {
    if (doc && doc.createElement && doc.head) {
      styleEl = doc.createElement('style')
      styleEl.setAttribute('data-dsh-plugin', 'ai-courses')
      styleEl.textContent = AIC_COURSES_CSS
      doc.head.appendChild(styleEl)
    }
  } catch (err) {
    console.warn('[ai-courses] 样式注入失败：', err && err.message)
  }

  const disposers = []

  /* 侧边栏面板图标 / 主面板：**等槽声明后再注册**。
     `sidebar.panellist` 由 `@deepseek-ai/dsh-client-ui-sidebar` 声明；在 `dsh web` 里这个声明
     发生在 sidebar 首次渲染时，比插件 apply 晚 —— 直接 `slots.register` 会抛
     「slot "sidebar.panellist" is not declared」，整个 client entry 被标 failed（真机踩到）。
     用 `slots.inject` 等声明；老宿主没有 inject 时退回直接注册。 */
  if (slots && typeof slots.inject === 'function') {
    /* `id` 必须与 `main` 的 `key` 是同一字符串（宿主按 list id 寻址 main 面板，E-8）；
       `label` 必须是函数。 */
    disposers.push(
      slots.inject('sidebar.panellist', () => slots.register(
        { name: 'sidebar.panellist', id: 'ai-courses', order: 30, label: () => t('panel.title') },
        (props) => h(CoursePanelIcon, props),
      )),
    )
    /* 主面板。key = 'ai-courses'（**不能**用 'course'：那是 dsh-course-plugin 的格位） */
    disposers.push(
      slots.inject('main', () => slots.register(
        { name: 'main', key: 'ai-courses' },
        () => h(AicCoursesApp, { t: t, ctx: ctx }),
      )),
    )
  } else {
    disposers.push(
      slots.register(
        { name: 'sidebar.panellist', id: 'ai-courses', order: 30, label: () => t('panel.title') },
        (props) => h(CoursePanelIcon, props),
      ),
    )
    disposers.push(
      slots.register({ name: 'main', key: 'ai-courses' }, () => h(AicCoursesApp, { t: t, ctx: ctx })),
    )
  }

  /* 主会话里的 `/ai-course` 实时状态卡片（conversation.chat.commandview，见 55-status-card.js）：
     宿主 ui-chat 声明该槽，用 inject 等声明出现再注册（直接 register 会抛「未声明」）。 */
  aicRegisterStatusCard(ctx, slots, t).forEach((d) => disposers.push(d))

  /* 主会话回复末尾的**课程大纲卡片**（conversation.chat.turnTail，见 65-outline-card.js）：
     同样是宿主声明的槽，同样用 inject 等声明。 */
  aicRegisterOutlineCard(ctx, slots, t).forEach((d) => disposers.push(d))

  /* 主会话的**常驻 agent 状态条**（conversation.input.dock，见 58-agent-dock.js）：
     生成知识点内容不产生回合，所以要挂在「输入框上方」这个与回合无关的槽里。 */
  aicRegisterAgentDock(ctx, slots, t).forEach((d) => disposers.push(d))

  ctx.effect(() => () => {
    for (const d of disposers) {
      try { if (typeof d === 'function') d() } catch (err) { console.warn('[ai-courses] 清理失败：', err && err.message) }
    }
    if (styleEl && styleEl.parentNode) styleEl.parentNode.removeChild(styleEl)
  })

  console.log('[ai-courses] 客户端已就绪（sidebar/main 等槽声明后注册；主会话槽已注册）')
}

/* ==================== src/client/99-shell-tail.js ==================== */

/* ==================== 外壳尾：导出插件对象 ==================== */

    module.exports = createPlugin()
    return module.exports
  },
})

/* ==================== 内联第三方：highlight.js（126 KB） ==================== */
/* 为什么内联而不是按需加载：高亮是核心展示能力，而「静态资源走宿主路由」要求宿主先带上新代码，
   改完前端看不到效果、必须重启宿主 —— 这条已经踩过两次。130 KB 换来「刷新即生效」。 */
/*!
  Highlight.js v11.12.0 (git: f7f7d3803b)
  (c) 2006-2026 Josh Goebel <hello@joshgoebel.com> and other contributors
  License: BSD-3-Clause
 */
var hljs=function(){"use strict";function e(n){
return n instanceof Map?n.clear=n.delete=n.set=()=>{
throw Error("map is read-only")}:n instanceof Set&&(n.add=n.clear=n.delete=()=>{
throw Error("set is read-only")
}),Object.freeze(n),Object.getOwnPropertyNames(n).forEach(t=>{
const a=n[t],i=typeof a;"object"!==i&&"function"!==i||Object.isFrozen(a)||e(a)
}),n}class n{constructor(e){
void 0===e.data&&(e.data={}),this.data=e.data,this.isMatchIgnored=!1}
ignoreMatch(){this.isMatchIgnored=!0}}function t(e){
return e.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;").replace(/'/g,"&#x27;")
}function a(e,...n){const t=Object.create(null);for(const n in e)t[n]=e[n]
;return n.forEach(e=>{for(const n in e)t[n]=e[n]}),t}const i=e=>!!e.scope
;class r{constructor(e,n){
this.buffer="",this.classPrefix=n.classPrefix,e.walk(this)}addText(e){
this.buffer+=t(e)}openNode(e){if(!i(e))return;const n=((e,{prefix:n})=>{
if(e.startsWith("language:"))return e.replace("language:","language-")
;if(e.includes(".")){const t=e.split(".")
;return[`${n}${t.shift()}`,...t.map((e,n)=>`${e}${"_".repeat(n+1)}`)].join(" ")}
return`${n}${e}`})(e.scope,{prefix:this.classPrefix});this.span(n)}closeNode(e){
i(e)&&(this.buffer+="</span>")}value(){return this.buffer}span(e){
this.buffer+=`<span class="${e}">`}}const s=(e={})=>{const n={children:[]}
;return Object.assign(n,e),n};class o{constructor(){
this.rootNode=s(),this.stack=[this.rootNode]}get top(){
return this.stack[this.stack.length-1]}get root(){return this.rootNode}add(e){
this.top.children.push(e)}openNode(e){const n=s({scope:e})
;this.add(n),this.stack.push(n)}closeNode(){
if(this.stack.length>1)return this.stack.pop()}closeAllNodes(){
for(;this.closeNode(););}toJSON(){return JSON.stringify(this.rootNode,null,4)}
walk(e){return this.constructor._walk(e,this.rootNode)}static _walk(e,n){
return"string"==typeof n?e.addText(n):n.children&&(e.openNode(n),
n.children.forEach(n=>this._walk(e,n)),e.closeNode(n)),e}static _collapse(e){
"string"!=typeof e&&e.children&&(e.children.every(e=>"string"==typeof e)?e.children=[e.children.join("")]:e.children.forEach(e=>{
o._collapse(e)}))}}class c extends o{constructor(e){super(),this.options=e}
addText(e){""!==e&&this.add(e)}startScope(e){this.openNode(e)}endScope(){
this.closeNode()}__addSublanguage(e,n){const t=e.root
;n&&(t.scope="language:"+n),this.add(t)}toHTML(){
return new r(this,this.options).value()}finalize(){
return this.closeAllNodes(),!0}}function l(e){
return e?"string"==typeof e?e:e.source:null}function d(e){return b("(?=",e,")")}
function g(e){return b("(?:",e,")*")}function u(e){return b("(?:",e,")?")}
function b(...e){return e.map(e=>l(e)).join("")}function m(...e){const n=(e=>{
const n=e[e.length-1]
;return"object"==typeof n&&n.constructor===Object?(e.splice(e.length-1,1),n):{}
})(e);return"("+(n.capture?"":"?:")+e.map(e=>l(e)).join("|")+")"}function p(e){
return RegExp(e.toString()+"|").exec("").length-1}
const _=RegExp(m(/\[(?:[^\\\]]|\\.)*\]/,/\(\?<(?![=!])[^>]+>/,/\(\?'[^']+'/,/\(\??/,/\\([1-9][0-9]*)/,/\\./))
;function h(e,{joinWith:n}){let t=0;return e.map(e=>{t+=1;const n=t
;let a=l(e),i="";for(;a.length>0;){const e=_.exec(a);if(!e){i+=a;break}
i+=a.substring(0,e.index),
a=a.substring(e.index+e[0].length),"\\"===e[0][0]&&e[1]?i+="\\"+(Number(e[1])+n):(i+=e[0],
("("===e[0]||/^\(\?[<']/.test(e[0]))&&t++)}return i}).map(e=>`(${e})`).join(n)}
const f="[a-zA-Z]\\w*",E="[a-zA-Z_]\\w*",y="\\b\\d+(\\.\\d+)?",w="(-?)(\\b0[xX][a-fA-F0-9]+|(\\b\\d+(\\.\\d*)?|\\.\\d+)([eE][-+]?\\d+)?)",v="\\b(0b[01]+)",N={
begin:"\\\\[\\s\\S]",relevance:0},k={scope:"string",begin:"'",end:"'",
illegal:"\\n",contains:[N]},x={scope:"string",begin:'"',end:'"',illegal:"\\n",
contains:[N]},O=(e,n,t={})=>{const i=a({scope:"comment",begin:e,end:n,
contains:[]},t);i.contains.push({scope:"doctag",
begin:"[ ]*(?=(TODO|FIXME|NOTE|BUG|OPTIMIZE|HACK|XXX):)",
end:/(TODO|FIXME|NOTE|BUG|OPTIMIZE|HACK|XXX):/,excludeBegin:!0,relevance:0})
;const r=m("I","a","is","so","us","to","at","if","in","it","on",/[A-Za-z]+['](d|ve|re|ll|t|s|n)/,/[A-Za-z]+[-][a-z]+/,/[A-Za-z][a-z]{2,}/)
;return i.contains.push({begin:b(/[ ]+/,"(",r,/[.]?[:]?([.][ ]|[ ])/,"){3}")}),i
},M=O("//","$"),A=O("/\\*","\\*/"),S=O("#","$");var C=Object.freeze({
__proto__:null,APOS_STRING_MODE:k,BACKSLASH_ESCAPE:N,BINARY_NUMBER_MODE:{
scope:"number",begin:v,relevance:0},BINARY_NUMBER_RE:v,COMMENT:O,
C_BLOCK_COMMENT_MODE:A,C_LINE_COMMENT_MODE:M,C_NUMBER_MODE:{scope:"number",
begin:w,relevance:0},C_NUMBER_RE:w,END_SAME_AS_BEGIN:e=>Object.assign(e,{
"on:begin":(e,n)=>{n.data._beginMatch=e[1]},"on:end":(e,n)=>{
n.data._beginMatch!==e[1]&&n.ignoreMatch()}}),HASH_COMMENT_MODE:S,IDENT_RE:f,
MATCH_NOTHING_RE:/\b\B/,METHOD_GUARD:{begin:"\\.\\s*"+E,relevance:0},
NUMBER_MODE:{scope:"number",begin:y,relevance:0},NUMBER_RE:y,
PHRASAL_WORDS_MODE:{
begin:/\b(a|an|the|are|I'm|isn't|don't|doesn't|won't|but|just|should|pretty|simply|enough|gonna|going|wtf|so|such|will|you|your|they|like|more)\b/
},QUOTE_STRING_MODE:x,REGEXP_MODE:{scope:"regexp",begin:/\/(?=[^/\n]*\/)/,
end:/\/[gimuy]*/,contains:[N,{begin:/\[/,end:/\]/,relevance:0,contains:[N]}]},
RE_STARTERS_RE:"!|!=|!==|%|%=|&|&&|&=|\\*|\\*=|\\+|\\+=|,|-|-=|/=|/|:|;|<<|<<=|<=|<|===|==|=|>>>=|>>=|>=|>>>|>>|>|\\?|\\[|\\{|\\(|\\^|\\^=|\\||\\|=|\\|\\||~",
SHEBANG:(e={})=>{const n=/^#![ ]*\//
;return e.binary&&(e.begin=b(n,/.*\b/,e.binary,/\b.*/)),a({scope:"meta",begin:n,
end:/$/,relevance:0,"on:begin":(e,n)=>{0!==e.index&&n.ignoreMatch()}},e)},
TITLE_MODE:{scope:"title",begin:f,relevance:0},UNDERSCORE_IDENT_RE:E,
UNDERSCORE_TITLE_MODE:{scope:"title",begin:E,relevance:0}});function T(e,n){
"."===e.input[e.index-1]&&n.ignoreMatch()}function R(e,n){
void 0!==e.className&&(e.scope=e.className,delete e.className)}function D(e,n){
n&&e.beginKeywords&&(e.begin="\\b("+e.beginKeywords.split(" ").join("|")+")(?!\\.)(?=\\b|\\s)",
e.__beforeBegin=T,e.keywords=e.keywords||e.beginKeywords,delete e.beginKeywords,
void 0===e.relevance&&(e.relevance=0))}function I(e,n){
Array.isArray(e.illegal)&&(e.illegal=m(...e.illegal))}function L(e,n){
if(e.match){
if(e.begin||e.end)throw Error("begin & end are not supported with match")
;e.begin=e.match,delete e.match}}function B(e,n){
void 0===e.relevance&&(e.relevance=1)}const F=(e,n)=>{if(!e.beforeMatch)return
;if(e.starts)throw Error("beforeMatch cannot be used with starts")
;const t=Object.assign({},e);Object.keys(e).forEach(n=>{delete e[n]
}),e.keywords=t.keywords,e.begin=b(t.beforeMatch,d(t.begin)),e.starts={
relevance:0,contains:[Object.assign(t,{endsParent:!0})]
},e.relevance=0,delete t.beforeMatch
},$=["of","and","for","in","not","or","if","then","parent","list","value"]
;function z(e,n,t="keyword"){const a=Object.create(null)
;return"string"==typeof e?i(t,e.split(" ")):Array.isArray(e)?i(t,e):Object.keys(e).forEach(t=>{
Object.assign(a,z(e[t],n,t))}),a;function i(e,t){
n&&(t=t.map(e=>e.toLowerCase())),t.forEach(n=>{const t=n.split("|")
;a[t[0]]=[e,j(t[0],t[1])]})}}function j(e,n){
return n?Number(n):(e=>$.includes(e.toLowerCase()))(e)?0:1}const U={},P=e=>{
console.error(e)},K=(e,...n)=>{console.log("WARN: "+e,...n)},H=(e,n)=>{
U[`${e}/${n}`]||(console.log(`Deprecated as of ${e}. ${n}`),U[`${e}/${n}`]=!0)
},q=Error();function G(e,n,{key:t}){let a=0;const i=e[t],r={},s={}
;for(let e=1;e<=n.length;e++)s[e+a]=i[e],r[e+a]=!0,a+=p(n[e-1])
;e[t]=s,e[t]._emit=r,e[t]._multi=!0}function Z(e){(e=>{
e.scope&&"object"==typeof e.scope&&null!==e.scope&&(e.beginScope=e.scope,
delete e.scope)})(e),"string"==typeof e.beginScope&&(e.beginScope={
_wrap:e.beginScope}),"string"==typeof e.endScope&&(e.endScope={_wrap:e.endScope
}),(e=>{if(Array.isArray(e.begin)){
if(e.skip||e.excludeBegin||e.returnBegin)throw P("skip, excludeBegin, returnBegin not compatible with beginScope: {}"),
q
;if("object"!=typeof e.beginScope||null===e.beginScope)throw P("beginScope must be object"),
q;G(e,e.begin,{key:"beginScope"}),e.begin=h(e.begin,{joinWith:""})}})(e),(e=>{
if(Array.isArray(e.end)){
if(e.skip||e.excludeEnd||e.returnEnd)throw P("skip, excludeEnd, returnEnd not compatible with endScope: {}"),
q
;if("object"!=typeof e.endScope||null===e.endScope)throw P("endScope must be object"),
q;G(e,e.end,{key:"endScope"}),e.end=h(e.end,{joinWith:""})}})(e)}function W(e){
function n(n,t){
return RegExp(l(n),"m"+(e.case_insensitive?"i":"")+(e.unicodeRegex?"u":"")+(t?"g":""))
}class t{constructor(){
this.matchIndexes={},this.regexes=[],this.matchAt=1,this.position=0}
addRule(e,n){
n.position=this.position++,this.matchIndexes[this.matchAt]=n,this.regexes.push([n,e]),
this.matchAt+=p(e)+1}compile(){0===this.regexes.length&&(this.exec=()=>null)
;const e=this.regexes.map(e=>e[1]);this.matcherRe=n(h(e,{joinWith:"|"
}),!0),this.lastIndex=0}exec(e){this.matcherRe.lastIndex=this.lastIndex
;const n=this.matcherRe.exec(e);if(!n)return null
;const t=n.findIndex((e,n)=>n>0&&void 0!==e),a=this.matchIndexes[t]
;return n.splice(0,t),Object.assign(n,a)}}class i{constructor(){
this.rules=[],this.multiRegexes=[],
this.count=0,this.lastIndex=0,this.regexIndex=0}getMatcher(e){
if(this.multiRegexes[e])return this.multiRegexes[e];const n=new t
;return this.rules.slice(e).forEach(([e,t])=>n.addRule(e,t)),
n.compile(),this.multiRegexes[e]=n,n}resumingScanAtSamePosition(){
return 0!==this.regexIndex}considerAll(){this.regexIndex=0}addRule(e,n){
this.rules.push([e,n]),"begin"===n.type&&this.count++}exec(e){
const n=this.getMatcher(this.regexIndex);n.lastIndex=this.lastIndex
;let t=n.exec(e)
;if(this.resumingScanAtSamePosition())if(t&&t.index===this.lastIndex);else{
const n=this.getMatcher(0);n.lastIndex=this.lastIndex+1,t=n.exec(e)}
return t&&(this.regexIndex+=t.position+1,
this.regexIndex===this.count&&this.considerAll()),t}}
if(e.compilerExtensions||(e.compilerExtensions=[]),
e.contains&&e.contains.includes("self"))throw Error("ERR: contains `self` is not supported at the top-level of a language.  See documentation.")
;return e.classNameAliases=a(e.classNameAliases||{}),function t(r,s){const o=r
;if(r.isCompiled)return o
;[R,L,Z,F].forEach(e=>e(r,s)),e.compilerExtensions.forEach(e=>e(r,s)),
r.__beforeBegin=null,[D,I,B].forEach(e=>e(r,s)),r.isCompiled=!0;let c=null
;return"object"==typeof r.keywords&&r.keywords.$pattern&&(r.keywords=Object.assign({},r.keywords),
c=r.keywords.$pattern,
delete r.keywords.$pattern),c=c||/\w+/,r.keywords&&(r.keywords=z(r.keywords,e.case_insensitive)),
o.keywordPatternRe=n(c,!0),
s&&(r.begin||(r.begin=/\B|\b/),o.beginRe=n(o.begin),r.end||r.endsWithParent||(r.end=/\B|\b/),
r.end&&(o.endRe=n(o.end)),
o.terminatorEnd=l(o.end)||"",r.endsWithParent&&s.terminatorEnd&&(o.terminatorEnd+=(r.end?"|":"")+s.terminatorEnd)),
r.illegal&&(o.illegalRe=n(r.illegal)),
r.contains||(r.contains=[]),r.contains=[].concat(...r.contains.map(e=>(e=>(e.variants&&!e.cachedVariants&&(e.cachedVariants=e.variants.map(n=>a(e,{
variants:null},n))),e.cachedVariants?e.cachedVariants:Q(e)?a(e,{
starts:e.starts?a(e.starts):null
}):Object.isFrozen(e)?a(e):e))("self"===e?r:e))),r.contains.forEach(e=>{t(e,o)
}),r.starts&&t(r.starts,s),o.matcher=(e=>{const n=new i
;return e.contains.forEach(e=>n.addRule(e.begin,{rule:e,type:"begin"
})),e.terminatorEnd&&n.addRule(e.terminatorEnd,{type:"end"
}),e.illegal&&n.addRule(e.illegal,{type:"illegal"}),n})(o),o}(e)}function Q(e){
return!!e&&(e.endsWithParent||Q(e.starts))}class X extends Error{
constructor(e,n){super(e),this.name="HTMLInjectionError",this.html=n}}
const V=t,J=a,Y=Symbol("nomatch"),ee=t=>{
const a=Object.create(null),i=Object.create(null),r=[];let s=!0
;const o="Could not find the language '{}', did you forget to load/include a language module?",l={
disableAutodetect:!0,name:"Plain text",contains:[]};let p={
ignoreUnescapedHTML:!1,throwUnescapedHTML:!1,noHighlightRe:/^(no-?highlight)$/i,
languageDetectRe:/\blang(?:uage)?-([\w-]+)\b/i,classPrefix:"hljs-",
cssSelector:"pre code",languages:null,__emitter:c};function _(e){
return p.noHighlightRe.test(e)}function h(e,n,t){let a="",i=""
;"object"==typeof n?(a=e,
t=n.ignoreIllegals,i=n.language):(H("10.7.0","highlight(lang, code, ...args) has been deprecated."),
H("10.7.0","Please use highlight(code, options) instead.\nhttps://github.com/highlightjs/highlight.js/issues/2277"),
i=e,a=n),void 0===t&&(t=!0);const r={code:a,language:i};O("before:highlight",r)
;const s=r.result?r.result:f(r.language,r.code,t)
;return s.code=r.code,O("after:highlight",s),s}function f(e,t,i,r){
const c=Object.create(null);function l(e,n){return e.keywords[n]}function d(){
if(!M.keywords)return void S.addText(C);let e=0;M.keywordPatternRe.lastIndex=0
;let n=M.keywordPatternRe.exec(C),t="";for(;n;){t+=C.substring(e,n.index)
;const a=k.case_insensitive?n[0].toLowerCase():n[0],i=l(M,a);if(i){const[e,r]=i
;if(S.addText(t),
t="",c[a]=(c[a]||0)+1,c[a]<=7&&(T+=r),e.startsWith("_"))t+=n[0];else{
const t=k.classNameAliases[e]||e;u(n[0],t)}}else t+=n[0]
;e=M.keywordPatternRe.lastIndex,n=M.keywordPatternRe.exec(C)}
t+=C.substring(e),S.addText(t)}function g(){null!=M.subLanguage?(()=>{
if(""===C)return;let e=null;if("string"==typeof M.subLanguage){
if(!a[M.subLanguage])return void S.addText(C)
;e=f(M.subLanguage,C,!0,A[M.subLanguage]),A[M.subLanguage]=e._top
}else e=E(C,M.subLanguage.length?M.subLanguage:null)
;M.relevance>0&&(T+=e.relevance),S.__addSublanguage(e._emitter,e.language)
})():d(),C=""}function u(e,n){
""!==e&&(S.startScope(n),S.addText(e),S.endScope())}function b(e,n){let t=1
;const a=n.length-1;for(;t<=a;){if(!e._emit[t]){t++;continue}
const a=k.classNameAliases[e[t]]||e[t],i=n[t];a?u(i,a):(C=i,d(),C=""),t++}}
function m(e,n){
return e.scope&&"string"==typeof e.scope&&S.openNode(k.classNameAliases[e.scope]||e.scope),
e.beginScope&&(e.beginScope._wrap?(u(C,k.classNameAliases[e.beginScope._wrap]||e.beginScope._wrap),
C=""):e.beginScope._multi&&(b(e.beginScope,n),C="")),M=Object.create(e,{parent:{
value:M}}),M}function _(e,t,a){let i=((e,n)=>{const t=e&&e.exec(n)
;return t&&0===t.index})(e.endRe,a);if(i){if(e["on:end"]){const a=new n(e)
;e["on:end"](t,a),a.isMatchIgnored&&(i=!1)}if(i){
for(;e.endsParent&&e.parent;)e=e.parent;return e}}
if(e.endsWithParent)return _(e.parent,t,a)}function h(e){
return 0===M.matcher.regexIndex?(C+=e[0],1):(I=!0,0)}function y(e){
const n=e[0],a=t.substring(e.index),i=_(M,e,a);if(!i)return Y;const r=M
;M.endScope&&M.endScope._wrap?(g(),
u(n,M.endScope._wrap)):M.endScope&&M.endScope._multi?(g(),
b(M.endScope,e)):r.skip?C+=n:(r.returnEnd||r.excludeEnd||(C+=n),
g(),r.excludeEnd&&(C=n));do{
M.scope&&S.closeNode(),M.skip||M.subLanguage||(T+=M.relevance),M=M.parent
}while(M!==i.parent);return i.starts&&m(i.starts,e),r.returnEnd?0:n.length}
let w={};function v(a,r){const o=r&&r[0];if(C+=a,null==o)return g(),0
;if("begin"===w.type&&"end"===r.type&&w.index===r.index&&""===o){
if(C+=t.slice(r.index,r.index+1),!s){const n=Error(`0 width match regex (${e})`)
;throw n.languageName=e,n.badRule=w.rule,n}return 1}
if(w=r,"begin"===r.type)return(e=>{
const t=e[0],a=e.rule,i=new n(a),r=[a.__beforeBegin,a["on:begin"]]
;for(const n of r)if(n&&(n(e,i),i.isMatchIgnored))return h(t)
;return a.skip?C+=t:(a.excludeBegin&&(C+=t),
g(),a.returnBegin||a.excludeBegin||(C=t)),m(a,e),a.returnBegin?0:t.length})(r)
;if("illegal"===r.type&&!i){
const e=Error('Illegal lexeme "'+o+'" for mode "'+(M.scope||"<unnamed>")+'"')
;throw e.mode=M,e}if("end"===r.type){const e=y(r);if(e!==Y)return e}
if("illegal"===r.type&&""===o)return r.index===t.length||(C+="\n"),1
;if(D>1e5&&D>3*r.index)throw Error("potential infinite loop, way more iterations than matches")
;return C+=o,o.length}const k=N(e)
;if(!k)throw P(o.replace("{}",e)),Error('Unknown language: "'+e+'"')
;const x=W(k);let O="",M=r||x;const A={},S=new p.__emitter(p);(()=>{const e=[]
;for(let n=M;n!==k;n=n.parent)n.scope&&e.unshift(n.scope)
;e.forEach(e=>S.openNode(e))})();let C="",T=0,R=0,D=0,I=!1;try{
if(k.__emitTokens)k.__emitTokens(t,S);else{for(M.matcher.considerAll();;){
D++,I?I=!1:M.matcher.considerAll(),M.matcher.lastIndex=R
;const e=M.matcher.exec(t);if(!e)break;const n=v(t.substring(R,e.index),e)
;R=e.index+n}v(t.substring(R))}return S.finalize(),O=S.toHTML(),{language:e,
value:O,relevance:T,illegal:!1,_emitter:S,_top:M}}catch(n){
if(n.message&&n.message.includes("Illegal"))return{language:e,value:V(t),
illegal:!0,relevance:0,_illegalBy:{message:n.message,index:R,
context:t.slice(R-100,R+100),mode:n.mode,resultSoFar:O},_emitter:S};if(s)return{
language:e,value:V(t),illegal:!1,relevance:0,errorRaised:n,_emitter:S,_top:M}
;throw n}}function E(e,n){n=n||p.languages||Object.keys(a);const t=(e=>{
const n={value:V(e),illegal:!1,relevance:0,_top:l,_emitter:new p.__emitter(p)}
;return n._emitter.addText(e),n})(e),i=n.filter(N).filter(x).map(n=>f(n,e,!1))
;i.unshift(t);const r=i.sort((e,n)=>{
if(e.relevance!==n.relevance)return n.relevance-e.relevance
;if(e.language&&n.language){if(N(e.language).supersetOf===n.language)return 1
;if(N(n.language).supersetOf===e.language)return-1}return 0}),[s,o]=r,c=s
;return c.secondBest=o,c}function y(e){let n=null;const t=(e=>{
let n=e.className+" ";n+=e.parentNode?e.parentNode.className:""
;const t=p.languageDetectRe.exec(n);if(t){const n=N(t[1])
;return n||(K(o.replace("{}",t[1])),
K("Falling back to no-highlight mode for this block.",e)),n?t[1]:"no-highlight"}
return n.split(/\s+/).find(e=>_(e)||N(e))})(e);if(_(t))return
;if(O("before:highlightElement",{el:e,language:t
}),e.dataset.highlighted)return void console.log("Element previously highlighted. To highlight again, first unset `dataset.highlighted`.",e)
;if(e.children.length>0&&(p.ignoreUnescapedHTML||(console.warn("One of your code blocks includes unescaped HTML. This is a potentially serious security risk."),
console.warn("https://github.com/highlightjs/highlight.js/wiki/security"),
console.warn("The element with unescaped HTML:"),
console.warn(e)),p.throwUnescapedHTML))throw new X("One of your code blocks includes unescaped HTML.",e.innerHTML)
;n=e;const a=n.textContent,r=t?h(a,{language:t,ignoreIllegals:!0}):E(a)
;e.innerHTML=r.value,e.dataset.highlighted="yes",((e,n,t)=>{const a=n&&i[n]||t
;e.classList.add("hljs"),e.classList.add("language-"+a)
})(e,t,r.language),e.result={language:r.language,re:r.relevance,
relevance:r.relevance},r.secondBest&&(e.secondBest={
language:r.secondBest.language,relevance:r.secondBest.relevance
}),O("after:highlightElement",{el:e,result:r,text:a})}let w=!1;function v(){
if("loading"===document.readyState)return w||window.addEventListener("DOMContentLoaded",()=>{
v()},!1),void(w=!0);document.querySelectorAll(p.cssSelector).forEach(y)}
function N(e){return e=(e||"").toLowerCase(),a[e]||a[i[e]]}
function k(e,{languageName:n}){"string"==typeof e&&(e=[e]),e.forEach(e=>{
i[e.toLowerCase()]=n})}function x(e){const n=N(e);return n&&!n.disableAutodetect
}function O(e,n){const t=e;r.forEach(e=>{e[t]&&e[t](n)})}Object.assign(t,{
highlight:h,highlightAuto:E,highlightAll:v,highlightElement:y,
highlightBlock:e=>(H("10.7.0","highlightBlock will be removed entirely in v12.0"),
H("10.7.0","Please use highlightElement now."),y(e)),configure:e=>{p=J(p,e)},
initHighlighting:()=>{
v(),H("10.6.0","initHighlighting() deprecated.  Use highlightAll() now.")},
initHighlightingOnLoad:()=>{
v(),H("10.6.0","initHighlightingOnLoad() deprecated.  Use highlightAll() now.")
},registerLanguage:(e,n)=>{let i=null;try{i=n(t)}catch(n){
if(P("Language definition for '{}' could not be registered.".replace("{}",e)),
!s)throw n;P(n),i=l}
i.name||(i.name=e),a[e]=i,i.rawDefinition=n.bind(null,t),i.aliases&&k(i.aliases,{
languageName:e})},unregisterLanguage:e=>{delete a[e]
;for(const n of Object.keys(i))i[n]===e&&delete i[n]},
listLanguages:()=>Object.keys(a),getLanguage:N,registerAliases:k,
autoDetection:x,inherit:J,addPlugin:e=>{(e=>{
e["before:highlightBlock"]&&!e["before:highlightElement"]&&(e["before:highlightElement"]=n=>{
e["before:highlightBlock"](Object.assign({block:n.el},n))
}),e["after:highlightBlock"]&&!e["after:highlightElement"]&&(e["after:highlightElement"]=n=>{
e["after:highlightBlock"](Object.assign({block:n.el},n))})})(e),r.push(e)},
removePlugin:e=>{const n=r.indexOf(e);-1!==n&&r.splice(n,1)}}),t.debugMode=()=>{
s=!1},t.safeMode=()=>{s=!0},t.versionString="11.12.0",t.regex={concat:b,
lookahead:d,either:m,optional:u,anyNumberOfTimes:g}
;for(const n in C)"object"==typeof C[n]&&e(C[n]);return Object.assign(t,C),t
},ne=ee({});ne.newInstance=()=>ee({});const te="[A-Za-z$_][0-9A-Za-z$_]*",ae={
scope:"number",
match:"([-+]?)(\\b0[xX][a-fA-F0-9]+|(\\b\\d+(\\.\\d*)?|\\.\\d+)([eE][-+]?\\d+)?)|NaN|[-+]?Infinity",
relevance:0
},ie=["as","in","of","if","for","while","finally","var","new","function","do","return","void","else","break","catch","instanceof","with","throw","case","default","try","switch","continue","typeof","delete","let","yield","const","class","debugger","async","await","static","import","from","export","extends","using"],re=["true","false","null","undefined","NaN","Infinity"],se=["Object","Function","Boolean","Symbol","Math","Date","Number","BigInt","String","RegExp","Array","Float32Array","Float64Array","Int8Array","Uint8Array","Uint8ClampedArray","Int16Array","Int32Array","Uint16Array","Uint32Array","BigInt64Array","BigUint64Array","Set","Map","WeakSet","WeakMap","ArrayBuffer","SharedArrayBuffer","Atomics","DataView","JSON","Promise","Generator","GeneratorFunction","AsyncFunction","Reflect","Proxy","Intl","WebAssembly"],oe=["Error","EvalError","InternalError","RangeError","ReferenceError","SyntaxError","TypeError","URIError"],ce=["setInterval","setTimeout","clearInterval","clearTimeout","require","exports","eval","isFinite","isNaN","parseFloat","parseInt","decodeURI","decodeURIComponent","encodeURI","encodeURIComponent","escape","unescape"],le=["arguments","this","super","console","window","document","localStorage","sessionStorage","module","self","global"],de=[].concat(ce,se,oe)
;function ge(e){const n=e.regex,t=te,a={begin:/<[A-Za-z0-9\\._:-]+/,
end:/\/[A-Za-z0-9\\._:-]+>|\/>/,isTrulyOpeningTag:(e,n)=>{
const t=e[0].length+e.index,a=e.input[t]
;if("<"===a||","===a)return void n.ignoreMatch();let i
;">"===a&&(((e,{after:n})=>{const t="</"+e[0].slice(1)
;return-1!==e.input.indexOf(t,n)})(e,{after:t})||n.ignoreMatch())
;const r=e.input.substring(t)
;((i=r.match(/^\s*=/))||(i=r.match(/^\s+extends\s+/))&&0===i.index)&&n.ignoreMatch()
}},i={$pattern:te,keyword:ie,literal:re,built_in:de,"variable.language":le
},r="[0-9](_?[0-9])*",s=`\\.(${r})`,o="0|[1-9](_?[0-9])*|0[0-7]*[89][0-9]*",c={
className:"number",variants:[{
begin:`(\\b(${o})((${s})|\\.)?|(${s}))[eE][+-]?(${r})\\b`},{
begin:`\\b(${o})\\b((${s})\\b|\\.)?|(${s})\\b`},{
begin:"\\b(0|[1-9](_?[0-9])*)n\\b"},{
begin:"\\b0[xX][0-9a-fA-F](_?[0-9a-fA-F])*n?\\b"},{
begin:"\\b0[bB][0-1](_?[0-1])*n?\\b"},{begin:"\\b0[oO][0-7](_?[0-7])*n?\\b"},{
begin:"\\b0[0-7]+n?\\b"}],relevance:0},l={className:"subst",begin:"\\$\\{",
end:"\\}",keywords:i,contains:[]},d={begin:".?html`",end:"",starts:{end:"`",
returnEnd:!1,contains:[e.BACKSLASH_ESCAPE,l],subLanguage:"xml"}},g={
begin:".?css`",end:"",starts:{end:"`",returnEnd:!1,
contains:[e.BACKSLASH_ESCAPE,l],subLanguage:"css"}},u={begin:".?gql`",end:"",
starts:{end:"`",returnEnd:!1,contains:[e.BACKSLASH_ESCAPE,l],
subLanguage:"graphql"}},b={className:"string",begin:"`",end:"`",
contains:[e.BACKSLASH_ESCAPE,l]},m={className:"comment",
variants:[e.COMMENT(/\/\*\*(?!\/)/,"\\*/",{relevance:0,contains:[{
begin:"(?=@[A-Za-z]+)",relevance:0,contains:[{className:"doctag",
begin:"@[A-Za-z]+"},{className:"type",begin:"\\{",end:"\\}",excludeEnd:!0,
excludeBegin:!0,relevance:0},{className:"variable",begin:t+"(?=\\s*(-)|$)",
endsParent:!0,relevance:0},{begin:/(?=[^\n])\s/,relevance:0}]}]
}),e.C_BLOCK_COMMENT_MODE,e.C_LINE_COMMENT_MODE]
},p=[e.APOS_STRING_MODE,e.QUOTE_STRING_MODE,d,g,u,b,{match:/\$\d+/},c]
;l.contains=p.concat({begin:/\{/,end:/\}/,keywords:i,contains:["self"].concat(p)
});const _=[].concat(m,l.contains),h=_.concat([{begin:/(\s*)\(/,end:/\)/,
keywords:i,contains:["self"].concat(_)}]),f={className:"params",begin:/(\s*)\(/,
end:/\)/,excludeBegin:!0,excludeEnd:!0,keywords:i,contains:h},E={variants:[{
match:[/class/,/\s+/,t,/\s+/,/extends/,/\s+/,n.concat(t,"(",n.concat(/\./,t),")*")],
scope:{1:"keyword",3:"title.class",5:"keyword",7:"title.class.inherited"}},{
match:[/class/,/\s+/,t],scope:{1:"keyword",3:"title.class"}}]},y={relevance:0,
match:n.either(/\bJSON/,/\b[A-Z][a-z]+([A-Z][a-z]*|\d)*/,/\b[A-Z]{2,}([A-Z][a-z]+|\d)+([A-Z][a-z]*)*/,/\b[A-Z]{2,}[a-z]+([A-Z][a-z]+|\d)*([A-Z][a-z]*)*/),
className:"title.class",keywords:{_:[...se,...oe]}},w={variants:[{
match:[/function/,/\s+/,t,/(?=\s*\()/]},{match:[/function/,/\s*(?=\()/]}],
className:{1:"keyword",3:"title.function"},label:"func.def",contains:[f],
illegal:/%/},v={
match:n.concat(/\b/,(N=[...ce,"super","import","await"].map(e=>e+"\\s*\\("),
n.concat("(?!",N.join("|"),")")),t,n.lookahead(/\s*\(/)),
className:"title.function",relevance:0};var N;const k={
begin:n.concat(/\./,n.lookahead(n.concat(t,/(?![0-9A-Za-z$_(])/))),end:t,
excludeBegin:!0,keywords:"prototype",className:"property",relevance:0},x={
match:[/get|set/,/\s+/,t,/(?=\()/],className:{1:"keyword",3:"title.function"},
contains:[{begin:/\(\)/},f]
},O="(\\([^()]*(\\([^()]*(\\([^()]*\\)[^()]*)*\\)[^()]*)*\\)|"+e.UNDERSCORE_IDENT_RE+")\\s*=>",M={
match:[/const|var|let/,/\s+/,t,/\s*/,/=\s*/,/(async\s*)?/,n.lookahead(O)],
keywords:"async",className:{1:"keyword",3:"title.function"},contains:[f]}
;return{name:"JavaScript",aliases:["js","jsx","mjs","cjs"],keywords:i,exports:{
PARAMS_CONTAINS:h,CLASS_REFERENCE:y},illegal:/#(?![$_A-Za-z])/,
contains:[e.SHEBANG({label:"shebang",binary:"node",relevance:5}),{
label:"use_strict",className:"meta",relevance:10,
begin:/^\s*['"]use (strict|asm)['"]/
},e.APOS_STRING_MODE,e.QUOTE_STRING_MODE,d,g,u,b,m,{match:/\$\d+/},c,y,{
scope:"attr",match:t+n.lookahead(":"),relevance:0},M,{
begin:"("+e.RE_STARTERS_RE+"|\\b(case|return|throw)\\b)\\s*",
keywords:"return throw case",relevance:0,contains:[m,e.REGEXP_MODE,{
className:"function",begin:O,returnBegin:!0,end:"\\s*=>",contains:[{
className:"params",variants:[{begin:e.UNDERSCORE_IDENT_RE,relevance:0},{
className:null,begin:/\(\s*\)/,skip:!0},{begin:/(\s*)\(/,end:/\)/,
excludeBegin:!0,excludeEnd:!0,keywords:i,contains:h}]}]},{begin:/,/,relevance:0
},{match:/\s+/,relevance:0},{variants:[{begin:"<>",end:"</>"},{
match:/<[A-Za-z0-9\\._:-]+\s*\/>/},{begin:a.begin,
"on:begin":a.isTrulyOpeningTag,end:a.end}],subLanguage:"xml",contains:[{
begin:a.begin,end:a.end,skip:!0,contains:["self"]}]}]},w,{
beginKeywords:"while if switch catch for"},{
begin:"\\b(?!function)"+e.UNDERSCORE_IDENT_RE+"\\([^()]*(\\([^()]*(\\([^()]*\\)[^()]*)*\\)[^()]*)*\\)\\s*\\{",
returnBegin:!0,label:"func.def",contains:[f,e.inherit(e.TITLE_MODE,{begin:t,
className:"title.function"})]},{match:/\.\.\./,relevance:0},k,{match:"\\$"+t,
relevance:0},{match:[/\bconstructor(?=\s*\()/],className:{1:"title.function"},
contains:[f]},v,{relevance:0,match:/\b[A-Z][A-Z_0-9]+\b/,
className:"variable.constant"},E,x,{match:/\$[(.]/}]}}
const ue=e=>b(/\b/,e,/\w$/.test(e)?/\b/:/\B/),be=["Protocol","Type"].map(ue),me=["init","self"].map(ue),pe=["Any","Self"],_e=["actor","any","associatedtype","async","await",/as\?/,/as!/,"as","borrowing","break","case","catch","class","consume","consuming","continue","convenience","copy","default","defer","deinit","didSet","distributed","do","dynamic","each","else","enum","extension","fallthrough",/fileprivate\(set\)/,"fileprivate","final","for","func","get","guard","if","import","indirect","infix",/init\?/,/init!/,"inout",/internal\(set\)/,"internal","in","is","isolated","nonisolated","lazy","let","macro","mutating","nonmutating",/open\(set\)/,"open","operator","optional","override","package","postfix","precedencegroup","prefix",/private\(set\)/,"private","protocol",/public\(set\)/,"public","repeat","required","rethrows","return","set","some","static","struct","subscript","super","switch","throws","throw",/try\?/,/try!/,"try","typealias",/unowned\(safe\)/,/unowned\(unsafe\)/,"unowned","var","weak","where","while","willSet"],he=["false","nil","true"],fe=["assignment","associativity","higherThan","left","lowerThan","none","right"],Ee=["#colorLiteral","#column","#dsohandle","#else","#elseif","#endif","#error","#file","#fileID","#fileLiteral","#filePath","#function","#if","#imageLiteral","#keyPath","#line","#selector","#sourceLocation","#warning"],ye=["abs","all","any","assert","assertionFailure","debugPrint","dump","fatalError","getVaList","isKnownUniquelyReferenced","max","min","numericCast","pointwiseMax","pointwiseMin","precondition","preconditionFailure","print","readLine","repeatElement","sequence","stride","swap","swift_unboxFromSwiftValueWithType","transcode","type","unsafeBitCast","unsafeDowncast","withExtendedLifetime","withUnsafeMutablePointer","withUnsafePointer","withVaList","withoutActuallyEscaping","zip"],we=m(/[/=\-+!*%<>&|^~?]/,/[\u00A1-\u00A7]/,/[\u00A9\u00AB]/,/[\u00AC\u00AE]/,/[\u00B0\u00B1]/,/[\u00B6\u00BB\u00BF\u00D7\u00F7]/,/[\u2016-\u2017]/,/[\u2020-\u2027]/,/[\u2030-\u203E]/,/[\u2041-\u2053]/,/[\u2055-\u205E]/,/[\u2190-\u23FF]/,/[\u2500-\u2775]/,/[\u2794-\u2BFF]/,/[\u2E00-\u2E7F]/,/[\u3001-\u3003]/,/[\u3008-\u3020]/,/[\u3030]/),ve=m(we,/[\u0300-\u036F]/,/[\u1DC0-\u1DFF]/,/[\u20D0-\u20FF]/,/[\uFE00-\uFE0F]/,/[\uFE20-\uFE2F]/),Ne=b(we,ve,"*"),ke=m(/[a-zA-Z_]/,/[\u00A8\u00AA\u00AD\u00AF\u00B2-\u00B5\u00B7-\u00BA]/,/[\u00BC-\u00BE\u00C0-\u00D6\u00D8-\u00F6\u00F8-\u00FF]/,/[\u0100-\u02FF\u0370-\u167F\u1681-\u180D\u180F-\u1DBF]/,/[\u1E00-\u1FFF]/,/[\u200B-\u200D\u202A-\u202E\u203F-\u2040\u2054\u2060-\u206F]/,/[\u2070-\u20CF\u2100-\u218F\u2460-\u24FF\u2776-\u2793]/,/[\u2C00-\u2DFF\u2E80-\u2FFF]/,/[\u3004-\u3007\u3021-\u302F\u3031-\u303F\u3040-\uD7FF]/,/[\uF900-\uFD3D\uFD40-\uFDCF\uFDF0-\uFE1F\uFE30-\uFE44]/,/[\uFE47-\uFEFE\uFF00-\uFFFD]/),xe=m(ke,/\d/,/[\u0300-\u036F\u1DC0-\u1DFF\u20D0-\u20FF\uFE20-\uFE2F]/),Oe=b(ke,xe,"*"),Me=b(/[A-Z]/,xe,"*"),Ae=["attached","autoclosure",b(/convention\(/,m("swift","block","c"),/\)/),"discardableResult","dynamicCallable","dynamicMemberLookup","escaping","freestanding","frozen","GKInspectable","IBAction","IBDesignable","IBInspectable","IBOutlet","IBSegueAction","inlinable","main","nonobjc","NSApplicationMain","NSCopying","NSManaged",b(/objc\(/,Oe,/\)/),"objc","objcMembers","propertyWrapper","requires_stored_property_inits","resultBuilder","Sendable","testable","UIApplicationMain","unchecked","unknown","usableFromInline","warn_unqualified_access"],Se=["iOS","iOSApplicationExtension","macOS","macOSApplicationExtension","macCatalyst","macCatalystApplicationExtension","watchOS","watchOSApplicationExtension","tvOS","tvOSApplicationExtension","swift"],Ce=e=>({
IMPORTANT:{scope:"meta",begin:"!important"},
BLOCK_COMMENT:e.C_BLOCK_COMMENT_MODE,HEXCOLOR:{scope:"number",
begin:/#(([0-9a-fA-F]{3,4})|(([0-9a-fA-F]{2}){3,4}))\b/},UNICODE_RANGE:{
scope:"number",
begin:/\b[Uu]\+[0-9A-Fa-f][0-9A-Fa-f?]{0,5}(-[0-9A-Fa-f][0-9A-Fa-f]{0,5})?/},
FUNCTION_DISPATCH:{className:"built_in",begin:/[\w-]+(?=\()/},
ATTRIBUTE_SELECTOR_MODE:{scope:"selector-attr",begin:/\[/,end:/\]/,illegal:"$",
contains:[e.APOS_STRING_MODE,e.QUOTE_STRING_MODE]},CSS_NUMBER_MODE:{
scope:"number",
begin:e.NUMBER_RE+"(%|em|ex|ch|rem|vw|vh|vmin|vmax|cm|mm|in|pt|pc|px|deg|grad|rad|turn|s|ms|Hz|kHz|dpi|dpcm|dppx)?",
relevance:0},CSS_VARIABLE:{className:"attr",begin:/--[A-Za-z_][A-Za-z0-9_-]*/}
}),Te=["a","abbr","address","article","aside","audio","b","blockquote","body","button","canvas","caption","cite","code","dd","del","details","dfn","div","dl","dt","em","fieldset","figcaption","figure","footer","form","h1","h2","h3","h4","h5","h6","header","hgroup","html","i","iframe","img","input","ins","kbd","label","legend","li","main","mark","menu","nav","object","ol","optgroup","option","p","picture","q","quote","samp","section","select","source","span","strong","summary","sup","table","tbody","td","textarea","tfoot","th","thead","time","tr","ul","var","video","defs","g","marker","mask","pattern","svg","switch","symbol","feBlend","feColorMatrix","feComponentTransfer","feComposite","feConvolveMatrix","feDiffuseLighting","feDisplacementMap","feFlood","feGaussianBlur","feImage","feMerge","feMorphology","feOffset","feSpecularLighting","feTile","feTurbulence","linearGradient","radialGradient","stop","circle","ellipse","image","line","path","polygon","polyline","rect","text","use","textPath","tspan","foreignObject","clipPath"],Re=["any-hover","any-pointer","aspect-ratio","color","color-gamut","color-index","device-aspect-ratio","device-height","device-width","display-mode","forced-colors","grid","height","hover","inverted-colors","monochrome","orientation","overflow-block","overflow-inline","pointer","prefers-color-scheme","prefers-contrast","prefers-reduced-motion","prefers-reduced-transparency","resolution","scan","scripting","update","width","min-width","max-width","min-height","max-height"].sort().reverse(),De=["active","any-link","blank","checked","current","default","defined","dir","disabled","drop","empty","enabled","first","first-child","first-of-type","fullscreen","future","focus","focus-visible","focus-within","has","host","host-context","hover","indeterminate","in-range","invalid","is","lang","last-child","last-of-type","left","link","local-link","not","nth-child","nth-col","nth-last-child","nth-last-col","nth-last-of-type","nth-of-type","only-child","only-of-type","optional","out-of-range","past","placeholder-shown","read-only","read-write","required","right","root","scope","target","target-within","user-invalid","valid","visited","where"].sort().reverse(),Ie=["after","backdrop","before","cue","cue-region","first-letter","first-line","grammar-error","marker","part","placeholder","selection","slotted","spelling-error"].sort().reverse(),Le=["accent-color","align-content","align-items","align-self","alignment-baseline","all","anchor-name","animation","animation-composition","animation-delay","animation-direction","animation-duration","animation-fill-mode","animation-iteration-count","animation-name","animation-play-state","animation-range","animation-range-end","animation-range-start","animation-timeline","animation-timing-function","appearance","aspect-ratio","backdrop-filter","backface-visibility","background","background-attachment","background-blend-mode","background-clip","background-color","background-image","background-origin","background-position","background-position-x","background-position-y","background-repeat","background-size","baseline-shift","block-size","border","border-block","border-block-color","border-block-end","border-block-end-color","border-block-end-style","border-block-end-width","border-block-start","border-block-start-color","border-block-start-style","border-block-start-width","border-block-style","border-block-width","border-bottom","border-bottom-color","border-bottom-left-radius","border-bottom-right-radius","border-bottom-style","border-bottom-width","border-collapse","border-color","border-end-end-radius","border-end-start-radius","border-image","border-image-outset","border-image-repeat","border-image-slice","border-image-source","border-image-width","border-inline","border-inline-color","border-inline-end","border-inline-end-color","border-inline-end-style","border-inline-end-width","border-inline-start","border-inline-start-color","border-inline-start-style","border-inline-start-width","border-inline-style","border-inline-width","border-left","border-left-color","border-left-style","border-left-width","border-radius","border-right","border-right-color","border-right-style","border-right-width","border-spacing","border-start-end-radius","border-start-start-radius","border-style","border-top","border-top-color","border-top-left-radius","border-top-right-radius","border-top-style","border-top-width","border-width","bottom","box-align","box-decoration-break","box-direction","box-flex","box-flex-group","box-lines","box-ordinal-group","box-orient","box-pack","box-shadow","box-sizing","break-after","break-before","break-inside","caption-side","caret-color","clear","clip","clip-path","clip-rule","color","color-interpolation","color-interpolation-filters","color-profile","color-rendering","color-scheme","column-count","column-fill","column-gap","column-rule","column-rule-color","column-rule-style","column-rule-width","column-span","column-width","columns","contain","contain-intrinsic-block-size","contain-intrinsic-height","contain-intrinsic-inline-size","contain-intrinsic-size","contain-intrinsic-width","container","container-name","container-type","content","content-visibility","corner-bottom-left-shape","corner-bottom-right-shape","corner-shape","corner-top-left-shape","corner-top-right-shape","counter-increment","counter-reset","counter-set","cue","cue-after","cue-before","cursor","cx","cy","direction","display","dominant-baseline","empty-cells","enable-background","field-sizing","fill","fill-opacity","fill-rule","filter","flex","flex-basis","flex-direction","flex-flow","flex-grow","flex-shrink","flex-wrap","float","flood-color","flood-opacity","flow","font","font-display","font-family","font-feature-settings","font-kerning","font-language-override","font-optical-sizing","font-palette","font-size","font-size-adjust","font-smooth","font-smoothing","font-stretch","font-style","font-synthesis","font-synthesis-position","font-synthesis-small-caps","font-synthesis-style","font-synthesis-weight","font-variant","font-variant-alternates","font-variant-caps","font-variant-east-asian","font-variant-emoji","font-variant-ligatures","font-variant-numeric","font-variant-position","font-variation-settings","font-weight","forced-color-adjust","gap","glyph-orientation-horizontal","glyph-orientation-vertical","grid","grid-area","grid-auto-columns","grid-auto-flow","grid-auto-rows","grid-column","grid-column-end","grid-column-start","grid-gap","grid-row","grid-row-end","grid-row-start","grid-template","grid-template-areas","grid-template-columns","grid-template-rows","hanging-punctuation","height","hyphenate-character","hyphenate-limit-chars","hyphens","icon","image-orientation","image-rendering","image-resolution","ime-mode","initial-letter","initial-letter-align","inline-size","inset","inset-area","inset-block","inset-block-end","inset-block-start","inset-inline","inset-inline-end","inset-inline-start","isolation","justify-content","justify-items","justify-self","kerning","left","letter-spacing","lighting-color","line-break","line-height","line-height-step","list-style","list-style-image","list-style-position","list-style-type","margin","margin-block","margin-block-end","margin-block-start","margin-bottom","margin-inline","margin-inline-end","margin-inline-start","margin-left","margin-right","margin-top","margin-trim","marker","marker-end","marker-mid","marker-start","marks","mask","mask-border","mask-border-mode","mask-border-outset","mask-border-repeat","mask-border-slice","mask-border-source","mask-border-width","mask-clip","mask-composite","mask-image","mask-mode","mask-origin","mask-position","mask-repeat","mask-size","mask-type","masonry-auto-flow","math-depth","math-shift","math-style","max-block-size","max-height","max-inline-size","max-width","min-block-size","min-height","min-inline-size","min-width","mix-blend-mode","nav-down","nav-index","nav-left","nav-right","nav-up","none","normal","object-fit","object-position","offset","offset-anchor","offset-distance","offset-path","offset-position","offset-rotate","opacity","order","orphans","outline","outline-color","outline-offset","outline-style","outline-width","overflow","overflow-anchor","overflow-block","overflow-clip-margin","overflow-inline","overflow-wrap","overflow-x","overflow-y","overlay","overscroll-behavior","overscroll-behavior-block","overscroll-behavior-inline","overscroll-behavior-x","overscroll-behavior-y","padding","padding-block","padding-block-end","padding-block-start","padding-bottom","padding-inline","padding-inline-end","padding-inline-start","padding-left","padding-right","padding-top","page","page-break-after","page-break-before","page-break-inside","paint-order","pause","pause-after","pause-before","perspective","perspective-origin","place-content","place-items","place-self","pointer-events","position","position-anchor","position-visibility","print-color-adjust","quotes","r","resize","rest","rest-after","rest-before","right","rotate","row-gap","ruby-align","ruby-position","scale","scroll-behavior","scroll-margin","scroll-margin-block","scroll-margin-block-end","scroll-margin-block-start","scroll-margin-bottom","scroll-margin-inline","scroll-margin-inline-end","scroll-margin-inline-start","scroll-margin-left","scroll-margin-right","scroll-margin-top","scroll-padding","scroll-padding-block","scroll-padding-block-end","scroll-padding-block-start","scroll-padding-bottom","scroll-padding-inline","scroll-padding-inline-end","scroll-padding-inline-start","scroll-padding-left","scroll-padding-right","scroll-padding-top","scroll-snap-align","scroll-snap-stop","scroll-snap-type","scroll-timeline","scroll-timeline-axis","scroll-timeline-name","scrollbar-color","scrollbar-gutter","scrollbar-width","shape-image-threshold","shape-margin","shape-outside","shape-rendering","speak","speak-as","src","stop-color","stop-opacity","stroke","stroke-dasharray","stroke-dashoffset","stroke-linecap","stroke-linejoin","stroke-miterlimit","stroke-opacity","stroke-width","tab-size","table-layout","text-align","text-align-all","text-align-last","text-anchor","text-combine-upright","text-decoration","text-decoration-color","text-decoration-line","text-decoration-skip","text-decoration-skip-ink","text-decoration-style","text-decoration-thickness","text-emphasis","text-emphasis-color","text-emphasis-position","text-emphasis-style","text-indent","text-justify","text-orientation","text-overflow","text-rendering","text-shadow","text-size-adjust","text-transform","text-underline-offset","text-underline-position","text-wrap","text-wrap-mode","text-wrap-style","timeline-scope","top","touch-action","transform","transform-box","transform-origin","transform-style","transition","transition-behavior","transition-delay","transition-duration","transition-property","transition-timing-function","translate","unicode-bidi","unicode-range","user-modify","user-select","vector-effect","vertical-align","view-timeline","view-timeline-axis","view-timeline-inset","view-timeline-name","view-transition-name","visibility","voice-balance","voice-duration","voice-family","voice-pitch","voice-range","voice-rate","voice-stress","voice-volume","white-space","white-space-collapse","widows","width","will-change","word-break","word-spacing","word-wrap","writing-mode","x","y","z-index","zoom"].sort().reverse(),Be=De.concat(Ie).sort().reverse()
;var Fe="[0-9](_*[0-9])*",$e=`\\.(${Fe})`,ze="[0-9a-fA-F](_*[0-9a-fA-F])*",je={
className:"number",variants:[{
begin:`(\\b(${Fe})((${$e})|\\.)?|(${$e}))[eE][+-]?(${Fe})[fFdD]?\\b`},{
begin:`\\b(${Fe})((${$e})[fFdD]?\\b|\\.([fFdD]\\b)?)`},{
begin:`(${$e})[fFdD]?\\b`},{begin:`\\b(${Fe})[fFdD]\\b`},{
begin:`\\b0[xX]((${ze})\\.?|(${ze})?\\.(${ze}))[pP][+-]?(${Fe})[fFdD]?\\b`},{
begin:"\\b(0|[1-9](_*[0-9])*)[lL]?\\b"},{begin:`\\b0[xX](${ze})[lL]?\\b`},{
begin:"\\b0(_*[0-7])*[lL]?\\b"},{begin:"\\b0[bB][01](_*[01])*[lL]?\\b"}],
relevance:0};function Ue(e,n,t){return-1===t?"":e.replace(n,a=>Ue(e,n,t-1))}
var Pe=Object.freeze({__proto__:null,grmr_bash:e=>{const n=e.regex,t={},a={
begin:/\$\{/,end:/\}/,contains:["self",{begin:/:-/,contains:[t]}]}
;Object.assign(t,{className:"variable",variants:[{
begin:n.concat(/\$[\w\d#@][\w\d_]*/,"(?![\\w\\d])(?![$])")},a]});const i={
className:"subst",begin:/\$\(/,end:/\)/,contains:[e.BACKSLASH_ESCAPE]
},r=e.inherit(e.COMMENT(),{match:[/(^|\s)/,/#.*$/],scope:{2:"comment"}}),s={
begin:/<<-?\s*(?=\w+)/,starts:{contains:[e.END_SAME_AS_BEGIN({begin:/(\w+)/,
end:/(\w+)/,className:"string"})]}},o={className:"string",begin:/"/,end:/"/,
contains:[e.BACKSLASH_ESCAPE,t,i]};i.contains.push(o);const c={begin:/\$?\(\(/,
end:/\)\)/,contains:[{begin:/\d+#[0-9a-f]+/,className:"number"},e.NUMBER_MODE,t]
},l=e.SHEBANG({binary:"(fish|bash|zsh|sh|csh|ksh|tcsh|dash|scsh)",relevance:10
}),d={className:"function",begin:/\w[\w\d_]*\s*\(\s*\)\s*\{/,returnBegin:!0,
contains:[e.inherit(e.TITLE_MODE,{begin:/\w[\w\d_]*/})],relevance:0};return{
name:"Bash",aliases:["sh","zsh"],keywords:{$pattern:/\b[a-z][a-z0-9._-]+\b/,
keyword:["if","then","else","elif","fi","time","for","while","until","in","do","done","case","esac","coproc","function","select"],
literal:["true","false"],
built_in:["break","cd","continue","eval","exec","exit","export","getopts","hash","pwd","readonly","return","shift","test","times","trap","umask","unset","alias","bind","builtin","caller","command","declare","echo","enable","help","let","local","logout","mapfile","printf","read","readarray","source","sudo","type","typeset","ulimit","unalias","set","shopt","autoload","bg","bindkey","bye","cap","chdir","clone","comparguments","compcall","compctl","compdescribe","compfiles","compgroups","compquote","comptags","comptry","compvalues","dirs","disable","disown","echotc","echoti","emulate","fc","fg","float","functions","getcap","getln","history","integer","jobs","kill","limit","log","noglob","popd","print","pushd","pushln","rehash","sched","setcap","setopt","stat","suspend","ttyctl","unfunction","unhash","unlimit","unsetopt","vared","wait","whence","where","which","zcompile","zformat","zftp","zle","zmodload","zparseopts","zprof","zpty","zregexparse","zsocket","zstyle","ztcp","chcon","chgrp","chown","chmod","cp","dd","df","dir","dircolors","ln","ls","mkdir","mkfifo","mknod","mktemp","mv","realpath","rm","rmdir","shred","sync","touch","truncate","vdir","b2sum","base32","base64","cat","cksum","comm","csplit","cut","expand","fmt","fold","head","join","md5sum","nl","numfmt","od","paste","ptx","pr","sha1sum","sha224sum","sha256sum","sha384sum","sha512sum","shuf","sort","split","sum","tac","tail","tr","tsort","unexpand","uniq","wc","arch","basename","chroot","date","dirname","du","echo","env","expr","factor","groups","hostid","id","link","logname","nice","nohup","nproc","pathchk","pinky","printenv","printf","pwd","readlink","runcon","seq","sleep","stat","stdbuf","stty","tee","test","timeout","tty","uname","unlink","uptime","users","who","whoami","yes"]
},contains:[l,e.SHEBANG(),d,c,r,s,{match:/(\/[a-z._-]+)+/},o,{match:/\\"/},{
className:"string",begin:/'/,end:/'/},{match:/\\'/},t]}},grmr_c:e=>{
const n=e.regex,t=e.COMMENT("//","$",{contains:[{begin:/\\\n/}]
}),a="decltype\\(auto\\)",i="[a-zA-Z_]\\w*::",r="("+a+"|"+n.optional(i)+"[a-zA-Z_]\\w*"+n.optional("<[^<>]+>")+")",s={
className:"type",variants:[{begin:"\\b[a-z\\d_]*_t\\b"},{
match:n.concat(/\batomic_/,n.either("bool","char","schar","uchar","short","ushort","int","uint","long","ulong","llong","ullong","char16_t","char32_t","wchar_t","int_least8_t","uint_least8_t","int_least16_t","uint_least16_t","int_least32_t","uint_least32_t","int_least64_t","uint_least64_t","int_fast8_t","uint_fast8_t","int_fast16_t","uint_fast16_t","int_fast32_t","uint_fast32_t","int_fast64_t","uint_fast64_t","intptr_t","uintptr_t","size_t","ptrdiff_t","intmax_t","uintmax_t"),/\b/)
}]},o={className:"string",variants:[{begin:'(u8?|U|L)?"',end:'"',illegal:"\\n",
contains:[e.BACKSLASH_ESCAPE]},{
begin:"(u8?|U|L)?'(\\\\(x[0-9A-Fa-f]{2}|u[0-9A-Fa-f]{4,8}|[0-7]{3}|\\S)|.)",
end:"'",illegal:"."},e.END_SAME_AS_BEGIN({
begin:/(?:u8?|U|L)?R"([^()\\\s"]{0,16})\(/,end:/\)([^()\\\s"]{0,16})"/})]},c={
className:"number",variants:[{match:/\b(0b[01']+)/},{
match:/(-?)\b([\d']+(\.[\d']*)?|\.[\d']+)((ll|LL|l|L)(u|U)?|(u|U)(ll|LL|l|L)?|f|F|b|B)/
},{
match:/(-?)\b(0[xX][a-fA-F0-9]+(?:'[a-fA-F0-9]+)*(?:\.[a-fA-F0-9]*(?:'[a-fA-F0-9]*)*)?(?:[pP][-+]?[0-9]+)?(l|L)?(u|U)?)/
},{match:/(-?)\b\d+(?:'\d+)*(?:\.\d*(?:'\d*)*)?(?:[eE][-+]?\d+)?/}],relevance:0
},l={scope:"meta",begin:/#\s*include\b/,end:/$/,keywords:{keyword:"include"},
contains:[{begin:/\\\n/},o,{scope:"string",begin:/<.*?>/
},t,e.C_BLOCK_COMMENT_MODE]},d={className:"meta",begin:/#\s*[a-z]+\b/,end:/$/,
keywords:{
keyword:"if else elif endif define undef warning error line pragma _Pragma ifdef ifndef elifdef elifndef include"
},contains:[{begin:/\\\n/,relevance:0},e.inherit(o,{className:"string"
}),t,e.C_BLOCK_COMMENT_MODE]},g=[l,d],u={className:"title",
begin:n.optional(i)+e.IDENT_RE,relevance:0
},b=n.optional(i)+e.IDENT_RE+"\\s*\\(",m={
keyword:["asm","auto","break","case","continue","default","do","else","enum","extern","for","fortran","goto","if","inline","register","restrict","return","sizeof","typeof","typeof_unqual","struct","switch","typedef","union","volatile","while","_Alignas","_Alignof","_Atomic","_Generic","_Noreturn","_Static_assert","_Thread_local","alignas","alignof","noreturn","static_assert","thread_local","_Pragma"],
type:["float","double","signed","unsigned","int","short","long","char","void","_Bool","_BitInt","_Complex","_Imaginary","_Decimal32","_Decimal64","_Decimal96","_Decimal128","_Decimal64x","_Decimal128x","_Float16","_Float32","_Float64","_Float128","_Float32x","_Float64x","_Float128x","const","static","constexpr","complex","bool","imaginary"],
literal:"true false NULL",
built_in:"std string wstring cin cout cerr clog stdin stdout stderr stringstream istringstream ostringstream auto_ptr deque list queue stack vector map set pair bitset multiset multimap unordered_set unordered_map unordered_multiset unordered_multimap priority_queue make_pair array shared_ptr abort terminate abs acos asin atan2 atan calloc ceil cosh cos exit exp fabs floor fmod fprintf fputs free frexp fscanf future isalnum isalpha iscntrl isdigit isgraph islower isprint ispunct isspace isupper isxdigit tolower toupper labs ldexp log10 log malloc realloc memchr memcmp memcpy memset modf pow printf putchar puts scanf sinh sin snprintf sprintf sqrt sscanf strcat strchr strcmp strcpy strcspn strlen strncat strncmp strncpy strpbrk strrchr strspn strstr tanh tan vfprintf vprintf vsprintf endl initializer_list unique_ptr"
},p=[...g,s,t,e.C_BLOCK_COMMENT_MODE,c,o],_={variants:[{begin:/=/,end:/;/},{
begin:/\(/,end:/\)/},{beginKeywords:"new throw return else",end:/;/}],
keywords:m,contains:p.concat([{begin:/\(/,end:/\)/,keywords:m,
contains:p.concat(["self"]),relevance:0}]),relevance:0},h={
begin:"("+r+"[\\*&\\s]+){1,12}"+b,returnBegin:!0,end:/[{;=]/,excludeEnd:!0,
keywords:m,illegal:/[^\w\s\*&:<>.]/,contains:[{begin:a,keywords:m,relevance:0},{
begin:b,returnBegin:!0,contains:[e.inherit(u,{className:"title.function"})],
relevance:0},{relevance:0,match:/,/},{className:"params",begin:/\(/,end:/\)/,
keywords:m,relevance:0,contains:[t,e.C_BLOCK_COMMENT_MODE,o,c,s,{begin:/\(/,
end:/\)/,keywords:m,relevance:0,contains:["self",t,e.C_BLOCK_COMMENT_MODE,o,c,s]
}]},s,t,e.C_BLOCK_COMMENT_MODE,...g]};return{name:"C",aliases:["h"],keywords:m,
disableAutodetect:!0,illegal:"</",contains:[].concat(_,h,p,[...g,{
begin:e.IDENT_RE+"::",keywords:m},{className:"class",
beginKeywords:"enum class struct union",end:/[{;:<>=]/,contains:[{
beginKeywords:"final class struct"},e.TITLE_MODE]}]),exports:{preprocessor:d,
strings:o,keywords:m}}},grmr_cpp:e=>{const n=e.regex,t=e.COMMENT("//","$",{
contains:[{begin:/\\\n/}]
}),a="decltype\\(auto\\)",i="[a-zA-Z_]\\w*::",r="(?!struct)("+a+"|"+n.optional(i)+"[a-zA-Z_]\\w*"+n.optional("<[^<>]+>")+")",s={
className:"type",begin:"\\b[a-z\\d_]*_t\\b"},o={className:"string",variants:[{
begin:'(u8?|U|L)?"',end:'"',illegal:"\\n",contains:[e.BACKSLASH_ESCAPE]},{
begin:"(u8?|U|L)?'(\\\\(x[0-9A-Fa-f]{2}|u[0-9A-Fa-f]{4,8}|[0-7]{3}|\\S)|.)",
end:"'",illegal:"."},e.END_SAME_AS_BEGIN({
begin:/(?:u8?|U|L)?R"([^()\\\s"]{0,16})\(/,end:/\)([^()\\\s"]{0,16})"/})]},c={
className:"number",variants:[{
begin:"[+-]?(?:(?:\\b[0-9](?:'?[0-9])*\\.(?:[0-9](?:'?[0-9])*)?|\\.[0-9](?:'?[0-9])*)(?:[Ee][+-]?[0-9](?:'?[0-9])*)?|\\b[0-9](?:'?[0-9])*[Ee][+-]?[0-9](?:'?[0-9])*|\\b0[Xx](?:[0-9A-Fa-f](?:'?[0-9A-Fa-f])*(?:\\.(?:[0-9A-Fa-f](?:'?[0-9A-Fa-f])*)?)?|\\.[0-9A-Fa-f](?:'?[0-9A-Fa-f])*)[Pp][+-]?[0-9](?:'?[0-9])*)(?:[Ff](?:16|32|64|128)?|(BF|bf)16|[Ll]|)"
},{
begin:"[+-]?\\b(?:0[Bb][01](?:'?[01])*|0[Xx][0-9A-Fa-f](?:'?[0-9A-Fa-f])*|0(?:'?[0-7])*|[1-9](?:'?[0-9])*)(?:[Uu](?:LL?|ll?)|[Uu][Zz]?|(?:LL?|ll?)[Uu]?|[Zz][Uu]|)"
}],relevance:0},l=[{scope:"meta",begin:/#\s*include\b/,end:/$/,keywords:{
keyword:"include"},contains:[{begin:/\\\n/},o,{scope:"string",begin:/<.*?>/
},t,e.C_BLOCK_COMMENT_MODE]},{className:"meta",begin:/#\s*[a-z]+\b/,end:/$/,
keywords:{
keyword:"if else elif endif define undef warning error line pragma _Pragma ifdef ifndef include"
},contains:[{begin:/\\\n/,relevance:0},e.inherit(o,{className:"string"
}),t,e.C_BLOCK_COMMENT_MODE]}],d={className:"title",
begin:n.optional(i)+e.IDENT_RE,relevance:0
},g=n.optional(i)+e.IDENT_RE+"\\s*\\(",u=["alignas","alignof","and","and_eq","asm","atomic_cancel","atomic_commit","atomic_noexcept","auto","bitand","bitor","break","case","catch","class","co_await","co_return","co_yield","compl","concept","const_cast|10","consteval","constexpr","constinit","continue","decltype","default","delete","do","dynamic_cast|10","else","enum","explicit","export","extern","false","final","for","friend","goto","if","import","inline","module","mutable","namespace","new","noexcept","not","not_eq","nullptr","operator","or","or_eq","override","private","protected","public","reflexpr","register","reinterpret_cast|10","requires","return","sizeof","static_assert","static_cast|10","struct","switch","synchronized","template","this","thread_local","throw","transaction_safe","transaction_safe_dynamic","true","try","typedef","typeid","typename","union","using","virtual","volatile","while","xor","xor_eq"],b={
type:["bool","char","char16_t","char32_t","char8_t","double","float","int","long","short","void","wchar_t","unsigned","signed","const","static"],
keyword:u,literal:["NULL","false","nullopt","nullptr","true"],
built_in:["_Pragma"],
_type_hints:["any","auto_ptr","barrier","binary_semaphore","bitset","complex","condition_variable","condition_variable_any","counting_semaphore","deque","false_type","flat_map","flat_set","future","imaginary","initializer_list","istringstream","jthread","latch","lock_guard","multimap","multiset","mutex","optional","ostringstream","packaged_task","pair","promise","priority_queue","queue","recursive_mutex","recursive_timed_mutex","scoped_lock","set","shared_future","shared_lock","shared_mutex","shared_timed_mutex","shared_ptr","stack","string_view","stringstream","timed_mutex","thread","true_type","tuple","unique_lock","unique_ptr","unordered_map","unordered_multimap","unordered_multiset","unordered_set","variant","vector","weak_ptr","wstring","wstring_view"]
},m={className:"function.dispatch",relevance:0,keywords:{
_hint:["abort","abs","acos","apply","as_const","asin","atan","atan2","calloc","ceil","cerr","cin","clog","cos","cosh","cout","declval","endl","exchange","exit","exp","fabs","floor","fmod","forward","fprintf","fputs","free","frexp","fscanf","future","invoke","isalnum","isalpha","iscntrl","isdigit","isgraph","islower","isprint","ispunct","isspace","isupper","isxdigit","labs","launder","ldexp","log","log10","make_pair","make_shared","make_shared_for_overwrite","make_tuple","make_unique","malloc","memchr","memcmp","memcpy","memset","modf","move","pow","printf","putchar","puts","realloc","scanf","sin","sinh","snprintf","sprintf","sqrt","sscanf","std","stderr","stdin","stdout","strcat","strchr","strcmp","strcpy","strcspn","strlen","strncat","strncmp","strncpy","strpbrk","strrchr","strspn","strstr","swap","tan","tanh","terminate","to_underlying","tolower","toupper","vfprintf","visit","vprintf","vsprintf"]
},
begin:n.concat(/\b/,`(?!${u.join("|")})`,e.IDENT_RE,n.lookahead(/(<[^<>]+>|)\s*\(/))
},p=[m,...l,s,t,e.C_BLOCK_COMMENT_MODE,c,o],_={variants:[{begin:/=/,end:/;/},{
begin:/\(/,end:/\)/},{beginKeywords:"new throw return else",end:/;/}],
keywords:b,contains:p.concat([{begin:/\(/,end:/\)/,keywords:b,
contains:p.concat(["self"]),relevance:0}]),relevance:0},h={className:"function",
begin:"("+r+"[\\*&\\s]+){1,12}"+g,returnBegin:!0,end:/[{;=]/,excludeEnd:!0,
keywords:b,illegal:/[^\w\s\*&:<>.]/,contains:[{begin:a,keywords:b,relevance:0},{
begin:g,returnBegin:!0,contains:[d],relevance:0},{begin:/::/,relevance:0},{
begin:/:/,endsWithParent:!0,contains:[o,c]},{relevance:0,match:/,/},{
className:"params",begin:/\(/,end:/\)/,keywords:b,relevance:0,
contains:[t,e.C_BLOCK_COMMENT_MODE,o,c,s,{begin:/\(/,end:/\)/,keywords:b,
relevance:0,contains:["self",t,e.C_BLOCK_COMMENT_MODE,o,c,s]}]
},s,t,e.C_BLOCK_COMMENT_MODE,...l]};return{name:"C++",
aliases:["cc","c++","h++","hpp","hh","hxx","cxx"],keywords:b,illegal:"</",
classNameAliases:{"function.dispatch":"built_in"},
contains:[].concat(_,h,m,p,[...l,{
begin:"\\b(deque|list|queue|priority_queue|pair|stack|vector|map|set|bitset|multiset|multimap|unordered_map|unordered_set|unordered_multiset|unordered_multimap|array|tuple|optional|variant|function|flat_map|flat_set)\\s*<(?!<)",
end:">",keywords:b,contains:["self",s]},{begin:e.IDENT_RE+"::",keywords:b},{
match:[/\b(?:enum(?:\s+(?:class|struct))?|class|struct|union)/,/\s+/,/\w+/],
className:{1:"keyword",3:"title.class"}}])}},grmr_csharp:e=>{const n={
keyword:["abstract","as","base","break","case","catch","class","const","continue","do","else","event","explicit","extern","finally","fixed","for","foreach","goto","if","implicit","in","interface","internal","is","lock","namespace","new","operator","out","override","params","private","protected","public","readonly","record","ref","return","scoped","sealed","sizeof","stackalloc","static","struct","switch","this","throw","try","typeof","unchecked","unsafe","using","virtual","void","volatile","while"].concat(["add","alias","and","ascending","args","async","await","by","descending","dynamic","equals","file","from","get","global","group","init","into","join","let","nameof","not","notnull","on","or","orderby","partial","record","remove","required","scoped","select","set","unmanaged","value|0","var","when","where","with","yield"]),
built_in:["bool","byte","char","decimal","delegate","double","dynamic","enum","float","int","long","nint","nuint","object","sbyte","short","string","ulong","uint","ushort"],
literal:["default","false","null","true"]},t=e.inherit(e.TITLE_MODE,{
begin:"[a-zA-Z](\\.?\\w)*"}),a="\\d(_*\\d)*",i="([uU][lL]?|[lL][uU]?)?",r={
className:"number",variants:[{begin:"\\b0[bB]_*[01](_*[01])*"+i},{
begin:"(-?)\\b0[xX]_*[a-fA-F0-9](_*[a-fA-F0-9])*"+i},{
begin:"(-?)(\\b"+a+"(\\.("+a+")?)?|\\."+a+")([eE][-+]?"+a+")?([fFdDmM]|[uU][lL]?|[lL][uU]?)?"
}],relevance:0},s={className:"string",begin:'@"',end:'"',contains:[{begin:'""'}]
},o=e.inherit(s,{illegal:/\n/}),c={className:"subst",begin:/\{/,end:/\}/,
keywords:n},l=e.inherit(c,{illegal:/\n/}),d={className:"string",begin:/\$"/,
end:'"',illegal:/\n/,contains:[{begin:/\{\{/},{begin:/\}\}/
},e.BACKSLASH_ESCAPE,l]},g={className:"string",begin:/\$@"/,end:'"',contains:[{
begin:/\{\{/},{begin:/\}\}/},{begin:'""'},c]},u=e.inherit(g,{illegal:/\n/,
contains:[{begin:/\{\{/},{begin:/\}\}/},{begin:'""'},l]})
;c.contains=[g,d,s,e.APOS_STRING_MODE,e.QUOTE_STRING_MODE,r,e.C_BLOCK_COMMENT_MODE],
l.contains=[u,d,o,e.APOS_STRING_MODE,e.QUOTE_STRING_MODE,r,e.inherit(e.C_BLOCK_COMMENT_MODE,{
illegal:/\n/})];const b={variants:[{className:"string",
begin:/"""("*)(?!")(.|\n)*?"""\1/,relevance:1
},g,d,s,e.APOS_STRING_MODE,e.QUOTE_STRING_MODE]},m={begin:"<",end:">",
contains:[{beginKeywords:"in out"},t]
},p=e.IDENT_RE+"(<"+e.IDENT_RE+"(\\s*,\\s*"+e.IDENT_RE+")*>)?(\\[\\])?",_={
begin:"@"+e.IDENT_RE,relevance:0};return{name:"C#",aliases:["cs","c#"],
keywords:n,illegal:/::/,contains:[e.COMMENT("///","$",{returnBegin:!0,
contains:[{className:"doctag",variants:[{begin:"///",relevance:0},{
begin:"\x3c!--|--\x3e"},{begin:"</?",end:">"}]}]
}),e.C_LINE_COMMENT_MODE,e.C_BLOCK_COMMENT_MODE,{className:"meta",begin:"#",
end:"$",keywords:{
keyword:"if else elif endif define undef warning error line region endregion pragma checksum"
}},b,r,{beginKeywords:"class interface",relevance:0,end:/[{;=]/,
illegal:/[^\s:,]/,contains:[{beginKeywords:"where class"
},t,m,e.C_LINE_COMMENT_MODE,e.C_BLOCK_COMMENT_MODE]},{beginKeywords:"namespace",
relevance:0,end:/[{;=]/,illegal:/[^\s:]/,
contains:[t,e.C_LINE_COMMENT_MODE,e.C_BLOCK_COMMENT_MODE]},{
beginKeywords:"record",relevance:0,end:/[{;=]/,illegal:/[^\s:]/,
contains:[t,m,e.C_LINE_COMMENT_MODE,e.C_BLOCK_COMMENT_MODE]},{className:"meta",
begin:"^\\s*\\[(?=[\\w])",excludeBegin:!0,end:"\\]",excludeEnd:!0,contains:[{
className:"string",begin:/"/,end:/"/}]},{
beginKeywords:"new return throw await else",relevance:0},{className:"function",
begin:"("+p+"\\s+)+"+e.IDENT_RE+"\\s*(<[^=]+>\\s*)?\\(",returnBegin:!0,
end:/\s*[{;=]/,excludeEnd:!0,keywords:n,contains:[{
beginKeywords:"public private protected static internal protected abstract async extern override unsafe virtual new sealed partial",
relevance:0},{begin:e.IDENT_RE+"\\s*(<[^=]+>\\s*)?\\(",returnBegin:!0,
contains:[e.TITLE_MODE,m],relevance:0},{match:/\(\)/},{className:"params",
begin:/\(/,end:/\)/,excludeBegin:!0,excludeEnd:!0,keywords:n,relevance:0,
contains:[b,r,e.C_BLOCK_COMMENT_MODE]
},e.C_LINE_COMMENT_MODE,e.C_BLOCK_COMMENT_MODE]},_]}},grmr_css:e=>{
const n=e.regex,t=Ce(e),a=[e.APOS_STRING_MODE,e.QUOTE_STRING_MODE];return{
name:"CSS",case_insensitive:!0,illegal:/[=|'\$]/,keywords:{
keyframePosition:"from to"},classNameAliases:{keyframePosition:"selector-tag"},
contains:[t.BLOCK_COMMENT,{begin:/-(webkit|moz|ms|o)-(?=[a-z])/
},t.CSS_NUMBER_MODE,{className:"selector-id",begin:/#[A-Za-z0-9_-]+/,relevance:0
},{className:"selector-class",begin:"\\.[a-zA-Z-][a-zA-Z0-9_-]*",relevance:0
},t.ATTRIBUTE_SELECTOR_MODE,{className:"selector-pseudo",variants:[{
begin:":("+De.join("|")+")"},{begin:":(:)?("+Ie.join("|")+")"}]
},t.CSS_VARIABLE,{className:"attribute",begin:"\\b("+Le.join("|")+")\\b"},{
begin:/:/,end:/[;}{]/,
contains:[t.BLOCK_COMMENT,t.HEXCOLOR,t.IMPORTANT,t.CSS_NUMBER_MODE,t.UNICODE_RANGE,...a,{
begin:/(url|data-uri)\(/,end:/\)/,relevance:0,keywords:{built_in:"url data-uri"
},contains:[...a,{className:"string",begin:/[^)]/,endsWithParent:!0,
excludeEnd:!0}]},t.FUNCTION_DISPATCH]},{begin:n.lookahead(/@/),end:"[{;]",
relevance:0,illegal:/:/,contains:[{className:"keyword",begin:/@-?\w[\w]*(-\w+)*/
},{begin:/\s/,endsWithParent:!0,excludeEnd:!0,relevance:0,keywords:{
$pattern:/[a-z-]+/,keyword:"and or not only",attribute:Re.join(" ")},contains:[{
begin:/[a-z-]+(?=:)/,className:"attribute"},...a,t.CSS_NUMBER_MODE]}]},{
className:"selector-tag",begin:"\\b("+Te.join("|")+")\\b"}]}},grmr_diff:e=>{
const n=e.regex;return{name:"Diff",aliases:["patch"],contains:[{
className:"meta",relevance:10,
match:n.either(/^@@ +-\d+,\d+ +\+\d+,\d+ +@@/,/^@@ +-\d+ +\+\d+,\d+ +@@/,/^@@ +-\d+,\d+ +\+\d+ +@@/,/^@@ +-\d+ +\+\d+ +@@/,/^\*\*\* +\d+,\d+ +\*\*\*\*$/,/^--- +\d+,\d+ +----$/)
},{className:"comment",variants:[{
begin:n.either(/Index: /,/^index/,/={3,}/,/^-{3}/,/^\*{3} /,/^\+{3}/,/^diff --git/),
end:/$/},{match:/^\*{15}$/}]},{className:"addition",begin:/^\+/,end:/$/},{
className:"deletion",begin:/^-/,end:/$/},{className:"addition",begin:/^!/,
end:/$/}]}},grmr_go:e=>{const n={
keyword:["break","case","chan","const","continue","default","defer","else","fallthrough","for","func","go","goto","if","import","interface","map","package","range","return","select","struct","switch","type","var"],
type:["bool","byte","complex64","complex128","error","float32","float64","int8","int16","int32","int64","string","uint8","uint16","uint32","uint64","int","uint","uintptr","rune"],
literal:["true","false","iota","nil"],
built_in:["append","cap","close","complex","copy","imag","len","make","new","panic","print","println","real","recover","delete"]
};return{name:"Go",aliases:["golang"],keywords:n,illegal:"</",
contains:[e.C_LINE_COMMENT_MODE,e.C_BLOCK_COMMENT_MODE,{className:"string",
variants:[e.QUOTE_STRING_MODE,e.APOS_STRING_MODE,{begin:"`",end:"`"}]},{
className:"number",variants:[{
match:/-?\b0[xX]\.[a-fA-F0-9](_?[a-fA-F0-9])*[pP][+-]?\d(_?\d)*i?/,relevance:0
},{
match:/-?\b0[xX](_?[a-fA-F0-9])+((\.([a-fA-F0-9](_?[a-fA-F0-9])*)?)?[pP][+-]?\d(_?\d)*)?i?/,
relevance:0},{match:/-?\b0[oO](_?[0-7])*i?/,relevance:0},{
match:/-?\b0[bB](_?[01])*i?/,relevance:0},{
match:/-?\.\d(_?\d)*([eE][+-]?\d(_?\d)*)?i?/,relevance:0},{
match:/-?\b\d(_?\d)*(\.(\d(_?\d)*)?)?([eE][+-]?\d(_?\d)*)?i?/,relevance:0}]},{
begin:/:=/},{className:"function",beginKeywords:"func",end:"\\s*(\\{|$)",
excludeEnd:!0,contains:[e.TITLE_MODE,{className:"params",begin:/\(/,end:/\)/,
endsParent:!0,keywords:n,illegal:/["']/}]}]}},grmr_graphql:e=>{const n=e.regex
;return{name:"GraphQL",aliases:["gql"],case_insensitive:!0,disableAutodetect:!1,
keywords:{
keyword:["query","mutation","subscription","type","input","schema","directive","interface","union","scalar","fragment","enum","on"],
literal:["true","false","null"]},
contains:[e.HASH_COMMENT_MODE,e.QUOTE_STRING_MODE,e.NUMBER_MODE,{
scope:"punctuation",match:/[.]{3}/,relevance:0},{scope:"punctuation",
begin:/[\!\(\)\:\=\[\]\{\|\}]{1}/,relevance:0},{scope:"variable",begin:/\$/,
end:/\W/,excludeEnd:!0,relevance:0},{scope:"meta",match:/@\w+/,excludeEnd:!0},{
scope:"symbol",begin:n.concat(/[_A-Za-z][_0-9A-Za-z]*/,n.lookahead(/\s*:/)),
relevance:0}],illegal:[/[;<']/,/BEGIN/]}},grmr_ini:e=>{const n=e.regex,t={
className:"number",relevance:0,variants:[{begin:/([+-]+)?[\d]+_[\d_]+/},{
begin:e.NUMBER_RE}]},a=e.COMMENT();a.variants=[{begin:/;/,end:/$/},{begin:/#/,
end:/$/}];const i={className:"variable",variants:[{begin:/\$[\w\d"][\w\d_]*/},{
begin:/\$\{(.*?)\}/}]},r={className:"literal",
begin:/\bon|off|true|false|yes|no\b/},s={className:"string",
contains:[e.BACKSLASH_ESCAPE],variants:[{begin:"'''",end:"'''",relevance:10},{
begin:'"""',end:'"""',relevance:10},{begin:'"',end:'"'},{begin:"'",end:"'"}]
},o={begin:/\[/,end:/\]/,contains:[a,r,i,s,t,"self"],relevance:0
},c=n.either(/[A-Za-z0-9_-]+/,/"(\\"|[^"])*"/,/'[^']*'/);return{
name:"TOML, also INI",aliases:["toml"],case_insensitive:!0,illegal:/\S/,
contains:[a,{className:"section",begin:/\[+/,end:/\]+/},{
begin:n.concat(c,"(\\s*\\.\\s*",c,")*",n.lookahead(/\s*=\s*[^#\s]/)),
className:"attr",starts:{end:/$/,contains:[a,o,r,i,s,t]}}]}},grmr_java:e=>{
const n=e.regex,t="[\xc0-\u02b8a-zA-Z_$][\xc0-\u02b8a-zA-Z_$0-9]*",a="(?:(?:\\s*\\[\\s*])+)?",i=t+"<@@@>"+a,r="(?:\\?(?:\\s+(?:extends|super)\\s+"+i+")?|"+i+")",s=Ue("(?:\\s*<\\s*"+r+"(?:\\s*,\\s*"+r+")*\\s*>)?",/<@@@>/g,2),o={
keyword:["synchronized","abstract","private","var","static","if","const ","for","while","strictfp","finally","protected","import","native","final","void","enum","else","break","transient","catch","instanceof","volatile","case","assert","package","default","public","try","switch","continue","throws","protected","public","private","module","requires","exports","do","sealed","yield","permits","goto","when"],
literal:["false","true","null"],
type:["char","boolean","long","float","int","byte","short","double"],
built_in:["super","this"]},c={className:"meta",begin:"@"+t,contains:[{
begin:/\(/,end:/\)/,contains:["self"]}]},l={className:"params",begin:/\(/,
end:/\)/,keywords:o,relevance:0,contains:[e.C_BLOCK_COMMENT_MODE],endsParent:!0}
;return{name:"Java",aliases:["jsp"],keywords:o,illegal:/<\/|#/,
contains:[e.COMMENT("/\\*\\*","\\*/",{relevance:0,contains:[{begin:/\w+@/,
relevance:0},{className:"doctag",begin:"@[A-Za-z]+"}]}),{
begin:/import java\.[a-z]+\./,keywords:"import",relevance:2
},e.C_LINE_COMMENT_MODE,e.C_BLOCK_COMMENT_MODE,{begin:/"""/,end:/"""/,
className:"string",contains:[e.BACKSLASH_ESCAPE]
},e.APOS_STRING_MODE,e.QUOTE_STRING_MODE,{
match:[/\b(?:class|interface|enum|extends|implements|new)/,/\s+/,t],className:{
1:"keyword",3:"title.class"}},{match:/non-sealed/,scope:"keyword"},{
beginKeywords:"new throw return else yield assert",relevance:0},{
begin:[t,n.concat(s,a,/\s+/),t,a,/\s*/,/=(?!=)/],className:{1:"type",
3:"variable",6:"operator"}},{begin:[/record/,/\s+/,t],className:{1:"keyword",
3:"title.class"},contains:[l,e.C_LINE_COMMENT_MODE,e.C_BLOCK_COMMENT_MODE]},{
begin:[t,n.concat(s,a,/\s+/),t,/\s*(?=\()/],className:{1:"type",
3:"title.function"},keywords:o,contains:[{className:"params",begin:/\(/,
end:/\)/,keywords:o,relevance:0,
contains:[c,e.APOS_STRING_MODE,e.QUOTE_STRING_MODE,je,e.C_BLOCK_COMMENT_MODE]
},e.C_LINE_COMMENT_MODE,e.C_BLOCK_COMMENT_MODE]},je,c]}},grmr_javascript:ge,
grmr_json:e=>{const n=["true","false","null"],t={scope:"literal",
beginKeywords:n.join(" ")};return{name:"JSON",aliases:["jsonc","json5"],
keywords:{literal:n},contains:[{className:"attr",
begin:/(("(\\.|[^\\"\r\n])*")|('(\\.|[^\\'\r\n])*'))(?=\s*:)/,relevance:1.01},{
match:/[{}[\],:]/,className:"punctuation",relevance:0
},e.APOS_STRING_MODE,e.QUOTE_STRING_MODE,t,ae,e.C_LINE_COMMENT_MODE,e.C_BLOCK_COMMENT_MODE],
illegal:"\\S"}},grmr_kotlin:e=>{const n={
keyword:"abstract as val var vararg get set class object open private protected public noinline crossinline dynamic final enum if else do while for when throw try catch finally import package is in fun override companion reified inline lateinit init interface annotation data sealed internal infix operator out by constructor super tailrec where const inner suspend typealias external expect actual",
built_in:"Byte Short Char Int Long Boolean Float Double Void Unit Nothing",
literal:"true false null"},t={className:"symbol",begin:e.UNDERSCORE_IDENT_RE+"@"
},a={className:"subst",begin:/\$\{/,end:/\}/,contains:[e.C_NUMBER_MODE]},i={
className:"variable",begin:"\\$"+e.UNDERSCORE_IDENT_RE},r={className:"string",
variants:[{begin:'"""',end:'"""(?=[^"])',contains:[i,a]},{begin:"'",end:"'",
illegal:/\n/,contains:[e.BACKSLASH_ESCAPE]},{begin:'"',end:'"',illegal:/\n/,
contains:[e.BACKSLASH_ESCAPE,i,a]}]};a.contains.push(r);const s={
className:"meta",
begin:"@(?:file|property|field|get|set|receiver|param|setparam|delegate)\\s*:(?:\\s*"+e.UNDERSCORE_IDENT_RE+")?"
},o={className:"meta",begin:"@"+e.UNDERSCORE_IDENT_RE,contains:[{begin:/\(/,
end:/\)/,contains:[e.inherit(r,{className:"string"}),"self"]}]
},c=je,l=e.COMMENT("/\\*","\\*/",{contains:[e.C_BLOCK_COMMENT_MODE]}),d={
variants:[{className:"type",begin:e.UNDERSCORE_IDENT_RE},{begin:/\(/,end:/\)/,
contains:[]}]},g=d;return g.variants[1].contains=[d],d.variants[1].contains=[g],
{name:"Kotlin",aliases:["kt","kts","ktm","ktx"],keywords:n,
contains:[e.COMMENT("/\\*\\*","\\*/",{relevance:0,contains:[{className:"doctag",
begin:"@[A-Za-z]+"}]}),e.C_LINE_COMMENT_MODE,l,{className:"keyword",
begin:/\b(break|continue|return|this)\b/,starts:{contains:[{className:"symbol",
begin:/@\w+/}]}},t,s,o,{className:"function",beginKeywords:"fun",end:"[(]|$",
returnBegin:!0,excludeEnd:!0,keywords:n,relevance:5,contains:[{
begin:e.UNDERSCORE_IDENT_RE+"\\s*\\(",returnBegin:!0,relevance:0,
contains:[e.UNDERSCORE_TITLE_MODE]},{className:"type",begin:/</,end:/>/,
keywords:"reified",relevance:0},{className:"params",begin:/\(/,end:/\)/,
endsParent:!0,keywords:n,relevance:0,contains:[{begin:/:/,end:/[=,\/]/,
endsWithParent:!0,contains:[d,e.C_LINE_COMMENT_MODE,l],relevance:0
},e.C_LINE_COMMENT_MODE,l,s,o,r,e.C_NUMBER_MODE]},l]},{
begin:[/class|interface|trait/,/\s+/,e.UNDERSCORE_IDENT_RE],beginScope:{
3:"title.class"},keywords:"class interface trait",end:/[:\{(]|$/,excludeEnd:!0,
illegal:"extends implements",contains:[{
beginKeywords:"public protected internal private constructor"
},e.UNDERSCORE_TITLE_MODE,{className:"type",begin:/</,end:/>/,excludeBegin:!0,
excludeEnd:!0,relevance:0},{className:"type",begin:/[,:]\s*/,end:/[<\(,){\s]|$/,
excludeBegin:!0,returnEnd:!0},s,o]},r,{className:"meta",begin:"^#!/usr/bin/env",
end:"$",illegal:"\n"},c]}},grmr_less:e=>{
const n=Ce(e),t=Be,a="[\\w-]+",i="("+a+"|@\\{"+a+"\\})",r=[],s=[],o=e=>({
className:"string",begin:"~?"+e+".*?"+e}),c=(e,n,t)=>({className:e,begin:n,
relevance:t}),l={$pattern:/[a-z-]+/,keyword:"and or not only",
attribute:Re.join(" ")},d={begin:"\\(",end:"\\)",contains:s,keywords:l,
relevance:0}
;s.push(e.C_LINE_COMMENT_MODE,e.C_BLOCK_COMMENT_MODE,o("'"),o('"'),n.CSS_NUMBER_MODE,{
begin:"(url|data-uri)\\(",starts:{className:"string",end:"[\\)\\n]",
excludeEnd:!0}
},n.UNICODE_RANGE,n.HEXCOLOR,d,c("variable","@@?"+a,10),c("variable","@\\{"+a+"\\}"),c("built_in","~?`[^`]*?`"),{
className:"attribute",begin:a+"\\s*:",end:":",returnBegin:!0,excludeEnd:!0
},n.IMPORTANT,{beginKeywords:"and not"},n.FUNCTION_DISPATCH);const g=s.concat({
begin:/\{/,end:/\}/,contains:r}),u={beginKeywords:"when",endsWithParent:!0,
contains:[{beginKeywords:"and not"}].concat(s)},b={begin:i+"\\s*:",
returnBegin:!0,end:/[;}]/,relevance:0,contains:[{begin:/-(webkit|moz|ms|o)-/
},n.CSS_VARIABLE,{className:"attribute",begin:"\\b("+Le.join("|")+")\\b",
end:/(?=:)/,starts:{endsWithParent:!0,illegal:"[<=$]",relevance:0,contains:s}}]
},m={className:"keyword",
begin:"@(import|media|charset|font-face|(-[a-z]+-)?keyframes|supports|document|namespace|page|viewport|host)\\b",
starts:{end:"[;{}]",keywords:l,returnEnd:!0,contains:s,relevance:0}},p={
className:"variable",variants:[{begin:"@"+a+"\\s*:",relevance:15},{begin:"@"+a
}],starts:{end:"[;}]",returnEnd:!0,contains:g}},_={variants:[{
begin:"[\\.#:&\\[>]",end:"[;{}]"},{begin:i,end:/\{/}],returnBegin:!0,
returnEnd:!0,illegal:"[<='$\"]",relevance:0,
contains:[e.C_LINE_COMMENT_MODE,e.C_BLOCK_COMMENT_MODE,u,c("keyword","all\\b"),c("variable","@\\{"+a+"\\}"),{
begin:"\\b("+Te.join("|")+")\\b",className:"selector-tag"
},n.CSS_NUMBER_MODE,c("selector-tag",i,0),c("selector-id","#"+i),c("selector-class","\\."+i,0),c("selector-tag","&",0),n.ATTRIBUTE_SELECTOR_MODE,{
className:"selector-pseudo",begin:":("+De.join("|")+")"},{
className:"selector-pseudo",begin:":(:)?("+Ie.join("|")+")"},{begin:/\(/,
end:/\)/,relevance:0,contains:g},{begin:"!important"},n.FUNCTION_DISPATCH]},h={
begin:a+":(:)?"+`(${t.join("|")})`,returnBegin:!0,contains:[_]}
;return r.push(e.C_LINE_COMMENT_MODE,e.C_BLOCK_COMMENT_MODE,m,p,h,b,_,u,n.FUNCTION_DISPATCH),
{name:"Less",case_insensitive:!0,illegal:"[=>'/<($\"]",contains:r}},
grmr_lua:e=>{const n="\\[=*\\[",t="\\]=*\\]",a={begin:n,end:t,contains:["self"]
},i=[e.COMMENT("--(?!"+n+")","$"),e.COMMENT("--"+n,t,{contains:[a],relevance:10
})];return{name:"Lua",aliases:["pluto"],keywords:{
$pattern:e.UNDERSCORE_IDENT_RE,literal:"true false nil",
keyword:"and break do else elseif end for goto if in local global not or repeat return then until while",
built_in:"_G _ENV _VERSION __index __newindex __mode __call __metatable __tostring __len __gc __add __sub __mul __div __mod __pow __concat __unm __eq __lt __le assert collectgarbage dofile error getfenv getmetatable ipairs load loadfile loadstring module next pairs pcall print rawequal rawget rawset require select setfenv setmetatable tonumber tostring type unpack xpcall arg self coroutine resume yield status wrap create running debug getupvalue debug sethook getmetatable gethook setmetatable setlocal traceback setfenv getinfo setupvalue getlocal getregistry getfenv io lines write close flush open output type read stderr stdin input stdout popen tmpfile math log max acos huge ldexp pi cos tanh pow deg tan cosh sinh random randomseed frexp ceil floor rad abs sqrt modf asin min mod fmod log10 atan2 exp sin atan os exit setlocale date getenv difftime remove time clock tmpname rename execute package preload loadlib loaded loaders cpath config path seeall string sub upper len gfind rep find match char dump gmatch reverse byte format gsub lower table setn insert getn foreachi maxn foreach concat sort remove"
},contains:i.concat([{className:"function",beginKeywords:"function",end:"\\)",
contains:[e.inherit(e.TITLE_MODE,{
begin:"([_a-zA-Z]\\w*\\.)*([_a-zA-Z]\\w*:)?[_a-zA-Z]\\w*"}),{className:"params",
begin:"\\(",endsWithParent:!0,contains:i}].concat(i)
},e.C_NUMBER_MODE,e.APOS_STRING_MODE,e.QUOTE_STRING_MODE,{className:"string",
begin:n,end:t,contains:[a],relevance:5}])}},grmr_makefile:e=>{const n={
className:"variable",variants:[{begin:"\\$\\("+e.UNDERSCORE_IDENT_RE+"\\)",
contains:[e.BACKSLASH_ESCAPE]},{begin:/\$[@%<?\^\+\*]/}]},t={className:"string",
begin:/"/,end:/"/,contains:[e.BACKSLASH_ESCAPE,n]},a={className:"variable",
begin:/\$\([\w-]+\s/,end:/\)/,keywords:{
built_in:"subst patsubst strip findstring filter filter-out sort word wordlist firstword lastword dir notdir suffix basename addsuffix addprefix join wildcard realpath abspath error warning shell origin flavor foreach if or and call eval file value"
},contains:[n,t]},i={begin:"^"+e.UNDERSCORE_IDENT_RE+"\\s*(?=[:+?]?=)"},r={
className:"section",begin:/^[^\s]+:/,end:/$/,contains:[n]};return{
name:"Makefile",aliases:["mk","mak","make"],keywords:{$pattern:/[\w-]+/,
keyword:"define endef undefine ifdef ifndef ifeq ifneq else endif include -include sinclude override export unexport private vpath"
},contains:[e.HASH_COMMENT_MODE,n,t,a,i,{className:"meta",begin:/^\.PHONY:/,
end:/$/,keywords:{$pattern:/[\.\w]+/,keyword:".PHONY"}},r]}},grmr_markdown:e=>{
const n={begin:/<\/?[A-Za-z_]/,end:">",subLanguage:"xml",relevance:0},t={
variants:[{begin:/\[.+?\]\[.*?\]/,relevance:0},{
begin:/\[.+?\]\(((data|javascript|mailto):|(?:http|ftp)s?:\/\/).*?\)/,
relevance:2},{
begin:e.regex.concat(/\[.+?\]\(/,/[A-Za-z][A-Za-z0-9+.-]*/,/:\/\/.*?\)/),
relevance:2},{begin:/\[.+?\]\([./?&#].*?\)/,relevance:1},{
begin:/\[.*?\]\(.*?\)/,relevance:0}],returnBegin:!0,contains:[{match:/\[(?=\])/
},{className:"string",relevance:0,begin:"\\[",end:"\\]",excludeBegin:!0,
returnEnd:!0},{className:"link",relevance:0,begin:"\\]\\(",end:"\\)",
excludeBegin:!0,excludeEnd:!0},{className:"symbol",relevance:0,begin:"\\]\\[",
end:"\\]",excludeBegin:!0,excludeEnd:!0}]},a={className:"strong",contains:[],
variants:[{begin:/_{2}(?!\s)/,end:/_{2}/},{begin:/\*{2}(?!\s)/,end:/\*{2}/}]
},i={className:"emphasis",contains:[],variants:[{begin:/\*(?![*\s])/,end:/\*/},{
begin:/_(?![_\s])/,end:/_/,relevance:0}]},r=e.inherit(a,{contains:[]
}),s=e.inherit(i,{contains:[]});a.contains.push(s),i.contains.push(r)
;let o=[n,t];return[a,i,r,s].forEach(e=>{e.contains=e.contains.concat(o)
}),o=o.concat(a,i),{name:"Markdown",aliases:["md","mkdown","mkd"],contains:[{
className:"section",variants:[{begin:"^#{1,6}",end:"$",contains:o},{
begin:"(?=^.+?\\n[=-]{2,}$)",contains:[{begin:"^[=-]*$"},{begin:"^",end:"\\n",
contains:o}]}]},n,{className:"bullet",begin:"^[ \t]*([*+-]|(\\d+\\.))(?=\\s+)",
end:"\\s+",excludeEnd:!0},{match:/^ {0,3}([-*_])[ \t]*(?:\1[ \t]*){2,}$/},a,i,{
className:"quote",begin:"^>\\s+",contains:o,end:"$"},{className:"code",
variants:[{begin:"(`{3,})[^`](.|\\n)*?\\1`*[ ]*"},{
begin:"(~{3,})[^~](.|\\n)*?\\1~*[ ]*"},{begin:"```",end:"```+[ ]*$"},{
begin:"~~~",end:"~~~+[ ]*$"},{begin:"`.+?`"},{begin:"(?=^( {4}|\\t))",
contains:[{begin:"^( {4}|\\t)",end:"(\\n)$"}],relevance:0}]},t,{
begin:/^\[[^\n]+\]:/,returnBegin:!0,contains:[{className:"symbol",begin:/\[/,
end:/\]/,excludeBegin:!0,excludeEnd:!0},{className:"link",begin:/:\s*/,end:/$/,
excludeBegin:!0}]},{scope:"literal",
match:/&([a-zA-Z0-9]+|#[0-9]{1,7}|#[Xx][0-9a-fA-F]{1,6});/}]}},
grmr_objectivec:e=>{const n=/[a-zA-Z@][a-zA-Z0-9_]*/,t={$pattern:n,
keyword:["@interface","@class","@protocol","@implementation"]};return{
name:"Objective-C",aliases:["mm","objc","obj-c","obj-c++","objective-c++"],
keywords:{"variable.language":["this","super"],$pattern:n,
keyword:["while","export","sizeof","typedef","const","struct","for","union","volatile","static","mutable","if","do","return","goto","enum","else","break","extern","asm","case","default","register","explicit","typename","switch","continue","inline","readonly","assign","readwrite","self","@synchronized","id","typeof","nonatomic","IBOutlet","IBAction","strong","weak","copy","in","out","inout","bycopy","byref","oneway","__strong","__weak","__block","__autoreleasing","@private","@protected","@public","@try","@property","@end","@throw","@catch","@finally","@autoreleasepool","@synthesize","@dynamic","@selector","@optional","@required","@encode","@package","@import","@defs","@compatibility_alias","__bridge","__bridge_transfer","__bridge_retained","__bridge_retain","__covariant","__contravariant","__kindof","_Nonnull","_Nullable","_Null_unspecified","__FUNCTION__","__PRETTY_FUNCTION__","__attribute__","getter","setter","retain","unsafe_unretained","nonnull","nullable","null_unspecified","null_resettable","class","instancetype","NS_DESIGNATED_INITIALIZER","NS_UNAVAILABLE","NS_REQUIRES_SUPER","NS_RETURNS_INNER_POINTER","NS_INLINE","NS_AVAILABLE","NS_DEPRECATED","NS_ENUM","NS_OPTIONS","NS_SWIFT_UNAVAILABLE","NS_ASSUME_NONNULL_BEGIN","NS_ASSUME_NONNULL_END","NS_REFINED_FOR_SWIFT","NS_SWIFT_NAME","NS_SWIFT_NOTHROW","NS_DURING","NS_HANDLER","NS_ENDHANDLER","NS_VALUERETURN","NS_VOIDRETURN"],
literal:["false","true","FALSE","TRUE","nil","YES","NO","NULL"],
built_in:["dispatch_once_t","dispatch_queue_t","dispatch_sync","dispatch_async","dispatch_once"],
type:["int","float","char","unsigned","signed","short","long","double","wchar_t","unichar","void","bool","BOOL","id|0","_Bool"]
},illegal:"</",contains:[{className:"built_in",
begin:"\\b(AV|CA|CF|CG|CI|CL|CM|CN|CT|MK|MP|MTK|MTL|NS|SCN|SK|UI|WK|XC)\\w+"
},e.C_LINE_COMMENT_MODE,e.C_BLOCK_COMMENT_MODE,e.C_NUMBER_MODE,e.QUOTE_STRING_MODE,e.APOS_STRING_MODE,{
className:"string",variants:[{begin:'@"',end:'"',illegal:"\\n",
contains:[e.BACKSLASH_ESCAPE]}]},{className:"meta",begin:/#\s*[a-z]+\b/,end:/$/,
keywords:{
keyword:"if else elif endif define undef warning error line pragma ifdef ifndef include"
},contains:[{begin:/\\\n/,relevance:0},e.inherit(e.QUOTE_STRING_MODE,{
className:"string"}),{className:"string",begin:/<.*?>/,end:/$/,illegal:"\\n"
},e.C_LINE_COMMENT_MODE,e.C_BLOCK_COMMENT_MODE]},{className:"class",
begin:"("+t.keyword.join("|")+")\\b",end:/(\{|$)/,excludeEnd:!0,keywords:t,
contains:[e.UNDERSCORE_TITLE_MODE]},{begin:"\\."+e.UNDERSCORE_IDENT_RE,
relevance:0}]}},grmr_perl:e=>{const n=e.regex,t=/[dualxmsipngr]{0,12}/,a={
$pattern:/[\w.]+/,
keyword:"abs accept alarm and atan2 bind binmode bless break caller chdir chmod chomp chop chown chr chroot class close closedir connect continue cos crypt dbmclose dbmopen defined delete die do dump each else elsif endgrent endhostent endnetent endprotoent endpwent endservent eof eval exec exists exit exp fcntl field fileno flock for foreach fork format formline getc getgrent getgrgid getgrnam gethostbyaddr gethostbyname gethostent getlogin getnetbyaddr getnetbyname getnetent getpeername getpgrp getpriority getprotobyname getprotobynumber getprotoent getpwent getpwnam getpwuid getservbyname getservbyport getservent getsockname getsockopt given glob gmtime goto grep gt hex if index int ioctl join keys kill last lc lcfirst length link listen local localtime log lstat lt ma map method mkdir msgctl msgget msgrcv msgsnd my ne next no not oct open opendir or ord our pack package pipe pop pos print printf prototype push q|0 qq quotemeta qw qx rand read readdir readline readlink readpipe recv redo ref rename require reset return reverse rewinddir rindex rmdir say scalar seek seekdir select semctl semget semop send setgrent sethostent setnetent setpgrp setpriority setprotoent setpwent setservent setsockopt shift shmctl shmget shmread shmwrite shutdown sin sleep socket socketpair sort splice split sprintf sqrt srand stat state study sub substr symlink syscall sysopen sysread sysseek system syswrite tell telldir tie tied time times tr truncate uc ucfirst umask undef unless unlink unpack unshift untie until use utime values vec wait waitpid wantarray warn when while write x|0 xor y|0"
},i={className:"subst",begin:"[$@]\\{",end:"\\}",keywords:a},r={begin:/->\{/,
end:/\}/},s={scope:"attr",match:/\s+:\s*\w+(\s*\(.*?\))?/},o={scope:"variable",
variants:[{begin:/\$\d/},{
begin:n.concat(/[$%@](?!")(\^\w\b|#\w+(::\w+)*|\{\w+\}|\w+(::\w*)*)/,"(?![A-Za-z])(?![@$%])")
},{begin:/[$%@](?!")[^\s\w{=]|\$=/,relevance:0}],contains:[s]},c={
className:"number",variants:[{match:/0?\.[0-9][0-9_]+\b/},{
match:/\bv?(0|[1-9][0-9_]*(\.[0-9_]+)?|[1-9][0-9_]*)\b/},{
match:/\b0[0-7][0-7_]*\b/},{match:/\b0x[0-9a-fA-F][0-9a-fA-F_]*\b/},{
match:/\b0b[0-1][0-1_]*\b/}],relevance:0
},l=[e.BACKSLASH_ESCAPE,i,o],d=[/!/,/\//,/\|/,/\?/,/'/,/"/,/#/],g=(e,a,i="\\1")=>{
const r="\\1"===i?i:n.concat(i,a)
;return n.concat(n.concat("(?:",e,")"),a,/(?:\\.|[^\\\/])*?/,r,/(?:\\.|[^\\\/])*?/,i,t)
},u=(e,a,i)=>n.concat(n.concat("(?:",e,")"),a,/(?:\\.|[^\\\/])*?/,i,t),b=[o,e.HASH_COMMENT_MODE,e.COMMENT(/^=\w/,/=cut/,{
endsWithParent:!0}),r,{className:"string",contains:l,variants:[{
begin:"q[qwxr]?\\s*\\(",end:"\\)",relevance:5},{begin:"q[qwxr]?\\s*\\[",
end:"\\]",relevance:5},{begin:"q[qwxr]?\\s*\\{",end:"\\}",relevance:5},{
begin:"q[qwxr]?\\s*\\|",end:"\\|",relevance:5},{begin:"q[qwxr]?\\s*<",end:">",
relevance:5},{begin:"qw\\s+q",end:"q",relevance:5},{begin:"'",end:"'",
contains:[e.BACKSLASH_ESCAPE]},{begin:'"',end:'"'},{begin:"`",end:"`",
contains:[e.BACKSLASH_ESCAPE]},{begin:/\{\w+\}/,relevance:0},{
begin:"-?\\w+\\s*=>",relevance:0}]},c,{
begin:"(\\/\\/|"+e.RE_STARTERS_RE+"|\\b(split|return|print|reverse|grep)\\b)\\s*",
keywords:"split return print reverse grep",relevance:0,
contains:[e.HASH_COMMENT_MODE,{className:"regexp",variants:[{
begin:g("s|tr|y",n.either(...d,{capture:!0}))},{begin:g("s|tr|y","\\(","\\)")},{
begin:g("s|tr|y","\\[","\\]")},{begin:g("s|tr|y","\\{","\\}")}],relevance:2},{
className:"regexp",variants:[{begin:/(m|qr)\/\//,relevance:0},{
begin:u("(?:m|qr)?",/\//,/\//)},{begin:u("m|qr",n.either(...d,{capture:!0
}),/\1/)},{begin:u("m|qr",/\(/,/\)/)},{begin:u("m|qr",/\[/,/\]/)},{
begin:u("m|qr",/\{/,/\}/)}]}]},{className:"function",beginKeywords:"sub method",
end:"(\\s*\\(.*?\\))?[;{]",excludeEnd:!0,relevance:5,contains:[e.TITLE_MODE,s]
},{className:"class",beginKeywords:"class",end:"[;{]",excludeEnd:!0,relevance:5,
contains:[e.TITLE_MODE,s,c]},{begin:"-\\w\\b",relevance:0},{begin:"^__DATA__$",
end:"^__END__$",subLanguage:"mojolicious",contains:[{begin:"^@@.*",end:"$",
className:"comment"}]}];return i.contains=b,r.contains=b,{name:"Perl",
aliases:["pl","pm"],keywords:a,contains:b}},grmr_php:e=>{
const n=e.regex,t=/(?![A-Za-z0-9])(?![$])/,a=n.concat(/[a-zA-Z_\x7f-\xff][a-zA-Z0-9_\x7f-\xff]*/,t),i=n.concat(/(\\?[A-Z][a-z0-9_\x7f-\xff]+|\\?[A-Z]+(?=[A-Z][a-z0-9_\x7f-\xff])){1,}/,t),r=n.concat(/[A-Z]+/,t),s={
scope:"variable",match:"\\$+"+a},o={scope:"subst",variants:[{begin:/\$\w+/},{
begin:/\{\$/,end:/\}/}]},c=e.inherit(e.APOS_STRING_MODE,{illegal:null
}),l="[ \t\n]",d={scope:"string",variants:[e.inherit(e.QUOTE_STRING_MODE,{
illegal:null,contains:e.QUOTE_STRING_MODE.contains.concat(o)}),c,{
begin:/<<<[ \t]*(?:(\w+)|"(\w+)")\n/,end:/[ \t]*(\w+)\b/,
contains:e.QUOTE_STRING_MODE.contains.concat(o),"on:begin":(e,n)=>{
n.data._beginMatch=e[1]||e[2]},"on:end":(e,n)=>{
n.data._beginMatch!==e[1]&&n.ignoreMatch()}},e.END_SAME_AS_BEGIN({
begin:/<<<[ \t]*'(\w+)'\n/,end:/[ \t]*(\w+)\b/})]},g={scope:"number",variants:[{
begin:"\\b0[bB][01]+(?:_[01]+)*\\b"},{begin:"\\b0[oO][0-7]+(?:_[0-7]+)*\\b"},{
begin:"\\b0[xX][\\da-fA-F]+(?:_[\\da-fA-F]+)*\\b"},{
begin:"(?:\\b\\d+(?:_\\d+)*(\\.(?:\\d+(?:_\\d+)*))?|\\B\\.\\d+)(?:[eE][+-]?\\d+)?"
}],relevance:0
},u=["false","null","true"],b=["__CLASS__","__DIR__","__FILE__","__FUNCTION__","__COMPILER_HALT_OFFSET__","__LINE__","__METHOD__","__NAMESPACE__","__TRAIT__","die","echo","exit","include","include_once","print","require","require_once","array","abstract","and","as","binary","bool","boolean","break","callable","case","catch","class","clone","const","continue","declare","default","do","double","else","elseif","empty","enddeclare","endfor","endforeach","endif","endswitch","endwhile","enum","eval","extends","final","finally","float","for","foreach","from","global","goto","if","implements","instanceof","insteadof","int","integer","interface","isset","iterable","list","match|0","mixed","new","never","object","or","private","protected","public","readonly","real","return","string","switch","throw","trait","try","unset","use","var","void","while","xor","yield"],m=["Error|0","AppendIterator","ArgumentCountError","ArithmeticError","ArrayIterator","ArrayObject","AssertionError","BadFunctionCallException","BadMethodCallException","CachingIterator","CallbackFilterIterator","CompileError","Countable","DirectoryIterator","DivisionByZeroError","DomainException","EmptyIterator","ErrorException","Exception","FilesystemIterator","FilterIterator","GlobIterator","InfiniteIterator","InvalidArgumentException","IteratorIterator","LengthException","LimitIterator","LogicException","MultipleIterator","NoRewindIterator","OutOfBoundsException","OutOfRangeException","OuterIterator","OverflowException","ParentIterator","ParseError","RangeException","RecursiveArrayIterator","RecursiveCachingIterator","RecursiveCallbackFilterIterator","RecursiveDirectoryIterator","RecursiveFilterIterator","RecursiveIterator","RecursiveIteratorIterator","RecursiveRegexIterator","RecursiveTreeIterator","RegexIterator","RuntimeException","SeekableIterator","SplDoublyLinkedList","SplFileInfo","SplFileObject","SplFixedArray","SplHeap","SplMaxHeap","SplMinHeap","SplObjectStorage","SplObserver","SplPriorityQueue","SplQueue","SplStack","SplSubject","SplTempFileObject","TypeError","UnderflowException","UnexpectedValueException","UnhandledMatchError","ArrayAccess","BackedEnum","Closure","Fiber","Generator","Iterator","IteratorAggregate","Serializable","Stringable","Throwable","Traversable","UnitEnum","WeakReference","WeakMap","Directory","__PHP_Incomplete_Class","parent","php_user_filter","self","static","stdClass"],p={
keyword:b,literal:(e=>{const n=[];return e.forEach(e=>{
n.push(e),e.toLowerCase()===e?n.push(e.toUpperCase()):n.push(e.toLowerCase())}),
n})(u),built_in:m},_=e=>e.map(e=>e.replace(/\|\d+$/,"")),h={variants:[{
match:[/new/,n.concat(l,"+"),n.concat("(?!",_(m).join("\\b|"),"\\b)"),i],scope:{
1:"keyword",4:"title.class"}}]},f=n.concat(a,"\\b(?!\\()"),E={variants:[{
match:[n.concat(/::/,n.lookahead(/(?!class\b)/)),f],scope:{2:"variable.constant"
}},{match:[/::/,/class/],scope:{2:"variable.language"}},{
match:[i,n.concat(/::/,n.lookahead(/(?!class\b)/)),f],scope:{1:"title.class",
3:"variable.constant"}},{match:[i,n.concat("::",n.lookahead(/(?!class\b)/))],
scope:{1:"title.class"}},{match:[i,/::/,/class/],scope:{1:"title.class",
3:"variable.language"}}]},y={scope:"attr",
match:n.concat(a,n.lookahead(":"),n.lookahead(/(?!::)/))},w={relevance:0,
begin:/\(/,end:/\)/,keywords:p,
contains:[y,s,E,e.C_BLOCK_COMMENT_MODE,e.C_LINE_COMMENT_MODE,e.HASH_COMMENT_MODE,d,g,h]
},v={relevance:0,
match:[/\b/,n.concat("(?!fn\\b|function\\b|",_(b).join("\\b|"),"|",_(m).join("\\b|"),"\\b)"),a,n.concat(l,"*"),n.lookahead(/(?=\()/)],
scope:{3:"title.function.invoke"},contains:[w]};w.contains.push(v)
;const N=[y,E,e.C_BLOCK_COMMENT_MODE,e.C_LINE_COMMENT_MODE,e.HASH_COMMENT_MODE,d,g,h],k={
begin:n.concat(/#\[\s*\\?/,n.either(i,r)),beginScope:"meta",end:/]/,
endScope:"meta",keywords:{literal:u,keyword:["new","array"]},contains:[{
begin:/\[/,end:/]/,keywords:{literal:u,keyword:["new","array"]},
contains:["self",...N]},...N,{scope:"meta",variants:[{match:i},{match:r}]}]}
;return{case_insensitive:!1,keywords:p,
contains:[k,e.HASH_COMMENT_MODE,e.COMMENT("//","$"),e.COMMENT("/\\*","\\*/",{
contains:[{scope:"doctag",match:"@[A-Za-z]+"}]}),{match:/__halt_compiler\(\);/,
keywords:"__halt_compiler",starts:{scope:"comment",end:e.MATCH_NOTHING_RE,
contains:[{match:/\?>/,scope:"meta",endsParent:!0}]}},{scope:"meta",variants:[{
begin:/<\?php/,relevance:10},{begin:/<\?=/},{begin:/<\?/,relevance:.1},{
begin:/\?>/}]},{scope:"variable.language",match:/\$this\b/},s,v,E,{
match:[/const/,/\s/,a],scope:{1:"keyword",3:"variable.constant"}},h,{
scope:"function",relevance:0,beginKeywords:"fn function",end:/[;{]/,
excludeEnd:!0,illegal:"[$%\\[]",contains:[{beginKeywords:"use"
},e.UNDERSCORE_TITLE_MODE,{begin:"=>",endsParent:!0},{scope:"params",
begin:"\\(",end:"\\)",excludeBegin:!0,excludeEnd:!0,keywords:p,
contains:["self",k,s,E,e.C_BLOCK_COMMENT_MODE,e.C_LINE_COMMENT_MODE,e.HASH_COMMENT_MODE,d,g]
}]},{scope:"class",variants:[{beginKeywords:"enum",illegal:/[($"]/},{
beginKeywords:"class interface trait",illegal:/[:($"]/}],relevance:0,end:/\{/,
excludeEnd:!0,contains:[{beginKeywords:"extends implements"
},e.UNDERSCORE_TITLE_MODE]},{beginKeywords:"namespace",relevance:0,end:";",
illegal:/[.']/,contains:[e.inherit(e.UNDERSCORE_TITLE_MODE,{scope:"title.class"
})]},{beginKeywords:"use",relevance:0,end:";",contains:[{
match:/\b(as|const|function)\b/,scope:"keyword"},e.UNDERSCORE_TITLE_MODE]},d,g]}
},grmr_php_template:e=>({name:"PHP template",subLanguage:"xml",contains:[{
begin:/<\?(php|=)?/,end:/\?>/,subLanguage:"php",contains:[{begin:"/\\*",
end:"\\*/",skip:!0},{begin:'b"',end:'"',skip:!0},{begin:"b'",end:"'",skip:!0
},e.inherit(e.APOS_STRING_MODE,{illegal:null,className:null,contains:null,
skip:!0}),e.inherit(e.QUOTE_STRING_MODE,{illegal:null,className:null,
contains:null,skip:!0})]}]}),grmr_plaintext:e=>({name:"Plain text",
aliases:["text","txt"],disableAutodetect:!0}),grmr_python:e=>{
const n=e.regex,t=/[\p{XID_Start}_]\p{XID_Continue}*/u,a=["and","as","assert","async","await","break","case","class","continue","def","del","elif","else","except","finally","for","from","global","if","import","in","is","lambda","lazy","match","nonlocal|10","not","or","pass","raise","return","try","while","with","yield"],i={
$pattern:/[A-Za-z]\w+|__\w+__/,keyword:a,
built_in:["__import__","abs","aiter","all","anext","any","ascii","bin","bool","breakpoint","bytearray","bytes","callable","chr","classmethod","compile","complex","delattr","dict","dir","divmod","enumerate","eval","exec","filter","float","format","frozendict","frozenset","getattr","globals","hasattr","hash","help","hex","id","input","int","isinstance","issubclass","iter","len","list","locals","map","max","memoryview","min","next","object","oct","open","ord","pow","print","property","range","repr","reversed","round","sentinel","set","setattr","slice","sorted","staticmethod","str","sum","super","tuple","type","vars","zip"],
literal:["__debug__","Ellipsis","False","None","NotImplemented","True"],
type:["Any","Callable","Coroutine","Dict","List","Literal","Generic","Optional","Sequence","Set","Tuple","Type","Union"]
},r={className:"meta",begin:/^(>>>|\.\.\.) /},s={className:"subst",begin:/\{/,
end:/\}/,keywords:i,illegal:/#/},o={begin:/\{\{/,relevance:0},c={
className:"string",contains:[e.BACKSLASH_ESCAPE],variants:[{
begin:/([uU]|[bB]|[rR]|[bB][rR]|[rR][bB])?'''/,end:/'''/,
contains:[e.BACKSLASH_ESCAPE,r],relevance:10},{
begin:/([uU]|[bB]|[rR]|[bB][rR]|[rR][bB])?"""/,end:/"""/,
contains:[e.BACKSLASH_ESCAPE,r],relevance:10},{
begin:/([fFtT][rR]|[rR][fFtT]|[fFtT])'''/,end:/'''/,
contains:[e.BACKSLASH_ESCAPE,r,o,s]},{begin:/([fFtT][rR]|[rR][fFtT]|[fFtT])"""/,
end:/"""/,contains:[e.BACKSLASH_ESCAPE,r,o,s]},{begin:/([uU]|[rR])'/,end:/'/,
relevance:10},{begin:/([uU]|[rR])"/,end:/"/,relevance:10},{
begin:/([bB]|[bB][rR]|[rR][bB])'/,end:/'/},{begin:/([bB]|[bB][rR]|[rR][bB])"/,
end:/"/},{begin:/([fFtT][rR]|[rR][fFtT]|[fFtT])'/,end:/'/,
contains:[e.BACKSLASH_ESCAPE,o,s]},{begin:/([fFtT][rR]|[rR][fFtT]|[fFtT])"/,
end:/"/,contains:[e.BACKSLASH_ESCAPE,o,s]
},e.APOS_STRING_MODE,e.QUOTE_STRING_MODE]
},l="[0-9](_?[0-9])*",d=`(\\b(${l}))?\\.(${l})|\\b(${l})\\.`,g="\\b|"+a.join("|"),u={
className:"number",relevance:0,variants:[{
begin:`(\\b(${l})|(${d}))[eE][+-]?(${l})[jJ]?(?=${g})`},{begin:`(${d})[jJ]?`},{
begin:`\\b([1-9](_?[0-9])*|0+(_?0)*)[lLjJ]?(?=${g})`},{
begin:`\\b0[bB](_?[01])+[lL]?(?=${g})`},{begin:`\\b0[oO](_?[0-7])+[lL]?(?=${g})`
},{begin:`\\b0[xX](_?[0-9a-fA-F])+[lL]?(?=${g})`},{begin:`\\b(${l})[jJ](?=${g})`
}]},b={className:"comment",begin:n.lookahead(/# type:/),end:/$/,keywords:i,
contains:[{begin:/# type:/},{begin:/#/,end:/\b\B/,endsWithParent:!0}]},m={
className:"params",variants:[{className:"",begin:/\(\s*\)/,skip:!0},{begin:/\(/,
end:/\)/,excludeBegin:!0,excludeEnd:!0,keywords:i,
contains:["self",r,u,c,e.HASH_COMMENT_MODE]}]};return s.contains=[c,u,r],{
name:"Python",aliases:["py","gyp","ipython"],unicodeRegex:!0,keywords:i,
illegal:/(<\/|\?)|=>/,contains:[r,u,{scope:"variable.language",match:/\bself\b/
},{beginKeywords:"if",relevance:0},{match:/\bor\b/,scope:"keyword"
},c,b,e.HASH_COMMENT_MODE,{match:[/\bdef/,/\s+/,t],scope:{1:"keyword",
3:"title.function"},contains:[m]},{variants:[{
match:[/\bclass/,/\s+/,t,/\s*/,/\(\s*/,t,/\s*\)/]},{match:[/\bclass/,/\s+/,t]}],
scope:{1:"keyword",3:"title.class",6:"title.class.inherited"}},{
className:"meta",begin:/^[\t ]*@/,end:/(?=#)|$/,contains:[u,m,c]}]}},
grmr_python_repl:e=>({aliases:["pycon"],contains:[{className:"meta.prompt",
starts:{end:/ |$/,starts:{end:"$",subLanguage:"python"}},variants:[{
begin:/^>>>(?=[ ]|$)/},{begin:/^\.\.\.(?=[ ]|$)/}]}]}),grmr_r:e=>{
const n=e.regex,t=/(?:(?:[a-zA-Z]|\.[._a-zA-Z])[._a-zA-Z0-9]*)|\.(?!\d)/,a=n.either(/0[xX][0-9a-fA-F]+\.[0-9a-fA-F]*[pP][+-]?\d+i?/,/0[xX][0-9a-fA-F]+(?:[pP][+-]?\d+)?[Li]?/,/(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?[Li]?/),i=/[=!<>:]=|\|\||&&|:::?|<-|<<-|->>|->|\|>|[-+*\/?!$&|:<=>@^~]|\*\*/,r=n.either(/[()]/,/[{}]/,/\[\[/,/[[\]]/,/\\/,/,/)
;return{name:"R",keywords:{$pattern:t,
keyword:"function if in break next repeat else for while",
literal:"NULL NA TRUE FALSE Inf NaN NA_integer_|10 NA_real_|10 NA_character_|10 NA_complex_|10",
built_in:"LETTERS letters month.abb month.name pi T F abs acos acosh all any anyNA Arg as.call as.character as.complex as.double as.environment as.integer as.logical as.null.default as.numeric as.raw asin asinh atan atanh attr attributes baseenv browser c call ceiling class Conj cos cosh cospi cummax cummin cumprod cumsum digamma dim dimnames emptyenv exp expression floor forceAndCall gamma gc.time globalenv Im interactive invisible is.array is.atomic is.call is.character is.complex is.double is.environment is.expression is.finite is.function is.infinite is.integer is.language is.list is.logical is.matrix is.na is.name is.nan is.null is.numeric is.object is.pairlist is.raw is.recursive is.single is.symbol lazyLoadDBfetch length lgamma list log max min missing Mod names nargs nzchar oldClass on.exit pos.to.env proc.time prod quote range Re rep retracemem return round seq_along seq_len seq.int sign signif sin sinh sinpi sqrt standardGeneric substitute sum switch tan tanh tanpi tracemem trigamma trunc unclass untracemem UseMethod xtfrm"
},contains:[e.COMMENT(/#'/,/$/,{contains:[{scope:"doctag",match:/@examples/,
starts:{end:n.lookahead(n.either(/\n^#'\s*(?=@[a-zA-Z]+)/,/\n^(?!#')/)),
endsParent:!0}},{scope:"doctag",begin:"@param",end:/$/,contains:[{
scope:"variable",variants:[{match:t},{match:/`(?:\\.|[^`\\])+`/}],endsParent:!0
}]},{scope:"doctag",match:/@[a-zA-Z]+/},{scope:"keyword",match:/\\[a-zA-Z]+/}]
}),e.HASH_COMMENT_MODE,{scope:"string",contains:[e.BACKSLASH_ESCAPE],
variants:[e.END_SAME_AS_BEGIN({begin:/[rR]"(-*)\(/,end:/\)(-*)"/
}),e.END_SAME_AS_BEGIN({begin:/[rR]"(-*)\{/,end:/\}(-*)"/
}),e.END_SAME_AS_BEGIN({begin:/[rR]"(-*)\[/,end:/\](-*)"/
}),e.END_SAME_AS_BEGIN({begin:/[rR]'(-*)\(/,end:/\)(-*)'/
}),e.END_SAME_AS_BEGIN({begin:/[rR]'(-*)\{/,end:/\}(-*)'/
}),e.END_SAME_AS_BEGIN({begin:/[rR]'(-*)\[/,end:/\](-*)'/}),{begin:'"',end:'"',
relevance:0},{begin:"'",end:"'",relevance:0}]},{relevance:0,variants:[{scope:{
1:"operator",2:"number"},match:[i,a]},{scope:{1:"operator",2:"number"},
match:[/%[^%]*%/,a]},{scope:{1:"punctuation",2:"number"},match:[r,a]},{scope:{
2:"number"},match:[/[^a-zA-Z0-9._]|^/,a]}]},{scope:{3:"operator"},
match:[t,/\s+/,/<-/,/\s+/]},{scope:"operator",relevance:0,variants:[{match:i},{
match:/%[^%]*%/}]},{scope:"punctuation",relevance:0,match:r},{begin:"`",end:"`",
contains:[{begin:/\\./}]}]}},grmr_ruby:e=>{
const n=e.regex,t="([a-zA-Z_]\\w*[!?=]?|[-+~]@|<<|>>|=~|===?|<=>|[<>]=?|\\*\\*|[-/+%^&*~`|]|\\[\\]=?)",a=n.either(/\b([A-Z]+[a-z0-9]+)+/,/\b([A-Z]+[a-z0-9]+)+[A-Z]+/),i=n.concat(a,/(::\w+)*/),r={
"variable.constant":["__FILE__","__LINE__","__ENCODING__"],
"variable.language":["self","super"],
keyword:["alias","and","begin","BEGIN","break","case","class","defined","do","else","elsif","end","END","ensure","for","if","in","module","next","not","or","redo","require","rescue","retry","return","then","undef","unless","until","when","while","yield","include","extend","prepend","public","private","protected","raise","throw"],
built_in:["proc","lambda","attr_accessor","attr_reader","attr_writer","define_method","private_constant","module_function"],
literal:["true","false","nil"]},s={className:"doctag",begin:"@[A-Za-z]+"},o={
begin:"#<",end:">"},c=[e.COMMENT("#","$",{contains:[s]
}),e.COMMENT("^=begin","^=end",{contains:[s],relevance:10
}),e.COMMENT("^__END__",e.MATCH_NOTHING_RE)],l={className:"subst",begin:/#\{/,
end:/\}/,keywords:r},d={className:"string",contains:[e.BACKSLASH_ESCAPE,l],
variants:[{begin:/'/,end:/'/},{begin:/"/,end:/"/},{begin:/`/,end:/`/},{
begin:/%[qQwWx]?\(/,end:/\)/},{begin:/%[qQwWx]?\[/,end:/\]/},{
begin:/%[qQwWx]?\{/,end:/\}/},{begin:/%[qQwWx]?</,end:/>/},{begin:/%[qQwWx]?\//,
end:/\//},{begin:/%[qQwWx]?%/,end:/%/},{begin:/%[qQwWx]?-/,end:/-/},{
begin:/%[qQwWx]?\|/,end:/\|/},{begin:/\B\?(\\\d{1,3})/},{
begin:/\B\?(\\x[A-Fa-f0-9]{1,2})/},{begin:/\B\?(\\u\{?[A-Fa-f0-9]{1,6}\}?)/},{
begin:/\B\?(\\M-\\C-|\\M-\\c|\\c\\M-|\\M-|\\C-\\M-)[\x20-\x7e]/},{
begin:/\B\?\\(c|C-)[\x20-\x7e]/},{begin:/\B\?\\?\S/},{
begin:n.concat(/<<[-~]?'?/,n.lookahead(/(\w+)(?=\W)[^\n]*\n(?:[^\n]*\n)*?\s*\1\b/)),
contains:[e.END_SAME_AS_BEGIN({begin:/(\w+)/,end:/(\w+)/,
contains:[e.BACKSLASH_ESCAPE,l]})]}]},g="[0-9](_?[0-9])*",u={className:"number",
relevance:0,variants:[{
begin:`\\b([1-9](_?[0-9])*|0)(\\.(${g}))?([eE][+-]?(${g})|r)?i?\\b`},{
begin:"\\b0[dD][0-9](_?[0-9])*r?i?\\b"},{begin:"\\b0[bB][0-1](_?[0-1])*r?i?\\b"
},{begin:"\\b0[oO][0-7](_?[0-7])*r?i?\\b"},{
begin:"\\b0[xX][0-9a-fA-F](_?[0-9a-fA-F])*r?i?\\b"},{
begin:"\\b0(_?[0-7])+r?i?\\b"}]},b={variants:[{match:/\(\)/},{
className:"params",begin:/\(/,end:/(?=\))/,excludeBegin:!0,endsParent:!0,
keywords:r}]},m=[d,{variants:[{match:[/class\s+/,i,/\s+<\s+/,i]},{
match:[/\b(class|module)\s+/,i]}],scope:{2:"title.class",
4:"title.class.inherited"},keywords:r},{match:[/(include|extend)\s+/,i],scope:{
2:"title.class"},keywords:r},{relevance:0,match:[i,/\.new[. (]/],scope:{
1:"title.class"}},{relevance:0,match:/\b[A-Z][A-Z_0-9]+\b/,
className:"variable.constant"},{relevance:0,match:a,scope:"title.class"},{
match:[/def/,/\s+/,t],scope:{1:"keyword",3:"title.function"},contains:[b]},{
begin:"::"},{className:"symbol",begin:e.UNDERSCORE_IDENT_RE+"(!|\\?)?:",
relevance:0},{className:"symbol",begin:":(?!\\s)",contains:[d,{begin:t}],
relevance:0},u,{className:"variable",
begin:"(\\$\\W)|((\\$|@@?)(\\w+))(?=[^@$?])(?![A-Za-z])(?![@$?'])"},{
className:"params",begin:/\|(?!=)/,end:/\|/,excludeBegin:!0,excludeEnd:!0,
relevance:0,keywords:r},{begin:"("+e.RE_STARTERS_RE+"|unless)\\s*",
keywords:"unless",contains:[{className:"regexp",contains:[e.BACKSLASH_ESCAPE,l],
illegal:/\n/,variants:[{begin:"/",end:"/[a-z]*"},{begin:/%r\{/,end:/\}[a-z]*/},{
begin:"%r\\(",end:"\\)[a-z]*"},{begin:"%r!",end:"![a-z]*"},{begin:"%r\\[",
end:"\\][a-z]*"}]}].concat(o,c),relevance:0}].concat(o,c)
;l.contains=m,b.contains=m;const p=[{begin:/^\s*=>/,starts:{end:"$",contains:m}
},{className:"meta.prompt",
begin:"^([>?]>|[\\w#]+\\(\\w+\\):\\d+:\\d+[>*]|(\\w+-)?\\d+\\.\\d+\\.\\d+(p\\d+)?[^\\d][^>]+>)(?=[ ])",
starts:{end:"$",keywords:r,contains:m}}];return c.unshift(o),{name:"Ruby",
aliases:["rb","gemspec","podspec","thor","irb"],keywords:r,illegal:/\/\*/,
contains:[e.SHEBANG({binary:"ruby"})].concat(p).concat(c).concat(m)}},
grmr_rust:e=>{
const n=e.regex,t=/(r#)?/,a=n.concat(t,e.UNDERSCORE_IDENT_RE),i=n.concat(t,e.IDENT_RE),r={
scope:"title.function.invoke",relevance:0,
begin:n.concat(/\b/,/(?!(?:let|for|while|if|else|match)\b)/,i,n.lookahead(/\s*\(/))
},s="([ui](8|16|32|64|128|size)|f(16|32|64|128))?",o=["drop ","Copy","Send","Sized","Sync","Drop","Fn","FnMut","FnOnce","ToOwned","Clone","Debug","PartialEq","PartialOrd","Eq","Ord","AsRef","AsMut","Into","From","Default","Iterator","Extend","IntoIterator","DoubleEndedIterator","ExactSizeIterator","SliceConcatExt","ToString","assert!","assert_eq!","bitflags!","bytes!","cfg!","col!","concat!","concat_idents!","debug_assert!","debug_assert_eq!","env!","eprintln!","panic!","file!","format!","format_args!","include_bytes!","include_str!","line!","local_data_key!","module_path!","option_env!","print!","println!","select!","stringify!","try!","unimplemented!","unreachable!","vec!","write!","writeln!","macro_rules!","assert_ne!","debug_assert_ne!"],c=["i8","i16","i32","i64","i128","isize","u8","u16","u32","u64","u128","usize","f16","f32","f64","f128","str","char","bool","Box","Option","Result","String","Vec"]
;return{name:"Rust",aliases:["rs"],keywords:{$pattern:e.IDENT_RE+"!?",type:c,
keyword:["abstract","as","async","await","become","box","break","const","continue","crate","do","dyn","else","enum","extern","false","final","fn","for","if","impl","in","let","loop","macro","match","mod","move","mut","override","priv","pub","raw","ref","return","self","Self","static","struct","super","trait","true","try","type","typeof","union","unsafe","unsized","use","virtual","where","while","yield"],
literal:["true","false","Some","None","Ok","Err"],built_in:o},illegal:"</",
contains:[e.C_LINE_COMMENT_MODE,e.COMMENT("/\\*","\\*/",{contains:["self"]
}),e.inherit(e.QUOTE_STRING_MODE,{begin:/b?"/,illegal:null}),{scope:"symbol",
begin:/'[a-zA-Z_][a-zA-Z0-9_]*(?!')/},{scope:"string",variants:[{
begin:/b?r(#*)"(.|\n)*?"\1(?!#)/},{begin:/b?'/,end:/'/,contains:[{
scope:"char.escape",match:/\\('|"|\\|\w|x\w{2}|u\w{4}|U\w{8})/}]}]},{
scope:"number",variants:[{begin:"\\b0b([01_]+)"+s},{begin:"\\b0o([0-7_]+)"+s},{
begin:"\\b0x([A-Fa-f0-9_]+)"+s},{
begin:"\\b(\\d[\\d_]*(\\.[0-9_]+)?([eE][+-]?[0-9_]+)?)"+s}],relevance:0},{
begin:[/\bsafe/,/\s+/,/extern/],scope:{1:"keyword",3:"keyword"}},{
begin:[/fn/,/\s+/,a],scope:{1:"keyword",3:"title.function"}},{scope:"meta",
begin:"#!?\\[",end:"\\]",contains:[{scope:"string",begin:/"/,end:/"/,
contains:[e.BACKSLASH_ESCAPE]}]},{begin:[/let/,/\s+/,/(?:mut\s+)?/,a],scope:{
1:"keyword",3:"keyword",4:"variable"}},{begin:[/for/,/\s+/,a,/\s+/,/in/],scope:{
1:"keyword",3:"variable",5:"keyword"}},{begin:[/type/,/\s+/,a],scope:{
1:"keyword",3:"title.class"}},{
begin:[/(?:trait|enum|struct|union|impl|for)/,/\s+/,a],scope:{1:"keyword",
3:"title.class"}},{begin:e.IDENT_RE+"::",keywords:{keyword:"Self",built_in:o,
type:c}},{scope:"punctuation",begin:"->"},r]}},grmr_scss:e=>{
const n=Ce(e),t=Ie,a=De,i="@[a-z-]+",r={className:"variable",
begin:"(\\$[a-zA-Z-][a-zA-Z0-9_-]*)\\b",relevance:0};return{name:"SCSS",
case_insensitive:!0,illegal:"[=/|']",
contains:[e.C_LINE_COMMENT_MODE,e.C_BLOCK_COMMENT_MODE,n.CSS_NUMBER_MODE,{
className:"selector-id",begin:"#[A-Za-z0-9_-]+",relevance:0},{
className:"selector-class",begin:"\\.[A-Za-z0-9_-]+",relevance:0
},n.ATTRIBUTE_SELECTOR_MODE,{className:"selector-tag",
begin:"\\b("+Te.join("|")+")\\b",relevance:0},{className:"selector-pseudo",
begin:":("+a.join("|")+")"},{className:"selector-pseudo",
begin:":(:)?("+t.join("|")+")"},r,{begin:/\(/,end:/\)/,
contains:[n.CSS_NUMBER_MODE]},n.CSS_VARIABLE,{className:"attribute",
begin:"\\b("+Le.join("|")+")\\b"},{
begin:"\\b(whitespace|wait|w-resize|visible|vertical-text|vertical-ideographic|uppercase|upper-roman|upper-alpha|underline|transparent|top|thin|thick|text|text-top|text-bottom|tb-rl|table-header-group|table-footer-group|sw-resize|super|strict|static|square|solid|small-caps|separate|se-resize|scroll|s-resize|rtl|row-resize|ridge|right|repeat|repeat-y|repeat-x|relative|progress|pointer|overline|outside|outset|oblique|nowrap|not-allowed|normal|none|nw-resize|no-repeat|no-drop|newspaper|ne-resize|n-resize|move|middle|medium|ltr|lr-tb|lowercase|lower-roman|lower-alpha|loose|list-item|line|line-through|line-edge|lighter|left|keep-all|justify|italic|inter-word|inter-ideograph|inside|inset|inline|inline-block|inherit|inactive|ideograph-space|ideograph-parenthesis|ideograph-numeric|ideograph-alpha|horizontal|hidden|help|hand|groove|fixed|ellipsis|e-resize|double|dotted|distribute|distribute-space|distribute-letter|distribute-all-lines|disc|disabled|default|decimal|dashed|crosshair|collapse|col-resize|circle|char|center|capitalize|break-word|break-all|bottom|both|bolder|bold|block|bidi-override|below|baseline|auto|always|all-scroll|absolute|table|table-cell)\\b"
},{begin:/:/,end:/[;}{]/,relevance:0,
contains:[n.BLOCK_COMMENT,r,n.HEXCOLOR,n.CSS_NUMBER_MODE,n.UNICODE_RANGE,e.QUOTE_STRING_MODE,e.APOS_STRING_MODE,n.IMPORTANT,n.FUNCTION_DISPATCH]
},{begin:"@(page|font-face)",keywords:{$pattern:i,keyword:"@page @font-face"}},{
begin:"@",end:"[{;]",returnBegin:!0,keywords:{$pattern:/[a-z-]+/,
keyword:"and or not only",attribute:Re.join(" ")},contains:[{begin:i,
className:"keyword"},{begin:/[a-z-]+(?=:)/,className:"attribute"
},r,e.QUOTE_STRING_MODE,e.APOS_STRING_MODE,n.HEXCOLOR,n.CSS_NUMBER_MODE]
},n.FUNCTION_DISPATCH]}},grmr_shell:e=>({name:"Shell Session",
aliases:["console","shellsession"],contains:[{className:"meta.prompt",
begin:/^\s{0,3}[./~\w\d[\]()@-]*[>%$#][ ]?/,starts:{end:/[^\\](?=\s*$)/,
subLanguage:"bash"}}]}),grmr_sql:e=>{
const n=e.regex,t=e.COMMENT("--","$"),a=["abs","acos","array_agg","asin","atan","avg","cast","ceil","ceiling","coalesce","corr","cos","cosh","count","covar_pop","covar_samp","cume_dist","dense_rank","deref","element","exp","extract","first_value","floor","json_array","json_arrayagg","json_exists","json_object","json_objectagg","json_query","json_table","json_table_primitive","json_value","lag","last_value","lead","listagg","ln","log","log10","lower","max","min","mod","nth_value","ntile","nullif","percent_rank","percentile_cont","percentile_disc","position","position_regex","power","rank","regr_avgx","regr_avgy","regr_count","regr_intercept","regr_r2","regr_slope","regr_sxx","regr_sxy","regr_syy","row_number","sin","sinh","sqrt","stddev_pop","stddev_samp","substring","substring_regex","sum","tan","tanh","translate","translate_regex","treat","trim","trim_array","unnest","upper","value_of","var_pop","var_samp","width_bucket"],i=a,r=["abs","acos","all","allocate","alter","and","any","are","array","array_agg","array_max_cardinality","as","asensitive","asin","asymmetric","at","atan","atomic","authorization","avg","begin","begin_frame","begin_partition","between","bigint","binary","blob","boolean","both","by","call","called","cardinality","cascaded","case","cast","ceil","ceiling","char","char_length","character","character_length","check","classifier","clob","close","coalesce","collate","collect","column","commit","condition","connect","constraint","contains","convert","copy","corr","corresponding","cos","cosh","count","covar_pop","covar_samp","create","cross","cube","cume_dist","current","current_catalog","current_date","current_default_transform_group","current_path","current_role","current_row","current_schema","current_time","current_timestamp","current_path","current_role","current_transform_group_for_type","current_user","cursor","cycle","date","day","deallocate","dec","decimal","decfloat","declare","default","define","delete","dense_rank","deref","describe","deterministic","disconnect","distinct","double","drop","dynamic","each","element","else","empty","end","end_frame","end_partition","end-exec","equals","escape","every","except","exec","execute","exists","exp","external","extract","false","fetch","filter","first_value","float","floor","for","foreign","frame_row","free","from","full","function","fusion","get","global","grant","group","grouping","groups","having","hold","hour","identity","in","indicator","initial","inner","inout","insensitive","insert","int","integer","intersect","intersection","interval","into","is","join","json_array","json_arrayagg","json_exists","json_object","json_objectagg","json_query","json_table","json_table_primitive","json_value","lag","language","large","last_value","lateral","lead","leading","left","like","like_regex","listagg","ln","local","localtime","localtimestamp","log","log10","lower","match","match_number","match_recognize","matches","max","member","merge","method","min","minute","mod","modifies","module","month","multiset","national","natural","nchar","nclob","new","no","none","normalize","not","nth_value","ntile","null","nullif","numeric","octet_length","occurrences_regex","of","offset","old","omit","on","one","only","open","or","order","out","outer","over","overlaps","overlay","parameter","partition","pattern","per","percent","percent_rank","percentile_cont","percentile_disc","period","portion","position","position_regex","power","precedes","precision","prepare","primary","procedure","ptf","range","rank","reads","real","recursive","ref","references","referencing","regr_avgx","regr_avgy","regr_count","regr_intercept","regr_r2","regr_slope","regr_sxx","regr_sxy","regr_syy","release","result","return","returns","revoke","right","rollback","rollup","row","row_number","rows","running","savepoint","scope","scroll","search","second","seek","select","sensitive","session_user","set","show","similar","sin","sinh","skip","smallint","some","specific","specifictype","sql","sqlexception","sqlstate","sqlwarning","sqrt","start","static","stddev_pop","stddev_samp","submultiset","subset","substring","substring_regex","succeeds","sum","symmetric","system","system_time","system_user","table","tablesample","tan","tanh","then","time","timestamp","timezone_hour","timezone_minute","to","trailing","translate","translate_regex","translation","treat","trigger","trim","trim_array","true","truncate","uescape","union","unique","unknown","unnest","update","upper","user","using","value","values","value_of","var_pop","var_samp","varbinary","varchar","varying","versioning","when","whenever","where","width_bucket","window","with","within","without","year","add","asc","collation","desc","final","first","last","view"].filter(e=>!a.includes(e)),s={
match:n.concat(/\b/,n.either(...i),/\s*\(/),relevance:0,keywords:{built_in:i}}
;function o(e){
return n.concat(/\b/,n.either(...e.map(e=>e.replace(/\s+/,"\\s+"))),/\b/)}
const c={scope:"keyword",
match:o(["create table","insert into","primary key","foreign key","not null","alter table","add constraint","grouping sets","on overflow","character set","respect nulls","ignore nulls","nulls first","nulls last","depth first","breadth first"]),
relevance:0};return{name:"SQL",case_insensitive:!0,illegal:/[{}]|<\//,keywords:{
$pattern:/\b[\w\.]+/,keyword:((e,{exceptions:n,when:t}={})=>{const a=t
;return n=n||[],e.map(e=>e.match(/\|\d+$/)||n.includes(e)?e:a(e)?e+"|0":e)})(r,{
when:e=>e.length<3}),literal:["true","false","unknown"],
type:["bigint","binary","blob","boolean","char","character","clob","date","dec","decfloat","decimal","float","int","integer","interval","nchar","nclob","national","numeric","real","row","smallint","time","timestamp","varchar","varying","varbinary"],
built_in:["current_catalog","current_date","current_default_transform_group","current_path","current_role","current_schema","current_transform_group_for_type","current_user","session_user","system_time","system_user","current_time","localtime","current_timestamp","localtimestamp"]
},contains:[{scope:"type",
match:o(["double precision","large object","with timezone","without timezone"])
},c,s,{scope:"variable",match:/@[a-z0-9][a-z0-9_]*/},{scope:"string",variants:[{
begin:/'/,end:/'/,contains:[{match:/''/}]}]},{begin:/"/,end:/"/,contains:[{
match:/""/}]},e.C_NUMBER_MODE,e.C_BLOCK_COMMENT_MODE,t,{scope:"operator",
match:/[-+*/=%^~]|&&?|\|\|?|!=?|<(?:=>?|<|>)?|>[>=]?/,relevance:0}]}},
grmr_swift:e=>{const n={match:/\s+/,relevance:0},t=e.COMMENT("/\\*","\\*/",{
contains:["self"]}),a=[e.C_LINE_COMMENT_MODE,t],i={match:[/\./,m(...be,...me)],
className:{2:"keyword"}},r={match:b(/\./,m(..._e)),relevance:0
},s=_e.filter(e=>"string"==typeof e).concat(["_|0"]),o={variants:[{
className:"keyword",
match:m(..._e.filter(e=>"string"!=typeof e).concat(pe).map(ue),...me)}]},c={
$pattern:m(/\b\w+/,/#\w+/),keyword:s.concat(Ee),literal:he},l=[i,r,o],g=[{
match:b(/\./,m(...ye)),relevance:0},{className:"built_in",
match:b(/\b/,m(...ye),/(?=\()/)}],u={match:/->/,relevance:0},p=[u,{
className:"operator",relevance:0,variants:[{match:Ne},{match:`\\.(\\.|${ve})+`}]
}],_="([0-9]_*)+",h="([0-9a-fA-F]_*)+",f={className:"number",relevance:0,
variants:[{match:`\\b(${_})(\\.(${_}))?([eE][+-]?(${_}))?\\b`},{
match:`\\b0x(${h})(\\.(${h}))?([pP][+-]?(${_}))?\\b`},{match:/\b0o([0-7]_*)+\b/
},{match:/\b0b([01]_*)+\b/}]},E=(e="")=>({className:"subst",variants:[{
match:b(/\\/,e,/[0\\tnr"']/)},{match:b(/\\/,e,/u\{[0-9a-fA-F]{1,8}\}/)}]
}),y=(e="")=>({className:"subst",match:b(/\\/,e,/[\t ]*(?:[\r\n]|\r\n)/)
}),w=(e="")=>({className:"subst",label:"interpol",begin:b(/\\/,e,/\(/),end:/\)/
}),v=(e="")=>({begin:b(e,/"""/),end:b(/"""/,e),contains:[E(e),y(e),w(e)]
}),N=(e="")=>({begin:b(e,/"/),end:b(/"/,e),contains:[E(e),w(e)]}),k={
className:"string",
variants:[v(),v("#"),v("##"),v("###"),N(),N("#"),N("##"),N("###")]
},x=[e.BACKSLASH_ESCAPE,{begin:/\[/,end:/\]/,relevance:0,
contains:[e.BACKSLASH_ESCAPE]}],O={begin:/\/[^\s](?=[^/\n]*\/)/,end:/\//,
contains:x},M=e=>{const n=b(e,/\//),t=b(/\//,e);return{begin:n,end:t,
contains:[...x,{scope:"comment",begin:`#(?!.*${t})`,end:/$/}]}},A={
scope:"regexp",variants:[M("###"),M("##"),M("#"),O]},S={match:b(/`/,Oe,/`/)
},C=[S,{className:"variable",match:/\$\d+/},{className:"variable",
match:`\\$${xe}+`}],T=[{match:/(@|#(un)?)available/,scope:"keyword",starts:{
contains:[{begin:/\(/,end:/\)/,keywords:Se,contains:[...p,f,k]}]}},{
scope:"keyword",match:b(/@/,m(...Ae),d(m(/\(/,/\s+/)))},{scope:"meta",
match:b(/@/,Oe)}],R={match:d(/\b[A-Z]/),relevance:0,contains:[{className:"type",
match:b(/(AV|CA|CF|CG|CI|CL|CM|CN|CT|MK|MP|MTK|MTL|NS|SCN|SK|UI|WK|XC)/,xe,"+")
},{className:"type",match:Me,relevance:0},{match:/[?!]+/,relevance:0},{
match:/\.\.\./,relevance:0},{match:b(/\s+&\s+/,d(Me)),relevance:0}]},D={
begin:/</,end:/>/,keywords:c,contains:[...a,...l,...T,u,R]};R.contains.push(D)
;const I={begin:/\(/,end:/\)/,relevance:0,keywords:c,contains:["self",{
match:b(Oe,/\s*:/),keywords:"_|0",relevance:0
},...a,A,...l,...g,...p,f,k,...C,...T,R]},L={begin:/</,end:/>/,
keywords:"repeat each",contains:[...a,R]},B={begin:/\(/,end:/\)/,keywords:c,
contains:[{begin:m(d(b(Oe,/\s*:/)),d(b(Oe,/\s+/,Oe,/\s*:/))),end:/:/,
relevance:0,contains:[{className:"keyword",match:/\b_\b/},{className:"params",
match:Oe}]},...a,...l,...p,f,k,...T,R,I],endsParent:!0,illegal:/["']/},F={
match:[/(func|macro)/,/\s+/,m(S.match,Oe,Ne)],className:{1:"keyword",
3:"title.function"},contains:[L,B,n],illegal:[/\[/,/%/]},$={
match:[/\b(?:subscript|init[?!]?)/,/\s*(?=[<(])/],className:{1:"keyword"},
contains:[L,B,n],illegal:/\[|%/},z={match:[/operator/,/\s+/,Ne],className:{
1:"keyword",3:"title"}},j={begin:[/precedencegroup/,/\s+/,Me],className:{
1:"keyword",3:"title"},contains:[R],keywords:[...fe,...he],end:/}/},U={
begin:[/(struct|protocol|class|extension|enum|actor)/,/\s+/,Oe,/\s*/],
beginScope:{1:"keyword",3:"title.class"},keywords:c,contains:[L,...l,{begin:/:/,
end:/\{/,keywords:c,contains:[{scope:"title.class.inherited",match:Me},...l],
relevance:0}]};for(const e of k.variants){
const n=e.contains.find(e=>"interpol"===e.label);n.keywords=c
;const t=[...l,...g,...p,f,k,...C];n.contains=[...t,{begin:/\(/,end:/\)/,
contains:["self",...t]}]}return{name:"Swift",keywords:c,contains:[...a,F,$,{
match:[/class\b/,/\s+/,/func\b/,/\s+/,/\b[A-Za-z_][A-Za-z0-9_]*\b/],scope:{
1:"keyword",3:"keyword",5:"title.function"}},{match:[/class\b/,/\s+/,/var\b/],
scope:{1:"keyword",3:"keyword"}},U,z,j,{beginKeywords:"import",end:/$/,
contains:[...a],relevance:0},A,...l,...g,...p,f,k,...C,...T,R,I]}},
grmr_typescript:e=>{
const n=e.regex,t=ge(e),a=te,i=["any","void","number","boolean","string","object","never","symbol","bigint","unknown"],r={
begin:[/namespace/,/\s+/,e.IDENT_RE],beginScope:{1:"keyword",3:"title.class"}
},s={beginKeywords:"interface",end:/\{/,excludeEnd:!0,keywords:{
keyword:"interface extends",built_in:i},contains:[t.exports.CLASS_REFERENCE]
},o={$pattern:te,
keyword:ie.concat(["type","interface","public","private","protected","implements","declare","abstract","readonly","enum","override","satisfies"]),
literal:re,built_in:de.concat(i),"variable.language":le},c={className:"meta",
begin:"@"+a},l=(e,n,t)=>{const a=e.contains.findIndex(e=>e.label===n)
;if(-1===a)throw Error("can not find mode to replace");e.contains.splice(a,1,t)}
;Object.assign(t.keywords,o),t.exports.PARAMS_CONTAINS.push(c)
;const d=t.contains.find(e=>"attr"===e.scope),g=Object.assign({},d,{
match:n.concat(a,n.lookahead(/\s*\?:/))})
;return t.exports.PARAMS_CONTAINS.push([t.exports.CLASS_REFERENCE,d,g]),
t.contains=t.contains.concat([c,r,s,g]),
l(t,"shebang",e.SHEBANG()),l(t,"use_strict",{className:"meta",relevance:10,
begin:/^\s*['"]use strict['"]/
}),t.contains.find(e=>"func.def"===e.label).relevance=0,Object.assign(t,{
name:"TypeScript",aliases:["ts","tsx","mts","cts"]}),t},grmr_vbnet:e=>{
const n=e.regex,t=/\d{1,2}\/\d{1,2}\/\d{4}/,a=/\d{4}-\d{1,2}-\d{1,2}/,i=/(\d|1[012])(:\d+){0,2} *(AM|PM)/,r=/\d{1,2}(:\d{1,2}){1,2}/,s={
className:"literal",variants:[{begin:n.concat(/# */,n.either(a,t),/ *#/)},{
begin:n.concat(/# */,r,/ *#/)},{begin:n.concat(/# */,i,/ *#/)},{
begin:n.concat(/# */,n.either(a,t),/ +/,n.either(i,r),/ *#/)}]
},o=e.COMMENT(/'''/,/$/,{contains:[{className:"doctag",begin:/<\/?/,end:/>/}]
}),c=e.COMMENT(null,/$/,{variants:[{begin:/'/},{begin:/([\t ]|^)REM(?=\s)/}]})
;return{name:"Visual Basic .NET",aliases:["vb"],case_insensitive:!0,
classNameAliases:{label:"symbol"},keywords:{
keyword:"addhandler alias aggregate ansi as async assembly auto binary by byref byval call case catch class compare const continue custom declare default delegate dim distinct do each equals else elseif end enum erase error event exit explicit finally for friend from function get global goto group handles if implements imports in inherits interface into iterator join key let lib loop me mid module mustinherit mustoverride mybase myclass namespace narrowing new next notinheritable notoverridable of off on operator option optional order overloads overridable overrides paramarray partial preserve private property protected public raiseevent readonly redim removehandler resume return select set shadows shared skip static step stop structure strict sub synclock take text then throw to try unicode until using when where while widening with withevents writeonly yield",
built_in:"addressof and andalso await directcast gettype getxmlnamespace is isfalse isnot istrue like mod nameof new not or orelse trycast typeof xor cbool cbyte cchar cdate cdbl cdec cint clng cobj csbyte cshort csng cstr cuint culng cushort",
type:"boolean byte char date decimal double integer long object sbyte short single string uinteger ulong ushort",
literal:"true false nothing"},
illegal:"//|\\{|\\}|endif|gosub|variant|wend|^\\$ ",contains:[{
className:"string",begin:/"(""|[^/n])"C\b/},{className:"string",begin:/"/,
end:/"/,illegal:/\n/,contains:[{begin:/""/}]},s,{className:"number",relevance:0,
variants:[{begin:/\b\d[\d_]*((\.[\d_]+(E[+-]?[\d_]+)?)|(E[+-]?[\d_]+))[RFD@!#]?/
},{begin:/\b\d[\d_]*((U?[SIL])|[%&])?/},{begin:/&H[\dA-F_]+((U?[SIL])|[%&])?/},{
begin:/&O[0-7_]+((U?[SIL])|[%&])?/},{begin:/&B[01_]+((U?[SIL])|[%&])?/}]},{
className:"label",begin:/^\w+:/},o,c,{className:"meta",
begin:/[\t ]*#(const|disable|else|elseif|enable|end|externalsource|if|region)\b/,
end:/$/,keywords:{
keyword:"const disable else elseif enable end externalsource if region then"},
contains:[c]}]}},grmr_wasm:e=>{e.regex;const n=e.COMMENT(/\(;/,/;\)/)
;return n.contains.push("self"),{name:"WebAssembly",keywords:{$pattern:/[\w.]+/,
keyword:["anyfunc","block","br","br_if","br_table","call","call_indirect","data","drop","elem","else","end","export","func","global.get","global.set","local.get","local.set","local.tee","get_global","get_local","global","if","import","local","loop","memory","memory.grow","memory.size","module","mut","nop","offset","param","result","return","select","set_global","set_local","start","table","tee_local","then","type","unreachable"]
},contains:[e.COMMENT(/;;/,/$/),n,{match:[/(?:offset|align)/,/\s*/,/=/],
className:{1:"keyword",3:"operator"}},{className:"variable",begin:/\$[\w_]+/},{
match:/(\((?!;)|\))+/,className:"punctuation",relevance:0},{
begin:[/(?:func|call|call_indirect)/,/\s+/,/\$[^\s)]+/],className:{1:"keyword",
3:"title.function"}},e.QUOTE_STRING_MODE,{match:/(i32|i64|f32|f64)(?!\.)/,
className:"type"},{className:"keyword",
match:/\b(f32|f64|i32|i64)(?:\.(?:abs|add|and|ceil|clz|const|convert_[su]\/i(?:32|64)|copysign|ctz|demote\/f64|div(?:_[su])?|eqz?|extend_[su]\/i32|floor|ge(?:_[su])?|gt(?:_[su])?|le(?:_[su])?|load(?:(?:8|16|32)_[su])?|lt(?:_[su])?|max|min|mul|nearest|neg?|or|popcnt|promote\/f32|reinterpret\/[fi](?:32|64)|rem_[su]|rot[lr]|shl|shr_[su]|store(?:8|16|32)?|sqrt|sub|trunc(?:_[su]\/f(?:32|64))?|wrap\/i64|xor))\b/
},{className:"number",relevance:0,
match:/[+-]?\b(?:\d(?:_?\d)*(?:\.\d(?:_?\d)*)?(?:[eE][+-]?\d(?:_?\d)*)?|0x[\da-fA-F](?:_?[\da-fA-F])*(?:\.[\da-fA-F](?:_?[\da-fA-D])*)?(?:[pP][+-]?\d(?:_?\d)*)?)\b|\binf\b|\bnan(?::0x[\da-fA-F](?:_?[\da-fA-D])*)?\b/
}]}},grmr_xml:e=>{
const n=e.regex,t=n.concat(/[\p{L}_]/u,n.optional(/[\p{L}0-9_.-]*:/u),/[\p{L}0-9_.-]*/u),a={
className:"symbol",begin:/&[a-z]+;|&#[0-9]+;|&#x[a-f0-9]+;/},i={begin:/\s/,
contains:[{className:"keyword",begin:/#?[a-z_][a-z1-9_-]+/,illegal:/\n/}]
},r=e.inherit(i,{begin:/\(/,end:/\)/}),s=e.inherit(e.APOS_STRING_MODE,{
className:"string"}),o=e.inherit(e.QUOTE_STRING_MODE,{className:"string"}),c={
endsWithParent:!0,illegal:/</,relevance:0,contains:[{className:"attr",
begin:/[\p{L}0-9._:-]+/u,relevance:0},{begin:/=\s*/,relevance:0,contains:[{
className:"string",endsParent:!0,variants:[{begin:/"/,end:/"/,contains:[a]},{
begin:/'/,end:/'/,contains:[a]},{begin:/[^\s"'=<>`]+/}]}]}]};return{
name:"HTML, XML",
aliases:["html","xhtml","rss","atom","xjb","xsd","xsl","plist","wsf","svg"],
case_insensitive:!0,unicodeRegex:!0,contains:[{className:"meta",begin:/<![a-z]/,
end:/>/,relevance:10,contains:[i,o,s,r,{begin:/\[/,end:/\]/,contains:[{
className:"meta",begin:/<![a-z]/,end:/>/,contains:[i,r,o,s]}]}]
},e.COMMENT(/<!--/,/-->/,{relevance:10}),{begin:/<!\[CDATA\[/,end:/\]\]>/,
relevance:10},a,{className:"meta",end:/\?>/,variants:[{begin:/<\?xml/,
relevance:10,contains:[o]},{begin:/<\?[a-z][a-z0-9]+/}]},{className:"tag",
begin:/<style(?=\s|>)/,end:/>/,keywords:{name:"style"},contains:[c],starts:{
end:/<\/style>/,returnEnd:!0,subLanguage:"css"}},{className:"tag",
begin:/<script(?=\s|>)/,end:/>/,keywords:{name:"script"},contains:[c],starts:{
end:/<\/script>/,returnEnd:!0,subLanguage:"javascript"}},{className:"tag",
begin:/<>|<\/>/},{className:"tag",
begin:n.concat(/</,n.lookahead(n.concat(t,n.either(/\/>/,/>/,/\s/)))),
end:/\/?>/,contains:[{className:"name",begin:t,relevance:0,starts:c}]},{
className:"tag",begin:n.concat(/<\//,n.lookahead(n.concat(t,/>/))),contains:[{
className:"name",begin:t,relevance:0},{begin:/>/,relevance:0,endsParent:!0}]}]}
},grmr_yaml:e=>{
const n="true false yes no null",t="[\\w#;/?:@&=+$,.~*'()[\\]]+",a={
className:"string",relevance:0,variants:[{begin:/"/,end:/"/},{begin:/\S+/}],
contains:[e.BACKSLASH_ESCAPE,{className:"template-variable",variants:[{
begin:/\{\{/,end:/\}\}/},{begin:/%\{/,end:/\}/}]}]},i=e.inherit(a,{variants:[{
begin:/'/,end:/'/,contains:[{begin:/''/,relevance:0}]},{begin:/"/,end:/"/},{
begin:/[^\s,{}[\]]+/}]}),r={end:",",endsWithParent:!0,excludeEnd:!0,keywords:n,
relevance:0},s={begin:/\{/,end:/\}/,contains:[r],illegal:"\\n",relevance:0},o={
begin:"\\[",end:"\\]",contains:[r],illegal:"\\n",relevance:0},c=[{
className:"attr",variants:[{begin:/[\w*@][\w*@ :()\./-]*:(?=[ \t]|$)/},{
begin:/"[\w*@][\w*@ :()\./-]*":(?=[ \t]|$)/},{
begin:/'[\w*@][\w*@ :()\./-]*':(?=[ \t]|$)/}]},{className:"meta",
begin:"^---\\s*$",relevance:10},{className:"string",
begin:"[\\|>]([1-9]?[+-])?[ ]*\\n( +)[^ ][^\\n]*\\n(\\2[^\\n]+\\n?)*"},{
begin:"<%[%=-]?",end:"[%-]?%>",subLanguage:"ruby",excludeBegin:!0,excludeEnd:!0,
relevance:0},{className:"type",begin:"!\\w+!"+t},{className:"type",
begin:"!<"+t+">"},{className:"type",begin:"!"+t},{className:"type",begin:"!!"+t
},{className:"meta",begin:"&"+e.UNDERSCORE_IDENT_RE+"$"},{className:"meta",
begin:"\\*"+e.UNDERSCORE_IDENT_RE+"$"},{className:"bullet",begin:"-(?=[ ]|$)",
relevance:0},e.HASH_COMMENT_MODE,{beginKeywords:n,keywords:{literal:n}},{
className:"number",
begin:"\\b[0-9]{4}(-[0-9][0-9]){0,2}([Tt \\t][0-9][0-9]?(:[0-9][0-9]){2})?(\\.[0-9]*)?([ \\t])*(Z|[-+][0-9][0-9]?(:[0-9][0-9])?)?\\b"
},{className:"number",begin:e.C_NUMBER_RE+"\\b",relevance:0},s,o,{
className:"string",relevance:0,begin:/'/,end:/'/,contains:[{match:/''/,
scope:"char.escape",relevance:0}]},a],l=[...c]
;return l.pop(),l.push(i),r.contains=l,{name:"YAML",case_insensitive:!0,
aliases:["yml"],contains:c}}});const Ke=ne;for(const e of Object.keys(Pe)){
const n=e.replace("grmr_","").replace("_","-");Ke.registerLanguage(n,Pe[e])}
return Ke}()
;"object"==typeof exports&&"undefined"!=typeof module&&(module.exports=hljs);
/* 挂到全局：客户端按 `globalThis[name]` 取（浏览器里 window === globalThis） */
if (typeof globalThis !== 'undefined' && !globalThis.hljs) globalThis.hljs = hljs
