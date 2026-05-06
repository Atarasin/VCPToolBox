'use strict';

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert');
const { mock } = require('node:test');

const { WorkflowEngine } = require('../core/WorkflowEngine');

function createStory(overrides = {}) {
  return {
    id: 'story-123',
    status: 'draft',
    config: {
      storyPrompt: '一个关于异常 AI 扩散的测试故事',
      targetWordCount: { min: 2500, max: 3500 },
      genre: '科幻',
      stylePreference: '硬科幻'
    },
    phase1: {
      userConfirmed: false,
      checkpointId: null,
      status: 'pending'
    },
    phase2: {
      userConfirmed: false,
      checkpointId: null,
      status: 'pending'
    },
    phase3: {
      userConfirmed: false,
      checkpointId: null,
      status: 'pending'
    },
    workflow: {
      state: 'idle',
      currentPhase: 'phase1',
      currentStep: null,
      activeCheckpoint: null,
      retryContext: {
        phase: null,
        step: null,
        attempt: 0,
        maxAttempts: 4,
        lastError: null
      },
      history: [],
      runToken: 'existing-run-token'
    },
    ...overrides
  };
}

function createMockStateManager(initialStory) {
  let story = initialStory;

  return {
    initialize: mock.fn(async () => {}),
    getStory: mock.fn(async (storyId) => (story && story.id === storyId ? story : null)),
    updateStory: mock.fn(async (_storyId, updates) => {
      story = {
        ...story,
        ...updates
      };
      return story;
    }),
    updateWorkflow: mock.fn(async (_storyId, updates) => {
      story.workflow = {
        ...(story.workflow || {}),
        ...updates,
        retryContext: updates.retryContext !== undefined
          ? { ...(story.workflow?.retryContext || {}), ...updates.retryContext }
          : story.workflow?.retryContext
      };
      return story;
    }),
    getWorkflowCompatibilityView: mock.fn(async (storyId) => {
      if (!story || story.id !== storyId) {
        return null;
      }
      return story.workflow;
    }),
    __getStory: () => story
  };
}

describe('WorkflowEngine', () => {
  let story;
  let stateManager;
  let engine;

  beforeEach(() => {
    story = createStory();
    stateManager = createMockStateManager(story);
    engine = new WorkflowEngine({
      stateManager,
      agentDispatcher: { dispatch: mock.fn() },
      chapterOperations: {},
      contentValidator: {},
      config: {
        MAX_PHASE_RETRY_ATTEMPTS: 4,
        USER_CHECKPOINT_TIMEOUT_MS: 1000
      }
    });
  });

  describe('constructor()', () => {
    it('keeps WorkflowEngine as a shell without constructing legacy phase-class runners', () => {
      assert.strictEqual(engine.initialized, false);
      assert.deepStrictEqual(engine.phases, {});
      assert.strictEqual(engine.webSocketPusher, null);
      assert.strictEqual(engine.kernelAdapter, null);
    });

    it('exposes compatibility surface classifications after phase-class retirement', () => {
      const report = engine.getCompatibilitySurfaceReport();
      const workflowEngineSurface = report.find((item) => item.id === 'workflow-engine');

      assert.ok(Array.isArray(report));
      assert.ok(workflowEngineSurface);
      assert.strictEqual(report.length, 1);
      assert.strictEqual(workflowEngineSurface.state, 'retain-as-shell');
      assert.ok(!report.find((item) => item.id === 'phase1-world-building'));
      assert.strictEqual(WorkflowEngine.compatibilitySurface.state, 'retain-as-shell');
    });

    it('binds an explicitly provided kernel adapter instead of constructing one implicitly', async () => {
      const adapter = {
        initialize: mock.fn(async () => {}),
        getStatus: mock.fn(async () => null)
      };

      engine.bindKernelAdapter(adapter);
      await engine.initialize();

      assert.strictEqual(engine.kernelAdapter, adapter);
      assert.strictEqual(adapter.initialize.mock.calls.length, 1);
    });

    it('does not construct a hidden control plane when initialized without a bound adapter', async () => {
      await engine.initialize();

      assert.strictEqual(engine.initialized, true);
      assert.strictEqual(engine.kernelAdapter, null);
    });
  });

  describe('start(storyId)', () => {
    it('delegates workflow start through the kernel facade using story config inputs', async () => {
      engine.kernelAdapter = {
        executeWorkflow: mock.fn(async () => ({ status: 'waiting_checkpoint' })),
        getStatus: mock.fn(async () => ({
          state: 'waiting_checkpoint',
          currentPhase: 'phase1',
          currentStep: 'checkpointPhase1',
          activeCheckpoint: 'cp-kernel-start',
          recoveryCursor: { phaseId: 'phase1', stepId: 'checkpointPhase1' }
        }))
      };

      const result = await engine.start('story-123');

      assert.strictEqual(engine.kernelAdapter.executeWorkflow.mock.calls.length, 1);
      assert.deepStrictEqual(engine.kernelAdapter.executeWorkflow.mock.calls[0].arguments[1], {
        storyId: 'story-123',
        storyPrompt: '一个关于异常 AI 扩散的测试故事',
        targetWordCount: { min: 2500, max: 3500 },
        genre: '科幻',
        stylePreference: '硬科幻'
      });
      assert.strictEqual(result.status, 'waiting_checkpoint');
      assert.strictEqual(result.currentPhase, 'phase1');
      assert.deepStrictEqual(result.activeCheckpoint, { checkpointId: 'cp-kernel-start' });
    });

    it('rejects unsupported start when the kernel control plane is unavailable', async () => {
      const result = await engine.start('story-123');

      assert.strictEqual(result.status, 'error');
      assert.match(result.error, /requires WorkflowKernel control plane/i);
    });
  });

  describe('resume(storyId, checkpointApproval)', () => {
    it('rejects mismatched checkpoint ids before delegation', async () => {
      story.workflow.state = 'waiting_checkpoint';
      story.workflow.activeCheckpoint = {
        id: 'cp-expected',
        phase: 'phase1',
        status: 'pending'
      };
      engine.kernelAdapter = {
        resume: mock.fn(async () => ({ status: 'running' })),
        getStatus: mock.fn(async () => ({ state: 'running', currentPhase: 'phase2', currentStep: 'outline' }))
      };

      const result = await engine.resume('story-123', {
        checkpointId: 'cp-other',
        approval: true
      });

      assert.strictEqual(result.status, 'error');
      assert.match(result.error, /Checkpoint mismatch/);
      assert.strictEqual(engine.kernelAdapter.resume.mock.calls.length, 0);
    });

    it('delegates checkpoint approval to the kernel facade', async () => {
      story.workflow.state = 'waiting_checkpoint';
      story.workflow.currentPhase = 'phase2';
      story.workflow.activeCheckpoint = {
        id: 'cp-kernel-resume',
        phase: 'phase2',
        type: 'phase2_outline_confirmation',
        status: 'pending'
      };
      engine.kernelAdapter = {
        resume: mock.fn(async () => ({ status: 'running' })),
        getStatus: mock.fn(async () => ({
          state: 'running',
          currentPhase: 'phase2',
          currentStep: 'generateOutline',
          activeCheckpoint: null,
          recoveryCursor: { phaseId: 'phase2', stepId: 'generateOutline' }
        }))
      };

      const result = await engine.resume('story-123', {
        checkpointId: 'cp-kernel-resume',
        approval: true,
        feedback: 'approved'
      });

      assert.strictEqual(engine.kernelAdapter.resume.mock.calls.length, 1);
      assert.deepStrictEqual(engine.kernelAdapter.resume.mock.calls[0].arguments[1], {
        checkpointId: 'cp-kernel-resume',
        approval: true,
        feedback: 'approved',
        reason: undefined,
        chapter_number: undefined
      });
      assert.strictEqual(result.status, 'running');
      assert.strictEqual(result.currentPhase, 'phase2');
      assert.deepStrictEqual(result.recoveryCursor, { phaseId: 'phase2', stepId: 'generateOutline' });
    });
  });

  describe('retryPhase(storyId, phaseName, reason)', () => {
    it('delegates restart requests to kernel recovery once retry limits allow it', async () => {
      story.workflow.retryContext = {
        phase: 'phase2',
        step: 'draft',
        attempt: 1,
        maxAttempts: 4,
        lastError: 'old error'
      };
      engine.kernelAdapter = {
        recover: mock.fn(async () => ({ status: 'running' })),
        getStatus: mock.fn(async () => ({
          state: 'running',
          currentPhase: 'phase2',
          currentStep: 'generateOutline',
          activeCheckpoint: null,
          recoveryCursor: { phaseId: 'phase2' }
        }))
      };

      const result = await engine.retryPhase('story-123', 'phase2', 'temporary failure');

      assert.strictEqual(engine.kernelAdapter.recover.mock.calls.length, 1);
      assert.deepStrictEqual(engine.kernelAdapter.recover.mock.calls[0].arguments[1], {
        recoveryAction: 'restart_phase',
        targetPhase: 'phase2',
        feedback: 'temporary failure'
      });
      assert.strictEqual(result.currentPhase, 'phase2');
    });

    it('fails once max retry attempts are exceeded', async () => {
      story.workflow.retryContext = {
        phase: 'phase1',
        step: 'initial',
        attempt: 4,
        maxAttempts: 4,
        lastError: 'persistent error'
      };
      engine.kernelAdapter = {
        recover: mock.fn(async () => ({ status: 'running' })),
        getStatus: mock.fn(async () => ({ state: 'running', currentPhase: 'phase1', currentStep: 'initial' }))
      };

      const result = await engine.retryPhase('story-123', 'phase1', 'still broken');

      assert.strictEqual(result.status, 'failed');
      assert.match(result.error, /Max retry attempts/);
      assert.strictEqual(engine.kernelAdapter.recover.mock.calls.length, 0);
    });
  });

  describe('recover(storyId, options)', () => {
    it('delegates continue and rollback semantics to the kernel facade', async () => {
      story.workflow.state = 'failed';
      story.workflow.currentPhase = 'phase3';
      engine.kernelAdapter = {
        recover: mock.fn(async () => ({ status: 'running' })),
        getStatus: mock.fn(async () => ({
          state: 'running',
          currentPhase: 'phase2',
          currentStep: 'generateOutline',
          activeCheckpoint: null,
          recoveryCursor: { phaseId: 'phase2' }
        }))
      };

      const result = await engine.recover('story-123', {
        recoveryAction: 'rollback',
        targetCheckpoint: 'cp-kernel-rollback'
      });

      assert.strictEqual(engine.kernelAdapter.recover.mock.calls.length, 1);
      assert.deepStrictEqual(engine.kernelAdapter.recover.mock.calls[0].arguments[1], {
        recoveryAction: 'rollback',
        targetCheckpoint: 'cp-kernel-rollback'
      });
      assert.strictEqual(result.currentPhase, 'phase2');
      assert.deepStrictEqual(result.recoveryCursor, { phaseId: 'phase2' });
    });

    it('returns an explicit compatibility error when recover is called without a control plane', async () => {
      const result = await engine.recover('story-123', { recoveryAction: 'continue' });

      assert.strictEqual(result.status, 'error');
      assert.match(result.error, /requires WorkflowKernel control plane/i);
    });
  });

  describe('handleChapterRetry(storyId, args)', () => {
    it('rewrites chapter retry into checkpoint rejection through resume', async () => {
      story.workflow.activeCheckpoint = {
        id: 'cp-phase2-chapter',
        phase: 'phase2',
        type: 'phase2_chapter_retry_confirmation',
        status: 'pending'
      };
      engine.kernelAdapter = {
        resume: mock.fn(async () => ({ status: 'retrying' })),
        getStatus: mock.fn(async () => ({
          state: 'retrying',
          currentPhase: 'phase2',
          currentStep: 'retryChapter',
          activeCheckpoint: null,
          recoveryCursor: null
        }))
      };

      const result = await engine.handleChapterRetry('story-123', {
        phase: 'phase2',
        chapter_number: 2,
        feedback: '重写第二章'
      });

      assert.strictEqual(engine.kernelAdapter.resume.mock.calls.length, 1);
      assert.deepStrictEqual(engine.kernelAdapter.resume.mock.calls[0].arguments[1], {
        checkpointId: 'cp-phase2-chapter',
        approval: false,
        feedback: '重写第二章',
        reason: 'Manual chapter retry requested for phase2 chapter 2',
        chapter_number: 2
      });
      assert.strictEqual(result.status, 'retrying');
      assert.strictEqual(result.currentPhase, 'phase2');
    });
  });

  describe('getWorkflowStatus(storyId)', () => {
    it('prefers kernel runtime status while preserving compatibility retry context', async () => {
      story.workflow.retryContext = {
        phase: 'phase2',
        step: 'generateOutline',
        attempt: 2,
        maxAttempts: 4,
        lastError: 'temporary failure'
      };
      engine.kernelAdapter = {
        getStatus: mock.fn(async () => ({
          state: 'waiting_checkpoint',
          currentPhase: 'phase2',
          currentStep: 'checkpointOutline',
          activeCheckpoint: 'cp-phase2-outline',
          recoveryCursor: { phaseId: 'phase2', stepId: 'checkpointOutline' }
        }))
      };

      const status = await engine.getWorkflowStatus('story-123');

      assert.strictEqual(status.state, 'waiting_checkpoint');
      assert.strictEqual(status.currentPhase, 'phase2');
      assert.strictEqual(status.currentStep, 'checkpointOutline');
      assert.strictEqual(status.activeCheckpoint, 'cp-phase2-outline');
      assert.strictEqual(status.retryContext.attempt, 2);
      assert.deepStrictEqual(status.recoveryCursor, { phaseId: 'phase2', stepId: 'checkpointOutline' });
    });
  });

  describe('checkExpiredCheckpoints()', () => {
    it('reports timeout continuation as kernel-owned and skips legacy scanning', async () => {
      engine.kernelAdapter = {
        getStatus: mock.fn(async () => null)
      };

      const result = await engine.checkExpiredCheckpoints();

      assert.deepStrictEqual(result, {
        processed: 0,
        autoApproved: 0,
        mode: 'kernel'
      });
    });
  });
});
