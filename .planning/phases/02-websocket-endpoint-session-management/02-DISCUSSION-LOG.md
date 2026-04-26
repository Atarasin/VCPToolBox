# Phase 2: WebSocket Endpoint & Session Management - Discussion Log

> **Audit trail only.** Do not use as input to planning or implementation agents.
> Decisions are captured in `02-CONTEXT.md`.

**Date:** 2026-04-26
**Phase:** 02-websocket-endpoint-session-management
**Mode:** discuss
**Areas discussed:** Upgrade Authentication Contract, Endpoint Isolation Boundary, Session Isolation Model

## Gray Areas Presented

1. Upgrade-time authentication contract for `/mcp`
2. Session identity injection and request-context shape
3. Native keepalive and disconnect handling
4. Isolation boundary between `/mcp` and the legacy distributed WebSocket mesh

## User Decisions

### Upgrade Authentication Contract
- **Selected option:** `Header+Bearer`
- **Decision captured:** Reuse `resolveDedicatedGatewayAuth`, accepting both `x-agent-gateway-key` and `Authorization: Bearer ...` during the HTTP Upgrade handshake.
- **Why it matters:** Keeps the remote MCP endpoint aligned with existing gateway auth semantics while preserving compatibility with standard MCP clients that prefer bearer auth.

### Endpoint Isolation Boundary
- **Selected option:** `专用管理器`
- **Decision captured:** Implement `/mcp` as a dedicated manager under `modules/agentGateway/`, with its own client Map and lifecycle handling, while still wiring through the shared HTTP server.
- **Why it matters:** Satisfies the roadmap requirement that `/mcp` remain strictly separated from the existing node-to-node WebSocket mesh.

### Session Isolation Model
- **Selected option:** `服务端生成`
- **Decision captured:** Generate a canonical `sessionId` on the server for each authenticated connection and inject it into every downstream harness call; clients do not override canonical session identity.
- **Why it matters:** Preserves per-connection isolation and ensures gateway-managed MCP operations keep a stable session identity for job visibility and auditability.

## Left To Planning

- Keepalive interval, pong timeout, and close-code policy
- Exact file/module split for the dedicated MCP WebSocket manager
- Optional external correlation fields that do not replace canonical `sessionId`

## Out Of Scope Redirects

- JSON-RPC framing, batch handling, and MCP lifecycle methods belong to Phase 3
- Capability exposure and MCP error mapping belong to Phase 4
- Connection ceilings, rate limiting, and payload limits belong to Phase 5
