---
phase: 02
slug: websocket-endpoint-session-management
status: approved
nyquist_compliant: true
wave_0_complete: true
created: 2026-04-26
approved: 2026-04-26
---

# Phase 02 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | `node:test` |
| **Config file** | none |
| **Quick run command** | `node --test test/agent-gateway/transport/websocket-transport.test.js test/agent-gateway/adapters/agent-gateway-mcp-websocket.test.js` |
| **Full suite command** | `npm run test:agent-gateway-mcp-transport && npm run test:agent-gateway-mcp-websocket` |
| **Estimated runtime** | ~20 seconds |

---

## Sampling Rate

- **After every task commit:** Run the focused test(s) for the touched area; at minimum `node --test test/agent-gateway/transport/websocket-transport.test.js`
- **After every plan wave:** Run `node --test test/agent-gateway/transport/websocket-transport.test.js test/agent-gateway/adapters/agent-gateway-mcp-websocket.test.js`
- **Before `/gsd-verify-work`:** Full suite must be green
- **Max feedback latency:** 20 seconds

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Threat Ref | Secure Behavior | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|------------|-----------------|-----------|-------------------|-------------|--------|
| 02-01-00 | 01 | 1 | TRANS-01 | T-02-05 | Transport contract explicitly requires `finished`, preventing incomplete transport implementations from passing validation silently | unit | `node --test test/agent-gateway/transport/websocket-transport.test.js` | ✅ | ✅ green |
| 02-01-01 | 01 | 1 | TRANS-01 / TRANS-10 | T-02-01 / T-02-04 | Transport only accepts live socket traffic, ignores binary frames, routes transport errors, and emits serialized outbound frames without creating a parallel heartbeat protocol | unit | `node --test test/agent-gateway/transport/websocket-transport.test.js` | ✅ | ✅ green |
| 02-01-02 | 01 | 1 | TRANS-02 / TRANS-03 / TRANS-09 / OP-02 / OP-06 | T-02-02 / T-02-03 / T-02-05 | Upgrade auth gates handshake, batch requests fail safely, canonical session is server-owned, and cleanup always removes connection state | integration | `node --test test/agent-gateway/adapters/agent-gateway-mcp-websocket.test.js` | ✅ | ✅ green |
| 02-02-01 | 02 | 1 | TRANS-01 / OP-02 / OP-06 | T-02-03 / T-02-05 | `server.js` wires the dedicated `/mcp` manager without merging it into the legacy mesh lifecycle | integration | `node --test test/agent-gateway/adapters/agent-gateway-mcp-websocket.test.js` | ✅ | ✅ green |
| 02-02-02 | 02 | 1 | TRANS-01 / TRANS-02 / TRANS-03 / TRANS-09 / TRANS-10 / OP-02 / OP-06 | T-02-01 / T-02-02 / T-02-03 / T-02-04 / T-02-05 | Endpoint tests prove auth, parse/batch rejection, request metadata injection, keepalive behavior, shutdown ordering, and cleanup all hold against the wired server | integration | `npm run test:agent-gateway-mcp-websocket` | ✅ | ✅ green |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

- [x] `modules/agentGateway/transport/webSocketTransport.js` — websocket dumb-pipe transport implementation
- [x] `modules/agentGateway/transport/mcpTransport.js` — explicit `finished` contract validation
- [x] `modules/agentGateway/mcpWebSocketServer.js` — dedicated `/mcp` upgrade, keepalive, and session manager
- [x] `test/agent-gateway/transport/websocket-transport.test.js` — focused transport contract coverage
- [x] `test/agent-gateway/adapters/agent-gateway-mcp-websocket.test.js` — endpoint integration coverage
- [x] `package.json` — `test:agent-gateway-mcp-websocket` script

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| Browser/devtool interoperability against a running VCP instance | TRANS-01 / TRANS-02 | Automated tests use Node clients and do not exercise browser header limitations or real deployment proxies | Start the app, connect a real MCP websocket client to `/mcp`, verify authenticated connect and graceful disconnect |
| Slow or hung upgrade authentication behavior | OP-06 | Auth-timeout hardening is intentionally deferred to Phase 5, so Phase 2 only documents the risk instead of enforcing a timeout | With a controlled auth stall, confirm the current server behavior and capture findings for Phase 5 hardening |

---

## Validation Sign-Off

- [x] All tasks have automated verify or Wave 0 dependencies
- [x] Sampling continuity: no 3 consecutive tasks without automated verify
- [x] Wave 0 covers all MISSING references
- [x] No watch-mode flags
- [x] Feedback latency < 20s
- [x] `nyquist_compliant: true` set in frontmatter

**Approval:** approved for Phase 2 sign-off; upgrade-auth timeout hardening deferred to Phase 5.
