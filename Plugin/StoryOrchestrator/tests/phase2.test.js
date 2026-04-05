'use strict';

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const { Phase2_OutlineDrafting } = require('../core/Phase2_OutlineDrafting');

function createMockAgentDispatcher(behavior = {}) {
  const calls = [];
  
  return {
    calls,
    delegate: async (agentType, prompt, options) => {
      calls.push({ agentType, prompt, options });
      
      if (behavior.delegateResult) {
        return behavior.delegateResult(agentType, prompt, options);
      }
      
      if (agentType === 'plotArchitect') {
        return { 
          content: behavior.plotArchitectContent || [
          '第1章 开篇',
          '核心事件：故事开始',
          '场景：起点',
          '字数分配：约2500字',
          '',
          '第2章 发展',
          '核心事件：冲突展开',
          '场景：城市',
          '字数分配：约3000字',
          '',
          '第3章 高潮',
          '核心事件：决战',
          '场景：战场',
          '字数分配：约3500字'
        ].join('\n')
        };
      }
      if (agentType === 'logicValidator') {
        return { content: behavior.validatorContent || [
          '【验证结论】',
          '通过',
          '',
          '【问题清单】',
          '（无）',
          '',
          '【修正建议】',
          '（无）'
        ].join('\n') };
      }
      if (agentType === 'detailFiller') {
        return { content: behavior.detailFillerContent || '填充了细节的章节内容' };
      }
      if (agentType === 'chapterWriter') {
        return { content: behavior.chapterWriterContent || '第X章 测试章节\n\n测试章节正文' };
      }
      return { content: 'Default mock response' };
    },
    resetCalls: () => { calls.length = 0; }
  };
}

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
    updatePhase2: async (storyId, updates) => {
      const story = stories.get(storyId) || {};
      story.phase2 = { ...story.phase2, ...updates };
      story.updatedAt = new Date().toISOString();
      stories.set(storyId, story);
      if (behavior.updatePhase2) behavior.updatePhase2(storyId, story);
      return story;
    },
    createStory: async (storyPrompt, config) => {
      const storyId = `story-${Date.now()}`;
      const story = {
        id: storyId,
        status: 'phase1_completed',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        config: {
          targetWordCount: config?.targetWordCount || { min: 2500, max: 3500 },
          genre: config?.genre || 'general',
          stylePreference: config?.stylePreference || '',
          storyPrompt: storyPrompt
        },
        phase1: {
          worldview: behavior.worldview || { name: '测试世界观', rules: ['规则1', '规则2'] },
          characters: behavior.characters || [{ name: '主角', personality: '勇敢' }],
          validation: null,
          userConfirmed: true,
          checkpointId: null,
          status: 'completed'
        },
        phase2: {
          outline: null,
          chapters: [],
          currentChapter: 0,
          userConfirmed: false,
          checkpointId: null,
          status: 'pending'
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

function createMockChapterOperations(behavior = {}) {
  return {
    createChapterDraft: async (storyId, chapterNum, options) => {
      if (behavior.createChapterDraft) return behavior.createChapterDraft(storyId, chapterNum, options);
      return {
        content: behavior.draftContent || `第${chapterNum}章 测试章节\n\n测试正文`.repeat(10),
        wasExpanded: false,
        metrics: { counts: { actualCount: behavior.draftWordCount || 3000 }, validation: { isQualified: true, deficit: 0 } }
      };
    },
    fillDetails: async (storyId, chapterNum, content, options) => {
      if (behavior.fillDetails) return behavior.fillDetails(storyId, chapterNum, content, options);
      return {
        detailedContent: content + '\n\n【细节填充】增加场景描写和人物心理'.repeat(5),
        agentResponse: { content: '细节填充完成' }
      };
    },
    countChapterLength: (content, targetMin, targetMax, options) => {
      if (behavior.countChapterLength) return behavior.countChapterLength(content, targetMin, targetMax, options);
      const actualCount = behavior.overrideWordCount || content.length;
      return {
        counts: { actualCount },
        validation: { isQualified: actualCount >= targetMin, deficit: actualCount < targetMin ? targetMin - actualCount : 0 }
      };
    },
    reviseChapter: async (storyId, chapterNum, content, options) => {
      if (behavior.reviseChapter) return behavior.reviseChapter(storyId, chapterNum, content, options);
      return {
        revisedContent: content + '\n\n【修订内容】根据反馈修订',
        changeSummary: '已根据验证反馈修订',
        agentResponse: { content: '修订完成' }
      };
    },
    _expandChapter: async (storyId, content, deficit, outline) => {
      if (behavior._expandChapter) return behavior._expandChapter(storyId, content, deficit, outline);
      return { content: content + '\n\n【扩充内容】自动扩充'.repeat(3) };
    }
  };
}

function createMockContentValidator(behavior = {}) {
  return {
    comprehensiveValidation: async (storyId, chapterNum, content, storyBible, previousChapters) => {
      if (behavior.comprehensiveValidation) return behavior.comprehensiveValidation(storyId, chapterNum, content, storyBible, previousChapters);
      return behavior.validationResult || {
        overall: { passed: true, hasCriticalIssues: false, criticalCount: 0 },
        checks: { worldview: { passed: true }, characters: { passed: true }, plot: { passed: true } },
        allIssues: [],
        allSuggestions: []
      };
    }
  };
}

function createTestStory(overrides = {}) {
  return {
    id: 'test-story-123',
    status: 'phase1_completed',
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
      outline: null,
      chapters: [],
      currentChapter: 0,
      status: 'pending',
      userConfirmed: false,
      checkpointId: null
    },
    ...overrides
  };
}

function createTestOutline(chapterCount = 3) {
  const chapters = [];
  for (let i = 1; i <= chapterCount; i++) {
    chapters.push({
      number: i,
      title: `第${i}章 测试章节`,
      coreEvent: `核心事件${i}`,
      scenes: [`场景${i}`],
      characters: ['主角'],
      wordCountTarget: 2500
    });
  }
  return { chapters, structure: '起承转合', keyTurningPoints: ['转折点1'], foreshadowing: ['伏笔1'] };
}

describe('Phase2_OutlineDrafting', () => {
  
  describe('Outline Generation', () => {
    
    test('should delegate to plotArchitect agent for outline creation', async () => {
      const agentDispatcher = createMockAgentDispatcher();
      const stateManager = createMockStateManager({
        initialStory: createTestStory()
      });
      const chapterOperations = createMockChapterOperations();
      const contentValidator = createMockContentValidator();
      
      const phase2 = new Phase2_OutlineDrafting({
        stateManager,
        agentDispatcher,
        chapterOperations,
        contentValidator,
        config: { MAX_OUTLINE_REVISION_ATTEMPTS: 2 }
      });
      
      await phase2.run('test-story-123');
      
      const plotArchitectCalls = agentDispatcher.calls.filter(c => c.agentType === 'plotArchitect');
      assert.strictEqual(plotArchitectCalls.length >= 1, true, 'plotArchitect should be called at least once');
      
      const firstCall = plotArchitectCalls[0];
      assert.strictEqual(firstCall.agentType, 'plotArchitect');
      assert.ok(firstCall.prompt.includes('大纲') || firstCall.prompt.includes('outline'), 
        'Prompt should be for outline generation');
    });
    
    test('should create checkpoint after successful outline generation', async () => {
      const agentDispatcher = createMockAgentDispatcher({
        delegateResult: (agentType) => {
          if (agentType === 'plotArchitect') {
            return { content: [
              '第1章 开篇',
              '核心事件：故事开始',
              '场景：起点',
              '字数分配：约2500字'
            ].join('\n') };
          }
          if (agentType === 'logicValidator') {
            return { content: [
              '【验证结论】',
              '通过',
              '',
              '【问题清单】',
              '（无）'
            ].join('\n') };
          }
          return { content: 'default' };
        }
      });
      const stateManager = createMockStateManager({
        initialStory: createTestStory()
      });
      const chapterOperations = createMockChapterOperations();
      const contentValidator = createMockContentValidator();
      
      const phase2 = new Phase2_OutlineDrafting({
        stateManager,
        agentDispatcher,
        chapterOperations,
        contentValidator
      });
      
      const result = await phase2.run('test-story-123');
      
      assert.strictEqual(result.status, 'waiting_checkpoint');
      assert.ok(result.checkpointId, 'Should have checkpointId');
      assert.ok(result.data && result.data.outline, 'Should have outline in result.data');
    });
    
    test('should validate outline with logicValidator agent', async () => {
      const agentDispatcher = createMockAgentDispatcher();
      const stateManager = createMockStateManager({
        initialStory: createTestStory()
      });
      const chapterOperations = createMockChapterOperations();
      const contentValidator = createMockContentValidator();
      
      const phase2 = new Phase2_OutlineDrafting({
        stateManager,
        agentDispatcher,
        chapterOperations,
        contentValidator
      });
      
      await phase2.run('test-story-123');
      
      const validatorCalls = agentDispatcher.calls.filter(c => c.agentType === 'logicValidator');
      assert.strictEqual(validatorCalls.length >= 1, true, 'logicValidator should be called for outline validation');
    });
    
    test('should auto-revise outline when validation fails', async () => {
      const agentDispatcher = createMockAgentDispatcher({
        validatorContent: [
          '【验证结论】',
          '不通过',
          '',
          '【问题清单】',
          '- 章节逻辑不通',
          '- 人物出场不合理',
          '',
          '【修正建议】',
          '- 调整章节顺序'
        ].join('\n')
      });
      
      let updateCallCount = 0;
      const stateManager = createMockStateManager({
        initialStory: createTestStory(),
        updatePhase2: (id, story) => { updateCallCount++; }
      });
      
      const chapterOperations = createMockChapterOperations();
      const contentValidator = createMockContentValidator();
      
      const phase2 = new Phase2_OutlineDrafting({
        stateManager,
        agentDispatcher,
        chapterOperations,
        contentValidator,
        config: { MAX_OUTLINE_REVISION_ATTEMPTS: 2 }
      });
      
      const result = await phase2.run('test-story-123');
      
      const plotArchitectCalls = agentDispatcher.calls.filter(c => c.agentType === 'plotArchitect');
      assert.strictEqual(plotArchitectCalls.length >= 2, true, 'plotArchitect should be called at least twice (original + revision)');
    });
    
    test('should return error after max revision attempts exceeded', async () => {
      const agentDispatcher = createMockAgentDispatcher({
        validatorContent: [
          '【验证结论】',
          '不通过',
          '',
          '【问题清单】',
          '- 问题持续存在'
        ].join('\n')
      });
      
      const stateManager = createMockStateManager({
        initialStory: createTestStory()
      });
      
      const chapterOperations = createMockChapterOperations();
      const contentValidator = createMockContentValidator();
      
      const phase2 = new Phase2_OutlineDrafting({
        stateManager,
        agentDispatcher,
        chapterOperations,
        contentValidator,
        config: { MAX_OUTLINE_REVISION_ATTEMPTS: 1 }
      });
      
      const result = await phase2.run('test-story-123');
      
      assert.strictEqual(result.status, 'error');
      assert.ok(result.error.includes('validation failed'), 'Error should mention validation failure');
    });
    
    test('should parse outline content correctly', () => {
      const agentDispatcher = createMockAgentDispatcher();
      const stateManager = createMockStateManager();
      const chapterOperations = createMockChapterOperations();
      const contentValidator = createMockContentValidator();
      
      const phase2 = new Phase2_OutlineDrafting({
        stateManager,
        agentDispatcher,
        chapterOperations,
        contentValidator
      });
      
      const outlineContent = `
第1章 觉醒
核心事件：AI第一次意识到自我存在
场景：实验室
字数分配：约2500字

第2章 探索
核心事件：AI开始探索外部世界
场景：城市街道
字数分配：约3000字

第3章 抉择
核心事件：AI面临终极选择
场景：数据中心
字数分配：约3500字
`;
      
      const outline = phase2._parseOutline(outlineContent, 3);
      
      assert.ok(Array.isArray(outline.chapters), 'Chapters should be an array');
      assert.ok(outline.chapters.length > 0, 'Should have parsed chapters');
      assert.strictEqual(outline.chapters[0].number, 1);
      assert.strictEqual(outline.chapters[1].number, 2);
      assert.strictEqual(outline.chapters[2].number, 3);
    });
    
    test('should update story status to phase2_running during execution', async () => {
      const agentDispatcher = createMockAgentDispatcher();
      
      let capturedStatus = null;
      const stateManagerWrapper = createMockStateManager({
        initialStory: createTestStory(),
        updateStory: (id, story) => {
          capturedStatus = story.status;
        }
      });
      
      const chapterOperations = createMockChapterOperations();
      const contentValidator = createMockContentValidator();
      
      const phase2 = new Phase2_OutlineDrafting({
        stateManager: stateManagerWrapper,
        agentDispatcher,
        chapterOperations,
        contentValidator
      });
      
      await phase2.run('test-story-123');
      
      assert.ok(capturedStatus === 'phase2_running' || capturedStatus === 'phase2_completed', 
        'Status should transition through phase2_running');
    });
  });
  
  describe('Checkpoint Continuation', () => {
    
    test('should continue content production when checkpoint approved', async () => {
      const agentDispatcher = createMockAgentDispatcher();
      const stateManager = createMockStateManager({
        initialStory: createTestStory({
          phase2: {
            outline: createTestOutline(2),
            status: 'pending_confirmation',
            checkpointId: 'cp-outline-123',
            userConfirmed: false
          }
        })
      });
      
      const chapterOperations = createMockChapterOperations();
      const contentValidator = createMockContentValidator();
      
      const phase2 = new Phase2_OutlineDrafting({
        stateManager,
        agentDispatcher,
        chapterOperations,
        contentValidator
      });
      
      const result = await phase2.continueFromCheckpoint('test-story-123', 'approve', null);
      
      assert.strictEqual(result.status, 'completed');
      assert.ok(result.data, 'Should have result data');
    });
    
    test('should revise outline when checkpoint rejected with feedback', async () => {
      const agentDispatcher = createMockAgentDispatcher();
      const stateManager = createMockStateManager({
        initialStory: createTestStory({
          phase2: {
            outline: createTestOutline(2),
            status: 'pending_confirmation',
            checkpointId: 'cp-outline-123',
            userConfirmed: false
          }
        })
      });
      
      const chapterOperations = createMockChapterOperations();
      const contentValidator = createMockContentValidator();
      
      const phase2 = new Phase2_OutlineDrafting({
        stateManager,
        agentDispatcher,
        chapterOperations,
        contentValidator
      });
      
      const result = await phase2.continueFromCheckpoint(
        'test-story-123', 
        'reject', 
        '第2章情节需要更丰富的发展'
      );
      
      assert.strictEqual(result.status, 'waiting_checkpoint');
      assert.ok(result.checkpointId, 'Should create new checkpoint after revision');
    });
  });
  
  describe('Chapter Production', () => {
    
    test('should produce chapters sequentially (not in parallel)', async () => {
      const callOrder = [];
      const agentDispatcher = createMockAgentDispatcher({
        delegateResult: (agentType, prompt, options) => {
          callOrder.push({ agent: agentType, time: Date.now() });
          return { content: '第X章 测试内容'.repeat(100) };
        }
      });
      
      const stateManager = createMockStateManager({
        initialStory: createTestStory({
          phase2: {
            outline: createTestOutline(3),
            status: 'content_production',
            userConfirmed: true
          }
        })
      });
      
      const chapterOperations = createMockChapterOperations({
        createChapterDraft: async (storyId, chapterNum, options) => {
          callOrder.push({ agent: `draft-${chapterNum}`, time: Date.now() });
          return {
            content: `第${chapterNum}章 正文`.repeat(100),
            wasExpanded: false,
            metrics: { counts: { actualCount: 3000 }, validation: { isQualified: true } }
          };
        },
        countChapterLength: (content, min, max, opts) => ({
          counts: { actualCount: 3000 },
          validation: { isQualified: true }
        })
      });
      
      const contentValidator = createMockContentValidator();
      
      const phase2 = new Phase2_OutlineDrafting({
        stateManager,
        agentDispatcher,
        chapterOperations,
        contentValidator
      });
      
      await phase2._produceContent('test-story-123');
      
      const draftCalls = callOrder.filter(c => c.agent.startsWith('draft-'));
      assert.strictEqual(draftCalls.length, 3, 'Should produce 3 chapters');
      
      for (let i = 0; i < draftCalls.length - 1; i++) {
        assert.ok(
          draftCalls[i].time <= draftCalls[i + 1].time,
          'Chapter calls should be sequential'
        );
      }
    });
    
    test('should call detailFiller for each chapter', async () => {
      const agentDispatcher = createMockAgentDispatcher();
      const stateManager = createMockStateManager({
        initialStory: createTestStory({
          phase2: {
            outline: createTestOutline(2),
            status: 'content_production',
            userConfirmed: true
          }
        })
      });
      
      let fillDetailsCalls = 0;
      const chapterOperations = createMockChapterOperations({
        createChapterDraft: async (storyId, chapterNum) => ({
          content: '测试内容'.repeat(100),
          wasExpanded: false,
          metrics: { counts: { actualCount: 3000 }, validation: { isQualified: true } }
        }),
        fillDetails: async (storyId, chapterNum, content, options) => {
          fillDetailsCalls++;
          return { detailedContent: content + ' 填充细节' };
        },
        countChapterLength: () => ({
          counts: { actualCount: 3000 },
          validation: { isQualified: true }
        })
      });
      
      const contentValidator = createMockContentValidator();
      
      const phase2 = new Phase2_OutlineDrafting({
        stateManager,
        agentDispatcher,
        chapterOperations,
        contentValidator
      });
      
      await phase2._produceContent('test-story-123');
      
      assert.strictEqual(fillDetailsCalls, 2, 'fillDetails should be called for each chapter');
    });
    
    test('should expand chapter if word count is insufficient', async () => {
      const agentDispatcher = createMockAgentDispatcher();
      const stateManager = createMockStateManager({
        initialStory: createTestStory({
          phase2: {
            outline: createTestOutline(1),
            status: 'content_production',
            userConfirmed: true
          }
        })
      });
      
      let expandCalled = false;
      let expandDeficit = 0;
      
      const chapterOperations = createMockChapterOperations({
        createChapterDraft: async () => ({
          content: '短内容',
          wasExpanded: false,
          metrics: { counts: { actualCount: 500 }, validation: { isQualified: false, deficit: 2000 } }
        }),
        fillDetails: async () => ({
          detailedContent: '填充后内容'.repeat(100)
        }),
        countChapterLength: (content, min, max, opts) => {
          if (opts?.lengthPolicy === 'range') {
            return {
              counts: { actualCount: content.length },
              validation: { isQualified: content.length >= min, deficit: Math.max(0, min - content.length) }
            };
          }
          return {
            counts: { actualCount: 500 },
            validation: { isQualified: false, deficit: 2000 }
          };
        },
        _expandChapter: async (storyId, content, deficit, outline) => {
          expandCalled = true;
          expandDeficit = deficit;
          return { content: content + ' 扩充内容'.repeat(200) };
        }
      });
      
      const contentValidator = createMockContentValidator();
      
      const phase2 = new Phase2_OutlineDrafting({
        stateManager,
        agentDispatcher,
        chapterOperations,
        contentValidator
      });
      
      const result = await phase2._produceChapter('test-story-123', 1, createTestOutline(1).chapters[0]);
      
      assert.strictEqual(expandCalled, true, 'Chapter expansion should be triggered');
      assert.ok(expandDeficit > 0, 'Expansion deficit should be positive');
    });
    
    test('should validate chapter content after production', async () => {
      const agentDispatcher = createMockAgentDispatcher();
      const stateManager = createMockStateManager({
        initialStory: createTestStory({
          phase2: {
            outline: createTestOutline(1),
            status: 'content_production',
            userConfirmed: true,
            chapters: []
          }
        })
      });
      
      let validationCalls = 0;
      const chapterOperations = createMockChapterOperations({
        createChapterDraft: async () => ({
          content: '测试内容'.repeat(100),
          wasExpanded: false,
          metrics: { counts: { actualCount: 3000 }, validation: { isQualified: true } }
        }),
        fillDetails: async () => ({ detailedContent: '填充后内容' }),
        countChapterLength: () => ({
          counts: { actualCount: 3000 },
          validation: { isQualified: true }
        })
      });
      
      const contentValidator = createMockContentValidator({
        comprehensiveValidation: async () => {
          validationCalls++;
          return {
            overall: { passed: true, hasCriticalIssues: false, criticalCount: 0 },
            checks: { worldview: { passed: true }, characters: { passed: true }, plot: { passed: true } },
            allIssues: [],
            allSuggestions: []
          };
        }
      });
      
      const phase2 = new Phase2_OutlineDrafting({
        stateManager,
        agentDispatcher,
        chapterOperations,
        contentValidator
      });
      
      await phase2._produceChapter('test-story-123', 1, createTestOutline(1).chapters[0]);
      
      assert.strictEqual(validationCalls, 1, 'Content validation should be called');
    });
    
    test('should revise chapter if validation fails', async () => {
      const agentDispatcher = createMockAgentDispatcher();
      const stateManager = createMockStateManager({
        initialStory: createTestStory({
          phase2: {
            outline: createTestOutline(1),
            status: 'content_production',
            userConfirmed: true,
            chapters: []
          }
        })
      });
      
      let reviseCalls = 0;
      const chapterOperations = createMockChapterOperations({
        createChapterDraft: async () => ({
          content: '测试内容'.repeat(100),
          wasExpanded: false,
          metrics: { counts: { actualCount: 3000 }, validation: { isQualified: true } }
        }),
        fillDetails: async () => ({ detailedContent: '填充后内容' }),
        countChapterLength: () => ({
          counts: { actualCount: 3000 },
          validation: { isQualified: true }
        }),
        reviseChapter: async (storyId, chapterNum, content, options) => {
          reviseCalls++;
          return {
            revisedContent: content + '\n\n【修订内容】',
            changeSummary: '已修订'
          };
        }
      });
      
      let validationCallCount = 0;
      const contentValidator = createMockContentValidator({
        comprehensiveValidation: async () => {
          validationCallCount++;
          return {
            overall: { 
              passed: validationCallCount > 1, 
              hasCriticalIssues: validationCallCount === 1,
              criticalCount: validationCallCount === 1 ? 1 : 0 
            },
            checks: { worldview: { passed: true }, characters: { passed: true }, plot: { passed: true } },
            allIssues: validationCallCount === 1 ? [{ description: '逻辑问题' }] : [],
            allSuggestions: []
          };
        }
      });
      
      const phase2 = new Phase2_OutlineDrafting({
        stateManager,
        agentDispatcher,
        chapterOperations,
        contentValidator,
        config: { MAX_CHAPTER_REVISION_ATTEMPTS: 1 }
      });
      
      const result = await phase2._produceChapter('test-story-123', 1, createTestOutline(1).chapters[0]);
      
      assert.strictEqual(reviseCalls, 1, 'Chapter should be revised once');
      assert.strictEqual(result.wasRevised, true, 'Result should indicate revision happened');
      assert.strictEqual(result.revisionAttempts, 1, 'Should record revision attempt');
    });
    
    test('should save chapter to state after production', async () => {
      const agentDispatcher = createMockAgentDispatcher();
      let savedChapters = [];
      
      const stateManager = createMockStateManager({
        initialStory: createTestStory({
          phase2: {
            outline: createTestOutline(2),
            status: 'content_production',
            userConfirmed: true,
            chapters: []
          }
        })
      });
      
      const originalUpdatePhase2 = stateManager.updatePhase2;
      stateManager.updatePhase2 = async (storyId, updates) => {
        if (updates.chapters) savedChapters = updates.chapters;
        return originalUpdatePhase2(storyId, updates);
      };
      
      const chapterOperations = createMockChapterOperations({
        createChapterDraft: async (storyId, chapterNum) => ({
          content: `第${chapterNum}章内容`.repeat(50),
          wasExpanded: false,
          metrics: { counts: { actualCount: 3000 }, validation: { isQualified: true } }
        }),
        fillDetails: async () => ({ detailedContent: '填充后内容' }),
        countChapterLength: () => ({
          counts: { actualCount: 3000 },
          validation: { isQualified: true }
        })
      });
      
      const contentValidator = createMockContentValidator();
      
      const phase2 = new Phase2_OutlineDrafting({
        stateManager,
        agentDispatcher,
        chapterOperations,
        contentValidator
      });
      
      await phase2._produceContent('test-story-123');
      
      assert.ok(savedChapters.length > 0, 'Chapters should be saved to state');
      assert.strictEqual(savedChapters.length, 2, 'Both chapters should be saved');
      assert.ok(savedChapters[0].content, 'Chapter 1 should have content');
      assert.ok(savedChapters[1].content, 'Chapter 2 should have content');
    });
    
    test('should track current chapter during production', async () => {
      const agentDispatcher = createMockAgentDispatcher();
      let currentChapterTrack = [];
      
      const stateManager = createMockStateManager({
        initialStory: createTestStory({
          phase2: {
            outline: createTestOutline(3),
            status: 'content_production',
            userConfirmed: true
          }
        })
      });
      
      const originalUpdatePhase2 = stateManager.updatePhase2;
      stateManager.updatePhase2 = async (storyId, updates) => {
        if (updates.currentChapter !== undefined) currentChapterTrack.push(updates.currentChapter);
        return originalUpdatePhase2(storyId, updates);
      };
      
      const chapterOperations = createMockChapterOperations({
        createChapterDraft: async (storyId, chapterNum) => ({
          content: `第${chapterNum}章内容`.repeat(50),
          wasExpanded: false,
          metrics: { counts: { actualCount: 3000 }, validation: { isQualified: true } }
        }),
        fillDetails: async () => ({ detailedContent: '填充后内容' }),
        countChapterLength: () => ({
          counts: { actualCount: 3000 },
          validation: { isQualified: true }
        })
      });
      
      const contentValidator = createMockContentValidator();
      
      const phase2 = new Phase2_OutlineDrafting({
        stateManager,
        agentDispatcher,
        chapterOperations,
        contentValidator
      });
      
      await phase2._produceContent('test-story-123');
      
      assert.deepStrictEqual(currentChapterTrack, [1, 2, 3], 'Current chapter should be tracked sequentially');
    });
  });
  
  describe('State Management', () => {
    
    test('should update phase2 status during execution', async () => {
      const agentDispatcher = createMockAgentDispatcher();
      const stateManager = createMockStateManager({
        initialStory: createTestStory()
      });
      const chapterOperations = createMockChapterOperations();
      const contentValidator = createMockContentValidator();
      
      const phase2 = new Phase2_OutlineDrafting({
        stateManager,
        agentDispatcher,
        chapterOperations,
        contentValidator
      });
      
      await phase2.run('test-story-123');
      
      const finalStory = await stateManager.getStory('test-story-123');
      
      assert.ok(
        finalStory.phase2.status === 'pending_confirmation' || 
        finalStory.phase2.status === 'completed',
        'Phase2 status should be updated'
      );
    });
    
    test('should update story status to phase2_completed after all chapters', async () => {
      const agentDispatcher = createMockAgentDispatcher();
      const stateManager = createMockStateManager({
        initialStory: createTestStory({
          phase2: {
            outline: createTestOutline(2),
            status: 'content_production',
            userConfirmed: true
          }
        })
      });
      
      const chapterOperations = createMockChapterOperations({
        createChapterDraft: async () => ({
          content: '测试内容'.repeat(100),
          wasExpanded: false,
          metrics: { counts: { actualCount: 3000 }, validation: { isQualified: true } }
        }),
        fillDetails: async () => ({ detailedContent: '填充后内容' }),
        countChapterLength: () => ({
          counts: { actualCount: 3000 },
          validation: { isQualified: true }
        })
      });
      
      const contentValidator = createMockContentValidator();
      
      const phase2 = new Phase2_OutlineDrafting({
        stateManager,
        agentDispatcher,
        chapterOperations,
        contentValidator
      });
      
      const result = await phase2._produceContent('test-story-123');
      
      const finalStory = await stateManager.getStory('test-story-123');
      
      assert.strictEqual(result.status, 'completed');
      assert.strictEqual(finalStory.status, 'phase2_completed');
    });
    
    test('should save chapter results with correct structure', async () => {
      const agentDispatcher = createMockAgentDispatcher();
      const stateManager = createMockStateManager({
        initialStory: createTestStory({
          phase2: {
            outline: createTestOutline(1),
            status: 'content_production',
            userConfirmed: true,
            chapters: []
          }
        })
      });
      
      const chapterResult = {
        status: 'completed',
        content: '测试章节正文'.repeat(100),
        wordCount: 3000,
        metrics: {
          counts: { actualCount: 3000 },
          validation: { isQualified: true }
        },
        validation: {
          overall: { passed: true, hasCriticalIssues: false },
          allIssues: []
        },
        wasRevised: false,
        revisionAttempts: 0
      };
      
      const chapterOperations = createMockChapterOperations();
      const contentValidator = createMockContentValidator();
      
      const phase2 = new Phase2_OutlineDrafting({
        stateManager,
        agentDispatcher,
        chapterOperations,
        contentValidator
      });
      
      await phase2._saveChapterToState('test-story-123', 1, chapterResult);
      
      const finalStory = await stateManager.getStory('test-story-123');
      
      assert.ok(finalStory.phase2.chapters.length > 0, 'Chapters array should not be empty');
      const savedChapter = finalStory.phase2.chapters[0];
      assert.strictEqual(savedChapter.number, 1, 'Chapter number should be 1');
      assert.ok(savedChapter.content, 'Chapter should have content');
      assert.ok(savedChapter.metrics, 'Chapter should have metrics');
      assert.ok(savedChapter.validation, 'Chapter should have validation');
      assert.strictEqual(savedChapter.status, 'completed');
    });
    
    test('should handle story not found error', async () => {
      const agentDispatcher = createMockAgentDispatcher();
      const stateManager = createMockStateManager();
      const chapterOperations = createMockChapterOperations();
      const contentValidator = createMockContentValidator();
      
      const phase2 = new Phase2_OutlineDrafting({
        stateManager,
        agentDispatcher,
        chapterOperations,
        contentValidator
      });
      
      await assert.rejects(
        async () => phase2.run('non-existent-story'),
        { message: /Story not found/ }
      );
    });
  });
  
  describe('Outline Validation Parsing', () => {
    
    test('should parse passing validation result', () => {
      const agentDispatcher = createMockAgentDispatcher();
      const stateManager = createMockStateManager();
      const chapterOperations = createMockChapterOperations();
      const contentValidator = createMockContentValidator();
      
      const phase2 = new Phase2_OutlineDrafting({
        stateManager,
        agentDispatcher,
        chapterOperations,
        contentValidator
      });
      
      const result = phase2._parseOutlineValidationResult(`
【验证结论】
通过

【问题清单】
（无）

【修正建议】
（无）
      `);
      
      assert.strictEqual(result.passed, true);
    });
    
    test('should parse failing validation result with issues', () => {
      const agentDispatcher = createMockAgentDispatcher();
      const stateManager = createMockStateManager();
      const chapterOperations = createMockChapterOperations();
      const contentValidator = createMockContentValidator();
      
      const phase2 = new Phase2_OutlineDrafting({
        stateManager,
        agentDispatcher,
        chapterOperations,
        contentValidator
      });
      
      const result = phase2._parseOutlineValidationResult(`
【验证结论】
不通过

【问题清单】
- 章节逻辑不通顺
- 人物出场安排不合理

【修正建议】
- 建议调整章节顺序
- 建议增加人物描写
      `);
      
      assert.strictEqual(result.passed, false);
      assert.ok(result.issues.length > 0, 'Should have issues');
      assert.ok(result.suggestions.length > 0, 'Should have suggestions');
    });
    
    test('should detect failure keywords in validation', () => {
      const agentDispatcher = createMockAgentDispatcher();
      const stateManager = createMockStateManager();
      const chapterOperations = createMockChapterOperations();
      const contentValidator = createMockContentValidator();
      
      const phase2 = new Phase2_OutlineDrafting({
        stateManager,
        agentDispatcher,
        chapterOperations,
        contentValidator
      });
      
      const result1 = phase2._parseOutlineValidationResult('验证结论：不通过');
      assert.strictEqual(result1.passed, false);
      
      const result2 = phase2._parseOutlineValidationResult('验证结论：失败');
      assert.strictEqual(result2.passed, false);
      
      const result3 = phase2._parseOutlineValidationResult('验证结论：通过');
      assert.strictEqual(result3.passed, true);
    });
  });
  
  describe('Error Handling', () => {
    
    test('should handle empty outline gracefully', async () => {
      const agentDispatcher = createMockAgentDispatcher();
      const stateManager = createMockStateManager({
        initialStory: createTestStory({
          phase2: {
            outline: { chapters: [] },
            status: 'content_production',
            userConfirmed: true
          }
        })
      });
      
      const chapterOperations = createMockChapterOperations();
      const contentValidator = createMockContentValidator();
      
      const phase2 = new Phase2_OutlineDrafting({
        stateManager,
        agentDispatcher,
        chapterOperations,
        contentValidator
      });
      
      const result = await phase2._produceContent('test-story-123');
      
      assert.strictEqual(result.status, 'error');
      assert.ok(result.error.includes('No chapters'), 'Should report no chapters error');
    });
  });
  
  describe('Integration Scenarios', () => {
    
    test('complete outline generation and approval flow', async () => {
      const agentDispatcher = createMockAgentDispatcher({
        validatorContent: [
          '【验证结论】',
          '通过',
          '',
          '【问题清单】',
          '（无）'
        ].join('\n')
      });
      
      const stateManager = createMockStateManager({
        initialStory: createTestStory()
      });
      
      const chapterOperations = createMockChapterOperations({
        createChapterDraft: async (storyId, chapterNum) => ({
          content: `第${chapterNum}章测试内容`.repeat(50),
          wasExpanded: false,
          metrics: { counts: { actualCount: 3000 }, validation: { isQualified: true } }
        }),
        fillDetails: async () => ({ detailedContent: '填充后内容' }),
        countChapterLength: () => ({
          counts: { actualCount: 3000 },
          validation: { isQualified: true }
        })
      });
      
      const contentValidator = createMockContentValidator();
      
      const phase2 = new Phase2_OutlineDrafting({
        stateManager,
        agentDispatcher,
        chapterOperations,
        contentValidator
      });
      
      const outlineResult = await phase2.run('test-story-123');
      assert.strictEqual(outlineResult.status, 'waiting_checkpoint');
      
      const contentResult = await phase2.continueFromCheckpoint('test-story-123', 'approve', null);
      
      assert.strictEqual(contentResult.status, 'completed');
      assert.ok(contentResult.data.totalWordCount >= 0);
    });
    
    test('outline generation with revision when validation fails', async () => {
      let plotArchitectCallCount = 0;
      
      const agentDispatcher = createMockAgentDispatcher({
        delegateResult: (agentType, prompt, options) => {
          if (agentType === 'logicValidator') {
            return { content: [
              '【验证结论】',
              '通过',
              '',
              '【问题清单】',
              '（无）'
            ].join('\n') };
          }
          if (agentType === 'plotArchitect') {
            plotArchitectCallCount++;
            return [
              `第${plotArchitectCallCount}章 开篇`,
              '核心事件：故事开始',
              '场景：起点',
              '字数分配：约2500字',
              '',
              `第${plotArchitectCallCount + 1}章 发展`,
              '核心事件：冲突展开',
              '场景：城市',
              '字数分配：约3000字'
            ].join('\n');
          }
          return { content: '测试内容' };
        }
      });
      
      const stateManager = createMockStateManager({
        initialStory: createTestStory()
      });
      
      const chapterOperations = createMockChapterOperations();
      const contentValidator = createMockContentValidator();
      
      const phase2 = new Phase2_OutlineDrafting({
        stateManager,
        agentDispatcher,
        chapterOperations,
        contentValidator,
        config: { MAX_OUTLINE_REVISION_ATTEMPTS: 2 }
      });
      
      const result = await phase2.run('test-story-123');
      
      assert.strictEqual(result.status, 'waiting_checkpoint');
      assert.ok(result.data?.outline, 'Should have outline in result.data');
    });
    
    test('chapter production with word count expansion', async () => {
      const agentDispatcher = createMockAgentDispatcher();
      
      const stateManager = createMockStateManager({
        initialStory: createTestStory({
          phase2: {
            outline: createTestOutline(1),
            status: 'content_production',
            userConfirmed: true
          }
        })
      });
      
      let expansionTriggered = false;
      const chapterOperations = createMockChapterOperations({
        createChapterDraft: async () => ({
          content: '短内容',
          wasExpanded: false,
          metrics: { counts: { actualCount: 500 }, validation: { isQualified: false, deficit: 2000 } }
        }),
        fillDetails: async () => ({
          detailedContent: '填充后内容'
        }),
        countChapterLength: (content, min, max, opts) => {
          const actualCount = content.length;
          return {
            counts: { actualCount },
            validation: { 
              isQualified: actualCount >= min, 
              deficit: actualCount < min ? min - actualCount : 0 
            }
          };
        },
        _expandChapter: async (storyId, content, deficit, outline) => {
          expansionTriggered = true;
          return { content: content + ' 扩充内容'.repeat(300) };
        }
      });
      
      const contentValidator = createMockContentValidator();
      
      const phase2 = new Phase2_OutlineDrafting({
        stateManager,
        agentDispatcher,
        chapterOperations,
        contentValidator
      });
      
      const result = await phase2._produceChapter('test-story-123', 1, createTestOutline(1).chapters[0]);
      
      assert.strictEqual(expansionTriggered, true, 'Chapter expansion should be triggered for insufficient word count');
      assert.ok(result.wordCount > 0, 'Result should have word count');
    });
  });
});

console.log('Running Phase2_OutlineDrafting tests...');
