# StoryOrchestrator Legacy Path Retirement Audit

## Purpose

This document records the implementation evidence for StoryOrchestrator legacy path retirement after phase-class shell runtime removal.

Its job is not to declare that every compatibility layer is gone. Its job is to answer three narrower questions for maintainers:

- Which legacy surfaces still have real runtime or compatibility duties
- Which surfaces are canonical-path delegation, migration-input-only, or fully retired
- What must be true before any later implementation change can safely remove the remaining compatibility shell

## Audit Scope

This audit covers the documented legacy compatibility surfaces that framed the retirement implementation wave:

- `WorkflowEngine`
- `Phase1_WorldBuilding`
- `Phase2_OutlineDrafting`
- `Phase3_Refinement`
- `workflow-phase1.js` (already retired as a file-backed degraded entry)

## Routing Classes

| Routing class | Meaning |
|---|---|
| `canonical-delegation-shell` | The surface still fronts a public command path, but its supported behavior is to delegate into the kernel-owned control plane. |
| `migration-input-only` | The surface no longer exists as a runtime module; only persisted legacy references are still normalized for compatibility. |
| `retired` | The surface no longer participates in supported runtime, recovery, or checkpoint execution. |

## Surface Inventory

| Surface | Current state | Routing class | Why it still exists | Retirement direction |
|---|---|---|---|---|
| `WorkflowEngine` | `retain-as-shell` | `canonical-delegation-shell` | `StoryOrchestrator` still constructs it during initialization, routes status reads through it, and uses it as the public compatibility facade for start, resume, recover, retry, and chapter retry commands. | Keep as a thin shell for now; only consider further collapse after public command routing and compatibility state reads are re-homed. |
| `Phase1_WorldBuilding` | `retired` | `retired` | Supported runtime execution no longer instantiates or calls the phase class. The source file and its dedicated tests have been removed. | Keep retired; do not restore as fallback runtime. |
| `Phase2_OutlineDrafting` | `retired` | `retired` | Checkpoint continuation and phase2 recovery no longer call `run()` or `continueFromCheckpoint()` on the phase class. The source file and its dedicated tests have been removed. | Keep retired; do not restore as fallback runtime. |
| `Phase3_Refinement` | `retired` | `retired` | Final checkpoint continuation and recovery now delegate through kernel-owned runtime instead of the phase class. The source file and its dedicated tests have been removed. | Keep retired; do not restore as fallback runtime. |
| `workflow-phase1.js` | `retired` | `migration-input-only` | The file-backed degraded entry has already been removed. Old phase-only `definitionRef` values are accepted only as migration input and normalized directly onto the canonical workflow definition. | Keep only the normalization rule; do not reintroduce the file-backed degraded entry. |

## Evidence Summary

### 1. WorkflowEngine still fronts real command paths

Current command handling still shows that `WorkflowEngine` is not dead code:

- `StoryOrchestrator` still constructs and initializes `WorkflowEngine` during startup.
- `UserConfirmCheckpoint` still falls back to `workflowEngine.resume()` when a persisted checkpoint exists but the in-memory kernel workflow is not active.
- `RecoverStoryWorkflow`, `RetryPhase`, and `RetryChapter` still call into workflow-engine compatibility helpers.
- `QueryStoryStatus` still reads workflow status through `workflowEngine.getWorkflowStatus()`.

Current judgment:

- `WorkflowEngine` remains a real compatibility shell.
- It should not receive new primary workflow control semantics.
- It cannot yet be retired safely.

### 2. Phase-class shells no longer carry supported runtime execution

The phase classes are no longer canonical logic and are no longer fallback runtime:

- `WorkflowEngine` no longer imports or instantiates `Phase1_WorldBuilding`, `Phase2_OutlineDrafting`, or `Phase3_Refinement`.
- `start()`, `resume()`, `recover()`, `retryPhase()`, and `handleChapterRetry()` all delegate through `StoryOrchestratorKernelAdapter`.
- Kernel-unavailable paths now return an explicit retirement error instead of re-entering `_runPhase1()`, `_runPhase2()`, `_runPhase3()`, or phase-class `continueFromCheckpoint()` behavior.
- The phase source files and dedicated `Phase1.test.js`, `Phase2.test.js`, and `Phase3.test.js` have been removed.

Current judgment:

- `Phase1_WorldBuilding`, `Phase2_OutlineDrafting`, and `Phase3_Refinement` are retired runtime surfaces.
- Their retirement is implementation-backed, not merely aspirational documentation.

### 3. workflow-phase1.js remains retired as migration input only

The old phase-only definition entry stays retired and the narrower compatibility rule still holds:

- Workflow definition loading prefers the full workflow definition.
- Legacy phase definitions are treated as deprecated migration input for kernel execution.
- Recovery normalization still keeps `story-orchestrator-phase1` readable by mapping it onto the full workflow definition.

Current judgment:

- `workflow-phase1.js` remains retired.
- Its remaining value is limited to input normalization, not orchestration logic.

### 4. Tests now protect the thin-facade contract instead of phase-class runtime

The test suite has been updated to treat facade delegation as the supported contract surface:

- `WorkflowEngine.test.js` verifies compatibility surface classification, facade delegation, and kernel-owned timeout handling.
- `ReplacementCertification.test.js` continues to verify that the compatibility shell delegates start, resume, recovery, and phase progress without re-entering legacy phase runners when kernel ownership is active.
- `integration.test.js` now stubs facade-level `start`, `resume`, `recover`, and `retryPhase` behavior instead of relying on `_runPhase1()` or phase-class execution.
- Phase-centric unit tests were removed together with the retired phase-class runtime.

Current judgment:

- The repository now protects canonical workflow definition behavior, kernel-owned execution, and thin-facade compatibility semantics.
- Silent reintroduction of phase-class runtime should be treated as regression.

## Retirement Preconditions

### WorkflowEngine

WorkflowEngine should only move toward retirement after all of the following become true:

- `StoryOrchestrator` no longer depends on it as the default compatibility command shell.
- Start, status query, checkpoint approval fallback, recovery, retry, and chapter retry all have thinner kernel-owned or facade-owned replacements.
- Compatibility state projection is re-homed into a smaller surface or direct kernel query contract.
- Tests that currently protect WorkflowEngine compatibility semantics are either removed intentionally or rewritten around the replacement surface.

### Phase1_WorldBuilding / Phase2_OutlineDrafting / Phase3_Refinement

The phase-class shells have already crossed their runtime retirement threshold. The remaining guardrails are:

- Start, resume, continue, restart, rollback, and retry paths must not regain `_runPhase1/_runPhase2/_runPhase3` re-entry.
- Phase-class `continueFromCheckpoint()` behavior must not be reintroduced as supported runtime.
- New tests must assert facade delegation or canonical workflow-definition behavior rather than phase-class fallback.
- Future docs must describe phase classes only as retired historical context, not as active modules.

### workflow-phase1.js

The file-backed degraded phase-only definition entry remains retired. The remaining guardrails are:

- Stored `story-orchestrator-phase1` references may still appear as migration input, but they must normalize directly onto the canonical full workflow definition.
- Recovery and backup/restore logic must not regain a dependency on a standalone phase-only definition file.
- Regression coverage must continue to protect normalization behavior without recreating the old degraded entry contract.

## Recommended Staging

1. Keep `workflow-phase1.js` retired as a file-backed degraded entry and preserve only migration-input normalization.
2. Keep phase-class shells retired; reject any attempt to revive them as runtime fallback.
3. Collapse `WorkflowEngine` last, after it no longer fronts public command routing or compatibility state projection.

## Verification Checklist For A Later Implementation Change

A future retirement implementation change should verify all four evidence groups before deleting any surviving compatibility surface:

1. Runtime entrypoints  
   The target surface is no longer reached by start, resume, recover, retry, checkpoint continue, or status-query flows.

2. Recovery and fallback  
   The target surface is no longer needed for checkpoint fallback, restart, rollback, or compatibility recovery flows.

3. Compatibility references  
   Old aliases, old `definitionRef` values, and persisted recovery inputs are migrated or intentionally unsupported.

4. Regression coverage  
   Existing tests that protect the target surface are removed intentionally or replaced with canonical-path assertions.

## Current Outcome

The current retirement judgment is now:

- `WorkflowEngine`: retain as thin compatibility shell for now
- `Phase1_WorldBuilding`: retired
- `Phase2_OutlineDrafting`: retired
- `Phase3_Refinement`: retired
- `workflow-phase1.js`: retired as file-backed degraded entry; legacy refs survive only as normalized migration input

That means the next safe step is not another broad deletion sweep. The next safe step is to continue shrinking `WorkflowEngine` without reviving any phase-class runtime dependency.
