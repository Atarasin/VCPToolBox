# 02 · 目标架构

## 1. 设计立意

现状的根本问题不是"代码多"，而是**同一职责存在多份实现、且网关与宿主（VCP）之间没有显式边界**。目标架构围绕两条主线：

1. **每个职责一份实现**——MCP 语义、传输治理、diary 策略、配置加载各收敛为单一模块，协议/传输差异只体现在"最后一厘米"的薄壳里。
2. **端口-适配器（Ports & Adapters）边界**——网关核心只依赖显式声明的能力端口；所有对 `pluginManager`、根级组件的接触收口到组装根。这正是"更优雅地对外提供 VCP 能力"的结构基础：VCP 能力先在端口层被显式建模，再由协议层机械地暴露出去。

## 2. 目标目录结构

```
modules/agentGateway/
├─ index.js                      # 公共出口（真实完整的 barrel）
├─ composition/                  # 【组装根】唯一允许接触 pluginManager / 根级 require 的地方
│  ├─ bootstrapGateway.js              # 宿主 ready 后创建 routes/bundle，执行绑定完整性校验
│  ├─ createGatewayServiceBundle.js   # 现文件迁入，改为组装 ports + services
│  └─ vcpPortBindings.js              # pluginManager → 各端口实现的绑定；不在插件加载前执行
│
├─ ports/                        # 【新增】VCP 能力端口：显式接口 + 运行时校验
│  ├─ index.js
│  ├─ ragRetrieverPort.js        # search/embed/rerank/timeParse/semanticGroups/conceptVectors
│  ├─ diaryStorePort.js          # listDiaryNames/getDiaryContent/getChunksByFilePaths/写入
│  ├─ toolInvokerPort.js         # processToolCall/plugins 枚举/审批
│  ├─ agentDirectoryPort.js      # agentMap/renderPrompt
│  └─ llmCompletionPort.js       # aiMemo 摘要所需的 chat completion
│
├─ core/                         # 【重命名自 services/】纯业务，只依赖 ports + policy + contracts
│  ├─ recall/                    # 【Phase 4 拆分】
│  │  ├─ recallRuntimeService.js      # 编排器（<150 行）
│  │  ├─ pipeline/                    # resolveProfile / precomputeVector / executeRule /
│  │  │                               # mergeResults / applyBudget / applyAiMemo 各 stage
│  │  ├─ retrievers/                  # ragRetriever(原 collectRagItems) / fullTextRetriever
│  │  ├─ modifiers/                   # timeDecay / roleValve / base64Memo / truncate / aiMemo
│  │  └─ recallItem.js                # 统一 item 形状 + itemKey() + dedupe/aggregate/interleave
│  ├─ contextRuntimeService.js   # 只剩 search/context 编排，检索委托 core/recall/retrievers
│  ├─ memoryRuntimeService.js
│  ├─ toolRuntimeService.js
│  ├─ agentRegistryService.js
│  ├─ capabilityService.js
│  ├─ jobRuntimeService.js
│  ├─ operabilityService.js
│  └─ recallProjectionService.js
│
├─ policy/                       # 保留，内部去重
│  ├─ …（现有文件）
│  └─ shared/
│     ├─ hotJsonConfigLoader.js  # 统一 mtime 热加载（B6）
│     └─ normalize.js            # normalizeString/StringArray/parseBoolean/parseJsonObject（B7）
│
├─ protocols/                    # 【新增】协议语义层
│  └─ mcp/
│     ├─ constants.js            # 协议版本 / serverInfo / JSON-RPC 码 / 截断长度（C7）
│     ├─ resultShapes.js         # envelope 构造器单一实现（B1）
│     ├─ errorMapping.js         # gateway→MCP 错误码映射单一实现（A1）
│     ├─ harness.js              # createMcpHarness(executor) —— method 分发单一实现
│     ├─ diaryPolicyGate.js      # diary 策略注入/准入单一实现（A2）
│     ├─ descriptors.js          # 现 mcpDescriptorRegistry（Phase 5A 改为 catalog 生成）
│     ├─ inProcessExecutor.js    # 差异体 1：直调 service bundle（原 mcpAdapter 的执行部分）
│     └─ backendProxyExecutor.js # 差异体 2：经 GatewayBackendClient 转发
│
├─ transport/                    # 传输层，收口公共逻辑
│  ├─ shared/
│  │  ├─ slidingWindowRateLimit.js    # B4
│  │  ├─ mcpContextInjector.js        # session/connection 上下文注入（B4）
│  │  ├─ runtimeProvider.js           # 进程级 runtime 创建/缓存；transport 不拥有共享 runtime
│  │  ├─ jsonRpcCodec.js              # 统一解析/notification；batch policy 参数化并保留现行为
│  │  └─ transportLogger.js           # 统一 stderr 日志（C11）
│  ├─ mcpTransport.js / stdioTransport.js / webSocketTransport.js   # 保留
│  ├─ httpServer.js               # 原 mcpHttpServer，闭包拆分
│  ├─ webSocketServer.js
│  └─ stdioServer.js              # 不再兼营"公共 runtime 工厂"职责
│
├─ contracts/                    # 保留；Phase 5A 增加 operation catalog
│  ├─ operations/                # 每个 canonical operation 一份定义：args/result/errors/bindings
│  ├─ schemas/                   # operation 引用的 JSON Schema；不按协议复制业务形状
│  ├─ generate/                  # operation catalog → MCP descriptor / OpenAPI 生成器
│  └─ …（现有文件）
│
├─ infra/                        # auditLogger 可插拔 sink；trace 贯通
├─ clients/
│  └─ GatewayBackendClient.js    # 路径改引 PUBLISHED_NATIVE_GATEWAY_PATHS（B10）；默认超时
└─ config/                       # 不变
```

> 迁移期允许旧路径 re-export 新位置（`services/index.js` → `core/`），外部 require 点（server.js/routes/scripts/tests）逐步切换后删除。

## 3. 关键设计决策

### 3.0 装配生命周期先于端口抽象

**现状约束**：`server.js` 在模块装载阶段创建 `agentGatewayRoutes`，由此触发 service bundle 构造；`pluginManager.loadPlugins()` 与 service 插件初始化发生在之后。RAG 端口依赖的 `RAGDiaryPlugin` 此时尚未进入 `messagePreprocessors`，不能在现时序下做真实 fail-fast。

**目标时序**：

```
创建 pluginManager
  → loadPlugins()
  → initializeServices()
  → bootstrapGateway(pluginManager)
       ├─ assertVcpHostReady()
       ├─ bindVcpPorts()
       ├─ createGatewayServiceBundle()
       └─ create/mount Native routes；向 MCP in-process 入口暴露同一 bundle
  → app.listen()
```

- `assertVcpHostReady()` 校验的是实际宿主组件和已启用能力的必需方法，不接受“永远存在、内部再 lazy lookup”的包装器冒充 fail-fast。宿主配置明确禁用的可选能力绑定 typed unavailable port，并沿用既有 operation failure/capability 暴露语义；不能因单项可选能力缺失让整个 Gateway 无条件启动失败。
- 可选能力在宿主 ready 后固定为 capability snapshot；运行期间插件热重载如需改变能力，必须显式 rebuild/refresh port snapshot，不能静默改变接口形状。
- 独立测试可直接传入 fake ports，不要求启动完整 pluginManager；生产装配测试必须按真实启动顺序执行一次。
- 在完成该时序调整前，不迁移 service 构造逻辑到构造期严格端口校验。

### 3.1 端口层（ports/）——"VCP 能力"的显式建模

**现状**：service 层通过多级 `||` 回退猜测 `pluginManager` 上有什么（C2），并用 lazy `require('../../../…')` 兜底（C3），还直接调 RAG 插件的下划线私有方法（C6）。这意味着 VCP 宿主任何重命名都可能静默破坏网关，且 service 无法脱离完整宿主做测试。

**目标**：每个端口是一个 `create*Port(bindings)` 工厂，在宿主 ready 后输出**冻结的窄接口**。对已启用能力，构造时校验实际绑定的必需方法存在（fail-fast）；对明确禁用的可选能力，构造显式 unavailable port；细粒度可选方法用 `capabilities` 标志声明，而非业务执行阶段临时 `typeof` 探测：

```js
// ports/ragRetrieverPort.js（示意）
function createRagRetrieverPort(bindings) {
    assertFunctions(bindings, ['embedQuery', 'searchDiary']);   // 必需
    return Object.freeze({
        embedQuery: bindings.embedQuery,           // (text) => Promise<number[]>
        searchDiary: bindings.searchDiary,         // (diary, vector, opts) => Promise<RawHit[]>
        rerank: bindings.rerank || null,           // 可选能力：null 即不支持
        parseTimeRanges: bindings.parseTimeRanges || null,
        enhanceWithSemanticGroups: bindings.enhanceWithSemanticGroups || null,
        getConceptVector: bindings.getConceptVector || null,    // 替代直读 enhancedVectorCache
        capabilities() {
            return { rerank: !!bindings.rerank, timeAware: !!bindings.parseTimeRanges, /* … */ };
        }
    });
}
```

`composition/vcpPortBindings.js` 是唯一知道 `RAGDiaryPlugin._rerankDocuments`、`knowledgeBaseManager.search(…, 1.33, …)` 这些宿主细节的地方——把 `1.33`、tagBoost 语义等魔法值连同注释集中于此。RAG 私有 API（`_rerankDocuments` 等）在绑定处包一层，后续与 RAGDiaryPlugin 协商公开 API 时只改这一个文件。绑定函数不得在插件加载前执行，也不得用 lazy root `require` 掩盖宿主未 ready。

**收益**：
- service/core 可用假端口做单测，不再 mock 整个 pluginManager；
- `getKnowledgeBaseManager`/`getRagPlugin` 两套四份的探测函数（B5 一部分）直接删除；
- 为 C5 的 late-binding 循环依赖消解创造前提：recall 与 context 先改为依赖 ports，Phase 4 再把共享 retriever 搬到 `core/recall/`，届时两者不再互相持有 service。

### 3.2 单一 MCP 核心（protocols/mcp/）——消灭双 adapter

**现状**：in-process 与 backend-proxy 两个 adapter 各 1000+ 行，约 15+ 个助手函数拷贝且已漂移（A1/A2/A8/B1/B2/B3）。

**目标**：识别出两者**唯一的本质差异**——"操作最终怎么执行"（直调 service vs HTTP 转发）。把它收敛为一个 executor 接口，其余全部共享：

```
createMcpHarness({ executor, descriptors, serverInfo })
  ├─ handleRequest(request)         # method switch —— 单一实现
  ├─ resultShapes.js                # success/failure/deferred envelope —— 单一实现
  ├─ errorMapping.js                # AGW→MCP 码表（含全部 recall 码）—— 单一实现
  └─ diaryPolicyGate.js             # 准入/默认注入 —— 单一实现
       │
       ├─ inProcessExecutor         # { execute(op, args, ctx) } → service bundle
       └─ backendProxyExecutor      # { execute(op, args, ctx) } → GatewayBackendClient
```

executor 契约：`execute(operation, args, ctx) → Promise<GatewayResult>`，其中 `GatewayResult = { success, status, code, data|error, details, meta }` 是**归一化后的内部结果形状**——proxy 端的 `normalizeNativeResult` 负责把 HTTP 响应折算成这个形状，in-process 端 service 天然返回它。resultShapes/errorMapping 只消费 `GatewayResult`，从机制上排除"两条链路 envelope 不一致"。

漂移仲裁原则（Phase 1 落地时逐条确认）：
- 错误码映射：以 in-process 版为准（含 recall 码）；
- details 消毒：以 proxy 版为准（`sanitizeMcpErrorDetails` 白名单，修复 A8）；
- diary 策略：以 in-process 版语义为准 + 保留 proxy 的显式空策略短路，差异点写成带注释的单一函数（修复 A2）；
- `normalizeMcpString`：以消毒版为准（修复 B2）。

`executeGatewayManagedTool` 的 283 行 if 链改为**操作表**：

```js
const GATEWAY_OPERATIONS = {
    [TOOL_NAMES.MEMORY_SEARCH]:   { name: 'memory.search',  requireSession: true,  diaryPolicy: true },
    [TOOL_NAMES.RECALL_RUN]:      { name: 'recall.run',     requireSession: false, validate: requireAgentIdAndQuery },
    // …
};
```

治理包裹（operability begin/finish）、身份校验、diary gate 由 harness 按表驱动统一执行；executor 只做那一行真正的调用。AGENT_RENDER/BOOTSTRAP 的重复块合并为共享的 render 操作 + `asBootstrap` 后处理标志。

### 3.3 传输公共层（transport/shared/）

**现状**：HTTP/WS 逐字拷贝限流、上下文注入、harness 解析等（B4）；runtime 所有权边界不清（C12）；无超时（A4）；批处理/日志三态不一致（C10/C11）。

**目标**：
- **runtimeProvider**：评审已撤销“A3 会让其他 harness 失效”的判断，因此不为一个未复现问题引入引用计数。共享 runtime 由进程级 composition/provider 创建和缓存；HTTP/WS transport 只持有借用引用，`close()` 只关闭自身 session/connection，不 reset 共享 runtime。stdio 独立进程可以拥有自己的 provider，并在进程结束时 reset。若未来 backend client 出现真实 `close/dispose` 资源，再基于失败测试引入明确 owner 或引用计数。
- **统一 dispatch 超时**：`jsonRpcCodec.dispatch(harness, request, { signal, timeoutMs })` 内建 `AbortSignal.timeout` 合成；三传输统一把 signal 注入 ctx，`GatewayBackendClient` 增加默认 timeout（可配 `VCP_MCP_BACKEND_TIMEOUT_MS`，默认 30s）（修复 A4）。
- **批处理策略显式但保持兼容**：`jsonRpcCodec` 接受 `batchPolicy`，WS 配置为现有的“支持、上限 20”，HTTP/stdio 配置为现有的“拒绝 batch”。结构重构阶段只统一实现入口，不扩大接受范围。三传输统一支持 batch 属 Phase 6 行为变更，需单独契约评审。
- **`createMcpHttpServer` 767 行闭包拆分**：session 生命周期（`sessionStore.js`）、SSE 流管理（`sseStream.js`）、请求分发三块拆为可单测单元；SSE 背压加超时兜底（D6）。
- WS 增加 idle 回收与 HTTP 对齐；HTTP 自愈发现 session 标记为 `kind:'discovery'`，进入独立有界 LRU 池并使用 60s TTL，不计入正常 `maxSessions`。响应仍返回可在 TTL 内复用的 session id，保持客户端兼容（修复 A7）。

### 3.4 recall 管线重组（core/recall/）

**现状**：`executeRecall` 537 行内联全部阶段（C1）；modifier 家族散布 900+ 行同文件；与 contextRuntimeService 重复一批基建（B5）；去重 key 内联四处（B9）；budget 两份（B8）。

**目标**：显式 pipeline，每 stage 独立文件、独立单测，编排器只做串联与诊断聚合：

```
executeRecall(input)
  → stages/resolveProfile      # profileResolver + mapResolvedRecallFailure
  → stages/precomputeVector    # 经 ragRetrieverPort.embedQuery
  → stages/executeRules        # 对每条 rule: gates → retriever → modifiers（保持现有串行顺序）
  │    ├─ gates/roleValveGate.js  gates/conceptSimilarityGate.js
  │    ├─ retrievers/ragRetriever.js        # 原 collectRagItems，搬家后成为唯一实现
  │    ├─ retrievers/fullTextRetriever.js   # 原 defaultFullTextRetriever
  │    └─ modifiers/*                        # 注册表: { key, stage: 'pre'|'post'|'global', apply() }
  → stages/mergeResults        # dedupe/aggregate/interleave（基于 recallItem.itemKey()）
  → stages/applyBudget         # 与 projection 的 budget 合并为单一 tokenBudget.js（B8）
  → stages/applyAiMemo         # 经 llmCompletionPort；提示词模板移至 config/aimemo_presets/
```

配套决策：
- **stage 协议**：`stage(ctx) → ctx'`，`ctx` 携带 `items/diagnostics/pipelineStages`；现有诊断结构（ruleDiagnostics/modifierDetails）原样保留为协议一部分——这是已对外暴露的可观测性承诺。
- **`recallItem.js`**：统一 item 形状（`text/score/sourceDiary/sourceFile/timestamp/tags/role`），提供 `itemKey(item)`；interleave 的 O(n²) `find` 改 Map 索引（B9）。
- **modifier 注册表**取代 `MODIFIER_PIPELINE_ORDER` 里的 continue/if 特判：每个 modifier 自带执行阶段声明，`applyS02Modifiers` 里"跳过 time/group/tagMemo/rerank/aiMemo"的知识改由注册表表达。
- **diary 准入去重**：`defaultFullTextRetriever` 与 `collectRagItems` 各自 80 行的准入块合并为 `resolveDiaryAccess({ requestedDiaries, agentId, authContext, policyResolver, appliedDefaultPolicy }) → { targetDiaries | rejection }` 单一函数（同时服务 B5 与 A2 的策略统一）。
- **规则执行顺序冻结**：现状 for 循环串行执行 rules（`recallRuntimeService.js:1295`）。虽然拆分后数据依赖更清晰，但 rules 仍共享 KnowledgeBaseManager、缓存、reranker、LLM 后端与外部限流；本轮保持串行和调用顺序不变。未来并行化放入 Phase 6，要求有界并发、默认并发度 1、真实后端压力测试与可回滚开关。
- contextRuntimeService 的 search/context 主流程改为调用 `retrievers/ragRetriever`，删除自己的那份实现。

### 3.5 契约单源（operation catalog + schemas + 生成器）

**现状**：同一工具的形状存在三份手工副本——descriptorRegistry 硬编码 inputSchema（311 行）、publishedOpenApiDocument 手写 1821 行、toolRuntimeService 手写校验器；三者无机器对齐（D1/D2）。

**目标**：
- `contracts/operations/` 下每个 canonical operation 一份定义，至少包含 `operationId`、args/result schema 引用、稳定错误码集合、REST binding（method/path/parameter locations）和 MCP binding（tool/prompt/resource 名及后处理）。8 个 MCP 工具与 15 个 REST 端点不强求一一对应。
- `contracts/schemas/` 只维护业务 args/result/envelope 的 JSON Schema；同一 operation 不因 REST/MCP 各复制一份业务形状。协议独有 envelope 与参数位置由 binding 描述。
- 继续发布 OpenAPI 3.0.3 时，生成器必须显式处理 draft-07 与 OAS 3.0 的差异（如 `nullable`、`example/examples`、部分关键字支持）；若升级到 OpenAPI 3.1，作为单独契约决策，不在搬家提交中顺带完成。
- 引入显式顶层依赖的 **ajv**（锁定 CommonJS 兼容版本）编译 gateway 托管 operation 校验器，但默认保持现有接受语义：`coerceTypes:false`、`useDefaults:false`、`removeAdditional:false`；`additionalProperties`、enum/format/pattern 是否生效逐 operation 以历史请求 corpus 确认。插件“猜测 schema”的宽松路径不变。
- `contracts/generate/` 从 operation catalog 生成 MCP descriptors 与 OpenAPI paths/components；`scripts/exportAgentGatewayOpenApi.js` 改调生成器。**唯一手写源是 operation catalog/schema**；`publishedOpenApiDocument.js` 与导出的 JSON/YAML 均作为生成产物提交仓库，运行时不维护第二套生成逻辑。CI 重生成后要求零 diff。
- 契约测试升级：路径集合一致、descriptor/catalog 同源、关键请求与响应样例通过 schema、生成产物无 diff、历史合法/非法请求 corpus 的判定不变。
- `info.version` 取自 `packageJson`，消灭双版本。

### 3.6 基础设施（infra/）

- **auditLogger**：`createAuditLogger({ sinks: [consoleSink, fileSink?] })`；组装根注入唯一实例，删除三处 service 内 `createAuditLogger()` 兜底（D3），保证审计流单一。文件 sink 为可选配置（`AGENT_GATEWAY_AUDIT_FILE`），默认行为不变。
- **trace 贯通**：入站中间件读 `x-request-id`/`x-agent-gateway-trace-id`（头常量已存在），生成或复用 traceId 放入 requestContext；operabilityService 删除自造 `createTraceId`，改用 infra/trace；audit 事件与 MCP operability 元数据携带同一 traceId（D4）。
- **transportLogger**：`log(level, event, fields)` 结构化一行 JSON 到 stderr，带 sessionId/requestId；替换两版 `writeStderr`（C11）。

## 4. 对外提供 VCP 能力的最终形态（消费者视角）

重构完成后，"接入 VCP 能力"有三个清晰层次，文档与代码一一对应：

| 层次 | 消费者 | 入口 | 特点 |
|---|---|---|---|
| L1 REST | 服务端集成 | `/agent_gateway/*` | OpenAPI 由 operation catalog + schema 生成，永远与实现同步 |
| L2 MCP | Agent 工具生态 | `/mcp`(http/ws) 或 stdio | 共享 harness/executor 语义；transport batch policy 显式保留；8 工具与 REST operation 同源 |
| L3 in-process | 仓库内其他模块（如 vcpLoop/workflowKernel 未来需要 recall 时） | `require('modules/agentGateway').core` + 组装根 | 直接拿 service，不经协议层；ports 使其可脱离完整宿主测试 |

RAG 检索作为最核心能力，其单一调用面为：`core/recall/recallRuntimeService.executeRecall()`（profile 驱动）与 `core/recall/retrievers/ragRetriever()`（参数驱动），REST 的 `/recall/run`、`/rag/search`、`/rag/context` 与 MCP 的 `gateway_recall_run`、`gateway_memory_search`、`gateway_context_assemble` 全部收敛到这两个入口。

## 5. 明确不做的替代方案（及理由）

- **不把 MCP 三传输统一为"全部 in-process"**：backend-proxy 回环使 stdio 进程可以对接远程 VCP、且与 canonical REST 共享鉴权/治理，是有意设计（见 `mydoc/export/mcp/agent-gateway-mcp-low-conflict-coexistence-design.md`）；重构只统一其上的语义层。
- **不引入重型框架**（NestJS/InversifyJS 等）：组装根 + 工厂函数已满足 DI 需求，符合仓库现有风格。
- **不给 jobRuntimeService 上持久化**：当前消费场景未要求跨进程 job；登记为 D5 备查，接口设计（store 注入位）预留即可。
- **不动 `recall_profiles.json` 配置格式**：S04 刚完成结构化收口，用户已有存量配置；只补 example 同步与校验。
