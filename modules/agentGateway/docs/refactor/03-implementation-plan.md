# 03 · 实施计划（Milestone → Slice → Task）

> 这是可执行拆分稿。`Milestone` 是可发布边界，`Slice` 是可独立合并和回滚的垂直变更，`Task` 是一个明确文件/测试/验证动作。
> 负债编号对应 [01-current-state-and-debt.md](./01-current-state-and-debt.md) §3；最终状态以本文末尾 closure matrix 为准。

## 层级约定

| 层级 | 编号 | 完成定义 |
|---|---|---|
| Milestone | `M0`、`M1`… | 目标、依赖和发布门禁明确；所有子 Slice 完成并通过 milestone 验证 |
| Slice | `M#.S#` | 一个可 review、可 merge、可 revert 的垂直改动；包含实现、测试和迁移兼容 |
| Task | `M#.S#.T#` | 单一可执行动作；完成后可在 PR 或任务系统中勾选 |

原 Phase 映射：`M0=Phase -1`、`M1=Phase 0`、`M2=Phase 1`、`M3=Phase 2`、`M4=Phase 3`、`M5=Phase 4`、`M6=Phase 5A`、`M7=Phase 5B`、`M8=Phase 6（可选）`。

## Milestone 顺序

```text
M0 → M1 → M2
M2 → M3 → M7
M2 → M4 → M5
      M4 → M7
M2 → M6

M8 只能在 M5/M6/M7 完成后单独立项。
```

- `M0` 是全部后续工作的硬门槛，不允许带着已知红灯开始结构重构。
- `M3`、`M4`、`M6` 均依赖 `M2`；三者可并行，但修改同一文件时以 Slice 所有权为准。
- `M5` 依赖 `M4`；`M7` 依赖 `M3 + M4`。
- rules 并行化、HTTP/stdio batch 统一等行为变化仅属于 `M8`，不属于本轮结构重构验收。

## Milestone M0 · 可信基线与发布门禁（Phase -1）

**目标**：把“全量测试绿色”变成可重复执行的本地与 CI 门禁。

评审基线（2026-07-17）：

```text
node --test --test-concurrency=1 tests/agent-gateway/**/*.test.js tests/s*/test-*.js
684 tests / 675 pass / 9 fail
```

### Slice M0.S1 · 聚合测试入口

Tasks：

- [ ] `M0.S1.T1` 新增跨平台 `scripts/run-agent-gateway-tests.js`，递归收集 `tests/agent-gateway/**/*.test.js` 与 `tests/s01`–`s05` 测试文件，不依赖 Bash `globstar`。
- [ ] `M0.S1.T2` 在 `package.json` 暴露 `test:agent-gateway`，默认使用 `--test-concurrency=1`。
- [ ] `M0.S1.T3` 输出测试文件数、test/suite/pass/fail、耗时和 Node 版本，作为 CI artifact。

Slice 验证：同一 checkout 连续执行两次，测试集合和结果一致。

### Slice M0.S2 · 基线失败清零与 fixture 隔离

Tasks：

- [ ] `M0.S2.T1` 重新生成并核对 OpenAPI YAML/JSON，恢复 canonical document 等价测试。
- [ ] `M0.S2.T2` 将 resolver/budget 测试改读 `tests/fixtures/agent-gateway/recall_profiles.json` 或每用例临时配置，禁止读取用户运行态 `modules/agentGateway/config/recall_profiles.json`。
- [ ] `M0.S2.T3` 修复 AgentRegistry 默认 render fixture 的环境/路径依赖。
- [ ] `M0.S2.T4` 修复 CapabilityService 版本断言，使注入 `packageJson` 与 root package 两种路径各自确定。
- [ ] `M0.S2.T5` 保存基线失败到测试报告，确认 `684/684` 或当前聚合集合的实际总数全部通过。

Slice 验证：修改本地运行态 `recall_profiles.json` 后测试结果不变化。

### Slice M0.S3 · CI 与受控 smoke 门禁

Tasks：

- [ ] `M0.S3.T1` 在 `.github/workflows/ci.yml` 增加 Node test step，真实执行 `npm run test:agent-gateway`。
- [ ] `M0.S3.T2` 增加非阻断文件级并行任务，专门发现全局 env/cache 污染；不替代串行基线。
- [ ] `M0.S3.T3` 保留 `smoke:agent-gateway-codex-mcp` 作为发布前端到端门禁；依赖本机 Codex CLI/真实服务时标记为人工或受控环境任务。
- [ ] `M0.S3.T4` 验证 CI 环境前置：Node 版本、`rust-vexus-lite` 原生模块构建产物与 Python 依赖是否为聚合测试所必需；必需时在 workflow 增加构建步骤或在测试侧做可选依赖隔离，避免本地基线之外再冒出一批 CI 环境失败。

Milestone 验收：本地与 CI 均可执行聚合测试且 0 fail。关闭 D7。

## Milestone M1 · 可复现正确性与安全热修（Phase 0）

**目标**：只修已有失败测试或能先写出失败回归测试的问题；不移动文件。

### Slice M1.S1 · 错误码、超时与密钥比较

Tasks：

- [ ] `M1.S1.T1` 补齐 `mcpBackendProxyAdapter.js` 的 recall 错误码映射，对齐 canonical error mapping，覆盖 404/403/400。
- [ ] `M1.S1.T2` 为 `GatewayBackendClient.requestJson/requestEventStream` 增加 `VCP_MCP_BACKEND_TIMEOUT_MS`（默认 30000ms），用兼容 Node 20 的 helper 合成外部 signal 与 timeout signal。
- [ ] `M1.S1.T3` 让 WS/stdio dispatch 传入请求 signal，并覆盖挂起 fetch、外部 abort、正常完成和 listener 清理。
- [ ] `M1.S1.T4` 将 dedicated gateway key 双方先转为固定长度摘要，再使用 `crypto.timingSafeEqual`；保留空 key/未配置语义。
- [ ] `M1.S1.T5` 增加不同长度、空值、非 ASCII key 的 timing-safe 回归测试。

关闭：A1、A4（行为面）、A5。

### Slice M1.S2 · MCP 双路径行为对齐

Tasks：

- [ ] `M1.S2.T1` in-process harness 顶层 catch 复用 proxy 的 `sanitizeMcpErrorDetails`；先从 proxy 导出，M2 再迁入共享模块。
- [ ] `M1.S2.T2` 对齐 diary policy：proxy 补 `VCP_MCP_DEFAULT_AGENT_ID` 与 rejection `status:403`；in-process 保留显式空策略短路。
- [ ] `M1.S2.T3` 为每个 diary policy 差异补双路径回归测试，断言判定、错误码和 details 白名单一致。
- [ ] `M1.S2.T4` 补 proxy `gateway_recall_run` 的 agentId/query 前置校验。
- [ ] `M1.S2.T5` 补 proxy `gateway_memory_write` 的 idempotencyKey 多源合并。
- [ ] `M1.S2.T6` 从 GUIDE/解析器支持的结构生成通用 `recall_profiles.json.example`，禁止复制当前用户 agent/diary 数据。

关闭：A2、A8、A9、A10（行为面）。

### Slice M1.S3 · discovery 与认证债务定性

Tasks：

- [ ] `M1.S3.T1` 将 self-healing discovery session 标记为 `kind:'discovery'`，进入独立有界 LRU 池、TTL 60s，不计入正常 `maxSessions`；保留 TTL 内可复用的 session id。
- [ ] `M1.S3.T2` 池满时淘汰最旧 discovery session，不挤占正常 initialize 配额；压测验证正常 session 数和 discovery 池上限。
- [ ] `M1.S3.T3` 为原 A3 写“HTTP/WS 共享 runtime，先后关闭仍可服务”的回归测试；按预期不失败，标记 A3=`invalid`，不引入引用计数。
- [ ] `M1.S3.T4` 保留 `admin_transition` role 和 outer Admin Auth 兼容行为；补测试证明 Native transition 请求经外层认证后角色仍可用于 policy。
- [ ] `M1.S3.T5` 将 A6 记录为认证升级豁免，不修改 `roles` 生产语义。

关闭：A3=`invalid`、A6=`waived`、A7（行为面）。

Milestone 验收：`npm run test:agent-gateway` 与受控 smoke 全绿；M1 每个行为变更均有独立回归测试。

## Milestone M2 · MCP 核心去重（Phase 1）

**目标**：两个 adapter 收敛为单一 harness + 两个 executor；公共结果塑形和准入逻辑只保留一份。

### Slice M2.S1 · parity 测试护栏

Tasks：

- [ ] `M2.S1.T1` 建立 executor contract parity：同一 canonical `GatewayResult` 经 in-process/proxy executor 归一化后逐字段比较。
- [ ] `M2.S1.T2` 建立 black-box path parity：内存 Express Native routes + 真实 `GatewayBackendClient` HTTP 调用，对比 in-process service bundle。
- [ ] `M2.S1.T3` 覆盖 body/header/idempotency/auth/policy/route serialization，不接受只 mock `backendClient` 返回值的测试作为唯一护栏。
- [ ] `M2.S1.T4` 8 个 MCP 工具覆盖 success/failure/deferred；只白名单 requestId、traceId、durationMs 等动态字段。
- [ ] `M2.S1.T5` parity 测试建立即 0 豁免：M1 已完成双路径行为对齐，任何不一致必须修复，禁止以 snapshot 豁免标记带入 M2 之后的阶段。

Slice 验证：两层 parity 全绿，且失败能定位到 executor 或 Native route 边界。

### Slice M2.S2 · MCP 公共语义模块

Tasks：

- [ ] `M2.S2.T1` 新建 `protocols/mcp/constants.js`，集中协议版本、serverInfo、JSON-RPC 码、截断长度和默认上下文值。
- [ ] `M2.S2.T2` 新建 `resultShapes.js`，统一 success/failure/deferred/content 构造；failure 使用已消毒 details，operability metadata 保留完整字段集。
- [ ] `M2.S2.T3` 新建 `errorMapping.js`，维护完整 gateway → MCP 错误映射。
- [ ] `M2.S2.T4` 新建 `diaryPolicyGate.js`，将 `__defaultDiaryPolicyApplied` 替换为 `ctx.diaryPolicy.appliedDefault`。
- [ ] `M2.S2.T5` 统一 `normalizeMcpString` 的消毒语义和长度常量，关闭 B2。
- [ ] `M2.S2.T6` 新建 `harness.js`，承载 method switch、治理包裹和资源/提示词分发。
- [ ] `M2.S2.T7` 将 `readResource` 按资源类型拆为独立 handler，并为每种资源补单测。

关闭：B1、B2、B3、C4、C7（MCP 部分）。

### Slice M2.S3 · executor 与操作表迁移

Tasks：

- [ ] `M2.S3.T1` 建立 `inProcessExecutor.js` 和 `backendProxyExecutor.js`，只保留最终执行差异。
- [ ] `M2.S3.T2` 将 `executeGatewayManagedTool` if 链迁移为 `GATEWAY_OPERATIONS` 操作表。
- [ ] `M2.S3.T3` 合并 AGENT_RENDER/BOOTSTRAP 的 render operation，bootstrap 只执行后处理。
- [ ] `M2.S3.T4` 将 `mcpGatewayOperability` 的治理逻辑并入 harness，删除 proxy 重复 metadata builder。
- [ ] `M2.S3.T5` 将 A1/A2/A8/A10 的行为回归接到公共 harness 契约。

关闭：A1、A2、A8、A10、C1（MCP 部分）。

### Slice M2.S4 · 兼容入口与 descriptor 迁移

Tasks：

- [ ] `M2.S4.T1` 将 `mcpDescriptorRegistry.js` 移到 `protocols/mcp/descriptors.js`，暂保留手写 schema。
- [ ] `M2.S4.T2` 删除 descriptor 中两分支同值的死参数 `diaryRagLoopOnly`，用契约测试证明 descriptor 集合不变。
- [ ] `M2.S4.T3` 补全 `adapters/index.js` 公共出口。
- [ ] `M2.S4.T4` 旧 `mcpAdapter.js`、`mcpBackendProxyAdapter.js` 改为 re-export 壳，添加 deprecation 说明。
- [ ] `M2.S4.T5` 迁移仓库内测试和脚本引用，但保留仓库外 require 在至少一个正式版本内可用。

关闭：C8；为后续 M6 保留 descriptor 兼容边界。

Milestone 验收：旧入口、新入口、两层 parity 和 adapter 单测全绿；无长期 snapshot 豁免。

## Milestone M3 · 传输公共层（Phase 2）

**依赖**：M2。

### Slice M3.S1 · runtime provider 与公共 codec

Tasks：

- [ ] `M3.S1.T1` 落地 `slidingWindowRateLimit`、`mcpContextInjector`、`runtimeProvider`、`jsonRpcCodec`、`transportLogger`。
- [ ] `M3.S1.T2` 将共享 runtime 的创建/缓存/reset 放到进程级 provider；HTTP/WS transport 只借用，不在 `close()` reset。
- [ ] `M3.S1.T3` stdio 独立进程拥有自己的 provider，进程关闭时 reset；当前 backend client 无 dispose 资源，不引入引用计数。
- [ ] `M3.S1.T4` codec 统一 parse、notification、错误塑形和 dispatch timeout；batch 由显式 `batchPolicy` 控制。

关闭：C10、C11、C12（公共层落点）。

### Slice M3.S2 · HTTP session 与 SSE

Tasks：

- [ ] `M3.S2.T1` 从 `mcpHttpServer.js` 拆出 `sessionStore.js`，覆盖 create/find/touch/destroy/idle。
- [ ] `M3.S2.T2` 拆出 `sseStream.js`，覆盖 open/queue/heartbeat/close。
- [ ] `M3.S2.T3` SSE 背压增加 30s 超时和连接关闭中断；这是 D6 修复引入的显式行为变化（现状为可能永久挂起），须登记到兼容性检查清单并写入发布说明。
- [ ] `M3.S2.T4` 将 M1 discovery LRU/TTL 语义接入公共 session store，保持独立配额。
- [ ] `M3.S2.T5` 合并重复的 JSON-RPC/空响应 writer，统一状态码与 header 写入路径。

关闭：A7（公共层落点）、B4、D6。

### Slice M3.S3 · WS/stdio 兼容迁移

Tasks：

- [ ] `M3.S3.T1` WS 增加可配置 idle 回收，默认关闭以保持现行为（D6 的 WS 侧因此定性为"显式可配"而非行为对齐）；heartbeat 与 idle 分别测试。
- [ ] `M3.S3.T2` stdio 只保留自身 transport loop；公共 runtime/jsonRpc 职责迁出，旧导出继续 re-export 至正式 deprecation 周期结束。
- [ ] `M3.S3.T3` 三传输统一执行 `validateMcpTransport`，但保留现有 batch policy：WS 支持上限 20，HTTP/stdio 拒绝。
- [ ] `M3.S3.T4` 增加关闭顺序测试：关闭 WS 后 HTTP 已取得 harness 继续工作，任一 transport close 不 reset 共享 provider。

关闭：A4（dispatch 落点）、C10、D6。

### Slice M3.S4 · backend client 路径收口

Tasks：

- [ ] `M3.S4.T1` 将 `GatewayBackendClient` 移至 `clients/`，保留旧路径 re-export。
- [ ] `M3.S4.T2` 用 canonical route bindings/常量替代 9 个硬编码 path literal。
- [ ] `M3.S4.T3` 增加 fetch timeout、abort 和路径生成的客户端单测。

关闭：B10。

Milestone 验收：HTTP/WS/stdio transport tests 全绿；兼容性矩阵证明 batch 行为未变。

## Milestone M4 · 装配时序与 VCP 能力端口（Phase 3）

**依赖**：M2；可与 M3 并行，必须在 M5 前完成。

### Slice M4.S1 · bootstrap 生命周期

Tasks：

- [ ] `M4.S1.T1` 将 `createAgentGatewayRoutes(pluginManager)` 和生产 service bundle 首次构造移到 `loadPlugins()`、`initializeServices()` 完成之后、`app.listen()` 之前。
- [ ] `M4.S1.T2` 新建 `composition/bootstrapGateway.js`，按 `assertVcpHostReady → bind ports → create bundle → create/mount Native routes` 顺序执行。
- [ ] `M4.S1.T3` 生产路径只允许从 bootstrap 完成首次组装；保留测试用 fake ports 入口。
- [ ] `M4.S1.T4` 增加 host 未 ready 时明确失败、host ready 后成功、监听前完成 bootstrap 的启动顺序测试。

### Slice M4.S2 · ports 与 host bindings

Tasks：

- [ ] `M4.S2.T1` 新建 ragRetriever、diaryStore、toolInvoker、agentDirectory、llmCompletion 五端口。
- [ ] `M4.S2.T2` 对已启用能力校验实际宿主绑定，不接受内部继续 lazy lookup 的占位 wrapper。
- [ ] `M4.S2.T3` 对明确禁用的可选能力绑定 typed unavailable port，保持现有 capability/operation failure 语义。
- [ ] `M4.S2.T4` 新建 `composition/vcpPortBindings.js`，收口 pluginManager 探测、根级 require、RAG 私有 API 包装和魔法参数。
- [ ] `M4.S2.T5` 在 host ready 后冻结 capability snapshot；热重载若改变能力必须显式 rebuild/refresh。

关闭：C2、C3、C6、C7（宿主部分）。

### Slice M4.S3 · service 注入与 core 兼容层

Tasks：

- [ ] `M4.S3.T1` 将 `createGatewayServiceBundle` 迁入 composition，先建 ports 再注入 services；保留旧导出和 bundle cache 语义。
- [ ] `M4.S3.T2` 将 service deps 从 `pluginManager` 改为具体端口，删除重复 `getKnowledgeBaseManager/getRagPlugin`。
- [ ] `M4.S3.T3` 非 recall service 实现逐步迁入 `core/`；`services/` 保留兼容 re-export。
- [ ] `M4.S3.T4` 让 context/recall 的 late-binding 只保留到 M5 retriever 迁移前，禁止新增循环依赖。
- [ ] `M4.S3.T5` AIMemo axios 直调改经 `llmCompletionPort`；URL/env 兼容逻辑只存在于 binding。

关闭：C5、C9（传输部分）、C2/C3 的 service 面。

### Slice M4.S4 · 认证结果桥接

Tasks：

- [ ] `M4.S4.T1` server outer auth middleware 将已解析 dedicated auth 结果放入 request。
- [ ] `M4.S4.T2` Native route 优先消费 canonical request auth；独立挂载 routes 时才执行 fallback resolver。
- [ ] `M4.S4.T3` 增加 dedicated/transition auth 的 server 集成与 standalone route fixture 测试，证明只解析一次且角色兼容。
- [ ] `M4.S4.T4` 写明认证桥接的不变清单并纳入 Slice 验证：dedicated key 校验语义、`admin_transition` 角色与 role-based policy 兼容、未提供 key 时的 401 边界、standalone 挂载的 fallback 行为均不变。

关闭：B11；A6 仍为 waived，不升级认证模式。

Milestone 验收：真实启动顺序、假端口 service、server/standalone auth 三类测试全绿。

## Milestone M5 · recall 管线重组（Phase 4）

**依赖**：M4。

### Slice M5.S1 · item、去重与 budget 纯函数

Tasks：

- [ ] `M5.S1.T1` 落地 `recallItem.js` 与 `itemKey()`。
- [ ] `M5.S1.T2` 迁移 dedupe/aggregate/interleave；Map 优化不得改变稳定顺序和分数仲裁。
- [ ] `M5.S1.T3` 合并 budget 算法为 `tokenBudget.js`，projection 保留薄包装和旧导出名。
- [ ] `M5.S1.T4` 为搬家前后固定 fixture 比较 items、diagnostics、调用顺序和错误；仅排除动态 duration/trace 字段。

关闭：B8、B9。

### Slice M5.S2 · modifiers 与 retrievers

Tasks：

- [ ] `M5.S2.T1` 将 timeDecay、roleValve、base64Memo、truncate、aiMemo 拆为注册表化 modifier。
- [ ] `M5.S2.T2` 将 AIMemo presets 移至配置文件，保留未知 preset 回退和诊断字段。
- [ ] `M5.S2.T3` 将 `collectRagItems` 及其专属 helper（候选：normalizeRagItem、getFileMetadata/getCachedFileMetadata、deduplicateRagCandidates、computeCosineSimilarity、getQueryVector、extractCoreTags、normalizeTimestampValue、deriveTimestampFromPath、buildRecallQuery、listDiaryTargets 等，迁移前须列出精确清单）搬至唯一 `ragRetriever.js`；`defaultFullTextRetriever` 搬至 `fullTextRetriever.js`。search/context 共用的 normalize/selection helper 保留在 context 侧或落 `policy/shared/normalize.js`。
- [ ] `M5.S2.T4` 两个 retriever 共用 `resolveDiaryAccess()`；删除重复 normalize/config/403 分支。
- [ ] `M5.S2.T5` 增加真实共享 backend spy，断言同一时刻只执行一条 rule。
- [ ] `M5.S2.T6` 验证迁移后 `contextRuntimeService.js` 单文件 <800 行（README 验收硬指标）；超出时继续拆分编排段，不得以"勉强达标"收尾。

关闭：B5、C9（preset 部分）、C1（recall 部分）。

### Slice M5.S3 · stage 编排

Tasks：

- [ ] `M5.S3.T1` 拆出 resolveProfile、precomputeVector、executeRules、mergeResults、applyBudget、applyAiMemo 六个 stage。
- [ ] `M5.S3.T2` 将 `executeRecall` 降为 <150 行编排器，保留 pipelineStages/ruleDiagnostics/modifierDetails 结构。
- [ ] `M5.S3.T3` 保持现有 for-loop rules 串行顺序，不引入 `Promise.all`。
- [ ] `M5.S3.T4` 使用隔离 fixture 运行 `tests/s01`–`s05`，禁止重新依赖运行态配置。
- [ ] `M5.S3.T5` 落地 `policy/shared/hotJsonConfigLoader.js`，让 recall profile 与 MCP memory policy 共享 mtime 热加载、解析失败回退和缓存语义。
- [ ] `M5.S3.T6` 落地 `policy/shared/normalize.js`，收口 normalizeString/StringArray/parseBoolean/parseJsonObject。

关闭：B6、B7、C5、C7（recall 部分）。

### Slice M5.S4 · 历史导出与迁移兼容

Tasks：

- [ ] `M5.S4.T1` 从新模块 re-export `buildRagOptionsFromModifiers` 等历史 runtime/projection 导出，保持 `tests/s01`–`s05` 和仓库外引用可用。
- [ ] `M5.S4.T2` `services/recallRuntimeService.js` 与 `services/recallProjectionService.js` 保留兼容壳，并添加 deprecation 说明。
- [ ] `M5.S4.T3` 增加旧路径/新路径导出集合与函数身份兼容测试；至少跨一个正式版本后再评估删除。

Milestone 验收：固定 profile + fake ports 的 items/diagnostics snapshot 与重构前一致；无并行行为变更。

## Milestone M6 · Operation Catalog 与契约生成（Phase 5A）

**依赖**：M2；可与 M5 并行，但不得同时修改同一 descriptor/export 文件。

### Slice M6.S1 · canonical operation 与 schema

Tasks：

- [ ] `M6.S1.T1` 固定唯一手写源为 `contracts/operations/` + `contracts/schemas/`。
- [ ] `M6.S1.T2` 为每个 canonical operation 定义 operationId、args/result schema、错误集合、REST method/path/parameter locations、MCP tool/prompt/resource binding 和必要后处理。
- [ ] `M6.S1.T3` 维护业务 schema 与协议 envelope schema；同一 operation 不按 REST/MCP 复制业务形状。
- [ ] `M6.S1.T4` 明确 JSON Schema → OpenAPI 3.0.3 转换规则，覆盖 `nullable`、example/examples 和 unsupported keywords；OpenAPI 3.1 另行决策。

关闭：D1（模型部分）、D2（schema 模型部分）。

### Slice M6.S2 · AJV 兼容校验

Tasks：

- [ ] `M6.S2.T1` 添加显式顶层 ajv 依赖并锁定 CommonJS 兼容版本。
- [ ] `M6.S2.T2` gateway 托管 operation 使用 `coerceTypes:false`、`useDefaults:false`、`removeAdditional:false`。
- [ ] `M6.S2.T3` 逐 operation 用合法/非法历史请求 corpus 决定 `additionalProperties`、format、pattern、enum 约束。
- [ ] `M6.S2.T4` 保留插件“猜测 schema”的宽松路径，不让 AJV 改变插件工具行为。

Slice 验证：未知字段、数值字符串、空值、enum 边界的历史判定不变。

### Slice M6.S3 · descriptor/OpenAPI 生成与门禁

Tasks：

- [ ] `M6.S3.T1` 从 catalog 生成 MCP descriptors 与 OpenAPI paths/components。
- [ ] `M6.S3.T2` 将 `publishedOpenApiDocument.js`、OpenAPI JSON/YAML 和 descriptor 模块作为生成产物提交仓库；运行时不维护第二套 canonical 生成逻辑。
- [ ] `M6.S3.T3` 让 `scripts/exportAgentGatewayOpenApi.js` 只调用生成器，`info.version` 取 root packageJson。
- [ ] `M6.S3.T4` 增加 catalog/binding/path/tool 集合、请求响应 schema、生成物无 diff 测试。
- [ ] `M6.S3.T5` 对旧/新 descriptors 与 OpenAPI 做字段级 diff，逐项标记 `expected correction` 或 `regression`。

关闭：D1、D2、C1（descriptor/OpenAPI 部分）。

Milestone 验收：CI 重生成文档后 `git diff --exit-code`，客户端示例和 parity fixture 全绿。

## Milestone M7 · Audit 与 Trace 基础设施（Phase 5B）

**依赖**：M3 + M4。

### Slice M7.S1 · audit sink 与唯一实例

Tasks：

- [ ] `M7.S1.T1` 将 `createAuditLogger({ sinks })` 接入 console sink 和可选 file sink。
- [ ] `M7.S1.T2` 由 composition 注入唯一实例，删除 service 内兜底 `createAuditLogger()`。
- [ ] `M7.S1.T3` 明确 file sink 的目录创建、追加失败降级、敏感字段过滤和进程关闭 flush。
- [ ] `M7.S1.T4` 若不实现轮转，文档明确由外部 logrotate/容器日志驱动负责。

关闭：D3。

### Slice M7.S2 · trace 全链路

Tasks：

- [ ] `M7.S2.T1` REST/MCP 入站读取或生成 traceId，放入 requestContext。
- [ ] `M7.S2.T2` 删除 operabilityService 每操作自造的不相关 traceId，改用 requestContext trace。
- [ ] `M7.S2.T3` 让 transport log、operation control、audit event、MCP metadata、Native response header 共享同一 traceId。
- [ ] `M7.S2.T4` backend-proxy HTTP 显式转发 trace header，并增加跨边界一致性测试。
- [ ] `M7.S2.T5` sink 失败不影响业务响应；敏感 key/token 不进入 audit fields。

关闭：D4。

### Slice M7.S3 · job 范围决策

Tasks：

- [ ] `M7.S3.T1` 将 D5 标记为 `waived`：本轮不添加未使用的 `store` 注入位。
- [ ] `M7.S3.T2` 在文档记录跨进程 job 需求出现时需单独设计状态模型、持久化和多实例一致性。

关闭：D5=`waived`。

Milestone 验收：一次 MCP backend-proxy 调用从 transport → Native route → service → audit 的 traceId 全链相同；sink 故障可观察且不破坏业务响应。

## Milestone M8 · 性能与协议行为优化（Phase 6，可选）

**前置**：M5、M6、M7 全部完成；不计入本轮结构重构验收。

### Slice M8.S1 · rules 有界并发

Tasks：

- [ ] `M8.S1.T1` 以真实 KnowledgeBaseManager/sqlite、reranker、LLM 限流压测建立串行基线。
- [ ] `M8.S1.T2` 引入有界并发，默认并发度 1，并提供 env/配置回滚开关。
- [ ] `M8.S1.T3` 验证输出顺序、诊断语义、资源压力和失败重试行为。

### Slice M8.S2 · HTTP/stdio batch 支持

Tasks：

- [ ] `M8.S2.T1` 单独更新协议契约、资源上限和 notification 组合语义。
- [ ] `M8.S2.T2` 增加三传输客户端兼容测试和旧客户端回退策略。
- [ ] `M8.S2.T3` 评审通过后再改变 HTTP/stdio 当前拒绝 batch 的默认行为。

### Slice M8.S3 · transport lifecycle 行为调整

Tasks：

- [ ] `M8.S3.T1` 评估 WS idle 默认值和统一 session lifecycle。
- [ ] `M8.S3.T2` 将运维行为变更与文件拆分分开发布并提供回滚开关。

## 横切门禁

### Milestone 发布门禁

- [ ] 所有子 Slice 的 Task 完成，并有对应测试/生成物/文档证据。
- [ ] `npm run test:agent-gateway` 0 fail；受控 smoke 按发布环境通过。
- [ ] Slice 间依赖未被跨越；同一文件的并行 Slice 有明确 owner。
- [ ] closure matrix 中每个负债为 `fixed`、`invalid`、`deferred` 或 `waived`，无空状态。

### 兼容性检查清单

- [ ] 15 个 REST 路径、method、请求/响应 envelope 不变。
- [ ] 8 个 MCP 工具名、prompt/resource 名和 inputSchema 接受语义不变。
- [ ] HTTP/stdio 仍拒绝 batch，WS 仍支持上限 20。
- [ ] recall rules 保持串行和稳定输出顺序。
- [ ] 显式行为变化逐条登记并写入发布说明：SSE 长连接背压挂起 30s 后中断并清理（M3.S2.T3）；discovery session 改独立 LRU 池、60s TTL，不再占用 `maxSessions`（M1.S3）；WS idle 回收新增可配开关、默认关闭（M3.S3.T1）。
- [ ] 所有既有 env 名有效；新增 env 有默认值且默认行为不变。
- [ ] `recall_profiles.json` / `mcp_agent_memory_policy.json` 格式与 mtime 热加载不变。
- [ ] scripts、ecosystem、Docker 启动方式不变。
- [ ] 旧模块路径至少跨一个正式版本 re-export，并带 deprecation 说明。

### Slice 回滚策略

- [ ] 每个 Slice 的实现、测试和生成物变更在独立提交或可独立 revert 的提交组内。
- [ ] `M4.S1` 启动时序改造先于 `M4.S2` 端口严格校验，二者可分别 revert。
- [ ] `M6.S3` 生成物变更独立提交；回滚时保留 operation catalog 与旧生成物的一致性检查。
- [ ] 旧 adapter/client/module 路径在 deprecation 周期内持续 re-export，紧急回滚不要求同步修改仓库外 require 点。
- [ ] 无法先写出失败测试的生产改动不得进入 M1；行为变化不得混入 M2–M7。

## 债务关闭矩阵

| 负债 | 计划状态 | Milestone / Slice / 依据 |
|---|---|---|
| A1 | fixed | M1.S1 + M2.S2/M2.S3：单一码表与 proxy 回归 |
| A2 | fixed | M1.S2 + M2.S2：行为对齐与单一 diary gate |
| A3 | invalid | M1.S3：关闭顺序回归证明旧 harness 仍可服务 |
| A4 | fixed | M1.S1 + M3.S1/M3.S3：timeout/abort 归位 |
| A5 | fixed | M1.S1：固定长度摘要 + timingSafeEqual |
| A6 | waived | M1.S3：transition auth 保持兼容，认证升级独立立项 |
| A7 | fixed | M1.S3 + M3.S2：独立短 TTL discovery 池 |
| A8 | fixed | M1.S2 + M2.S2：sanitize 与共享 result shape |
| A9 | fixed | M1.S2：通用 example 与维护约定 |
| A10 | fixed | M1.S2 + M2.S3：行为对齐与 executor contract |
| B1 | fixed | M2.S2/M2.S3：公共 MCP 语义与 executor |
| B2 | fixed | M2.S2.T5：统一消毒 normalize |
| B3 | fixed | M2.S2/M2.S3：单一 operability metadata |
| B4 | fixed | M3.S1/M3.S2：公共 transport 层 |
| B5 | fixed | M4.S3 + M5.S2：ports 与唯一 retriever |
| B6 | fixed | M5.S3.T5：shared hot JSON loader |
| B7 | fixed | M5.S3.T6：shared normalize helpers |
| B8 | fixed | M5.S1.T3：单一 token budget |
| B9 | fixed | M5.S1.T1/T2：itemKey 与 Map 去重 |
| B10 | fixed | M3.S4：canonical route bindings |
| B11 | fixed | M4.S4：复用 outer auth 结果，standalone fallback |
| C1 | fixed | M2.S3 + M5.S3 + M6.S3：按职责拆分 |
| C2 | fixed | M4.S2/M4.S3：ports/composition |
| C3 | fixed | M4.S2：根级依赖收口 |
| C4 | fixed | M2.S2.T4：显式 `ctx.diaryPolicy` |
| C5 | fixed | M4.S3 + M5.S2：消除 late-binding |
| C6 | fixed | M4.S2：RAG 私有 API 只在 binding 包装 |
| C7 | fixed | M2.S2 + M4.S2 + M5.S2：常量与绑定集中 |
| C8 | fixed | M2.S4.T3–T5：公共出口与兼容 re-export |
| C9 | fixed | M4.S3.T5 + M5.S2.T2：llm port 与 presets |
| C10 | fixed | M3.S1/M3.S3：单一 codec + 显式兼容 batch policy |
| C11 | fixed | M3.S1：结构化 transport logger |
| C12 | fixed | M3.S1/M3.S3：runtime provider 与所有权边界 |
| D1 | fixed | M6.S1/M6.S3：operation catalog 与生成器 |
| D2 | fixed | M6.S1/M6.S2：schema 模型与兼容 AJV |
| D3 | fixed | M7.S1：唯一 audit logger 与 sinks |
| D4 | fixed | M7.S2：trace 全链路 |
| D5 | waived | M7.S3：当前无跨进程 job 需求 |
| D6 | fixed | M3.S2/M3.S3：SSE 背压超时与 HTTP/stdio lifecycle 修复；WS idle 为显式可配、默认关闭保持现行为 |
| D7 | fixed | M0.S1–M0.S3：聚合测试与 CI |

## 建议排期

| Milestone | 原 Phase | 单人预估 | 并行说明 |
|---|---|---|---|
| M0 | -1 | 2–4 天 | 必须先完成 |
| M1 | 0 | 2–3 天 | 每个 Slice 独立提交 |
| M2 | 1 | 5–8 天 | parity Slice 可先行；接触面最大，已含 30% 缓冲 |
| M3 | 2 | 3–5 天 | 依赖 M2 |
| M4 | 3 | 4–6 天 | 可与 M3 并行，M4.S1 先于 M4.S2 |
| M5 | 4 | 7–10 天 | 依赖 M4，保持串行降低风险；已含 30% 缓冲 |
| M6 | 5A | 4–6 天 | 依赖 M2，可与 M5 并行但隔离 descriptor 文件所有权 |
| M7 | 5B | 2–4 天 | 依赖 M3+M4 |
| M8 | 6（可选） | 单独评估 | 不计入本轮排期 |

单人约 6–8 周（M2/M5 已含 30% 缓冲，其余阶段无缓冲）。两人并行时，一人负责 M2→M3→M7，另一人负责 M4→M5；M6 在 descriptor 文件所有权明确后穿插。M8 不计入结构重构排期。

## 完成度量

- 两个 adapter 的公共语义只存在于 `protocols/mcp/`；旧文件仅为兼容 re-export。
- recall 编排器 <150 行，各 stage/modifier/retriever 单文件建议 <300 行；文件阈值不是拆出无意义包装器的理由。
- OpenAPI 与 MCP descriptors 可由 operation catalog 确定性生成，CI 生成后无 diff。
- `grep -rn "require('../../../" modules/agentGateway --include=*.js` 仅命中 `composition/`。
- parity 0 豁免；聚合测试与 CI 0 fail；closure matrix 无未标状态项。
