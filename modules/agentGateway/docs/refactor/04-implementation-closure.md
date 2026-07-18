# M0-M7 implementation closure

## Final status

The implementation is **not yet fully compliant** with the M0-M7 target architecture.
All published behavior and automated release gates pass, but two structural requirements
remain open: M4 host isolation and M5 physical stage modules.

| Milestone | Status | Evidence |
| --- | --- | --- |
| M0 | Complete | `npm run test:agent-gateway`; CI aggregate runner |
| M1 | Complete | timeout/auth/discovery regression suites |
| M2 | Complete | canonical MCP semantics, executors and parity suites |
| M3 | Complete | shared codec/context/rate limit; split HTTP/WS runtimes |
| M4 | Partial | composition and ports exist, but core/service/policy code still reads `pluginManager` and the RAG port exposes raw host objects |
| M5 | Partial | item/budget/diary access and serial rules are unified; the six named stages remain functions in `core/recall/pipeline.js` rather than physical stage files |
| M6 | Complete | canonical operations/schemas, deterministic generation and eight-operation AJV compatibility corpus |
| M7 | Complete | shared audit sinks and a real HTTP MCP → backend proxy → Native route → service → audit trace test |

## Compatibility and release notes

- The 15 REST paths, eight MCP operations, response envelopes and environment variables are preserved.
- HTTP and stdio batch requests remain rejected; WebSocket batch remains capped at 20.
- Recall rules remain serial; no `Promise.all` was introduced in the rule loop.
- SSE backpressure is bounded at 30 seconds by default.
- Discovery sessions use an independent bounded LRU pool with a 60-second TTL.
- WebSocket idle cleanup is opt-in and remains disabled by default.
- Legacy service paths remain CommonJS identity re-exports where migration shims exist.
- `AGENT_GATEWAY_AUDIT_FILE` enables an append-only file sink. Rotation remains delegated to container logging or external `logrotate`.
- D5 is waived: jobs remain process-local until a cross-process state model is separately designed.
- M8 is out of scope; rule concurrency and HTTP/stdio batch behavior require a separate compatibility decision.

## Remaining closure work

1. Replace raw `knowledgeBaseManager`/`ragPlugin` exposure with frozen narrow RAG port methods and move all private API/magic-parameter knowledge into `composition/vcpPortBindings.js`.
2. Remove direct `pluginManager` reads from core/services/policy/protocol code; composition must inject snapshots and narrow ports.
3. Move `resolveProfile`, `precomputeVector`, `executeRules`, `mergeResults`, `applyBudget` and `applyAiMemo` into physical stage modules while preserving diagnostics and export identity.
