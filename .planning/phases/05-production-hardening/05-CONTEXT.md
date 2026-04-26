# Phase 5: Production Hardening - Context

**Gathered:** 2026-04-26
**Status:** Completed and archived

<domain>
## Phase Boundary

Make the authenticated `/mcp` WebSocket endpoint safe to run under sustained external traffic by finishing the missing resource-guard controls around connection admission, payload bounds, message-rate abuse, and stalled upgrade handling.

In scope: enforcing `OP-01`, `OP-04`, and `OP-05`; carrying forward deferred hardening item `WR-02` for upgrade-auth timeout protection; wiring production-facing limits from configuration into the real server bootstrap; and adding targeted websocket tests that prove overload paths fail fast without leaking connections or hanging shutdown.
Out of scope: new MCP capabilities, new Gateway Core business rules, AdminPanel monitoring UI, cross-process distributed quotas, and broader observability/resource/event features deferred beyond this milestone.

</domain>

<decisions>
## Implementation Decisions

### Hardening Ownership
- **D-01:** `modules/agentGateway/mcpWebSocketServer.js` remains the owner of transport-level admission control, frame-size enforcement, heartbeat cleanup, and websocket-specific overload protection.
- **D-02:** `modules/agentGateway/services/operabilityService.js` is the canonical reference for existing Gateway operability semantics and metadata, but Phase 5 should only reuse it where transport behavior naturally aligns. Do not force websocket-only concerns into the backend-proxy adapter layer.
- **D-03:** Production limits must be configurable from the real server bootstrap in `server.js`; phase sign-off should not depend on test-only constructor overrides.

### Current State To Preserve
- **D-04:** The `/mcp` endpoint already uses a dedicated connection map and is isolated from the legacy websocket mesh. Phase 5 must harden this path without reintroducing mesh coupling.
- **D-05:** `mcpWebSocketServer.js` already enforces an in-memory `maxConnections` option and a `ws` `maxPayload` ceiling, but these controls are not yet traced to the Phase 5 requirement contract because they are not fully wired, documented, and verified as production features.
- **D-06:** Connection cleanup on `close` and `error` is already part of the accepted transport lifecycle from Phase 2. Hardening work may strengthen regression coverage here, but it should not redefine the cleanup contract.

### Verification Strategy
- **D-07:** Prefer websocket endpoint tests over unit-only checks for hardening behavior so phase evidence covers real upgrade, frame, close, and shutdown semantics.
- **D-08:** Overload-path tests must include anti-hang guards. Use explicit per-test timeouts, bounded waits for close/error events, and socket teardown that cannot block fixture shutdown.
- **D-09:** Split Phase 5 into two plans:
  - `05-01`: transport guardrails that finish connection-limit wiring, payload ceiling behavior, cleanup drift checks, and the deferred upgrade timeout guard
  - `05-02`: per-connection rate limiting and overload signaling

### Claude's Discretion
- Use the smallest stable configuration surface that still makes production limits visible and testable.
- Add focused helper functions in websocket tests if they reduce duplicated close/error waiting logic.

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Project requirements and roadmap
- `.planning/ROADMAP.md` — Phase 5 goal, dependency on Phase 4, and success criteria for production hardening.
- `.planning/REQUIREMENTS.md` — `OP-01`, `OP-04`, and `OP-05` define the missing operability contract.
- `.planning/STATE.md` — Tracks `WR-02` as an accepted deferred hardening item for this phase.

### Existing implementation to reuse
- `modules/agentGateway/mcpWebSocketServer.js` — Current `/mcp` upgrade handling, connection tracking, heartbeat lifecycle, batch limits, and `ws` payload ceiling.
- `server.js` — Real application bootstrap where production websocket options must be wired from environment/config instead of remaining constructor-only defaults.
- `modules/agentGateway/contracts/protocolGovernance.js` — Upgrade-time auth resolver used by the `/mcp` websocket path.
- `modules/agentGateway/services/operabilityService.js` — Existing rate-limit, concurrency, and payload-governance semantics used elsewhere in Agent Gateway.
- `modules/agentGateway/adapters/mcpGatewayOperability.js` — Shows how Gateway-managed operations package operability rejections and retry metadata.

### Existing tests and fixtures
- `test/agent-gateway/adapters/agent-gateway-mcp-websocket.test.js` — Current websocket auth, framing, lifecycle, capability, and error-contract coverage that Phase 5 should extend.
- `test/agent-gateway/services/agent-gateway-operability.test.js` — Executable reference for rate-limit and payload-governance behavior already established in the core operability service.
- `test/agent-gateway/adapters/agent-gateway-mcp-adapter.test.js` — Shows how operability rejections are exposed through MCP-facing contracts today.

### Prior reviews and deferred notes
- `.planning/phases/02-websocket-endpoint-session-management/02-REVIEW.md` — Records `WR-02` and why upgrade-time timeout protection was deferred.
- `.planning/phases/04-capability-exposure/04-CONTEXT.md` — Explicitly leaves production hardening controls to Phase 5.

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- `createMcpWebSocketServer()` already centralizes the websocket concerns this phase needs to harden: upgrade admission, frame parsing, connection serialization, cleanup, and shutdown.
- `resolvePositiveInteger()` is already used in the websocket server for numeric options and can support new environment/config wiring.
- `operabilityService.beginRequest()` already models rate-limit and payload-limit policy plus retry metadata; its behavior is a good semantic reference even if Phase 5 keeps transport throttling local to the websocket server.

### Established Patterns
- The codebase prefers defensive teardown in tests by tracking open sockets and destroying leftovers during fixture shutdown.
- Existing Agent Gateway tests treat policy enforcement as structured, metadata-rich failures instead of opaque transport crashes.
- `server.js` commonly reads environment variables directly when bootstrapping optional runtime limits; Phase 5 can follow this pattern without introducing a new config subsystem.

### Gaps To Close
- `VCP_MCP_WS_MAX_CONNECTIONS` is documented in requirements but not actually wired through `server.js` or verified end to end.
- There is no `/mcp` upgrade timeout guard, so a stalled auth path can hold the socket until the client gives up.
- There is no per-connection message rate limiter in the websocket transport.
- Payload ceilings rely on `ws` `maxPayload`, but there is not yet phase-level proof that oversized frames are rejected cleanly and do not leave connection-count drift or hanging cleanup behind.

</code_context>

<specifics>
## Specific Ideas

- Keep connection-limit enforcement at upgrade time, before `handleUpgrade()`, and expose the configured limit to tests via constructor options and real server env wiring.
- Treat batch requests as a potential amplification vector when designing rate limiting; the plan should decide explicitly whether the limiter counts frames, batch members, or weighted request cost.
- For auth timeout protection, bound the entire upgrade-auth path so stalled `/mcp` handshakes destroy the socket deterministically and do not leak partially registered connections.
- Verify that overload-path failures do not regress healthy clients on other websocket connections.

</specifics>

<deferred>
## Deferred Ideas

- Global quotas shared across multiple Node processes remain out of scope; Phase 5 only needs instance-local protection.
- Metrics export and AdminPanel connection dashboards stay deferred even if the implementation records enough state to support future observability.
- Adaptive backoff, ban lists, or IP-based abuse controls are not required for this milestone.

</deferred>

---

*Phase: 05-production-hardening*
*Context gathered: 2026-04-26*
