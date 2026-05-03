const assert = require('node:assert/strict');
const test = require('node:test');
const { parallelGroupStep, CancellationError } = require('../../../modules/workflowKernel/steps/ParallelGroupStep');

function createMockKernel(handlers) {
  return {
    stepRegistry: {
      get: (type) => handlers[type] || null
    }
  };
}

function createContext() {
  return { inputs: {}, outputs: {}, steps: {} };
}

test('parallelGroupStep with empty steps returns completed', async () => {
  const result = await parallelGroupStep(
    { steps: [] },
    { kernel: createMockKernel({}), context: createContext(), workflowId: 'wf1' }
  );
  assert.equal(result.status, 'completed');
  assert.deepEqual(result.output.results, []);
});

test('parallelGroupStep waitForRest policy succeeds when all pass', async () => {
  const kernel = createMockKernel({
    async success(step) {
      return { status: 'completed', output: { value: step.id } };
    }
  });

  const result = await parallelGroupStep(
    {
      steps: [
        { id: 's1', type: 'success', outputKey: 'o1' },
        { id: 's2', type: 'success', outputKey: 'o2' }
      ],
      failurePolicy: 'waitForRest'
    },
    { kernel, context: createContext(), workflowId: 'wf1' }
  );

  assert.equal(result.status, 'completed');
  assert.equal(result.output.results.length, 2);
});

test('parallelGroupStep waitForRest policy fails when any sub-step fails', async () => {
  const kernel = createMockKernel({
    async success() {
      return { status: 'completed', output: { value: 1 } };
    },
    async fail() {
      return { status: 'failed', error: new Error('intentional failure') };
    }
  });

  const result = await parallelGroupStep(
    {
      steps: [
        { id: 's1', type: 'success' },
        { id: 's2', type: 'fail' }
      ],
      failurePolicy: 'waitForRest'
    },
    { kernel, context: createContext(), workflowId: 'wf1' }
  );

  assert.equal(result.status, 'failed');
  assert.ok(result.error.message.includes('1 sub-step(s) failed'));
});

test('parallelGroupStep ignore policy returns all results including failures', async () => {
  const kernel = createMockKernel({
    async success() {
      return { status: 'completed', output: { value: 1 } };
    },
    async fail() {
      return { status: 'failed', error: new Error('intentional failure') };
    }
  });

  const result = await parallelGroupStep(
    {
      steps: [
        { id: 's1', type: 'success' },
        { id: 's2', type: 'fail' }
      ],
      failurePolicy: 'ignore'
    },
    { kernel, context: createContext(), workflowId: 'wf1' }
  );

  assert.equal(result.status, 'completed');
  assert.equal(result.output.results.length, 2);
  assert.equal(result.output.failures, 1);
});

test('parallelGroupStep cancelAll policy fails on first failure and cancels others', async () => {
  const kernel = createMockKernel({
    async fastFail() {
      return { status: 'failed', error: new Error('fast failure') };
    },
    async slowSuccess() {
      // Simulate a slow operation that should be cancelled
      await new Promise(resolve => setTimeout(resolve, 100));
      return { status: 'completed', output: { value: 1 } };
    }
  });

  const result = await parallelGroupStep(
    {
      steps: [
        { id: 's1', type: 'fastFail' },
        { id: 's2', type: 'slowSuccess' }
      ],
      failurePolicy: 'cancelAll'
    },
    { kernel, context: createContext(), workflowId: 'wf1' }
  );

  assert.equal(result.status, 'failed');
  assert.ok(result.error.message.includes('cancelled'));
  assert.ok(result.output.cancelled >= 0);
  assert.equal(result.output.results.length, 2);
});

test('parallelGroupStep cancelAll with unknown step type triggers cancellation', async () => {
  const kernel = createMockKernel({
    async slowSuccess() {
      await new Promise(resolve => setTimeout(resolve, 100));
      return { status: 'completed', output: { value: 1 } };
    }
  });

  const result = await parallelGroupStep(
    {
      steps: [
        { id: 's1', type: 'unknown' },
        { id: 's2', type: 'slowSuccess' }
      ],
      failurePolicy: 'cancelAll'
    },
    { kernel, context: createContext(), workflowId: 'wf1' }
  );

  assert.equal(result.status, 'failed');
  assert.ok(result.error.message.includes('cancelled'));
});

test('parallelGroupStep propagates checkpoint from sub-step', async () => {
  const kernel = createMockKernel({
    async checkpoint() {
      return {
        status: 'waiting_checkpoint',
        checkpoint: { checkpointId: 'cp1', type: 'test' }
      };
    },
    async success() {
      return { status: 'completed', output: { value: 1 } };
    }
  });

  const result = await parallelGroupStep(
    {
      steps: [
        { id: 's1', type: 'checkpoint' },
        { id: 's2', type: 'success' }
      ]
    },
    { kernel, context: createContext(), workflowId: 'wf1' }
  );

  assert.equal(result.status, 'waiting_checkpoint');
  assert.equal(result.checkpoint.checkpointId, 'cp1');
});

test('parallelGroupStep stores outputs in context', async () => {
  const kernel = createMockKernel({
    async add(step) {
      return { status: 'completed', output: { sum: step.a + step.b } };
    }
  });

  const context = createContext();
  const result = await parallelGroupStep(
    {
      steps: [
        { id: 's1', type: 'add', a: 1, b: 2, outputKey: 'sum1' },
        { id: 's2', type: 'add', a: 3, b: 4, outputKey: 'sum2' }
      ]
    },
    { kernel, context, workflowId: 'wf1' }
  );

  assert.equal(result.status, 'completed');
  assert.equal(context.outputs.sum1.sum, 3);
  assert.equal(context.outputs.sum2.sum, 7);
  assert.equal(context.steps.s1.status, 'completed');
  assert.equal(context.steps.s2.status, 'completed');
});

test('CancellationError is exported and has correct name', () => {
  const err = new CancellationError('test cancel');
  assert.equal(err.name, 'CancellationError');
  assert.equal(err.message, 'test cancel');
});

test('parallelGroupStep waitForRest with unknown step type fails the group', async () => {
  const kernel = createMockKernel({
    async success() {
      return { status: 'completed', output: { value: 1 } };
    }
  });

  const result = await parallelGroupStep(
    {
      steps: [
        { id: 's1', type: 'success' },
        { id: 's2', type: 'unknown' }
      ],
      failurePolicy: 'waitForRest'
    },
    { kernel, context: createContext(), workflowId: 'wf1' }
  );

  assert.equal(result.status, 'failed');
  assert.ok(result.error.message.includes('sub-step(s) failed'));
});

test('parallelGroupStep ignore policy includes unknown step type failures', async () => {
  const kernel = createMockKernel({
    async success() {
      return { status: 'completed', output: { value: 1 } };
    }
  });

  const result = await parallelGroupStep(
    {
      steps: [
        { id: 's1', type: 'success' },
        { id: 's2', type: 'unknown' }
      ],
      failurePolicy: 'ignore'
    },
    { kernel, context: createContext(), workflowId: 'wf1' }
  );

  assert.equal(result.status, 'completed');
  assert.equal(result.output.results.length, 2);
  assert.equal(result.output.failures, 1);
  const failed = result.output.results.find(r => r.stepId === 's2');
  assert.equal(failed.status, 'failed');
  assert.ok(failed.error.message.includes('Unknown sub-step type'));
});

test('parallelGroupStep cancelAll with handler throw triggers cancellation', async () => {
  const kernel = createMockKernel({
    async thrower() {
      throw new Error('thrown error');
    },
    async slowSuccess() {
      await new Promise(resolve => setTimeout(resolve, 100));
      return { status: 'completed', output: { value: 1 } };
    }
  });

  const result = await parallelGroupStep(
    {
      steps: [
        { id: 's1', type: 'thrower' },
        { id: 's2', type: 'slowSuccess' }
      ],
      failurePolicy: 'cancelAll'
    },
    { kernel, context: createContext(), workflowId: 'wf1' }
  );

  assert.equal(result.status, 'failed');
  assert.ok(result.error.message.includes('cancelled'));
  assert.equal(result.output.results.length, 2);
});

test('parallelGroupStep waitForRest treats direct CancellationError as non-fatal', async () => {
  const kernel = createMockKernel({
    async canceller() {
      throw new CancellationError('direct cancellation');
    },
    async success() {
      return { status: 'completed', output: { value: 1 } };
    }
  });

  const result = await parallelGroupStep(
    {
      steps: [
        { id: 's1', type: 'canceller' },
        { id: 's2', type: 'success' }
      ],
      failurePolicy: 'waitForRest'
    },
    { kernel, context: createContext(), workflowId: 'wf1' }
  );

  assert.equal(result.status, 'completed');
  assert.equal(result.output.results.length, 2);
  const cancelled = result.output.results.find(r => r.stepId === 's1');
  assert.equal(cancelled.status, 'cancelled');
  assert.ok(cancelled.error instanceof CancellationError);
});

test('parallelGroupStep cancelAll treats direct CancellationError as group failure', async () => {
  const kernel = createMockKernel({
    async canceller() {
      throw new CancellationError('direct cancellation');
    },
    async success() {
      return { status: 'completed', output: { value: 1 } };
    }
  });

  const result = await parallelGroupStep(
    {
      steps: [
        { id: 's1', type: 'canceller' },
        { id: 's2', type: 'success' }
      ],
      failurePolicy: 'cancelAll'
    },
    { kernel, context: createContext(), workflowId: 'wf1' }
  );

  assert.equal(result.status, 'completed');
  assert.equal(result.output.results.length, 2);
  const cancelled = result.output.results.find(r => r.stepId === 's1');
  assert.equal(cancelled.status, 'cancelled');
  assert.ok(cancelled.error instanceof CancellationError);
});

test('parallelGroupStep ignore policy includes CancellationError results', async () => {
  const kernel = createMockKernel({
    async canceller() {
      throw new CancellationError('direct cancellation');
    },
    async success() {
      return { status: 'completed', output: { value: 1 } };
    }
  });

  const result = await parallelGroupStep(
    {
      steps: [
        { id: 's1', type: 'canceller' },
        { id: 's2', type: 'success' }
      ],
      failurePolicy: 'ignore'
    },
    { kernel, context: createContext(), workflowId: 'wf1' }
  );

  assert.equal(result.status, 'completed');
  assert.equal(result.output.results.length, 2);
  assert.equal(result.output.failures, 0);
  const cancelled = result.output.results.find(r => r.stepId === 's1');
  assert.equal(cancelled.status, 'cancelled');
});
