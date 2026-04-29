---
id: M001
title: "VCP Remote MCP Bridge"
status: complete
completed_at: 2026-04-29T14:18:37.141Z
key_decisions:
  - WebSocket as remote transport — adopted via dedicated `/mcp` endpoint instead of reusing the internal node-to-node mesh
  - No MCP SDK dependency — custom transport adapter reuses existing harness logic in `mcpBackendProxyAdapter.js`
  - Auth at upgrade time using `resolveDedicatedGatewayAuth` — rejects unauthenticated clients with `socket.destroy()` before WS handshake completes
  - Native `ws` ping/pong frames for keepalive — avoids collision with ChromeObserver's existing heartbeat JSON protocol
  - Singleton harness + per-connection `requestContext` injection — session isolation without expensive harness recreation per connection
  - Backend-proxy MCP env is explicit runtime config — `VCP_MCP_BACKEND_URL`, `VCP_MCP_BACKEND_KEY`, `VCP_MCP_BACKEND_GATEWAY_ID`, and `VCP_MCP_DEFAULT_AGENT_ID` are required runtime config
  - Keep Trae on stdio for now — Trae does not natively support WebSocket MCP; archive WebSocket as infrastructure and add Streamable HTTP for Trae-native remote access
  - Streamable HTTP with server-owned `MCP-Session-Id` — canonical HTTP MCP surface with session lifecycle, SSE streaming, and `DELETE` cleanup
key_files:
  - modules/agentGateway/transport/mcpTransport.js
  - modules/agentGateway/transport/stdioTransport.js
  - modules/agentGateway/transport/webSocketTransport.js
  - modules/agentGateway/transport/index.js
  - modules/agentGateway/mcpStdioServer.js
  - modules/agentGateway/mcpWebSocketServer.js
  - modules/agentGateway/mcpHttpServer.js
  - modules/agentGateway/index.js
  - server.js
  - config.env.example
  - test/agent-gateway/transport/stdio-transport.test.js
  - test/agent-gateway/adapters/agent-gateway-mcp-websocket.test.js
  - test/agent-gateway/adapters/agent-gateway-mcp-http.test.js
  - mydoc/export/agent-gateway-consumer-guide.md
lessons_learned:
  - Transport abstraction pays off immediately — the same `McpTransport` interface enabled stdio, WebSocket, and HTTP implementations with zero harness changes
  - Upgrade-time auth is the right seam for WebSocket security — rejecting unauthenticated clients before the WS handshake completes avoids resource waste and simplifies threat modeling
  - Batch support should stay WebSocket-only — stdio remains a simple byte-stream transport; message-oriented WebSocket is the natural surface for bounded batch arrays
  - Per-connection rate limiting must be independent — one abusive client must not throttle healthy peers; independent limiter state per connection is essential
  - Route-local payload limits are critical for MCP HTTP — the global `express.json()` limit (300 MB) cannot silently widen the MCP attack surface; explicit route-local ceilings fail fast
  - Three-transport coexistence requires careful http.Server ownership — mounting HTTP routes and WebSocket upgrades on the same server without cross-interference requires explicit path ordering and separate client Maps
  - Real backend-proxy harness tests catch surface drift that mock tests miss — mixing mock and real harness fixtures makes exceptions visible and localized
---

# M001: VCP Remote MCP Bridge

**Extended VCP's Agent Gateway with remote WebSocket and Streamable HTTP MCP transports, enabling external MCP clients to authenticate via VCP's existing user system and use RAG/memory tools remotely without breaking the local stdio surface.**

## What Happened

M001 delivered a complete remote MCP bridge for the VCP Agent Gateway across six sequential slices.

**S01 — Transport Abstraction & Stdio Preservation:** Extracted stdio I/O logic from `mcpStdioServer.js` into a reusable `McpTransport` interface with a `StdioTransport` implementation. Created `createStdioMcpServer` factory and preserved `startStdioMcpServer` as a thin backwards-compatible wrapper. All 7 existing stdio MCP integration tests passed unmodified, proving zero regression.

**S02 — WebSocket Endpoint & Session Management:** Built `WebSocketTransport` implementing the `McpTransport` contract, added a dedicated `/mcp` upgrade manager in `mcpWebSocketServer.js` with upgrade-time auth via `resolveDedicatedGatewayAuth`, per-connection `sessionId` injection into `requestContext`, and native `ws` ping/pong keepalive. Strictly separated the external MCP endpoint from the existing node-to-node WebSocket mesh using a dedicated `mcpClients` Map.

**S03 — MCP Protocol Compliance:** Upgraded the WebSocket manager to protocol-correct JSON-RPC framing with bounded batch support (configurable max batch size). Verified the real MCP lifecycle (`initialize`, `notifications/initialized`, `ping`) over WebSocket using the existing backend-proxy harness. Made `initialize` metadata transport-neutral instead of stdio-biased.

**S04 — Capability Exposure:** Wired RAG/memory tools and prompts over the WebSocket transport with real backend-proxy harness coverage for `tools/list`, `tools/call`, `prompts/list`, `prompts/get`, and batch capability discovery. Hardened MCP-standard error mapping so remote clients see stable `MCP_*` codes for contract violations instead of raw backend exceptions. Added representative success-path assertions for `gateway_memory_search`, `gateway_context_assemble`, and `gateway_memory_write`.

**S05 — Production Hardening:** Added transport guardrails to `/mcp`: configurable max concurrent connections (`VCP_MCP_WS_MAX_CONNECTIONS`), per-connection message rate limiting with `AGW_RATE_LIMITED` overflow responses and `retryAfterMs` metadata, maximum JSON-RPC payload enforcement (`VCP_MCP_WS_MAX_PAYLOAD_BYTES`), and bounded upgrade-auth timeout (`VCP_MCP_WS_UPGRADE_AUTH_TIMEOUT_MS`). Cleanup on `ws.close` and `ws.error` prevents connection-count drift and memory leaks.

**S06 — HTTP Compatibility Layer:** Implemented canonical Streamable HTTP MCP transport at `/mcp` (`mcpHttpServer.js`) with server-owned `MCP-Session-Id` lifecycle, `POST`/`GET`/`DELETE` methods, SSE streaming with heartbeat frames, dedicated auth reuse, idle expiry, request abort propagation, and route-local payload limits. Added deprecated SSE compatibility surface at `/mcp/sse` + `/mcp/sse/messages`. Proved three-transport coexistence (stdio, WebSocket, HTTP) on one live `http.Server` without cross-interference. Updated Trae-facing consumer documentation to steer users toward Streamable HTTP.

No blockers were discovered during execution. All slices completed without plan-invalidating deviations.

## Success Criteria Results

### Phase 1 — Transport Abstraction & Stdio Preservation
1. ✅ Existing local stdio MCP clients continue to work without any configuration changes — verified by unmodified integration suite (7/7 pass)
2. ✅ A new `McpTransport` interface abstracts message sending, receiving, and connection lifecycle — `modules/agentGateway/transport/mcpTransport.js`
3. ✅ The stdio transport implements `McpTransport` with identical behavior — `modules/agentGateway/transport/stdioTransport.js`
4. ✅ All existing stdio MCP integration tests pass without modification — `npm run test:agent-gateway-mcp-transport`

### Phase 2 — WebSocket Endpoint & Session Management
1. ✅ External clients can open a WebSocket connection to `/mcp` and authenticate during the HTTP Upgrade handshake — endpoint tests verify
2. ✅ Unauthenticated upgrade requests are rejected with `socket.destroy()` — endpoint tests verify
3. ✅ Each authenticated connection receives a unique `sessionId` injected into `requestContext` — verified in harness calls
4. ✅ Native WebSocket ping/pong frames keep connections alive — no collision with ChromeObserver heartbeat
5. ✅ The `/mcp` endpoint uses a dedicated client Map strictly separated from the node-to-node mesh — `mcpClients` Map
6. ✅ Connection cleanup runs on `ws.close` and `ws.error` — removes from Map, clears timers

### Phase 3 — MCP Protocol Compliance
1. ✅ JSON-RPC 2.0 messages framed as WebSocket text frames, one per frame — verified
2. ✅ Batch JSON-RPC requests supported with configurable maximum batch size — verified with bounded batch tests
3. ✅ MCP `initialize` handshake returns correct protocol version, capabilities, and server info — verified over real harness
4. ✅ `notifications/initialized` handled idempotently (no response) — verified
5. ✅ `ping` method returns healthy response — verified

### Phase 4 — Capability Exposure
1. ✅ Remote clients can call `tools/list` and discover RAG/memory tools — real harness test
2. ✅ Remote clients can invoke RAG/memory tools via `tools/call` — real harness test for search, context, write
3. ✅ Remote clients can call `prompts/list` and discover prompts — real harness test
4. ✅ Remote clients can fetch prompt content via `prompts/get` — real harness test with host hints
5. ✅ Tool, prompt, and resource errors mapped to standard MCP error codes — error contract tests verify no raw stack trace leakage

### Phase 5 — Production Hardening
1. ✅ Configurable max concurrent connection limit enforced at upgrade time — `VCP_MCP_WS_MAX_CONNECTIONS`
2. ✅ Per-connection message rate limiting prevents backend overload — `AGW_RATE_LIMITED` with `retryAfterMs`
3. ✅ Maximum JSON-RPC payload size enforced — `VCP_MCP_WS_MAX_PAYLOAD_BYTES`
4. ✅ Connection cleanup on disconnect prevents memory leaks and counter drift — cleanup-safe teardown ordering
5. ✅ Upgrade auth timeout protection aborts stalled `/mcp` handshakes — `VCP_MCP_WS_UPGRADE_AUTH_TIMEOUT_MS`

### Phase 6 — HTTP Compatibility Layer
1. ✅ Express serves canonical Streamable HTTP MCP endpoint on `/mcp` for POST/GET without regressing WebSocket — coexistence tests pass
2. ✅ HTTP `initialize` creates server-owned MCP session; follow-up requests validate `MCP-Session-Id` — session lifecycle tests pass
3. ✅ Dedicated Agent Gateway auth enforced for HTTP using same gateway-key / bearer-token rules as WebSocket — auth reuse tests pass
4. ✅ Streamable HTTP requests reuse existing backend-proxy harness preserving prompt/tool/result semantics — real harness capability calls pass
5. ✅ Deprecated SSE compatibility surface exists at separate URL (`/mcp/sse`) — SSE endpoint tests pass
6. ✅ Representative parity tests pass for `initialize`, `notifications/initialized`, `tools/list`, `prompts/get`, and gateway-managed memory calls — HTTP test suite covers all
7. ✅ Existing stdio and WebSocket MCP transports remain behaviorally unchanged — regression suites pass
8. ✅ HTTP transport mirrors WebSocket hardening (active sessions, payload, rate limit, auth timeout, idle expiry) — hardening parity tests pass
9. ✅ Streamable HTTP supports `GET /mcp`, `DELETE /mcp`, and route-local payload limits — lifecycle tests pass
10. ✅ WebSocket, Streamable HTTP, and SSE compatibility coexist on one live `http.Server` — three-transport coexistence test passes

## Definition of Done Results

- All 6 slices completed and validated
- All 11 tasks completed with verification evidence
- Existing stdio MCP integration tests pass without modification (7/7)
- WebSocket transport integration and regression tests pass
- HTTP transport integration tests pass
- Three-transport coexistence proven on one live http.Server
- Production guardrails (connection limits, payload limits, rate limiting, auth timeout) implemented and tested
- Trae-facing consumer documentation updated
- No secrets committed, no breaking changes to existing APIs
- Code review and self-check passed for all slices

## Requirement Outcomes

### Validated Requirements
- **TRANS-01 through TRANS-10** — WebSocket transport, auth, session isolation, JSON-RPC framing, batch support, MCP lifecycle — validated in S02, S03
- **CAP-01 through CAP-05** — Tool/prompt discovery and invocation, MCP-standard error mapping — validated in S04
- **OP-02, OP-03, OP-06** — Connection cleanup, stdio zero-regression, strict endpoint separation — validated in S01, S02, S05
- **OP-01, OP-04, OP-05** — Max connections, rate limiting, payload limits — implemented and tested in S05 (noted as `active` in REQUIREMENTS.md due to stale status; should be transitioned to `validated`)
- **HTTP-01 through HTTP-14** — Streamable HTTP lifecycle, SSE compatibility, auth reuse, hardening parity, three-transport coexistence — validated in S06 (noted as `active` in REQUIREMENTS.md due to stale status; should be transitioned to `validated`)

### Out of Scope (preserved)
- MCP client functionality (VCP calling out to remote MCP servers)
- Replacing the existing node-to-node WebSocket mesh protocol
- Changes to the RAG/memory data model or indexing strategy
- AdminPanel UI changes for MCP connection management

## Deviations

None.

## Follow-ups

- Transition OP-01, OP-04, OP-05, and HTTP-01 through HTTP-14 from `active` to `validated` in REQUIREMENTS.md to reflect actual completion status
- Future milestone may add server-initiated push (`notifications/tools/list_changed`) when the capability service emits events
- Future milestone may add AdminPanel UI for MCP connection management
- Monitor MCP SDK v2 stable release for potential future adoption if it provides compelling multi-transport or OAuth features
