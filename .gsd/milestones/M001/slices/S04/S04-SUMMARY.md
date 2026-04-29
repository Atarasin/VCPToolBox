---
id: S04
parent: M001
milestone: M001
provides: []
requires: []
affects: []
key_files: []
key_decisions: []
patterns_established: []
observability_surfaces: []
drill_down_paths: []
duration: 
verification_result: passed
completed_at: 
blocker_discovered: false
---
# S04: Capability Exposure

**# 04-01 Summary**

## What Happened

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

# 04-02 Summary

## Completed

- Updated `modules/agentGateway/adapters/mcpBackendProxyAdapter.js` to sanitize unexpected backend exceptions before they become JSON-RPC errors, while preserving explicit MCP error codes and sanitized metadata for expected gateway failures.
- Documented `createBackendProxyMcpServerHarness()` as a shared singleton-style harness so future transport work keeps mutable per-connection state in request/session context instead of on the harness object.
- Extended `test/agent-gateway/adapters/agent-gateway-mcp-websocket.test.js` with real backend-proxy coverage for prompt misuse, tool misuse guidance, diary policy rejections, unsupported tool/resource requests, sanitized runtime failures, and mixed success/error batch semantics.
- Extended `test/agent-gateway/adapters/agent-gateway-mcp-transport.test.js` with a stdio parity test that asserts representative backend runtime failures stay sanitized and MCP-shaped.

## Verification

- `node --test test/agent-gateway/adapters/agent-gateway-mcp-adapter.test.js test/agent-gateway/adapters/agent-gateway-mcp-transport.test.js test/agent-gateway/adapters/agent-gateway-mcp-websocket.test.js`

## Coverage Highlights

- Remote websocket and stdio clients now receive stable `MCP_*` codes for prompt/tool/resource contract violations instead of raw backend exception output.
- Tool-level policy rejections remain result-scoped `isError` responses, so transports preserve MCP surface semantics instead of upgrading them to transport failures.
- Representative backend connectivity failures no longer leak stack traces, hostnames, ports, or raw `ECONNREFUSED` details through JSON-RPC error payloads.
- Mixed JSON-RPC websocket batches preserve per-entry success/error behavior while still using the shared real backend-proxy harness.

## Test Stability Notes

- Added explicit timeouts to the websocket integration and regression tests so transport hangs fail fast with actionable errors instead of stalling the whole suite.
- Hardened the websocket fixture shutdown path to track and destroy residual TCP sockets before awaiting `server.close()`, preventing lingering upgrade connections from blocking test process exit.
- Adjusted the sibling-websocket-stack regression test to defer its first server frame slightly, avoiding a message-listener race where the client could miss an immediately-sent payload and appear hung.
- Verified the hang-prevention changes with the focused websocket regression subset and the full phase-4 adapter/transport/websocket test matrix.
