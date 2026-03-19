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

test('状态机在 SETUP_WORLD 设计者 acted 后切换到 critic 回合', () => {
  const designerTransition = applyStateTransition(
    {
      projectId: 'p2',
      state: 'SETUP_WORLD',
      substate: null,
      debate: {
        role: 'designer',
        round: 0,
        maxRounds: 3
      }
    },
    {
      ackStatus: 'acted'
    }
  );
  assert.equal(designerTransition.project.state, 'SETUP_WORLD');
  assert.equal(designerTransition.project.debate.role, 'critic');
  assert.equal(designerTransition.advanced, false);

  const criticTransition = applyStateTransition(
    designerTransition.project,
    {
      ackStatus: 'acted',
      metrics: {
        setupScore: 92
      },
      qualityGate: {
        passed: true,
        score: 92
      }
    }
  );
  assert.equal(criticTransition.project.state, 'SETUP_CHARACTER');
  assert.equal(criticTransition.project.debate.role, 'designer');
  assert.equal(criticTransition.project.debate.round, 0);
  assert.equal(criticTransition.advanced, true);
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

test('状态机在 critic 评分不达标时增加轮次并回到 designer', () => {
  const transition = applyStateTransition(
    {
      projectId: 'p4',
      state: 'SETUP_CHARACTER',
      substate: null,
      qualityPolicy: {
        setupPassThreshold: 90
      },
      debate: {
        role: 'critic',
        round: 1,
        maxRounds: 3
      }
    },
    {
      ackStatus: 'acted',
      metrics: {
        setupScore: 80
      },
      qualityGate: {
        passed: false,
        score: 80
      }
    }
  );
  assert.equal(transition.project.state, 'SETUP_CHARACTER');
  assert.equal(transition.project.debate.role, 'designer');
  assert.equal(transition.project.debate.round, 2);
  assert.equal(transition.reason, 'setup_critic_not_passed_retry');
});
