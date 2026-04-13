# OpenClaw Bridge API 接口文档

> 基于 `routes/openclawBridgeRoutes.js` 当前实现自动生成  
> 桥接版本：`v1`

---

## 通用约定

### 响应格式

所有接口统一返回以下结构：

#### 成功响应

```json
{
  "success": true,
  "data": { /* 接口特定数据 */ },
  "meta": {
    "requestId": "ocw_xxxxxxxx",
    "bridgeVersion": "v1",
    "durationMs": 42
  }
}
```

#### 错误响应

```json
{
  "success": false,
  "error": "错误描述",
  "code": "OCW_XXXXX",
  "details": { /* 额外细节 */ },
  "meta": {
    "requestId": "ocw_xxxxxxxx",
    "bridgeVersion": "v1",
    "durationMs": 12
  }
}
```

### 通用请求头

| 头字段 | 说明 |
|--------|------|
| `Content-Type` | `application/json`（POST/PUT 接口必需） |
| `X-Request-Id` | 可选，客户端自定义请求追踪 ID |

### requestContext 规范

以下 POST 接口在请求体中可包含 `requestContext` 对象，用于统一传递审计与追踪信息：

```json
{
  "requestContext": {
    "agentId": "agent-001",
    "sessionId": "session-abc",
    "requestId": "req-123",
    "source": "openclaw"
  }
}
```

---

## 1. 获取能力清单

### `GET /openclaw/capabilities`

获取当前 OpenClaw 桥接端点支持的工具列表与记忆系统能力描述。

#### Query 参数

| 参数 | 类型 | 必填 | 默认值 | 说明 |
|------|------|------|--------|------|
| `agentId` | string | **是** | - | 调用方 Agent 标识 |
| `maid` | string | 否 | - | 关联的 Maid 标识 |
| `requestId` | string | 否 | 自动生成 | 请求追踪 ID |
| `includeMemoryTargets` | boolean/string | 否 | `true` | 是否在 memory 中返回可访问的日记本目标列表 |

#### 成功响应示例

```json
{
  "success": true,
  "data": {
    "server": {
      "name": "VCPToolBox",
      "version": "1.x.x",
      "bridgeVersion": "v1"
    },
    "tools": [
      {
        "name": "DailyNote",
        "displayName": "DailyNote",
        "pluginType": "distributed",
        "distributed": true,
        "approvalRequired": false,
        "timeoutMs": 30000,
        "description": "...",
        "inputSchema": { /* JSON Schema */ },
        "invocationCommands": [ /* ... */ ]
      }
    ],
    "memory": {
      "targets": [ /* 当 includeMemoryTargets=true 时返回 */ ],
      "features": {
        "timeAware": true,
        "groupAware": true,
        "rerank": true,
        "tagMemo": true,
        "writeBack": true
      }
    }
  },
  "meta": { "requestId": "...", "bridgeVersion": "v1", "durationMs": 15 }
}
```

#### 错误码

| HTTP | Code | 说明 |
|------|------|------|
| 400 | `OCW_INVALID_REQUEST` | `agentId` 缺失 |
| 500 | `OCW_INTERNAL_ERROR` | 构建能力清单时发生内部错误 |

---

## 2. 获取 RAG 目标列表

### `GET /openclaw/rag/targets`

获取当前 Agent 可访问的 RAG 日记本（记忆目标）列表。

#### Query 参数

| 参数 | 类型 | 必填 | 默认值 | 说明 |
|------|------|------|--------|------|
| `agentId` | string | **是** | - | 调用方 Agent 标识 |
| `maid` | string | 否 | - | 关联的 Maid 标识 |
| `requestId` | string | 否 | 自动生成 | 请求追踪 ID |

#### 成功响应示例

```json
{
  "success": true,
  "data": {
    "targets": ["diary-a", "diary-b"]
  },
  "meta": { "requestId": "...", "bridgeVersion": "v1", "durationMs": 8 }
}
```

#### 错误码

| HTTP | Code | 说明 |
|------|------|------|
| 400 | `OCW_INVALID_REQUEST` | `agentId` 缺失 |
| 500 | `OCW_INTERNAL_ERROR` | 加载 RAG 目标时发生内部错误 |

---

## 3. 执行 RAG 语义检索

### `POST /openclaw/rag/search`

执行语义检索，支持 `rag` / `hybrid` / `auto` 三种模式，可选时间感知、分组感知、标签增强、重排序等特性。

#### 请求体

| 字段 | 类型 | 必填 | 默认值 | 说明 |
|------|------|------|--------|------|
| `query` | string | **是** | - | 检索查询文本 |
| `requestContext` | object | **是** | - | 包含 `agentId`、`sessionId` |
| `diary` | string | 否 | - | 单日记本约束（兼容字段） |
| `diaries` | string[] | 否 | - | 多日记本约束列表 |
| `maid` | string | 否 | - | Maid 标识 |
| `mode` | string | 否 | `rag` | 检索模式：`rag` \| `hybrid` \| `auto` |
| `k` | integer | 否 | `5` | 返回结果数量上限（最大 `20`） |
| `timeAware` | boolean | 否 | `true`(hybrid)/`false` | 是否启用时间范围解析 |
| `groupAware` | boolean | 否 | `true`(hybrid)/`false` | 是否启用语义分组增强 |
| `rerank` | boolean | 否 | `false` | 是否对结果重排序 |
| `tagMemo` | boolean | 否 | `true`(hybrid)/`false` | 是否启用标签权重增强 |
| `options` | object | 否 | `{}` | 兼容的选项对象，内部可含上述开关 |

#### 成功响应示例

```json
{
  "success": true,
  "data": {
    "items": [
      {
        "text": "...检索到的文本片段...",
        "score": 0.872,
        "sourceDiary": "diary-a",
        "sourceFile": "2025-04-01.md",
        "timestamp": "2025-04-01T12:00:00.000Z",
        "tags": ["tag1", "tag2"]
      }
    ],
    "diagnostics": {
      "mode": "hybrid",
      "targetDiaries": ["diary-a"],
      "resultCount": 5,
      "timeAwareApplied": false,
      "groupAwareApplied": true,
      "rerankApplied": false,
      "tagMemoApplied": true,
      "coreTags": ["tag1"],
      "durationMs": 156
    }
  },
  "meta": { "requestId": "...", "bridgeVersion": "v1", "durationMs": 156 }
}
```

#### 错误码

| HTTP | Code | 说明 |
|------|------|------|
| 400 | `OCW_RAG_INVALID_QUERY` | `query` 缺失，或 `mode` 非法 |
| 400 | `OCW_INVALID_REQUEST` | `agentId` / `sessionId` 缺失 |
| 403 | `OCW_RAG_TARGET_FORBIDDEN` | 请求的日记本不被允许访问 |
| 404 | `OCW_RAG_TARGET_NOT_FOUND` | 请求的日记本不存在 |
| 500 | `OCW_RAG_SEARCH_ERROR` | 检索执行失败 |

---

## 4. 构建 RAG 回忆上下文

### `POST /openclaw/rag/context`

在 `search` 基础上增加上下文组装策略：Token 预算控制、块数限制、最低分数阈值、超大块截断，最终返回可直接注入 LLM 的 `recallBlocks`。

#### 请求体

| 字段 | 类型 | 必填 | 默认值 | 说明 |
|------|------|------|--------|------|
| `query` | string | 条件必填 | - | 显式查询文本（与 `recentMessages` 二选一） |
| `recentMessages` | object[] | 条件必填 | - | 最近对话消息数组，自动拼接为查询文本 |
| `requestContext` | object | **是** | - | 包含 `agentId`、`sessionId` |
| `agentId` | string | 否 | - | 可直接传于根级（兼容写法） |
| `sessionId` | string | 否 | - | 可直接传于根级（兼容写法） |
| `diary` | string | 否 | - | 单日记本约束 |
| `diaries` | string[] | 否 | - | 多日记本约束列表 |
| `maid` | string | 否 | - | Maid 标识 |
| `maxBlocks` | integer | 否 | `4` | 返回最大上下文块数（最大 `20`） |
| `tokenBudget` | integer | 否 | `1200` | Token 预算上限（最大 `4000`） |
| `maxTokenRatio` | number | 否 | `0.6` | 实际可用于注入的 Token 比例（`0.1` ~ `1.0`） |
| `minScore` | number | 否 | `0.7` | 上下文块最低相似度分数阈值 |
| `mode` | string | 否 | `hybrid` | 检索模式：`rag` \| `hybrid` \| `auto` |
| `k` | integer | 否 | 由 `maxBlocks` 推导 | 内部检索候选数 |
| `timeAware` | boolean | 否 | `true` | 是否启用时间范围解析 |
| `groupAware` | boolean | 否 | `true` | 是否启用语义分组增强 |
| `rerank` | boolean | 否 | `true` | 是否启用重排序 |
| `tagMemo` | boolean | 否 | `true` | 是否启用标签权重增强 |

#### 成功响应示例

```json
{
  "success": true,
  "data": {
    "recallBlocks": [
      {
        "text": "...上下文文本...",
        "metadata": {
          "score": 0.91,
          "sourceDiary": "diary-a",
          "sourceFile": "2025-04-01.md",
          "timestamp": "2025-04-01T12:00:00.000Z",
          "tags": ["tag1"],
          "estimatedTokens": 128,
          "truncated": false
        }
      }
    ],
    "estimatedTokens": 128,
    "appliedPolicy": {
      "tokenBudget": 1200,
      "maxTokenRatio": 0.6,
      "maxInjectedTokens": 720,
      "maxBlocks": 4,
      "minScore": 0.7,
      "mode": "hybrid",
      "timeAware": true,
      "groupAware": true,
      "rerank": true,
      "tagMemo": true,
      "targetDiaries": ["diary-a"]
    }
  },
  "meta": { "requestId": "...", "bridgeVersion": "v1", "durationMs": 203 }
}
```

#### 错误码

| HTTP | Code | 说明 |
|------|------|------|
| 400 | `OCW_INVALID_REQUEST` | `agentId` / `sessionId` 缺失 |
| 400 | `OCW_RAG_INVALID_QUERY` | `query` 与 `recentMessages` 均未提供 |
| 403 | `OCW_RAG_TARGET_FORBIDDEN` | 日记本访问被拒绝 |
| 404 | `OCW_RAG_TARGET_NOT_FOUND` | 日记本不存在 |
| 500 | `OCW_RAG_CONTEXT_ERROR` | 上下文构建失败 |

---

## 5. 写入记忆（Memory Write）

### `POST /openclaw/memory/write`

将 OpenClaw durable memory 写回 VCP 日记体系（通过 `DailyNote` 插件）。支持幂等键与内容指纹去重。

#### 请求体

| 字段 | 类型 | 必填 | 默认值 | 说明 |
|------|------|------|--------|------|
| `requestContext` | object | **是** | - | 包含 `agentId`、`sessionId` |
| `target` | object | **是** | - | 写入目标 |
| `target.diary` | string | **是** | - | 目标日记本名称 |
| `target.maid` | string | 否 | - | 目标 Maid 标识 |
| `memory` | object | **是** | - | 记忆内容 |
| `memory.text` | string | **是** | - | 记忆文本内容 |
| `memory.tags` | string[] | **是** | - | 标签数组 |
| `memory.timestamp` | string/number | 否 | 当前时间 | 记忆时间戳 |
| `memory.metadata` | object | 否 | - | 额外元数据 |
| `options` | object | 否 | `{}` | 写入选项 |
| `options.idempotencyKey` | string | 否 | - | 幂等键，用于防止重复写入 |
| `options.deduplicate` | boolean | 否 | `true` | 是否启用内容指纹去重 |

> **兼容写法**：根级也可直接传 `diary`、`text`、`tags`、`timestamp`、`metadata`、`idempotencyKey`。

#### 成功响应示例

**正常写入**

```json
{
  "success": true,
  "data": {
    "writeStatus": "created",
    "diary": "diary-a",
    "entryId": "ocw_mem_xxxx",
    "deduplicated": false,
    "filePath": "DailyNote/diary-a/2025-04-01.md",
    "timestamp": "2025-04-01T14:30:00.000Z"
  },
  "meta": { "requestId": "...", "bridgeVersion": "v1", "durationMs": 89 }
}
```

**重复写入（被去重跳过）**

```json
{
  "success": true,
  "data": {
    "writeStatus": "skipped_duplicate",
    "diary": "diary-a",
    "entryId": "ocw_mem_xxxx",
    "deduplicated": true,
    "filePath": "DailyNote/diary-a/2025-04-01.md",
    "timestamp": "2025-04-01T14:30:00.000Z"
  },
  "meta": { "requestId": "...", "bridgeVersion": "v1", "durationMs": 12 }
}
```

#### 错误码

| HTTP | Code | 说明 |
|------|------|------|
| 400 | `OCW_INVALID_REQUEST` | `agentId` / `sessionId` 缺失 |
| 400 | `OCW_MEMORY_INVALID_PAYLOAD` | `target.diary`、`memory.text` 或 `memory.tags` 缺失 |
| 403 | `OCW_MEMORY_TARGET_FORBIDDEN` | 目标日记本不允许该 Agent 写入 |
| 500 | `OCW_MEMORY_WRITE_ERROR` | `DailyNote` 插件不可用或写入失败 |

---

## 6. 调用工具

### `POST /openclaw/tools/:toolName`

调用指定桥接工具，执行对应插件功能。工具名即插件 `name`。

#### Path 参数

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `toolName` | string | **是** | 工具/插件名称 |

#### 请求体

| 字段 | 类型 | 必填 | 默认值 | 说明 |
|------|------|------|--------|------|
| `args` | object | **是** | - | 工具调用参数，必须符合该工具的 `inputSchema` |
| `requestContext` | object | **是** | - | 包含 `agentId`、`sessionId` |

#### 成功响应示例

```json
{
  "success": true,
  "data": {
    "toolName": "DailyNote",
    "result": { /* 插件原始返回结果 */ },
    "audit": {
      "approvalUsed": false,
      "distributed": true
    }
  },
  "meta": { "requestId": "...", "bridgeVersion": "v1", "durationMs": 234 }
}
```

#### 错误码

| HTTP | Code | 说明 |
|------|------|------|
| 400 | `OCW_INVALID_REQUEST` | `toolName` 缺失，或 `agentId` / `sessionId` 缺失 |
| 400 | `OCW_TOOL_INVALID_ARGS` | `args` 不是对象，或不符合 inputSchema |
| 403 | `OCW_TOOL_APPROVAL_REQUIRED` | 该工具需要人工审批 |
| 404 | `OCW_TOOL_NOT_FOUND` | 工具不存在或不可桥接 |
| 500 | `OCW_TOOL_EXECUTION_ERROR` | 工具执行失败（由具体插件或系统错误映射） |

> **特殊说明**：当 `toolName` 为 `vcp_memory_write` 时，内部会路由到与 `/openclaw/memory/write` 相同的写入逻辑。

---

## 附录 A：常量与限制

| 常量 | 值 | 说明 |
|------|-----|------|
| `OPENCLAW_BRIDGE_VERSION` | `v1` | 桥接版本 |
| `OPENCLAW_DEFAULT_RAG_K` | `5` | 默认 RAG 返回数量 |
| `OPENCLAW_MAX_RAG_K` | `20` | 最大 RAG 返回数量 |
| `OPENCLAW_DEFAULT_CONTEXT_MAX_BLOCKS` | `4` | 默认上下文最大块数 |
| `OPENCLAW_DEFAULT_CONTEXT_TOKEN_BUDGET` | `1200` | 默认 Token 预算 |
| `OPENCLAW_MAX_CONTEXT_TOKEN_BUDGET` | `4000` | 最大 Token 预算 |
| `OPENCLAW_DEFAULT_CONTEXT_MIN_SCORE` | `0.7` | 默认最低相似度阈值 |
| `OPENCLAW_DEFAULT_CONTEXT_MAX_TOKEN_RATIO` | `0.6` | 默认 Token 注入比例上限 |
| `OPENCLAW_MAX_CONTEXT_MESSAGES` | `12` | `recentMessages` 最大解析消息数 |
| `OPENCLAW_TAG_BOOST` | `0.15` | 标签权重提升系数 |
| `OPENCLAW_MEMORY_WRITE_TOOL_NAME` | `vcp_memory_write` | 记忆写入专用工具名 |

---

## 附录 B：OpenClaw 错误代码速查表

| 错误代码 | 触发场景 |
|----------|----------|
| `OCW_INVALID_REQUEST` | 通用参数缺失或格式错误 |
| `OCW_INTERNAL_ERROR` | 服务端内部异常 |
| `OCW_RAG_INVALID_QUERY` | RAG 查询文本缺失或模式非法 |
| `OCW_RAG_TARGET_NOT_FOUND` | 请求的日记本不存在 |
| `OCW_RAG_TARGET_FORBIDDEN` | 日记本访问/写入被拒绝 |
| `OCW_RAG_SEARCH_ERROR` | RAG 检索执行失败 |
| `OCW_RAG_CONTEXT_ERROR` | RAG 上下文构建失败 |
| `OCW_MEMORY_INVALID_PAYLOAD` | 记忆写入参数缺失 |
| `OCW_MEMORY_TARGET_FORBIDDEN` | 记忆写入目标无权限 |
| `OCW_MEMORY_WRITE_ERROR` | `DailyNote` 插件缺失或写入失败 |
| `OCW_TOOL_INVALID_ARGS` | 工具参数格式错误或校验不通过 |
| `OCW_TOOL_NOT_FOUND` | 工具未找到或不可桥接 |
| `OCW_TOOL_APPROVAL_REQUIRED` | 工具调用需要审批 |
| `OCW_TOOL_EXECUTION_ERROR` | 工具执行期异常 |
