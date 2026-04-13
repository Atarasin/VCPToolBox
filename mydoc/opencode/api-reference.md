# API 接口参考

本文档列出 OhMyOpenCode 与 VCPToolBox 集成的所有核心 API 端点。

**基础 URL**: `http://<vcp-host>:<port>/admin_api/openclaw`

**通用响应格式**:

```json
{
  "success": true,
  "data": { ... },
  "meta": {
    "requestId": "ocw_xxx",
    "bridgeVersion": "v1",
    "durationMs": 42
  }
}
```

错误响应:

```json
{
  "success": false,
  "error": "错误描述",
  "code": "OCW_XXX",
  "details": { ... },
  "meta": { ... }
}
```

---

## 1. 能力发现

### GET `/capabilities`

获取当前 Agent 可访问的工具列表、记忆目标、服务器元数据。

#### Query Parameters

| 参数 | 类型 | 必需 | 说明 |
|------|------|------|------|
| `agentId` | string | 是 | Agent 唯一标识 |
| `maid` | string | 否 | 辅助身份标识 |
| `includeMemoryTargets` | boolean | 否 | 是否包含 RAG 目标，默认 `true` |
| `requestId` | string | 否 | 外部提供的追踪 ID |

#### Response

```json
{
  "success": true,
  "data": {
    "server": {
      "name": "VCPToolBox",
      "version": "7.1.2",
      "bridgeVersion": "v1"
    },
    "tools": [
      {
        "name": "VCPVSearch",
        "displayName": "VCP联网搜索",
        "description": "...",
        "inputSchema": { "type": "object", "properties": { ... } },
        "timeoutMs": 30000,
        "requiresApproval": false,
        "isDistributed": false
      }
    ],
    "memory": {
      "supported": true,
      "modes": ["rag", "hybrid", "auto"],
      "targets": ["Nova日记本", "公共日记本"]
    }
  },
  "meta": { ... }
}
```

---

## 2. RAG 语义检索

### GET `/rag/targets`

获取当前 Agent 可访问的 RAG 目标（日记本）列表。

#### Query Parameters

| 参数 | 类型 | 必需 | 说明 |
|------|------|------|------|
| `agentId` | string | 是 | Agent 唯一标识 |
| `maid` | string | 否 | 辅助身份标识 |
| `requestId` | string | 否 | 追踪 ID |

#### Response

```json
{
  "success": true,
  "data": {
    "targets": ["Nova日记本", "公共日记本", "开发日记本"]
  }
}
```

---

### POST `/rag/search`

执行语义检索，返回结构化结果与诊断信息。

#### Request Body

```json
{
  "query": "用户喜欢什么宠物",
  "diary": "Nova日记本",
  "diaries": ["Nova日记本", "公共日记本"],
  "maid": "Nova",
  "requestContext": {
    "agentId": "nova",
    "sessionId": "sess_001",
    "requestId": "req_001",
    "source": "ohmy-openagent"
  },
  "mode": "hybrid",
  "groupAware": true,
  "tagMemo": true,
  "timeAware": true,
  "rerank": false,
  "k": 5
}
```

#### Body 字段说明

| 字段 | 类型 | 必需 | 说明 |
|------|------|------|------|
| `query` | string | 是 | 查询文本 |
| `diary` | string | 否 | 单个目标日记本 |
| `diaries` | string[] | 否 | 多个目标日记本 |
| `requestContext.agentId` | string | 是 | Agent ID |
| `requestContext.sessionId` | string | 是 | 会话 ID |
| `mode` | string | 是 | `rag` / `hybrid` / `auto` |
| `groupAware` | boolean | 否 | 是否启用分组感知 |
| `tagMemo` | boolean | 否 | 是否启用标签增强 |
| `timeAware` | boolean | 否 | 是否启用时间感知 |
| `rerank` | boolean | 否 | 是否重排序 |
| `k` | integer | 否 | 返回结果数量，默认 5，最大 20 |

#### Response

```json
{
  "success": true,
  "data": {
    "results": [
      {
        "id": "chunk_xxx",
        "text": "用户提到特别喜欢橘猫...",
        "score": 0.89,
        "source": "Nova日记本/2024/03/15.txt",
        "tags": ["偏好", "宠物"],
        "metadata": { "timestamp": "2024-03-15T10:00:00Z" }
      }
    ],
    "diagnostics": {
      "mode": "hybrid",
      "activatedGroups": ["宠物组"],
      "coreTags": ["偏好"],
      "totalCandidates": 127,
      "finalCount": 5
    }
  }
}
```

---

### POST `/rag/context`

将最近对话片段转换为自动召回的上下文块，适合直接拼入 prompt。

#### Request Body

```json
{
  "recentMessages": [
    { "role": "user", "content": "我下周去深圳住哪里好？" },
    { "role": "assistant", "content": "您之前提到喜欢福田区..." }
  ],
  "target": {
    "diary": "Nova日记本",
    "maid": "Nova"
  },
  "options": {
    "maxBlocks": 3,
    "tokenBudget": 800,
    "minScore": 0.75,
    "maxTokenRatio": 0.6
  },
  "requestContext": {
    "agentId": "nova",
    "sessionId": "sess_001"
  }
}
```

#### Response

```json
{
  "success": true,
  "data": {
    "contextBlocks": [
      {
        "type": "memory",
        "source": "Nova日记本",
        "content": "[2024-03-10] 用户说：\"我出差一般都住福田区，交通方便。\"",
        "relevanceScore": 0.91,
        "tokenEstimate": 45
      }
    ],
    "totalTokenEstimate": 45,
    "queryUsed": "深圳 出差 住宿 福田区"
  }
}
```

---

## 3. 记忆写入

### POST `/memory/write`

向 VCP 日记体系写入持久记忆。支持幂等写入和去重。

#### Request Body

```json
{
  "target": {
    "diary": "Nova日记本",
    "maid": "Nova"
  },
  "memory": {
    "text": "用户提到下周要去深圳出差，喜欢住在福田区",
    "tags": ["出差", "深圳", "福田区", "偏好"],
    "timestamp": "2026-04-13T10:00:00Z",
    "metadata": {
      "source": "ohmy-openagent",
      "priority": "high",
      "conversationId": "conv_123"
    }
  },
  "options": {
    "idempotencyKey": "idmp_001",
    "deduplicate": true
  },
  "requestContext": {
    "agentId": "nova",
    "sessionId": "sess_001"
  }
}
```

#### Response

```json
{
  "success": true,
  "data": {
    "written": true,
    "diary": "Nova日记本",
    "chunkId": "chunk_xxx",
    "vectorized": true,
    "idempotencyKey": "idmp_001"
  }
}
```

---

## 4. 工具调用

### POST `/tools/:toolName`

调用指定插件。支持同步、异步、分布式插件。

#### URL Parameters

| 参数 | 说明 |
|------|------|
| `toolName` | 插件名称，如 `VCPVSearch`、`AgentAssistant` |

#### Request Body

```json
{
  "args": {
    "query": "今天的新闻"
  },
  "requestContext": {
    "agentId": "nova",
    "sessionId": "sess_001",
    "requestId": "req_001",
    "source": "ohmy-openagent"
  }
}
```

#### 通用 Body 字段

| 字段 | 类型 | 必需 | 说明 |
|------|------|------|------|
| `args` | object | 是 | 插件参数，具体字段取决于插件 |
| `requestContext.agentId` | string | 是 | Agent ID |
| `requestContext.sessionId` | string | 是 | 会话 ID |
| `requestContext.requestId` | string | 否 | 追踪 ID |
| `requestContext.source` | string | 否 | 调用来源标识 |

### AgentAssistant 专用参数

当 `toolName` 为 `AgentAssistant` 时，`args` 支持以下参数：

| 参数 | 类型 | 必需 | 说明 |
|------|------|------|------|
| `agent_name` | string | 是 | 目标 Agent 名称（如 `小克`） |
| `prompt` | string | 是 | 发送给目标 Agent 的消息 |
| `timely_contact` | string | 否 | 定时执行时间，格式 `YYYY-MM-DD-HH:mm` |
| `task_delegation` | boolean | 否 | 是否异步委托，默认 `false` |
| `inject_tools` | string | 否 | 临时注入的工具列表，逗号分隔 |
| `query_delegation` | string | 否 | 查询异步委托状态 |
| `maid` | string | 否 | 发送方名称 |
| `session_id` | string | 否 | 会话 ID |
| `temporary_contact` | boolean | 否 | 是否临时联系（不保持上下文） |

#### AgentAssistant 即时通讯 Response

```json
{
  "success": true,
  "data": {
    "toolName": "AgentAssistant",
    "result": {
      "status": "success",
      "result": {
        "content": [{ "type": "text", "text": "你好！我可以帮你搜索量子计算论文。" }]
      }
    }
  }
}
```

#### AgentAssistant 异步委托 Response

```json
{
  "success": true,
  "data": {
    "toolName": "AgentAssistant",
    "result": {
      "status": "success",
      "result": {
        "content": [{ "type": "text", "text": "委托任务 (ID: aa-delegation-xxx) 已成功提交... {{VCP_ASYNC_RESULT::AgentAssistant::aa-delegation-xxx}}" }]
      }
    }
  }
}
```

#### 通用插件 Response

```json
{
  "success": true,
  "data": {
    "toolName": "VCPVSearch",
    "result": {
      "status": "success",
      "result": "1. 今日科技新闻...",
      "messageForAI": "搜索完成"
    },
    "audit": {
      "approvalUsed": false,
      "distributed": false
    }
  }
}
```

---

## 5. 错误代码表

| 错误码 | HTTP 状态 | 说明 |
|--------|-----------|------|
| `OCW_INVALID_REQUEST` | 400 | 请求参数缺失或格式错误 |
| `OCW_RAG_INVALID_QUERY` | 400 | RAG 查询参数无效 |
| `OCW_TOOL_INVALID_ARGS` | 400 | 工具参数不符合 schema |
| `OCW_TOOL_APPROVAL_REQUIRED` | 403 | 工具需要管理员审批 |
| `OCW_RAG_TARGET_FORBIDDEN` | 403 | Agent 无权访问该日记本 |
| `OCW_RAG_TARGET_NOT_FOUND` | 404 | 日记本不存在 |
| `OCW_TOOL_NOT_FOUND` | 404 | 插件不存在或不可桥接 |
| `OCW_INTERNAL_ERROR` | 500 | 服务器内部错误 |

---

## 6. WebSocket 消息格式

连接地址：`ws://<vcp-host>:<port>/vcpinfo/VCP_Key=<your_vcp_key>`

### AGENT_PRIVATE_CHAT_PREVIEW

```json
{
  "type": "AGENT_PRIVATE_CHAT_PREVIEW",
  "agentName": "小克",
  "sessionId": "agent_KE delegation_session",
  "query": "搜索量子计算论文",
  "response": "已找到3篇相关论文...",
  "timestamp": "2026-04-13T10:05:00Z"
}
```

### 异步任务完成通知

通过 `pushVcpInfo` 推送，格式与插件自定义消息相关，常见字段：

```json
{
  "type": "PLUGIN_CALLBACK",
  "pluginName": "AgentAssistant",
  "taskId": "aa-delegation-xxx",
  "status": "Succeed",
  "message": "任务完成报告..."
}
```
