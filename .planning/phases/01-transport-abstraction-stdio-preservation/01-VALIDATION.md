---
phase: 1
slug: transport-abstraction-stdio-preservation
status: draft
nyquist_compliant: false
wave_0_complete: false
created: 2026-04-25
---

# Phase 1 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | node:test (built-in) |
| **Config file** | none — see Wave 0 |
| **Quick run command** | `npm run test:agent-gateway-mcp-transport` |
| **Full suite command** | `node --test test/agent-gateway/adapters/agent-gateway-mcp-transport.test.js test/agent-gateway/transport/stdio-transport.test.js` |
| **Estimated runtime** | ~5 seconds |

---

## Sampling Rate

- **After every task commit:** Run `npm run test:agent-gateway-mcp-transport`
- **After every plan wave:** Run full suite (integration + unit tests)
- **Before `/gsd-verify-work`:** Full suite must be green
- **Max feedback latency:** 10 seconds

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Threat Ref | Secure Behavior | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|------------|-----------------|-----------|-------------------|-------------|--------|
| 1-01-01 | 01 | 1 | OP-03 | — | Preserve existing stdio behavior | integration | `npm run test:agent-gateway-mcp-transport` | Yes | pending |
| 1-01-02 | 01 | 1 | OP-03 | — | Transport interface contract | unit | `node --test test/agent-gateway/transport/stdio-transport.test.js` | No — W0 | pending |

*Status: pending / green / red / flaky*

---

## Wave 0 Requirements

- [ ] `test/agent-gateway/transport/stdio-transport.test.js` — stubs for transport contract
- [ ] `modules/agentGateway/transport/` directory — created
- [ ] `modules/agentGateway/transport/stdioTransport.js` — new file
- [ ] `modules/agentGateway/transport/mcpTransport.js` — new file
- [ ] `modules/agentGateway/transport/index.js` — new file

---

## Manual-Only Verifications

All phase behaviors have automated verification.

---

## Validation Sign-Off

- [ ] All tasks have automated verify or Wave 0 dependencies
- [ ] Sampling continuity: no 3 consecutive tasks without automated verify
- [ ] Wave 0 covers all MISSING references
- [ ] No watch-mode flags
- [ ] Feedback latency < 10s
- [ ] `nyquist_compliant: true` set in frontmatter

**Approval:** pending
