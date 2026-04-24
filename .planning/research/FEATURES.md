# Feature Landscape: VCP Remote MCP WebSocket Bridge

**Domain:** Remote MCP server transport over WebSocket for VCP Agent Gateway
**Researched:** 2026-04-24
**Confidence:** HIGH (based on direct codebase inspection, OpenSpec requirements, and MCP SDK documentation)

---

## 1. Table Stakes

Features users (MCP client hosts like Claude Desktop, Cursor, Trae) expect from any remote MCP server. Missing these makes the product feel broken or unusable.

| Feature | Why Expected | Complexity | Notes |
|---------|--------------|------------|-------|
| **WebSocket endpoint at a fixed URL** | MCP clients need a stable address to connect (e.g., `wss://host/mcp`). | Low | Reuse existing Express `httpServer` with `noServer: true` pattern already used in `WebSocketServer.js`. |
| **JSON-RPC 2.0 message framing over WebSocket text frames** | MCP protocol is JSON-RPC 2.0. Each message is one JSON object per line (stdio) or one JSON object per WebSocket text frame. | Low | Existing `mcpStdioServer.js` already parses JSON-RPC; WebSocket transport sends/receives identical payloads over `ws.send()`/`ws.on('message')`. |
| **MCP lifecycle: `initialize` handshake** | MCP spec requires capability negotiation on first connection. Server must respond with `protocolVersion`, `capabilities`, `serverInfo`. | Low | Already implemented in `buildMcpInitializeResult()` inside `mcpBackendProxyAdapter.js`. |
| **`notifications/initialized` acknowledgment** | Client signals handshake completion. Server must accept and not error. | Low | Already handled in harness (`case 'notifications/initialized': result = null;`). |
| **`ping` / keepalive** | Clients and servers must verify connection health. MCP defines `ping` method. | Low | Harness already supports `ping`. WebSocket layer adds native `ws.ping()`/`ws.pong()` for TCP-level keepalive. |
| **Tool discovery via `tools/list`** | Clients must discover what tools the server exposes before calling them. | Low | `adapter.listTools()` exists; returns `gateway_memory_search`, `gateway_context_assemble`, `gateway_memory_write`, `gateway_agent_bootstrap`, `gateway_job_get`, `gateway_job_cancel`. |
| **Prompt discovery via `prompts/list`** | Prompt-aware clients (Trae) discover injectable prompts. | Low | `adapter.listPrompts()` exists; returns `gateway_agent_render`. |
| **Resource discovery via `resources/list`** | Clients discover readable resources (memory targets, job events). | Low | `adapter.listResources()` exists; returns `vcp://agent-gateway/memory-targets/{agentId}`. |
| **Tool invocation via `tools/call`** | Core purpose: remote clients invoke RAG/memory tools. | Medium | `adapter.callTool()` delegates to `GatewayBackendClient` which calls native backend HTTP routes. |
| **Prompt fetch via `prompts/get`** | Trae fetches `gateway_agent_render` for agent injection. | Medium | `adapter.getPrompt()` delegates to `backendClient.renderAgent()`. |
| **Resource read via `resources/read`** | Clients read memory targets or job events. | Medium | `adapter.readResource()` delegates to `backendClient.getMemoryTargets()` or `backendClient.listJobEvents()`. |
| **Connection authentication at upgrade time** | Security baseline: reject unauthorized clients before WebSocket handshake completes. | Medium | Must reuse VCP's existing `resolveDedicatedGatewayAuth` or `x-agent-gateway-key` / `Authorization: Bearer` header checks during `httpServer.on('upgrade')`. |
| **Error responses with MCP error codes** | Clients expect structured errors (`MCP_INVALID_REQUEST`, `MCP_FORBIDDEN`, etc.), not raw stack traces. | Low | `mapGatewayFailureToMcpErrorCode()` and `createFailureResult()` already exist. |
| **Graceful connection close** | Clients should receive orderly shutdown, not abrupt TCP resets. | Low | Handle `ws.close()` with appropriate WebSocket close codes; clean up connection Map entries. |
| **Concurrent connection support** | Multiple external MCP clients may connect simultaneously. | Medium | Requires per-connection state isolation (see Pitfalls: Session Bleed). |
| **Preserve existing stdio transport unchanged** | Existing local consumers (Trae stdio) must continue working. | Low | New WebSocket transport is additive; stdio server remains untouched. |

---

## 2. Differentiators

Features that set VCP's remote MCP bridge apart from a generic MCP server or a simple stdio wrapper.

| Feature | Value Proposition | Complexity | Notes |
|---------|-------------------|------------|-------|
| **Reuse of existing VCP auth system** | No separate credential store; single identity layer for HTTP, WebSocket mesh, and MCP. | Medium | Use `GatewayBackendClient` with `gatewayKey`, `gatewayId`, `bearerToken` already defined. |
| **Backend-only proxy pattern** | Remote clients get identical behavior to local stdio because both delegate to the same running VCP backend. | Medium | No local runtime initialization; transport is thin. Already proven in `mcpStdioServer.js`. |
| **Deferred job execution with event resources** | Long-running operations (render, memory search) return job handles + `vcp://agent-gateway/jobs/{jobId}/events` resource for polling. | Medium | `createDeferredResultEnvelope()` and `readResource()` for `JOB_EVENTS` already implemented. |
| **Agent-scoped diary policy enforcement** | Memory search/context assembly automatically constrained by `mcp_agent_memory_policy.json` per agent. | Medium | `applyAgentDiaryPolicyToBody()` enforces allowlists before backend calls. |
| **Prompt-first agent injection for Trae** | `prompts/get(name = gateway_agent_render)` returns inject-ready prompt content; tool path is fallback only. | Medium | Aligns with M17 Trae prompt injection spec; metadata includes `hostHints.injectionMode`. |
| **Canonical operability metadata** | All results include `traceId`, `operationName`, `retryAfterMs` when applicable. | Low | `buildOperabilityMetadata()` already additive to success and failure results. |
| **Idempotent memory writes** | `gateway_memory_write` supports `idempotencyKey` for safe retries. | Low | Backend already supports; MCP adapter passes it through. |
| **Multi-tenant isolation via request context** | Each connection injects unique `sessionId` and `requestContext` so jobs/memory never bleed across clients. | Medium | Requires WebSocket transport to wrap harness calls with per-connection context. |
| **Graceful degradation under load** | Connection limits, rate limiting, and payload size protections prevent backend overload. | Medium | Can leverage existing Gateway Core operability policy (M14) and add WebSocket-specific connection caps. |
| **Structured logging with request correlation** | Every request carries `requestId` traceable across transport, adapter, backend, and response. | Low | Existing `normalizeNativeResult()` extracts `meta.requestId`. |

---

## 3. Anti-Features

Features to explicitly NOT build, based on project scope, existing architecture, and MCP spec boundaries.

| Anti-Feature | Why Avoid | What to Do Instead |
|--------------|-----------|-------------------|
| **Generic MCP proxy to arbitrary external servers** | This project exposes VCP *as* an MCP server, not VCP calling *out* to other MCP servers. | Keep MCP client functionality (calling remote servers) out of scope per `PROJECT.md`. |
| **Replacing the existing node-to-node WebSocket mesh protocol** | The internal distributed layer (`/vcp-distributed-server`) uses a custom protocol for VCP node communication. | Add a *separate* `/mcp` endpoint for external MCP clients; leave mesh untouched. |
| **Changes to RAG/memory data model or indexing** | Only the transport layer changes; business logic stays in Gateway Core. | Delegate all tool/resource/prompt operations to existing backend routes via `GatewayBackendClient`. |
| **OAuth 2.1 or complex auth flows for WebSocket** | MCP spec defines OAuth for HTTP transports; WebSocket is custom. VCP already has API keys and bearer tokens. | Reuse existing `x-agent-gateway-key` / `Authorization: Bearer` at upgrade handshake. |
| **Session persistence across server restarts** | MCP is stateless per connection; persistent sessions add complexity without clear value. | Treat each WebSocket connection as an independent session; reconnections re-authenticate and re-initialize. |
| **Breaking changes to existing stdio MCP consumers** | Trae and other local hosts rely on the current stdio transport. | Add WebSocket transport as a new file/module; do not modify `mcpStdioServer.js` behavior. |
| **MCP `sampling` or `roots` client capabilities** | These require the *server* to call the *client*, which is complex and not needed for RAG/memory exposure. | Do not advertise `sampling` or `roots` in server capabilities. |
| **Real-time bidirectional streaming (SSE over WebSocket)** | MCP utilities like progress use notifications, but full streaming is not required for the diary RAG loop. | Use deferred jobs + event resources for long-running operations. |
| **UI for MCP connection management in AdminPanel** | Out of scope per `PROJECT.md`; can be added later. | Document configuration in `PROJECT.md` and transport setup files only. |
| **Batch JSON-RPC requests** | The existing stdio transport explicitly rejects batch requests. | Maintain parity: reject batches in WebSocket transport too, or handle them if explicitly required later. |

---

## 4. How Remote MCP Clients Discover and Use Capabilities

### 4.1 Discovery Flow

```
1. Client opens WebSocket to wss://host/mcp
2. Server validates auth at upgrade handshake (header/cookie based)
3. Client sends: { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", ... } }
4. Server responds with capabilities: { tools: {}, resources: {}, prompts: {} }
5. Client sends: { jsonrpc: "2.0", method: "notifications/initialized" }
6. Client discovers:
   - tools/list   -> gateway_memory_search, gateway_context_assemble, gateway_memory_write, gateway_agent_bootstrap, gateway_job_get, gateway_job_cancel
   - prompts/list -> gateway_agent_render
   - resources/list -> vcp://agent-gateway/memory-targets/{agentId}
```

### 4.2 Tool Invocation Patterns

| Tool | Input | Output | Deferred? |
|------|-------|--------|-----------|
| `gateway_memory_search` | `{ query, diary?, diaries?, maid?, mode?, k? }` | Memory results array | No |
| `gateway_context_assemble` | `{ query?, recentMessages?, diary?, diaries?, maxBlocks?, tokenBudget? }` | Assembled context blocks | No |
| `gateway_memory_write` | `{ target, memory, tags?, diary?, idempotencyKey? }` | Write confirmation | No |
| `gateway_agent_bootstrap` | `{ agentId, variables?, model?, maxLength? }` | Rendered prompt text | Yes (if backend defers) |
| `gateway_job_get` | `{ jobId }` | Job status record | No |
| `gateway_job_cancel` | `{ jobId }` | Cancelled job record | No |

### 4.3 Prompt Injection Pattern (Trae)

```
Client sends: prompts/get(name = "gateway_agent_render", arguments = { agentId: "nexus" })
Server responds:
  messages: [{ role: "system", content: [{ type: "text", text: "...rendered prompt..." }] }]
  meta: {
    hostHints: {
      injectionMode: "prompt_message_content",
      primarySurface: "prompts/get",
      useMessageContentAsPromptBody: true
    }
  }
```

### 4.4 Resource Read Patterns

| Resource URI | Purpose | Backend Route |
|--------------|---------|---------------|
| `vcp://agent-gateway/memory-targets/{agentId}` | Policy-filtered diary targets | `GET /agent_gateway/memory/targets` |
| `vcp://agent-gateway/jobs/{jobId}/events` | Job lifecycle events | `GET /agent_gateway/events/stream` + `GET /agent_gateway/jobs/{jobId}` |

---

## 5. Feature Dependencies

```
WebSocket Transport Foundation
  |-- Auth at Upgrade Handshake
  |     |-- Reuse resolveDedicatedGatewayAuth (from protocolGovernance)
  |     |-- Validate x-agent-gateway-key or Authorization: Bearer
  |
  |-- Connection Lifecycle Management
  |     |-- Generate unique connectionId + sessionId per ws
  |     |-- Maintain mcpClients Map separate from distributedServers/clients
  |     |-- Handle close/error/timeout cleanup
  |
  |-- JSON-RPC Framing over WebSocket
  |     |-- Parse incoming text frames as JSON-RPC requests
  |     |-- Send responses as text frames
  |     |-- Reuse createJsonRpcErrorResponse from mcpStdioServer.js
  |
  |-- Per-Connection Request Context Injection
  |     |-- Wrap harness.handleRequest to inject sessionId, requestId, runtime: "mcp-ws"
  |     |-- Prevent session bleed across concurrent connections
  |
  |-- Harness Reuse
        |-- Reuse createBackendProxyMcpServerHarness (existing)
        |-- Reuse adapter.listTools, adapter.callTool, etc.
        |-- No new business logic in transport layer

MCP Capability Exposure (already implemented in backend proxy adapter)
  |-- tools/list, tools/call
  |-- prompts/list, prompts/get
  |-- resources/list, resources/read
  |-- initialize, ping

Security & Operability
  |-- Connection rate limiting (per IP / per gateway key)
  |-- Payload size limits (max JSON-RPC message size)
  |-- Connection pool limits (max concurrent MCP WebSocket clients)
  |-- Structured error mapping (AGW_* -> MCP_* codes)
  |-- Request tracing (requestId, traceId correlation)
```

### Dependency Rules

- **Transport layer MUST NOT implement business logic.** It only handles WebSocket I/O, auth, connection state, and JSON-RPC framing. All tool/prompt/resource semantics stay in `mcpBackendProxyAdapter.js`.
- **Auth MUST happen before `handleUpgrade`.** The transport cannot depend on the MCP `initialize` message for authentication.
- **Per-connection context MUST be injected before `harness.handleRequest`.** The harness is shared; the transport must ensure each call carries the connection's unique identity.
- **Deferred job results require both `gateway_job_get` tool AND `resources/read` for job events.** Both are already implemented; the WebSocket transport just exposes them.

---

## 6. MVP Recommendation

### Prioritize (Phase 1)

1. **WebSocket endpoint with auth at upgrade** — Without this, nothing else works securely.
2. **JSON-RPC framing and lifecycle** — `initialize`, `notifications/initialized`, `ping`.
3. **Tool discovery and invocation** — `tools/list`, `tools/call` for memory search, context assembly, memory write.
4. **Prompt discovery and fetch** — `prompts/list`, `prompts/get` for Trae injection.
5. **Resource discovery and read** — `resources/list`, `resources/read` for memory targets.
6. **Concurrent connection isolation** — Per-connection sessionId to prevent bleed.

### Defer (Later Phases)

- **Rate limiting and payload protections** — Important but can be added after basic transport works.
- **Graceful degradation / load shedding** — Requires operational metrics not yet collected.
- **AdminPanel UI for connection monitoring** — Explicitly out of scope for now.
- **Batch JSON-RPC support** — Existing stdio rejects batches; maintain parity.

---

## Sources

- `/home/zh/projects/VCP/VCPToolBox/openspec/specs/agent-gateway-mcp-server-transport/spec.md` — stdio transport baseline
- `/home/zh/projects/VCP/VCPToolBox/openspec/specs/agent-gateway-mcp-readiness/spec.md` — MCP v1 boundary definition
- `/home/zh/projects/VCP/VCPToolBox/openspec/specs/agent-gateway-mcp-trae-prompt-injection/spec.md` — Trae prompt injection requirements
- `/home/zh/projects/VCP/VCPToolBox/openspec/specs/agent-gateway-mcp-memory-adapter/spec.md` — Memory tool contracts
- `/home/zh/projects/VCP/VCPToolBox/openspec/specs/agent-gateway-mcp-job-event-runtime/spec.md` — Deferred job and event resource contracts
- `/home/zh/projects/VCP/VCPToolBox/openspec/specs/agent-gateway-mcp-operability-alignment/spec.md` — Error and retry metadata
- `/home/zh/projects/VCP/VCPToolBox/openspec/specs/agent-gateway-protocol-governance/spec.md` — Canonical error codes and request context
- `/home/zh/projects/VCP/VCPToolBox/openspec/specs/agent-gateway-auth-policy/spec.md` — Auth context and scope guards
- `/home/zh/projects/VCP/VCPToolBox/modules/agentGateway/mcpStdioServer.js` — Existing stdio transport implementation
- `/home/zh/projects/VCP/VCPToolBox/modules/agentGateway/adapters/mcpBackendProxyAdapter.js` — MCP adapter with harness, tools, prompts, resources
- `/home/zh/projects/VCP/VCPToolBox/modules/agentGateway/adapters/mcpDescriptorRegistry.js` — Tool/prompt/resource descriptors
- `/home/zh/projects/VCP/VCPToolBox/WebSocketServer.js` — Existing WebSocket upgrade routing and auth patterns
