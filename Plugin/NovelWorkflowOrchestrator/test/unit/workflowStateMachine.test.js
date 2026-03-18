const test = require('node:test');
const assert = require('node:assert/strict');
const { applyStateTransition } = require('../../lib/core/workflowStateMachine');

test('状态机在 INIT 且无回执时自动进入 SETUP_WORLD', () => {
  const transition = applyStateTransition({
    projectId: 'p1',
    state: 'INIT',
    substate: null
  });
  assert.equal(transition.project.state, 'SETUP_WORLD');
  assert.equal(transition.advanced, true);
  assert.equal(transition.reason, 'init_bootstrap');
});

test('状态机在 SETUP_WORLD 收到 acted 回执后推进到 SETUP_CHARACTER', () => {
  const transition = applyStateTransition(
    {
      projectId: 'p2',
      state: 'SETUP_WORLD',
      substate: null
    },
    {
      ackStatus: 'acted'
    }
  );
  assert.equal(transition.project.state, 'SETUP_CHARACTER');
  assert.equal(transition.advanced, true);
});

test('章节审核重大问题时从 CH_REVIEW 路由到 CH_REFLOW', () => {
  const transition = applyStateTransition(
    {
      projectId: 'p3',
      state: 'CHAPTER_CREATION',
      substate: 'CH_REVIEW'
    },
    {
      ackStatus: 'acted',
      issueSeverity: 'major'
    }
  );
  assert.equal(transition.project.state, 'CHAPTER_CREATION');
  assert.equal(transition.project.substate, 'CH_REFLOW');
  assert.equal(transition.advanced, true);
});
