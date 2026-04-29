# T02: 02-websocket-endpoint-session-management 02

**Slice:** S02 — **Milestone:** M001

## Description

Finish Phase 2 by wiring the dedicated websocket manager into the real server lifecycle and adding endpoint-level tests that prove `/mcp` behaves correctly for authenticated clients, rejected upgrades, canonical session injection, keepalive, cleanup, and isolation from the legacy websocket mesh.

Purpose: Turn the isolated websocket foundation from Plan 01 into a runnable VCP server capability with repeatable verification.
Output: `server.js` startup/shutdown wiring, websocket endpoint integration tests, and a dedicated npm test command.

## Must-Haves

- [ ] "`server.js` initializes and shuts down the dedicated Agent Gateway `/mcp` websocket manager alongside the existing HTTP server lifecycle"
- [ ] "Automated endpoint tests prove authenticated connect, pre-handshake rejection, canonical session continuity, keepalive behavior, and cleanup"
- [ ] "A repeatable websocket MCP test command exists in `package.json` and runs alongside the existing stdio MCP transport suite"

## Files

- `server.js`
- `package.json`
- `test/agent-gateway/adapters/agent-gateway-mcp-websocket.test.js`
