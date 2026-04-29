# T01: 01-transport-abstraction-stdio-preservation 01

**Slice:** S01 — **Milestone:** M001

## Description

Extract stdio I/O logic from `mcpStdioServer.js` into a reusable `McpTransport` abstraction, create a new `createStdioMcpServer` factory, and preserve `startStdioMcpServer` as a thin backwards-compatible wrapper. Zero behavioral changes for existing consumers.

Purpose: Enable Phase 2 WebSocket transport without touching harness logic by establishing a clean transport interface.
Output: New `transport/` directory with interface + stdio implementation, refactored `mcpStdioServer.js` with factory + wrapper, new unit tests for transport contract.

## Must-Haves

- [ ] "Existing stdio MCP clients continue to work without any configuration changes"
- [ ] "A new McpTransport interface abstracts message sending, receiving, and connection lifecycle"
- [ ] "The stdio transport implements McpTransport with identical behavior to pre-refactor"
- [ ] "All existing stdio MCP integration tests pass without modification"

## Files

- `modules/agentGateway/transport/mcpTransport.js`
- `modules/agentGateway/transport/stdioTransport.js`
- `modules/agentGateway/transport/index.js`
- `modules/agentGateway/mcpStdioServer.js`
- `scripts/start-agent-gateway-mcp-server.js`
- `test/agent-gateway/transport/stdio-transport.test.js`
