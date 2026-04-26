# Phase 4 Research: Capability Exposure

**Date:** 2026-04-26
**Phase:** 04-capability-exposure

## Summary

Phase 4 does not need a new MCP capability architecture. The backend-proxy adapter already publishes the relevant prompt/tool/resource surfaces and standardizes MCP error vocabulary; the missing work is proving that remote WebSocket clients can consume those capabilities end to end and tightening any remaining remote-surface gaps that the tests expose.

## Findings

### 1. The remote capability surface already exists in the backend-proxy adapter

From `modules/agentGateway/adapters/mcpBackendProxyAdapter.js`:
- `listTools()` publishes gateway-managed tools for remote hosts
- `callTool()` already routes `gateway_memory_search`, `gateway_context_assemble`, `gateway_memory_write`, `gateway_agent_bootstrap`, and job tools to the backend client
- `listPrompts()` and `getPrompt()` already expose `gateway_agent_render`
- `listResources()` and `readResource()` already provide resource plumbing and MCP error shaping

Implication:
- Phase 4 should start with real `/mcp` contract verification, not with a rewrite of capability registration

### 2. The stdio transport test is the best executable reference for the desired remote flow

From `test/agent-gateway/adapters/agent-gateway-mcp-transport.test.js`:
- the transport already proves `initialize -> prompts/list -> tools/list -> resources/list -> prompts/get -> tools/call`
- `gateway_agent_render` is intentionally excluded from `tools/list`
- `gateway_agent_render` tool calls already redirect clients toward `prompts/get`

Implication:
- The websocket path should reuse the same discovery and invocation contract where Phase 4 scope overlaps
- The safest plan is to mirror the relevant stdio assertions over real WebSocket

### 3. Existing websocket coverage is still capability-light

From `test/agent-gateway/adapters/agent-gateway-mcp-websocket.test.js`:
- Phase 2 and Phase 3 coverage already proves auth, parse recovery, batch handling, initialize, initialized, and ping
- one real-harness websocket assertion checks `tools/list` metadata after initialize
- there is no end-to-end websocket proof yet for remote `prompts/list`, `prompts/get`, or representative gateway-managed memory tool calls
- there is no websocket-first proof yet for CAP-05 error contracts

Implication:
- The main Phase 4 gap is remote acceptance coverage, not transport bootstrapping

### 4. MCP error semantics are intentionally split between request errors and tool-result failures

From `mcpBackendProxyAdapter.js`:
- malformed or unsupported prompt/resource/tool requests throw `createMcpError(...)`, which the harness maps into JSON-RPC errors with `error.data.code = MCP_*`
- backend failures for gateway-managed tool execution are normalized through `createFailureResult(...)`, which returns MCP tool results with `isError: true` and standardized `error.code`
- gateway canonical failures are translated by `mapGatewayFailureToMcpErrorCode(...)`

Implication:
- CAP-05 is not just "everything becomes a top-level JSON-RPC error"
- Phase 4 tests must verify both error shapes and ensure neither leaks raw stack traces

### 5. Resource success-path expansion is not the Phase 4 objective, but resource error mapping still matters

From `.planning/REQUIREMENTS.md`:
- resource discovery/read is deferred to v2 as a broad feature area
- CAP-05 still explicitly requires resource failures to map to MCP-standard error codes

Implication:
- Phase 4 should not over-invest in new resource features
- A focused remote resource-error check is enough to close the requirement without broadening scope

### 6. The websocket real-harness fixture is sufficient for memory flows by default, but not for prompt rendering

From `test/agent-gateway/helpers/agent-gateway-test-helpers.js` and `test/agent-gateway/adapters/agent-gateway-mcp-websocket.test.js`:
- the default websocket `createPluginManager()` already provides `vectorDBManager` and RAG helpers, so representative memory search/context/write flows can be made deterministic without inventing new infrastructure
- the same minimal plugin-manager shape does not provide `agentManager` or `agentRegistryRenderPrompt`
- `createGatewayServiceBundle()` passes `pluginManager.agentManager` and `pluginManager.agentRegistryRenderPrompt` into the native agent-registry service, so `prompts/get` needs a richer agent fixture

Implication:
- Phase 4 should explicitly require a richer real-harness fixture for prompt-fetch tests, ideally by mirroring the transport test's transport-plugin-manager pattern inside a shared websocket test helper

### 7. Unexpected backend exceptions currently leak raw `error.message` through the harness catch

From `mcpBackendProxyAdapter.js`:
- the harness catch block returns `error.message` directly in the JSON-RPC error payload for unexpected throws
- this avoids stack leakage, but a network or connection failure can still expose internal topology details in the message body

Implication:
- Phase 4 error-contract work should explicitly audit and, if necessary, sanitize representative thrown backend exceptions rather than checking only for missing stack traces

## Recommended Planning Split

### Plan 04-01
- Extend real `/mcp` websocket coverage for capability discovery and representative capability invocation
- Prove `tools/list`, `prompts/list`, `prompts/get`, and representative gateway-managed memory tool calls over the real backend-proxy path
- Tighten remote surface publication only if the real-harness tests uncover scope drift

### Plan 04-02
- Audit and harden MCP-standard error mapping for remote prompt/tool/resource failures
- Add websocket coverage for unsupported names, invalid arguments, policy failures, and resource errors so remote clients receive stable MCP codes rather than raw backend details

## Constraints To Preserve

- Do not move capability ownership into `mcpWebSocketServer.js`
- Do not fork websocket capability behavior away from the backend-proxy adapter already used by stdio
- Do not broaden this phase into Phase 5 hardening controls
- Keep `gateway_agent_render` on the prompt surface, not back on `tools/list`
- Keep comments and helper structure aligned with the current Agent Gateway style
