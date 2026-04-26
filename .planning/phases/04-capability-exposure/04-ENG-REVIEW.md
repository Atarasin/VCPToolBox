# Phase 4: Capability Exposure — Engineering Review

**Review Date:** 2026-04-26
**Reviewer:** /plan-eng-review
**Branch:** main
**Scope:** `.planning/phases/04-capability-exposure/04-01-PLAN.md` and `04-02-PLAN.md`
**Verdict:** CLEARED with recommendations (see below)

---

## Step 0: Scope Challenge

### What existing code already partially or fully solves each sub-problem?

| Sub-problem | Existing solution | Plan reuse |
|-------------|-------------------|------------|
| Remote `tools/list` | `mcpBackendProxyAdapter.js:listTools()` (line 573+) | Reuses — adds websocket e2e coverage only |
| Remote `tools/call` for memory ops | `mcpBackendProxyAdapter.js:callTool()` with `gateway_memory_search`, `gateway_context_assemble`, `gateway_memory_write` routing | Reuses — adds websocket e2e coverage only |
| Remote `prompts/list` | `mcpBackendProxyAdapter.js:listPrompts()` | Reuses — adds websocket e2e coverage only |
| Remote `prompts/get` | `mcpBackendProxyAdapter.js:getPrompt()` with `gateway_agent_render` | Reuses — adds websocket e2e coverage only |
| MCP error mapping | `mapGatewayFailureToMcpErrorCode()`, `createFailureResult()`, `createMcpError()` | Reuses — audits and hardens existing paths |
| Real-harness websocket fixture | `agent-gateway-mcp-websocket.test.js` has 3 real-harness tests | Extends with shared helper |
| Transport plugin manager for prompts | `agent-gateway-mcp-transport.test.js:createTransportPluginManager()` | Mirrors pattern into websocket suite |

**Assessment:** Phase 4 is almost entirely *verification work*, not new capability construction. The backend-proxy adapter already implements everything being exposed. The plans correctly identify this and focus on closing coverage gaps rather than rebuilding.

### What is the minimum set of changes that achieves the stated goal?

The core objective is: *prove remote WebSocket clients can discover and invoke the existing backend-proxy capability surface.*

Minimum set:
1. Extract a shared `createRealHarnessFixture(options)` in `agent-gateway-mcp-websocket.test.js`
2. Add ~6 new websocket tests for capability discovery + invocation (04-01)
3. Add ~6 new websocket tests for error contracts (04-02)
4. Make the smallest possible adapter adjustments if real-harness behavior diverges from intent

Everything else — adapter refactors, new services, transport changes — is out of scope and correctly deferred.

### Complexity check

| Plan | Files touched | New classes/services |
|------|--------------|----------------------|
| 04-01 | 2 (`mcpBackendProxyAdapter.js`, `agent-gateway-mcp-websocket.test.js`) | 0 |
| 04-02 | 3 (+ `agent-gateway-mcp-transport.test.js`) | 0 |

**Result:** 3 files total, 0 new classes. Well under the 8-file / 2-class smell threshold. No scope reduction required.

### Search check

No new architectural patterns, infrastructure components, or concurrency approaches are introduced in Phase 4. The plans rely entirely on existing patterns:
- Transport abstraction (Phase 1, Layer 1 — already shipped)
- WebSocket upgrade handling (Phase 2, Layer 1 — already shipped)
- JSON-RPC batching (Phase 3, Layer 1 — already shipped)
- Backend-proxy harness (pre-existing, Layer 1)

No custom solutions where built-ins exist. No search needed.

### TODOS cross-reference

No `TODOS.md` exists in the repo. Deferred items from prior phases:
- `WR-02` (upgrade auth timeout guard) is correctly carried in `STATE.md` and scoped to Phase 5. It does not block Phase 4.

### Completeness check

The plans are doing the **complete version** of verification work:
- 04-01 requires 6+ tests covering discovery + representative invocation
- 04-02 requires 6+ tests covering error contracts with explicit negative assertions (no stack traces, no raw connection strings)
- Both plans require using the **real** backend-proxy harness path (`useStubHarness: false`) rather than stubs
- Both plans call for parity checks against the existing stdio transport test

This is the right level of completeness. A shortcut would be stub-only tests, which would prove nothing about the actual remote contract.

### Distribution check

No new artifact types (binary, package, container). Phase 4 ships through existing CI/CD. No distribution concerns.

---

## 1. Architecture Review

### Issue A1: Shared harness singleton needs concurrency contract documentation

The harness (`createBackendProxyMcpServerHarness`) is a singleton shared across all stdio and WebSocket connections. The design doc explicitly states this is intentional because `backendClient` and service bundle are expensive to recreate.

**Finding:** There is no documented concurrency contract for the singleton adapter. `mcpBackendProxyAdapter.js` holds mutable state only in the `backendClient` (which is connection-agnostic), but future maintainers might add per-connection mutable state without realizing the harness is shared.

**Recommendation:** Add a code comment at `createBackendProxyMcpServerHarness` (line 881) stating:

```
// NOTE: This harness is a singleton shared across ALL connections (stdio + WebSocket).
// Do NOT store per-connection mutable state here. Per-connection state belongs in
// requestContext/sessionId, which is injected by the transport layer.
```

**Confidence:** 8/10 — pattern is correct, missing documentation is a maintainability risk.

---

### Issue A2: Batch partial failure handling is correct but untested

**Correction from prior review:** The websocket server does **not** use `Promise.all` for batch requests. It processes entries sequentially in a `for` loop (`mcpWebSocketServer.js:331-340`), and each `dispatchRequest` has its own `try/catch` (`mcpWebSocketServer.js:293-308`). This means an unexpected exception in one batch entry is caught locally and returned as a JSON-RPC error for that entry. The batch array itself is preserved.

**Finding:** The code handles partial batch failure correctly, but there is no test proving it. If a future refactor reintroduces `Promise.all` or removes the per-entry catch, this safety property would silently break.

**Recommendation:** Add one test case in 04-02:
- A batch containing one valid `ping` and one `prompts/get` that triggers an unexpected adapter failure
- Assert the batch response is still an array, with the valid entry returning a result and the failed entry returning a JSON-RPC error

This verifies the transport layer does not drop the entire batch on partial failure.

**Confidence:** 7/10 — current code likely handles this, but no test proves it.

---

### Issue A3: Error message sanitization must cover both harness and transport layers

04-02 Task 1 says: "If a representative thrown backend exception currently surfaces transport internals such as host, IP, or port numbers through `error.message`, sanitize the MCP-facing message while preserving actionable `error.data.code` metadata."

**Finding:** There are **two** layers where `error.message` leaks to remote clients:

1. **Harness catch** (`mcpBackendProxyAdapter.js:931-940`):
```javascript
catch (error) {
    return buildJsonRpcError(
        request.id,
        -32000,
        error.message || 'MCP adapter request failed',
        {
            code: error.code || MCP_ERROR_CODES.RUNTIME_ERROR,
            ...(error.details && typeof error.details === 'object' ? error.details : {})
        }
    );
}
```

2. **Transport catch** (`mcpWebSocketServer.js:296-307`):
```javascript
catch (error) {
    return createJsonRpcErrorResponse(
        requestWithContext.id,
        -32603,
        'Internal error',
        { details: error.message }
    );
}
```

Layer 1 leaks `error.message` in the JSON-RPC `error.message` field. Layer 2 leaks it in `error.data.details`. If `GatewayBackendClient` throws `ECONNREFUSED 192.168.1.50:8080`, that string can reach the client through either path.

**Recommendation:** Add a shared helper `sanitizeMcpErrorMessage(message)` that strips common network topology patterns:
- `/\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}(:\d+)?\b/g` (IPv4 addresses)
- `/\b[a-z]+:\/\/[^\s]+/gi` (URLs)
- `/ECONNREFUSED\s+\S+/gi` (connection refused with host)

Apply it in **both** catch blocks before building the JSON-RPC error. Preserve the original message in server-side logs (stderr) only. The 04-02 plan should explicitly mention sanitizing the transport layer catch in addition to the harness catch.

**Confidence:** 9/10 — verified by reading both catch blocks.

---

### Issue A4: Sequential batch processing is safe but may be slow for large batches

The websocket server processes batch entries sequentially (`for` loop with `await`). With `DEFAULT_MAX_BATCH_SIZE = 20`, the worst case is 20 sequential harness calls. Since each harness call may involve async backend I/O, a full batch of capability calls could take noticeable time.

**Finding:** This is not a Phase 4 concern because:
- Max batch size is small (20)
- Typical MCP discovery batches are 2-3 calls
- Sequential processing prevents backend stampede and simplifies error handling

**Recommendation:** None for Phase 4. If batch latency becomes an issue in Phase 5, consider parallel dispatch with individual error catching.

**Confidence:** 8/10 — observation, not a defect.

---

## 2. Code Quality Review

### Issue Q1: `agent-gateway-mcp-websocket.test.js` is already 845 lines — watch for test file bloat

Adding 12+ new tests (6 from 04-01, 6 from 04-02) could push this file past 1000 lines. The existing file already mixes stub-harness tests, real-harness tests, batch tests, auth tests, and lifecycle tests.

**Finding:** The plan correctly requires extracting a `createRealHarnessFixture` helper, which will reduce duplication. But even with that, the file will be large.

**Recommendation:** Consider splitting the websocket test file into two files during 04-01:
- `agent-gateway-mcp-websocket.test.js` — transport-layer tests (auth, framing, batch, lifecycle)
- `agent-gateway-mcp-websocket-capability.test.js` — capability-layer tests (discovery, invocation, error contracts)

This is a 5-minute refactor with high readability payoff. It mirrors the existing separation between `agent-gateway-mcp-transport.test.js` (stdio capability tests) and `agent-gateway-mcp-adapter.test.js` (adapter unit tests).

**Confidence:** 7/10 — not a bug, but a maintainability signal.

---

### Issue Q2: Mixed fixture strategies need explicit guardrails

04-01 Task 2 says:
> "If the full native backend path is still too heavy for one representative memory operation, document the exception inline and inject a deterministic mock harness only for that specific test; do not silently mix fixture strategies."

**Finding:** This is a reasonable escape hatch, but "document the exception inline" is vague. Without a concrete marker (e.g., a code comment template or a specific test naming convention), future readers won't know which tests use real vs mock fixtures.

**Recommendation:** Enforce a naming convention:
- Tests using real harness: `test('real harness: ...')`
- Tests using mock harness: `test('mock harness: ...')`
- Or add a JSDoc tag: `@fixture real-harness` / `@fixture mock-harness`

Alternatively, never mix fixtures in the same file. If a mock is needed, put that test in a separate file with "mock" in the filename.

**Confidence:** 6/10 — medium confidence this will cause confusion in 3 months.

---

### Issue Q3: DRY violation — `createNativeServer` is duplicated across test files

`agent-gateway-mcp-transport.test.js` (line 63-86), `agent-gateway-mcp-adapter.test.js` (line 46-68), and `agent-gateway-mcp-websocket.test.js` (implied by inline backend setup) all contain nearly identical `createNativeServer` functions.

**Finding:** The plans do not address this duplication. Extracting `createRealHarnessFixture` in the websocket test is a good start, but the broader duplication across test files remains.

**Recommendation:** Move `createNativeServer` into `test/agent-gateway/helpers/agent-gateway-test-helpers.js`. This is a 2-minute refactor that reduces ~60 lines of duplication across 3 files.

**Confidence:** 9/10 — verified by reading all three files.

---

### Issue Q4: `mcpBackendProxyAdapter.js` at 950 lines is approaching refactor territory

The adapter file is large but well-organized by function. Phase 4 only requires "minimal scope or metadata adjustments," so no immediate action is needed.

**Finding:** If Phase 4 execution reveals the need for more than ~20 lines of adapter changes, that signals the adapter's remote-surface contract may be fundamentally misaligned with the WebSocket transport expectations. In that case, pause and reassess whether the issue is in the adapter or in the transport's context injection.

**Recommendation:** Track adapter diff size during 04-01 execution. If changes exceed 50 lines, escalate for architecture review before proceeding to 04-02.

**Confidence:** 7/10 — heuristic, not a concrete bug.

---

### Issue Q5: No issue found in error handling patterns

The existing error handling is already well-structured:
- `createMcpError` for request-level validation failures
- `createFailureResult` for tool-result-level failures with `isError: true`
- `mapGatewayFailureToMcpErrorCode` for canonical Gateway code translation
- Harness `try/catch` for unexpected exceptions

04-02 correctly audits all of these paths. No code quality concerns beyond the two-layer sanitization gap noted in A3.

---

## 3. Test Review

### Test Framework

**Runtime:** Node.js (`node:test` built-in test runner)
**Framework:** Native Node.js test runner (no Jest/Vitest)
**Command:** `node --test test/agent-gateway/adapters/agent-gateway-mcp-websocket.test.js`

### Coverage Diagram

```
CODE PATHS (WebSocket → Harness → Adapter)
[+] modules/agentGateway/mcpWebSocketServer.js
  ├── handleUpgrade + auth
  │   ├── [★★★ TESTED] gateway key auth
  │   ├── [★★★ TESTED] bearer token auth
  │   └── [★★★ TESTED] unauthenticated rejection
  ├── connection context injection
  │   ├── [★★★ TESTED] sessionId overwrite
  │   ├── [★★★ TESTED] authContext canonicalization
  │   └── [★★  TESTED] forged metadata rejection
  ├── JSON-RPC message handling
  │   ├── [★★★ TESTED] single request/response
  │   ├── [★★★ TESTED] batch requests (happy path)
  │   ├── [★★★ TESTED] batch with notifications
  │   ├── [★★★ TESTED] all-notification batch (no response)
  │   ├── [★★★ TESTED] empty batch rejection
  │   ├── [★★★ TESTED] oversized batch rejection
  │   └── [★★★ TESTED] malformed batch member
  ├── lifecycle
  │   ├── [★★★ TESTED] initialize
  │   ├── [★★★ TESTED] notifications/initialized
  │   └── [★★★ TESTED] ping
  ├── heartbeat
  │   ├── [★★★ TESTED] native ping/pong keepalive
  │   └── [★★★ TESTED] stale client termination
  └── harness dispatch
      ├── [★★   TESTED] stub harness echo
      ├── [★★   TESTED] real harness tools/list (1 test)
      ├── [GAP]          real harness prompts/list
      ├── [GAP]          real harness prompts/get
      ├── [GAP]          real harness tools/call (memory ops)
      ├── [GAP]          batch capability requests
      └── [GAP]          connection drop during capability call

[+] modules/agentGateway/adapters/mcpBackendProxyAdapter.js
  ├── listTools()
  │   ├── [★★★ TESTED] stdio — includes gateway-managed tools
  │   ├── [★★★ TESTED] stdio — excludes gateway_agent_render
  │   └── [GAP]          websocket — same assertions
  ├── listPrompts()
  │   ├── [★★★ TESTED] stdio — includes gateway_agent_render
  │   └── [GAP]          websocket — same assertions
  ├── getPrompt()
  │   ├── [★★★ TESTED] stdio — renders prompt
  │   ├── [GAP]          websocket — renders prompt
  │   ├── [★★★ TESTED] adapter — unsupported prompt error
  │   └── [GAP]          websocket — unsupported prompt error
  ├── callTool()
  │   ├── [★★★ TESTED] stdio — memory search
  │   ├── [★★★ TESTED] stdio — context assemble
  │   ├── [★★★ TESTED] stdio — memory write
  │   ├── [★★★ TESTED] adapter — diary policy rejection
  │   ├── [★★★ TESTED] adapter — unknown tool
  │   ├── [★★★ TESTED] adapter — gateway_agent_render redirect
  │   └── [GAP]          websocket — all of the above
  ├── readResource()
  │   ├── [★★  TESTED] adapter — unsupported URI
  │   └── [GAP]          websocket — unsupported URI error contract
  └── error paths
      ├── [★★★ TESTED] adapter — mapGatewayFailureToMcpErrorCode
      ├── [★★★ TESTED] adapter — createFailureResult shape
      ├── [GAP]          websocket — raw stack trace negative assertion
      ├── [GAP]          websocket — raw connection string negative assertion
      └── [GAP]          websocket — transport-layer catch sanitization

USER FLOWS
[+] Remote MCP client discovers capabilities
  ├── [GAP] [→E2E] Open WS → initialize → tools/list → prompts/list
  └── [GAP] [→E2E] Open WS → initialize → prompts/get → verify content

[+] Remote MCP client invokes memory tools
  ├── [GAP] [→E2E] tools/call gateway_memory_search → structured result
  ├── [GAP] [→E2E] tools/call gateway_context_assemble → structured result
  └── [GAP] [→E2E] tools/call gateway_memory_write → structured result

[+] Remote MCP client handles errors
  ├── [GAP] [→E2E] Invalid prompt → JSON-RPC error with MCP code
  ├── [GAP] [→E2E] Tool policy failure → isError:true with code
  └── [GAP] [→E2E] Resource failure → MCP-standard error

COVERAGE: 18/46 paths tested (39%)  |  Code paths: 18/39 (46%)  |  User flows: 0/7 (0%)
QUALITY: ★★★:14 ★★:4 ★:0  |  GAPS: 28 (9 E2E-worthy)
```

### Test Gaps (to be closed by Phase 4)

The gaps above map directly to the Phase 4 plans. Both plans are well-specified and should close the gaps. Additional gaps identified:

1. **Batch capability requests** — No plan mentions testing a batch that contains `tools/list` + `prompts/get`. This is a realistic client behavior (some MCP clients batch discovery calls). 04-01 Task 1 requires "one real-harness batch discovery call containing `tools/list`, `prompts/list`, and `prompts/get`" which covers this.
2. **Connection drop during capability call** — What happens if the client closes the WebSocket while `gateway_memory_search` is still executing? Current transport code (`WebSocketTransport.send()`) silently drops messages to closed sockets, and the queue catch block prevents unhandled rejections. The code is safe but untested.
3. **Notification error handling** — If a notification (no `id`) fails during processing, the error is logged to stderr but the client receives no response. Per JSON-RPC spec this is correct, but there is no test proving the server does not crash or send an unexpected response.
4. **Transport-layer catch sanitization** — The websocket server's `dispatchRequest` catch returns `error.message` in `error.data.details`. This is a separate leakage path from the harness catch. Needs explicit negative assertions.

**Recommendation for gap 2:** Add one test in 04-01 or 04-02: start a `tools/call`, terminate the client mid-flight, assert no unhandled rejection and no server crash.

**Confidence:** 8/10 for gaps 1-2; 6/10 for gap 3 (may be over-testing); 9/10 for gap 4.

### Regression Rule Check

Phase 4 modifies `mcpBackendProxyAdapter.js` only for "minimal scope or metadata adjustments." If any existing behavior changes, a regression test must be added to `agent-gateway-mcp-transport.test.js` or `agent-gateway-mcp-adapter.test.js`. 04-02 already requires parity checks in the transport test, which satisfies the regression rule.

---

## 4. Performance Review

### Issue P1: No performance concerns for Phase 4

Phase 4 is test-heavy and code-light. The only production code changes are minimal adapter adjustments. No new I/O paths, no new database queries, no new caching layers.

**Observations:**
- `mcpWebSocketServer.js` processes batch requests sequentially. With `DEFAULT_MAX_BATCH_SIZE = 20`, the worst-case latency is 20 sequential harness calls. This is acceptable for Phase 4.
- Each WebSocket connection maintains a `heartbeatTimer` (setInterval). At 100 concurrent connections, that's 100 intervals firing every 30 seconds. Negligible overhead.
- The `connections` Map in `mcpWebSocketServer.js` grows unbounded up to the connection limit (enforced in Phase 5). For Phase 4 testing, this is not a concern.

**Recommendation:** None. Performance review passes with no issues.

---

## NOT in Scope

| Item | Rationale |
|------|-----------|
| Connection limits (`VCP_MCP_WS_MAX_CONNECTIONS`) | Deferred to Phase 5 (OP-01) |
| Per-connection rate limiting | Deferred to Phase 5 (OP-04) |
| Maximum JSON-RPC payload size enforcement | Deferred to Phase 5 (OP-05) |
| Upgrade auth timeout guard (`WR-02`) | Deferred to Phase 5 (explicitly acknowledged in STATE.md) |
| Server-initiated `listChanged` push notifications | Deferred to v2 (requires capability event emission) |
| Resource success-path expansion | Deferred to v2 (broad feature area) |
| New prompt/tool descriptor families | Out of scope — Phase 4 only exposes existing surfaces |
| Changes to RAG/memory data model or indexing | Out of scope — business logic stays in Gateway Core |
| OAuth 2.1 or complex auth flows | Out of scope — reuse existing gateway key / bearer token |
| `agent-gateway-mcp-websocket.test.js` file split | Recommended but not required for Phase 4 closure |
| `createNativeServer` DRY extraction across test files | Recommended cleanup, not blocking |
| Parallel batch dispatch optimization | Not needed — sequential is safe and simple |

---

## What Already Exists

| Component | What it provides | Plan reuse |
|-----------|-----------------|------------|
| `mcpBackendProxyAdapter.js` | Full remote capability surface (tools, prompts, resources) and MCP error mapping | Reuses — minimal adjustments only |
| `mcpWebSocketServer.js` | WebSocket transport, auth, session injection, batching, heartbeat | Reuses — no changes planned |
| `mcpStdioServer.js` | Stdio transport using `StdioTransport` class | Reuses — no changes planned |
| `agent-gateway-mcp-transport.test.js` | Stdio capability discovery and invocation tests | Serves as executable contract reference |
| `agent-gateway-mcp-adapter.test.js` | Adapter-level error mapping and policy tests | Serves as error contract reference |
| `agent-gateway-mcp-websocket.test.js` | WebSocket auth, framing, batch, lifecycle tests | Extended with capability + error coverage |
| `agent-gateway-test-helpers.js` | `createPluginManager`, `createKnowledgeBaseManager`, `createRagPlugin` | Extended with richer fixture for prompt tests |

---

## Failure Modes

| Codepath | Realistic failure | Test covers? | Error handling? | User sees? |
|----------|-------------------|--------------|-----------------|------------|
| `tools/list` over WS | Backend client timeout | 04-01 (indirectly) | Harness catch → JSON-RPC error | JSON-RPC error with MCP code |
| `prompts/get` over WS | Agent registry missing | 04-02 (planned) | Adapter throws → harness catch | JSON-RPC error with MCP code |
| `tools/call` memory search | Diary policy rejection | 04-02 (planned) | Adapter returns `createFailureResult` | Tool result with `isError: true` |
| `tools/call` unknown tool | Unknown tool name | 04-02 (planned) | Adapter throws `createMcpError` | JSON-RPC error with `NOT_FOUND` |
| `resources/read` invalid URI | Unsupported URI template | 04-02 (planned) | Adapter throws `createMcpError` | JSON-RPC error with `RESOURCE_UNSUPPORTED` |
| Backend network failure | `ECONNREFUSED host:port` | **GAP** | Harness catch passes raw message | **Critical gap: raw connection string leaked** |
| Transport unexpected failure | Null dereference in adapter | **GAP** | Transport catch passes raw message in `details` | **Critical gap: raw message leaked via transport layer** |
| Batch partial failure | One entry throws unexpectedly | **GAP** | Sequential dispatch with per-entry catch | Handled correctly, but untested |
| Client disconnect mid-call | WS closes during backend call | **GAP** | Transport send silently drops | Safe (no crash), but untested |
| Notification failure | Invalid notification payload | **GAP** | Logged to stderr, no response | Safe per spec, but untested |

**Critical gaps flagged:** 4

1. **Backend network failure message leakage (harness layer)** — Addressed in A3. Needs explicit test in 04-02.
2. **Unexpected transport-layer error leakage** — `mcpWebSocketServer.js:306` returns `error.message` in `error.data.details`. Needs sanitization and test in 04-02.
3. **Batch partial failure** — Code handles it correctly, but untested. Needs explicit test in 04-02.
4. **Client disconnect mid-call** — Code is safe (`WebSocketTransport.send` drops silently), but untested. Needs explicit test in 04-01 or 04-02.

---

## Worktree Parallelization Strategy

**Verdict:** Sequential implementation, no parallelization opportunity.

Both 04-01 and 04-02 touch the same two primary files:
- `test/agent-gateway/adapters/agent-gateway-mcp-websocket.test.js`
- `modules/agentGateway/adapters/mcpBackendProxyAdapter.js`

04-02 depends on 04-01 (per `depends_on: ["01"]` in the plan metadata). Even if dependency were removed, the shared test file creates merge conflicts. Execute sequentially: 04-01 first, then 04-02.

---

## Diagrams Recommended

The plans lack ASCII diagrams for the error flow. Recommend adding this inline in 04-02-PLAN.md:

```
Remote Client → /mcp WebSocket → mcpWebSocketServer.js → harness.handleRequest()
                                                                    |
                                    +-------------------------------+-------------------------------+
                                    |                                                               |
                            Expected failure                                              Unexpected failure
                            (validation, not-found)                                       (network, null ref)
                                    |                                                               |
                            adapter throws createMcpError()                               harness catch block
                                    |                                                               |
                            JSON-RPC error response                                       JSON-RPC error response
                            code: -32000                                                code: -32000
                            data.code: MCP_*                                            data.code: MCP_RUNTIME_ERROR
                            data.details: safe                                          data.message: SANITIZED
                                    |                                                               |
                                    +-------------------------------+-------------------------------+
                                                                    |
                                                            transport.send()
                                                                    |
                                    +-------------------------------+-------------------------------+
                                    |                                                               |
                            If harness handled it                                              If harness threw unexpectedly
                            (returns JSON-RPC error)                                           (transport catch fires)
                                    |                                                               |
                            Sent as-is                                                        code: -32603
                                                                                                message: "Internal error"
                                                                                                data.details: SANITIZED
```

---

## Completion Summary

| Section | Result |
|---------|--------|
| Step 0: Scope Challenge | Scope accepted as-is — Phase 4 is verification work, appropriately scoped |
| Architecture Review | 4 issues found (A1-A4: shared harness documentation, batch partial failure, two-layer error sanitization, sequential batch processing) |
| Code Quality Review | 4 issues found (Q1-Q4: test file bloat, mixed fixtures, DRY violation, adapter size watch) |
| Test Review | Diagram produced, 28 gaps identified (most mapped to plan tasks), 4 additional gaps recommended |
| Performance Review | 0 issues found |
| NOT in scope | 11 items deferred/excluded |
| What already exists | 7 components reused |
| TODOS.md updates | 0 items — no TODOS.md exists; deferred items tracked in STATE.md |
| Failure modes | 4 critical gaps flagged (harness message leakage, transport message leakage, batch partial failure untested, disconnect mid-call untested) |
| Outside voice | Skipped — scope is verification-only, low architectural risk |
| Parallelization | Sequential — shared files, explicit dependency |
| Lake Score | Plans already chose complete option (real harness tests, not stubs) |

---

## Unresolved Decisions

None. This is a review-only document. All recommendations are advisory and require explicit user approval before implementation.

---

## Review Log

```json
{"skill":"plan-eng-review","timestamp":"2026-04-26T12:30:00Z","status":"issues_open","unresolved":0,"critical_gaps":4,"issues_found":8,"mode":"FULL_REVIEW","commit":"de7c808"}
```
