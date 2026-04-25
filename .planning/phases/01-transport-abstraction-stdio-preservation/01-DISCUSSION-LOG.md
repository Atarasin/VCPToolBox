# Phase 1: Transport Abstraction & Stdio Preservation - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md — this log preserves the alternatives considered.

**Date:** 2026-04-25
**Phase:** 1-transport-abstraction-stdio-preservation
**Areas discussed:** Transport interface contract, Backwards compatibility strategy

---

## Transport interface contract

| Option | Description | Selected |
|--------|-------------|----------|
| EventEmitter (transport.on('message', ...)) | Node.js idiomatic. Harness registers listeners. | |
| Callback registration (transport.setMessageHandler(fn)) | Simpler contract, no EventEmitter dependency. | ✓ |
| You decide | Claude picks based on codebase conventions. | |

**User's choice:** Callback registration (transport.setMessageHandler(fn))
**Notes:** User prefers explicit callback registration over EventEmitter for a cleaner, dependency-free contract.

---

### Message serialization responsibility

| Option | Description | Selected |
|--------|-------------|----------|
| Parsed object (transport.send({ jsonrpc: '2.0', ... })) | Transport handles JSON.stringify internally. | |
| Pre-serialized string (transport.send('{"jsonrpc":"2.0",...}')) | Transport is a dumb byte pipe. Harness handles stringify. | ✓ |
| You decide | Claude picks based on what fits the codebase best. | |

**User's choice:** Pre-serialized string (transport.send('{"jsonrpc":"2.0",...}'))
**Notes:** User wants transport to be a "dumb pipe" — pre-serialized strings in, callback handlers out. Keeps harness in control of JSON-RPC semantics.

---

### Transport lifecycle

| Option | Description | Selected |
|--------|-------------|----------|
| Constructor only — transport is ready after new | Simplest. Stdio transport is always 'connected' once created. | ✓ |
| Explicit open/close pair | More symmetric and predictable. | |
| You decide | Claude picks based on stdio and WebSocket needs. | |

**User's choice:** Constructor only — transport is ready after new
**Notes:** Interface stays minimal. WebSocket transport in Phase 2 will manage its own connection lifecycle internally.

---

### Error handling

| Option | Description | Selected |
|--------|-------------|----------|
| Callback registration (setErrorHandler) | Symmetric with message handler. | ✓ |
| EventEmitter-style (on('error', ...)) | Node.js standard but inconsistent with callback-based messages. | |
| Thrown from close() | Simplest contract but loses context. | |

**User's choice:** Callback registration (setErrorHandler)
**Notes:** Symmetric with message handler pattern. Clean contract, easy to test.

---

## Backwards compatibility strategy

### API stability

| Option | Description | Selected |
|--------|-------------|----------|
| Preserve exactly — same signature, same return shape | Zero risk of breaking existing callers. | |
| Evolve the signature — introduce a new factory, keep old as wrapper | Old API stays as a thin wrapper calling the new transport. | ✓ |
| You decide | Claude picks based on refactoring best practices. | |

**User's choice:** Evolve the signature — introduce a new factory, keep old as wrapper
**Notes:** Old API stays as a thin wrapper. New code uses the factory. Cleanest separation.

---

### Module location

| Option | Description | Selected |
|--------|-------------|----------|
| New file in adapters/ (mcpTransport.js) | Keeps transport close to other adapters. | |
| New transport/ subdirectory | Dedicated home for transport abstractions. | ✓ |
| You decide | Claude picks based on codebase conventions. | |

**User's choice:** New transport/ subdirectory
**Notes:** Stdio and WebSocket transports will live together. Cleaner separation.

---

### Build approach

| Option | Description | Selected |
|--------|-------------|----------|
| Extract from existing mcpStdioServer.js | Refactor existing working code. Lowest risk of behavioral drift. | ✓ |
| Write new transport from scratch | Cleaner separation but slight risk of divergence. | |
| You decide | Claude picks based on codebase maturity. | |

**User's choice:** Extract from existing mcpStdioServer.js
**Notes:** Existing readline queue semantics preserved exactly. Battle-tested behavior maintained.

---

### Testing

| Option | Description | Selected |
|--------|-------------|----------|
| Reuse existing integration tests only | Fastest but transport interface itself isn't directly tested. | |
| Add unit tests for transport interface + keep integration tests | More coverage, slightly more test code. | ✓ |
| You decide | Claude picks based on test pyramid and risk. | |

**User's choice:** Add unit tests for transport interface + keep integration tests
**Notes:** New focused tests for McpTransport contract. Existing integration tests verify stdio end-to-end.

---

## Claude's Discretion

- Exact method names on the interface (e.g., `sendMessage` vs `send` vs `write`).
- Whether the transport interface includes a `destroy` method in addition to `close`.
- How `finished` promise is surfaced in the new factory vs wrapper.
- Internal directory structure within `transport/` (single file vs `index.js` + `stdioTransport.js`).

## Deferred Ideas

- WebSocket transport implementation — Phase 2
- Batch request support in transport layer — Phase 3
- Connection limits and rate limiting — Phase 5
