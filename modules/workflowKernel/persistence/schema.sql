-- ============================================================================
-- WorkflowKernel Independent SQLite Persistence Schema
-- ============================================================================
-- Purpose:
--   Provides dedicated tables for workflow execution state and event history,
--   isolated from StoryOrchestrator's legacy tables to prevent coupling and
--   migration conflicts.
--
-- Table naming convention:
--   All kernel tables are prefixed with `wk_` to avoid name collisions with
--   StoryOrchestrator tables (e.g., StoryOrchestrator already owns
--   `workflow_events`). This prefix is short, unambiguous, and greppable.
--
-- Optimistic locking:
--   The `version` column on `wk_workflows` is incremented on every UPDATE.
--   Writers must include `AND version = ?` in the WHERE clause; zero changes
--   signals an optimistic lock conflict.
--
-- Usage:
--   Apply with `db.exec(schemaSql)` using better-sqlite3. All statements are
--   idempotent (IF NOT EXISTS) and safe to run on every startup.
-- ============================================================================

-- Enable foreign-key enforcement for CASCADE behavior.
PRAGMA foreign_keys = ON;

-- ----------------------------------------------------------------------------
-- wk_workflows — primary workflow execution-state table
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS wk_workflows (
    workflow_id      TEXT PRIMARY KEY,
    definition_ref   TEXT NOT NULL,
    status           TEXT NOT NULL,
    context_json     TEXT NOT NULL DEFAULT '{}',
    execution_cursor TEXT,
    checkpoint_state_json TEXT,
    retry_context_json    TEXT,
    run_token        TEXT NOT NULL,
    version          INTEGER NOT NULL DEFAULT 1,
    created_at       TEXT NOT NULL,
    updated_at       TEXT NOT NULL
);

-- Index: fast lookup of active / non-terminal workflows for recovery scans.
CREATE INDEX IF NOT EXISTS idx_wk_workflows_status
    ON wk_workflows(status);

-- Index: fast lookup by update recency (recovery, monitoring, cleanup).
CREATE INDEX IF NOT EXISTS idx_wk_workflows_updated_at
    ON wk_workflows(updated_at);

-- ----------------------------------------------------------------------------
-- wk_workflow_events — append-only event history for each workflow
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS wk_workflow_events (
    event_id         TEXT PRIMARY KEY,
    workflow_id      TEXT NOT NULL,
    event_type       TEXT NOT NULL,
    payload_json     TEXT NOT NULL DEFAULT '{}',
    created_at       TEXT NOT NULL,
    FOREIGN KEY (workflow_id) REFERENCES wk_workflows(workflow_id)
        ON DELETE CASCADE
);

-- Index: fetch event stream for a single workflow in chronological order.
CREATE INDEX IF NOT EXISTS idx_wk_workflow_events_workflow_created
    ON wk_workflow_events(workflow_id, created_at);

-- Index: event-type filtering for diagnostics and audit queries.
CREATE INDEX IF NOT EXISTS idx_wk_workflow_events_type
    ON wk_workflow_events(event_type);

-- ----------------------------------------------------------------------------
-- Optimistic locking helper (optional, for documentation / copy-paste)
-- ----------------------------------------------------------------------------
-- Typical update pattern:
--
--   UPDATE wk_workflows
--   SET status = ?,
--       context_json = ?,
--       execution_cursor = ?,
--       run_token = ?,
--       version = version + 1,
--       updated_at = ?
--   WHERE workflow_id = ?
--     AND version = ?;
--
-- Check `result.changes === 0` to detect and throw an optimistic lock conflict.
-- ----------------------------------------------------------------------------
