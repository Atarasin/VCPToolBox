# Agent Gateway 重构方案

> 状态：评审修订稿（待实施）
> 初稿日期：2026-07-09
> 评审修订：2026-07-17
> 范围：`modules/agentGateway/`（约 41 个 JS 文件、1.65 万行），及其在 `server.js` / `routes/agentGatewayRoutes.js` / `scripts/` 中的装配点

## 文档索引

| 文档 | 内容 |
|---|---|
| [01-current-state-and-debt.md](./01-current-state-and-debt.md) | 现状架构、调用链全景、技术负债登记表（全部附 `文件:行号` 证据） |
| [02-target-architecture.md](./02-target-architecture.md) | 目标架构：能力端口层、单一 MCP 核心、recall 管线重组、契约单源 |
| [03-implementation-plan.md](./03-implementation-plan.md) | 分阶段实施计划：基线门禁、改动清单、依赖关系、验证方式、风险与回滚 |

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
5. **契约单源**：以 operation catalog 描述 canonical args/result、错误集合和 REST/MCP bindings，再生成 JSON Schema、MCP descriptor 与 OpenAPI，机器保证同一业务操作跨协议一致。

## 非目标

- 不改变对外契约：15 个 REST 路径、8 个 MCP 工具名、响应 envelope 结构、`config.env` 环境变量名、`recall_profiles.json` / `mcp_agent_memory_policy.json` 配置格式全部保持不变。
- 不引入 TypeScript / ESM（遵守仓库 CommonJS 约定，见 `modules/AGENTS.md`）。
- 不重写 RAG 本体（`RAGDiaryPlugin` / `KnowledgeBaseManager`）——只重构网关对它们的访问方式。
- 不在本轮完成认证体系升级（`ADMIN_TRANSITION` → 强制专用密钥），仅修复其中的安全实现缺陷并预留升级位。
- 不在结构重构阶段改变规则执行并发度、HTTP/stdio batch 接受范围或输入校验宽严；这些行为变化必须在重构完成后作为独立优化评审。
- debt 修复引入的少量显式行为变化（SSE 背压 30s 超时、discovery session 独立池、WS idle 可配开关）不属于契约冻结项，但必须在 03 兼容性检查清单逐条登记并写入发布说明。

## 指导原则

1. **先建立可信基线**：在修复或重构前先让 Agent Gateway 全量测试可由单一命令执行、与运行配置隔离并接入 CI。
2. **只修可复现问题**：已确认的行为 bug（错误码降级、无超时阻塞等）在结构重构前以最小 diff 修复；无法由回归测试复现的问题不得进入热修阶段。
3. **每阶段独立可发布**：每个阶段结束时全量测试绿色，对外契约和既有接受/拒绝语义保持不变，可停在任一阶段边界。
4. **差分测试护航**：Phase 1 起建立「同请求 → in-process / backend-proxy 双路径 → 断言 envelope 一致」的 parity 测试，把"防漂移"从人工纪律变成机器约束。
5. **删除优于抽象**：拷贝代码合并时以"选定一份正确实现 + 删除另一份"为主，不为对齐而新造中间层。
6. **组装根唯一且生命周期明确**：只有 `composition/` 允许接触 `pluginManager` 与根级 `require`；端口绑定与 fail-fast 校验必须发生在宿主插件初始化完成之后。

## 阶段总览

| 阶段 | 主题 | 规模 | 关键产出 |
|---|---|---|---|
| Phase -1 | 可信基线与发布门禁 | 小 | 全量测试聚合命令、运行配置隔离、现有 9 个失败清零、CI 门禁 |
| Phase 0 | 止血：可复现的正确性与安全热修 | 小 | proxy 错误码补齐、超时与 AbortSignal、timingSafeEqual、示例配置对齐；A3/A6 只调查不盲改 |
| Phase 1 | MCP 核心去重 | 中 | `protocols/mcp/` 单一 harness + resultShapes + errorMapping + diaryPolicy；两 adapter 收敛为两个 executor；parity 测试 |
| Phase 2 | 传输公共层 | 中 | `transport/shared/`：限流、上下文注入、runtime provider、日志约定；保留各传输现有 batch 语义 |
| Phase 3 | 装配时序与 VCP 能力端口层 | 中 | 宿主 ready 后绑定 ports；组装根收口 `pluginManager`；消除 lazy require 与 late-binding 循环依赖 |
| Phase 4 | recall 管线重组 | 大 | `core/recall/` stage + modifier 拆分；保持 rules 串行；`executeRecall` 降为 <150 行编排器 |
| Phase 5A | 契约 operation catalog | 中 | canonical operation 模型 + ajv 兼容校验；生成 descriptor/OpenAPI |
| Phase 5B | 基础设施贯通 | 中 | 审计 sink 可插拔；trace 经 REST/MCP/operability/audit 贯通 |
| Phase 6（可选） | 性能与协议能力优化 | 独立评审 | 有界 rules 并发、batch 语义统一等显式行为变更，不属于本轮结构重构验收范围 |

依赖关系：Phase -1 → Phase 0 → Phase 1；Phase 1 → Phase 2、Phase 3 与 Phase 5A；Phase 2 与 Phase 3 可并行；Phase 3 → Phase 4；Phase 2 + Phase 3 → Phase 5B。Phase 6 只能在结构重构完成后单独立项。

## 验收标准

- [ ] 存在单一 `npm run test:agent-gateway` 聚合命令，覆盖 `tests/agent-gateway/**` 与 `tests/s01`–`s05`，本地与 CI 全部通过。
- [ ] 评审时确认的基线失败已清零：OpenAPI 生成物漂移、recall profile 测试读取运行配置、AgentRegistry 与 CapabilityService 失败均有明确修复或 fixture 隔离。
- [ ] `smoke:agent-gateway-codex-mcp` 端到端通过；依赖外部 Codex/真实服务时作为发布前人工门禁，不伪装成无依赖 CI。
- [ ] parity 测试：8 个 MCP 工具经 in-process 与 backend-proxy 两条路径调用，成功/失败 envelope（含错误码、operability 元数据字段集）逐字段一致。
- [ ] 负债登记表（01 文档 §3）每项均在 closure matrix 中标记为 `fixed`、`invalid`、`deferred` 或 `waived`，并附验证或豁免依据。
- [ ] 无单文件 >800 行、无单函数 >150 行（`publishedOpenApiDocument.js` 由生成器取代后自然达标）。
- [ ] `grep -r "require('../../../" modules/agentGateway --include=*.js` 仅命中 `composition/`。
- [ ] 对外契约冻结项（REST 路径 / 工具名 / envelope / env 名 / 规则串行语义 / 各传输 batch 接受范围）零变更，由契约测试与历史请求 corpus 守护。

## 可依赖的既有资产

- 测试：`tests/agent-gateway/`（adapters / services / policy / contracts / routes / transport / examples 分层单测）、`tests/s01`–`s05` 里程碑测试、`scripts/run-agent-gateway-codex-e2e.js`。这些是重要资产，但评审基线并非全绿，必须先完成 Phase -1。
- 契约守护：`tests/agent-gateway/contracts/agent-gateway-contract-publishing.test.js`（路径集合三方一致性）。
- 文档：`config/RECALL_PROFILES_CONFIG_GUIDE.md`、`mydoc/export/mcp/*` 设计文档。
