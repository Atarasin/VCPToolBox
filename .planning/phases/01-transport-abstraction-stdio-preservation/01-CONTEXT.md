# Phase 1: Transport Abstraction & Stdio Preservation - Context

**Gathered:** 2026-04-25
**Status:** Ready for planning

<domain>
## Phase Boundary

Refactor the existing stdio MCP server to use a transport interface (`McpTransport`), enabling WebSocket transport in Phase 2 without touching harness logic. Zero regression for existing stdio consumers.

In scope: `McpTransport` interface definition, stdio transport implementation extracted from `mcpStdioServer.js`, backwards-compatible wrapper, transport unit tests.
Out of scope: WebSocket transport (Phase 2), JSON-RPC protocol handling (Phase 3), capability exposure (Phase 4), production hardening (Phase 5).

</domain>

<decisions>
## Implementation Decisions

### Transport Interface Contract
- **D-01:** Incoming messages delivered via callback registration (`transport.setMessageHandler(handler)`), not EventEmitter.
- **D-02:** Transport's `send` method accepts pre-serialized JSON strings (not parsed objects). Harness handles `JSON.stringify` before calling `send`.
- **D-03:** Transport is ready after construction — no explicit `open`/`connect` method in the interface. Lifecycle is constructor + `close()`.
- **D-04:** Transport-level errors reported via callback registration (`transport.setErrorHandler(handler)`). Symmetric with message delivery.

### Backwards Compatibility Strategy
- **D-05:** Introduce a new factory function for creating stdio MCP servers with the transport abstraction. Keep `startStdioMcpServer` as a thin backwards-compatible wrapper.
- **D-06:** New `McpTransport` interface and stdio transport implementation live in a new `modules/agentGateway/transport/` subdirectory.
- **D-07:** Extract stdio transport logic from existing `mcpStdioServer.js` rather than rewriting from scratch. Existing readline, queue, and close semantics are preserved.
- **D-08:** Add focused unit tests for the `McpTransport` contract (send, close, error handlers). Keep all 7 existing stdio integration tests unmodified.

### Claude's Discretion
- Exact method names on the interface (e.g., `sendMessage` vs `send` vs `write`).
- Whether the transport interface includes a `destroy` method in addition to `close`.
- How `finished` promise is surfaced in the new factory vs wrapper.
- Internal directory structure within `transport/` (single file vs `index.js` + `stdioTransport.js`).

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Existing stdio implementation
- `modules/agentGateway/mcpStdioServer.js` — Existing stdio MCP server. Contains readline input handling, JSON-RPC write logic, queue-based request processing, and close lifecycle. This is the code to extract.
- `scripts/start-agent-gateway-mcp-server.js` — Entry point that imports `startStdioMcpServer` and wires runtime hooks. Must continue working.

### Harness and adapters
- `modules/agentGateway/adapters/mcpBackendProxyAdapter.js` — `createBackendProxyMcpServerHarness` and `createBackendProxyMcpAdapter`. The harness handles JSON-RPC requests and returns responses. The transport abstraction sits below the harness.
- `modules/agentGateway/adapters/mcpAdapter.js` — Related adapter code that may share patterns.

### Test coverage
- `test/agent-gateway/adapters/agent-gateway-mcp-transport.test.js` — 7 integration tests for stdio MCP transport. Must all pass unmodified after refactoring.

### Requirements
- `.planning/REQUIREMENTS.md` — v1 requirements. Phase 1 covers OP-03 only.
- `.planning/ROADMAP.md` — Phase details and success criteria.

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- `mcpStdioServer.js` (`startStdioMcpServer`): Contains the complete stdio transport logic — readline setup, message queue, JSON-RPC write helpers, close/finished lifecycle. This logic will be extracted into the new stdio transport class.
- `createJsonRpcErrorResponse`: Already exported from `mcpStdioServer.js`. May be reused or moved to a shared location.
- `writeJsonMessage` and `writeStderr`: Internal helpers that write newline-delimited JSON to stdout/stderr.

### Established Patterns
- CommonJS modules with `require()` / `module.exports`.
- Function-based rather than class-based for top-level entry points (`startStdioMcpServer` is async function returning `{ close(), finished }`).
- Error handling: sync errors thrown, async errors caught and written to stderr.
- Environment variables accessed via `process.env.*` with fallbacks.
- Prefix logging: `[MCPTransport] ...` to stderr.

### Integration Points
- `startStdioMcpServer` accepts `options` with `stdin`, `stdout`, `stderr`, `initializeRuntime`, `shutdownRuntime`, and `harness` overrides. The new factory should preserve this option shape.
- The harness (`handleRequest`) expects parsed JSON-RPC objects and returns response objects. Transport sits between harness and I/O.
- Entry script `scripts/start-agent-gateway-mcp-server.js` wires process signals (SIGINT, SIGTERM) to `server.close()`. This must continue working.

</code_context>

<specifics>
## Specific Ideas

- The user wants the transport abstraction to be a "dumb pipe" — pre-serialized strings in, callback handlers out. This keeps the harness in control of JSON-RPC semantics.
- Callback registration over EventEmitter for a cleaner, dependency-free contract.
- Extract-from-existing approach means the existing readline queue semantics (sequential request processing via `queue = queue.then(...)`) should be preserved exactly.
- New `transport/` subdirectory signals this is a cross-cutting abstraction, not just another adapter.

</specifics>

<deferred>
## Deferred Ideas

- WebSocket transport implementation — Phase 2
- Batch request support in transport layer — Phase 3 (JSON-RPC protocol compliance)
- Connection limits and rate limiting — Phase 5

</deferred>

---

*Phase: 01-transport-abstraction-stdio-preservation*
*Context gathered: 2026-04-25*
