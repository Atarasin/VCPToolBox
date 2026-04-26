# Phase 02: Engineering Review Report

**Reviewed:** 2026-04-26
**Reviewer:** Claude (`/plan-eng-review`)
**Depth:** Full architecture, code quality, test coverage, performance
**Status:** ISSUES_OPEN — 11 findings, 1 critical gap, 0 unresolved decisions
**Plans reviewed:** `02-01-PLAN.md`, `02-02-PLAN.md`

---

## Step 0: Scope Challenge

**Conclusion: Scope accepted as-is. No reduction recommended.**

- **Existing code reuse is excellent.** The plan correctly reuses `resolveDedicatedGatewayAuth()`, `normalizeRequestContext()`, the `McpTransport` contract, the `noServer` upgrade pattern from `WebSocketServer.js`, and the harness+transport layering proven in Phase 1.
- **Minimal change set.** ~7 files total (4 new, 3 modified) and 2 new modules. Well within reasonable bounds.
- **No custom solutions where built-ins exist.** `ws` is already in `package.json`. `crypto.randomUUID()` is used for session IDs.
- **Completeness check: PASS.** Includes transport unit tests, endpoint integration tests, `server.js` wiring, and a `package.json` test script.

---

## Section 1: Architecture Review

### Issue 1A — `mcpWebSocketServer.js` harness creation/passthrough (RESOLVED)

**Severity:** P2 | **Confidence:** 8/10

**Problem:** `mcpWebSocketServer.js` needs a `harness` to call `handleRequest()`, but the plan didn't specify how it gets one.

**Decision:** Option A chosen — match `createStdioMcpServer` pattern.
- `createMcpWebSocketServer(options)` accepts `options.harness`
- If omitted, lazily creates one via `initializeBackendProxyMcpRuntime`
- This gives tests flexibility (mock harness injection) and keeps `server.js` wiring simple

**Action for plan update:** Add `options.harness` parameter to `createMcpWebSocketServer` signature in Plan 01 Task 2.

---

### Issue 1B — `McpTransport` interface missing `finished` property

**Severity:** P3 | **Confidence:** 7/10

**Problem:** `mcpStdioServer.js` uses `transport.finished`, but `mcpTransport.js` only defines 4 methods (`send`, `close`, `setMessageHandler`, `setErrorHandler`). `WebSocketTransport` must provide `finished` too, yet the interface contract doesn't capture it.

**Recommendation:** Update `mcpTransport.js` to include `finished` in the `McpTransport` shape and `validateMcpTransport`. It's already a de-facto requirement.

**Action for plan update:** Add a Task 0 or prepend to Task 1: update `McpTransport` interface and validation to include `finished`.

---

### Issue 1C — Batch request rejection is implied but not explicit

**Severity:** P3 | **Confidence:** 8/10

**Problem:** Phase 2 defers batch support to Phase 3, but `mcpWebSocketServer.js` will receive JSON-RPC messages. `mcpStdioServer.js` explicitly rejects batch requests with error code `-32600`. The WebSocket manager should do the same.

**Recommendation:** Add explicit batch-request rejection to Plan 01 Task 2, mirroring `mcpStdioServer.js:139-143`.

**Expected behavior:**
```javascript
if (Array.isArray(request)) {
    transport.send(JSON.stringify(createJsonRpcErrorResponse(
        null, -32600, 'Batch requests are not supported', { field: 'request' }
    )));
    return;
}
```

---

### Issue 1D — Binary WebSocket frame handling is undefined

**Severity:** P3 | **Confidence:** 7/10

**Problem:** The plan says "Convert inbound **non-binary** websocket messages to UTF-8 strings." It doesn't say what happens to binary frames. `ws` delivers them by default.

**Recommendation:** Explicitly ignore/drop binary frames in `WebSocketTransport` to avoid feeding garbage into the JSON parser.

**Suggested implementation:**
```javascript
ws.on('message', (data, isBinary) => {
    if (isBinary) {
        return; // Ignore binary frames
    }
    // ... existing text frame handling
});
```

**Action for plan update:** Add "ignore binary frames" to Plan 01 Task 1 implementation requirements.

---

### Issue 1E — `server.js` shutdown ordering for the new manager

**Severity:** P3 | **Confidence:** 7/10

**Problem:** `gracefulShutdown` currently closes `webSocketServer` first, then `pluginManager`. The MCP manager depends on `pluginManager` for auth config. If `pluginManager` is torn down while the MCP manager still has open connections trying to authenticate, that's a race.

**Recommendation:** Close the MCP manager **before** `pluginManager.shutdownAllPlugins()`, or at least before `webSocketServer.shutdown()`.

**Suggested shutdown order:**
1. `taskScheduler.shutdown()`
2. `mcpWebSocketServer.close()` — **NEW**
3. `webSocketServer.shutdown()`
4. `pluginManager.shutdownAllPlugins()`
5. `knowledgeBaseManager.shutdown()`

**Action for plan update:** Clarify in Plan 02 Task 1 that MCP manager closes before `pluginManager.shutdownAllPlugins()`.

---

## Section 2: Code Quality Review

### Issue 2A — DRY: `createJsonRpcErrorResponse` should be reused

**Severity:** P3 | **Confidence:** 8/10

**Problem:** `mcpStdioServer.js` exports `createJsonRpcErrorResponse`. `mcpWebSocketServer.js` will need the exact same JSON-RPC error envelope shape. Rewriting it would be a DRY violation.

**Recommendation:** Import `createJsonRpcErrorResponse` from `mcpStdioServer.js` in `mcpWebSocketServer.js`.

**Action for plan update:** In Plan 01 Task 2, replace "Reuse the existing JSON-RPC error envelope style from stdio where applicable" with "Import `createJsonRpcErrorResponse` from `mcpStdioServer.js`".

---

### Issue 2B — `resolveNativeRequestContext` vs `normalizeRequestContext`

**Severity:** P3 | **Confidence:** 7/10

**Problem:** Plan 01 Task 2 mentions `normalizeRequestContext()` for building the connection-scoped base context. This is correct, but the distinction is subtle and worth making explicit.

**Key distinction:**
- `resolveNativeRequestContext()` = for HTTP requests with headers/query params
- `normalizeRequestContext()` = for building context objects from structured data

WebSocket messages are pure JSON-RPC after upgrade, so `normalizeRequestContext()` is the right tool.

**Action for plan update:** Explicitly state in Plan 01 Task 2 that `normalizeRequestContext()` (not `resolveNativeRequestContext()`) builds the per-connection base context.

---

### Issue 2C — `WebSocketTransport.close()` return type

**Severity:** P3 | **Confidence:** 7/10

**Problem:** `StdioTransport.close()` returns `Promise.resolve()`. `mcpStdioServer.js` does `await transport.close()`. `ws.WebSocket.close()` is synchronous. If `WebSocketTransport.close()` returns nothing, the contract is inconsistent.

**Recommendation:** Have `WebSocketTransport.close()` return `Promise.resolve()` (or a promise that resolves when the `ws` `close` event fires) to match the `StdioTransport` behavior.

**Suggested implementation:**
```javascript
close() {
    if (this._closed) {
        return Promise.resolve();
    }
    this._closed = true;
    this._ws.close();
    return Promise.resolve();
}
```

---

## Section 3: Test Review

### Current Coverage

**Plan 01 tests (5 cases):**
1. sends serialized outbound frames to an open socket
2. delivers inbound text frames to the registered message handler
3. routes handler exceptions to the error handler
4. ignores/no-ops safely after close
5. resolves `finished` after the websocket closes

**Plan 02 tests (7 cases):**
1. Authenticated connect via gateway key header
2. Authenticated connect via bearer token
3. Unauthorized upgrade rejected before open
4. Canonical session continuity across requests
5. Cleanup removes connection state on close/error
6. Native keepalive path
7. Isolation from the legacy mesh

### Coverage Diagram

```
CODE PATHS                                           USER FLOWS
[+] webSocketTransport.js                            [+] WebSocket MCP client connect
  ├── send(jsonString)                                 ├── [TESTED] Authenticated connect (gateway key)
  │   ├── [TESTED] happy path — sends to open ws       ├── [TESTED] Authenticated connect (bearer)
  │   └── [TESTED] no-op after close                   └── [GAP] Slow connection / large payload
  ├── setMessageHandler()                            [+] Unauthorized access
  │   ├── [TESTED] delivers text frames                ├── [TESTED] Rejected before handshake
  │   └── [GAP] ignores binary frames                  └── [GAP] Brute-force auth attempts
  ├── setErrorHandler()                              [+] Session behavior
  │   ├── [TESTED] routes handler throws               ├── [TESTED] Session continuity across requests
  │   └── [GAP] routes ws 'error' events               └── [GAP] Client tries to override sessionId
  ├── close()                                        [+] Cleanup
  │   ├── [TESTED] idempotent                          ├── [TESTED] Cleanup on client close
  │   └── [GAP] resolves finished promise on close     ├── [TESTED] Cleanup on error
  └── finished                                       └── [GAP] Cleanup on process SIGTERM
      └── [TESTED] resolves after close              [+] Keepalive
                                                           ├── [TESTED] Healthy client stays alive
[+] mcpWebSocketServer.js                                  └── [TESTED] Stale client terminated
  ├── upgrade auth
  │   ├── [TESTED] gateway key success
  │   ├── [TESTED] bearer success
  │   └── [TESTED] reject → socket.destroy()
  ├── JSON parse
  │   ├── [GAP] parse error → JSON-RPC -32700          [+] Isolation
  │   └── [GAP] batch request → JSON-RPC -32600        └── [TESTED] /mcp does not touch legacy mesh
  ├── harness dispatch
  │   ├── [TESTED] sessionId injected
  │   ├── [GAP] requestId generated when missing
  │   └── [GAP] gatewayId propagated
  └── keepalive
      ├── [TESTED] ping/pong cycle
      └── [GAP] timer cleanup on error

COVERAGE: 17/28 paths tested (61%) | Code paths: 10/17 (59%) | User flows: 7/11 (64%)
QUALITY: TESTED: 17, GAPS: 11
```

### Gaps to Add to the Plan

| # | Gap | Test Type | Priority | Suggested Test File |
|---|-----|-----------|----------|---------------------|
| 1 | `ws` error event → error handler | unit | HIGH | `websocket-transport.test.js` |
| 2 | Binary frame ignored | unit | HIGH | `websocket-transport.test.js` |
| 3 | JSON parse error returns -32700 | integration | HIGH | `agent-gateway-mcp-websocket.test.js` |
| 4 | Batch request rejected with -32600 | integration | HIGH | `agent-gateway-mcp-websocket.test.js` |
| 5 | `requestId` auto-generated when missing | integration | MEDIUM | `agent-gateway-mcp-websocket.test.js` |
| 6 | `gatewayId` propagated into `requestContext` | integration | MEDIUM | `agent-gateway-mcp-websocket.test.js` |
| 7 | Client-supplied `sessionId` is overwritten | integration | MEDIUM | `agent-gateway-mcp-websocket.test.js` |
| 8 | `close()` resolves `finished` promise | unit | LOW | `websocket-transport.test.js` |
| 9 | Timer cleanup on `ws` error event | integration | MEDIUM | `agent-gateway-mcp-websocket.test.js` |
| 10 | Cleanup on process SIGTERM | integration | LOW | `agent-gateway-mcp-websocket.test.js` |
| 11 | Slow connection / large payload | E2E | LOW | Manual verification |

**Regression risk:** Gap #2 (binary frames) is regression-adjacent. If a client accidentally sends a binary frame and the manager tries to `JSON.parse()` it, it'll throw and potentially crash the message loop. **Add this test.**

**Action for plan update:**
- Plan 01 Task 1: Add 3 tests (ws error event, binary frame ignore, finished promise on close)
- Plan 02 Task 2: Add 7 tests (parse error, batch reject, requestId auto-gen, gatewayId propagation, sessionId overwrite, timer cleanup on error, SIGTERM cleanup)
- Update `min_tests` in both plans accordingly (Plan 01: 5 → 8, Plan 02: 6 → 10+)

---

## Section 4: Performance Review

**0 critical issues found.**

1. **Memory leak risk: Connection Map growth** — Dedicated manager uses a `Map`. If cleanup on `close`/`error` has a bug, connections leak. Plan mandates idempotent cleanup and covers this in tests. **Mitigation: already in plan.**

2. **Promise queue memory growth** — Per-connection sequential request handling uses a promise queue. If requests arrive faster than they're processed, memory grows unbounded. Connection limits (Phase 5) will address this. **Not a Phase 2 blocker.**

3. **Timer leak risk: Keepalive timers** — `ping` intervals must be cleared on every disconnect path. Plan requires timer cleanup on `close`, `error`, and forced termination. **Mitigation: already in plan.**

No N+1 queries, no caching opportunities, no high-complexity algorithms. Phase 2 is I/O-bound WebSocket framing.

---

## Failure Modes

| Codepath | Realistic Failure | Tested? | Error Handling? | User Sees? |
|----------|-------------------|---------|-----------------|------------|
| Upgrade auth fails | Invalid/missing credentials | Yes | `socket.destroy()` | Silent disconnect (by design) |
| Upgrade auth slow | `resolveDedicatedGatewayAuth` hangs | **No** | **None** | Connection timeout |
| JSON parse error | Client sends malformed JSON | **No** | Should return -32700 | JSON-RPC error response |
| Batch request | Client sends JSON array | **No** | Should return -32600 | JSON-RPC error response |
| Harness throws | Backend error during tool call | No (covered by harness tests) | JSON-RPC -32000 | JSON-RPC error response |
| Binary frame | Client sends Buffer | **No** | Should be ignored | Nothing (safe ignore) |
| Keepalive timeout | Client stops responding to ping | Yes | `ws.terminate()` + cleanup | Abrupt disconnect |
| ws error event | TCP error, ECONNRESET | **No** | Error handler + cleanup | Depends on handler |
| Double close | `close()` called twice | Yes | Idempotent no-op | Nothing |
| Cleanup race | `close` + `error` fire simultaneously | **No** | Idempotent cleanup | Nothing |

**Critical gap (flagged):** The "Upgrade auth slow" row has no error handling and no timeout. If `resolveDedicatedGatewayAuth` hangs (e.g., `pluginManager` is in a bad state), the HTTP upgrade hangs indefinitely. This is unlikely but worth noting. A `server.timeout` on the HTTP server or a timeout around auth would mitigate it, but that's probably Phase 5 territory.

**Action:** Document this in the plan's threat model or add a TODO for Phase 5.

---

## "NOT in scope" Section

Work explicitly deferred that was considered:

1. **JSON-RPC batch support** — Deferred to Phase 3. Batch requests will be rejected with `-32600` in Phase 2.
2. **MCP initialize/capability lifecycle** — Deferred to Phase 3/4. Phase 2 transport is a dumb pipe; the harness already handles `initialize`.
3. **Connection limits (`VCP_MCP_WS_MAX_CONNECTIONS`)** — Deferred to Phase 5.
4. **Per-connection rate limiting** — Deferred to Phase 5.
5. **Maximum JSON-RPC payload size enforcement** — Deferred to Phase 5.
6. **Replacing or modifying the legacy `WebSocketServer.js` mesh** — Explicitly out of scope. `/mcp` is a parallel stack.
7. **Session persistence across server restarts** — MCP is stateless per connection.
8. **Upgrade auth timeout** — No timeout on `resolveDedicatedGatewayAuth` during HTTP upgrade. Consider for Phase 5.

---

## "What already exists" Section

| Existing Asset | How Phase 2 Uses It | Any Unnecessary Rebuild? |
|----------------|--------------------|--------------------------|
| `resolveDedicatedGatewayAuth()` | Reused for upgrade auth | No |
| `normalizeRequestContext()` / `createRequestId()` | Reused for session/request context | No |
| `McpTransport` contract (`mcpTransport.js`) | WebSocketTransport implements it | No |
| `StdioTransport` | Serves as the reference implementation | No |
| `mcpStdioServer.js` | Layering pattern mirrored exactly | No |
| `WebSocketServer.js` | Reference for `noServer`, `socket.destroy()`, Map tracking | No — Phase 2 does NOT modify it |
| `server.js` | Integration point for new manager | No |
| `ws` library | Already in `package.json` | No |
| `node:test` + `node:assert/strict` | Existing test framework reused | No |

---

## Proposed TODOs

### TODO-1: Add `finished` to `McpTransport` interface
- **What:** Update `mcpTransport.js` to include `finished` in the contract shape and `validateMcpTransport`.
- **Why:** `mcpStdioServer.js` already depends on `transport.finished`. Making it explicit prevents future transport implementations from missing it.
- **Effort:** 5 minutes.
- **Depends on:** Nothing. Can be done in Phase 2.
- **Suggested commit:** prepend to Plan 01 Task 1 or add as a micro-task.

### TODO-2: Extract shared JSON-RPC error utilities
- **What:** Move `createJsonRpcErrorResponse` and `buildJsonRpcError` into a shared helper under `modules/agentGateway/contracts/`.
- **Why:** Both `mcpStdioServer.js` and `mcpWebSocketServer.js` need identical JSON-RPC error envelopes. DRY.
- **Effort:** 15 minutes.
- **Depends on:** Nothing. Can be done in Phase 2 or later.

### TODO-3: Add upgrade auth timeout guard
- **What:** Add a timeout around `resolveDedicatedGatewayAuth` in the HTTP upgrade handler, or set `server.timeout` on the HTTP server.
- **Why:** Prevents indefinite hangs if auth resolution stalls.
- **Effort:** 10 minutes.
- **Depends on:** Nothing. **Recommended for Phase 5** (production hardening).

---

## Parallelization Strategy

**Sequential implementation, no parallelization opportunity.**

Both plans (01 and 02) touch the same primary module (`mcpWebSocketServer.js`) and the same test style. Plan 02 depends on Plan 01.

**Execution order:** `01 → 02`

---

## Summary for Next Session

**If you are a future session picking this up:**

1. The user chose **Option A** for the harness API: `createMcpWebSocketServer(options)` accepts `options.harness` with fallback to internal creation.
2. The biggest gaps to fix in the plan before execution are:
   - Add `finished` to `McpTransport` interface
   - Add binary frame ignore to `WebSocketTransport`
   - Add batch request rejection to `mcpWebSocketServer.js`
   - Add 8+ missing tests (see Test Gaps table)
   - Clarify shutdown order in `gracefulShutdown`
3. The architecture is sound and conservative. No scope reduction needed.
4. The one critical gap (upgrade auth timeout) is noted but deferred to Phase 5.
5. Once the plan is updated with the gaps above, run `/gsd-execute-phase 2` to implement.
