# S05: Production Hardening

**Goal:** Finish the transport guardrails that make `/mcp` operationally safe before any backend request work begins.
**Demo:** Finish the transport guardrails that make `/mcp` operationally safe before any backend request work begins.

## Must-Haves


## Tasks

- [x] **T01: 05-production-hardening 01**
  - Finish the transport guardrails that make `/mcp` operationally safe before any backend request work begins.

Purpose: Close the non-rate-limit hardening gaps in Phase 5 by proving that connection admission, payload ceilings, cleanup behavior, and upgrade auth timeout protection all behave deterministically on the real websocket endpoint.
Output: Production-wired websocket hardening controls plus endpoint tests that show overload and stalled-upgrade paths fail fast without leaking connection state.
- [x] **T02: 05-production-hardening 02**
  - Add the missing per-connection overload protection so one remote websocket client cannot flood the shared MCP harness with unbounded message bursts.

Purpose: Close `OP-04` with a deterministic transport-local rate limiter that protects the backend before request dispatch while still giving remote clients stable retry guidance.
Output: Per-connection rate limiting in `/mcp` plus websocket tests that prove burst rejection, retry metadata, and healthy-peer isolation.

## Files Likely Touched

- `modules/agentGateway/mcpWebSocketServer.js`
- `server.js`
- `test/agent-gateway/adapters/agent-gateway-mcp-websocket.test.js`
- `modules/agentGateway/mcpWebSocketServer.js`
- `test/agent-gateway/adapters/agent-gateway-mcp-websocket.test.js`
