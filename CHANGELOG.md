# VCPToolBox 版本变更日志

## 7.1.2 - 2026-03-29

### OpenClaw Bridge Phase 1
- 新增独立路由模块 `routes/openclawBridgeRoutes.js`，将 OpenClaw Bridge 接口从 `adminPanelRoutes.js` 中拆分，保持管理面板与桥接接口边界清晰。
- 在 `routes/openclawBridgeRoutes.js` 实现 `GET /admin_api/openclaw/capabilities`，输出 OpenClaw Bridge v1 所需的工具能力描述、超时、审批标记与输入 schema。
- 在 `routes/openclawBridgeRoutes.js` 实现 `POST /admin_api/openclaw/tools/:toolName`，打通 OpenClaw 到 `PluginManager.processToolCall()` 的最小工具调用闭环。
- 新增统一成功/失败 envelope、`x-request-id` 与 `x-openclaw-bridge-version` 响应头，以及 `OCW_TOOL_*` 错误码映射。
- 新增 OpenClaw Bridge 审计日志事件，覆盖能力发现、调用开始、调用成功、调用失败与审批阻断场景。
- 在 `Plugin.js` 增加 `__openclawContext` 透传清洗逻辑，避免桥接上下文污染插件实际入参。
- 新增 `test/openclaw-bridge-routes.test.js`，覆盖 capabilities、成功调用、参数校验、审批拦截与超时错误映射。
