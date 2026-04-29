# Requirements

This file is the explicit capability and coverage contract for the project.

## Validated

### TRANS-01 — VCP exposes a fixed WebSocket endpoint at `/mcp` for external MCP clients
- Status: validated
- Class: core-capability
- Source: inferred
- Primary Slice: S02
- Validation: Dedicated `/mcp` WebSocket upgrade handler implemented in `modules/agentGateway/mcpWebSocketServer.js`. External MCP clients can connect to the fixed endpoint. Verified in S02 integration tests.

### TRANS-02 — Authentication happens during the HTTP Upgrade handshake using VCP's existing user/auth system (`resolveDedicatedGatewayAuth`) before the WebSocket connection is established
- Status: validated
- Class: core-capability
- Source: inferred
- Primary Slice: S02
- Validation: `resolveDedicatedGatewayAuth` called during `httpServer.on('upgrade')` for `/mcp` path. Auth succeeds before `wss.handleUpgrade()`. Verified in S02 endpoint tests.

### TRANS-03 — Unauthenticated upgrade requests are rejected immediately with `socket.destroy()`
- Status: validated
- Class: core-capability
- Source: inferred
- Primary Slice: S02
- Validation: Unauthenticated `/mcp` upgrades rejected via `socket.destroy()` consistent with existing VCP invalid-key pattern. Verified in S02 endpoint tests.

### TRANS-04 — JSON-RPC 2.0 messages are framed as WebSocket text frames (one message per frame)
- Status: validated
- Class: core-capability
- Source: inferred
- Primary Slice: S03
- Validation: Each `ws.on('message')` event parses one complete JSON-RPC object. Frame semantics verified in S03 protocol compliance tests.

### TRANS-05 — Batch JSON-RPC requests are supported over WebSocket with a configurable maximum batch size
- Status: validated
- Class: core-capability
- Source: inferred
- Primary Slice: S03
- Validation: Array payloads detected and processed with `Promise.all`. Configurable max batch size enforced. Valid, empty, oversized, mixed, and invalid-member batch cases covered in S03 tests.

### TRANS-06 — The MCP `initialize` handshake returns correct protocol version, capabilities, and server info
- Status: validated
- Class: core-capability
- Source: inferred
- Primary Slice: S03
- Validation: `buildMcpInitializeResult()` returns `protocolVersion`, `capabilities`, and `serverInfo`. Verified over real backend-proxy harness in S03 lifecycle tests.

### TRANS-07 — `notifications/initialized` is handled idempotently (no response sent for notifications)
- Status: validated
- Class: core-capability
- Source: inferred
- Primary Slice: S03
- Validation: Notification detection skips response generation. Repeated notifications handled safely. Verified in S03 lifecycle tests.

### TRANS-08 — `ping` method returns a healthy response
- Status: validated
- Class: core-capability
- Source: inferred
- Primary Slice: S03
- Validation: `ping` returns `{}` response. Verified in S03 lifecycle tests.

### TRANS-09 — Each WebSocket connection receives a unique `sessionId` injected into `requestContext` before every harness call
- Status: validated
- Class: core-capability
- Source: inferred
- Primary Slice: S02
- Validation: Per-connection `sessionId` (e.g., `ws-${connectionId}`) injected into `params.requestContext` before every `harness.handleRequest` call. Verified in S02 and S04 real harness tests.

### TRANS-10 — Native `ws` ping/pong frames are used for connection keepalive (not application-level JSON heartbeat)
- Status: validated
- Class: core-capability
- Source: inferred
- Primary Slice: S02
- Validation: RFC 6455 native ping/pong frames used. No application-level JSON heartbeat to avoid collision with ChromeObserver. Verified in S02 keepalive tests.

### CAP-01 — Remote clients can discover available tools via `tools/list`
- Status: validated
- Class: core-capability
- Source: inferred
- Primary Slice: S04
- Validation: Real backend-proxy harness coverage for `tools/list` over WebSocket. Remote clients discover gateway-managed memory tools. Verified in S04 capability exposure tests.

### CAP-02 — Remote clients can invoke RAG/memory tools via `tools/call` (memory search, context assembly, memory write)
- Status: validated
- Class: core-capability
- Source: inferred
- Primary Slice: S04
- Validation: Representative success-path assertions for `gateway_memory_search`, `gateway_context_assemble`, and `gateway_memory_write` over WebSocket with real and mock harness fixtures. Verified in S04 capability exposure tests.

### CAP-03 — Remote clients can discover available prompts via `prompts/list`
- Status: validated
- Class: core-capability
- Source: inferred
- Primary Slice: S04
- Validation: Real backend-proxy harness coverage for `prompts/list` over WebSocket. Verified in S04 capability exposure tests.

### CAP-04 — Remote clients can fetch prompt content via `prompts/get`
- Status: validated
- Class: core-capability
- Source: inferred
- Primary Slice: S04
- Validation: Real backend-proxy harness coverage for `prompts/get` including rendered MCP message content and host-hint metadata (`primarySurface`, resolved `agentId`, `requestId`). Verified in S04 capability exposure tests.

### CAP-05 — Tool, prompt, and resource errors are mapped to standard MCP error codes (not raw stack traces)
- Status: validated
- Class: core-capability
- Source: inferred
- Primary Slice: S04
- Validation: `mcpBackendProxyAdapter.js` sanitizes unexpected backend exceptions. Stable `MCP_*` codes for contract violations. Stack traces, hostnames, ports, and raw `ECONNREFUSED` details do not leak through JSON-RPC error payloads. Verified in S04 error contract tests.

### OP-01 — A configurable maximum concurrent connection limit is enforced at upgrade time (`VCP_MCP_WS_MAX_CONNECTIONS`)
- Status: validated
- Class: core-capability
- Source: inferred
- Primary Slice: S05
- Validation: Implemented in `modules/agentGateway/mcpWebSocketServer.js` with `VCP_MCP_WS_MAX_CONNECTIONS` enforced before `wss.handleUpgrade()`. Endpoint tests verify excess clients are rejected before a live MCP session exists. Verified by `npm run test:agent-gateway-mcp-websocket`.

### OP-02 — Connection cleanup runs on `ws.close` and `ws.error` (remove from tracking Map, clear timers)
- Status: validated
- Class: core-capability
- Source: inferred
- Primary Slice: S02
- Validation: Cleanup handlers remove from `mcpClients` Map and clear pending state on both `close` and `error` events. Verified in S02 endpoint tests.

### OP-03 — The existing local stdio MCP transport continues to work with zero behavioral changes
- Status: validated
- Class: core-capability
- Source: inferred
- Primary Slice: S01
- Validation: Existing stdio MCP integration suite (7 tests) passes unmodified after transport abstraction refactor. `startStdioMcpServer` preserved as one-line wrapper. Verified by `npm run test:agent-gateway-mcp-transport`.

### OP-04 — Per-connection message rate limiting prevents backend overload
- Status: validated
- Class: core-capability
- Source: inferred
- Primary Slice: S05
- Validation: Implemented in `modules/agentGateway/mcpWebSocketServer.js` with per-connection independent limiter state. Bursty clients receive `AGW_RATE_LIMITED` JSON-RPC error with `retryAfterMs`, `limit`, and `windowMs`. Peer isolation verified: one abusive client does not throttle healthy peers. Verified by `npm run test:agent-gateway-mcp-websocket`.

### OP-05 — Maximum JSON-RPC payload size is enforced; oversized messages are rejected
- Status: validated
- Class: core-capability
- Source: inferred
- Primary Slice: S05
- Validation: Implemented in `modules/agentGateway/mcpWebSocketServer.js` with `VCP_MCP_WS_MAX_PAYLOAD_BYTES`. Oversized websocket frames rejected promptly without connection-count drift or poisoning healthy traffic. Verified by `npm run test:agent-gateway-mcp-websocket`.

### OP-06 — The new `/mcp` endpoint is strictly separated from the existing node-to-node WebSocket mesh (dedicated client Map, no shared routing)
- Status: validated
- Class: core-capability
- Source: inferred
- Primary Slice: S02
- Validation: Dedicated `mcpClients` Map used for external MCP connections. Existing `clients` Map and internal protocols (`/vcp-distributed-server`, `/VCPlog`, etc.) remain untouched. Verified in S02 endpoint tests.

### HTTP-01 — VCP exposes a canonical Streamable HTTP MCP endpoint at `/mcp` that supports HTTP `POST` requests for JSON-RPC messages without regressing the existing `/mcp` WebSocket upgrade path
- Status: validated
- Class: core-capability
- Source: inferred
- Primary Slice: S06
- Validation: Canonical Streamable HTTP MCP endpoint at `/mcp` supports HTTP `POST` for JSON-RPC messages. Coexistence with existing `/mcp` WebSocket upgrade path proven by three-transport tests. Verified by `node --test test/agent-gateway/adapters/agent-gateway-mcp-http.test.js`.

### HTTP-02 — The Streamable HTTP MCP endpoint supports standards-aligned session establishment on `initialize` and returns a server-owned `MCP-Session-Id` header for follow-up requests
- Status: validated
- Class: core-capability
- Source: inferred
- Primary Slice: S06
- Validation: Server-owned `MCP-Session-Id` header returned on `initialize` response. Follow-up requests must include this header. Session lifecycle tests verify creation and reuse. Verified by `node --test test/agent-gateway/adapters/agent-gateway-mcp-http.test.js`.

### HTTP-03 — Follow-up Streamable HTTP requests validate `MCP-Session-Id` and reject missing or unknown session state unless the request itself is a fresh `initialize`
- Status: validated
- Class: core-capability
- Source: inferred
- Primary Slice: S06
- Validation: Follow-up requests with missing or unknown `MCP-Session-Id` are rejected unless the request is a fresh `initialize`. Session ownership checks verified in HTTP integration tests. Verified by `node --test test/agent-gateway/adapters/agent-gateway-mcp-http.test.js`.

### HTTP-04 — Dedicated Agent Gateway auth for HTTP MCP reuses the same gateway-key / bearer-token rules already enforced by the WebSocket transport
- Status: validated
- Class: core-capability
- Source: inferred
- Primary Slice: S06
- Validation: HTTP MCP auth reuses `resolveDedicatedGatewayAuth` with same `x-agent-gateway-key` and `Authorization: Bearer` rules as WebSocket transport. Auth tests verify identical enforcement. Verified by `node --test test/agent-gateway/adapters/agent-gateway-mcp-http.test.js`.

### HTTP-05 — Streamable HTTP requests reuse the existing backend-proxy MCP harness so `tools/list`, `tools/call`, `prompts/list`, and `prompts/get` preserve the same semantics already validated over stdio and WebSocket
- Status: validated
- Class: core-capability
- Source: inferred
- Primary Slice: S06
- Validation: HTTP requests reuse the existing backend-proxy MCP harness (`mcpBackendProxyAdapter.js`). `tools/list`, `tools/call`, `prompts/list`, and `prompts/get` preserve the same semantics validated over stdio and WebSocket. Real harness capability calls verified. Verified by `node --test test/agent-gateway/adapters/agent-gateway-mcp-http.test.js`.

### HTTP-06 — VCP exposes a deprecated HTTP+SSE compatibility surface at a separate URL for older MCP clients that cannot use Streamable HTTP
- Status: validated
- Class: core-capability
- Source: inferred
- Primary Slice: S06
- Validation: Deprecated SSE compatibility surface exposed at `GET /mcp/sse` and `POST /mcp/sse/messages`. Endpoint publication, heartbeat behavior, and companion POST initialization verified. Verified by `node --test test/agent-gateway/adapters/agent-gateway-mcp-http.test.js`.

### HTTP-07 — Representative remote parity coverage exists for `initialize`, `notifications/initialized`, `tools/list`, `prompts/get`, and at least one gateway-managed memory call over Streamable HTTP and the SSE compatibility surface
- Status: validated
- Class: core-capability
- Source: inferred
- Primary Slice: S06
- Validation: Parity tests cover `initialize`, `notifications/initialized`, `tools/list`, `prompts/get`, and gateway-managed memory calls (`gateway_memory_search`, `gateway_context_assemble`) over both Streamable HTTP and SSE compatibility surface. Verified by `node --test test/agent-gateway/adapters/agent-gateway-mcp-http.test.js`.

### HTTP-08 — Existing stdio and WebSocket MCP transports continue to pass their current regression suites unchanged after the HTTP compatibility layer is added
- Status: validated
- Class: core-capability
- Source: inferred
- Primary Slice: S06
- Validation: Existing stdio and WebSocket regression suites pass unchanged after HTTP layer addition. `node --test test/agent-gateway/adapters/agent-gateway-mcp-websocket.test.js test/agent-gateway/adapters/agent-gateway-mcp-transport.test.js` verified clean.

### HTTP-09 — Canonical Streamable HTTP supports required `GET /mcp` SSE streaming with `MCP-Session-Id` validation, heartbeat frames, and clean disconnect handling
- Status: validated
- Class: core-capability
- Source: inferred
- Primary Slice: S06
- Validation: `GET /mcp` SSE streaming requires valid `MCP-Session-Id`, emits heartbeat comments periodically, mirrors JSON-RPC responses, and handles clean disconnect. Stream behavior verified in HTTP integration tests. Verified by `node --test test/agent-gateway/adapters/agent-gateway-mcp-http.test.js`.

### HTTP-10 — HTTP MCP supports `DELETE /mcp` to release session state and abort in-flight server work bound to that session
- Status: validated
- Class: core-capability
- Source: inferred
- Primary Slice: S06
- Validation: `DELETE /mcp` returns `204 No Content` and immediately tears down server-side session state, aborting in-flight harness work bound to that session. Cleanup behavior verified in HTTP integration tests. Verified by `node --test test/agent-gateway/adapters/agent-gateway-mcp-http.test.js`.

### HTTP-11 — HTTP MCP mirrors WebSocket hardening defaults with explicit limits for active sessions, payload size, per-session request rate, auth timeout, and idle-session expiry
- Status: validated
- Class: core-capability
- Source: inferred
- Primary Slice: S06
- Validation: HTTP mirrors WebSocket hardening: active session limits (`VCP_MCP_HTTP_MAX_SESSIONS`), payload size (`VCP_MCP_HTTP_MAX_PAYLOAD`), per-session request rate (`VCP_MCP_HTTP_RATE_LIMIT`), auth timeout (`VCP_MCP_HTTP_AUTH_TIMEOUT_MS`), and idle-session expiry (`VCP_MCP_HTTP_IDLE_TIMEOUT_MS`). Hardening parity tests verify all limits. Verified by `node --test test/agent-gateway/adapters/agent-gateway-mcp-http.test.js`.

### HTTP-12 — HTTP MCP enforces its payload ceiling with a route-local body parser limit so the global `express.json()` limit cannot silently widen the MCP attack surface
- Status: validated
- Class: core-capability
- Source: inferred
- Primary Slice: S06
- Validation: Route-local body parser limit enforces HTTP MCP payload ceiling independently of the global `express.json()` limit. Oversize payloads return `413 Payload Too Large` before reaching backend logic. Verified by `node --test test/agent-gateway/adapters/agent-gateway-mcp-http.test.js`.

### HTTP-13 — HTTP MCP transport preserves the canonical harness request shape and reuses the existing `AGW_ERROR_CODES` plus JSON-RPC error mapping rules
- Status: validated
- Class: core-capability
- Source: inferred
- Primary Slice: S06
- Validation: HTTP transport preserves the canonical harness request shape and reuses existing `AGW_ERROR_CODES` plus JSON-RPC error mapping rules. Error shaping tests verify consistency with stdio and WebSocket transports. Verified by `node --test test/agent-gateway/adapters/agent-gateway-mcp-http.test.js`.

### HTTP-14 — Streamable HTTP, SSE compatibility, and the existing WebSocket `/mcp` upgrade path can coexist on the same live `http.Server` without cross-interference
- Status: validated
- Class: core-capability
- Source: inferred
- Primary Slice: S06
- Validation: Streamable HTTP (`POST/GET/DELETE /mcp`), SSE compatibility (`/mcp/sse`), and existing WebSocket `/mcp` upgrade path coexist on the same live `http.Server`. Three-transport coexistence test proves no cross-interference. Verified by `node --test test/agent-gateway/adapters/agent-gateway-mcp-http.test.js`.

## Active

_None — all requirements for M001 are validated._

## Deferred

_None._

## Out of Scope

- MCP client functionality (VCP calling *out* to remote MCP servers)
- Replacing the existing node-to-node WebSocket mesh protocol
- Changes to the RAG/memory data model or indexing strategy
- AdminPanel UI changes for MCP connection management

## Traceability

| ID | Class | Status | Primary owner | Supporting | Proof |
|---|---|---|---|---|---|
| TRANS-01 | core-capability | validated | S02 | — | Dedicated `/mcp` WebSocket endpoint implemented and tested |
| TRANS-02 | core-capability | validated | S02 | — | `resolveDedicatedGatewayAuth` at upgrade time verified |
| TRANS-03 | core-capability | validated | S02 | — | `socket.destroy()` on unauthenticated upgrades verified |
| TRANS-04 | core-capability | validated | S03 | — | One JSON-RPC object per WS text frame verified |
| TRANS-05 | core-capability | validated | S03 | — | Bounded batch support verified |
| TRANS-06 | core-capability | validated | S03 | — | Initialize handshake returns correct metadata |
| TRANS-07 | core-capability | validated | S03 | — | Notification idempotency verified |
| TRANS-08 | core-capability | validated | S03 | — | `ping` returns `{}` |
| TRANS-09 | core-capability | validated | S02 | — | Unique `sessionId` per connection verified |
| TRANS-10 | core-capability | validated | S02 | — | Native ws ping/pong keepalive verified |
| CAP-01 | core-capability | validated | S04 | — | `tools/list` over WebSocket with real harness |
| CAP-02 | core-capability | validated | S04 | — | `tools/call` for memory operations over WebSocket |
| CAP-03 | core-capability | validated | S04 | — | `prompts/list` over WebSocket |
| CAP-04 | core-capability | validated | S04 | — | `prompts/get` with rendered content and host hints |
| CAP-05 | core-capability | validated | S04 | — | MCP-standard error codes, no stack trace leakage |
| OP-01 | core-capability | validated | S05 | — | `VCP_MCP_WS_MAX_CONNECTIONS` enforced at upgrade |
| OP-02 | core-capability | validated | S02 | — | Cleanup on `ws.close` and `ws.error` |
| OP-03 | core-capability | validated | S01 | — | Stdio zero-regression: 7/7 integration tests pass |
| OP-04 | core-capability | validated | S05 | — | Per-connection rate limiting with peer isolation |
| OP-05 | core-capability | validated | S05 | — | Payload ceiling enforced without drift |
| OP-06 | core-capability | validated | S02 | — | Dedicated `mcpClients` Map, no mesh collision |
| HTTP-01 | core-capability | validated | S06 | — | Streamable HTTP POST on `/mcp`, no WebSocket regression |
| HTTP-02 | core-capability | validated | S06 | — | Server-owned `MCP-Session-Id` on initialize |
| HTTP-03 | core-capability | validated | S06 | — | Session validation on follow-up requests |
| HTTP-04 | core-capability | validated | S06 | — | Auth reuse with WebSocket rules |
| HTTP-05 | core-capability | validated | S06 | — | Backend-proxy harness semantics preserved |
| HTTP-06 | core-capability | validated | S06 | — | Deprecated SSE surface at `/mcp/sse` |
| HTTP-07 | core-capability | validated | S06 | — | Parity coverage over Streamable HTTP and SSE |
| HTTP-08 | core-capability | validated | S06 | — | Stdio and WebSocket regressions clean |
| HTTP-09 | core-capability | validated | S06 | — | `GET /mcp` SSE streaming with heartbeat |
| HTTP-10 | core-capability | validated | S06 | — | `DELETE /mcp` session cleanup |
| HTTP-11 | core-capability | validated | S06 | — | HTTP hardening mirrors WebSocket |
| HTTP-12 | core-capability | validated | S06 | — | Route-local payload limit |
| HTTP-13 | core-capability | validated | S06 | — | Canonical harness shape and error mapping |
| HTTP-14 | core-capability | validated | S06 | — | Three-transport coexistence on one `http.Server` |

## Coverage Summary

- Active requirements: 0
- Mapped to slices: 35
- Validated: 35 (TRANS-01..10, CAP-01..05, OP-01..06, HTTP-01..14)
- Unmapped active requirements: 0
