# T01: 05-production-hardening 01

**Slice:** S05 — **Milestone:** M001

## Description

Finish the transport guardrails that make `/mcp` operationally safe before any backend request work begins.

Purpose: Close the non-rate-limit hardening gaps in Phase 5 by proving that connection admission, payload ceilings, cleanup behavior, and upgrade auth timeout protection all behave deterministically on the real websocket endpoint.
Output: Production-wired websocket hardening controls plus endpoint tests that show overload and stalled-upgrade paths fail fast without leaking connection state.

## Must-Haves

- [ ] "The real `/mcp` server bootstrap enforces a configurable maximum concurrent connection limit using `VCP_MCP_WS_MAX_CONNECTIONS` instead of relying on constructor-only defaults"
- [ ] "Oversized websocket frames are rejected quickly and cleanly without leaving connection-count drift or hanging shutdown behind"
- [ ] "Stalled `/mcp` upgrade authentication is bounded by an explicit timeout guard so the socket cannot hang indefinitely"

## Files

- `modules/agentGateway/mcpWebSocketServer.js`
- `server.js`
- `test/agent-gateway/adapters/agent-gateway-mcp-websocket.test.js`
