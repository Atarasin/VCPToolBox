const assert = require('node:assert/strict');
const test = require('node:test');

const { StoryOrchestratorKernelAdapter } = require('../../Plugin/StoryOrchestrator/adapters/StoryOrchestratorKernelAdapter');

// ------------------------------------------------------------------
// Mocks
// ------------------------------------------------------------------

function createMockStateManager(overrides = {}) {
  const history = [];
  return {
    repository: {
      createStory: async () => ({}),
      getStoryWithFields: async () => null,
      updateStory: async () => {},
      appendEvent: async () => {},
      listStories: async () => []
    },
    getStory: overrides.getStory || (async () => null),
    updateWorkflow: async (id, patch) => {
      history.push({ type: 'updateWorkflow', id, patch });
    },
    appendWorkflowHistory: async (id, entry) => {
      history.push({ type: 'history', id, entry });
    },
    setActiveCheckpoint: async () => {},
    clearActiveCheckpoint: async () => {},
    updatePhase1: async () => {},
    updatePhase2: async () => {},
    updatePhase3: async () => {},
    updateStory: async () => {},
    createStory: async () => ({ id: 'story-test-001' }),
    listStories: async () => [],
    _history: history
  };
}

function createMockAgentDispatcher() {
  return {
    delegate: async (agentType, prompt, options) => ({ content: 'mock response' }),
    initialize: async () => {}
  };
}

function createMockChapterOperations() {
  return {
    createChapterDraft: async () => ({ content: 'draft', metrics: {} }),
    reviewChapter: async () => ({}),
    reviseChapter: async () => ({}),
    polishChapter: async () => ({ polishedContent: 'polished', metrics: {} }),
    fillDetails: async () => ({}),
    countChapterLength: () => ({ counts: { actualCount: 100 }, validation: { isQualified: true } }),
    _expandChapter: async () => ({ content: 'expanded' })
  };
}

function createMockContentValidator() {
  return {
    validateWorldview: async () => ({}),
    validateCharacters: async () => ({}),
    validatePlot: async () => ({}),
    comprehensiveValidation: async () => ({
      overall: { passed: true, hasCriticalIssues: false, criticalCount: 0 },
      allIssues: []
    }),
    qualityScore: async () => ({ average: 8.5, scores: {}, rawReport: '' })
  };
}

// ------------------------------------------------------------------
// Tests — Initialization
// ------------------------------------------------------------------

test('adapter initializes with feature flag enabled', async () => {
  const adapter = new StoryOrchestratorKernelAdapter({
    stateManager: createMockStateManager(),
    agentDispatcher: createMockAgentDispatcher(),
    chapterOperations: createMockChapterOperations(),
    contentValidator: createMockContentValidator(),
    config: { USE_WORKFLOW_KERNEL: true }
  });

  await adapter.initialize();

  assert.ok(adapter.kernel, 'kernel should be initialized');
  assert.equal(adapter.useKernel, true, 'useKernel should be true');
  assert.ok(adapter.eventAdapter, 'eventAdapter should be set');
  assert.equal(typeof adapter.kernel.config.shouldContinue, 'function', 'shouldContinue should be injected into kernel config');
  assert.ok(adapter.kernel.stepRegistry.handlers.has('agentCall'), 'bridge step should be registered');
  assert.ok(adapter.kernel.stepRegistry.handlers.has('checkpoint'), 'kernel primitive step should be registered');
  assert.ok(adapter.kernel.stepRegistry.handlers.has('schemaValidate'), 'story validation glue should be registered');
  assert.ok(adapter.kernel.stepRegistry.handlers.has('finalEdit'), 'story generation glue should be registered');
});

test('adapter initializes with feature flag disabled', async () => {
  const adapter = new StoryOrchestratorKernelAdapter({
    stateManager: createMockStateManager(),
    agentDispatcher: createMockAgentDispatcher(),
    chapterOperations: createMockChapterOperations(),
    contentValidator: createMockContentValidator(),
    config: { USE_WORKFLOW_KERNEL: false }
  });

  await adapter.initialize();

  assert.equal(adapter.useKernel, false, 'useKernel should be false');
  assert.equal(adapter.kernel, null, 'kernel should not be initialized');
});

// ------------------------------------------------------------------
// Tests — shouldContinue
// ------------------------------------------------------------------

test('shouldContinue returns false when max iterations reached', () => {
  const adapter = new StoryOrchestratorKernelAdapter({
    stateManager: createMockStateManager(),
    agentDispatcher: createMockAgentDispatcher(),
    chapterOperations: createMockChapterOperations(),
    contentValidator: createMockContentValidator(),
    config: {}
  });

  const context = {
    inputs: { maxIterations: 3 },
    outputs: { iterationCount: 3 }
  };

  assert.equal(adapter.shouldContinue(context), false);
});

test('shouldContinue returns true when quality is below threshold', () => {
  const adapter = new StoryOrchestratorKernelAdapter({
    stateManager: createMockStateManager(),
    agentDispatcher: createMockAgentDispatcher(),
    chapterOperations: createMockChapterOperations(),
    contentValidator: createMockContentValidator(),
    config: {}
  });

  const context = {
    inputs: { maxIterations: 5, qualityThreshold: 8.0 },
    outputs: { iterationCount: 1, averageQualityScore: 6.5 }
  };

  assert.equal(adapter.shouldContinue(context), true);
});

test('shouldContinue returns false when quality threshold is met', () => {
  const adapter = new StoryOrchestratorKernelAdapter({
    stateManager: createMockStateManager(),
    agentDispatcher: createMockAgentDispatcher(),
    chapterOperations: createMockChapterOperations(),
    contentValidator: createMockContentValidator(),
    config: {}
  });

  const context = {
    inputs: { maxIterations: 5, qualityThreshold: 8.0 },
    outputs: { iterationCount: 2, averageQualityScore: 8.5 }
  };

  assert.equal(adapter.shouldContinue(context), false);
});

test('shouldContinue returns false when explicit stop signal is present', () => {
  const adapter = new StoryOrchestratorKernelAdapter({
    stateManager: createMockStateManager(),
    agentDispatcher: createMockAgentDispatcher(),
    chapterOperations: createMockChapterOperations(),
    contentValidator: createMockContentValidator(),
    config: {}
  });

  const context = {
    inputs: { maxIterations: 5 },
    outputs: { iterationCount: 1, stopLoop: true }
  };

  assert.equal(adapter.shouldContinue(context), false);
});

test('shouldContinue defaults to allowing iterations up to max', () => {
  const adapter = new StoryOrchestratorKernelAdapter({
    stateManager: createMockStateManager(),
    agentDispatcher: createMockAgentDispatcher(),
    chapterOperations: createMockChapterOperations(),
    contentValidator: createMockContentValidator(),
    config: {}
  });

  const context = {
    inputs: {},
    outputs: { iterationCount: 0 }
  };

  // Default maxIterations is 5, iterationCount is 0 → should continue
  assert.equal(adapter.shouldContinue(context), true);
});

// ------------------------------------------------------------------
// Tests — State Mapping
// ------------------------------------------------------------------

test('mapStoryStateToKernelState: running phase1 → running', () => {
  const adapter = new StoryOrchestratorKernelAdapter({
    stateManager: createMockStateManager(),
    agentDispatcher: createMockAgentDispatcher(),
    chapterOperations: createMockChapterOperations(),
    contentValidator: createMockContentValidator(),
    config: {}
  });

  const story = {
    workflow: { state: 'running', currentPhase: 'phase1' },
    phase1: { status: 'running' }
  };

  assert.equal(adapter.mapStoryStateToKernelState(story), 'running');
});

test('mapStoryStateToKernelState: waiting checkpoint → waiting_checkpoint', () => {
  const adapter = new StoryOrchestratorKernelAdapter({
    stateManager: createMockStateManager(),
    agentDispatcher: createMockAgentDispatcher(),
    chapterOperations: createMockChapterOperations(),
    contentValidator: createMockContentValidator(),
    config: {}
  });

  const story = {
    workflow: { state: 'idle' },
    phase1: { status: 'pending_confirmation' }
  };

  assert.equal(adapter.mapStoryStateToKernelState(story), 'waiting_checkpoint');
});

test('mapStoryStateToKernelState: completed story → completed', () => {
  const adapter = new StoryOrchestratorKernelAdapter({
    stateManager: createMockStateManager(),
    agentDispatcher: createMockAgentDispatcher(),
    chapterOperations: createMockChapterOperations(),
    contentValidator: createMockContentValidator(),
    config: {}
  });

  const story = {
    workflow: { state: 'completed' },
    phase3: { userConfirmed: true }
  };

  assert.equal(adapter.mapStoryStateToKernelState(story), 'completed');
});

test('mapStoryStateToKernelState: failed phase → failed', () => {
  const adapter = new StoryOrchestratorKernelAdapter({
    stateManager: createMockStateManager(),
    agentDispatcher: createMockAgentDispatcher(),
    chapterOperations: createMockChapterOperations(),
    contentValidator: createMockContentValidator(),
    config: {}
  });

  const story = {
    workflow: { state: 'idle' },
    phase2: { status: 'failed' }
  };

  assert.equal(adapter.mapStoryStateToKernelState(story), 'failed');
});

test('mapKernelStateToStoryState: running phase2 → phase2_running', () => {
  const adapter = new StoryOrchestratorKernelAdapter({
    stateManager: createMockStateManager(),
    agentDispatcher: createMockAgentDispatcher(),
    chapterOperations: createMockChapterOperations(),
    contentValidator: createMockContentValidator(),
    config: {}
  });

  const result = adapter.mapKernelStateToStoryState('running', 'phase2');
  assert.equal(result.status, 'phase2_running');
  assert.equal(result.phase, 'phase2');
});

test('mapKernelStateToStoryState: waiting_checkpoint phase3 → phase3_waiting_checkpoint', () => {
  const adapter = new StoryOrchestratorKernelAdapter({
    stateManager: createMockStateManager(),
    agentDispatcher: createMockAgentDispatcher(),
    chapterOperations: createMockChapterOperations(),
    contentValidator: createMockContentValidator(),
    config: {}
  });

  const result = adapter.mapKernelStateToStoryState('waiting_checkpoint', 'phase3');
  assert.equal(result.status, 'phase3_waiting_checkpoint');
  assert.equal(result.phase, 'phase3');
});

test('mapKernelStateToStoryState: completed → completed', () => {
  const adapter = new StoryOrchestratorKernelAdapter({
    stateManager: createMockStateManager(),
    agentDispatcher: createMockAgentDispatcher(),
    chapterOperations: createMockChapterOperations(),
    contentValidator: createMockContentValidator(),
    config: {}
  });

  const result = adapter.mapKernelStateToStoryState('completed');
  assert.equal(result.status, 'completed');
  assert.equal(result.phase, 'completed');
});

// ------------------------------------------------------------------
// Tests — Event Emission
// ------------------------------------------------------------------

test('event adapter maps workflow.started to workflow_started', async () => {
  const events = [];
  const adapter = new StoryOrchestratorKernelAdapter({
    stateManager: createMockStateManager(),
    agentDispatcher: createMockAgentDispatcher(),
    chapterOperations: createMockChapterOperations(),
    contentValidator: createMockContentValidator(),
    config: { USE_WORKFLOW_KERNEL: true }
  });

  await adapter.initialize();

  // Replace event sink to capture events
  adapter.eventAdapter.eventSink = {
    push: async (workflowId, event) => {
      events.push({ workflowId, event });
    }
  };
  adapter.eventAdapter.registerWorkflow('story-001', { phases: [{ steps: [] }] });

  adapter.eventAdapter.onKernelEvent('story-001', {
    type: 'workflow.started',
    payload: { definitionRef: 'test' },
    timestamp: new Date().toISOString()
  });

  assert.equal(events.length, 1);
  assert.equal(events[0].event.eventType, 'workflow_started');
});

test('event adapter maps checkpoint_pending to checkpoint_created and checkpoint_pending', async () => {
  const events = [];
  const adapter = new StoryOrchestratorKernelAdapter({
    stateManager: createMockStateManager(),
    agentDispatcher: createMockAgentDispatcher(),
    chapterOperations: createMockChapterOperations(),
    contentValidator: createMockContentValidator(),
    config: { USE_WORKFLOW_KERNEL: true }
  });

  await adapter.initialize();

  adapter.eventAdapter.eventSink = {
    push: async (workflowId, event) => {
      events.push({ workflowId, event });
    }
  };
  adapter.eventAdapter.registerWorkflow('story-002', { phases: [{ steps: [] }] });

  adapter.eventAdapter.onKernelEvent('story-002', {
    type: 'workflow.checkpoint_pending',
    payload: { checkpointId: 'cp-1', checkpointType: 'phase1' },
    timestamp: new Date().toISOString()
  });

  const eventTypes = events.map(e => e.event.eventType);
  assert.ok(eventTypes.includes('checkpoint_created'), `expected checkpoint_created in ${JSON.stringify(eventTypes)}`);
  assert.ok(eventTypes.includes('checkpoint_pending'), `expected checkpoint_pending in ${JSON.stringify(eventTypes)}`);
});

test('event adapter maps workflow.completed to workflow_completed', async () => {
  const events = [];
  const adapter = new StoryOrchestratorKernelAdapter({
    stateManager: createMockStateManager(),
    agentDispatcher: createMockAgentDispatcher(),
    chapterOperations: createMockChapterOperations(),
    contentValidator: createMockContentValidator(),
    config: { USE_WORKFLOW_KERNEL: true }
  });

  await adapter.initialize();

  adapter.eventAdapter.eventSink = {
    push: async (workflowId, event) => {
      events.push({ workflowId, event });
    }
  };
  adapter.eventAdapter.registerWorkflow('story-003', { phases: [{ steps: [] }] });

  adapter.eventAdapter.onKernelEvent('story-003', {
    type: 'workflow.completed',
    payload: { outputs: {} },
    timestamp: new Date().toISOString()
  });

  assert.equal(events.length >= 1, true);
  assert.ok(events.some(e => e.event.eventType === 'workflow_completed'));
});

test('event adapter maps workflow.step_failed to phase_failed', async () => {
  const events = [];
  const adapter = new StoryOrchestratorKernelAdapter({
    stateManager: createMockStateManager(),
    agentDispatcher: createMockAgentDispatcher(),
    chapterOperations: createMockChapterOperations(),
    contentValidator: createMockContentValidator(),
    config: { USE_WORKFLOW_KERNEL: true }
  });

  await adapter.initialize();

  adapter.eventAdapter.eventSink = {
    push: async (workflowId, event) => {
      events.push({ workflowId, event });
    }
  };
  adapter.eventAdapter.registerWorkflow('story-004', { phases: [{ steps: [] }] });

  adapter.eventAdapter.onKernelEvent('story-004', {
    type: 'workflow.step_failed',
    payload: { stepId: 's1', error: 'boom' },
    timestamp: new Date().toISOString()
  });

  assert.ok(events.some(e => e.event.eventType === 'phase_failed'));
});

test('event adapter maps workflow.checkpoint_rejected for chapter to chapter_checkpoint_rejected', async () => {
  const events = [];
  const adapter = new StoryOrchestratorKernelAdapter({
    stateManager: createMockStateManager(),
    agentDispatcher: createMockAgentDispatcher(),
    chapterOperations: createMockChapterOperations(),
    contentValidator: createMockContentValidator(),
    config: { USE_WORKFLOW_KERNEL: true }
  });

  await adapter.initialize();

  adapter.eventAdapter.eventSink = {
    push: async (workflowId, event) => {
      events.push({ workflowId, event });
    }
  };
  adapter.eventAdapter.registerWorkflow('story-005', { phases: [{ steps: [] }] });

  adapter.eventAdapter.onKernelEvent('story-005', {
    type: 'workflow.checkpoint_rejected',
    payload: { checkpointId: 'cp-ch-1', checkpointType: 'chapter_retry' },
    timestamp: new Date().toISOString()
  });

  assert.ok(events.some(e => e.event.eventType === 'chapter_checkpoint_rejected'));
});

test('event adapter maps workflow.checkpoint_timeout to checkpoint_auto_approved', async () => {
  const events = [];
  const adapter = new StoryOrchestratorKernelAdapter({
    stateManager: createMockStateManager(),
    agentDispatcher: createMockAgentDispatcher(),
    chapterOperations: createMockChapterOperations(),
    contentValidator: createMockContentValidator(),
    config: { USE_WORKFLOW_KERNEL: true }
  });

  await adapter.initialize();

  adapter.eventAdapter.eventSink = {
    push: async (workflowId, event) => {
      events.push({ workflowId, event });
    }
  };
  adapter.eventAdapter.registerWorkflow('story-006', { phases: [{ steps: [] }] });

  adapter.eventAdapter.onKernelEvent('story-006', {
    type: 'workflow.checkpoint_timeout',
    payload: { checkpointId: 'cp-timeout', action: 'timeout' },
    timestamp: new Date().toISOString()
  });

  assert.ok(events.some(e => e.event.eventType === 'checkpoint_auto_approved'));
});

// ------------------------------------------------------------------
// Tests — Retry Context Sync
// ------------------------------------------------------------------

test('syncRetryContext writes retry context to stateManager', async () => {
  const stateManager = createMockStateManager();
  const adapter = new StoryOrchestratorKernelAdapter({
    stateManager,
    agentDispatcher: createMockAgentDispatcher(),
    chapterOperations: createMockChapterOperations(),
    contentValidator: createMockContentValidator(),
    config: {}
  });

  const kernelRecord = {
    retryContext: {
      phase: 'phase2',
      step: 'produceChapters',
      attempt: 2,
      maxAttempts: 3,
      lastError: 'Validation failed'
    }
  };

  await adapter.syncRetryContext('story-retry-001', kernelRecord);

  const updateEntry = stateManager._history.find(h => h.type === 'updateWorkflow');
  assert.ok(updateEntry, 'updateWorkflow should have been called');
  assert.equal(updateEntry.patch.retryContext.phase, 'phase2');
  assert.equal(updateEntry.patch.retryContext.attempt, 2);
  assert.equal(updateEntry.patch.retryContext.lastError, 'Validation failed');
});

// ------------------------------------------------------------------
// Tests — Backward Compatibility
// ------------------------------------------------------------------

test('executePhase throws when kernel is disabled', async () => {
  const adapter = new StoryOrchestratorKernelAdapter({
    stateManager: createMockStateManager(),
    agentDispatcher: createMockAgentDispatcher(),
    chapterOperations: createMockChapterOperations(),
    contentValidator: createMockContentValidator(),
    config: { USE_WORKFLOW_KERNEL: false }
  });

  await adapter.initialize();

  await assert.rejects(
    async () => adapter.executePhase('story-001', 'phase1', { phases: [] }),
    (err) => err.message.includes('WorkflowKernel is not enabled')
  );
});

test('resume throws when kernel is disabled', async () => {
  const adapter = new StoryOrchestratorKernelAdapter({
    stateManager: createMockStateManager(),
    agentDispatcher: createMockAgentDispatcher(),
    chapterOperations: createMockChapterOperations(),
    contentValidator: createMockContentValidator(),
    config: { USE_WORKFLOW_KERNEL: false }
  });

  await adapter.initialize();

  await assert.rejects(
    async () => adapter.resume('story-001', { checkpointId: 'cp-1' }),
    (err) => err.message.includes('WorkflowKernel is not enabled')
  );
});

test('recover throws when kernel is disabled', async () => {
  const adapter = new StoryOrchestratorKernelAdapter({
    stateManager: createMockStateManager(),
    agentDispatcher: createMockAgentDispatcher(),
    chapterOperations: createMockChapterOperations(),
    contentValidator: createMockContentValidator(),
    config: { USE_WORKFLOW_KERNEL: false }
  });

  await adapter.initialize();

  await assert.rejects(
    async () => adapter.recover('story-001', { recoveryAction: 'continue' }),
    (err) => err.message.includes('WorkflowKernel is not enabled')
  );
});

test('getStatus returns null when kernel is disabled', async () => {
  const adapter = new StoryOrchestratorKernelAdapter({
    stateManager: createMockStateManager(),
    agentDispatcher: createMockAgentDispatcher(),
    chapterOperations: createMockChapterOperations(),
    contentValidator: createMockContentValidator(),
    config: { USE_WORKFLOW_KERNEL: false }
  });

  await adapter.initialize();

  const status = await adapter.getStatus('story-001');
  assert.equal(status, null);
});

test('getStatus projects kernel-authored phase, step and recovery cursor', async () => {
  const adapter = new StoryOrchestratorKernelAdapter({
    stateManager: createMockStateManager(),
    agentDispatcher: createMockAgentDispatcher(),
    chapterOperations: createMockChapterOperations(),
    contentValidator: createMockContentValidator(),
    config: { USE_WORKFLOW_KERNEL: true }
  });

  adapter.kernel = {
    activeWorkflows: new Map([
      ['story-001', {
        definition: {
          phases: [{
            id: 'phase2',
            steps: [{ id: 'generateOutline', type: 'noop' }]
          }]
        },
        record: {
          status: 'running',
          executionCursor: [{ phase: 0 }, { step: 0 }],
          checkpointState: null,
          recoveryCursor: { phaseId: 'phase2', stepId: 'generateOutline' }
        }
      }]
    ]),
    getRunStatus: async () => ({
      state: 'running',
      currentPhaseId: 'phase2',
      currentStepId: 'generateOutline',
      checkpointState: null,
      recoveryCursor: { phaseId: 'phase2', stepId: 'generateOutline' },
      recentEvents: []
    })
  };

  const status = await adapter.getStatus('story-001');

  assert.equal(status.state, 'running');
  assert.equal(status.currentPhase, 'phase2');
  assert.equal(status.currentStep, 'generateOutline');
  assert.equal(status.recoveryCursor.stepId, 'generateOutline');
});

test('_extractBusinessPayload projects business snapshot fields through shared contracts', () => {
  const adapter = new StoryOrchestratorKernelAdapter({
    stateManager: createMockStateManager(),
    agentDispatcher: createMockAgentDispatcher(),
    chapterOperations: createMockChapterOperations(),
    contentValidator: createMockContentValidator(),
    config: {}
  });

  const payload = adapter._extractBusinessPayload('phase2', {
    outputs: {
      outline: { chapters: [{ title: 'ch1' }] },
      chaptersResult: {
        chapters: [{ number: 1, content: 'draft' }],
        completedCount: 1,
        totalWordCount: 1200
      }
    }
  });

  assert.deepEqual(payload, {
    outline: { chapters: [{ title: 'ch1' }] },
    chapters: [{ number: 1, content: 'draft' }],
    currentChapter: 1,
    userConfirmed: false,
    checkpointId: null,
    status: 'running'
  });
});

// ------------------------------------------------------------------
// Tests — Integration via real kernel with mocked repository
// ------------------------------------------------------------------

test('executeWorkflow validates definition before execution', async () => {
  const adapter = new StoryOrchestratorKernelAdapter({
    stateManager: createMockStateManager(),
    agentDispatcher: createMockAgentDispatcher(),
    chapterOperations: createMockChapterOperations(),
    contentValidator: createMockContentValidator(),
    config: { USE_WORKFLOW_KERNEL: true }
  });

  await adapter.initialize();

  // Provide an invalid definition (unknown step type)
  const invalidDefinition = {
    id: 'test-wf',
    phases: [{
      id: 'p1',
      steps: [{ id: 'badStep', type: 'nonExistentStepType' }]
    }]
  };

  await assert.rejects(
    async () => adapter.executePhase('story-bad', 'phase1', invalidDefinition),
    (err) => err.message.includes('Workflow validation failed')
  );
});

test('kernel compatibility bridge exposes the full event type list', async () => {
  const adapter = new StoryOrchestratorKernelAdapter({
    stateManager: createMockStateManager(),
    agentDispatcher: createMockAgentDispatcher(),
    chapterOperations: createMockChapterOperations(),
    contentValidator: createMockContentValidator(),
    config: { USE_WORKFLOW_KERNEL: true }
  });

  await adapter.initialize();

  const eventTypes = adapter._getKernelCompatibilityEventTypes();
  assert.equal(eventTypes.length, 14);
  assert.ok(eventTypes.includes('workflow.started'));
  assert.ok(eventTypes.includes('workflow.checkpoint_pending'));
  assert.ok(eventTypes.includes('workflow.completed'));
  assert.ok(eventTypes.includes('workflow.rollback'));
});
