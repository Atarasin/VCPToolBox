# Phase 05 UAT

## Result

PASS

## Validation Summary

1. Success criterion: `OP-01` configurable maximum concurrent connection limit is enforced at `/mcp` upgrade time
   - Evidence: `modules/agentGateway/mcpWebSocketServer.js` rejects upgrades before `wss.handleUpgrade()` when the live connection count reaches `maxConnections`, and `server.js` wires the production bootstrap to `VCP_MCP_WS_MAX_CONNECTIONS`.
   - Tests: `enforces the configured websocket connection limit at upgrade time`, `prevents websocket connection-count drift across overlapping client teardown`

2. Success criterion: `OP-05` maximum JSON-RPC payload size is enforced and oversized messages are rejected cleanly
   - Evidence: `modules/agentGateway/mcpWebSocketServer.js` keeps the `ws` `maxPayload` ceiling active, and the connection manager cleanup path leaves no drift after oversized-frame rejection.
   - Tests: `rejects oversized websocket payloads promptly without hanging fixture shutdown`, `keeps the websocket server healthy after rejecting an oversized payload`

3. Success criterion: deferred hardening item `WR-02` is closed by bounding stalled upgrade authentication
   - Evidence: `modules/agentGateway/mcpWebSocketServer.js` wraps upgrade authentication in a bounded timeout and destroys stalled sockets without registering a live connection.
   - Tests: `aborts stalled websocket upgrade authentication with the configured timeout`

4. Success criterion: `OP-04` per-connection message rate limiting prevents backend overload before dispatch
   - Evidence: `modules/agentGateway/mcpWebSocketServer.js` stores limiter state per authenticated websocket connection, rejects excess traffic before `handleClientMessage()` is queued, and returns structured retry metadata for request messages while dropping notification-only overload safely.
   - Tests: `rate limits burst traffic per websocket connection and returns retry metadata`, `recovers the same websocket connection after the rate-limit window resets`, `keeps healthy websocket peers isolated from another connection being rate limited`, `drops rate-limited notifications without dispatching backend work`

5. Success criterion: overload and rejection paths do not poison later healthy traffic
   - Evidence: the hardening suite verifies that connection counts return to zero after teardown and that a healthy client can still complete a normal request after rejection paths.
   - Tests: `prevents websocket connection-count drift across overlapping client teardown`, `keeps the websocket server healthy after rejecting an oversized payload`, `keeps healthy websocket peers isolated from another connection being rate limited`

## Commands Run

- `npm run test:agent-gateway-mcp-websocket`

## Real-World Verification

1. Validation environment: Trae running on a second network-reachable device, with a direct websocket client session opened against the VCP `/mcp` endpoint
   - Initial blocker: websocket connect succeeded but the first `initialize` request received no response because the server process was missing `VCP_MCP_BACKEND_URL` for the backend-only MCP proxy runtime.
   - Fix applied: added `VCP_MCP_BACKEND_URL`, `VCP_MCP_BACKEND_KEY`, `VCP_MCP_BACKEND_GATEWAY_ID`, and `VCP_MCP_DEFAULT_AGENT_ID` to `config.env` and `config.env.example`, then restarted the server.

2. Remote websocket MCP handshake after the config fix
   - Request: `initialize`
   - Result: pass; the server returned `protocolVersion: 2025-06-18`, `serverInfo.name: vcp-agent-gateway`, and the expected `prompts`, `resources`, and `tools` capabilities.

3. Remote capability discovery and prompt fetch on the live websocket endpoint
   - Requests: `tools/list`, `prompts/get(name=gateway_agent_render)`
   - Result: pass; both requests completed successfully from the second device, confirming that the production `/mcp` websocket path is usable over the network after the MCP backend proxy environment is configured.

4. Client compatibility boundary discovered during UAT
   - Trae's built-in MCP client currently supports `stdio`, `SSE`, and `Streamable HTTP`, but not websocket transport.
   - Conclusion: the production `/mcp` websocket endpoint itself is validated and archived as working, but Trae cannot consume it via its native MCP client configuration. Trae must use the existing stdio bridge today, or VCP must add an HTTP MCP transport in a future milestone.

## Outcome

- Tests passed: `52/52`
- Regression status: no Phase 5 functional regression found in the `/mcp` websocket hardening scope
- Remaining known risk: Phase 5 hardening remains instance-local by design; global multi-process quotas and broader observability are still explicitly out of scope for this milestone
- Field validation status: remote websocket MCP path verified on a second device for `initialize`, `tools/list`, and `prompts/get(gateway_agent_render)` after backend proxy env configuration was corrected
- Compatibility note: Trae currently cannot use the websocket transport through its native MCP client, so Trae integration should continue through stdio until an HTTP MCP surface exists
