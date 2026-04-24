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
