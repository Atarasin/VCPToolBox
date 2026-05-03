const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const Database = require('better-sqlite3');
const { WorkflowKernel } = require('../../../modules/workflowKernel/core/WorkflowKernel');
const { RecoveryManager } = require('../../../modules/workflowKernel/core/RecoveryManager');
const { EXECUTION_STATES } = require('../../../modules/workflowKernel/core/StateMachine');
const { agentCallStep } = require('../../../modules/workflowKernel/steps/AgentCallStep');
const { StoryStateRepositoryAdapter } = require('../../../modules/workflowKernel/persistence/StoryStateRepositoryAdapter');
const { SQLiteWorkflowStateRepository } = require('../../../modules/workflowKernel/persistence/SQLiteWorkflowStateRepository');
const { WorkflowValidator } = require('../../../modules/workflowKernel/validators/WorkflowValidator');
const { StepRegistry } = require('../../../modules/workflowKernel/core/StepRegistry');
const { WorkflowDefinitionSchema } = require('../../../modules/workflowKernel/types/WorkflowDefinition');

function makeMockStoryRepo() {
  const stories = new Map();
  return {
    createStory: (id, data) => { stories.set(id, { story_id: id, ...data, version: 1, status: 'running' }); return { story_id: id }; },
    getStory: (id) => stories.get(id) || null,
    getStoryWithFields: (id) => stories.get(id) || null,
    updateStory: (id, updates, version) => { const s = stories.get(id); Object.assign(s, updates, { version: version + 1 }); return s; },
    appendEvent: () => {},
    listStories: () => Array.from(stories.values()),
    _stories: stories
  };
}

describe('Persistence Integration', () => {

  it('persists workflow state through adapter', async () => {
    const storyRepo = makeMockStoryRepo();
    const stateRepo = new StoryStateRepositoryAdapter(storyRepo);
    const kernel = new WorkflowKernel({
      agentDispatcher: {
        delegate: async (id, prompt) => ({ content: 'ok', markers: [], raw: {} })
      },
      stateRepository: stateRepo
    });

    kernel.registerStepType('agentCall', agentCallStep);

    const definition = {
      id: 'persist-test',
      phases: [{
        id: 'p1',
        steps: [{ id: 's1', type: 'agentCall', agent: 'test', input: {}, outputKey: 'out1' }]
      }]
    };

    await kernel.execute('wf-persist', definition, { seed: 42 });

    const persisted = storyRepo._stories.get('wf-persist');
    assert.ok(persisted);
    assert.ok(persisted.workflow_state);
    const state = JSON.parse(persisted.workflow_state);
    assert.deepStrictEqual(state.inputs, { seed: 42 });
    assert.ok(state.steps.s1);
  });

  it('validates workflow definitions before execution', () => {
    const validator = new WorkflowValidator();
    const badDef = { id: 'bad', phases: [{ id: 'p1', steps: [{ id: '1-invalid', type: '' }] }] };
    const result = validator.validate(badDef);
    assert.strictEqual(result.valid, false);
    assert.ok(result.errors.length > 0);
  });

  it('passes valid workflow definitions', () => {
    const validator = new WorkflowValidator();
    const goodDef = {
      id: 'good',
      phases: [{
        id: 'p1',
        steps: [{ id: 's1', type: 'agentCall', input: { $ref: 'ctx.inputs.x' } }]
      }]
    };
    const result = validator.validate(goodDef);
    assert.strictEqual(result.valid, true);
    assert.deepStrictEqual(result.errors, []);
  });

  it('rejects unregistered step types', () => {
    const registry = new StepRegistry();
    registry.register('agentCall', () => {});
    registry.register('checkpoint', () => {});
    const validator = new WorkflowValidator(registry);
    const invalidType = {
      id: 'test',
      phases: [{ id: 'p1', steps: [{ id: 's1', type: 'unknown' }] }]
    };
    const result = validator.validate(invalidType);
    assert.strictEqual(result.valid, false);
    assert.ok(result.errors.some(e => e.includes('not registered')));
  });

  it('rejects invalid $ref paths', () => {
    const validator = new WorkflowValidator();
    const invalidRef = {
      id: 'test',
      phases: [{ id: 'p1', steps: [{ id: 's1', type: 'agentCall', input: { prompt: { $ref: 'invalid.path' } } }] }]
    };
    const result = validator.validate(invalidRef);
    assert.strictEqual(result.valid, false);
    assert.ok(result.errors.some(e => e.includes('must start with')));
  });

  it('validates workflow definition schema', () => {
    const validDef = {
      id: 'test-workflow',
      version: '1.0',
      phases: [{
        id: 'phase1',
        name: 'Phase 1',
        steps: [
          { id: 'step1', type: 'agentCall', outputKey: 'result' },
          { id: 'step2', type: 'checkpoint' }
        ]
      }]
    };
    assert.strictEqual(WorkflowDefinitionSchema.validate(validDef), true);
  });

  it('rejects schema violations', () => {
    assert.throws(() => WorkflowDefinitionSchema.validate({ phases: [] }), (err) =>
      err.validationErrors?.some(e => e.includes('id'))
    );
    assert.throws(() => WorkflowDefinitionSchema.validate({ id: 'bad', phases: [] }), (err) =>
      err.validationErrors?.some(e => e.includes('at least one phase'))
    );
    assert.throws(() => WorkflowDefinitionSchema.validate({
      id: 'bad',
      phases: [{ id: 'p1', steps: [{ id: 's1', type: 'x' }, { id: 's1', type: 'y' }] }]
    }), (err) => err.validationErrors?.some(e => e.includes('Duplicate')));
  });
});

describe('SQLite Persistence Integration', () => {
  let db;
  let repo;
  let kernel;

  beforeEach(() => {
    db = new Database(':memory:');
    repo = new SQLiteWorkflowStateRepository(db);
    repo.initialize();
  });

  afterEach(() => {
    if (kernel && kernel.checkpointManager) {
      kernel.checkpointManager.destroy();
    }
    if (db) {
      db.close();
    }
    kernel = null;
    repo = null;
    db = null;
  });

  it('persists workflow state to wk_workflows on execute', async () => {
    kernel = new WorkflowKernel({
      agentDispatcher: {
        delegate: async (id, prompt) => ({ content: 'ok', markers: [], raw: {} })
      },
      stateRepository: repo
    });
    kernel.registerStepType('noop', async () => ({ status: 'completed', output: 'done' }));

    const definition = {
      id: 'sqlite-persist-test',
      phases: [{
        id: 'p1',
        steps: [{ id: 's1', type: 'noop', outputKey: 'out1' }]
      }]
    };

    const record = await kernel.execute('wf-sqlite-1', definition, { seed: 42 });
    assert.strictEqual(record.status, EXECUTION_STATES.COMPLETED);

    const persisted = await repo.get('wf-sqlite-1');
    assert.ok(persisted);
    assert.strictEqual(persisted.workflowId, 'wf-sqlite-1');
    assert.strictEqual(persisted.definitionRef, 'sqlite-persist-test');
    assert.strictEqual(persisted.status, 'completed');
    assert.deepStrictEqual(persisted.context.inputs, { seed: 42 });
    assert.ok(persisted.runToken);
  });

  it('appends event history via appendHistory during execution', async () => {
    kernel = new WorkflowKernel({
      agentDispatcher: {
        delegate: async (id, prompt) => ({ content: 'ok', markers: [], raw: {} })
      },
      stateRepository: repo
    });
    kernel.registerStepType('noop', async () => ({ status: 'completed', output: 'done' }));

    const definition = {
      id: 'sqlite-events-test',
      phases: [{
        id: 'p1',
        steps: [{ id: 's1', type: 'noop', outputKey: 'out1' }]
      }]
    };

    await kernel.execute('wf-sqlite-2', definition, { seed: 99 });

    const events = db.prepare("SELECT * FROM wk_workflow_events WHERE workflow_id = 'wf-sqlite-2' ORDER BY created_at").all();
    assert.ok(events.length >= 3, `Expected at least 3 events, got ${events.length}`);

    const types = events.map(e => e.event_type);
    assert.ok(types.includes('workflow.started'), 'should have workflow.started event');
    assert.ok(types.includes('workflow.step_started'), 'should have workflow.step_started event');
    assert.ok(types.includes('workflow.step_completed'), 'should have workflow.step_completed event');
    assert.ok(types.includes('workflow.completed'), 'should have workflow.completed event');
  });

  it('persists checkpoint events during resume', async () => {
    kernel = new WorkflowKernel({
      agentDispatcher: {
        delegate: async (id, prompt) => ({ content: 'ok', markers: [], raw: {} })
      },
      stateRepository: repo
    });
    kernel.registerStepType('checkpoint', async () => ({
      status: 'waiting_checkpoint',
      checkpoint: { checkpointId: 'cp-1', type: 'review', promptTemplate: 'Review' }
    }));
    kernel.registerStepType('noop', async () => ({ status: 'completed', output: 'after-checkpoint' }));

    const definition = {
      id: 'sqlite-cp-test',
      phases: [{
        id: 'p1',
        steps: [
          { id: 's1', type: 'checkpoint', outputKey: 'cpOut' },
          { id: 's2', type: 'noop', outputKey: 'finalOut' }
        ]
      }]
    };

    await kernel.execute('wf-sqlite-3', definition);
    const status = await kernel.getStatus('wf-sqlite-3');
    assert.strictEqual(status.state, EXECUTION_STATES.WAITING_CHECKPOINT);

    const eventsBefore = db.prepare("SELECT * FROM wk_workflow_events WHERE workflow_id = 'wf-sqlite-3' ORDER BY created_at").all();
    assert.ok(eventsBefore.some(e => e.event_type === 'workflow.checkpoint_pending'));

    await kernel.resume('wf-sqlite-3', {
      checkpointId: 'cp-1',
      action: 'approve',
      feedback: 'Looks good'
    });

    const eventsAfter = db.prepare("SELECT * FROM wk_workflow_events WHERE workflow_id = 'wf-sqlite-3' ORDER BY created_at").all();
    assert.ok(eventsAfter.some(e => e.event_type === 'workflow.checkpoint_approved'));
    assert.ok(eventsAfter.some(e => e.event_type === 'workflow.completed'));
  });

  it('RecoveryManager.scanAndRecover lists active workflows from SQLite repo', async () => {
    // Seed an active workflow directly in the DB
    await repo.create('wf-recover-1', 'def-1', { input: 'test' });
    await repo.update('wf-recover-1', {
      status: 'running',
      executionCursor: [{ phase: 0 }, { step: 0 }],
      context: { steps: { s0: { type: 'guard' } } }
    });

    const mockKernel = { activeWorkflows: new Map() };
    const recovery = new RecoveryManager(mockKernel, repo);
    const { recovered, failed } = await recovery.scanAndRecover();

    assert.strictEqual(recovered.length, 1);
    assert.strictEqual(failed.length, 0);
    assert.strictEqual(recovered[0].workflowId, 'wf-recover-1');
    assert.strictEqual(recovered[0].action, 'resume_from_cursor');
    assert.ok(recovered[0].runToken, 'recovery should include runToken');
  });

  it('RecoveryManager logs runToken mismatch when kernel has active workflow', async () => {
    await repo.create('wf-recover-2', 'def-2', { input: 'test' });
    await repo.update('wf-recover-2', {
      status: 'running',
      executionCursor: [{ phase: 0 }, { step: 0 }],
      context: { steps: { s0: { type: 'guard' } } }
    });

    const mockKernel = { activeWorkflows: new Map() };
    mockKernel.activeWorkflows.set('wf-recover-2', {
      record: { runToken: 'different-token' }
    });

    const recovery = new RecoveryManager(mockKernel, repo);
    const { recovered, failed } = await recovery.scanAndRecover();

    assert.strictEqual(recovered.length, 1);
    assert.strictEqual(recovered[0].action, 'skipped');
    assert.strictEqual(recovered[0].reason, 'runToken_mismatch');
    assert.ok(recovered[0].runToken);
  });

  it('RecoveryManager marks failed when no safe boundary exists', async () => {
    await repo.create('wf-recover-3', 'def-3', { input: 'test' });
    await repo.update('wf-recover-3', {
      status: 'running',
      executionCursor: [{ phase: 0 }, { step: 0 }],
      context: { steps: { s0: { type: 'agentCall' } } }
    });

    const mockKernel = { activeWorkflows: new Map() };
    const recovery = new RecoveryManager(mockKernel, repo);
    const { recovered, failed } = await recovery.scanAndRecover();

    assert.strictEqual(recovered.length, 1);
    assert.strictEqual(recovered[0].action, 'marked_failed');
    assert.strictEqual(recovered[0].reason, 'no_safe_boundary_found');
    assert.strictEqual(recovered[0].lastStepType, 'agentCall');
    assert.ok(recovered[0].runToken);

    const persisted = await repo.get('wf-recover-3');
    assert.strictEqual(persisted.status, 'failed');
  });

  it('falls back to StoryStateRepositoryAdapter when SQLite tables are not used', async () => {
    // This verifies backward compatibility: the kernel works with either repository
    const storyRepo = makeMockStoryRepo();
    const stateRepo = new StoryStateRepositoryAdapter(storyRepo);
    kernel = new WorkflowKernel({
      agentDispatcher: {
        delegate: async (id, prompt) => ({ content: 'ok', markers: [], raw: {} })
      },
      stateRepository: stateRepo
    });
    kernel.registerStepType('noop', async () => ({ status: 'completed', output: 'done' }));

    const definition = {
      id: 'fallback-test',
      phases: [{
        id: 'p1',
        steps: [{ id: 's1', type: 'noop', outputKey: 'out1' }]
      }]
    };

    const record = await kernel.execute('wf-fallback', definition, { seed: 77 });
    assert.strictEqual(record.status, EXECUTION_STATES.COMPLETED);

    const persisted = storyRepo._stories.get('wf-fallback');
    assert.ok(persisted);
    const state = JSON.parse(persisted.workflow_state);
    assert.deepStrictEqual(state.inputs, { seed: 77 });
  });

  it('kernel getStatus falls back to SQLite repo for inactive workflows', async () => {
    kernel = new WorkflowKernel({
      agentDispatcher: {
        delegate: async (id, prompt) => ({ content: 'ok', markers: [], raw: {} })
      },
      stateRepository: repo
    });
    kernel.registerStepType('noop', async () => ({ status: 'completed', output: 'done' }));

    const definition = {
      id: 'status-test',
      phases: [{
        id: 'p1',
        steps: [{ id: 's1', type: 'noop', outputKey: 'out1' }]
      }]
    };

    await kernel.execute('wf-status-test', definition, { in: 1 });

    // Clear active workflows to force repo lookup
    kernel.activeWorkflows.clear();

    const status = await kernel.getStatus('wf-status-test');
    assert.ok(status);
    assert.strictEqual(status.workflowId, 'wf-status-test');
    assert.strictEqual(status.state, EXECUTION_STATES.COMPLETED);
    assert.deepStrictEqual(status.executionCursor, [{ phase: 0 }, { step: 0 }]);
  });
});
