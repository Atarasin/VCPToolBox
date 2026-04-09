'use strict';

const { describe, test, beforeEach, mock } = require('node:test');
const assert = require('node:assert/strict');

const { Phase1_WorldBuilding } = require('../core/Phase1_WorldBuilding');
const { AGENT_TYPES } = require('../agents/AgentDefinitions');

function createStory(overrides = {}) {
  return {
    id: 'story-phase1',
    config: {
      storyPrompt: '一个关于 AI 在海上城市觉醒的科幻故事',
      genre: '科幻',
      stylePreference: '冷峻写实',
      targetWordCount: { min: 2800, max: 3600 }
    },
    phase1: {},
    ...overrides
  };
}

function createDeps(story = createStory()) {
  const state = { current: story };

  const stateManager = {
    getStory: mock.fn(async () => state.current),
    updatePhase1: mock.fn(async (_storyId, updates) => {
      state.current = {
        ...state.current,
        phase1: {
          ...(state.current.phase1 || {}),
          ...updates
        }
      };
      return state.current;
    }),
    updateStory: mock.fn(async (_storyId, updates) => {
      state.current = { ...state.current, ...updates };
      return state.current;
    }),
    setActiveCheckpoint: mock.fn(async () => undefined),
    appendWorkflowHistory: mock.fn(async () => undefined)
  };

  const agentDispatcher = {
    delegateParallel: mock.fn(async () => ({
      succeeded: [
        {
          agentType: AGENT_TYPES.WORLD_BUILDER,
          result: {
            content: JSON.stringify({
              setting: '海上巨构城市',
              rules: { physical: '意识可迁移', limitations: '迁移有损耗' }
            })
          }
        },
        {
          agentType: AGENT_TYPES.CHARACTER_DESIGNER,
          result: {
            content: JSON.stringify({
              protagonists: [
                {
                  name: '林澜',
                  identity: '维护工程师',
                  motivation: '查明 AI 觉醒真相'
                }
              ]
            })
          }
        }
      ],
      failed: []
    })),
    delegate: mock.fn(async () => ({
      content: '【验证结论】\n通过\n\n【发现的问题】\n无\n\n【修正建议】\n无'
    }))
  };

  return { state, stateManager, agentDispatcher };
}

describe('Phase1_WorldBuilding', () => {
  let deps;
  let phase;

  beforeEach(() => {
    deps = createDeps();
    phase = new Phase1_WorldBuilding({
      stateManager: deps.stateManager,
      agentDispatcher: deps.agentDispatcher,
      promptBuilder: {},
      config: { MAX_PHASE_ITERATIONS: 4 }
    });
  });

  test('constructor initializes dependencies and config', () => {
    assert.equal(phase.stateManager, deps.stateManager);
    assert.equal(phase.agentDispatcher, deps.agentDispatcher);
    assert.equal(phase.maxRevisionAttempts, 4);
  });

  test('run executes world building flow and returns checkpoint payload', async () => {
    const result = await phase.run('story-phase1');

    assert.equal(result.status, 'waiting_checkpoint');
    assert.equal(result.phase, 'phase1');
    assert.equal(result.nextAction, 'phase2');
    assert.match(result.checkpointId, /^cp-phase1-story-phase1-/);
    assert.equal(result.data.worldview.setting, '海上巨构城市');
    assert.equal(result.data.characters.protagonists[0].name, '林澜');

    assert.equal(deps.agentDispatcher.delegateParallel.mock.calls.length, 1);
    const agents = deps.agentDispatcher.delegateParallel.mock.calls[0].arguments[0];
    assert.deepEqual(
      agents.map((item) => item.agentType),
      [AGENT_TYPES.WORLD_BUILDER, AGENT_TYPES.CHARACTER_DESIGNER]
    );
    assert.equal(deps.agentDispatcher.delegate.mock.calls[0].arguments[0], AGENT_TYPES.LOGIC_VALIDATOR);
  });

  test('createCheckpoint stores active checkpoint metadata', async () => {
    const checkpointId = await phase._createCheckpoint('story-phase1');

    assert.match(checkpointId, /^cp-phase1-story-phase1-/);
    assert.equal(deps.stateManager.setActiveCheckpoint.mock.calls.length, 1);
    const payload = deps.stateManager.setActiveCheckpoint.mock.calls[0].arguments[1];
    assert.equal(payload.type, 'worldview_confirmation');
    assert.equal(payload.phase, 'phase1');
    assert.equal(payload.checkpointId, checkpointId);
  });

  test('validation parser extracts pass state, issues, and suggestions', () => {
    const parsed = phase._parseValidationResult(
      '【验证结论】\n不通过\n\n【发现的问题】\n- 世界观冲突（严重）\n- 人物动机不符（重要）\n\n【修正建议】\n- 建议统一年代设定\n- 建议补充人物前史'
    );

    assert.equal(parsed.passed, false);
    assert.equal(parsed.issues.length, 2);
    assert.equal(parsed.issues[0].severity, 'critical');
    assert.equal(parsed.issues[1].severity, 'major');
    assert.deepEqual(parsed.suggestions, ['建议统一年代设定', '建议补充人物前史']);
  });

  test('parsers repair truncated JSON output from agents when possible', () => {
    const worldview = phase._parseWorldview('```json\n{"setting":"海上城邦","rules":{"physical":"潮汐驱动","special":"意识共振","limitations":"会损耗记忆"},"secrets":["旧系统仍在监听"]');
    const characters = phase._parseCharacters('{"protagonists":[{"name":"林澜","identity":"维护工程师","motivation":"查明真相"}],"supportingCharacters":[{"name":"许沉","identity":"档案管理员","relationship":"盟友"}]');

    assert.equal(worldview.setting, '海上城邦');
    assert.equal(worldview.rules.limitations, '会损耗记忆');
    assert.equal(worldview.secrets[0], '旧系统仍在监听');
    assert.equal(characters.protagonists[0].name, '林澜');
    assert.equal(characters.supportingCharacters[0].name, '许沉');
  });

  test('run returns needs_retry when revision also fails validation', async () => {
    deps.agentDispatcher.delegate.mock.mockImplementation(async () => ({
      content: '【验证结论】\n不通过\n\n【发现的问题】\n- 世界观冲突（严重）\n\n【修正建议】\n- 建议统一规则'
    }));

    const result = await phase.run('story-phase1');

    assert.equal(result.status, 'needs_retry');
    assert.equal(result.nextAction, 'retry');
    assert.equal(result.data.revisionAttempts, 1);
  });

  test('run handles missing story and unexpected dispatcher errors', async () => {
    deps.stateManager.getStory.mock.mockImplementationOnce(async () => null);
    const missingStoryResult = await phase.run('missing');
    assert.equal(missingStoryResult.status, 'failed');
    assert.equal(missingStoryResult.data.error, 'Story not found');

    deps.stateManager.getStory.mock.mockImplementation(async () => deps.state.current);
    deps.agentDispatcher.delegateParallel.mock.mockImplementationOnce(async () => {
      throw new Error('parallel dispatch failed');
    });

    const errorResult = await phase.run('story-phase1');
    assert.equal(errorResult.status, 'failed');
    assert.match(errorResult.data.error, /parallel dispatch failed/);
  });
});
