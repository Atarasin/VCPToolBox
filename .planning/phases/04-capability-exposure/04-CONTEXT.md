# Phase 4: Capability Exposure - Context

**Gathered:** 2026-04-26
**Status:** Ready for planning

<domain>
## Phase Boundary

Make the authenticated `/mcp` WebSocket endpoint expose the already-supported Agent Gateway prompt and gateway-managed memory capabilities to remote MCP clients through the real backend-proxy harness.

In scope: remote `tools/list`, representative `tools/call` coverage for the gateway-managed memory surfaces (`gateway_memory_search`, `gateway_context_assemble`, `gateway_memory_write`), remote `prompts/list`, remote `prompts/get`, and verification that prompt/tool/resource failures map to standard MCP error codes rather than leaking raw transport or backend errors.
Out of scope: new Gateway Core business logic, new prompt/tool descriptor families, production hardening controls from Phase 5, and v2 resource-expansion work beyond the narrow error-contract checks needed for CAP-05.

</domain>

<decisions>
## Implementation Decisions

### Capability Ownership
- **D-01:** `modules/agentGateway/adapters/mcpBackendProxyAdapter.js` remains the canonical owner of remote MCP capability discovery, invocation, and error mapping. `mcpWebSocketServer.js` must stay focused on transport, framing, auth context injection, and connection lifecycle.
- **D-02:** Phase 4 verifies the existing backend-proxy capability surface over WebSocket instead of inventing a websocket-only adapter branch. The remote path should reuse the same harness contract already exercised by stdio.
- **D-03:** `gateway_agent_render` stays a prompt-only surface. If clients attempt to call it as a tool, the remote MCP contract should continue steering them to `prompts/get`.

### Scope For This Phase
- **D-04:** Phase 4 success is defined by remote discoverability and invocation of the gateway-managed memory/prompt surface, not by exposing arbitrary local plugin tools over the remote transport.
- **D-05:** Resource success-path expansion is still deferred, but CAP-05 requires resource failures to follow the same MCP-standard error vocabulary as prompt failures.

### Verification Strategy
- **D-06:** Real `/mcp` websocket tests should use a real backend-proxy harness path wherever possible so the phase proves transport exposure, not just local stub behavior.
- **D-07:** Tool failure semantics and prompt/resource failure semantics are intentionally different and both must be preserved:
  - prompt/resource request contract failures surface as JSON-RPC errors with MCP-standard codes in `error.data.code`
  - gateway-managed tool runtime or policy failures surface as MCP tool results with `isError: true` and standardized `error.code`

### Claude's Discretion
- Choose the smallest stable fixture strategy for representative remote capability calls, provided it exercises the real websocket path and keeps assertions deterministic.
- Add small websocket-test helpers or backend stub helpers if they materially reduce duplicated setup.

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Project requirements and roadmap
- `.planning/ROADMAP.md` — Phase 4 goal, dependency on Phase 3, and success criteria for remote tools/prompts plus MCP-standard error mapping.
- `.planning/REQUIREMENTS.md` — `CAP-01` through `CAP-05` define the remote capability-exposure contract.
- `.planning/STATE.md` — Confirms Phase 3 is complete and Phase 4 is the active planning target.

### Existing implementation to reuse
- `modules/agentGateway/adapters/mcpBackendProxyAdapter.js` — Canonical backend-proxy MCP capability surface for `tools/list`, `tools/call`, `prompts/list`, `prompts/get`, `resources/list`, `resources/read`, and MCP error mapping.
- `modules/agentGateway/mcpWebSocketServer.js` — Real `/mcp` transport path that injects canonical request/session/auth context before dispatching to the harness.
- `modules/agentGateway/mcpStdioServer.js` — Runtime bootstrap used by both stdio and WebSocket when the backend-proxy harness is initialized from transport code.
- `routes/agentGatewayRoutes.js` — Native backend endpoint surface consumed by the backend-proxy client during real-harness tests.

### Existing tests and fixtures
- `test/agent-gateway/adapters/agent-gateway-mcp-transport.test.js` — Executable reference for the backend-proxy MCP capability flow over stdio, including prompts/tools/resources and parse-error recovery.
- `test/agent-gateway/adapters/agent-gateway-mcp-websocket.test.js` — Existing websocket auth, framing, lifecycle, and limited real-harness coverage that Phase 4 should extend.
- `test/agent-gateway/adapters/agent-gateway-mcp-adapter.test.js` — Deeper adapter-level assertions for gateway-managed tool behavior, diary policy, and MCP error mapping.

### Research and design references
- `.planning/research/FEATURES.md` — Notes the existing gateway-managed MCP capability model and deferred-event resource shape.
- `mydoc/export/mcp/agent-gateway-mcp-low-conflict-coexistence-design.md` — Confirms prompt surface ownership and the intended first-wave backend-managed tool list for MCP exposure.
- `mydoc/export/mcp/mcp-coding-recall-rag-flow.md` — Summarizes the bootstrap/prompt and diary-memory call paths that Phase 4 is surfacing remotely.

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- `createBackendProxyMcpAdapter()` already implements the remote-facing capability methods and restricts discovery to gateway-managed prompts/tools/resources.
- `createBackendProxyMcpServerHarness().handleRequest()` already dispatches MCP lifecycle methods plus prompt/tool/resource methods through one shared JSON-RPC envelope.
- `mapGatewayFailureToMcpErrorCode()` and `createFailureResult()` already centralize MCP error vocabulary for backend failures.

### Established Patterns
- The project prefers real transport tests backed by lightweight in-process HTTP fixtures over heavy mocks.
- WebSocket request processing is serialized per connection, so representative capability tests can assert deterministic ordering and context propagation.
- Remote prompt rendering already uses `prompts/get` as the primary surface, with `gateway_agent_bootstrap` kept as a fallback tool surface.

### Integration Points
- Remote capability exposure should land primarily in websocket endpoint tests and only touch adapter code if real `/mcp` behavior still diverges from the documented contract.
- Any scope tightening for published remote capabilities belongs in `mcpBackendProxyAdapter.js`, not in the websocket manager.

</code_context>

<specifics>
## Specific Ideas

- Mirror the strongest parts of the stdio transport test in the websocket suite: discover prompts/tools, fetch a prompt, and invoke representative gateway-managed memory operations over the real `/mcp` path.
- Treat CAP-05 as a transport-contract test problem first: prove remote clients receive stable MCP codes for prompt/tool/resource failures and do not see raw stack traces.
- Keep Phase 4 focused on the backend-proxy surface already intended for remote hosts; avoid accidentally broadening remote exposure to local-only plugin tools.

</specifics>

<deferred>
## Deferred Ideas

- Expanding remote resource success-path coverage beyond the minimal error-contract checks stays deferred with the broader v2 resource scope.
- Server-initiated `list_changed` notifications remain out of scope.
- Connection limits, rate limiting, payload ceilings, and upgrade-auth timeout protection remain Phase 5 work.

</deferred>

---

*Phase: 04-capability-exposure*
*Context gathered: 2026-04-26*
