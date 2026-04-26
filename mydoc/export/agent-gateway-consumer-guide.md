# Agent Gateway Consumer Guide

## 1. Published Contract

- OpenAPI YAML: `mydoc/export/agent-gateway.openapi.yaml`
- OpenAPI JSON: `mydoc/export/agent-gateway.openapi.json`
- Minimal Node client: `examples/agent-gateway-node-client.js`

当前 Native Gateway 以 `/agent_gateway/*` 作为正式 published contract，对外稳定开放以下资源：

- `GET /agent_gateway/capabilities`
- `GET /agent_gateway/agents`
- `GET /agent_gateway/agents/:agentId`
- `POST /agent_gateway/agents/:agentId/render`
- `GET /agent_gateway/memory/targets`
- `POST /agent_gateway/memory/search`
- `POST /agent_gateway/memory/write`
- `POST /agent_gateway/context/assemble`
- `POST /agent_gateway/tools/:toolName/invoke`
- `GET /agent_gateway/jobs/:jobId`
- `POST /agent_gateway/jobs/:jobId/cancel`
- `GET /agent_gateway/events/stream`

## 2. Auth

推荐使用专用 Gateway 凭证：

- Header `x-agent-gateway-key`
- Header `x-agent-gateway-id`

兼容输入：

- `Authorization: Bearer <gateway-key>`
- 过渡期 `Basic Auth`
- 过渡期 `admin_auth` Cookie

## 3. Compatibility

- 当前 published contract 版本：`v1`
- 当前发布阶段：`ga`
- 稳定边界包括：资源路径、governed envelope、`AGW_*` 错误码、job state names、event type names
- 后续新增字段或新增资源通常视为 additive change
- 删除稳定字段、重命名资源路径、或改变稳定状态语义视为 breaking change

## 4. MCP Transports

- 推荐 Trae 与其他 MCP Host 优先使用 `POST /mcp` + `GET /mcp` + `DELETE /mcp` 组成的 Streamable HTTP transport。
- `POST /mcp` 的首次 `initialize` 会返回服务端生成的 `MCP-Session-Id` header；后续 `GET /mcp`、`POST /mcp`、`DELETE /mcp` 都必须带回该 header。
- `GET /mcp` 会保持 `text/event-stream` 长连接，并在空闲期发送 heartbeat comment；同一会话内的 JSON-RPC 响应会镜像成 `event: message` 帧。
- 兼容旧客户端时可使用 `GET /mcp/sse` 与 `POST /mcp/sse/messages`。这是 deprecated 兼容层，建议仅在 Host 不支持 canonical Streamable HTTP 时启用。
- MCP transport 复用 `x-agent-gateway-key` / `x-agent-gateway-id` 或 `Authorization: Bearer <token>` 专用鉴权，不复用普通用户态会话。
- 默认资源保护开关由 `VCP_MCP_HTTP_MAX_SESSIONS`、`VCP_MCP_HTTP_MAX_PAYLOAD_BYTES`、`VCP_MCP_HTTP_AUTH_TIMEOUT_MS`、`VCP_MCP_HTTP_RATE_LIMIT_MESSAGES`、`VCP_MCP_HTTP_RATE_LIMIT_WINDOW_MS`、`VCP_MCP_HTTP_SESSION_IDLE_MS` 控制。

### 4.1 Trae Streamable HTTP

```bash
curl -X POST "http://localhost:3000/mcp" \
  -H "content-type: application/json" \
  -H "x-agent-gateway-key: gw-secret" \
  -H "x-agent-gateway-id: gw-prod" \
  -d '{
    "jsonrpc": "2.0",
    "id": 1,
    "method": "initialize",
    "params": {
      "protocolVersion": "2025-06-18",
      "capabilities": {},
      "clientInfo": {
        "name": "trae",
        "version": "1.0.0"
      }
    }
  }'
```

返回 header 中的 `MCP-Session-Id` 需要保留给后续请求：

```bash
curl -N "http://localhost:3000/mcp" \
  -H "Accept: text/event-stream" \
  -H "x-agent-gateway-key: gw-secret" \
  -H "x-agent-gateway-id: gw-prod" \
  -H "MCP-Session-Id: mcphttp_xxx"
```

### 4.2 Deprecated SSE Compatibility

```bash
curl -N "http://localhost:3000/mcp/sse" \
  -H "Accept: text/event-stream" \
  -H "x-agent-gateway-key: gw-secret" \
  -H "x-agent-gateway-id: gw-prod"
```

首个 `event: endpoint` 会返回兼容消息入口 `/mcp/sse/messages`，随后继续使用同一个 `MCP-Session-Id`：

```bash
curl -X POST "http://localhost:3000/mcp/sse/messages" \
  -H "content-type: application/json" \
  -H "x-agent-gateway-key: gw-secret" \
  -H "x-agent-gateway-id: gw-prod" \
  -H "MCP-Session-Id: mcphttp_xxx" \
  -d '{
    "jsonrpc": "2.0",
    "id": 2,
    "method": "tools/list"
  }'
```

## 5. Representative Examples

### 5.1 Capabilities

```bash
curl -X GET "http://localhost:3000/agent_gateway/capabilities?agentId=Ariadne" \
  -H "x-agent-gateway-key: gw-secret" \
  -H "x-agent-gateway-id: gw-prod"
```

### 5.2 Memory Search

```bash
curl -X POST "http://localhost:3000/agent_gateway/memory/search" \
  -H "content-type: application/json" \
  -H "x-agent-gateway-key: gw-secret" \
  -d '{
    "query": "上周项目会议讨论了什么",
    "requestContext": {
      "requestId": "req-search-001",
      "agentId": "Ariadne",
      "runtime": "native"
    }
  }'
```

### 5.3 Agent Render

`POST /agent_gateway/agents/:agentId/render` 返回的是最终 rendered prompt，而不是原始 `Agent/*.txt` 模板文件。若底层模板在渲染时展开了日记本或 `TagMemo` 语法，最终 prompt 可能已经包含记忆召回后的内容。调用方应优先消费 `data.renderedPrompt`，并结合 `data.renderMeta` 判断是否发生了记忆注入、截断或其他稳定的 render 状态。

```bash
curl -X POST "http://localhost:3000/agent_gateway/agents/Ariadne/render" \
  -H "content-type: application/json" \
  -H "x-agent-gateway-key: gw-secret" \
  -d '{
    "requestContext": {
      "requestId": "req-render-001",
      "agentId": "Ariadne",
      "sessionId": "sess-render-001",
      "runtime": "native"
    },
    "variables": {
      "VarUserName": "Nova"
    }
  }'
```

### 5.4 Tool Invoke

```bash
curl -X POST "http://localhost:3000/agent_gateway/tools/SciCalculator/invoke" \
  -H "content-type: application/json" \
  -H "x-agent-gateway-key: gw-secret" \
  -d '{
    "args": {
      "expression": "1+1"
    },
    "requestContext": {
      "requestId": "req-tool-001",
      "agentId": "Ariadne",
      "runtime": "native"
    }
  }'
```

### 5.5 Job Poll

```bash
curl -X GET "http://localhost:3000/agent_gateway/jobs/job_001?agentId=Ariadne&sessionId=sess-001" \
  -H "x-agent-gateway-key: gw-secret"
```

### 5.6 Event Stream

```bash
curl -N "http://localhost:3000/agent_gateway/events/stream?agentId=Ariadne&sessionId=sess-001" \
  -H "Accept: text/event-stream" \
  -H "x-agent-gateway-key: gw-secret"
```

首帧会先输出 `gateway.meta`，随后按需输出 `job.waiting_approval`、`job.running`、`job.completed` 等 canonical event。

## 6. Migration Notes

- 旧版 beta OpenAPI 仅覆盖 9 个接口，且未包含 `jobs/events`
- M9 以后应优先以本目录下的正式 YAML/JSON 作为机读 contract
- 外部客户端不应再依赖源码或 archive 文档推断 `agent_gateway` 的真实资源面
