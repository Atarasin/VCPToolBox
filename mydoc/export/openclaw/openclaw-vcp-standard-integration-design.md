# OpenClaw 通过标准接口统一接入 VCP 的设计方案

> 历史设计记录：`/admin_api/openclaw/*` 已在后续 change 中退役。当前受支持接入面以 `/agent_gateway/*` 为准，本文件仅用于追溯迁移设计背景。

## 1. 背景与结论

当前 `modules/agentGateway` 已经形成了比较清晰的三层结构：

1. `Gateway Core service bundle`
2. canonical native HTTP surface：`/agent_gateway/*`
3. 标准 MCP adapter：`mcpStdioServer + mcpBackendProxyAdapter`

而旧版 `openclaw-vcp-plugin` 仍然直接消费 `/admin_api/openclaw/*` 这组 OpenClaw 专用兼容接口。这样会带来两个长期问题：

1. `OpenClaw` 仍然绑在旧 bridge contract 上，没有和 `agent_gateway` / `MCP` 统一
2. 后续任何能力扩展都要同时维护 `openclaw` 专用协议和标准协议，容易再次长出第二套语义

基于当前代码现状，推荐的统一方向不是“让 OpenClaw 直接改吃 MCP stdio”，而是：

**让 OpenClaw 保留宿主侧插件形态，但其所有 VCP 能力调用统一改为消费 canonical `/agent_gateway/*` 接口；MCP 继续作为平级标准 adapter 复用同一套 native contract。**

一句话总结：

**OpenClaw 应该变成 `Host Adapter`，而不是继续当 `VCP 专用协议消费者`。**

---

## 2. 现状判断

### 2.1 VCPToolBox 已具备的标准出口

当前仓库里已经存在以下稳定出口：

1. 共享核心装配：`modules/agentGateway/createGatewayServiceBundle.js`
2. Native Gateway beta 路由：`routes/agentGatewayRoutes.js`
3. MCP 后端代理适配：`modules/agentGateway/adapters/mcpBackendProxyAdapter.js`
4. MCP stdio transport：`modules/agentGateway/mcpStdioServer.js`

其中：

- `createGatewayServiceBundle.js` 已明确写出“OpenClaw 与 Native adapter 都应通过这里获取同一组 service 实例”
- `routes/agentGatewayRoutes.js` 已经暴露：
  - `GET /agent_gateway/capabilities`
  - `GET /agent_gateway/memory/targets`
  - `POST /agent_gateway/memory/search`
  - `POST /agent_gateway/context/assemble`
  - `POST /agent_gateway/memory/write`
  - `POST /agent_gateway/tools/:toolName/invoke`
  - `GET /agent_gateway/jobs/:jobId`
  - `POST /agent_gateway/jobs/:jobId/cancel`
  - `GET /agent_gateway/events/stream`
  - `POST /agent_gateway/agents/:agentId/render`
- MCP adapter 已经是对这些 native route 的协议映射，而不是第二套 runtime

### 2.2 旧版 openclaw-vcp-plugin 的问题

旧插件的能力面其实很完整，它不仅注册了桥接工具，还接入了：

1. `registerMemoryRuntime`
2. `registerMemoryPromptSection`
3. `registerMemoryFlushPlan`
4. `registerContextEngine("vcp", ...)`
5. `registerTool(vcp_memory_write)`
6. 启动健康检查与工具快照

但是它的问题也很明确：

1. 客户端 `src/client/vcp-client.ts` 直连 `/admin_api/openclaw/*`
2. 协议模型命名仍然是 `VcpCapabilitiesData / VcpRagSearchData / VcpRagContextData`
3. 插件内部重复定义了一套和 native gateway 高度相似但不完全一致的 DTO、错误模型和访问路径
4. 插件的 allow/deny、diaryMap、recall policy 中有一部分是本地二次判断，不完全以网关 canonical policy 为准

本质上，旧插件已经做成了一个“OpenClaw 宿主适配层 + OpenClaw 专用远程协议客户端”的混合体。

### 2.3 基于 `TODOS.md` 的问题核对结论

对 `TODOS.md` 中列出的问题逐条核对后，可以分成三类。

#### 第一类：合理，且应进入主方案

1. 新增 `/agent_gateway/health` 路由
2. 创建 `AgentGatewayClient` 并切到 `/agent_gateway/*`
3. 重写 client 单测
4. 新增 parity tests
5. 更新日志和 manifest 中的 bridge 命名
6. 验证 `/agent_gateway/memory/write` 与旧写回语义一致
7. 确认 Phase 1 期间不意外破坏旧 `/admin_api/openclaw/*`

这些项都和当前代码现状直接对应：

1. 旧插件启动健康检查仍然调用 `/admin_api/openclaw/health`
2. `routes/agentGatewayRoutes.js` 当前没有 `/agent_gateway/health`
3. 旧插件客户端仍以 OpenClaw 专用 DTO 和大量手写类型守卫消费旧桥接协议
4. 当前仓库已经有 native gateway / MCP 对齐测试基础，适合继续扩成 OpenClaw parity tests

#### 第二类：合理，但需要调整优先级

1. `AgentGatewayClient + Zod schema`
2. auth 兼容性测试
3. deferred job 状态测试

其中：

1. `AgentGatewayClient` 是 Phase 1 核心项
2. Zod schema 收敛是高价值项，但不必阻塞第一版协议迁移
3. deferred job 测试值得做，但优先级应低于 health、capabilities、memory、context、tool invoke 主链路

#### 第三类：方向对，但表述需要修正

`TODOS.md` 中最需要修正的是这条：

1. “basic auth 密码字段兼容映射为 gatewayKey，发送请求时优先使用 `x-agent-gateway-key`”

当前系统里这两个概念不是同一层语义：

1. `server.js` 中 `/agent_gateway` 仍受外层 `adminAuth` 保护
2. `protocolGovernance.js` 中 `x-agent-gateway-key` / bearer 才是 native gateway 内层认证语义

所以更准确的说法应该是：

1. `gatewayKey` / bearer 是 native gateway 首选认证
2. Basic Auth 是当前挂载方式下的兼容访问模式
3. Basic Auth 不能被直接定义成 `gatewayKey` 的等价别名
4. 如果需要兼容映射，只能作为显式过渡 alias，而不是 canonical 语义

下面的设计将按这个修正后的结论展开。

---

## 3. 设计目标

本次统一设计建议满足以下目标：

1. OpenClaw 继续使用自身原生插件生命周期与宿主 API
2. OpenClaw 不再依赖 `/admin_api/openclaw/*` 作为主线协议
3. OpenClaw、MCP、后续其他宿主统一复用 `agent_gateway` canonical contract
4. 不在 OpenClaw 插件里复制 Gateway Core 的业务判断
5. 兼容当前 OpenClaw 已经接入的 memory runtime、context engine、durable memory flush 机制
6. 保留 requestId、agentId、sessionId、traceId、jobId 等 machine-readable 语义
7. 为后续实现提供低回归迁移路径

---

## 4. 非目标

本次方案明确不追求：

1. 不要求 OpenClaw 第一阶段完全改为“只通过 MCP client 接 VCP”
2. 不要求把 OpenClaw 插件彻底删除
3. 不要求马上废弃 `/admin_api/openclaw/*` 兼容入口
4. 不要求第一阶段把 OpenClaw 的所有本地策略都挪回服务端
5. 不要求立即把 `openclaw-vcp-plugin` 改造成 monorepo 内共享包

---

## 5. 方案比较

### 方案 A：继续维护旧 `/admin_api/openclaw/*`

优点：

1. 改动最小
2. 旧插件几乎不用动

缺点：

1. OpenClaw 永远停留在 vendor-specific contract
2. 与 `agent_gateway` / `MCP` 的能力边界持续分叉
3. 新能力需要双写协议与测试

结论：

**不推荐。**

### 方案 B：让 OpenClaw 直接改走 MCP

优点：

1. 看起来最“标准化”
2. 理论上与 Trae / Claude Code 共用一个入口

缺点：

1. OpenClaw 当前核心价值不只是工具调用，还依赖 `registerMemoryRuntime`、`registerContextEngine`、`registerMemoryFlushPlan`
2. MCP 在当前 VCP 设计里更像“外部客户端协议面”，不是 OpenClaw 宿主能力注入面的替代品
3. 直接 MCP 化会失去 OpenClaw 原生 memory/context 生命周期优势，或者又要在插件里做二次桥接

结论：

**现阶段不推荐作为主方案。**

### 方案 C：OpenClaw 保留宿主插件，但改用 `/agent_gateway/*`

优点：

1. 复用标准接口，而不是 OpenClaw 专用接口
2. 保留 OpenClaw 原生插件能力注入点
3. 与 MCP 一起收敛到同一 canonical contract
4. 迁移成本可控，适合渐进替换

缺点：

1. 仍需保留一个 OpenClaw 宿主适配层
2. 需要为旧配置和旧响应模型设计迁移层

结论：

**推荐采用。**

---

## 6. 推荐总体架构

推荐架构如下：

```text
OpenClaw Host
  |
  | plugin lifecycle / registerTool / registerMemoryRuntime / registerContextEngine
  v
openclaw-vcp-plugin (thin host adapter)
  |
  | canonical HTTP client
  v
/agent_gateway/*
  |
  v
Gateway Core service bundle
  |
  +--> CapabilityService
  +--> ToolRuntimeService
  +--> MemoryRuntimeService
  +--> ContextRuntimeService
  +--> AgentRegistryService
  +--> JobRuntimeService
  +--> OperabilityService
```

与 MCP 的关系如下：

```text
Trae / Claude Code / Tool-only Host
  |
  | MCP stdio JSON-RPC
  v
mcpStdioServer + mcpBackendProxyAdapter
  |
  | native HTTP
  v
/agent_gateway/*
```

最终形成的是：

1. `Gateway Core` 负责唯一业务语义
2. `Native agent_gateway` 负责唯一 canonical machine-readable contract
3. `MCP` 是外部生态 adapter
4. `OpenClaw plugin` 是宿主生命周期 adapter

---

## 7. OpenClaw 侧建议分层

建议将 `openclaw-vcp-plugin` 从“远程桥接插件”重定义为“OpenClaw Host Adapter”。

### 7.1 建议保留的宿主层职责

以下职责仍应保留在 OpenClaw 插件侧：

1. `registerTool()` 注册 OpenClaw 可见工具
2. `registerMemoryRuntime()` 注入 OpenClaw memory_search manager
3. `registerMemoryPromptSection()` 注入记忆使用提示
4. `registerMemoryFlushPlan()` 接入 compaction 前 durable memory flush
5. `registerContextEngine()` 接入 OpenClaw assemble 流程
6. 启动健康检查、工具快照与 UI 友好元信息缓存

这些是 OpenClaw 宿主特有能力，不应该挪进 VCP backend。

### 7.2 建议移除的“专用协议层职责”

以下职责不应继续以 OpenClaw 专用协议存在：

1. `/admin_api/openclaw/capabilities` 客户端模型
2. `/admin_api/openclaw/rag/targets` 客户端模型
3. `/admin_api/openclaw/rag/search` 客户端模型
4. `/admin_api/openclaw/rag/context` 客户端模型
5. `/admin_api/openclaw/tools/:toolName` 客户端模型
6. `writeMemory()` 通过桥接工具再转专用写回路径的假设

这些都应改成对 `/agent_gateway/*` 的标准消费。

---

## 8. 插件内部重构建议

### 8.1 客户端层重构

当前的 `VcpClient` 建议升级为 `AgentGatewayClient`，直接对齐 native gateway。

建议的最小 client API：

1. `getCapabilities(agentId, options)`
2. `invokeTool(toolName, args, requestContext, options)`
3. `getMemoryTargets(agentId, options)`
4. `searchMemory(body)`
5. `assembleContext(body)`
6. `writeMemory(body)`
7. `renderAgent(agentId, body)`
8. `getJob(jobId, query)`
9. `cancelJob(jobId, body)`
10. `streamEvents(query)` 可选

对应路由：

1. `GET /agent_gateway/capabilities`
2. `POST /agent_gateway/tools/:toolName/invoke`
3. `GET /agent_gateway/memory/targets`
4. `POST /agent_gateway/memory/search`
5. `POST /agent_gateway/context/assemble`
6. `POST /agent_gateway/memory/write`
7. `POST /agent_gateway/agents/:agentId/render`
8. `GET /agent_gateway/jobs/:jobId`
9. `POST /agent_gateway/jobs/:jobId/cancel`

### 8.2 适配层对象保持不变，但底层换协议

以下对象建议继续保留，但只改底层数据源：

1. `VcpToolRegistry`
2. `VcpMemoryAdapter`
3. `VcpContextEngine`
4. `createVcpBootstrapService`

原因：

1. 它们已经很好地贴合了 OpenClaw SDK 的宿主接口
2. 真正的问题不在宿主装配层，而在下层 remote contract

所以推荐做法是：

**保留宿主适配对象，替换其 client 与 DTO。**

### 8.3 DTO 收敛建议

当前插件里定义的这些类型建议逐步收敛到 gateway 命名：

1. `VcpCapabilitiesData` -> `AgentGatewayCapabilities`
2. `VcpToolInvokeData` -> `AgentGatewayToolInvokeResult`
3. `VcpMemoryTargetsData` -> `AgentGatewayMemoryTargets`
4. `VcpRagSearchData` -> `AgentGatewayMemorySearchResult`
5. `VcpRagContextData` -> `AgentGatewayContextAssembleResult`
6. `VcpMemoryWriteData` -> `AgentGatewayMemoryWriteResult`

命名上的变化很重要，因为它会直接把“消费的是 OpenClaw 专用 bridge”改成“消费的是 VCP 标准接口”。

---

## 9. 配置迁移建议

建议保留现有大部分用户配置语义，但增加标准接口配置字段。

### 9.1 建议新增或调整的配置

建议主配置改成：

1. `gatewayBaseUrl`
2. `gatewayVersion`
3. `gatewayAuth`
4. `capabilitiesAgentId`
5. `toolAllowList`
6. `toolDenyList`
7. `diaryMap`
8. `recallPolicy`
9. `startupHealthcheck`
10. `snapshotCache`

### 9.2 兼容旧字段

第一阶段可做兼容映射：

1. `baseUrl` -> `gatewayBaseUrl`
2. `bridgeVersion` -> `gatewayVersion`
3. `auth` -> `gatewayAuth`

并在日志中提示：

1. 当前字段来自 legacy OpenClaw bridge 配置
2. 后续版本将默认使用 native gateway 命名

### 9.3 认证配置建议

认证配置建议不要再延续旧的单一 `auth` 心智，而是显式区分三类模式：

1. `gatewayKey`
2. `bearer`
3. `basic`

推荐语义如下：

1. `gatewayKey`
   - 对应 `x-agent-gateway-key`
   - 是 native gateway 首选认证模式
2. `bearer`
   - 对应 `Authorization: Bearer ...`
   - 用于与 gateway 专用凭证或代理层 bearer 集成
3. `basic`
   - 对应当前 `server.js` 对 `/agent_gateway` 路径的外层 `adminAuth`
   - 主要是现阶段部署兼容，不应被当作 native gateway 的长期 canonical 认证

建议配置结构为：

1. `gatewayAuth.type = "gatewayKey" | "bearer" | "basic" | "none"`
2. `gatewayAuth.gatewayKey`
3. `gatewayAuth.gatewayId`
4. `gatewayAuth.token`
5. `gatewayAuth.username`
6. `gatewayAuth.password`

兼容策略建议如下：

1. 旧 `auth.type = "basic"` 可以继续支持
2. 但应输出 deprecation log，提示这是“挂载兼容认证”，不是 native gateway 首选模式
3. 不建议在文档中直接定义“basic password = gatewayKey”
4. 如果确实需要迁移便利，可实现显式 alias：
   - 仅当用户选择 `gatewayKey` 模式但未显式提供 `gatewayKey`
   - 才考虑从旧 secret 字段回填
   - 同时输出明确 deprecation 日志

### 9.4 policy 的推荐边界

建议策略边界遵循“服务端主控，客户端补充”原则：

1. diary 是否允许，优先由 `agent_gateway` 服务端判定
2. tool scope 是否允许，优先由 `agent_gateway` 服务端判定
3. OpenClaw 插件本地 allow/deny 只做额外收紧，不做放宽

这样可以避免插件配置与网关策略相互打架。

---

## 10. 能力映射建议

### 10.1 工具能力

旧插件当前是：

1. 拉取 capabilities
2. 本地过滤
3. 调 `registerTool()`
4. 执行时 `POST /admin_api/openclaw/tools/:toolName`

建议改为：

1. `GET /agent_gateway/capabilities`
2. 保留本地 allow/deny 收紧过滤
3. 调 `registerTool()`
4. 执行时 `POST /agent_gateway/tools/:toolName/invoke`

### 10.2 memory runtime

旧插件当前是：

1. `GET /admin_api/openclaw/rag/targets`
2. `POST /admin_api/openclaw/rag/search`

建议改为：

1. `GET /agent_gateway/memory/targets`
2. `POST /agent_gateway/memory/search`

### 10.3 context assemble

旧插件当前是：

1. `POST /admin_api/openclaw/rag/context`

建议改为：

1. `POST /agent_gateway/context/assemble`

### 10.4 durable memory write

旧插件当前是：

1. 通过 `vcp_memory_write` 工具在插件侧包装写回
2. 底层仍按 OpenClaw bridge 的工具协议组织参数

建议改为：

1. `vcp_memory_write` 仍保留，供 OpenClaw compaction flush 与 agent 主流程使用
2. 但其底层统一改成 `POST /agent_gateway/memory/write`
3. 幂等键、去重、target/maid 等语义完全跟随 native gateway

### 10.5 agent bootstrap

如果 OpenClaw 后续需要 agent bootstrap / prompt render 能力，建议优先接：

1. `POST /agent_gateway/agents/:agentId/render`

而不是再发明新的 OpenClaw 专用 prompt route。

### 10.6 health check

这一项应从“建议”上升为 **Phase 1 必做项**。

原因很直接：

1. 旧插件的 `startupHealthcheck` 已经默认开启
2. 旧客户端当前调用的是 `/admin_api/openclaw/health`
3. native `agent_gateway` 当前还没有对等的 `/agent_gateway/health`

因此如果要让 OpenClaw 插件真正迁移到标准接口，VCPToolBox 侧需要补一个 canonical health route，例如：

1. `GET /agent_gateway/health`

建议返回最小稳定结构：

1. `status`
2. `serverTime`
3. `pluginManagerReady`
4. `knowledgeBaseReady`
5. `gatewayVersion`

这条 route 的定位应该是：

1. 供 OpenClaw 插件启动探活使用
2. 供后续 native SDK / 自研宿主统一做健康检查
3. 不再让健康检查依附于 legacy OpenClaw bridge

---

## 11. 建议实施阶段

### Phase 1：协议收口，不改宿主装配

目标：

1. 先把 `openclaw-vcp-plugin` 的数据源从 `/admin_api/openclaw/*` 换成 `/agent_gateway/*`
2. 不改现有 `registerTool/registerMemoryRuntime/registerContextEngine` 装配结构

工作项：

1. VCPToolBox 侧新增 `GET /agent_gateway/health`
2. 在 `openclaw-vcp-plugin` 内新增 `AgentGatewayClient`
3. 保留旧 `VcpClient` 作为兼容包装，或直接替换
4. 更新 `VcpToolRegistry`
5. 更新 `VcpMemoryAdapter`
6. 更新 `VcpContextEngine`
7. 更新启动健康检查与快照逻辑
8. 显式梳理认证模式：
   - `gatewayKey` 为首选
   - `bearer` 为可选
   - `basic` 为现阶段挂载兼容

验收标准：

1. OpenClaw 现有功能保持可用
2. 网络请求全部切到 `/agent_gateway/*`
3. health check 切到 `/agent_gateway/health`
4. 不再依赖 `/admin_api/openclaw/*`

### Phase 2：命名与模型收敛

目标：

1. 清理插件内部 legacy 命名
2. 让 OpenClaw 插件从“bridge plugin”转成“host adapter”

工作项：

1. 重命名 client / DTO / config
2. 更新 README / CHANGELOG / plugin manifest 描述
3. 将 `VCP Bridge` 对外描述调整为 `VCP Agent Gateway Adapter for OpenClaw`

验收标准：

1. 新命名不再暗示专用 bridge 协议
2. 开发者能一眼看出该插件只是宿主适配层

### Phase 3：回收 legacy 兼容面

目标：

1. 当 OpenClaw 新插件稳定后，逐步收缩 `/admin_api/openclaw/*`

建议步骤：

1. 先将其标记为 legacy compatibility surface
2. 保留一段版本窗口
3. 最后只保留必要 shim，或彻底下线

前提：

1. OpenClaw 新插件已稳定使用 `/agent_gateway/*`
2. 没有外部仍依赖旧协议的关键宿主

---

## 12. 为什么不推荐“OpenClaw 直接变成 MCP 客户端”

这个问题需要单独强调。

虽然从“标准协议”角度看，MCP 很吸引人，但当前 OpenClaw 的价值并不只是调用工具，而是：

1. 以插件方式向 OpenClaw 注册工具
2. 将 VCP 接入 OpenClaw 的 memory runtime
3. 将 VCP recall 接入 OpenClaw 的 context assemble 生命周期
4. 在 compaction 前触发 durable memory flush 计划

这些都属于宿主内嵌能力，而不是普通外部工具发现能力。

所以更合适的分工是：

1. `MCP` 负责外部通用接入
2. `OpenClaw plugin` 负责 OpenClaw 原生生命周期接入
3. 二者都统一消费 `/agent_gateway/*`

这才是真正的统一，而不是把所有宿主都强行塞成 MCP client。

---

## 13. 测试与验证设计

由于这次是协议迁移，测试应优先验证“语义不退化”，而不是只测单点函数。

### 13.1 OpenClaw 插件侧测试

建议新增或改造以下测试：

1. `AgentGatewayClient` 单测
   - 覆盖 health / capabilities / memory targets / memory search / context assemble / memory write / tool invoke / render / job
   - 覆盖 200 / 202 / 4xx / 5xx 响应解析
   - 覆盖 request timeout、错误码、trace/request 元信息读取
   - 覆盖 `gatewayKey / bearer / basic` 三类认证请求头构造

2. `VcpToolRegistry` 单测
   - 验证 tools 来源改为 `GET /agent_gateway/capabilities`
   - 验证执行改为 `POST /agent_gateway/tools/:toolName/invoke`
   - 验证 allow/deny 只做额外收紧

3. `VcpMemoryAdapter` 单测
   - 验证 targets/search/write 全部走 native gateway
   - 验证 diary 选择、缓存读取、写回幂等语义不退化

4. `VcpContextEngine` 单测
   - 验证 assemble 调用改走 `POST /agent_gateway/context/assemble`
   - 验证 recall blocks 注入逻辑保持不变

5. `index.ts` 入口测试
   - 验证 OpenClaw 插件仍然注册 memory runtime、context engine、flush plan、writeback tool

这里建议直接参考 VCPToolBox 仓库中已经存在的 `AgentGatewayClient` 示例与测试模式，而不是从零设计新的 HTTP client 行为。

### 13.2 端到端语义对齐测试

建议新增一组“native gateway parity tests”，目标是确认 OpenClaw adapter 与 canonical route 语义一致。

重点覆盖：

1. capabilities 对齐
2. tool invoke completed / accepted / waiting_approval 对齐
3. memory targets 对齐
4. memory search diagnostics 对齐
5. context assemble recallBlocks / estimatedTokens 对齐
6. memory write 幂等与 deduplicate 对齐
7. agent render 对齐
8. job get / cancel 对齐

其中优先级建议分两层：

1. P0
   - health
   - capabilities
   - tool invoke
   - memory targets/search/write
   - context assemble
2. P1
   - agent render
   - deferred job get / cancel
   - events stream

### 13.3 回归测试策略

推荐维持三层验证：

1. OpenClaw 插件单测
2. `agent_gateway` native route 集成测试
3. MCP 与 native gateway 语义一致性测试

目标不是让三套实现分别测试，而是证明：

**OpenClaw adapter 与 MCP adapter 只是不同宿主壳，底层 contract 必须一致。**

---

## 14. 风险与应对

### 风险 1：OpenClaw 插件仍保留过多本地策略

表现：

1. 本地 allow/deny、diaryMap、recallPolicy 与服务端策略冲突

应对：

1. 服务端作为准入主控
2. 插件本地只允许“额外收紧”
3. 在日志中输出最终有效 agentId / diary / policy summary

### 风险 2：native gateway 的返回模型与旧插件 DTO 不完全兼容

表现：

1. 某些字段命名或 envelope 结构变化导致插件适配层异常

应对：

1. 在 Phase 1 先做 adapter shim
2. 先保证兼容，再做 DTO 改名

### 风险 3：OpenClaw 对 deferred job 的消费不足

表现：

1. `accepted` / `waiting_approval` 状态有了，但 OpenClaw 插件没有完整利用

应对：

1. 第一阶段先透传 job identity 与状态
2. 第二阶段再决定是否在 OpenClaw UI 或 service 层补更完整的 job follow-up

### 风险 4：旧 `/admin_api/openclaw/*` 仍被其他调用方依赖

应对：

1. 先加 deprecation 文档
2. 统计调用来源
3. 版本窗口内保留 shim

### 风险 5：把 Basic Auth 和 gatewayKey 混成同一语义

表现：

1. 迁移后客户端以为只要填旧 basic password 就一定等价于 native gateway key
2. 结果在某些部署里访问 `/agent_gateway/*` 失败，或者错误地绕过了预期认证层

应对：

1. 文档中明确“外层挂载认证”和“内层 gateway 专用认证”是两层语义
2. 配置结构显式区分 `basic`、`gatewayKey`、`bearer`
3. 兼容映射只作为过渡 alias，不作为 canonical 定义

---

## 15. 推荐落地顺序

如果按最小冲突顺序推进，建议这样排：

1. 先在 VCPToolBox 侧补 `GET /agent_gateway/health`
2. 再在 `openclaw-vcp-plugin` 内新增 native `AgentGatewayClient`
3. 让工具发现、工具执行、memory、context、writeback、health 全部切到 `/agent_gateway/*`
4. 保持 OpenClaw 插件宿主装配不动
5. 增加 P0 parity tests，证明 OpenClaw adapter 与 native gateway 语义一致
6. 再做命名清理和配置迁移
7. 最后再考虑回收 `/admin_api/openclaw/*`

这个顺序的核心好处是：

1. 不会一次性同时改协议、宿主装配、产品命名
2. 可以先把“统一标准接口 + 健康检查闭环”这件最关键的事情落地
3. 能最大限度复用旧插件已经验证过的 OpenClaw integration 代码

---

## 16. 最终建议

最终建议只有一条主线：

**不要把 OpenClaw 也做成另一种 VCP 私有桥，而要把它收口成消费 canonical `agent_gateway` 的宿主适配层。**

对应到实现上就是：

1. `Gateway Core` 继续作为唯一业务核心
2. `/agent_gateway/*` 继续作为唯一标准 HTTP contract
3. `MCP` 继续作为外部生态 adapter
4. `openclaw-vcp-plugin` 变成薄的 OpenClaw host adapter
5. `/admin_api/openclaw/*` 进入 legacy compatibility 轨道

这样处理后，整体拓扑会非常清晰：

```text
Gateway Core
   ^
   |
Native agent_gateway  <--- canonical contract
   ^            ^
   |            |
OpenClaw      MCP
Host Adapter  External Adapter
```

这条路线最符合当前代码已经形成的结构，也最利于后续继续扩展更多宿主，而不会再次复制一套 VCP 语义。
