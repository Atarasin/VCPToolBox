const test = require('node:test');
const assert = require('node:assert/strict');
const {
  updateStagnation,
  shouldOpenManualByStagnation,
  openManualReview,
  applyManualReply
} = require('../../lib/managers/manualInterventionManager');

test('停滞计数在未推进时累加并可触发人工介入', () => {
  const project = updateStagnation(
    {
      stagnation: {
        unchangedTicks: 2,
        threshold: 3
      }
    },
    false,
    {
      stagnantTickThreshold: 3
    }
  );
  assert.equal(project.stagnation.unchangedTicks, 3);
  assert.equal(shouldOpenManualByStagnation(project), true);
});

test('人工介入打开后进入等待状态', async () => {
  const records = new Map();
  const store = {
    putManualReview: async (projectId, payload) => {
      records.set(projectId, payload);
    }
  };
  const opened = await openManualReview(
    store,
    {
      projectId: 'p1',
      state: 'SETUP_WORLD',
      substate: null,
      stagnation: {
        unchangedTicks: 3
      }
    },
    {
      triggerReason: 'stagnant_ticks_exceeded'
    }
  );
  assert.equal(opened.project.state, 'PAUSED_MANUAL_REVIEW');
  assert.equal(records.get('p1').status, 'waiting_human_reply');
});

test('人工回复 resume 后恢复到指定阶段', async () => {
  let stored = {
    projectId: 'p2',
    status: 'waiting_human_reply'
  };
  const store = {
    getManualReview: async () => stored,
    putManualReview: async (_projectId, payload) => {
      stored = payload;
    }
  };
  const result = await applyManualReply(
    store,
    {
      projectId: 'p2',
      state: 'PAUSED_MANUAL_REVIEW',
      substate: null,
      manualReview: {
        status: 'waiting_human_reply',
        resumeStage: 'CHAPTER_CREATION',
        resumeSubstate: 'CH_REFLOW'
      },
      stagnation: {
        unchangedTicks: 5
      }
    },
    {
      manualReplies: [
        {
          projectId: 'p2',
          decision: 'resume'
        }
      ]
    }
  );
  assert.equal(result.resolved, true);
  assert.equal(result.project.state, 'CHAPTER_CREATION');
  assert.equal(result.project.substate, 'CH_REFLOW');
  assert.equal(stored.status, 'resolved');
});
