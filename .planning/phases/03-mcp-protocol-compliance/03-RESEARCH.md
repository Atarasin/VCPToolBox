# Phase 3 Research: MCP Protocol Compliance

**Date:** 2026-04-26
**Phase:** 03-mcp-protocol-compliance

## Summary

Phase 3 does not require a new MCP server architecture. The codebase already has the core lifecycle semantics in the backend-proxy harness; the remaining work is making the `/mcp` WebSocket path protocol-correct and proving it with real-harness tests.

## Findings

### 1. Lifecycle semantics already exist in the harness

From `modules/agentGateway/adapters/mcpBackendProxyAdapter.js`:
- `initialize` returns `protocolVersion`, `capabilities`, and `serverInfo` via `buildMcpInitializeResult()`
- `notifications/initialized` returns `null`, which matches notification semantics
- `ping` returns `{}`, which is sufficient for an MCP health check

Implication:
- Phase 3 should reuse the harness instead of re-implementing lifecycle logic inside `mcpWebSocketServer.js`

### 2. The current WebSocket manager is missing only the protocol-specific gaps

From `modules/agentGateway/mcpWebSocketServer.js`:
- Single JSON-RPC objects are already parsed and dispatched through the real transport path
- Parse errors already return shared `-32700` envelopes
- Non-object payloads already return shared `-32600` envelopes
- Batch arrays are still explicitly rejected with `-32600`

Implication:
- The WebSocket manager is already the right seam for Phase 3; it needs batch support and stronger lifecycle verification rather than a rewrite

### 3. Batch support should stay WebSocket-only

From `.planning/research/STACK.md` and `mydoc/export/mcp/mcp-remote-websocket-transport-design.md`:
- stdio remains a byte-stream transport and intentionally rejects JSON-RPC batches
- WebSocket is message-oriented and is the intended surface for bounded batch support

Implication:
- Phase 3 should not try to make stdio batch-capable
- WebSocket-only batch support is the intended architecture, not a temporary divergence

### 4. Unbounded batch fan-out is the main risk

From `.planning/research/PITFALLS.md`:
- Large batch arrays can amplify backend work quickly
- The recommended mitigation is a configurable maximum batch size and predictable processing behavior

Implication:
- Phase 3 should introduce an explicit maximum batch-size control
- The implementation should preserve response ordering and avoid hidden unlimited fan-out

### 5. Current initialize wording is transport-biased

From `buildMcpInitializeResult()`:
- `instructions` currently say: "Use the published Agent Gateway diary RAG prompts, tools, and resources over MCP stdio."

Implication:
- Remote WebSocket clients would receive a misleading initialize payload
- Phase 3 should make initialize instructions transport-neutral or otherwise correct for both stdio and WebSocket

## Recommended Planning Split

### Plan 03-01
- Upgrade `mcpWebSocketServer.js` from explicit batch rejection to bounded WebSocket batch support
- Cover valid, empty, oversized, mixed, and invalid-member batch cases in endpoint tests

### Plan 03-02
- Verify the real MCP lifecycle over WebSocket using the existing harness
- Make initialize metadata transport-correct
- Add end-to-end tests for `initialize`, repeated `notifications/initialized`, and `ping`

## Constraints To Preserve

- Do not move protocol ownership into `transport/webSocketTransport.js`
- Do not change stdio behavior for batch handling
- Do not fork lifecycle semantics away from `mcpBackendProxyAdapter.js`
- Keep comments and file structure aligned with the current Agent Gateway style
