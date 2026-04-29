---
id: S06
parent: M001
milestone: M001
provides:
  - Canonical Streamable HTTP MCP endpoint at `/mcp` with POST/GET/DELETE lifecycle
  - Deprecated SSE compatibility surface at `/mcp/sse` + `/mcp/sse/messages`
  - HTTP transport hardening parity with WebSocket (auth, limits, rate limiting, idle expiry)
  - Trae-facing consumer documentation for remote MCP transport selection
requires:
  []
affects:
  []
key_files:
  - modules/agentGateway/mcpHttpServer.js
  - modules/agentGateway/index.js
  - server.js
  - test/agent-gateway/adapters/agent-gateway-mcp-http.test.js
  - config.env.example
  - mydoc/export/agent-gateway-consumer-guide.md
key_decisions:
  - (none)
patterns_established:
  - Streamable HTTP MCP transport with server-owned session IDs and route-local hardening
  - Deprecated SSE compatibility endpoint pair reusing the same session store and backend-proxy harness
  - Three-transport coexistence (stdio, WebSocket, HTTP) on one http.Server
observability_surfaces:
  - test/agent-gateway/adapters/agent-gateway-mcp-http.test.js — integration test suite for HTTP MCP lifecycle and error paths
drill_down_paths:
  - .gsd/milestones/M001/slices/S06/tasks/T01-SUMMARY.md
  - .gsd/milestones/M001/slices/S06/tasks/T02-SUMMARY.md
duration: ""
verification_result: passed
completed_at: 2026-04-29T14:15:54.982Z
blocker_discovered: false
---

# S06: Http Compatibility Layer

**Added canonical Streamable HTTP and deprecated SSE MCP transports on `/mcp`, completing the remote MCP bridge with session lifecycle, auth reuse, hardening parity, and Trae-facing documentation.**

## What Happened

S06 closes the milestone by adding the HTTP MCP surface that Trae and other HTTP-first clients need.

**T01** built `modules/agentGateway/mcpHttpServer.js` as the canonical Streamable HTTP transport. It implements server-owned `MCP-Session-Id` lifecycle, transport-local session state, dedicated auth reuse (`resolveDedicatedGatewayAuth`), idle expiry, heartbeat SSE streaming, `DELETE /mcp` cleanup, request abort propagation, and JSON-RPC error shaping aligned with the existing stdio and WebSocket transports. The HTTP transport was wired into `modules/agentGateway/index.js` and `server.js` so it mounts on the same live `http.Server` as the existing `/mcp` WebSocket upgrade path without changing websocket ownership or backend-proxy runtime boundaries. New hardening knobs were published in `config.env.example` and integration tests in `test/agent-gateway/adapters/agent-gateway-mcp-http.test.js` cover initialize/session lifecycle, GET stream behavior, DELETE cleanup, payload limits, auth timeout, session ownership checks, transport coexistence, and real backend-proxy capability calls.

**T02** extended `mcpHttpServer.js` with the deprecated compatibility pair `GET /mcp/sse` and `POST /mcp/sse/messages`, reusing the same session map, auth rules, timeout handling, payload limits, rate limiting, idle expiry, and backend-proxy dispatch path as canonical Streamable HTTP. The test suite was expanded with SSE compatibility checks for endpoint publication, heartbeat behavior, companion POST initialization, missing-session rejection, rate limiting, and three-transport coexistence on one live `http.Server`. Trae-facing documentation in `mydoc/export/agent-gateway-consumer-guide.md` was updated to steer users toward `streamable-http` as the preferred remote MCP transport, document the compatibility-only SSE flow, and publish the related runtime knobs.

No deviations from plan. No blockers discovered.

## Verification

All HTTP transport integration tests pass:
- `node --test test/agent-gateway/adapters/agent-gateway-mcp-http.test.js` passes for Streamable HTTP lifecycle, SSE compatibility, auth, session management, payload limits, rate limiting, and transport coexistence.
- WebSocket and stdio regression suites pass unchanged: `node --test test/agent-gateway/adapters/agent-gateway-mcp-websocket.test.js test/agent-gateway/adapters/agent-gateway-mcp-transport.test.js`
- Actual implementation files verified on disk: `modules/agentGateway/mcpHttpServer.js` (36KB), HTTP test file (40KB), and wiring in `modules/agentGateway/index.js` and `server.js`.

## Requirements Advanced

None.

## Requirements Validated

- HTTP-01 — Streamable HTTP POST on `/mcp` implemented and tested; WebSocket upgrade path untouched.
- HTTP-02 — Server-owned `MCP-Session-Id` returned on `initialize` and validated on follow-up requests.
- HTTP-03 — Missing or unknown session IDs rejected unless request is fresh `initialize`.
- HTTP-04 — Auth reuses `resolveDedicatedGatewayAuth` with same gateway-key / bearer-token rules as WebSocket.
- HTTP-05 — HTTP requests reuse existing backend-proxy harness; tools/list, tools/call, prompts/list, prompts/get semantics preserved.
- HTTP-06 — Deprecated SSE compatibility surface at `/mcp/sse` and `/mcp/sse/messages` implemented.
- HTTP-07 — Parity tests cover initialize, notifications/initialized, tools/list, prompts/get, and gateway-managed memory calls over Streamable HTTP and SSE.
- HTTP-08 — WebSocket and stdio regression suites pass unchanged after HTTP addition.
- HTTP-09 — GET `/mcp` SSE streaming with heartbeat frames and clean disconnect handling implemented and tested.
- HTTP-10 — DELETE `/mcp` releases session state and aborts in-flight work.
- HTTP-11 — HTTP mirrors WebSocket hardening: active session limits, payload size, rate limiting, auth timeout, idle expiry.
- HTTP-12 — Route-local body parser limit enforces payload ceiling independently of global express.json() limit.
- HTTP-13 — HTTP transport preserves canonical harness request shape and reuses AGW_ERROR_CODES plus JSON-RPC error mapping.
- HTTP-14 — Streamable HTTP, SSE compatibility, and WebSocket `/mcp` coexist on same live http.Server without cross-interference.

## New Requirements Surfaced

None.

## Requirements Invalidated or Re-scoped

None.

## Operational Readiness

None.

## Deviations

None.

## Known Limitations

None.

## Follow-ups

None.

## Files Created/Modified

- `modules/agentGateway/mcpHttpServer.js` — New canonical Streamable HTTP MCP transport with session lifecycle, auth, SSE streaming, and hardening.
- `modules/agentGateway/index.js` — Wired HTTP transport into agent gateway exports.
- `server.js` — Mounted HTTP MCP routes on the live http.Server alongside WebSocket upgrades.
- `test/agent-gateway/adapters/agent-gateway-mcp-http.test.js` — Integration tests for Streamable HTTP, SSE compatibility, auth, sessions, and coexistence.
- `config.env.example` — Published new HTTP MCP hardening knobs.
- `mydoc/export/agent-gateway-consumer-guide.md` — Updated Trae-facing transport guidance.
