# Agent Gateway Core Split Map

> 目标：为 `modules/agentGatewayCore.js` 提供 M0 阶段切分盘点，明确哪些逻辑更适合迁移到 `contracts`、`infra`、`services`、`adapters`，并标记纯函数、状态函数、路由耦合逻辑和 OpenClaw 特有逻辑。

## 1. 当前整体判断

- 当前文件同时承担协议契约、基础设施、能力服务、memory/context/tool runtime 服务以及 Express adapter 职责
- 低风险优先提取对象：纯函数、稳定 envelope、错误映射、审计/trace 工具
- 高风险后提取对象：直接依赖 `pluginManager`、`KnowledgeBaseManager`、`RAGDiaryPlugin` 的 runtime 服务
- 最后保留在 adapter 的应只剩参数映射、HTTP 状态与 vendor-specific 协议兼容

## 2. 目标归属盘点

### 2.1 `contracts` 候选

| 函数组 | 当前函数 | 逻辑属性 | 说明 |
| --- | --- | --- | --- |
| 请求/字符串归一化 | `normalizeOpenClawString`, `normalizeOpenClawStringArray`, `resolveOpenClawDiarySelection`, `parseOpenClawJsonObject` | 纯函数、OpenClaw 特有命名 | 后续可抽成统一 requestContext / payload normalize 工具 |
| 响应包络 | `createOpenClawMeta`, `sendOpenClawSuccess`, `sendOpenClawError` | 纯函数、路由输出契约、OpenClaw 特有 | M1 可演进成通用 `responseEnvelope` |
| 基础参数解析 | `parseOpenClawBooleanQuery`, `parseOpenClawInteger` | 纯函数 | 可作为 contracts 或共享 schema helper |
| RAG target / memory 描述模型 | `createOpenClawRagTargetDescriptor`, `createOpenClawMemoryDescriptor` | 纯函数、OpenClaw 协议模型 | 后续能力模型抽离时应和 capability model 一起整理 |
| RAG 查询与文本规范化 | `normalizeOpenClawRagMode`, `extractOpenClawRagOptions`, `normalizeOpenClawTimestampValue`, `normalizeOpenClawContentText`, `normalizeOpenClawConversationMessages`, `buildOpenClawRecallQuery` | 纯函数、OpenClaw 特有 | 后续可沉到 request contract 或 service input normalize |
| 上下文块与 schema 校验 | `estimateOpenClawTokenCount`, `truncateOpenClawTextByTokens`, `createOpenClawRecallBlock`, `validateOpenClawSchemaValue` | 纯函数 | 其中 schema 校验后续更适合配合 `infra/schemaRegistry` 使用 |

### 2.2 `infra` 候选

| 函数组 | 当前函数 | 逻辑属性 | 说明 |
| --- | --- | --- | --- |
| Trace / requestId | `createOpenClawRequestId`, `setOpenClawBridgeHeaders` | 纯函数、路由输出耦合、OpenClaw 特有 | M1 应拆成统一 trace/request-id 工具 |
| 配置与依赖获取 | `getOpenClawBridgeConfig`, `getOpenClawRagConfig`, `getOpenClawKnowledgeBaseManager`, `getOpenClawRagPlugin`, `getOpenClawEmbeddingUtils` | 状态函数、缓存函数、OpenClaw 特有 | 需要与后续 gateway 依赖装配解耦 |
| 检索/打分通用辅助 | `computeOpenClawCosineSimilarity`, `extractOpenClawCoreTags`, `deriveOpenClawTimestampFromPath`, `summarizeOpenClawScoreStats` | 纯函数 | 可沉为共享 infra helper |
| metadata 访问缓存 | `getOpenClawFileMetadata`, `getCachedOpenClawFileMetadata` | 状态函数 | 后续可并入 retrieval infra/cache helper |
| memory 幂等基础设施 | `getOpenClawMemoryWriteStore`, `createOpenClawMemoryFingerprint`, `resolveOpenClawMemoryDuplicate`, `rememberOpenClawMemoryWrite`, `extractOpenClawMemoryWritePath`, `createOpenClawMemoryEntryId` | 状态函数 + 纯函数混合 | 可演进为 `idempotencyStore` + memory bridge helper |
| 错误映射与审计 | `parseOpenClawPluginError`, `mapOpenClawMemoryWriteError`, `mapOpenClawToolExecutionError`, `logOpenClawAudit` | 纯函数 / I/O 函数，OpenClaw 特有 | M1 应拆成 `errorMapper` 与 `auditLogger` |

### 2.3 `services` 候选

| 函数组 | 当前函数 | 逻辑属性 | 说明 |
| --- | --- | --- | --- |
| capability / tool 描述 | `isOpenClawBridgeablePlugin`, `getOpenClawToolTimeoutMs`, `parseInvocationCommandExample`, `extractInvocationParameterHints`, `applyOpenClawInvocationParameters`, `buildOpenClawInvocationVariantSchema`, `getOpenClawToolInputSchema`, `summarizeOpenClawToolDescription`, `getOpenClawInvocationCommands`, `createOpenClawToolDescriptor` | 纯函数为主，少量依赖 plugin 元数据 | 可收敛为 `CapabilityService` 与 schema registry |
| agent diary scope | `buildOpenClawAgentAliases`, `collectOpenClawConfiguredDiaries`, `resolveOpenClawAllowedDiaries`, `isOpenClawDiaryAllowed`, `listOpenClawDiaryTargets`, `resolveOpenClawMemoryTargets` | 纯函数 + 依赖 KB 查询 | 后续应并入 policy + memory/context service |
| memory write 业务 | `getOpenClawMemoryWritePluginInfo`, `normalizeOpenClawMemoryTags`, `resolveOpenClawMemoryDateParts`, `buildOpenClawMemoryWriteMaid`, `normalizeOpenClawMemoryMetadata`, `buildOpenClawMemoryWriteContent`, `performOpenClawMemoryWrite` | 混合纯函数与状态函数，OpenClaw 语义较强 | M2/M3 应拆成 `MemoryRuntimeService` 与 memory bridge helper |
| retrieval / context 业务 | `getOpenClawQueryVector`, `deduplicateOpenClawRagCandidates`, `normalizeOpenClawRagItem`, `deduplicateOpenClawRecallBlocks` | 状态函数 + 纯函数混合 | M2 应拆成 `ContextRuntimeService`/`MemoryRuntimeService` |

### 2.4 `adapters` 候选

| 逻辑块 | 当前位置 | 逻辑属性 | 说明 |
| --- | --- | --- | --- |
| OpenClaw HTTP 入口 shim | `routes/openclawBridgeRoutes.js` | 路由耦合、OpenClaw 特有 | 当前已是轻量 adapter 壳 |
| Router 组装 | `createAgentGatewayCore(pluginManager)` | 路由耦合 | 后续应退化为 service 组装层 |
| `GET /openclaw/capabilities` | `router.get('/openclaw/capabilities', ...)` | 路由耦合、OpenClaw 特有 | 应只保留协议参数解析与 response 映射 |
| `GET /openclaw/rag/targets` | `router.get('/openclaw/rag/targets', ...)` | 路由耦合、OpenClaw 特有 | 同上 |
| `POST /openclaw/rag/search` | `router.post('/openclaw/rag/search', ...)` | 路由耦合、OpenClaw 特有 | 当前掺入大量 service 逻辑，需重点变薄 |
| `POST /openclaw/rag/context` | `router.post('/openclaw/rag/context', ...)` | 路由耦合、OpenClaw 特有 | 当前掺入 retrieval 和 budget 策略 |
| `POST /openclaw/memory/write` | `router.post('/openclaw/memory/write', ...)` | 路由耦合、OpenClaw 特有 | 仅应保留到 memory runtime bridge 的协议映射 |
| `POST /openclaw/tools/:toolName` | `router.post('/openclaw/tools/:toolName', ...)` | 路由耦合、OpenClaw 特有 | 当前包含 validation、approval、execution、error mapping，多职责混合 |

## 3. 逻辑属性标记

### 3.1 纯函数

以下逻辑可作为 M1 优先抽离对象：

- 字符串、数组、布尔、整数归一化
- response envelope 构造
- invocation command 解析与 schema 生成
- RAG 参数规范化、文本截断、token 估算、score 统计
- memory 指纹、entryId 生成、metadata 规范化
- 工具与 memory 错误映射

### 3.2 状态函数

以下逻辑依赖缓存、存储或外部运行时对象：

- `getOpenClawKnowledgeBaseManager`, `getOpenClawRagPlugin`, `getOpenClawEmbeddingUtils`
- `getOpenClawMemoryWriteStore`, `resolveOpenClawMemoryDuplicate`, `rememberOpenClawMemoryWrite`
- `listOpenClawDiaryTargets`, `resolveOpenClawMemoryTargets`
- `getOpenClawQueryVector`, `getOpenClawFileMetadata`, `getCachedOpenClawFileMetadata`
- `performOpenClawMemoryWrite`, `normalizeOpenClawRagItem`

### 3.3 路由耦合逻辑

以下逻辑必须在后续拆分后留在 adapter，或进一步压薄：

- `req.query` / `req.body` / `req.params` 读取
- HTTP status 决策与 `res.status(...).json(...)`
- `req.ip` 提取
- OpenClaw 专用路径命名：`/openclaw/*`

### 3.4 OpenClaw 特有逻辑

以下逻辑命名或协议结构明显带 vendor 语义，后续需要降到 adapter 或 bridge helper：

- `OPENCLAW_*` 常量与错误码命名
- `x-openclaw-bridge-version`
- `__openclawContext`
- `vcp_memory_write` 桥接工具名
- `openclaw`, `openclaw-context`, `openclaw-memory`, `openclaw-memory-write` 默认 source 值

## 4. 推荐拆分顺序

1. `contracts`
2. `infra`
3. `CapabilityService`
4. `MemoryRuntimeService` / `ContextRuntimeService`
5. `ToolRuntimeService`
6. `AgentRegistryService`
7. Native Gateway adapter

不建议的顺序：

- 先上 Native Gateway 再回收 core：会让新老 adapter 同时依赖单体实现
- 先上 auth/jobs/MCP：会在核心契约未稳定时扩大边界面

## 5. 当前阶段结论

- `modules/agentGatewayCore.js` 不是最终形态，应被视为拆分跳板
- M1 最适合先抽走的是 response/error/request/trace/audit 等基础件
- RAG、memory、tool runtime 的大块业务逻辑暂时仍保留在当前文件，但已经具备明确服务化边界
- OpenClaw adapter 应继续保留兼容行为，但不应再继续向单体核心堆业务
