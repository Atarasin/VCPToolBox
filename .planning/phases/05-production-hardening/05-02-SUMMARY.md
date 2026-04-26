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
