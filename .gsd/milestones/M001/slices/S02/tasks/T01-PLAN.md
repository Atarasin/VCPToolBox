# T01: 02-websocket-endpoint-session-management 01

**Slice:** S02 — **Milestone:** M001

## Description

Create the dedicated Agent Gateway websocket foundation for `/mcp`: a dumb-pipe `WebSocketTransport`, an isolated websocket manager that authenticates upgrades, injects canonical session context into every request, tracks connections in its own `Map`, and keeps sockets alive with native `ws` ping/pong.

Purpose: Deliver the Phase 2 transport boundary without touching the legacy distributed websocket mesh or changing harness business logic.
Output: New websocket transport file, dedicated `/mcp` manager module, updated transport exports, and focused transport tests.

## Must-Haves

- [ ] "A dedicated Agent Gateway websocket manager owns `/mcp` and does not modify the legacy `WebSocketServer.js` mesh"
- [ ] "Upgrade authentication reuses `resolveDedicatedGatewayAuth` and rejects failures with `socket.destroy()` before handshake completion"
- [ ] "Each authenticated socket gets a server-generated canonical `sessionId` injected into every harness call"
- [ ] "Native `ws` ping/pong keepalive and connection cleanup are owned by the dedicated manager"

## Files

- `modules/agentGateway/transport/mcpTransport.js`
- `modules/agentGateway/transport/webSocketTransport.js`
- `modules/agentGateway/transport/index.js`
- `modules/agentGateway/mcpWebSocketServer.js`
- `test/agent-gateway/transport/websocket-transport.test.js`
