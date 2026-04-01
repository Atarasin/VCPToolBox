# VCPToolBox 版本变更日志

## 7.1.2 - 2026-03-29

### OpenClaw Bridge Phase 4
- 在 `routes/openclawBridgeRoutes.js` 新增 `POST /admin_api/openclaw/memory/write`，将 OpenClaw durable memory 写回 VCP 日记体系。
- 为 `POST /admin_api/openclaw/tools/vcp_memory_write` 增加内部 durable memory 桥接，使 OpenClaw 可以统一经由插件工具调用链完成写回，而不必感知专用 memory write API 细节。
- 扩展 `GET /admin_api/openclaw/capabilities`，对外补充每个工具的 `invocationCommands` 原始说明、参数与示例，供 OpenClaw 插件生成更贴近 manifest 的 Skill 文档。
- 将 OpenClaw durable memory 写回链路收敛为仅调用 `DailyNote` 工具，不再回退到 `DailyNoteWrite`。
- 调整 `DailyNote` create 参数契约，将 `Tag` 标记为必需参数，并同步收紧 OpenClaw memory write 请求为必须提供 tags。
- 为记忆写回补充基于 `idempotencyKey` 与内容指纹的去重逻辑，避免同批 durable memory 重复落盘。
- 为记忆写回补充 diary 权限校验、错误码映射与 `memory.write.*` 审计日志，便于灰度观察与问题追踪。
- 更新 capabilities 的 memory feature 描述，在存在可用日记写入插件时对外暴露 `writeBack: true`。
- 扩展 `test/openclaw-bridge-routes.test.js`，覆盖写回能力发现、成功写入、幂等去重与越权拒绝场景。

### OpenClaw Bridge Phase 3
- 在 `routes/openclawBridgeRoutes.js` 新增 `POST /admin_api/openclaw/rag/context`，支持将最近对话片段转换为自动召回查询并输出 recall blocks。
- 为上下文召回增加注入预算控制、最小分数阈值、去重、块数量限制与超预算截断逻辑。
- 复用既有 RAG 检索链路的 TimeAware、GroupAware、Rerank、TagMemo 策略，为 ContextEngine assemble 阶段提供结构化召回结果。
- 扩展 `test/openclaw-bridge-routes.test.js`，覆盖 context recall 生成、token budget 截断与空查询校验场景。
- 升级 `rag/search` 与 `rag/context` 的请求协议，支持 `diaries[]` 多目标约束，并将其纳入访问校验、目标裁剪与审计日志。
- 在 `rag.context.completed` 审计日志中补充候选/达标/最终召回文本的分数统计（最大值、最小值、平均值）与 `filteredByMinScore`，便于调优 `minScore`。

### OpenClaw Bridge Phase 2
- 在 `routes/openclawBridgeRoutes.js` 新增 `GET /admin_api/openclaw/rag/targets`，按 agent 维度输出可访问 diary 列表。
- 在 `routes/openclawBridgeRoutes.js` 新增 `POST /admin_api/openclaw/rag/search`，将 OpenClaw memory_search 桥接到 VCP RAG 检索链路并返回结构化结果与诊断信息。
- 为 OpenClaw RAG 检索补充 diary 权限映射、跨角色访问开关、TagMemo/Group/Time/Rerank 策略接入与审计日志。
- 更新 capabilities 的 memory 描述，暴露可访问 targets 与 memory feature 能力位。
- 扩展 `test/openclaw-bridge-routes.test.js`，覆盖 memory targets、结构化检索、空结果与越权访问场景。
- 补充多 diary 约束测试，验证 Bridge 在 `diaries[]` 模式下只检索并返回显式指定的 diary 范围。
- 在 `rag.search.completed` 审计日志中补充候选/最终返回结果的分数统计（最大值、最小值、平均值）与 `filteredByResultWindow`，便于分析显式检索结果分布。

### OpenClaw Bridge Phase 1
- 新增独立路由模块 `routes/openclawBridgeRoutes.js`，将 OpenClaw Bridge 接口从 `adminPanelRoutes.js` 中拆分，保持管理面板与桥接接口边界清晰。
- 在 `routes/openclawBridgeRoutes.js` 实现 `GET /admin_api/openclaw/capabilities`，输出 OpenClaw Bridge v1 所需的工具能力描述、超时、审批标记与输入 schema。
- 在 `routes/openclawBridgeRoutes.js` 实现 `POST /admin_api/openclaw/tools/:toolName`，打通 OpenClaw 到 `PluginManager.processToolCall()` 的最小工具调用闭环。
- 新增统一成功/失败 envelope、`x-request-id` 与 `x-openclaw-bridge-version` 响应头，以及 `OCW_TOOL_*` 错误码映射。
- 新增 OpenClaw Bridge 审计日志事件，覆盖能力发现、调用开始、调用成功、调用失败与审批阻断场景。
- 在 `Plugin.js` 增加 `__openclawContext` 透传清洗逻辑，避免桥接上下文污染插件实际入参。
- 新增 `test/openclaw-bridge-routes.test.js`，覆盖 capabilities、成功调用、参数校验、审批拦截与超时错误映射。
