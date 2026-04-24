# Requirements: VCP Remote MCP WebSocket Bridge

**Project:** VCP Remote MCP Bridge
**Version:** v1.0
**Last updated:** 2026-04-24

---

## v1 Requirements

### Transport Foundation (TRANS)

- [ ] **TRANS-01**: VCP exposes a fixed WebSocket endpoint at `/mcp` for external MCP clients
- [ ] **TRANS-02**: Authentication happens during the HTTP Upgrade handshake using VCP's existing user/auth system (`resolveDedicatedGatewayAuth`) before the WebSocket connection is established
- [ ] **TRANS-03**: Unauthenticated upgrade requests are rejected immediately with `socket.destroy()`
- [ ] **TRANS-04**: JSON-RPC 2.0 messages are framed as WebSocket text frames (one message per frame)
- [ ] **TRANS-05**: Batch JSON-RPC requests are supported over WebSocket with a configurable maximum batch size
- [ ] **TRANS-06**: The MCP `initialize` handshake returns correct protocol version, capabilities, and server info
- [ ] **TRANS-07**: `notifications/initialized` is handled idempotently (no response sent for notifications)
- [ ] **TRANS-08**: `ping` method returns a healthy response
- [ ] **TRANS-09**: Each WebSocket connection receives a unique `sessionId` injected into `requestContext` before every harness call
- [ ] **TRANS-10**: Native `ws` ping/pong frames are used for connection keepalive (not application-level JSON heartbeat)

### Capability Exposure (CAP)

- [ ] **CAP-01**: Remote clients can discover available tools via `tools/list`
- [ ] **CAP-02**: Remote clients can invoke RAG/memory tools via `tools/call` (memory search, context assembly, memory write)
- [ ] **CAP-03**: Remote clients can discover available prompts via `prompts/list`
- [ ] **CAP-04**: Remote clients can fetch prompt content via `prompts/get`
- [ ] **CAP-05**: Tool, prompt, and resource errors are mapped to standard MCP error codes (not raw stack traces)

### Operability & Compatibility (OP)

- [ ] **OP-01**: A configurable maximum concurrent connection limit is enforced at upgrade time (`VCP_MCP_WS_MAX_CONNECTIONS`)
- [ ] **OP-02**: Connection cleanup runs on `ws.close` and `ws.error` (remove from tracking Map, clear timers)
- [ ] **OP-03**: The existing local stdio MCP transport continues to work with zero behavioral changes
- [ ] **OP-04**: Per-connection message rate limiting prevents backend overload
- [ ] **OP-05**: Maximum JSON-RPC payload size is enforced; oversized messages are rejected
- [ ] **OP-06**: The new `/mcp` endpoint is strictly separated from the existing node-to-node WebSocket mesh (dedicated client Map, no shared routing)

## v2 Requirements (Deferred)

- **Resource discovery and read** (`resources/list`, `resources/read`) — deferred to v2; not critical for core RAG read/write use case
- **Server-initiated push** (`notifications/tools/list_changed`) — requires capability service to emit events
- **AdminPanel UI for connection monitoring** — out of scope for initial transport work
- **Binary frame support** — MCP is text-only JSON-RPC; no current need

## Out of Scope

| Exclusion | Reasoning |
|-----------|-----------|
| MCP client functionality (VCP calling out to remote MCP servers) | This project exposes VCP *as* an MCP server, not the reverse |
| Replacing the existing node-to-node WebSocket mesh protocol | Internal distributed layer stays as-is; add a separate `/mcp` endpoint |
| Changes to RAG/memory data model or indexing | Only transport changes; business logic stays in Gateway Core |
| OAuth 2.1 or complex auth flows for WebSocket | VCP already has API keys and bearer tokens; reuse existing system |
| Session persistence across server restarts | MCP is stateless per connection; reconnections re-authenticate |
| Real-time bidirectional streaming (SSE over WebSocket) | Deferred jobs + event resources handle long-running operations |

## Traceability

| Requirement | Phase | Status |
|-------------|-------|--------|
| TRANS-01 | Phase 2 | Pending |
| TRANS-02 | Phase 2 | Pending |
| TRANS-03 | Phase 2 | Pending |
| TRANS-04 | Phase 3 | Pending |
| TRANS-05 | Phase 3 | Pending |
| TRANS-06 | Phase 3 | Pending |
| TRANS-07 | Phase 3 | Pending |
| TRANS-08 | Phase 3 | Pending |
| TRANS-09 | Phase 2 | Pending |
| TRANS-10 | Phase 2 | Pending |
| CAP-01 | Phase 4 | Pending |
| CAP-02 | Phase 4 | Pending |
| CAP-03 | Phase 4 | Pending |
| CAP-04 | Phase 4 | Pending |
| CAP-05 | Phase 4 | Pending |
| OP-01 | Phase 5 | Pending |
| OP-02 | Phase 2 | Pending |
| OP-03 | Phase 1 | Pending |
| OP-04 | Phase 5 | Pending |
| OP-05 | Phase 5 | Pending |
| OP-06 | Phase 2 | Pending |

*Traceability filled by roadmap.*
