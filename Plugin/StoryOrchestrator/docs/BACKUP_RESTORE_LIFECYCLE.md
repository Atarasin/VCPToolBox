# StoryOrchestrator Business-State Backup/Restore Lifecycle

## Overview

When `USE_WORKFLOW_KERNEL=true`, StoryOrchestrator delegates phase execution to the `WorkflowKernel`. The kernel manages its own execution state (cursor, step results, checkpoints), but StoryOrchestrator's *business state* — worldview, characters, outline, chapters — must survive crashes and be recoverable.

The `StoryOrchestratorKernelAdapter` bridges this gap by registering three lifecycle hooks with the kernel:

- `beforeStep`
- `afterCheckpoint`
- `onRecovery`

These hooks synchronize kernel execution state with StoryOrchestrator's persistent snapshot tables.

## Hook Registration

During `StoryOrchestratorKernelAdapter.initialize()`, the adapter calls `kernel.registerLifecycleHook(name, handler)` for each of the three hooks. The kernel stores these in `kernel.lifecycleHooks` and invokes them at the appropriate execution points.

## beforeStep Hook

**When invoked:** At the start of `_executeStep()`, before the step handler runs.

**Context provided:**
```js
{ workflowId, step, record, kernel }
```

**Behavior:**
- Determines the current phase from `record.executionCursor`.
- Creates a business-state snapshot with type depending on step type and `snapshotGranularity`:
  - `checkpoint` steps → `pre_checkpoint` snapshot
  - `every_step` granularity → `before_step` snapshot for all steps
  - `phase_boundary` granularity → `phase_start` snapshot before the first `agentCall` of each phase

**Snapshot payload:** Extracted from `record.context.outputs` via `_extractBusinessPayload()`, producing phase-shaped objects (worldview, characters, outline, chapters, etc.).

## afterCheckpoint Hook

**When invoked:** Inside `kernel.resume()`, after the checkpoint is resolved and state transitions to `RUNNING`, but before `_runWorkflow()` continues.

**Context provided:**
```js
{ workflowId, checkpointId, action, record, kernel }
```

**Behavior:**
- Only acts on `action === 'approve'` or `action === 'skip'`.
- Creates an `approved` snapshot of business state.
- Updates the story record with `current_<phase>_snapshot_id`.
- Persists snapshot metadata to the kernel events table via `stateRepository.appendHistory()`:
  ```js
  {
    type: 'workflow.snapshot_created',
    payload: { snapshotId, workflowId, phaseName, checkpointId, snapshotType, stepId }
  }
  ```

## onRecovery Hook

**When invoked:** Inside `kernel.recover()`, before re-hydrating the workflow and resuming execution.

**Context provided:**
```js
{ workflowId, record, kernel }
```

**Behavior:**
1. Determines target phase from `record.executionCursor` (falls back to `story.current_phase`).
2. Calls `_buildRestoredOutputs(storyId, targetPhase)` to load approved snapshots for all *prior* phases.
3. Merges restored outputs into `record.context.outputs` so that subsequent steps can reference them via `$ref`.

**Restored output keys:**
- `worldview`, `characters`, `phase1Validation` (from phase1)
- `outline`, `chaptersResult` (from phase2)
- `polishedChapters` (from phase3)

## Snapshot Granularity Configuration

Controlled via `config.SNAPSHOT_GRANULARITY`:

| Value | Behavior |
|-------|----------|
| `checkpoint_only` | Snapshots only at checkpoint boundaries |
| `phase_boundary` | Snapshots at checkpoint + before first agentCall per phase |
| `every_step` | Snapshots before every step |

Default is `phase_boundary`.

## Crash Recovery Flow

1. **Pre-crash:** Workflow executes. `beforeStep` and `afterCheckpoint` hooks create snapshots.
2. **Crash:** Process exits. `activeWorkflows` in memory is lost, but `wk_workflows` / `stories` tables retain the record.
3. **Startup:** `RecoveryManager` scans active workflows and returns recovery plans.
4. **Recovery:** `kernel.recover(storyId)` is called.
5. **onRecovery hook:** Loads approved snapshots for prior phases and injects them into `record.context.outputs`.
6. **Resume:** `_runWorkflow()` continues from the execution cursor with business state restored.

## Event Metadata Schema

Snapshot events stored in `wk_workflow_events` / `workflow_events`:

```js
{
  type: 'workflow.snapshot_created',
  timestamp: '2026-05-01T12:00:00.000Z',
  payload: {
    snapshotId: 'snap-abc123',
    workflowId: 'story-xyz',
    phaseName: 'phase1',
    checkpointId: 'cp-123',
    snapshotType: 'approved',
    stepId: [{ phase: 0 }, { step: 5 }]
  }
}
```

## Verification

Run the backup/restore test suite:

```bash
node --test Plugin/StoryOrchestrator/tests/KernelAdapterBackupRestore.test.js
```

Run with the workflow kernel enabled:

```bash
TEST_USE_WORKFLOW_KERNEL=true node --test Plugin/StoryOrchestrator/tests/KernelAdapterBackupRestore.test.js
```

## Zero-Regression Guarantee

When `USE_WORKFLOW_KERNEL=false`:
- `StoryOrchestratorKernelAdapter` is not initialized.
- No lifecycle hooks are registered.
- The original phase-class path runs unchanged.
- Snapshot tables continue to be managed by `WorkflowEngine` / `StateManager` as before.
