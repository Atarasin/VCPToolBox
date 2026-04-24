# Research Summary: VCP Remote MCP WebSocket Bridge

**Project:** VCP Remote MCP Bridge
**Researched:** 2026-04-24
**Confidence:** HIGH

---

## Key Stack Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| **No MCP SDK dependency** | Custom transport adapter | VCP already has equivalent harness logic in `mcpBackendProxyAdapter.js`. Adding `@modelcontextprotocol/sdk` duplicates ~1500 lines of capability logic and forces a risky stdio refactor. |
| **Reuse existing runtime** | `ws@^8.17.0`, `express@^5.1.0`, `uuid@^9.0.0` | All already in production. Zero new dependencies needed. |
| **Transport abstraction** | `McpTransport` interface → `McpStdioTransport` + `McpWebSocketTransport` | One harness, two transports. Stdio behavior preserved exactly; WebSocket gets batch + session isolation. |
| **Auth at upgrade time** | `resolveDedicatedGatewayAuth` during HTTP Upgrade | Prevents auth bypass. Rejects unauthenticated clients with `socket.destroy()` before WS handshake completes. |
| **Native ws ping/pong** | RFC 6455 frames, not application JSON | Avoids collision with existing `ChromeObserver` heartbeat protocol. |

## Table Stakes for v1

1. **WebSocket endpoint at fixed URL** (`/mcp`) with upgrade-time auth
2. **JSON-RPC 2.0 framing** over WebSocket text frames
3. **MCP lifecycle**: `initialize`, `notifications/initialized`, `ping`
4. **Tool discovery and invocation**: `tools/list`, `tools/call` for memory search, context assembly, memory write
5. **Prompt and resource discovery**: `prompts/list`, `prompts/get`, `resources/list`, `resources/read`
6. **Per-connection session isolation** to prevent session bleed across concurrent clients
7. **Graceful connection close** with proper cleanup
8. **Existing stdio transport unchanged** — zero regression

## Critical Architectural Decisions

1. **Strict endpoint separation** — External MCP `/mcp` uses standard JSON-RPC; internal `/vcp-distributed-server` uses custom VCP protocol. Dedicated `mcpClients` Map, no shared routing.
2. **Singleton harness + per-connection context injection** — `createBackendProxyMcpServerHarness` is expensive to recreate. Session isolation happens at the transport layer via `requestContext.sessionId`, not multiple harness instances.
3. **Auth context propagation** — `authResult` from upgrade time must be threaded through to `harness.handleRequest` params so backend services receive correct scope and permissions.

## Top Pitfalls to Avoid

| # | Pitfall | Impact | Phase |
|---|---------|--------|-------|
| 1 | Auth after WebSocket upgrade | Security bypass, DoS | 1 |
| 2 | Missing per-connection `sessionId` injection | Session bleed, cross-client data leakage | 1 |
| 3 | No connection limits | Resource exhaustion, memory leak | 1 |
| 4 | Application-level heartbeat JSON | Collision with ChromeObserver, misrouted messages | 1 |
| 5 | Missing cleanup on disconnect | Memory leak, connection counter drift | 1 |
| 6 | Unbounded batch requests | Backend overload, event loop blocking | 2 |
| 7 | Protocol version mismatch | Client initialization failure | 1/3 |
| 8 | Query-parameter credential leak | Gateway key exposed in logs/history | 1 |
| 9 | Stdio transport refactor regression | Breaking existing local MCP consumers | 1 |

## Recommended Phase Structure

| Phase | Focus | Key Deliverables |
|-------|-------|-----------------|
| 1 | Transport Foundation | `McpTransport` interface, `McpStdioTransport` refactor, `McpWebSocketTransport`, `/mcp` upgrade handler, auth + session isolation |
| 2 | Capability Exposure & Integration | Wire harness methods over WebSocket, batch request caps, tool/prompt/resource validation |
| 3 | Client Integration & Validation | Test with Claude Desktop, Cursor, Trae; protocol version negotiation; auth fallback validation |
| 4 | Production Hardening | Rate limiting, payload limits, connection metrics, structured logging |
| 5 | Deferred Enhancements | Server-initiated push (`listChanged`), AdminPanel UI, expanded batch support |

## Open Questions

1. **Browser client scenario:** If no browser clients need to connect, query-param auth fallback can be eliminated entirely, removing Pitfall 8.
2. **`listChanged` event emission:** The capability service does not currently emit events. Enabling server-initiated push in Phase 5 requires adding an event emitter.
3. **CORS for WebSocket upgrade:** Do remote MCP clients need CORS preflight? Usually no for WS, but should be verified with actual client stacks.
4. **Backend request cancellation:** If a WebSocket client disconnects mid-request, can the in-flight `GatewayBackendClient` HTTP call be aborted?

## Sources

- MCP SDK v1.29.0 source (transport interface, stdio implementation, protocol routing)
- MCP Specification 2025-03-26
- VCP codebase: `mcpStdioServer.js`, `mcpBackendProxyAdapter.js`, `WebSocketServer.js`, `protocolGovernance.js`, `server.js`
- VCP design doc: `mydoc/export/mcp/mcp-remote-websocket-transport-design.md`
- VCP OpenSpec requirements for agent gateway MCP transport
