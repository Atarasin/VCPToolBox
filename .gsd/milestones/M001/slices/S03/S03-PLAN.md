# S03: Mcp Protocol Compliance

**Goal:** Upgrade the dedicated `/mcp` websocket manager from single-request-only JSON-RPC handling to protocol-correct WebSocket framing with bounded batch support.
**Demo:** Upgrade the dedicated `/mcp` websocket manager from single-request-only JSON-RPC handling to protocol-correct WebSocket framing with bounded batch support.

## Must-Haves


## Tasks

- [x] **T01: 03-mcp-protocol-compliance 01**
  - Upgrade the dedicated `/mcp` websocket manager from single-request-only JSON-RPC handling to protocol-correct WebSocket framing with bounded batch support.

Purpose: Close the largest Phase 3 gap without changing Gateway Core business logic or stdio behavior.
Output: Updated `mcpWebSocketServer.js` batch handling plus endpoint tests that prove WebSocket frame semantics and batch correctness.
- [x] **T02: 03-mcp-protocol-compliance 02**
  - Prove that the real MCP lifecycle works correctly over the remote WebSocket transport and clean up any initialize metadata that is now transport-inaccurate.

Purpose: Make remote MCP clients able to handshake confidently against `/mcp` without inventing a parallel websocket-specific lifecycle contract.
Output: transport-correct initialize metadata plus real-harness websocket tests for `initialize`, repeated `notifications/initialized`, and `ping`.

## Files Likely Touched

- `modules/agentGateway/mcpWebSocketServer.js`
- `test/agent-gateway/adapters/agent-gateway-mcp-websocket.test.js`
- `modules/agentGateway/adapters/mcpBackendProxyAdapter.js`
- `test/agent-gateway/adapters/agent-gateway-mcp-websocket.test.js`
- `test/agent-gateway/adapters/agent-gateway-mcp-transport.test.js`
