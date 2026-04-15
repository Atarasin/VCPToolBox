# oh-my-openagent × VCPToolBox 联合使用方案

> **研究范围**：VCPToolBox 源码架构、OpenClaw Bridge API、插件系统、TagMemo 记忆系统、多 Agent 编排模式、oh-my-openagent 框架
> **基于版本**：VCPToolBox VCP 7.1.2 | oh-my-openagent (code-yeongyu/oh-my-openagent)
> **生成时间**：2026-04-14

---

## 执行摘要

VCPToolBox **已经内置了一套专用的外部 Agent 桥接 API** —— `OpenClaw Bridge`（`routes/openclawBridgeRoutes.js`，3131 行，功能完备）。这是最关键的发现。

- **6 个标准化 REST 端点**：工具发现、RAG 搜索、上下文召回、记忆写入、工具执行、目标列表
- **完整的安全机制**：参数验证、权限审批、审计日志、错误映射
- **记忆隔离**：基于 `agentId` 的日记本访问控制
- **生产就绪**：代码已实现，但**尚未在 `server.js` 中挂载**

oh-my-openagent **明确不内置记忆系统**（Issue #74 设计决策），恰好与 VCP 的 TagMemo 语义记忆系统形成**天然互补**。

**核心结论**：将 VCP 的 OpenClaw Bridge 注册为 oh-my-openagent 的 MCP Server / 外部工具后端，同时以 VCP 的 TagMemo 作为 oh-my-openagent 的持久记忆层，是技术路径最清晰、侵入性最小的联合方案。

---

## 一、VCP 现有外部集成接口全景

### 1.1 OpenClaw Bridge API（6 个端点）

| 方法 | 端点 | 用途 | 认证 |
|------|------|------|------|
| `GET` | `/openclaw/capabilities` | 列出所有可用工具 + 记忆系统特性 | Bearer Token |
| `GET` | `/openclaw/rag/targets` | 获取 Agent 可访问的日记本/RAG 目标列表 | Bearer Token |
| `POST` | `/openclaw/rag/search` | 语义搜索 VCP 向量知识库 | Bearer Token |
| `POST` | `/openclaw/rag/context` | 构建召回上下文（含 TagMemo 增强） | Bearer Token |
| `POST` | `/openclaw/memory/write` | 写入记忆到 VCP 日记体系（含幂等去重） | Bearer Token |
| `POST` | `/openclaw/tools/:toolName` | **直接调用任意 VCP 插件**（含参数验证 + 审批） | Bearer Token |

**关键设计细节**：

- 每个请求需要 `requestContext.agentId` 和 `requestContext.sessionId`（多 Agent 追踪）
- 内置审计日志（`logOpenClawAudit`）
- 工具调用前会检查 `toolApprovalManager`（安全审批门控）
- 记忆写入支持 `idempotencyKey`（幂等）和 `deduplicate`（指纹去重）
- RAG 搜索支持 `TagMemo`、`Group`、`Rerank`、`Time` 四种增强模式
- Agent 间日记隔离：`isOpenClawDiaryAllowed()` 根据 Agent 身份控制日记本访问权限
- 完整的错误映射系统（`mapOpenClawToolExecutionError`）

> **⚠️ 重要发现**：`routes/openclawBridgeRoutes.js` 已编写完成（3131 行，功能完备），但**尚未在 `server.js` 中挂载**。需要添加路由注册才能对外暴露。

### 1.2 其他可用接口

| 接口 | 用途 | 局限 |
|------|------|------|
| `POST /v1/chat/completions` | AI 对话（含 VCP 工具循环） | 需要嵌入 VCP 指令协议文本 |
| `POST /v1/human/tool` | 直接工具调用 | 低级接口，无自动 VCP 循环 |
| `ADMIN API /admin_api/*` | 系统管理、日记 CRUD、RAG 配置 | Basic Auth，管理级权限 |
| `WebSocket /vcp-distributed-server/` | 分布式工具注册与执行 | 需要 VCP_Key，协议复杂 |

---

## 二、可行的联合方案架构

基于 VCP 现有能力和多 Agent 编排研究，提出**三层递进方案**：

### 方案 A：API 网关模式（最小侵入，最快落地）

```
┌──────────────────────────────────────────────────┐
│            oh-my-openagent（编排层）              │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐        │
│  │ Agent A  │ │ Agent B  │ │ Agent C  │        │
│  │(规划/拆解)│ │(搜索/分析)│ │(写作/执行)│        │
│  └────┬─────┘ └────┬─────┘ └────┬─────┘        │
│       │             │             │              │
│       └─────────────┼─────────────┘              │
│                     │ (Tool Calls)                │
└─────────────────────┬────────────────────────────┘
                      │ HTTP REST (Bearer Token)
                      ▼
┌──────────────────────────────────────────────────┐
│   VCPToolBox — OpenClaw Bridge API               │
│  ┌──────────────────────────────────────────┐    │
│  │ GET  /openclaw/capabilities → 工具发现    │    │
│  │ POST /openclaw/tools/:name   → 插件调用    │    │
│  │ POST /openclaw/rag/search    → 语义检索    │    │
│  │ POST /openclaw/rag/context   → 召回上下文  │    │
│  │ POST /openclaw/memory/write  → 写入记忆   │    │
│  │ GET  /openclaw/rag/targets   → 日记目标    │    │
│  └──────────────────────────────────────────┘    │
│                     │                              │
│  ┌─────────────┐  ┌──────────────┐  ┌──────────┐ │
│  │ Plugin.js   │  │ KB Manager   │  │ WSServer │ │
│  │ (79+插件)   │  │ (TagMemo RAG)│  │ (分布式)  │ │
│  └─────────────┘  └──────────────┘  └──────────┘ │
└──────────────────────────────────────────────────┘
```

**实现步骤**：

1. **激活 OpenClaw 路由**：在 `server.js` 中注册 `openclawBridgeRoutes`
   ```javascript
   const openClawRoutes = require('./routes/openclawBridgeRoutes');
   app.use('/admin_api', openClawRoutes(pluginManager));
   ```
2. **oh-my-openagent 侧**：为每个 Agent 定义 Tool Schema，映射 VCP 工具
3. **记忆共享**：多个 Agent 通过 `agentId` + `sessionId` 标识，VCP 自动隔离日记本访问权限

**优点**：零代码修改 VCP 核心，OpenClaw API 已完备  
**缺点**：每步工具调用是独立 HTTP 请求，无 VCP 工具循环能力

---

### 方案 B：智能体作为对话模式（利用 VCP 工具循环）

```
┌──────────────────────────────────────────────────┐
│            oh-my-openagent（编排层）              │
│  将子任务构造为 VCP 对话请求                       │
└─────────────────────┬────────────────────────────┘
                      │ POST /v1/chat/completions
                      │ system_prompt 包含 VCP 工具描述
                      ▼
┌──────────────────────────────────────────────────┐
│   VCPToolBox — Chat Handler                       │
│   ┌────────────────────────────────────────┐      │
│   │ 1. 消息预处理（变量替换/RAG 注入）        │      │
│   │ 2. AI 调用 → VCP 工具循环自动执行          │      │
│   │ 3. 工具结果自动回注对话                  │      │
│   │ 4. 最多 N 轮循环（MaxVCPLoop）          │      │
│   │ 5. 返回最终结果                          │      │
│   └────────────────────────────────────────┘      │
│   自动执行：搜索→生图→编辑→返回                    │
└──────────────────────────────────────────────────┘
```

**关键**：VCP 的 `chatCompletionHandler.js` 已实现完整工具循环（最多 `MaxVCPLoopStream` 轮）。oh-my-openagent 只需发送正确格式的请求，VCP 自动完成多步工具调用。

**系统提示词模板**（oh-my-openagent 注入）：
```
你是 Agent 团队的 {{AgentRole}}。
拥有以下 VCP 工具：{{VCPAllTools}}
记忆上下文：[[共享日记本::Time::Group::TagMemo]]

请根据任务自主调用工具完成目标。
```

**优点**：充分利用 VCP 的工具循环和 RAG 注入能力  
**缺点**：依赖 VCP 的模型转发，不适用于需要不同模型的任务

---

### 方案 C：混合模式（推荐）

```
┌─────────────────────────────────────────────────────────────┐
│                 oh-my-openagent（编排层）                     │
│  ┌────────────────────────────────────────────────────┐    │
│  │ 任务规划器 → 选择执行路径                           │    │
│  │  ├─ 简单工具调用 → OpenClaw API (方案 A)             │    │
│  │  ├─ 多步复杂任务 → Chat Completion (方案 B)          │    │
│  │  ├─ 记忆操作 → OpenClaw Memory API                 │    │
│  │  └─ RAG 检索 → OpenClaw RAG API                    │    │
│  └────────────────────────────────────────────────────┘    │
│                                                             │
│  ┌─────────┐  ┌─────────┐  ┌─────────┐  ┌──────────┐     │
│  │ Agent A │  │ Agent B │  │ Agent C │  │ Agent D  │     │
│  │(规划)   │  │(搜索)   │  │(写作)   │  │(Artifact)│     │
│  └────┬────┘  └────┬────┘  └────┬────┘  └────┬─────┘     │
│       │            │            │             │             │
│  共享记忆层 ──→ VCP 日记体系 ←── 访问控制                     │
└─────────────────────────────────────────────────────────────┘
                      │
        ┌─────────────┼─────────────┐
        │             │             │
        ▼             ▼             ▼
  OpenClaw API   Chat Completion   WebSocket
  (工具/记忆)    (多步循环)       (实时推送)
```

**核心设计原则**：

1. **oh-my-openagent 负责编排**：任务分解、Agent 调度、流程控制
2. **VCP 负责执行和记忆**：工具执行、RAG 检索、记忆持久化
3. **通过 OpenClaw API 桥接**：标准化、版本化、可审计

---

## 三、记忆系统集成方案

### 3.1 三层记忆映射

| oh-my-openagent | VCP 对应 | OpenClaw 端点 |
|-----------------|---------|-------------|
| 全局知识（所有 Agent 共享） | `公共日记本` | `POST /openclaw/rag/search` + `diary: 公共日记本` |
| 团队记忆（角色组共享） | `角色日记本` | `POST /openclaw/rag/search` + `diaries: [角色A, 角色B]` |
| 个体记忆（Agent 私有） | `Agent名日记本` | `POST /openclaw/memory/write` + `agentId: agent_name` |

### 3.2 记忆读写流程

**写入记忆（Agent 完成任务后）**：
```json
POST /openclaw/memory/write
{
  "requestContext": { "agentId": "planner", "sessionId": "task-123" },
  "target": { "diary": "规划师日记本", "maid": "规划师" },
  "memory": {
    "text": "完成了 X 项目的需求分析，发现三个关键约束...",
    "tags": ["项目X", "需求分析", "约束"],
    "metadata": { "task_id": "task-123", "priority": "high" }
  },
  "options": { "idempotencyKey": "task-123-summary", "deduplicate": true }
}
```

**读取记忆（Agent 开始任务前）**：
```json
POST /openclaw/rag/search
{
  "requestContext": { "agentId": "writer", "sessionId": "task-456" },
  "query": "项目 X 的需求和约束",
  "diary": "规划师日记本",
  "mode": "semantic",
  "k": 10,
  "options": { "tagMemo": true, "groupAware": true, "timeAware": true }
}
```

**构建上下文（注入 Agent System Prompt 前）**：
```json
POST /openclaw/rag/context
{
  "requestContext": { "agentId": "writer", "sessionId": "task-456" },
  "messages": [ { "role": "user", "content": "帮我写项目 X 的可行性报告" } ],
  "diary": "规划师日记本",
  "maxBlocks": 8,
  "tokenBudget": 2000,
  "minScore": 0.3,
  "options": { "tagMemo": true, "rerank": true, "groupAware": true }
}
```

---

## 四、工具调用集成方案

### 4.1 工具发现

```json
GET /openclaw/capabilities?agentId=planner&includeMemoryTargets=true
```

返回示例：
```json
{
  "success": true,
  "data": {
    "server": { "name": "VCPToolBox", "version": "7.1.2", "bridgeVersion": "v1" },
    "tools": [
      { "name": "VSearch", "displayName": "联网搜索", "pluginType": "synchronous",
        "inputSchema": { }, "invocationCommands": [ ] },
      { "name": "VCPFluxGen", "displayName": "Flux 文生图", ... }
    ],
    "memory": {
      "features": { "timeAware": true, "groupAware": true, "tagMemo": true, "rerank": true, "writeBack": true },
      "targets": [
        { "id": "共享日记本", "displayName": "共享知识库", "type": "diary", "allowed": true },
        { "id": "规划师日记本", "displayName": "规划师记忆", "type": "diary", "allowed": true }
      ]
    }
  }
}
```

### 4.2 工具执行

```json
POST /openclaw/tools/VSearch
{
  "args": { "query": "量子计算最新进展", "limit": 5 },
  "requestContext": { "agentId": "researcher", "sessionId": "task-789", "source": "oh-my-openagent" }
}
```

---

## 五、VCP 内置 Agent 间通信（方案补充）

VCP 已有内置的 Agent 间协作机制 —— `AgentAssistant` 插件（`Plugin/AgentAssistant/AgentAssistant.js`）：

| 功能 | 说明 |
|------|------|
| Agent 间即时通讯 | `agent_name` + `prompt` 参数 |
| 上下文保持 | 每 Agent 每会话独立历史，最大 `maxHistoryRounds` 轮 |
| 定时通讯 | `timely_contact` 参数安排未来任务 |
| 异步委托 | `DELEGATION` 模式，支持心跳续命 |
| 积分系统 | `agent_scores.json` 追踪 Agent 任务完成质量 |

oh-my-openagent 既可以直接使用这个机制，也可以绕过它用 OpenClaw API 实现自定义编排。

---

## 六、oh-my-openagent 框架分析

### 6.1 基本概况

- **仓库**：[code-yeongyu/oh-my-openagent](https://github.com/code-yeongyu/oh-my-openagent)
- **语言**：TypeScript
- **运行时**：Bun only
- **架构**：三层设计（Planning → Execution → Worker）

### 6.2 三层架构

```
┌─────────────────────────────────────────────────────────────┐
│              PLANNING LAYER (Human + Prometheus)             │
│  Prometheus (Planner) → Metis (Consultant) → Momus (Review)│
└─────────────────────────────────────────────────────────────┘
                              ↓
┌─────────────────────────────────────────────────────────────┐
│              EXECUTION LAYER (Orchestrator: Atlas)          │
│           Atlas reads plans, delegates via sisyphus_task     │
└─────────────────────────────────────────────────────────────┘
                              ↓
┌─────────────────────────────────────────────────────────────┐
│              WORKER LAYER (Specialized Agents)              │
│  Sisyphus-Junior | Oracle | Explore | Librarian | Frontend │
└─────────────────────────────────────────────────────────────┘
```

### 6.3 Agent 类型

| Agent | 模型 | 用途 |
|-------|------|------|
| **Sisyphus** | claude-opus-4-6 | 主编排器，规划与委派 |
| **Prometheus** | claude-opus-4-6 | 战略 planner |
| **Atlas** | claude-sonnet-4-6 | Todo-list 编排器 |
| **Oracle** | gpt-5.2 | 架构与调试咨询 |
| **Librarian** | minimax-m2.7 | 文档与 GitHub 研究 |
| **Explore** | grok-code | 快速代码库搜索 |

### 6.4 Category 路由系统

Sisyphus 不按具体模型委派，而是按**类别**委派：

```typescript
const DEFAULT_CATEGORIES = {
  'visual-engineering': { model: 'gemini-3.1-pro' },
  'ultrabrain':         { model: 'gpt-5.4' },
  'deep':               { model: 'gpt-5.4' },
  'quick':              { model: 'gpt-5.4-mini' },
  'writing':            { model: 'kimi-k2.5' },
};
```

### 6.5 关键设计决策：无内置记忆

oh-my-openagent **明确不内置记忆系统**（[Issue #74](https://github.com/code-yeongyu/oh-my-openagent/issues/74)）。社区已有多个第三方记忆插件：

| 方案 | 后端 | 特点 |
|------|------|------|
| `RLabs-Inc/memory` | Python (SQLite + Chroma) | 会话摘要、项目级 |
| `opencode-elf` | SQLite + hybrid | 轻量 |
| `opencode-mem` | USearch + SQLite | 本地向量 DB |

**没有任何一个社区方案达到 VCP TagMemo 的语义增强深度（EPA + 残差金字塔 + 浪潮图遍历）。**

---

## 七、oh-my-openagent × VCP 的天然互补关系

| oh-my-openagent | VCPToolBox | 互补关系 |
|-----------------|------------|---------|
| **编排层**：Sisyphus 规划 → Atlas 调度 → 专业 Agent 执行 | **执行层**：79+ 插件、工具循环、LLM 转发 | 编排 vs 执行 |
| **无内置记忆**（设计决策） | **TagMemo V7.5 记忆系统**：EPA + 残差金字塔 + 浪潮算法 | **完美互补** |
| **26 内置工具**（LSP、AST、文件系统） | **79+ 领域插件**（搜索/生图/音乐/学术/物联网） | 开发工具 vs 领域能力 |
| **MCP Server 支持**（3 层） | **OpenClaw Bridge API**（6 端点，生产就绪） | 标准化桥接 |
| **Category 路由**（7 类别） | **Plugin Manifest**（6 类型） | 可映射 |
| **Hook 系统**（48 hook） | **VCP Info WebSocket**（实时推送） | 事件联通 |

**核心方案**：将 VCP 的 OpenClaw Bridge 注册为 oh-my-openagent 的 MCP Server，同时将 VCP 的 TagMemo 记忆系统作为 oh-my-openagent 的持久记忆后端。需要激活的只是一个路由挂载操作（3131 行代码已就绪）。

---

## 八、落地行动项

| 优先级 | 行动 | 说明 |
|--------|------|------|
| **P0** | 在 `server.js` 中注册 OpenClaw Bridge 路由 | 代码已就绪，只需挂载 |
| **P0** | 配置 Agent 日记隔离策略 | 设置 `OpenClawBridge_RAG_Policy` 环境变量 |
| **P1** | oh-my-openagent 侧实现 Tool Schema 适配层 | 将 `/openclaw/capabilities` 返回值转换为 Agent 框架的 Tool 定义 |
| **P1** | 实现记忆读写适配器 | 包装 `/openclaw/memory/write` 和 `/openclaw/rag/search` |
| **P2** | 对齐认证方案 | OpenClaw 使用 Bearer Token（与 `/v1/` 端点相同） |
| **P2** | WebSocket 集成（实时推送场景） | 利用 VCPInfo 通道获取工具执行进度 |
| **P3** | 混合模式路由决策 | oh-my-openagent 根据任务复杂度选择 API 或 ChatCompletion |

---

## 附录：关键源码位置索引

| 功能 | 文件 | 说明 |
|------|------|------|
| OpenClaw Bridge 路由 | `routes/openclawBridgeRoutes.js:2100-3131` | 6 个 API 端点，3131 行 |
| OpenClaw 工具发现 | `routes/openclawBridgeRoutes.js:2111` | `/openclaw/capabilities` |
| OpenClaw RAG 搜索 | `routes/openclawBridgeRoutes.js:2223` | `/openclaw/rag/search` |
| OpenClaw 上下文召回 | `routes/openclawBridgeRoutes.js:2521` | `/openclaw/rag/context` |
| OpenClaw 记忆写入 | `routes/openclawBridgeRoutes.js:2887` | `/openclaw/memory/write` |
| OpenClaw 工具执行 | `routes/openclawBridgeRoutes.js:2920` | `/openclaw/tools/:toolName` |
| 插件管理器 | `Plugin.js` | 79+ 插件加载与执行总控 |
| TagMemo 核心 | `TagMemoEngine.js` | V6/V8 浪潮算法实现 |
| EPA 模块 | `EPAModule.js` | Embedding Projection Analysis |
| 聊天主流程 | `modules/chatCompletionHandler.js` | 含 VCP 工具循环 |
| Agent 通讯插件 | `Plugin/AgentAssistant/AgentAssistant.js` | Agent 间标准化通信 |

---

*文档生成自 VCPToolBox 源码审阅与 oh-my-openagent 框架研究。*
