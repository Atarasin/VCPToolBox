'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');

const { StateManager } = require('../core/StateManager');
const { ArtifactManager } = require('../core/ArtifactManager');

function createStateManagerWithRepository(repositoryOverrides = {}) {
  const manager = new StateManager();
  manager.repository = {
    getStoryWithFields: () => null,
    getSnapshot: () => null,
    getCheckpoint: () => null,
    getEvents: () => [],
    ...repositoryOverrides
  };
  return manager;
}

test('StateManager assembles business projections separately from workflow compatibility view', () => {
  const manager = createStateManagerWithRepository({
    getStoryWithFields: () => ({
      story_id: 'story-projection-1',
      status: 'phase2_running',
      version: 7,
      created_at: '2026-05-04T00:00:00.000Z',
      updated_at: '2026-05-04T00:10:00.000Z',
      config_json: JSON.stringify({ genre: 'sci-fi' }),
      current_phase: 'phase2',
      current_step: 'generateOutline',
      workflow_state: 'running',
      retry_context_json: JSON.stringify({ phase: 'phase2', step: 'generateOutline', attempt: 2 }),
      current_phase1_snapshot_id: 'snap-phase1',
      current_phase2_snapshot_id: 'snap-phase2-bad',
      current_phase3_snapshot_id: null,
      final_output_json: null,
      active_checkpoint_id: 'cp-1'
    }),
    getSnapshot: (snapshotId) => {
      if (snapshotId === 'snap-phase1') {
        return {
          payload_json: JSON.stringify({
            worldview: { data: { setting: 'Orbital Ring' } },
            characters: [{ name: 'Lin' }],
            validation: { verdict: 'PASS' },
            status: 'approved'
          })
        };
      }

      if (snapshotId === 'snap-phase2-bad') {
        return {
          payload_json: '{bad json'
        };
      }

      return null;
    },
    getCheckpoint: () => ({
      checkpoint_id: 'cp-1',
      phase_name: 'phase2',
      checkpoint_type: 'outline_confirmation',
      status: 'pending',
      created_at: '2026-05-04T00:09:00.000Z',
      expires_at: null,
      feedback: ''
    }),
    getEvents: () => ([
      {
        created_at: '2026-05-04T00:08:00.000Z',
        event_type: 'workflow.step_completed',
        phase_name: 'phase2',
        event_detail_json: JSON.stringify({ step: 'validateOutline' })
      },
      {
        created_at: '2026-05-04T00:07:00.000Z',
        event_type: 'workflow.started',
        phase_name: 'phase1',
        event_detail_json: JSON.stringify({})
      }
    ])
  });

  const story = manager._assembleStoryFromSQLite('story-projection-1');

  assert.deepEqual(story.phase1.worldview, { data: { setting: 'Orbital Ring' } });
  assert.equal(story.phase1.status, 'approved');
  assert.deepEqual(
    story.phase2,
    {
      outline: null,
      chapters: [],
      currentChapter: 0,
      userConfirmed: false,
      checkpointId: null,
      status: 'pending'
    }
  );
  assert.equal(story.workflow.state, 'running');
  assert.equal(story.workflow.currentPhase, 'phase2');
  assert.equal(story.workflow.currentStep, 'generateOutline');
  assert.equal(story.workflow.retryContext.attempt, 2);
  assert.equal(story.workflow.activeCheckpoint.id, 'cp-1');
  assert.equal(story.workflow.history[0].type, 'workflow.started');
  assert.equal(story.workflow.history[1].step, 'validateOutline');
});

test('StateManager.updateWorkflow patches compatibility view without rewriting business projections', async () => {
  const manager = new StateManager();
  const story = {
    id: 'story-projection-2',
    status: 'phase1_running',
    phase1: {
      worldview: { data: { setting: 'Ruined Coast' } },
      characters: [{ name: 'Chen' }],
      validation: null,
      userConfirmed: false,
      checkpointId: null,
      status: 'running'
    },
    workflow: manager._createWorkflowCompatibilityState({
      state: 'idle',
      currentPhase: 'phase1',
      currentStep: null
    })
  };
  let captured = null;

  manager.getStory = async () => story;
  manager.updateStory = async (storyId, updatedStory, repoUpdates) => {
    captured = { storyId, updatedStory, repoUpdates };
    return updatedStory;
  };

  await manager.updateWorkflow('story-projection-2', {
    state: 'running',
    currentPhase: 'phase2',
    currentStep: 'generateOutline',
    retryContext: {
      phase: 'phase2',
      step: 'generateOutline',
      attempt: 1
    }
  });

  assert.ok(captured, 'updateStory should be called');
  assert.deepEqual(captured.updatedStory.phase1.worldview, { data: { setting: 'Ruined Coast' } });
  assert.equal(captured.updatedStory.workflow.state, 'running');
  assert.equal(captured.updatedStory.workflow.currentPhase, 'phase2');
  assert.equal(captured.updatedStory.workflow.currentStep, 'generateOutline');
  assert.equal(captured.updatedStory.workflow.retryContext.attempt, 1);
  assert.deepEqual(captured.repoUpdates, {
    status: 'phase1_running',
    current_phase: 'phase2',
    current_step: 'generateOutline',
    workflow_state: 'running'
  });
});

test('ArtifactManager indexes plugin artifact projections without treating index failures as runtime failures', async () => {
  const originalMkdir = fs.promises.mkdir;
  const originalWriteFile = fs.promises.writeFile;
  const mkdirCalls = [];
  const writeCalls = [];

  fs.promises.mkdir = async (dir) => {
    mkdirCalls.push(dir);
  };
  fs.promises.writeFile = async (filePath, buffer) => {
    writeCalls.push({ filePath, content: buffer.toString('utf8') });
  };

  try {
    const artifactManager = new ArtifactManager({
      recordArtifact() {
        throw new Error('sqlite unavailable');
      }
    });

    const result = await artifactManager.saveArtifact('story-projection-3', 'prompt', 'hello artifact');

    assert.ok(result.artifactId.startsWith('art-story-projection-3-prompt-'));
    assert.equal(result.sizeBytes, Buffer.byteLength('hello artifact'));
    assert.equal(mkdirCalls.length, 1);
    assert.equal(writeCalls.length, 1);
  } finally {
    fs.promises.mkdir = originalMkdir;
    fs.promises.writeFile = originalWriteFile;
  }
});

test('ArtifactManager.listArtifacts reads projection index through repository helper', () => {
  const rows = [{ artifact_id: 'art-1', artifact_type: 'prompt' }];
  const artifactManager = new ArtifactManager({
    getArtifactIndex(storyId, artifactType) {
      assert.equal(storyId, 'story-projection-4');
      assert.equal(artifactType, 'prompt');
      return rows;
    }
  });

  assert.equal(artifactManager.listArtifacts('story-projection-4', 'prompt'), rows);
});
