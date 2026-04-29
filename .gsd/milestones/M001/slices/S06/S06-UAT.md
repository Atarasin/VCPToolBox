# S06: Http Compatibility Layer — UAT

**Milestone:** M001
**Written:** 2026-04-29T14:15:54.982Z

## UAT: S06 — HTTP Compatibility Layer

### Streamable HTTP Lifecycle
1. Start VCP with `VCP_MCP_BACKEND_URL`, `VCP_MCP_BACKEND_KEY`, `VCP_MCP_BACKEND_GATEWAY_ID` configured.
2. `POST /mcp` with `initialize` JSON-RPC request and valid `x-agent-gateway-key` or `Authorization: Bearer` header.
3. Verify response contains `result.protocolVersion`, `result.capabilities`, and `MCP-Session-Id` response header.
4. `POST /mcp` with `tools/list` including the `MCP-Session-Id` header from step 3.
5. Verify response lists gateway-managed memory tools (`gateway_memory_search`, `gateway_context_assemble`, etc.).

### SSE Streaming
6. `GET /mcp` with the same `MCP-Session-Id` and auth headers.
7. Verify SSE stream opens, emits heartbeat comments periodically, and mirrors JSON-RPC responses for previously submitted requests.

### Session Cleanup
8. `DELETE /mcp` with the same `MCP-Session-Id`.
9. Verify `204 No Content` and that subsequent requests with the old session ID are rejected.

### Deprecated SSE Compatibility
10. `GET /mcp/sse` with auth headers.
11. Verify SSE endpoint publishes compatibility metadata and accepts companion `POST /mcp/sse/messages` for JSON-RPC dispatch.

### Transport Coexistence
12. Confirm WebSocket upgrades to `/mcp` still work concurrently with HTTP traffic.
13. Confirm stdio MCP continues to pass its regression suite unchanged.

### Negative Cases
14. `POST /mcp` with oversize payload (> `VCP_MCP_HTTP_MAX_PAYLOAD`) → verify `413 Payload Too Large`.
15. `POST /mcp` with missing auth → verify `401 Unauthorized`.
16. `POST /mcp` with unknown `MCP-Session-Id` (non-initialize) → verify session rejection.
