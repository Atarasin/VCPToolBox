# S01: Transport Abstraction Stdio Preservation

**Goal:** Extract stdio I/O logic from `mcpStdioServer.
**Demo:** Extract stdio I/O logic from `mcpStdioServer.

## Must-Haves


## Tasks

- [x] **T01: 01-transport-abstraction-stdio-preservation 01**
  - Extract stdio I/O logic from `mcpStdioServer.js` into a reusable `McpTransport` abstraction, create a new `createStdioMcpServer` factory, and preserve `startStdioMcpServer` as a thin backwards-compatible wrapper. Zero behavioral changes for existing consumers.

Purpose: Enable Phase 2 WebSocket transport without touching harness logic by establishing a clean transport interface.
Output: New `transport/` directory with interface + stdio implementation, refactored `mcpStdioServer.js` with factory + wrapper, new unit tests for transport contract.

## Files Likely Touched

- `modules/agentGateway/transport/mcpTransport.js`
- `modules/agentGateway/transport/stdioTransport.js`
- `modules/agentGateway/transport/index.js`
- `modules/agentGateway/mcpStdioServer.js`
- `scripts/start-agent-gateway-mcp-server.js`
- `test/agent-gateway/transport/stdio-transport.test.js`
