# WorkflowKernel Independent SQLite Schema Design

**Scope:** M003-S03 — Independent SQLite Persistence Layer  
**Author:** executor (auto-mode)  
**Date:** 2026-05-01  
**Status:** Design complete, ready for implementation

---

## 1. Design Goals

1. **Isolation** — Kernel execution state lives in tables that are independent from StoryOrchestrator's `stories`, `phase_attempts`, `snapshots`, `checkpoints`, and `workflow_events`.
2. **Optimistic Locking** — Prevent lost updates when multiple writers (kernel loop, recovery manager, checkpoint resolver) touch the same workflow row.
3. **Crash Recovery** — Store enough state (`execution_cursor`, `run_token`, `context_json`) so `RecoveryManager` can resume from the last safe step boundary after a VCP restart.
4. **Event Auditability** — Append-only event history enables post-mortem debugging and replay analysis without mutating execution state.
5. **Idempotent Migration** — `CREATE TABLE IF NOT EXISTS` and `CREATE INDEX IF NOT EXISTS` make startup safe to run repeatedly.

---

## 2. Table Definitions

### 2.1 `wk_workflows` — Primary Execution State

| Column | Type | Constraints | Purpose |
|--------|------|-------------|---------|
| `workflow_id` | `TEXT` | `PRIMARY KEY` | Unique workflow identifier (caller-supplied or UUID). |
| `definition_ref` | `TEXT` | `NOT NULL` | Reference to the workflow definition (`definition.id`). |
| `status` | `TEXT` | `NOT NULL` | Current `ExecutionState`: `idle`, `running`, `waiting_checkpoint`, `retrying`, `recovering`, `completed`, `failed`. |
| `context_json` | `TEXT` | `NOT NULL DEFAULT '{}'` | Serialized `WorkflowRecord.context` — `inputs`, `outputs`, and per-step results. |
| `execution_cursor` | `TEXT` | nullable | JSON array encoding current position, e.g. `[{"phase":0},{"step":2}]`. |
| `checkpoint_state_json` | `TEXT` | nullable | Serialized checkpoint payload when workflow is in `waiting_checkpoint`. |
| `retry_context_json` | `TEXT` | nullable | Retry metadata (attempt count, last error, backoff state). |
| `run_token` | `TEXT` | `NOT NULL` | Crash-detection token. Regenerated on every fresh execution start. Mismatch between in-memory and persisted token indicates a crash residue. |
| `version` | `INTEGER` | `NOT NULL DEFAULT 1` | Optimistic lock counter. Incremented on every successful UPDATE. |
| `created_at` | `TEXT` | `NOT NULL` | ISO-8601 timestamp. |
| `updated_at` | `TEXT` | `NOT NULL` | ISO-8601 timestamp, updated on every write. |

### 2.2 `wk_workflow_events` — Append-Only Event History

| Column | Type | Constraints | Purpose |
|--------|------|-------------|---------|
| `event_id` | `TEXT` | `PRIMARY KEY` | Unique event identifier (UUIDv4 or ULID). |
| `workflow_id` | `TEXT` | `NOT NULL` | FK → `wk_workflows(workflow_id)`. |
| `event_type` | `TEXT` | `NOT NULL` | Kernel event type: `workflow.started`, `workflow.step_started`, `workflow.step_completed`, `workflow.checkpoint_pending`, `workflow.checkpoint_approved`, `workflow.failed`, `workflow.completed`, etc. |
| `payload_json` | `TEXT` | `NOT NULL DEFAULT '{}'` | Event-specific payload (step ID, output key, checkpoint ID, error message, etc.). |
| `created_at` | `TEXT` | `NOT NULL` | ISO-8601 timestamp. |

**Foreign key:** `workflow_id` REFERENCES `wk_workflows(workflow_id) ON DELETE CASCADE`.

---

## 3. Indexes

| Index Name | Table | Columns | Rationale |
|------------|-------|---------|-----------|
| `idx_wk_workflows_status` | `wk_workflows` | `status` | `RecoveryManager.startupRecovery()` scans all non-terminal workflows. This turns the scan into an index seek. |
| `idx_wk_workflows_updated_at` | `wk_workflows` | `updated_at` | Supports "stale workflow" cleanup, monitoring dashboards, and ordering in admin queries. |
| `idx_wk_workflow_events_workflow_created` | `wk_workflow_events` | `workflow_id`, `created_at` | Reconstructs the event timeline for a single workflow in chronological order. |
| `idx_wk_workflow_events_type` | `wk_workflow_events` | `event_type` | Filtering for diagnostics (e.g., "show me all checkpoint events in the last 24h"). |

---

## 4. Optimistic Locking Strategy

### 4.1 Why Optimistic Locking?

Workflow state can be updated by:
- The kernel's main execution loop (`_runWorkflow` → `_executeStep`)
- `RecoveryManager` during startup resumption
- `CheckpointManager` when a human resolves a checkpoint
- `HotReloadManager` if a definition change forces a state mutation

Optimistic locking is chosen because:
- Conflicts are rare (a workflow is normally driven by a single control flow).
- SQLite in WAL mode already provides high read concurrency.
- Avoids the complexity of row-level locking or a separate mutex table.

### 4.2 Protocol

**Read:**
```sql
SELECT workflow_id, version, status, context_json, execution_cursor, run_token
FROM wk_workflows
WHERE workflow_id = ?;
```

**Write (UPDATE):**
```sql
UPDATE wk_workflows
SET status           = ?,
    context_json     = ?,
    execution_cursor = ?,
    run_token        = ?,
    version          = version + 1,
    updated_at       = ?
WHERE workflow_id = ?
  AND version = ?;
```

**Conflict detection:**
```javascript
const result = stmt.run(...values);
if (result.changes === 0) {
  throw new Error(
    `Optimistic lock conflict for workflow ${workflowId}. ` +
    `Expected version ${expectedVersion}.`
  );
}
```

**Retry policy:** Callers may retry the read-modify-write cycle once, then escalate to a logged error. The kernel's `RetryPolicy` does not apply here because lock conflicts are concurrency issues, not transient failures.

---

## 5. Naming Conflict Resolution

### 5.1 Conflicting Table

StoryOrchestrator's `StoryOrchestratorDatabase.js` already creates a table named **`workflow_events`** with a story-centric schema:

```sql
CREATE TABLE IF NOT EXISTS workflow_events (
  event_id TEXT PRIMARY KEY,
  story_id TEXT NOT NULL,
  phase_name TEXT,
  event_type TEXT NOT NULL,
  event_detail_json TEXT,
  ...
);
```

This table has:
- Different columns (`story_id`, `phase_name`, `related_attempt_id`) vs. the kernel's needs (`workflow_id`, `payload_json`).
- Different semantics (story business events vs. kernel execution events).

### 5.2 Resolution: `wk_` Prefix

Both kernel tables are prefixed with **`wk_`** (short for "workflow kernel"):
- `wk_workflows`
- `wk_workflow_events`

**Benefits:**
- Eliminates the naming collision without renaming StoryOrchestrator tables (which would be a breaking change).
- Keeps tables in the **same SQLite database file**, satisfying the M003 architectural decision to avoid a second database dependency.
- Makes kernel tables instantly greppable (`wk_*`).
- Future kernel tables (e.g., `wk_workflow_definitions`, `wk_step_templates`) can follow the same convention.

---

## 6. Migration Strategy

### 6.1 Idempotent Startup

The schema SQL file (`schema.sql`) uses `IF NOT EXISTS` for all `CREATE TABLE` and `CREATE INDEX` statements. It is safe to execute on every `WorkflowStateRepository` initialization.

```javascript
// In a future SQLiteWorkflowStateRepository constructor/init:
const schemaSql = fs.readFileSync(
  path.join(__dirname, 'schema.sql'),
  'utf-8'
);
db.exec(schemaSql);
```

### 6.2 No Data Migration Required

This is a **green-field schema**. Existing StoryOrchestrator data remains untouched. The `StoryStateRepositoryAdapter` continues to bridge to legacy tables until the new `SQLiteWorkflowStateRepository` is wired in.

### 6.3 Future Schema Evolution

If columns are added in future milestones:
1. Add `ALTER TABLE ... ADD COLUMN ...` statements below the `CREATE TABLE` blocks.
2. Wrap them in `IF NOT EXISTS`-style guards (SQLite does not support `IF NOT EXISTS` on `ALTER TABLE`, so use a pragma check or application-level version tracking).

---

## 7. Mapping to WorkflowStateRepository Interface

The schema directly supports the `WorkflowStateRepository` CRUD operations:

| Interface Method | SQL Operation | Notes |
|------------------|---------------|-------|
| `create(workflowId, definitionRef, initialContext)` | `INSERT INTO wk_workflows` | Sets `version = 1`, generates `run_token`. |
| `get(workflowId)` | `SELECT * FROM wk_workflows WHERE workflow_id = ?` | Deserializes JSON columns before returning. |
| `update(workflowId, patch)` | `UPDATE wk_workflows ... WHERE workflow_id = ? AND version = ?` | Deep-merges `patch.context` into existing `context_json`. |
| `appendHistory(workflowId, event)` | `INSERT INTO wk_workflow_events` | Converts event object to `payload_json`. |
| `listActive()` | `SELECT * FROM wk_workflows WHERE status IN (...)` | Scans `idx_wk_workflows_status`. |

---

## 8. Consistency with M003-CONTEXT.md Constraints

| Constraint | Compliance |
|------------|------------|
| **SQLite only** | ✅ Uses `better-sqlite3` compatible DDL (no vendor-specific extensions). |
| **Independent tables** | ✅ `wk_workflows` and `wk_workflow_events` do not reference StoryOrchestrator tables. |
| **Optimistic locking** | ✅ `version` column + `UPDATE ... WHERE version = ?` pattern. |
| **Crash recovery** | ✅ `execution_cursor`, `run_token`, and `status` provide sufficient state for `RecoveryManager`. |
| **Event history** | ✅ Append-only `wk_workflow_events` with FK cascade for cleanup. |
| **No naming conflicts** | ✅ `wk_` prefix avoids collision with existing `workflow_events`. |

---

## 9. Open Questions / Future Work

1. **Max concurrent overflow** — The `maxConcurrentWorkflows: 100` limit is currently enforced in-memory inside `WorkflowKernel`. A future slice could add a `concurrent_count` view or queue table if we need durable queuing.
2. **Definition caching** — `definition_ref` is a string reference. If definitions become large, consider a separate `wk_workflow_definitions` lookup table to avoid duplicating JSON in every workflow row.
3. **Event retention** — No TTL or archiving policy is defined yet. For long-running production instances, a background job may need to truncate events older than N days.
