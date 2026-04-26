# Phase 2: WebSocket Endpoint & Session Management - Research

**Researched:** 2026-04-26
**Domain:** Node.js `ws` endpoint integration, authenticated upgrade handling, connection-scoped MCP session management
**Confidence:** HIGH

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions
- **D-01:** `/mcp` upgrade authentication reuses `resolveDedicatedGatewayAuth`, accepting both `x-agent-gateway-key` and `Authorization: Bearer ...` during the HTTP Upgrade handshake.
- **D-02:** Unauthorized `/mcp` upgrades are rejected before handshake completion with `socket.destroy()`.
- **D-03:** `x-agent-gateway-id` remains an optional gateway identity hint and should be preserved in the authenticated connection context when present.
- **D-04:** Every authenticated WebSocket connection receives a server-generated canonical `sessionId`; clients cannot override the canonical session used by MCP handling.
- **D-05:** Connection-scoped context injected before harness calls includes at least `sessionId`, `requestId`, `runtime`, `source`, and authenticated `gatewayId` when present.
- **D-06:** `/mcp` is implemented as a dedicated manager under `modules/agentGateway/`, not as a new branch inside `WebSocketServer.js`.
- **D-07:** The dedicated MCP WebSocket manager owns its own connection `Map`, lifecycle hooks, and cleanup logic, even though it reuses the shared HTTP server `upgrade` flow.
- **D-08:** Keepalive uses native `ws` ping/pong frames, not application-level JSON heartbeat messages.

### Claude's Discretion
- Exact internal file layout under `modules/agentGateway/` for the dedicated manager and transport helpers.
- Keepalive interval and stale-client timeout values, as long as they use protocol ping/pong and avoid JSON heartbeat collisions.
- Whether to preserve a client-supplied correlation field for diagnostics, provided it does not replace the server-generated canonical `sessionId`.

### Deferred Ideas (OUT OF SCOPE)
- Full JSON-RPC batch support, initialize lifecycle details, and capability exposure. Phase 2 should still reject batch arrays explicitly with `-32600` instead of leaving behavior undefined.
- Connection limits, payload ceilings, and rate limiting controls.
- Extending the legacy distributed WebSocket mesh or reusing its client registries.
- Upgrade-auth timeout hardening for stalled `resolveDedicatedGatewayAuth()` calls; document the risk now and defer enforcement to Phase 5 hardening.
</user_constraints>

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|------------------|
| TRANS-01 | Fixed WebSocket endpoint at `/mcp` for external MCP clients | Use a dedicated `ws.WebSocketServer({ noServer: true })` manager attached to the existing HTTP server upgrade hook |
| TRANS-02 | Authenticate during HTTP Upgrade using `resolveDedicatedGatewayAuth` | Reuse existing gateway header and bearer-token parsing in `protocolGovernance.js` |
| TRANS-03 | Reject unauthorized upgrades with `socket.destroy()` | Match both existing project pattern and `ws` guidance to authenticate inside HTTP `upgrade`, not `verifyClient` |
| TRANS-09 | Inject unique `sessionId` into `requestContext` before every harness call | Build a connection-scoped canonical context and merge it into each parsed MCP request before `harness.handleRequest()` |
| TRANS-10 | Use native `ws` ping/pong frames for keepalive | Follow the standard `isAlive + ping + pong` server heartbeat loop described by `ws` |
| OP-02 | Cleanup on `ws.close` and `ws.error` | Dedicated manager owns connection removal, timer disposal, and transport shutdown |
| OP-06 | Keep `/mcp` isolated from the legacy mesh | Create a new manager module under `modules/agentGateway/` and wire it from `server.js` only |
</phase_requirements>

## Summary

Phase 2 should introduce a dedicated Agent Gateway WebSocket manager for `/mcp` that mirrors the successful Phase 1 layering: transport stays a dumb pipe, the manager owns request parsing and harness interaction, and the legacy `WebSocketServer.js` mesh remains untouched. The key addition for this phase is connection-scoped identity: each authenticated socket gets a server-generated canonical `sessionId` plus an authenticated gateway context that is merged into every MCP request before it reaches the harness.

The most important implementation choice is to authenticate in the shared HTTP server `upgrade` event, not inside `ws.verifyClient`. That matches existing project patterns, preserves `socket.destroy()` rejection behavior, and aligns with `ws` documentation that discourages `verifyClient` for auth-heavy flows. Keepalive should use native control frames (`ping`/`pong`) with a per-connection liveness flag; this avoids collisions with MCP JSON-RPC traffic and satisfies the roadmap requirement without pulling Phase 3 framing work forward.

**Primary recommendation:** add `modules/agentGateway/mcpWebSocketServer.js` plus `modules/agentGateway/transport/webSocketTransport.js`, keep the new `/mcp` manager completely separate from `WebSocketServer.js`, and inject canonical `requestContext` by rewriting parsed request params before calling the existing harness.

## Architectural Responsibility Map

| Capability | Primary Tier | Secondary Tier | Rationale |
|------------|-------------|----------------|-----------|
| HTTP upgrade path matching | Dedicated MCP WS manager | Shared HTTP server | `/mcp` must remain isolated from the legacy mesh |
| Upgrade authentication | `resolveDedicatedGatewayAuth()` | Dedicated MCP WS manager | Reuse existing gateway auth rules instead of inventing a second parser |
| WebSocket frame I/O | `WebSocketTransport` | `ws` runtime | Transport only receives/sends serialized messages |
| JSON parsing + MCP dispatch | Dedicated MCP WS manager | Harness | Reuse the same handle-request flow as stdio |
| Canonical session injection | Dedicated MCP WS manager | `requestContext` helpers | Session identity is per connection, not client-controlled |
| Keepalive | Dedicated MCP WS manager | `ws` ping/pong | Requires connection registry and lifecycle cleanup |
| Business logic | Existing MCP harness | Backend proxy adapter | Phase 2 must not reimplement gateway semantics |

## Standard Stack

### Core
| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| `ws` | `^8.17.0` | Dedicated `/mcp` WebSocket server + transport | Already in project dependencies and already used for server-side WebSocket support |
| `node:http` | built-in | Shared HTTP server upgrade integration | Existing server entrypoint already exposes the required upgrade hook |
| `node:crypto` | built-in | Generate canonical connection and session identifiers | Stable built-in API; avoids ad-hoc ID generation |
| `node:test` | built-in | Automated verification | Existing project test runner |
| `node:assert/strict` | built-in | Assertions | Existing project test style |

### Supporting
| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| `express` | existing dependency | Test-only native route harness | Reuse the same fixture style as current MCP transport tests |
| `node:events` / `node:timers` | built-in | Keepalive scheduling and cleanup coordination | Manager lifecycle implementation and deterministic tests |

**Installation:** None required. `ws` is already available in `package.json`.

**Version verification:**
```bash
npm ls ws
node --version
```

## Architecture Patterns

### System Architecture Diagram

```text
External MCP Client
    |
    v
HTTP server upgrade event (`server.js`)
    |
    +--> legacy `WebSocketServer.js` paths (unchanged)
    |
    +--> `/mcp` path
            |
            v
      resolveDedicatedGatewayAuth(headers)
            |
       authorized?
        /      \
      no        yes
      |          |
 socket.destroy  wss.handleUpgrade(...)
                 |
                 v
          create connection context
          - connectionId
          - canonical sessionId
          - gatewayId/auth source
          - keepalive state
                 |
                 v
          WebSocketTransport (dumb pipe)
                 |
                 v
      parse request + inject requestContext/authContext
                 |
                 v
            harness.handleRequest(request)
                 |
                 v
       serialize JSON-RPC response -> transport.send()
```

### Recommended Project Structure
```text
modules/agentGateway/
├── transport/
│   ├── index.js                    # Existing transport exports
│   ├── mcpTransport.js             # Existing transport contract
│   ├── stdioTransport.js           # Existing stdio transport
│   └── webSocketTransport.js       # New ws-backed dumb pipe
├── mcpStdioServer.js               # Existing stdio manager (unchanged in this phase)
├── mcpWebSocketServer.js           # New dedicated `/mcp` upgrade + session manager
└── contracts/
    ├── protocolGovernance.js       # Existing auth/header helpers
    └── requestContext.js           # Existing normalization and request-id helpers

test/agent-gateway/
├── adapters/
│   ├── agent-gateway-mcp-transport.test.js   # Existing stdio integration coverage
│   └── agent-gateway-mcp-websocket.test.js   # New `/mcp` endpoint integration coverage
└── transport/
    └── websocket-transport.test.js           # New focused transport contract tests
```

### Pattern 1: Authenticate in HTTP `upgrade`, Not `verifyClient`
**What:** Match `/mcp` in the shared HTTP server upgrade hook, authenticate there, and call `socket.destroy()` before handshake completion on failure.
**When to use:** Any path that must share the main HTTP server while preserving custom auth semantics.
**Example:**
```javascript
httpServer.on('upgrade', (request, socket, head) => {
    if (request.url !== '/mcp') {
        return;
    }

    const auth = resolveDedicatedGatewayAuth({
        headers: request.headers,
        pluginManager
    });

    if (!auth.valid) {
        socket.destroy();
        return;
    }

    wss.handleUpgrade(request, socket, head, (ws) => {
        attachConnection(ws, request, auth);
    });
});
```

### Pattern 2: Connection-Scoped Canonical Context Injection
**What:** Build a trusted connection context once at handshake time, then merge it into every inbound MCP request before the harness sees it.
**When to use:** When downstream adapters require stable `sessionId` and optional authenticated `gatewayId`, but the harness signature only accepts a single `request` object.
**Example:**
```javascript
function injectConnectionContext(request, connectionContext) {
    const params = request.params && typeof request.params === 'object'
        ? { ...request.params }
        : {};
    const clientContext = params.requestContext && typeof params.requestContext === 'object'
        ? params.requestContext
        : {};

    const normalized = normalizeRequestContext({
        requestId: clientContext.requestId,
        agentId: clientContext.agentId,
        source: clientContext.source || connectionContext.source,
        runtime: clientContext.runtime || connectionContext.runtime,
        sessionId: connectionContext.sessionId
    }, {
        defaultSource: connectionContext.source,
        defaultRuntime: connectionContext.runtime,
        requestIdPrefix: 'agwmcp'
    });

    return {
        ...request,
        params: {
            ...params,
            requestContext: {
                ...normalized,
                ...(connectionContext.gatewayId ? { gatewayId: connectionContext.gatewayId } : {})
            },
            authContext: {
                ...(params.authContext && typeof params.authContext === 'object' ? params.authContext : {}),
                ...(connectionContext.gatewayId ? { gatewayId: connectionContext.gatewayId } : {}),
                sessionId: connectionContext.sessionId
            }
        }
    };
}
```

### Pattern 3: Native Ping/Pong Heartbeat
**What:** Track per-connection liveness with `ws.on('pong')`, periodically `ping()` healthy clients, and terminate stale connections that miss a heartbeat cycle.
**When to use:** Long-lived server-side WebSocket connections where application-level JSON heartbeats would interfere with protocol traffic.
**Example:**
```javascript
function startHeartbeat(connection, options) {
    connection.isAlive = true;
    connection.ws.on('pong', () => {
        connection.isAlive = true;
    });

    connection.heartbeatTimer = setInterval(() => {
        if (!connection.isAlive) {
            connection.ws.terminate();
            return;
        }
        connection.isAlive = false;
        connection.ws.ping();
    }, options.pingIntervalMs);
}
```

### Anti-Patterns to Avoid
- **Do not extend `WebSocketServer.js` with `/mcp` branches:** that would violate the locked isolation boundary and mix unrelated auth/routing models.
- **Do not trust client-provided `sessionId`:** downstream services use session identity for audit and job visibility; the canonical value must come from the server.
- **Do not implement JSON heartbeat messages:** Phase 2 explicitly requires native ping/pong so Phase 3 JSON-RPC semantics stay clean.
- **Do not change harness signatures first:** `mcpBackendProxyAdapter` already expects `handleRequest(request)`, so inject context into the request object instead of widening interfaces prematurely.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Upgrade auth parser | Custom header parsing | `resolveDedicatedGatewayAuth()` | Reuses existing gateway key + bearer-token support |
| Request metadata normalization | Ad-hoc object merges | `normalizeRequestContext()` | Preserves canonical request ID/source/runtime shaping |
| WebSocket server mux | Separate HTTP listener | `ws.WebSocketServer({ noServer: true })` on the existing HTTP server | Keeps routing centralized in `server.js` |
| Heartbeat protocol | JSON `{"type":"ping"}` frames | Native `ws.ping()` / `pong` | Avoids collisions with MCP JSON-RPC traffic |
| Session IDs | Timestamp-only strings | `crypto.randomUUID()` + stable prefix | Lower collision risk and clearer diagnostics |

## Runtime State Inventory

This phase adds in-memory connection state that must be created and cleaned deterministically:

| Category | Items Found | Action Required |
|----------|-------------|-----------------|
| Live connection registry | Dedicated `Map` keyed by generated connection ID | Remove entries on `close`, `error`, and forced heartbeat termination |
| Per-connection identity | Canonical `sessionId`, optional `gatewayId`, auth metadata | Generate once on connect; never accept client overwrite |
| Timers | Heartbeat interval and optional stale timeout bookkeeping | Clear every timer during cleanup |
| Shared HTTP hooks | `upgrade` listener attached to main server | Detach on manager shutdown to prevent leaked listeners in tests |
| Secrets/env vars | Existing gateway auth headers/bearer tokens only | Read during handshake, never persist in connection snapshots |

**Nothing found in category:** No persistent storage, database schema, or filesystem migrations are introduced in this phase.

## Common Pitfalls

### Pitfall 1: Reusing the Legacy Mesh Registry
**What goes wrong:** `/mcp` clients appear in the node-to-node mesh maps or inherit its routing/auth assumptions.
**Why it happens:** `WebSocketServer.js` already has an upgrade path and looks convenient to extend.
**How to avoid:** Keep all `/mcp` code in `modules/agentGateway/mcpWebSocketServer.js` and wire it from `server.js` only.
**Warning signs:** New conditionals added to `WebSocketServer.js` mention `/mcp` or Agent Gateway request context.

### Pitfall 2: Client Session Override
**What goes wrong:** Tool calls inherit a client-supplied `sessionId`, breaking canonical job visibility.
**Why it happens:** Naive `request.params = { ...request.params, requestContext: { ...clientRequestContext, ...serverContext } }` merges in the wrong order.
**How to avoid:** Normalize from inbound metadata but always write the canonical `sessionId` last from the connection context.
**Warning signs:** Integration tests show two requests on the same socket with different `sessionId` values.

### Pitfall 3: Heartbeat Timers Leak After Close
**What goes wrong:** Tests hang, servers refuse to shut down, or stale sockets remain in memory.
**Why it happens:** Timers survive after `ws.close`, `ws.error`, or `ws.terminate`.
**How to avoid:** Centralize cleanup in one idempotent function that clears timers, closes the transport, and deletes the registry entry.
**Warning signs:** Node test process reports open handles or manager connection count never returns to zero.

### Pitfall 4: Assuming the Harness Accepts a Second Context Argument
**What goes wrong:** Requests reach the harness without session metadata even though the manager built it.
**Why it happens:** `handleRequest(request, context)` looks intuitive, but the existing harness only accepts one argument.
**How to avoid:** Mutate the request payload before dispatch; do not widen the interface in Phase 2.
**Warning signs:** Requests fail with `requestContext.agentId and requestContext.sessionId are required`.

### Pitfall 5: Path Matching Collides With Other Upgrades
**What goes wrong:** The new `/mcp` listener steals upgrades meant for the legacy mesh or other future paths.
**Why it happens:** The manager installs a blanket `upgrade` handler without checking `pathname`.
**How to avoid:** Parse the request URL and return early unless the path matches the exact configured endpoint.
**Warning signs:** Existing WebSocket functionality breaks after enabling the new manager.

## Code Examples

### Minimal `WebSocketTransport`
```javascript
const WebSocket = require('ws');

class WebSocketTransport {
    constructor(ws, options = {}) {
        this.ws = ws;
        this.binaryType = options.binaryType || 'nodebuffer';
        this._messageHandler = null;
        this._errorHandler = null;
        this._closed = false;
        this._finishedPromise = new Promise((resolve) => {
            ws.once('close', resolve);
        });

        ws.binaryType = this.binaryType;
        ws.on('message', (data, isBinary) => {
            if (isBinary || typeof this._messageHandler !== 'function') {
                return;
            }
            try {
                this._messageHandler(Buffer.isBuffer(data) ? data.toString('utf8') : String(data));
            } catch (error) {
                if (typeof this._errorHandler === 'function') {
                    this._errorHandler(error);
                }
            }
        });
        ws.on('error', (error) => {
            if (typeof this._errorHandler === 'function') {
                this._errorHandler(error);
            }
        });
    }

    setMessageHandler(handler) {
        this._messageHandler = handler;
    }

    setErrorHandler(handler) {
        this._errorHandler = handler;
    }

    send(jsonString) {
        if (this._closed || this.ws.readyState !== WebSocket.OPEN) {
            return;
        }
        this.ws.send(jsonString);
    }

    close(code, reason) {
        if (this._closed) {
            return Promise.resolve();
        }
        this._closed = true;
        this.ws.close(code || 1000, reason || 'normal closure');
        return Promise.resolve();
    }

    get finished() {
        return this._finishedPromise;
    }
}
```

### Dedicated `/mcp` Manager Skeleton
```javascript
const crypto = require('node:crypto');
const { WebSocketServer } = require('ws');
const { resolveDedicatedGatewayAuth } = require('./contracts/protocolGovernance');
const { normalizeRequestContext } = require('./contracts/requestContext');
const { WebSocketTransport } = require('./transport/webSocketTransport');

function createMcpWebSocketServer(options = {}) {
    const wss = new WebSocketServer({ noServer: true, clientTracking: false });
    const connections = new Map();

    function createConnectionContext(auth) {
        return {
            connectionId: `mcpws_${crypto.randomUUID()}`,
            sessionId: `mcpws_${crypto.randomUUID()}`,
            source: 'agent-gateway-mcp-ws',
            runtime: 'mcp-websocket',
            gatewayId: auth.gatewayId || ''
        };
    }

    return {
        attach(httpServer) {
            httpServer.on('upgrade', (request, socket, head) => {
                if (new URL(request.url, 'http://localhost').pathname !== '/mcp') {
                    return;
                }

                const auth = resolveDedicatedGatewayAuth({
                    headers: request.headers,
                    pluginManager: options.pluginManager
                });
                if (!auth.valid) {
                    socket.destroy();
                    return;
                }

                wss.handleUpgrade(request, socket, head, (ws) => {
                    const connection = createConnectionContext(auth);
                    const transport = new WebSocketTransport(ws);
                    connections.set(connection.connectionId, { ...connection, ws, transport });
                    // parse JSON, inject requestContext, dispatch to harness, cleanup on close/error
                });
            });
        }
    };
}
```

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| Local-only stdio MCP transport | Transport abstraction from Phase 1 | Phase 1 | Enables a second transport without changing harness business logic |
| Legacy root-level WebSocket mesh | Dedicated Agent Gateway `/mcp` manager | Phase 2 | Preserves protocol separation and independent lifecycle controls |
| No remote MCP session boundary | Connection-scoped canonical `sessionId` | Phase 2 | Restores audit continuity and downstream job visibility |

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | `ws` remains available at `^8.17.0` in this repo | Standard Stack | LOW - dependency already present in `package.json` |
| A2 | Existing MCP harness behavior should stay request-object based (`handleRequest(request)`) | Context Injection | LOW - confirmed in `mcpBackendProxyAdapter.js` |
| A3 | `requestContext.gatewayId` and/or `authContext.gatewayId` are sufficient to preserve authenticated gateway identity | Session Isolation | MEDIUM - adapter behavior should be validated in endpoint tests |
| A4 | `server.js` is the correct integration point for adding a second upgrade path | Integration Points | LOW - already owns the shared HTTP server and legacy WebSocket initialization |
| A5 | Default keepalive values do not need environment configuration in this phase | Scope | MEDIUM - test-only overrides may still be useful for deterministic heartbeat tests |

## Open Questions

1. **Should the manager export connection snapshot helpers for tests?**
   - What we know: Cleanup and session injection are easier to assert if tests can inspect connection metadata.
   - What's unclear: Whether that leaks too much internal structure into runtime code.
   - Recommendation: Export a minimal `getConnectionCount()` and maybe `getConnections()` helper from the manager, marked for diagnostics/testing only.

2. **Should authenticated `gatewayId` be mirrored into both `requestContext` and `authContext`?**
   - What we know: Existing adapter utilities read from both locations.
   - What's unclear: Whether downstream consumers rely on one over the other.
   - Recommendation: Mirror into both to minimize compatibility risk and document the canonical source in follow-up phases.

3. **Should heartbeat termination use one missed pong or interval + timeout pair?**
   - What we know: `ws` supports the standard `isAlive` loop; tests are easier with a single stale-cycle rule.
   - What's unclear: Whether production network behavior needs a more forgiving timeout.
   - Recommendation: Start with a single stale-cycle termination plus injectable interval values for tests; revisit tunability in Phase 5.

## Environment Availability

| Dependency | Required By | Available | Version | Fallback |
|------------|------------|-----------|---------|----------|
| Node.js | Runtime/tests | Yes | verified in repo runtime | — |
| `ws` | Dedicated `/mcp` manager and transport | Yes | `^8.17.0` | None |
| `node:test` | Transport + endpoint verification | Yes | built-in | — |
| `express` | Endpoint fixture server in tests | Yes | existing dependency | Native `http` server if needed |
| Existing Agent Gateway harness | MCP dispatch | Yes | repo local | Stub harness for low-level unit tests |

**Missing dependencies with no fallback:** None

## Validation Architecture

### Test Framework
| Property | Value |
|----------|-------|
| Framework | `node:test` |
| Config file | none |
| Quick run command | `node --test test/agent-gateway/transport/websocket-transport.test.js test/agent-gateway/adapters/agent-gateway-mcp-websocket.test.js` |
| Full suite command | `npm run test:agent-gateway-mcp-transport && npm run test:agent-gateway-mcp-websocket` |

### Phase Requirements to Test Map
| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| TRANS-01 | `/mcp` accepts authenticated websocket upgrades on the shared server | integration | `node --test test/agent-gateway/adapters/agent-gateway-mcp-websocket.test.js` | No - Wave 0 gap |
| TRANS-02 | Gateway key and bearer-token auth both work during upgrade | integration | `node --test test/agent-gateway/adapters/agent-gateway-mcp-websocket.test.js` | No - Wave 0 gap |
| TRANS-03 | Unauthorized upgrades are rejected before handshake completion | integration | `node --test test/agent-gateway/adapters/agent-gateway-mcp-websocket.test.js` | No - Wave 0 gap |
| TRANS-09 | Same socket gets a stable canonical `sessionId` injected on every harness call | integration | `node --test test/agent-gateway/adapters/agent-gateway-mcp-websocket.test.js` | No - Wave 0 gap |
| TRANS-10 | Native ping/pong keepalive preserves healthy sockets and terminates stale ones | unit + integration | `node --test test/agent-gateway/transport/websocket-transport.test.js test/agent-gateway/adapters/agent-gateway-mcp-websocket.test.js` | No - Wave 0 gap |
| OP-02 | Cleanup removes the connection from the dedicated registry on close/error | integration | `node --test test/agent-gateway/adapters/agent-gateway-mcp-websocket.test.js` | No - Wave 0 gap |
| OP-06 | `/mcp` stays isolated from the legacy mesh | integration | `node --test test/agent-gateway/adapters/agent-gateway-mcp-websocket.test.js` | No - Wave 0 gap |

### Sampling Rate
- **Per task commit:** run the focused test(s) for the touched component.
- **Per plan wave:** run `node --test test/agent-gateway/transport/websocket-transport.test.js test/agent-gateway/adapters/agent-gateway-mcp-websocket.test.js`.
- **Phase gate:** both websocket tests plus the existing stdio transport test suite are green before `/gsd-verify-work`.

### Wave 0 Gaps
- [ ] `modules/agentGateway/transport/webSocketTransport.js` - new transport contract implementation
- [ ] `modules/agentGateway/mcpWebSocketServer.js` - dedicated upgrade/session manager
- [ ] `test/agent-gateway/transport/websocket-transport.test.js` - focused transport tests
- [ ] `test/agent-gateway/adapters/agent-gateway-mcp-websocket.test.js` - endpoint integration tests
- [ ] `package.json` script entry for websocket MCP transport verification

## Security Domain

Phase 2 introduces a new network-facing entrypoint, so authentication and session management controls are part of the implementation itself.

### Applicable ASVS Categories

| ASVS Category | Applies | Standard Control |
|---------------|---------|-----------------|
| V2 Authentication | Yes | Reuse `resolveDedicatedGatewayAuth()` during HTTP upgrade; reject failures before handshake |
| V3 Session Management | Yes | Server-generated canonical `sessionId` per connection; never trust client override |
| V4 Access Control | Yes | `/mcp` path remains isolated from legacy mesh routing and registries |
| V5 Input Validation | Yes | Parse inbound text frames as JSON only after transport delivery; reject malformed requests with existing error behavior |
| V7 Error Handling | Yes | Keep stderr diagnostics server-side and avoid sending auth failure details during handshake rejection |

### Known Threat Patterns

| Threat | Why It Matters | Mitigation |
|--------|----------------|------------|
| Spoofed gateway identity | Header-based auth happens before a WebSocket session exists | Reuse `resolveDedicatedGatewayAuth()` and never accept unauthenticated upgrade continuation |
| Session fixation | Client may try to provide its own `sessionId` in request params | Always overwrite canonical connection `sessionId` during injection |
| Resource leakage | Long-lived sockets can leak timers/maps | Centralize idempotent cleanup on `close`, `error`, and heartbeat termination |
| Protocol confusion | JSON heartbeat messages could collide with MCP methods | Use native `ping`/`pong` control frames only |

## Sources

### Primary (HIGH confidence)
- Existing codebase analysis: `server.js`, `WebSocketServer.js`, `modules/agentGateway/mcpStdioServer.js`, `modules/agentGateway/contracts/protocolGovernance.js`, `modules/agentGateway/contracts/requestContext.js`, `modules/agentGateway/adapters/mcpBackendProxyAdapter.js`
- Existing MCP transport tests: `test/agent-gateway/adapters/agent-gateway-mcp-transport.test.js`
- Project dependency inventory: `package.json`

### Secondary (MEDIUM confidence)
- `ws` README / API docs: `noServer` shared-server upgrade pattern, guidance to authenticate in HTTP `upgrade`, and native heartbeat example using `ping`/`pong`

---

*Phase: 02-websocket-endpoint-session-management*
*Context gathered and researched: 2026-04-26*
