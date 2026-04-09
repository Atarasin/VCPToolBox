'use strict';

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert');
const { mock } = require('node:test');

const { WorkflowEngine } = require('../core/WorkflowEngine');

function createStory(overrides = {}) {
  return {
    id: 'story-123',
    status: 'draft',
    phase1: {
      worldview: null,
      characters: [],
      validation: null,
      userConfirmed: false,
      checkpointId: null,
      status: 'pending'
    },
    phase2: {
      outline: null,
      chapters: [],
      currentChapter: 0,
      userConfirmed: false,
      checkpointId: null,
      status: 'pending'
    },
    phase3: {
      polishedChapters: [],
      finalValidation: null,
      iterationCount: 0,
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
        maxAttempts: 3,
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

  const stateManager = {
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
      story.workflow = story.workflow || {};
      story.workflow = {
        ...story.workflow,
        ...updates,
        retryContext: updates.retryContext !== undefined
          ? { ...(story.workflow.retryContext || {}), ...updates.retryContext }
          : story.workflow.retryContext
      };
      return story;
    }),
    updatePhase1: mock.fn(async (_storyId, updates) => {
      story.phase1 = { ...story.phase1, ...updates };
      return story;
    }),
    updatePhase2: mock.fn(async (_storyId, updates) => {
      story.phase2 = { ...story.phase2, ...updates };
      return story;
    }),
    updatePhase3: mock.fn(async (_storyId, updates) => {
      story.phase3 = { ...story.phase3, ...updates };
      return story;
    }),
    appendWorkflowHistory: mock.fn(async (_storyId, entry) => {
      story.workflow.history.push(entry);
      return story;
    }),
    setActiveCheckpoint: mock.fn(async (_storyId, checkpoint) => {
      story.workflow.activeCheckpoint = { ...checkpoint };
      return story;
    }),
    clearActiveCheckpoint: mock.fn(async () => {
      story.workflow.activeCheckpoint = null;
      return story;
    }),
    recordPhaseFeedback: mock.fn(async (_storyId, phaseName, feedback) => {
      if (story.workflow.activeCheckpoint) {
        story.workflow.activeCheckpoint.feedback = feedback;
      }
      if (story[phaseName]) {
        story[phaseName].userFeedback = feedback;
      }
      return story;
    }),
    listStories: mock.fn(async () => (story ? [story.id] : [])),
    __getStory: () => story
  };

  return stateManager;
}

describe('WorkflowEngine', () => {
  let story;
  let stateManager;
  let agentDispatcher;
  let engine;

  beforeEach(() => {
    story = createStory();
    stateManager = createMockStateManager(story);
    agentDispatcher = { dispatch: mock.fn() };

    engine = new WorkflowEngine({
      stateManager,
      agentDispatcher,
      chapterOperations: {},
      contentValidator: {},
      config: {
        MAX_PHASE_RETRY_ATTEMPTS: 4,
        USER_CHECKPOINT_TIMEOUT_MS: 1000
      }
    });

    engine.phases = {
      phase1: { run: mock.fn(async () => ({ status: 'completed', phase: 'phase1' })) },
      phase2: {
        run: mock.fn(async () => ({ status: 'completed', phase: 'phase2' })),
        continueFromCheckpoint: mock.fn(async () => ({ status: 'completed', phase: 'phase2' }))
      },
      phase3: {
        run: mock.fn(async () => ({ status: 'completed', phase: 'phase3' })),
        continueFromCheckpoint: mock.fn(async () => ({ status: 'completed', phase: 'phase3' }))
      }
    };
  });

  describe('constructor()', () => {
    it('initializes dependencies, retry config and default state', () => {
      assert.strictEqual(engine.stateManager, stateManager);
      assert.strictEqual(engine.agentDispatcher, agentDispatcher);
      assert.strictEqual(engine.retryConfig.maxAttempts, 4);
      assert.deepStrictEqual(engine.retryConfig.retryOnPhases, ['phase1', 'phase2', 'phase3']);
      assert.strictEqual(engine.initialized, false);
      assert.deepStrictEqual(engine.phases && Object.keys(engine.phases), ['phase1', 'phase2', 'phase3']);
      assert.strictEqual(engine.webSocketPusher, null);
    });

    it('does not currently expose a public pause() method', () => {
      assert.strictEqual(typeof engine.pause, 'undefined');
    });
  });

  describe('start(storyId)', () => {
    it('starts an idle workflow and moves into waiting_checkpoint when phase1 needs approval', async () => {
      engine.phases.phase1.run = mock.fn(async () => ({
        status: 'waiting_checkpoint',
        phase: 'phase1',
        checkpointId: 'cp-1',
        data: { worldview: 'ok' }
      }));

      const notifications = [];
      engine.setWebSocketPusher({
        push: mock.fn(async (_storyId, notification) => {
          notifications.push(notification);
        })
      });

      const result = await engine.start('story-123');
      const updatedStory = stateManager.__getStory();

      assert.strictEqual(result.status, 'waiting_checkpoint');
      assert.strictEqual(updatedStory.workflow.state, 'waiting_checkpoint');
      assert.strictEqual(updatedStory.workflow.currentPhase, 'phase1');
      assert.strictEqual(updatedStory.workflow.activeCheckpoint.id, 'cp-1');
      assert.strictEqual(updatedStory.status, 'phase1_waiting_checkpoint');
      assert.strictEqual(engine.phases.phase1.run.mock.calls.length, 1);
      assert.ok(notifications.some((notification) => notification.eventType === 'workflow_started'));
      assert.ok(notifications.some((notification) => notification.eventType === 'checkpoint_pending'));
    });

    it('rejects missing stories', async () => {
      const result = await engine.start('missing-story');

      assert.strictEqual(result.status, 'error');
      assert.match(result.error, /Story not found/);
    });

    it('rejects workflows that are already running', async () => {
      story.workflow.state = 'running';

      const result = await engine.start('story-123');

      assert.strictEqual(result.status, 'error');
      assert.match(result.error, /already running/);
    });

    it('moves the workflow into failed state when a phase fails', async () => {
      engine.phases.phase1.run = mock.fn(async () => ({
        status: 'failed',
        phase: 'phase1',
        error: 'boom'
      }));

      const result = await engine.start('story-123');
      const updatedStory = stateManager.__getStory();

      assert.strictEqual(result.status, 'failed');
      assert.strictEqual(updatedStory.workflow.state, 'failed');
      assert.strictEqual(updatedStory.status, 'phase1_failed');
    });
  });

  describe('resume(storyId, checkpointApproval)', () => {
    it('approves a phase1 checkpoint and resumes into phase2', async () => {
      story.workflow.state = 'waiting_checkpoint';
      story.workflow.currentPhase = 'phase1';
      story.workflow.activeCheckpoint = {
        id: 'cp-1',
        phase: 'phase1',
        type: 'phase1_checkpoint',
        status: 'pending'
      };

      engine._runPhase2 = mock.fn(async () => ({ status: 'running', phase: 'phase2' }));
      engine._continueApprovedPhaseInBackground = mock.fn(async () => {});

      const result = await engine.resume('story-123', {
        checkpointId: 'cp-1',
        approval: true,
        feedback: 'approved'
      });

      assert.strictEqual(result.status, 'running');
      assert.strictEqual(result.background, true);
      assert.strictEqual(result.phase, 'phase2');
      assert.strictEqual(engine._continueApprovedPhaseInBackground.mock.calls.length, 1);
      assert.strictEqual(engine._continueApprovedPhaseInBackground.mock.calls[0].arguments[1], 'phase2');
      assert.strictEqual(stateManager.clearActiveCheckpoint.mock.calls.length, 1);
      assert.strictEqual(stateManager.recordPhaseFeedback.mock.calls.length, 1);
      assert.strictEqual(stateManager.updatePhase1.mock.calls.at(-1).arguments[1].status, 'completed');
      assert.strictEqual(stateManager.updateStory.mock.calls.at(-1).arguments[1].status, 'phase2_running');
    });

    it('rejects a checkpoint and reruns the current phase', async () => {
      story.workflow.state = 'waiting_checkpoint';
      story.workflow.currentPhase = 'phase2';
      story.workflow.activeCheckpoint = {
        id: 'cp-2',
        phase: 'phase2',
        type: 'phase2_checkpoint',
        status: 'pending'
      };

      engine._runPhase2 = mock.fn(async () => ({ status: 'waiting_checkpoint', phase: 'phase2', checkpointId: 'cp-2b' }));
      engine._rerunRejectedPhaseInBackground = mock.fn(async () => {});

      const result = await engine.resume('story-123', {
        checkpointId: 'cp-2',
        approval: false,
        feedback: 'needs work',
        reason: 'outline too weak'
      });

      assert.strictEqual(result.status, 'retrying');
      assert.strictEqual(result.background, true);
      assert.strictEqual(engine._rerunRejectedPhaseInBackground.mock.calls.length, 1);
      assert.strictEqual(stateManager.recordPhaseFeedback.mock.calls.length, 1);
      assert.strictEqual(stateManager.updateWorkflow.mock.calls.at(-1).arguments[1].state, 'running');
      assert.strictEqual(stateManager.updateStory.mock.calls.at(-1).arguments[1].status, 'phase2_retrying');
    });

    it('rejects mismatched checkpoint ids', async () => {
      story.workflow.state = 'waiting_checkpoint';
      story.workflow.currentPhase = 'phase1';
      story.workflow.activeCheckpoint = {
        id: 'cp-expected',
        phase: 'phase1',
        status: 'pending'
      };

      const result = await engine.resume('story-123', {
        checkpointId: 'cp-other',
        approval: true,
        feedback: 'approved'
      });

      assert.strictEqual(result.status, 'error');
      assert.match(result.error, /Checkpoint mismatch/);
    });

    it('completes the workflow when the final checkpoint is approved', async () => {
      story.workflow.state = 'waiting_checkpoint';
      story.workflow.currentPhase = 'phase3';
      story.workflow.activeCheckpoint = {
        id: 'cp-3',
        phase: 'phase3',
        type: 'phase3_checkpoint',
        status: 'pending'
      };

      const result = await engine.resume('story-123', {
        checkpointId: 'cp-3',
        approval: true,
        feedback: 'ship it'
      });

      const updatedStory = stateManager.__getStory();
      assert.strictEqual(result.status, 'completed');
      assert.strictEqual(updatedStory.workflow.state, 'completed');
      assert.strictEqual(updatedStory.status, 'completed');
    });
  });

  describe('retryPhase(storyId, phase)', () => {
    it('retries a valid phase and refreshes retry context', async () => {
      story.workflow.retryContext = {
        phase: 'phase2',
        step: 'draft',
        attempt: 1,
        maxAttempts: 4,
        lastError: 'old error'
      };

      engine._sleep = mock.fn(async () => {});
      engine._runPhase2 = mock.fn(async () => ({ status: 'running', phase: 'phase2' }));

      const result = await engine.retryPhase('story-123', 'phase2', 'temporary failure');

      assert.strictEqual(result.status, 'running');
      assert.strictEqual(engine._sleep.mock.calls.length, 1);
      assert.strictEqual(engine._runPhase2.mock.calls.length, 1);
      assert.strictEqual(stateManager.updateWorkflow.mock.calls.at(-1).arguments[1].retryContext.attempt, 2);
    });

    it('fails once max retry attempts are exceeded', async () => {
      story.workflow.retryContext = {
        phase: 'phase1',
        step: 'initial',
        attempt: 4,
        maxAttempts: 4,
        lastError: 'persistent error'
      };

      const result = await engine.retryPhase('story-123', 'phase1', 'still broken');

      assert.strictEqual(result.status, 'failed');
      assert.match(result.error, /Max retry attempts/);
    });

    it('rejects invalid phase names', async () => {
      const result = await engine.retryPhase('story-123', 'phase99', 'bad');

      assert.strictEqual(result.status, 'error');
      assert.match(result.error, /Invalid phase name/);
    });
  });

  describe('recover(storyId, action)', () => {
    it('continues a crashed workflow into the next phase when the checkpointed phase is already confirmed', async () => {
      story.workflow.state = 'failed';
      story.workflow.currentPhase = 'phase2';
      story.phase2.userConfirmed = true;

      engine._runPhase3 = mock.fn(async () => ({ status: 'running', phase: 'phase3' }));

      const result = await engine.recover('story-123', { recoveryAction: 'continue', feedback: 'resume' });

      assert.strictEqual(result.status, 'running');
      assert.strictEqual(engine._runPhase3.mock.calls.length, 1);
      assert.strictEqual(stateManager.updateWorkflow.mock.calls.at(-1).arguments[1].retryContext.attempt, 0);
    });

    it('restarts a requested phase and resets downstream phase state', async () => {
      story.workflow.state = 'failed';
      story.workflow.currentPhase = 'phase3';
      story.phase2.chapters = [{ number: 1, title: 'old' }];
      story.phase3.polishedChapters = [{ number: 1, content: 'old' }];

      engine._runPhase2 = mock.fn(async () => ({ status: 'running', phase: 'phase2' }));

      const result = await engine.recover('story-123', {
        recoveryAction: 'restart_phase',
        targetPhase: 'phase2'
      });

      assert.strictEqual(result.status, 'running');
      assert.strictEqual(engine._runPhase2.mock.calls.length, 1);
      assert.strictEqual(stateManager.updatePhase2.mock.calls.length, 1);
      assert.strictEqual(stateManager.updatePhase3.mock.calls.length, 1);
      assert.strictEqual(stateManager.updateStory.mock.calls.at(-1).arguments[1].status, 'phase2_running');
    });

    it('rolls back to an inferred phase checkpoint and reruns that phase', async () => {
      story.workflow.state = 'failed';
      story.workflow.currentPhase = 'phase3';
      story.phase2.userConfirmed = true;
      story.phase2.checkpointId = 'cp-2-outline';

      engine._runPhase2 = mock.fn(async () => ({ status: 'running', phase: 'phase2' }));

      const result = await engine.recover('story-123', {
        recoveryAction: 'rollback'
      });

      assert.strictEqual(result.status, 'running');
      assert.strictEqual(engine._runPhase2.mock.calls.length, 1);
      assert.strictEqual(stateManager.clearActiveCheckpoint.mock.calls.length, 1);
      assert.strictEqual(stateManager.updateWorkflow.mock.calls.at(-1).arguments[1].currentPhase, 'phase2');
    });
  });

  describe('notification flow', () => {
    it('pushes workflow events through the configured websocket pusher', async () => {
      const received = [];
      engine.setWebSocketPusher({
        push: mock.fn(async (_storyId, notification) => {
          received.push(notification);
        })
      });

      engine.phases.phase1.run = mock.fn(async () => ({
        status: 'waiting_checkpoint',
        phase: 'phase1',
        checkpointId: 'cp-notify',
        data: { summary: 'pending review' }
      }));

      await engine.start('story-123');

      assert.strictEqual(received[0].type, 'workflow_event');
      assert.strictEqual(received[0].storyId, 'story-123');
      assert.ok(received.every((notification) => typeof notification.timestamp === 'string'));
      assert.ok(received.some((notification) => notification.eventType === 'workflow_started'));
      assert.ok(received.some((notification) => notification.eventType === 'checkpoint_pending'));
    });

    it('swallows websocket push failures while preserving workflow progress', async () => {
      engine.setWebSocketPusher({
        push: mock.fn(async () => {
          throw new Error('socket offline');
        })
      });

      engine.phases.phase1.run = mock.fn(async () => ({
        status: 'waiting_checkpoint',
        phase: 'phase1',
        checkpointId: 'cp-resilient',
        data: {}
      }));

      const result = await engine.start('story-123');
      const updatedStory = stateManager.__getStory();

      assert.strictEqual(result.status, 'waiting_checkpoint');
      assert.strictEqual(updatedStory.workflow.state, 'waiting_checkpoint');
    });
  });

  describe('state transition chain', () => {
    it('covers idle → running → waiting_checkpoint → completed across public APIs', async () => {
      engine.phases.phase1.run = mock.fn(async () => ({
        status: 'waiting_checkpoint',
        phase: 'phase1',
        checkpointId: 'cp-chain',
        data: {}
      }));

      const startResult = await engine.start('story-123');
      assert.strictEqual(startResult.status, 'waiting_checkpoint');
      assert.strictEqual(stateManager.__getStory().workflow.state, 'waiting_checkpoint');

      const updatedStory = stateManager.__getStory();
      updatedStory.workflow.currentPhase = 'phase3';
      updatedStory.workflow.activeCheckpoint = {
        id: 'cp-final',
        phase: 'phase3',
        type: 'phase3_checkpoint',
        status: 'pending'
      };

      const resumeResult = await engine.resume('story-123', {
        checkpointId: 'cp-final',
        approval: true,
        feedback: 'done'
      });

      assert.strictEqual(resumeResult.status, 'completed');
      assert.strictEqual(stateManager.__getStory().workflow.state, 'completed');
    });
  });
});
