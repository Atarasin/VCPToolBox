# Agent Gateway M0 Baseline

> 目标：在开始 `modules/agentGatewayCore.js` 拆分前，冻结当前 OpenClaw bridge 的外部协议、错误与审计行为，作为后续 M1-M6 的兼容性基线。

## 1. 基线范围

- 当前 OpenClaw 适配入口仍是 `routes/openclawBridgeRoutes.js`，其实现已完全下沉到 `modules/agentGatewayCore.js`
- 本基线只覆盖当前已对外暴露的 `/admin_api/openclaw/*` 行为，不引入新的 Native Gateway 协议
- 可执行基线以 `test/openclaw-bridge-routes.test.js` 为准，人类可读摘要以本文为准

## 2. 当前路由面

| 路由 | 作用 | 当前行为摘要 |
| --- | --- | --- |
| `GET /admin_api/openclaw/capabilities` | 能力发现 | 返回服务信息、可桥接工具描述、memory 功能描述与可访问 target |
| `GET /admin_api/openclaw/rag/targets` | target 发现 | 返回当前 agent 可访问的 diary target 列表 |
| `POST /admin_api/openclaw/rag/search` | 记忆检索 | 返回标准化 item 列表和 diagnostics，支持 target 过滤、time/group/rerank/tagMemo |
| `POST /admin_api/openclaw/rag/context` | 上下文召回 | 返回 recall blocks、estimatedTokens 和 appliedPolicy |
| `POST /admin_api/openclaw/memory/write` | durable memory 写回 | 通过 `DailyNote` create 流程写回日记，并带幂等控制 |
| `POST /admin_api/openclaw/tools/:toolName` | 工具执行 | 统一做 schema 校验、审批拦截、超时/执行错误映射，并透传 `__openclawContext` |

## 3. 典型响应

### 3.1 `capabilities`

典型请求：

```http
GET /admin_api/openclaw/capabilities?agentId=agent.default
```

典型成功响应：

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
        "name": "ChromeBridge",
        "pluginType": "hybridservice",
        "distributed": false
      },
      {
        "name": "RemoteSearch",
        "pluginType": "synchronous",
        "distributed": true
      },
      {
        "name": "SciCalculator",
        "pluginType": "synchronous",
        "distributed": false
      }
    ],
    "memory": {
      "targets": [
        { "id": "Nova" },
        { "id": "SharedMemory" }
      ],
      "features": {
        "timeAware": true,
        "groupAware": true,
        "rerank": true,
        "tagMemo": true,
        "writeBack": false
      }
    }
  },
  "meta": {
    "requestId": "ocw_*",
    "bridgeVersion": "v1",
    "durationMs": 0
  }
}
```

稳定要点：

- 只暴露 `isDistributed`、`hybridservice + direct`、`stdio synchronous/asynchronous` 三类可桥接插件
- `memory.features.writeBack` 只有在 `DailyNote` 可用时才为 `true`
- 响应头必须包含 `x-request-id` 与 `x-openclaw-bridge-version: v1`

### 3.2 `rag/search`

典型请求：

```json
{
  "query": "上周项目会议讨论了什么",
  "diary": "Nova",
  "k": 3,
  "options": {
    "timeAware": true,
    "groupAware": true,
    "rerank": true,
    "tagMemo": true
  },
  "requestContext": {
    "source": "openclaw",
    "agentId": "agent.nova",
    "sessionId": "sess-memory-001",
    "requestId": "req-memory-001"
  }
}
```

典型成功响应：

```json
{
  "success": true,
  "data": {
    "items": [
      {
        "sourceDiary": "Nova",
        "sourceFile": "2026-03-20.md",
        "tags": ["项目", "会议", "桥接"],
        "timestamp": "2026-03-20T10:20:00.000Z"
      }
    ],
    "diagnostics": {
      "mode": "rag",
      "targetDiaries": ["Nova"],
      "resultCount": 1,
      "timeAwareApplied": true,
      "groupAwareApplied": true,
      "rerankApplied": true,
      "tagMemoApplied": true,
      "coreTags": ["项目", "会议"]
    }
  },
  "meta": {
    "requestId": "req-memory-001",
    "bridgeVersion": "v1",
    "durationMs": 0
  }
}
```

典型错误行为：

- 缺少 `query` -> `400 / OCW_RAG_INVALID_QUERY`
- 缺少 `requestContext.agentId` 或 `sessionId` -> `400 / OCW_INVALID_REQUEST`
- diary 不存在 -> `404 / OCW_RAG_TARGET_NOT_FOUND`
- diary 越权 -> `403 / OCW_RAG_TARGET_FORBIDDEN`
- 检索执行失败 -> `500 / OCW_RAG_SEARCH_ERROR`

### 3.3 `rag/context`

典型请求：

```json
{
  "recentMessages": [
    { "role": "user", "content": "帮我回忆一下上周项目会议的关键结论" },
    { "role": "assistant", "content": "我将检索相关日记片段" }
  ],
  "tokenBudget": 80,
  "maxTokenRatio": 0.5,
  "maxBlocks": 1,
  "minScore": 0.7,
  "requestContext": {
    "source": "openclaw-context",
    "agentId": "agent.nova",
    "sessionId": "sess-context-001",
    "requestId": "req-context-001"
  }
}
```

典型成功响应：

```json
{
  "success": true,
  "data": {
    "recallBlocks": [
      {
        "text": "上次A项目会议讨论了接口桥接方案与权限策略。",
        "metadata": {
          "sourceDiary": "Nova",
          "sourceFile": "2026-03-20.md",
          "score": 0.9,
          "truncated": false
        }
      }
    ],
    "estimatedTokens": 10,
    "appliedPolicy": {
      "tokenBudget": 80,
      "maxTokenRatio": 0.5,
      "maxInjectedTokens": 40,
      "maxBlocks": 1,
      "minScore": 0.7,
      "mode": "hybrid",
      "timeAware": true,
      "groupAware": true,
      "rerank": true,
      "tagMemo": true,
      "targetDiaries": ["Nova"]
    }
  },
  "meta": {
    "requestId": "req-context-001",
    "bridgeVersion": "v1",
    "durationMs": 0
  }
}
```

典型错误行为：

- 缺少 `agentId` 或 `sessionId` -> `400 / OCW_INVALID_REQUEST`
- 缺少 `query` 且无法从 `recentMessages` 生成查询 -> `400 / OCW_RAG_INVALID_QUERY`
- diary 不存在 -> `404 / OCW_RAG_TARGET_NOT_FOUND`
- diary 越权 -> `403 / OCW_RAG_TARGET_FORBIDDEN`
- 召回执行失败 -> `500 / OCW_RAG_CONTEXT_ERROR`

### 3.4 `memory/write`

典型请求：

```json
{
  "target": {
    "diary": "Nova"
  },
  "memory": {
    "text": "需要在 Phase 4 中把 durable memory 写回 VCP 日记系统。",
    "tags": ["Phase4", "memory-write"],
    "timestamp": "2026-04-01T09:30:00.000Z",
    "metadata": {
      "sourceEvent": "memory.flush",
      "importance": 0.92
    }
  },
  "options": {
    "idempotencyKey": "mem-write-001",
    "deduplicate": true
  },
  "requestContext": {
    "source": "openclaw-memory",
    "agentId": "agent.nova",
    "sessionId": "sess-memory-write-001",
    "requestId": "req-memory-write-001"
  }
}
```

典型成功响应：

```json
{
  "success": true,
  "data": {
    "writeStatus": "created",
    "diary": "Nova",
    "entryId": "0123456789abcdef01234567",
    "deduplicated": false,
    "filePath": "/tmp/Nova/2026-04-01-09_30_00.md",
    "timestamp": "2026-04-01T09:30:00.000Z"
  },
  "meta": {
    "requestId": "req-memory-write-001",
    "bridgeVersion": "v1",
    "durationMs": 0
  }
}
```

稳定要点：

- durable memory 统一桥接到 `DailyNote` 的 `create` 调用，不再回退到 `DailyNoteWrite`
- `memory.tags` 为必填，不再生成兜底标签
- 同一个 `idempotencyKey` + `deduplicate=true` 会返回 `writeStatus: "skipped_duplicate"`
- 工具透传上下文键为 `__openclawContext`

典型错误行为：

- 缺少 `target.diary` / `memory.text` / `memory.tags` -> `400 / OCW_MEMORY_INVALID_PAYLOAD`
- diary 越权 -> `403 / OCW_MEMORY_TARGET_FORBIDDEN`
- 缺少 `DailyNote` -> `500 / OCW_MEMORY_WRITE_ERROR`
- 插件内部写入异常 -> `400 / OCW_MEMORY_INVALID_PAYLOAD` 或 `500 / OCW_MEMORY_WRITE_ERROR`

### 3.5 `tools/:toolName`

典型请求：

```json
{
  "args": {
    "expression": "1+1"
  },
  "requestContext": {
    "source": "openclaw",
    "agentId": "agent.math",
    "sessionId": "sess-001",
    "requestId": "req-001"
  }
}
```

典型成功响应：

```json
{
  "success": true,
  "data": {
    "toolName": "SciCalculator",
    "result": {
      "status": "success"
    },
    "audit": {
      "approvalUsed": false,
      "distributed": false
    }
  },
  "meta": {
    "requestId": "req-001",
    "bridgeVersion": "v1",
    "durationMs": 0
  }
}
```

稳定要点：

- 正常工具调用会把 `requestContext` 透传为 `args.__openclawContext`
- `vcp_memory_write` 是桥接保留工具名，内部重定向到 memory write 逻辑
- 工具参数先走 schema 校验，再走审批，再执行插件

典型错误行为：

- 缺少 `toolName` 或 `requestContext` -> `400 / OCW_INVALID_REQUEST`
- `args` 非对象或不满足 schema -> `400 / OCW_TOOL_INVALID_ARGS`
- 需要审批 -> `403 / OCW_TOOL_APPROVAL_REQUIRED`
- 工具不存在 -> `404 / OCW_TOOL_NOT_FOUND`
- 超时 -> `504 / OCW_TOOL_TIMEOUT`
- 其他执行异常 -> `500 / OCW_TOOL_EXECUTION_ERROR`

## 4. 稳定响应包络

成功包络：

```json
{
  "success": true,
  "data": {},
  "meta": {
    "requestId": "string",
    "bridgeVersion": "v1",
    "durationMs": 0
  }
}
```

失败包络：

```json
{
  "success": false,
  "error": "string",
  "code": "OCW_*",
  "details": {},
  "meta": {
    "requestId": "string",
    "bridgeVersion": "v1",
    "durationMs": 0
  }
}
```

稳定 header：

- `x-request-id`: 请求级追踪 ID，优先复用外部提供值，否则由网关生成
- `x-openclaw-bridge-version`: 当前固定为 `v1`

## 5. 错误码基线

| 范围 | 错误码 |
| --- | --- |
| 通用请求 | `OCW_INVALID_REQUEST`, `OCW_INTERNAL_ERROR` |
| RAG Search | `OCW_RAG_INVALID_QUERY`, `OCW_RAG_TARGET_NOT_FOUND`, `OCW_RAG_TARGET_FORBIDDEN`, `OCW_RAG_SEARCH_ERROR` |
| RAG Context | `OCW_RAG_INVALID_QUERY`, `OCW_RAG_TARGET_NOT_FOUND`, `OCW_RAG_TARGET_FORBIDDEN`, `OCW_RAG_CONTEXT_ERROR` |
| Memory Write | `OCW_MEMORY_INVALID_PAYLOAD`, `OCW_MEMORY_TARGET_FORBIDDEN`, `OCW_MEMORY_WRITE_ERROR` |
| Tool Runtime | `OCW_TOOL_NOT_FOUND`, `OCW_TOOL_APPROVAL_REQUIRED`, `OCW_TOOL_INVALID_ARGS`, `OCW_TOOL_TIMEOUT`, `OCW_TOOL_EXECUTION_ERROR` |

## 6. 审计行为基线

当前审计统一输出到控制台前缀：

```text
[OpenClawBridgeAudit] {...json...}
```

当前事件名集合：

- `memory.write.started`
- `memory.write.duplicate`
- `memory.write.completed`
- `memory.write.failed`
- `rag.search.started`
- `rag.search.completed`
- `rag.search.failed`
- `rag.context.started`
- `rag.context.completed`
- `rag.context.failed`
- `tool.approval_required`
- `tool.invoke.started`
- `tool.invoke.completed`
- `tool.invoke.failed`

稳定字段约束：

- 所有审计事件都带 `requestId`
- Memory / RAG / Tool 主链路都带 `source`、`agentId`、`sessionId`
- 完成/失败事件都带 `durationMs`
- `rag.search.completed` 和 `rag.context.completed` 带 score statistics

## 7. 后续阶段约束

- M1 之前不得改变本文件记录的 response envelope、错误码和关键审计事件名
- 每轮重构前先跑 `node --test test/openclaw-bridge-routes.test.js`
- 后续拆分顺序固定为 `contracts -> infra -> capability -> memory/context -> tool runtime -> registry -> native gateway`
- 当前轮次明确不做：完整独立 auth、完整 jobs runtime、MCP 正式实现

## 8. 回归结果与风险

回归命令：

```bash
node --test test/openclaw-bridge-routes.test.js
```

当前结果：

- `2026-04-18` 执行通过
- `24/24` 用例通过，`0` 失败，`0` 跳过
- 验证覆盖 `capabilities`、`rag/targets`、`rag/search`、`rag/context`、`memory/write`、`tools/:toolName`、`vcp_memory_write` 桥接、approval、timeout 与审计统计

当前已知风险：

- 本文是“代表性基线”，精确字段仍以测试断言为准
- `modules/agentGatewayCore.js` 仍是单体，职责边界尚未通过物理文件拆分兑现
- 后续如果新增对外能力，必须确认其复用同一套 Gateway Core，而不是再次把逻辑写回 adapter
