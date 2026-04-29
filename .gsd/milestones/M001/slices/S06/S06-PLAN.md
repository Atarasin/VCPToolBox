# S06: Http Compatibility Layer

**Goal:** Add the primary HTTP MCP surface needed for Trae-native remote compatibility by implementing a standards-aligned Streamable HTTP endpoint on `/mcp`.
**Demo:** Add the primary HTTP MCP surface needed for Trae-native remote compatibility by implementing a standards-aligned Streamable HTTP endpoint on `/mcp`.

## Must-Haves


## Tasks

- [x] **T01: 06-http-compatibility-layer 01**
  - Add the primary HTTP MCP surface needed for Trae-native remote compatibility by implementing a standards-aligned Streamable HTTP endpoint on `/mcp`.

Purpose: expose the already-validated MCP prompt and memory surface through normal HTTP requests while preserving websocket coexistence and transport-local session ownership.
Output: a canonical `/mcp` Streamable HTTP transport with session handling, dedicated auth reuse, and parity tests for lifecycle plus representative capability calls.
- [x] **T02: 06-http-compatibility-layer 02**
  - Finish the HTTP compatibility layer by adding a deprecated SSE MCP surface and packaging the resulting client guidance so Trae can use the new HTTP transport confidently.

Purpose: preserve compatibility for older HTTP+SSE MCP clients, document the preferred transport for Trae, and prove that HTTP additions do not regress existing stdio or websocket behavior.
Output: a compatibility-only SSE endpoint, parity tests for the legacy HTTP flow, and user-facing transport configuration guidance.

## Files Likely Touched

- `modules/agentGateway/mcpHttpServer.js`
- `modules/agentGateway/index.js`
- `server.js`
- `config.env.example`
- `test/agent-gateway/adapters/agent-gateway-mcp-http.test.js`
- `modules/agentGateway/mcpHttpServer.js`
- `server.js`
- `test/agent-gateway/adapters/agent-gateway-mcp-http.test.js`
- `config.env.example`
- `mydoc/export/agent-gateway-consumer-guide.md`
