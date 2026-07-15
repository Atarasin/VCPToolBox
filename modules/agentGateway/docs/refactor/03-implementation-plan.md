# 03 · 实施计划

> 每个阶段独立可发布：阶段结束时 `tests/agent-gateway/**`、`tests/s01`–`s05` 全绿，对外契约零变化。
> 负债编号（A1…D6）对应 [01-current-state-and-debt.md](./01-current-state-and-debt.md) §3。

## Phase 0 · 止血热修（先于一切结构改动）

**目标**：修掉已确认的行为 bug 与安全缺陷，全部最小 diff，不动文件结构。

| 步骤 | 改动 | 关闭负债 |
|---|---|---|
| 0.1 | `mcpBackendProxyAdapter.js:203-219` 的 `mapGatewayFailureToMcpErrorCode` 补齐 8 个 recall 错误码 case（对齐 `mcpAdapter.js:94-123`） | A1 |
| 0.2 | `GatewayBackendClient.requestJson/requestEventStream` 增加默认超时（`VCP_MCP_BACKEND_TIMEOUT_MS`，默认 30000ms，`AbortSignal.timeout` 与外部 signal 合成）；WS/stdio dispatch 传入 signal | A4 |
| 0.3 | `mcpStdioServer.js` runtime 单例改引用计数（`acquire/release`），HTTP/WS/stdio `close()` 只 release；归零才 shutdown | A3 |
| 0.4 | `protocolGovernance.js:163` 改 `crypto.timingSafeEqual`（长度对齐后比较） | A5 |
| 0.5 | in-process harness 顶层 catch（`mcpAdapter.js:1472-1479`）接入 proxy 版的 `sanitizeMcpErrorDetails`（临时从 proxy 文件导出复用，Phase 1 再归位） | A8 |
| 0.6 | 对齐 diary 策略两版的**判定结果**：给 proxy 版补 `VCP_MCP_DEFAULT_AGENT_ID` 兜底与 rejection `status:403`；给 in-process 版补显式空策略短路（与 proxy `:500-505` 相同语义）。两版逻辑仍是两份（Phase 1 合并），但行为先对齐 | A2（行为面） |
| 0.7 | proxy 版 `gateway_recall_run` 补 agentId/query 前置校验；`gateway_memory_write` 补 idempotencyKey 多源合并（对照 in-process 版） | A10 |
| 0.8 | 重新生成 `config/recall_profiles.json.example`（从当前 schema/GUIDE 对齐），并在 GUIDE 顶部注明 example 的维护约定 | A9 |
| 0.9 | HTTP 自愈发现 session：discovery 方法（`SELF_HEAL_DISCOVERY_METHODS`）改为免 session 直接处理（不建 session、不占配额），或建不计入 `maxSessions` 的短 TTL（60s）匿名会话——二选一，倾向前者 | A7 |
| 0.10 | `resolveDedicatedGatewayAuth` 未认证分支的 `roles` 改为 `[]`，`admin_transition` 只保留在 `authMode` 字段（先 grep 确认无下游读该 roles 值做判断；有则记录并保持，留到认证升级） | A6 |

**验证**：
- 新增回归测试：proxy 路径 recall 错误码断言（404/403/400 各一例）；runtime 双持有关闭顺序测试；backend fetch 超时测试（mock 挂起服务器）。
- 全量既有测试 + `smoke:agent-gateway-codex-mcp`。

**风险**：0.6/0.9/0.10 涉及行为语义，需在 PR 描述中逐条列出行为变化点供人工确认。0.10 最可能有隐蔽消费方，先只做调查、确认安全再改。

## Phase 1 · MCP 核心去重（protocols/mcp/）

**目标**：两个 adapter → 单一 harness + 两个 executor。这是全方案的枢纽阶段。

步骤：
1. **建立 parity 测试先行**（护栏先于重构）：`tests/agent-gateway/adapters/mcp-parity.test.js`——同一 fixture 请求（8 工具 × 成功/失败/deferred 各态）分别打 in-process harness 与 backend-proxy harness（后者 mock backendClient 指向内存 REST fixture），断言 envelope 逐字段一致（除 meta.requestId 等白名单字段）。首次运行允许对 Phase 0 之后仍存在的已知差异打 snapshot 豁免标记，随重构逐个删除豁免。
2. 新建 `protocols/mcp/`：
   - `constants.js`：协议版本、serverInfo、JSON-RPC 码、截断长度、`'mcp-session'`/`'127.0.0.1'` 默认值（C7 的 MCP 部分）；
   - `resultShapes.js`：从两 adapter 中选定实现并迁移 success/failure/deferred/content 构造器（B1），failure 以 proxy 版（含 sanitize）为准、operability 元数据以 in-process 版字段集（含 category/retryable）为准；
   - `errorMapping.js`：in-process 版全码表（A1 最终归位）；
   - `harness.js`：`createMcpHarness({ executor, listTools, listResources, readResource, getPrompt })`，method switch 唯一实现；
   - `diaryPolicyGate.js`：合并两版 `applyAgentDiaryPolicy*`（A2 最终归位），`__defaultDiaryPolicyApplied` 改为 ctx 上的显式字段 `ctx.diaryPolicy = { appliedDefault: true }` 并同步修改 service 端读取点（C4）。
3. `executeGatewayManagedTool` if 链 → `GATEWAY_OPERATIONS` 操作表；RENDER/BOOTSTRAP 合并（C1 部分）。
4. `mcpAdapter.js` 瘦身为 `inProcessExecutor.js` + 资源读取实现；`mcpBackendProxyAdapter.js` 瘦身为 `backendProxyExecutor.js` + `normalizeNativeResult`。旧文件保留为 re-export 壳（`createMcpAdapter`/`createBackendProxyMcpServerHarness` 名字不变），待 Phase 2 后删除。
5. `mcpGatewayOperability.js` 并入 harness 的表驱动治理；proxy 版同名 `buildOperabilityMetadata` 删除（B3）。
6. `adapters/index.js` 桶导出补全或随目录迁移废弃（C8）。
7. `mcpDescriptorRegistry.js` 移动为 `protocols/mcp/descriptors.js`，删除死参数 `diaryRagLoopOnly`（`:476-480` 两分支同值）；311 行 schema 硬编码保留到 Phase 5 再换生成。

**验证**：parity 测试全部豁免清零；`tests/agent-gateway/adapters/*` 改指新入口后全绿；`readResource` 拆分后（每资源类型一个 handler）单测覆盖。

**风险**：这是接触面最大的阶段。缓解：老入口名保持 re-export；分两个 PR（先 resultShapes/errorMapping/constants 提取——纯搬家；再 harness/executor 重组）。

## Phase 2 · 传输公共层（transport/shared/）

依赖：Phase 1（传输只面对单一 harness 工厂）。

步骤：
1. `transport/shared/` 落地五件套：`slidingWindowRateLimit`、`mcpContextInjector`、`runtimeHandle`（Phase 0.3 的引用计数实现归位于此）、`jsonRpcCodec`（统一 parse/batch/notification/超时语义，batch 三传输统一支持、上限 20）、`transportLogger`（结构化 stderr，带 sessionId/requestId）（B4、C10、C11）。
2. `mcpHttpServer.js` 767 行闭包拆分：`sessionStore.js`（create/find/touch/destroy/idle 定时器）、`sseStream.js`（open/queue/heartbeat/close，背压加 30s 超时兜底，D6）、主文件只剩路由 handler。`writeJsonRpcResponse/writeEmptyResponse` 合并。
3. WS 增加 idle 回收（复用 sessionStore 的 idle 语义或独立计时，与 HTTP 同 env 语义 `VCP_MCP_WS_SESSION_IDLE_MS`，默认关闭以保持现行为，文档标注）。
4. `mcpStdioServer.js` 剥离 `initializeBackendProxyMcpRuntime/shutdownBackendProxyMcpRuntime/createJsonRpcErrorResponse` 公共职责至 shared；stdio 文件只剩自身传输。旧导出名 re-export 一个版本周期。
5. `validateMcpTransport` 在三传输统一生效。
6. `GatewayBackendClient` 移至 `clients/`，9 个硬编码路径改引 `PUBLISHED_NATIVE_GATEWAY_PATHS`（B10）。

**验证**：`tests/agent-gateway/transport/*`、`adapters/agent-gateway-mcp-http/websocket.test.js` 全绿；新增：三传输 batch 行为一致性测试、WS/stdio 超时中断测试、双传输独立关闭测试。

## Phase 3 · VCP 能力端口层（ports/ + composition/）

依赖：无硬依赖，可与 Phase 2 并行；建议在 Phase 4 之前完成。

步骤：
1. 新建 `ports/` 五端口（ragRetriever/diaryStore/toolInvoker/agentDirectory/llmCompletion），构造时 fail-fast 校验 + `capabilities()`。
2. 新建 `composition/vcpPortBindings.js`：现散布在 `contextRuntimeService.js:265-297`、`recallRuntimeService.js:246-265`、`capabilityService.js:100-115`、`agentRegistryService.js:4-5`、`mcpAdapter.js:581-585` 的宿主探测/lazy require/私有 API 调用全部搬入（C2、C3、C6）。`1.33` 系数、TAG_BOOST 等魔法值连注释集中于此（C7 剩余部分）。
3. `createGatewayServiceBundle` 迁入 `composition/`，签名不变（仍接收 pluginManager），内部先建 ports 再注入各 service；`__agentGatewayServiceBundle` 缓存机制保留。
4. 各 service 的 deps 从 `pluginManager` 改为具体端口；`getKnowledgeBaseManager/getRagPlugin` 四份删除；recall/context 的 late-binding 闭包（C5）随依赖改为 ports 后消解。
5. AIMemo 的 axios 直调改经 `llmCompletionPort`（绑定处保留现 env 读取 `AIMemoUrl/Api/Model` 与 url 拼接约定，C9 的传输部分）。

**验证**：`tests/agent-gateway/services/*` 改用假端口 fixture（这也会显著简化现有测试的 mock 体量）；一条"绑定完整性"测试：真实 pluginManager 形状 fixture → 端口构造全部成功。

**风险**：端口切面若切得过细会制造新形式主义——以"每端口对应一个真实宿主组件"为界（RAGDiaryPlugin→ragRetriever、KnowledgeBaseManager→diaryStore、Plugin.js→toolInvoker、agentManager+messageProcessor→agentDirectory），不为纯函数建端口。

## Phase 4 · recall 管线重组（core/recall/）

依赖：Phase 3（stage/retriever 依赖 ports）。

步骤（按提交切分）：
1. **纯函数搬家**：`recallItem.js`（item 形状 + `itemKey()`）落地；`deduplicateItems/aggregateDeduplicateItems/interleaveItems` 迁入并以 itemKey 重写（interleave 的 O(n²) find 改 Map，B9）；`applyBudgetPostProcessing` 与 `projectBudgetedContextBlocks` 合并为 `tokenBudget.js`（B8，projection 保留薄包装以维持导出名）。
2. **modifiers 拆分**：`modifiers/{timeDecay,roleValve,base64Memo,truncate,aiMemo}.js` 注册表化（含 stage 声明），`applyS02Modifiers` 改为注册表驱动；AIMemo 提示词预设移至 `config/aimemo_presets/`（C9）。
3. **retrievers 拆分**：`collectRagItems` 从 contextRuntimeService **搬家**至 `retrievers/ragRetriever.js`（成为唯一实现，contextRuntimeService 改为调用方）；`defaultFullTextRetriever` 迁入 `retrievers/fullTextRetriever.js`；两者共用新的 `resolveDiaryAccess()`（B5 的准入块合并）。B5 其余重复 helper（normalize 系、getRagConfig 系）在此阶段随迁移自然删除，落点为 `policy/shared/normalize.js` 与 ports。
4. **stages 拆分**：`executeRecall` 按 §02-3.4 的六 stage 拆分，编排器 <150 行；rules 执行改 `Promise.all` 并行（保序输出，diagnostics 结构不变）。
5. `policy/shared/hotJsonConfigLoader.js` 落地，`recallProfileResolver` 与 `mcpAgentMemoryPolicy` 改用（B6、B7）。
6. `recallRuntimeService.js` 旧导出名（`buildRagOptionsFromModifiers` 等 20+ 个被测试引用的导出）由新模块 re-export 保持不破坏 `tests/s01`–`s05`。

**验证**：
- `tests/s01`–`s05` 全绿是硬门槛（它们直接测 resolver/runtime/projection 内部行为）；
- 新增各 stage/modifier/retriever 单测；
- 一条端到端快照：固定 profile + 固定假端口数据 → `executeRecall` 输出（items+diagnostics）与重构前 snapshot 一致（rules 并行化后 durationMs 字段从比对中排除）；
- 并行化单独一个提交，可独立回滚。

**风险**：这是行为回归风险最高的阶段。缓解：搬家（1-3 步）与重组（4 步）分 PR；每步以"输出 snapshot 不变"守护；并行化如引发 RAG 后端并发问题（KnowledgeBaseManager 的 sqlite 访问），退回串行并记录原因。

## Phase 5 · 契约单源与基础设施

依赖：可与 Phase 3/4 并行（不触碰 service 内部）。

步骤：
1. `contracts/schemas/` 落地 8 个 gateway 工具 + 15 个 REST 端点的 JSON Schema（从现 descriptorRegistry 硬编码与 openApi 文档中提取合并，以实际路由行为为准逐个核对）。
2. 引入 ajv（锁 CommonJS 兼容版本）：gateway 托管工具入参改 ajv 校验；插件工具保留 `schemaRegistry` 猜测路径不变（D2）。
3. `contracts/generate/`：schema → MCP descriptors（替换 `descriptors.js` 311 行硬编码）与 → OpenAPI 文档；`publishedOpenApiDocument.js` 改为生成产物或直接由 `scripts/exportAgentGatewayOpenApi.js` 即时生成（D1）；`info.version` 取 packageJson。
4. 契约测试升级：路径三方一致（保留）+ descriptor/schema 同源断言 + 关键响应样例 schema 校验。
5. `infra/auditLogger` sinks 化，组装根注入唯一实例，删除三处兜底 `createAuditLogger()`（D3）；可选文件 sink（`AGENT_GATEWAY_AUDIT_FILE`）。
6. trace 贯通：REST 与 MCP 入口读/生成 traceId 放入 requestContext；operabilityService 改用 infra/trace；audit 与 operability 元数据共享 traceId（D4）。删除 `infra/trace.js` 中零调用的死代码或使其被真正使用。
7. （登记不实施）D5 jobRuntimeService 持久化：本轮只在 `createJobRuntimeService(deps)` 预留 `store` 注入位。

**验证**：`test:agent-gateway-contracts` 升级版全绿；导出的 OpenAPI 与旧文档 diff 人工评审一次（字段级差异需逐条确认是"修正"而非"回归"）。

## 横切事项

### 测试策略汇总
- **不动**：`tests/s01`–`s05`（行为基准）、契约测试路径断言。
- **新增**：parity 测试（Phase 1，之后常驻）、超时/关闭顺序回归（Phase 0/2）、stage/modifier/port 单测（Phase 3/4）、schema 同源断言（Phase 5）。
- **重写成本**：`tests/agent-gateway/services/*` 的 mock 会因 ports 变薄（Phase 3），属改善型重写。

### 兼容性承诺（每 PR 检查清单）
- [ ] 15 个 REST 路径、请求/响应 envelope 不变
- [ ] 8 个 MCP 工具名、inputSchema 语义不变（Phase 5 生成后需 diff 确认）
- [ ] `config.env` 所有既有 env 名有效；新增 env 均有默认值且默认行为与现状一致
- [ ] `recall_profiles.json` / `mcp_agent_memory_policy.json` 格式与热加载语义不变
- [ ] `scripts/start-agent-gateway-mcp-server.js`、`ecosystem.config.js`、docker 启动方式不变
- [ ] 旧模块导出名在删除前至少保留一个版本周期的 re-export

### 回滚策略
- Phase 0 每条独立提交，可单条 revert。
- Phase 1/2/4 的"搬家提交"与"重组提交"分离；重组提交均以 snapshot/parity 测试守护，revert 单个 PR 即可回到上一稳定点。
- 旧文件以 re-export 壳保留到下一阶段末，紧急情况下外部 require 点无需改动即可回退。

### 建议排期与人力

| 阶段 | 预估 | 可并行性 |
|---|---|---|
| Phase 0 | 2–3 天 | — |
| Phase 1 | 4–6 天 | parity 测试可先行 1 天 |
| Phase 2 | 3–4 天 | 依赖 P1 |
| Phase 3 | 3–4 天 | 可与 P2 并行 |
| Phase 4 | 5–8 天 | 依赖 P3 |
| Phase 5 | 3–5 天 | 可与 P3/P4 并行 |

合计约 4–5 周单人节奏；若两人并行（一人 P1→P2 协议线，一人 P3→P4 内核线，P0 与 parity 先行合作完成），约 3 周。

### 完成后的度量核对（对应 README 验收标准）
- 代码量预期：两 adapter 2519 行 → executor 双体约 600–800 行 + protocols/mcp 共享约 500 行（净删约 1200 行）；recallRuntimeService 1770 行 → 编排器 + stages/modifiers/retrievers 合计约 1400 行但单文件均 <300 行；openApi 1821 行手写 → schema 源 + 生成器。
- `grep -rn "require('../../../" modules/agentGateway --include=*.js` 仅命中 `composition/`。
- parity 测试 0 豁免。
