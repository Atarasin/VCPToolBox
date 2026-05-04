'use strict';

/**
 * StoryOrchestratorKernelAdapter backup/restore lifecycle tests.
 *
 * Verifies that business-state snapshots are created before steps,
 * marked after checkpoints, and correctly restored on recovery.
 */

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert');

const { StoryOrchestratorKernelAdapter } = require('../adapters/StoryOrchestratorKernelAdapter');

/* ------------------------------------------------------------------ */
/*  helpers                                                           */
/* ------------------------------------------------------------------ */

function createMockStateManagerWithSnapshots() {
  const snapshots = new Map();
  const stories = new Map();
  let snapshotCounter = 0;
  const calls = {
    updatePhase1: [],
    setActiveCheckpoint: []
  };

  const repository = {
    getStory(storyId) {
      return stories.get(storyId) || null;
    },
    updateStory(storyId, updates, version) {
      const existing = stories.get(storyId) || { story_id: storyId, version: 1 };
      stories.set(storyId, { ...existing, ...updates, version: (existing.version || 1) + 1 });
      return stories.get(storyId);
    },
    createSnapshot(payload) {
      const id = `snap-${++snapshotCounter}`;
      snapshots.set(id, {
        snapshot_id: id,
        ...payload,
        payload_json: typeof payload.payload_json === 'string'
          ? payload.payload_json
          : JSON.stringify(payload.payload_json)
      });

      // Track latest approved snapshot per phase on the story record
      const story = stories.get(payload.story_id);
      if (story && payload.snapshot_type === 'approved') {
        const field = `current_${payload.phase_name}_snapshot_id`;
        stories.set(payload.story_id, { ...story, [field]: id });
      }
      return id;
    },
    getSnapshot(snapshotId) {
      return snapshots.get(snapshotId) || null;
    },
    getLatestApprovedSnapshot(storyId, phaseName) {
      const story = stories.get(storyId);
      if (!story) return null;
      const field = `current_${phaseName}_snapshot_id`;
      const snapId = story[field];
      return snapId ? snapshots.get(snapId) || null : null;
    },
    appendEvent() {}
  };

  return {
    repository,
    async getStory(storyId) {
      const s = stories.get(storyId);
      if (!s) return null;
      return {
        id: storyId,
        phase1: { worldview: null, characters: [], status: 'pending' },
        phase2: { outline: null, chapters: [], status: 'pending' },
        phase3: { polishedChapters: [], status: 'pending' },
        workflow: { state: 'idle', currentPhase: 'phase1' },
        ...s
      };
    },
    async updateStory(storyId, updates) {
      const existing = stories.get(storyId) || { story_id: storyId };
      stories.set(storyId, { ...existing, ...updates });
      return stories.get(storyId);
    },
    async updateWorkflow(storyId, updates) {
      const existing = stories.get(storyId) || { story_id: storyId };
      stories.set(storyId, { ...existing, workflow: { ...existing.workflow, ...updates } });
      return stories.get(storyId);
    },
    async appendWorkflowHistory() {},
    async updatePhase1(storyId, updates) {
      calls.updatePhase1.push({ storyId, updates });
      const existing = stories.get(storyId) || { story_id: storyId };
      const currentPhase1 = existing.phase1 || { worldview: null, characters: [], validation: null, userConfirmed: false, checkpointId: null, status: 'pending' };
      stories.set(storyId, { ...existing, phase1: { ...currentPhase1, ...updates } });
      return stories.get(storyId);
    },
    async setActiveCheckpoint(storyId, checkpoint) {
      calls.setActiveCheckpoint.push({ storyId, checkpoint });
      const existing = stories.get(storyId) || { story_id: storyId };
      stories.set(storyId, {
        ...existing,
        workflow: {
          ...(existing.workflow || {}),
          activeCheckpoint: {
            id: checkpoint.id || checkpoint.checkpointId,
            phase: checkpoint.phase,
            type: checkpoint.type,
            status: checkpoint.status
          }
        }
      });
      return stories.get(storyId);
    },
    async clearActiveCheckpoint() {},
    _snapshots: snapshots,
    _stories: stories,
    _calls: calls
  };
}

function createAdapterWithKernel() {
  const stateManager = createMockStateManagerWithSnapshots();
  const adapter = new StoryOrchestratorKernelAdapter({
    stateManager,
    agentDispatcher: { delegate: async () => ({ content: '{}', markers: [], raw: {} }) },
    chapterOperations: {},
    contentValidator: {},
    config: { USE_WORKFLOW_KERNEL: 'true', SNAPSHOT_GRANULARITY: 'every_step' }
  });
  adapter.initialize();
  return { adapter, stateManager };
}

/* ------------------------------------------------------------------ */
/*  test suite                                                        */
/* ------------------------------------------------------------------ */

describe('StoryOrchestratorKernelAdapter — backup/restore lifecycle', () => {
  describe('compatibility definition degradation', () => {
    it('normalizes legacy phase-only definition refs onto the full workflow definition', async () => {
      const { adapter } = createAdapterWithKernel();
      const storyId = 'story-legacy-definition-ref';

      adapter.kernel.stateRepository = {
        async get(id) {
          if (id !== storyId) {
            return null;
          }
          return {
            workflowId: storyId,
            definitionRef: 'story-orchestrator-phase1',
            status: 'recovering'
          };
        }
      };

      const definition = await adapter._loadRecoveryDefinition(storyId);

      assert.strictEqual(adapter._normalizeRecoveryDefinitionRef('story-orchestrator-phase1'), 'story-orchestrator-v1');
      assert.strictEqual(definition.id, 'story-orchestrator-v1');
      assert.ok(Array.isArray(definition.phases));
      assert.ok(definition.phases.length >= 3);
    });
  });

  describe('beforeStep hook', () => {
    it('creates a snapshot before each step when granularity is every_step', async () => {
      const { adapter, stateManager } = createAdapterWithKernel();
      const storyId = 'story-before-step';

      // Seed story and repository
      stateManager.repository.updateStory(storyId, { story_id: storyId, current_phase: 'phase1' });

      // Simulate kernel execution state
      const definition = {
        phases: [
          { id: 'phase1', steps: [{ id: 's1', type: 'agentCall' }, { id: 's2', type: 'noop' }] }
        ]
      };

      // Create an active workflow in the kernel
      const kernel = adapter.kernel;
      const record = {
        workflowId: storyId,
        executionCursor: [{ phase: 0 }, { step: 0 }],
        context: {
          inputs: {},
          outputs: { worldview: { data: { setting: 'Mars' } } },
          steps: {}
        },
        status: 'running'
      };
      kernel.activeWorkflows.set(storyId, {
        stateMachine: { getState: () => 'running', isTerminal: () => false },
        definition,
        record
      });

      // Trigger beforeStep hook manually
      await kernel._callHooks('beforeStep', {
        workflowId: storyId,
        step: { id: 's1', type: 'agentCall' },
        record,
        kernel
      });

      // A snapshot should have been created
      const snapshots = Array.from(stateManager._snapshots.values());
      assert.strictEqual(snapshots.length, 1, 'Should create one snapshot');
      assert.strictEqual(snapshots[0].snapshot_type, 'before_step');
      assert.strictEqual(snapshots[0].phase_name, 'phase1');
    });

    it('creates pre_checkpoint snapshot before checkpoint steps', async () => {
      const { adapter, stateManager } = createAdapterWithKernel();
      const storyId = 'story-checkpoint';
      stateManager.repository.updateStory(storyId, { story_id: storyId, current_phase: 'phase1' });

      const definition = {
        phases: [
          { id: 'phase1', steps: [{ id: 'cp1', type: 'checkpoint' }] }
        ]
      };

      const kernel = adapter.kernel;
      const record = {
        workflowId: storyId,
        executionCursor: [{ phase: 0 }, { step: 0 }],
        context: {
          inputs: {},
          outputs: {
            worldview: { data: { setting: 'Mars' } },
            characters: { data: [{ name: 'Alice' }] }
          },
          steps: {}
        },
        status: 'running'
      };
      kernel.activeWorkflows.set(storyId, {
        stateMachine: { getState: () => 'running', isTerminal: () => false },
        definition,
        record
      });

      await kernel._callHooks('beforeStep', {
        workflowId: storyId,
        step: { id: 'cp1', type: 'checkpoint' },
        record,
        kernel
      });

      const snapshots = Array.from(stateManager._snapshots.values());
      assert.strictEqual(snapshots.length, 1);
      assert.strictEqual(snapshots[0].snapshot_type, 'pre_checkpoint');
    });
  });

  describe('afterCheckpoint hook', () => {
    it('creates approved snapshot and persists metadata after checkpoint approval', async () => {
      const { adapter, stateManager } = createAdapterWithKernel();
      const storyId = 'story-after-cp';
      stateManager.repository.updateStory(storyId, { story_id: storyId, current_phase: 'phase1' });

      const definition = {
        phases: [
          { id: 'phase1', steps: [{ id: 'cp1', type: 'checkpoint' }] }
        ]
      };

      const kernel = adapter.kernel;
      const record = {
        workflowId: storyId,
        executionCursor: [{ phase: 0 }, { step: 0 }],
        context: {
          inputs: {},
          outputs: { worldview: { data: { setting: 'Mars' } } },
          steps: {}
        },
        status: 'running'
      };
      kernel.activeWorkflows.set(storyId, {
        stateMachine: { getState: () => 'running', isTerminal: () => false },
        definition,
        record
      });

      await kernel._callHooks('afterCheckpoint', {
        workflowId: storyId,
        checkpointId: 'cp-123',
        action: 'approve',
        record,
        kernel
      });

      const snapshots = Array.from(stateManager._snapshots.values());
      assert.strictEqual(snapshots.length, 1);
      assert.strictEqual(snapshots[0].snapshot_type, 'approved');

      // Story record should track the approved snapshot
      const story = stateManager.repository.getStory(storyId);
      assert.ok(story.current_phase1_snapshot_id);
    });

    it('does not create snapshot on checkpoint rejection', async () => {
      const { adapter, stateManager } = createAdapterWithKernel();
      const storyId = 'story-reject-cp';
      stateManager.repository.updateStory(storyId, { story_id: storyId, current_phase: 'phase1' });

      const kernel = adapter.kernel;
      const record = {
        workflowId: storyId,
        executionCursor: [{ phase: 0 }, { step: 0 }],
        context: { inputs: {}, outputs: {}, steps: {} },
        status: 'running'
      };
      kernel.activeWorkflows.set(storyId, {
        stateMachine: { getState: () => 'running', isTerminal: () => false },
        definition: { phases: [{ id: 'phase1', steps: [] }] },
        record
      });

      await kernel._callHooks('afterCheckpoint', {
        workflowId: storyId,
        checkpointId: 'cp-123',
        action: 'reject',
        record,
        kernel
      });

      const snapshots = Array.from(stateManager._snapshots.values());
      assert.strictEqual(snapshots.length, 0);
    });
  });

  describe('legacy checkpoint sync', () => {
    it('syncs active checkpoint and phase1 pending confirmation on checkpoint_pending', async () => {
      const { adapter, stateManager } = createAdapterWithKernel();
      const storyId = 'story-phase1-pending';

      stateManager._stories.set(storyId, {
        story_id: storyId,
        phase1: {
          worldview: { data: { setting: '废土都市' } },
          characters: { data: { protagonists: [{ name: '陈默' }] } },
          validation: { verdict: 'PASS' },
          userConfirmed: false,
          checkpointId: null,
          status: 'running'
        },
        workflow: {
          state: 'waiting_checkpoint',
          currentPhase: 'phase1',
          currentStep: '[{"phase":0},{"step":9}]',
          activeCheckpoint: null,
          history: []
        }
      });

      await adapter._emitLegacyEvent(storyId, {
        eventType: 'workflow.checkpoint_pending',
        payload: {
          checkpointId: 'checkpointPhase1',
          checkpointType: 'phase1_worldview_confirmation',
          phase: 'phase1'
        }
      });

      assert.strictEqual(stateManager._calls.setActiveCheckpoint.length, 1);
      assert.deepStrictEqual(stateManager._calls.setActiveCheckpoint[0], {
        storyId,
        checkpoint: {
          id: 'checkpointPhase1',
          phase: 'phase1',
          type: 'phase1_worldview_confirmation',
          status: 'pending',
          createdAt: stateManager._calls.setActiveCheckpoint[0].checkpoint.createdAt,
          autoContinueOnTimeout: true,
          contractVersion: 'plugin-sdk.v1',
          reviewPayload: {},
          reviewTitle: '世界观与人设审查'
        }
      });

      assert.strictEqual(stateManager._calls.updatePhase1.length, 1);
      assert.deepStrictEqual(stateManager._calls.updatePhase1[0], {
        storyId,
        updates: {
          checkpointId: 'checkpointPhase1',
          status: 'pending_confirmation'
        }
      });
    });
  });

  describe('onRecovery hook', () => {
    it('restores business state from approved snapshots into kernel context', async () => {
      const { adapter, stateManager } = createAdapterWithKernel();
      const storyId = 'story-recovery';

      // Pre-populate an approved snapshot
      stateManager.repository.updateStory(storyId, {
        story_id: storyId,
        current_phase: 'phase1',
        current_phase1_snapshot_id: 'snap-approved-1'
      });
      stateManager.repository.createSnapshot({
        story_id: storyId,
        phase_name: 'phase1',
        snapshot_type: 'approved',
        payload_json: {
          worldview: { setting: 'Future Earth', rules: { physical: 'Normal' } },
          characters: [{ name: 'Bob', identity: 'Engineer' }],
          validation: { verdict: 'PASS' }
        }
      });

      const kernel = adapter.kernel;
      const record = {
        workflowId: storyId,
        executionCursor: [{ phase: 1 }, { step: 0 }], // phase2
        context: { inputs: {}, outputs: {}, steps: {} },
        status: 'recovering',
        definition: {
          phases: [
            { id: 'phase1', steps: [] },
            { id: 'phase2', steps: [{ id: 's1', type: 'agentCall' }] }
          ]
        }
      };

      await kernel._callHooks('onRecovery', {
        workflowId: storyId,
        record,
        kernel
      });

      // Business state from phase1 should be merged into context.outputs
      assert.ok(record.context.outputs.worldview, 'Worldview should be restored');
      assert.strictEqual(record.context.outputs.worldview.setting, 'Future Earth');
      assert.ok(record.context.outputs.characters, 'Characters should be restored');
      assert.strictEqual(record.context.outputs.characters[0].name, 'Bob');
      assert.ok(record.context.outputs.phase1Validation, 'Validation should be restored');
    });

    it('infers phase from story record when executionCursor lacks phase info', async () => {
      const { adapter, stateManager } = createAdapterWithKernel();
      const storyId = 'story-recovery-infer';

      stateManager.repository.updateStory(storyId, {
        story_id: storyId,
        current_phase: 'phase1',
        current_phase1_snapshot_id: 'snap-approved-2'
      });
      stateManager.repository.createSnapshot({
        story_id: storyId,
        phase_name: 'phase1',
        snapshot_type: 'approved',
        payload_json: {
          worldview: { setting: 'Mars Colony' },
          characters: [{ name: 'Alice' }]
        }
      });

      const kernel = adapter.kernel;
      const record = {
        workflowId: storyId,
        executionCursor: [], // empty cursor
        context: { inputs: {}, outputs: {}, steps: {} },
        status: 'recovering'
      };

      await kernel._callHooks('onRecovery', {
        workflowId: storyId,
        record,
        kernel
      });

      assert.ok(record.context.outputs.worldview, 'Worldview should be restored via inferred phase');
      assert.strictEqual(record.context.outputs.worldview.setting, 'Mars Colony');
    });
  });

  describe('Crash recovery end-to-end', () => {
    it('restores business state matching execution cursor position after simulated crash', async () => {
      const { adapter, stateManager } = createAdapterWithKernel();
      const storyId = 'story-crash-e2e';

      // Simulate phase1 completion with approved checkpoint
      stateManager.repository.updateStory(storyId, {
        story_id: storyId,
        current_phase: 'phase2',
        current_phase1_snapshot_id: 'snap-phase1-approved'
      });
      stateManager.repository.createSnapshot({
        story_id: storyId,
        phase_name: 'phase1',
        snapshot_type: 'approved',
        payload_json: {
          worldview: { setting: 'Cyberpunk 2077', rules: { special: 'Neural implants' } },
          characters: [{ name: 'V', identity: 'Mercenary' }],
          validation: { verdict: 'PASS' }
        }
      });

      // Simulate kernel crash: activeWorkflows cleared, but persistence has record
      const kernel = adapter.kernel;
      const crashedRecord = {
        workflowId: storyId,
        definitionRef: 'story-orchestrator-v1',
        status: 'running',
        executionCursor: [{ phase: 1 }, { step: 0 }], // phase2, step 0
        context: {
          inputs: { storyPrompt: 'Test', genre: 'sci-fi' },
          outputs: {},
          steps: {}
        },
        checkpointState: null,
        retryContext: {},
        history: [],
        runToken: 'rt-old',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      };

      // Store record in a mock stateRepository that the kernel can read
      kernel.stateRepository = {
        async get(id) {
          if (id === storyId) return crashedRecord;
          return null;
        },
        async update() {},
        async appendHistory() {}
      };

      // Call recover — this should trigger onRecovery hooks
      await kernel.recover(storyId);

      // After recovery, the active workflow should have restored business state
      const active = kernel.activeWorkflows.get(storyId);
      assert.ok(active, 'Workflow should be re-hydrated');
      assert.ok(active.record.context.outputs.worldview, 'Worldview should be restored after crash');
      assert.strictEqual(active.record.context.outputs.worldview.setting, 'Cyberpunk 2077');
      assert.ok(active.record.context.outputs.characters, 'Characters should be restored');
      assert.strictEqual(active.record.context.outputs.characters[0].name, 'V');
    });
  });

  describe('Snapshot metadata in events', () => {
    it('stores snapshot metadata in kernel events via appendHistory', async () => {
      const { adapter, stateManager } = createAdapterWithKernel();
      const storyId = 'story-event-meta';
      stateManager.repository.updateStory(storyId, { story_id: storyId, current_phase: 'phase1' });

      const historyEvents = [];
      const kernel = adapter.kernel;
      kernel.stateRepository = {
        async get() { return null; },
        async update() {},
        async appendHistory(workflowId, event) {
          historyEvents.push({ workflowId, ...event });
        }
      };

      const definition = {
        phases: [
          { id: 'phase1', steps: [{ id: 'cp1', type: 'checkpoint' }] }
        ]
      };

      const record = {
        workflowId: storyId,
        executionCursor: [{ phase: 0 }, { step: 0 }],
        context: { inputs: {}, outputs: { worldview: { data: { setting: 'Space' } } }, steps: {} },
        status: 'running'
      };
      kernel.activeWorkflows.set(storyId, {
        stateMachine: { getState: () => 'running', isTerminal: () => false },
        definition,
        record
      });

      await kernel._callHooks('afterCheckpoint', {
        workflowId: storyId,
        checkpointId: 'cp-meta-1',
        action: 'approve',
        record,
        kernel
      });

      assert.strictEqual(historyEvents.length, 1);
      assert.strictEqual(historyEvents[0].type, 'workflow.snapshot_created');
      assert.ok(historyEvents[0].payload.snapshotId);
      assert.strictEqual(historyEvents[0].payload.phaseName, 'phase1');
      assert.strictEqual(historyEvents[0].payload.checkpointId, 'cp-meta-1');
    });
  });
});
