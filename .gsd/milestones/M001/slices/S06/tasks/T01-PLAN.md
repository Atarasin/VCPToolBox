# T01: 06-http-compatibility-layer 01

**Slice:** S06 — **Milestone:** M001

## Description

Add the primary HTTP MCP surface needed for Trae-native remote compatibility by implementing a standards-aligned Streamable HTTP endpoint on `/mcp`.

Purpose: expose the already-validated MCP prompt and memory surface through normal HTTP requests while preserving websocket coexistence and transport-local session ownership.
Output: a canonical `/mcp` Streamable HTTP transport with session handling, dedicated auth reuse, and parity tests for lifecycle plus representative capability calls.

## Must-Haves

- [ ] "The Express stack serves a canonical Streamable HTTP MCP endpoint on `/mcp` without breaking the existing `/mcp` WebSocket upgrade flow"
- [ ] "HTTP `initialize` returns a server-owned `MCP-Session-Id` and later HTTP MCP requests reject missing or unknown sessions unless they are a fresh initialize"
- [ ] "Dedicated gateway-key or bearer-token auth is enforced consistently for HTTP MCP requests"
- [ ] "The new HTTP transport reuses the existing backend-proxy MCP harness so prompt and tool semantics match stdio and WebSocket"
- [ ] "Canonical Streamable HTTP supports both `POST /mcp` and required `GET /mcp`; GET validates `MCP-Session-Id`, emits heartbeat frames, and closes cleanly on client disconnect"
- [ ] "HTTP MCP supports `DELETE /mcp` with a valid `MCP-Session-Id` to release server-side state and abort in-flight harness calls"
- [ ] "HTTP MCP mirrors WebSocket hardening with parity defaults for max active sessions, max payload, per-session rate limit, and auth timeout, plus an explicit idle-session expiry"
- [ ] "HTTP MCP enforces a route-local body parser limit at the `/mcp` boundary instead of inheriting the global `express.json({ limit: '300mb' })` setting from `server.js`"
- [ ] "HTTP transport injects canonical request/session/auth context at the transport boundary without changing the harness request shape seen by stdio and WebSocket"
- [ ] "HTTP transport reuses the existing `AGW_ERROR_CODES` and JSON-RPC error mapping rules instead of inventing HTTP-only business envelopes"
- [ ] "Slow GET `/mcp` consumers use gentle backpressure: JSON-RPC response frames await `drain`, while stale heartbeat frames may be dropped instead of blocking forward progress"
- [ ] "HTTP routes coexist with the existing `/mcp` WebSocket upgrade handler on the same `http.Server` without changing websocket ownership"

## Files

- `modules/agentGateway/mcpHttpServer.js`
- `modules/agentGateway/index.js`
- `server.js`
- `config.env.example`
- `test/agent-gateway/adapters/agent-gateway-mcp-http.test.js`
