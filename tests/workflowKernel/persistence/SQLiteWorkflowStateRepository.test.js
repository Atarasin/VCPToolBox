const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const Database = require('better-sqlite3');
const { SQLiteWorkflowStateRepository } = require('../../../modules/workflowKernel/persistence/SQLiteWorkflowStateRepository');

describe('SQLiteWorkflowStateRepository', () => {
  let db;
  let repo;

  beforeEach(() => {
    db = new Database(':memory:');
    repo = new SQLiteWorkflowStateRepository(db);
    repo.initialize();
  });

  afterEach(() => {
    db.close();
  });

  it('creates a workflow with default fields', async () => {
    const record = await repo.create('wf-1', 'def-1', { input: 'test' });

    assert.strictEqual(record.workflowId, 'wf-1');
    assert.strictEqual(record.definitionRef, 'def-1');
    assert.strictEqual(record.status, 'idle');
    assert.deepStrictEqual(record.context, { input: 'test' });
    assert.strictEqual(record.version, 1);
    assert.ok(record.runToken, 'runToken should be generated');
    assert.ok(record.createdAt, 'createdAt should be set');
    assert.ok(record.updatedAt, 'updatedAt should be set');
  });

  it('get returns null for non-existent workflow', async () => {
    const record = await repo.get('nonexistent');
    assert.strictEqual(record, null);
  });

  it('get deserializes JSON fields', async () => {
    await repo.create('wf-2', 'def-2', { seed: 42 });
    await repo.update('wf-2', {
      executionCursor: [{ phase: 0 }, { step: 1 }],
      checkpointState: { checkpointId: 'cp-1' },
      retryContext: { attempt: 3 }
    });

    const record = await repo.get('wf-2');
    assert.deepStrictEqual(record.executionCursor, [{ phase: 0 }, { step: 1 }]);
    assert.deepStrictEqual(record.checkpointState, { checkpointId: 'cp-1' });
    assert.deepStrictEqual(record.retryContext, { attempt: 3 });
  });

  it('update modifies fields and increments version', async () => {
    await repo.create('wf-3', 'def-3', {});

    const updated = await repo.update('wf-3', {
      status: 'running',
      context: { outputs: { result: 42 } }
    });

    assert.strictEqual(updated.status, 'running');
    assert.deepStrictEqual(updated.context, { outputs: { result: 42 } });
    assert.strictEqual(updated.version, 2);
  });

  it('update throws on optimistic lock conflict', async () => {
    await repo.create('wf-4', 'def-4', {});

    // Tamper version in DB to 99, then intercept the version read so
    // update() thinks it is still 1, causing the UPDATE to match 0 rows.
    db.prepare("UPDATE wk_workflows SET version = 99 WHERE workflow_id = 'wf-4'").run();

    const origPrepare = db.prepare.bind(db);
    db.prepare = function(sql) {
      const stmt = origPrepare(sql);
      if (sql.includes('SELECT version')) {
        return {
          get: () => ({ version: 1 }),
          run: (...args) => stmt.run(...args),
          all: (...args) => stmt.all(...args)
        };
      }
      return stmt;
    };

    try {
      await assert.rejects(
        repo.update('wf-4', { status: 'running' }),
        /Optimistic lock conflict for workflow wf-4\. Expected version 1\./
      );
    } finally {
      db.prepare = origPrepare;
    }
  });

  it('update throws for non-existent workflow', async () => {
    await assert.rejects(
      repo.update('missing', { status: 'running' }),
      /Workflow missing not found/
    );
  });

  it('update with empty patch returns current record unchanged', async () => {
    const created = await repo.create('wf-5', 'def-5', { key: 'val' });
    const updated = await repo.update('wf-5', {});

    assert.strictEqual(updated.status, created.status);
    assert.strictEqual(updated.version, created.version);
  });

  it('appendHistory inserts event record', async () => {
    await repo.create('wf-6', 'def-6', {});

    await repo.appendHistory('wf-6', {
      type: 'step_completed',
      stepId: 's1',
      timestamp: '2024-01-01T00:00:00Z'
    });

    const rows = db.prepare("SELECT * FROM wk_workflow_events WHERE workflow_id = 'wf-6'").all();
    assert.strictEqual(rows.length, 1);
    assert.strictEqual(rows[0].event_type, 'step_completed');
    const payload = JSON.parse(rows[0].payload_json);
    assert.strictEqual(payload.stepId, 's1');
  });

  it('appendHistory generates event id when not provided', async () => {
    await repo.create('wf-7', 'def-7', {});

    await repo.appendHistory('wf-7', { type: 'workflow.started' });

    const rows = db.prepare("SELECT * FROM wk_workflow_events WHERE workflow_id = 'wf-7'").all();
    assert.ok(rows[0].event_id.startsWith('evt-'), 'event_id should be generated');
  });

  it('listActive returns only non-terminal workflows', async () => {
    await repo.create('wf-run', 'def', {});
    await repo.create('wf-wait', 'def', {});
    await repo.create('wf-retry', 'def', {});
    await repo.create('wf-recover', 'def', {});
    await repo.create('wf-done', 'def', {});
    await repo.create('wf-fail', 'def', {});

    await repo.update('wf-run', { status: 'running' });
    await repo.update('wf-wait', { status: 'waiting_checkpoint' });
    await repo.update('wf-retry', { status: 'retrying' });
    await repo.update('wf-recover', { status: 'recovering' });
    await repo.update('wf-done', { status: 'completed' });
    await repo.update('wf-fail', { status: 'failed' });

    const active = await repo.listActive();
    const ids = active.map(r => r.workflowId).sort();

    assert.deepStrictEqual(ids, ['wf-recover', 'wf-retry', 'wf-run', 'wf-wait']);
  });

  it('listActive orders by updated_at DESC', async () => {
    await repo.create('wf-a', 'def', {});
    await repo.create('wf-b', 'def', {});

    await repo.update('wf-a', { status: 'running' });
    // Ensure wf-b is updated later
    await new Promise(r => setTimeout(r, 10));
    await repo.update('wf-b', { status: 'running' });

    const active = await repo.listActive();
    assert.strictEqual(active[0].workflowId, 'wf-b');
    assert.strictEqual(active[1].workflowId, 'wf-a');
  });

  it('listActive returns empty array when no active workflows', async () => {
    await repo.create('wf-done', 'def', {});
    await repo.update('wf-done', { status: 'completed' });

    const active = await repo.listActive();
    assert.deepStrictEqual(active, []);
  });

  it('provides RecoveryManager compatibility aliases', async () => {
    await repo.create('wf-compat', 'def', {});
    await repo.update('wf-compat', {
      context: { steps: { s0: { type: 'guard' } } },
      executionCursor: [{ phase: 0 }, { step: 0 }],
      retryContext: { count: 1 }
    });

    const record = await repo.get('wf-compat');

    // RecoveryManager reads these aliases
    assert.strictEqual(record.workflow_state, record.context_json);
    assert.strictEqual(record.current_step, record.execution_cursor);
    assert.deepStrictEqual(record.retryContext, { count: 1 });
  });

  it('run_token can be updated', async () => {
    await repo.create('wf-token', 'def', {});
    const newToken = 'rt-custom-123';

    const updated = await repo.update('wf-token', { runToken: newToken });
    assert.strictEqual(updated.runToken, newToken);

    const fetched = await repo.get('wf-token');
    assert.strictEqual(fetched.runToken, newToken);
  });

  it('hydrates persisted recovery cursor from retry context', async () => {
    await repo.create('wf-recovery-cursor', 'def', {});
    await repo.update('wf-recovery-cursor', {
      retryContext: {
        __recovery: {
          currentCursor: {
            phaseId: 'p1',
            phaseIndex: 0,
            stepId: 's1',
            stepIndex: 0,
            boundaryType: 'step_boundary',
            runToken: 'rt-1',
            resumeAction: 'resume_step',
            executionCursor: [{ phase: 0 }, { step: 0 }]
          },
          rollbackBoundaries: []
        }
      }
    });

    const fetched = await repo.get('wf-recovery-cursor');
    assert.strictEqual(fetched.recoveryCursor.stepId, 's1');
    assert.strictEqual(fetched.recoveryState.currentCursor.boundaryType, 'step_boundary');
  });

  it('events are cascaded on workflow delete', async () => {
    await repo.create('wf-cascade', 'def', {});
    await repo.appendHistory('wf-cascade', { type: 'test' });

    db.prepare("DELETE FROM wk_workflows WHERE workflow_id = 'wf-cascade'").run();

    const events = db.prepare("SELECT * FROM wk_workflow_events WHERE workflow_id = 'wf-cascade'").all();
    assert.strictEqual(events.length, 0, 'events should be cascade-deleted');
  });

  it('safeParse handles malformed JSON gracefully', async () => {
    db.prepare("INSERT INTO wk_workflows (workflow_id, definition_ref, status, context_json, run_token, version, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .run('wf-badjson', 'def', 'running', '{invalid', 'rt-1', 1, '2024-01-01T00:00:00Z', '2024-01-01T00:00:00Z');

    const record = await repo.get('wf-badjson');
    assert.deepStrictEqual(record.context, {}, 'malformed context_json should return default');
  });

  it('schema initialization is idempotent', async () => {
    // initialize() was already called in beforeEach; calling again should not throw
    assert.doesNotThrow(() => repo.initialize());
    assert.doesNotThrow(() => repo.initialize());
  });
});
