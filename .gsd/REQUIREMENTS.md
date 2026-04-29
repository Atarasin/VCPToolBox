# Requirements

## Active

### OP-01 — A configurable maximum concurrent connection limit is enforced at upgrade time (`VCP_MCP_WS_MAX_CONNECTIONS`)

- Status: active
- Class: core-capability
- Source: inferred
- Primary Slice: none yet

A configurable maximum concurrent connection limit is enforced at upgrade time (`VCP_MCP_WS_MAX_CONNECTIONS`)

### OP-04 — Per-connection message rate limiting prevents backend overload

- Status: active
- Class: core-capability
- Source: inferred
- Primary Slice: none yet

Per-connection message rate limiting prevents backend overload

### OP-05 — Maximum JSON-RPC payload size is enforced; oversized messages are rejected

- Status: active
- Class: core-capability
- Source: inferred
- Primary Slice: none yet

Maximum JSON-RPC payload size is enforced; oversized messages are rejected

### HTTP-01 — VCP exposes a canonical Streamable HTTP MCP endpoint at `/mcp` that supports HTTP `POST` requests for JSON-RPC messages without regressing the existing `/mcp` WebSocket upgrade path

- Status: active
- Class: core-capability
- Source: inferred
- Primary Slice: none yet

VCP exposes a canonical Streamable HTTP MCP endpoint at `/mcp` that supports HTTP `POST` requests for JSON-RPC messages without regressing the existing `/mcp` WebSocket upgrade path

### HTTP-02 — The Streamable HTTP MCP endpoint supports standards-aligned session establishment on `initialize` and returns a server-owned `MCP-Session-Id` header for follow-up requests

- Status: active
- Class: core-capability
- Source: inferred
- Primary Slice: none yet

The Streamable HTTP MCP endpoint supports standards-aligned session establishment on `initialize` and returns a server-owned `MCP-Session-Id` header for follow-up requests

### HTTP-03 — Follow-up Streamable HTTP requests validate `MCP-Session-Id` and reject missing or unknown session state unless the request itself is a fresh `initialize`

- Status: active
- Class: core-capability
- Source: inferred
- Primary Slice: none yet

Follow-up Streamable HTTP requests validate `MCP-Session-Id` and reject missing or unknown session state unless the request itself is a fresh `initialize`

### HTTP-04 — Dedicated Agent Gateway auth for HTTP MCP reuses the same gateway-key / bearer-token rules already enforced by the WebSocket transport

- Status: active
- Class: core-capability
- Source: inferred
- Primary Slice: none yet

Dedicated Agent Gateway auth for HTTP MCP reuses the same gateway-key / bearer-token rules already enforced by the WebSocket transport

### HTTP-05 — Streamable HTTP requests reuse the existing backend-proxy MCP harness so `tools/list`, `tools/call`, `prompts/list`, and `prompts/get` preserve the same semantics already validated over stdio and WebSocket

- Status: active
- Class: core-capability
- Source: inferred
- Primary Slice: none yet

Streamable HTTP requests reuse the existing backend-proxy MCP harness so `tools/list`, `tools/call`, `prompts/list`, and `prompts/get` preserve the same semantics already validated over stdio and WebSocket

### HTTP-06 — VCP exposes a deprecated HTTP+SSE compatibility surface at a separate URL for older MCP clients that cannot use Streamable HTTP

- Status: active
- Class: core-capability
- Source: inferred
- Primary Slice: none yet

VCP exposes a deprecated HTTP+SSE compatibility surface at a separate URL for older MCP clients that cannot use Streamable HTTP

### HTTP-07 — Representative remote parity coverage exists for `initialize`, `notifications/initialized`, `tools/list`, `prompts/get`, and at least one gateway-managed memory call over Streamable HTTP and the SSE compatibility surface

- Status: active
- Class: core-capability
- Source: inferred
- Primary Slice: none yet

Representative remote parity coverage exists for `initialize`, `notifications/initialized`, `tools/list`, `prompts/get`, and at least one gateway-managed memory call over Streamable HTTP and the SSE compatibility surface

### HTTP-08 — Existing stdio and WebSocket MCP transports continue to pass their current regression suites unchanged after the HTTP compatibility layer is added

- Status: active
- Class: core-capability
- Source: inferred
- Primary Slice: none yet

Existing stdio and WebSocket MCP transports continue to pass their current regression suites unchanged after the HTTP compatibility layer is added

### HTTP-09 — Canonical Streamable HTTP supports required `GET /mcp` SSE streaming with `MCP-Session-Id` validation, heartbeat frames, and clean disconnect handling

- Status: active
- Class: core-capability
- Source: inferred
- Primary Slice: none yet

Canonical Streamable HTTP supports required `GET /mcp` SSE streaming with `MCP-Session-Id` validation, heartbeat frames, and clean disconnect handling

### HTTP-10 — HTTP MCP supports `DELETE /mcp` to release session state and abort in-flight server work bound to that session

- Status: active
- Class: core-capability
- Source: inferred
- Primary Slice: none yet

HTTP MCP supports `DELETE /mcp` to release session state and abort in-flight server work bound to that session

### HTTP-11 — HTTP MCP mirrors WebSocket hardening defaults with explicit limits for active sessions, payload size, per-session request rate, auth timeout, and idle-session expiry

- Status: active
- Class: core-capability
- Source: inferred
- Primary Slice: none yet

HTTP MCP mirrors WebSocket hardening defaults with explicit limits for active sessions, payload size, per-session request rate, auth timeout, and idle-session expiry

### HTTP-12 — HTTP MCP enforces its payload ceiling with a route-local body parser limit so the global `express.json()` limit cannot silently widen the MCP attack surface

- Status: active
- Class: core-capability
- Source: inferred
- Primary Slice: none yet

HTTP MCP enforces its payload ceiling with a route-local body parser limit so the global `express.json()` limit cannot silently widen the MCP attack surface

### HTTP-13 — HTTP MCP transport preserves the canonical harness request shape and reuses the existing `AGW_ERROR_CODES` plus JSON-RPC error mapping rules

- Status: active
- Class: core-capability
- Source: inferred
- Primary Slice: none yet

HTTP MCP transport preserves the canonical harness request shape and reuses the existing `AGW_ERROR_CODES` plus JSON-RPC error mapping rules

### HTTP-14 — Streamable HTTP, SSE compatibility, and the existing WebSocket `/mcp` upgrade path can coexist on the same live `http.Server` without cross-interference

- Status: active
- Class: core-capability
- Source: inferred
- Primary Slice: none yet

Streamable HTTP, SSE compatibility, and the existing WebSocket `/mcp` upgrade path can coexist on the same live `http.Server` without cross-interference

## Validated

### TRANS-01 — VCP exposes a fixed WebSocket endpoint at `/mcp` for external MCP clients

- Status: validated
- Class: core-capability
- Source: inferred
- Primary Slice: none yet

VCP exposes a fixed WebSocket endpoint at `/mcp` for external MCP clients

### TRANS-02 — Authentication happens during the HTTP Upgrade handshake using VCP's existing user/auth system (`resolveDedicatedGatewayAuth`) before the WebSocket connection is established

- Status: validated
- Class: core-capability
- Source: inferred
- Primary Slice: none yet

Authentication happens during the HTTP Upgrade handshake using VCP's existing user/auth system (`resolveDedicatedGatewayAuth`) before the WebSocket connection is established

### TRANS-03 — Unauthenticated upgrade requests are rejected immediately with `socket.destroy()`

- Status: validated
- Class: core-capability
- Source: inferred
- Primary Slice: none yet

Unauthenticated upgrade requests are rejected immediately with `socket.destroy()`

### TRANS-04 — JSON-RPC 2.0 messages are framed as WebSocket text frames (one message per frame)

- Status: validated
- Class: core-capability
- Source: inferred
- Primary Slice: none yet

JSON-RPC 2.0 messages are framed as WebSocket text frames (one message per frame)

### TRANS-05 — Batch JSON-RPC requests are supported over WebSocket with a configurable maximum batch size

- Status: validated
- Class: core-capability
- Source: inferred
- Primary Slice: none yet

Batch JSON-RPC requests are supported over WebSocket with a configurable maximum batch size

### TRANS-06 — The MCP `initialize` handshake returns correct protocol version, capabilities, and server info

- Status: validated
- Class: core-capability
- Source: inferred
- Primary Slice: none yet

The MCP `initialize` handshake returns correct protocol version, capabilities, and server info

### TRANS-07 — `notifications/initialized` is handled idempotently (no response sent for notifications)

- Status: validated
- Class: core-capability
- Source: inferred
- Primary Slice: none yet

`notifications/initialized` is handled idempotently (no response sent for notifications)

### TRANS-08 — `ping` method returns a healthy response

- Status: validated
- Class: core-capability
- Source: inferred
- Primary Slice: none yet

`ping` method returns a healthy response

### TRANS-09 — Each WebSocket connection receives a unique `sessionId` injected into `requestContext` before every harness call

- Status: validated
- Class: core-capability
- Source: inferred
- Primary Slice: none yet

Each WebSocket connection receives a unique `sessionId` injected into `requestContext` before every harness call

### TRANS-10 — Native `ws` ping/pong frames are used for connection keepalive (not application-level JSON heartbeat)

- Status: validated
- Class: core-capability
- Source: inferred
- Primary Slice: none yet

Native `ws` ping/pong frames are used for connection keepalive (not application-level JSON heartbeat)

### CAP-01 — Remote clients can discover available tools via `tools/list`

- Status: validated
- Class: core-capability
- Source: inferred
- Primary Slice: none yet

Remote clients can discover available tools via `tools/list`

### CAP-02 — Remote clients can invoke RAG/memory tools via `tools/call` (memory search, context assembly, memory write)

- Status: validated
- Class: core-capability
- Source: inferred
- Primary Slice: none yet

Remote clients can invoke RAG/memory tools via `tools/call` (memory search, context assembly, memory write)

### CAP-03 — Remote clients can discover available prompts via `prompts/list`

- Status: validated
- Class: core-capability
- Source: inferred
- Primary Slice: none yet

Remote clients can discover available prompts via `prompts/list`

### CAP-04 — Remote clients can fetch prompt content via `prompts/get`

- Status: validated
- Class: core-capability
- Source: inferred
- Primary Slice: none yet

Remote clients can fetch prompt content via `prompts/get`

### CAP-05 — Tool, prompt, and resource errors are mapped to standard MCP error codes (not raw stack traces)

- Status: validated
- Class: core-capability
- Source: inferred
- Primary Slice: none yet

Tool, prompt, and resource errors are mapped to standard MCP error codes (not raw stack traces)

### OP-02 — Connection cleanup runs on `ws.close` and `ws.error` (remove from tracking Map, clear timers)

- Status: validated
- Class: core-capability
- Source: inferred
- Primary Slice: none yet

Connection cleanup runs on `ws.close` and `ws.error` (remove from tracking Map, clear timers)

### OP-03 — The existing local stdio MCP transport continues to work with zero behavioral changes

- Status: validated
- Class: core-capability
- Source: inferred
- Primary Slice: none yet

The existing local stdio MCP transport continues to work with zero behavioral changes

### OP-06 — The new `/mcp` endpoint is strictly separated from the existing node-to-node WebSocket mesh (dedicated client Map, no shared routing)

- Status: validated
- Class: core-capability
- Source: inferred
- Primary Slice: none yet

The new `/mcp` endpoint is strictly separated from the existing node-to-node WebSocket mesh (dedicated client Map, no shared routing)

## Deferred

## Out of Scope
