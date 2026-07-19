# Real-client smoke 记录

> 各 milestone 的真实 MCP client smoke 结果登记（06-execution-plan.md 的 smoke 验收项引用本文）。

## M0.S4 Tool description 重写（2026-07-19）

- **变更**：重写 `gateway_recall_run` / `gateway_memory_search` / `gateway_context_assemble` / `gateway_memory_write` 4 个核心 tool 的 description 为触发判断导向文案；未改任何 schema、身份或授权行为。`npm run export:agent-gateway-openapi` 重生成后 `mcpDescriptors.json` 与 catalog 一致（零 drift）。
- **客户端**：Codex CLI（本机 `codex`，经 `npm run smoke:agent-gateway-codex-mcp`）。
- **结果**：PASS。`tools/list` 返回的 4 条新 description 完整送达客户端；bootstrap 链路 renderHits=1，直连 MCP probe 取回正确 rendered prompt（`You are Ariadne. Hello CodexE2E.`）。已知限制：Codex 非交互模式取消了模型侧 MCP tool call（`user cancelled MCP tool call`），故本次 smoke 以直连 probe 证据判定通过；模型端工具选择行为（description 触发判断是否更准确）需在 M2.S4 的三客户端 capability smoke 中一并评审。
- **风险标记**：本变更为模型可见行为变化（tool 触发倾向），不标记为"无行为风险"。
