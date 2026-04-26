# Roadmap: VCP Remote MCP Transport Bridge

## Overview

This milestone first added a remote WebSocket MCP transport to the existing VCP Node.js platform so external MCP clients can connect over the network, authenticate via VCP's existing user system, and use the RAG/memory tools already exposed locally over stdio. The next increment extends that work with Trae-compatible HTTP transports (`Streamable HTTP` plus deprecated `SSE` compatibility) while preserving the existing stdio and WebSocket surfaces.

## Phases

- [x] **Phase 1: Transport Abstraction & Stdio Preservation** - Refactor existing stdio MCP to use a transport interface with zero behavioral changes
- [x] **Phase 2: WebSocket Endpoint & Session Management** - Expose `/mcp` WebSocket endpoint with upgrade-time auth, session isolation, and keepalive
- [x] **Phase 3: MCP Protocol Compliance** - Implement JSON-RPC framing, batch support, initialize handshake, and lifecycle methods
- [x] **Phase 4: Capability Exposure** - Wire RAG/memory tools and prompts over WebSocket with standard MCP error codes
- [x] **Phase 5: Production Hardening** - Add connection limits, rate limiting, payload limits, and overload protection
- [ ] **Phase 6: HTTP Compatibility Layer** - Add Streamable HTTP and SSE-compatible MCP transports for Trae and other HTTP-first clients

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
- [x] `04-01-PLAN.md` — Verify real `/mcp` capability discovery plus representative remote prompt and gateway-managed memory invocation over the backend-proxy websocket harness
- [x] `04-02-PLAN.md` — Harden and verify MCP-standard error mapping for remote prompt, tool, and resource failures over WebSocket

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
**Plans**: 2 plans

Plans:
- [x] `05-01-PLAN.md` — Wire production `/mcp` transport guardrails: max connections, payload ceilings, cleanup drift coverage, and upgrade-auth timeout protection
- [x] `05-02-PLAN.md` — Add per-connection websocket message rate limiting with retry-aware overload protection and peer-isolation tests

### Phase 6: HTTP Compatibility Layer
**Goal**: HTTP-capable MCP clients can consume the same Agent Gateway prompt and memory surface remotely through standards-aligned Streamable HTTP and backward-compatible SSE endpoints.
**Depends on**: Phase 5
**Requirements**: HTTP-01, HTTP-02, HTTP-03, HTTP-04, HTTP-05, HTTP-06, HTTP-07, HTTP-08, HTTP-09, HTTP-10, HTTP-11, HTTP-12, HTTP-13, HTTP-14
**Success Criteria** (what must be TRUE):
  1. Express serves a canonical Streamable HTTP MCP endpoint on `/mcp` for `POST`/`GET` without regressing the existing `/mcp` WebSocket upgrade path
  2. HTTP `initialize` can create a server-owned MCP session and follow-up requests validate `MCP-Session-Id` instead of silently accepting anonymous cross-request state
  3. Dedicated Agent Gateway auth is enforced for HTTP MCP requests using the same gateway-key / bearer-token rules as the WebSocket transport
  4. Streamable HTTP requests reuse the existing backend-proxy MCP harness and preserve prompt/tool/result semantics already validated over stdio and WebSocket
  5. A deprecated SSE compatibility surface exists at a separate URL and can complete the initialization flow expected by HTTP+SSE clients without duplicating Gateway Core business logic
  6. Representative parity tests pass for `initialize`, `notifications/initialized`, `tools/list`, `prompts/get`, and a gateway-managed memory call over the new HTTP transports
  7. Existing stdio and WebSocket MCP transports remain behaviorally unchanged
  8. HTTP transport mirrors WebSocket hardening with explicit limits for active sessions, payload size, rate limiting, auth timeout, and idle-session expiry
  9. Streamable HTTP supports required `GET /mcp`, `DELETE /mcp`, and route-local payload limits without inheriting the global 300 MB JSON body limit
  10. WebSocket, Streamable HTTP, and SSE compatibility are proven to coexist on one live `http.Server`
**Plans**: 2 plans

Plans:
- [ ] `06-01-PLAN.md` — Add the canonical Streamable HTTP `/mcp` transport with session management, GET/DELETE lifecycle, HTTP hardening parity, and transport-parity integration tests
- [ ] `06-02-PLAN.md` — Add the deprecated SSE compatibility endpoint on fixed URLs plus coexistence tests and consumer-facing configuration/docs updates

## Progress

**Execution Order:**
Phases execute in numeric order: 1 -> 2 -> 3 -> 4 -> 5 -> 6

| Phase | Plans Complete | Status | Completed |
|-------|----------------|--------|-----------|
| 1. Transport Abstraction & Stdio Preservation | 1/1 | Complete | 2026-04-25 |
| 2. WebSocket Endpoint & Session Management | 2/2 | Complete | 2026-04-26 |
| 3. MCP Protocol Compliance | 2/2 | Complete | 2026-04-26 |
| 4. Capability Exposure | 2/2 | Complete | 2026-04-26 |
| 5. Production Hardening | 2/2 | Complete | 2026-04-26 |
| 6. HTTP Compatibility Layer | 0/2 | Planned | |
