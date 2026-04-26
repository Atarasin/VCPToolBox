# Roadmap: VCP Remote MCP WebSocket Bridge

## Overview

This milestone adds a remote WebSocket MCP transport to the existing VCP Node.js platform so external MCP clients (Claude Desktop, Cursor, etc.) can connect over the network, authenticate via VCP's existing user system, and use the RAG/memory tools already exposed locally over stdio. The existing stdio transport is preserved exactly through a new `McpTransport` abstraction.

## Phases

- [x] **Phase 1: Transport Abstraction & Stdio Preservation** - Refactor existing stdio MCP to use a transport interface with zero behavioral changes
- [x] **Phase 2: WebSocket Endpoint & Session Management** - Expose `/mcp` WebSocket endpoint with upgrade-time auth, session isolation, and keepalive
- [x] **Phase 3: MCP Protocol Compliance** - Implement JSON-RPC framing, batch support, initialize handshake, and lifecycle methods
- [ ] **Phase 4: Capability Exposure** - Wire RAG/memory tools and prompts over WebSocket with standard MCP error codes
- [ ] **Phase 5: Production Hardening** - Add connection limits, rate limiting, payload limits, and overload protection

## Phase Details

### Phase 1: Transport Abstraction & Stdio Preservation
**Goal**: Existing stdio MCP consumers experience zero regression; a new `McpTransport` abstraction enables adding WebSocket without touching harness logic.
**Depends on**: Nothing (first phase)
**Requirements**: OP-03
**Success Criteria** (what must be TRUE):
  1. Existing local stdio MCP clients (subprocess consumers) continue to work without any configuration changes
  2. A new `McpTransport` interface abstracts message sending, receiving, and connection lifecycle
  3. The stdio transport implements `McpTransport` with identical behavior to the pre-refactor implementation
  4. All existing stdio MCP integration tests pass without modification
**Plans**: 1 plan

Plans:
- [x] `01-01-PLAN.md` — Create McpTransport interface, extract StdioTransport, refactor mcpStdioServer.js with factory + backwards-compatible wrapper, add transport unit tests

### Phase 2: WebSocket Endpoint & Session Management
**Goal**: External MCP clients can establish authenticated WebSocket connections to VCP with proper session isolation and keepalive.
**Depends on**: Phase 1
**Requirements**: TRANS-01, TRANS-02, TRANS-03, TRANS-09, TRANS-10, OP-02, OP-06
**Success Criteria** (what must be TRUE):
  1. External clients can open a WebSocket connection to `/mcp` and authenticate using existing VCP credentials during the HTTP Upgrade handshake
  2. Unauthenticated upgrade requests are immediately rejected with `socket.destroy()` before the WebSocket handshake completes
  3. Each authenticated connection receives a unique `sessionId` injected into `requestContext` before every harness call
  4. Native WebSocket ping/pong frames keep connections alive without colliding with existing VCP heartbeat protocols
  5. The `/mcp` endpoint uses a dedicated client Map and is strictly separated from the existing node-to-node WebSocket mesh
  6. Connection cleanup runs on `ws.close` and `ws.error` (removes from tracking Map, clears timers)
**Plans**: 2 plans

Plans:
- [x] `02-01-PLAN.md` — Build callback-based `WebSocketTransport`, dedicated `/mcp` upgrade manager, per-connection session injection, keepalive lifecycle, and focused unit coverage
- [x] `02-02-PLAN.md` — Wire the dedicated MCP WebSocket manager into `server.js`, add endpoint integration tests, and expose a repeatable websocket transport test command

### Phase 3: MCP Protocol Compliance
**Goal**: Remote clients can complete the MCP initialization handshake and exchange JSON-RPC messages correctly over WebSocket.
**Depends on**: Phase 2
**Requirements**: TRANS-04, TRANS-05, TRANS-06, TRANS-07, TRANS-08
**Success Criteria** (what must be TRUE):
  1. JSON-RPC 2.0 messages are framed as WebSocket text frames with one message per frame
  2. Batch JSON-RPC requests are supported with a configurable maximum batch size
  3. The MCP `initialize` handshake returns correct protocol version, capabilities, and server info
  4. `notifications/initialized` is handled idempotently (no response sent for notifications)
  5. The `ping` method returns a healthy response
**Plans**: 2 plans

Plans:
- [x] `03-01-PLAN.md` — Upgrade the dedicated `/mcp` websocket manager to support bounded JSON-RPC batch arrays and verify WebSocket frame/batch semantics with endpoint tests
- [x] `03-02-PLAN.md` — Verify the real MCP lifecycle (`initialize`, `notifications/initialized`, `ping`) over WebSocket and make initialize metadata transport-correct

### Phase 4: Capability Exposure
**Goal**: Remote clients can discover and invoke VCP's RAG/memory tools and prompts over the WebSocket transport.
**Depends on**: Phase 3
**Requirements**: CAP-01, CAP-02, CAP-03, CAP-04, CAP-05
**Success Criteria** (what must be TRUE):
  1. Remote clients can call `tools/list` and discover available RAG/memory tools
  2. Remote clients can invoke RAG/memory tools via `tools/call` (memory search, context assembly, memory write)
  3. Remote clients can call `prompts/list` and discover available prompts
  4. Remote clients can fetch prompt content via `prompts/get`
  5. Tool, prompt, and resource errors are mapped to standard MCP error codes (not raw stack traces)
**Plans**: 2 plans

Plans:
- [ ] `04-01-PLAN.md` — Verify real `/mcp` capability discovery plus representative remote prompt and gateway-managed memory invocation over the backend-proxy websocket harness
- [ ] `04-02-PLAN.md` — Harden and verify MCP-standard error mapping for remote prompt, tool, and resource failures over WebSocket

### Phase 5: Production Hardening
**Goal**: The WebSocket MCP endpoint is safe to run in production with resource limits and overload protection.
**Depends on**: Phase 4
**Requirements**: OP-01, OP-04, OP-05
**Success Criteria** (what must be TRUE):
  1. A configurable maximum concurrent connection limit (`VCP_MCP_WS_MAX_CONNECTIONS`) is enforced at upgrade time
  2. Per-connection message rate limiting prevents backend overload
  3. Maximum JSON-RPC payload size is enforced; oversized messages are rejected cleanly
  4. Connection cleanup on disconnect prevents memory leaks and connection counter drift
  5. Upgrade authentication cannot hang indefinitely; timeout protection aborts stalled `/mcp` handshakes cleanly
**Plans**: 1 deferred follow-up

Plans:
- [ ] `05-XX-HARDENING.md` — Add upgrade auth timeout guard for `/mcp` handshake stalls (deferred from Phase 2 WR-02)

## Progress

**Execution Order:**
Phases execute in numeric order: 1 -> 2 -> 3 -> 4 -> 5

| Phase | Plans Complete | Status | Completed |
|-------|----------------|--------|-----------|
| 1. Transport Abstraction & Stdio Preservation | 1/1 | Complete | 2026-04-25 |
| 2. WebSocket Endpoint & Session Management | 2/2 | Complete | 2026-04-26 |
| 3. MCP Protocol Compliance | 2/2 | Complete | 2026-04-26 |
| 4. Capability Exposure | 0/2 | Planned | - |
| 5. Production Hardening | 0/1+ | Not started | - |
