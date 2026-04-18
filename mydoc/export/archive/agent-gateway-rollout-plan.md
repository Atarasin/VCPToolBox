# VCP Agent Gateway 落地实施方案

> 文档目标：在 `agent-first-export-options.md` 的方向性方案基础上，进一步给出一份可以直接指导开发排期、模块拆分、接口设计、迁移执行和测试验收的完整落地蓝图。
>
> 当前状态基线：`Gateway Core` 的第一阶段抽离已经完成，`routes/openclawBridgeRoutes.js` 已经降为兼容 shim，核心逻辑暂时集中在 `modules/agentGatewayCore.js`。

---

## 1. 结论先行

推荐采用下面这条落地路线：

1. **先把当前单体 `agentGatewayCore.js` 拆成真正的 Gateway Core 子模块**
2. **再补齐 Agent Registry，使 VCP 可以正式导出 agent 定义**
3. **随后推出 Native Agent Gateway，形成 VCP 自己的 canonical protocol**
4. **将 OpenClaw 适配层持续瘦身，只保留协议映射**
5. **最后接入 MCP adapter，扩展外部 agent 生态**

一句话概括：

**短期目标不是“再新增几个接口”，而是“把已经验证过的 OpenClaw bridge 能力，沉淀成可复用、可治理、可演进的 Agent Gateway 平台内核”。**

---

## 2. 当前基线与关键判断

### 2.1 已经具备的能力

当前代码已经证明 VCP 可以对外导出以下能力：

- capability discovery
- tool invocation
- memory search
- context assemble
- durable memory write-back

也就是说，VCP 现在缺的不是“对外能力本身”，而是：

- 缺统一的核心能力模型
- 缺 agent-first 的正式协议边界
- 缺独立于 `/admin_api` 的身份与权限语义
- 缺从单一 adapter 向多协议复用演进的结构

### 2.2 当前第一阶段抽离的真实定位

当前 `modules/agentGatewayCore.js` 的价值主要有两个：

1. 它已经把 `routes/openclawBridgeRoutes.js` 的大部分实现从 route 层移走
2. 它为后续拆分成多个 service 提供了唯一入口

但它依然是一个**过渡态单体模块**，还存在这些问题：

- 仍保留大量 `OpenClaw` 命名
- 路由、业务、契约、错误映射、审计逻辑仍耦合在一起
- 尚未形成真正的 `core service + adapter` 结构
- 还没有 native gateway 与 registry 的公共契约层

因此，这份落地方案将以“**从过渡态单体 Core，演进为正式 Gateway 平台结构**”为主线。

---

## 3. 总体目标

本次落地的终局目标不是单纯提供一组 API，而是形成一套可长期演进的 Agent Gateway 能力层。

### 3.1 业务目标

- 让外部 agent 宿主能稳定接入 VCP 的工具、记忆、上下文与 agent 定义
- 让 VCP 成为 agent 能力的统一提供方，而不是某个宿主的桥接对象
- 让 OpenClaw、MCP、自研宿主都复用同一套内核逻辑

### 3.2 工程目标

- 消除现有 `agentGatewayCore.js` 的单体耦合
- 建立清晰的模块边界、协议边界和策略边界
- 为鉴权、审计、异步任务、能力版本化预留明确扩展点

### 3.3 成功标准

落地完成后，至少应满足以下标准：

- OpenClaw adapter 不再承载核心业务逻辑
- Native Gateway 可以独立作为正式机读协议使用
- Agent Registry 可稳定导出 agent 定义与 render 结果
- 至少两类 adapter 可以复用同一套 core service
- 关键链路具备自动化测试和回归验证方案

---

## 4. 设计原则

### 4.1 Core 先于 Adapter

先定义 VCP 自己的能力模型，再做 OpenClaw/MCP 映射；不能让 adapter 倒过来决定 core 的结构。

### 4.2 Agent 优先，不以后台管理语义为中心

对外协议必须围绕：

- `agent identity`
- `session identity`
- `tool scope`
- `memory scope`
- `request trace`

而不是围绕后台管理员身份。

### 4.3 资源对象一等公民

不要把所有能力都折叠成 tool。至少要把这些对象独立对待：

- agent
- capability
- tool runtime
- memory runtime
- context runtime
- job runtime
- event stream

### 4.4 兼容优先、渐进迁移

短期内保留现有 OpenClaw 路由和测试，采用“内部重构、外部兼容”的方式推进，避免一次性切换造成回归风险。

### 4.5 所有关键行为必须可审计

每次能力发现、工具执行、记忆检索、写回、审批等待、异步任务都要能追踪：

- requestId
- sessionId
- agentId
- adapter source
- policy decision
- latency

---

## 5. 目标架构

推荐最终结构如下：

```text
External Hosts
  |- OpenClaw
  |- MCP Client
  |- Native SDK / Custom Agent Host

Protocol Adapters
  |- routes/openclawBridgeRoutes.js
  |- routes/agentGatewayRoutes.js
  `- future: mcp server adapter

Gateway Core
  |- contracts
  |- policy
  |- services
  |- infra
  `- adapter bridge helpers

Platform Backends
  |- agentManager
  |- PluginManager
  |- KnowledgeBaseManager / RAGDiaryPlugin
  `- WebSocket distributed runtime
```

核心思想：

- `routes/*` 只做协议适配和参数映射
- `modules/agentGateway/*` 承载统一业务逻辑
- 现有 `Plugin.js`、`KnowledgeBaseManager.js`、`modules/agentManager.js` 继续作为底层依赖
- 后续的 `MCP adapter` 不重新实现业务，只消费 core service

---

## 6. 推荐目录与模块拆分

建议在后续开发中，将当前单体 `modules/agentGatewayCore.js` 逐步重组为下面的目录结构。

```text
modules/
`- agentGateway/
   |- index.js
   |- contracts/
   |  |- requestContext.js
   |  |- capabilityModel.js
   |  |- errorCodes.js
   |  |- responseEnvelope.js
   |  `- schemas.js
   |- policy/
   |  |- authContextResolver.js
   |  |- agentPolicyResolver.js
   |  |- diaryScopeGuard.js
   |  `- toolScopeGuard.js
   |- services/
   |  |- capabilityService.js
   |  |- agentRegistryService.js
   |  |- toolRuntimeService.js
   |  |- memoryRuntimeService.js
   |  |- contextRuntimeService.js
   |  `- jobRuntimeService.js
   |- infra/
   |  |- auditLogger.js
   |  |- trace.js
   |  |- schemaRegistry.js
   |  |- idempotencyStore.js
   |  `- errorMapper.js
   `- adapters/
      |- openclawAdapter.js
      |- nativeHttpAdapter.js
      `- mcpAdapter.js
```

### 6.1 `index.js`

职责：

- 组装 core 依赖
- 暴露 service facade
- 提供 adapter 可复用的统一入口

建议输出：

- `createAgentGateway(pluginManager, options)`

### 6.2 `contracts/*`

职责：

- 定义统一的 requestContext
- 定义统一的 response envelope
- 定义稳定错误码
- 定义 capability model
- 统一各类接口的 machine-readable schema

这里的目标是把“协议契约”从“实现细节”中剥离出来。

### 6.3 `policy/*`

职责：

- 从请求中解析 agent 身份与 gateway 身份
- 将 agent 映射到 tool scope / diary scope
- 统一做访问控制
- 隔离当前 `/admin_api` Basic Auth 与未来 gateway auth 的差异

### 6.4 `services/*`

职责：

- 对外提供稳定的业务服务接口
- 内部复用现有 VCP 模块
- 不关心 HTTP、OpenClaw 或 MCP 的协议细节

### 6.5 `infra/*`

职责：

- trace、审计、错误映射、幂等控制、schema 注册
- 为后续异步任务与事件流提供基础设施

### 6.6 `adapters/*`

职责：

- 把外部协议映射到 core request / core response
- 尽量不携带业务逻辑
- 保持 OpenClaw、Native、MCP 三种适配层风格统一

---

## 7. 服务边界设计

### 7.1 `CapabilityService`

负责：

- 汇总工具能力
- 汇总 memory/context/jobs/events 能力说明
- 结合 agent policy 进行能力过滤
- 输出 canonical capability model

输入：

- `requestContext`
- `authContext`
- `agentId`
- `includeTargets` 等查询参数

输出：

- server info
- resolved agent capability scope
- tools 列表
- memory / context / jobs / events 描述

### 7.2 `AgentRegistryService`

负责：

- 从 `agentManager` 拉取 agent alias 与文件映射
- 获取 prompt 原文
- 输出 agent 元信息
- 生成 render 结果

建议后续新增能力：

- hash
- mtime
- source file
- alias
- display name
- tag / capability hint
- default policy

### 7.3 `ToolRuntimeService`

负责：

- 校验工具调用参数
- 应用 tool scope 和 approval policy
- 调用 `PluginManager.processToolCall()`
- 统一同步结果、审批等待、超时、异步句柄的返回结构

建议内部统一输出：

- `completed`
- `accepted`
- `waiting_approval`
- `failed`

### 7.4 `MemoryRuntimeService`

负责：

- diary target 枚举
- memory search
- durable memory write
- 幂等写入
- memory scope 校验

建议将当前 `vcp_memory_write` 的桥接能力视为 memory runtime 的一部分，而不是长期的正式 tool。

### 7.5 `ContextRuntimeService`

负责：

- 对 recent messages 进行 recall query 生成
- 调用向量搜索与时间范围限制逻辑
- 组装 recall blocks
- 处理 token budget、min score、去重与截断

### 7.6 `JobRuntimeService`

初期可先做最小骨架，职责包括：

- 为异步工具调用生成 job handle
- 提供 poll / cancel 查询
- 与审批等待、长任务插件对接

初期即使先不完整实现，也建议把接口和内部抽象预留出来，避免以后重写 tool runtime。

---

## 8. 对现有代码的具体重构方案

### 8.1 现有代码状态

当前关系是：

- `routes/openclawBridgeRoutes.js` 仅做 shim
- `modules/agentGatewayCore.js` 同时承担：
  - 路由注册
  - 请求参数处理
  - 能力发现
  - schema 推导
  - RAG 搜索
  - 上下文组装
  - 记忆写回
  - 审计输出
  - 错误映射

这说明第一阶段已经完成“从 route 中挪出”，但还没有完成“业务服务化”。

### 8.2 第二阶段重构目标

建议按下面顺序切：

1. 先把纯工具函数移入 `contracts` 和 `infra`
2. 再把 capability / tool / memory / context 逻辑拆到 `services`
3. 最后再把路由定义从 `agentGatewayCore.js` 拆成 `adapters`

### 8.3 推荐拆分顺序

#### 第一步：抽纯函数

先抽离这些无状态能力：

- requestId 生成
- response envelope
- schema 推导辅助
- query/body normalize
- 审计格式化
- 错误码映射

目标：

- 尽快降低 `agentGatewayCore.js` 文件体积
- 为后续服务拆分创造稳定公共依赖

#### 第二步：抽 `CapabilityService`

优先拆它的原因是：

- 风险低
- 读多写少
- 对外协议价值高
- 容易先让 Native Gateway 和 OpenClaw 共享

#### 第三步：抽 `MemoryRuntimeService` 和 `ContextRuntimeService`

这两部分是 VCP 高价值能力，也是最需要稳定抽象的部分。

#### 第四步：抽 `ToolRuntimeService`

这里涉及：

- schema 校验
- 插件调用
- approval policy
- timeout / error mapping

虽然复杂，但一旦抽出来，OpenClaw 和 MCP 的工具调用路径就能统一。

#### 第五步：抽 `AgentRegistryService`

这个阶段可以和原生 `/agent_gateway/agents*` 一起推进。

---

## 9. 原生协议设计

建议新增正式原生前缀：

- `/agent_gateway`

不建议继续把正式导出层挂在 `/admin_api` 下。

### 9.1 API 分组

建议初版资源如下：

- `GET /agent_gateway/capabilities`
- `GET /agent_gateway/agents`
- `GET /agent_gateway/agents/:agentId`
- `POST /agent_gateway/agents/:agentId/render`
- `GET /agent_gateway/memory/targets`
- `POST /agent_gateway/memory/search`
- `POST /agent_gateway/memory/write`
- `POST /agent_gateway/context/assemble`
- `POST /agent_gateway/tools/:toolName/invoke`
- `POST /agent_gateway/jobs`
- `GET /agent_gateway/jobs/:jobId`
- `POST /agent_gateway/jobs/:jobId/cancel`
- `GET /agent_gateway/events/stream`

### 9.2 统一请求上下文

建议所有执行型接口都接收：

```json
{
  "requestContext": {
    "requestId": "req_xxx",
    "sessionId": "sess_xxx",
    "agentId": "nova.planner",
    "source": "openclaw|mcp|native",
    "runtime": "openclaw|mcp|native",
    "tenantId": "optional",
    "workspaceId": "optional"
  }
}
```

说明：

- `source` 用于审计来源
- `runtime` 用于兼容性判断
- `agentId` 用于权限和记忆边界
- `sessionId` 用于会话追踪和未来 compact / resume

### 9.3 统一响应包络

建议统一为：

```json
{
  "success": true,
  "data": {},
  "meta": {
    "requestId": "req_xxx",
    "gatewayVersion": "v1",
    "durationMs": 12
  }
}
```

错误响应：

```json
{
  "success": false,
  "error": "human readable message",
  "code": "AGW_xxx",
  "details": {},
  "meta": {
    "requestId": "req_xxx",
    "gatewayVersion": "v1",
    "durationMs": 12
  }
}
```

说明：

- OpenClaw 适配层可以继续保留兼容头和兼容字段
- Native Gateway 建议开始统一使用 `gatewayVersion`

### 9.4 统一状态模型

建议执行型接口输出标准状态：

- `completed`
- `accepted`
- `waiting_approval`
- `failed`

这样后续接入异步任务和 MCP 时不会再次修改核心模型。

---

## 10. Agent Registry 设计

### 10.1 目标

让外部系统无需直接读取管理侧文件接口，也能知道：

- VCP 中有哪些 agent
- 每个 agent 对应哪个源文件
- prompt 如何渲染
- 它的默认策略和能力边界是什么

### 10.2 与现有 `agentManager` 的关系

建议采用“**复用存量、补一层导出语义**”的方式：

- 继续使用 `agentManager` 管理 alias 与文件缓存
- 不直接暴露其内部结构
- 由 `AgentRegistryService` 输出 agent-first 的对外对象

### 10.3 建议返回字段

`GET /agent_gateway/agents`

建议至少返回：

- `agentId`
- `alias`
- `sourceFile`
- `exists`
- `mtime`
- `hash`
- `summary`
- `defaultPolicies`
- `capabilityHints`

`GET /agent_gateway/agents/:agentId`

建议补充：

- prompt raw
- prompt size
- rendered preview metadata
- accessible tools
- accessible memory targets

`POST /agent_gateway/agents/:agentId/render`

建议输入：

- render variables
- target runtime
- include metadata

建议输出：

- rendered system prompt
- dependencies used
- truncation / warning 信息

### 10.4 注意事项

- 不能把后台管理用途的“浏览目录”“编辑 agent 文件”能力混进 registry
- registry 要回答的是“定义导出”，不是“后台编辑”

---

## 11. 鉴权与策略设计

### 11.1 为什么必须单独设计

当前 OpenClaw 路由挂在 `/admin_api` 下，继承的是后台 Basic Auth。这可以继续作为过渡方案，但不能作为长期正式语义。

### 11.2 推荐身份模型

建议拆成三层身份：

1. `gateway identity`
2. `agent identity`
3. `session identity`

#### `gateway identity`

表示“谁在接入 VCP”，例如：

- OpenClaw
- 某个 MCP server
- 某个自研 agent host

#### `agent identity`

表示“当前调用代表哪个 agent”。

#### `session identity`

表示“本次对话 / 任务链路是什么”。

### 11.3 推荐鉴权演进路径

#### 阶段 A：兼容期

- 继续允许 `/admin_api/openclaw/*` 走现有 Basic Auth
- 新增 `/agent_gateway/*` 时也可以先复用 admin 鉴权
- 但内部要已经开始生成独立 `authContext`

#### 阶段 B：分离期

- 为 `/agent_gateway/*` 增加独立 gateway key
- 支持 header 传入 agentId
- 在 core 内做 tool scope / diary scope 校验

#### 阶段 C：正式期

- 管理接口与 agent runtime 鉴权彻底分离
- 管理员身份不默认拥有所有 runtime 权限

### 11.4 策略解析器

建议新增：

- `authContextResolver`
- `agentPolicyResolver`
- `toolScopeGuard`
- `diaryScopeGuard`

作用：

- 避免权限逻辑分散在各个 route 中
- 为未来租户、项目隔离、审批流程预留统一入口

---

## 12. 错误码与可观测性设计

### 12.1 错误码原则

不能长期依赖 message 文本，应统一稳定错误码。

建议前缀：

- `AGW_` for Agent Gateway canonical errors

例如：

- `AGW_BAD_REQUEST`
- `AGW_UNAUTHORIZED`
- `AGW_FORBIDDEN`
- `AGW_AGENT_NOT_FOUND`
- `AGW_TOOL_NOT_FOUND`
- `AGW_TOOL_VALIDATION_FAILED`
- `AGW_TOOL_TIMEOUT`
- `AGW_MEMORY_TARGET_FORBIDDEN`
- `AGW_MEMORY_WRITE_DUPLICATE`
- `AGW_CONTEXT_BUDGET_EXCEEDED`
- `AGW_INTERNAL_ERROR`

OpenClaw adapter 可以在外层继续映射成 `OCW_*` 风格以保持兼容。

### 12.2 审计日志

建议统一记录：

- requestId
- sessionId
- agentId
- adapter source
- operation type
- target tool / diary / agent
- result status
- durationMs
- policy decision

### 12.3 Trace 传播

建议在 core 层统一挂接：

- `requestId`
- `sessionId`
- `agentId`
- `source`

并向下游插件调用透传内部上下文，而不是继续让各 adapter 自己拼 `__openclawContext`。

长期建议演进为：

- `__agentGatewayContext`

OpenClaw adapter 在兼容期仍可附带 `__openclawContext`。

---

## 13. 异步任务与事件流设计

### 13.1 为什么现在就要设计

即使第一版不完整实现，也必须在 core 中预留模型，否则未来一旦支持：

- 审批等待
- 长任务插件
- 流式工具输出
- distributed async execution

就会推翻现有工具调用协议。

### 13.2 最小可行方案

建议先做 polling 版本：

- `POST /agent_gateway/jobs`
- `GET /agent_gateway/jobs/:jobId`
- `POST /agent_gateway/jobs/:jobId/cancel`

第一版可以只支持：

- 工具执行异步句柄
- 审批等待状态查询

### 13.3 后续扩展

第二阶段可增加：

- `GET /agent_gateway/events/stream` SSE
- 与 `WebSocketServer.js` 的事件桥接
- webhook push

---

## 14. 适配层设计

### 14.1 OpenClaw Adapter

定位：

- 兼容现有 OpenClaw 协议与路径
- 只负责请求格式转换、字段映射和错误码映射
- 不承载业务判断

后续目标：

- 保留 `/admin_api/openclaw/*`
- 继续复用现有测试
- 将 `OpenClaw` 语义逐步限制在 adapter 内

### 14.2 Native HTTP Adapter

定位：

- VCP 自己的正式机读协议
- 作为 canonical contract 对外暴露
- 后续 SDK 和更多宿主都应优先对接这里

### 14.3 MCP Adapter

定位：

- 生态扩展层
- 重点先做 tool export
- memory/context/agent registry 再逐步映射

注意：

- MCP adapter 不能直接读取底层模块
- 必须走 Gateway Core

---

## 15. 分阶段实施计划

下面给出建议排期顺序。为降低回归风险，采用“先内部重构，再开新出口”的方式。

### Phase 0：基线冻结与保护

目标：

- 固定当前 OpenClaw 兼容行为
- 为后续重构提供回归保护

工作项：

- 保留并扩展 `test/openclaw-bridge-routes.test.js`
- 记录当前能力响应样例
- 记录当前错误码与响应结构

验收标准：

- 当前 24 个 OpenClaw bridge 测试持续全绿
- 新增重构前后的响应快照对比基线

### Phase 1：Core 服务化拆分

目标：

- 把 `modules/agentGatewayCore.js` 从单体过渡态拆成模块化 core

工作项：

- 新建 `modules/agentGateway/`
- 抽 `contracts`
- 抽 `infra`
- 抽 `CapabilityService`
- 抽 `MemoryRuntimeService`
- 抽 `ContextRuntimeService`
- 抽 `ToolRuntimeService`
- 将旧 `agentGatewayCore.js` 降级为组装入口

验收标准：

- `routes/openclawBridgeRoutes.js` 继续保持 shim
- `agentGatewayCore.js` 显著变薄
- OpenClaw 现有测试全部通过

### Phase 2：Agent Registry 导出

目标：

- 正式导出 agent 定义能力

工作项：

- 新增 `AgentRegistryService`
- 新增 `/agent_gateway/agents`
- 新增 `/agent_gateway/agents/:agentId`
- 新增 `/agent_gateway/agents/:agentId/render`
- 与 `agentManager` 对接

验收标准：

- 外部宿主可不依赖管理端文件接口拿到 agent 定义
- registry 输出包含 hash / mtime / source file 等元信息

### Phase 3：Native Gateway Beta

目标：

- 推出 VCP 自己的正式原生导出协议

工作项：

- 新增 `routes/agentGatewayRoutes.js`
- 接出 capabilities / tools / memory / context / agents
- 统一 response envelope、error code、requestContext

验收标准：

- 同一套 core 同时支撑 OpenClaw 与 Native 两个 adapter
- 增加 native 协议集成测试

### Phase 4：Auth / Policy / Job Runtime

目标：

- 补齐治理能力和异步能力骨架

工作项：

- 加入 gateway key 机制
- 加入独立 `authContext`
- 新增 `jobRuntimeService`
- 新增 poll / cancel
- 标准化 `waiting_approval`

验收标准：

- tool scope / diary scope 测试覆盖完成
- 批准等待与异步句柄有稳定协议结构

### Phase 5：MCP Adapter

目标：

- 扩展到更广泛 agent 生态

工作项：

- 将 canonical tool model 映射为 MCP tools
- 设计 agent / prompt / memory 的最小 MCP 暴露方案
- 验证至少一个 MCP client 接入成功

验收标准：

- 不复制核心业务逻辑
- OpenClaw / Native / MCP 三者均复用 Gateway Core

---

## 16. 推荐文件改造清单

下面列出建议实际会动到的主要文件。

### 16.1 新增文件

- `modules/agentGateway/index.js`
- `modules/agentGateway/contracts/requestContext.js`
- `modules/agentGateway/contracts/errorCodes.js`
- `modules/agentGateway/contracts/responseEnvelope.js`
- `modules/agentGateway/contracts/capabilityModel.js`
- `modules/agentGateway/policy/authContextResolver.js`
- `modules/agentGateway/policy/agentPolicyResolver.js`
- `modules/agentGateway/policy/toolScopeGuard.js`
- `modules/agentGateway/policy/diaryScopeGuard.js`
- `modules/agentGateway/services/capabilityService.js`
- `modules/agentGateway/services/agentRegistryService.js`
- `modules/agentGateway/services/toolRuntimeService.js`
- `modules/agentGateway/services/memoryRuntimeService.js`
- `modules/agentGateway/services/contextRuntimeService.js`
- `modules/agentGateway/services/jobRuntimeService.js`
- `modules/agentGateway/infra/auditLogger.js`
- `modules/agentGateway/infra/trace.js`
- `modules/agentGateway/infra/errorMapper.js`
- `routes/agentGatewayRoutes.js`

### 16.2 逐步瘦身文件

- `modules/agentGatewayCore.js`
- `routes/openclawBridgeRoutes.js`

### 16.3 需要接入或适配的现有文件

- `server.js`
- `modules/agentManager.js`
- `Plugin.js`
- `KnowledgeBaseManager.js`
- `WebSocketServer.js`

---

## 17. 测试与验证方案

结合当前项目“以生产验证为主、无系统化单测框架”的现实，建议采用“**最少但关键**”的测试策略。

### 17.1 必保留的兼容测试

继续保留并扩展：

- `test/openclaw-bridge-routes.test.js`

它的作用是：

- 保护旧协议不回归
- 验证 adapter 薄化过程中外部行为不变

### 17.2 新增 Core 级测试

建议新增：

- `test/agent-gateway-capability-service.test.js`
- `test/agent-gateway-memory-runtime.test.js`
- `test/agent-gateway-context-runtime.test.js`
- `test/agent-gateway-tool-runtime.test.js`
- `test/agent-gateway-agent-registry.test.js`

重点测试内容：

- scope 过滤
- schema 校验
- requestContext 传播
- error code 稳定性
- memory 幂等写入
- context budget / truncation 行为

### 17.3 Native Gateway 集成测试

建议新增：

- `test/agent-gateway-routes.test.js`

验证：

- `/agent_gateway/capabilities`
- `/agent_gateway/agents`
- `/agent_gateway/memory/search`
- `/agent_gateway/context/assemble`
- `/agent_gateway/tools/:toolName/invoke`

### 17.4 策略与权限测试

建议补充场景：

- 不同 `agentId` 对 diary 的可见范围不同
- 被限制 agent 无法访问高危工具
- `/admin_api` 与 `/agent_gateway` 的 auth 语义隔离

### 17.5 迁移回归测试

每次完成一个拆分阶段后，都建议至少执行：

```bash
node --test test/openclaw-bridge-routes.test.js
```

在 Native Gateway 上线后，还应执行：

```bash
node --test test/openclaw-bridge-routes.test.js test/agent-gateway-routes.test.js
```

### 17.6 手动验证清单

建议补充人工验证：

- capabilities 是否按 agent policy 正确过滤
- memory write 后是否可被 search 与 context 命中
- approval required 是否仍保持兼容行为
- 大 token budget / 小 token budget 的 recall 输出是否稳定

---

## 18. 主要风险与对应策略

### 18.1 风险：重构过程中协议悄悄漂移

应对：

- 先冻结 OpenClaw 兼容测试
- 响应包络和错误码抽到 contracts

### 18.2 风险：权限逻辑散落，后面难以治理

应对：

- 尽早引入 `policy/*`
- 不把 diary / tool 校验继续写死在 adapter 中

### 18.3 风险：Native Gateway 过早上线但 auth 未成熟

应对：

- 先标记 beta
- 初期允许复用 admin 鉴权，但内部已生成独立 `authContext`

### 18.4 风险：MCP 过早接入导致 core 被反向绑架

应对：

- 必须等 canonical protocol 和 core contracts 稳定后再接 MCP

### 18.5 风险：测试覆盖不足导致拆分回归

应对：

- 先补 core service 测试，再做较大拆分
- 保持 OpenClaw 集成测试持续执行

---

## 19. 推荐近期执行顺序

如果从现在开始进入实现阶段，建议按下面顺序推进：

1. 为 `modules/agentGatewayCore.js` 做第二次拆分，先抽 `contracts` 和 `infra`
2. 抽出 `CapabilityService`，并确保 OpenClaw capabilities 行为零回归
3. 抽出 `MemoryRuntimeService` 与 `ContextRuntimeService`
4. 补 `ToolRuntimeService`，统一 tool invoke 契约
5. 新增 `AgentRegistryService` 与 `/agent_gateway/agents*`
6. 新增 `routes/agentGatewayRoutes.js`，推出 Native Gateway beta
7. 补 authContext、job runtime、approval 标准态
8. 最后再做 MCP adapter

---

## 20. 最终建议

如果只给一个实施建议，那就是：

**从现在开始，不要再把 `modules/agentGatewayCore.js` 当“最终核心模块”继续堆功能，而要把它视为“拆分跳板”，尽快演进成 `contracts + policy + services + infra + adapters` 的正式结构。**

这样做的结果是：

- 现有 OpenClaw 成果可以被完整保留
- Native Gateway 可以尽快成为正式机读协议
- MCP 接入不会复制业务逻辑
- VCP 会从“某个桥接对象”升级为“agent 运行时能力提供方”

---

## 21. 配套验收清单

实现完成后，建议用下面这组清单做最终验收：

- OpenClaw 兼容测试全部通过
- Native Gateway 路由测试全部通过
- 至少两个 adapter 复用同一套 core service
- Agent Registry 可输出 agent 定义、元信息和 render 结果
- Memory search / write / context assemble 共享统一 requestContext
- Tool runtime 支持 completed / accepted / waiting_approval 三种标准状态
- 关键操作具备 requestId、agentId、sessionId 级别审计能力

当这几项都成立时，分层 Agent Gateway 才算真正落地，而不只是“把 OpenClaw bridge 换了个名字”。
