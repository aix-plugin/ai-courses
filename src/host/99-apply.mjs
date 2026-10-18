
/* ---------------------------------------------------------------- apply */
export function apply (ctx, config) {
  const disposers = []
  try {
    /* RPC：client ↔ host 的唯一数据通道 */
    const deps = buildContext(ctx, config)
    const table = createMethodTableFor(deps)
    registerRoutes(ctx, table).forEach((d) => disposers.push(d))
    /* 媒体的 GET 路由（学习页正文里的相对路径图片）：与 RPC 同一个 webServer，路径前缀独立 */
    disposers.push(registerMediaRoute(ctx, deps))
    /* 浏览器按需加载的静态资源（Mermaid）。缺文件只影响图表渲染，客户端会降级成源码块 */
    disposers.push(registerVendorRoute(ctx))
    disposers.push(registerSystemPrompt(ctx))
    disposers.push(registerCourseCommand(ctx, deps))

    /* 模型工具：与 UI 走同一张方法表，保证语义不漂移 */
    const toolDefs = createToolDefinitions({ deps, table })
    registerTools(ctx, toolDefs).forEach((d) => disposers.push(d))
    /* logger 走 try/catch：它不是 inject 服务，取不到也不该让激活失败 */
    try { ctx.logger?.info?.('[ai-courses] RPC %d 个方法、%d 个工具；courseRoot=%s', table.size, toolDefs.length, deps.root) } catch {}

  } catch (err) {
    disposers.forEach((d) => { try { d() } catch {} })
    throw err
  }
  return () => { disposers.forEach((d) => { try { d() } catch {} }) }
}
