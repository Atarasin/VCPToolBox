# T02: 06-http-compatibility-layer 02

**Slice:** S06 — **Milestone:** M001

## Description

Finish the HTTP compatibility layer by adding a deprecated SSE MCP surface and packaging the resulting client guidance so Trae can use the new HTTP transport confidently.

Purpose: preserve compatibility for older HTTP+SSE MCP clients, document the preferred transport for Trae, and prove that HTTP additions do not regress existing stdio or websocket behavior.
Output: a compatibility-only SSE endpoint, parity tests for the legacy HTTP flow, and user-facing transport configuration guidance.

## Must-Haves

- [ ] "A deprecated HTTP+SSE compatibility endpoint exists at the fixed URL pair `GET /mcp/sse` and `POST /mcp/sse/messages`"
- [ ] "The SSE compatibility surface reuses the same `mcpHttpServer` runtime, session map, dedicated auth, and HTTP hardening controls instead of forking capability logic"
- [ ] "Representative lifecycle and capability parity is verified for both Streamable HTTP and the SSE compatibility flow"
- [ ] "Client-facing configuration and docs explicitly steer Trae to HTTP transport instead of websocket"
- [ ] "Three-transport coexistence is proven on one live `http.Server` running WebSocket, Streamable HTTP, and the SSE compatibility surface together"
- [ ] "Compatibility-only metadata stays inside the SSE adapter and never leaks into the backend-proxy harness or Gateway Core contracts"

## Files

- `modules/agentGateway/mcpHttpServer.js`
- `server.js`
- `test/agent-gateway/adapters/agent-gateway-mcp-http.test.js`
- `config.env.example`
- `mydoc/export/agent-gateway-consumer-guide.md`
