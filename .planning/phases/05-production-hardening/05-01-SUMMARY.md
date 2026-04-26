# 05-01 Summary

## Completed

- Updated `modules/agentGateway/mcpWebSocketServer.js` to finish the transport guardrails around `/mcp`, including configurable connection admission, payload ceilings, and a bounded upgrade-auth timeout with cleanup-safe teardown ordering.
- Wired the production bootstrap in `server.js` to read `VCP_MCP_WS_MAX_CONNECTIONS`, `VCP_MCP_WS_MAX_PAYLOAD_BYTES`, and `VCP_MCP_WS_UPGRADE_AUTH_TIMEOUT_MS` so the real server path enforces the documented Phase 5 limits instead of relying on test-only overrides.
- Extended `test/agent-gateway/adapters/agent-gateway-mcp-websocket.test.js` with endpoint coverage for upgrade-time connection rejection, connection-count drift cleanup, oversized payload rejection, healthy follow-up traffic after rejection, and stalled-upgrade timeout protection.

## Verification

- `npm run test:agent-gateway-mcp-websocket`

## Coverage Highlights

- The real `/mcp` bootstrap now enforces `VCP_MCP_WS_MAX_CONNECTIONS` before `wss.handleUpgrade()`, so excess clients are rejected before a live MCP session exists.
- Oversized websocket frames are rejected promptly without leaving connection-count drift or poisoning later healthy websocket traffic.
- Stalled upgrade authentication is bounded by `VCP_MCP_WS_UPGRADE_AUTH_TIMEOUT_MS`, and timeout cleanup runs without registering a partial connection.
