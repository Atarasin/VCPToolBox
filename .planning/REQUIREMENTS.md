# Requirements: VCP Remote MCP Transport Bridge

**Project:** VCP Remote MCP Bridge
**Version:** v1.0
**Last updated:** 2026-04-24

---

## v1 Requirements

### Transport Foundation (TRANS)

- [x] **TRANS-01**: VCP exposes a fixed WebSocket endpoint at `/mcp` for external MCP clients
- [x] **TRANS-02**: Authentication happens during the HTTP Upgrade handshake using VCP's existing user/auth system (`resolveDedicatedGatewayAuth`) before the WebSocket connection is established
- [x] **TRANS-03**: Unauthenticated upgrade requests are rejected immediately with `socket.destroy()`
- [x] **TRANS-04**: JSON-RPC 2.0 messages are framed as WebSocket text frames (one message per frame)
- [x] **TRANS-05**: Batch JSON-RPC requests are supported over WebSocket with a configurable maximum batch size
- [x] **TRANS-06**: The MCP `initialize` handshake returns correct protocol version, capabilities, and server info
- [x] **TRANS-07**: `notifications/initialized` is handled idempotently (no response sent for notifications)
- [x] **TRANS-08**: `ping` method returns a healthy response
- [x] **TRANS-09**: Each WebSocket connection receives a unique `sessionId` injected into `requestContext` before every harness call
- [x] **TRANS-10**: Native `ws` ping/pong frames are used for connection keepalive (not application-level JSON heartbeat)

### Capability Exposure (CAP)

- [x] **CAP-01**: Remote clients can discover available tools via `tools/list`
- [x] **CAP-02**: Remote clients can invoke RAG/memory tools via `tools/call` (memory search, context assembly, memory write)
- [x] **CAP-03**: Remote clients can discover available prompts via `prompts/list`
- [x] **CAP-04**: Remote clients can fetch prompt content via `prompts/get`
- [x] **CAP-05**: Tool, prompt, and resource errors are mapped to standard MCP error codes (not raw stack traces)

### Operability & Compatibility (OP)

- [ ] **OP-01**: A configurable maximum concurrent connection limit is enforced at upgrade time (`VCP_MCP_WS_MAX_CONNECTIONS`)
- [x] **OP-02**: Connection cleanup runs on `ws.close` and `ws.error` (remove from tracking Map, clear timers)
- [x] **OP-03**: The existing local stdio MCP transport continues to work with zero behavioral changes
- [ ] **OP-04**: Per-connection message rate limiting prevents backend overload
- [ ] **OP-05**: Maximum JSON-RPC payload size is enforced; oversized messages are rejected
- [x] **OP-06**: The new `/mcp` endpoint is strictly separated from the existing node-to-node WebSocket mesh (dedicated client Map, no shared routing)

### HTTP Compatibility (HTTP)

- [ ] **HTTP-01**: VCP exposes a canonical Streamable HTTP MCP endpoint at `/mcp` that supports HTTP `POST` requests for JSON-RPC messages without regressing the existing `/mcp` WebSocket upgrade path
- [ ] **HTTP-02**: The Streamable HTTP MCP endpoint supports standards-aligned session establishment on `initialize` and returns a server-owned `MCP-Session-Id` header for follow-up requests
- [ ] **HTTP-03**: Follow-up Streamable HTTP requests validate `MCP-Session-Id` and reject missing or unknown session state unless the request itself is a fresh `initialize`
- [ ] **HTTP-04**: Dedicated Agent Gateway auth for HTTP MCP reuses the same gateway-key / bearer-token rules already enforced by the WebSocket transport
- [ ] **HTTP-05**: Streamable HTTP requests reuse the existing backend-proxy MCP harness so `tools/list`, `tools/call`, `prompts/list`, and `prompts/get` preserve the same semantics already validated over stdio and WebSocket
- [ ] **HTTP-06**: VCP exposes a deprecated HTTP+SSE compatibility surface at a separate URL for older MCP clients that cannot use Streamable HTTP
- [ ] **HTTP-07**: Representative remote parity coverage exists for `initialize`, `notifications/initialized`, `tools/list`, `prompts/get`, and at least one gateway-managed memory call over Streamable HTTP and the SSE compatibility surface
- [ ] **HTTP-08**: Existing stdio and WebSocket MCP transports continue to pass their current regression suites unchanged after the HTTP compatibility layer is added
- [ ] **HTTP-09**: Canonical Streamable HTTP supports required `GET /mcp` SSE streaming with `MCP-Session-Id` validation, heartbeat frames, and clean disconnect handling
- [ ] **HTTP-10**: HTTP MCP supports `DELETE /mcp` to release session state and abort in-flight server work bound to that session
- [ ] **HTTP-11**: HTTP MCP mirrors WebSocket hardening defaults with explicit limits for active sessions, payload size, per-session request rate, auth timeout, and idle-session expiry
- [ ] **HTTP-12**: HTTP MCP enforces its payload ceiling with a route-local body parser limit so the global `express.json()` limit cannot silently widen the MCP attack surface
- [ ] **HTTP-13**: HTTP MCP transport preserves the canonical harness request shape and reuses the existing `AGW_ERROR_CODES` plus JSON-RPC error mapping rules
- [ ] **HTTP-14**: Streamable HTTP, SSE compatibility, and the existing WebSocket `/mcp` upgrade path can coexist on the same live `http.Server` without cross-interference

## v2 Requirements (Deferred)

- **Resource discovery and read** (`resources/list`, `resources/read`) — deferred to v2; not critical for core RAG read/write use case
- **Server-initiated push** (`notifications/tools/list_changed`) — requires capability service to emit events
- **AdminPanel UI for connection monitoring** — out of scope for initial transport work
- **Binary frame support** — MCP is text-only JSON-RPC; no current need
- **Advanced HTTP session resumption and reconnect replay** — defer until the base HTTP transports are in place and a client proves it needs durable event replay

## Out of Scope

| Exclusion | Reasoning |
|-----------|-----------|
| MCP client functionality (VCP calling out to remote MCP servers) | This project exposes VCP *as* an MCP server, not the reverse |
| Replacing the existing node-to-node WebSocket mesh protocol | Internal distributed layer stays as-is; add a separate `/mcp` endpoint |
| Changes to RAG/memory data model or indexing | Only transport changes; business logic stays in Gateway Core |
| OAuth 2.1 or complex auth flows for WebSocket | VCP already has API keys and bearer tokens; reuse existing system |
| Session persistence across server restarts | MCP is stateless per connection; reconnections re-authenticate |
| Real-time bidirectional streaming (SSE over WebSocket) | Deferred jobs + event resources handle long-running operations |
| Replacing the existing `/mcp` WebSocket endpoint with HTTP-only transport | Existing websocket clients remain supported; HTTP is an additive compatibility layer |

## Traceability

| Requirement | Phase | Status |
|-------------|-------|--------|
| TRANS-01 | Phase 2 | Complete |
| TRANS-02 | Phase 2 | Complete |
| TRANS-03 | Phase 2 | Complete |
| TRANS-04 | Phase 3 | Complete |
| TRANS-05 | Phase 3 | Complete |
| TRANS-06 | Phase 3 | Complete |
| TRANS-07 | Phase 3 | Complete |
| TRANS-08 | Phase 3 | Complete |
| TRANS-09 | Phase 2 | Complete |
| TRANS-10 | Phase 2 | Complete |
| CAP-01 | Phase 4 | Complete |
| CAP-02 | Phase 4 | Complete |
| CAP-03 | Phase 4 | Complete |
| CAP-04 | Phase 4 | Complete |
| CAP-05 | Phase 4 | Complete |
| OP-01 | Phase 5 | Pending |
| OP-02 | Phase 2 | Complete |
| OP-03 | Phase 1 | Complete |
| OP-04 | Phase 5 | Pending |
| OP-05 | Phase 5 | Pending |
| OP-06 | Phase 2 | Complete |
| HTTP-01 | Phase 6 | Planned |
| HTTP-02 | Phase 6 | Planned |
| HTTP-03 | Phase 6 | Planned |
| HTTP-04 | Phase 6 | Planned |
| HTTP-05 | Phase 6 | Planned |
| HTTP-06 | Phase 6 | Planned |
| HTTP-07 | Phase 6 | Planned |
| HTTP-08 | Phase 6 | Planned |
| HTTP-09 | Phase 6 | Planned |
| HTTP-10 | Phase 6 | Planned |
| HTTP-11 | Phase 6 | Planned |
| HTTP-12 | Phase 6 | Planned |
| HTTP-13 | Phase 6 | Planned |
| HTTP-14 | Phase 6 | Planned |

*Traceability filled by roadmap.*
