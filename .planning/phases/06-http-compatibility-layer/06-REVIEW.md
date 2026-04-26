# Phase 6 Plan Engineering Review

**Reviewer:** `/plan-eng-review`
**Date:** 2026-04-26
**Scope:** `.planning/phases/06-http-compatibility-layer/06-01-PLAN.md` + `06-02-PLAN.md`
**Original plans:** unchanged. This document captures findings, recommended decisions, and acceptance criteria that the executor should treat as authoritative supplements during execution.
**Voice:** GStack engineering review (Garry Tan / YC partner energy + senior eng)

---

## TL;DR

Phase 6 ships an HTTP compatibility layer because Trae cannot speak the existing `/mcp` WebSocket transport. The plans correctly split the work into a canonical Streamable HTTP transport (06-01) and a deprecated HTTP+SSE compatibility surface (06-02), and they correctly choose to wrap — not duplicate — the existing backend-proxy MCP harness. The architectural choices are sound.

The plans are also **silently incomplete in ways that would ship a regression** unless caught during execution. Concretely:

- **The HTTP path inherits zero of Phase 5's production hardening unless explicitly required.** WebSocket already enforces max connections, max payload, rate limit, and upgrade-auth timeout. HTTP would silently miss all four, plus accept payloads up to 300 MB because of the global `express.json({ limit: '300mb' })` in `server.js`.
- **The session map has no expiry mechanism.** A `Map<sessionId, sessionRecord>` accumulates forever in the original truths.
- **GET `/mcp` is described as optional** despite the MCP Streamable HTTP spec requiring server-to-client streaming via GET.
- **06-02's `wave: 1` contradicts its `depends_on: ["01"]`.** Both plans cannot run in wave 1; one of them must move.
- **No coexistence test** asserts that adding HTTP routes does not disturb the WebSocket upgrade handler on the same `http.Server`.
- **The SSE compatibility URL is left unspecified** — clients, tests, and docs cannot align without a concrete contract.
- **Body parser scope is silent.** Without a route-local override, HTTP MCP requests are bounded by the global 300 MB limit, ~75× the 4 MB cap WebSocket enforces.

This review records each finding (F1–F11), the chosen disposition, and the additions Plan 06-01 and Plan 06-02 must satisfy at execution time. Treat the **Augmented Acceptance Criteria** sections below as the gate — if a delivery omits any item, it is not ready to merge.

---

## Step 0 — Scope Challenge

**Question:** Why is Phase 6 needed now, and is HTTP the right shape?

**Resolution:** the driving requirement is non-negotiable: Trae's native MCP client supports `stdio`, `SSE`, and `Streamable HTTP`, and does not support WebSocket. Without HTTP transport, Trae cannot consume VCP at all. Streamable HTTP is the modern MCP HTTP transport and is the right primary target. SSE compatibility is the right secondary target because older HTTP+SSE clients still exist in the wild, and `HTTP-06` requires it.

**Cuts considered and rejected:**
- Cut SSE compat → rejected: `HTTP-06` is an explicit v1 requirement.
- Cut Streamable HTTP, ship only SSE → rejected: SSE is a deprecated transport; making it the only HTTP option for new clients is a strict downgrade.
- Defer Phase 6 → rejected: Phase 5 (production hardening for WebSocket) is complete and the next blocking gap is Trae compatibility.

**Conclusion:** scope is correct. No expansion (no resource discovery, no event replay, no AdminPanel UI, no cross-instance session stores).

---

## Findings

### F1 — Wave / depends_on contradiction in 06-02 [P0 correctness]

**Issue:** `06-02-PLAN.md` declares `wave: 1` while also declaring `depends_on: ["01"]`. Both plans cannot run in the same wave when one depends on the other.

**Decision:** **06-02 should execute in wave 2, after 06-01 lands.** Parallel execution would force two writers on `modules/agentGateway/mcpHttpServer.js`, which violates the "transport view, not forked runtime" boundary.

**Acceptance:** at execution time, treat 06-02 as `wave: 2` regardless of the YAML literal, and do not start 06-02 work until 06-01's verification gates pass.

---

### F2 — Express HTTP route ownership: in-route vs root mount [P0 design]

**Issue:** the plan does not state who registers the HTTP routes. Two viable options:
- (a) define routes inline inside `routes/agentGatewayRoutes.js`, or
- (b) have `mcpHttpServer.js` export an `attach(router)` method that owns route registration.

(a) leaks transport bookkeeping (session map, framing, Phase 5 limits) into the route file. (b) keeps the transport adapter cohesive.

**Decision:** **option (b) — `mcpHttpServer.attach()` registers routes against the existing `/agent_gateway` Express router.** This mirrors `mcpWebSocketServer.attach(httpServer)` and keeps `routes/agentGatewayRoutes.js` thin.

**Acceptance:** `routes/agentGatewayRoutes.js` must contain at most a single line that hands the router to `mcpHttpServer.attach(router)`. All `text/event-stream` framing, session validation, and limit enforcement live inside `mcpHttpServer.js`.

---

### F3 — HTTP path missed all Phase 5 production hardening [P0 reliability/security]

**Issue:** Phase 5 added five hardening primitives to WebSocket. The original 06-01 truths require none of them on HTTP. Without an explicit requirement, the HTTP path will ship without:

| Phase 5 primitive (WS) | Default | Mirror on HTTP? |
|------------------------|---------|-----------------|
| `DEFAULT_MAX_CONNECTIONS` | 100 | **must mirror** as max sessions |
| `DEFAULT_MAX_PAYLOAD_BYTES` | 4 MB | **must mirror** as max request body |
| `DEFAULT_UPGRADE_AUTH_TIMEOUT_MS` | 5000 | **must mirror** as auth handshake timeout |
| `DEFAULT_RATE_LIMIT_MESSAGES` | 60 | **must mirror** as per-session message budget |
| `DEFAULT_RATE_LIMIT_WINDOW_MS` | 1000 | **must mirror** as rate limit window |

**Decision:** **06-01 must enforce all five limits on HTTP MCP** with parity defaults to WebSocket, plus an idle-session expiry.

**Acceptance — 06-01 must add the following truths:**
- HTTP MCP enforces a max-active-session limit, defaulted to the same value as WebSocket's max connections, exposed via `VCP_MCP_HTTP_MAX_SESSIONS` (default 100).
- HTTP MCP enforces a max request body size, defaulted to the same value as WebSocket's max payload, exposed via `VCP_MCP_HTTP_MAX_PAYLOAD_BYTES` (default 4 MB).
- HTTP MCP enforces a per-session rate limit at parity with WebSocket, exposed via `VCP_MCP_HTTP_RATE_LIMIT_MESSAGES` (default 60) and `VCP_MCP_HTTP_RATE_LIMIT_WINDOW_MS` (default 1000).
- HTTP MCP enforces an auth-handshake timeout, exposed via `VCP_MCP_HTTP_AUTH_TIMEOUT_MS` (default 5000).
- HTTP MCP enforces an idle-session expiry, exposed via `VCP_MCP_HTTP_SESSION_IDLE_MS` (default 600000).

**Acceptance — `config.env.example` must publish all six knobs** (the five above plus the existing-naming convention used by Phase 5).

**Acceptance — tests must cover at least one limit per primitive** (e.g., reject 5 MB body, reject 101st session, reject 61st message inside 1 s window, reject auth handshake taking longer than 5 s, expire idle session after configured window).

---

### F4 — Session lifecycle gaps (idle expiry, DELETE, abort propagation, drain) [P1 reliability]

**Issue:** the original plan does not specify:
1. how sessions are cleaned up if the client disappears
2. whether DELETE is supported on the session
3. whether in-flight harness calls are aborted when the client disconnects
4. whether SSE writes wait for `drain` under backpressure

**Decision:** **all four are required.**
- **DELETE** `/agent_gateway/mcp` must be supported with a valid `MCP-Session-Id`, freeing all server-side state and aborting any in-flight harness calls bound to that session.
- **Reject-new-on-overflow:** when `VCP_MCP_HTTP_MAX_SESSIONS` is reached, return HTTP 429 (or equivalent) on the next `initialize` rather than evicting an existing session.
- **AbortSignal propagation:** every `harness.handleRequest()` call must receive an `AbortSignal` derived from the client connection (close on `req.aborted`, on session DELETE, or on idle expiry).
- **SSE backpressure:** `res.write()` on the GET stream must `await` the `drain` event when the socket buffer is full, instead of dropping frames silently. For heartbeat frames specifically, prefer dropping the oldest queued heartbeat over blocking forward progress (gentle backpressure).

**Acceptance — 06-01 must add truths covering all four bullets above.**

---

### F5 — GET /mcp written as optional despite spec required [P1 spec compliance]

**Issue:** the original 06-01 plan describes GET `/mcp` as optional. The MCP Streamable HTTP spec requires GET as the server-to-client streaming channel; without GET, server-initiated messages cannot reach the client.

**Decision:** **GET `/mcp` is required, not optional.**

**Acceptance — 06-01 must add a truth:**
- HTTP MCP supports GET `/agent_gateway/mcp` for server-to-client SSE streaming, validates `MCP-Session-Id`, emits a heartbeat event on a regular cadence, and propagates AbortSignal on client disconnect.

**Acceptance — tests must cover:** opening the GET stream, receiving an initial heartbeat, validating the session id requirement, and clean abort on client close.

---

### F6 — Coexistence test for HTTP + WebSocket on the same server missing [P1 regression risk]

**Issue:** the original plan does not assert that HTTP routes and the WebSocket upgrade handler can coexist on a single `http.Server` without interference.

**Decision:** **add an explicit three-transport coexistence test** in 06-02 (after both transports exist). The test brings up one `http.Server` that mounts:
- the existing `/mcp` WebSocket upgrade handler
- the new Streamable HTTP routes (06-01)
- the new SSE compat routes (06-02)

…and exercises one representative request on each, asserting no cross-interference.

**Acceptance — 06-02 Task 2 must include a coexistence test case.**

---

### F7 — SSE compatibility URL deferred to implementation time [P1 contract clarity]

**Issue:** the original 06-02 truths leave the SSE compatibility URL pattern ambiguous (`GET /sse or equivalent`). Clients, tests, and docs cannot align without a concrete URL contract.

**Decision:** **lock the URL pair now:**
- `GET /agent_gateway/mcp/sse` — event stream
- `POST /agent_gateway/mcp/sse/messages` — JSON-RPC companion

Both routes mount under the existing `/agent_gateway` router so they share the dedicated-auth middleware path.

**Acceptance — 06-02 must encode this URL pair in truths, key_links, tests, and consumer docs.**

---

### F8 — Test count too small for HTTP transport scope [P1 coverage]

**Issue:** the original plans require `min_tests: 5` for 06-01 and `min_tests: 4` for 06-02. The HTTP transport surface area (POST initialize, POST request, GET stream, DELETE session, plus five hardening primitives, plus session lifecycle, plus SSE compat, plus three-transport coexistence, plus stdio+WS regression) cannot fit in 9 tests without leaving real failure modes uncovered.

**Decision:** **bump test counts to:**
- 06-01: `min_tests: 12` covering canonical Streamable HTTP lifecycle + hardening + GET stream + DELETE
- 06-02: `min_tests: 6` covering SSE compat lifecycle + capability parity + coexistence + stdio/WS regression

**06-01 acceptance — 12 cases:**
1. POST `initialize` returns `MCP-Session-Id`
2. POST `notifications/initialized` returns 202 / no body, idempotent
3. POST `tools/list` parity vs stdio + WS baseline
4. POST `prompts/get` parity vs stdio + WS baseline
5. POST representative gateway-managed memory call parity
6. Follow-up request without `MCP-Session-Id` is rejected (except fresh `initialize`)
7. GET `/agent_gateway/mcp` opens the stream, emits heartbeat, validates session id, and aborts cleanly on client close
8. DELETE `/agent_gateway/mcp` releases session state and aborts in-flight harness calls
9. Max-sessions limit rejects the (N+1)th `initialize` with the correct status
10. Max-payload limit rejects a body larger than `VCP_MCP_HTTP_MAX_PAYLOAD_BYTES`
11. Per-session rate limit rejects requests beyond `VCP_MCP_HTTP_RATE_LIMIT_MESSAGES` per window
12. Auth handshake timeout rejects clients exceeding `VCP_MCP_HTTP_AUTH_TIMEOUT_MS`

**06-02 acceptance — 6 cases:**
1. SSE compat `initialize` flow (GET stream open, POST companion handshake)
2. SSE compat `tools/list` parity
3. SSE compat `prompts/get` parity
4. SSE compat representative gateway-managed memory call parity
5. Three-transport coexistence on a single live `http.Server`
6. stdio + WebSocket regression suites still pass after Phase 6 lands

---

### F9 — Truths missing boundary statements (harness, error envelope, metadata leakage) [P1 architecture]

**Issue:** the original truths do not state where transport ends and the canonical capability surface begins. Without explicit boundaries, future maintainers will leak transport concerns into the harness.

**Decision:** **add three boundary truths** to each plan as appropriate:
- HTTP MCP transport never modifies harness request shape; canonical request context (`sessionId`, dedicated auth) is injected at the transport boundary and the harness sees the same shape it sees on stdio and WebSocket.
- HTTP MCP error envelopes reuse the existing `AGW_ERROR_CODES` and JSON-RPC error mapping rules already enforced on stdio and WebSocket.
- Compatibility-specific metadata (deprecated tags, retry hints, alternate event names) lives only in the SSE transport adapter and never leaks into the backend-proxy harness or Gateway Core contracts.

---

### F10 — Body parser limit: global 300 MB vs WebSocket 4 MB cap [P1 reliability]

**Issue:** `server.js` declares `app.use(express.json({ limit: '300mb' }))` globally. WebSocket enforces a 4 MB payload cap. Without a route-local override, HTTP MCP would silently accept payloads ~75× larger than WebSocket allows.

**Decision:** **mount a route-local `express.json({ limit: VCP_MCP_HTTP_MAX_PAYLOAD_BYTES })` inside `mcpHttpServer.attach()`.** The limit is enforced before the global parser sees the request because Express middleware order is route-specific.

**Acceptance — 06-01 must add a truth:**
- HTTP MCP requests are size-limited at the route boundary by a route-local body parser whose limit matches `VCP_MCP_HTTP_MAX_PAYLOAD_BYTES`, independent of any global Express body parser configuration.

---

### F11 — GET stream backpressure + abort propagation explicitness [P2 reliability]

**Issue:** the original plan implies but does not state how the GET stream handles slow consumers and how AbortSignal flows through the harness call graph.

**Decision:** **make both explicit:**
- AbortSignal propagation is required (already covered in F4).
- For the GET stream, prefer **gentle backpressure**: drop the oldest queued heartbeat frame if the socket buffer is full rather than blocking forward progress. JSON-RPC response frames (which carry MCP responses) must `await drain` instead of being dropped.
- Resumability and replay are explicitly **out of scope** for Phase 6 and recorded as a Phase 7 candidate if a client proves it needs durable replay.

**Acceptance — 06-01 must add a truth covering AbortSignal + drain + heartbeat-drop policy.**

---

## Augmented Acceptance Criteria

The following augmented acceptance criteria supplement (do not replace) the truths in `06-01-PLAN.md` and `06-02-PLAN.md`.

### Plan 06-01 — Streamable HTTP

**Truths the executor must satisfy in addition to the plan's existing truths:**
1. Routes are registered by `mcpHttpServer.attach(router)`; `routes/agentGatewayRoutes.js` contains only a single attach line.
2. Coexists with the `/mcp` WebSocket upgrade handler on the same `http.Server` without modifying upgrade-handler ownership.
3. `MCP-Session-Id` is server-assigned on `initialize` and validated on every follow-up request except a fresh `initialize`.
4. GET `/agent_gateway/mcp` is supported (not optional) with heartbeat + AbortSignal + session-id validation.
5. DELETE `/agent_gateway/mcp` is supported and frees server-side state plus aborts in-flight harness calls.
6. Max-sessions limit (`VCP_MCP_HTTP_MAX_SESSIONS`, default 100): reject (N+1)th `initialize`.
7. Max-payload limit (`VCP_MCP_HTTP_MAX_PAYLOAD_BYTES`, default 4 MB): enforced by a route-local `express.json({ limit })` mounted inside `mcpHttpServer.attach()`.
8. Per-session rate limit (`VCP_MCP_HTTP_RATE_LIMIT_MESSAGES`, default 60 / `VCP_MCP_HTTP_RATE_LIMIT_WINDOW_MS`, default 1000) at parity with WebSocket.
9. Auth handshake timeout (`VCP_MCP_HTTP_AUTH_TIMEOUT_MS`, default 5000) at parity with WebSocket.
10. Idle-session expiry (`VCP_MCP_HTTP_SESSION_IDLE_MS`, default 600000): expire idle sessions, free memory, abort pending harness calls.
11. Dedicated auth reuses `resolveDedicatedGatewayAuth()`; no weaker HTTP-only fallback.
12. Harness boundary: transport never modifies harness request shape; harness sees the same shape it sees on stdio and WebSocket.
13. Error envelope reuses `AGW_ERROR_CODES` + JSON-RPC error mapping.

**Artifacts the executor must produce:**
- `modules/agentGateway/mcpHttpServer.js` exporting `createMcpHttpServer` and an `attach(router, httpServer)` method.
- `test/agent-gateway/adapters/agent-gateway-mcp-http.test.js` with at least the **12 cases** enumerated in F8.
- `config.env.example` documenting the **6 knobs** above with parity defaults.
- No edits to `mcpStdioServer.js`, `mcpWebSocketServer.js`, or `createBackendProxyMcpServerHarness()`.

### Plan 06-02 — SSE Compatibility + Trae Docs

**Truths the executor must satisfy in addition to the plan's existing truths:**
1. SSE compatibility surface is mounted on the URL pair `GET /agent_gateway/mcp/sse` + `POST /agent_gateway/mcp/sse/messages`.
2. The compatibility surface reuses the same `mcpHttpServer` runtime, session map, dedicated auth, and Phase 5 hardening as Streamable HTTP — it is a transport view, not a forked runtime.
3. Coexistence is proven on a single `http.Server` running WebSocket + Streamable HTTP + SSE compat.
4. Existing stdio and WebSocket regression suites are re-run and pass with no behavioral change.
5. Trae-facing client guidance documents `streamable-http` as the preferred remote MCP transport and labels SSE strictly as compatibility for older clients; WebSocket is documented as available infrastructure but not a Trae-supported MCP transport today.
6. Compatibility-specific metadata (deprecated tags, retry hints, alternate event names) lives only in the SSE transport adapter and never leaks into the backend-proxy harness or Gateway Core contracts.

**Artifacts the executor must produce:**
- Additions to `modules/agentGateway/mcpHttpServer.js` for the SSE compat route pair (no second runtime).
- `test/agent-gateway/adapters/agent-gateway-mcp-http.test.js` extended with the **6 cases** enumerated in F8.
- `mydoc/export/agent-gateway-consumer-guide.md` updated with the Trae transport selection guidance described above.

---

## STRIDE Threat Register (supplemental)

The plan files include their own threat models. The following supplemental threats should also be tracked.

### 06-01 supplemental threats

| Threat ID | Category | Component | Disposition | Mitigation |
|-----------|----------|-----------|-------------|------------|
| T-06-01s | Spoofing | HTTP MCP path bypasses dedicated auth | mitigate | Reuse `resolveDedicatedGatewayAuth()` at the same call site as Streamable HTTP; no weaker fallback |
| T-06-02s | Tampering | Cross-session-id reuse / replay | mitigate | Validate `MCP-Session-Id` against server-owned session map; reject unknown ids on follow-ups |
| T-06-03s | Repudiation | Missing audit trail for HTTP MCP requests | accept | Existing Express access logs cover this surface |
| T-06-04s | Information Disclosure | Stack traces or backend internals leak via HTTP error envelope | mitigate | Reuse `AGW_ERROR_CODES` + harness error mapping; no raw error bubble-up |
| T-06-05s | Denial of Service | Unbounded session map | mitigate | `VCP_MCP_HTTP_MAX_SESSIONS` + idle expiry + DELETE support |
| T-06-06s | Denial of Service | Oversized payloads | mitigate | Route-local `express.json({ limit })` |
| T-06-07s | Denial of Service | Rate-limit bypass | mitigate | Per-session rate limit at parity with WebSocket |
| T-06-08s | Denial of Service | Auth handshake holds session indefinitely | mitigate | `VCP_MCP_HTTP_AUTH_TIMEOUT_MS` |
| T-06-09s | Denial of Service | Slow GET stream consumer back-pressures the server | mitigate | `await drain` for response frames; drop oldest heartbeat for slow consumers |
| T-06-10s | Elevation of Privilege | Compatibility transport injects forged session context | mitigate | Transport-local injection; harness never reads transport metadata directly |
| T-06-11s | Reliability | HTTP additions regress WebSocket upgrade handler | mitigate | Three-transport coexistence test (delivered in 06-02) |

### 06-02 supplemental threats

| Threat ID | Category | Component | Disposition | Mitigation |
|-----------|----------|-----------|-------------|------------|
| T-06-12s | Spoofing | Deprecated SSE path bypasses canonical auth/session rules | mitigate | Reuse the same `resolveDedicatedGatewayAuth()` middleware and session map as Streamable HTTP |
| T-06-13s | Tampering | Cross-transport session-id reuse on the SSE compat path | mitigate | Validate `MCP-Session-Id` against the shared session map; document the cross-transport reuse policy explicitly (allowed or refused — pick one and assert it) |
| T-06-14s | Reliability | HTTP compatibility work regresses stdio or WebSocket | mitigate | Re-run existing stdio + WebSocket parity suites after Plan 06-02 lands |
| T-06-15s | Reliability | SSE compat path bypasses Phase 5 hardening | mitigate | Mount the compat surface inside the same `mcpHttpServer` runtime so the same limits apply uniformly |
| T-06-16s | DoS | SSE compat clients hold streams open without progress | mitigate | Inherit idle-session expiry, max-sessions limit, and AbortSignal cleanup from the shared HTTP runtime |
| T-06-17s | Integrity | Docs steer Trae users to unsupported WebSocket mode or to SSE for new builds | mitigate | Publish explicit preferred `streamable-http` guidance, label SSE as compatibility-only, label WebSocket as not-supported-by-Trae |
| T-06-18s | Information Disclosure | Compatibility-specific metadata leaks into harness or Gateway Core contracts | mitigate | Keep compatibility-only metadata inside the transport adapter |

---

## NOT in scope (carried forward, do not expand)

- New Gateway Core capabilities (e.g., `notifications/tools/list_changed`)
- Durable replay for disconnected SSE streams or resumable HTTP transport state
- Cross-instance shared MCP session stores
- AdminPanel introspection for HTTP transports
- Redesigning the `/mcp` WebSocket upgrade contract
- Migrating Trae or any other client off WebSocket — adding HTTP is additive, not subtractive
- Resource discovery / read (`resources/list`, `resources/read`)
- Server-initiated `notifications/tools/list_changed`
- Binary frame support
- OAuth 2.1

---

## What already exists and must be preserved

| Artifact | Source | Why it must stay unchanged |
|----------|--------|----------------------------|
| `initializeBackendProxyMcpRuntime()` | Phase 1 | Single shared runtime bootstrap for all transports |
| `createBackendProxyMcpServerHarness()` | Phase 4 | Canonical capability surface; transport-agnostic |
| `resolveDedicatedGatewayAuth()` | Phases 2 + 5 | Single source of truth for dedicated auth |
| `/mcp` WebSocket upgrade handler | Phases 2–4 | Existing remote transport contract |
| Phase 5 production hardening for WebSocket | Phase 5 | Behavioral baseline that HTTP must mirror, not replace |
| stdio MCP transport | Phase 1 | Existing local transport contract |
| `routes/agentGatewayRoutes.js` SSE conventions | Pre-Phase 6 | `text/event-stream` framing pattern reused by GET `/mcp` and SSE compat |

---

## Failure-mode coverage matrix

| Failure mode | Where mitigated |
|--------------|------------------|
| HTTP path bypasses dedicated auth | T-06-01s; reuse `resolveDedicatedGatewayAuth()` |
| HTTP path bypasses Phase 5 hardening | F3 truths + 5 env knobs + tests #9–#12 |
| Unbounded session map | F4 + idle expiry + max-sessions limit |
| Body parser silently allows 300 MB requests | F10 + route-local `express.json({ limit })` |
| Client disconnect leaves harness call running | F4 + AbortSignal propagation |
| Slow GET consumer back-pressures server | F11 + `await drain` + heartbeat drop |
| WebSocket upgrade handler regressed by HTTP routes | 06-02 case #5 (three-transport coexistence) |
| stdio or WebSocket regression after Phase 6 | 06-02 case #6 (regression suite re-run) |
| GET `/mcp` missing breaks server-to-client streaming | F5 + GET as required, not optional |
| SSE compat URL ambiguous → docs/tests/clients diverge | F7 + URL pair locked to `/agent_gateway/mcp/sse{,/messages}` |
| Compat-only tags leak into harness contracts | T-06-18s + transport-local metadata |
| 06-01 + 06-02 race on the same file | F1 + serial execution (06-02 wave: 2) |
| Doc points new clients at SSE | F8 doc constraints + Trae guidance recommends streamable-http |
| Doc tells Trae users to use WebSocket | F8 doc constraints + WebSocket explicitly labeled not-supported-by-Trae |

---

## Worktree / Parallelization

**Sequential only.** 06-02 wave should be 2 (see F1). Both plans modify the same file (`modules/agentGateway/mcpHttpServer.js`) and parallel execution would force two writers on it. There is no parallel split that does not duplicate work or invent a second runtime.

---

## Findings → Decisions → Encoding Map

| Finding | Severity | Decision | Encoded in |
|---------|----------|----------|------------|
| F1 wave/dep mismatch | P0 | 06-02 → wave 2 | This document; executor must respect serial ordering |
| F2 route ownership | P0 | `mcpHttpServer.attach(router)` pattern | This document — supplemental truth |
| F3 Phase 5 parity missed | P0 | 5 limits + idle expiry, 6 env knobs | This document — supplemental truths + `config.env.example` requirement |
| F4 session lifecycle | P1 | DELETE + reject-new + AbortSignal + drain | This document — supplemental truths |
| F5 GET optional | P1 | GET required, not optional | This document — supplemental truths |
| F6 coexistence test | P1 | Three-transport coexistence test in 06-02 | This document — 06-02 augmented test list |
| F7 SSE URL ambiguous | P1 | URL pair locked to `/agent_gateway/mcp/sse{,/messages}` | This document — 06-02 augmented truths |
| F8 test count too low | P1 | 06-01 min_tests: 12; 06-02 min_tests: 6 | This document — augmented test enumerations |
| F9 boundary truths | P1 | Harness shape + error envelope + metadata localization | This document — supplemental truths |
| F10 body parser scope | P1 | Route-local `express.json({ limit })` inside attach() | This document — supplemental truth |
| F11 backpressure / abort | P2 | AbortSignal + await drain + heartbeat-drop | This document — supplemental truth |

---

## Outside Voice (optional)

If a second-opinion review is wanted, the highest-value targets are:
- `/codex` independent review of Phase 5 → Phase 6 hardening parity claims (F3 + F10), to confirm no Phase 5 primitive is missed.
- `/plan-design-review` of the consumer-facing transport guide section in `mydoc/export/agent-gateway-consumer-guide.md` (06-02), to confirm Trae users cannot reach a wrong-transport conclusion from the guidance.

Both are optional and the plans do not depend on them.

---

## Reviewer summary

The Phase 6 plan files capture the right architectural intent: HTTP transport is additive, the canonical surface is Streamable HTTP, the deprecated surface is a separate URL, and the harness stays untouched. The plans are not, however, complete enough to ship without regression unless the augmented criteria above are honored.

The single most impactful gap is Phase 5 parity (F3 + F10) — without those, the HTTP path would inherit none of Phase 5's reliability guarantees. The single most impactful coordination gap is F1 — without serializing 06-02 after 06-01, both plans would race on `mcpHttpServer.js`.

Treat this document as the executor's gate. Plans remain unchanged on disk.
