'use strict';

const { test, describe, beforeEach, mock } = require('node:test');
const assert = require('node:assert');

const { Phase3_Refinement } = require('../core/Phase3_Refinement');

/**
 * Helper: Create mock AgentDispatcher
 */
function createMockAgentDispatcher(behavior = {}) {
  const calls = [];

  return {
    calls,
    delegate: async (agentType, prompt, options) => {
      calls.push({ agentType, prompt, options });

      if (behavior.delegateResult) {
        return behavior.delegateResult(agentType, prompt, options);
      }

      if (agentType === 'finalEditor') {
        return {
          content: behavior.finalEditorContent || '【终校定稿】\n\n这是经过润色校验后的最终故事文本。'
        };
      }

      return { content: 'Default mock response' };
    },
    resetCalls: () => { calls.length = 0; }
  };
}

/**
 * Helper: Create mock StateManager
 */
function createMockStateManager(behavior = {}) {
  const stories = new Map();

  if (behavior.initialStory) {
    stories.set(behavior.initialStory.id, behavior.initialStory);
  }

  return {
    stories,
    getStory: async (storyId) => {
      if (behavior.getStory) return behavior.getStory(storyId);
      return stories.get(storyId) || null;
    },
    updateStory: async (storyId, updates) => {
      const story = stories.get(storyId) || {};
      const updated = { ...story, ...updates, updatedAt: new Date().toISOString() };
      stories.set(storyId, updated);
      if (behavior.updateStory) behavior.updateStory(storyId, updated);
      return updated;
    },
    updatePhase3: async (storyId, updates) => {
      const story = stories.get(storyId) || {};
      if (!story.phase3) {
        story.phase3 = {};
      }
      story.phase3 = { ...story.phase3, ...updates };
      story.updatedAt = new Date().toISOString();
      stories.set(storyId, story);
      if (behavior.updatePhase3) behavior.updatePhase3(storyId, story);
      return story;
    },
    createStory: async (storyPrompt, config) => {
      const storyId = `story-${Date.now()}`;
      const story = {
        id: storyId,
        status: 'phase2_completed',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        config: {
          targetWordCount: config?.targetWordCount || { min: 2500, max: 3500 },
          genre: config?.genre || 'general',
          stylePreference: config?.stylePreference || '',
          storyPrompt: storyPrompt
        },
        phase1: {
          worldview: { name: '测试世界观' },
          characters: [{ name: '主角' }],
          status: 'completed',
          userConfirmed: true
        },
        phase2: {
          outline: { chapters: [{ number: 1, title: '测试' }] },
          chapters: [],
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
          status: 'pending'
        }
      };
      stories.set(storyId, story);
      return story;
    },
    clear: () => { stories.clear(); }
  };
}

/**
 * Helper: Create mock ChapterOperations
 */
function createMockChapterOperations(behavior = {}) {
  return {
    polishChapter: async (storyId, chapterNum, chapterContent, options) => {
      if (behavior.polishChapter) {
        return behavior.polishChapter(storyId, chapterNum, chapterContent, options);
      }
      return {
        polishedContent: behavior.polishedContent || `[润色版] ${chapterContent}`,
        improvements: ['文风优化', '句式调整'],
        metrics: {
          counts: { chineseChars: (chapterContent || '').length + 100 }
        },
        agentResponse: { content: '章节润色完成' }
      };
    }
  };
}

/**
 * Helper: Create mock ContentValidator
 */
function createMockContentValidator(behavior = {}) {
  return {
    comprehensiveValidation: async (storyId, chapterNum, content, storyBible) => {
      if (behavior.comprehensiveValidation) {
        return behavior.comprehensiveValidation(storyId, chapterNum, content, storyBible);
      }
      return behavior.validationResult || {
        overall: { passed: true, hasCriticalIssues: false, criticalCount: 0 },
        checks: { worldview: { passed: true }, characters: { passed: true }, plot: { passed: true } },
        allIssues: [],
        allSuggestions: []
      };
    },
    qualityScore: async (content) => {
      if (behavior.qualityScore) {
        return behavior.qualityScore(content);
      }
      return behavior.qualityScoreResult || {
        average: 8.0,
        scores: { 叙事流畅度: 8, 描写生动度: 8, 对话自然度: 8, 节奏把控: 8, 吸引力: 8 },
        rawReport: '质量评分：8.0分'
      };
    }
  };
}

/**
 * Helper: Create mock PromptBuilder
 */
function createMockPromptBuilder(behavior = {}) {
  return {
    buildFinalEditorPrompt: (content) => {
      if (behavior.buildFinalEditorPrompt) {
        return behavior.buildFinalEditorPrompt(content);
      }
      return `【终校定稿】\n请对以下内容进行最终校订：\n\n${content}`;
    },
    buildStylePolisherPrompt: (content) => {
      return `【文笔润色】请优化以下内容：\n\n${content}`;
    }
  };
}

/**
 * Helper: Create test story with chapters
 */
function createTestStory(overrides = {}) {
  const chapters = [
    {
      number: 1,
      title: '第一章：觉醒',
      content: '这是第一章的原始内容，需要进行润色校验。故事开始于一个普通的早晨。',
      metrics: { counts: { chineseChars: 500 } }
    },
    {
      number: 2,
      title: '第二章：探索',
      content: '第二章的内容延续了故事的发展，主角开始探索这个世界的秘密。',
      metrics: { counts: { chineseChars: 600 } }
    }
  ];

  return {
    id: 'test-story-123',
    status: 'phase2_completed',
    config: {
      targetWordCount: { min: 2500, max: 3500 },
      genre: '科幻',
      stylePreference: '硬科幻风格',
      storyPrompt: '一个关于AI觉醒的故事'
    },
    phase1: {
      worldview: { name: '未来世界', rules: ['AI不得伤害人类', 'AI可以进化'] },
      characters: [
        { name: '主角', personality: '好奇心强', role: 'protagonist' },
        { name: '配角', personality: '谨慎', role: 'supporting' }
      ],
      status: 'completed',
      userConfirmed: true
    },
    phase2: {
      outline: { chapters: chapters.map(ch => ({ number: ch.number, title: ch.title })) },
      chapters: chapters,
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
      status: 'pending'
    },
    ...overrides
  };
}

/**
 * Helper: Create quality score result with specified average
 */
function createQualityScoreResult(average, scores = {}) {
  const defaultScores = {
    叙事流畅度: average,
    描写生动度: average,
    对话自然度: average,
    节奏把控: average,
    吸引力: average
  };
  return {
    average,
    scores: { ...defaultScores, ...scores },
    rawReport: `质量评分：${average}分`
  };
}

describe('Phase3_Refinement', () => {

  describe('constructor', () => {
    test('should initialize with provided dependencies', () => {
      const mockStateManager = createMockStateManager();
      const mockAgentDispatcher = createMockAgentDispatcher();
      const mockChapterOperations = createMockChapterOperations();
      const mockContentValidator = createMockContentValidator();
      const mockPromptBuilder = createMockPromptBuilder();

      const phase3 = new Phase3_Refinement({
        stateManager: mockStateManager,
        agentDispatcher: mockAgentDispatcher,
        chapterOperations: mockChapterOperations,
        contentValidator: mockContentValidator,
        promptBuilder: mockPromptBuilder,
        config: {}
      });

      assert.strictEqual(phase3.stateManager, mockStateManager);
      assert.strictEqual(phase3.agentDispatcher, mockAgentDispatcher);
      assert.strictEqual(phase3.chapterOperations, mockChapterOperations);
      assert.strictEqual(phase3.contentValidator, mockContentValidator);
    });

    test('should use default MAX_PHASE_ITERATIONS of 5', () => {
      const mockStateManager = createMockStateManager();
      const phase3 = new Phase3_Refinement({
        stateManager: mockStateManager,
        agentDispatcher: createMockAgentDispatcher(),
        chapterOperations: createMockChapterOperations(),
        contentValidator: createMockContentValidator(),
        promptBuilder: createMockPromptBuilder(),
        config: {}
      });
      assert.strictEqual(phase3.MAX_PHASE_ITERATIONS, 5);
    });

    test('should use default QUALITY_THRESHOLD of 8.0', () => {
      const mockStateManager = createMockStateManager();
      const phase3 = new Phase3_Refinement({
        stateManager: mockStateManager,
        agentDispatcher: createMockAgentDispatcher(),
        chapterOperations: createMockChapterOperations(),
        contentValidator: createMockContentValidator(),
        promptBuilder: createMockPromptBuilder(),
        config: {}
      });
      assert.strictEqual(phase3.QUALITY_THRESHOLD, 8.0);
    });

    test('should accept custom config values', () => {
      const mockStateManager = createMockStateManager();
      const phase3 = new Phase3_Refinement({
        stateManager: mockStateManager,
        agentDispatcher: createMockAgentDispatcher(),
        chapterOperations: createMockChapterOperations(),
        contentValidator: createMockContentValidator(),
        promptBuilder: createMockPromptBuilder(),
        config: {
          MAX_PHASE_ITERATIONS: 10,
          QUALITY_THRESHOLD: 9.0,
          CRITICAL_ISSUE_THRESHOLD: 2
        }
      });
      assert.strictEqual(phase3.MAX_PHASE_ITERATIONS, 10);
      assert.strictEqual(phase3.QUALITY_THRESHOLD, 9.0);
      assert.strictEqual(phase3.CRITICAL_ISSUE_THRESHOLD, 2);
    });
  });

  describe('run() - polish-validate iteration loop', () => {

    test('should exit loop when quality threshold (8.0) is met on first iteration', async () => {
      const story = createTestStory();
      const mockStateManager = createMockStateManager({ initialStory: story });
      const mockAgentDispatcher = createMockAgentDispatcher();
      const mockChapterOperations = createMockChapterOperations();
      const mockContentValidator = createMockContentValidator({
        qualityScoreResult: createQualityScoreResult(8.5)
      });
      const mockPromptBuilder = createMockPromptBuilder();

      const phase3 = new Phase3_Refinement({
        stateManager: mockStateManager,
        agentDispatcher: mockAgentDispatcher,
        chapterOperations: mockChapterOperations,
        contentValidator: mockContentValidator,
        promptBuilder: mockPromptBuilder,
        config: {}
      });

      const result = await phase3.run('test-story-123');

      assert.strictEqual(result.status, 'waiting_checkpoint');
      assert.strictEqual(result.data.iterationCount, 1);
      assert.strictEqual(result.data.averageQualityScore, 8.5);
    });

    test('should iterate until quality threshold is met', async () => {
      const story = createTestStory();
      const mockStateManager = createMockStateManager({ initialStory: story });
      const mockAgentDispatcher = createMockAgentDispatcher();
      const mockChapterOperations = createMockChapterOperations();
      const callTracker = { qualityScoreCalls: 0 };
      const mockContentValidator = createMockContentValidator({
        qualityScore: async (content) => {
          callTracker.qualityScoreCalls++;
          // First 2 iterations below threshold, third meets threshold
          const average = callTracker.qualityScoreCalls >= 3 ? 8.2 : 7.0;
          return createQualityScoreResult(average);
        }
      });
      const mockPromptBuilder = createMockPromptBuilder();

      const phase3 = new Phase3_Refinement({
        stateManager: mockStateManager,
        agentDispatcher: mockAgentDispatcher,
        chapterOperations: mockChapterOperations,
        contentValidator: mockContentValidator,
        promptBuilder: mockPromptBuilder,
        config: {}
      });

      const result = await phase3.run('test-story-123');

      assert.strictEqual(result.status, 'waiting_checkpoint');
      assert.strictEqual(result.data.iterationCount, 3);
      assert.strictEqual(callTracker.qualityScoreCalls, 3);
    });

    test('should reach max iterations (5) and exit even if threshold not met', async () => {
      const story = createTestStory();
      const mockStateManager = createMockStateManager({ initialStory: story });
      const mockAgentDispatcher = createMockAgentDispatcher();
      const mockChapterOperations = createMockChapterOperations();
      let iterationCount = 0;
      const mockContentValidator = createMockContentValidator({
        qualityScore: async () => {
          iterationCount++;
          return createQualityScoreResult(7.5); // Always below threshold
        }
      });
      const mockPromptBuilder = createMockPromptBuilder();

      const phase3 = new Phase3_Refinement({
        stateManager: mockStateManager,
        agentDispatcher: mockAgentDispatcher,
        chapterOperations: mockChapterOperations,
        contentValidator: mockContentValidator,
        promptBuilder: mockPromptBuilder,
        config: {}
      });

      const result = await phase3.run('test-story-123');

      assert.strictEqual(result.status, 'waiting_checkpoint');
      assert.strictEqual(result.data.iterationCount, 5);
      assert.strictEqual(iterationCount, 5);
    });

    test('should not exit if quality threshold met but critical issues exist', async () => {
      const story = createTestStory();
      const mockStateManager = createMockStateManager({ initialStory: story });
      const mockAgentDispatcher = createMockAgentDispatcher();
      const mockChapterOperations = createMockChapterOperations();
      let iterationCount = 0;
      const mockContentValidator = createMockContentValidator({
        qualityScoreResult: createQualityScoreResult(8.5), // Above threshold
        comprehensiveValidation: async () => ({
          overall: { passed: false, hasCriticalIssues: true, criticalCount: 1 },
          checks: { worldview: { passed: true }, characters: { passed: true }, plot: { passed: false } },
          allIssues: [{ description: '情节逻辑冲突', severity: 'critical' }],
          allSuggestions: []
        })
      });
      const mockPromptBuilder = createMockPromptBuilder();

      const phase3 = new Phase3_Refinement({
        stateManager: mockStateManager,
        agentDispatcher: mockAgentDispatcher,
        chapterOperations: mockChapterOperations,
        contentValidator: mockContentValidator,
        promptBuilder: mockPromptBuilder,
        config: {}
      });

      const result = await phase3.run('test-story-123');

      // Should iterate until max since critical issues prevent exit
      assert.strictEqual(result.status, 'waiting_checkpoint');
      assert.strictEqual(result.data.iterationCount, 5); // Max iterations
    });

    test('should call chapterOperations.polishChapter for each chapter per iteration', async () => {
      const story = createTestStory();
      const mockStateManager = createMockStateManager({ initialStory: story });
      const mockAgentDispatcher = createMockAgentDispatcher();
      let polishCallCount = 0;
      const mockChapterOperations = createMockChapterOperations({
        polishChapter: async (storyId, chapterNum, chapterContent, options) => {
          polishCallCount++;
          return {
            polishedContent: `[润色版 ${chapterNum}] ${chapterContent}`,
            improvements: ['优化1'],
            metrics: { counts: { chineseChars: chapterContent.length + 50 } }
          };
        }
      });
      const mockContentValidator = createMockContentValidator({
        qualityScoreResult: createQualityScoreResult(8.5) // Exit on first iteration
      });
      const mockPromptBuilder = createMockPromptBuilder();

      const phase3 = new Phase3_Refinement({
        stateManager: mockStateManager,
        agentDispatcher: mockAgentDispatcher,
        chapterOperations: mockChapterOperations,
        contentValidator: mockContentValidator,
        promptBuilder: mockPromptBuilder,
        config: {}
      });

      await phase3.run('test-story-123');

      // 2 chapters × 1 iteration = 2 polish calls
      assert.strictEqual(polishCallCount, 2);
    });

    test('should preserve chapter content through iterations', async () => {
      const story = createTestStory();
      const mockStateManager = createMockStateManager({ initialStory: story });
      const mockAgentDispatcher = createMockAgentDispatcher();
      let iterationContent = [];
      const mockChapterOperations = createMockChapterOperations({
        polishChapter: async (storyId, chapterNum, chapterContent, options) => {
          iterationContent.push(chapterContent);
          return {
            polishedContent: `[迭代] ${chapterContent}`,
            improvements: ['优化'],
            metrics: { counts: { chineseChars: chapterContent.length + 20 } }
          };
        }
      });
      const mockContentValidator = createMockContentValidator({
        qualityScore: async (content) => {
          const avg = content.includes('迭代') ? 8.5 : 7.0;
          return createQualityScoreResult(avg);
        }
      });
      const mockPromptBuilder = createMockPromptBuilder();

      const phase3 = new Phase3_Refinement({
        stateManager: mockStateManager,
        agentDispatcher: mockAgentDispatcher,
        chapterOperations: mockChapterOperations,
        contentValidator: mockContentValidator,
        promptBuilder: mockPromptBuilder,
        config: {}
      });

      await phase3.run('test-story-123');

      assert.ok(iterationContent.length >= 2);
    });

    test('should handle polishChapter failure gracefully', async () => {
      const story = createTestStory();
      const mockStateManager = createMockStateManager({ initialStory: story });
      const mockAgentDispatcher = createMockAgentDispatcher();
      let callCount = 0;
      const mockChapterOperations = createMockChapterOperations({
        polishChapter: async (storyId, chapterNum, chapterContent, options) => {
          callCount++;
          if (callCount === 1) {
            throw new Error('Polish service unavailable');
          }
          return {
            polishedContent: chapterContent,
            improvements: [],
            metrics: { counts: { chineseChars: chapterContent.length } }
          };
        }
      });
      const mockContentValidator = createMockContentValidator({
        qualityScoreResult: createQualityScoreResult(8.5)
      });
      const mockPromptBuilder = createMockPromptBuilder();

      const phase3 = new Phase3_Refinement({
        stateManager: mockStateManager,
        agentDispatcher: mockAgentDispatcher,
        chapterOperations: mockChapterOperations,
        contentValidator: mockContentValidator,
        promptBuilder: mockPromptBuilder,
        config: {}
      });

      const result = await phase3.run('test-story-123');

      // Should still succeed, using original content when polish fails
      assert.strictEqual(result.status, 'waiting_checkpoint');
    });
  });

  describe('run() - quality scoring', () => {

    test('should call qualityScore after each iteration', async () => {
      const story = createTestStory();
      const mockStateManager = createMockStateManager({ initialStory: story });
      const mockAgentDispatcher = createMockAgentDispatcher();
      const mockChapterOperations = createMockChapterOperations();
      let qualityScoreCallCount = 0;
      const mockContentValidator = createMockContentValidator({
        qualityScore: async (content) => {
          qualityScoreCallCount++;
          return createQualityScoreResult(8.5);
        }
      });
      const mockPromptBuilder = createMockPromptBuilder();

      const phase3 = new Phase3_Refinement({
        stateManager: mockStateManager,
        agentDispatcher: mockAgentDispatcher,
        chapterOperations: mockChapterOperations,
        contentValidator: mockContentValidator,
        promptBuilder: mockPromptBuilder,
        config: {}
      });

      await phase3.run('test-story-123');

      assert.strictEqual(qualityScoreCallCount, 1);
    });

    test('should track qualityScores array across iterations', async () => {
      const story = createTestStory();
      const mockStateManager = createMockStateManager({ initialStory: story });
      const mockAgentDispatcher = createMockAgentDispatcher();
      const mockChapterOperations = createMockChapterOperations();
      const mockContentValidator = createMockContentValidator({
        qualityScore: async () => createQualityScoreResult(7.5)
      });
      const mockPromptBuilder = createMockPromptBuilder();

      const phase3 = new Phase3_Refinement({
        stateManager: mockStateManager,
        agentDispatcher: mockAgentDispatcher,
        chapterOperations: mockChapterOperations,
        contentValidator: mockContentValidator,
        promptBuilder: createMockPromptBuilder(),
        config: {}
      });

      const result = await phase3.run('test-story-123');

      assert.ok(result.data.qualityScores);
      assert.ok(result.data.qualityScores.length >= 1);
    });

    test('should handle qualityScore returning zero average', async () => {
      const story = createTestStory();
      const mockStateManager = createMockStateManager({ initialStory: story });
      const mockAgentDispatcher = createMockAgentDispatcher();
      const mockChapterOperations = createMockChapterOperations();
      const mockContentValidator = createMockContentValidator({
        qualityScore: async () => ({
          average: 0,
          scores: {},
          rawReport: ''
        })
      });
      const mockPromptBuilder = createMockPromptBuilder();

      const phase3 = new Phase3_Refinement({
        stateManager: mockStateManager,
        agentDispatcher: mockAgentDispatcher,
        chapterOperations: mockChapterOperations,
        contentValidator: mockContentValidator,
        promptBuilder: mockPromptBuilder,
        config: {}
      });

      const result = await phase3.run('test-story-123');

      assert.strictEqual(result.status, 'waiting_checkpoint');
    });
  });

  describe('run() - comprehensive validation', () => {

    test('should call comprehensiveValidation after each iteration', async () => {
      const story = createTestStory();
      const mockStateManager = createMockStateManager({ initialStory: story });
      const mockAgentDispatcher = createMockAgentDispatcher();
      const mockChapterOperations = createMockChapterOperations();
      let validationCallCount = 0;
      const mockContentValidator = createMockContentValidator({
        comprehensiveValidation: async () => {
          validationCallCount++;
          return {
            overall: { passed: true, hasCriticalIssues: false, criticalCount: 0 },
            checks: { worldview: { passed: true }, characters: { passed: true }, plot: { passed: true } },
            allIssues: [],
            allSuggestions: []
          };
        },
        qualityScoreResult: createQualityScoreResult(8.5)
      });
      const mockPromptBuilder = createMockPromptBuilder();

      const phase3 = new Phase3_Refinement({
        stateManager: mockStateManager,
        agentDispatcher: mockAgentDispatcher,
        chapterOperations: mockChapterOperations,
        contentValidator: mockContentValidator,
        promptBuilder: mockPromptBuilder,
        config: {}
      });

      await phase3.run('test-story-123');

      assert.strictEqual(validationCallCount, 1);
    });

    test('should include validation results in qualityScores', async () => {
      const story = createTestStory();
      const mockStateManager = createMockStateManager({ initialStory: story });
      const mockAgentDispatcher = createMockAgentDispatcher();
      const mockChapterOperations = createMockChapterOperations();
      const mockContentValidator = createMockContentValidator({
        comprehensiveValidation: async () => ({
          overall: { passed: true, hasCriticalIssues: false, criticalCount: 0 },
          checks: { worldview: { passed: true }, characters: { passed: true }, plot: { passed: true } },
          allIssues: [],
          allSuggestions: []
        }),
        qualityScoreResult: createQualityScoreResult(8.5)
      });
      const mockPromptBuilder = createMockPromptBuilder();

      const phase3 = new Phase3_Refinement({
        stateManager: mockStateManager,
        agentDispatcher: mockAgentDispatcher,
        chapterOperations: mockChapterOperations,
        contentValidator: mockContentValidator,
        promptBuilder: mockPromptBuilder,
        config: {}
      });

      const result = await phase3.run('test-story-123');

      assert.ok(result.data.qualityScores);
      assert.strictEqual(result.data.qualityScores.length, 1);
    });

    test('should handle comprehensiveValidation failure gracefully', async () => {
      const story = createTestStory();
      const mockStateManager = createMockStateManager({ initialStory: story });
      const mockAgentDispatcher = createMockAgentDispatcher();
      const mockChapterOperations = createMockChapterOperations();
      let qualityScoreCallCount = 0;
      const mockContentValidator = createMockContentValidator({
        comprehensiveValidation: async () => {
          throw new Error('Validation service error');
        },
        qualityScore: async () => {
          qualityScoreCallCount++;
          return createQualityScoreResult(8.5);
        }
      });
      const mockPromptBuilder = createMockPromptBuilder();

      const phase3 = new Phase3_Refinement({
        stateManager: mockStateManager,
        agentDispatcher: mockAgentDispatcher,
        chapterOperations: mockChapterOperations,
        contentValidator: mockContentValidator,
        promptBuilder: mockPromptBuilder,
        config: {}
      });

      const result = await phase3.run('test-story-123');

      // Should continue despite validation failure
      assert.strictEqual(result.status, 'waiting_checkpoint');
      assert.strictEqual(qualityScoreCallCount, 1);
    });
  });

  describe('run() - final editing', () => {

    test('should call finalEditor agent after polish loop', async () => {
      const story = createTestStory();
      const mockStateManager = createMockStateManager({ initialStory: story });
      const mockAgentDispatcher = createMockAgentDispatcher();
      const mockChapterOperations = createMockChapterOperations();
      const mockContentValidator = createMockContentValidator({
        qualityScoreResult: createQualityScoreResult(8.5)
      });
      const mockPromptBuilder = createMockPromptBuilder();

      const phase3 = new Phase3_Refinement({
        stateManager: mockStateManager,
        agentDispatcher: mockAgentDispatcher,
        chapterOperations: mockChapterOperations,
        contentValidator: mockContentValidator,
        promptBuilder: mockPromptBuilder,
        config: {}
      });

      await phase3.run('test-story-123');

      const finalEditorCalls = mockAgentDispatcher.calls.filter(c => c.agentType === 'finalEditor');
      assert.strictEqual(finalEditorCalls.length, 1);
    });

    test('should pass polished content to finalEditor', async () => {
      const story = createTestStory();
      const mockStateManager = createMockStateManager({ initialStory: story });
      const mockAgentDispatcher = createMockAgentDispatcher();
      const mockChapterOperations = createMockChapterOperations();
      const mockContentValidator = createMockContentValidator({
        qualityScoreResult: createQualityScoreResult(8.5)
      });
      const mockPromptBuilder = createMockPromptBuilder();

      const phase3 = new Phase3_Refinement({
        stateManager: mockStateManager,
        agentDispatcher: mockAgentDispatcher,
        chapterOperations: mockChapterOperations,
        contentValidator: mockContentValidator,
        promptBuilder: mockPromptBuilder,
        config: {}
      });

      await phase3.run('test-story-123');

      const finalEditorCall = mockAgentDispatcher.calls.find(c => c.agentType === 'finalEditor');
      assert.ok(finalEditorCall.prompt.includes('第1章'));
      assert.ok(finalEditorCall.prompt.includes('第2章'));
    });

    test('should build final editor prompt with proper format', async () => {
      const story = createTestStory();
      const mockStateManager = createMockStateManager({ initialStory: story });
      const mockAgentDispatcher = createMockAgentDispatcher();
      const mockChapterOperations = createMockChapterOperations();
      const mockContentValidator = createMockContentValidator({
        qualityScoreResult: createQualityScoreResult(8.5)
      });
      let builtPrompt = null;
      const mockPromptBuilder = createMockPromptBuilder({
        buildFinalEditorPrompt: (content) => {
          builtPrompt = content;
          return `【终校定稿】\n请对以下内容进行最终校订：\n\n${content}`;
        }
      });

      const phase3 = new Phase3_Refinement({
        stateManager: mockStateManager,
        agentDispatcher: mockAgentDispatcher,
        chapterOperations: mockChapterOperations,
        contentValidator: mockContentValidator,
        promptBuilder: mockPromptBuilder,
        config: {}
      });

      await phase3.run('test-story-123');

      assert.ok(builtPrompt.includes('第1章'));
    });

    test('should handle finalEditor failure gracefully', async () => {
      const story = createTestStory();
      const mockStateManager = createMockStateManager({ initialStory: story });
      const mockAgentDispatcher = createMockAgentDispatcher({
        delegateResult: async (agentType, prompt, options) => {
          if (agentType === 'finalEditor') {
            throw new Error('Final editor timeout');
          }
          return { content: 'Response' };
        }
      });
      const mockChapterOperations = createMockChapterOperations();
      const mockContentValidator = createMockContentValidator({
        qualityScoreResult: createQualityScoreResult(8.5)
      });
      const mockPromptBuilder = createMockPromptBuilder();

      const phase3 = new Phase3_Refinement({
        stateManager: mockStateManager,
        agentDispatcher: mockAgentDispatcher,
        chapterOperations: mockChapterOperations,
        contentValidator: mockContentValidator,
        promptBuilder: mockPromptBuilder,
        config: {}
      });

      const result = await phase3.run('test-story-123');

      assert.strictEqual(result.status, 'error');
      assert.ok(result.error.includes('Final editor failed'));
    });
  });

  describe('run() - checkpoint creation', () => {

    test('should create final acceptance checkpoint', async () => {
      const story = createTestStory();
      const mockStateManager = createMockStateManager({ initialStory: story });
      const mockAgentDispatcher = createMockAgentDispatcher();
      const mockChapterOperations = createMockChapterOperations();
      const mockContentValidator = createMockContentValidator({
        qualityScoreResult: createQualityScoreResult(8.5)
      });
      const mockPromptBuilder = createMockPromptBuilder();

      const phase3 = new Phase3_Refinement({
        stateManager: mockStateManager,
        agentDispatcher: mockAgentDispatcher,
        chapterOperations: mockChapterOperations,
        contentValidator: mockContentValidator,
        promptBuilder: mockPromptBuilder,
        config: {}
      });

      const result = await phase3.run('test-story-123');

      assert.ok(result.checkpointId);
      assert.ok(result.checkpointId.startsWith('cp-3-final-'));
    });

    test('should return waiting_checkpoint status for user acceptance', async () => {
      const story = createTestStory();
      const mockStateManager = createMockStateManager({ initialStory: story });
      const mockAgentDispatcher = createMockAgentDispatcher();
      const mockChapterOperations = createMockChapterOperations();
      const mockContentValidator = createMockContentValidator({
        qualityScoreResult: createQualityScoreResult(8.5)
      });
      const mockPromptBuilder = createMockPromptBuilder();

      const phase3 = new Phase3_Refinement({
        stateManager: mockStateManager,
        agentDispatcher: mockAgentDispatcher,
        chapterOperations: mockChapterOperations,
        contentValidator: mockContentValidator,
        promptBuilder: mockPromptBuilder,
        config: {}
      });

      const result = await phase3.run('test-story-123');

      assert.strictEqual(result.status, 'waiting_checkpoint');
      assert.strictEqual(result.phase, 'phase3');
      assert.strictEqual(result.nextAction, 'user_confirm_final_acceptance');
    });

    test('should include finalEditorOutput in result data', async () => {
      const story = createTestStory();
      const mockStateManager = createMockStateManager({ initialStory: story });
      const mockAgentDispatcher = createMockAgentDispatcher();
      const mockChapterOperations = createMockChapterOperations();
      const mockContentValidator = createMockContentValidator({
        qualityScoreResult: createQualityScoreResult(8.5)
      });
      const mockPromptBuilder = createMockPromptBuilder();

      const phase3 = new Phase3_Refinement({
        stateManager: mockStateManager,
        agentDispatcher: mockAgentDispatcher,
        chapterOperations: mockChapterOperations,
        contentValidator: mockContentValidator,
        promptBuilder: mockPromptBuilder,
        config: {}
      });

      const result = await phase3.run('test-story-123');

      assert.ok(result.data.finalEditorOutput);
    });
  });

  describe('run() - state updates', () => {

    test('should initialize phase3 state if not exists', async () => {
      const story = createTestStory();
      delete story.phase3;
      const mockStateManager = createMockStateManager({ initialStory: story });
      const mockAgentDispatcher = createMockAgentDispatcher();
      const mockChapterOperations = createMockChapterOperations();
      const mockContentValidator = createMockContentValidator({
        qualityScoreResult: createQualityScoreResult(8.5)
      });
      const mockPromptBuilder = createMockPromptBuilder();

      const phase3 = new Phase3_Refinement({
        stateManager: mockStateManager,
        agentDispatcher: mockAgentDispatcher,
        chapterOperations: mockChapterOperations,
        contentValidator: mockContentValidator,
        promptBuilder: mockPromptBuilder,
        config: {}
      });

      const result = await phase3.run('test-story-123');

      assert.strictEqual(result.status, 'waiting_checkpoint');
    });

    test('should update phase3 state with finalEditorOutput', async () => {
      const story = createTestStory();
      const mockStateManager = createMockStateManager({ initialStory: story });
      const mockAgentDispatcher = createMockAgentDispatcher();
      const mockChapterOperations = createMockChapterOperations();
      const mockContentValidator = createMockContentValidator({
        qualityScoreResult: createQualityScoreResult(8.5)
      });
      const mockPromptBuilder = createMockPromptBuilder();

      const phase3 = new Phase3_Refinement({
        stateManager: mockStateManager,
        agentDispatcher: mockAgentDispatcher,
        chapterOperations: mockChapterOperations,
        contentValidator: mockContentValidator,
        promptBuilder: mockPromptBuilder,
        config: {}
      });

      await phase3.run('test-story-123');

      const updatedStory = mockStateManager.stories.get('test-story-123');
      assert.ok(updatedStory.phase3.finalEditorOutput);
      assert.ok(updatedStory.phase3.polishedChapters);
    });

    test('should set status to final_editing_complete after final editor', async () => {
      const story = createTestStory();
      const mockStateManager = createMockStateManager({ initialStory: story });
      const mockAgentDispatcher = createMockAgentDispatcher();
      const mockChapterOperations = createMockChapterOperations();
      const mockContentValidator = createMockContentValidator({
        qualityScoreResult: createQualityScoreResult(8.5)
      });
      const mockPromptBuilder = createMockPromptBuilder();

      const phase3 = new Phase3_Refinement({
        stateManager: mockStateManager,
        agentDispatcher: mockAgentDispatcher,
        chapterOperations: mockChapterOperations,
        contentValidator: mockContentValidator,
        promptBuilder: mockPromptBuilder,
        config: {}
      });

      await phase3.run('test-story-123');

      const updatedStory = mockStateManager.stories.get('test-story-123');
      assert.ok(updatedStory.phase3.status === 'final_editing_complete' || 
                updatedStory.phase3.status === 'waiting_final_acceptance');
    });
  });

  describe('run() - error handling', () => {

    test('should return error when story not found', async () => {
      const mockStateManager = createMockStateManager();
      const mockAgentDispatcher = createMockAgentDispatcher();
      const mockChapterOperations = createMockChapterOperations();
      const mockContentValidator = createMockContentValidator();
      const mockPromptBuilder = createMockPromptBuilder();

      const phase3 = new Phase3_Refinement({
        stateManager: mockStateManager,
        agentDispatcher: mockAgentDispatcher,
        chapterOperations: mockChapterOperations,
        contentValidator: mockContentValidator,
        promptBuilder: mockPromptBuilder,
        config: {}
      });

      const result = await phase3.run('nonexistent-story');

      assert.strictEqual(result.status, 'error');
      assert.ok(result.error.includes('Story not found'));
    });

    test('should return error when no chapters found in phase2', async () => {
      const story = createTestStory({
        phase2: {
          outline: { chapters: [] },
          chapters: [],
          status: 'completed',
          userConfirmed: true
        }
      });
      const mockStateManager = createMockStateManager({ initialStory: story });
      const mockAgentDispatcher = createMockAgentDispatcher();
      const mockChapterOperations = createMockChapterOperations();
      const mockContentValidator = createMockContentValidator();
      const mockPromptBuilder = createMockPromptBuilder();

      const phase3 = new Phase3_Refinement({
        stateManager: mockStateManager,
        agentDispatcher: mockAgentDispatcher,
        chapterOperations: mockChapterOperations,
        contentValidator: mockContentValidator,
        promptBuilder: mockPromptBuilder,
        config: {}
      });

      const result = await phase3.run('test-story-123');

      assert.strictEqual(result.status, 'error');
      assert.ok(result.error.includes('No chapters found'));
    });

    test('should propagate polish loop errors', async () => {
      const story = createTestStory();
      const mockStateManager = createMockStateManager({ initialStory: story });
      const mockAgentDispatcher = createMockAgentDispatcher();
      const mockChapterOperations = createMockChapterOperations({
        polishChapter: async () => {
          throw new Error('Critical polish failure');
        }
      });
      const mockContentValidator = createMockContentValidator({
        qualityScoreResult: createQualityScoreResult(8.5)
      });
      const mockPromptBuilder = createMockPromptBuilder();

      const phase3 = new Phase3_Refinement({
        stateManager: mockStateManager,
        agentDispatcher: mockAgentDispatcher,
        chapterOperations: mockChapterOperations,
        contentValidator: mockContentValidator,
        promptBuilder: mockPromptBuilder,
        config: {}
      });

      // Should still complete - polish failures are caught internally
      const result = await phase3.run('test-story-123');
      assert.strictEqual(result.status, 'waiting_checkpoint');
    });
  });

  describe('continueFromCheckpoint() - approval handling', () => {

    test('should handle approval and mark story as completed', async () => {
      const story = createTestStory({
        phase3: {
          polishedChapters: [
            { number: 1, title: '第一章', content: '润色后内容' }
          ],
          finalEditorOutput: '最终定稿内容',
          qualityScores: [{ average: 8.5 }],
          iterationCount: 2,
          userConfirmed: false,
          checkpointId: 'cp-3-final-123',
          status: 'waiting_final_acceptance'
        }
      });
      const mockStateManager = createMockStateManager({ initialStory: story });
      const mockAgentDispatcher = createMockAgentDispatcher();
      const mockChapterOperations = createMockChapterOperations();
      const mockContentValidator = createMockContentValidator();
      const mockPromptBuilder = createMockPromptBuilder();

      const phase3 = new Phase3_Refinement({
        stateManager: mockStateManager,
        agentDispatcher: mockAgentDispatcher,
        chapterOperations: mockChapterOperations,
        contentValidator: mockContentValidator,
        promptBuilder: mockPromptBuilder,
        config: {}
      });

      const result = await phase3.continueFromCheckpoint('test-story-123', 'approve');

      assert.strictEqual(result.status, 'completed');
      assert.strictEqual(result.nextAction, 'story_completed');
      assert.ok(result.data.finalOutput);
    });

    test('should generate final output on approval', async () => {
      const story = createTestStory({
        phase3: {
          polishedChapters: [
            { number: 1, title: '第一章', content: '润色后内容', metrics: { counts: { chineseChars: 3000 } } }
          ],
          finalEditorOutput: '最终定稿',
          qualityScores: [{ average: 8.5 }],
          iterationCount: 2,
          userConfirmed: false,
          checkpointId: 'cp-3-final-123',
          status: 'waiting_final_acceptance'
        }
      });
      const mockStateManager = createMockStateManager({ initialStory: story });
      const mockAgentDispatcher = createMockAgentDispatcher();
      const mockChapterOperations = createMockChapterOperations();
      const mockContentValidator = createMockContentValidator();
      const mockPromptBuilder = createMockPromptBuilder();

      const phase3 = new Phase3_Refinement({
        stateManager: mockStateManager,
        agentDispatcher: mockAgentDispatcher,
        chapterOperations: mockChapterOperations,
        contentValidator: mockContentValidator,
        promptBuilder: mockPromptBuilder,
        config: {}
      });

      const result = await phase3.continueFromCheckpoint('test-story-123', 'approve');

      assert.ok(result.data.finalOutput.metadata);
      assert.ok(result.data.finalOutput.chapters);
      assert.ok(result.data.finalOutput.storyBible);
    });

    test('should update phase3 status to completed on approval', async () => {
      const story = createTestStory({
        phase3: {
          polishedChapters: [{ number: 1, title: '第一章', content: '内容' }],
          finalEditorOutput: '最终定稿',
          qualityScores: [],
          iterationCount: 1,
          userConfirmed: false,
          checkpointId: 'cp-3-final-123',
          status: 'waiting_final_acceptance'
        }
      });
      const mockStateManager = createMockStateManager({ initialStory: story });
      const mockAgentDispatcher = createMockAgentDispatcher();
      const mockChapterOperations = createMockChapterOperations();
      const mockContentValidator = createMockContentValidator();
      const mockPromptBuilder = createMockPromptBuilder();

      const phase3 = new Phase3_Refinement({
        stateManager: mockStateManager,
        agentDispatcher: mockAgentDispatcher,
        chapterOperations: mockChapterOperations,
        contentValidator: mockContentValidator,
        promptBuilder: mockPromptBuilder,
        config: {}
      });

      await phase3.continueFromCheckpoint('test-story-123', 'approve');

      const updatedStory = mockStateManager.stories.get('test-story-123');
      assert.strictEqual(updatedStory.phase3.status, 'completed');
      assert.strictEqual(updatedStory.phase3.userConfirmed, true);
    });
  });

  describe('continueFromCheckpoint() - rejection handling', () => {

    test('should record rejection feedback', async () => {
      const story = createTestStory({
        phase3: {
          polishedChapters: [],
          finalEditorOutput: '最终定稿',
          qualityScores: [],
          iterationCount: 1,
          userConfirmed: false,
          checkpointId: 'cp-3-final-123',
          status: 'waiting_final_acceptance'
        }
      });
      const mockStateManager = createMockStateManager({ initialStory: story });
      const mockAgentDispatcher = createMockAgentDispatcher();
      const mockChapterOperations = createMockChapterOperations();
      const mockContentValidator = createMockContentValidator({
        qualityScoreResult: createQualityScoreResult(8.5)
      });
      const mockPromptBuilder = createMockPromptBuilder();

      const phase3 = new Phase3_Refinement({
        stateManager: mockStateManager,
        agentDispatcher: mockAgentDispatcher,
        chapterOperations: mockChapterOperations,
        contentValidator: mockContentValidator,
        promptBuilder: mockPromptBuilder,
        config: {}
      });

      await phase3.continueFromCheckpoint('test-story-123', 'reject', '需要更多细节描写');

      const updatedStory = mockStateManager.stories.get('test-story-123');
      assert.ok(updatedStory.phase3.lastRejection);
      assert.strictEqual(updatedStory.phase3.lastRejection.feedback, '需要更多细节描写');
    });

    test('should update status on rejection', async () => {
      const story = createTestStory({
        phase3: {
          polishedChapters: [],
          finalEditorOutput: '最终定稿',
          qualityScores: [],
          iterationCount: 1,
          userConfirmed: false,
          checkpointId: 'cp-3-final-123',
          status: 'waiting_final_acceptance'
        }
      });
      const mockStateManager = createMockStateManager({ initialStory: story });
      const mockAgentDispatcher = createMockAgentDispatcher();
      const mockChapterOperations = createMockChapterOperations();
      const mockContentValidator = createMockContentValidator({
        qualityScoreResult: createQualityScoreResult(8.5)
      });
      const mockPromptBuilder = createMockPromptBuilder();

      const phase3 = new Phase3_Refinement({
        stateManager: mockStateManager,
        agentDispatcher: mockAgentDispatcher,
        chapterOperations: mockChapterOperations,
        contentValidator: mockContentValidator,
        promptBuilder: mockPromptBuilder,
        config: {}
      });

      await phase3.continueFromCheckpoint('test-story-123', 'reject', '需要改进');

      const updatedStory = mockStateManager.stories.get('test-story-123');
      assert.ok(updatedStory.phase3.lastRejection);
      assert.strictEqual(updatedStory.phase3.lastRejection.feedback, '需要改进');
    });

    test('should re-run Phase3 with feedback on rejection', async () => {
      const story = createTestStory({
        phase3: {
          polishedChapters: [],
          finalEditorOutput: '最终定稿',
          qualityScores: [],
          iterationCount: 1,
          userConfirmed: false,
          checkpointId: 'cp-3-final-123',
          status: 'waiting_final_acceptance'
        }
      });
      const mockStateManager = createMockStateManager({ initialStory: story });
      const mockAgentDispatcher = createMockAgentDispatcher();
      const mockChapterOperations = createMockChapterOperations();
      const mockContentValidator = createMockContentValidator({
        qualityScoreResult: createQualityScoreResult(8.5)
      });
      const mockPromptBuilder = createMockPromptBuilder();

      const phase3 = new Phase3_Refinement({
        stateManager: mockStateManager,
        agentDispatcher: mockAgentDispatcher,
        chapterOperations: mockChapterOperations,
        contentValidator: mockContentValidator,
        promptBuilder: mockPromptBuilder,
        config: {}
      });

      const result = await phase3.continueFromCheckpoint('test-story-123', 'reject', '需要改进文风');

      // Should restart Phase3, so status will be waiting_checkpoint again
      assert.strictEqual(result.status, 'waiting_checkpoint');
    });
  });

  describe('continueFromCheckpoint() - error handling', () => {

    test('should return error when story not found', async () => {
      const mockStateManager = createMockStateManager();
      const mockAgentDispatcher = createMockAgentDispatcher();
      const mockChapterOperations = createMockChapterOperations();
      const mockContentValidator = createMockContentValidator();
      const mockPromptBuilder = createMockPromptBuilder();

      const phase3 = new Phase3_Refinement({
        stateManager: mockStateManager,
        agentDispatcher: mockAgentDispatcher,
        chapterOperations: mockChapterOperations,
        contentValidator: mockContentValidator,
        promptBuilder: mockPromptBuilder,
        config: {}
      });

      const result = await phase3.continueFromCheckpoint('nonexistent', 'approve');

      assert.strictEqual(result.status, 'error');
      assert.ok(result.error.includes('Story not found'));
    });
  });

  describe('_calculateAverageScore()', () => {
    test('should return 0 for empty array', () => {
      const mockStateManager = createMockStateManager();
      const phase3 = new Phase3_Refinement({
        stateManager: mockStateManager,
        agentDispatcher: createMockAgentDispatcher(),
        chapterOperations: createMockChapterOperations(),
        contentValidator: createMockContentValidator(),
        promptBuilder: createMockPromptBuilder(),
        config: {}
      });

      const result = phase3._calculateAverageScore([]);
      assert.strictEqual(result, 0);
    });

    test('should calculate average of single score', () => {
      const mockStateManager = createMockStateManager();
      const phase3 = new Phase3_Refinement({
        stateManager: mockStateManager,
        agentDispatcher: createMockAgentDispatcher(),
        chapterOperations: createMockChapterOperations(),
        contentValidator: createMockContentValidator(),
        promptBuilder: createMockPromptBuilder(),
        config: {}
      });

      const result = phase3._calculateAverageScore([{ average: 8.5 }]);
      assert.strictEqual(result, 8.5);
    });

    test('should calculate average of multiple scores', () => {
      const mockStateManager = createMockStateManager();
      const phase3 = new Phase3_Refinement({
        stateManager: mockStateManager,
        agentDispatcher: createMockAgentDispatcher(),
        chapterOperations: createMockChapterOperations(),
        contentValidator: createMockContentValidator(),
        promptBuilder: createMockPromptBuilder(),
        config: {}
      });

      const result = phase3._calculateAverageScore([
        { average: 7.0 },
        { average: 8.0 },
        { average: 9.0 }
      ]);
      assert.strictEqual(result, 8.0);
    });

    test('should handle averageScore field name', () => {
      const mockStateManager = createMockStateManager();
      const phase3 = new Phase3_Refinement({
        stateManager: mockStateManager,
        agentDispatcher: createMockAgentDispatcher(),
        chapterOperations: createMockChapterOperations(),
        contentValidator: createMockContentValidator(),
        promptBuilder: createMockPromptBuilder(),
        config: {}
      });

      const result = phase3._calculateAverageScore([
        { averageScore: 8.0 },
        { averageScore: 6.0 }
      ]);
      assert.strictEqual(result, 7.0);
    });

    test('should filter out zero scores', () => {
      const mockStateManager = createMockStateManager();
      const phase3 = new Phase3_Refinement({
        stateManager: mockStateManager,
        agentDispatcher: createMockAgentDispatcher(),
        chapterOperations: createMockChapterOperations(),
        contentValidator: createMockContentValidator(),
        promptBuilder: createMockPromptBuilder(),
        config: {}
      });

      const result = phase3._calculateAverageScore([
        { average: 0 },
        { average: 8.0 },
        { average: 0 }
      ]);
      assert.strictEqual(result, 8.0);
    });

    test('should round to one decimal place', () => {
      const mockStateManager = createMockStateManager();
      const phase3 = new Phase3_Refinement({
        stateManager: mockStateManager,
        agentDispatcher: createMockAgentDispatcher(),
        chapterOperations: createMockChapterOperations(),
        contentValidator: createMockContentValidator(),
        promptBuilder: createMockPromptBuilder(),
        config: {}
      });

      const result = phase3._calculateAverageScore([
        { average: 7.0 },
        { average: 8.0 }
      ]);
      assert.strictEqual(result, 7.5);
    });
  });

  describe('iteration loop edge cases', () => {

    test('should handle single chapter story', async () => {
      const story = createTestStory({
        phase2: {
          outline: { chapters: [{ number: 1, title: '第一章' }] },
          chapters: [{
            number: 1,
            title: '第一章',
            content: '唯一的章节内容',
            metrics: { counts: { chineseChars: 100 } }
          }],
          status: 'completed',
          userConfirmed: true
        }
      });
      const mockStateManager = createMockStateManager({ initialStory: story });
      const mockAgentDispatcher = createMockAgentDispatcher();
      let polishCallCount = 0;
      const mockChapterOperations = createMockChapterOperations({
        polishChapter: async () => {
          polishCallCount++;
          return {
            polishedContent: '润色后内容',
            improvements: [],
            metrics: { counts: { chineseChars: 120 } }
          };
        }
      });
      const mockContentValidator = createMockContentValidator({
        qualityScoreResult: createQualityScoreResult(8.5)
      });
      const mockPromptBuilder = createMockPromptBuilder();

      const phase3 = new Phase3_Refinement({
        stateManager: mockStateManager,
        agentDispatcher: mockAgentDispatcher,
        chapterOperations: mockChapterOperations,
        contentValidator: mockContentValidator,
        promptBuilder: mockPromptBuilder,
        config: {}
      });

      const result = await phase3.run('test-story-123');

      assert.strictEqual(result.status, 'waiting_checkpoint');
      assert.strictEqual(polishCallCount, 1);
    });

    test('should handle many chapters (scaling test)', async () => {
      const chapters = [];
      for (let i = 1; i <= 10; i++) {
        chapters.push({
          number: i,
          title: `第${i}章`,
          content: `第${i}章内容`,
          metrics: { counts: { chineseChars: 500 } }
        });
      }
      const story = createTestStory({
        phase2: {
          outline: { chapters: chapters.map(ch => ({ number: ch.number, title: ch.title })) },
          chapters: chapters,
          status: 'completed',
          userConfirmed: true
        }
      });
      const mockStateManager = createMockStateManager({ initialStory: story });
      const mockAgentDispatcher = createMockAgentDispatcher();
      let polishCallCount = 0;
      const mockChapterOperations = createMockChapterOperations({
        polishChapter: async () => {
          polishCallCount++;
          return {
            polishedContent: '润色后',
            improvements: [],
            metrics: { counts: { chineseChars: 520 } }
          };
        }
      });
      const mockContentValidator = createMockContentValidator({
        qualityScoreResult: createQualityScoreResult(8.5)
      });
      const mockPromptBuilder = createMockPromptBuilder();

      const phase3 = new Phase3_Refinement({
        stateManager: mockStateManager,
        agentDispatcher: mockAgentDispatcher,
        chapterOperations: mockChapterOperations,
        contentValidator: mockContentValidator,
        promptBuilder: mockPromptBuilder,
        config: {}
      });

      const result = await phase3.run('test-story-123');

      assert.strictEqual(result.status, 'waiting_checkpoint');
      assert.strictEqual(polishCallCount, 10); // 10 chapters × 1 iteration
    });

    test('should continue iterating when validation passes but quality below threshold', async () => {
      const story = createTestStory();
      const mockStateManager = createMockStateManager({ initialStory: story });
      const mockAgentDispatcher = createMockAgentDispatcher();
      const mockChapterOperations = createMockChapterOperations();
      let iterationCount = 0;
      const mockContentValidator = createMockContentValidator({
        comprehensiveValidation: () => ({
          overall: { passed: true, hasCriticalIssues: false, criticalCount: 0 },
          checks: { worldview: { passed: true }, characters: { passed: true }, plot: { passed: true } },
          allIssues: [],
          allSuggestions: []
        }),
        qualityScore: async () => {
          iterationCount++;
          return createQualityScoreResult(iterationCount === 3 ? 8.2 : 7.5);
        }
      });
      const mockPromptBuilder = createMockPromptBuilder();

      const phase3 = new Phase3_Refinement({
        stateManager: mockStateManager,
        agentDispatcher: mockAgentDispatcher,
        chapterOperations: mockChapterOperations,
        contentValidator: mockContentValidator,
        promptBuilder: mockPromptBuilder,
        config: {}
      });

      const result = await phase3.run('test-story-123');

      assert.strictEqual(result.status, 'waiting_checkpoint');
      assert.strictEqual(iterationCount, 3);
    });

    test('should track qualityScores array across iterations', async () => {
      const story = createTestStory();
      const mockStateManager = createMockStateManager({ initialStory: story });
      const mockAgentDispatcher = createMockAgentDispatcher();
      const mockChapterOperations = createMockChapterOperations();
      let iterationCount = 0;
      const mockContentValidator = createMockContentValidator({
        qualityScore: async () => {
          iterationCount++;
          return createQualityScoreResult(iterationCount * 1.5 + 6.0);
        }
      });
      const mockPromptBuilder = createMockPromptBuilder();

      const phase3 = new Phase3_Refinement({
        stateManager: mockStateManager,
        agentDispatcher: mockAgentDispatcher,
        chapterOperations: mockChapterOperations,
        contentValidator: mockContentValidator,
        promptBuilder: createMockPromptBuilder(),
        config: {}
      });

      const result = await phase3.run('test-story-123');

      // Should have quality scores for each iteration
      assert.ok(result.data.qualityScores);
      assert.ok(result.data.qualityScores.length >= 1);
    });
  });

  describe('_generateFinalOutput()', () => {
    test('should generate output with metadata', () => {
      const mockStateManager = createMockStateManager();
      const phase3 = new Phase3_Refinement({
        stateManager: mockStateManager,
        agentDispatcher: createMockAgentDispatcher(),
        chapterOperations: createMockChapterOperations(),
        contentValidator: createMockContentValidator(),
        promptBuilder: createMockPromptBuilder(),
        config: {}
      });

      const story = {
        id: 'test-story',
        createdAt: '2026-01-01T00:00:00Z',
        config: {
          storyPrompt: 'Test story prompt',
          genre: '科幻',
          stylePreference: '硬科幻',
          targetWordCount: { min: 2500, max: 3500 }
        },
        phase1: {
          worldview: { name: 'Test World' },
          characters: [{ name: 'Test Character' }]
        },
        phase2: {
          outline: { chapters: [] }
        },
        phase3: {
          polishedChapters: [
            { number: 1, title: '第一章', content: '内容', metrics: { counts: { chineseChars: 1000 } } }
          ],
          finalEditorOutput: 'Final output text',
          qualityScores: [{ average: 8.5 }]
        }
      };

      const output = phase3._generateFinalOutput(story);

      assert.ok(output.metadata);
      assert.strictEqual(output.metadata.storyId, 'test-story');
      assert.strictEqual(output.metadata.genre, '科幻');
      assert.ok(output.storyBible);
      assert.ok(output.chapters);
      assert.strictEqual(output.chapters.length, 1);
    });

    test('should include quality scores in metadata', () => {
      const mockStateManager = createMockStateManager();
      const phase3 = new Phase3_Refinement({
        stateManager: mockStateManager,
        agentDispatcher: createMockAgentDispatcher(),
        chapterOperations: createMockChapterOperations(),
        contentValidator: createMockContentValidator(),
        promptBuilder: createMockPromptBuilder(),
        config: {}
      });

      const story = {
        id: 'test-story',
        createdAt: '2026-01-01T00:00:00Z',
        config: { storyPrompt: 'Test' },
        phase1: { worldview: {}, characters: [] },
        phase2: { outline: {} },
        phase3: {
          polishedChapters: [],
          finalEditorOutput: 'Final',
          qualityScores: [{ average: 7.5 }, { average: 8.0 }]
        }
      };

      const output = phase3._generateFinalOutput(story);

      assert.ok(output.metadata.qualityScores);
      assert.strictEqual(output.metadata.qualityScores.length, 2);
    });
  });

  describe('_calculateTotalWordCount()', () => {
    test('should calculate total word count from polished chapters', () => {
      const mockStateManager = createMockStateManager();
      const phase3 = new Phase3_Refinement({
        stateManager: mockStateManager,
        agentDispatcher: createMockAgentDispatcher(),
        chapterOperations: createMockChapterOperations(),
        contentValidator: createMockContentValidator(),
        promptBuilder: createMockPromptBuilder(),
        config: {}
      });

      const obj = {
        phase3: {
          polishedChapters: [
            { metrics: { counts: { chineseChars: 1000 } } },
            { metrics: { counts: { chineseChars: 1500 } } },
            { metrics: { counts: { chineseChars: 2000 } } }
          ]
        }
      };

      const result = phase3._calculateTotalWordCount(obj);
      assert.strictEqual(result, 4500);
    });

    test('should return 0 when no chapters', () => {
      const mockStateManager = createMockStateManager();
      const phase3 = new Phase3_Refinement({
        stateManager: mockStateManager,
        agentDispatcher: createMockAgentDispatcher(),
        chapterOperations: createMockChapterOperations(),
        contentValidator: createMockContentValidator(),
        promptBuilder: createMockPromptBuilder(),
        config: {}
      });

      const result = phase3._calculateTotalWordCount({ phase3: { polishedChapters: [] } });
      assert.strictEqual(result, 0);
    });

    test('should handle missing metrics gracefully', () => {
      const mockStateManager = createMockStateManager();
      const phase3 = new Phase3_Refinement({
        stateManager: mockStateManager,
        agentDispatcher: createMockAgentDispatcher(),
        chapterOperations: createMockChapterOperations(),
        contentValidator: createMockContentValidator(),
        promptBuilder: createMockPromptBuilder(),
        config: {}
      });

      const obj = {
        phase3: {
          polishedChapters: [
            { metrics: null },
            { metrics: { counts: null } },
            { metrics: { counts: { chineseChars: 1000 } } }
          ]
        }
      };

      const result = phase3._calculateTotalWordCount(obj);
      assert.strictEqual(result, 1000);
    });
  });
});
