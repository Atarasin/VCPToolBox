# Architecture

**Date:** 2026-04-24

## Architectural Pattern

VCP follows a **modular monolith** pattern with a **plugin-centric runtime**. The core is a flat Node.js application where functionality is organized by responsibility rather than layered directories.

Key characteristics:
- No `src/` directory — root-level files are core runtime components
- Plugin system as the primary extension mechanism (100+ plugins)
- Event-driven plugin lifecycle via `EventEmitter`
- Distributed capabilities via custom WebSocket protocol

## Core Components

### 1. HTTP/SSE Gateway (`server.js`)
- Express server with configurable port (`PORT=6005`)
- Loads environment from `config.env` via `dotenv`
- Mounts routes from `routes/`
- Initializes plugin manager, WebSocket server, knowledge base
- Global HTTP/HTTPS agent tuning (`maxSockets = 10000`)

### 2. Plugin Runtime (`Plugin.js`)
- `PluginManager` class extends `EventEmitter`
- Discovers plugins from `Plugin/` directory
- Parses `plugin-manifest.json` per plugin
- Supports sync, async, and static execution modes
- Message preprocessor pipeline with configurable order
- Hot-reload via `chokidar` file watching
- Scheduled job support via `node-schedule`
- Tool approval gate (`toolApprovalManager`)

### 3. WebSocket Distributed Layer (`WebSocketServer.js`, `FileFetcherServer.js`)
- Custom WebSocket protocol for node-to-node communication
- Node registration, heartbeat, remote tool execution
- Cross-node file fetching
- Agent directory sync across distributed instances

### 4. RAG / Memory System (`KnowledgeBaseManager.js`)
- TagMemo engine — semantic tagging and wave-based memory retrieval
- Vector store management (`VectorStore/`)
- HNSW index for approximate nearest neighbor search
- Daily note integration (`dailynote/`)
- Embedding utilities (`EmbeddingUtils.js`)

### 5. Agent Gateway (`modules/agentGateway/`)
- Modular service architecture (services, adapters, contracts, policy, infra)
- MCP (Model Context Protocol) server transport
- Agent registry, job runtime, event runtime
- Tool runtime with capability discovery
- Auth policy enforcement
- Memory runtime for agent state persistence
- OpenAPI spec generation and contract publishing

### 6. Message Processing Pipeline (`modules/messageProcessor.js`)
- Variable/placeholder substitution
- Role divider logic
- Context management
- Toolbox manager integration

## Data Flow

```
User Request
    ↓
server.js (Express routing)
    ↓
Routes (routes/*.js) — REST API endpoints
    ↓
PluginManager (Plugin.js) — dispatch to plugin
    ↓
Plugin execution — may call:
    - External APIs (AI upstream)
    - KnowledgeBaseManager (RAG lookup)
    - VectorStore (semantic search)
    - File system (media, documents)
    - Other plugins (cross-plugin calls)
    ↓
Response aggregation → SSE stream or JSON response
```

## Key Abstractions

- **Plugin Manifest** — Declares plugin capabilities, hooks, permissions
- **Message Preprocessor** — Transforms messages before plugin execution
- **Static Placeholder** — Template variable injection system
- **Tool Approval** — Security gate for sensitive operations
- **Agent Map** — Dynamic agent capability registry
- **OpenSpec Changes** — Structured spec-driven development workflow (`openspec/`)

## Entry Points

| Entry Point | File | Purpose |
|-------------|------|---------|
| Main server | `server.js` | HTTP/SSE API, plugin init, WebSocket |
| Admin server | `adminServer.js` | Admin panel backend |
| Plugin runtime | `Plugin.js` | Plugin loading and execution |
| WS server | `WebSocketServer.js` | Distributed node protocol |
| File fetcher | `FileFetcherServer.js` | Cross-node file proxy |
| Agent gateway | `modules/agentGateway/index.js` | Modular agent services |

## Rust N-API Component

`rust-vexus-lite/` provides high-performance vector operations via Node-API bindings to Rust. Integrated into the knowledge base pipeline for embedding similarity computation.

## Admin Panel

`AdminPanel/` — Static file frontend served by `adminServer.js`. Provides web UI for plugin management, agent configuration, log viewing, and system monitoring.
