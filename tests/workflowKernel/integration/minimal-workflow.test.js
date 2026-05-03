const { describe, it, afterEach } = require('node:test');
const assert = require('node:assert');
const { WorkflowKernel } = require('../../../modules/workflowKernel/core/WorkflowKernel');
const { EXECUTION_STATES } = require('../../../modules/workflowKernel/core/StateMachine');
const { agentCallStep } = require('../../../modules/workflowKernel/steps/AgentCallStep');
const { checkpointStep } = require('../../../modules/workflowKernel/steps/CheckpointStep');
const { loopStep } = require('../../../modules/workflowKernel/steps/LoopStep');

describe('Minimal Workflow Integration', () => {
  let kernel;

  afterEach(() => {
    if (kernel && kernel.checkpointManager) {
      kernel.checkpointManager.destroy();
      kernel = null;
    }
  });

  it('executes simple workflow with noop step', async () => {
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
    assert.ok(events.some(e => e.type === 'workflow.started'));
    assert.ok(events.some(e => e.type === 'workflow.completed'));

    const status = await kernel.getStatus('wf-simple');
    assert.strictEqual(status.state, EXECUTION_STATES.COMPLETED);
  });

  it('executes agentCall + checkpoint + loop workflow', async () => {
    const events = [];
    kernel = new WorkflowKernel({
      agentDispatcher: {
        delegate: async (agentId, prompt) => ({
          content: `Agent ${agentId} says: ${prompt}`,
          markers: [],
          raw: {}
        })
      }
    });

    kernel.onEvent('*', (event) => events.push(event));
    kernel.registerStepType('agentCall', agentCallStep);
    kernel.registerStepType('checkpoint', checkpointStep);
    kernel.registerStepType('loop', loopStep);

    const definition = {
      id: 'test-workflow',
      phases: [{
        id: 'p1',
        name: 'Test Phase',
        steps: [
          { id: 'draft', type: 'agentCall', agent: 'writer', input: { prompt: 'Write intro' }, outputKey: 'draft' },
          { id: 'review', type: 'checkpoint', promptTemplate: 'Review the draft' },
          { id: 'polishLoop', type: 'loop', steps: [
            { id: 'polish', type: 'agentCall', agent: 'editor', input: { prompt: 'Polish' } }
          ], maxIterations: 2, shouldContinue: () => false }
        ]
      }]
    };

    await kernel.execute('wf-test', definition, {});

    const status = await kernel.getStatus('wf-test');
    assert.strictEqual(status.state, 'waiting_checkpoint');
    assert.ok(status.checkpointState);

    await kernel.resume('wf-test', {
      checkpointId: status.checkpointState.checkpointId,
      action: 'approve',
      feedback: 'Looks good'
    });

    const finalStatus = await kernel.getStatus('wf-test');
    assert.strictEqual(finalStatus.state, 'completed');
    assert.ok(events.some(e => e.type === 'workflow.started'));
    assert.ok(events.some(e => e.type === 'workflow.checkpoint_pending'));
    assert.ok(events.some(e => e.type === 'workflow.completed'));
  });

  it('rejects duplicate workflow execution', async () => {
    kernel = new WorkflowKernel({});
    kernel.registerStepType('noop', async () => ({ status: 'completed' }));

    const definition = {
      id: 'dup-test',
      phases: [{ id: 'p1', steps: [{ id: 's1', type: 'noop' }] }]
    };

    await kernel.execute('wf-dup', definition);
    await assert.rejects(
      kernel.execute('wf-dup', definition),
      /already active/
    );
  });

  it('marks workflow failed on unknown step type', async () => {
    kernel = new WorkflowKernel({});
    const definition = {
      id: 'bad',
      phases: [{ id: 'p1', steps: [{ id: 's1', type: 'unknown_type' }] }]
    };

    const record = await kernel.execute('wf-bad', definition);
    assert.strictEqual(record.status, EXECUTION_STATES.FAILED);
  });
});
