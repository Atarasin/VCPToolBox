# Phase 5 Research: Production Hardening

**Date:** 2026-04-26
**Phase:** 05-production-hardening

## Summary

Phase 5 is not greenfield work. The `/mcp` transport already contains the right hardening seams: a dedicated connection map, an upgrade-time connection gate, a `ws` payload ceiling, serialized per-connection dispatch, and deterministic cleanup hooks. The missing work is to finish wiring these controls into the production bootstrap, close the deferred upgrade-time timeout gap, add an explicit per-connection rate limiter, and prove the overload paths with websocket-first tests that cannot hang.

## Findings

### 1. Connection and payload controls already exist, but they are only partial Phase 5 evidence

From `modules/agentGateway/mcpWebSocketServer.js`:
- `maxConnections` already defaults to `100` and is enforced before `wss.handleUpgrade()`
- `maxPayloadBytes` already defaults to `4 * 1024 * 1024` and is passed to `new WebSocket.Server({ maxPayload })`
- connection tracking is isolated in a dedicated `connections` `Map`

Gap:
- `server.js` currently constructs `createMcpWebSocketServer({ pluginManager, stderr })` without wiring the documented `VCP_MCP_WS_MAX_CONNECTIONS`
- there is no requirement-level verification yet that these controls behave correctly under real websocket upgrade and oversized-frame conditions

Implication:
- Phase 5 should preserve the existing implementation shape, then finish the production wiring and add end-to-end tests instead of re-architecting admission control

### 2. The open risk from Phase 2 is still real: upgrade auth can stall indefinitely

From `.planning/phases/02-websocket-endpoint-session-management/02-REVIEW.md` and `.planning/STATE.md`:
- `WR-02` explicitly defers timeout protection for the `/mcp` upgrade auth path to Phase 5
- current `handleUpgrade()` calls `resolveDedicatedGatewayAuth()` inside the upgrade flow and only relies on rejection handling, not timeout bounding

Implication:
- Phase 5 must bound the upgrade-auth path with a dedicated timeout that destroys the socket if auth resolution or surrounding upgrade logic stalls
- verification needs a deterministic stalled-auth test fixture, not just code inspection

### 3. Transport-local rate limiting is still missing

From `.planning/REQUIREMENTS.md` and `modules/agentGateway/mcpWebSocketServer.js`:
- `OP-04` requires per-connection message rate limiting
- the websocket transport currently serializes messages per connection but does not throttle ingress

Relevant reusable reference:
- `modules/agentGateway/services/operabilityService.js` already implements sliding-window rate limiting with structured retry metadata for Gateway-managed operations

Implication:
- Phase 5 should borrow the semantic shape of operability rejections (`retryAfterMs`, stable code, deterministic window math), but the limiter itself likely belongs in `mcpWebSocketServer.js` because `OP-04` is specifically about websocket message ingress and must fire before backend overload occurs

### 4. Payload rejection needs websocket-specific proof, not just constructor confidence

From `mcpWebSocketServer.js`:
- `ws` enforces `maxPayload` at the frame layer before application code sees the message

Risk:
- if the phase only relies on the `ws` option and never tests the real close/error behavior, it will be hard to prove that oversized frames are rejected "cleanly" and do not leave stale connections or hung shutdown behind

Implication:
- Phase 5 tests should send an oversized frame against a small configured payload limit and assert:
  - the client is closed or errors promptly
  - the server can accept later healthy connections
  - `getConnectionCount()` or equivalent fixture evidence returns to zero after cleanup

### 5. Batch requests complicate rate limiting

From `mcpWebSocketServer.js`:
- one websocket frame can contain either a single request or a JSON-RPC batch array
- there is already a bounded `maxBatchSize`

Implication:
- Phase 5 must decide how rate limiting counts batched traffic
- the safest plan is to state this explicitly in the implementation task rather than leaving the semantics to ad hoc coding

Recommended direction:
- count one frame as the admission unit for the transport limiter, and explicitly document why batch fan-out remains separately governed by `maxBatchSize`
- alternatively, count batch members as weighted cost if tests show single-frame batches can still overload the harness despite the existing batch ceiling

### 6. Existing websocket tests already contain the right anti-hang patterns

From `test/agent-gateway/adapters/agent-gateway-mcp-websocket.test.js` and remembered project testing guidance:
- fixtures already track raw TCP sockets and destroy leftovers on shutdown
- the suite already uses bounded `waitForJsonMessage`, connection-failure expectations, and explicit integration test timeouts
- recent project learning emphasizes per-wait timeouts, anti-race listeners, and cleanup that cannot block `server.close()`

Implication:
- Phase 5 should extend the existing websocket suite rather than starting a new test harness
- hardening tests should keep using explicit close/error waits and minimal, targeted fixtures

### 7. Server bootstrap is the missing link for "production" sign-off

From `server.js`:
- `/mcp` currently starts with defaults only
- other server concerns are routinely wired from environment variables at bootstrap time

Implication:
- Phase 5 should not stop at making constructor options richer in tests
- the real server path must read and pass through the selected websocket hardening limits, at minimum for documented settings such as `VCP_MCP_WS_MAX_CONNECTIONS`, and likely for any new timeout/rate/payload knobs introduced by the implementation

## Recommended Planning Split

### Plan 05-01
- Finish transport guardrails already implied by the code:
  - wire max-connection config into production bootstrap
  - verify connection-limit admission and cleanup drift
  - formalize payload-ceiling behavior with explicit websocket tests
  - implement the deferred upgrade-auth timeout guard (`WR-02`)

### Plan 05-02
- Add per-connection message rate limiting and overload signaling:
  - choose and document the counting model for single messages vs batches
  - fail fast before backend work is dispatched
  - surface stable retry metadata for remote clients where practical
  - prove that throttled connections do not starve healthy peers

## Constraints To Preserve

- Do not push websocket-only throttling deep into the backend-proxy adapter unless a shared abstraction clearly reduces duplication without changing transport boundaries
- Do not broaden Phase 5 into observability dashboards, distributed quotas, or new MCP capabilities
- Keep comments and helper structure aligned with the current Agent Gateway style
- Preserve the accepted cleanup contract from Phase 2 while hardening overload paths
