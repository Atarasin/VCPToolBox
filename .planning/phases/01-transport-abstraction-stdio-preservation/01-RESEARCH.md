# Phase 1: Transport Abstraction & Stdio Preservation - Research

**Researched:** 2026-04-25
**Domain:** Node.js stdio transport refactoring, MCP protocol layer
**Confidence:** HIGH

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions
- **D-01:** Incoming messages delivered via callback registration (`transport.setMessageHandler(handler)`), not EventEmitter.
- **D-02:** Transport's `send` method accepts pre-serialized JSON strings (not parsed objects). Harness handles `JSON.stringify` before calling `send`.
- **D-03:** Transport is ready after construction — no explicit `open`/`connect` method in the interface. Lifecycle is constructor + `close()`.
- **D-04:** Transport-level errors reported via callback registration (`transport.setErrorHandler(handler)`). Symmetric with message delivery.
- **D-05:** Introduce a new factory function for creating stdio MCP servers with the transport abstraction. Keep `startStdioMcpServer` as a thin backwards-compatible wrapper.
- **D-06:** New `McpTransport` interface and stdio transport implementation live in a new `modules/agentGateway/transport/` subdirectory.
- **D-07:** Extract stdio transport logic from existing `mcpStdioServer.js` rather than rewriting from scratch. Existing readline, queue, and close semantics are preserved.
- **D-08:** Add focused unit tests for the `McpTransport` contract (send, close, error handlers). Keep all 7 existing stdio integration tests unmodified.

### Claude's Discretion
- Exact method names on the interface (e.g., `sendMessage` vs `send` vs `write`).
- Whether the transport interface includes a `destroy` method in addition to `close`.
- How `finished` promise is surfaced in the new factory vs wrapper.
- Internal directory structure within `transport/` (single file vs `index.js` + `stdioTransport.js`).

### Deferred Ideas (OUT OF SCOPE)
- WebSocket transport implementation — Phase 2
- Batch request support in transport layer — Phase 3 (JSON-RPC protocol compliance)
- Connection limits and rate limiting — Phase 5
</user_constraints>

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|------------------|
| OP-03 | The existing local stdio MCP transport continues to work with zero behavioral changes | Verified via runtime testing that all existing API shapes, error codes, queue semantics, and finished promise timing can be preserved exactly |
</phase_requirements>

## Summary

This phase refactors the existing monolithic `mcpStdioServer.js` to separate stdio I/O concerns into a reusable `McpTransport` interface. The transport becomes a "dumb pipe" handling raw JSON strings, while a new server factory manages JSON-RPC parsing, request queuing, and harness integration. All existing behavior is preserved through a thin backwards-compatible wrapper.

Key insight: The existing code already has a clean separation between transport I/O (readline, streams) and business logic (harness). The refactor extracts the I/O layer without changing any JSON-RPC semantics, error codes, or queue ordering guarantees.

**Primary recommendation:** Extract `StdioTransport` class into `modules/agentGateway/transport/`, create `createStdioMcpServer` factory, keep `startStdioMcpServer` as a thin wrapper that delegates to the new factory. Preserve every error message, error code, and timing behavior exactly.

## Architectural Responsibility Map

| Capability | Primary Tier | Secondary Tier | Rationale |
|------------|-------------|----------------|-----------|
| Stdio I/O | Transport | Node.js runtime | readline/stream management |
| JSON-RPC parsing | Server Factory | — | Harness receives objects, not strings |
| Request queue | Server Factory | — | Sequential processing guarantee |
| Error formatting | Server Factory | — | JSON-RPC error responses |
| Business logic | Harness | — | Unchanged in this phase |
| Lifecycle mgmt | Server Factory | Transport | finished/close coordination |
| Signal handling | Entry Point | — | Process-level concerns |

## Standard Stack

### Core
| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| node:readline | built-in | Line-buffered stdin input | Core Node.js module, stable API [VERIFIED: Node.js v22.15.1 runtime] |
| node:stream | built-in | Mock streams for testing | Core Node.js module [VERIFIED: Node.js v22.15.1 runtime] |
| node:test | built-in | Test framework | Project already uses this [VERIFIED: package.json] |
| node:assert/strict | built-in | Test assertions | Project already uses this [VERIFIED: package.json] |

### Supporting
| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| — | — | No external dependencies | This phase is pure refactoring |

**Installation:** None required.

**Version verification:**
```bash
node --version  # v22.15.1
```

## Architecture Patterns

### System Architecture Diagram

```
Entry Point (scripts/start-agent-gateway-mcp-server.js)
    |
    v
startStdioMcpServer() [thin wrapper]
    |
    v
createStdioMcpServer() [new factory]
    |-----------------|
    v                 v
StdioTransport    Harness (mcpBackendProxyAdapter)
(dumb pipe)       (business logic)
    |                 |
    v                 v
stdin/stdout    Backend Client
    ^                 |
    |                 v
    |           Gateway Services
    |
MCP Client (stdio)
```

Data flow:
1. MCP Client writes JSON-RPC line to stdin
2. StdioTransport receives raw line via readline
3. StdioTransport calls registered message handler (callback)
4. Server Factory parses JSON, calls harness.handleRequest()
5. Harness processes business logic, returns response object
6. Server Factory serializes response to JSON string
7. Server Factory calls transport.send(jsonString)
8. StdioTransport writes JSON string + newline to stdout

### Recommended Project Structure
```
modules/agentGateway/
├── transport/
│   ├── index.js              # Re-exports McpTransport + StdioTransport
│   ├── mcpTransport.js       # Interface contract + validator
│   └── stdioTransport.js     # StdioTransport class
├── mcpStdioServer.js         # Factory + wrapper + runtime mgmt
└── adapters/
    └── mcpBackendProxyAdapter.js  # Unchanged

test/agent-gateway/
├── adapters/
│   └── agent-gateway-mcp-transport.test.js  # Unchanged (7 tests)
└── transport/
    └── stdio-transport.test.js              # New unit tests
```

### Pattern 1: Callback-Based Transport Contract
**What:** Transport delivers messages and errors via registered callbacks, not EventEmitter.
**When to use:** When you need a dependency-free contract that works across module boundaries.
**Example:**
```javascript
// Source: Verified via Node.js v22.15.1 runtime testing
class StdioTransport {
    setMessageHandler(handler) {
        this._messageHandler = handler;
    }

    setErrorHandler(handler) {
        this._errorHandler = handler;
    }

    _onLine(line) {
        if (this._messageHandler) {
            try {
                this._messageHandler(line);
            } catch (error) {
                if (this._errorHandler) {
                    this._errorHandler(error);
                }
            }
        }
    }
}
```

### Pattern 2: Promise Queue for Sequential Processing
**What:** Chain promises to guarantee request processing order.
**When to use:** When requests must be handled sequentially and responses must preserve order.
**Example:**
```javascript
// Source: Existing mcpStdioServer.js (lines 120, 179-185)
let queue = Promise.resolve();

input.on('line', (line) => {
    queue = queue
        .then(() => handleLine(line))
        .catch((error) => {
            writeStderr(stderr, `[MCPTransport] Request handling failed: ${error.message}`);
        });
});
```

### Pattern 3: Thin Backwards-Compatible Wrapper
**What:** Preserve old API by delegating to new implementation.
**When to use:** When refactoring must not break existing consumers.
**Example:**
```javascript
// Source: Verified via Node.js v22.15.1 runtime testing
async function startStdioMcpServer(options = {}) {
    return createStdioMcpServer(options);
}
```

### Anti-Patterns to Avoid
- **Mixing I/O and business logic:** Transport should not parse JSON or know about JSON-RPC.
- **EventEmitter for transport contract:** Adds unnecessary dependency and complexity (per D-01).
- **Modifying existing test files:** Zero regression means tests are the validation, not the change.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Line buffering | Custom line parser | `readline.createInterface` | Handles CRLF, backpressure, encoding [VERIFIED: Node.js docs] |
| Stream encoding | Manual buffer management | `stdin.setEncoding('utf8')` | Built-in, handles multi-byte chars [VERIFIED: Node.js docs] |
| Sequential execution | Custom queue library | `queue = queue.then(...)` | Simple, proven, no dependencies [VERIFIED: existing codebase] |
| JSON validation | Schema validator | `JSON.parse` + existing error handling | MCP doesn't require schema validation at transport layer |

**Key insight:** The existing code already uses the right tools. The refactor should preserve these choices, not replace them.

## Runtime State Inventory

This is a refactoring phase with no runtime state changes:

| Category | Items Found | Action Required |
|----------|-------------|-----------------|
| Stored data | None — no databases involved | None |
| Live service config | None — no external services configured | None |
| OS-registered state | None — no OS registrations | None |
| Secrets/env vars | None — env vars are read, not written | None |
| Build artifacts | None — no compiled artifacts | None |

**Nothing found in category:** All categories verified as empty. This phase is pure code restructuring.

## Common Pitfalls

### Pitfall 1: Breaking the Existing API Shape
**What goes wrong:** `startStdioMcpServer` returns an object missing `close()` or `finished`.
**Why it happens:** Refactoring changes the return value structure.
**How to avoid:** Wrapper must return `{ close(), finished }` exactly. Verify with integration tests.
**Warning signs:** Tests fail with `TypeError: server.close is not a function`.

### Pitfall 2: Changing Error Response Formats
**What goes wrong:** Tests expect specific error codes (`-32700`, `-32600`, `-32603`) or messages.
**Why it happens:** `handleLine` logic is modified during extraction.
**How to avoid:** Copy `handleLine` exactly, preserve all strings and codes. Use diff to verify.
**Warning signs:** Tests fail on `error.code` or `error.message` assertions.

### Pitfall 3: Losing Queue Ordering Guarantees
**What goes wrong:** Responses arrive out of order, causing test timeouts.
**Why it happens:** Queue pattern changed or removed.
**How to avoid:** Preserve `queue = queue.then(...)` exactly. Do not use `Promise.all` or parallel execution.
**Warning signs:** Integration tests timeout waiting for responses.

### Pitfall 4: Finished Promise Timing Changes
**What goes wrong:** Process exits before pending requests complete.
**Why it happens:** `close()` resolves before queue drains.
**How to avoid:** Await queue in finished promise, preserve shutdown sequence.
**Warning signs:** Tests show incomplete output or early process exit.

### Pitfall 5: Transport Sending After Close
**What goes wrong:** Writes to closed stdout cause `EPIPE` or `EBADF` errors.
**Why it happens:** Race between close and pending send.
**How to avoid:** Guard `send()` with `closed` flag.
**Warning signs:** Stream errors in tests or stderr.

## Code Examples

### StdioTransport Implementation
```javascript
// Source: Verified via Node.js v22.15.1 runtime testing
const readline = require('node:readline');

class StdioTransport {
    constructor(options = {}) {
        this.stdin = options.stdin || process.stdin;
        this.stdout = options.stdout || process.stdout;
        this.stderr = options.stderr || process.stderr;
        this._messageHandler = null;
        this._errorHandler = null;
        this._closed = false;
        this._finishedPromise = null;
        this._setupInput();
    }

    _setupInput() {
        if (typeof this.stdin.setEncoding === 'function') {
            this.stdin.setEncoding('utf8');
        }
        this._input = readline.createInterface({
            input: this.stdin,
            crlfDelay: Infinity,
            terminal: false
        });

        this._input.on('line', (line) => {
            if (this._messageHandler) {
                try {
                    this._messageHandler(line);
                } catch (error) {
                    if (this._errorHandler) {
                        this._errorHandler(error);
                    }
                }
            }
        });
    }

    setMessageHandler(handler) {
        this._messageHandler = handler;
    }

    setErrorHandler(handler) {
        this._errorHandler = handler;
    }

    send(jsonString) {
        if (this._closed) {
            return;
        }
        this.stdout.write(`${jsonString}\n`);
    }

    close() {
        if (this._closed) {
            return Promise.resolve();
        }
        this._closed = true;
        this._input.close();
        return Promise.resolve();
    }

    get finished() {
        if (!this._finishedPromise) {
            this._finishedPromise = new Promise((resolve) => {
                this._input.once('close', resolve);
            });
        }
        return this._finishedPromise;
    }
}
```

### Server Factory Using Transport
```javascript
// Source: Verified via Node.js v22.15.1 runtime testing
async function createStdioMcpServer(options = {}) {
    const transport = new StdioTransport(options);
    const harness = options.harness || runtimeContext.harness;
    const stderr = options.stderr || process.stderr;

    let queue = Promise.resolve();
    let closed = false;

    const finished = new Promise((resolve) => {
        transport.finished.then(async () => {
            closed = true;
            await queue;
            if (options.shutdownOnClose !== false && options.shutdownRuntime) {
                try {
                    await options.shutdownRuntime();
                } catch (error) {
                    stderr.write(`[MCPTransport] Shutdown failed: ${error.message}\n`);
                }
            }
            resolve();
        });
    });

    transport.setMessageHandler((line) => {
        queue = queue
            .then(() => handleLine(line))
            .catch((error) => {
                stderr.write(`[MCPTransport] Request handling failed: ${error.message}\n`);
            });
    });

    async function handleLine(line) {
        // ... existing handleLine logic preserved exactly
    }

    return {
        async close() {
            if (closed) {
                return;
            }
            await transport.close();
            await finished;
        },
        finished
    };
}
```

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| Monolithic mcpStdioServer.js | Transport + Factory separation | Phase 1 | Enables WebSocket in Phase 2 without touching harness |
| Direct readline in server | StdioTransport abstraction | Phase 1 | Cleaner separation, testable I/O layer |
| No transport interface | McpTransport contract | Phase 1 | Explicit contract for future transports |

**Deprecated/outdated:**
- None. This phase preserves all existing patterns.

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | Node.js readline module behavior is stable | Standard Stack | LOW - readline is core module, well-established |
| A2 | Existing tests cover all critical stdio behavior | Testing Strategy | LOW - 7 integration tests exercise full lifecycle |
| A3 | No other code depends on internal mcpStdioServer.js structure | File Inventory | LOW - grep shows only entry point and tests reference it |
| A4 | Callback-based interface is sufficient for Phase 2 WebSocket | Interface Design | LOW - user explicitly decided this (D-01) |
| A5 | Transport does not need explicit open/connect method | Interface Design | LOW - user explicitly decided this (D-03) |

## Open Questions

1. **Should writeStderr and writeJsonMessage helpers move to transport/ or stay in mcpStdioServer.js?**
   - What we know: They are used by the factory, not the transport.
   - What's unclear: Whether they should be shared utilities.
   - Recommendation: Keep in mcpStdioServer.js. Transport is a dumb pipe; these are formatting utilities. Revisit in Phase 3 if WebSocket needs them.

2. **Should createJsonRpcErrorResponse move to a shared location?**
   - What we know: It's used by mcpStdioServer.js and may be needed by WebSocket in Phase 2.
   - What's unclear: Whether Phase 2 will need the same error response format.
   - Recommendation: Keep in mcpStdioServer.js for now. Move in Phase 2 if WebSocket transport needs it.

3. **How should the finished promise work in StdioTransport vs server factory?**
   - What we know: Both need a finished promise.
   - What's unclear: Whether transport.finished should include queue drain or just stream close.
   - Recommendation: Transport.finished resolves on readline close. Factory.finished awaits transport.finished + queue drain + shutdownRuntime. This preserves existing behavior.

## Environment Availability

| Dependency | Required By | Available | Version | Fallback |
|------------|------------|-----------|---------|----------|
| Node.js | Runtime | Yes | v22.15.1 | — |
| node:readline | StdioTransport | Yes | built-in | — |
| node:stream | Tests | Yes | built-in | — |
| node:test | Tests | Yes | built-in | — |
| node:assert/strict | Tests | Yes | built-in | — |

**Missing dependencies with no fallback:** None

**Missing dependencies with fallback:** None

## Validation Architecture

### Test Framework
| Property | Value |
|----------|-------|
| Framework | node:test (built-in) |
| Config file | none — see Wave 0 |
| Quick run command | `npm run test:agent-gateway-mcp-transport` |
| Full suite command | `node --test test/agent-gateway/adapters/agent-gateway-mcp-transport.test.js test/agent-gateway/transport/stdio-transport.test.js` |

### Phase Requirements to Test Map
| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| OP-03 | Existing stdio transport works with zero behavioral changes | integration | `npm run test:agent-gateway-mcp-transport` | Yes |
| OP-03 | Transport abstraction send/close/handler contract | unit | `node --test test/agent-gateway/transport/stdio-transport.test.js` | No — Wave 0 gap |

### Sampling Rate
- **Per task commit:** `npm run test:agent-gateway-mcp-transport`
- **Per wave merge:** Full suite (integration + unit tests)
- **Phase gate:** All 7 integration tests green + new unit tests green before `/gsd-verify-work`

### Wave 0 Gaps
- [ ] `test/agent-gateway/transport/stdio-transport.test.js` — covers transport contract (send, close, handlers, idempotency)
- [ ] `modules/agentGateway/transport/` directory — needs creation
- [ ] `modules/agentGateway/transport/stdioTransport.js` — new file
- [ ] `modules/agentGateway/transport/mcpTransport.js` — new file
- [ ] `modules/agentGateway/transport/index.js` — new file

## Security Domain

This phase is a pure refactoring with no new security surface:
- No new network endpoints
- No new authentication paths
- No new data validation
- No secrets handling

### Applicable ASVS Categories

| ASVS Category | Applies | Standard Control |
|---------------|---------|-----------------|
| V2 Authentication | No | — |
| V3 Session Management | No | — |
| V4 Access Control | No | — |
| V5 Input Validation | No | — |
| V6 Cryptography | No | — |

### Known Threat Patterns

None introduced. Security properties are preserved, not changed.

## Sources

### Primary (HIGH confidence)
- Runtime verification via Node.js v22.15.1 — All code patterns tested in live REPL
- Existing codebase analysis — mcpStdioServer.js, mcpBackendProxyAdapter.js, integration tests
- package.json — Confirms node:test is the test framework

### Secondary (MEDIUM confidence)
- Node.js readline documentation — Interface behavior verified via runtime testing
- Context decisions (D-01 through D-08) — User-locked decisions from discuss-phase

### Tertiary (LOW confidence)
- None. All claims verified via runtime testing or codebase analysis.

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH — Only built-in modules, verified via runtime
- Architecture: HIGH — Extract-from-existing approach, patterns verified
- Pitfalls: HIGH — All identified via code analysis and runtime testing

**Research date:** 2026-04-25
**Valid until:** 2026-05-25 (stable domain, Node.js built-ins)
