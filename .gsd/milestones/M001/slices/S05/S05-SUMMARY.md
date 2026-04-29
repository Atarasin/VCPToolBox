---
id: S05
parent: M001
milestone: M001
provides: []
requires: []
affects: []
key_files: []
key_decisions: []
patterns_established: []
observability_surfaces: []
drill_down_paths: []
duration: 
verification_result: passed
completed_at: 
blocker_discovered: false
---
# S05: Production Hardening

**# 05-01 Summary**

## What Happened

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

# 05-02 Summary

## Completed

- Added transport-local per-connection message rate limiting in `modules/agentGateway/mcpWebSocketServer.js` so bursty websocket clients are throttled before backend dispatch instead of accumulating unbounded shared work.
- Standardized the overflow response as a stable JSON-RPC error payload with actionable metadata, including `AGW_RATE_LIMITED`, `retryAfterMs`, `limit`, and `windowMs`, while dropping notification-only overload without dispatching backend work.
- Extended `test/agent-gateway/adapters/agent-gateway-mcp-websocket.test.js` with focused coverage for burst rejection, same-connection recovery after the rate-limit window resets, healthy-peer isolation, and notification-drop behavior.

## Verification

- `npm run test:agent-gateway-mcp-websocket`

## Coverage Highlights

- Each authenticated websocket connection now maintains independent limiter state, so one abusive client does not throttle healthy peers.
- Rate-limited request messages fail fast with retry guidance that remote MCP clients can act on deterministically.
- The same websocket connection recovers after the configured window expires, proving the limiter is bounded rather than permanently poisoning the session.
