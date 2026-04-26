# 04-01 Summary

## Completed

- Added `createRealHarnessFixture()` to `test/agent-gateway/adapters/agent-gateway-mcp-websocket.test.js` so websocket capability tests share one explicit backend-proxy setup path with temporary agent prompt wiring and consistent cleanup.
- Extended the websocket suite with real-harness coverage for `tools/list`, `prompts/list`, `prompts/get`, and mixed batch capability discovery so remote `/mcp` clients are verified against the same published surface as stdio clients.
- Added representative real-harness success-path assertions for `gateway_memory_search` and `gateway_context_assemble` to confirm websocket `tools/call` responses stay MCP-shaped instead of leaking backend-native envelopes.
- Added an explicit `mock harness:` websocket test for `gateway_memory_write` success shaping because the native backend test fixture does not provide the `DailyNote` write capability required for a true end-to-end write success path. The mixed-fixture exception is now visible in the test name and localized to this single case.

## Verification

- `node --test --test-name-pattern "real harness: websocket capability discovery exposes prompt-only and tool-only gateway surfaces|real harness: websocket prompts/get returns rendered prompt content with host hints|real harness: websocket representative gateway-managed search and context calls keep MCP result shaping|mock harness: websocket memory write preserves MCP tool-result success shaping|real harness: websocket batch capability discovery preserves per-entry prompt and tool semantics" test/agent-gateway/adapters/agent-gateway-mcp-websocket.test.js`

## Coverage Highlights

- Remote websocket clients now prove that `gateway_agent_render` stays prompt-only while gateway-managed memory operations stay tool-only.
- Remote `prompts/get` responses preserve rendered MCP message content plus host-hint metadata (`primarySurface`, resolved `agentId`, `requestId`) needed by tool-only hosts.
- Real websocket batch calls now prove transport-correct array responses for `tools/list`, `prompts/list`, and `prompts/get` over the backend-proxy harness.
- Representative websocket `tools/call` success paths now cover the gateway-managed memory search/context contract and a visible exception path for memory-write success shaping.
