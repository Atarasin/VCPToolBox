# Phase 3: MCP Protocol Compliance - Context

**Gathered:** 2026-04-26
**Status:** Ready for planning

<domain>
## Phase Boundary

Make the authenticated `/mcp` WebSocket endpoint protocol-correct for remote MCP clients: one JSON-RPC message per WebSocket text frame, bounded batch support, and a verified MCP lifecycle (`initialize`, `notifications/initialized`, `ping`) over the real WebSocket transport.

In scope: WebSocket JSON-RPC framing semantics, batch request handling with an explicit maximum size, aggregation rules for mixed request/notification batches, initialize lifecycle correctness over WebSocket, and focused protocol-compliance tests.
Out of scope: remote tool/prompt/resource capability exposure semantics (Phase 4), payload/rate/connection hardening controls (Phase 5), and any changes to the underlying Gateway Core business logic.

</domain>

<decisions>
## Implementation Decisions

### Transport And Framing
- **D-01:** The WebSocket transport remains text-only for MCP JSON-RPC. One complete JSON-RPC message maps to one WebSocket text frame; binary frames continue to be ignored at the transport layer.
- **D-02:** The existing stdio transport keeps its current batch rejection behavior. Batch request support is WebSocket-only and must not regress stdio parity.
- **D-03:** WebSocket batch handling must be bounded by a configurable maximum batch size so a single frame cannot fan out into unbounded backend work.

### Batch Semantics
- **D-04:** A valid batch request is a JSON array delivered in one WebSocket text frame. The server processes items in array order and preserves response order for request items that expect responses.
- **D-05:** Batch entries that are notifications do not produce response items. If a batch contains only notifications, the server sends no response frame.
- **D-06:** Empty batches, oversized batches, or structurally invalid batch envelopes are rejected with JSON-RPC `-32600` invalid-request semantics using the same shared error-envelope helpers as the single-request path where practical.

### MCP Lifecycle
- **D-07:** The MCP harness remains the canonical owner of `initialize`, `notifications/initialized`, and `ping` result semantics; the WebSocket manager must not fork those behaviors.
- **D-08:** Phase 3 must verify the real WebSocket path against the existing harness rather than relying only on stubbed echo handlers.
- **D-09:** The `initialize` result should stay transport-neutral. Any user-facing instructions or metadata must not incorrectly describe the WebSocket endpoint as stdio-only.

### Claude's Discretion
- Choose the exact option/env shape for maximum batch size, provided it is explicit, easy to test, and scoped to the MCP WebSocket transport.
- Choose whether batch items execute strictly sequentially or with a small bounded internal strategy, provided response ordering and overload safety remain clear.
- Add small helper functions inside `mcpWebSocketServer.js` or nearby test fixtures when they materially improve readability.

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Project requirements and roadmap
- `.planning/ROADMAP.md` — Phase 3 goal, dependency on Phase 2, and success criteria for framing, batch handling, initialize, initialized, and ping.
- `.planning/REQUIREMENTS.md` — `TRANS-04` through `TRANS-08` define the full protocol-compliance scope for this phase.
- `.planning/STATE.md` — Confirms Phase 2 is signed off and Phase 3 is ready to plan.

### Existing implementation to preserve
- `modules/agentGateway/mcpWebSocketServer.js` — Current `/mcp` manager, single-request JSON parsing path, connection context injection, and explicit batch rejection that must be upgraded.
- `modules/agentGateway/mcpStdioServer.js` — Reference for single-request JSON-RPC parsing and shared `createJsonRpcErrorResponse()` envelopes. Stdio batch rejection stays unchanged.
- `modules/agentGateway/adapters/mcpBackendProxyAdapter.js` — Canonical MCP harness behavior for `initialize`, `notifications/initialized`, `ping`, prompt/tool/resource dispatch, and JSON-RPC response shaping.
- `modules/agentGateway/transport/webSocketTransport.js` — WebSocket dumb-pipe boundary; protocol logic should not leak into the transport implementation.

### Existing tests and fixtures
- `test/agent-gateway/adapters/agent-gateway-mcp-websocket.test.js` — Current endpoint test suite with auth, parse error, keepalive, cleanup, and session injection coverage.
- `test/agent-gateway/adapters/agent-gateway-mcp-transport.test.js` — Real stdio MCP harness coverage showing the expected initialize/ping/discovery semantics from the existing adapter.

### Research and design references
- `.planning/research/STACK.md` — Documents WebSocket framing and batch-support direction for the remote MCP transport.
- `.planning/research/FEATURES.md` — Notes that lifecycle methods already exist in the harness and should be reused.
- `.planning/research/PITFALLS.md` — Highlights protocol-version drift and unbounded batch fan-out as concrete risks for this phase.
- `mydoc/export/mcp/mcp-remote-websocket-transport-design.md` — Confirms WebSocket-only batch support as the intended design direction.

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- `createJsonRpcErrorResponse()` already gives the transport layer a shared JSON-RPC error envelope and should stay the source of truth for parse/invalid-request responses.
- `injectConnectionContext()` already provides the canonical per-request `sessionId`, `requestContext`, and `authContext` normalization for WebSocket dispatch.
- `buildMcpInitializeResult()` already builds the core MCP initialize payload with protocol version, capabilities, and server info.

### Established Patterns
- Per-connection request handling is serialized through a promise queue in `mcpWebSocketServer.js`.
- Project tests prefer real `ws` sockets plus lightweight in-process HTTP fixtures over large mocks.
- Agent Gateway protocol code centralizes request normalization and result shaping instead of duplicating semantics per transport.

### Integration Points
- Batch handling belongs in `mcpWebSocketServer.js`, because the transport only moves frames and the harness expects individual JSON-RPC messages.
- Lifecycle verification should exercise the real adapter stack through the WebSocket manager so remote MCP behavior matches the already-supported stdio path.

</code_context>

<specifics>
## Specific Ideas

- The current WebSocket manager already has most of the transport boundary complete; the biggest protocol gap is upgrading batch arrays from explicit rejection to bounded support.
- Because `initialize`, `notifications/initialized`, and `ping` are already implemented in the harness, the fastest safe Phase 3 path is to reuse that behavior and prove it end-to-end over WebSocket.
- The current initialize instructions mention MCP stdio specifically, which is misleading once remote WebSocket clients use the same harness. Phase 3 is the right place to neutralize that wording.

</specifics>

<deferred>
## Deferred Ideas

- Tool/prompt/resource discovery and invocation over the remote WebSocket path remain Phase 4 work, even if some real-harness tests incidentally touch the same adapter.
- Connection limits, payload ceilings, and message-rate controls remain Phase 5 hardening work.
- Server-initiated MCP push notifications such as `list_changed` remain out of scope for this phase.

</deferred>

---

*Phase: 03-mcp-protocol-compliance*
*Context gathered: 2026-04-26*
