'use strict';

const { describe, test, beforeEach, mock } = require('node:test');
const assert = require('node:assert/strict');

const { Phase2_OutlineDrafting } = require('../core/Phase2_OutlineDrafting');

function createStory(overrides = {}) {
  return {
    id: 'story-phase2',
    status: 'phase1_completed',
    config: {
      storyPrompt: 'AI 在极夜殖民地引发的悬疑事件',
      targetWordCount: { min: 3200, max: 4200 },
      genre: '科幻悬疑',
      stylePreference: '压抑紧张'
    },
    phase1: {
      worldview: { setting: '极夜殖民地' },
      characters: [{ name: '周岚', role: 'investigator' }],
      status: 'completed',
      userConfirmed: true
    },
    phase2: {
      outline: null,
      chapters: [],
      currentChapter: 0,
      userConfirmed: false,
      checkpointId: null,
      status: 'pending'
    },
    ...overrides
  };
}

function createDeps(story = createStory()) {
  const state = { current: story };

  const stateManager = {
    getStory: mock.fn(async () => state.current),
    updateStory: mock.fn(async (_storyId, updates) => {
      state.current = { ...state.current, ...updates };
      return state.current;
    }),
    updatePhase2: mock.fn(async (_storyId, updates) => {
      state.current = {
        ...state.current,
        phase2: {
          ...(state.current.phase2 || {}),
          ...updates
        }
      };
      return state.current;
    })
  };

  const outlineText = [
    '第1章 失联前夜',
    '核心事件：调查员收到第一条异常告警',
    '场景：北区机房',
    '人物：周岚, 值班 AI',
    '字数分配：约2500字',
    '',
    '第2章 数据雪崩',
    '核心事件：殖民地监控集体黑屏',
    '场景：中央塔',
    '人物：周岚, 指挥官',
    '字数分配：约2800字'
  ].join('\n');

  const agentDispatcher = {
    delegate: mock.fn(async (agentType) => {
      if (agentType === 'plotArchitect') {
        return { content: outlineText };
      }
      return {
        content: '【验证结论】\n通过\n\n【问题清单】\n（无）\n\n【修正建议】\n（无）'
      };
    })
  };

  const chapterOperations = {
    createChapterDraft: mock.fn(async (_storyId, chapterNum) => ({
      content: `第${chapterNum}章草稿内容`.repeat(200),
      metrics: {
        counts: { actualCount: 2600 },
        validation: { isQualified: true, deficit: 0 }
      }
    })),
    fillDetails: mock.fn(async (_storyId, _chapterNum, content) => ({
      detailedContent: `${content}\n补充细节`
    })),
    countChapterLength: mock.fn((_content, targetMin) => ({
      counts: { actualCount: Math.max(targetMin, 2600) },
      validation: { isQualified: true, deficit: 0 }
    })),
    reviseChapter: mock.fn(async (_storyId, _chapterNum, content) => ({
      revisedContent: `${content}\n修订版`
    })),
    _expandChapter: mock.fn(async (_storyId, content) => ({
      content: `${content}\n扩写版`
    }))
  };

  const contentValidator = {
    comprehensiveValidation: mock.fn(async () => ({
      overall: { passed: true, hasCriticalIssues: false, criticalCount: 0 },
      checks: {},
      allIssues: [],
      allSuggestions: []
    }))
  };

  const promptBuilder = {
    buildOutlinePrompt: mock.fn(({ storyPrompt }) => `OUTLINE::${storyPrompt}`)
  };

  return { state, stateManager, agentDispatcher, chapterOperations, contentValidator, promptBuilder };
}

describe('Phase2_OutlineDrafting', () => {
  let deps;
  let phase;

  beforeEach(() => {
    deps = createDeps();
    phase = new Phase2_OutlineDrafting({
      stateManager: deps.stateManager,
      agentDispatcher: deps.agentDispatcher,
      chapterOperations: deps.chapterOperations,
      contentValidator: deps.contentValidator,
      promptBuilder: deps.promptBuilder,
      config: { MAX_OUTLINE_REVISION_ATTEMPTS: 2, MAX_CHAPTER_REVISION_ATTEMPTS: 1 }
    });
  });

  test('constructor initializes dependencies and retry limits', () => {
    assert.equal(phase.stateManager, deps.stateManager);
    assert.equal(phase.agentDispatcher, deps.agentDispatcher);
    assert.equal(phase.maxRevisionAttempts, 2);
    assert.equal(phase.maxChapterRevisions, 1);
  });

  test('run generates outline and returns checkpoint for approval', async () => {
    const result = await phase.run('story-phase2');

    assert.equal(result.status, 'waiting_checkpoint');
    assert.equal(result.phase, 'phase2');
    assert.equal(result.nextAction, 'outline_confirmation');
    assert.match(result.checkpointId, /^cp-outline-/);
    assert.equal(result.data.outline.chapters.length, 2);
    assert.equal(result.data.outline.chapters[0].coreEvent, '调查员收到第一条异常告警');

    assert.equal(deps.promptBuilder.buildOutlinePrompt.mock.calls.length, 1);
    assert.equal(deps.agentDispatcher.delegate.mock.calls[0].arguments[0], 'plotArchitect');
    assert.equal(deps.agentDispatcher.delegate.mock.calls[1].arguments[0], 'logicValidator');
  });

  test('outline generation stores checkpoint and pending confirmation state', async () => {
    const result = await phase._generateOutline('story-phase2');

    assert.equal(result.status, 'waiting_checkpoint');
    const updates = deps.stateManager.updatePhase2.mock.calls.map((call) => call.arguments[1]);
    assert.ok(updates.some((item) => item.status === 'pending_confirmation'));
    assert.ok(updates.some((item) => typeof item.checkpointId === 'string' && item.checkpointId.startsWith('cp-outline-')));
  });

  test('validation parser handles text and JSON formats', () => {
    const textParsed = phase._parseOutlineValidationResult(
      '【验证结论】\n不通过\n\n【问题清单】\n- 章节逻辑不通\n- 建议增强转场\n\n【修正建议】\n- 调整第二章节奏'
    );
    assert.equal(textParsed.passed, false);
    assert.ok(textParsed.issues.length >= 1);
    assert.ok(textParsed.suggestions.length >= 1);

    const jsonParsed = phase._parseOutlineValidationResult(
      '<<<VALIDATION_RESULT开始>>>{"verdict":"PASS_WITH_WARNINGS","confidence":4,"blocking_issues":[],"non_blocking_issues":["节奏偏慢"],"revision_priorities":["收紧第二章"]}<<<VALIDATION_RESULT结束>>>'
    );
    assert.equal(jsonParsed.verdict, 'PASS_WITH_WARNINGS');
    assert.equal(jsonParsed.passed, true);
    assert.deepEqual(jsonParsed.nonBlockingIssues, ['节奏偏慢']);
  });

  test('continueFromCheckpoint approve uses confirmed outline for async content production', async () => {
    deps.state.current.phase2 = {
      outline: {
        chapters: [
          { number: 1, title: '第1章', coreEvent: '事件一', wordCountTarget: 2500 },
          { number: 2, title: '第2章', coreEvent: '事件二', wordCountTarget: 2500 }
        ]
      },
      chapters: [],
      checkpointId: 'cp-outline-approve',
      status: 'pending_confirmation',
      userConfirmed: false
    };

    const result = await phase.continueFromCheckpoint('story-phase2', 'approve');

    assert.equal(result.status, 'waiting_checkpoint');
    assert.equal(result.data.chaptersCompleted, 2);
    assert.equal(deps.chapterOperations.createChapterDraft.mock.calls.length, 2);
    assert.equal(deps.contentValidator.comprehensiveValidation.mock.calls.length, 2);
  });

  test('run throws when story is missing and produceContent errors without chapters', async () => {
    deps.stateManager.getStory.mock.mockImplementationOnce(async () => null);
    await assert.rejects(() => phase.run('missing-story'), /Story not found/);

    deps.state.current.phase2 = {
      outline: { chapters: [] },
      chapters: [],
      status: 'content_production',
      userConfirmed: true
    };
    const result = await phase._produceContent('story-phase2');
    assert.equal(result.status, 'error');
    assert.match(result.error, /No chapters/);
  });
});
