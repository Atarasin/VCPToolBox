# Phase 6: HTTP Compatibility Layer - Context

**Gathered:** 2026-04-26
**Status:** Ready for planning

<domain>
## Phase Boundary

Add Trae-compatible HTTP MCP transports on top of the already-validated Agent Gateway MCP runtime by introducing a canonical Streamable HTTP endpoint and a deprecated SSE compatibility endpoint.

In scope: standards-aligned HTTP MCP session handling, dedicated auth reuse, transport-local session storage, Express route integration, parity with the existing backend-proxy MCP harness, and transport tests for Streamable HTTP plus deprecated HTTP+SSE compatibility.
Out of scope: new Gateway Core business capabilities, replacing the existing WebSocket `/mcp` transport, advanced reconnect replay, AdminPanel transport management UI, and broad event-subscription work beyond what the transport contract needs.

</domain>

<decisions>
## Implementation Decisions

### Transport Ownership
- **D-01:** `createBackendProxyMcpServerHarness()` remains the canonical MCP business surface. Phase 6 adds HTTP transport adapters around it instead of introducing a second capability runtime.
- **D-02:** Streamable HTTP is the primary new transport because Trae supports it natively today. Deprecated HTTP+SSE compatibility is a separate compatibility surface, not the main contract.
- **D-03:** The existing `/mcp` WebSocket endpoint remains in place. HTTP transport must coexist with the `/mcp` upgrade path instead of replacing it.

### Session and Auth Model
- **D-04:** HTTP MCP sessions are server-owned and should be keyed by `MCP-Session-Id`, created on `initialize`, and rejected on later requests if the session is missing or unknown.
- **D-05:** HTTP MCP auth must reuse the same dedicated gateway-key / bearer-token rules already used by `resolveDedicatedGatewayAuth`; do not create a weaker HTTP-only fallback.
- **D-06:** Session state should stay transport-local and lightweight. Keep mutable request/session metadata in the HTTP transport layer, not on the backend-proxy harness object.
- **D-07:** HTTP session state must have an explicit lifecycle: idle expiry, explicit `DELETE /mcp` teardown, and abort propagation for in-flight harness calls.

### Verification Strategy
- **D-08:** Prefer transport-parity tests that exercise the real Express route stack and the real backend-proxy harness over unit-only route tests.
- **D-09:** Reuse the strongest assertions from stdio and WebSocket coverage: `initialize`, `notifications/initialized`, `tools/list`, `prompts/get`, and representative gateway-managed memory operations.
- **D-10:** Keep SSE compatibility and Streamable HTTP on separate URLs to avoid avoidable route ambiguity and simplify client guidance.
- **D-11:** HTTP MCP must inherit Phase 5-equivalent hardening instead of silently depending on weaker global Express defaults.
- **D-12:** Prove WebSocket, Streamable HTTP, and SSE compatibility coexist on one live `http.Server` before Phase 6 can close.

### Claude's Discretion
- Choose the thinnest HTTP transport abstraction that still keeps session bookkeeping, SSE framing, and request validation out of `routes/agentGatewayRoutes.js`.
- Reuse existing SSE helper patterns from the Agent Gateway native event stream where it reduces transport boilerplate.

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Project requirements and roadmap
- `.planning/ROADMAP.md` — Phase 6 goal, dependency on Phase 5, and success criteria for HTTP compatibility.
- `.planning/REQUIREMENTS.md` — `HTTP-01` through `HTTP-14` define the full HTTP compatibility and hardening contract.
- `.planning/PROJECT.md` — Current project framing and the archived note that Trae needs HTTP transport instead of WebSocket.
- `.planning/STATE.md` — Confirms Phase 5 is complete and the next logical expansion is HTTP compatibility.

### Existing implementation to reuse
- `modules/agentGateway/mcpStdioServer.js` — Existing runtime bootstrap and shared backend-proxy harness initialization.
- `modules/agentGateway/mcpWebSocketServer.js` — Reference transport implementation for request/session injection, dedicated auth reuse, and transport-local lifecycle boundaries.
- `modules/agentGateway/adapters/mcpBackendProxyAdapter.js` — Canonical MCP capability surface and error/result shaping.
- `modules/agentGateway/GatewayBackendClient.js` — Existing HTTP and SSE backend client helper patterns already used by the backend-proxy path.
- `routes/agentGatewayRoutes.js` — Existing Express integration point and reusable SSE response patterns.
- `modules/agentGateway/contracts/protocolGovernance.js` — Dedicated auth semantics that HTTP MCP must reuse.

### Existing tests and fixtures
- `test/agent-gateway/adapters/agent-gateway-mcp-transport.test.js` — Stdio parity coverage for lifecycle and capability semantics.
- `test/agent-gateway/adapters/agent-gateway-mcp-websocket.test.js` — Remote transport parity baseline and real backend-proxy coverage to mirror.
- `test/agent-gateway/routes/agent-gateway-routes.test.js` — Existing Express route testing patterns, including SSE route coverage.
- `test/agent-gateway/examples/agent-gateway-node-client.test.js` — Existing HTTP/SSE request-shaping examples that can guide client-facing config tests.

### External protocol references
- MCP transport spec (2025-11-25): Streamable HTTP uses HTTP `POST` and `GET`, may assign `MCP-Session-Id`, and may optionally stream SSE responses.
- MCP backwards-compatibility guidance: servers may host deprecated HTTP+SSE endpoints alongside Streamable HTTP endpoints, preferably on separate URLs.

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- `initializeBackendProxyMcpRuntime()` already centralizes runtime bootstrap for stdio and WebSocket, so HTTP transport should reuse it rather than inventing a new runtime path.
- `GatewayBackendClient.requestEventStream()` and `routes/agentGatewayRoutes.js` already show codebase-standard SSE framing and parsing expectations.
- `mcpWebSocketServer.js` already demonstrates the accepted boundary: transport code injects canonical request/session/auth context, then delegates to the shared harness.
- `server.js` currently applies a global `express.json({ limit: '300mb' })`, so HTTP MCP needs a route-local parser limit to preserve payload parity with the 4 MB websocket ceiling.

### Established Patterns
- The codebase prefers thin transport adapters over duplicating Gateway Core semantics.
- Agent Gateway routes already use dedicated auth headers and structured operation errors; HTTP MCP should align with those conventions.
- Existing websocket tests already prove which MCP methods matter most for parity. Phase 6 can mirror that verification set.

### Integration Points
- `server.js` already mounts `/agent_gateway` routes and delegates `/mcp` upgrades to the websocket stack. Phase 6 needs an additional HTTP request path for `/mcp` without breaking the upgrade handler.
- A new HTTP MCP transport module should likely live under `modules/agentGateway/` next to `mcpStdioServer.js` and `mcpWebSocketServer.js`.
- SSE compatibility should use the fixed URL pair `GET /mcp/sse` and `POST /mcp/sse/messages` so clients, tests, and docs share one contract while keeping the canonical MCP family under the same root.

</code_context>

<specifics>
## Specific Ideas

- Start with a dedicated `mcpHttpServer` module that owns session maps, request validation, route-local payload limits, abort propagation, and HTTP/SSE framing while reusing the shared backend-proxy runtime initializer.
- Treat Streamable HTTP as the canonical path on `/mcp` for `POST`, required `GET`, and `DELETE`, while keeping WebSocket on the same path via `Upgrade: websocket`.
- Use the fixed SSE compatibility route pair `GET /mcp/sse` and `POST /mcp/sse/messages` instead of overloading Streamable HTTP route semantics.
- Keep Phase 6 parity-focused: ship the minimum transport contract Trae needs first, then revisit advanced server-push or event replay only after the basic compatibility layer is stable.

</specifics>

<deferred>
## Deferred Ideas

- HTTP resource success-path expansion beyond the same representative tool/prompt coverage already used elsewhere.
- Durable replay for disconnected SSE streams or resumable HTTP transport state.
- Cross-instance shared MCP session stores.
- AdminPanel connection introspection for HTTP transports.

</deferred>

---

*Phase: 06-http-compatibility-layer*
*Context gathered: 2026-04-26*
