# Phase 2: WebSocket Endpoint & Session Management - Context

**Gathered:** 2026-04-26
**Status:** Ready for planning

<domain>
## Phase Boundary

Expose an authenticated `/mcp` WebSocket endpoint for external MCP clients, with per-connection session isolation, dedicated connection tracking, and native keepalive behavior.

In scope: HTTP Upgrade authentication, handshake-time rejection for unauthorized clients, dedicated MCP connection manager and tracking Map, server-generated `sessionId` injection into `requestContext`, connection lifecycle cleanup, and native `ws` ping/pong keepalive.
Out of scope: JSON-RPC batch/framing semantics and initialize lifecycle details (Phase 3), MCP capability exposure (Phase 4), and rate/connection hardening controls (Phase 5).

</domain>

<decisions>
## Implementation Decisions

### Upgrade Authentication Contract
- **D-01:** `/mcp` upgrade authentication reuses `resolveDedicatedGatewayAuth`, accepting both the dedicated gateway header (`x-agent-gateway-key`) and `Authorization: Bearer ...` during the HTTP Upgrade handshake.
- **D-02:** Unauthenticated or invalid `/mcp` upgrade attempts are rejected before the WebSocket handshake completes by destroying the socket immediately; no fallback to the legacy mesh auth path.
- **D-03:** `x-agent-gateway-id` continues to be accepted as an optional gateway identity hint and is propagated into the authenticated connection context when present.

### Session Isolation Model
- **D-04:** Each authenticated WebSocket connection receives a server-generated canonical `sessionId` at connect time; the client cannot override the canonical session identity used by MCP request handling.
- **D-05:** The canonical per-connection context injected before harness calls includes at least `sessionId`, `requestId`, `runtime`, `source`, and any authenticated `gatewayId`; request-level code may add `agentId` later when required by a specific MCP operation.
- **D-06:** MCP transport code must inject the connection-scoped `sessionId` into every harness call so downstream gateway-managed tooling preserves job visibility and audit continuity.

### Endpoint Isolation Boundary
- **D-07:** `/mcp` is implemented as a dedicated manager under `modules/agentGateway/` rather than as another branch inside the legacy `WebSocketServer.js` protocol handler.
- **D-08:** The dedicated MCP WebSocket manager reuses the existing HTTP server `upgrade` hook pattern, but owns its own client Map, lifecycle hooks, and cleanup logic, strictly separated from the existing node-to-node mesh Maps and routing.
- **D-09:** `server.js` remains the integration point that wires the shared HTTP server to the dedicated MCP WebSocket manager during startup and shutdown.

### Claude's Discretion
- Keepalive interval, pong timeout, and close-code choices, as long as they use native `ws` ping/pong and do not introduce JSON heartbeat collisions.
- Internal file layout for the dedicated MCP WebSocket manager (`single file` vs `manager + helpers`), as long as it stays under `modules/agentGateway/`.
- Whether to record a client-supplied external session correlation field for diagnostics, provided it does not replace the server-generated canonical `sessionId`.

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Project requirements and roadmap
- `.planning/ROADMAP.md` — Phase 2 goal, dependency on Phase 1, and success criteria for auth, session isolation, keepalive, and dedicated Map cleanup.
- `.planning/REQUIREMENTS.md` — TRANS-01, TRANS-02, TRANS-03, TRANS-09, TRANS-10, OP-02, and OP-06 define the transport boundary for this phase.

### Existing MCP transport and request-context contracts
- `modules/agentGateway/mcpStdioServer.js` — Current harness/transport boundary. Shows the "transport is a dumb pipe, harness owns protocol semantics" pattern to preserve for WebSocket.
- `modules/agentGateway/transport/stdioTransport.js` — Current transport contract shape and lifecycle expectations (`send`, `close`, `finished`, callback-based message handling).
- `modules/agentGateway/contracts/requestContext.js` — Canonical request-context normalization helpers and ID generation primitives.
- `modules/agentGateway/contracts/protocolGovernance.js` — `resolveDedicatedGatewayAuth`, gateway headers, and native request-context conventions to reuse at upgrade time.

### Backend proxy and gateway-managed runtime expectations
- `modules/agentGateway/adapters/mcpBackendProxyAdapter.js` — MCP harness behavior, `ensureSessionId`, and the request-context fields required for gateway-managed tools and job visibility.
- `modules/agentGateway/GatewayBackendClient.js` — Existing header propagation behavior for `x-agent-gateway-key`, `x-agent-gateway-id`, and `Authorization: Bearer ...`.

### Existing WebSocket integration points
- `server.js` — Current HTTP server startup/shutdown and existing WebSocket initialization point.
- `WebSocketServer.js` — Legacy node-to-node/custom WebSocket mesh. Useful as a reference for `noServer` upgrade wiring, Map-based client tracking, and `socket.destroy()` rejection, but `/mcp` must remain isolated from this mesh.

### Specs and tests
- `openspec/specs/agent-gateway-mcp-server-transport/spec.md` — Transport boundary principle: transport code exposes canonical MCP behavior without re-implementing gateway business logic.
- `openspec/specs/agent-gateway-mcp-readiness/spec.md` — MCP integrations must consume canonical gateway models instead of creating a parallel runtime.
- `test/agent-gateway/adapters/agent-gateway-mcp-transport.test.js` — Existing MCP transport test style and host-facing expectations for initialize/ping/discovery behavior.

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- `resolveDedicatedGatewayAuth()` already normalizes both dedicated gateway header auth and bearer-token auth; Phase 2 should reuse this rather than inventing a second WebSocket auth parser.
- `normalizeRequestContext()` and `createRequestId()` already define the canonical shape for request-scoped metadata; WebSocket session injection should build on these helpers.
- `createStdioMcpServer()` demonstrates the desired layering: transport only moves serialized payloads while the harness owns MCP semantics.
- `GatewayBackendClient#createHeaders()` already shows the intended propagation format for gateway key, gateway ID, and bearer token headers.

### Established Patterns
- Shared HTTP server + `ws` `noServer` upgrade flow is already used in the codebase.
- Unauthorized WebSocket upgrade paths are rejected immediately with `socket.destroy()`.
- Connection registries are tracked with dedicated `Map` instances keyed by generated client identifiers.
- Newer Agent Gateway code prefers small contract/helper modules under `modules/agentGateway/` instead of expanding legacy root-level protocol files.

### Integration Points
- `server.js` startup currently initializes the legacy `WebSocketServer`; Phase 2 will add a parallel Agent Gateway MCP WebSocket initialization path here.
- The MCP WebSocket transport must feed parsed client messages into the same harness contract used by stdio, while injecting a connection-scoped `requestContext` before each harness call.
- Cleanup must run on both `ws.close` and `ws.error`, removing the connection from the dedicated MCP client Map and clearing keepalive timers.

</code_context>

<specifics>
## Specific Ideas

- The user wants external MCP clients to connect through a standard `/mcp` endpoint without inventing a second auth vocabulary; accepting both dedicated gateway headers and bearer tokens keeps the contract aligned with existing gateway behavior.
- The user wants `/mcp` architecturally separate from the legacy distributed WebSocket mesh, even if both reuse the same underlying HTTP server.
- The user wants session identity to be authoritative on the server side: connection-scoped, generated once during handshake, and automatically injected into downstream MCP requests.

</specifics>

<deferred>
## Deferred Ideas

- Exact keepalive cadence and timeout thresholds are intentionally left to planning/implementation, provided they use native `ws` ping/pong.
- JSON-RPC message framing, batch handling, `initialize`, and lifecycle notifications remain Phase 3 work.
- Capability publication and MCP error-surface work remain Phase 4.
- Connection limits, rate limiting, and payload ceilings remain Phase 5.

</deferred>

---

*Phase: 02-websocket-endpoint-session-management*
*Context gathered: 2026-04-26*
