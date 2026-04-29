# VCP Remote MCP Bridge

## What This Is

VCP is a modular Node.js plugin platform with a distributed runtime, RAG/memory system, and agent gateway. This project extends the existing local-only stdio MCP service so that external MCP clients (Claude Desktop, Cursor, and other standard MCP consumers) can connect remotely over WebSocket, authenticate via VCP's existing user system, and use the RAG/memory tools already exposed locally.

## Core Value

WebSocket-capable external MCP clients can securely read from and write to VCP's knowledge base over a stable WebSocket connection without requiring local process access.

## Requirements

### Validated

- ✓ VCP runs as a modular monolith with 100+ plugins — existing
- ✓ HTTP/SSE gateway serves REST API and SSE streams — existing
- ✓ Plugin runtime (PluginManager) dispatches execution with event-driven lifecycle — existing
- ✓ WebSocket distributed layer handles node-to-node communication — existing
- ✓ RAG/memory system (TagMemo, HNSW vector store, daily notes) persists and retrieves knowledge — existing
- ✓ Agent Gateway exposes local stdio MCP server with tool/runtime and auth policy enforcement — existing
- ✓ Existing user/auth system (Plugin/UserAuth, API keys, basic auth) secures endpoints — existing
- ✓ External MCP clients can connect to VCP over a fixed WebSocket URL endpoint — validated in Phase 02
- ✓ Connection is authenticated using VCP's existing user/auth system — validated in Phase 02
- ✓ Remote clients can invoke RAG/memory MCP tools (query, add, update) that already work locally — validated in Phase 04
- ✓ Multiple concurrent remote connections are supported safely — validated in Phase 05
- ✓ Production `/mcp` guardrails enforce connection limits, payload ceilings, upgrade-auth timeouts, and per-connection rate limiting — validated in Phase 05
- ✓ Remote websocket field validation on a second device passed for `initialize`, `tools/list`, and `prompts/get(gateway_agent_render)` after backend-proxy MCP env configuration was added — validated in Phase 05 UAT

### Active

- [x] Local stdio MCP service continues to work unchanged — validated in Phase 01
- None — milestone scope is fully validated through Phase 05

### Out of Scope

- MCP client functionality (VCP calling *out* to remote MCP servers) — this project is about exposing VCP *as* an MCP server to remote clients
- Replacing the existing node-to-node WebSocket mesh protocol — that stays as-is
- Changes to the RAG/memory data model or indexing strategy — only the transport layer changes
- UI changes in AdminPanel for MCP connection management — can be added later
- Native Trae websocket MCP client compatibility — Trae currently supports `stdio`, `SSE`, and `Streamable HTTP`, so Trae must use stdio until a future HTTP MCP transport exists

## Context

VCP's agent gateway (`modules/agentGateway/`) already runs an MCP server transport over stdio for local consumers. The knowledge base exposes tools for semantic search, memory insertion, tag management, and daily note integration. The WebSocket distributed layer (`WebSocketServer.js`) handles node registration, heartbeats, and remote tool execution across VCP instances, but it uses a custom protocol not compatible with standard MCP clients.

The gap was purely transport: stdio worked for local subprocesses, but there was no way for an external MCP client running on a different machine to reach VCP's MCP surface. This milestone closes that gap with a dedicated WebSocket transport bridge that reuses the existing MCP tool/runtime and auth infrastructure while adding production-safe admission, payload, timeout, and rate-limit guardrails.

## Constraints

- **Tech stack**: Node.js, `ws` library, Express — must fit into existing runtime without new major dependencies
- **Compatibility**: Cannot break existing local stdio MCP consumers
- **Security**: Must reuse VCP's existing auth system; no separate credential store
- **Protocol**: Must conform to MCP protocol semantics over WebSocket (JSON-RPC framing)

## Key Decisions

| Decision | Rationale | Outcome |
|----------|-----------|---------|
| WebSocket as remote transport | User requirement; widely supported by MCP SDKs and client ecosystems | Adopted via dedicated `/mcp` transport |
| Reuse vs. separate WebSocket endpoint | Existing node-to-node mesh uses custom protocol; external MCP clients need standard MCP framing | Dedicated `/mcp` endpoint preserved separately from the legacy mesh |
| Auth via existing VCP user system | Avoids introducing a second identity/authorization layer; consistent with existing API security | Upgrade-time auth reuses existing VCP credentials and policy checks |
| Backend-proxy MCP env is explicit runtime config | The websocket MCP runtime lazily boots through the backend-proxy harness and fails at first request if its backend URL is absent | `VCP_MCP_BACKEND_URL`, `VCP_MCP_BACKEND_KEY`, `VCP_MCP_BACKEND_GATEWAY_ID`, and `VCP_MCP_DEFAULT_AGENT_ID` are now documented as required runtime config |
| Keep Trae on stdio for now | Trae does not currently support websocket MCP transport natively | Archive the websocket endpoint as valid infrastructure and defer Trae-native remote access to a future HTTP MCP transport |

## Evolution

This document evolves at phase transitions and milestone boundaries.

**After each phase transition** (via `/gsd-transition`):
1. Requirements invalidated? → Move to Out of Scope with reason
2. Requirements validated? → Move to Validated with phase reference
3. New requirements emerged? → Add to Active
4. Decisions to log? → Add to Key Decisions
5. "What This Is" still accurate? → Update if drifted

**After each milestone** (via `/gsd-complete-milestone`):
1. Full review of all sections
2. Core Value check — still the right priority?
3. Audit Out of Scope — reasons still valid?
4. Update Context with current state

---
*Last updated: 2026-04-26 after Phase 05 completion and live websocket archive verification*
