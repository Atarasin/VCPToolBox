'use strict';

const { describe, test, beforeEach, mock } = require('node:test');
const assert = require('node:assert/strict');

const { Phase3_Refinement } = require('../core/Phase3_Refinement');

function createStory(overrides = {}) {
  return {
    id: 'story-phase3',
    createdAt: '2026-01-01T00:00:00.000Z',
    status: 'phase2_completed',
    config: {
      storyPrompt: '关于深空航站 AI 自我裁决的故事',
      genre: '科幻',
      stylePreference: '克制冷感',
      targetWordCount: { min: 2600, max: 3600 }
    },
    phase1: {
      worldview: { setting: '深空航站' },
      characters: [{ name: '许观', role: 'engineer' }],
      status: 'completed',
      userConfirmed: true
    },
    phase2: {
      outline: { chapters: [{ number: 1, title: '预警' }, { number: 2, title: '裁决' }] },
      chapters: [
        {
          number: 1,
          title: '预警',
          content: '第一章原稿内容',
          metrics: { counts: { chineseChars: 800 } }
        },
        {
          number: 2,
          title: '裁决',
          content: '第二章原稿内容',
          metrics: { counts: { chineseChars: 900 } }
        }
      ],
      status: 'completed',
      userConfirmed: true,
      checkpointId: null
    },
    phase3: {
      polishedChapters: [],
      finalValidation: null,
      iterationCount: 0,
      userConfirmed: false,
      checkpointId: null,
      status: 'pending',
      finalEditorOutput: null,
      qualityScores: []
    },
    ...overrides
  };
}

function createDeps(story = createStory()) {
  const state = { current: story, qualityCalls: 0 };

  const stateManager = {
    getStory: mock.fn(async () => state.current),
    updateStory: mock.fn(async (_storyId, updates) => {
      state.current = { ...state.current, ...updates };
      return state.current;
    }),
    updatePhase3: mock.fn(async (_storyId, updates) => {
      state.current = {
        ...state.current,
        phase3: {
          ...(state.current.phase3 || {}),
          ...updates
        }
      };
      return state.current;
    })
  };

  const agentDispatcher = {
    delegate: mock.fn(async (agentType, prompt) => {
      if (agentType === 'finalEditor') {
        return { content: `终校定稿\n${prompt}` };
      }
      return { content: 'unused' };
    })
  };

  const chapterOperations = {
    polishChapter: mock.fn(async (_storyId, chapterNum, chapterContent, _options) => ({
      polishedContent: `[润色${chapterNum}]${chapterContent}`,
      improvements: ['统一文风'],
      metrics: { counts: { chineseChars: chapterContent.length + 100 } }
    }))
  };

  const contentValidator = {
    comprehensiveValidation: mock.fn(async () => ({
      overall: { passed: true, hasCriticalIssues: false, criticalCount: 0 },
      checks: {},
      allIssues: [],
      allSuggestions: []
    })),
    qualityScore: mock.fn(async () => {
      state.qualityCalls += 1;
      return {
        average: state.qualityCalls >= 2 ? 8.2 : 7.4,
        scores: { narrative: state.qualityCalls >= 2 ? 8.2 : 7.4 },
        rawReport: 'quality report'
      };
    })
  };

  const promptBuilder = {
    buildFinalEditorPrompt: mock.fn((content) => `FINAL_PROMPT::${content}`)
  };

  return { state, stateManager, agentDispatcher, chapterOperations, contentValidator, promptBuilder };
}

describe('Phase3_Refinement', () => {
  let deps;
  let phase;

  beforeEach(() => {
    deps = createDeps();
    phase = new Phase3_Refinement({
      stateManager: deps.stateManager,
      agentDispatcher: deps.agentDispatcher,
      chapterOperations: deps.chapterOperations,
      contentValidator: deps.contentValidator,
      promptBuilder: deps.promptBuilder,
      config: { MAX_PHASE_ITERATIONS: 3, QUALITY_THRESHOLD: 8.0 }
    });
  });

  test('constructor initializes phase settings', () => {
    assert.equal(phase.stateManager, deps.stateManager);
    assert.equal(phase.MAX_PHASE_ITERATIONS, 3);
    assert.equal(phase.QUALITY_THRESHOLD, 8.0);
  });

  test('run polishes chapters, validates quality, and creates final checkpoint', async () => {
    const result = await phase.run('story-phase3');

    assert.equal(result.status, 'waiting_checkpoint');
    assert.equal(result.phase, 'phase3');
    assert.equal(result.nextAction, 'user_confirm_final_acceptance');
    assert.match(result.checkpointId, /^cp-3-final-/);
    assert.equal(result.data.iterationCount, 2);
    assert.equal(result.data.averageQualityScore, 7.8);
    assert.equal(deps.chapterOperations.polishChapter.mock.calls.length, 4);
    assert.equal(deps.contentValidator.comprehensiveValidation.mock.calls.length, 2);
    assert.equal(deps.agentDispatcher.delegate.mock.calls[0].arguments[0], 'finalEditor');
  });

  test('final editor prompt and checkpoint generation use polished content', async () => {
    const result = await phase.run('story-phase3');

    assert.equal(deps.promptBuilder.buildFinalEditorPrompt.mock.calls.length, 1);
    const promptInput = deps.promptBuilder.buildFinalEditorPrompt.mock.calls[0].arguments[0];
    assert.match(promptInput, /\[润色1\]/);
    assert.match(promptInput, /\[润色2\]/);
    assert.match(result.checkpointId, /^cp-3-final-/);
  });

  test('quality average helper and approval flow generate final output', async () => {
    assert.equal(
      phase._calculateAverageScore([{ average: 8.2 }, { averageScore: 7.8 }]),
      8
    );

    deps.state.current.phase3 = {
      polishedChapters: [
        { number: 1, title: '预警', content: '终稿章一', metrics: { counts: { chineseChars: 1200 } } }
      ],
      finalEditorOutput: '终校完成',
      qualityScores: [{ average: 8.5 }],
      iterationCount: 1,
      userConfirmed: false,
      checkpointId: 'cp-3-final-approve',
      status: 'waiting_final_acceptance'
    };

    const approval = await phase.continueFromCheckpoint('story-phase3', 'approve');
    assert.equal(approval.status, 'completed');
    assert.equal(approval.nextAction, 'story_completed');
    assert.equal(approval.data.finalOutput.totalWordCount, 1200);
  });

  test('continueFromCheckpoint reject records feedback and reruns phase with async flow', async () => {
    deps.state.current.phase3 = {
      polishedChapters: [],
      finalEditorOutput: '旧终稿',
      qualityScores: [],
      iterationCount: 0,
      userConfirmed: false,
      checkpointId: 'cp-3-final-reject',
      status: 'waiting_final_acceptance'
    };
    deps.state.qualityCalls = 0;

    const result = await phase.continueFromCheckpoint('story-phase3', 'reject', '需要更强的末日压迫感');

    assert.equal(result.status, 'waiting_checkpoint');
    assert.equal(deps.state.current.phase3.lastRejection.feedback, '需要更强的末日压迫感');
    assert.match(result.checkpointId, /^cp-3-final-/);
  });

  test('run handles missing story, missing chapters, and final editor failure', async () => {
    deps.stateManager.getStory.mock.mockImplementationOnce(async () => null);
    const missingStory = await phase.run('missing');
    assert.equal(missingStory.status, 'error');
    assert.match(missingStory.error, /Story not found/);

    deps.stateManager.getStory.mock.mockImplementation(async () => deps.state.current);
    deps.state.current.phase2.chapters = [];
    const missingChapters = await phase.run('story-phase3');
    assert.equal(missingChapters.status, 'failed');
    assert.match(missingChapters.error, /No chapters found/);

    deps.state.current.phase2.chapters = createStory().phase2.chapters;
    deps.state.qualityCalls = 2;
    deps.agentDispatcher.delegate.mock.mockImplementationOnce(async () => {
      throw new Error('editor offline');
    });
    const editorFailure = await phase.run('story-phase3');
    assert.equal(editorFailure.status, 'error');
    assert.match(editorFailure.error, /Final editor failed/);
  });
});
