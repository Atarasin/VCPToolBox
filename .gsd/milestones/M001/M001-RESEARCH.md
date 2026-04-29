# Research Summary: VCP Remote MCP WebSocket Bridge

**Project:** VCP Remote MCP Bridge
**Researched:** 2026-04-24
**Confidence:** HIGH

---

## Key Stack Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| **No MCP SDK dependency** | Custom transport adapter | VCP already has equivalent harness logic in `mcpBackendProxyAdapter.js`. Adding `@modelcontextprotocol/sdk` duplicates ~1500 lines of capability logic and forces a risky stdio refactor. |
| **Reuse existing runtime** | `ws@^8.17.0`, `express@^5.1.0`, `uuid@^9.0.0` | All already in production. Zero new dependencies needed. |
| **Transport abstraction** | `McpTransport` interface → `McpStdioTransport` + `McpWebSocketTransport` | One harness, two transports. Stdio behavior preserved exactly; WebSocket gets batch + session isolation. |
| **Auth at upgrade time** | `resolveDedicatedGatewayAuth` during HTTP Upgrade | Prevents auth bypass. Rejects unauthenticated clients with `socket.destroy()` before WS handshake completes. |
| **Native ws ping/pong** | RFC 6455 frames, not application JSON | Avoids collision with existing `ChromeObserver` heartbeat protocol. |

## Table Stakes for v1

1. **WebSocket endpoint at fixed URL** (`/mcp`) with upgrade-time auth
2. **JSON-RPC 2.0 framing** over WebSocket text frames
3. **MCP lifecycle**: `initialize`, `notifications/initialized`, `ping`
4. **Tool discovery and invocation**: `tools/list`, `tools/call` for memory search, context assembly, memory write
5. **Prompt and resource discovery**: `prompts/list`, `prompts/get`, `resources/list`, `resources/read`
6. **Per-connection session isolation** to prevent session bleed across concurrent clients
7. **Graceful connection close** with proper cleanup
8. **Existing stdio transport unchanged** — zero regression

## Critical Architectural Decisions

1. **Strict endpoint separation** — External MCP `/mcp` uses standard JSON-RPC; internal `/vcp-distributed-server` uses custom VCP protocol. Dedicated `mcpClients` Map, no shared routing.
2. **Singleton harness + per-connection context injection** — `createBackendProxyMcpServerHarness` is expensive to recreate. Session isolation happens at the transport layer via `requestContext.sessionId`, not multiple harness instances.
3. **Auth context propagation** — `authResult` from upgrade time must be threaded through to `harness.handleRequest` params so backend services receive correct scope and permissions.

## Top Pitfalls to Avoid

| # | Pitfall | Impact | Phase |
|---|---------|--------|-------|
| 1 | Auth after WebSocket upgrade | Security bypass, DoS | 1 |
| 2 | Missing per-connection `sessionId` injection | Session bleed, cross-client data leakage | 1 |
| 3 | No connection limits | Resource exhaustion, memory leak | 1 |
| 4 | Application-level heartbeat JSON | Collision with ChromeObserver, misrouted messages | 1 |
| 5 | Missing cleanup on disconnect | Memory leak, connection counter drift | 1 |
| 6 | Unbounded batch requests | Backend overload, event loop blocking | 2 |
| 7 | Protocol version mismatch | Client initialization failure | 1/3 |
| 8 | Query-parameter credential leak | Gateway key exposed in logs/history | 1 |
| 9 | Stdio transport refactor regression | Breaking existing local MCP consumers | 1 |

## Recommended Phase Structure

| Phase | Focus | Key Deliverables |
|-------|-------|-----------------|
| 1 | Transport Foundation | `McpTransport` interface, `McpStdioTransport` refactor, `McpWebSocketTransport`, `/mcp` upgrade handler, auth + session isolation |
| 2 | Capability Exposure & Integration | Wire harness methods over WebSocket, batch request caps, tool/prompt/resource validation |
| 3 | Client Integration & Validation | Test with Claude Desktop, Cursor, Trae; protocol version negotiation; auth fallback validation |
| 4 | Production Hardening | Rate limiting, payload limits, connection metrics, structured logging |
| 5 | Deferred Enhancements | Server-initiated push (`listChanged`), AdminPanel UI, expanded batch support |

## Open Questions

1. **Browser client scenario:** If no browser clients need to connect, query-param auth fallback can be eliminated entirely, removing Pitfall 8.
2. **`listChanged` event emission:** The capability service does not currently emit events. Enabling server-initiated push in Phase 5 requires adding an event emitter.
3. **CORS for WebSocket upgrade:** Do remote MCP clients need CORS preflight? Usually no for WS, but should be verified with actual client stacks.
4. **Backend request cancellation:** If a WebSocket client disconnects mid-request, can the in-flight `GatewayBackendClient` HTTP call be aborted?

## Sources

- MCP SDK v1.29.0 source (transport interface, stdio implementation, protocol routing)
- MCP Specification 2025-03-26
- VCP codebase: `mcpStdioServer.js`, `mcpBackendProxyAdapter.js`, `WebSocketServer.js`, `protocolGovernance.js`, `server.js`
- VCP design doc: `mydoc/export/mcp/mcp-remote-websocket-transport-design.md`
- VCP OpenSpec requirements for agent gateway MCP transport

# Architecture Patterns: MCP Remote WebSocket Bridge

**Domain:** VCP Agent Gateway — remote MCP transport over WebSocket
**Researched:** 2026-04-24
**Confidence:** HIGH (based on direct codebase inspection and existing design documents)

## Executive Summary

VCP already has a working MCP server surface exposed only over stdio (`mcpStdioServer.js`).
The goal is to add a WebSocket transport so external MCP clients (Claude Desktop, Cursor, remote scripts) can connect over the network without breaking the existing stdio path or the internal node-to-node WebSocket mesh.

The architecture follows a **transport abstraction pattern**: one harness (business logic), two transports (stdio and WebSocket), strict separation between the external MCP WebSocket endpoint and the existing internal WebSocket mesh, and reuse of the existing VCP auth system at the WebSocket upgrade handshake.

---

## Recommended Architecture

### High-Level Diagram

```
External MCP Clients (Claude Desktop, Cursor, etc.)
         |
         | WebSocket wss://host/mcp
         | (JSON-RPC 2.0 over text frames)
         v
+---------------------------------------------------+
|              Express HTTP Server (server.js)        |
|  +---------------------------------------------+    |
|  |  httpServer.on('upgrade') handler           |    |
|  |  - Existing paths: /VCPlog, /vcp-distributed |    |
|  |    /vcp-chrome-control, /vcp-admin-panel     |    |
|  |  - NEW path: /mcp  (MCP remote transport)    |    |
|  |    Auth: x-agent-gateway-key or Bearer       |    |
|  |    (resolveDedicatedGatewayAuth)             |    |
|  +---------------------------------------------+    |
+---------------------------------------------------+
         |
         v
+---------------------------------------------------+
|  WebSocketServer.js (existing, modified)          |
|  - Routes /mcp upgrades to McpWebSocketTransport  |
|  - Routes /vcp-distributed to distributedServers  |
|  - Routes /VCPlog to clients Map                  |
|  - Each domain uses a separate client Map         |
+---------------------------------------------------+
         |
         v
+---------------------------------------------------+
|  modules/agentGateway/transports/ (new directory)  |
|                                                    |
|  McpTransport.js          (interface)              |
|    - send(message)                                 |
|    - close()                                       |
|    - onMessage(handler)                            |
|                                                    |
|  McpStdioTransport.js     (extracted from         |
|    mcpStdioServer.js)     - readline, queue,       |
|                             JSON parse, stdout     |
|                                                    |
|  McpWebSocketTransport.js (new)                    |
|    - wraps single ws connection                    |
|    - per-connection requestContext/sessionId       |
|    - heartbeat ping/pong (ws native frames)        |
|    - batch request support                         |
+---------------------------------------------------+
         |
         |  Both transports call the same harness
         v
+---------------------------------------------------+
|  createBackendProxyMcpServerHarness               |
|  (mcpBackendProxyAdapter.js — UNCHANGED)          |
|    - adapter.listTools()                           |
|    - adapter.callTool()                            |
|    - adapter.getPrompt()                           |
|    - adapter.readResource()                        |
+---------------------------------------------------+
         |
         v
+---------------------------------------------------+
|  GatewayBackendClient (HTTP to VCP REST API)      |
|  or direct toolRuntimeService.invokeTool()        |
+---------------------------------------------------+
```

### Why This Structure

1. **One harness, many transports** — The business logic in `mcpBackendProxyAdapter.js` is transport-agnostic. It accepts a JSON-RPC request object and returns a JSON-RPC response. Both stdio and WebSocket are thin I/O wrappers around this.
2. **No changes to existing stdio behavior** — `McpStdioTransport` preserves exact behavior: line-buffered input, single-request queue, batch rejection with `-32600`.
3. **WebSocket gets enhancements** — Batch requests, per-connection session scoping, and native ws ping/pong are WebSocket-only features.
4. **Existing WebSocket mesh is untouched** — The internal node-to-node protocol (`/vcp-distributed-server`, custom message types like `register_tools`, `execute_tool`) lives in a completely separate routing branch.

---

## Component Boundaries

### 1. WebSocket Upgrade Router (`WebSocketServer.js`)

**Responsibility:** Accept or reject HTTP Upgrade requests based on pathname and auth.
**Communicates With:**
- `httpServer` (from `server.js`) — receives `upgrade` events
- `McpWebSocketTransport` — passes authenticated `ws` sockets
- Existing client Maps (`clients`, `distributedServers`, etc.) — for other protocols

**Boundary rules:**
- `/mcp` is a **new, separate branch** in the `httpServer.on('upgrade')` handler.
- It is evaluated **before** the existing `VCP_Key` regex checks.
- Auth uses **headers** (`x-agent-gateway-key` or `Authorization: Bearer`) via `resolveDedicatedGatewayAuth`, NOT the pathname-embedded `VCP_Key` pattern used by internal protocols.
- On auth failure: `socket.destroy()` immediately (same pattern as invalid `VCP_Key`).
- On auth success: `wssInstance.handleUpgrade(request, socket, head, (ws) => { ... })` then pass `ws` to `McpWebSocketTransport`.
- **Must NOT** reuse `clients` Map for MCP connections. Use a dedicated `mcpClients` Map to avoid collision with VCPLog and other internal client types.

### 2. MCP Transport Interface (`McpTransport.js`)

**Responsibility:** Define the contract that both stdio and WebSocket transports implement.
**Communicates With:** None (pure interface).

```javascript
// Conceptual interface
{
  send(message),      // Send a JSON-RPC message to the client
  close(),            // Close the transport
  onMessage(handler)  // Register handler for incoming messages
}
```

### 3. MCP Stdio Transport (`McpStdioTransport.js`)

**Responsibility:** Wrap stdin/stdout in the `McpTransport` interface.
**Communicates With:**
- `process.stdin` / `process.stdout` — I/O
- `createBackendProxyMcpServerHarness` — business logic

**Boundary rules:**
- Preserves existing behavior exactly: line buffering, `readline` interface, Promise queue for sequential request handling.
- Rejects batch requests with `-32600` (existing behavior).
- No auth (stdio assumes local process boundary).

### 4. MCP WebSocket Transport (`McpWebSocketTransport.js`)

**Responsibility:** Wrap a single `ws` connection in the `McpTransport` interface.
**Communicates With:**
- `ws` connection instance — I/O
- `createBackendProxyMcpServerHarness` — business logic

**Boundary rules:**
- One transport instance per WebSocket connection.
- Injects per-connection `sessionId` (e.g., `ws-${connectionId}`) into `params.requestContext` before calling `harness.handleRequest`.
- Supports JSON-RPC batch requests (array of requests → array of responses).
- Uses native `ws` ping/pong frames (not application-level JSON) to avoid collision with ChromeObserver's existing `heartbeat` message type.
- Cleans up on `ws.on('close')` and `ws.on('error')`.

### 5. MCP Server Harness (`createBackendProxyMcpServerHarness`)

**Responsibility:** JSON-RPC dispatch and MCP business logic.
**Communicates With:**
- `GatewayBackendClient` — HTTP calls to VCP REST API
- `mcpDescriptorRegistry` — tool/prompt/resource descriptors

**Boundary rules:**
- **UNCHANGED** by this project. No modifications.
- Receives a JSON-RPC request object, returns a JSON-RPC response object.
- The harness instance is a **singleton**, shared across stdio and all WebSocket connections.
- Per-connection isolation is achieved via `requestContext` injection at the transport layer, not by creating multiple harness instances.

### 6. Auth Resolver (`resolveDedicatedGatewayAuth`)

**Responsibility:** Validate gateway key or bearer token.
**Communicates With:**
- `protocolGovernance.js` — config and header parsing
- `pluginManager` — to retrieve gateway key config

**Boundary rules:**
- Called during the WebSocket upgrade handshake (HTTP layer), not after the WS connection is established.
- Works with `request.headers` directly.
- Supports fallback query params (`/mcp?gateway_key=xxx`) for browser-based clients that cannot set custom headers.

---

## Data Flow

### Connection Establishment

```
1. Client sends HTTP Upgrade request to /mcp
   Headers: Connection: Upgrade, Upgrade: websocket
            x-agent-gateway-key: <key>  OR  Authorization: Bearer <token>

2. WebSocketServer.js upgrade handler:
   a. Parse pathname → matches /mcp
   b. Extract headers (or query params)
   c. Call resolveDedicatedGatewayAuth({ headers, pluginManager })
   d. If !authenticated → socket.destroy()
   e. If authenticated → wssInstance.handleUpgrade(...) → create McpWebSocketTransport(ws)

3. McpWebSocketTransport:
   a. Assign connectionId and sessionId
   b. Register ws.on('message') handler
   c. Store in mcpClients Map
```

### Request/Response Flow (Single Request)

```
1. Client sends JSON-RPC over WS text frame:
   { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }

2. McpWebSocketTransport.onMessage:
   a. Parse JSON
   b. Inject requestContext: { sessionId: "ws-<connectionId>", ... }
   c. Call harness.handleRequest(request)

3. harness.handleRequest:
   a. Dispatch to adapter.listTools(params)
   b. Return result object

4. McpWebSocketTransport:
   a. Wrap result in JSON-RPC response
   b. ws.send(JSON.stringify(response))
```

### Request/Response Flow (Batch Request — WebSocket only)

```
1. Client sends JSON-RPC batch:
   [{ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} },
    { jsonrpc: "2.0", id: 2, method: "tools/call", params: {...} }]

2. McpWebSocketTransport.onMessage:
   a. Detect Array.isArray(request)
   b. Map each request through harness.handleRequest with injected requestContext
   c. await Promise.all(responses)
   d. ws.send(JSON.stringify(responses.filter(Boolean)))
```

### Connection Teardown

```
1. Client closes WS or network drops
2. ws.on('close') fires
3. McpWebSocketTransport:
   a. Remove from mcpClients Map
   b. Clear any pending request state
   c. Log disconnection

4. Server graceful shutdown:
   a. webSocketServer.shutdown() closes wssInstance
   b. All ws connections close
   c. All McpWebSocketTransport instances clean up
```

---

## Separation of External MCP WS from Internal Node-to-Node WS

This is the most critical boundary. The existing `WebSocketServer.js` already handles multiple client types via pathname matching:

| Pathname | Client Type | Protocol | Auth Method | Purpose |
|----------|-------------|----------|-------------|---------|
| `/VCPlog/VCP_Key=...` | VCPLog | Custom JSON | Path-embedded key | Log streaming |
| `/vcp-distributed-server/VCP_Key=...` | DistributedServer | Custom JSON | Path-embedded key | Node mesh, tool proxy |
| `/vcp-chrome-control/VCP_Key=...` | ChromeControl | Custom JSON | Path-embedded key | Browser automation |
| `/vcp-chrome-observer/VCP_Key=...` | ChromeObserver | Custom JSON | Path-embedded key | Browser observation |
| `/vcp-admin-panel/VCP_Key=...` | AdminPanel | Custom JSON | Path-embedded key | Admin UI |
| **`/mcp`** | **McpClient** | **JSON-RPC 2.0** | **Headers / Query** | **Standard MCP** |

**Critical design decisions:**

1. **Separate client Map** — MCP connections must be stored in a dedicated `mcpClients` Map (or WeakMap), NOT in the existing `clients` Map. This prevents:
   - Accidental broadcast of internal messages to MCP clients
   - Collision of `clientId` namespaces
   - Unintended routing of custom protocol messages to MCP clients

2. **Different auth pattern** — Internal protocols use `VCP_Key` embedded in the pathname. MCP uses HTTP headers (`x-agent-gateway-key` / `Authorization: Bearer`) at upgrade time, consistent with the existing Agent Gateway REST API auth.

3. **Different message dispatch** — Internal protocols dispatch based on `parsedMessage.type` (custom strings like `heartbeat`, `command_result`, `register_tools`). MCP dispatches based on `request.method` (standard JSON-RPC methods like `initialize`, `tools/list`, `tools/call`).

4. **No cross-traffic** — MCP clients must never receive internal VCP messages (connection_ack for VCPLog, tool_approval_response, etc.). Internal clients must never receive MCP JSON-RPC notifications.

---

## Auth Integration Architecture

### Upgrade-Time Auth

```javascript
// Inside WebSocketServer.js httpServer.on('upgrade')
const mcpPathRegex = /^\/mcp(?:\?.*)?$/;
const mcpMatch = pathname.match(mcpPathRegex) ||
                 (pathname === '/mcp');

if (mcpMatch) {
    // Primary: headers
    const authHeaders = {
        'x-agent-gateway-key': request.headers['x-agent-gateway-key'],
        'authorization': request.headers['authorization']
    };

    // Fallback: query params (for browser clients)
    const query = parsedUrl.query;
    if (!authHeaders['x-agent-gateway-key'] && query.gateway_key) {
        authHeaders['x-agent-gateway-key'] = query.gateway_key;
    }
    if (!authHeaders['authorization'] && query.bearer_token) {
        authHeaders['authorization'] = `Bearer ${query.bearer_token}`;
    }

    const authResult = resolveDedicatedGatewayAuth({
        headers: authHeaders,
        pluginManager
    });

    if (!authResult.authenticated) {
        writeLog(`MCP connection denied. Invalid gateway key.`);
        socket.destroy();
        return;
    }

    // Auth succeeded — proceed with WebSocket upgrade
    wssInstance.handleUpgrade(request, socket, head, (ws) => {
        const clientId = generateClientId();
        ws.clientId = clientId;
        ws.clientType = 'McpClient';
        ws.authContext = authResult; // Attach auth context for session use
        mcpClients.set(clientId, ws);
        // ... pass to McpWebSocketTransport
    });
}
```

### Per-Request Auth Context Injection

The `authResult` from upgrade time is attached to the `ws` object. `McpWebSocketTransport` injects this into the `requestContext` for every `handleRequest` call:

```javascript
// Inside McpWebSocketTransport before calling harness
const enrichedRequest = {
    ...request,
    params: {
        ...request.params,
        requestContext: {
            ...(request.params?.requestContext || {}),
            sessionId: this.sessionId,
            gatewayId: this.ws.authContext?.gatewayId || 'vcp-gateway',
            // Auth context is implicitly trusted because it was validated at upgrade time
        }
    }
};
```

### Connection Limits

- Default: 100 concurrent MCP WebSocket connections.
- Configurable via `VCP_MCP_WS_MAX_CONNECTIONS` environment variable.
- Enforced in `WebSocketServer.js` before calling `wssInstance.handleUpgrade()`.
- When limit reached: `socket.destroy()` with a log entry.

---

## Connection Lifecycle Management

### State Machine

```
[Client] --HTTP Upgrade--> [Upgrade Handler] --auth?--> [McpWebSocketTransport]
                                                              |
                                                              v
                                                    [Connected / Active]
                                                              |
                    +------------------+----------------------+------------------+
                    |                  |                      |                  |
                    v                  v                      v                  v
              [Client closes]   [Network drop]        [Server shutdown]   [Auth expiry]
                    |                  |                      |                  |
                    v                  v                      v                  v
              [Cleanup]          [Cleanup]              [Cleanup]          [Cleanup]
                    |                  |                      |                  |
                    +------------------+----------------------+------------------+
                                                              |
                                                              v
                                                    [Disconnected]
```

### Lifecycle Hooks

| Event | Handler | Action |
|-------|---------|--------|
| `upgrade` accepted | `WebSocketServer.js` | Create `ws`, assign `clientId`, store in `mcpClients` Map, instantiate `McpWebSocketTransport` |
| `ws.message` | `McpWebSocketTransport` | Parse JSON, validate JSON-RPC, inject requestContext, dispatch to harness, send response |
| `ws.ping` | `ws` library (native) | Auto-pong by `ws` library. Transport may track lastPingTime. |
| `ws.close` | `McpWebSocketTransport` | Remove from `mcpClients`, clear pending state, log |
| `ws.error` | `McpWebSocketTransport` | Log error, force cleanup, remove from Map |
| Server `shutdown()` | `WebSocketServer.js` | Close `wssInstance`, all `ws` connections close, all transports clean up |

### Cleanup Requirements

1. **Map removal** — Always delete from `mcpClients` on close/error.
2. **Pending request rejection** — If a request is in-flight when the connection drops, the Promise should reject gracefully (not crash the server).
3. **Heartbeat timeout** — If no pong received within 60s of a ping, destroy the socket.
4. **Memory leak prevention** — Do not hold references to closed `ws` objects. Use `ws.on('close', ...)` to release all callbacks.

---

## JSON-RPC over WS to Existing MCP Tool/Runtime Mapping

The existing harness (`createBackendProxyMcpServerHarness`) already handles these JSON-RPC methods:

| JSON-RPC Method | Harness Handler | Maps To |
|-----------------|-----------------|---------|
| `initialize` | `buildMcpInitializeResult` | MCP protocol handshake |
| `notifications/initialized` | No-op | Client ack |
| `ping` | `{}` | Health check |
| `tools/list` | `adapter.listTools` | `capabilityService.getCapabilities` + registry |
| `tools/call` | `adapter.callTool` | `toolRuntimeService.invokeTool` or gateway-managed operations |
| `prompts/list` | `adapter.listPrompts` | Registry |
| `prompts/get` | `adapter.getPrompt` | `agentRegistryService.renderAgent` |
| `resources/list` | `adapter.listResources` | Registry |
| `resources/read` | `adapter.readResource` | `capabilityService` / `jobRuntimeService` |

The WebSocket transport adds:
- **Batch request support** — Array of requests handled via `Promise.all`.
- **Per-connection session scoping** — `sessionId` injected into every request.
- **Future: server-initiated push** — `notifications/tools/list_changed` when capabilities update (Phase 2).

No changes to the harness method dispatch table are required.

---

## Suggested Build Order

Based on dependency analysis, build in this order:

### Phase 1: Transport Abstraction (Foundation)

1. **`modules/agentGateway/transports/McpTransport.js`**
   - Define the interface. No dependencies.

2. **`modules/agentGateway/transports/McpStdioTransport.js`**
   - Extract stdio logic from `mcpStdioServer.js`.
   - Depends on: `McpTransport.js`.
   - Risk: Must preserve exact existing behavior.

3. **Refactor `modules/agentGateway/mcpStdioServer.js`**
   - Replace inline transport logic with `McpStdioTransport`.
   - Depends on: `McpStdioTransport.js`.
   - Risk: Regression in stdio MCP. Mitigate with existing tests.

### Phase 2: WebSocket Transport (New Feature)

4. **`modules/agentGateway/transports/McpWebSocketTransport.js`**
   - New WebSocket transport implementing `McpTransport`.
   - Depends on: `McpTransport.js`, `ws` library.
   - Features: batch support, per-connection session, heartbeat.

5. **Modify `WebSocketServer.js`**
   - Add `/mcp` path handling in `httpServer.on('upgrade')`.
   - Add `mcpClients` Map.
   - Integrate `resolveDedicatedGatewayAuth` for upgrade-time auth.
   - Depends on: `McpWebSocketTransport.js`, `protocolGovernance.js`.
   - Risk: Must not break existing WebSocket paths. Test all existing client types.

6. **`modules/agentGateway/transports/index.js`**
   - Re-export all transports.

### Phase 3: Integration & Validation

7. **Update `server.js` (if needed)**
   - May need to pass `pluginManager` reference for auth resolution during upgrade.
   - Likely minimal or no changes required if `WebSocketServer.js` already has access to `pluginManager`.

8. **Write tests**
   - `test/agent-gateway/transports/mcp-websocket-transport.test.js`
   - Cover: initialize handshake, tools/list, tools/call, batch requests, auth failure, connection limits, graceful disconnect.

9. **Run existing tests**
   - `npm run test:agent-gateway-mcp-transport` must pass with zero regressions.

10. **Validate with real client**
    - Use a simple `ws` client script or Claude Desktop to connect to `/mcp` and invoke tools.

### Phase 4: Enhancements (Deferred)

11. **Server-initiated push** — `listChanged` notifications when capabilities update.
12. **Connection metrics** — Export active MCP connection count for monitoring.
13. **Rate limiting** — Per-connection request rate limits.

---

## Anti-Patterns to Avoid

### Anti-Pattern 1: Reuse the `clients` Map for MCP connections
**What:** Store MCP WebSocket connections in the existing `clients` Map alongside VCPLog clients.
**Why bad:** Internal broadcasts and message routing will leak into MCP clients. MCP clients may receive non-JSON-RPC messages.
**Instead:** Use a dedicated `mcpClients` Map.

### Anti-Pattern 2: Auth after WebSocket handshake
**What:** Allow any client to complete the WebSocket upgrade, then send an `authenticate` JSON-RPC method.
**Why bad:** Violates the existing VCP security model. Wastes server resources on unauthenticated connections. Harder to integrate with load balancers and firewalls.
**Instead:** Reject unauthenticated upgrades at the HTTP layer with `socket.destroy()`.

### Anti-Pattern 3: Create a harness instance per connection
**What:** Instantiate `createBackendProxyMcpServerHarness` for every WebSocket connection.
**Why bad:** `GatewayBackendClient` and service bundle are expensive to recreate. No benefit since the harness is stateless; session isolation belongs in `requestContext`.
**Instead:** Singleton harness, per-connection `requestContext` injection.

### Anti-Pattern 4: Application-level heartbeat messages
**What:** Send `{ type: 'heartbeat' }` JSON messages over the WebSocket.
**Why bad:** Collides with ChromeObserver's existing `heartbeat` message type. Adds unnecessary JSON parsing overhead.
**Instead:** Use native `ws` ping/pong frames (handled automatically by the `ws` library).

### Anti-Pattern 5: Modify `mcpBackendProxyAdapter.js` for transport concerns
**What:** Add WebSocket-specific logic (batch handling, connection tracking) into the harness.
**Why bad:** Violates separation of concerns. The harness should remain transport-agnostic.
**Instead:** Keep all transport logic in `McpWebSocketTransport.js`.

---

## Scalability Considerations

| Concern | At 1 connection | At 100 connections | At 10K connections |
|---------|-----------------|--------------------|--------------------|
| Harness instance | 1 singleton | 1 singleton | 1 singleton |
| Memory per connection | ~2 KB (ws object + transport) | ~200 KB total | Consider horizontal scaling |
| Auth validation | Per-upgrade | Per-upgrade | May need connection rate limiting |
| Batch requests | Supported | Supported | Consider max batch size limit |
| Heartbeat | Native ws ping/pong | Native ws ping/pong | Native ws ping/pong |
| Tool execution | Direct invoke | Direct invoke | May need job queue for deferred tools |

---

## Sources

- `/home/zh/projects/VCP/VCPToolBox/mydoc/export/mcp/mcp-remote-websocket-transport-design.md` — Existing design document (Approach B recommended)
- `/home/zh/projects/VCP/VCPToolBox/modules/agentGateway/mcpStdioServer.js` — Existing stdio transport
- `/home/zh/projects/VCP/VCPToolBox/modules/agentGateway/adapters/mcpBackendProxyAdapter.js` — Harness logic
- `/home/zh/projects/VCP/VCPToolBox/modules/agentGateway/adapters/mcpAdapter.js` — Alternative adapter (local tool runtime)
- `/home/zh/projects/VCP/VCPToolBox/modules/agentGateway/contracts/protocolGovernance.js` — Auth resolution (`resolveDedicatedGatewayAuth`)
- `/home/zh/projects/VCP/VCPToolBox/WebSocketServer.js` — Existing WebSocket upgrade routing
- `/home/zh/projects/VCP/VCPToolBox/server.js` — Express server initialization

# Technology Stack: MCP Remote WebSocket Bridge

**Project:** VCP Remote MCP Bridge
**Researched:** 2026-04-24
**Confidence:** HIGH (verified against MCP SDK v1.29.0 source, VCP codebase, and official spec)

---

## Executive Summary

VCP already owns the three runtime pieces this project needs: `ws@^8.17.0` for WebSocket framing, `express@^5.1.0` for the upgrade handshake, and a custom JSON-RPC harness (`mcpBackendProxyAdapter.js`) that is transport-agnostic. The only missing layer is a thin WebSocket transport adapter that speaks the same JSON-RPC dialect the existing stdio transport already speaks.

**Decision:** Do NOT add `@modelcontextprotocol/sdk` as a production dependency. The SDK’s `Transport` interface is trivial (~6 methods/callbacks) and VCP’s existing harness already handles JSON-RPC method dispatch, capability negotiation, and request/response correlation. Adding the SDK would duplicate the harness logic already in `mcpBackendProxyAdapter.js` and force a refactor of the working stdio path for marginal upside. Instead, implement a custom `Transport`-like adapter that wraps a `ws` connection and delegates to the existing harness.

**Stack principle:** Minimal new dependencies. Reuse what VCP already runs in production.

---

## Recommended Stack

### Core Runtime (Already in Production)

| Technology | Version | Purpose | Why |
|------------|---------|---------|-----|
| Node.js | `>=20.x` (LTS) | Runtime | VCP already requires Node 20+ for `WebSocketServer.js` and modern `ws` features. |
| `ws` | `^8.17.0` (existing) | WebSocket server & client | Already in `package.json`. Handles upgrade, ping/pong, binary/text frames, backpressure. No replacement needed. |
| `express` | `^5.1.0` (existing) | HTTP server / upgrade routing | Already in `package.json`. Required for the `httpServer.on('upgrade', ...)` path that `ws` uses. |
| `uuid` | `^9.0.0` (existing) | Session ID generation | Already in `package.json`. Use `v4()` for per-connection `sessionId` injection into `requestContext`. |

### Bridge Layer (New Code, Zero New Dependencies)

| Component | Type | Purpose | Notes |
|-----------|------|---------|-------|
| `McpWebSocketTransport` | New file | Wraps a single `ws` connection; implements `send()`, `close()`, `onmessage` | ~120 lines. Injects per-connection `sessionId` into `requestContext` before calling harness. |
| `McpStdioTransport` | Refactored file | Extracts stdio logic from `mcpStdioServer.js` into a transport interface | ~80 lines. Preserves existing newline-delimited JSON framing. Zero behavior change. |
| `McpTransport` (interface) | New file | Abstract base: `send(message)`, `close()`, `onMessage(handler)` | ~60 lines. No Node I/O dependencies. Enables unit testing without real sockets. |

### Auth (Existing, Reused)

| Technology | Version | Purpose | Why |
|------------|---------|---------|-----|
| `resolveDedicatedGatewayAuth` | Existing (protocolGovernance.js) | Validates `x-agent-gateway-key` or `Authorization: Bearer` | Already secures the Agent Gateway. Reused at WebSocket upgrade time via `request.headers`. No new auth library. |

### What Is NOT Added

| Category | What | Why Not |
|----------|------|---------|
| MCP SDK | `@modelcontextprotocol/sdk` | Duplicates harness logic; forces stdio refactor; adds dependency tax for ~100 lines of transport glue. See Decision Record below. |
| MCP SDK v2 | `@modelcontextprotocol/server` 2.0.0-alpha.2 | Pre-alpha. API surface unstable. Not production-ready. |
| Heartbeat library | Custom ping/pong JSON messages | `ws` already provides native ping/pong frames (RFC 6455). Application-level heartbeat JSON collides with existing `ChromeObserver` heartbeat protocol. |
| Binary framing | `msgpack`, `protobuf` | MCP is JSON-RPC 2.0. All messages are UTF-8 JSON. Binary adds complexity with zero benefit for this use case. |
| SSE transport | `eventsource` or similar | SSE is unidirectional (server→client). MCP requires bidirectional RPC. Would need a second HTTP channel for client→server, which is what Streamable HTTP does — but that is a separate transport, not this project’s scope. |

---

## Decision Record

### DR-1: No `@modelcontextprotocol/sdk` Dependency

**Context:** The official MCP TypeScript SDK provides `StdioServerTransport`, `StreamableHTTPServerTransport`, and a `Server` class that handles capability negotiation and request routing. VCP already has equivalent logic in `mcpBackendProxyAdapter.js`.

**Decision:** Do not add the SDK. Implement a custom transport adapter that conforms to the SDK’s `Transport` interface shape without importing the package.

**Rationale:**
1. **Duplication:** The SDK’s `Server` class and VCP’s `createBackendProxyMcpServerHarness` both handle `initialize`, `tools/list`, `tools/call`, `resources/list`, etc. Adopting the SDK would require replacing or bypassing the harness.
2. **Stdio regression risk:** The existing `mcpStdioServer.js` does not use the SDK. Migrating stdio to the SDK’s `StdioServerTransport` would touch working code for no user-facing benefit.
3. **Dependency tax:** The SDK adds a package and its transitive dependencies for functionality solvable in ~120 lines of custom code.
4. **Auth mismatch:** The SDK has no opinion on auth. VCP would still need custom glue to wire `resolveDedicatedGatewayAuth` into the SDK’s transport lifecycle.

**Confidence:** HIGH (verified by reading SDK source: `src/server/mcp.ts` is 1547 lines of capability logic VCP already owns; `src/server/stdio.ts` is a thin readline wrapper VCP already has.)

**Counter-argument & rebuttal:** The SDK provides battle-tested JSON-RPC framing and protocol version negotiation. **Rebuttal:** VCP’s harness already handles protocol version negotiation (`buildMcpInitializeResult` returns `protocolVersion`, `capabilities`, `serverInfo`) and JSON-RPC framing is trivial (`JSON.stringify` + newline for stdio; `JSON.stringify` + `ws.send` for WebSocket). The risk of bugs in this layer is lower than the risk of refactoring the harness.

### DR-2: Custom Transport Interface (Not SDK Import)

**Context:** The SDK defines a `Transport` interface with `start()`, `send()`, `close()`, `onclose`, `onerror`, `onmessage`, `sessionId`, and `setProtocolVersion`. VCP’s transport needs are simpler.

**Decision:** Define a local `McpTransport` interface that matches the SDK’s shape but is implemented without importing the SDK.

**Interface:**
```typescript
// McpTransport.js — local interface, no external dependency
class McpTransport {
  async send(message) {}        // Send JSON-RPC message
  async close() {}              // Close transport
  onMessage(handler) {}         // Register incoming message handler
  onClose(handler) {}           // Register close handler
  onError(handler) {}           // Register error handler
}
```

**Rationale:** Decouples VCP from SDK release cadence. If VCP later decides to adopt the SDK, the interface is already compatible.

**Confidence:** HIGH

### DR-3: Native `ws` Ping/Pong (Not Application-Level JSON)

**Context:** The existing `WebSocketServer.js` uses `ws` native ping/pong for connection health. The `ChromeObserver` client type already sends an application-level JSON heartbeat message (`{ type: 'heartbeat' }`).

**Decision:** Use `ws` native ping/pong frames (30s interval) for the MCP WebSocket transport. Do not send application-level JSON heartbeat messages.

**Rationale:** Native ping/pong is RFC 6455 compliant, handled automatically by `ws` (no listener code needed in VCP), and avoids collision with the existing `ChromeObserver` heartbeat protocol. Application-level JSON heartbeat would require a new message type and risk being misinterpreted by other WebSocket clients.

**Confidence:** HIGH

### DR-4: Auth at Upgrade Time (Not Post-Upgrade)

**Context:** WebSocket connections begin with an HTTP upgrade handshake. The `request` object at upgrade time has full HTTP headers. After the handshake, only WebSocket frames are available.

**Decision:** Authenticate during the `httpServer.on('upgrade', ...)` event using `resolveDedicatedGatewayAuth(request.headers)`. Reject unauthenticated upgrades with `socket.destroy()` before the WebSocket handshake completes.

**Rationale:**
1. **Security:** Prevents unauthenticated clients from reaching the WebSocket layer at all.
2. **Simplicity:** No need to implement an MCP-level auth method (e.g., `auth/authenticate` JSON-RPC method).
3. **Consistency:** Matches the existing `WebSocketServer.js` pattern for invalid `VCP_Key` — immediate `socket.destroy()`.

**Fallback:** For clients that cannot set custom headers (e.g., browser `WebSocket` API), accept query parameters (`/mcp?gateway_key=xxx`) and synthesize headers for the auth resolver.

**Confidence:** HIGH

---

## Bridging stdio to WebSocket: Protocol Framing

### stdio Framing (Existing)

The existing `mcpStdioServer.js` uses newline-delimited JSON (NDJSON):

```
Client → Server: {"jsonrpc":"2.0","id":1,"method":"initialize","params":{...}}\n
Server → Client: {"jsonrpc":"2.0","id":1,"result":{...}}\n
Client → Server: {"jsonrpc":"2.0","method":"notifications/initialized"}\n
Client → Server: {"jsonrpc":"2.0","id":2,"method":"tools/list"}\n
Server → Client: {"jsonrpc":"2.0","id":2,"result":{...}}\n
```

- **Transport characteristic:** Byte stream. Requires `readline` or `ReadBuffer` to split on `\n`.
- **Batch support:** Explicitly rejected with `-32600` (existing behavior).
- **Encoding:** UTF-8.

### WebSocket Framing (New)

WebSocket is message-oriented. Each text frame is one complete message. No newline delimiter needed.

```
Client → Server (WS text frame): {"jsonrpc":"2.0","id":1,"method":"initialize","params":{...}}
Server → Client (WS text frame): {"jsonrpc":"2.0","id":1,"result":{...}}
Client → Server (WS text frame): {"jsonrpc":"2.0","method":"notifications/initialized"}
Client → Server (WS text frame): {"jsonrpc":"2.0","id":2,"method":"tools/list"}
Server → Client (WS text frame): {"jsonrpc":"2.0","id":2,"result":{...}}
```

- **Transport characteristic:** Message-oriented. Each `ws.on('message', ...)` event is one complete JSON-RPC message.
- **Batch support:** Enabled. A batch request is a JSON array sent as a single WS text frame. The transport splits the array and calls `harness.handleRequest` for each element, then sends the aggregated responses as a single WS text frame.
- **Encoding:** UTF-8 (WebSocket text frames). No binary frames.

### Key Difference Summary

| Aspect | stdio | WebSocket |
|--------|-------|-----------|
| Framing | Newline-delimited JSON (`\n`) | One message per WS text frame |
| Direction | Full-duplex over two streams | Full-duplex over one connection |
| Batch requests | Rejected (`-32600`) | Supported |
| Connection lifecycle | Process lifetime | Per-connection, with explicit close |
| Session isolation | Single session (process) | Per-connection `sessionId` |

### Implementation Pattern

```javascript
// McpWebSocketTransport.js (simplified)
class McpWebSocketTransport {
  constructor(ws, sessionId) {
    this.ws = ws;
    this.sessionId = sessionId;
    this.messageHandler = null;

    ws.on('message', (data) => {
      const request = JSON.parse(data.toString('utf-8'));
      if (this.messageHandler) {
        this.messageHandler(request);
      }
    });

    ws.on('close', () => {
      if (this.closeHandler) this.closeHandler();
    });
  }

  async send(message) {
    if (this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(message));
    }
  }

  async close() {
    this.ws.close();
  }

  onMessage(handler) {
    this.messageHandler = handler;
  }
}
```

The harness (`createBackendProxyMcpServerHarness`) receives the request object and returns a response object. The transport is responsible only for serialization/deserialization and wire delivery.

---

## Authentication Patterns

### Primary: Header-Based Auth at Upgrade Time

```javascript
// Inside WebSocketServer.js upgrade handler
const authResult = resolveDedicatedGatewayAuth({
  headers: request.headers,
  pluginManager
});

if (!authResult.authenticated) {
  socket.destroy();
  return;
}

// Auth succeeded — proceed with WebSocket upgrade
wssInstance.handleUpgrade(request, socket, head, (ws) => {
  const transport = new McpWebSocketTransport(ws, sessionId);
  // ... attach to harness
});
```

**Headers checked:**
- `x-agent-gateway-key` — compared against `config.gatewayKey`
- `Authorization: Bearer <token>` — validated via existing bearer token resolution

### Fallback: Query Parameter Auth

For clients that cannot set custom headers (browser `WebSocket`, some MCP client SDKs):

```javascript
const parsedUrl = new URL(request.url, `http://${request.headers.host}`);
const syntheticHeaders = {
  [AGENT_GATEWAY_HEADERS.GATEWAY_KEY]: parsedUrl.query.gateway_key || '',
  authorization: parsedUrl.query.bearer_token
    ? `Bearer ${parsedUrl.query.bearer_token}`
    : ''
};

const authResult = resolveDedicatedGatewayAuth({
  headers: syntheticHeaders,
  pluginManager
});
```

**Security note:** Query parameters may appear in server logs. Prefer headers for production. Document the query param fallback as "for development and browser-based clients only."

### Session Context Injection

After auth succeeds, the transport injects a per-connection `sessionId` into the `requestContext` passed to the harness:

```javascript
const enrichedRequest = {
  ...request,
  requestContext: {
    ...request.requestContext,
    sessionId: this.sessionId,
    authResult: authResult  // Optional: pass roles/gatewayId to harness
  }
};

const response = await harness.handleRequest(enrichedRequest);
```

This ensures:
- **Memory isolation:** Per-connection search context, job tracking, and session state.
- **Auditability:** Each request can be traced to a specific WebSocket connection.
- **No session bleed:** Connection A cannot see connection B’s in-flight jobs.

---

## Client Connection Patterns

### Standard MCP Client Flow Over WebSocket

1. **Upgrade:** Client opens WebSocket to `wss://vcp-host/mcp` (or `ws://` for local dev).
2. **Auth:** Headers or query params sent with upgrade request.
3. **Initialize:** Client sends `initialize` request:
   ```json
   {
     "jsonrpc": "2.0",
     "id": 1,
     "method": "initialize",
     "params": {
       "protocolVersion": "2025-03-26",
       "capabilities": {},
       "clientInfo": { "name": "claude-desktop", "version": "1.0.0" }
     }
   }
   ```
4. **Initialized:** Client sends `notifications/initialized` (no response expected).
5. **Tool discovery:** Client sends `tools/list`.
6. **Tool invocation:** Client sends `tools/call` with arguments.
7. **Close:** Client or server closes WebSocket.

### Connection URL

```
Production:  wss://vcp.example.com/mcp
Development: ws://localhost:3000/mcp
With auth:   wss://vcp.example.com/mcp?gateway_key=xxx
```

### Concurrent Connections

- **Target:** 100+ concurrent WebSocket connections.
- **Limit:** Configurable via `VCP_MCP_WS_MAX_CONNECTIONS` (default 100).
- **Enforcement:** Checked in `WebSocketServer.js` before calling `wssInstance.handleUpgrade()`.
- **Memory model:** Each connection holds one `McpWebSocketTransport` instance (~few KB) plus the `ws` socket object. The harness singleton is shared. No per-connection backend client recreation.

### Reconnection

- **Client responsibility:** MCP clients (Claude Desktop, Cursor) handle reconnection.
- **Server behavior:** On disconnect, the transport’s `onClose` handler cleans up the connection reference. The harness singleton remains. The client must re-run the full `initialize` handshake after reconnect.
- **No session resumption:** By design. Each connection gets a new `sessionId`. The harness does not persist session state across reconnections.

---

## Version Compatibility Matrix

| Component | Version | MCP Protocol | Compatibility |
|-----------|---------|--------------|---------------|
| VCP harness | Existing | `2025-03-26` | Supports `initialize` with `protocolVersion` negotiation |
| `ws` | `^8.17.0` | N/A | RFC 6455 compliant; supports ping/pong, text/binary frames |
| Express | `^5.1.0` | N/A | Required for `httpServer.on('upgrade')` |
| MCP SDK (not used) | `1.29.0` | `2025-03-26` | Would be compatible, but unnecessary |
| MCP SDK v2 (not used) | `2.0.0-alpha.2` | `2025-11-25` | Pre-alpha; unstable; do not use |

**Protocol versions supported by VCP harness:** `2025-03-26` (current), `2024-11-05` (legacy). The harness returns the negotiated version in `buildMcpInitializeResult`.

---

## What NOT to Use (And Why)

### 1. `@modelcontextprotocol/sdk` v1.x

**Why not:** Duplicates harness logic; adds dependency; forces stdio refactor; auth still requires custom glue.
**When to reconsider:** If VCP later wants to adopt the SDK’s `McpServer` high-level API (tool/prompt/resource decorators) or needs official SSE/HTTP transport support out-of-the-box.

### 2. `@modelcontextprotocol/server` v2.0.0-alpha.2

**Why not:** Pre-alpha release. API surface changing weekly. Not production-ready.
**When to reconsider:** After v2 reaches stable release and provides compelling features VCP cannot implement easily (e.g., built-in OAuth 2.1, standardized multi-transport support).

### 3. Application-Level JSON Heartbeat

**Why not:** Collides with existing `ChromeObserver` heartbeat protocol (`{ type: 'heartbeat' }`). Adds unnecessary message type.
**What to use instead:** Native `ws` ping/pong frames (30s interval). Handled automatically by the `ws` library.

### 4. Auth After WebSocket Upgrade

**Why not:** Allows unauthenticated clients to complete the WebSocket handshake and reach the MCP protocol layer. Requires implementing an MCP-level auth method (e.g., `auth/authenticate` JSON-RPC method), which is non-standard and adds complexity.
**What to use instead:** Auth at HTTP upgrade time using `resolveDedicatedGatewayAuth`. Reject with `socket.destroy()` before handshake completes.

### 5. Shared Client Map for MCP Connections

**Why not:** The existing `WebSocketServer.js` stores each client type in separate Maps (`VCPLogClients`, `VCPInfoClients`, etc.). Mixing MCP connections into an existing Map (e.g., `ChromeControlClients`) would cause message routing errors.
**What to use instead:** A dedicated `McpClients` Map (or `Set`) in `WebSocketServer.js`, managed separately from existing client types.

### 6. Binary Message Framing (msgpack, protobuf)

**Why not:** MCP is JSON-RPC 2.0. All messages are UTF-8 JSON. Binary framing adds serialization/deserialization overhead and requires client-side support. No standard MCP client supports binary.
**What to use instead:** WebSocket text frames with `JSON.stringify` / `JSON.parse`.

### 7. SSE as Primary Transport

**Why not:** SSE is unidirectional (server→client). MCP requires bidirectional RPC. SSE would need a companion HTTP POST channel for client→server, which is exactly what Streamable HTTP does — but that is a different project, not this one.
**What to use instead:** WebSocket for this project. Consider Streamable HTTP as a future transport if the need arises.

---

## Installation

No new packages to install. The stack uses only existing dependencies:

```bash
# Verify existing dependencies are present
npm ls ws express uuid

# Expected output:
# ws@8.17.0
# express@5.1.0
# uuid@9.0.0
```

If `ws` is ever upgraded, ensure the version remains `^8.x` (not `^9.x`) to avoid breaking changes in the `handleUpgrade` API.

---

## Sources

- MCP SDK v1.29.0 source (GitHub commit `e12cbd7078db388152f6e839abdbe09ba01f3f32`):
  - `src/shared/transport.ts` — Transport interface definition
  - `src/server/stdio.ts` — StdioServerTransport implementation
  - `src/shared/protocol.ts` — Protocol.connect() and request/response routing
  - `src/server/mcp.ts` — McpServer high-level API (1547 lines)
  - `src/server/streamableHttp.ts` — StreamableHTTPServerTransport
- VCP codebase:
  - `package.json` — Dependency versions
  - `modules/agentGateway/mcpStdioServer.js` — Existing stdio transport
  - `modules/agentGateway/adapters/mcpBackendProxyAdapter.js` — Harness logic
  - `WebSocketServer.js` — WebSocket upgrade routing
  - `modules/agentGateway/contracts/protocolGovernance.js` — Auth resolution
- MCP Specification 2025-03-26 — Official protocol version and transport requirements

# Feature Landscape: VCP Remote MCP WebSocket Bridge

**Domain:** Remote MCP server transport over WebSocket for VCP Agent Gateway
**Researched:** 2026-04-24
**Confidence:** HIGH (based on direct codebase inspection, OpenSpec requirements, and MCP SDK documentation)

---

## 1. Table Stakes

Features users (MCP client hosts like Claude Desktop, Cursor, Trae) expect from any remote MCP server. Missing these makes the product feel broken or unusable.

| Feature | Why Expected | Complexity | Notes |
|---------|--------------|------------|-------|
| **WebSocket endpoint at a fixed URL** | MCP clients need a stable address to connect (e.g., `wss://host/mcp`). | Low | Reuse existing Express `httpServer` with `noServer: true` pattern already used in `WebSocketServer.js`. |
| **JSON-RPC 2.0 message framing over WebSocket text frames** | MCP protocol is JSON-RPC 2.0. Each message is one JSON object per line (stdio) or one JSON object per WebSocket text frame. | Low | Existing `mcpStdioServer.js` already parses JSON-RPC; WebSocket transport sends/receives identical payloads over `ws.send()`/`ws.on('message')`. |
| **MCP lifecycle: `initialize` handshake** | MCP spec requires capability negotiation on first connection. Server must respond with `protocolVersion`, `capabilities`, `serverInfo`. | Low | Already implemented in `buildMcpInitializeResult()` inside `mcpBackendProxyAdapter.js`. |
| **`notifications/initialized` acknowledgment** | Client signals handshake completion. Server must accept and not error. | Low | Already handled in harness (`case 'notifications/initialized': result = null;`). |
| **`ping` / keepalive** | Clients and servers must verify connection health. MCP defines `ping` method. | Low | Harness already supports `ping`. WebSocket layer adds native `ws.ping()`/`ws.pong()` for TCP-level keepalive. |
| **Tool discovery via `tools/list`** | Clients must discover what tools the server exposes before calling them. | Low | `adapter.listTools()` exists; returns `gateway_memory_search`, `gateway_context_assemble`, `gateway_memory_write`, `gateway_agent_bootstrap`, `gateway_job_get`, `gateway_job_cancel`. |
| **Prompt discovery via `prompts/list`** | Prompt-aware clients (Trae) discover injectable prompts. | Low | `adapter.listPrompts()` exists; returns `gateway_agent_render`. |
| **Resource discovery via `resources/list`** | Clients discover readable resources (memory targets, job events). | Low | `adapter.listResources()` exists; returns `vcp://agent-gateway/memory-targets/{agentId}`. |
| **Tool invocation via `tools/call`** | Core purpose: remote clients invoke RAG/memory tools. | Medium | `adapter.callTool()` delegates to `GatewayBackendClient` which calls native backend HTTP routes. |
| **Prompt fetch via `prompts/get`** | Trae fetches `gateway_agent_render` for agent injection. | Medium | `adapter.getPrompt()` delegates to `backendClient.renderAgent()`. |
| **Resource read via `resources/read`** | Clients read memory targets or job events. | Medium | `adapter.readResource()` delegates to `backendClient.getMemoryTargets()` or `backendClient.listJobEvents()`. |
| **Connection authentication at upgrade time** | Security baseline: reject unauthorized clients before WebSocket handshake completes. | Medium | Must reuse VCP's existing `resolveDedicatedGatewayAuth` or `x-agent-gateway-key` / `Authorization: Bearer` header checks during `httpServer.on('upgrade')`. |
| **Error responses with MCP error codes** | Clients expect structured errors (`MCP_INVALID_REQUEST`, `MCP_FORBIDDEN`, etc.), not raw stack traces. | Low | `mapGatewayFailureToMcpErrorCode()` and `createFailureResult()` already exist. |
| **Graceful connection close** | Clients should receive orderly shutdown, not abrupt TCP resets. | Low | Handle `ws.close()` with appropriate WebSocket close codes; clean up connection Map entries. |
| **Concurrent connection support** | Multiple external MCP clients may connect simultaneously. | Medium | Requires per-connection state isolation (see Pitfalls: Session Bleed). |
| **Preserve existing stdio transport unchanged** | Existing local consumers (Trae stdio) must continue working. | Low | New WebSocket transport is additive; stdio server remains untouched. |

---

## 2. Differentiators

Features that set VCP's remote MCP bridge apart from a generic MCP server or a simple stdio wrapper.

| Feature | Value Proposition | Complexity | Notes |
|---------|-------------------|------------|-------|
| **Reuse of existing VCP auth system** | No separate credential store; single identity layer for HTTP, WebSocket mesh, and MCP. | Medium | Use `GatewayBackendClient` with `gatewayKey`, `gatewayId`, `bearerToken` already defined. |
| **Backend-only proxy pattern** | Remote clients get identical behavior to local stdio because both delegate to the same running VCP backend. | Medium | No local runtime initialization; transport is thin. Already proven in `mcpStdioServer.js`. |
| **Deferred job execution with event resources** | Long-running operations (render, memory search) return job handles + `vcp://agent-gateway/jobs/{jobId}/events` resource for polling. | Medium | `createDeferredResultEnvelope()` and `readResource()` for `JOB_EVENTS` already implemented. |
| **Agent-scoped diary policy enforcement** | Memory search/context assembly automatically constrained by `mcp_agent_memory_policy.json` per agent. | Medium | `applyAgentDiaryPolicyToBody()` enforces allowlists before backend calls. |
| **Prompt-first agent injection for Trae** | `prompts/get(name = gateway_agent_render)` returns inject-ready prompt content; tool path is fallback only. | Medium | Aligns with M17 Trae prompt injection spec; metadata includes `hostHints.injectionMode`. |
| **Canonical operability metadata** | All results include `traceId`, `operationName`, `retryAfterMs` when applicable. | Low | `buildOperabilityMetadata()` already additive to success and failure results. |
| **Idempotent memory writes** | `gateway_memory_write` supports `idempotencyKey` for safe retries. | Low | Backend already supports; MCP adapter passes it through. |
| **Multi-tenant isolation via request context** | Each connection injects unique `sessionId` and `requestContext` so jobs/memory never bleed across clients. | Medium | Requires WebSocket transport to wrap harness calls with per-connection context. |
| **Graceful degradation under load** | Connection limits, rate limiting, and payload size protections prevent backend overload. | Medium | Can leverage existing Gateway Core operability policy (M14) and add WebSocket-specific connection caps. |
| **Structured logging with request correlation** | Every request carries `requestId` traceable across transport, adapter, backend, and response. | Low | Existing `normalizeNativeResult()` extracts `meta.requestId`. |

---

## 3. Anti-Features

Features to explicitly NOT build, based on project scope, existing architecture, and MCP spec boundaries.

| Anti-Feature | Why Avoid | What to Do Instead |
|--------------|-----------|-------------------|
| **Generic MCP proxy to arbitrary external servers** | This project exposes VCP *as* an MCP server, not VCP calling *out* to other MCP servers. | Keep MCP client functionality (calling remote servers) out of scope per `PROJECT.md`. |
| **Replacing the existing node-to-node WebSocket mesh protocol** | The internal distributed layer (`/vcp-distributed-server`) uses a custom protocol for VCP node communication. | Add a *separate* `/mcp` endpoint for external MCP clients; leave mesh untouched. |
| **Changes to RAG/memory data model or indexing** | Only the transport layer changes; business logic stays in Gateway Core. | Delegate all tool/resource/prompt operations to existing backend routes via `GatewayBackendClient`. |
| **OAuth 2.1 or complex auth flows for WebSocket** | MCP spec defines OAuth for HTTP transports; WebSocket is custom. VCP already has API keys and bearer tokens. | Reuse existing `x-agent-gateway-key` / `Authorization: Bearer` at upgrade handshake. |
| **Session persistence across server restarts** | MCP is stateless per connection; persistent sessions add complexity without clear value. | Treat each WebSocket connection as an independent session; reconnections re-authenticate and re-initialize. |
| **Breaking changes to existing stdio MCP consumers** | Trae and other local hosts rely on the current stdio transport. | Add WebSocket transport as a new file/module; do not modify `mcpStdioServer.js` behavior. |
| **MCP `sampling` or `roots` client capabilities** | These require the *server* to call the *client*, which is complex and not needed for RAG/memory exposure. | Do not advertise `sampling` or `roots` in server capabilities. |
| **Real-time bidirectional streaming (SSE over WebSocket)** | MCP utilities like progress use notifications, but full streaming is not required for the diary RAG loop. | Use deferred jobs + event resources for long-running operations. |
| **UI for MCP connection management in AdminPanel** | Out of scope per `PROJECT.md`; can be added later. | Document configuration in `PROJECT.md` and transport setup files only. |
| **Batch JSON-RPC requests** | The existing stdio transport explicitly rejects batch requests. | Maintain parity: reject batches in WebSocket transport too, or handle them if explicitly required later. |

---

## 4. How Remote MCP Clients Discover and Use Capabilities

### 4.1 Discovery Flow

```
1. Client opens WebSocket to wss://host/mcp
2. Server validates auth at upgrade handshake (header/cookie based)
3. Client sends: { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", ... } }
4. Server responds with capabilities: { tools: {}, resources: {}, prompts: {} }
5. Client sends: { jsonrpc: "2.0", method: "notifications/initialized" }
6. Client discovers:
   - tools/list   -> gateway_memory_search, gateway_context_assemble, gateway_memory_write, gateway_agent_bootstrap, gateway_job_get, gateway_job_cancel
   - prompts/list -> gateway_agent_render
   - resources/list -> vcp://agent-gateway/memory-targets/{agentId}
```

### 4.2 Tool Invocation Patterns

| Tool | Input | Output | Deferred? |
|------|-------|--------|-----------|
| `gateway_memory_search` | `{ query, diary?, diaries?, maid?, mode?, k? }` | Memory results array | No |
| `gateway_context_assemble` | `{ query?, recentMessages?, diary?, diaries?, maxBlocks?, tokenBudget? }` | Assembled context blocks | No |
| `gateway_memory_write` | `{ target, memory, tags?, diary?, idempotencyKey? }` | Write confirmation | No |
| `gateway_agent_bootstrap` | `{ agentId, variables?, model?, maxLength? }` | Rendered prompt text | Yes (if backend defers) |
| `gateway_job_get` | `{ jobId }` | Job status record | No |
| `gateway_job_cancel` | `{ jobId }` | Cancelled job record | No |

### 4.3 Prompt Injection Pattern (Trae)

```
Client sends: prompts/get(name = "gateway_agent_render", arguments = { agentId: "nexus" })
Server responds:
  messages: [{ role: "system", content: [{ type: "text", text: "...rendered prompt..." }] }]
  meta: {
    hostHints: {
      injectionMode: "prompt_message_content",
      primarySurface: "prompts/get",
      useMessageContentAsPromptBody: true
    }
  }
```

### 4.4 Resource Read Patterns

| Resource URI | Purpose | Backend Route |
|--------------|---------|---------------|
| `vcp://agent-gateway/memory-targets/{agentId}` | Policy-filtered diary targets | `GET /agent_gateway/memory/targets` |
| `vcp://agent-gateway/jobs/{jobId}/events` | Job lifecycle events | `GET /agent_gateway/events/stream` + `GET /agent_gateway/jobs/{jobId}` |

---

## 5. Feature Dependencies

```
WebSocket Transport Foundation
  |-- Auth at Upgrade Handshake
  |     |-- Reuse resolveDedicatedGatewayAuth (from protocolGovernance)
  |     |-- Validate x-agent-gateway-key or Authorization: Bearer
  |
  |-- Connection Lifecycle Management
  |     |-- Generate unique connectionId + sessionId per ws
  |     |-- Maintain mcpClients Map separate from distributedServers/clients
  |     |-- Handle close/error/timeout cleanup
  |
  |-- JSON-RPC Framing over WebSocket
  |     |-- Parse incoming text frames as JSON-RPC requests
  |     |-- Send responses as text frames
  |     |-- Reuse createJsonRpcErrorResponse from mcpStdioServer.js
  |
  |-- Per-Connection Request Context Injection
  |     |-- Wrap harness.handleRequest to inject sessionId, requestId, runtime: "mcp-ws"
  |     |-- Prevent session bleed across concurrent connections
  |
  |-- Harness Reuse
        |-- Reuse createBackendProxyMcpServerHarness (existing)
        |-- Reuse adapter.listTools, adapter.callTool, etc.
        |-- No new business logic in transport layer

MCP Capability Exposure (already implemented in backend proxy adapter)
  |-- tools/list, tools/call
  |-- prompts/list, prompts/get
  |-- resources/list, resources/read
  |-- initialize, ping

Security & Operability
  |-- Connection rate limiting (per IP / per gateway key)
  |-- Payload size limits (max JSON-RPC message size)
  |-- Connection pool limits (max concurrent MCP WebSocket clients)
  |-- Structured error mapping (AGW_* -> MCP_* codes)
  |-- Request tracing (requestId, traceId correlation)
```

### Dependency Rules

- **Transport layer MUST NOT implement business logic.** It only handles WebSocket I/O, auth, connection state, and JSON-RPC framing. All tool/prompt/resource semantics stay in `mcpBackendProxyAdapter.js`.
- **Auth MUST happen before `handleUpgrade`.** The transport cannot depend on the MCP `initialize` message for authentication.
- **Per-connection context MUST be injected before `harness.handleRequest`.** The harness is shared; the transport must ensure each call carries the connection's unique identity.
- **Deferred job results require both `gateway_job_get` tool AND `resources/read` for job events.** Both are already implemented; the WebSocket transport just exposes them.

---

## 6. MVP Recommendation

### Prioritize (Phase 1)

1. **WebSocket endpoint with auth at upgrade** — Without this, nothing else works securely.
2. **JSON-RPC framing and lifecycle** — `initialize`, `notifications/initialized`, `ping`.
3. **Tool discovery and invocation** — `tools/list`, `tools/call` for memory search, context assembly, memory write.
4. **Prompt discovery and fetch** — `prompts/list`, `prompts/get` for Trae injection.
5. **Resource discovery and read** — `resources/list`, `resources/read` for memory targets.
6. **Concurrent connection isolation** — Per-connection sessionId to prevent bleed.

### Defer (Later Phases)

- **Rate limiting and payload protections** — Important but can be added after basic transport works.
- **Graceful degradation / load shedding** — Requires operational metrics not yet collected.
- **AdminPanel UI for connection monitoring** — Explicitly out of scope for now.
- **Batch JSON-RPC support** — Existing stdio rejects batches; maintain parity.

---

## Sources

- `/home/zh/projects/VCP/VCPToolBox/openspec/specs/agent-gateway-mcp-server-transport/spec.md` — stdio transport baseline
- `/home/zh/projects/VCP/VCPToolBox/openspec/specs/agent-gateway-mcp-readiness/spec.md` — MCP v1 boundary definition
- `/home/zh/projects/VCP/VCPToolBox/openspec/specs/agent-gateway-mcp-trae-prompt-injection/spec.md` — Trae prompt injection requirements
- `/home/zh/projects/VCP/VCPToolBox/openspec/specs/agent-gateway-mcp-memory-adapter/spec.md` — Memory tool contracts
- `/home/zh/projects/VCP/VCPToolBox/openspec/specs/agent-gateway-mcp-job-event-runtime/spec.md` — Deferred job and event resource contracts
- `/home/zh/projects/VCP/VCPToolBox/openspec/specs/agent-gateway-mcp-operability-alignment/spec.md` — Error and retry metadata
- `/home/zh/projects/VCP/VCPToolBox/openspec/specs/agent-gateway-protocol-governance/spec.md` — Canonical error codes and request context
- `/home/zh/projects/VCP/VCPToolBox/openspec/specs/agent-gateway-auth-policy/spec.md` — Auth context and scope guards
- `/home/zh/projects/VCP/VCPToolBox/modules/agentGateway/mcpStdioServer.js` — Existing stdio transport implementation
- `/home/zh/projects/VCP/VCPToolBox/modules/agentGateway/adapters/mcpBackendProxyAdapter.js` — MCP adapter with harness, tools, prompts, resources
- `/home/zh/projects/VCP/VCPToolBox/modules/agentGateway/adapters/mcpDescriptorRegistry.js` — Tool/prompt/resource descriptors
- `/home/zh/projects/VCP/VCPToolBox/WebSocketServer.js` — Existing WebSocket upgrade routing and auth patterns

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