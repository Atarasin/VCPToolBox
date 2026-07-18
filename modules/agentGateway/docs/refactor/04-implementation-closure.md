# M0-M7 implementation closure

## Final status

The M0-M7 implementation is **compliant with the target architecture and automated release gates**.
The only remaining release limitation is the real Codex MCP smoke test, which requires external
authentication and remains the documented manual pre-release gate. M8 is still out of scope.

| Milestone | Status | Evidence |
| --- | --- | --- |
| M0 | Complete | `npm run test:agent-gateway`: 731/731; CI aggregate runner |
| M1 | Complete | timeout/auth/discovery regression suites |
| M2 | Complete | canonical MCP semantics, executors and parity suites |
| M3 | Complete | shared codec/context/rate limit; split HTTP/WS runtimes |
| M4 | Complete | frozen narrow ports; host/private API access and config extraction confined to `composition/`; partial enabled RAG bindings fail fast |
| M5 | Complete | six physical stage modules, short orchestrator, identity compatibility test and serial shared-backend test |
| M6 | Complete | canonical operations/schemas, deterministic generation and eight-operation AJV compatibility corpus |
| M7 | Complete | shared audit sinks and a real HTTP MCP → backend proxy → Native route → service → audit trace test |

## M4 closure evidence

- `composition/vcpPortBindings.js` is the only module that knows host fields, RAG private APIs,
  the historical `1.33` search coefficient, root-level host modules and legacy fixture adaptation.
- Core, service, policy, protocol and route code receive ports or frozen configuration/readiness
  snapshots; scans find no direct host-property or RAG-private-API access outside composition.
- The RAG port exposes methods and capability flags, not `knowledgeBaseManager` or `ragPlugin`.
- A partially enabled RAG host without `searchDiary` fails during binding instead of exposing a
  lazy wrapper that fails only during an operation.
- Memory write idempotency state is service-local and the diary writer port returns a DTO rather
  than a raw plugin object.

## M5 closure evidence

- `core/recall/pipeline.js` is a short orchestrator and re-exports the exact function objects from:
  `resolveProfile`, `precomputeVector`, `executeRules`, `mergeResults`, `applyBudget` and `applyAiMemo`.
- `executeRulesStage` uses a serial `for` loop with `await executeRuleStage(...)`; no rule-level
  `Promise.all` was introduced.
- Legacy recall service/projection paths remain CommonJS identity re-exports.
- S01-S05 fixtures and the full aggregate suite preserve items, diagnostics, ordering and errors.

## Compatibility and release notes

- The 15 REST paths, eight MCP operations, response envelopes and environment variables are preserved.
- HTTP and stdio batch requests remain rejected; WebSocket batch remains capped at 20.
- Recall rules remain serial and retain stable output ordering.
- SSE backpressure is bounded at 30 seconds by default.
- Discovery sessions use an independent bounded LRU pool with a 60-second TTL.
- WebSocket idle cleanup is opt-in and remains disabled by default.
- `AGENT_GATEWAY_AUDIT_FILE` enables an append-only file sink. Rotation remains delegated to
  container logging or external `logrotate`.
- D5 is waived: jobs remain process-local until a cross-process state model is separately designed.
- M8 remains out of scope; rule concurrency and HTTP/stdio batch behavior require a separate
  compatibility decision.

## Verification

| Check | Result |
| --- | --- |
| `npm run test:agent-gateway` | 731/731, 0 fail |
| S01-S05 | 424/424, 0 fail |
| OpenAPI/MCP generation | regenerated with zero diff |
| REST/MCP publication | 15 REST paths; 8 MCP operations |
| Function size | zero functions over 150 lines |
| File size | zero scoped files over 800 lines; maximum 798 |
| Host/private API scan | zero matches outside `composition/` |
| Deep root require scan | zero matches outside `composition/` |
| Real Codex smoke | not run; external authentication required |

Implementation closure commit: `5f42fc12`.
