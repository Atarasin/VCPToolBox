---
phase: 01-transport-abstraction-stdio-preservation
plan: 01
subsystem: agent-gateway
tags: [transport, refactor, stdio, mcp]
requirements: [OP-03]
dependency_graph:
  requires:
    - "modules/agentGateway/mcpStdioServer.js (pre-existing stdio implementation)"
    - "modules/agentGateway/adapters/mcpBackendProxyAdapter.js (harness factory)"
    - "modules/agentGateway/GatewayBackendClient.js (backend client)"
    - "scripts/start-agent-gateway-mcp-server.js (entry script wiring)"
  provides:
    - "modules/agentGateway/transport/mcpTransport.js → McpTransport contract + validateMcpTransport"
    - "modules/agentGateway/transport/stdioTransport.js → StdioTransport class"
    - "modules/agentGateway/transport/index.js → unified transport module exports"
    - "modules/agentGateway/mcpStdioServer.js → createStdioMcpServer factory + startStdioMcpServer wrapper"
    - "test/agent-gateway/transport/stdio-transport.test.js → 7 unit tests for transport contract"
  affects:
    - "scripts/start-agent-gateway-mcp-server.js (no changes required; still imports startStdioMcpServer)"
    - "test/agent-gateway/adapters/agent-gateway-mcp-transport.test.js (unmodified; all 7 integration tests pass)"
tech_stack:
  added: []
  patterns:
    - "Transport abstraction (interface + concrete implementation) with callback-based message/error delivery (D-01, D-04)"
    - "Pre-serialized JSON string send contract (D-02): transport is a dumb byte/line pipe"
    - "Constructor-only initialization with explicit close() lifecycle (D-03)"
    - "Backwards-compatible thin-wrapper pattern (D-05): legacy entry point delegates to new factory"
key_files:
  created:
    - "modules/agentGateway/transport/mcpTransport.js"
    - "modules/agentGateway/transport/stdioTransport.js"
    - "modules/agentGateway/transport/index.js"
    - "test/agent-gateway/transport/stdio-transport.test.js"
  modified:
    - "modules/agentGateway/mcpStdioServer.js"
key_decisions:
  - "Inject options.transport in createStdioMcpServer to allow Phase 2 WebSocket transport to reuse the factory without forking the harness wiring"
  - "Preserved handleLine logic verbatim — only writeJsonMessage(stdout, payload) call sites changed to transport.send(JSON.stringify(payload)) per D-02"
  - "validateMcpTransport throws TypeError with method name in message to give failing consumers a precise diagnostic"
metrics:
  duration_minutes: 6
  tasks_completed: 3
  tests_added: 7
  tests_passing: 14  # 7 integration + 7 unit
  files_created: 4
  files_modified: 1
  completed_date: "2026-04-25"
---

# Phase 01 Plan 01: Transport Abstraction & Stdio Preservation Summary

JSON-RPC stdio I/O extracted from `mcpStdioServer.js` into a reusable `StdioTransport` implementing the new `McpTransport` contract; `createStdioMcpServer` now owns the harness/queue wiring while `startStdioMcpServer` survives as a one-line wrapper, preserving every observable behavior of the existing MCP server.

## Outcome

The agent-gateway MCP stdio surface now layers cleanly into:

1. **Transport (`modules/agentGateway/transport/`)** — pluggable byte/line pipe with the four-method contract (`send`, `close`, `setMessageHandler`, `setErrorHandler`).
2. **Server factory (`createStdioMcpServer`)** — JSON-RPC parsing, request queueing, harness dispatch, shutdown lifecycle.
3. **Legacy wrapper (`startStdioMcpServer`)** — single-line forward to `createStdioMcpServer`, keeping `scripts/start-agent-gateway-mcp-server.js` and the 7 production integration tests untouched.

This unblocks Phase 2 (WebSocket transport): a new `WebSocketTransport` implementing the same contract can be passed to `createStdioMcpServer` (renamed or aliased later) via `options.transport` with zero changes to JSON-RPC handling.

## Tasks Completed

| # | Task | Commit | Files |
|---|------|--------|-------|
| 1 | Create McpTransport interface and StdioTransport implementation | `4735a9d` | `modules/agentGateway/transport/{mcpTransport,stdioTransport,index}.js` |
| 2 | Refactor mcpStdioServer.js — extract factory and preserve wrapper | `f57b10e` | `modules/agentGateway/mcpStdioServer.js` |
| 3 | Add unit tests for McpTransport contract | `f52da99` | `test/agent-gateway/transport/stdio-transport.test.js` |

## Verification

| Suite | Command | Result |
|-------|---------|--------|
| Existing integration tests (must pass unmodified) | `npm run test:agent-gateway-mcp-transport` | 7/7 pass |
| New transport unit tests | `node --test test/agent-gateway/transport/stdio-transport.test.js` | 7/7 pass |
| Transport contract self-check | `node -e "validateMcpTransport(new StdioTransport())"` | OK |

## Threat Model Mitigations

| Threat ID | Mitigation | Where |
|-----------|-----------|-------|
| T-01-01 (DoS via send-after-close) | `_closed` flag short-circuits `send()` | `stdioTransport.js` `send()` + Task 3 unit test "close prevents subsequent send calls" |
| T-01-03 (Tampering via handler throws) | try/catch around message handler routes to `_errorHandler` | `stdioTransport.js` line-handler + Task 3 unit test "setErrorHandler receives errors thrown by the message handler" |
| T-01-02 (stderr information disclosure) | accepted; existing behavior preserved | `mcpStdioServer.js` `writeStderr` calls unchanged |

## Decisions Made

- **Optional `options.transport` injection** — `createStdioMcpServer` accepts a pre-built transport, enabling Phase 2 WebSocket reuse without rewiring harness/queue/shutdown. Falls back to a fresh `StdioTransport(options)` when omitted, preserving the original public API.
- **Verbatim `handleLine` preservation** — The only changes to the protocol logic are call-site rewrites of `writeJsonMessage(stdout, payload)` → `transport.send(JSON.stringify(payload))` (D-02). All error codes (`-32700`, `-32600`, `-32603`) and messages remain byte-identical, which is why the unmodified integration suite passes.
- **`finished` promise wired through `transport.finished`** — The factory awaits the transport's lazy `finished` promise instead of subscribing directly to readline. This keeps queue-drain and `shutdownRuntime` timing observable to consumers exactly as before.
- **`writeJsonMessage` removed** — No longer needed inside `mcpStdioServer.js` once all writes go through `transport.send`. Dropping it prevents future drift between two competing write paths.

## Deviations from Plan

None — plan executed exactly as written. The optional `options.transport` injection point was added in Task 2; this is a strict superset of the documented behavior (still defaults to `new StdioTransport(options)` when absent) and required no plan change.

## Self-Check: PASSED

- modules/agentGateway/transport/mcpTransport.js → FOUND
- modules/agentGateway/transport/stdioTransport.js → FOUND
- modules/agentGateway/transport/index.js → FOUND
- modules/agentGateway/mcpStdioServer.js → FOUND (modified)
- test/agent-gateway/transport/stdio-transport.test.js → FOUND
- Commit 4735a9d → FOUND
- Commit f57b10e → FOUND
- Commit f52da99 → FOUND
- Integration suite (7 tests): pass
- Unit suite (7 tests): pass
