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
│  ├─ createGatewayServiceBundle.js   # 现文件迁入，改为组装 ports + services
│  └─ vcpPortBindings.js              # pluginManager → 各端口实现的绑定
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
│     ├─ descriptors.js          # 现 mcpDescriptorRegistry（Phase 5 改为 schema 生成）
│     ├─ inProcessExecutor.js    # 差异体 1：直调 service bundle（原 mcpAdapter 的执行部分）
│     └─ backendProxyExecutor.js # 差异体 2：经 GatewayBackendClient 转发
│
├─ transport/                    # 传输层，收口公共逻辑
│  ├─ shared/
│  │  ├─ slidingWindowRateLimit.js    # B4
│  │  ├─ mcpContextInjector.js        # session/connection 上下文注入（B4）
│  │  ├─ runtimeHandle.js             # 引用计数的 backend-proxy runtime（A3）
│  │  ├─ jsonRpcCodec.js              # parse/batch/notification 语义统一（C10）
│  │  └─ transportLogger.js           # 统一 stderr 日志（C11）
│  ├─ mcpTransport.js / stdioTransport.js / webSocketTransport.js   # 保留
│  ├─ httpServer.js               # 原 mcpHttpServer，闭包拆分
│  ├─ webSocketServer.js
│  └─ stdioServer.js              # 不再兼营"公共 runtime 工厂"职责
│
├─ contracts/                    # 保留；Phase 5 增加 schemas/ 单源
│  ├─ schemas/                   # 每工具/端点一份 JSON Schema（单源）
│  ├─ generate/                  # schema → MCP descriptor / OpenAPI 生成器
│  └─ …（现有文件）
│
├─ infra/                        # auditLogger 可插拔 sink；trace 贯通
├─ clients/
│  └─ GatewayBackendClient.js    # 路径改引 PUBLISHED_NATIVE_GATEWAY_PATHS（B10）；默认超时
└─ config/                       # 不变
```

> 迁移期允许旧路径 re-export 新位置（`services/index.js` → `core/`），外部 require 点（server.js/routes/scripts/tests）逐步切换后删除。

## 3. 关键设计决策

### 3.1 端口层（ports/）——"VCP 能力"的显式建模

**现状**：service 层通过多级 `||` 回退猜测 `pluginManager` 上有什么（C2），并用 lazy `require('../../../…')` 兜底（C3），还直接调 RAG 插件的下划线私有方法（C6）。这意味着 VCP 宿主任何重命名都可能静默破坏网关，且 service 无法脱离完整宿主做测试。

**目标**：每个端口是一个 `create*Port(bindings)` 工厂，输出**冻结的窄接口**，构造时校验必需方法存在（fail-fast），可选能力用 `capabilities` 标志显式声明而非运行时 `typeof` 探测：

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

`composition/vcpPortBindings.js` 是唯一知道 `RAGDiaryPlugin._rerankDocuments`、`knowledgeBaseManager.search(…, 1.33, …)` 这些宿主细节的地方——把 `1.33`、tagBoost 语义等魔法值连同注释集中于此。RAG 私有 API（`_rerankDocuments` 等）在绑定处包一层，后续与 RAGDiaryPlugin 协商公开 API 时只改这一个文件。

**收益**：
- service/core 可用假端口做单测，不再 mock 整个 pluginManager；
- `getKnowledgeBaseManager`/`getRagPlugin` 两套四份的探测函数（B5 一部分）直接删除；
- C5 的 late-binding 循环依赖消解：recall 与 context 都依赖 ports，互相之间只剩纯函数引用。

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

**现状**：HTTP/WS 逐字拷贝限流、上下文注入、harness 解析等（B4）；runtime 单例所有权冲突（A3）；无超时（A4）；批处理/日志三态不一致（C10/C11）。

**目标**：
- **runtimeHandle**：`acquireBackendProxyRuntime()` 返回引用计数句柄，`handle.release()` 减计数，归零才真正 shutdown。HTTP/WS/stdio 各持一个句柄，任一关闭不影响其余（修复 A3）。`mcpStdioServer.js` 不再兼任"公共 runtime 工厂"，该职责移到 `transport/shared/runtimeHandle.js`。
- **统一 dispatch 超时**：`jsonRpcCodec.dispatch(harness, request, { signal, timeoutMs })` 内建 `AbortSignal.timeout` 合成；三传输统一把 signal 注入 ctx，`GatewayBackendClient` 增加默认 timeout（可配 `VCP_MCP_BACKEND_TIMEOUT_MS`，默认 30s）（修复 A4）。
- **批处理策略统一**：以 MCP 规范为准做一个决定（建议三传输都支持 batch，上限沿用 WS 的 20），写进 jsonRpcCodec；行为差异从"实现巧合"变成"配置"。
- **`createMcpHttpServer` 767 行闭包拆分**：session 生命周期（`sessionStore.js`）、SSE 流管理（`sseStream.js`）、请求分发三块拆为可单测单元；SSE 背压加超时兜底（D6）。
- WS 增加 idle 回收与 HTTP 对齐；自愈发现 session 改为不占 `maxSessions` 配额的短时匿名会话或直接免 session 处理 discovery 方法（修复 A7）。

### 3.4 recall 管线重组（core/recall/）

**现状**：`executeRecall` 537 行内联全部阶段（C1）；modifier 家族散布 900+ 行同文件；与 contextRuntimeService 重复一批基建（B5）；去重 key 内联四处（B9）；budget 两份（B8）。

**目标**：显式 pipeline，每 stage 独立文件、独立单测，编排器只做串联与诊断聚合：

```
executeRecall(input)
  → stages/resolveProfile      # profileResolver + mapResolvedRecallFailure
  → stages/precomputeVector    # 经 ragRetrieverPort.embedQuery
  → stages/executeRules        # 对每条 rule: gates → retriever → modifiers（并行执行见下）
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
- **规则并行**：现状 for 循环串行执行 rules（`recallRuntimeService.js:1295`）。拆分后 rules 天然无相互依赖，改 `Promise.all` 并行（保留 ruleIndex 顺序输出）；这是重构顺带的性能收益，diagnostics 的 durationMs 语义不变。
- contextRuntimeService 的 search/context 主流程改为调用 `retrievers/ragRetriever`，删除自己的那份实现。

### 3.5 契约单源（contracts/schemas/ + 生成器）

**现状**：同一工具的形状存在三份手工副本——descriptorRegistry 硬编码 inputSchema（311 行）、publishedOpenApiDocument 手写 1821 行、toolRuntimeService 手写校验器；三者无机器对齐（D1/D2）。

**目标**：
- `contracts/schemas/` 下每个 gateway 工具/端点一份标准 JSON Schema（draft-07，人手维护的**唯一**形状源）。
- 引入 **ajv**（无 ESM 冲突，仓库 CommonJS 兼容）编译校验器：toolRuntimeService 的手写 `validateToolSchemaValue` 保留为插件"猜测 schema"的宽松路径，gateway 托管工具改走 ajv 严格校验。
- `contracts/generate/`：构建期脚本从 schemas 生成 MCP tool descriptors 与 OpenAPI paths/components；`scripts/exportAgentGatewayOpenApi.js` 改调生成器。`publishedOpenApiDocument.js` 退役为生成产物（描述文字/example 保留在 schema 的 `description`/`examples` 字段中迁移）。
- 契约测试升级：现有"路径集合一致"保留，新增"descriptor == 由 schema 生成"与"响应样例通过 schema 校验"两层。
- `info.version` 取自 `packageJson`，消灭双版本。

### 3.6 基础设施（infra/）

- **auditLogger**：`createAuditLogger({ sinks: [consoleSink, fileSink?] })`；组装根注入唯一实例，删除三处 service 内 `createAuditLogger()` 兜底（D3），保证审计流单一。文件 sink 为可选配置（`AGENT_GATEWAY_AUDIT_FILE`），默认行为不变。
- **trace 贯通**：入站中间件读 `x-request-id`/`x-agent-gateway-trace-id`（头常量已存在），生成或复用 traceId 放入 requestContext；operabilityService 删除自造 `createTraceId`，改用 infra/trace；audit 事件与 MCP operability 元数据携带同一 traceId（D4）。
- **transportLogger**：`log(level, event, fields)` 结构化一行 JSON 到 stderr，带 sessionId/requestId；替换两版 `writeStderr`（C11）。

## 4. 对外提供 VCP 能力的最终形态（消费者视角）

重构完成后，"接入 VCP 能力"有三个清晰层次，文档与代码一一对应：

| 层次 | 消费者 | 入口 | 特点 |
|---|---|---|---|
| L1 REST | 服务端集成 | `/agent_gateway/*` | OpenAPI 由 schema 生成，永远与实现同步 |
| L2 MCP | Agent 工具生态 | `/mcp`(http/ws) 或 stdio | 三传输行为一致（同 harness 同 executor 语义），8 工具 schema 与 REST 同源 |
| L3 in-process | 仓库内其他模块（如 vcpLoop/workflowKernel 未来需要 recall 时） | `require('modules/agentGateway').core` + 组装根 | 直接拿 service，不经协议层；ports 使其可脱离完整宿主测试 |

RAG 检索作为最核心能力，其单一调用面为：`core/recall/recallRuntimeService.executeRecall()`（profile 驱动）与 `core/recall/retrievers/ragRetriever()`（参数驱动），REST 的 `/recall/run`、`/rag/search`、`/rag/context` 与 MCP 的 `gateway_recall_run`、`gateway_memory_search`、`gateway_context_assemble` 全部收敛到这两个入口。

## 5. 明确不做的替代方案（及理由）

- **不把 MCP 三传输统一为"全部 in-process"**：backend-proxy 回环使 stdio 进程可以对接远程 VCP、且与 canonical REST 共享鉴权/治理，是有意设计（见 `mydoc/export/mcp/agent-gateway-mcp-low-conflict-coexistence-design.md`）；重构只统一其上的语义层。
- **不引入重型框架**（NestJS/InversifyJS 等）：组装根 + 工厂函数已满足 DI 需求，符合仓库现有风格。
- **不给 jobRuntimeService 上持久化**：当前消费场景未要求跨进程 job；登记为 D5 备查，接口设计（store 注入位）预留即可。
- **不动 `recall_profiles.json` 配置格式**：S04 刚完成结构化收口，用户已有存量配置；只补 example 同步与校验。
