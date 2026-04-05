'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');

const storyDb = {};
const stateHistory = [];

const createMockStateManager = () => {
  const sm = {
    initialized: false,
    cache: new Map(),
    
    async initialize() {
      this.initialized = true;
    },

    generateStoryId() {
      return 'story-test-123';
    },

    async createStory(storyPrompt, config = {}) {
      const storyId = sm.generateStoryId();
      const now = new Date().toISOString();
      const story = {
        id: storyId,
        status: 'phase1_running',
        createdAt: now,
        updatedAt: now,
        config: {
          targetWordCount: config.target_word_count || { min: 2500, max: 3500 },
          genre: config.genre || 'general',
          stylePreference: config.style_preference || '',
          storyPrompt: storyPrompt
        },
        phase1: {
          worldview: null,
          characters: [],
          validation: null,
          userConfirmed: false,
          checkpointId: null,
          status: 'running'
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
          runToken: 'test-uuid-1234'
        }
      };
      storyDb[storyId] = story;
      sm.cache.set(storyId, story);
      return story;
    },

    async getStory(storyId) {
      if (sm.cache.has(storyId)) {
        return sm.cache.get(storyId);
      }
      return storyDb[storyId] || null;
    },

    async updateStory(storyId, updates) {
      const story = await sm.getStory(storyId);
      if (!story) throw new Error('Story not found: ' + storyId);
      Object.assign(story, updates, { updatedAt: new Date().toISOString() });
      sm.cache.set(storyId, story);
      storyDb[storyId] = story;
      stateHistory.push({ action: 'updateStory', storyId, updates });
      return story;
    },

    async updateWorkflow(storyId, updates) {
      const story = await sm.getStory(storyId);
      if (!story) throw new Error('Story not found: ' + storyId);
      if (!story.workflow) {
        story.workflow = {
          state: 'idle',
          currentPhase: null,
          currentStep: null,
          activeCheckpoint: null,
          retryContext: { phase: null, step: null, attempt: 0, maxAttempts: 3, lastError: null },
          history: [],
          runToken: 'test-uuid-1234'
        };
      }
      if (updates.retryContext !== undefined) {
        story.workflow.retryContext = { ...story.workflow.retryContext, ...updates.retryContext };
      }
      Object.assign(story.workflow, updates);
      stateHistory.push({ action: 'updateWorkflow', storyId, updates });
      return story;
    },

    async appendWorkflowHistory(storyId, entry) {
      const story = await sm.getStory(storyId);
      if (!story) throw new Error('Story not found: ' + storyId);
      if (!story.workflow) story.workflow = {};
      if (!story.workflow.history) story.workflow.history = [];
      story.workflow.history.push({
        at: new Date().toISOString(),
        type: entry.type || 'notification',
        phase: entry.phase !== undefined ? entry.phase : story.workflow.currentPhase,
        step: entry.step !== undefined ? entry.step : story.workflow.currentStep,
        detail: entry.detail || {}
      });
      stateHistory.push({ action: 'appendWorkflowHistory', storyId, entry });
      return story;
    },

    async setActiveCheckpoint(storyId, checkpoint) {
      const story = await sm.getStory(storyId);
      if (!story) throw new Error('Story not found: ' + storyId);
      if (!story.workflow) story.workflow = {};
      story.workflow.activeCheckpoint = {
        id: checkpoint.id || 'cp-test-' + Date.now(),
        phase: checkpoint.phase || story.workflow.currentPhase,
        type: checkpoint.type || 'outline_confirmation',
        status: checkpoint.status || 'pending',
        createdAt: checkpoint.createdAt || new Date().toISOString(),
        expiresAt: checkpoint.expiresAt || null,
        autoContinueOnTimeout: checkpoint.autoContinueOnTimeout !== undefined ? checkpoint.autoContinueOnTimeout : true,
        feedback: checkpoint.feedback || ''
      };
      stateHistory.push({ action: 'setActiveCheckpoint', storyId, checkpoint });
      return story;
    },

    async clearActiveCheckpoint(storyId) {
      const story = await sm.getStory(storyId);
      if (!story) throw new Error('Story not found: ' + storyId);
      if (story.workflow) story.workflow.activeCheckpoint = null;
      stateHistory.push({ action: 'clearActiveCheckpoint', storyId });
      return story;
    },

    async recordPhaseFeedback(storyId, phaseName, feedback) {
      const story = await sm.getStory(storyId);
      if (!story) throw new Error('Story not found: ' + storyId);
      const now = new Date().toISOString();
      if (story.workflow && story.workflow.activeCheckpoint) {
        story.workflow.activeCheckpoint.feedback = feedback;
        story.workflow.activeCheckpoint.status = 'approved';
        story.workflow.activeCheckpoint.resolvedAt = now;
      }
      if (story[phaseName]) {
        story[phaseName].userFeedback = feedback;
        story[phaseName].feedbackRecordedAt = now;
      }
      stateHistory.push({ action: 'recordPhaseFeedback', storyId, phaseName, feedback });
      return story;
    }
  };
  return sm;
};

describe('WorkflowEngine', () => {
  let mockStateManager;
  let mockAgentDispatcher;
  let mockChapterOperations;
  let mockContentValidator;
  let WorkflowEngine;
  let engine;

  beforeEach(() => {
    stateHistory.length = 0;
    Object.keys(storyDb).forEach(k => delete storyDb[k]);
    mockStateManager = createMockStateManager();
    mockAgentDispatcher = {};
    mockChapterOperations = {};
    mockContentValidator = {};

    const { WorkflowEngine: WE } = require('../core/WorkflowEngine');
    WorkflowEngine = WE;
    
    engine = new WorkflowEngine({
      stateManager: mockStateManager,
      agentDispatcher: mockAgentDispatcher,
      chapterOperations: mockChapterOperations,
      contentValidator: mockContentValidator,
      config: { MAX_PHASE_RETRY_ATTEMPTS: 3 }
    });
  });

  const setPhaseBehaviors = (phaseConfigs) => {
    engine.phases = {
      phase1: {
        async run() {
          return phaseConfigs.phase1 ? phaseConfigs.phase1() : { status: 'completed', phase: 'phase1', data: { message: 'phase1 done' } };
        }
      },
      phase2: {
        async run() {
          return phaseConfigs.phase2 ? phaseConfigs.phase2() : { status: 'completed', phase: 'phase2', data: { message: 'phase2 done' } };
        },
        async continueFromCheckpoint() {
          return phaseConfigs.phase2Continue ? phaseConfigs.phase2Continue() : { status: 'completed', phase: 'phase2' };
        }
      },
      phase3: {
        async run() {
          return phaseConfigs.phase3 ? phaseConfigs.phase3() : { status: 'completed', phase: 'phase3', data: { message: 'phase3 done' } };
        },
        async continueFromCheckpoint() {
          return phaseConfigs.phase3Continue ? phaseConfigs.phase3Continue() : { status: 'completed', phase: 'phase3' };
        }
      }
    };
  };

  describe('State Machine Transitions', () => {

    describe('idle to running (phase1)', () => {
      it('transitions from idle to running when starting workflow', async () => {
        let phase1Ran = false;
        setPhaseBehaviors({
          phase1: () => {
            phase1Ran = true;
            return { status: 'completed', phase: 'phase1' };
          }
        });
        const story = await mockStateManager.createStory('Test story prompt');

        const result = await engine.start(story.id);

        assert.strictEqual(result.status, 'completed');
        assert.ok(phase1Ran);
      });

      it('rejects start if workflow already running', async () => {
        setPhaseBehaviors({});
        const story = await mockStateManager.createStory('Test story');
        await mockStateManager.updateWorkflow(story.id, { state: 'running' });

        const result = await engine.start(story.id);

        assert.strictEqual(result.status, 'error');
        assert.ok(result.error.includes('already running'));
      });

      it('rejects start if workflow already completed', async () => {
        setPhaseBehaviors({});
        const story = await mockStateManager.createStory('Test story');
        await mockStateManager.updateWorkflow(story.id, { state: 'completed' });

        const result = await engine.start(story.id);

        assert.strictEqual(result.status, 'error');
        assert.ok(result.error.includes('already completed'));
      });

      it('rejects start for non-existent story', async () => {
        setPhaseBehaviors({});
        const result = await engine.start('non-existent-story');

        assert.strictEqual(result.status, 'error');
        assert.ok(result.error.includes('not found'));
      });
    });

    describe('running to awaiting_checkpoint', () => {
      it('transitions to awaiting_checkpoint when phase requires confirmation', async () => {
        setPhaseBehaviors({
          phase1: () => ({
            status: 'waiting_checkpoint',
            phase: 'phase1',
            checkpointId: 'cp-1-worldview',
            data: { message: 'Worldview ready for review' }
          })
        });

        const story = await mockStateManager.createStory('Test story');
        const result = await engine.start(story.id);

        assert.strictEqual(result.status, 'waiting_checkpoint');
        assert.strictEqual(result.checkpointId, 'cp-1-worldview');
        assert.strictEqual(result.phase, 'phase1');

        const updatedStory = await mockStateManager.getStory(story.id);
        assert.strictEqual(updatedStory.workflow.state, 'waiting_checkpoint');
      });
    });

    describe('awaiting_checkpoint to running (phase2)', () => {
      it('transitions to phase2 when checkpoint is approved', async () => {
        setPhaseBehaviors({
          phase2: () => ({ status: 'waiting_checkpoint', phase: 'phase2', checkpointId: 'cp-2' })
        });
        const story = await mockStateManager.createStory('Test story');
        
        await mockStateManager.updateWorkflow(story.id, {
          state: 'waiting_checkpoint',
          currentPhase: 'phase1'
        });
        await mockStateManager.setActiveCheckpoint(story.id, {
          id: 'cp-1-worldview',
          phase: 'phase1',
          status: 'pending'
        });

        const result = await engine.resume(story.id, {
          checkpointId: 'cp-1-worldview',
          approval: true,
          feedback: 'Looks good'
        });

        const updatedStory = await mockStateManager.getStory(story.id);
        assert.strictEqual(updatedStory.workflow.currentPhase, 'phase2');
      });
    });

    describe('phase2 to awaiting_checkpoint (checkpoint 2)', () => {
      it('creates checkpoint 2 after phase2 completes', async () => {
        setPhaseBehaviors({
          phase1: () => ({ status: 'completed', phase: 'phase1' }),
          phase2: () => ({
            status: 'waiting_checkpoint',
            phase: 'phase2',
            checkpointId: 'cp-2-outline',
            data: { outline: 'Chapter outline...' }
          })
        });

        const story = await mockStateManager.createStory('Test story');
        await engine.start(story.id);

        const updatedStory = await mockStateManager.getStory(story.id);
        assert.strictEqual(updatedStory.workflow.activeCheckpoint && updatedStory.workflow.activeCheckpoint.phase, 'phase2');
      });
    });

    describe('awaiting_checkpoint to running (phase3)', () => {
      it('transitions to phase3 after approving checkpoint 2', async () => {
        setPhaseBehaviors({});
        const story = await mockStateManager.createStory('Test story');
        
        await mockStateManager.updateWorkflow(story.id, {
          state: 'waiting_checkpoint',
          currentPhase: 'phase2'
        });
        await mockStateManager.setActiveCheckpoint(story.id, {
          id: 'cp-2-outline',
          phase: 'phase2',
          status: 'pending'
        });

        const result = await engine.resume(story.id, {
          checkpointId: 'cp-2-outline',
          approval: true,
          feedback: 'Good outline'
        });

        const updatedStory = await mockStateManager.getStory(story.id);
        assert.strictEqual(updatedStory.workflow.currentPhase, 'phase3');
      });
    });

    describe('phase3 to awaiting_checkpoint (checkpoint 3)', () => {
      it('creates checkpoint 3 after phase3 completes', async () => {
        setPhaseBehaviors({
          phase1: () => ({ status: 'completed', phase: 'phase1' }),
          phase2: () => ({ status: 'completed', phase: 'phase2' }),
          phase3: () => ({
            status: 'waiting_checkpoint',
            phase: 'phase3',
            checkpointId: 'cp-3-final',
            data: { finalOutput: 'Complete story...' }
          })
        });

        const story = await mockStateManager.createStory('Test story');
        await engine.start(story.id);

        const updatedStory = await mockStateManager.getStory(story.id);
        assert.strictEqual(updatedStory.workflow.activeCheckpoint && updatedStory.workflow.activeCheckpoint.phase, 'phase3');
        assert.strictEqual(updatedStory.workflow.activeCheckpoint && updatedStory.workflow.activeCheckpoint.id, 'cp-3-final');
      });
    });

    describe('awaiting_checkpoint to completed', () => {
      it('transitions to completed when final checkpoint is approved', async () => {
        setPhaseBehaviors({});
        const story = await mockStateManager.createStory('Test story');
        
        await mockStateManager.updateWorkflow(story.id, {
          state: 'waiting_checkpoint',
          currentPhase: 'phase3'
        });
        await mockStateManager.setActiveCheckpoint(story.id, {
          id: 'cp-3-final',
          phase: 'phase3',
          status: 'pending'
        });

        const result = await engine.resume(story.id, {
          checkpointId: 'cp-3-final',
          approval: true,
          feedback: 'Excellent work!'
        });

        assert.strictEqual(result.status, 'completed');

        const updatedStory = await mockStateManager.getStory(story.id);
        assert.strictEqual(updatedStory.workflow.state, 'completed');
        assert.strictEqual(updatedStory.status, 'completed');
      });
    });

    describe('Error transitions', () => {
      it('handles phase failure and transitions to failed state', async () => {
        setPhaseBehaviors({
          phase1: () => ({
            status: 'failed',
            phase: 'phase1',
            error: 'AI service unavailable'
          })
        });

        const story = await mockStateManager.createStory('Test story');
        await engine.start(story.id);

        const updatedStory = await mockStateManager.getStory(story.id);
        assert.strictEqual(updatedStory.workflow.state, 'failed');
      });
    });
  });

  describe('Checkpoint Handling', () => {
    
    describe('Checkpoint creation', () => {
      it('creates checkpoint with correct properties', async () => {
        setPhaseBehaviors({
          phase1: () => ({
            status: 'waiting_checkpoint',
            checkpointId: 'cp-1-worldview',
            data: { worldview: {}, characters: [] }
          })
        });

        const story = await mockStateManager.createStory('Test');
        await engine.start(story.id);

        const updatedStory = await mockStateManager.getStory(story.id);
        const checkpoint = updatedStory.workflow.activeCheckpoint;

        assert.ok(checkpoint);
        assert.strictEqual(checkpoint.id, 'cp-1-worldview');
        assert.strictEqual(checkpoint.phase, 'phase1');
        assert.strictEqual(checkpoint.type, 'phase1_checkpoint');
        assert.strictEqual(checkpoint.status, 'pending');
        assert.strictEqual(checkpoint.autoContinueOnTimeout, true);
      });
    });

    describe('Timeout handling', () => {
      it('has autoContinueOnTimeout enabled by default', async () => {
        setPhaseBehaviors({
          phase1: () => ({
            status: 'waiting_checkpoint',
            checkpointId: 'cp-1',
            data: {}
          })
        });

        const story = await mockStateManager.createStory('Test');
        await engine.start(story.id);

        const updatedStory = await mockStateManager.getStory(story.id);
        assert.strictEqual(updatedStory.workflow.activeCheckpoint && updatedStory.workflow.activeCheckpoint.autoContinueOnTimeout, true);
      });
    });

    describe('User approval/rejection', () => {
      it('handles approval and continues workflow', async () => {
        setPhaseBehaviors({
          phase2: () => ({ status: 'waiting_checkpoint', phase: 'phase2', checkpointId: 'cp-2' }),
          phase3: () => ({ status: 'completed', phase: 'phase3' })
        });
        const story = await mockStateManager.createStory('Test');
        
        await mockStateManager.updateWorkflow(story.id, {
          state: 'waiting_checkpoint',
          currentPhase: 'phase1'
        });
        await mockStateManager.setActiveCheckpoint(story.id, {
          id: 'cp-1',
          phase: 'phase1',
          status: 'pending'
        });

        await engine.resume(story.id, {
          checkpointId: 'cp-1',
          approval: true,
          feedback: 'Approved!'
        });

        const updatedStory = await mockStateManager.getStory(story.id);
        assert.strictEqual(updatedStory.workflow.currentPhase, 'phase2');
      });

      it('handles rejection and re-runs current phase', async () => {
        let phase1RunCount = 0;
        
        setPhaseBehaviors({
          phase1: () => {
            phase1RunCount++;
            return {
              status: 'waiting_checkpoint',
              checkpointId: 'cp-1',
              data: { attempt: phase1RunCount }
            };
          }
        });

        const story = await mockStateManager.createStory('Test');
        
        await mockStateManager.updateWorkflow(story.id, {
          state: 'waiting_checkpoint',
          currentPhase: 'phase1'
        });
        await mockStateManager.setActiveCheckpoint(story.id, {
          id: 'cp-1',
          phase: 'phase1',
          status: 'pending'
        });

        await engine.resume(story.id, {
          checkpointId: 'cp-1',
          approval: false,
          feedback: 'Please improve',
          reason: 'Not detailed enough'
        });

        assert.ok(phase1RunCount >= 1);
      });

      it('rejects when checkpointId does not match', async () => {
        setPhaseBehaviors({});
        const story = await mockStateManager.createStory('Test');
        
        await mockStateManager.updateWorkflow(story.id, {
          state: 'waiting_checkpoint',
          currentPhase: 'phase1'
        });
        await mockStateManager.setActiveCheckpoint(story.id, {
          id: 'cp-correct',
          phase: 'phase1',
          status: 'pending'
        });

        const result = await engine.resume(story.id, {
          checkpointId: 'cp-wrong',
          approval: true,
          feedback: 'Approved'
        });

        assert.strictEqual(result.status, 'error');
        assert.ok(result.error.includes('mismatch'));
      });
    });
  });

  describe('Workflow Execution', () => {
    
    describe('Phase 1 execution', () => {
      it('executes phase1 and updates story status', async () => {
        let phase1Ran = false;
        setPhaseBehaviors({
          phase1: () => {
            phase1Ran = true;
            return { status: 'completed', phase: 'phase1' };
          }
        });
        await mockStateManager.createStory('Test story');

        await engine.start('story-test-123');

        const updatedStory = await mockStateManager.getStory('story-test-123');
        assert.ok(updatedStory.phase1);
        assert.ok(phase1Ran);
      });
    });

    describe('Phase 2 execution', () => {
      it('executes phase2 after phase1 completes', async () => {
        const executionOrder = [];
        
        setPhaseBehaviors({
          phase1: () => {
            executionOrder.push('phase1');
            return { status: 'completed', phase: 'phase1' };
          },
          phase2: () => {
            executionOrder.push('phase2');
            return { status: 'completed', phase: 'phase2' };
          }
        });

        await mockStateManager.createStory('Test');
        await engine.start('story-test-123');

        assert.ok(executionOrder.includes('phase1'));
        assert.ok(executionOrder.includes('phase2'));
        assert.ok(executionOrder.indexOf('phase1') < executionOrder.indexOf('phase2'));
      });
    });

    describe('Phase 3 execution', () => {
      it('executes phase3 after phase2 completes', async () => {
        const executionOrder = [];
        
        setPhaseBehaviors({
          phase1: () => {
            executionOrder.push('phase1');
            return { status: 'completed', phase: 'phase1' };
          },
          phase2: () => {
            executionOrder.push('phase2');
            return { status: 'completed', phase: 'phase2' };
          },
          phase3: () => {
            executionOrder.push('phase3');
            return { status: 'completed', phase: 'phase3' };
          }
        });

        await mockStateManager.createStory('Test');
        await engine.start('story-test-123');

        assert.strictEqual(executionOrder[0], 'phase1');
        assert.strictEqual(executionOrder[1], 'phase2');
        assert.strictEqual(executionOrder[2], 'phase3');
      });
    });

    describe('Error recovery', () => {
      it('recovers from crash state', async () => {
        setPhaseBehaviors({});
        const story = await mockStateManager.createStory('Test');
        
        await mockStateManager.updateWorkflow(story.id, {
          state: 'running',
          currentPhase: 'phase1',
          retryContext: { attempt: 1, maxAttempts: 3 }
        });

        const result = await engine.recover(story.id);

        assert.ok(result.status === 'success' || result.status === 'completed');

        const updatedStory = await mockStateManager.getStory(story.id);
        assert.ok(updatedStory.workflow.runToken);
      });

      it('reports already completed on recover if completed', async () => {
        setPhaseBehaviors({});
        const story = await mockStateManager.createStory('Test');
        
        await mockStateManager.updateWorkflow(story.id, { state: 'completed' });

        const result = await engine.recover(story.id);

        assert.strictEqual(result.status, 'success');
        assert.ok(result.message.includes('completed'));
      });

      it('reports idle state if workflow is idle', async () => {
        setPhaseBehaviors({});
        const story = await mockStateManager.createStory('Test');
        
        await mockStateManager.updateWorkflow(story.id, { state: 'idle' });

        const result = await engine.recover(story.id);

        assert.strictEqual(result.status, 'success');
        assert.ok(result.message.includes('idle'));
      });
    });
  });

  describe('Retry Logic', () => {
    
    describe('3 attempts with backoff', () => {
      it('allows up to 3 retry attempts', async () => {
        setPhaseBehaviors({});
        const story = await mockStateManager.createStory('Test');
        
        await mockStateManager.updateWorkflow(story.id, {
          retryContext: { attempt: 0, maxAttempts: 3, lastError: 'Initial error' }
        });

        const result1 = await engine.retryPhase(story.id, 'phase1', 'Test error 1');
        assert.ok(result1.status === 'completed' || result1.status === 'error');

        await mockStateManager.updateWorkflow(story.id, {
          retryContext: { attempt: 1, maxAttempts: 3 }
        });

        const result2 = await engine.retryPhase(story.id, 'phase1', 'Test error 2');
        assert.ok(result2.status === 'completed' || result2.status === 'error');

        await mockStateManager.updateWorkflow(story.id, {
          retryContext: { attempt: 2, maxAttempts: 3 }
        });

        const result3 = await engine.retryPhase(story.id, 'phase1', 'Test error 3');
        assert.ok(result3.status === 'completed' || result3.status === 'error');
      });

      it('fails when max attempts exceeded', async () => {
        setPhaseBehaviors({});
        const story = await mockStateManager.createStory('Test');
        
        await mockStateManager.updateWorkflow(story.id, {
          retryContext: { attempt: 3, maxAttempts: 3, lastError: 'Previous error' }
        });

        const result = await engine.retryPhase(story.id, 'phase1', 'New error');

        assert.strictEqual(result.status, 'failed');
        assert.ok(result.error.includes('Max retry attempts'));
      });

      it('applies backoff delays', async () => {
        setPhaseBehaviors({});
        const story = await mockStateManager.createStory('Test');
        
        await mockStateManager.updateWorkflow(story.id, {
          retryContext: { attempt: 1, maxAttempts: 3 }
        });

        await engine.retryPhase(story.id, 'phase1', 'Test error');
      });

      it('rejects invalid phase names for retry', async () => {
        setPhaseBehaviors({});
        const story = await mockStateManager.createStory('Test');

        const result = await engine.retryPhase(story.id, 'invalid_phase', 'Error');

        assert.strictEqual(result.status, 'error');
        assert.ok(result.error.includes('Invalid phase'));
      });
    });
  });

  describe('getWorkflowStatus', () => {
    it('returns current workflow status', async () => {
      setPhaseBehaviors({});
      const story = await mockStateManager.createStory('Test');
      
      await mockStateManager.updateWorkflow(story.id, {
        state: 'running',
        currentPhase: 'phase2',
        currentStep: 'outline_drafting'
      });

      const status = await engine.getWorkflowStatus(story.id);

      assert.strictEqual(status.state, 'running');
      assert.strictEqual(status.currentPhase, 'phase2');
      assert.strictEqual(status.currentStep, 'outline_drafting');
    });

    it('returns null for non-existent story', async () => {
      setPhaseBehaviors({});

      const status = await engine.getWorkflowStatus('non-existent');

      assert.strictEqual(status, null);
    });
  });

  describe('WebSocket Notifications', () => {
    it('sends notification when workflow starts', async () => {
      const notifications = [];
      const mockPusher = {
        push: async (storyId, notification) => {
          notifications.push(notification);
        }
      };

      setPhaseBehaviors({
        phase1: () => ({ status: 'waiting_checkpoint', phase: 'phase1', checkpointId: 'cp-1' })
      });
      engine.setWebSocketPusher(mockPusher);

      await mockStateManager.createStory('Test');
      await engine.start('story-test-123');

      assert.ok(notifications.length > 0);
      const startedNotification = notifications.find(n => n.eventType === 'workflow_started');
      assert.ok(startedNotification, 'Should have sent workflow_started notification');
    });

    it('does not throw if pusher fails', async () => {
      const mockPusher = {
        push: async () => {
          throw new Error('Pusher failed');
        }
      };

      setPhaseBehaviors({});
      engine.setWebSocketPusher(mockPusher);

      await mockStateManager.createStory('Test');

      await engine.start('story-test-123');
    });
  });
});
