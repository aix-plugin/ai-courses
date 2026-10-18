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
