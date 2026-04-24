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
