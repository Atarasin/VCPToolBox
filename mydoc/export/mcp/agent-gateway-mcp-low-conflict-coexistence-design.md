# Agent Gateway MCP 复用现有 VCP 后端与日记 RAG 闭环设计方案

## 1. 文档目标

本文档用于重新定义 MCP transport 的唯一目标形态：

- MCP 只作为 Trae 可连接的 `stdio` 协议壳
- 所有业务能力只复用已经运行的 VCP backend
- 不再保留本地 standalone runtime
- 第一阶段优先交付完整的日记 RAG 闭环，而不是泛化的全部插件工具代理

这里的“日记 RAG 闭环”特指：

1. diary memory 检索
2. recall context 组装
3. agent bootstrap fallback
4. memory write
5. deferred job 查询与取消

目标不是重新发明 MCP 语义，而是把已经存在的 canonical Gateway Core 语义，以 backend-only 的方式稳定发布给 Trae。

---

## 2. 结论先行

本次设计只保留一条路径：

**Trae -> MCP stdio transport -> 已运行 VCP backend -> native agent_gateway routes -> Gateway Core**

这意味着：

1. MCP transport 不再初始化 `KnowledgeBaseManager`
2. MCP transport 不再 `pluginManager.loadPlugins()`
3. MCP transport 不再直接构造本地 `createMcpServerHarness(pluginManager)`
4. MCP transport 只做 JSON-RPC 到 native HTTP 的协议映射与错误透传

同时，第一阶段能力面也只收口到 diary RAG 闭环，不承诺任意 direct plugin tool 的远程镜像。

---

## 3. 为什么必须这样收口

### 3.1 当前真正的问题不是端口，而是第二套运行时

现有 transport 默认启动链会：

1. `knowledgeBaseManager.initialize()`
2. `pluginManager.setProjectBasePath(...)`
3. `pluginManager.setVectorDBManager(...)`
4. `pluginManager.loadPlugins()`
5. `createMcpServerHarness(pluginManager)`

这会让 MCP 进程在已有 VCP backend 存在时，再额外拉起一整套重量级运行时。

问题包括：

1. 再初始化一套知识库
2. 再加载一轮插件
3. 再启动一批 service / hybridservice 副作用
4. 再占用一份内存、CPU、watcher、缓存、连接和状态资源

### 3.2 现有后端本来就应该是唯一业务承载者

用户前提已经明确：

1. 服务器上的 VCP backend 是必然存在的
2. MCP 不是第二个后端
3. MCP 只应该成为 Trae 的接入壳

因此继续讨论“是否保留 standalone-local”没有意义，因为那等于继续允许第二套运行时存在。

### 3.3 diary RAG 闭环比“广泛能力面”更优先

MCP 当前真正有价值的用途不是远程镜像所有插件，而是让编码 Agent 能稳定完成：

1. 查记忆
2. 组上下文
3. 获取 canonical agent bootstrap
4. 写回通用 memory
5. 查询异步作业

这是一条完整闭环，直接对应高频开发工作流。

---

## 4. 设计目标

本次重设计必须满足以下目标：

1. 保持 Trae 可通过 `stdio` 方式连接 MCP
2. 保持 `stdout` 只输出协议，`stderr` 只输出诊断
3. MCP 不再本地初始化任何 VCP 重量级运行时
4. 所有业务语义只复用已运行 backend 的 canonical route / service
5. 第一阶段至少覆盖 diary RAG 闭环
6. 保持 requestId、traceId、error identity、job identity 的 machine-readable 透传

---

## 5. 非目标

本方案明确不做：

1. 不保留 standalone-local 兼容模式
2. 不代理任意 direct local plugin tools
3. 不在本次把所有 MCP resources 全量补齐
4. 不引入 attach-to-process IPC
5. 不在本次把 metrics 或全插件生态一起打包进入

---

## 6. diary RAG 闭环的定义

第一阶段要交付的闭环能力如下。

### 6.1 recall 侧

1. `gateway_memory_search`
2. `gateway_context_assemble`
3. `gateway_agent_bootstrap`

### 6.2 writeback 侧

1. `gateway_memory_write`

### 6.3 deferred runtime 侧

1. `gateway_job_get`
2. `gateway_job_cancel`

### 6.4 最小 discovery 侧

1. `tools/list`
2. `prompts/list` / `prompts/get` 可按需保留 `gateway_agent_render`
3. `resources/list` / `resources/read` 只承诺与 diary RAG 闭环强相关且已有稳定 backend surface 的部分

如果某项 discovery 对 Trae 不是必需项，可以本地静态发布 descriptor，但执行仍必须走 backend。

---

## 7. 当前代码现状与缺口

### 7.1 已经存在、可直接代理的 native route

当前 native `agent_gateway` 已经提供：

1. `GET /agent_gateway/capabilities`
2. `GET /agent_gateway/memory/targets`
3. `POST /agent_gateway/memory/search`
4. `POST /agent_gateway/context/assemble`
5. `POST /agent_gateway/memory/write`
6. `GET /agent_gateway/jobs/:jobId`
7. `POST /agent_gateway/jobs/:jobId/cancel`
8. `GET /agent_gateway/events/stream`
9. `POST /agent_gateway/agents/:agentId/render`

这说明 diary RAG 闭环已经有一半以上的 backend surface。

### 7.2 当前已经收口到统一的 backend contract

当前对外 MCP 能力已经收口为：

1. prompt-first 的 `gateway_agent_render`
2. tool-only fallback 的 `gateway_agent_bootstrap`
3. 通用 `gateway_memory_search` / `gateway_context_assemble` / `gateway_memory_write`

这意味着 MCP transport 不再需要维持 coding 专用 capability，也不再需要为其追加独立 native route。

### 7.3 结论

因此当前更合理的结论是：

1. MCP transport 继续只代理 backend
2. prompt-aware 宿主走 `prompts/get`
3. tool-only 宿主走 `gateway_agent_bootstrap`
4. diary recall / writeback 统一收口到 memory/context/write contract

---

## 8. 唯一推荐方案

唯一推荐方案是：

**backend-only MCP proxy + diary RAG loop first**

不再保留：

1. standalone-local
2. dual-mode runtime
3. local minimal-runtime

原因很直接：

1. 用户明确说明 VCP backend 是必然存在的
2. 保留本地模式只会持续制造第二套运行时歧义
3. 任何“兼容退路”都会让实现和验证面显著膨胀
4. diary RAG 闭环本身已经足够大，不应再混入额外模式分叉

---

## 9. 总体架构

```text
Trae
  |
  | stdio JSON-RPC
  v
MCP Transport Process
  |
  | HTTP only
  v
GatewayBackendClient
  |
  | canonical native agent_gateway routes
  v
Running VCP Backend
  |
  v
Gateway Core services
  |
  +--> ContextRuntimeService
  +--> MemoryRuntimeService
  +--> JobRuntimeService
  |
  +--> AgentRegistryService
  |
  v
Diary RAG / writeback / prompt render / deferred runtime
```

关键点只有一个：

**MCP process 不拥有业务 runtime，只拥有协议映射。**

---

## 10. 请求映射设计

### 10.1 tools/list

`tools/list` 由 MCP 本地返回静态 descriptor，但这些 descriptor 必须对应 backend 真正支持的 capability。

第一阶段只列出：

1. `gateway_memory_search`
2. `gateway_context_assemble`
3. `gateway_agent_bootstrap`
4. `gateway_memory_write`
5. `gateway_job_get`
6. `gateway_job_cancel`

`gateway_agent_render` 保留在 prompt surface，而不是 tools/list。

### 10.2 tools/call

工具调用映射如下：

1. `gateway_memory_search`
   - `POST /agent_gateway/memory/search`
2. `gateway_context_assemble`
   - `POST /agent_gateway/context/assemble`
3. `gateway_agent_bootstrap`
   - `POST /agent_gateway/agents/:agentId/render`
4. `gateway_memory_write`
   - `POST /agent_gateway/memory/write`
5. `gateway_job_get`
   - `GET /agent_gateway/jobs/:jobId`
6. `gateway_job_cancel`
   - `POST /agent_gateway/jobs/:jobId/cancel`

### 10.3 prompts

如果 Trae 对 prompt surface 有强依赖，可以保留：

1. `prompts/list`
2. `prompts/get` for `gateway_agent_render`

但 prompt 的最终执行仍必须代理 backend render route，而不是本地渲染。

### 10.4 resources

第一阶段只承诺最小必要资源：

1. `vcp://agent-gateway/memory-targets/{agentId}` 可映射到 `GET /agent_gateway/memory/targets`
2. `vcp://agent-gateway/jobs/{jobId}/events` 可以先通过现有 job/detail + events/listing 能力做只读整形，或延后到 backend 提供更稳定 route

不强行承诺的资源：

1. profile
2. prompt-template
3. metrics
4. 其它与 diary RAG 闭环无强关联的资源

---

## 11. backend 侧当前应维持的 canonical route

### 11.1 `POST /agent_gateway/agents/:agentId/render`

职责：

1. 作为 `prompts/get(name = gateway_agent_render)` 的 canonical render 来源
2. 同时作为 `gateway_agent_bootstrap` 的共享 backend route
3. 在 deferred 场景下返回统一 job runtime envelope

### 11.2 memory / context / write routes

职责：

1. `POST /agent_gateway/memory/search` 负责通用记忆检索
2. `POST /agent_gateway/context/assemble` 负责通用 recall context 组装
3. `POST /agent_gateway/memory/write` 负责 durable memory writeback

### 11.3 为什么不再保留 coding 专用 route

原因：

1. 对外能力面已经移除 coding 专用 MCP tool
2. 统一 memory/context/write contract 更容易做 allowlist 治理
3. Bootstrap 已经覆盖 tool-only 宿主的 agent 注入需求

---

## 12. MCP transport 的职责边界

重设计后的 `mcpStdioServer.js` 只保留以下职责：

1. `stdin/stdout` JSON-RPC 收发
2. parse error / method not found / internal error 处理
3. stdout 与 stderr 隔离
4. 调用 `GatewayBackendClient`
5. 将 native backend response 映射成 MCP result / error

它不再负责：

1. 初始化 `KnowledgeBaseManager`
2. 访问 `pluginManager`
3. 构造本地 gateway service bundle
4. 直接运行 adapter-local service 行为

换句话说，`mcpStdioServer.js` 应该变成“真正的 transport”，而不是轻度后端。

---

## 13. 模块拆分建议

### 13.1 `modules/agentGateway/mcpStdioServer.js`

保留：

1. 协议收发
2. JSON-RPC 错误框架
3. 生命周期与 shutdown

删除：

1. 默认本地 runtime 初始化
2. `pluginManager` / `knowledgeBaseManager` 绑定逻辑

### 13.2 新增 `modules/agentGateway/gatewayBackendClient.js`

职责：

1. 封装 backend base URL、token、headers
2. 构造 canonical request body
3. 透传 requestId / traceId / authContext / requestContext
4. 统一解析 native success / failure envelope

### 13.3 新增 `modules/agentGateway/mcpBackendProxyHarness.js`

职责：

1. 提供 `initialize`
2. 提供 `prompts/list`
3. 提供 `prompts/get`
4. 提供 `tools/list`
5. 提供 `tools/call`
6. 提供 `resources/list`
7. 提供 `resources/read`

但其内部不持有本地 service bundle，只依赖 `GatewayBackendClient`。

### 13.4 抽取共享 descriptor registry

建议把以下内容从当前 `mcpAdapter.js` 中抽成纯静态 helper：

1. gateway-managed tool descriptors
2. gateway-managed prompt descriptors
3. supported resource templates

这样 backend proxy harness 不需要依赖本地 pluginManager，也能稳定完成 discovery。

---

## 14. diary RAG 闭环的请求流

### 14.1 recall 闭环

```text
Trae
  -> MCP tools/call(gateway_memory_search) / tools/call(gateway_context_assemble)
  -> MCP backend proxy
  -> POST /agent_gateway/memory/search or /agent_gateway/context/assemble
  -> ContextRuntimeService
  -> Diary RAG
  -> canonical response
  -> MCP result
```

### 14.2 writeback 闭环

```text
Trae
  -> MCP tools/call(gateway_memory_write)
  -> MCP backend proxy
  -> POST /agent_gateway/memory/write
  -> MemoryRuntimeService
  -> diary memory write path
  -> canonical response
  -> MCP result
```

### 14.3 deferred job 闭环

```text
Trae
  -> MCP tools/call(...)
  -> backend returns accepted / waiting_approval + job
  -> MCP tools/call(gateway_job_get)
  -> GET /agent_gateway/jobs/:jobId
  -> MCP tools/call(gateway_job_cancel)
  -> POST /agent_gateway/jobs/:jobId/cancel
```

---

## 15. 第一阶段能力边界

### 15.1 明确保留

第一阶段保留：

1. diary RAG recall
2. diary RAG context assembly
3. bootstrap fallback
4. memory write
5. job get / cancel
6. 最小 discovery

### 15.2 明确延后

第一阶段延后：

1. 任意 direct plugin tool 代理
2. 完整资源镜像
3. metrics 发布
4. 所有非 diary RAG 场景的扩展 capability

### 15.3 为什么这样划分

因为这条 change 的核心目标不是“把 MCP 做大”，而是：

1. 把第二套运行时彻底去掉
2. 把 diary RAG 闭环稳定接到 Trae
3. 保持 contract 继续收口在 backend

---

## 16. 验证方案

### 16.1 backend-only 验证

验证点：

1. MCP 启动时不再初始化 `KnowledgeBaseManager`
2. MCP 启动时不再 `loadPlugins()`
3. MCP 只依赖 backend base URL / token 即可工作

### 16.2 diary RAG 闭环验证

验证点：

1. `tools/list` 能看到闭环所需工具
2. `gateway_memory_search` 调用成功
3. `gateway_context_assemble` 调用成功
4. `gateway_agent_bootstrap` 调用成功
5. `gateway_memory_write` 调用成功
6. deferred result 可以通过 `gateway_job_get` / `gateway_job_cancel` 继续操作

### 16.3 contract 一致性验证

验证点：

1. requestId 透传一致
2. error code 透传一致
3. operability metadata 透传一致
4. deferred envelope 与当前共享 job runtime contract 一致

### 16.4 Trae 联通验证

验证点：

1. Trae 能连接 stdio MCP server
2. `tools/list` 正常
3. diary RAG 相关工具可实际调用
4. stdout 无诊断日志污染

---

## 17. 风险与取舍

### 风险 1：prompt / bootstrap 双路径长期漂移

说明：

1. prompt-aware 宿主走 `prompts/get`
2. tool-only 宿主走 `gateway_agent_bootstrap`

应对：

1. bootstrap 直接复用 render route
2. 两条路径共用同一套 `renderAgent()` 语义

### 风险 2：MCP 能力面比当前 adapter 更窄

说明：

去掉本地 runtime 后，就不再具备“顺带调用全部插件工具”的幻想空间。

应对：

1. 明确 diary RAG 闭环是第一阶段能力边界
2. 其余能力后续单独建 change

### 风险 3：代理链路更长

说明：

请求路径变为：

`Trae -> MCP transport -> backend -> Gateway Core`

应对：

1. 强制保留 requestId / traceId
2. 保持 machine-readable error details
3. 为 proxy 层补 focused transport tests

---

## 18. 推荐的下一条 change

建议 change 名称：

`agent-gateway-m16-mcp-backend-only-diary-rag-loop`

建议范围：

1. 删除 MCP transport 对本地 runtime 的依赖
2. 新增 backend-only proxy harness 与 HTTP client
3. 发布 bootstrap + memory/context/write 的 MCP descriptor
4. 补 transport、route、闭环验证与 Trae 文档

不建议同条 change 一起做：

1. metrics
2. full resource mirror
3. direct plugin tools remote execution
4. 非 diary RAG 的广泛 capability 扩展

---

## 19. 最终建议

如果目标是：

1. Trae 可接
2. 不再有第二套运行时
3. 只复用现有 VCP backend
4. diary RAG 形成可工作的完整闭环

那么最稳妥的方案不是保留兼容模式，而是：

**直接把 MCP 收口成 backend-only proxy，以 canonical render + bootstrap fallback + memory/context/write 作为稳定 contract。**

这样有三个直接收益：

1. 架构边界清晰，MCP 不再是假后端
2. diary RAG 形成从 recall 到 writeback 的完整链路
3. 后续即使扩更多 MCP capability，也仍然沿着“先 backend canonical，再 transport 发布”的正确方向演进
