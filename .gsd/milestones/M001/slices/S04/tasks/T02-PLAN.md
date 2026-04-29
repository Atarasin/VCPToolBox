# T02: 04-capability-exposure 02

**Slice:** S04 — **Milestone:** M001

## Description

Harden and verify the remote MCP error contract so websocket clients see standardized MCP errors for prompt/tool/resource failures instead of backend-native leakage.

Purpose: Close CAP-05 with explicit end-to-end evidence that remote capability failures remain safe, stable, and transport-correct.
Output: MCP-standard error mapping verification over `/mcp`, plus any minimal adapter refinements needed to eliminate raw or inconsistent error shaping.

## Must-Haves

- [ ] "Remote prompt, tool, and resource failures are mapped to stable MCP-standard error codes rather than raw backend or stack-trace output"
- [ ] "Tool-result failures and JSON-RPC request failures preserve their distinct MCP shapes across the websocket transport"
- [ ] "Remote clients receive actionable MCP error metadata, including prompt-only guidance for `gateway_agent_render`, without leaking implementation details"

## Files

- `modules/agentGateway/adapters/mcpBackendProxyAdapter.js`
- `test/agent-gateway/adapters/agent-gateway-mcp-websocket.test.js`
- `test/agent-gateway/adapters/agent-gateway-mcp-transport.test.js`
