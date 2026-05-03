const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const { WorkflowKernel } = require('../../../modules/workflowKernel/core/WorkflowKernel');
const { EXECUTION_STATES } = require('../../../modules/workflowKernel/core/StateMachine');
const { checkpointStep } = require('../../../modules/workflowKernel/steps/CheckpointStep');
const { loopStep } = require('../../../modules/workflowKernel/steps/LoopStep');
const { parallelGroupStep } = require('../../../modules/workflowKernel/steps/ParallelGroupStep');

describe('WorkflowKernel', () => {
  let kernel;
  let logs;
  let originalConsoleLog;

  beforeEach(() => {
    logs = [];
    originalConsoleLog = console.log;
    console.log = (...args) => logs.push(args.join(' '));
  });

  afterEach(() => {
    console.log = originalConsoleLog;
    if (kernel) {
      kernel.activeWorkflows.clear();
      kernel = null;
    }
  });

  it('execute completes simple workflow and emits lifecycle events', async () => {
    const events = [];
    kernel = new WorkflowKernel({});
    kernel.onEvent('*', (event) => events.push(event));
    kernel.registerStepType('noop', async () => ({ status: 'completed', output: 'done' }));

    const definition = {
      id: 'simple-test',
      phases: [{
        id: 'p1',
        steps: [{ id: 's1', type: 'noop', outputKey: 'out1' }]
      }]
    };

    const record = await kernel.execute('wf-simple', definition, { input: 'hello' });
    assert.strictEqual(record.workflowId, 'wf-simple');
    assert.strictEqual(record.status, EXECUTION_STATES.COMPLETED);
    assert.strictEqual(record.context.outputs.out1, 'done');
    assert.strictEqual(record.context.steps.s1.status, 'completed');

    const started = events.find(e => e.type === 'workflow.started');
    assert.ok(started, 'workflow.started event should be emitted');
    assert.strictEqual(started.payload.definitionRef, 'simple-test');
    assert.deepStrictEqual(started.payload.initialContext, { input: 'hello' });

    const completed = events.find(e => e.type === 'workflow.completed');
    assert.ok(completed, 'workflow.completed event should be emitted');
    assert.deepStrictEqual(completed.payload.outputs, { out1: 'done' });

    const stepStarted = events.find(e => e.type === 'workflow.step_started');
    assert.ok(stepStarted);
    assert.strictEqual(stepStarted.payload.stepId, 's1');

    const stepCompleted = events.find(e => e.type === 'workflow.step_completed');
    assert.ok(stepCompleted);
    assert.strictEqual(stepCompleted.payload.stepId, 's1');
  });

  it('execute rejects duplicate workflowId', async () => {
    kernel = new WorkflowKernel({});
    kernel.registerStepType('noop', async () => ({ status: 'completed' }));

    const definition = {
      id: 'dup-test',
      phases: [{ id: 'p1', steps: [{ id: 's1', type: 'noop' }] }]
    };

    await kernel.execute('wf-dup', definition);
    await assert.rejects(
      kernel.execute('wf-dup', definition),
      /Workflow wf-dup is already active/
    );
  });

  it('execute persists initial state via stateRepository', async () => {
    const created = [];
    const stateRepository = {
      create: async (workflowId, definitionRef, context) => {
        created.push({ workflowId, definitionRef, context });
      },
      update: async () => {}
    };

    kernel = new WorkflowKernel({ stateRepository });
    kernel.registerStepType('noop', async () => ({ status: 'completed' }));

    const definition = { id: 'persist-test', phases: [{ id: 'p1', steps: [{ id: 's1', type: 'noop' }] }] };
    await kernel.execute('wf-persist', definition, { seed: 42 });

    assert.strictEqual(created.length, 1);
    assert.strictEqual(created[0].workflowId, 'wf-persist');
    assert.strictEqual(created[0].definitionRef, 'persist-test');
    assert.deepStrictEqual(created[0].context.inputs, { seed: 42 });
  });

  it('getStatus returns active workflow state', async () => {
    kernel = new WorkflowKernel({});
    kernel.registerStepType('noop', async () => ({ status: 'completed' }));

    const definition = {
      id: 'status-test',
      phases: [{ id: 'p1', steps: [{ id: 's1', type: 'noop', outputKey: 'o1' }] }]
    };

    await kernel.execute('wf-status', definition, { in: 1 });
    const status = await kernel.getStatus('wf-status');
    assert.ok(status);
    assert.strictEqual(status.workflowId, 'wf-status');
    assert.strictEqual(status.state, EXECUTION_STATES.COMPLETED);
    assert.deepStrictEqual(status.executionCursor, [{ phase: 0 }, { step: 0 }]);
    assert.deepStrictEqual(status.context.inputs, { in: 1 });
    assert.strictEqual(status.checkpointState, null);
  });

  it('getStatus falls back to stateRepository when not active', async () => {
    const stateRepository = {
      get: async (workflowId) => ({
        workflowId,
        state: EXECUTION_STATES.FAILED,
        executionCursor: [{ phase: 0 }, { step: 1 }],
        context: { inputs: { from: 'repo' } },
        checkpointState: null
      })
    };

    kernel = new WorkflowKernel({ stateRepository });
    const status = await kernel.getStatus('wf-inactive');
    assert.ok(status);
    assert.strictEqual(status.workflowId, 'wf-inactive');
    assert.strictEqual(status.state, EXECUTION_STATES.FAILED);
    assert.deepStrictEqual(status.executionCursor, [{ phase: 0 }, { step: 1 }]);
  });

  it('getStatus returns null when not found and no repository', async () => {
    kernel = new WorkflowKernel({});
    const status = await kernel.getStatus('wf-missing');
    assert.strictEqual(status, null);
  });

  it('resume continues workflow from checkpoint', async () => {
    const events = [];
    kernel = new WorkflowKernel({});
    kernel.onEvent('*', (event) => events.push(event));

    kernel.registerStepType('checkpoint', async () => ({
      status: 'waiting_checkpoint',
      checkpoint: { checkpointId: 'cp-1', type: 'review', promptTemplate: 'Review' }
    }));
    kernel.registerStepType('noop', async () => ({ status: 'completed', output: 'after-checkpoint' }));

    const definition = {
      id: 'resume-test',
      phases: [{
        id: 'p1',
        steps: [
          { id: 's1', type: 'checkpoint', outputKey: 'cpOut' },
          { id: 's2', type: 'noop', outputKey: 'finalOut' }
        ]
      }]
    };

    await kernel.execute('wf-resume', definition);
    let status = await kernel.getStatus('wf-resume');
    assert.strictEqual(status.state, EXECUTION_STATES.WAITING_CHECKPOINT);
    assert.ok(status.checkpointState);

    const record = await kernel.resume('wf-resume', {
      checkpointId: 'cp-1',
      action: 'approve',
      feedback: 'Looks good'
    });

    assert.strictEqual(record.status, EXECUTION_STATES.COMPLETED);
    assert.strictEqual(record.context.outputs.finalOut, 'after-checkpoint');

    const approvedEvent = events.find(e => e.type === 'workflow.checkpoint_approved');
    assert.ok(approvedEvent);
    assert.strictEqual(approvedEvent.payload.checkpointId, 'cp-1');
    assert.strictEqual(approvedEvent.payload.action, 'approve');
    assert.strictEqual(approvedEvent.payload.feedback, 'Looks good');

    status = await kernel.getStatus('wf-resume');
    assert.strictEqual(status.state, EXECUTION_STATES.COMPLETED);
  });

  it('resume with reject re-runs the preceding step when checkpoint requests retry', async () => {
    const events = [];
    const stepOrder = [];
    kernel = new WorkflowKernel({});
    kernel.onEvent('*', (event) => events.push(event));
    kernel.registerStepType('tracker', async (step) => {
      stepOrder.push(step.id);
      return { status: 'completed', output: step.id };
    });
    kernel.registerStepType('checkpoint', async () => ({
      status: 'waiting_checkpoint',
      checkpoint: {
        checkpointId: 'cp-retry',
        type: 'review',
        promptTemplate: 'Review',
        onCheckpointReject: 'retry',
        metadata: { stepId: 'cp-step' }
      }
    }));

    const definition = {
      id: 'reject-retry-test',
      phases: [{
        id: 'p1',
        steps: [
          { id: 'before-review', type: 'tracker', outputKey: 'beforeReview' },
          { id: 'cp-step', type: 'checkpoint' },
          { id: 'after-review', type: 'tracker', outputKey: 'afterReview' }
        ]
      }]
    };

    await kernel.execute('wf-reject-retry', definition);
    const record = await kernel.resume('wf-reject-retry', {
      checkpointId: 'cp-retry',
      action: 'reject',
      feedback: 'Please regenerate'
    });

    assert.strictEqual(record.status, EXECUTION_STATES.WAITING_CHECKPOINT);
    assert.deepStrictEqual(stepOrder, ['before-review', 'before-review']);
    assert.strictEqual(record.retryContext.attempt, 1);
    assert.ok(events.some((event) => event.type === 'workflow.checkpoint_rejected'));
    assert.ok(events.filter((event) => event.type === 'workflow.checkpoint_pending').length >= 2);
  });

  it('resume with modify emits a distinct event and persists checkpoint resolution state', async () => {
    const events = [];
    kernel = new WorkflowKernel({});
    kernel.onEvent('*', (event) => events.push(event));
    kernel.registerStepType('checkpoint', async () => ({
      status: 'waiting_checkpoint',
      checkpoint: {
        checkpointId: 'cp-modify',
        type: 'review',
        promptTemplate: 'Review',
        metadata: { stepId: 'cp-step' }
      }
    }));
    kernel.registerStepType('noop', async () => ({ status: 'completed', output: 'done' }));

    const definition = {
      id: 'modify-test',
      phases: [{
        id: 'p1',
        steps: [
          { id: 'cp-step', type: 'checkpoint' },
          { id: 'after-cp', type: 'noop', outputKey: 'finalOut' }
        ]
      }]
    };

    const initialRecord = await kernel.execute('wf-modify', definition);
    assert.strictEqual(initialRecord.status, EXECUTION_STATES.WAITING_CHECKPOINT);

    const record = await kernel.resume('wf-modify', {
      checkpointId: 'cp-modify',
      action: 'modify',
      feedback: 'Updated by reviewer',
      modifiedData: { title: 'Revised title' }
    });

    assert.strictEqual(record.status, EXECUTION_STATES.COMPLETED);
    assert.strictEqual(record.context.steps['cp-step'].status, 'modified');
    assert.deepStrictEqual(record.context.steps['cp-step'].outputs, { title: 'Revised title' });

    const modifiedEvent = events.find((event) => event.type === 'workflow.checkpoint_modified');
    assert.ok(modifiedEvent);
    assert.strictEqual(modifiedEvent.payload.action, 'modify');
    assert.strictEqual(modifiedEvent.payload.status, 'modified');
  });

  it('resume throws when workflow not active', async () => {
    kernel = new WorkflowKernel({});
    await assert.rejects(
      kernel.resume('wf-inactive', { checkpointId: 'cp-1', action: 'approve' }),
      /Workflow wf-inactive is not active/
    );
  });

  it('resume throws when not in WAITING_CHECKPOINT state', async () => {
    kernel = new WorkflowKernel({});
    kernel.registerStepType('noop', async () => ({ status: 'completed' }));

    const definition = {
      id: 'not-waiting',
      phases: [{ id: 'p1', steps: [{ id: 's1', type: 'noop' }] }]
    };

    await kernel.execute('wf-running', definition);
    await assert.rejects(
      kernel.resume('wf-running', { checkpointId: 'cp-1', action: 'approve' }),
      /Workflow wf-running is not waiting for checkpoint/
    );
  });

  it('recover rehydrates a persisted checkpoint and resumes when definition is provided', async () => {
    const persistedRecord = {
      workflowId: 'wf-persisted-cp',
      definitionRef: 'recover-test',
      status: EXECUTION_STATES.WAITING_CHECKPOINT,
      executionCursor: [{ phase: 0 }, { step: 0 }],
      context: { inputs: {}, outputs: {}, steps: {} },
      checkpointState: { checkpointId: 'cp-1', type: 'review', promptTemplate: 'Review' },
      retryContext: {},
      history: [],
      runToken: 'rt-old',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };
    const updates = [];
    const events = [];

    kernel = new WorkflowKernel({
      stateRepository: {
        get: async (workflowId) => workflowId === 'wf-persisted-cp' ? persistedRecord : null,
        update: async (workflowId, patch) => updates.push({ workflowId, patch }),
        appendHistory: async (_workflowId, event) => events.push(event)
      }
    });
    kernel.registerStepType('checkpoint', async () => ({
      status: 'waiting_checkpoint',
      checkpoint: { checkpointId: 'cp-1', type: 'review', promptTemplate: 'Review' }
    }));
    kernel.registerStepType('noop', async () => ({ status: 'completed', output: 'after-recovery' }));

    const definition = {
      id: 'recover-test',
      phases: [{
        id: 'p1',
        steps: [
          { id: 'cp-step', type: 'checkpoint' },
          { id: 'after-cp', type: 'noop', outputKey: 'finalOut' }
        ]
      }]
    };

    const record = await kernel.recover('wf-persisted-cp', {
      definition,
      checkpointResponse: {
        checkpointId: 'cp-1',
        action: 'approve',
        feedback: 'Recovered approval'
      }
    });

    assert.strictEqual(record.status, EXECUTION_STATES.COMPLETED);
    assert.strictEqual(record.context.outputs.finalOut, 'after-recovery');
    assert.ok(updates.some(entry => entry.patch.status === EXECUTION_STATES.RUNNING));
    assert.ok(events.some(event => event.type === 'workflow.recovered'));
    assert.ok(events.some(event => event.type === 'workflow.checkpoint_approved'));
  });

  it('recover resumes an explicitly resumable in-flight step from the persisted recovery cursor', async () => {
    const updates = [];
    const events = [];
    const stepOrder = [];
    const persistedRecord = {
      workflowId: 'wf-recover-cursor',
      definitionRef: 'recover-cursor-test',
      status: EXECUTION_STATES.RUNNING,
      executionCursor: [{ phase: 0 }, { step: 1 }],
      context: {
        inputs: {},
        outputs: { beforeOut: 'before-step' },
        steps: {
          before: { status: 'completed', outputs: 'before-step', type: 'noop', attempt: 1 },
          resumable: {
            status: 'running',
            outputs: null,
            error: null,
            type: 'customResumable',
            attempt: 1,
            recovery: {
              isIdempotent: true,
              safeResumeBoundary: 'custom_step_boundary',
              boundaryType: 'custom_step_boundary',
              resumeFromCursor: true,
              rollbackBoundaries: ['custom_step_boundary', 'phase_boundary']
            }
          }
        }
      },
      checkpointState: null,
      retryContext: {
        __recovery: {
          currentCursor: {
            phaseId: 'p1',
            phaseIndex: 0,
            stepId: 'resumable',
            stepIndex: 1,
            boundaryType: 'custom_step_boundary',
            runToken: 'rt-old',
            resumeAction: 'resume_step',
            rollbackSafe: false,
            stepType: 'customResumable',
            executionCursor: [{ phase: 0 }, { step: 1 }]
          },
          rollbackBoundaries: [{
            key: 'phase_boundary:0:-1:',
            boundaryType: 'phase_boundary',
            phaseId: 'p1',
            phaseIndex: 0,
            stepId: null,
            stepIndex: -1,
            runToken: 'rt-old',
            resumeAction: 'resume_next',
            rollbackSafe: true,
            executionCursor: [{ phase: 0 }, { step: -1 }]
          }]
        }
      },
      history: [],
      runToken: 'rt-old',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };

    kernel = new WorkflowKernel({
      stateRepository: {
        get: async (workflowId) => workflowId === 'wf-recover-cursor' ? persistedRecord : null,
        update: async (workflowId, patch) => updates.push({ workflowId, patch }),
        appendHistory: async (_workflowId, event) => events.push(event)
      }
    });
    kernel.registerStepType('noop', async (step) => {
      stepOrder.push(step.id);
      return { status: 'completed', output: step.id };
    });
    kernel.registerStepType('customResumable', async (step) => {
      stepOrder.push(step.id);
      return { status: 'completed', output: 'resumed-ok' };
    });

    const definition = {
      id: 'recover-cursor-test',
      phases: [{
        id: 'p1',
        steps: [
          { id: 'before', type: 'noop', outputKey: 'beforeOut' },
          {
            id: 'resumable',
            type: 'customResumable',
            outputKey: 'resumeOut',
            recovery: {
              isIdempotent: true,
              safeResumeBoundary: 'custom_step_boundary',
              boundaryType: 'custom_step_boundary',
              resumeFromCursor: true,
              rollbackBoundaries: ['custom_step_boundary', 'phase_boundary']
            }
          },
          { id: 'after', type: 'noop', outputKey: 'afterOut' }
        ]
      }]
    };

    const record = await kernel.recover('wf-recover-cursor', {
      definition,
      recoveryAction: 'continue'
    });

    assert.strictEqual(record.status, EXECUTION_STATES.COMPLETED);
    assert.deepStrictEqual(stepOrder, ['resumable', 'after']);
    assert.strictEqual(record.context.outputs.resumeOut, 'resumed-ok');
    assert.strictEqual(record.context.outputs.afterOut, 'after');
    assert.ok(events.some((event) => event.type === 'workflow.recovered'));
    assert.ok(updates.some((entry) => entry.patch.retryContext?.__recovery?.currentCursor));
  });

  it('failure action rollbackToSnapshot rolls back to the latest safe boundary and re-enters execution', async () => {
    const events = [];
    const stepOrder = [];
    let attempts = 0;
    kernel = new WorkflowKernel({});
    kernel.onEvent('*', (event) => events.push(event));
    kernel.registerStepType('noop', async (step) => {
      stepOrder.push(step.id);
      return { status: 'completed', output: step.id };
    });
    kernel.registerStepType('flakyRollback', async (step) => {
      stepOrder.push(step.id);
      attempts += 1;
      if (attempts === 1) {
        return { status: 'failed', error: new Error('rollback me') };
      }
      return { status: 'completed', output: 'recovered' };
    });

    const definition = {
      id: 'rollback-runtime-test',
      phases: [{
        id: 'p1',
        steps: [
          { id: 'safe-boundary', type: 'noop', outputKey: 'safeOut' },
          { id: 'needs-rollback', type: 'flakyRollback', outputKey: 'midOut', onFailure: 'rollback' },
          { id: 'after-rollback', type: 'noop', outputKey: 'afterOut' }
        ]
      }]
    };

    const record = await kernel.execute('wf-rollback-runtime', definition);
    assert.strictEqual(record.status, EXECUTION_STATES.COMPLETED);
    assert.deepStrictEqual(stepOrder, ['safe-boundary', 'needs-rollback', 'needs-rollback', 'after-rollback']);
    assert.strictEqual(attempts, 2);
    assert.ok(events.some((event) => event.type === 'workflow.rollback'));
    assert.strictEqual(record.context.outputs.midOut, 'recovered');
  });

  it('recover restart_phase rewinds to the requested phase boundary before re-entering execution', async () => {
    const updates = [];
    const events = [];
    const stepOrder = [];
    const persistedRecord = {
      workflowId: 'wf-restart-phase',
      definitionRef: 'restart-phase-test',
      status: EXECUTION_STATES.RUNNING,
      executionCursor: [{ phase: 1 }, { step: 0 }],
      context: {
        inputs: {},
        outputs: {
          p1Out: 'phase-1-done',
          staleP2: 'stale-output'
        },
        steps: {
          p1s1: { status: 'completed', outputs: 'phase-1-done', type: 'noop', attempt: 1 },
          p2s1: { status: 'running', outputs: null, type: 'noop', attempt: 1 }
        }
      },
      checkpointState: null,
      retryContext: {
        __recovery: {
          currentCursor: {
            phaseId: 'p2',
            phaseIndex: 1,
            stepId: 'p2s1',
            stepIndex: 0,
            boundaryType: 'step_boundary',
            runToken: 'rt-old',
            resumeAction: 'resume_next',
            rollbackSafe: true,
            stepType: 'noop',
            executionCursor: [{ phase: 1 }, { step: 0 }]
          },
          rollbackBoundaries: [{
            key: 'phase_boundary:1:-1:',
            boundaryType: 'phase_boundary',
            phaseId: 'p2',
            phaseIndex: 1,
            stepId: null,
            stepIndex: -1,
            runToken: 'rt-old',
            resumeAction: 'resume_next',
            rollbackSafe: true,
            executionCursor: [{ phase: 1 }, { step: -1 }]
          }]
        }
      },
      history: [],
      runToken: 'rt-old',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };

    kernel = new WorkflowKernel({
      stateRepository: {
        get: async (workflowId) => workflowId === 'wf-restart-phase' ? persistedRecord : null,
        update: async (workflowId, patch) => updates.push({ workflowId, patch }),
        appendHistory: async (_workflowId, event) => events.push(event)
      }
    });
    kernel.registerStepType('noop', async (step) => {
      stepOrder.push(step.id);
      return { status: 'completed', output: `${step.id}-done` };
    });

    const definition = {
      id: 'restart-phase-test',
      phases: [
        {
          id: 'p1',
          steps: [{ id: 'p1s1', type: 'noop', outputKey: 'p1Out' }]
        },
        {
          id: 'p2',
          steps: [
            { id: 'p2s1', type: 'noop', outputKey: 'p2Out1' },
            { id: 'p2s2', type: 'noop', outputKey: 'p2Out2' }
          ]
        }
      ]
    };

    const record = await kernel.recover('wf-restart-phase', {
      definition,
      recoveryAction: 'restart_phase',
      targetPhase: 'p2'
    });

    assert.strictEqual(record.status, EXECUTION_STATES.COMPLETED);
    assert.deepStrictEqual(stepOrder, ['p2s1', 'p2s2']);
    assert.strictEqual(record.context.outputs.p1Out, 'phase-1-done');
    assert.strictEqual(record.context.outputs.p2Out1, 'p2s1-done');
    assert.strictEqual(record.context.outputs.p2Out2, 'p2s2-done');
    assert.ok(events.some((event) => event.type === 'workflow.recovered'));
    assert.ok(updates.some((entry) => entry.patch.retryContext?.__recovery?.lastRecoveryAction === 'restart_phase'));
  });

  it('recover rollback rejects when no rollback-safe boundary is available', async () => {
    const persistedRecord = {
      workflowId: 'wf-no-rollback-boundary',
      definitionRef: 'rollback-reject-test',
      status: EXECUTION_STATES.RUNNING,
      executionCursor: [{ phase: 0 }, { step: 0 }],
      context: {
        inputs: {},
        outputs: {},
        steps: {
          unsafe: { status: 'running', outputs: null, type: 'agentCall', attempt: 1 }
        }
      },
      checkpointState: null,
      retryContext: {
        __recovery: {
          currentCursor: {
            phaseId: 'p1',
            phaseIndex: 0,
            stepId: 'unsafe',
            stepIndex: 0,
            boundaryType: 'step_boundary',
            runToken: 'rt-old',
            resumeAction: 'resume_next',
            rollbackSafe: false,
            stepType: 'agentCall',
            executionCursor: [{ phase: 0 }, { step: 0 }]
          },
          rollbackBoundaries: []
        }
      },
      history: [],
      runToken: 'rt-old',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };

    kernel = new WorkflowKernel({
      stateRepository: {
        get: async (workflowId) => workflowId === 'wf-no-rollback-boundary' ? persistedRecord : null
      }
    });

    const definition = {
      id: 'rollback-reject-test',
      phases: [{
        id: 'p1',
        steps: [{ id: 'unsafe', type: 'agentCall' }]
      }]
    };

    await assert.rejects(
      kernel.recover('wf-no-rollback-boundary', {
        definition,
        recoveryAction: 'rollback'
      }),
      /No rollback-safe boundary is available/
    );
  });

  it('timeout auto-continue emits a timeout event and advances the workflow', async () => {
    const events = [];
    kernel = new WorkflowKernel({
      config: {
        defaultTimeoutMs: 5,
        checkpointPollIntervalMs: 5
      }
    });
    kernel.onEvent('*', (event) => events.push(event));
    kernel.registerStepType('checkpoint', checkpointStep);
    kernel.registerStepType('noop', async () => ({ status: 'completed', output: 'after-timeout' }));

    const definition = {
      id: 'timeout-test',
      phases: [{
        id: 'p1',
        steps: [
          { id: 'cp-step', type: 'checkpoint', promptTemplate: 'Review later' },
          { id: 'after-timeout', type: 'noop', outputKey: 'finalOut' }
        ]
      }]
    };

    await kernel.execute('wf-timeout', definition);
    await new Promise((resolve) => setTimeout(resolve, 80));

    const status = await kernel.getStatus('wf-timeout');
    assert.ok(status);
    assert.strictEqual(status.state, EXECUTION_STATES.COMPLETED);

    const timeoutEvent = events.find((event) => event.type === 'workflow.checkpoint_timeout');
    assert.ok(timeoutEvent);
    assert.strictEqual(timeoutEvent.payload.action, 'timeout');
    assert.strictEqual(timeoutEvent.payload.status, 'timed_out');
  });

  it('unknown step type transitions workflow to FAILED', async () => {
    kernel = new WorkflowKernel({});
    const events = [];
    kernel.onEvent('*', (event) => events.push(event));

    const definition = {
      id: 'unknown-step',
      phases: [{ id: 'p1', steps: [{ id: 's1', type: 'nonexistent_type' }] }]
    };

    const record = await kernel.execute('wf-unknown', definition);
    assert.strictEqual(record.status, EXECUTION_STATES.FAILED);

    const failedEvent = events.find(e => e.type === 'workflow.failed');
    assert.ok(failedEvent);
    assert.strictEqual(failedEvent.payload.failedStepId, 's1');
    assert.ok(failedEvent.payload.error.includes('Unknown step type'));
  });

  it('step returning failed status transitions workflow to FAILED', async () => {
    kernel = new WorkflowKernel({});
    const events = [];
    kernel.onEvent('*', (event) => events.push(event));
    kernel.registerStepType('flaky', async () => ({
      status: 'failed',
      error: { message: 'Intentional failure' }
    }));

    const definition = {
      id: 'failed-step',
      phases: [{ id: 'p1', steps: [{ id: 's1', type: 'flaky' }] }]
    };

    const record = await kernel.execute('wf-failed', definition);
    assert.strictEqual(record.status, EXECUTION_STATES.FAILED);

    const failedEvent = events.find(e => e.type === 'workflow.failed');
    assert.ok(failedEvent);
    assert.strictEqual(failedEvent.payload.failedStepId, 's1');
    assert.ok(failedEvent.payload.error.includes('Intentional failure'));

    const stepFailedEvent = events.find(e => e.type === 'workflow.step_failed');
    assert.ok(stepFailedEvent);
    assert.strictEqual(stepFailedEvent.payload.stepId, 's1');
    assert.strictEqual(stepFailedEvent.payload.stepType, 'flaky');
    assert.strictEqual(stepFailedEvent.payload.phaseId, 'p1');
    assert.strictEqual(stepFailedEvent.payload.errorCode, 'STEP_EXECUTION_FAILED');
    assert.ok(stepFailedEvent.payload.errorMessage.includes('Intentional failure'));
  });

  it('applies step-level retryPolicy before failing the workflow', async () => {
    const events = [];
    let attempts = 0;
    kernel = new WorkflowKernel({});
    kernel.onEvent('*', (event) => events.push(event));
    kernel.registerStepType('flaky', async () => {
      attempts += 1;
      if (attempts < 3) {
        return { status: 'failed', error: new Error(`Attempt ${attempts} failed`) };
      }
      return { status: 'completed', output: 'ok' };
    });

    const definition = {
      id: 'step-retry-test',
      phases: [{
        id: 'p1',
        steps: [{
          id: 's1',
          type: 'flaky',
          outputKey: 'out1',
          retryPolicy: { maxAttempts: 3, backoffDelays: [0, 0, 0] }
        }]
      }]
    };

    const record = await kernel.execute('wf-step-retry', definition);
    assert.strictEqual(record.status, EXECUTION_STATES.COMPLETED);
    assert.strictEqual(attempts, 3);
    assert.strictEqual(events.filter((event) => event.type === 'workflow.retrying').length, 2);
    assert.strictEqual(record.context.outputs.out1, 'ok');
  });

  it('applies workflow globalRetryPolicy to custom step failures', async () => {
    const events = [];
    let attempts = 0;
    kernel = new WorkflowKernel({});
    kernel.onEvent('*', (event) => events.push(event));
    kernel.registerStepType('customFlaky', async () => {
      attempts += 1;
      if (attempts === 1) {
        return { status: 'failed', error: new Error('First custom attempt failed') };
      }
      return { status: 'completed', output: 'custom-ok' };
    });

    const definition = {
      id: 'workflow-retry-test',
      globalRetryPolicy: { maxAttempts: 2, backoffDelays: [0, 0] },
      phases: [{
        id: 'p1',
        steps: [{ id: 'custom-step', type: 'customFlaky', outputKey: 'customOut' }]
      }]
    };

    const record = await kernel.execute('wf-workflow-retry', definition);
    assert.strictEqual(record.status, EXECUTION_STATES.COMPLETED);
    assert.strictEqual(attempts, 2);

    const retryEvent = events.find((event) => event.type === 'workflow.retrying');
    assert.ok(retryEvent);
    assert.strictEqual(retryEvent.payload.retryPolicySource, 'workflow');

    const stepFailedEvent = events.find((event) => event.type === 'workflow.step_failed');
    assert.ok(stepFailedEvent);
    assert.strictEqual(stepFailedEvent.payload.failureBoundary, 'custom_step');
  });

  it('routes failure checkpoint rejection back through re-execution', async () => {
    const events = [];
    let attempts = 0;
    kernel = new WorkflowKernel({});
    kernel.onEvent('*', (event) => events.push(event));
    kernel.registerStepType('flaky', async () => {
      attempts += 1;
      if (attempts === 1) {
        return { status: 'failed', error: new Error('Need human review') };
      }
      return { status: 'completed', output: 'recovered' };
    });

    const definition = {
      id: 'failure-checkpoint-test',
      phases: [{
        id: 'p1',
        steps: [{ id: 'reviewable', type: 'flaky', outputKey: 'out1', onFailure: 'checkpoint', onCheckpointReject: 'retry' }]
      }]
    };

    await kernel.execute('wf-failure-checkpoint', definition);
    let status = await kernel.getStatus('wf-failure-checkpoint');
    assert.strictEqual(status.state, EXECUTION_STATES.WAITING_CHECKPOINT);
    assert.ok(status.checkpointState);

    const record = await kernel.resume('wf-failure-checkpoint', {
      checkpointId: status.checkpointState.checkpointId,
      action: 'reject',
      feedback: 'Retry the failed step'
    });

    assert.strictEqual(record.status, EXECUTION_STATES.COMPLETED);
    assert.strictEqual(attempts, 2);
    assert.ok(events.some((event) => event.type === 'workflow.checkpoint_rejected'));
  });

  it('retries loop step at the loop boundary', async () => {
    const events = [];
    let subStepAttempts = 0;
    kernel = new WorkflowKernel({});
    kernel.onEvent('*', (event) => events.push(event));
    kernel.registerStepType('loop', loopStep);
    kernel.registerStepType('flakySubStep', async () => {
      subStepAttempts += 1;
      if (subStepAttempts === 1) {
        return { status: 'failed', error: new Error('Loop iteration failed') };
      }
      return { status: 'completed', output: 'loop-ok' };
    });

    const definition = {
      id: 'loop-boundary-test',
      phases: [{
        id: 'p1',
        steps: [{
          id: 'loop-wrapper',
          type: 'loop',
          retryPolicy: { maxAttempts: 2, backoffDelays: [0, 0] },
          shouldContinue: () => false,
          steps: [{ id: 'loop-flaky', type: 'flakySubStep' }]
        }]
      }]
    };

    const record = await kernel.execute('wf-loop-retry', definition);
    assert.strictEqual(record.status, EXECUTION_STATES.COMPLETED);
    assert.strictEqual(subStepAttempts, 2);

    const retryEvent = events.find((event) => event.type === 'workflow.retrying');
    assert.ok(retryEvent);
    assert.strictEqual(retryEvent.payload.failureBoundary, 'loop_step');
  });

  it('retries parallelGroup at the composite step boundary', async () => {
    const events = [];
    let branchAttempts = 0;
    kernel = new WorkflowKernel({});
    kernel.onEvent('*', (event) => events.push(event));
    kernel.registerStepType('parallelGroup', parallelGroupStep);
    kernel.registerStepType('branchOk', async () => ({ status: 'completed', output: 'ok' }));
    kernel.registerStepType('branchFlaky', async () => {
      branchAttempts += 1;
      if (branchAttempts === 1) {
        return { status: 'failed', error: new Error('Parallel branch failed') };
      }
      return { status: 'completed', output: 'recovered' };
    });

    const definition = {
      id: 'parallel-boundary-test',
      phases: [{
        id: 'p1',
        steps: [{
          id: 'parallel-wrapper',
          type: 'parallelGroup',
          retryPolicy: { maxAttempts: 2, backoffDelays: [0, 0] },
          failurePolicy: 'waitForRest',
          steps: [
            { id: 'branch-a', type: 'branchOk' },
            { id: 'branch-b', type: 'branchFlaky' }
          ]
        }]
      }]
    };

    const record = await kernel.execute('wf-parallel-retry', definition);
    assert.strictEqual(record.status, EXECUTION_STATES.COMPLETED);
    assert.strictEqual(branchAttempts, 2);

    const retryEvent = events.find((event) => event.type === 'workflow.retrying');
    assert.ok(retryEvent);
    assert.strictEqual(retryEvent.payload.failureBoundary, 'parallel_group');
  });

  it('getRunStatus returns enhanced status with recent events and last error', async () => {
    kernel = new WorkflowKernel({});
    kernel.registerStepType('flaky', async () => ({
      status: 'failed',
      error: { message: 'Intentional failure' }
    }));

    const definition = {
      id: 'run-status-failed',
      phases: [{ id: 'p1', steps: [{ id: 's1', type: 'flaky' }] }]
    };

    await kernel.execute('wf-run-status-failed', definition);

    const status = await kernel.getRunStatus('wf-run-status-failed');
    assert.ok(status);
    assert.strictEqual(status.workflowId, 'wf-run-status-failed');
    assert.strictEqual(status.state, EXECUTION_STATES.FAILED);
    assert.ok(status.runToken);
    assert.strictEqual(status.currentPhaseId, 'p1');
    assert.strictEqual(status.currentStepId, 's1');
    assert.strictEqual(status.currentStepType, 'flaky');
    assert.strictEqual(status.lastCompletedStep, null);
    assert.deepStrictEqual(status.lastFailedStep, {
      phaseId: 'p1',
      stepId: 's1',
      stepType: 'flaky'
    });
    assert.ok(status.lastEventAt);
    assert.ok(Array.isArray(status.recentEvents));
    assert.ok(status.recentEvents.some(event => event.type === 'workflow.step_failed'));
    assert.ok(status.lastError);
    assert.strictEqual(status.lastError.errorCode, 'STEP_EXECUTION_FAILED');
    assert.strictEqual(status.lastError.stepId, 's1');
    assert.ok(status.lastError.errorMessage.includes('Intentional failure'));
  });

  it('cursor resumption continues from next step after checkpoint', async () => {
    const stepOrder = [];
    kernel = new WorkflowKernel({});
    kernel.registerStepType('checkpoint', async () => ({
      status: 'waiting_checkpoint',
      checkpoint: { checkpointId: 'cp-1', type: 'review', promptTemplate: 'Review' }
    }));
    kernel.registerStepType('tracker', async (step) => {
      stepOrder.push(step.id);
      return { status: 'completed', output: step.id };
    });

    const definition = {
      id: 'cursor-test',
      phases: [{
        id: 'p1',
        steps: [
          { id: 'before-cp', type: 'tracker', outputKey: 'out1' },
          { id: 'cp-step', type: 'checkpoint' },
          { id: 'after-cp', type: 'tracker', outputKey: 'out2' }
        ]
      }]
    };

    await kernel.execute('wf-cursor', definition);
    assert.deepStrictEqual(stepOrder, ['before-cp']);

    await kernel.resume('wf-cursor', { checkpointId: 'cp-1', action: 'approve' });
    assert.deepStrictEqual(stepOrder, ['before-cp', 'after-cp']);

    const record = kernel.activeWorkflows.get('wf-cursor').record;
    assert.strictEqual(record.status, EXECUTION_STATES.COMPLETED);
    assert.strictEqual(record.context.outputs.out1, 'before-cp');
    assert.strictEqual(record.context.outputs.out2, 'after-cp');
  });

  it('webSocketPusher push failure is caught and logged', async () => {
    const events = [];
    kernel = new WorkflowKernel({
      webSocketPusher: {
        push: async () => {
          throw new Error('Push channel down');
        }
      }
    });
    kernel.onEvent('*', (event) => events.push(event));
    kernel.registerStepType('noop', async () => ({ status: 'completed' }));

    const definition = {
      id: 'push-fail',
      phases: [{ id: 'p1', steps: [{ id: 's1', type: 'noop' }] }]
    };

    const record = await kernel.execute('wf-push-fail', definition);
    assert.strictEqual(record.status, EXECUTION_STATES.COMPLETED);

    // EventBus should still have delivered the event
    assert.ok(events.some(e => e.type === 'workflow.started'));
    assert.ok(events.some(e => e.type === 'workflow.completed'));

    // Log should contain the push failure
    const pushFailLog = logs.find(l => l.includes('Event push failed'));
    assert.ok(pushFailLog, 'Push failure should be logged');
    assert.ok(pushFailLog.includes('Push channel down'));
  });

  it('stateRepository update is called on step completion', async () => {
    const updates = [];
    const stateRepository = {
      create: async () => {},
      update: async (workflowId, data) => {
        updates.push({ workflowId, ...data });
      }
    };

    kernel = new WorkflowKernel({ stateRepository });
    kernel.registerStepType('noop', async () => ({ status: 'completed', output: 'ok' }));

    const definition = {
      id: 'update-test',
      phases: [{ id: 'p1', steps: [{ id: 's1', type: 'noop', outputKey: 'o1' }] }]
    };

    await kernel.execute('wf-update', definition);
    assert.ok(updates.length >= 1);
    const lastUpdate = updates[updates.length - 1];
    assert.strictEqual(lastUpdate.workflowId, 'wf-update');
    assert.deepStrictEqual(lastUpdate.executionCursor, [{ phase: 0 }, { step: 0 }]);
    assert.deepStrictEqual(lastUpdate.context.outputs, { o1: 'ok' });
  });
});
