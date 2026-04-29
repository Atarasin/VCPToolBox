# T01: 04-capability-exposure 01

**Slice:** S04 — **Milestone:** M001

## Description

Prove that real remote WebSocket MCP clients can discover and use the intended Agent Gateway prompt and gateway-managed memory capabilities over `/mcp`.

Purpose: Close CAP-01 through CAP-04 by validating the real backend-proxy capability surface through the production WebSocket path instead of relying on stdio-only or stub-only coverage.
Output: Expanded websocket capability tests and only the smallest necessary adapter adjustments if the remote surface still drifts from the documented contract.

## Must-Haves

- [ ] "Remote `/mcp` websocket clients can discover the intended gateway-managed tools and prompts through the real backend-proxy harness"
- [ ] "Remote websocket clients can fetch `gateway_agent_render` through `prompts/get` and invoke representative gateway-managed memory operations through `tools/call`"
- [ ] "The remote capability surface stays aligned with the backend-proxy adapter rather than diverging into websocket-only logic"

## Files

- `modules/agentGateway/adapters/mcpBackendProxyAdapter.js`
- `test/agent-gateway/adapters/agent-gateway-mcp-websocket.test.js`
