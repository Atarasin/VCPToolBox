# Conventions

**Date:** 2026-04-24

## Code Style

- **Indentation:** 4 spaces (observed in core files)
- **Quotes:** Mixed — single quotes predominant in newer code, double in older
- **Semicolons:** Required, consistently used
- **Line endings:** LF (Unix-style)
- **Comments:** Chinese comments prevalent throughout codebase; mixed English/Chinese
- **File encoding:** UTF-8

## Naming Patterns

| Type | Convention | Example |
|------|------------|---------|
| Classes | PascalCase | `PluginManager`, `RotatingLogger` |
| Functions | camelCase | `resolveAgentDir()`, `ensureAgentDirectory()` |
| Variables | camelCase | `pluginDir`, `debugMode` |
| Constants | UPPER_SNAKE_CASE | `DEFAULT_TIMEZONE`, `PLUGIN_DIR` |
| Environment vars | UPPER_SNAKE_CASE | `API_URL`, `PORT`, `API_Key` |
| Private methods | Leading underscore | `_getDecryptedAuthCode()`, `_generateMainFilePath()` |
| Event emitters | `on[Event]` / `emit([event])` | Standard Node.js `EventEmitter` |

## Module Patterns

### CommonJS
All Node.js code uses `require()` / `module.exports`:
```javascript
const express = require('express');
module.exports = { ... };
```

### Class-based Core
Major subsystems implemented as classes extending `EventEmitter`:
- `PluginManager` (`Plugin.js`)
- `RotatingLogger` (`modules/logger.js`)

### Plugin Architecture
Each plugin is a directory with:
- `plugin-manifest.json` — Metadata, permissions, hooks
- Main script (varies by plugin)
- Optional frontend assets

### Gateway Module Pattern
`modules/agentGateway/` uses index.js barrel exports:
```javascript
module.exports = {
    adapters: require('./adapters'),
    contracts: require('./contracts'),
    infra: require('./infra'),
    policy: require('./policy'),
    services: require('./services')
};
```

## Error Handling

- **Sync errors:** Try/catch with specific error code handling (`EEXIST`, `EACCES`, `ENOENT`, etc.)
- **Async errors:** Try/catch with async/await
- **Fatal errors:** `process.exit(1)` on unrecoverable startup failures
- **Logging:** Custom rotating logger at `modules/logger.js`
- **Debug mode:** Controlled by `DebugMode` env var; gates verbose console output

Example pattern from `server.js`:
```javascript
try {
    await fs.mkdir(AGENT_DIR, { recursive: true });
} catch (error) {
    if (error.code !== 'EEXIST') {
        console.error(`[Server] Failed to create Agent directory: ${AGENT_DIR}`);
        if (error.code === 'EACCES' || error.code === 'EPERM') {
            console.error('[Server] Error: Permission denied');
        }
        process.exit(1);
    }
}
```

## Async Patterns

- **Primary:** `async/await` — Modern code uses this exclusively
- **Legacy:** Some callbacks remain in older plugin code
- **Promise:** `fs.promises` used for file operations
- **Streams:** Used for log writing and HTTP proxying

## Configuration Access

Environment variables accessed directly via `process.env.*` with fallbacks:
```javascript
const PORT = process.env.PORT || 6005;
const debugMode = (process.env.DebugMode || "False").toLowerCase() === "true";
```

## Logging Conventions

- Prefix format: `[Server]`, `[PluginManager]`, `[AgentGateway]`
- Log levels implied by method: `console.log` (info), `console.error` (error)
- Custom logger supports rotation by date and size
- Logs written to `DebugLog/ServerLog.txt` with daily archiving

## Security Patterns

- **Auth codes:** Encrypted binary files (`code.bin`)
- **API keys:** Stored in `config.env` (not committed to git)
- **Tool approval:** Explicit user approval for sensitive operations via `toolApprovalManager`
- **IP blocking:** `ip_blacklist.json` for abuse prevention
- **Shell execution:** Gated through plugins with approval workflow
