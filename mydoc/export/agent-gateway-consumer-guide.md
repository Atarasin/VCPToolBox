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

## 4. Representative Examples

### 4.1 Capabilities

```bash
curl -X GET "http://localhost:3000/agent_gateway/capabilities?agentId=Ariadne" \
  -H "x-agent-gateway-key: gw-secret" \
  -H "x-agent-gateway-id: gw-prod"
```

### 4.2 Memory Search

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

### 4.3 Tool Invoke

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

### 4.4 Job Poll

```bash
curl -X GET "http://localhost:3000/agent_gateway/jobs/job_001?agentId=Ariadne&sessionId=sess-001" \
  -H "x-agent-gateway-key: gw-secret"
```

### 4.5 Event Stream

```bash
curl -N "http://localhost:3000/agent_gateway/events/stream?agentId=Ariadne&sessionId=sess-001" \
  -H "Accept: text/event-stream" \
  -H "x-agent-gateway-key: gw-secret"
```

首帧会先输出 `gateway.meta`，随后按需输出 `job.waiting_approval`、`job.running`、`job.completed` 等 canonical event。

## 5. Migration Notes

- 旧版 beta OpenAPI 仅覆盖 9 个接口，且未包含 `jobs/events`
- M9 以后应优先以本目录下的正式 YAML/JSON 作为机读 contract
- 外部客户端不应再依赖源码或 archive 文档推断 `agent_gateway` 的真实资源面
