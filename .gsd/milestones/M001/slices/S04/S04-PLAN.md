# S04: Capability Exposure

**Goal:** Prove that real remote WebSocket MCP clients can discover and use the intended Agent Gateway prompt and gateway-managed memory capabilities over `/mcp`.
**Demo:** Prove that real remote WebSocket MCP clients can discover and use the intended Agent Gateway prompt and gateway-managed memory capabilities over `/mcp`.

## Must-Haves


## Tasks

- [x] **T01: 04-capability-exposure 01**
  - Prove that real remote WebSocket MCP clients can discover and use the intended Agent Gateway prompt and gateway-managed memory capabilities over `/mcp`.

Purpose: Close CAP-01 through CAP-04 by validating the real backend-proxy capability surface through the production WebSocket path instead of relying on stdio-only or stub-only coverage.
Output: Expanded websocket capability tests and only the smallest necessary adapter adjustments if the remote surface still drifts from the documented contract.
- [x] **T02: 04-capability-exposure 02**
  - Harden and verify the remote MCP error contract so websocket clients see standardized MCP errors for prompt/tool/resource failures instead of backend-native leakage.

Purpose: Close CAP-05 with explicit end-to-end evidence that remote capability failures remain safe, stable, and transport-correct.
Output: MCP-standard error mapping verification over `/mcp`, plus any minimal adapter refinements needed to eliminate raw or inconsistent error shaping.

## Files Likely Touched

- `modules/agentGateway/adapters/mcpBackendProxyAdapter.js`
- `test/agent-gateway/adapters/agent-gateway-mcp-websocket.test.js`
- `modules/agentGateway/adapters/mcpBackendProxyAdapter.js`
- `test/agent-gateway/adapters/agent-gateway-mcp-websocket.test.js`
- `test/agent-gateway/adapters/agent-gateway-mcp-transport.test.js`
