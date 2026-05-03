const { describe, it } = require('node:test');
const assert = require('node:assert');

const {
  normalizeWorldview,
  normalizeCharacters,
  deriveActiveCheckpoint,
  derivePhaseStatus,
  formatStoryListItem
} = require('../index.js');

describe('StoryOrchestratorPanel formatting', () => {
  it('normalizes worldview from kernel data envelope', () => {
    const worldview = normalizeWorldview({
      data: {
        setting: '废土都市',
        rules: { physical: '守恒' },
        factions: [{ name: '联盟' }],
        history: { keyEvents: ['灾变'] },
        secrets: ['真相']
      },
      meta: { usedParser: 'jsonBlock' }
    });

    assert.strictEqual(worldview.setting, '废土都市');
    assert.deepStrictEqual(worldview.rules, { physical: '守恒' });
    assert.strictEqual(worldview.factions.length, 1);
    assert.deepStrictEqual(worldview.history, { keyEvents: ['灾变'] });
    assert.deepStrictEqual(worldview.secrets, ['真相']);
  });

  it('normalizes characters from kernel data envelope', () => {
    const characters = normalizeCharacters({
      data: {
        protagonists: [{ name: '陈默' }],
        supportingCharacters: [{ name: '老周' }],
        antagonists: [{ name: '赵强' }]
      },
      meta: { usedParser: 'jsonBlock' }
    });

    assert.strictEqual(characters.characters.length, 3);
    assert.deepStrictEqual(characters.summary, {
      protagonists: 1,
      supporting: 1,
      antagonists: 1
    });
  });

  it('derives pending checkpoint from workflow history when activeCheckpoint is missing', () => {
    const checkpoint = deriveActiveCheckpoint({
      status: 'waiting_checkpoint',
      workflow: {
        currentPhase: 'phase1',
        activeCheckpoint: null,
        history: [
          {
            at: '2026-05-02T13:08:29.263Z',
            type: 'checkpoint_pending',
            phase: 'unknown',
            detail: {
              checkpointId: 'checkpointPhase1',
              checkpointType: 'phase1_worldview_confirmation'
            }
          }
        ]
      }
    });

    assert.deepStrictEqual(checkpoint, {
      id: 'checkpointPhase1',
      phase: 'phase1',
      type: 'phase1_worldview_confirmation',
      status: 'pending',
      createdAt: '2026-05-02T13:08:29.263Z'
    });
  });

  it('treats phase1 as pending confirmation when workflow is waiting at its checkpoint', () => {
    const status = derivePhaseStatus({
      status: 'waiting_checkpoint',
      workflow: {
        state: 'waiting_checkpoint',
        currentPhase: 'phase1',
        activeCheckpoint: null,
        history: [
          {
            at: '2026-05-02T13:08:29.263Z',
            type: 'checkpoint_pending',
            phase: 'unknown',
            detail: {
              checkpointId: 'checkpointPhase1',
              checkpointType: 'phase1_worldview_confirmation'
            }
          }
        ]
      },
      phase1: { status: 'running' }
    }, 'phase1');

    assert.strictEqual(status, 'pending_confirmation');
  });

  it('marks waiting checkpoint stories as needing review in story list items', () => {
    const listItem = formatStoryListItem({
      id: 'story-123',
      status: 'waiting_checkpoint',
      createdAt: '2026-05-02T13:05:06.019Z',
      updatedAt: '2026-05-02T13:08:29.264Z',
      config: {
        storyPrompt: '测试故事提示词',
        genre: '科幻灾难',
        targetWordCount: { min: 4000, max: 5000 }
      },
      phase1: { status: 'running' },
      phase2: { status: 'pending' },
      phase3: { status: 'pending' },
      workflow: {
        state: 'waiting_checkpoint',
        currentPhase: 'phase1',
        activeCheckpoint: null,
        history: [
          {
            at: '2026-05-02T13:08:29.263Z',
            type: 'checkpoint_pending',
            phase: 'unknown',
            detail: {
              checkpointId: 'checkpointPhase1',
              checkpointType: 'phase1_worldview_confirmation'
            }
          }
        ]
      }
    });

    assert.strictEqual(listItem.checkpointPending, true);
    assert.strictEqual(listItem.checkpointType, 'phase1_worldview_confirmation');
  });
});
