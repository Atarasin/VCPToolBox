# 01 · 现状架构与技术负债登记

> 原始调查基于 2026-07-09 的代码状态（分支 main）；2026-07-17 评审复核后修正 A3/A6 定性并补充测试基线。为保持跨文档引用稳定，撤销项仍保留原编号。

## 1. 现状架构全景

### 1.1 分层与调用链

```
外部消费方
├─ REST 客户端 ──────────► /agent_gateway/*  (routes/agentGatewayRoutes.js, 15 端点)
│                             │ getGatewayServiceBundle(pluginManager)
│                             ▼
│                        [service bundle]  ← in-process 直调
│
└─ MCP 客户端 (Trae/Codex/Claude…)
   ├─ Streamable HTTP ──► mcpHttpServer.js  (POST/GET/DELETE /mcp + /mcp/sse 兼容)
   ├─ WebSocket ────────► mcpWebSocketServer.js  (upgrade /mcp)
   └─ stdio ────────────► mcpStdioServer.js  (独立进程, scripts/start-agent-gateway-mcp-server.js)
        三者共享 ▼
     createBackendProxyMcpServerHarness  (adapters/mcpBackendProxyAdapter.js)
        │  GatewayBackendClient —— HTTP 回环
        ▼
     /agent_gateway/*  ──► [service bundle]     ← 即 MCP 默认是"代理回环"
```

另存在一条 in-process MCP 路径：`adapters/mcpAdapter.js` 的 `createMcpServerHarness` 直调 service bundle，主要用于测试/嵌入场景。**同一 MCP 语义因此有两份完整实现**。

### 1.2 service bundle（`createGatewayServiceBundle.js:65-163`）

一次性构建、缓存在 `pluginManager.__agentGatewayServiceBundle`（`:70,140`）：

| service | 行数 | 职责 |
|---|---|---|
| `capabilityService` | 415 | 能力清单（tools/memoryTargets）聚合 |
| `agentRegistryService` | 609 | Agent 档案 / prompt 模板渲染（依赖 `agentManager` + `messageProcessor`） |
| `jobRuntimeService` | 352 | 异步 job 状态机（**纯内存**，无持久化） |
| `memoryRuntimeService` | 701 | 记忆写入（经 `processToolCall('DailyNote', …)`） |
| `contextRuntimeService` | 1336 | rag/search 与 rag/context 主流程；导出 `collectRagItems`（`:596-825`） |
| `toolRuntimeService` | 494 | 普通插件工具执行（审批、schema 校验、job 化） |
| `operabilityService` | 457 | 限流 / 并发 / 载荷治理 |
| `recallRuntimeService` | 1770 | recall profile 编译执行（RAG 核心） |
| `recallProjectionService` | 335 | 结果投影（items / blocks / fullTextSections / budget） |

注意 `recallRuntimeService` 与 `contextRuntimeService` 的**late-binding 循环依赖**：`createGatewayServiceBundle.js:98-106` 中 context 服务经 `getRecallRuntimeService: () => recallRuntimeService` 闭包取尚未创建的 recall 服务，而 recall 服务又 `require` context 服务的 `collectRagItems`（`recallRuntimeService.js:3`）。

### 1.3 RAG/recall 链路（本次重构重点）

```
MCP gateway_recall_run / REST POST /agent_gateway/recall/run
  → recallRuntimeService.executeRecall()            recallRuntimeService.js:1198-1735 (~537 行)
      1. recallProfileResolver.resolveForAgent()    policy/recallProfileResolver.js:363-550
         · 读 config/recall_profiles.json（mtime 热加载 :81-116）
         · agent 别名 → profile 选择 → S04 前置校验（rule/modifier/diary 错误码）
      2. 预计算 query 向量                           :1265-1284
         · ragPlugin.getSingleEmbeddingCached / EmbeddingUtils 兜底
      3. 逐 rule 执行（for 循环 :1295-1558）
         · roleValve 表达式预门控 → gated_rag 概念向量余弦门控（evaluateGate :612-642）
         · full_text → defaultFullTextRetriever :293-392
         · rag      → contextRuntimeService.collectRagItems :1457-1467
             └ KnowledgeBaseManager.search + tagBoost + timeAware + groupAware + rerank
         · S02 后处理 modifiers（timeDecay/roleValve/base64Memo/truncate）applyS02Modifiers :893-953
         · per-rule aiMemo（LLM 摘要，axios 直调 :825-891）
      4. merge（interleave / score 排序 + aggregate 去重）:1560-1635
      5. budget 后处理（tokenBudget/maxTokenRatio/minScore）:1637-1655
      6. profile 级 aiMemo :1657-1684
  → recallProjectionService.projectFullResult()      投影为对外结构
```

RAG 本体在网关之外：`Plugin/RAGDiaryPlugin/RAGDiaryPlugin.js`（embedding、语义组、时间解析、rerank）与根级 `KnowledgeBaseManager.js`（向量检索、tagBoost、去重）。网关经 `pluginManager.messagePreprocessors.get('RAGDiaryPlugin')` 与 lazy `require('../../../KnowledgeBaseManager')` 访问。

### 1.4 策略与认证

- **凭据校验**在 `contracts/protocolGovernance.js:142-169`（`resolveDedicatedGatewayAuth`，明文 `===` 比对 `:163`）；未提供密钥时降级 `admin_transition` 回落 Admin Basic Auth（`server.js:687-704, 738-756`）。
- **authContextResolver**（`policy/authContextResolver.js:45-129`）只做身份归一化，不做验证。
- **diary 准入**三源合一（`policy/agentPolicyResolver.js resolveDiaryScopes :141-212`）：`mcp_agent_memory_policy.json` > `agentPolicyMap` > rag 配置/环境变量，默认拒绝。
- **工具准入**默认全开（`resolveToolScopes :235-241` 缺省 `allowAllTools:true`）——与 diary 默认拒绝方向相反。

### 1.5 外部消费面（冻结契约）

- REST：15 路径清单 `contracts/protocolGovernance.js:9-25`，路由 `routes/agentGatewayRoutes.js:421-1373`。
- MCP 工具：8 个名字 `adapters/mcpDescriptorRegistry.js:9-18`。
- 装配点：`server.js:118-119,125,526-541,1458,1549,1717-1726`；stdio 入口 `scripts/start-agent-gateway-mcp-server.js`。
- 配置：`config.env` 的 `AGENT_GATEWAY_KEY/ID`、`VCP_MCP_HTTP_*`、`VCP_MCP_WS_*`、`VCP_MCP_BACKEND_*`、`VCP_MCP_DEFAULT_AGENT_ID`。
- 依赖方向：agentGateway 单向依赖 `modules/agentManager`、`modules/messageProcessor` 与根级 RAG 组件；**无同级模块反向依赖**（重构自由度高）。

### 1.6 评审时测试与装配基线（2026-07-17）

- 全量执行 `node --test --test-concurrency=1 tests/agent-gateway/**/*.test.js tests/s*/test-*.js`：共 684 tests，675 pass，9 fail；并行执行结果相同。
- 失败集中在四类：已导出的 OpenAPI YAML/JSON 与 canonical document 漂移；recall profile 测试直接读取当前 `config/recall_profiles.json`；AgentRegistry 默认渲染用例；CapabilityService 版本断言。
- 根 `npm test` 只运行 `tests/rag-params/*.test.js`，不存在 Agent Gateway 全量聚合命令；`.github/workflows/ci.yml` 的 validate job 只执行 `npm ci`，不运行测试。
- Native 路由在 `server.js:1506` 创建并触发 service bundle 构造，宿主插件直到 `server.js:1594` 才加载。目标端口若在 bundle 构造期验证 RAG 插件，必须先调整这一装配时序。

## 2. 负债形成机制（为什么会这样）

模块按里程碑（S01→S05）快速演进，每次扩展一条新链路（native REST → in-process MCP → backend-proxy MCP → 三种传输）时，直接复制上一条链路的实现再修改。复制体随后各自演化，产生漂移。`index.js:2-3` 的注释（"按里程碑逐步补齐"）与 git 历史（`553c8d6e` "重构召回配置结构"、`79da8cdc` "S04标准化"）均可佐证。

## 3. 技术负债登记表

分级：**A=行为 bug/安全**（必须修；评审撤销项除外）、**B=结构性重复**（漂移温床）、**C=可维护性**（巨型文件/隐式契约）、**D=基础设施缺口**。

### A 类：正确性与安全

| # | 条目 | 证据 | 影响 |
|---|---|---|---|
| A1 | proxy adapter 丢失全部 recall 错误码映射：`RECALL_NO_PROFILE/FORBIDDEN/INVALID_*` 等 8 个码在 `mapGatewayFailureToMcpErrorCode` 中无 case，全部降级 `RUNTIME_ERROR` | `mcpBackendProxyAdapter.js:203-219` vs `mcpAdapter.js:94-123` | stdio/HTTP/WS 三种 MCP 传输（默认走 proxy）上 recall 语义错误全部失真；客户端无法区分 404/403/400 |
| A2 | diary 策略两版漂移：proxy 版有"策略全空直接放行"短路（`:500-505`），in-process 版无；in-process 版有 `VCP_MCP_DEFAULT_AGENT_ID` 兜底（`:441`），proxy 版无；rejection 的 `status` 字段一有一无 | `mcpAdapter.js:431-514` vs `mcpBackendProxyAdapter.js:489-571` | 同一 agent 同一 diary 请求，两条链路准入结论可能不同——策略执行面分叉 |
| A3 | **评审后撤销原行为 bug 结论**：`shutdownBackendProxyMcpRuntime()` 只清空模块级引用；HTTP/WS 各自保留已取得的 `runtimeContext.harness`，且 `GatewayBackendClient` 当前无 close/dispose 资源。清空单例后旧 harness 仍可响应 | `mcpStdioServer.js:50-91`；`mcpHttpServer.js:393-420`；`mcpWebSocketServer.js:284-313` | 不存在“另一传输静默失效”的已证实行为。所有权命名和重复初始化可能性改登记为 C12；未出现失败测试前不进入热修 |
| A4 | harness 调用与后端回环 fetch 无超时：WS/stdio 未传 AbortSignal，`GatewayBackendClient.requestJson` 无默认 timeout；两者的消息队列是串行 promise，一次挂起 → 后续请求全部阻塞 | `mcpWebSocketServer.js:424,532`；`mcpStdioServer.js:149,165`；`GatewayBackendClient.js:111-123` | 后端一次网络抖动可使 WS 连接/stdio 进程永久卡死 |
| A5 | 网关密钥非常量时间比较（`providedGatewayKey === config.gatewayKey`） | `protocolGovernance.js:163` | 时序侧信道；需先将两侧转换为固定长度摘要再使用 `crypto.timingSafeEqual`，避免不同长度输入抛错或提前返回 |
| A6 | **评审后重新定性**：Native 未提供 dedicated key 时会先经外层 Admin Basic/Cookie 鉴权，`admin_transition` 表达的是过渡认证身份，并非简单“未认证”；直接清空 roles 会改变 role-based policy。真正问题是外层鉴权结果未作为显式状态传给 gateway | `server.js:683-882`；`protocolGovernance.js:142-169`；`authContextResolver.js:81-110` | 不做局部 roles 热修；与 B11 合并为认证边界债务，本轮在“不升级认证体系”约束下显式豁免并保留既有行为 |
| A7 | HTTP 自愈发现（无 session 的 `tools/list` 等自动建临时 session）占用 `maxSessions` 名额，需等 idle（默认 10min）回收 | `mcpHttpServer.js:40-45,870-889` | 可被无 session 发现请求刷爆至 503 |
| A8 | in-process harness 顶层 catch 直接透传 `error.details`（可能含 stack），proxy 版有 `sanitizeMcpErrorDetails` 白名单 | `mcpAdapter.js:1472-1479` vs `mcpBackendProxyAdapter.js:66-101,1010-1018` | 两链路错误暴露面不对等；in-process 有信息泄露风险 |
| A9 | `recall_profiles.json` 与 `.example` 已漂移（example 落后） | `config/recall_profiles.json` vs `.example`（diff 不同） | 新部署照 example 配置会与文档行为不符 |
| A10 | proxy 版 `gateway_memory_write` 缺 idempotencyKey 多源合并；`gateway_recall_run` 缺 agentId/query 前置校验 | `mcpBackendProxyAdapter.js:759-778` vs `mcpAdapter.js:984-1018,1033-1050` | 同一调用两链路行为不一致 |

### B 类：结构性重复（漂移温床）

| # | 条目 | 证据 |
|---|---|---|
| B1 | 两个 MCP adapter 拷贝约 15+ 个助手：`MCP_ERROR_CODES`、`createMcpError`、`serializeMcpValue`、`createMcpTextContent`、deferred/success/failure envelope 构造器、`buildJsonRpcError`、`buildMcpInitializeResult`（instructions 文案已漂移）、harness `handleRequest` switch（逐字相同）、`normalizeDiarySelectionArgs`、`buildBootstrapSummary/Result`（逐字节相同） | `mcpAdapter.js:44-91,125-363,1383-1484` ↔ `mcpBackendProxyAdapter.js:23-163,165-350,958-1021`；对照明细见调查记录 |
| B2 | `normalizeMcpString` 同名不同义：in-process 版走 `sanitizeRequestContextValue`（消毒），proxy 版裸 `trim+slice` | `mcpAdapter.js:54-56` vs `mcpBackendProxyAdapter.js:44-53` |
| B3 | `buildOperabilityMetadata` 同名不同签名不同语义（2 参算 category/retryable vs 1 参挑 3 字段） | `adapters/mcpGatewayOperability.js:70-87` vs `mcpBackendProxyAdapter.js:221-227` |
| B4 | HTTP/WS server 间逐字重复：`checkRateLimit`（`mcpHttpServer.js:306-326` ↔ `mcpWebSocketServer.js:166-186`）、`resolveHarness`（`:393-420` ↔ `:284-313`）、`injectSessionContext`/`injectConnectionContext`（`:260-304` ↔ `:188-229`）、`createSession/ConnectionContext`（`:234-258` ↔ `:77-99`）、`hasOwn/isPlainObject/resolvePositiveInteger` 等工具（`:47-66` ↔ `:37-50,107-111`） | 见左 |
| B5 | recall 与 context 两 service 重复实现同一批函数：`normalizeString(Array)`、`getBridgeConfig`、`getRagConfig`、`buildAgentAliases`、`resolveAllowedDiaries`、`listDiaryTargets`、`computeCosineSimilarity`、`getQueryVector`、`normalizeConversationMessages`、403 拒绝分支 | `recallRuntimeService.js:33-244,566-595` ↔ `contextRuntimeService.js:36-376`；`defaultFullTextRetriever` 的 diary 准入块（`recallRuntimeService.js:302-363`）与 `collectRagItems` 开头（`contextRuntimeService.js:607-684`）结构逐段对应 |
| B6 | policy 层 mtime 缓存加载逻辑逐行同构两份 | `mcpAgentMemoryPolicy.js:118-151` ↔ `recallProfileResolver.js:81-116` |
| B7 | 字符串归一化工具在 policy 三个文件各写一遍 | `mcpAgentMemoryPolicy.js:16-28`、`agentPolicyResolver.js:10-22`、`recallProfileResolver.js:41-53` |
| B8 | budget 裁剪算法两份：`applyBudgetPostProcessing` 与 `projectBudgetedContextBlocks` 主体循环相同 | `recallRuntimeService.js:957-1013` ↔ `recallProjectionService.js:196-270` |
| B9 | 去重 key（`sourceDiary::sourceFile::text` 三元组拼接）在 4 处内联重复，interleave 分支内还做 O(n²) 的 `deduped.find` | `recallRuntimeService.js:1017-1031,1055-1090,1575-1611` |
| B10 | `GatewayBackendClient` 硬编码 9 个 `/agent_gateway/...` 路径字面量，未复用 `PUBLISHED_NATIVE_GATEWAY_PATHS` 常量表 | `GatewayBackendClient.js:167-223` vs `protocolGovernance.js:9-25` |
| B11 | 路由层与网关内双份鉴权中间件（同样的 `provided && !authenticated → 401`） | `server.js:687-704` ↔ `routes/agentGatewayRoutes.js:390-419` |

### C 类：可维护性

| # | 条目 | 证据 |
|---|---|---|
| C1 | 巨型函数：`executeRecall` ~537 行（`recallRuntimeService.js:1198-1735`）、`executeGatewayManagedTool` ~283 行 8 分支 if 链（`mcpAdapter.js:811-1094`，其中 AGENT_RENDER/BOOTSTRAP 两块 `:824-900` 几乎逐字重复）、`createGatewayManagedToolDescriptors` ~311 行（`mcpDescriptorRegistry.js:170-481`，参数 `diaryRagLoopOnly` 为死参数 `:476-480`）、`createMcpHttpServer` 闭包 ~767 行（`mcpHttpServer.js:328-1095`）、`readResource` ~124 行（`mcpAdapter.js:1255-1379`） |
| C2 | 对 `pluginManager` 的鸭子类型访问散布各 service：`messagePreprocessors.get('RAGDiaryPlugin')`、`vectorDBManager \|\| knowledgeBaseManager \|\| openClawBridge.…` 多级 `\|\|` 回退（`contextRuntimeService.js:265-297`、`recallRuntimeService.js:246-265`、`capabilityService.js:100-115`）；adapter 层直接深挖 `pluginManager.agentManager.agentMap`（`mcpAdapter.js:581-585`） |
| C3 | lazy `require('../../../…')` 逃逸依赖注入：`KnowledgeBaseManager`（`contextRuntimeService.js:276`）、`RAGDiaryPlugin`（`:291`）、`EmbeddingUtils`（`:840`、`recallRuntimeService.js:1188`）、`agentManager`/`messageProcessor` 单例兜底（`agentRegistryService.js:4-5`） |
| C4 | 隐式协议：`__defaultDiaryPolicyApplied` 标记塞进 args（`mcpAdapter.js:510`），proxy 版不产生（`mcpBackendProxyAdapter.js:563-570`）；`adapterAppliedDefaultDiaryPolicy` 参数贯穿 recall/context 调用链无类型声明 |
| C5 | late-binding 循环依赖：bundle 组装时 recall/context 互相引用需要闭包 hack | `createGatewayServiceBundle.js:98-106,133-137`；`recallRuntimeService.js:3` |
| C6 | RAG 深层私有 API 依赖：直接调 `ragPlugin._rerankDocuments`、`_getTimeRangeFilePaths`、`enhancedVectorCache` 等下划线成员 | `contextRuntimeService.js:753,789`；`recallRuntimeService.js:599` |
| C7 | 魔法值散落：`'127.0.0.1'`（`mcpAdapter.js:1013,1221`）、`'mcp-session'`（`mcpBackendProxyAdapter.js:406,573,594`）、协议版本 `'2025-06-18'` 两处（`mcpAdapter.js:1401`、`mcpBackendProxyAdapter.js:183`）、JSON-RPC 码 `-32601/-32000` 裸写、截断长度 256/128/64、`collectRagItems` 中的 `1.33` 系数（`contextRuntimeService.js:731`）、baseK=5 内联（`recallRuntimeService.js:1422`） |
| C8 | `adapters/index.js` 桶导出名不副实（只导出 `mcpAdapter`，proxy adapter 被 `mcpStdioServer.js:4-5` 绕过直取）；`contracts/index.js:1-5` 未导出 openApi 文档 |
| C9 | AIMemo 提示词/预设（约 60 行中文模板）硬编码在 runtime service 内，axios 直调 LLM，`${config.url}v1/chat/completions` 依赖 url 尾斜杠约定 | `recallRuntimeService.js:769-891` |
| C10 | 三传输批处理行为不一致：WS 支持 batch（`mcpWebSocketServer.js:441-476`），HTTP/stdio 拒绝（`mcpHttpServer.js:174-180`、`mcpStdioServer.js:139-144`）；`validateMcpTransport` 只在 WS 路径生效（`mcpWebSocketServer.js:495`） |
| C11 | 日志不成体系：`writeStderr` 签名两版（`mcpHttpServer.js:381-386` 单参 vs `mcpWebSocketServer.js:56-62` 双参）；无级别、无 requestId/sessionId 关联字段 |
| C12 | backend-proxy runtime 的创建/缓存放在 `mcpStdioServer.js`，HTTP/WS 又各自声明 `ownsRuntime`；当前不会使既有 harness 失效，但所有权边界与进程级关闭职责不清，清空缓存后可重复初始化 | `mcpStdioServer.js:10-13,50-91`；`mcpHttpServer.js:366-379,1071-1090`；`mcpWebSocketServer.js:263-282,667-697` |

### D 类：基础设施缺口

| # | 条目 | 证据 |
|---|---|---|
| D1 | 手写 1821 行 OpenAPI 文档：无运行时端点、`contracts/index.js` 未导出、契约测试只校验路径集合与 schema 存在性（`tests/.../agent-gateway-contract-publishing.test.js:47-113`）、`info.version` 硬编码 `'1.0.0'`（`publishedOpenApiDocument.js:274`）与 `x-vcp-version` 双版本并存 |
| D2 | schema 校验手写且松：`validateToolSchemaValue`（`toolRuntimeService.js:44-103`）不支持 enum/format/pattern；schema 来源是从插件中文说明正则"猜"出（`schemaRegistry.js:7-70`）；缺省 `additionalProperties:true`（`:274-277`）；全仓无 ajv |
| D3 | 审计日志仅 `console.log`（`auditLogger.js:8-13`），无持久化/轮转/采样；三个 service 各有 `createAuditLogger()` 兜底实例（`memoryRuntimeService.js:411` 等），审计流可能分裂 |
| D4 | trace 未贯通：`infra/trace.js` 的 `reuseRequestId/createTraceMeta` 零调用方；`operabilityService.js:41-43` 自造 `createTraceId`；traceId 每操作随机生成（`:270`），不接入 `x-request-id` / `x-agent-gateway-trace-id`（头已在 `protocolGovernance.js:35` 定义但未用） |
| D5 | `jobRuntimeService` 纯内存，进程重启 job 丢失、多实例不可用（当前可接受，登记备查） |
| D6 | HTTP 有 session idle 回收（`mcpHttpServer.js:478-486`），WS 无 idle 回收只有 ping/pong（`mcpWebSocketServer.js:315-345`），stdio 两者皆无——回收策略三态不一致；SSE 背压 `await drain` 可能永久挂起（`mcpHttpServer.js:542-543`） |
| D7 | Agent Gateway 全量测试无单一 npm 命令、未接入 CI，且评审基线已有 9 个稳定失败；部分 resolver 测试直接读取运行配置，无法作为可靠重构门禁 | `package.json:5-16`；`.github/workflows/ci.yml:30-47`；`tests/s01/test-resolver.js:28-47`；`tests/agent-gateway/policy/agent-gateway-profile-resolver-budget.test.js:6-42` |

## 4. 值得保留的设计（重构时不要破坏）

- **service bundle 的依赖注入雏形**：工厂函数 + deps 对象的模式方向正确，问题只在注入的是整个 `pluginManager` 而非窄接口。
- **recall 诊断体系**：`pipelineStages` / `ruleDiagnostics` / `modifierDetails` 的可观测性设计完整，重构 pipeline 时应作为 stage 协议的一部分保留。
- **S04 前置校验的精确错误码**（`RECALL_INVALID_RULE/MODIFIER/DIARY` 带 `ruleIndex`）——比静默降级好得多，是既有行为承诺。
- **mtime 热加载**语义（改配置无需重启）——抽公共加载器时保留。
- **契约测试**的"路径集合三方一致"机制——Phase 5A 在其上加深度即可。
- **transport 的 dumb-pipe 抽象**（`transport/mcpTransport.js` 契约）——方向正确，问题是校验未全面生效。
