# StoryOrchestrator Business-State Snapshot / Restore Contract

## Overview

The WorkflowKernel maintains **execution state** (cursor, step status, runToken).
StoryOrchestrator maintains **business state** (worldview, characters, outline, chapters).
This contract defines how the two are kept consistent across crashes and resumes.

## Actors

- **WorkflowKernel** — persists execution state to `wk_workflows` / `wk_workflow_events` (or via `StoryStateRepositoryAdapter` to the `stories` table).
- **StoryOrchestratorKernelAdapter** — bridges kernel events to StoryOrchestrator snapshots.
- **StoryStateRepository** — stores business-state snapshots in the `snapshots` table.

## Snapshot Creation

### Trigger Points

| Event | Granularity | Snapshot Type | Notes |
|-------|-------------|---------------|-------|
| `workflow.checkpoint_approved` | all | `approved` | Phase boundary — always snapshot |
| `workflow.checkpoint_auto_approved` | all | `approved` | Auto-approval path |
| `workflow.completed` | all | `approved` | Final state |
| `workflow.step_completed` | `phase_boundary` | `candidate` | Only if last step of phase |
| `workflow.step_completed` | `every_step` | `candidate` | Every step |
| `workflow.step_completed` | `checkpoint_only` | — | No snapshot |

### Configuration

```js
SNAPSHOT_GRANULARITY=checkpoint_only   // default: phase_boundary
```

- `checkpoint_only` — snapshots only at checkpoint approvals
- `phase_boundary` — snapshots at checkpoint approvals + last step of each phase
- `every_step` — snapshots at every step completion

### Payload Shape

Snapshots are stored with `snapshot_type` and a JSON payload shaped like StoryOrchestrator phase objects:

**phase1 payload:**
```json
{
  "worldview": { ... },
  "characters": [ ... ],
  "validation": { ... },
  "userConfirmed": false,
  "checkpointId": null,
  "status": "running"
}
```

**phase2 payload:**
```json
{
  "outline": { ... },
  "chapters": [ ... ],
  "currentChapter": 0,
  "userConfirmed": false,
  "checkpointId": null,
  "status": "running"
}
```

**phase3 payload:**
```json
{
  "polishedChapters": [ ... ],
  "finalValidation": null,
  "iterationCount": 0,
  "userConfirmed": false,
  "checkpointId": null,
  "status": "running"
}
```

### Side Effects

On snapshot creation, the adapter updates the `stories` table:
- `current_phase1_snapshot_id`
- `current_phase2_snapshot_id`
- `current_phase3_snapshot_id`

This allows `StateManager._assembleStoryFromSQLite()` to reconstruct the full story object.

## Restore on Execution

### `executeWorkflow()`

Before starting a new workflow, the adapter restores approved snapshots from all prior phases and injects them into `context.outputs` via the `restoredOutputs` parameter of `WorkflowKernel.execute()`.

### `executePhase()`

Before executing a single phase, the adapter restores approved snapshots from phases **before** the target phase. For example, when executing `phase2`, `phase1` snapshots are restored.

### `_buildRestoredOutputs()` Mapping

| Source Snapshot | Injected into `context.outputs` |
|-----------------|--------------------------------|
| `phase1.worldview` | `outputs.worldview` |
| `phase1.characters` | `outputs.characters` |
| `phase1.validation` | `outputs.phase1Validation` |
| `phase2.outline` | `outputs.outline` |
| `phase2.chapters` | `outputs.chaptersResult.chapters` |
| `phase2.currentChapter` | `outputs.chaptersResult.completedCount` |
| `phase3.polishedChapters` | `outputs.polishedChapters.chapters` |
| `phase3.iterationCount` | `outputs.polishedChapters.iterationCount` |

This ensures workflow steps can reference prior-phase outputs via `$ref: 'ctx.outputs.*'`.

## Restore on Resume

### `resume()`

After `kernel.resume()` completes, the adapter:
1. Reads the current kernel context from `activeWorkflows`
2. Determines the current phase from `executionCursor`
3. Creates a fresh `approved` snapshot from the context

This guarantees that after a checkpoint resume, the StoryOrchestrator view is consistent with the kernel's execution state.

## Consistency Guarantees

After crash recovery (`RecoveryManager.scanAndRecover()` + `resumeWorkflowInKernel()`):

1. **Execution cursor** is restored from `wk_workflows` / `stories.workflow_state`
2. **Business state** is already in the kernel `context.outputs` (persisted after each step)
3. **Snapshots** are created from the recovered context so `StateManager.getStory()` sees the latest state

### Cross-Check

A recovered workflow should satisfy:
- `kernel.context.outputs.worldview` matches `snapshot.payload_json.worldview`
- `kernel.executionCursor` points to the step after the last `completed` step
- `snapshot.snapshot_type` is `approved` if the last step was a checkpoint, otherwise `candidate`

## Failure Modes

| Scenario | Behavior |
|----------|----------|
| Snapshot creation fails (DB error) | Logged to stderr; execution continues |
| Snapshot restore fails (malformed JSON) | Logged to stderr; execution starts with empty outputs |
| No prior snapshot exists | `restoredOutputs` is empty; workflow generates fresh state |
| Granularity = `checkpoint_only`, crash mid-phase | Business state is in kernel context but NOT in snapshots table until checkpoint |

## Observability

Log lines to watch:

```
[StoryOrchestratorKernelAdapter] Business snapshot created: <snapId> for <storyId>/<phase> (<type>)
[StoryOrchestratorKernelAdapter] Snapshot creation failed: <error>
[StoryOrchestratorKernelAdapter] Snapshot restore failed: <error>
```

## Migration Notes

- Existing workflows without snapshots will continue to work; `restoredOutputs` will be empty.
- The `StoryStateRepositoryAdapter` path (stories table) already stores full context in `workflow_state`. Snapshots provide a normalized, queryable view.
- The `SQLiteWorkflowStateRepository` path (independent tables) relies on snapshots for StoryOrchestrator integration.
