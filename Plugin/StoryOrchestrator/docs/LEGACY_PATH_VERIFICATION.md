# Legacy Path Verification Report

**Date:** 2026-05-01
**Scope:** StoryOrchestrator legacy path (`USE_WORKFLOW_KERNEL=false`)
**Verifier:** Automated integration test suite

## Summary

The legacy `WorkflowEngine` + Phase1/2/3 path continues to function correctly with zero regressions. All integration tests pass, import resolution is conflict-free, and the feature switch toggles cleanly via configuration alone.

## Test Results

### Integration Tests (Legacy Path)

```bash
node --test Plugin/StoryOrchestrator/tests/integration.test.js
```

| Metric | Value |
|--------|-------|
| Total tests | 40 |
| Passed | 40 |
| Failed | 0 |
| Cancelled | 0 |
| Skipped | 0 |
| Duration | ~470 ms |

### Integration Tests (Kernel Path — Regression Check)

```bash
TEST_USE_WORKFLOW_KERNEL=true USE_WORKFLOW_KERNEL=true node --test Plugin/StoryOrchestrator/tests/integration.test.js
```

| Metric | Value |
|--------|-------|
| Total tests | 40 |
| Passed | 40 |
| Failed | 0 |
| Duration | ~2,950 ms |

### E2E Extraction Tests

```bash
node --test Plugin/StoryOrchestrator/tests/e2e-extraction.test.js
```

| Metric | Value |
|--------|-------|
| Total tests | 4 |
| Passed | 4 |
| Failed | 0 |

## Feature Switch Verification

### Toggle Mechanism

The switch is controlled by the `USE_WORKFLOW_KERNEL` key in `Plugin/StoryOrchestrator/config.env`:

- `true` → Kernel adapter initialized; `StartStoryProject` and `UserConfirmCheckpoint` routed through `WorkflowKernel`.
- `false` or absent → Kernel adapter skipped; all commands routed through legacy `WorkflowEngine`.

### Toggle Latency

| Step | Estimated Time |
|------|---------------|
| Edit `config.env` | < 5 seconds |
| Process restart | < 10 seconds |
| **Total** | **< 15 seconds** |

This is well under the one-minute requirement.

### Import Coexistence

Both `WorkflowEngine` and `StoryOrchestratorKernelAdapter` are imported unconditionally at the top of `StoryOrchestrator.js`:

```js
const { WorkflowEngine } = require('./WorkflowEngine');
const { StoryOrchestratorKernelAdapter } = require('../adapters/StoryOrchestratorKernelAdapter');
```

Runtime verification:

```bash
node -e "
require('./Plugin/StoryOrchestrator/core/StoryOrchestrator');
require('./Plugin/StoryOrchestrator/core/WorkflowEngine');
require('./Plugin/StoryOrchestrator/adapters/StoryOrchestratorKernelAdapter');
console.log('All imports resolve without conflicts');
"
```

**Result:** All three modules load simultaneously with no circular dependencies, no missing symbols, and no side effects from unused imports.

## Zero-Regression Evidence

1. **No code changes required to toggle** — Only `config.env` is modified.
2. **Legacy engine code is untouched** — `WorkflowEngine.js`, `Phase1.js`, `Phase2.js`, `Phase3.js` have no kernel-specific branches.
3. **StateManager schema unchanged** — The same `stories` table schema serves both paths.
4. **All 10 test suites pass** — Command interface, full workflow, concurrency, agent mock, state verification, validation, checkpoint expiry, phase2 retry, phase3 guard, and workflow closure.
5. **Observability metrics track both paths** — `getMetrics()` reports `kernel` and `legacy` counters regardless of which path is active.

## Conclusion

The legacy path is **fully operational** and **regression-free**. The feature switch is production-ready.
