# Agent Gateway 重构方案

> 状态：设计稿（待评审）
> 日期：2026-07-09
> 范围：`modules/agentGateway/`（约 41 个 JS 文件、1.65 万行），及其在 `server.js` / `routes/agentGatewayRoutes.js` / `scripts/` 中的装配点

## 文档索引

| 文档 | 内容 |
|---|---|
| [01-current-state-and-debt.md](./01-current-state-and-debt.md) | 现状架构、调用链全景、技术负债登记表（全部附 `文件:行号` 证据） |
| [02-target-architecture.md](./02-target-architecture.md) | 目标架构：能力端口层、单一 MCP 核心、recall 管线重组、契约单源 |
| [03-implementation-plan.md](./03-implementation-plan.md) | 六个阶段的实施计划：改动清单、验证方式、风险与回滚 |

## 背景

agentGateway 是 VCP 对外提供内置能力（尤其 RAG 记忆召回）的统一网关，暴露两种协议面：

1. **Native REST**：`/agent_gateway/*`（15 个端点，in-process 直调 service bundle）
2. **MCP**：Streamable HTTP（`/mcp`）、WebSocket（`/mcp`）、stdio（独立进程），三者默认经 backend-proxy 回环到 Native REST

模块经历 S01–S05 多个里程碑快速迭代（见 `tests/s01`–`s05`），功能已相当完整（recall profile 体系、修饰符流水线、诊断、operability 治理），但迭代方式以"整块复制再改"为主，积累了三类核心负债：

- **同一逻辑两份实现且已漂移**（两个 MCP adapter、两个传输 server 之间约 20+ 处拷贝，其中错误码映射、diary 策略等已产生行为差异，属正确性 bug）；
- **对 VCP 宿主的隐式依赖**（duck-typing `pluginManager` 属性 + 散落的 lazy `require('../../../…')`，无显式契约）；
- **巨型文件与巨型函数**（`recallRuntimeService.js` 1770 行、`executeRecall` ~537 行、`mcpAdapter.js` 1492 行、手写 OpenAPI 1821 行）。

## 重构目标

1. **消除行为漂移**：同一操作经任何协议/传输进入，得到完全一致的准入判定、错误码与响应结构。
2. **单一实现**：MCP 结果封装、错误映射、harness 分发、diary 策略、限流、配置加载等各只保留一份代码。
3. **显式的 VCP 能力边界**：以「能力端口（Port）」取代对 `pluginManager` 的鸭子类型访问，网关对宿主的全部依赖集中在一处组装根，可独立测试、可替换实现。
4. **recall 管线可演进**：把 537 行的 `executeRecall` 拆成可独立测试的 stage/modifier 单元，为后续新增召回策略留出扩展点。
5. **契约单源**：工具 schema、MCP descriptor、OpenAPI 文档由同一份 JSON Schema 生成，机器保证一致性。

## 非目标

- 不改变对外契约：15 个 REST 路径、8 个 MCP 工具名、响应 envelope 结构、`config.env` 环境变量名、`recall_profiles.json` / `mcp_agent_memory_policy.json` 配置格式全部保持不变。
- 不引入 TypeScript / ESM（遵守仓库 CommonJS 约定，见 `modules/AGENTS.md`）。
- 不重写 RAG 本体（`RAGDiaryPlugin` / `KnowledgeBaseManager`）——只重构网关对它们的访问方式。
- 不在本轮完成认证体系升级（`ADMIN_TRANSITION` → 强制专用密钥），仅修复其中的安全实现缺陷并预留升级位。

## 指导原则

1. **先止血，再动骨架**：已确认的行为 bug（错误码降级、单例所有权冲突、无超时阻塞）在任何结构重构之前以最小 diff 修复。
2. **每阶段独立可发布**：六个阶段各自保持全量测试绿色，可随时停在任一阶段边界。
3. **差分测试护航**：Phase 1 起建立「同请求 → in-process / backend-proxy 双路径 → 断言 envelope 一致」的 parity 测试，把"防漂移"从人工纪律变成机器约束。
4. **删除优于抽象**：拷贝代码合并时以"选定一份正确实现 + 删除另一份"为主，不为对齐而新造中间层。
5. **组装根唯一**：只有 `composition/` 允许接触 `pluginManager` 与根级 `require`，其余代码只依赖注入的端口。

## 阶段总览

| 阶段 | 主题 | 规模 | 关键产出 |
|---|---|---|---|
| Phase 0 | 止血：正确性与安全热修 | 小 | proxy 错误码补齐、超时与 AbortSignal、runtime 单例所有权、timingSafeEqual、示例配置对齐 |
| Phase 1 | MCP 核心去重 | 中 | `protocols/mcp/` 单一 harness + resultShapes + errorMapping + diaryPolicy；两 adapter 收敛为两个 executor；parity 测试 |
| Phase 2 | 传输公共层 | 中 | `transport/shared/`：限流、上下文注入、runtime 获取、日志约定；三传输行为对齐 |
| Phase 3 | VCP 能力端口层 | 中 | `ports/` 显式接口；组装根收口 `pluginManager`；消除 lazy require 与 late-binding 循环依赖 |
| Phase 4 | recall 管线重组 | 大 | `core/recall/` stage + modifier 拆分；context/recall 重复 helper 收口；`executeRecall` 降为 <150 行编排器 |
| Phase 5 | 契约单源与基础设施 | 中 | JSON Schema 单源 + ajv；descriptor/OpenAPI 生成；审计 sink 可插拔；trace 贯通 |

依赖关系：Phase 0 独立；Phase 1 → Phase 2（传输层依赖统一 harness）；Phase 3 → Phase 4（管线拆分依赖端口）；Phase 5 可与 3/4 并行。

## 验收标准

- [ ] `tests/agent-gateway/**` 与 `tests/s01`–`s05` 全部通过，`smoke:agent-gateway-codex-mcp` 端到端通过。
- [ ] parity 测试：8 个 MCP 工具经 in-process 与 backend-proxy 两条路径调用，成功/失败 envelope（含错误码、operability 元数据字段集）逐字段一致。
- [ ] 负债登记表（01 文档 §3）中 A/B/C/D 类条目全部关闭或显式豁免。
- [ ] 无单文件 >800 行、无单函数 >150 行（`publishedOpenApiDocument.js` 由生成器取代后自然达标）。
- [ ] `grep -r "require('../../../" modules/agentGateway --include=*.js` 仅命中 `composition/` 与 `ports/`。
- [ ] 对外契约冻结项（REST 路径 / 工具名 / envelope / env 名）零变更，由既有契约测试 `tests/agent-gateway/contracts/` 守护。

## 可依赖的既有资产

- 测试：`tests/agent-gateway/`（adapters / services / policy / contracts / routes / transport / examples 分层单测）、`tests/s01`–`s05` 里程碑测试、`scripts/run-agent-gateway-codex-e2e.js`。
- 契约守护：`tests/agent-gateway/contracts/agent-gateway-contract-publishing.test.js`（路径集合三方一致性）。
- 文档：`config/RECALL_PROFILES_CONFIG_GUIDE.md`、`mydoc/export/mcp/*` 设计文档。
