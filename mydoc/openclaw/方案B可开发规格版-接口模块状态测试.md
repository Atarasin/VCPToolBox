# 方案B可开发规格版（接口 / 模块 / 状态 / 测试）

## 1. 文档定位

这份文档不是“继续讨论方案”，而是把方案B收敛成可以直接分配给开发者实现的规格说明。

适用对象：

- VCPToolBox 后端开发
- OpenClaw 插件开发
- 联调与测试人员

本文输出四类可直接开发的内容：

1. 接口契约
2. 模块边界
3. 状态流与错误码
4. 测试基线

---

## 2. 目标版本与范围

本规格定义：

- **Bridge 协议版本**：`v1`
- **接入方案**：方案B（OpenClaw 原生工具 + 原生记忆双桥接）
- **通信方式**：本机 HTTP JSON API
- **能力范围**：
  - 工具发现
  - 工具调用
  - RAG 检索
  - 自动上下文召回
  - 记忆写回

不在本规格内的内容：

- MCP 标准化对外接口
- OpenClaw UI 层定制
- VCP 全插件体系重构

---

## 3. 当前实现依赖点

本规格严格建立在当前代码能力上，不新造第二套执行内核。

- VCP 统一工具执行入口：`PluginManager.processToolCall()`  
  参考：[Plugin.js:L778-L852](file:///home/zh/projects/VCP/VCPToolBox/Plugin.js#L778-L852)
- 当前插件管理接口：`GET /admin_api/plugins`  
  参考：[adminPanelRoutes.js:L380-L462](file:///home/zh/projects/VCP/VCPToolBox/routes/adminPanelRoutes.js#L380-L462)
- 当前人工工具入口：`POST /v1/human/tool`  
  参考：[server.js:L888-L954](file:///home/zh/projects/VCP/VCPToolBox/server.js#L888-L954)
- VCP RAG 占位符处理入口：`RAGDiaryPlugin._processRAGPlaceholder()`  
  参考：[RAGDiaryPlugin.js:L2177-L2214](file:///home/zh/projects/VCP/VCPToolBox/Plugin/RAGDiaryPlugin/RAGDiaryPlugin.js#L2177-L2214)
- 知识库统一检索入口：`KnowledgeBaseManager.search(...)`  
  参考：[KnowledgeBaseManager.js:L314-L354](file:///home/zh/projects/VCP/VCPToolBox/KnowledgeBaseManager.js#L314-L354)

因此开发原则是：

- 工具执行复用 `processToolCall`
- 记忆检索复用 `KnowledgeBaseManager`
- 自动回忆必要时复用 `RAGDiaryPlugin` 的策略逻辑，但不暴露占位符 DSL 给 OpenClaw

---

## 4. 总体组件规格

## 4.1 VCP 侧新增组件

建议新增一个桥接服务抽象：

- 组件名：`OpenClawBridgeService`
- 推荐类型：`hybridservice`

建议职责：

1. 暴露 OpenClaw 专用 API
2. 将 VCP 插件能力映射为结构化工具描述
3. 代理工具调用到 `PluginManager.processToolCall()`
4. 代理检索调用到 `KnowledgeBaseManager`
5. 统一处理审计、限权、错误码

建议落点：

- 路由入口放在 [adminPanelRoutes.js](file:///home/zh/projects/VCP/VCPToolBox/routes/adminPanelRoutes.js)
- 核心逻辑放在新服务模块中，由路由调用

## 4.2 OpenClaw 侧新增组件

建议插件包名：

- `@vcp/openclaw-vcptoolbox`

建议模块结构：

```text
src/
  index.ts
  client/
    VcpClient.ts
  config/
    schema.ts
  tools/
    VcpToolRegistry.ts
    toolMapper.ts
  memory/
    VcpMemoryAdapter.ts
    diaryResolver.ts
  context/
    VcpContextEngine.ts
    recallBudget.ts
  policy/
    VcpPolicyGuard.ts
  telemetry/
    auditLogger.ts
    metrics.ts
  types/
    bridge.ts
    config.ts
```

---

## 5. API 契约规格

所有接口统一前缀：

- `/admin_api/openclaw`

统一响应格式：

### 成功

```json
{
  "success": true,
  "data": {},
  "meta": {
    "requestId": "ocw_20260328_xxx",
    "bridgeVersion": "v1",
    "durationMs": 42
  }
}
```

### 失败

```json
{
  "success": false,
  "error": "工具调用失败",
  "code": "OCW_TOOL_EXECUTION_ERROR",
  "details": {
    "toolName": "SomeTool"
  },
  "meta": {
    "requestId": "ocw_20260328_xxx",
    "bridgeVersion": "v1",
    "durationMs": 42
  }
}
```

所有响应头要求：

- `x-openclaw-bridge-version: v1`
- `x-request-id: <requestId>`

---

## 5.1 健康检查

### `GET /admin_api/openclaw/health`

### 用途

- OpenClaw 插件启动时探活
- 灰度与联调期间快速确认 VCP Bridge 可用性

### 请求参数

无

### 成功响应 `data`

```json
{
  "status": "ok",
  "serverTime": "2026-03-28T12:00:00.000Z",
  "pluginManagerReady": true,
  "knowledgeBaseReady": true,
  "bridgeVersion": "v1"
}
```

---

## 5.2 能力发现

### `GET /admin_api/openclaw/capabilities`

### 用途

- OpenClaw 启动时拉取一次
- 配置热更新或定时刷新时重新拉取

### 查询参数

```json
{
  "agentId": "default",
  "includeDisabled": false,
  "includeMemoryTargets": true
}
```

### 成功响应 `data`

```json
{
  "server": {
    "name": "VCPToolBox",
    "version": "6.4",
    "bridgeVersion": "v1"
  },
  "tools": [
    {
      "name": "ChromeControl",
      "displayName": "Chrome 浏览器桥接器",
      "pluginType": "hybridservice",
      "distributed": false,
      "approvalRequired": false,
      "timeoutMs": 30000,
      "description": "执行浏览器控制命令",
      "inputSchema": {
        "type": "object",
        "properties": {
          "command": { "type": "string" },
          "target": { "type": "string" },
          "text": { "type": "string" },
          "url": { "type": "string" }
        },
        "required": ["command"]
      }
    }
  ],
  "memory": {
    "targets": [
      {
        "id": "Nova",
        "displayName": "Nova日记本",
        "type": "diary",
        "modes": ["rag", "context", "write"]
      }
    ],
    "features": {
      "timeAware": true,
      "groupAware": true,
      "rerank": true,
      "tagMemo": true,
      "writeBack": true
    }
  }
}
```

### 实现规则

1. `tools` 仅暴露允许桥接的插件
2. 不自动暴露 `messagePreprocessor` 与 `service` 为 tool
3. `inputSchema` 来源优先级：
   - 插件显式桥接 schema
   - `configSchema` + `invocationCommands`
   - 手工适配表

---

## 5.3 工具调用

### `POST /admin_api/openclaw/tools/:toolName`

### 请求体

```json
{
  "args": {
    "command": "click",
    "target": "#submit"
  },
  "requestContext": {
    "source": "openclaw",
    "agentId": "default",
    "sessionId": "sess_123",
    "requestId": "oc_req_001"
  }
}
```

### 成功响应 `data`

```json
{
  "toolName": "ChromeControl",
  "result": {
    "status": "success",
    "message": "clicked"
  },
  "audit": {
    "approvalUsed": false,
    "distributed": false
  }
}
```

### 失败错误码

| code | 含义 | HTTP |
|---|---|---|
| `OCW_TOOL_NOT_FOUND` | 工具不存在或不允许暴露 | 404 |
| `OCW_TOOL_INVALID_ARGS` | 参数不符合 schema | 400 |
| `OCW_TOOL_APPROVAL_REQUIRED` | 工具需要人工审批但未通过 | 403 |
| `OCW_TOOL_TIMEOUT` | 执行超时 | 504 |
| `OCW_TOOL_EXECUTION_ERROR` | 插件执行失败 | 500 |

### 实现要求

1. 必须在执行前做 schema 校验
2. 必须透传 `agentId/sessionId/requestId`
3. 必须将 `processToolCall()` 的异常规范化成上表错误码

---

## 5.4 RAG 目标发现

### `GET /admin_api/openclaw/rag/targets`

### 查询参数

- `agentId`

### 成功响应 `data`

```json
{
  "targets": [
    {
      "id": "Nova",
      "displayName": "Nova日记本",
      "type": "diary",
      "allowed": true
    }
  ]
}
```

### 实现要求

1. 返回结果必须经过权限过滤
2. `allowed=false` 的目标不应默认返回，除非带 debug/admin 查询参数

---

## 5.5 RAG 检索

### `POST /admin_api/openclaw/rag/search`

### 请求体

```json
{
  "query": "关于上次A项目会议的讨论内容",
  "diary": "Nova",
  "k": 5,
  "mode": "rag",
  "options": {
    "timeAware": true,
    "groupAware": true,
    "rerank": false,
    "tagMemo": true
  },
  "requestContext": {
    "source": "openclaw",
    "agentId": "default",
    "sessionId": "sess_123",
    "requestId": "oc_req_002"
  }
}
```

### 成功响应 `data`

```json
{
  "items": [
    {
      "id": "chunk_001",
      "text": "上次A项目会议讨论了接口桥接方案与权限策略。",
      "score": 0.921,
      "sourceDiary": "Nova",
      "sourceFile": "2026-03-20.md",
      "timestamp": "2026-03-20T10:20:00+08:00",
      "tags": ["项目", "会议", "桥接"]
    }
  ],
  "diagnostics": {
    "resultCount": 1,
    "timeAwareApplied": true,
    "groupAwareApplied": true,
    "rerankApplied": false,
    "tagMemoApplied": true
  }
}
```

### 失败错误码

| code | 含义 | HTTP |
|---|---|---|
| `OCW_RAG_INVALID_QUERY` | query 为空或非法 | 400 |
| `OCW_RAG_TARGET_FORBIDDEN` | diary 无权访问 | 403 |
| `OCW_RAG_TARGET_NOT_FOUND` | diary 不存在 | 404 |
| `OCW_RAG_SEARCH_ERROR` | 检索执行失败 | 500 |

### 实现要求

1. 必须支持 diary 缺省场景
2. diary 缺省时允许按 agent 映射的 target 集合进行搜索
3. 必须返回结构化 metadata，不只返回纯文本

---

## 5.6 上下文召回

### `POST /admin_api/openclaw/rag/context`

### 请求体

```json
{
  "conversation": {
    "lastUserMessage": "继续讨论 openclaw 接入的实施顺序",
    "lastAssistantMessage": "可以先做工具桥",
    "recentMessages": [
      { "role": "user", "content": "..." },
      { "role": "assistant", "content": "..." }
    ]
  },
  "memoryTargets": ["Nova"],
  "budget": {
    "maxBlocks": 4,
    "maxTokens": 1200
  },
  "policy": {
    "minScore": 0.72,
    "allowTimeAware": true,
    "allowGroupAware": true,
    "allowRerank": false
  },
  "requestContext": {
    "source": "openclaw",
    "agentId": "default",
    "sessionId": "sess_123",
    "requestId": "oc_req_003"
  }
}
```

### 成功响应 `data`

```json
{
  "recallBlocks": [
    {
      "id": "recall_001",
      "text": "此前已决定先做工具桥接，再做 memory_search。",
      "score": 0.89,
      "estimatedTokens": 42,
      "metadata": {
        "sourceDiary": "Nova",
        "sourceFile": "2026-03-21.md",
        "strategy": ["rag", "timeAware"]
      }
    }
  ],
  "estimatedTokens": 42,
  "appliedPolicy": {
    "maxBlocks": 4,
    "maxTokens": 1200,
    "minScore": 0.72
  }
}
```

### 失败错误码

| code | 含义 | HTTP |
|---|---|---|
| `OCW_CONTEXT_INVALID_INPUT` | 输入消息无效 | 400 |
| `OCW_CONTEXT_TARGET_FORBIDDEN` | 目标 diary 不可访问 | 403 |
| `OCW_CONTEXT_BUILD_ERROR` | 上下文召回构建失败 | 500 |

### 实现要求

1. 召回块必须去重
2. 必须按 token budget 截断
3. 返回空数组属于成功，不应作为错误

---

## 5.7 记忆写回

### `POST /admin_api/openclaw/memory/write`

### 请求体

```json
{
  "target": {
    "diary": "Nova"
  },
  "memory": {
    "text": "已确定先开发 OpenClaw Bridge v1，再接 memory_search。",
    "tags": ["openclaw", "bridge", "计划"],
    "timestamp": "2026-03-28T14:00:00+08:00"
  },
  "options": {
    "idempotencyKey": "mem_20260328_001",
    "deduplicate": true
  },
  "requestContext": {
    "source": "openclaw",
    "agentId": "default",
    "sessionId": "sess_123",
    "requestId": "oc_req_004"
  }
}
```

### 成功响应 `data`

```json
{
  "writeStatus": "created",
  "diary": "Nova",
  "entryId": "note_001",
  "deduplicated": false
}
```

### `writeStatus` 枚举

- `created`
- `updated`
- `skipped_duplicate`

### 失败错误码

| code | 含义 | HTTP |
|---|---|---|
| `OCW_MEMORY_TARGET_FORBIDDEN` | 无权写入该 diary | 403 |
| `OCW_MEMORY_INVALID_PAYLOAD` | 记忆内容无效 | 400 |
| `OCW_MEMORY_WRITE_ERROR` | 写回失败 | 500 |

---

## 6. OpenClaw 插件模块接口规格

以下接口是建议的实现边界，便于多人并行开发。

## 6.1 类型定义

```ts
export interface BridgeMeta {
  requestId: string;
  bridgeVersion: "v1";
  durationMs: number;
}

export interface BridgeSuccess<T> {
  success: true;
  data: T;
  meta: BridgeMeta;
}

export interface BridgeError {
  success: false;
  error: string;
  code: string;
  details?: Record<string, unknown>;
  meta: BridgeMeta;
}
```

## 6.2 VcpClient

```ts
export interface VcpClient {
  health(): Promise<BridgeSuccess<HealthData>>;
  getCapabilities(agentId: string): Promise<BridgeSuccess<CapabilitiesData>>;
  invokeTool(toolName: string, body: InvokeToolRequest): Promise<BridgeSuccess<InvokeToolData>>;
  listRagTargets(agentId: string): Promise<BridgeSuccess<RagTargetsData>>;
  ragSearch(body: RagSearchRequest): Promise<BridgeSuccess<RagSearchData>>;
  buildContext(body: RagContextRequest): Promise<BridgeSuccess<RagContextData>>;
  writeMemory(body: MemoryWriteRequest): Promise<BridgeSuccess<MemoryWriteData>>;
}
```

职责约束：

1. 不包含业务策略
2. 只负责 HTTP 调用、超时、重试、鉴权、错误解析

## 6.3 VcpToolRegistry

```ts
export interface VcpToolRegistry {
  refresh(agentId: string): Promise<void>;
  registerAll(api: OpenClawPluginApi): Promise<void>;
  getRegisteredTools(): RegisteredTool[];
}
```

职责约束：

1. 根据 capabilities 构造工具 schema
2. 应用 allow/deny policy
3. 不直接处理 tool 执行细节

## 6.4 VcpMemoryAdapter

```ts
export interface VcpMemoryAdapter {
  search(query: string, agentId: string, options?: Partial<RagSearchRequest>): Promise<MemorySearchResult[]>;
  write(entry: MemoryWriteRequest): Promise<MemoryWriteData>;
}
```

职责约束：

1. diary 解析与选择
2. 结果格式规范化
3. 不做 HTTP 原始细节

## 6.5 VcpContextEngine

```ts
export interface VcpContextEngine {
  assemble(input: AssembleInput): Promise<AssembleResult>;
}
```

关键规则：

1. 仅注入 recall blocks，不篡改正常对话历史
2. 失败时必须降级回原 context 流程
3. 注入量必须受预算控制

## 6.6 VcpPolicyGuard

```ts
export interface VcpPolicyGuard {
  allowTool(toolName: string, agentId: string): boolean;
  allowDiary(diary: string, agentId: string): boolean;
  clampRecallPolicy(input: RecallPolicy): RecallPolicy;
}
```

职责约束：

1. 白名单、黑名单、范围限制统一收口
2. 必须先于实际调用执行

---

## 7. 状态流规格

## 7.1 启动状态流

```text
UNINITIALIZED
  -> HEALTH_CHECKING
  -> CAPABILITIES_LOADING
  -> TOOLS_REGISTERING
  -> READY
```

失败分支：

```text
HEALTH_CHECKING -> DEGRADED
CAPABILITIES_LOADING -> DEGRADED
TOOLS_REGISTERING -> DEGRADED
```

说明：

- `DEGRADED` 表示插件已加载，但 VCP Bridge 不可用
- `DEGRADED` 下禁止自动召回，工具可按配置选择禁用或部分保留缓存 schema

## 7.2 工具调用状态流

```text
IDLE
  -> VALIDATING_ARGS
  -> POLICY_CHECKING
  -> INVOKING_VCP
  -> NORMALIZING_RESULT
  -> DONE
```

错误分支：

- `VALIDATING_ARGS -> ERROR_INVALID_ARGS`
- `POLICY_CHECKING -> ERROR_FORBIDDEN`
- `INVOKING_VCP -> ERROR_TIMEOUT`
- `INVOKING_VCP -> ERROR_EXECUTION`

## 7.3 上下文召回状态流

```text
ASSEMBLE_START
  -> POLICY_CHECKING
  -> BUILD_CONTEXT_REQUEST
  -> RECEIVE_RECALL_BLOCKS
  -> APPLY_TOKEN_BUDGET
  -> INJECT_SYSTEM_PROMPT_ADDITION
  -> ASSEMBLE_DONE
```

降级分支：

- `BUILD_CONTEXT_REQUEST -> DEGRADED_SKIP_RECALL -> ASSEMBLE_DONE`

## 7.4 写回状态流

```text
PENDING
  -> POLICY_CHECKING
  -> DEDUP_CHECK
  -> WRITE_REQUEST
  -> INDEXING_WAIT_OPTIONAL
  -> DONE
```

错误分支：

- `POLICY_CHECKING -> ERROR_FORBIDDEN`
- `WRITE_REQUEST -> RETRYING`
- `RETRYING -> DEAD_LETTER`

---

## 8. 配置规格

## 8.1 OpenClaw 插件配置

```json
{
  "vcp": {
    "baseUrl": "http://127.0.0.1:6005",
    "auth": {
      "type": "basic",
      "username": "admin",
      "passwordRef": "env:VCP_ADMIN_PASSWORD"
    },
    "timeouts": {
      "healthMs": 2000,
      "toolInvokeMs": 30000,
      "ragSearchMs": 12000,
      "ragContextMs": 8000,
      "memoryWriteMs": 12000
    },
    "tools": {
      "allowList": ["ChromeControl", "LightMemo", "DeepMemo"],
      "denyList": ["LinuxShellExecutor"]
    },
    "memory": {
      "diaryMap": {
        "default": ["Nova"],
        "research": ["Nova", "小冰"]
      },
      "defaultK": 5
    },
    "recall": {
      "enabled": true,
      "maxBlocks": 4,
      "maxTokens": 1200,
      "minScore": 0.72
    }
  }
}
```

## 8.2 VCP 侧配置建议

建议增加以下桥接配置项：

- `OPENCLAW_BRIDGE_ENABLED`
- `OPENCLAW_BRIDGE_VERSION`
- `OPENCLAW_BRIDGE_ALLOW_TOOLS`
- `OPENCLAW_BRIDGE_DENY_TOOLS`
- `OPENCLAW_BRIDGE_DEFAULT_TIMEOUT_MS`
- `OPENCLAW_BRIDGE_AUDIT_ENABLED`

---

## 9. 错误码规范

错误码统一前缀：

- `OCW_`

分组：

| 前缀 | 说明 |
|---|---|
| `OCW_AUTH_*` | 认证与鉴权 |
| `OCW_TOOL_*` | 工具调用 |
| `OCW_RAG_*` | RAG 检索 |
| `OCW_CONTEXT_*` | 上下文召回 |
| `OCW_MEMORY_*` | 记忆写回 |
| `OCW_INTERNAL_*` | Bridge 内部错误 |

最小错误码集合：

- `OCW_AUTH_UNAUTHORIZED`
- `OCW_AUTH_FORBIDDEN`
- `OCW_TOOL_NOT_FOUND`
- `OCW_TOOL_INVALID_ARGS`
- `OCW_TOOL_APPROVAL_REQUIRED`
- `OCW_TOOL_TIMEOUT`
- `OCW_TOOL_EXECUTION_ERROR`
- `OCW_RAG_INVALID_QUERY`
- `OCW_RAG_TARGET_FORBIDDEN`
- `OCW_RAG_TARGET_NOT_FOUND`
- `OCW_RAG_SEARCH_ERROR`
- `OCW_CONTEXT_INVALID_INPUT`
- `OCW_CONTEXT_BUILD_ERROR`
- `OCW_MEMORY_INVALID_PAYLOAD`
- `OCW_MEMORY_TARGET_FORBIDDEN`
- `OCW_MEMORY_WRITE_ERROR`
- `OCW_INTERNAL_UNKNOWN`

---

## 10. 测试规格

## 10.1 VCP 侧测试

### 路由测试

必须覆盖：

1. `health`
2. `capabilities`
3. `tools/:toolName`
4. `rag/targets`
5. `rag/search`
6. `rag/context`
7. `memory/write`

### 断言内容

1. HTTP 状态码正确
2. `success/code/meta` 结构正确
3. `requestId` 存在
4. 鉴权失败能正确拒绝

## 10.2 OpenClaw 侧测试

### 单元测试

1. `VcpClient` 错误映射
2. `toolMapper` schema 转换
3. `diaryResolver` agent -> diary 解析
4. `recallBudget` token 裁剪
5. `policyGuard` allow/deny 判定

### 集成测试

1. 启动时发现工具并注册
2. tool 调用成功
3. tool 调用失败分支
4. `memory_search` 检索命中
5. context assemble 成功注入
6. context assemble 失败降级
7. memory write 成功与幂等

## 10.3 端到端测试

建议 6 条主用例：

1. 用户请求浏览器操作 -> OpenClaw 调用 VCP 工具成功
2. 用户提问历史计划 -> OpenClaw 通过 `memory_search` 命中 VCP diary
3. 用户继续追问 -> OpenClaw 自动注入 recall blocks
4. 对无权限 diary 检索 -> 正确拒绝
5. VCP Bridge 不可用 -> OpenClaw 降级继续工作
6. 写入 durable memory -> 下一轮可检索召回

## 10.4 回归测试基线

每次变更必须回归：

1. capabilities 快照
2. 错误码快照
3. 代表性工具的 schema 快照
4. recall block token budget 行为

---

## 11. 开发任务切分建议

## 11.1 VCP 后端任务包

1. Bridge 路由骨架
2. 能力发现接口
3. 工具调用接口
4. RAG 目标与检索接口
5. 上下文召回接口
6. 记忆写回接口
7. 审计与错误码统一器
8. 路由测试

## 11.2 OpenClaw 插件任务包

1. 插件入口与配置加载
2. VcpClient
3. ToolRegistry + schema mapper
4. MemoryAdapter + diary resolver
5. ContextEngine + recall budget
6. PolicyGuard
7. Telemetry 与降级处理
8. 单测与集成测试

## 11.3 联调任务包

1. 契约对齐
2. 认证联通
3. 工具调用联调
4. RAG 检索联调
5. 自动召回联调
6. 写回闭环联调

---

## 12. 实施优先级

按实际开发顺序，建议这样排：

1. `health + capabilities`
2. `tools/:toolName`
3. OpenClaw ToolRegistry
4. `rag/search + rag/targets`
5. OpenClaw MemoryAdapter
6. `rag/context`
7. OpenClaw ContextEngine
8. `memory/write`

这样可以保证每一阶段都可演示、可验证、可回滚。

---

## 13. 交付物清单

本规格对应的最终交付物应包括：

### VCP 侧

1. Bridge 路由代码
2. Bridge 服务代码
3. 契约测试
4. 路由测试

### OpenClaw 侧

1. native plugin 代码
2. 类型定义
3. 单元测试
4. 集成测试

### 联调侧

1. 契约样例数据
2. 端到端测试脚本
3. 灰度发布与回滚记录

---

## 14. 结论

到这一层，方案B已经可以直接进入开发排期。

若要进一步进入“编码前最后一步”，下一份文档建议产出：

1. VCP Bridge OpenAPI 草案
2. OpenClaw 插件 TypeScript 接口文件草案
3. 测试用假数据与 fixtures 目录规划
