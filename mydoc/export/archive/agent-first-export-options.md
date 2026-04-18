# VCP Agent-First 对外导出方案探索

> 目标：探索一种比 `routes/openclawBridgeRoutes.js` 更适合作为长期对外能力出口的方案，让外部 agent 能稳定接入 VCP，并共享 VCP 插件、记忆、上下文与分布式生态。
>
> 基本原则：最终服务对象是 agent，不是人类，也不是管理后台。

---

## 1. 结论先行

`openclawBridgeRoutes.js` 不是失败尝试，恰恰相反，它已经证明了三件很重要的事：

1. VCP 的工具、RAG、记忆写回能力，已经可以被结构化导出。
2. `PluginManager.processToolCall()`、`KnowledgeBaseManager`、`agentManager` 这三层组合，足以支撑一个真正的 agent runtime gateway。
3. 当前最大问题不是“功能不够”，而是“协议边界还不够 agent-first”。

如果目标是让 **任意外部 agent** 都能高质量接入 VCP，推荐不要把 `openclawBridgeRoutes.js` 继续扩成一个单一厂商桥，而是将其降级为：

- 一个现成的 `vendor adapter`
- 一个未来统一导出层的内部实现样板

更合适的长期方向是：

**把 VCP 对外抽象为一个分层的 Agent Gateway，而不是一个 OpenClaw 专用桥。**

推荐总方案：

**`Agent Gateway Core` + `多协议适配器`**

其中：

- `Gateway Core` 负责导出 VCP 的真实能力模型
- `OpenClaw Adapter` 复用现有桥接能力
- `MCP Adapter` 负责进入更广泛 agent 生态
- `Native HTTP Adapter` 负责最稳定、最可控的 VCP 原生接入

---

## 2. 当前实现的真实定位

从 `routes/openclawBridgeRoutes.js` 当前实现看，它已经覆盖了 5 类关键能力：

1. 能力发现：`GET /openclaw/capabilities`
2. 目标发现：`GET /openclaw/rag/targets`
3. 记忆检索：`POST /openclaw/rag/search`
4. 上下文召回：`POST /openclaw/rag/context`
5. 工具执行与记忆写回：`POST /openclaw/tools/:toolName`、`POST /openclaw/memory/write`

这说明当前桥接已经不只是“工具导出”，而是在尝试导出一个迷你的 agent runtime。

它的优点很明显：

- 直接复用现有插件体系，无需重写插件生态
- 能透出 schema、超时、审批、分布式等工具元数据
- 已经把记忆检索、上下文召回、持久化写回拆成了结构化 JSON 能力
- 已有较完整测试覆盖，说明接口行为已经初步稳定

但它也有几个根本性限制：

### 2.1 命名和边界过于 vendor-specific

`openclaw` 这个名字天然暗示“这是给 OpenClaw 的接口”，而不是“VCP 的正式 agent 能力边界”。

结果是：

- 其他 agent 平台接入时会天然把自己视为“兼容者”
- VCP 内部也容易把它当成专项适配，而不是核心导出层

### 2.2 挂在 `/admin_api` 下，语义更像管理接口

当前路由是挂到 `/admin_api`，继承 Basic Auth 体系，这对快速落地很有效，但从长期看会带来语义错位：

- `admin` 表示管理后台，不表示 agent runtime
- 接口前缀会让调用方误解这是运维接口，而不是正式的机器协议
- 权限模型容易混进“后台管理员拥有全部权限”的假设

agent-first 的出口应区分：

- 管理端权限
- agent 身份权限
- agent 所属租户/角色/日记本范围
- 工具执行审批策略

### 2.3 当前导出中心仍偏“工具桥”

虽然已经有 memory/context，但能力总入口仍主要围绕“工具 + RAG”组织，还没有把以下对象作为一等公民导出：

- Agent 定义
- Agent 渲染结果
- Session 状态
- 长任务 / 异步任务
- 事件流 / 状态回推
- 能力版本协商

### 2.4 Schema 导出仍带有 manifest 文本推断色彩

当前 `inputSchema` 会从 `invocationCommands` 的描述和示例中推导参数，适合快速兼容，但对长期公共协议来说不够强：

- 文本提示变化可能导致 schema 漂移
- 示例驱动推导更适合“桥接”，不适合“正式契约”
- agent 侧需要更稳定、更明确的 machine-readable contract

### 2.5 缺少 agent 生命周期接口

对于外部 agent 来说，工具调用只是能力的一部分。更完整的对外导出通常还需要：

- agent 列表 / 能力画像
- prompt/render 结果
- session init / resume / compact
- job submit / poll / cancel
- event stream / webhook / websocket

当前桥接还没有覆盖这部分。

---

## 3. 判断标准：什么叫“更好的导出方式”

既然服务对象是 agent，就不能再用“人类调 API 方不方便”来评估，而要用下面 8 个标准：

### 3.1 可机器理解

协议应尽量结构化、可推断、可缓存、可版本协商，避免依赖自然语言说明。

### 3.2 可表达 agent 生命周期

不仅要能调工具，还要能描述：

- 谁是当前 agent
- 它能访问哪些能力
- 它的会话边界是什么
- 它如何读取和写回长期记忆

### 3.3 可治理

必须能对以下对象做策略控制：

- agent 身份
- tool scope
- diary scope
- 审批需求
- 审计事件
- 速率限制

### 3.4 可组合

工具、记忆、上下文、事件、agent registry 应该能分别使用，而不是只能整包接入。

### 3.5 可演进

未来无论接 OpenClaw、Claude Desktop、Cursor、MCP Client、自研 agent 宿主，都不应强迫 VCP 再重写一层业务。

### 3.6 可观测

agent 接入最怕黑盒，因此需要可追踪：

- requestId
- sessionId
- agentId
- tool trace
- memory trace
- recall trace
- approval trace

### 3.7 可支持异步与流式

很多 agent 不只是同步工具调用，还需要：

- streaming partial result
- 异步任务回查
- 状态订阅
- 人工审批等待

### 3.8 可跨生态复用

如果一个协议只能服务一个宿主，它就只是适配层，不是平台出口。

---

## 4. 候选方案

下面按“抽象层级”而不是“实现工作量”来比较几条路线。

## 4.1 方案 A：继续强化 OpenClaw 专用桥

做法：

- 保留现有 `/admin_api/openclaw/*`
- 增加更多 OpenClaw 需要的 endpoint
- 继续围绕 OpenClaw 的工具、memory、context 生命周期演进

优点：

- 复用现有成果最多
- 最快见效
- 对 OpenClaw 单点接入非常直接

缺点：

- 容易把 VCP 正式导出层锁死在单一宿主语义上
- 其他 agent 平台接入时仍要“假装自己是 OpenClaw”
- 长期会出现“桥越来越大，但 core abstraction 仍不清晰”的问题

适用场景：

- 只想服务 OpenClaw
- 短期目标是验证记忆与工具双桥接体验

结论：

**适合作为验证路线，不适合作为最终平台出口。**

---

## 4.2 方案 B：Agent Registry First

做法：

- 先把 `agentManager` 和 `/admin_api/agents*` 体系升级成正式的 agent registry
- 对外先导出 agent 定义、prompt、alias、meta、render 结果
- 工具与记忆能力后挂

优点：

- 先解决“外部 agent 如何理解 VCP 中有哪些 agent”这个根问题
- 与现有 `agentManager` 天然一致
- 让 VCP 成为 agent 定义的 source of truth

缺点：

- 只能解决“agent 定义同步”，不能单独解决 runtime 调度
- 如果停在这里，仍然没有真正把 VCP 的工具和记忆生态开放出去

适用场景：

- 外部系统本身有成熟 runtime，只缺 agent 角色来源
- 想优先解决 prompt 漂移和多端 agent 配置不一致

结论：

**应该做，但只能作为入口层，不能作为完整对外方案。**

---

## 4.3 方案 C：Native Agent HTTP Gateway

做法：

- 把 VCP 正式导出为一组 agent-first 的原生 HTTP/JSON 接口
- 以 VCP 自己的能力模型设计对象和资源，而不是借用某个宿主的命名

建议资源模型：

- `/agent_gateway/agents`
- `/agent_gateway/agents/:agentId`
- `/agent_gateway/capabilities`
- `/agent_gateway/tools/:toolName/invoke`
- `/agent_gateway/memory/search`
- `/agent_gateway/memory/write`
- `/agent_gateway/context/assemble`
- `/agent_gateway/sessions`
- `/agent_gateway/jobs`
- `/agent_gateway/events`

优点：

- 协议边界最清晰
- 权限、版本、审计、能力协商都更容易统一设计
- 最适合作为内部 canonical protocol

缺点：

- 生态即插即用性不如 MCP
- 外部宿主仍需要写一个适配器

适用场景：

- 希望 VCP 拥有长期稳定、完全可控的正式机读协议
- 希望未来所有 adapter 都复用同一个核心接口

结论：

**这是最适合做内部 canonical contract 的方案。**

---

## 4.4 方案 D：MCP Server 导出

做法：

- 在 VCP 外侧新增 MCP Server
- 将工具、资源、prompts 通过 MCP 暴露给外部 agent 宿主
- memory/context 由资源、工具或扩展协议承载

优点：

- 生态兼容面最广
- 很多 agent 宿主已经天然支持 MCP
- 对“工具发现与调用”最友好

缺点：

- MCP 在“长期记忆写回、上下文组装、会话策略、审批等待”这些层面不是天然完整答案
- 如果直接把全部语义强塞进 MCP tool，会再次退化成“工具中心”
- 仍需要 VCP 内部先有一层稳定抽象，否则 MCP 只是把当前桥重新包一遍

适用场景：

- 想快速接入更广泛 agent 生态
- 工具暴露是第一优先级

结论：

**非常适合作为外部生态适配层，但不应直接替代内部 canonical protocol。**

---

## 4.5 方案 E：分层式导出

做法：

把导出层拆成四层：

1. `Agent Registry Layer`
2. `Agent Runtime Gateway Layer`
3. `Protocol Adapter Layer`
4. `Event / Async Layer`

优点：

- 兼顾长期抽象与短期落地
- OpenClaw、MCP、自研宿主都能接到同一内核
- 当前 `openclawBridgeRoutes.js` 可以直接转型为一个 adapter，而不是被废弃

缺点：

- 设计工作量高于单一桥接
- 需要先承认“开放的是一套 runtime，不只是工具接口”

结论：

**这是最推荐的总体路线。**

---

## 5. 推荐方案：分层 Agent Gateway

推荐架构如下：

```text
                    +---------------------------+
                    | External Agent Hosts      |
                    | OpenClaw / MCP / Custom   |
                    +-------------+-------------+
                                  |
                   +--------------+---------------+
                   | Protocol Adapters            |
                   | OpenClaw / MCP / Native SDK  |
                   +--------------+---------------+
                                  |
                   +--------------+---------------+
                   | VCP Agent Gateway Core       |
                   | canonical agent-first model  |
                   +--------------+---------------+
                                  |
        +-------------------------+--------------------------+
        |                         |                          |
  +-----+------+           +------+-------+           +------+------+
  | Agent Layer |           | Tool Layer  |           | Memory Layer|
  | agentManager|           | PluginManager|          | RAG / Diary |
  +------------+           +--------------+           +-------------+
                                  |
                           +------+------+
                           | Dist Layer  |
                           | WebSocket   |
                           +-------------+
```

关键判断：

- `openclawBridgeRoutes.js` 不应再被视为最终出口
- 它应被视为 `OpenClaw Adapter`
- 真正长期稳定的部分应该是 `Gateway Core`

---

## 6. Gateway Core 应该导出什么

这部分是整个方案的关键。真正面向 agent 的导出对象，建议至少有 6 类。

## 6.1 Agent Registry

负责回答：

- VCP 中有哪些 agent
- 每个 agent 的 alias / file / version / hash 是什么
- 每个 agent 的 prompt 原文和 render 结果是什么
- 每个 agent 默认可访问哪些工具和记忆域

建议接口：

- `GET /agent_gateway/agents`
- `GET /agent_gateway/agents/:agentId`
- `POST /agent_gateway/agents/:agentId/render`

说明：

- `render` 比 `get prompt` 更适合对外，因为外部 agent 常常需要的是“可直接运行的 system prompt”
- 这里可以复用现有 `agentManager`，但不应直接暴露管理接口语义

## 6.2 Capability Registry

负责回答：

- 当前 agent 可以用什么工具
- 每个工具的 schema、超时、审批策略、分布式属性是什么
- 哪些能力是 tool，哪些是 memory，哪些是 context service

建议接口：

- `GET /agent_gateway/capabilities`

设计重点：

- 不要只返回 `tools`
- 应按能力类型分区，例如 `tools`、`memory`、`context`、`events`、`jobs`

## 6.3 Tool Runtime

负责执行 VCP 插件调用。

建议接口：

- `POST /agent_gateway/tools/:toolName/invoke`

设计重点：

- 保留 `requestId`、`agentId`、`sessionId`
- 明确返回同步结果或异步任务句柄
- 不要求外部知道插件类型差异
- 分布式转发由 VCP 内部透明处理

## 6.4 Memory Runtime

负责长期记忆检索和写回。

建议接口：

- `POST /agent_gateway/memory/search`
- `POST /agent_gateway/memory/write`
- `GET /agent_gateway/memory/targets`

设计重点：

- memory 是一等公民，不要伪装成 tool
- 明确区分检索、回忆构建、写回
- diary scope 必须与 agent 身份绑定

## 6.5 Context Runtime

负责根据最近消息和预算组装 recall blocks。

建议接口：

- `POST /agent_gateway/context/assemble`

设计重点：

- 输入 recent messages、token budget、policy
- 输出 recall blocks、score、来源、截断信息、命中策略
- 这层是 VCP 高价值能力，不应退化成某个私有提示词 DSL

## 6.6 Async / Event Runtime

负责异步执行和回推。

建议接口：

- `POST /agent_gateway/jobs`
- `GET /agent_gateway/jobs/:jobId`
- `POST /agent_gateway/jobs/:jobId/cancel`
- `GET /agent_gateway/events/stream`

设计重点：

- 对异步插件、审批等待、长任务非常重要
- 未来可以先做 polling，再补 SSE / WebSocket

---

## 7. 为什么推荐“Core + Adapter”，而不是直接上 MCP

因为 MCP 解决的是“怎么接进生态”，不是“VCP 应该导出什么”。

如果直接上 MCP，而内部没有统一导出层，最后通常会出现三个问题：

1. 工具能导出，memory/context 语义却不统一
2. 不同 adapter 各自拼装权限、审计、session 逻辑
3. VCP 自己失去 canonical contract，外部协议反客为主

因此更稳的顺序应该是：

1. 先定义 `Gateway Core`
2. 再把 `OpenClaw Bridge` 改造成 `OpenClaw Adapter`
3. 最后追加 `MCP Adapter`

这样做后：

- OpenClaw 用自己的宿主体验接 VCP
- MCP 客户端也能接同一套能力
- 自研 agent 还可以走最直接的 native HTTP 协议

---

## 8. 对当前 `openclawBridgeRoutes.js` 的建议定位

不建议废弃，也不建议继续把它当最终产品名扩写。

更建议将它重命名和重构为：

- 内部抽象：`agentGatewayService`
- 外部适配：`openclawAdapterRoutes`

具体改造思路：

### 8.1 从 route 中抽离 service

把以下逻辑抽成统一 service：

- capability build
- tool descriptor build
- diary target resolution
- memory search
- context assemble
- memory write
- error mapping
- audit event emit

这样未来：

- OpenClaw adapter 调它
- MCP adapter 调它
- Native HTTP gateway 也调它

### 8.2 保留 OpenClaw 路由，但不再让它代表正式命名

比如内部先有：

- `GET /agent_gateway/capabilities`
- `POST /agent_gateway/tools/:toolName/invoke`
- `POST /agent_gateway/context/assemble`

然后再让 OpenClaw adapter 将其映射成：

- `GET /openclaw/capabilities`
- `POST /openclaw/tools/:toolName`
- `POST /openclaw/rag/context`

### 8.3 调整 auth 语义

从长期看，建议把 `/admin_api` 下的机读出口逐步迁出，单独设计 agent auth。

建议支持至少 3 种身份维度：

- `gateway key`: 某个外部宿主的接入凭证
- `agent identity`: 当前调用所代表的 agent
- `session identity`: 当前会话 / 任务链路

不要默认“只要是 admin 就什么都能调”。

---

## 9. 推荐落地顺序

为了降低风险，建议分 4 个阶段推进。

## 9.1 Phase 1：把 OpenClaw Bridge 抽象成 Core + Adapter

目标：

- 不改外部行为
- 先稳定内部结构

工作内容：

- 抽出 `agentGatewayService`
- 让 `openclawBridgeRoutes.js` 只做请求适配
- 保持现有测试全部通过

验收标准：

- 现有 `openclaw-bridge-routes.test.js` 全绿
- route 文件显著变薄
- 主要逻辑可被第二个 adapter 直接复用

## 9.2 Phase 2：补齐 Agent Registry 导出

目标：

- 让外部系统真正理解“VCP 里有哪些 agent”

工作内容：

- 新增 `GET /agent_gateway/agents`
- 新增 `GET /agent_gateway/agents/:agentId`
- 新增 `POST /agent_gateway/agents/:agentId/render`
- 对接 `agentManager`

验收标准：

- 外部 agent 宿主无需读管理端文件接口即可拿到角色定义
- 支持 hash / version / mtime / source file 等元信息

## 9.3 Phase 3：推出 Native Gateway

目标：

- 拥有 VCP 自己的 canonical protocol

工作内容：

- 新增 `/agent_gateway/*`
- 梳理 capability model
- 增加统一错误码、统一 auth、统一 trace 字段

验收标准：

- OpenClaw adapter 能完全复用 core
- 至少再实现一个轻量 native client proof-of-concept

## 9.4 Phase 4：追加 MCP Adapter

目标：

- 扩展到更广泛 agent 生态

工作内容：

- 将 tools 映射为 MCP tools
- 将 agents / prompts / docs 映射为 MCP resources 或 prompts
- 对 memory/context 设计 MCP 侧包装策略

验收标准：

- 至少一个 MCP client 成功消费 VCP tools
- 能复用 Phase 3 的 auth、trace、policy 逻辑

---

## 10. 协议设计建议

下面给出一个更贴近长期实现的 agent-first 协议骨架。

## 10.1 统一请求上下文

所有写操作和执行型接口都建议携带：

```json
{
  "requestContext": {
    "requestId": "req_xxx",
    "sessionId": "sess_xxx",
    "agentId": "nova.planner",
    "source": "openclaw|mcp|native-sdk",
    "runtime": "openclaw",
    "workspaceId": "optional",
    "tenantId": "optional"
  }
}
```

原因：

- `source` 只表示来源通道，不表示真实 agent
- `agentId` 应成为权限和记忆边界的核心字段
- `runtime` 有利于审计和兼容性处理

## 10.2 统一能力描述

`capabilities` 返回建议从“只列工具”升级为：

```json
{
  "server": {
    "name": "VCPToolBox",
    "version": "x.y.z",
    "gatewayVersion": "v1"
  },
  "agent": {
    "id": "nova.planner",
    "resolvedPolicies": {
      "toolScopes": ["SciCalculator", "ChromeBridge"],
      "memoryTargets": ["Nova", "ProjectAlpha"]
    }
  },
  "tools": [],
  "memory": {},
  "context": {},
  "jobs": {},
  "events": {}
}
```

这样外部 agent 在握手后，就能一次性理解自己的完整运行边界。

## 10.3 区分同步结果与异步句柄

工具调用返回建议支持两种形态：

同步结果：

```json
{
  "status": "completed",
  "result": {}
}
```

异步句柄：

```json
{
  "status": "accepted",
  "job": {
    "jobId": "job_xxx",
    "pollUrl": "/agent_gateway/jobs/job_xxx"
  }
}
```

这样可以更自然地承接异步插件和审批等待。

## 10.4 显式审批态

当前 OpenClaw 桥会直接返回 `approval required`，长期建议标准化成：

```json
{
  "status": "waiting_approval",
  "approval": {
    "approvalId": "apr_xxx",
    "toolName": "ProtectedTool",
    "expiresAt": "2026-04-17T12:00:00.000Z"
  }
}
```

这样外部 agent 宿主可以决定：

- 挂起
- 重试
- 请求人工介入
- 转为别的计划

---

## 11. 为什么 agent-first 视角下，Agent Registry 非常关键

如果不导出 agent registry，外部 agent 宿主就只能把 VCP 当成：

- 一个工具箱
- 一个向量数据库
- 一个记忆 API

这会丢掉 VCP 很重要的一部分价值：

- `Agent/` 与 `agent_map.json` 的角色定义
- 角色与记忆域的天然对应关系
- 角色驱动的工具暴露策略

因此推荐明确把对外导出拆成两条主线：

1. `Agent Definition Export`
2. `Agent Runtime Export`

前者回答“我是谁”，后者回答“我能做什么”。

---

## 12. 风险与反模式

以下几条是后续设计里应尽量避免的。

### 12.1 不要把管理后台 API 直接当公共协议

管理端 API 可以复用，但不应直接等于正式机读出口。

### 12.2 不要把所有能力都扁平化成 tool

memory、context、events、jobs 都应该是独立对象。

### 12.3 不要让 adapter 反过来定义 core

OpenClaw 或 MCP 的宿主语义可以影响适配方式，但不应直接定义 VCP 内部能力模型。

### 12.4 不要继续依赖文本描述推断正式 schema

长期应推动插件 manifest 提供更稳定的 machine-readable schema。

### 12.5 不要忽略 session 和 async

agent runtime 与人类点击接口不同，长任务、审批等待、流式反馈是常态。

---

## 13. 最终建议

如果只允许给一个明确建议，我的建议是：

**不要把下一步定义成“继续做 OpenClaw Bridge”，而要定义成“建设 VCP Agent Gateway，并让 OpenClaw 成为第一个 adapter”。**

一句话版：

**当前桥接已经证明 VCP 有能力被导出，下一步需要解决的是“抽象升级”，不是“再加接口”。**

推荐优先级如下：

1. 抽出 `Gateway Core`
2. 补齐 `Agent Registry`
3. 推出 `Native Agent Gateway`
4. 保留并瘦身 `OpenClaw Adapter`
5. 最后追加 `MCP Adapter`

---

## 14. 建议验证方案

为了验证这条路线是否真的适合 agent，而不是只适合人类调试，建议用下面这组测试来验收。

## 14.1 协议测试

- capabilities 是否能一次性描述 agent 的工具、记忆、上下文边界
- tool invoke 是否能区分同步、异步、审批等待三种状态
- memory search / write / context assemble 是否共享统一 `requestContext`
- error code 是否稳定，不依赖自然语言 message

## 14.2 权限测试

- 不同 `agentId` 是否拿到不同 diary scope
- 被限制的 agent 是否无法越权访问 diary 和高危工具
- 管理员凭证与 agent runtime 凭证是否正确隔离

## 14.3 生态测试

- OpenClaw adapter 是否可无损映射 core 能力
- 第二种 adapter 是否能在不复制业务逻辑的情况下复用 core
- MCP adapter 是否至少能导出 tools，并稳定调用 3 个代表性插件

## 14.4 记忆测试

- 写回的 durable memory 是否能被后续检索命中
- context assemble 是否能在预算内稳定返回 recall blocks
- memory scope 切换时是否正确反映 agent policy

## 14.5 异步测试

- 长任务是否返回 job handle 而非阻塞超时
- 人工审批是否能进入 `waiting_approval` 状态
- 任务取消、超时、重试是否有稳定行为

---

## 15. 一个可执行的近期行动清单

如果要从现在开始推进，建议按下面顺序动手：

1. 为当前 `openclawBridgeRoutes.js` 画出 service 抽离边界
2. 先实现 `agentGatewayService`，不改外部接口
3. 增加 `Agent Registry` 的只读导出接口
4. 新建 `/agent_gateway/*` 原生协议草案
5. 让 OpenClaw adapter 改为映射到 core
6. 再评估 MCP adapter 的最小落地子集

这条路线能最大程度保留现有成果，同时把 VCP 从“某宿主的桥接对象”提升为“agent 生态里的能力提供方”。
