# Domain Pitfalls: MCP Remote Access over WebSocket

**Domain:** Adding WebSocket remote transport to an existing local-only stdio MCP server (VCP Agent Gateway)
**Researched:** 2026-04-24
**Confidence:** HIGH (derived from codebase analysis + MCP SDK v1/v2 documentation via Context7)

## Critical Pitfalls

Mistakes that cause rewrites, security incidents, or production outages.

### Pitfall 1: Authenticating After WebSocket Upgrade (Auth Bypass)

**What goes wrong:** The transport completes the WebSocket handshake unconditionally, then expects the client to send an `initialize` or auth message over the open socket. An unauthenticated attacker now holds an open WebSocket and can probe the MCP surface, send malformed JSON-RPC to crash the parser, or exhaust connection slots.

**Why it happens:** The `ws` library's `handleUpgrade` pattern makes it tempting to accept the socket first and validate later. The existing `WebSocketServer.js` already authenticates at upgrade time (path regex + VCP_Key match before `handleUpgrade`), but the MCP `/mcp` endpoint uses a different auth model (headers/query params vs pathname embedding).

**Consequences:**
- Unauthorized clients can open connections and consume the `VCP_MCP_WS_MAX_CONNECTIONS` pool
- Attackers can send malicious JSON-RPC payloads before any auth gate
- Connection-level DoS without ever presenting valid credentials

**Prevention:**
- Validate `x-agent-gateway-key` or `Authorization: Bearer` during the HTTP upgrade handshake, before calling `wssInstance.handleUpgrade()`
- On auth failure, call `socket.destroy()` immediately — do not complete the WebSocket handshake
- Do not accept query-param auth as primary; use it only as fallback for browser clients
- Reuse `resolveDedicatedGatewayAuth` from `protocolGovernance.js` against `request.headers` at upgrade time

**Warning signs:**
- Tests show `ws.readyState === WebSocket.OPEN` before any auth validation
- Connection logs show accepted sockets from unknown IPs with no gateway key
- `wssInstance.clients.size` grows even when auth should reject

**Phase to address:** Phase 1 (transport foundation). Auth must be designed into the upgrade handler from day one; retrofitting it later requires changing the connection lifecycle.

---

### Pitfall 2: Shared Harness with Unscoped Request Context (Session Bleed)

**What goes wrong:** The `createBackendProxyMcpServerHarness` singleton is shared across stdio and all WebSocket connections. If the WebSocket transport fails to inject a per-connection `sessionId` into `params.requestContext`, all remote clients share the same session identity. Memory search results, job tracking, and context assembly bleed across clients.

**Why it happens:** The existing stdio transport has exactly one consumer, so `requestContext` is whatever the caller provides. With multiple concurrent WebSocket connections, the harness must distinguish callers. The design doc calls for per-connection `requestContext` injection, but it's easy to miss in the adapter layer.

**Consequences:**
- Client A's `memory_search` results include Client B's diary entries
- Job IDs created by one client are visible to another
- Deferred job polling (`gateway_job_get`) crosses session boundaries

**Prevention:**
- In `McpWebSocketTransport`, generate a unique `connectionSessionId` (e.g., `ws-${clientId}`) at connection open
- Wrap every `harness.handleRequest(request)` call to merge the connection session into `params.requestContext`:
  ```javascript
  const scopedRequest = {
    ...request,
    params: {
      ...request.params,
      requestContext: {
        ...(request.params?.requestContext || {}),
        sessionId: this.connectionSessionId
      }
    }
  };
  ```
- Do not let clients override the injected `sessionId` (treat transport-scoped fields as authoritative)
- Audit `mcpBackendProxyAdapter.js` to ensure it reads `sessionId` from `requestContext` consistently

**Warning signs:**
- Two simultaneous WebSocket clients see identical `tools/list` meta or job results
- `sessionId` is missing from backend client logs for WebSocket requests
- Fuzz tests with concurrent connections show cross-contamination in memory search

**Phase to address:** Phase 1 (transport foundation). Must be built into the WebSocket transport wrapper; cannot be bolted on later without refactoring the request pipeline.

---

### Pitfall 3: No Connection Limits or Backpressure (Resource Exhaustion)

**What goes wrong:** The WebSocket server accepts unlimited concurrent connections. Each connection holds a `ws` object, buffers incoming frames, and may have in-flight backend HTTP requests. Under load, the process runs out of memory or file descriptors, or the event loop stalls processing a backlog of JSON-RPC messages.

**Why it happens:** The existing `WebSocketServer.js` has no global connection limit enforcement. The design doc mentions a 100-connection default but does not specify where or how it is enforced. Node.js `ws` does not apply backpressure automatically for text frames.

**Consequences:**
- Memory exhaustion from unbounded `ws` objects and message buffers
- Event loop blocking from processing a flood of JSON-RPC requests without rate limiting
- Denial of service for the stdio transport and other WebSocket routes (VCPLog, AdminPanel)

**Prevention:**
- Enforce `VCP_MCP_WS_MAX_CONNECTIONS` in the upgrade handler before `handleUpgrade()`:
  ```javascript
  if (mcpConnectionCount >= maxConnections) {
    socket.destroy();
    return;
  }
  ```
- Track `mcpConnectionCount` with `++` on successful upgrade and `--` on `ws.on('close')`
- Apply per-connection message rate limiting (e.g., max 100 messages/sec) using a token bucket or simple counter
- For backend calls inside `handleRequest`, ensure `GatewayBackendClient` requests do not pile up indefinitely; consider a per-connection in-flight request cap

**Warning signs:**
- `process.memoryUsage().heapUsed` grows linearly with connection count and never drops
- `lsof` shows thousands of open file descriptors
- Event loop lag spikes under moderate load (measure with `process.hrtime` or a monitoring library)

**Phase to address:** Phase 1 (transport foundation). Connection limiting must be in the upgrade handler. Rate limiting can be added in Phase 2 but the limit counter must exist from the start.

---

### Pitfall 4: Conflicting Heartbeat with ChromeObserver

**What goes wrong:** The WebSocket transport implements an application-level heartbeat (JSON message with `type: 'heartbeat'`). This collides with the existing `ChromeObserver` client type in `WebSocketServer.js`, which already uses `type: 'heartbeat'` / `type: 'heartbeat_ack'`. The MCP transport handler may misroute or drop these messages, or ChromeObserver logic may interfere with MCP connections.

**Why it happens:** `WebSocketServer.js` routes all messages through a single `ws.on('message')` handler that branches on `ws.clientType`. If MCP connections are stored in a generic `clients` Map (like VCPLog), their heartbeat messages hit the generic `else` branch and may be ignored or misrouted.

**Consequences:**
- MCP clients time out because heartbeat acks are not sent
- ChromeObserver logic fires on MCP messages, causing console noise or unexpected behavior
- The unified `clients` Map makes it impossible to distinguish MCP connections for targeted cleanup

**Prevention:**
- Use native WebSocket ping/pong frames (built into `ws`) for MCP keepalive, not application-level JSON messages. This avoids collision with ChromeObserver entirely:
  ```javascript
  ws.on('ping', () => ws.pong());
  ws.isAlive = true;
  const heartbeat = setInterval(() => {
    if (!ws.isAlive) { ws.terminate(); return; }
    ws.isAlive = false;
    ws.ping();
  }, 30000);
  ws.on('pong', () => { ws.isAlive = true; });
  ```
- Store MCP connections in a dedicated `mcpClients` Map (or Set) separate from `clients`, `chromeObserverClients`, etc.
- In `ws.on('close')`, clean up from the correct Map based on `ws.clientType === 'MCP'`

**Warning signs:**
- MCP connections drop after 30-60 seconds despite active use
- Logs show `[WebSocketServer] Received heartbeat from ChromeObserver client` for MCP client IDs
- `clients` Map contains entries with `clientType: 'MCP'` mixed with VCPLog entries

**Phase to address:** Phase 1 (transport foundation). The client type classification and heartbeat mechanism must be decided before any client compatibility testing.

---

### Pitfall 5: Missing Cleanup on Abrupt Disconnect (Memory Leak)

**What goes wrong:** When a remote MCP client closes the tab, kills the process, or drops off the network, the WebSocket connection terminates without the server running cleanup. The `ws` object, any pending backend requests, and per-connection state (like `requestContext` or rate-limit counters) remain in memory indefinitely.

**Why it happens:** The existing `WebSocketServer.js` has `ws.on('close', ...)` and `ws.on('error', ...)` handlers, but they only clean up from `clients`, `distributedServers`, `chromeObserverClients`, etc. If MCP connections are stored in a new Map or not tracked at all, cleanup is skipped.

**Consequences:**
- `mcpConnectionCount` never decrements, eventually exhausting the connection limit
- Per-connection state accumulates, causing memory growth over hours/days
- Pending `GatewayBackendClient` HTTP requests leak promises that never resolve

**Prevention:**
- Register `ws.on('close')` and `ws.on('error')` inside `McpWebSocketTransport` and ensure both decrement `mcpConnectionCount`
- Clear any per-connection timers (heartbeat interval) in the close handler
- If the transport maintains a pending-request Map (for JSON-RPC id correlation), delete entries on disconnect
- Ensure `webSocketServer.shutdown()` iterates MCP clients and calls `ws.terminate()` (not just `ws.close()`, which waits for close handshake)

**Warning signs:**
- `mcpConnectionCount` only increases across a load test
- Heap snapshots show retained `WebSocket` objects with `readyState: CLOSED`
- `setInterval` callbacks fire for dead connections because heartbeat timers were not cleared

**Phase to address:** Phase 1 (transport foundation). Cleanup must be paired with connection creation; retrofitting is error-prone.

---

### Pitfall 6: Batch Request Handling Without Backpressure or Timeout

**What goes wrong:** The design enables JSON-RPC batch requests over WebSocket (`Array.isArray(request)`). If a client sends a batch of 100 `tools/call` requests, the transport fires them all via `Promise.all` without limiting concurrency. Each call may trigger a backend HTTP request, exhausting the HTTP agent pool or the backend server's capacity.

**Why it happens:** The design doc shows:
  ```javascript
  const responses = await Promise.all(
    request.map((r) => harness.handleRequest(...))
  );
  ```
This is fine for small batches but dangerous for large ones with expensive backend calls.

**Consequences:**
- Backend HTTP agent queue fills up; new requests stall
- Event loop blocked waiting for 100 parallel backend calls
- Memory spike from 100 concurrent response buffers

**Prevention:**
- Cap batch size (e.g., max 10 requests per batch). Reject larger batches with `-32600` (Invalid Request)
- Limit concurrency within a batch using `p-limit` or a simple semaphore (max 3-5 parallel backend calls)
- Apply a per-batch timeout (e.g., 30s) so a single slow tool call does not hold the entire batch indefinitely
- Document that `McpStdioTransport` rejects batches (preserve existing behavior); `McpWebSocketTransport` supports them with limits

**Warning signs:**
- Backend response latency spikes when batch requests are sent
- `GatewayBackendClient` logs show many simultaneous `POST /agent_gateway/memory/search` calls from one connection
- Memory usage spikes correlate with batch request patterns in logs

**Phase to address:** Phase 2 (batching and throughput). Can be deferred from MVP but must be addressed before exposing to untrusted clients.

---

### Pitfall 7: Protocol Version and Capability Mismatch with Remote Clients

**What goes wrong:** The server hardcodes `protocolVersion: '2025-06-18'` and `listChanged: false` in `buildMcpInitializeResult`. Remote clients (Claude Desktop, Cursor, custom SDK clients) may request a different protocol version or expect `listChanged: true` for dynamic tool discovery. If the server ignores the requested version, clients may misinterpret capabilities or fail to initialize.

**Why it happens:** The harness currently returns the requested version or a default, but capabilities are static. The MCP SDK v2 removed WebSocket transport entirely, so clients using the latest SDK will need custom transport implementations. Any protocol drift between what the server claims and what it actually supports causes client-side errors.

**Consequences:**
- Clients refuse to connect because protocol version mismatch is treated as fatal
- Clients cache tool lists and never refresh because `listChanged: false`
- Future MCP spec changes require server updates; hardcoded values make this brittle

**Prevention:**
- Accept and echo the client's requested `protocolVersion` during `initialize` (already done), but validate it against a supported range. Reject unsupported versions with a clear error
- Keep `listChanged: false` for Phase 1, but design the capability object so it can be toggled later without changing `buildMcpInitializeResult`'s signature
- When `listChanged` is enabled (Phase 2), ensure the capability service emits events and the transport has a way to broadcast notifications to relevant connections
- Document supported protocol versions explicitly in the transport README

**Warning signs:**
- Client logs show `Protocol version mismatch` or `Unsupported capability`
- `initialize` response is accepted but subsequent `tools/call` fails with client-side schema validation errors
- Upgrading the MCP client SDK breaks connectivity

**Phase to address:** Phase 1 (transport foundation) for version negotiation; Phase 2 (push notifications) for `listChanged`.

---

### Pitfall 8: GatewayBackendClient Credential Leak Through Query Parameters

**What goes wrong:** The design doc suggests query-parameter auth fallback (`/mcp?gateway_key=xxx`) for browser clients that cannot set headers. If the gateway key is passed in the URL, it appears in server access logs, browser history, proxy logs, and referrer headers.

**Why it happens:** Browser `WebSocket` APIs do not support custom headers. The design doc proposes synthetic headers from query params as a workaround. This is convenient but insecure for production.

**Consequences:**
- Gateway key exposed in nginx/Apache access logs
- Key leaked via `Referer` header if the page navigates elsewhere
- Key visible in browser history and dev tools

**Prevention:**
- Prefer header-based auth (`x-agent-gateway-key`, `Authorization: Bearer`) for all non-browser clients
- For browser clients, require a short-lived token exchange: the browser first authenticates via an HTTP POST (with credentials in body/headers), receives a one-time WebSocket ticket, then connects with `/mcp?ticket=xxx`
- If query-param auth must be supported, document it as debug-only and ensure the key is rotated frequently
- Never log the raw `request.url` in `WebSocketServer.js` without stripping query parameters

**Warning signs:**
- Server logs contain `/mcp?gateway_key=abc123...`
- Security audit flags credentials in URLs
- Browser network tab shows the full WebSocket URL with key

**Phase to address:** Phase 1 (transport foundation). The auth contract must be decided before any client integration; changing it later breaks configured clients.

---

### Pitfall 9: Refactoring stdio Transport and Breaking Existing Consumers

**What goes wrong:** Approach B (recommended) refactors `mcpStdioServer.js` to extract `McpStdioTransport`. If the refactor changes the module exports, the initialization timing, or the Promise queue behavior, existing stdio consumers (Claude Desktop local config, test suite) break.

**Why it happens:** The existing `mcpStdioServer.js` is tightly coupled: it creates the readline interface, manages `runtimeState`, handles JSON parse errors, and queues requests inline. Extracting this into a separate class risks subtle behavior changes (e.g., error message format, shutdown timing, queue ordering).

**Consequences:**
- `npm run test:agent-gateway-mcp-transport` fails
- Claude Desktop local MCP config stops working
- The stdio transport becomes a regression vector for every future change

**Prevention:**
- Keep `mcpStdioServer.js` exports identical (`startStdioMcpServer`, `initializeBackendProxyMcpRuntime`, etc.)
- Implement `McpStdioTransport` as an internal helper that `mcpStdioServer.js` delegates to, but preserve the exact public API
- Run the existing stdio test suite after every transport refactor; do not proceed if it fails
- Add a compatibility test that spawns the stdio server via `scripts/start-agent-gateway-mcp-server.js` and verifies the exact JSON-RPC output format

**Warning signs:**
- Stdio tests fail with "Parse error" code changes or different `id` handling
- `start:mcp-agent-gateway` script exits immediately or hangs
- JSON-RPC error codes shift (e.g., `-32600` becomes `-32700` for the same input)

**Phase to address:** Phase 1 (transport foundation). The stdio refactor is the riskiest part of Approach B; it must be validated before any WebSocket work proceeds.

---

### Pitfall 10: Integration with Existing PluginManager Auth Without Context Propagation

**What goes wrong:** The WebSocket transport authenticates at upgrade time using `resolveDedicatedGatewayAuth`, but the resulting `authContext` is not propagated into the MCP harness. When `mcpBackendProxyAdapter.js` calls backend services (e.g., `capabilityService.getCapabilities`), those services expect an `authContext` derived from the request. If the WebSocket transport drops this context, backend calls run with incomplete or default auth, causing 403s or incorrect capability filtering.

**Why it happens:** The stdio transport does not have an HTTP request context; it relies on env vars (`VCP_MCP_BACKEND_KEY`, `VCP_MCP_BACKEND_BEARER_TOKEN`) for backend auth. The WebSocket transport has real HTTP headers at upgrade time, but the auth result is not threaded through to `handleRequest`.

**Consequences:**
- Authenticated MCP clients get 403 from backend because `authContext` is missing
- Tool scope guards (`toolScopeGuard.js`) reject calls that should be allowed
- Diary scope guards (`diaryScopeGuard.js`) apply wrong restrictions

**Prevention:**
- Capture the `authContext` from `resolveDedicatedGatewayAuth` at upgrade time and store it on the `ws` object
- In `McpWebSocketTransport.onMessage`, inject `authContext` into `params` before calling `harness.handleRequest`:
  ```javascript
  const scopedRequest = {
    ...request,
    params: {
      ...request.params,
      authContext: this.authContext,
      requestContext: { ...request.params?.requestContext, sessionId: this.connectionSessionId }
    }
  };
  ```
- Verify that `mcpBackendProxyAdapter.js` passes `authContext` through to `buildBody`, `buildJobQuery`, and backend client calls
- Add an integration test where a client with valid gateway key calls `tools/call` and verify the backend receives the correct `authContext`

**Warning signs:**
- Backend logs show `authContext: { roles: ['admin_transition'] }` for dedicated gateway clients
- Tool calls return `MCP_FORBIDDEN` despite valid gateway key
- Scope guards log mismatched agentId or missing sessionId

**Phase to address:** Phase 1 (transport foundation). Auth context propagation must be wired end-to-end before any client integration.

---

## Moderate Pitfalls

### Pitfall 11: Not Handling `notifications/initialized` Idempotently

**What goes wrong:** The MCP client sends `notifications/initialized` after receiving the `initialize` response. If the transport treats this as an error or expects it exactly once, reconnecting clients (or clients with retry logic) may fail.

**Why it happens:** The harness currently returns `null` for `notifications/initialized`. If the WebSocket transport does not handle `null` results gracefully (e.g., tries to `JSON.stringify(null)` and send it), it may throw or send an invalid frame.

**Prevention:**
- Ensure the transport skips sending a response for notifications (requests without `id`)
- The existing stdio transport already does this (`expectsResponse` check); mirror exactly in WebSocket

**Phase to address:** Phase 1.

---

### Pitfall 12: Missing CORS Handling for WebSocket Upgrade

**What goes wrong:** Browser-based MCP clients (e.g., a web IDE) attempt a WebSocket upgrade from a different origin. The server does not handle CORS preflight for the upgrade, causing the browser to block the connection before auth.

**Why it happens:** WebSocket upgrades do not typically trigger CORS preflight, but some corporate proxies or browser extensions intercept the handshake. The existing `server.js` sets `cors({ origin: '*' })` for Express HTTP routes, but the `httpServer.on('upgrade')` handler bypasses Express middleware.

**Prevention:**
- In the upgrade handler, check `request.headers.origin` against an allow-list if the server is exposed to browsers
- For same-origin or trusted clients, allow all origins; for production, make this configurable
- Document that the WebSocket endpoint is intended for server-to-server or local network use unless CORS is explicitly configured

**Phase to address:** Phase 1.

---

### Pitfall 13: JSON-RPC `id` Type Mismatch (String vs Number)

**What goes wrong:** MCP clients send `id` as either string or number. The server responds with the same type. If the transport or harness coerces `id` to a number (e.g., `parseInt`), clients that sent string IDs cannot correlate responses.

**Why it happens:** JavaScript's loose typing makes it easy to accidentally normalize `id`. The existing `buildJsonRpcError` uses `id ?? null`, which preserves type, but some middleware might not.

**Prevention:**
- Preserve `id` exactly as received (string, number, or null). Never coerce
- In the response builder, use `request.id` verbatim

**Phase to address:** Phase 1.

---

## Minor Pitfalls

### Pitfall 14: Logging MCP Traffic to stdout

**What goes wrong:** Debug logging inside the WebSocket transport writes JSON-RPC messages to `process.stdout`. For stdio this is fatal (corrupts the protocol stream). For WebSocket it is less severe but still pollutes logs.

**Prevention:**
- Use `console.error` or a structured logger for all MCP transport diagnostics
- Never write to `process.stdout` from the transport layer

**Phase to address:** Phase 1.

---

### Pitfall 15: Binary Frame Handling

**What goes wrong:** A malformed client sends binary WebSocket frames. The transport assumes text frames and calls `message.toString()`, producing garbage JSON.

**Prevention:**
- In `ws.on('message', (message, isBinary) => { ... })`, reject binary frames with a parse error or silently ignore them
- Document that the MCP WebSocket endpoint is text-only

**Phase to address:** Phase 1.

---

## Phase-Specific Warnings

| Phase Topic | Likely Pitfall | Mitigation |
|-------------|---------------|------------|
| Phase 1: Transport foundation | Auth bypass (Pitfall 1) | Validate auth before `handleUpgrade`; destroy socket on failure |
| Phase 1: Transport foundation | Session bleed (Pitfall 2) | Inject per-connection `sessionId` into every `handleRequest` |
| Phase 1: Transport foundation | Memory leak on disconnect (Pitfall 5) | Dedicate `mcpClients` Map; clear timers and decrement counter on close/error |
| Phase 1: Transport foundation | Stdio regression (Pitfall 9) | Preserve exact `mcpStdioServer.js` exports and behavior; run existing tests |
| Phase 1: Transport foundation | Auth context drop (Pitfall 10) | Thread `authContext` from upgrade through to harness params |
| Phase 2: Batching & throughput | Backend overload (Pitfall 6) | Cap batch size and concurrency; add per-batch timeout |
| Phase 2: Push notifications | `listChanged` without capability update | Ensure capability service emits events before enabling `listChanged: true` |
| Phase 3: Client integration | Protocol version mismatch (Pitfall 7) | Validate requested version; document supported versions |
| Phase 3: Client integration | Credential leak in URL (Pitfall 8) | Prefer header auth; use ticket exchange for browsers |
| Phase 3: Production hardening | Connection exhaustion (Pitfall 3) | Enforce `VCP_MCP_WS_MAX_CONNECTIONS`; monitor connection count |
| Phase 3: Production hardening | Heartbeat collision (Pitfall 4) | Use native `ws` ping/pong, not application JSON |

---

## Sources

- Context7 MCP TypeScript SDK documentation (`/modelcontextprotocol/typescript-sdk`):
  - WebSocketClientTransport removed in v2; custom Transport interface required
  - StreamableHTTP transport patterns (session management, auth providers, graceful shutdown)
  - DNS rebinding protection recommendations
  - Connection lifecycle (`onerror`, `onclose`, `terminateSession`)
  - `listChanged` capability and notification handlers
- VCP codebase analysis:
  - `modules/agentGateway/mcpStdioServer.js` — stdio transport implementation
  - `modules/agentGateway/adapters/mcpBackendProxyAdapter.js` — harness and request handling
  - `modules/agentGateway/contracts/protocolGovernance.js` — auth resolution (`resolveDedicatedGatewayAuth`)
  - `WebSocketServer.js` — existing WebSocket upgrade handling, client type routing, heartbeat patterns
  - `server.js` — Express initialization, `webSocketServer.initialize()` call site, CORS setup
  - `test/agent-gateway/adapters/agent-gateway-mcp-transport.test.js` — stdio test coverage
  - `mydoc/export/mcp/mcp-remote-websocket-transport-design.md` — design doc with Approach B architecture
