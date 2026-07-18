# 设计实现审计报告

## 审计元数据

- 项目：VCPToolBox — `modules/agentGateway/` 重构（M0–M7）
- 设计文档：`modules/agentGateway/docs/refactor/README.md`、`01-current-state-and-debt.md`、`02-target-architecture.md`、`03-implementation-plan.md`、`04-implementation-closure.md`
- 评审范围：当前代码是否实现 M0–M7 全部 Milestone/Slice/Task（M8 按设计不在本轮范围）
- 开始时间：2026-07-18 19:15 (CST)
- 完成时间：2026-07-18 20:25 (CST)
- 审计轮次：2（Cycle 1 `modified` → Cycle 2 `clean`，收敛停止）
- 基线：`main @ 0d790ab8`（审计前 HEAD，upstream 为 `origin/main`）
- 总体结论：`Compliant with limitations`

## 执行摘要

M0–M7 的全部里程碑经两个相互独立的审计 cycle 确认已在代码层面实现：聚合测试实测 731/731 通过（三个不同时点各跑一次均绿）、OpenAPI/MCP 描述符重生成零 diff、无单文件 >800 行 / 无单函数 >150 行、15 个 REST 路径与 8 个 MCP 工具名冻结、`require('../../../` 深层引用仅命中 `composition/`、债务关闭矩阵 41 项逐项抽查均有代码证据。闭合报告（04）中的各项声明全部属实。

Cycle 1 发现并修复 3 处偏差：1 处 major（`createMcpAdapter` 实测 169 行，违反"无单函数 >150 行"验收门禁，与闭合声明不符）与 2 处 minor（M2 死参数 `diaryRagLoopOnly` 的调用点残留、M7 迁移残留的死 import）。修复经全量测试复验后合并回 `main`。Cycle 2 以全新会话、全新 worktree 对集成后的代码重新独立审计，结论为 `clean`，审计收敛。

剩余限制均为 minor/observation，见"剩余偏差与风险"：`gateway_agent_render` 双路径行为分叉（重构前既有行为，已被 catalog 与测试显式固化，对齐需设计层决策）、`core/recall/` 目录扁平化（相对 02 文档的子目录设计仅命名层面差异）、C4 遗留字段的防御性兼容读取、主检出 `node_modules` 中 ajv 实装版本与 lockfile 漂移（环境问题，仓库 lockfile 正确）。真实 Codex MCP 冒烟测试未运行（依赖外部认证，为文档约定的发布前人工门禁）。

## 需求追踪

| ID | 设计要求 | 来源 | 最终实现证据 | 状态 |
| --- | --- | --- | --- | --- |
| REQ-M0 | 可信基线与发布门禁：聚合测试入口、fixture 隔离、CI 门禁 | 03 文档 M0 | `scripts/run-agent-gateway-tests.js`；`package.json:7` `test:agent-gateway`；`.github/workflows/ci.yml:51` 串行基线 step + `:63-64` 非阻断并行污染诊断 + TAP artifact；`tests/fixtures/agent-gateway/recall_profiles.json` 被 resolver/budget 测试引用，全 tests/ 无运行态配置读取；实测 731/731 | 符合 |
| REQ-M1 | 正确性与安全热修：错误码、超时、密钥比较、diary 对齐、discovery 池、认证兼容 | 03 文档 M1 | `protocols/mcp/errorMapping.js:7-30` 单一码表覆盖全部 RECALL_* 码；`clients/GatewayBackendClient.js:126-127` `VCP_MCP_BACKEND_TIMEOUT_MS` 默认 30000 + AbortSignal 合成；`contracts/protocolGovernance.js:10-12` sha256 定长摘要 + `timingSafeEqual`；`diaryPolicyGate.js:33,67`；`transport/http/sessionStore.js` 独立 LRU 池 TTL 60s 不占 maxSessions；`admin_transition` 兼容测试 3 文件；`recall_profiles.json.example` 通用占位符 | 符合 |
| REQ-M2 | MCP 核心去重：单一 harness + 语义模块 + 双 executor + 操作表 + parity 0 豁免 + 旧入口兼容壳 | 03 文档 M2 | `protocols/mcp/`（harness/constants/resultShapes/errorMapping/diaryPolicyGate/inProcessExecutor/backendProxyExecutor）；`contracts/operations/index.js:27` `GATEWAY_OPERATIONS` 深冻结表（实现采用 catalog 驱动，语义等价）；黑盒双路径 parity 测试（真实 HTTP vs in-process），全 tests/agent-gateway 无 skip/todo 豁免；旧 `adapters/mcpAdapter.js`/`mcpBackendProxyAdapter.js` 各 4 行 re-export 壳；descriptor 无 `diaryRagLoopOnly`（Cycle 1 清除调用点残留后） | 符合 |
| REQ-M3 | 传输公共层：shared 五模块、session/SSE 拆分、背压超时、batch 语义不变、client 路径收口 | 03 文档 M3 | `transport/shared/`（slidingWindowRateLimit/mcpContextInjector/runtimeProvider/jsonRpcCodec/transportLogger）；`transport/http/sessionStore.js`、`sseStream.js:37` 30s 背压超时；`mcpWebSocketServer.js:203` idle 可配默认 0（关闭）；batch：HTTP/stdio reject、WS allow 上限 20；`clients/GatewayBackendClient.js:221-277` 全部使用 `AGENT_GATEWAY_ROUTE_BINDINGS` | 符合 |
| REQ-M4 | 装配时序与 VCP 能力端口：bootstrap 生命周期、五端口 fail-fast、认证桥接 | 03 文档 M4 | `server.js:1605→1614→1617→1748`（loadPlugins→initializeServices→bootstrapGateway→listen）；`composition/bootstrapGateway.js`（assertVcpHostReady→bindVcpPorts→bundle→mount）；`ports/` 五端口 + `ragRetriever.js:24` 缺绑定即抛 + `Object.freeze` snapshot；`server.js:733,880` 写入 `req.agentGatewayAuth`，standalone fallback 保留；深层 require 仅命中 composition | 符合 |
| REQ-M5 | recall 管线重组：六 stage、短编排器、串行 rules、共享 loader/normalize、兼容壳 | 03 文档 M5 | `core/recall/pipeline.js` 71 行 + `stages/` 六模块；`stages/executeRules.js:189` 串行 for 无 `Promise.all`；`policy/shared/hotJsonConfigLoader.js` 与 `normalize.js` 被双 policy 复用；`services/recallRuntimeService.js`/`recallProjectionService.js` 为函数身份 re-export 壳（有身份测试） | 符合 |
| REQ-M6 | 契约单源：operations/schemas/generate、ajv 顶层依赖、生成零 diff | 03 文档 M6 | `contracts/operations|schemas|generate/` 为唯一手写源；`package.json:45` `"ajv": "^8.20.0"`；`schemas/validator.js:4` `coerceTypes:false,useDefaults:false,removeAdditional:false`；实测 `node scripts/exportAgentGatewayOpenApi.js` 后 `git status` 零 diff；`info.version` 取自 root packageJson（`generate/index.js:12`） | 符合 |
| REQ-M7 | audit 与 trace 基础设施：唯一 audit 实例 + sinks、trace 全链贯通、D5 waived | 03 文档 M7 | `infra/auditLogger.js` console/file sink + 敏感字段 REDACTED + sink 错误隔离 + flush；`composition/createGatewayServiceBundle.js:80-82` 唯一创建点（`AGENT_GATEWAY_AUDIT_FILE`）；`backendProxyExecutor.js:350` 显式转发 `x-agent-gateway-trace-id`；e2e 测试断言 transport→Native→service→audit 同一 traceId；D5 waived 见 04 文档 :43 | 符合 |
| REQ-X1 | 横切规模门禁：无单文件 >800 行、无单函数 >150 行 | README 验收标准 | 实测：范围内最大文件 785 行；启发式全量扫描无 >150 行函数（Cycle 1 修复后复测，Cycle 2 独立复测一致） | 符合 |
| REQ-X2 | 契约冻结：15 REST 路径、8 MCP 工具名、batch 语义、串行 rules | README/03 兼容性清单 | `PUBLISHED_NATIVE_GATEWAY_PATHS` 恰 15 条；8 个 MCP 操作名与冻结清单一致（catalog 测试 `agent-gateway-operation-catalog.test.js:14` 断言）；batch 与串行语义见 REQ-M3/M5 | 符合 |
| REQ-X3 | 债务关闭矩阵：每项有 fixed/invalid/deferred/waived 状态及证据 | 03 文档矩阵 | 41 项全部有状态；两轮审计抽查 A1–A10/B10/C4/C8/D3–D7 等均有代码证据，未发现空状态或虚标 | 符合 |

## 各轮结果

| 轮次 | 修复前发现 | 已应用修改 | 验证结果 | 轮次结论 |
| --- | --- | --- | --- | --- |
| Cycle 1 | 1 major（`createMcpAdapter` 169 行超门禁）+ 2 minor（死参数调用点残留、死 import） | 4 文件（见"已应用修改"） | 修改后全量 731/731、OpenAPI 生成零 diff、行数门禁实测达标 | `modified`（已集成） |
| Cycle 2 | 0 可执行偏差；4 项 minor/observation 留存（见"剩余偏差与风险"） | 无 | 全量 731/731、生成零 diff、全部结构门禁复核通过 | `clean`（收敛） |

## Worktree 隔离与合并

| 轮次 | 临时分支 | Worktree 路径 | 轮次提交 | 合并结果 | 合并后验证 | 清理状态 |
| --- | --- | --- | --- | --- | --- | --- |
| Cycle 1 | `audit/agent-gateway-refactor/20260718-191515/cycle-1` | `/tmp/audit-design-implementation/VCPToolBox-20260718-191515/cycle-1` | `2868c0cf` | `--no-ff` 合并，merge commit `ff8240cd` | 原工作区全量 731/731 通过，`git status` 干净，cycle 提交为 main 祖先 | worktree 已删除，分支已删除（`-d` 安全删除） |
| Cycle 2 | `audit/agent-gateway-refactor/20260718-191515/cycle-2` | `/tmp/audit-design-implementation/VCPToolBox-20260718-191515/cycle-2` | 无（clean cycle，无提交） | 无合并（no-op 集成） | worker 实跑全量 731/731；协调者核实分支未偏离 main | worktree 已删除，分支已删除 |
| Report | `audit/agent-gateway-refactor/20260718-191515/report` | `/tmp/audit-design-implementation/VCPToolBox-20260718-191515/report` | 本报告提交 | `--no-ff` 合并回 main | 合并后 `git status` 干净 | worktree 与分支已清理 |

所有 cycle 均在独立 worktree + 全新 worker 会话中执行；worker 未获得前序 cycle 的任何结论。

## 已应用修改

| 文件或模块 | 行为变更 | 需求 ID | 轮次 |
| --- | --- | --- | --- |
| `modules/agentGateway/protocols/mcp/backendProxyExecutor.js` | 删除传给无参 `createGatewayManagedToolDescriptors()` 的死实参 `{ diaryRagLoopOnly: true }`（无行为变化） | REQ-M2 | Cycle 1 |
| `modules/agentGateway/core/recall/ragRetriever.js` | 删除未使用的 `createAuditLogger` import（无行为变化） | REQ-M7 | Cycle 1 |
| `modules/agentGateway/protocols/mcp/inProcessExecutor.js` | 内联 `callTool`（44 行）改为调用 `callMcpTool`，`createMcpAdapter` 169→141 行、文件 798→770 行 | REQ-X1 | Cycle 1 |
| `modules/agentGateway/protocols/mcp/inProcessOperations.js` | 新增 `callMcpTool`（59 行，逐行保持原实现语义，经 DI 注入 executor 本地 helper） | REQ-X1 | Cycle 1 |

行为保持性由协调者独立复核：抽取前后 `normalizeMcpString` 为同一消毒实现（`sanitizeRequestContextValue`，默认 128），原方法未使用 `this`，默认参数语义不变；全量测试修改前后均 731/731。

## 验证结果

| 命令或检查 | 结果 | 轮次 | 说明 |
| --- | --- | --- | --- |
| `npm run test:agent-gateway` | 731/731，0 fail（~12.5s） | Cycle 1（修改前后）、合并后原工作区、Cycle 2 | 共 4 次独立运行全绿 |
| `node scripts/exportAgentGatewayOpenApi.js` 后 `git status`/`git diff` | 零 diff | Cycle 1、Cycle 2 | OpenAPI JSON/YAML 与 MCP descriptors 均为确定性生成产物 |
| `grep -rn "require('../../../" modules/agentGateway --include=*.js` | 仅命中 `composition/`（3 文件） | Cycle 1、Cycle 2 | M4 门禁 |
| 文件/函数行数扫描 | 最大文件 785 行；无 >150 行函数 | Cycle 1（修复后）、Cycle 2 | 验收硬指标 |
| 15 REST 路径 / 8 MCP 工具名 | 与冻结清单一致 | Cycle 1、Cycle 2 | catalog 测试机器断言 |
| 全 tests/agent-gateway skip/todo 扫描 | 0 命中 | Cycle 2 | parity 无豁免 |
| 基线对照（`git show 6dd7435d~1:…`） | agent_render 分叉为重构前既有行为 | Cycle 2 | 避免将既有契约误判为回归 |

## 剩余偏差与风险

| 严重程度 | 需求 ID | 证据 | 未解决原因 | 后续行动 |
| --- | --- | --- | --- | --- |
| minor | REQ-M2 | `gateway_agent_render` 经 `tools/call` 调用时 in-process 执行 render、backend-proxy 拒绝（`inProcessExecutor.js:584` vs `backendProxyExecutor.js:585-590`）；为 2026-04 起既有基线行为，catalog 显式标 `publishedAsTool:false`，约 10 处测试固化 | 对齐双侧语义属设计层决策（需改 ~10 个测试），超出"无歧义修复"范围 | 在设计文档补充显式豁免说明，或单独立项统一双侧拒绝语义 |
| minor | REQ-M5 | 02 文档设计 `core/recall/retrievers/`、`modifiers/` 子目录，实现为扁平 `ragRetriever.js`/`fullTextRetriever.js`/`modifiers.js` | 实质"唯一实现"目标已达成，迁移仅命名层面收益且波及大量 import 与身份兼容壳 | 下次涉及这些文件时顺势迁移 |
| minor | REQ-M1 | `services/contextRuntimeService.js:143` 保留 `body.__defaultDiaryPolicyApplied` 兼容读取（主路径已是 `ctx.diaryPolicy.appliedDefault`） | 防御性回退，供仓库外旧调用方兼容 | 跨一个正式版本后评估删除 |
| observation | REQ-M6 | 主检出 `node_modules` 实装 ajv 6.15.0，与 `package.json` `^8.20.0` / lockfile 8.20.0 不符 | 本地环境漂移，非仓库问题；lockfile 正确，CI `npm ci` 不受影响 | 在主检出执行 `npm install` 同步本地依赖 |
| info | REQ-M0 | 真实 Codex MCP 冒烟（`smoke:agent-gateway-codex-mcp`）未运行 | 依赖外部认证/本机 Codex CLI | 按文档约定作为发布前人工门禁执行 |

## 基线变更保护

审计开始时 `main` 工作区完全干净（`git status` 为空）；审计流程未回退、改写或覆盖任何用户变更。两处流程事项如实披露：

1. 审计进行期间，用户在主检出并行写入并暂存了其自有的新设计文档 `modules/agentGateway/docs/agent-integration/README.md`（Agent 客户端集成方案，属用户的后续实现计划）。协调者一度将其误判为 Cycle 2 worker 的越权产物并移出仓库（移动前已完整备份，内容无损失）；经用户指正后，已将该文档恢复原路径与暂存状态（`git status` 中恢复为 `A`）。该文档为用户所有，未纳入本审计的任何提交，也不属于本审计的修改范围。
2. 为使 cycle worktree 能复用主检出的 `node_modules`（以只读符号链接接入，测试不修改其内容），向 `.git/info/exclude` 追加了一行 `/node_modules`（本地 ignore，不影响任何跟踪文件，worktree 移除后该行对主检出无实际作用）。

## 结论

**`Compliant with limitations`** — `modules/agentGateway/` 当前代码真实实现了设计文档定义的 M0–M7 全部里程碑，全部自动化门禁实测通过，Cycle 1 修复的 3 处偏差已集成并复验，Cycle 2 独立复审确认无可执行偏差。

无需用户立即决策的阻塞项；建议的后续工程工作（均非本轮验收阻塞）：agent_render 双路径语义的设计层裁决、`core/recall/` 子目录命名迁移、遗留兼容字段的版本化清理、主检出执行一次 `npm install` 消除 ajv 环境漂移、发布前执行真实 Codex 冒烟人工门禁。
