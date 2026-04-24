# Concerns

**Date:** 2026-04-24

## Technical Debt

### Flat Directory Structure
- Root directory has 80+ files — difficult to navigate
- No `src/` separation — core runtime mixed with utility scripts
- Scaling risk: hard to onboard new developers

### Mixed Languages in Codebase
- Comments and documentation heavily in Chinese
- Variable names mixed Chinese/English
- Increases barrier for non-Chinese contributors

### Plugin System Complexity
- 100+ plugins with varying maintenance levels
- No clear deprecation strategy for old plugins
- Plugin manifest schema may vary across generations
- Hot-reload complexity with file watchers and scheduled jobs

### Configuration Sprawl
- Multiple config files: `config.env`, `.env`, `toolApprovalConfig.json`, `agent_map.json`, `rag_params.json`
- `config.env` is flat key=value with minimal structure
- Sensitive values (API keys) stored in plaintext config

## Security Concerns

### High-Privilege Operations
- **WARNING from README:** "Agent 拥有硬件底层级分布式系统根权限"
- Shell execution plugins (`LinuxShellExecutor`, `PowerShellExecutor`) with approval gating
- SSH remote execution capability
- Plugins can spawn child processes

### Secret Exposure Risk
- `config.env` contains real API keys (observed in file)
- No `.env` in `.gitignore` check needed — verify secrets aren't committed
- `config.env` is tracked? Check git status

### Authentication Gaps
- Basic auth for admin panel may be insufficient for production
- API key scheme is single-key per endpoint (no granular permissions)
- `toolApprovalManager` provides gating but relies on config file

## Performance Concerns

### Single-Process Bottleneck
- Main server is single Node.js process
- CPU-intensive operations (embedding, vector search) can block event loop
- Rust N-API helps but not all paths use it

### Memory Usage
- Large in-memory caches (`node-cache`)
- Vector indices loaded into memory
- Plugin system holds references to all plugins

### HTTP Agent Tuning
- `maxSockets = 10000` on global agents — high resource usage under load
- No connection pooling limits for specific upstreams

## Fragile Areas

### Agent Gateway (Rapidly Evolving)
- New modular architecture still stabilizing
- MCP transport adapter under active development
- Multiple runtime services (job, event, memory, context) with interdependencies

### RAG / Vector System
- `hnswlib-node` bindings can crash on malformed vectors
- Vector dimension mismatches between models and indexes
- Daily note RAG depends on proper embedding generation

### File-Based State
- Heavy reliance on JSON files for state (`agent_map.json`, `rag_params.json`)
- Race conditions possible with concurrent writes
- No transactional guarantees

## Known Issues

### Dependency Risks
- `pdf-parse` pinned to old version via override
- `puppeteer` + stealth plugins — Chrome dependency heavy
- `better-sqlite3` requires native compilation (platform-specific binaries)

### Windows-Specific Components
- `vcp-installer-source/` is Windows-focused
- `WinNotify.py`, `update.bat` — Windows-only utilities
- Cross-platform support gaps for installer/notification components

### Documentation Drift
- `AGENTS.md` generated on 2026-02-13 — may be stale
- `README.md` is very large (75KB) — hard to maintain
- Multiple changelog files (`ChangeLog.md`, `CHANGELOG.md`, `vcptoolbox更新日志.txt`)

## Testing Gaps

- No integration tests for plugin system
- No end-to-end tests for distributed WebSocket protocol
- No load/performance tests
- Admin panel frontend untested
- Rust component tests not visible in test directory

## Recommended Monitoring

- Upstream AI API latency and error rates
- Plugin execution times and failure rates
- Vector store query performance
- Disk space for logs (`DebugLog/` grows unbounded without cleanup)
- Memory usage of Node.js process
