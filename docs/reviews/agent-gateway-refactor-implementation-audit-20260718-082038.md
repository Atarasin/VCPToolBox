# Agent Gateway 重构设计实现审计报告

## 审计元数据

- 项目：VCPToolBox / Agent Gateway
- 设计文档：`modules/agentGateway/docs/refactor/README.md`、`01-current-state-and-debt.md`、`02-target-architecture.md`、`03-implementation-plan.md`
- 评审范围：M0-M7；M8 明确排除
- 完成时间：2026-07-18 08:20:38 Asia/Shanghai
- 审计轮次：3
- 分支：`codex/agentgateway-refactor`
- Worktree：`/home/zh/projects/VCP/VCPToolBox-agentgateway-refactor`
- 总体结论：`Not compliant`

## 执行摘要

三轮审计已修复 recall/contract 单源、服务与 transport 超长函数、HTTP/WS 生命周期、Native route 组装、AJV 兼容 corpus 与 trace 全链一致性。最终自动化测试 728/728 通过，生成物无漂移，Agent Gateway 范围内没有超过 150 行的函数，也没有超过 800 行的源码文件。

仍有两个设计级偏差，因而不能判定完全符合：M4 要求只有 composition 接触宿主对象，但多个 core/service/policy/protocol 文件仍直接读取 `pluginManager`；M5 要求六个 recall stage 物理分文件，目前仍集中在 `core/recall/pipeline.js`。

## 需求追踪

| ID | 设计要求 | 最终实现证据 | 状态 |
| --- | --- | --- | --- |
| A1-A10 | MCP 错误、策略、超时、认证、discovery 行为兼容 | canonical MCP modules、timeout/auth/discovery tests | 符合 |
| B1-B4 | MCP 与 transport 公共语义 | `protocols/mcp/`、`transport/shared/`、HTTP/WS runtime | 符合 |
| B5 | 唯一 retriever 与窄端口 | retriever 已集中，但 RAG port 仍暴露 raw host objects | 部分符合 |
| B6-B9 | hot loader、normalize、budget、item key | shared policy helpers、`tokenBudget.js`、`recallItem.js` | 符合 |
| B10-B11 | canonical route 与 auth bridge | route bindings、outer auth 优先/fallback tests | 符合 |
| C1 | 大函数/文件按职责拆分 | 0 function >150；0 scoped file >800 | 符合 |
| C2-C7 | composition/ports 隔离宿主细节 | deep root require 仅在 composition，但多处仍直接读 `pluginManager` | 不符合 |
| C8-C12 | 兼容出口、LLM port、codec/logger/runtime ownership | compatibility re-export、shared MCP/transport modules | 符合 |
| D1-D2 | operation/schema 单源与 AJV | canonical JSON sources、generator、8-operation corpus | 符合 |
| D3-D4 | 唯一 audit 与 trace 全链 | shared logger；真实跨边界 trace e2e test | 符合 |
| D5 | job 持久化 | 按设计豁免，保持进程内 | 符合（豁免） |
| D6-D7 | lifecycle、背压、测试/CI | transport tests；728/728 aggregate | 符合 |
| M5.S3.T1 | 六个 stage 物理拆分 | stage 已函数化但仍位于 `core/recall/pipeline.js` | 不符合 |

## 各轮结果

| 轮次 | 修复前发现 | 已应用修改 | 验证结果 | 轮次结论 |
| --- | --- | --- | --- | --- |
| 1 | recall/contract 并非真正单源 | diary access、full-text、budget、canonical operations/schemas | 726/726 | modified |
| 2 | 多个 service/WS/backend factory 超过 150 行 | service stage、core compatibility、WS state runtime | 726/726 | modified |
| 3 | HTTP/REST 超长、trace 跨 transport 丢失、M6 corpus 不足 | HTTP runtime、route modules、trace injector/e2e、AJV corpus | 728/728 | modified，仍有结构偏差 |

## Worktree 隔离与合并

| 轮次 | 分支 | Worktree | 轮次提交 | 集成结果 | 清理状态 |
| --- | --- | --- | --- | --- | --- |
| 1 | `codex/agentgateway-refactor` | 独立 worktree | `9ad0c6e9` | 已在工作分支 | 保留供用户验收 |
| 2 | 同上 | 同上 | `0c605e3f` | 已在工作分支 | 保留供用户验收 |
| 3 | 同上 | 同上 | `a52e6390` | 已在工作分支 | 保留供用户验收 |

说明：用户约束要求不使用子代理，故未执行 skill 默认的每轮新代理/新 worktree 合并流程；所有修改始终隔离在用户指定的单一独立 worktree，原工作区未改动。

## 验证结果

| 检查 | 结果 | 说明 |
| --- | --- | --- |
| `npm run test:agent-gateway` | 728/728，0 fail | 47 个测试文件 |
| `npm run export:agent-gateway-openapi` | 通过 | JSON/YAML/MCP descriptors 可重复生成 |
| generated diff | 无差异 | canonical source 与生成物一致 |
| ESLint max-lines-per-function | 通过 | 最大 150，实际无违规 |
| scoped file size | 通过 | 最大 800 行 |
| deep root require scan | 仅 composition 命中 | C3 的 require 收口完成 |
| trace e2e | 通过 | transport/header/Native/service/operability/response/audit 同一 trace |
| Codex 真实 smoke | 未运行 | 依赖真实认证与外部服务，保留为发布前人工门禁 |

## 剩余偏差与风险

| 严重程度 | 需求 ID | 证据 | 后续行动 |
| --- | --- | --- | --- |
| Major | M4.S2/M4.S3、C2/C6 | `ports/ragRetriever.js` 暴露 raw host objects；core/service/policy/protocol 多处读取 `pluginManager` | 扩充窄 RAG port，composition 注入配置/能力快照，逐个删除宿主 duck typing |
| Major | M5.S3.T1 | 六个 stage 仍在 `core/recall/pipeline.js` | 移到 `core/recall/stages/`，保留短 orchestrator 与身份兼容测试 |
| Minor | 发布门禁 | 真实 Codex smoke 未执行 | 在具备认证的受控环境执行 `npm run smoke:agent-gateway-codex-mcp` |

## 基线变更保护

原工作区 `/home/zh/projects/VCP/VCPToolBox` 未修改。所有提交位于独立 worktree 和 `codex/agentgateway-refactor` 分支，未重置、覆盖或提交用户其他改动。

## 结论

总体结论为 `Not compliant`。行为兼容、测试、契约生成、尺寸门禁和 M7 trace 已闭合，但 M4 宿主隔离与 M5 stage 文件化是设计中的明确硬要求，必须完成后才能升级为 `Compliant`。
