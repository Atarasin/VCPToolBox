/**
 * Integration Call Tests — Real WorkflowKernel End-to-End Invocation
 *
 * These tests exercise the ACTUAL WorkflowKernel, StepRegistry, StateMachine,
 * and all built-in step handlers (agentCall, checkpoint, guard, loop, parallelGroup).
 * No part of the kernel execution engine is mocked.
 *
 * Mocked boundaries:
 *   - agentDispatcher (returns canned responses)
 *   - stateRepository (in-memory adapter)
 *   - webSocketPusher (event collector)
 *
 * Coverage targets:
 *   1. Full workflow execution from idle → completed
 *   2. Checkpoint pause → resume → completed
 *   3. Guard condition pass / fail / checkpoint
 *   4. Loop iteration with shouldContinue
 *   5. Parallel group execution with all failure policies
 *   6. Adapter → Kernel real invocation chain
 *   7. EventBus event sequence verification
 *   8. State persistence round-trip
 *   9. Step failure → workflow.failed state transition
 */

const assert = require('node:assert/strict');
const test = require('node:test');

const { WorkflowKernel } = require('../../modules/workflowKernel');
const { StoryOrchestratorKernelAdapter } = require('../../Plugin/StoryOrchestrator/adapters/StoryOrchestratorKernelAdapter');
const { EXECUTION_STATES } = require('../../modules/workflowKernel/core/StateMachine');

// ------------------------------------------------------------------
// In-memory state repository for persistence verification
// ------------------------------------------------------------------

function createInMemoryStateRepository() {
  const store = new Map();
  return {
    create: async (workflowId, definitionRef, context) => {
      store.set(workflowId, { workflowId, definitionRef, context, status: 'created', executionCursor: [] });
    },
    update: async (workflowId, patch) => {
      const rec = store.get(workflowId);
      if (rec) {
        Object.assign(rec, patch);
        rec.updatedAt = new Date().toISOString();
      }
    },
    get: async (workflowId) => store.get(workflowId) || null,
    _store: store
  };
}

// ------------------------------------------------------------------
// Mock agent dispatcher with programmable responses
// ------------------------------------------------------------------

function createMockAgentDispatcher(responses = {}) {
  return {
    delegate: async (agentId, prompt, options) => {
      if (responses[agentId]) {
        return responses[agentId](agentId, prompt, options);
      }
      return { content: `mock-response-${agentId}`, markers: [], raw: `raw-${agentId}` };
    },
    initialize: async () => {}
  };
}

// ------------------------------------------------------------------
// Event collector for EventBus / webSocketPusher verification
// ------------------------------------------------------------------

function createEventCollector() {
  const events = [];
  return {
    push: async (workflowId, event) => {
      events.push({ workflowId, ...event });
    },
    getEvents: () => events,
    getTypes: () => events.map(e => e.type),
    clear: () => { events.length = 0; }
  };
}

// ------------------------------------------------------------------
// Kernel builder — always returns a REAL kernel with real step handlers
// ------------------------------------------------------------------

function createRealKernel({ agentDispatcher, stateRepository, webSocketPusher, config = {} } = {}) {
  const kernel = new WorkflowKernel({
    agentDispatcher: agentDispatcher || createMockAgentDispatcher(),
    stateRepository: stateRepository || createInMemoryStateRepository(),
    webSocketPusher: webSocketPusher || createEventCollector(),
    config
  });

  // Register all built-in step types exactly as adapter does
  kernel.stepRegistry.register('agentCall', require('../../modules/workflowKernel/steps/AgentCallStep').agentCallStep);
  kernel.stepRegistry.register('checkpoint', require('../../modules/workflowKernel/steps/CheckpointStep').checkpointStep);
  kernel.stepRegistry.register('guard', require('../../modules/workflowKernel/steps/GuardStep').guardStep);
  kernel.stepRegistry.register('loop', require('../../modules/workflowKernel/steps/LoopStep').loopStep);
  kernel.stepRegistry.register('parallelGroup', require('../../modules/workflowKernel/steps/ParallelGroupStep').parallelGroupStep);
  kernel.stepRegistry.register('noop', async () => ({ status: 'completed', output: {} }));

  return kernel;
}

// ------------------------------------------------------------------
// Tests — 1. Full workflow execution: idle → completed
// ------------------------------------------------------------------

test('real kernel executes simple agentCall workflow to completion', async () => {
  const events = createEventCollector();
  const agentDispatcher = createMockAgentDispatcher({
    'worldBuilder': () => ({ content: JSON.stringify({ world: 'fantasy' }), markers: [], raw: 'raw-wb' })
  });

  const kernel = createRealKernel({ agentDispatcher, webSocketPusher: events });

  const definition = {
    id: 'test-simple-agent',
    phases: [{
      id: 'phase1',
      name: 'Build World',
      steps: [
        {
          id: 'generateWorld',
          type: 'agentCall',
          agent: 'worldBuilder',
          input: { prompt: 'Create a fantasy world' },
          outputKey: 'worldData'
        },
        {
          id: 'noopCleanup',
          type: 'noop'
        }
      ]
    }]
  };

  const record = await kernel.execute('story-001', definition, { storyPrompt: 'A hero journey' });

  assert.equal(record.status, EXECUTION_STATES.COMPLETED);
  assert.equal(record.context.outputs.worldData.content, JSON.stringify({ world: 'fantasy' }));
  assert.equal(record.context.steps.generateWorld.status, 'completed');
  assert.equal(record.context.steps.noopCleanup.status, 'completed');

  const eventTypes = events.getTypes();
  assert.ok(eventTypes.includes('workflow.started'));
  assert.ok(eventTypes.includes('workflow.step_started'));
  assert.ok(eventTypes.includes('workflow.step_completed'));
  assert.ok(eventTypes.includes('workflow.completed'));
});

// ------------------------------------------------------------------
// Tests — 2. Checkpoint pause → resume → completed
// ------------------------------------------------------------------

test('real kernel pauses at checkpoint and resumes to completion', async () => {
  const events = createEventCollector();
  const kernel = createRealKernel({ webSocketPusher: events });

  const definition = {
    id: 'test-checkpoint',
    phases: [{
      id: 'phase1',
      name: 'Review',
      steps: [
        {
          id: 'produceDraft',
          type: 'noop'
        },
        {
          id: 'humanReview',
          type: 'checkpoint',
          checkpointType: 'phase1',
          promptTemplate: 'Please review the draft'
        },
        {
          id: 'finalize',
          type: 'noop'
        }
      ]
    }]
  };

  // Execute — should pause at checkpoint
  const record = await kernel.execute('story-002', definition);

  assert.equal(record.status, EXECUTION_STATES.WAITING_CHECKPOINT);
  assert.ok(record.checkpointState);
  assert.equal(record.checkpointState.checkpointId, 'humanReview');
  assert.equal(record.context.steps.produceDraft.status, 'completed');
  // Checkpoint step is recorded before the CheckpointPauseError is thrown
  assert.equal(record.context.steps.humanReview.status, 'waiting_checkpoint');

  const eventTypes = events.getTypes();
  assert.ok(eventTypes.includes('workflow.checkpoint_pending'));
  assert.ok(!eventTypes.includes('workflow.completed'));

  // Resume with approval
  events.clear();
  const resumed = await kernel.resume('story-002', {
    checkpointId: 'humanReview',
    action: 'approve',
    feedback: 'Looks great'
  });

  assert.equal(resumed.status, EXECUTION_STATES.COMPLETED);
  assert.equal(resumed.context.steps.finalize.status, 'completed');

  const resumedTypes = events.getTypes();
  assert.ok(resumedTypes.includes('workflow.checkpoint_approved'));
  assert.ok(resumedTypes.includes('workflow.completed'));
});

// ------------------------------------------------------------------
// Tests — 3. Guard condition: pass / fail / checkpoint
// ------------------------------------------------------------------

test('guard step passes when condition is true', async () => {
  const kernel = createRealKernel();

  const definition = {
    id: 'test-guard-pass',
    phases: [{
      id: 'p1',
      steps: [
        {
          id: 'setScore',
          type: 'noop' // noop does not set outputs, so we seed context manually
        }
      ]
    }]
  };

  // Execute a noop first, then manually set outputs for guard to reference
  const record = await kernel.execute('story-guard-pass', definition);
  record.context.outputs.score = 95;

  // Now execute a guard step directly via kernel's _executeStep (internal but needed for state setup)
  const guardResult = await kernel.stepRegistry.get('guard')(
    { id: 'qualityGate', type: 'guard', condition: 'ctx.outputs.score >= 90' },
    { workflowId: 'story-guard-pass', step: { id: 'qualityGate' }, context: record.context, kernel }
  );

  assert.equal(guardResult.status, 'completed');
  assert.equal(guardResult.output.passed, true);
});

test('guard step fails when condition is false and onFailure=fail', async () => {
  const kernel = createRealKernel();
  const context = { inputs: {}, outputs: { score: 70 }, steps: {} };

  const guardResult = await kernel.stepRegistry.get('guard')(
    { id: 'qualityGate', type: 'guard', condition: 'ctx.outputs.score >= 90', onFailure: 'fail' },
    { workflowId: 'story-guard-fail', step: { id: 'qualityGate' }, context, kernel }
  );

  assert.equal(guardResult.status, 'failed');
  assert.ok(guardResult.error.message.includes('Guard condition failed'));
});

test('guard step creates checkpoint when condition is false and onFailure=checkpoint', async () => {
  const kernel = createRealKernel();
  const context = { inputs: {}, outputs: { score: 70 }, steps: {} };

  const guardResult = await kernel.stepRegistry.get('guard')(
    { id: 'qualityGate', type: 'guard', condition: 'ctx.outputs.score >= 90', onFailure: 'checkpoint' },
    { workflowId: 'story-guard-cp', step: { id: 'qualityGate' }, context, kernel }
  );

  assert.equal(guardResult.status, 'waiting_checkpoint');
  assert.ok(guardResult.checkpoint.checkpointId.startsWith('guard-'));
});

// ------------------------------------------------------------------
// Tests — 4. Loop iteration with shouldContinue
// ------------------------------------------------------------------

test('loop step iterates until shouldContinue returns false', async () => {
  const kernel = createRealKernel();
  // Register a counter step that increments context.outputs.iterationCount
  kernel.stepRegistry.register('incrementCounter', async (step, stepContext) => {
    const { context } = stepContext;
    context.outputs.iterationCount = (context.outputs.iterationCount || 0) + 1;
    return { status: 'completed', output: { count: context.outputs.iterationCount } };
  });

  // Inject shouldContinue that stops after 3 iterations
  kernel.config.shouldContinue = (context) => {
    const iter = context.outputs.iterationCount || 0;
    return iter < 3;
  };

  const context = { inputs: {}, outputs: {}, steps: {} };

  const loopResult = await kernel.stepRegistry.get('loop')(
    {
      id: 'polishLoop',
      type: 'loop',
      maxIterations: 10,
      steps: [
        {
          id: 'polishAction',
          type: 'incrementCounter',
          outputKey: 'polishResult'
        }
      ]
    },
    { workflowId: 'story-loop', step: { id: 'polishLoop' }, context, kernel }
  );

  assert.equal(loopResult.status, 'completed');
  assert.equal(loopResult.output.iterations, 3);
  assert.equal(loopResult.output.stopped, true);
});

test('loop step fails when maxIterations exceeded without stopping', async () => {
  const kernel = createRealKernel();
  kernel.config.shouldContinue = () => true; // never stop

  const context = { inputs: {}, outputs: {}, steps: {} };

  const loopResult = await kernel.stepRegistry.get('loop')(
    {
      id: 'infiniteLoop',
      type: 'loop',
      maxIterations: 2,
      onMaxIterationsExceeded: 'fail',
      steps: [{ id: 'action', type: 'noop' }]
    },
    { workflowId: 'story-loop-fail', step: { id: 'infiniteLoop' }, context, kernel }
  );

  assert.equal(loopResult.status, 'failed');
  assert.ok(loopResult.error.message.includes('Loop exceeded max iterations'));
});

// ------------------------------------------------------------------
// Tests — 5. Parallel group with all failure policies
// ------------------------------------------------------------------

test('parallelGroup step executes sub-steps concurrently (waitForRest)', async () => {
  const kernel = createRealKernel();
  const context = { inputs: {}, outputs: {}, steps: {} };

  const result = await kernel.stepRegistry.get('parallelGroup')(
    {
      id: 'parallelWork',
      type: 'parallelGroup',
      failurePolicy: 'waitForRest',
      steps: [
        { id: 'taskA', type: 'noop', outputKey: 'resultA' },
        { id: 'taskB', type: 'noop', outputKey: 'resultB' }
      ]
    },
    { workflowId: 'story-parallel', step: { id: 'parallelWork' }, context, kernel }
  );

  assert.equal(result.status, 'completed');
  assert.equal(result.output.results.length, 2);
  assert.equal(context.steps.taskA.status, 'completed');
  assert.equal(context.steps.taskB.status, 'completed');
});

test('parallelGroup cancelAll policy fails fast on first failure', async () => {
  const kernel = createRealKernel();
  // Register a failing step type
  kernel.stepRegistry.register('alwaysFail', async () => ({ status: 'failed', error: new Error('intentional failure') }));

  const context = { inputs: {}, outputs: {}, steps: {} };

  const result = await kernel.stepRegistry.get('parallelGroup')(
    {
      id: 'parallelFailFast',
      type: 'parallelGroup',
      failurePolicy: 'cancelAll',
      steps: [
        { id: 'taskA', type: 'alwaysFail' },
        { id: 'taskB', type: 'noop' }
      ]
    },
    { workflowId: 'story-parallel-cancel', step: { id: 'parallelFailFast' }, context, kernel }
  );

  assert.equal(result.status, 'failed');
  assert.ok(result.error.message.includes('Parallel group cancelled'));
});

test('parallelGroup ignore policy returns all results including failures', async () => {
  const kernel = createRealKernel();
  kernel.stepRegistry.register('alwaysFail', async () => ({ status: 'failed', error: new Error('intentional failure') }));

  const context = { inputs: {}, outputs: {}, steps: {} };

  const result = await kernel.stepRegistry.get('parallelGroup')(
    {
      id: 'parallelIgnore',
      type: 'parallelGroup',
      failurePolicy: 'ignore',
      steps: [
        { id: 'taskA', type: 'alwaysFail' },
        { id: 'taskB', type: 'noop' }
      ]
    },
    { workflowId: 'story-parallel-ignore', step: { id: 'parallelIgnore' }, context, kernel }
  );

  assert.equal(result.status, 'completed');
  assert.equal(result.output.results.length, 2);
  assert.equal(result.output.failures, 1);
});

// ------------------------------------------------------------------
// Tests — 6. Adapter → Kernel real invocation chain
// ------------------------------------------------------------------

test('StoryOrchestratorKernelAdapter.executePhase invokes real kernel', async () => {
  const events = createEventCollector();
  const agentDispatcher = createMockAgentDispatcher();

  // StoryStateRepositoryAdapter expects repo.createStory / repo.getStoryWithFields etc.
  const mockRepo = {
    createStory: async (workflowId, data) => ({ id: workflowId, ...data }),
    getStoryWithFields: async (workflowId) => ({ id: workflowId, status: 'created' }),
    updateStory: async () => {},
    appendEvent: async () => {},
    listStories: async () => []
  };

  const adapter = new StoryOrchestratorKernelAdapter({
    stateManager: {
      ...mockRepo,
      getStory: async () => null,
      updateWorkflow: async () => {},
      appendWorkflowHistory: async () => {},
      setActiveCheckpoint: async () => {},
      clearActiveCheckpoint: async () => {},
      updatePhase1: async () => {},
      updatePhase2: async () => {},
      updatePhase3: async () => {},
      createStory: async () => ({ id: 'story-adapter-001' }),
      listStories: async () => []
    },
    agentDispatcher,
    chapterOperations: {
      createChapterDraft: async () => ({ content: 'draft', metrics: {} }),
      reviewChapter: async () => ({}),
      reviseChapter: async () => ({}),
      polishChapter: async () => ({ polishedContent: 'polished', metrics: {} }),
      fillDetails: async () => ({}),
      countChapterLength: () => ({ counts: { actualCount: 100 }, validation: { isQualified: true } }),
      _expandChapter: async () => ({ content: 'expanded' })
    },
    contentValidator: {
      validateWorldview: async () => ({}),
      validateCharacters: async () => ({}),
      validatePlot: async () => ({}),
      comprehensiveValidation: async () => ({
        overall: { passed: true, hasCriticalIssues: false, criticalCount: 0 },
        allIssues: []
      }),
      qualityScore: async () => ({ average: 8.5, scores: {}, rawReport: '' })
    },
    config: { USE_WORKFLOW_KERNEL: true }
  });

  await adapter.initialize();

  // Replace kernel's webSocketPusher with our collector
  adapter.kernel.webSocketPusher = events;

  const definition = {
    id: 'adapter-test-wf',
    phases: [{
      id: 'phase1',
      steps: [
        { id: 'step1', type: 'noop' },
        { id: 'step2', type: 'agentCall', agent: 'worldBuilder', input: { prompt: 'test' }, outputKey: 'agentResult' }
      ]
    }]
  };

  const record = await adapter.executePhase('story-adapter-001', 'phase1', definition);

  assert.equal(record.status, EXECUTION_STATES.COMPLETED);
  assert.equal(record.context.steps.step1.status, 'completed');
  assert.equal(record.context.steps.step2.status, 'completed');

  const eventTypes = events.getTypes();
  assert.ok(eventTypes.includes('workflow.started'));
  assert.ok(eventTypes.includes('workflow.completed'));
});

// ------------------------------------------------------------------
// Tests — 7. EventBus event sequence verification
// ------------------------------------------------------------------

test('EventBus emits correct event sequence for multi-step workflow', async () => {
  const events = createEventCollector();
  const kernel = createRealKernel({ webSocketPusher: events });

  // Also subscribe via EventBus directly
  const busEvents = [];
  kernel.onEvent('*', (event) => busEvents.push(event.type));

  const definition = {
    id: 'test-events',
    phases: [{
      id: 'phase1',
      steps: [
        { id: 's1', type: 'noop' },
        { id: 's2', type: 'noop' }
      ]
    }]
  };

  await kernel.execute('story-events', definition);

  const expectedSequence = [
    'workflow.started',
    'workflow.step_started',
    'workflow.step_completed',
    'workflow.step_started',
    'workflow.step_completed',
    'workflow.completed'
  ];

  assert.deepEqual(busEvents, expectedSequence);
});

// ------------------------------------------------------------------
// Tests — 8. State persistence round-trip
// ------------------------------------------------------------------

test('stateRepository receives create and updates during execution', async () => {
  const stateRepo = createInMemoryStateRepository();
  const kernel = createRealKernel({ stateRepository: stateRepo });

  const definition = {
    id: 'test-persist',
    phases: [{
      id: 'phase1',
      steps: [
        { id: 's1', type: 'noop', outputKey: 'out1' }
      ]
    }]
  };

  await kernel.execute('story-persist', definition, { seed: 42 });

  const persisted = await stateRepo.get('story-persist');
  assert.ok(persisted, 'record should be persisted');
  assert.equal(persisted.definitionRef, 'test-persist');
  assert.equal(persisted.context.inputs.seed, 42);
  assert.ok(persisted.context.outputs.out1, 'step output should be persisted');
});

// ------------------------------------------------------------------
// Tests — 9. Step failure → workflow.failed state transition
// ------------------------------------------------------------------

test('unknown step type transitions workflow to failed with correct event', async () => {
  const events = createEventCollector();
  const kernel = createRealKernel({ webSocketPusher: events });

  const definition = {
    id: 'test-fail',
    phases: [{
      id: 'phase1',
      steps: [
        { id: 'badStep', type: 'nonExistentType' }
      ]
    }]
  };

  // Kernel.execute does NOT throw — it captures the error internally and returns a FAILED record
  const record = await kernel.execute('story-fail', definition);

  assert.equal(record.status, EXECUTION_STATES.FAILED);

  const active = kernel.activeWorkflows.get('story-fail');
  assert.ok(active);
  assert.equal(active.record.status, EXECUTION_STATES.FAILED);

  const eventTypes = events.getTypes();
  assert.ok(eventTypes.includes('workflow.failed'));
});

test('step handler returning failed status transitions workflow to failed', async () => {
  const events = createEventCollector();
  const kernel = createRealKernel({ webSocketPusher: events });
  kernel.stepRegistry.register('failStep', async () => ({ status: 'failed', error: new Error('step logic failed') }));

  const definition = {
    id: 'test-step-fail',
    phases: [{
      id: 'phase1',
      steps: [
        { id: 'fs', type: 'failStep' }
      ]
    }]
  };

  // Kernel.execute does NOT throw — it captures the error internally
  const record = await kernel.execute('story-step-fail', definition);

  assert.equal(record.status, EXECUTION_STATES.FAILED);

  const active = kernel.activeWorkflows.get('story-step-fail');
  assert.equal(active.record.status, EXECUTION_STATES.FAILED);

  const eventTypes = events.getTypes();
  assert.ok(eventTypes.includes('workflow.failed'));
  assert.ok(eventTypes.includes('workflow.step_started'));
});

// ------------------------------------------------------------------
// Tests — 10. AgentCallStep input resolution with $ref
// ------------------------------------------------------------------

test('agentCall step resolves $ref inputs from context.outputs', async () => {
  const agentCalls = [];
  const agentDispatcher = createMockAgentDispatcher({
    'summarizer': (agentId, prompt) => {
      agentCalls.push({ agentId, prompt });
      return { content: 'summary-result', markers: [], raw: 'raw' };
    }
  });

  const kernel = createRealKernel({ agentDispatcher });

  // Pre-seed context by executing a noop that stores output, then run agentCall
  const definition = {
    id: 'test-ref',
    phases: [{
      id: 'phase1',
      steps: [
        { id: 'seed', type: 'noop', outputKey: 'seedData' }
      ]
    }]
  };

  const record = await kernel.execute('story-ref', definition);
  record.context.outputs.seedData = { text: 'The quick brown fox' };

  // Now manually run agentCall with $ref input
  const agentResult = await kernel.stepRegistry.get('agentCall')(
    {
      id: 'summarize',
      type: 'agentCall',
      agent: 'summarizer',
      input: { prompt: { $ref: 'ctx.outputs.seedData.text' } }
    },
    { workflowId: 'story-ref', step: { id: 'summarize' }, context: record.context, kernel }
  );

  assert.equal(agentResult.status, 'completed');
  assert.equal(agentCalls.length, 1);
  assert.equal(agentCalls[0].prompt, 'The quick brown fox');
});

// ------------------------------------------------------------------
// Tests — 11. Resume from checkpoint restores execution cursor
// ------------------------------------------------------------------

test('resume continues from next step after checkpoint', async () => {
  const kernel = createRealKernel();

  const definition = {
    id: 'test-cursor',
    phases: [{
      id: 'phase1',
      steps: [
        { id: 'beforeCp', type: 'noop', outputKey: 'before' },
        { id: 'theCheckpoint', type: 'checkpoint', checkpointType: 'generic' },
        { id: 'afterCp', type: 'noop', outputKey: 'after' }
      ]
    }]
  };

  await kernel.execute('story-cursor', definition);

  // Should be waiting at checkpoint
  const beforeResume = kernel.activeWorkflows.get('story-cursor');
  assert.equal(beforeResume.record.executionCursor[1].step, 1); // checkpoint step index

  // Resume
  await kernel.resume('story-cursor', {
    checkpointId: 'theCheckpoint',
    action: 'approve'
  });

  const afterResume = kernel.activeWorkflows.get('story-cursor');
  assert.equal(afterResume.record.status, EXECUTION_STATES.COMPLETED);
  assert.equal(afterResume.record.context.steps.afterCp.status, 'completed');
  // noop returns empty object {}, which is truthy and gets stored under outputKey
  assert.deepEqual(afterResume.record.context.outputs.after, {});
});

// ------------------------------------------------------------------
// Tests — 12. WorkflowValidator rejects invalid definitions before execution
// ------------------------------------------------------------------

test('adapter validate-and-execute rejects unregistered step types', async () => {
  const adapter = new StoryOrchestratorKernelAdapter({
    stateManager: {
      repository: createInMemoryStateRepository(),
      getStory: async () => null,
      updateWorkflow: async () => {},
      appendWorkflowHistory: async () => {},
      setActiveCheckpoint: async () => {},
      clearActiveCheckpoint: async () => {},
      updatePhase1: async () => {},
      updatePhase2: async () => {},
      updatePhase3: async () => {},
      updateStory: async () => {},
      createStory: async () => ({ id: 'story-val-001' }),
      listStories: async () => []
    },
    agentDispatcher: createMockAgentDispatcher(),
    chapterOperations: {},
    contentValidator: {},
    config: { USE_WORKFLOW_KERNEL: true }
  });

  await adapter.initialize();

  const invalidDefinition = {
    id: 'bad-wf',
    phases: [{
      id: 'p1',
      steps: [{ id: 'bad', type: 'notRegistered' }]
    }]
  };

  await assert.rejects(
    async () => adapter.executePhase('story-val-001', 'phase1', invalidDefinition),
    (err) => err.message.includes('Workflow validation failed') && err.message.includes("Step type 'notRegistered' is not registered")
  );
});

// ------------------------------------------------------------------
// Tests — 13. Concurrent workflow isolation
// ------------------------------------------------------------------

test('multiple workflows execute independently without state leakage', async () => {
  const kernel = createRealKernel();

  const definition = {
    id: 'test-isolate',
    phases: [{
      id: 'phase1',
      steps: [
        { id: 'setValue', type: 'noop', outputKey: 'value' }
      ]
    }]
  };

  const recordA = await kernel.execute('story-A', definition);
  const recordB = await kernel.execute('story-B', definition);

  recordA.context.outputs.value = 'alpha';
  recordB.context.outputs.value = 'beta';

  assert.equal(recordA.context.outputs.value, 'alpha');
  assert.equal(recordB.context.outputs.value, 'beta');
  assert.equal(kernel.activeWorkflows.size, 2);
});

// ------------------------------------------------------------------
// Tests — 14. Duplicate workflowId throws
// ------------------------------------------------------------------

test('executing duplicate workflowId throws', async () => {
  const kernel = createRealKernel();
  const definition = { id: 'test-dup', phases: [{ id: 'p1', steps: [{ id: 's1', type: 'noop' }] }] };

  await kernel.execute('story-dup', definition);

  await assert.rejects(
    async () => kernel.execute('story-dup', definition),
    (err) => err.message.includes('Workflow story-dup is already active')
  );
});
