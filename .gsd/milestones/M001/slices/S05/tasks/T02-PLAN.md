# T02: 05-production-hardening 02

**Slice:** S05 — **Milestone:** M001

## Description

Add the missing per-connection overload protection so one remote websocket client cannot flood the shared MCP harness with unbounded message bursts.

Purpose: Close `OP-04` with a deterministic transport-local rate limiter that protects the backend before request dispatch while still giving remote clients stable retry guidance.
Output: Per-connection rate limiting in `/mcp` plus websocket tests that prove burst rejection, retry metadata, and healthy-peer isolation.

## Must-Haves

- [ ] "Each authenticated `/mcp` connection enforces a bounded inbound message rate before backend work is dispatched"
- [ ] "Rate-limited traffic yields stable, actionable remote behavior instead of silently overloading the shared harness"
- [ ] "The limiter does not break healthy websocket peers, heartbeat traffic, or normal batch semantics"

## Files

- `modules/agentGateway/mcpWebSocketServer.js`
- `test/agent-gateway/adapters/agent-gateway-mcp-websocket.test.js`
