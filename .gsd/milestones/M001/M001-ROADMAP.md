# M001: Migration

**Vision:** VCP is a modular Node.js plugin platform with a distributed runtime, RAG/memory system, and agent gateway. This milestone extends the existing local-only stdio MCP service so that external MCP clients can connect remotely over WebSocket and HTTP, authenticate via VCP's existing user system, and use the RAG/memory tools already exposed locally.

## Success Criteria


## Slices

- [x] **S01: Transport Abstraction Stdio Preservation** `risk:medium` `depends:[]`
  > After this: Extract stdio I/O logic from `mcpStdioServer.js` into a reusable `McpTransport` abstraction, creating a clean transport interface that enables Phase 2 WebSocket reuse without touching harness logic.
- [x] **S02: Websocket Endpoint Session Management** `risk:medium` `depends:[S01]`
  > After this: Create the dedicated Agent Gateway websocket foundation for `/mcp`: a dumb-pipe `WebSocketTransport`, an isolated websocket manager that authenticates upgrades, injects canonical session context into every request, tracks connections in its own `Map`, and keeps sockets alive with native `ws` ping/pong.
- [x] **S03: Mcp Protocol Compliance** `risk:medium` `depends:[S02]`
  > After this: Upgrade the dedicated `/mcp` websocket manager from single-request-only JSON-RPC handling to protocol-correct WebSocket framing with bounded batch support.
- [x] **S04: Capability Exposure** `risk:medium` `depends:[S03]`
  > After this: Prove that real remote WebSocket MCP clients can discover and use the intended Agent Gateway prompt and gateway-managed memory capabilities over `/mcp`.
- [x] **S05: Production Hardening** `risk:medium` `depends:[S04]`
  > After this: Finish the transport guardrails that make `/mcp` operationally safe before any backend request work begins.
- [ ] **S06: Http Compatibility Layer** `risk:medium` `depends:[S05]`
  > After this: Add the primary HTTP MCP surface needed for Trae-native remote compatibility by implementing a standards-aligned Streamable HTTP endpoint on `/mcp`.
