# Workflow Resumption Safety Rules

## Overview

When VCP restarts after a crash, the `RecoveryManager` scans all active (non-terminal) workflows and decides whether each workflow can safely resume from its explicit recovery cursor, must roll back to a declared safe boundary, or should be marked as failed. These rules ensure that:

1. **Idempotent steps are not re-executed** after recovery.
2. **Non-idempotent steps with side effects** are rolled back to the last safe boundary.
3. **Checkpoints are always safe** to resume from.
4. **Run tokens prevent split-brain** resumption by multiple VCP instances.

---

## Step-Type Safety Classification

| Category | Step Types | Resume Behavior |
|----------|-----------|-----------------|
| **Safe to resume** | `checkpoint`, `guard`, `noop` | Resume from current cursor. The step is idempotent or read-only. |
| **Non-idempotent** | `agentCall` | Roll back to the **last safe boundary** (previous checkpoint, guard, or noop). If no safe boundary exists, mark as `failed`. |
| **Custom with explicit metadata** | any custom step declaring `recovery.resumeFromCursor`, `recovery.rollbackBoundaries`, or `isIdempotent` | Follows declared metadata instead of built-in defaults |
| **Unknown / unclassified** | Any type not listed above | Treated as **unsafe by default** and rolled back to a phase boundary unless metadata says otherwise |

> **Rationale:** `agentCall` may trigger external API calls, send messages, or mutate remote state. Re-running an `agentCall` after a crash could cause duplicate side effects. Guards and no-ops are pure computations; checkpoints are explicitly designed as safe synchronization points.

---

## Recovery Decision Tree

```
Scan all workflows with status ∈ {running, waiting_checkpoint, retrying, recovering}
│
├─► workflow has no execution cursor?
│   └─► ACTION: marked_idle
│       Logs: "Workflow {id} has no execution cursor. Marking idle."
│
├─► workflow is already active in kernel with different runToken?
│   └─► ACTION: skipped
│       Logs: "RunToken mismatch for workflow {id}. Persisted={x}, Active={y}. Skipping recovery."
│
├─► persisted `retryContext.__recovery.currentCursor` says `resume_step` or safe `resume_next`?
│   └─► ACTION: resume_from_cursor
│       Logs: "Workflow {id} safe to resume from cursor. stepId={s}, stepType={t}"
│
├─► current cursor is unsafe or non-idempotent?
│   ├─► a declared rollback boundary exists in `retryContext.__recovery.rollbackBoundaries`?
│   │   └─► ACTION: resume_from_safe_boundary
│   │       Logs: "Workflow {id} non-idempotent step detected. Rolling back to safe boundary."
│   │
│   └─► no safe boundary found?
│       └─► ACTION: marked_failed
│           Logs: "Workflow {id} cannot safely resume. No safe boundary found. Marking as failed."
│           Side effect: updates DB status → 'failed'
```

---

## Cursor Semantics and Safe Boundaries

### What the `executionCursor` Represents

The kernel now persists both:

- `executionCursor`: the runtime cursor currently being executed
- `retryContext.__recovery.currentCursor`: the explicit recovery cursor contract used by recovery decisions

This means a crash during a step can preserve the in-flight step identity without relying on best-effort inference.

| Scenario | In-Memory Cursor | Persisted Cursor at Crash | Recovery Start Index |
|----------|-----------------|---------------------------|---------------------|
| Crash **during** resumable step 2 | `[{phase:0}, {step:1}]` | `executionCursor=[{phase:0},{step:1}]`, `recoveryCursor.resumeAction='resume_step'` | Step index `1` (step 2) |
| Crash **during** unsafe step 2 | `[{phase:0}, {step:1}]` | `executionCursor=[{phase:0},{step:1}]`, rollback boundary remains prior safe step or phase boundary | Recovery resumes from declared safe boundary |
| Crash **after** step 2 completes | `[{phase:0}, {step:2}]` (step 3 started) | `executionCursor=[{phase:0},{step:1}]`, `recoveryCursor.resumeAction='resume_next'` | Step index `2` (step 3) |

> **Boundary guarantee:** Recovery no longer depends only on "last completed step". The explicit recovery cursor states whether the kernel should `resume_step`, `resume_next`, or first roll back to a declared safe boundary.

### Safe Boundary Lookup

When a non-idempotent or unsafe step is detected, the preferred path is to use `retryContext.__recovery.rollbackBoundaries`. This list is populated by the kernel at phase boundaries, checkpoint boundaries, and composite/custom restart-safe boundaries. For legacy records that do not yet have explicit recovery metadata, `RecoveryManager` still falls back to walking backward through `context.steps`.

If the safe boundary is step index `N`, `_runWorkflow` will resume from step `N + 1`, effectively re-executing all steps after the safe boundary. This is correct because those steps may have been partially executed or not persisted.

---

## RunToken Mismatch Detection

Each workflow execution is assigned a `runToken` (generated on `create` and refreshed on explicit resume). If a workflow is already present in `kernel.activeWorkflows` with a different `runToken` than what is persisted, recovery is skipped.

**Why:** This prevents two VCP instances from simultaneously recovering the same workflow (split-brain). The active kernel is considered the authoritative owner.

---

## StoryOrchestrator Business-State Consistency

When using `StoryStateRepositoryAdapter`, the adapter maps StoryOrchestrator fields to kernel fields:

| StoryOrchestrator Field | Kernel Field | Used By RecoveryManager |
|------------------------|--------------|------------------------|
| `story_id` | `workflowId` / `workflow_id` | Workflow identity |
| `workflow_state` (JSON) | `context` / `context_json` | Step completion history, inputs, outputs |
| `current_step` (JSON) | `executionCursor` / `execution_cursor` | Resume position |
| `run_token` | `runToken` / `run_token` | Split-brain detection |
| `status` | `status` | Active vs. terminal classification |

**Consistency guarantee:** Business state stored in `workflow_state.inputs` and `workflow_state.outputs` is preserved across crash recovery because the adapter reads the raw JSON and returns it as `context`. Recovery decisions are based solely on `context.steps[*].type`, which the kernel populates during normal execution.

---

## Checklists for Operators

### After an unexpected VCP restart

1. Check logs for `[RecoveryManager] Recovery complete: X recovered, Y failed`.
2. For any `marked_failed` workflows, investigate whether a safe boundary was missing or whether the step type classification needs adjustment.
3. Verify that `resume_from_cursor` workflows completed successfully by checking for `workflow.completed` events.
4. If a workflow was `skipped` due to `runToken_mismatch`, confirm that another VCP instance is actively managing it.

### Before adding a new step type

1. Decide whether the step is **idempotent** (safe to re-run) or **non-idempotent** (has side effects).
2. If the step is safe to resume in place, declare `recovery.resumeFromCursor: true` or equivalent metadata on the step definition / registry.
3. If the step is unsafe to resume, declare `recovery.rollbackBoundaries` or let it fall back to `phase_boundary`.
4. Keep `context.steps[stepId].type` and `context.steps[stepId].recovery` populated so legacy fallback and diagnostics stay usable.

---

## File References

- `modules/workflowKernel/core/RecoveryContract.js` — Shared recovery cursor and metadata normalization
- `modules/workflowKernel/core/RecoveryManager.js` — Recovery classification and fallback behavior
- `modules/workflowKernel/core/WorkflowKernel.js` — `_runWorkflow` resume logic and unified recovery dispatch
- `modules/workflowKernel/persistence/SQLiteWorkflowStateRepository.js` — Cursor and context persistence
- `modules/workflowKernel/persistence/StoryStateRepositoryAdapter.js` — StoryOrchestrator bridge
- `tests/workflowKernel/integration/crash-recovery.test.js` — Simulation tests
