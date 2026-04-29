# S02: Websocket Endpoint Session Management

**Goal:** Create the dedicated Agent Gateway websocket foundation for `/mcp`: a dumb-pipe `WebSocketTransport`, an isolated websocket manager that authenticates upgrades, injects canonical session context into every request, tracks connections in its own `Map`, and keeps sockets alive with native `ws` ping/pong.
**Demo:** Create the dedicated Agent Gateway websocket foundation for `/mcp`: a dumb-pipe `WebSocketTransport`, an isolated websocket manager that authenticates upgrades, injects canonical session context into every request, tracks connections in its own `Map`, and keeps sockets alive with native `ws` ping/pong.

## Must-Haves


## Tasks

- [x] **T01: 02-websocket-endpoint-session-management 01**
  - Create the dedicated Agent Gateway websocket foundation for `/mcp`: a dumb-pipe `WebSocketTransport`, an isolated websocket manager that authenticates upgrades, injects canonical session context into every request, tracks connections in its own `Map`, and keeps sockets alive with native `ws` ping/pong.

Purpose: Deliver the Phase 2 transport boundary without touching the legacy distributed websocket mesh or changing harness business logic.
Output: New websocket transport file, dedicated `/mcp` manager module, updated transport exports, and focused transport tests.
- [x] **T02: 02-websocket-endpoint-session-management 02**
  - Finish Phase 2 by wiring the dedicated websocket manager into the real server lifecycle and adding endpoint-level tests that prove `/mcp` behaves correctly for authenticated clients, rejected upgrades, canonical session injection, keepalive, cleanup, and isolation from the legacy websocket mesh.

Purpose: Turn the isolated websocket foundation from Plan 01 into a runnable VCP server capability with repeatable verification.
Output: `server.js` startup/shutdown wiring, websocket endpoint integration tests, and a dedicated npm test command.

## Files Likely Touched

- `modules/agentGateway/transport/mcpTransport.js`
- `modules/agentGateway/transport/webSocketTransport.js`
- `modules/agentGateway/transport/index.js`
- `modules/agentGateway/mcpWebSocketServer.js`
- `test/agent-gateway/transport/websocket-transport.test.js`
- `server.js`
- `package.json`
- `test/agent-gateway/adapters/agent-gateway-mcp-websocket.test.js`
