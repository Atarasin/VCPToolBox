const { describe, it } = require('node:test');
const assert = require('node:assert');
const { loopStep } = require('../../../modules/workflowKernel/steps/LoopStep');

describe('LoopStep', () => {
  it('completes when no sub-steps', async () => {
    const result = await loopStep({ steps: [] }, { kernel: {}, context: {} });
    assert.strictEqual(result.status, 'completed');
    assert.strictEqual(result.output.iterations, 0);
  });

  it('runs exactly once when no shouldContinue', async () => {
    const kernel = {
      stepRegistry: {
        get: (type) => async () => ({ status: 'completed', output: { done: true } })
      },
      config: {}
    };
    const step = {
      id: 'loop1',
      steps: [{ id: 's1', type: 'noop' }]
    };
    const result = await loopStep(step, { kernel, context: { steps: {}, outputs: {} } });
    assert.strictEqual(result.status, 'completed');
    assert.strictEqual(result.output.iterations, 1);
    assert.strictEqual(result.output.reason, 'no_shouldContinue');
  });

  it('iterates until shouldContinue returns false', async () => {
    let calls = 0;
    const kernel = {
      stepRegistry: {
        get: (type) => async () => {
          calls++;
          return { status: 'completed', output: { val: calls } };
        }
      },
      config: {}
    };
    const step = {
      id: 'loop2',
      steps: [{ id: 's1', type: 'noop', outputKey: 's1' }],
      shouldContinue: (ctx) => ctx.outputs.s1?.val < 3
    };
    const context = { steps: {}, outputs: {} };
    const result = await loopStep(step, { kernel, context });
    assert.strictEqual(result.status, 'completed');
    assert.strictEqual(result.output.iterations, 3);
    assert.strictEqual(result.output.stopped, true);
  });

  it('returns checkpoint from sub-step', async () => {
    const kernel = {
      stepRegistry: {
        get: () => async () => ({
          status: 'waiting_checkpoint',
          checkpoint: { checkpointId: 'cp-1' }
        })
      },
      config: {}
    };
    const step = {
      id: 'loop3',
      steps: [{ id: 's1', type: 'checkpoint' }]
    };
    const result = await loopStep(step, { kernel, context: { steps: {}, outputs: {} } });
    assert.strictEqual(result.status, 'waiting_checkpoint');
  });

  it('fails when max iterations exceeded', async () => {
    const kernel = {
      stepRegistry: {
        get: () => async () => ({ status: 'completed' })
      },
      config: {}
    };
    const step = {
      id: 'loop4',
      steps: [{ id: 's1', type: 'noop' }],
      maxIterations: 2,
      shouldContinue: () => true
    };
    const result = await loopStep(step, { kernel, context: { steps: {}, outputs: {} } });
    assert.strictEqual(result.status, 'failed');
    assert.match(result.error.message, /max iterations/);
  });

  it('returns checkpoint on max iterations with onMaxIterationsExceeded=checkpoint', async () => {
    const kernel = {
      stepRegistry: {
        get: () => async () => ({ status: 'completed' })
      },
      config: {}
    };
    const step = {
      id: 'loop5',
      steps: [{ id: 's1', type: 'noop' }],
      maxIterations: 1,
      shouldContinue: () => true,
      onMaxIterationsExceeded: 'checkpoint'
    };
    const result = await loopStep(step, { kernel, context: { steps: {}, outputs: {} } });
    assert.strictEqual(result.status, 'waiting_checkpoint');
    assert.strictEqual(result.checkpoint.type, 'loop_max_iterations');
  });

  it('completes at exactly maxIterations boundary', async () => {
    let iteration = 0;
    const kernel = {
      stepRegistry: {
        get: () => async () => {
          iteration++;
          return { status: 'completed', output: { val: iteration } };
        }
      },
      config: {}
    };
    const step = {
      id: 'loop-boundary',
      steps: [{ id: 's1', type: 'noop', outputKey: 's1' }],
      maxIterations: 3,
      shouldContinue: (ctx) => ctx.outputs.s1?.val !== 3
    };
    const context = { steps: {}, outputs: {} };
    const result = await loopStep(step, { kernel, context });
    assert.strictEqual(result.status, 'completed');
    assert.strictEqual(result.output.iterations, 3);
    assert.strictEqual(result.output.stopped, true);
  });

  it('fails when exceeding maxIterations boundary', async () => {
    const kernel = {
      stepRegistry: {
        get: () => async () => ({ status: 'completed' })
      },
      config: {}
    };
    const step = {
      id: 'loop-over',
      steps: [{ id: 's1', type: 'noop' }],
      maxIterations: 2,
      shouldContinue: () => true
    };
    const result = await loopStep(step, { kernel, context: { steps: {}, outputs: {} } });
    assert.strictEqual(result.status, 'failed');
    assert.match(result.error.message, /exceeded max iterations \(2\)/);
  });

  it('propagates error when shouldContinue throws', async () => {
    const kernel = {
      stepRegistry: {
        get: () => async () => ({ status: 'completed' })
      },
      config: {}
    };
    const step = {
      id: 'loop-throw',
      steps: [{ id: 's1', type: 'noop' }],
      shouldContinue: () => { throw new Error('shouldContinue explosion'); }
    };
    await assert.rejects(
      async () => loopStep(step, { kernel, context: { steps: {}, outputs: {} } }),
      /shouldContinue explosion/
    );
  });

  it('stops after first iteration when shouldContinue immediately returns false', async () => {
    const kernel = {
      stepRegistry: {
        get: () => async () => ({ status: 'completed', output: { val: 1 } })
      },
      config: {}
    };
    const step = {
      id: 'loop-zero',
      steps: [{ id: 's1', type: 'noop' }],
      shouldContinue: () => false
    };
    const result = await loopStep(step, { kernel, context: { steps: {}, outputs: {} } });
    assert.strictEqual(result.status, 'completed');
    assert.strictEqual(result.output.iterations, 1);
    assert.strictEqual(result.output.reason, 'shouldContinue_returned_false');
  });

  it('overwrites step output across iterations', async () => {
    let iteration = 0;
    const kernel = {
      stepRegistry: {
        get: () => async () => {
          iteration++;
          return { status: 'completed', output: { iter: iteration } };
        }
      },
      config: {}
    };
    const step = {
      id: 'loop-overwrite',
      steps: [{ id: 's1', type: 'noop', outputKey: 's1' }],
      maxIterations: 5,
      shouldContinue: (ctx) => ctx.outputs.s1?.iter < 3
    };
    const context = { steps: {}, outputs: {} };
    const result = await loopStep(step, { kernel, context });
    assert.strictEqual(result.status, 'completed');
    assert.strictEqual(result.output.iterations, 3);
    assert.strictEqual(context.steps.s1.outputs.iter, 3);
    assert.strictEqual(context.outputs.s1.iter, 3);
  });

  it('handles nested loops correctly', async () => {
    const kernel = {
      stepRegistry: {
        get: (type) => {
          if (type === 'innerLoop') {
            return async (subStep, subContext) => loopStep(subStep, subContext);
          }
          return async () => ({ status: 'completed', output: { val: 1 } });
        }
      },
      config: {}
    };
    const step = {
      id: 'outer-loop',
      steps: [
        {
          id: 'inner1',
          type: 'innerLoop',
          steps: [{ id: 'inner-s1', type: 'noop' }],
          shouldContinue: () => false
        }
      ],
      maxIterations: 3,
      shouldContinue: () => false
    };
    const context = { steps: {}, outputs: {} };
    const result = await loopStep(step, { kernel, context });
    assert.strictEqual(result.status, 'completed');
    assert.strictEqual(result.output.iterations, 1);
    assert.strictEqual(context.steps['inner1'].status, 'completed');
    assert.strictEqual(context.steps['inner-s1'].status, 'completed');
  });

  it('fails when loop sub-step type is unknown', async () => {
    const kernel = {
      stepRegistry: {
        get: () => null
      },
      config: {}
    };
    const step = {
      id: 'loop-unknown',
      steps: [{ id: 's1', type: 'missing' }]
    };
    const result = await loopStep(step, { kernel, context: { steps: {}, outputs: {} } });
    assert.strictEqual(result.status, 'failed');
    assert.match(result.error.message, /Loop sub-step type not found: missing/);
  });

  it('fails when a loop sub-step returns failed status', async () => {
    const kernel = {
      stepRegistry: {
        get: () => async () => ({ status: 'failed', error: new Error('sub-step blew up') })
      },
      config: {}
    };
    const step = {
      id: 'loop-fail',
      steps: [{ id: 's1', type: 'fail' }]
    };
    const result = await loopStep(step, { kernel, context: { steps: {}, outputs: {} } });
    assert.strictEqual(result.status, 'failed');
    assert.match(result.error.message, /Loop sub-step s1 failed: sub-step blew up/);
  });
});
