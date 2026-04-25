# VCP Remote MCP Bridge

## What This Is

VCP is a modular Node.js plugin platform with a distributed runtime, RAG/memory system, and agent gateway. This project extends the existing local-only stdio MCP service so that external MCP clients (Claude Desktop, Cursor, and other standard MCP consumers) can connect remotely over WebSocket, authenticate via VCP's existing user system, and use the RAG/memory tools already exposed locally.

## Core Value

External MCP clients can securely read from and write to VCP's knowledge base over a stable WebSocket connection without requiring local process access.

## Requirements

### Validated

- ✓ VCP runs as a modular monolith with 100+ plugins — existing
- ✓ HTTP/SSE gateway serves REST API and SSE streams — existing
- ✓ Plugin runtime (PluginManager) dispatches execution with event-driven lifecycle — existing
- ✓ WebSocket distributed layer handles node-to-node communication — existing
- ✓ RAG/memory system (TagMemo, HNSW vector store, daily notes) persists and retrieves knowledge — existing
- ✓ Agent Gateway exposes local stdio MCP server with tool/runtime and auth policy enforcement — existing
- ✓ Existing user/auth system (Plugin/UserAuth, API keys, basic auth) secures endpoints — existing

### Active

- [ ] External MCP clients can connect to VCP over a fixed WebSocket URL endpoint
- [ ] Connection is authenticated using VCP's existing user/auth system
- [ ] Remote clients can invoke RAG/memory MCP tools (query, add, update) that already work locally
- [ ] Multiple concurrent remote connections are supported safely
- [x] Local stdio MCP service continues to work unchanged — validated in Phase 01

### Out of Scope

- MCP client functionality (VCP calling *out* to remote MCP servers) — this project is about exposing VCP *as* an MCP server to remote clients
- Replacing the existing node-to-node WebSocket mesh protocol — that stays as-is
- Changes to the RAG/memory data model or indexing strategy — only the transport layer changes
- UI changes in AdminPanel for MCP connection management — can be added later

## Context

VCP's agent gateway (`modules/agentGateway/`) already runs an MCP server transport over stdio for local consumers. The knowledge base exposes tools for semantic search, memory insertion, tag management, and daily note integration. The WebSocket distributed layer (`WebSocketServer.js`) handles node registration, heartbeats, and remote tool execution across VCP instances, but it uses a custom protocol not compatible with standard MCP clients.

The gap is purely transport: stdio works for local subprocesses, but there is no way for an external MCP client running on a different machine to reach VCP's MCP surface. Adding a WebSocket transport bridge fills this gap while reusing the existing MCP tool/runtime and auth infrastructure.

## Constraints

- **Tech stack**: Node.js, `ws` library, Express — must fit into existing runtime without new major dependencies
- **Compatibility**: Cannot break existing local stdio MCP consumers
- **Security**: Must reuse VCP's existing auth system; no separate credential store
- **Protocol**: Must conform to MCP protocol semantics over WebSocket (JSON-RPC framing)

## Key Decisions

| Decision | Rationale | Outcome |
|----------|-----------|---------|
| WebSocket as remote transport | User requirement; widely supported by MCP SDKs and client ecosystems | — Pending |
| Reuse vs. separate WebSocket endpoint | Existing node-to-node mesh uses custom protocol; external MCP clients need standard MCP framing | — Pending |
| Auth via existing VCP user system | Avoids introducing a second identity/authorization layer; consistent with existing API security | — Pending |

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
*Last updated: 2026-04-25 after Phase 01 completion*
