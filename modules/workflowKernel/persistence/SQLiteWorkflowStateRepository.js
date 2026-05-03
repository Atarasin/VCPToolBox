/**
 * SQLiteWorkflowStateRepository — native SQLite adapter for WorkflowStateRepository.
 *
 * Uses independent `wk_workflows` and `wk_workflow_events` tables with optimistic
 * locking (version column) and crash recovery fields (run_token, execution_cursor).
 */

const fs = require('fs');
const path = require('path');
const { WorkflowStateRepository } = require('./WorkflowStateRepository');

class SQLiteWorkflowStateRepository extends WorkflowStateRepository {
  /**
   * @param {Database} db — better-sqlite3 database instance
   */
  constructor(db) {
    super();
    this.db = db;
  }

  /**
   * Apply the independent workflow-kernel schema (idempotent).
   */
  initialize() {
    const schemaPath = path.join(__dirname, 'schema.sql');
    const schemaSql = fs.readFileSync(schemaPath, 'utf-8');
    this.db.exec(schemaSql);
  }

  /**
   * Create a new workflow record.
   * @param {string} workflowId
   * @param {string} definitionRef
   * @param {Object} initialContext
   * @returns {Promise<Object>} WorkflowRecord
   */
  async create(workflowId, definitionRef, initialContext) {
    const now = new Date().toISOString();
    const runToken = `rt-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;

    const stmt = this.db.prepare(`
      INSERT INTO wk_workflows (
        workflow_id, definition_ref, status, context_json,
        run_token, version, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
      workflowId,
      definitionRef,
      'idle',
      JSON.stringify(initialContext || {}),
      runToken,
      1,
      now,
      now
    );

    return this.get(workflowId);
  }

  /**
   * Get a workflow record by id.
   * @param {string} workflowId
   * @returns {Promise<Object|null>} WorkflowRecord
   */
  async get(workflowId) {
    const stmt = this.db.prepare(`SELECT * FROM wk_workflows WHERE workflow_id = ?`);
    const row = stmt.get(workflowId);
    if (!row) return null;
    return this._hydrateRow(row);
  }

  /**
   * Partially update a workflow record using optimistic locking.
   * @param {string} workflowId
   * @param {Object} patch
   * @returns {Promise<Object>} Updated WorkflowRecord
   */
  async update(workflowId, patch) {
    const current = this.db.prepare(`SELECT version FROM wk_workflows WHERE workflow_id = ?`).get(workflowId);
    if (!current) {
      throw new Error(`Workflow ${workflowId} not found`);
    }

    const expectedVersion = current.version;
    const fields = [];
    const values = [];

    if (patch.status !== undefined) {
      fields.push('status = ?');
      values.push(patch.status);
    }
    if (patch.context !== undefined) {
      fields.push('context_json = ?');
      values.push(JSON.stringify(patch.context));
    }
    if (patch.executionCursor !== undefined) {
      fields.push('execution_cursor = ?');
      values.push(JSON.stringify(patch.executionCursor));
    }
    if (patch.checkpointState !== undefined) {
      fields.push('checkpoint_state_json = ?');
      values.push(JSON.stringify(patch.checkpointState));
    }
    if (patch.retryContext !== undefined) {
      fields.push('retry_context_json = ?');
      values.push(JSON.stringify(patch.retryContext));
    }
    if (patch.runToken !== undefined) {
      fields.push('run_token = ?');
      values.push(patch.runToken);
    }

    if (fields.length === 0) {
      return this.get(workflowId);
    }

    fields.push('version = version + 1');
    fields.push('updated_at = ?');
    values.push(new Date().toISOString());
    values.push(workflowId);
    values.push(expectedVersion);

    const stmt = this.db.prepare(`
      UPDATE wk_workflows
      SET ${fields.join(', ')}
      WHERE workflow_id = ?
        AND version = ?
    `);

    const result = stmt.run(...values);

    if (result.changes === 0) {
      throw new Error(
        `Optimistic lock conflict for workflow ${workflowId}. Expected version ${expectedVersion}.`
      );
    }

    return this.get(workflowId);
  }

  /**
   * Append an event to workflow history.
   * @param {string} workflowId
   * @param {Object} event
   * @returns {Promise<void>}
   */
  async appendHistory(workflowId, event) {
    const eventId = event.id || `evt-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    const stmt = this.db.prepare(`
      INSERT INTO wk_workflow_events (
        event_id, workflow_id, event_type, payload_json, created_at
      ) VALUES (?, ?, ?, ?, ?)
    `);

    stmt.run(
      eventId,
      workflowId,
      event.type || 'workflow_event',
      JSON.stringify(event),
      event.timestamp || new Date().toISOString()
    );
  }

  /**
   * List all active (non-terminal) workflows.
   * Active statuses: running, waiting_checkpoint, retrying, recovering
   * @returns {Promise<Object[]>} WorkflowRecord[]
   */
  async listActive() {
    const stmt = this.db.prepare(`
      SELECT * FROM wk_workflows
      WHERE status IN ('running', 'waiting_checkpoint', 'retrying', 'recovering')
      ORDER BY updated_at DESC
    `);
    const rows = stmt.all();
    return rows.map(row => this._hydrateRow(row));
  }

  /**
   * Convert a raw DB row into a normalized WorkflowRecord.
   * Provides both camelCase and snake_case properties, plus compatibility
   * aliases expected by RecoveryManager.
   */
  _hydrateRow(row) {
    const context = this._safeParse(row.context_json, {});
    const executionCursor = this._safeParse(row.execution_cursor, null);
    const checkpointState = this._safeParse(row.checkpoint_state_json, null);
    const retryContext = this._safeParse(row.retry_context_json, null);
    const recoveryState = retryContext?.__recovery || null;

    return {
      // Primary identifier
      workflowId: row.workflow_id,
      workflow_id: row.workflow_id,

      // Core fields
      definitionRef: row.definition_ref,
      status: row.status,

      // Parsed objects
      context,
      context_json: row.context_json,
      executionCursor,
      execution_cursor: row.execution_cursor,
      checkpointState,
      checkpoint_state_json: row.checkpoint_state_json,
      retryContext,
      retry_context_json: row.retry_context_json,
      recoveryState,
      recoveryCursor: recoveryState?.currentCursor || null,

      // Crash recovery
      runToken: row.run_token,
      run_token: row.run_token,

      // Locking
      version: row.version,

      // Timestamps
      createdAt: row.created_at,
      updatedAt: row.updated_at,

      // Compatibility aliases for RecoveryManager and other consumers
      workflow_state: row.context_json,
      current_step: row.execution_cursor,
      retryContext: retryContext
    };
  }

  _safeParse(json, defaultValue) {
    if (json === undefined || json === null) return defaultValue;
    try {
      return JSON.parse(json);
    } catch {
      return defaultValue;
    }
  }
}

module.exports = { SQLiteWorkflowStateRepository };
