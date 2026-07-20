# Real-client smoke 记录

> 各 milestone 的真实 MCP client smoke 结果登记（06-execution-plan.md 的 smoke 验收项引用本文）。

## M4.S3 三格式生成物真实安装 smoke（2026-07-20）

- **生成**：`node scripts/agent-gateway-skill-export.js --agent MCPMidas --out <tmp> --format all --base-url https://vcp.example.com`（真实部署 guidance 配置 `modules/agentGateway/config/agent_guidance.json` + 真实 agent directory）。三 format 各 2 文件（skill/guide + manifest.json），manifest 内 per-file sha256 全部与落盘内容一致；secret scan 零命中（生成物只含 endpoint、工具说明与 `${AGENT_GATEWAY_TOKEN}` 环境引用形态）。
- **Claude Code 2.1.215（真实安装）**：PASS。生成的 `SKILL.md` 安装至临时项目 `.claude/skills/vcp-agent-gateway-mcpmidas/`，真实 `claude -p` 会话的 available-skills 列表包含 `vcp-agent-gateway-mcpmidas`（frontmatter name/description 被正常解析装载）。
- **Codex CLI 0.144.5（真实安装）**：PASS。初版 codex format 为项目根 `AGENTS.md`（真实 `codex exec` 读取并正确回答其中 Agent id）；随后确认 Codex 已支持 Agent Skills 规范，codex format 切换为 SKILL.md——置入临时项目 `.agents/skills/vcp-agent-gateway-mcpmidas/` 后，真实 `codex exec` 可用 skill 列表包含该 skill（按需装载，不再与项目已有 AGENTS.md 合并共存）。`config.toml` MCP 注册片段经 TOML 解析校验（url + `${AGENT_GATEWAY_TOKEN}` header 环境引用）。
- **Kimi Code 0.27.0（真实安装）**：PASS。生成的 `SKILL.md` 置入隔离 skills 目录（`kimi --skills-dir <tmp>`，不改写用户级 `~/.kimi-code` 配置），真实 `kimi -p` 会话的可用 skill 列表包含 `vcp-agent-gateway-mcpmidas`（首轮 smoke 发现 Kimi 要求 frontmatter 才能装载——kimi 模板据此补齐 name/description frontmatter 后复测通过）。`mcp.json` 注册片段另经 JSON 解析校验（`bearerTokenEnvVar` 形态，零明文 token）；MCP endpoint 本身已由 M2.S4 真实 smoke 覆盖。
- **端到端签名下载**：route 级测试覆盖 mint（credential + format 校验）→ 裸签名 URL redeem（无 credential）→ 重放 403 → revision 漂移 410（不烧 nonce）→ 文件 backend 跨实例/跨重启一次性语义（`tests/agent-gateway/routes/agent-gateway-skill-download-routes.test.js`）。
- **部署要求**：代理/CDN/APM/access log 的缓存旁路与 query 脱敏为部署侧责任，清单见 [deployment-notes.md](deployment-notes.md)。

## M2.S4 三客户端 capability smoke（2026-07-20）

- **脚本**：`npm run smoke:agent-gateway-m2`（`scripts/run-agent-gateway-m2-smoke.js`）。临时 native backend + Streamable HTTP MCP gateway，文件 credential 绑定 agent `Ariadne`（`gateway:read` + `gateway:execute`），另有 legacy gateway key 作未绑定对照。
- **直连 capability probe（M2 门禁证据）**：PASS。绑定 initialize.instructions 只含所属 agent 摘要（agent id、guidance resource URI、revision、workflow marker）；未绑定（legacy key）恰好返回 canonical `GENERIC_INSTRUCTIONS`，不含任何 agent id/workflow/memoryDefaults 内容；guidance resource、bootstrap `integrationGuidance`、REST binding 三面 deep-equal 且同 revision；REST 响应 `Cache-Control: private, no-store` + `Vary: Authorization, x-agent-gateway-key, Cookie`；绑定 credential 读他人 guidance → 403；`tools/list` 不含 `gateway_agent_render`。
- **§5.3 兼容性矩阵（实测，guidance revision 一致性以直连 probe 的 revision 为准）**：

| 客户端 | 版本 | initialize | instructions 消费 | resources 消费 | bootstrap（tool-only 路径） | 备注 |
|---|---|---|---|---|---|---|
| Claude Code | 2.1.215 | ok | 模型可见（能引用 instructions 首句） | `resources/read` 自主调用，revision 与 canonical 一致 | 成功，`integrationGuidance.revision` 一致 | 全三层 guidance 均可消费 |
| Codex CLI | 0.144.5 | ok | 模型可见 | `resources/read` 自主调用，revision 一致 | 非交互 `codex exec` 自动取消 MCP tool call（`user cancelled MCP tool call`，`approval_policy="never"` 亦不生效）；bootstrap 语义由直连 probe 与 M0.S4 codex smoke 覆盖 | resource+instructions 双层可用 |
| Kimi Code | 0.27.0 | ok | 未向模型呈现 | 客户端不支持 MCP resources | `tools/call` 成功但只向模型渲染 `content[0].text`（renderedPrompt），`structuredContent`（含 `integrationGuidance`）不可见 | 典型 tool-only host：guidance 依赖 bootstrap 文本层 |

- **结论**：无绑定连接只收通用 instructions、绑定连接只得所属 agent guidance、tool-only host 经 bootstrap 获取等价内容——三条 M2 门禁全部满足。已知限制：Kimi 只消费 tool result 的 text 内容，`integrationGuidance` 结构化字段对模型不可见（renderedPrompt 兼容语义仍完整送达）；Codex 非交互模式无法完成模型侧 MCP tool call（与 M0.S4 记录一致）。
- **测试**：`npm run test:agent-gateway-m2-smoke-script`（脚本 helper 单测）；`npm run test:agent-gateway` 全量通过（M2 合并时 879 用例，0 失败）。

## M0.S4 Tool description 重写（2026-07-19）

- **变更**：重写 `gateway_recall_run` / `gateway_memory_search` / `gateway_context_assemble` / `gateway_memory_write` 4 个核心 tool 的 description 为触发判断导向文案；未改任何 schema、身份或授权行为。`npm run export:agent-gateway-openapi` 重生成后 `mcpDescriptors.json` 与 catalog 一致（零 drift）。
- **客户端**：Codex CLI（本机 `codex`，经 `npm run smoke:agent-gateway-codex-mcp`）。
- **结果**：PASS。`tools/list` 返回的 4 条新 description 完整送达客户端；bootstrap 链路 renderHits=1，直连 MCP probe 取回正确 rendered prompt（`You are Ariadne. Hello CodexE2E.`）。已知限制：Codex 非交互模式取消了模型侧 MCP tool call（`user cancelled MCP tool call`），故本次 smoke 以直连 probe 证据判定通过；模型端工具选择行为（description 触发判断是否更准确）需在 M2.S4 的三客户端 capability smoke 中一并评审。
- **风险标记**：本变更为模型可见行为变化（tool 触发倾向），不标记为"无行为风险"。
