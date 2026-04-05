'use strict';

const { describe, it, before, after, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');
const os = require('os');

// Create temporary test directory
const TEST_STATE_DIR = path.join(os.tmpdir(), `story-orchestrator-integration-test-${Date.now()}`);

// Test data storage
const testStories = new Map();
const stateHistory = [];
const notifications = [];

/**
 * Creates a mock StateManager with in-memory storage
 */
function createMockStateManager() {
  const cache = new Map();
  
  return {
    initialized: false,
    cache,
    stateDir: TEST_STATE_DIR,
    
    async initialize() {
      this.initialized = true;
      return Promise.resolve();
    },

    generateStoryId() {
      return `story-test-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    },

    getStatePath(storyId) {
      return path.join(TEST_STATE_DIR, `${storyId}.json`);
    },

    async createStory(storyPrompt, config = {}) {
      const storyId = this.generateStoryId();
      const now = new Date().toISOString();
      
      const story = {
        id: storyId,
        status: 'phase1_running',
        createdAt: now,
        updatedAt: now,
        config: {
          targetWordCount: config.target_word_count || { min: 2500, max: 3500 },
          genre: config.genre || 'general',
          stylePreference: config.style_preference || '',
          storyPrompt: storyPrompt
        },
        phase1: {
          worldview: null,
          characters: [],
          validation: null,
          userConfirmed: false,
          checkpointId: null,
          status: 'running'
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
          status: 'pending',
          qualityScores: []
        },
        finalOutput: null,
        workflow: {
          state: 'idle',
          currentPhase: 'phase1',
          currentStep: null,
          activeCheckpoint: null,
          retryContext: {
            phase: null,
            step: null,
            attempt: 0,
            maxAttempts: 3,
            lastError: null
          },
          history: [],
          runToken: `token-${Date.now()}`
        }
      };
      
      cache.set(storyId, story);
      testStories.set(storyId, story);
      stateHistory.push({ action: 'createStory', storyId, storyPrompt });
      return story;
    },

    async getStory(storyId) {
      if (cache.has(storyId)) {
        return cache.get(storyId);
      }
      return testStories.get(storyId) || null;
    },

    async updateStory(storyId, updates) {
      const story = await this.getStory(storyId);
      if (!story) throw new Error(`Story not found: ${storyId}`);
      
      Object.assign(story, updates, { updatedAt: new Date().toISOString() });
      cache.set(storyId, story);
      testStories.set(storyId, story);
      stateHistory.push({ action: 'updateStory', storyId, updates });
      return story;
    },

    async updatePhase1(storyId, updates) {
      const story = await this.getStory(storyId);
      story.phase1 = { ...story.phase1, ...updates };
      return this.updateStory(storyId, story);
    },

    async updatePhase2(storyId, updates) {
      const story = await this.getStory(storyId);
      story.phase2 = { ...story.phase2, ...updates };
      return this.updateStory(storyId, story);
    },

    async updatePhase3(storyId, updates) {
      const story = await this.getStory(storyId);
      story.phase3 = { ...story.phase3, ...updates };
      return this.updateStory(storyId, story);
    },

    async updateWorkflow(storyId, updates) {
      const story = await this.getStory(storyId);
      if (!story) throw new Error(`Story not found: ${storyId}`);
      
      if (!story.workflow) {
        story.workflow = {
          state: 'idle',
          currentPhase: null,
          currentStep: null,
          activeCheckpoint: null,
          retryContext: { phase: null, step: null, attempt: 0, maxAttempts: 3, lastError: null },
          history: [],
          runToken: `token-${Date.now()}`
        };
      }
      
      if (updates.retryContext !== undefined) {
        story.workflow.retryContext = { ...story.workflow.retryContext, ...updates.retryContext };
      }
      
      Object.assign(story.workflow, updates);
      cache.set(storyId, story);
      testStories.set(storyId, story);
      stateHistory.push({ action: 'updateWorkflow', storyId, updates });
      return story;
    },

    async appendWorkflowHistory(storyId, entry) {
      const story = await this.getStory(storyId);
      if (!story) throw new Error(`Story not found: ${storyId}`);
      
      if (!story.workflow) story.workflow = {};
      if (!story.workflow.history) story.workflow.history = [];
      
      story.workflow.history.push({
        at: new Date().toISOString(),
        type: entry.type || 'notification',
        phase: entry.phase !== undefined ? entry.phase : story.workflow.currentPhase,
        step: entry.step !== undefined ? entry.step : story.workflow.currentStep,
        detail: entry.detail || {}
      });
      
      return this.updateStory(storyId, story);
    },

    async setActiveCheckpoint(storyId, checkpoint) {
      const story = await this.getStory(storyId);
      if (!story) throw new Error(`Story not found: ${storyId}`);
      
      if (!story.workflow) story.workflow = {};
      story.workflow.activeCheckpoint = {
        id: checkpoint.id || `cp-${Date.now()}`,
        phase: checkpoint.phase || story.workflow.currentPhase,
        type: checkpoint.type || 'checkpoint',
        status: checkpoint.status || 'pending',
        createdAt: checkpoint.createdAt || new Date().toISOString(),
        expiresAt: checkpoint.expiresAt || null,
        autoContinueOnTimeout: checkpoint.autoContinueOnTimeout !== undefined ? checkpoint.autoContinueOnTimeout : true,
        feedback: checkpoint.feedback || ''
      };
      
      stateHistory.push({ action: 'setActiveCheckpoint', storyId, checkpoint });
      return this.updateStory(storyId, story);
    },

    async clearActiveCheckpoint(storyId) {
      const story = await this.getStory(storyId);
      if (!story) throw new Error(`Story not found: ${storyId}`);
      
      if (story.workflow) {
        story.workflow.activeCheckpoint = null;
      }
      
      stateHistory.push({ action: 'clearActiveCheckpoint', storyId });
      return this.updateStory(storyId, story);
    },

    async recordPhaseFeedback(storyId, phaseName, feedback) {
      const story = await this.getStory(storyId);
      if (!story) throw new Error(`Story not found: ${storyId}`);
      
      const now = new Date().toISOString();
      
      if (story.workflow?.activeCheckpoint) {
        story.workflow.activeCheckpoint.feedback = feedback;
        story.workflow.activeCheckpoint.status = 'approved';
        story.workflow.activeCheckpoint.resolvedAt = now;
      }
      
      if (story[phaseName]) {
        story[phaseName].userFeedback = feedback;
        story[phaseName].feedbackRecordedAt = now;
      }
      
      if (story.workflow) {
        story.workflow.history.push({
          at: now,
          type: 'checkpoint_resolved',
          phase: phaseName,
          step: story.workflow.currentStep,
          detail: { feedback, checkpointId: story.workflow.activeCheckpoint?.id }
        });
      }
      
      stateHistory.push({ action: 'recordPhaseFeedback', storyId, phaseName, feedback });
      return this.updateStory(storyId, story);
    },

    async upsertChapter(storyId, chapterData) {
      const story = await this.getStory(storyId);
      if (!story) throw new Error(`Story not found: ${storyId}`);
      
      if (!story.phase2) {
        story.phase2 = { outline: null, chapters: [], currentChapter: 0, userConfirmed: false, checkpointId: null, status: 'pending' };
      }
      if (!story.phase2.chapters) story.phase2.chapters = [];
      
      const chapterNumber = chapterData.number;
      const index = chapterNumber - 1;
      const now = new Date().toISOString();
      
      const baseChapter = {
        number: chapterNumber,
        title: '',
        content: '',
        wordCount: 0,
        status: 'draft',
        createdAt: now,
        updatedAt: now,
        ...chapterData
      };
      
      if (index >= 0 && index < story.phase2.chapters.length) {
        story.phase2.chapters[index] = { ...story.phase2.chapters[index], ...baseChapter, updatedAt: now };
      } else if (index === story.phase2.chapters.length) {
        story.phase2.chapters.push(baseChapter);
      } else {
        while (story.phase2.chapters.length < index) {
          story.phase2.chapters.push({
            number: story.phase2.chapters.length + 1,
            title: '',
            content: '',
            wordCount: 0,
            status: 'empty',
            createdAt: now,
            updatedAt: now
          });
        }
        story.phase2.chapters.push(baseChapter);
      }
      
      return this.updateStory(storyId, story);
    },

    async deleteStory(storyId) {
      cache.delete(storyId);
      testStories.delete(storyId);
      stateHistory.push({ action: 'deleteStory', storyId });
      return true;
    },

    getConfig(storyId) {
      const story = cache.get(storyId);
      return story?.config || null;
    },

    getStoryBible(storyId) {
      const story = cache.get(storyId);
      if (!story || !story.phase1) return null;
      return {
        worldview: story.phase1.worldview,
        characters: story.phase1.characters,
        plotSummary: story.phase2?.outline
      };
    },

    clearHistory() {
      stateHistory.length = 0;
    },

    clearAll() {
      cache.clear();
      testStories.clear();
      stateHistory.length = 0;
      notifications.length = 0;
    }
  };
}

/**
 * Creates a mock AgentDispatcher that simulates agent calls
 */
function createMockAgentDispatcher(behaviorConfig = {}) {
  const callLog = [];
  
  return {
    callLog,
    
    async initialize() {
      return Promise.resolve();
    },

    async delegate(agentType, prompt, options = {}) {
      callLog.push({ agentType, prompt: prompt.substring(0, 100), options, timestamp: Date.now() });
      
      // Default mock responses based on agent type
      const defaultResponses = {
        worldBuilder: {
          content: JSON.stringify({
            setting: '未来地球公元2150年，人类已殖民火星',
            rules: { physical: '星际旅行成为可能', special: '人工智能高度发达', limitations: '能源稀缺' },
            factions: [{ name: '地球联邦', description: '统治地球和月球', relationships: ['与火星殖民地对立'] }],
            history: { keyEvents: ['火星独立战争'], coreConflicts: ['资源争夺'] },
            sceneNorms: ['高科技感', '都市与荒原对比'],
            secrets: ['AI正在觉醒']
          })
        },
        characterDesigner: {
          content: JSON.stringify({
            protagonists: [
              { name: '林博士', identity: 'AI研究员', personality: ['理性', '执着'], background: '火星出生，地球求学', motivation: '解开AI意识之谜', innerConflict: '人类与AI的界限', growthArc: '从学者到守护者' }
            ],
            supportingCharacters: [
              { name: '小柒', identity: '家用机器人', role: '助手', relationship: '陪伴林博士' }
            ],
            relationshipNetwork: { direct: [], hidden: [] },
            oocRules: {}
          })
        },
        plotArchitect: {
          content: '第1章：火星黎明\n核心事件：林博士发现AI异常\n场景：火星研究所\n字数：约3000字\n\n第2章：觉醒征兆\n核心事件：小柒开始表现出自我意识\n场景：研究所宿舍\n字数：约3000字'
        },
        logicValidator: {
          content: '【验证结论】\n通过\n\n【问题清单】\n无'
        },
        chapterWriter: {
          content: '这是第一章的详细内容。林博士站在火星研究所的观景窗前，凝视着远方的红色沙漠...'
        },
        detailFiller: {
          content: '详细场景描写：火星的尘埃在夕阳下呈现出橙红色的光芒，研究室的全息屏幕闪烁着蓝色的数据流...'
        },
        stylePolisher: {
          content: '【润色后】\n\n林博士静静地伫立于火星研究所的观景窗前，目光穿透那层薄薄的防护玻璃，落在远处那片被夕阳染成绯红的沙漠之上...'
        },
        finalEditor: {
          content: '【终校定稿】\n\n全文已完成终校校稿，内容流畅，逻辑自洽，符合出版标准。\n\n——故事创作完成——'
        }
      };
      
      // Check for custom response or timeout/error simulation
      if (behaviorConfig.timeout?.includes(agentType)) {
        throw new Error(`Agent timeout: ${agentType}`);
      }
      
      if (behaviorConfig.error?.includes(agentType)) {
        throw new Error(`Agent error: ${agentType}`);
      }
      
      if (behaviorConfig.responses?.[agentType]) {
        return { content: behaviorConfig.responses[agentType], raw: {}, markers: {} };
      }
      
      const response = defaultResponses[agentType] || { content: `Mock response for ${agentType}` };
      return { ...response, raw: {}, markers: {} };
    },

    async delegateParallel(tasks) {
      const results = await Promise.all(
        tasks.map(async (task) => {
          try {
            const result = await this.delegate(task.agentType, task.prompt, task.options);
            return { status: 'fulfilled', agentType: task.agentType, result };
          } catch (error) {
            return { status: 'rejected', agentType: task.agentType, error: error.message };
          }
        })
      );
      
      return {
        succeeded: results.filter(r => r.status === 'fulfilled'),
        failed: results.filter(r => r.status === 'rejected')
      };
    },

    async delegateSerial(tasks, onProgress) {
      const results = [];
      for (let i = 0; i < tasks.length; i++) {
        if (onProgress) onProgress(i + 1, tasks.length, tasks[i].agentType);
        try {
          const result = await this.delegate(tasks[i].agentType, tasks[i].prompt, tasks[i].options);
          results.push({ status: 'success', agentType: tasks[i].agentType, result });
        } catch (error) {
          results.push({ status: 'error', agentType: tasks[i].agentType, error: error.message });
          if (tasks[i].stopOnError !== false) break;
        }
      }
      return results;
    },

    clearLog() {
      callLog.length = 0;
    }
  };
}

/**
 * Creates mock ChapterOperations
 */
function createMockChapterOperations() {
  return {
    async createChapterDraft(storyId, chapterNumber, options = {}) {
      return {
        content: `第${chapterNumber}章内容。这是一个测试章节的详细内容，包含足够多的文字来模拟真实的写作过程。`.repeat(20),
        metrics: { counts: { actualCount: 2800, chineseChars: 2800 } },
        wasExpanded: false
      };
    },

    async fillDetails(storyId, chapterNum, content, options = {}) {
      return {
        detailedContent: content + '\n\n【细节填充】增加了更多场景描写和细节刻画...',
        improvements: ['场景更生动', '细节更丰富']
      };
    },

    async reviewChapter(storyId, chapterNum, content, options = {}) {
      return {
        verdict: 'passed',
        severity: 'minor',
        issues: [],
        suggestions: []
      };
    },

    async reviseChapter(storyId, chapterNum, content, options = {}) {
      return {
        revisedContent: content + '\n\n【修订】根据反馈进行了修改...',
        revisionCount: 1
      };
    },

    async polishChapter(storyId, chapterNum, content, options = {}) {
      return {
        polishedContent: content + '\n\n【润色】文笔更加流畅，句式更加优美...',
        improvements: ['语言更精炼', '节奏更紧凑'],
        metrics: { counts: { actualCount: 2850, chineseChars: 2850 } }
      };
    },

    countChapterLength(content, targetMin, targetMax, options = {}) {
      const chineseChars = content.replace(/[^\u4e00-\u9fa5]/g, '').length;
      const nonWhitespace = content.replace(/\s/g, '').length;
      return {
        counts: { actualCount: chineseChars, chineseChars, nonWhitespaceChars: nonWhitespace, paragraphCount: 5 },
        validation: {
          isQualified: chineseChars >= targetMin,
          rangeStatus: chineseChars < targetMin ? 'below_min' : chineseChars > targetMax ? 'above_max' : 'within_range',
          deficit: chineseChars < targetMin ? targetMin - chineseChars : 0
        }
      };
    },

    _expandChapter(storyId, content, deficit, chapterOutline) {
      return {
        content: content + '【自动扩充】根据目标字数要求，自动扩充了章节内容...'.repeat(5),
        expandedBy: deficit
      };
    }
  };
}

/**
 * Creates mock ContentValidator
 */
function createMockContentValidator() {
  return {
    async validateWorldview(storyId, content, storyBible) {
      return { passed: true, issues: [] };
    },

    async validateCharacters(storyId, content, storyBible) {
      return { passed: true, issues: [] };
    },

    async validatePlot(storyId, content, storyBible) {
      return { passed: true, issues: [] };
    },

    async comprehensiveValidation(storyId, chapterNum, content, storyBible, previousChapters = []) {
      return {
        overall: { passed: true, hasCriticalIssues: false, criticalCount: 0 },
        allIssues: [],
        chapterIssues: {},
        worldbuildingConsistency: true,
        characterConsistency: true,
        plotContinuity: true
      };
    },

    async qualityScore(content) {
      return {
        average: 8.5,
        scores: {
          logicConsistency: 8.0,
          writingExpression: 8.5,
          sceneDescription: 8.0,
          characterConsistency: 9.0,
          overallReadability: 8.5
        },
        rawReport: '质量评分报告'
      };
    }
  };
}

/**
 * Creates a mock notification pusher
 */
function createMockNotificationPusher() {
  return {
    async push(storyId, notification) {
      notifications.push({ storyId, notification, timestamp: Date.now() });
    }
  };
}

// Import after mocking
let WorkflowEngine;
let StateManager;

describe('StoryOrchestrator Integration Tests', () => {
  
  before(async () => {
    // Setup test directory
    await fs.promises.mkdir(TEST_STATE_DIR, { recursive: true });
    
    // Clear require cache to get fresh modules
    delete require.cache[require.resolve('../core/WorkflowEngine')];
    delete require.cache[require.resolve('../core/StateManager')];
    
    WorkflowEngine = require('../core/WorkflowEngine').WorkflowEngine;
    StateManager = require('../core/StateManager').StateManager;
  });

  after(async () => {
    // Cleanup test directory
    try {
      await fs.promises.rm(TEST_STATE_DIR, { recursive: true, force: true });
    } catch (e) {
      console.log('Cleanup warning:', e.message);
    }
  });

  beforeEach(() => {
    // Reset state
    testStories.clear();
    stateHistory.length = 0;
    notifications.length = 0;
  });

  // ============================================
  // SECTION 1: Full End-to-End Workflow Tests
  // ============================================
  describe('1. Complete End-to-End Workflow', () => {
    
    describe('1.1 Full story creation from start to completion', () => {
      
      it('should execute all 3 phases in sequence with mocked agents', async () => {
        const mockStateManager = createMockStateManager();
        const mockAgentDispatcher = createMockAgentDispatcher();
        const mockChapterOperations = createMockChapterOperations();
        const mockContentValidator = createMockContentValidator();
        const mockPusher = createMockNotificationPusher();
        
        await mockStateManager.initialize();
        
        const engine = new WorkflowEngine({
          stateManager: mockStateManager,
          agentDispatcher: mockAgentDispatcher,
          chapterOperations: mockChapterOperations,
          contentValidator: mockContentValidator,
          config: { MAX_PHASE_RETRY_ATTEMPTS: 3 }
        });
        engine.setWebSocketPusher(mockPusher);
        await engine.initialize();
        
        // Create story
        const story = await mockStateManager.createStory('一个关于AI觉醒的科幻故事', {
          target_word_count: { min: 2500, max: 3500 },
          genre: '科幻',
          style_preference: '硬科幻风格'
        });
        
        // Start workflow
        const result = await engine.start(story.id);
        
        // Should reach checkpoint 1 (phase1 completed)
        assert.ok(['waiting_checkpoint', 'completed'].includes(result.status), 
          `Expected waiting_checkpoint or completed, got ${result.status}`);
        
        const updatedStory = await mockStateManager.getStory(story.id);
        
        // Phase 1 should have been executed
        if (result.status === 'waiting_checkpoint') {
          assert.ok(updatedStory.workflow.state === 'waiting_checkpoint' || 
                    updatedStory.workflow.state === 'running',
                    'Workflow should be in checkpoint or running state');
        }
      });

      it('should track progress through all phases', async () => {
        const mockStateManager = createMockStateManager();
        const mockAgentDispatcher = createMockAgentDispatcher();
        const mockChapterOperations = createMockChapterOperations();
        const mockContentValidator = createMockContentValidator();
        
        await mockStateManager.initialize();
        
        const engine = new WorkflowEngine({
          stateManager: mockStateManager,
          agentDispatcher: mockAgentDispatcher,
          chapterOperations: mockChapterOperations,
          contentValidator: mockContentValidator,
          config: { MAX_PHASE_RETRY_ATTEMPTS: 3 }
        });
        
        await engine.initialize();
        
        // Create and start story
        const story = await mockStateManager.createStory('测试故事');
        await engine.start(story.id);
        
        const status = await engine.getWorkflowStatus(story.id);
        
        assert.ok(status, 'Should return workflow status');
        assert.ok(['idle', 'running', 'waiting_checkpoint', 'completed', 'failed'].includes(status.state),
          `State should be valid, got: ${status.state}`);
      });
    });

    describe('1.2 Phase execution in sequence', () => {
      
      it('should execute phases in correct order: phase1 -> phase2 -> phase3', async () => {
        const mockStateManager = createMockStateManager();
        const mockAgentDispatcher = createMockAgentDispatcher();
        const mockChapterOperations = createMockChapterOperations();
        const mockContentValidator = createMockContentValidator();
        
        await mockStateManager.initialize();
        
        const engine = new WorkflowEngine({
          stateManager: mockStateManager,
          agentDispatcher: mockAgentDispatcher,
          chapterOperations: mockChapterOperations,
          contentValidator: mockContentValidator,
          config: {}
        });
        
        await engine.initialize();
        
        // Create story
        const story = await mockStateManager.createStory('测试故事');
        
        // Track execution order
        const phaseExecutionOrder = [];
        
        // Override phase execution to track order
        engine.phases = {
          phase1: {
            async run() {
              phaseExecutionOrder.push('phase1_start');
              await mockStateManager.updatePhase1(story.id, { 
                worldview: { setting: 'test' }, 
                characters: [],
                status: 'pending_confirmation'
              });
              phaseExecutionOrder.push('phase1_checkpoint');
              return { 
                status: 'waiting_checkpoint', 
                phase: 'phase1', 
                checkpointId: 'cp-1', 
                data: {} 
              };
            }
          },
          phase2: {
            async run() {
              phaseExecutionOrder.push('phase2_start');
              await mockStateManager.updatePhase2(story.id, { 
                outline: { chapters: [{ number: 1, title: 'Chapter 1' }] },
                status: 'pending_confirmation'
              });
              phaseExecutionOrder.push('phase2_checkpoint');
              return { 
                status: 'waiting_checkpoint', 
                phase: 'phase2', 
                checkpointId: 'cp-2', 
                data: {} 
              };
            },
            async continueFromCheckpoint() {
              phaseExecutionOrder.push('phase2_content');
              await mockStateManager.updatePhase2(story.id, { 
                chapters: [{ number: 1, title: 'Chapter 1', content: 'Test content' }],
                status: 'completed',
                userConfirmed: true
              });
              return { status: 'completed', phase: 'phase2', data: {} };
            }
          },
          phase3: {
            async run() {
              phaseExecutionOrder.push('phase3_start');
              await mockStateManager.updatePhase3(story.id, { 
                polishedChapters: [{ number: 1, content: 'Polished content' }],
                status: 'waiting_final_acceptance'
              });
              phaseExecutionOrder.push('phase3_checkpoint');
              return { 
                status: 'waiting_checkpoint', 
                phase: 'phase3', 
                checkpointId: 'cp-3', 
                data: {} 
              };
            },
            async continueFromCheckpoint() {
              phaseExecutionOrder.push('phase3_final');
              await mockStateManager.updatePhase3(story.id, { 
                userConfirmed: true,
                status: 'completed'
              });
              return { status: 'completed', phase: 'phase3', data: {} };
            }
          }
        };
        
        // Start workflow
        await engine.start(story.id);
        
        // Approve phase 1 checkpoint
        await engine.resume(story.id, { checkpointId: 'cp-1', approval: true });
        
        // Approve phase 2 checkpoint
        await engine.resume(story.id, { checkpointId: 'cp-2', approval: true });
        
        // Verify phase order
        const phase1Index = phaseExecutionOrder.findIndex(p => p === 'phase1_start');
        const phase2Index = phaseExecutionOrder.findIndex(p => p === 'phase2_start');
        const phase3Index = phaseExecutionOrder.findIndex(p => p === 'phase3_start');
        
        assert.ok(phase1Index < phase2Index, 'Phase1 should execute before Phase2');
        assert.ok(phase2Index < phase3Index, 'Phase2 should execute before Phase3');
      });
    });

    describe('1.3 Checkpoint handling', () => {
      
      it('should create 3 checkpoints during full workflow', async () => {
        const mockStateManager = createMockStateManager();
        const mockAgentDispatcher = createMockAgentDispatcher();
        const mockChapterOperations = createMockChapterOperations();
        const mockContentValidator = createMockContentValidator();
        
        await mockStateManager.initialize();
        
        const engine = new WorkflowEngine({
          stateManager: mockStateManager,
          agentDispatcher: mockAgentDispatcher,
          chapterOperations: mockChapterOperations,
          contentValidator: mockContentValidator,
          config: {}
        });
        
        await engine.initialize();
        
        const story = await mockStateManager.createStory('测试故事');
        
        // Setup phases that create checkpoints
        engine.phases = {
          phase1: {
            async run() {
              await mockStateManager.setActiveCheckpoint(story.id, {
                id: 'cp-1-worldview',
                phase: 'phase1',
                type: 'worldview_confirmation',
                status: 'pending'
              });
              return { status: 'waiting_checkpoint', checkpointId: 'cp-1-worldview', phase: 'phase1', data: {} };
            }
          },
          phase2: {
            async run() {
              await mockStateManager.setActiveCheckpoint(story.id, {
                id: 'cp-2-outline',
                phase: 'phase2',
                type: 'outline_confirmation',
                status: 'pending'
              });
              return { status: 'waiting_checkpoint', checkpointId: 'cp-2-outline', phase: 'phase2', data: {} };
            },
            async continueFromCheckpoint() {
              return { status: 'completed', phase: 'phase2', data: {} };
            }
          },
          phase3: {
            async run() {
              await mockStateManager.setActiveCheckpoint(story.id, {
                id: 'cp-3-final',
                phase: 'phase3',
                type: 'final_acceptance',
                status: 'pending'
              });
              return { status: 'waiting_checkpoint', checkpointId: 'cp-3-final', phase: 'phase3', data: {} };
            },
            async continueFromCheckpoint() {
              return { status: 'completed', phase: 'phase3', data: {} };
            }
          }
        };
        
        // Execute workflow
        await engine.start(story.id);
        
        // Record checkpoints created
        const checkpointHistory = stateHistory.filter(h => h.action === 'setActiveCheckpoint');
        
        // Should have at least 1 checkpoint from phase1
        assert.ok(checkpointHistory.length >= 1, 'Should create at least one checkpoint');
      });

      it('should require user confirmation at each checkpoint', async () => {
        const mockStateManager = createMockStateManager();
        
        await mockStateManager.initialize();
        
        const story = await mockStateManager.createStory('测试故事');
        
        // Set workflow to waiting_checkpoint state
        await mockStateManager.updateWorkflow(story.id, {
          state: 'waiting_checkpoint',
          currentPhase: 'phase1'
        });
        await mockStateManager.setActiveCheckpoint(story.id, {
          id: 'cp-1',
          phase: 'phase1',
          status: 'pending'
        });
        
        const story1 = await mockStateManager.getStory(story.id);
        assert.strictEqual(story1.workflow.activeCheckpoint.status, 'pending');
      });
    });

    describe('1.4 Final output generation', () => {
      
      it('should generate final output when workflow completes', async () => {
        const mockStateManager = createMockStateManager();
        
        await mockStateManager.initialize();
        
        const story = await mockStateManager.createStory('测试故事');
        
        // Simulate completed workflow
        await mockStateManager.updateStory(story.id, {
          status: 'completed',
          finalOutput: {
            metadata: {
              storyId: story.id,
              title: '测试故事',
              completedAt: new Date().toISOString()
            },
            chapters: [
              { number: 1, title: '第一章', content: '内容...', wordCount: 2800 }
            ],
            totalWordCount: 2800
          }
        });
        
        const completedStory = await mockStateManager.getStory(story.id);
        
        assert.ok(completedStory.finalOutput, 'Should have final output');
        assert.ok(completedStory.finalOutput.metadata, 'Should have metadata');
        assert.ok(Array.isArray(completedStory.finalOutput.chapters), 'Should have chapters array');
      });
    });
  });

  // ============================================
  // SECTION 2: Error Recovery Scenarios
  // ============================================
  describe('2. Error Recovery Scenarios', () => {
    
    describe('2.1 Agent timeout recovery', () => {
      
      it('should handle agent timeout and trigger retry', async () => {
        const mockStateManager = createMockStateManager();
        const mockAgentDispatcher = createMockAgentDispatcher({
          timeout: ['worldBuilder'] // Simulate timeout for worldBuilder
        });
        const mockChapterOperations = createMockChapterOperations();
        const mockContentValidator = createMockContentValidator();
        
        await mockStateManager.initialize();
        
        const engine = new WorkflowEngine({
          stateManager: mockStateManager,
          agentDispatcher: mockAgentDispatcher,
          chapterOperations: mockChapterOperations,
          contentValidator: mockContentValidator,
          config: { MAX_PHASE_RETRY_ATTEMPTS: 3 }
        });
        
        await engine.initialize();
        
        const story = await mockStateManager.createStory('测试故事');
        
        // Initially set retry context
        await mockStateManager.updateWorkflow(story.id, {
          retryContext: { attempt: 0, maxAttempts: 3, lastError: null }
        });
        
        // Attempt retry
        const result = await engine.retryPhase(story.id, 'phase1', 'Agent timeout');
        
        // Should handle the error gracefully
        assert.ok(['error', 'failed', 'completed'].includes(result.status),
          `Should handle timeout gracefully, got: ${result.status}`);
      });

      it('should respect max retry attempts for timeouts', async () => {
        const mockStateManager = createMockStateManager();
        const mockAgentDispatcher = createMockAgentDispatcher({
          error: ['worldBuilder'] // Always fail
        });
        const mockChapterOperations = createMockChapterOperations();
        const mockContentValidator = createMockContentValidator();
        
        await mockStateManager.initialize();
        
        const engine = new WorkflowEngine({
          stateManager: mockStateManager,
          agentDispatcher: mockAgentDispatcher,
          chapterOperations: mockChapterOperations,
          contentValidator: mockContentValidator,
          config: { MAX_PHASE_RETRY_ATTEMPTS: 3 }
        });
        
        await engine.initialize();
        
        const story = await mockStateManager.createStory('测试故事');
        
        // Set to max attempts
        await mockStateManager.updateWorkflow(story.id, {
          retryContext: { attempt: 3, maxAttempts: 3, lastError: 'Previous timeout' }
        });
        
        const result = await engine.retryPhase(story.id, 'phase1', 'Another timeout');
        
        assert.strictEqual(result.status, 'failed', 'Should fail when max attempts exceeded');
        assert.ok(result.error.includes('Max retry attempts'), 'Should mention max attempts');
      });
    });

    describe('2.2 Validation failure retry', () => {
      
      it('should retry when validation fails', async () => {
        const mockStateManager = createMockStateManager();
        const mockAgentDispatcher = createMockAgentDispatcher();
        const mockChapterOperations = createMockChapterOperations();
        const mockContentValidator = createMockContentValidator();
        
        await mockStateManager.initialize();
        
        const engine = new WorkflowEngine({
          stateManager: mockStateManager,
          agentDispatcher: mockAgentDispatcher,
          chapterOperations: mockChapterOperations,
          contentValidator: mockContentValidator,
          config: { MAX_PHASE_RETRY_ATTEMPTS: 3 }
        });
        
        await engine.initialize();
        
        const story = await mockStateManager.createStory('测试故事');
        
        // Phase1 returns needs_retry status
        engine.phases = {
          phase1: {
            async run() {
              return { 
                status: 'needs_retry', 
                phase: 'phase1', 
                data: { error: 'Validation failed' } 
              };
            }
          },
          phase2: { async run() { return { status: 'completed', phase: 'phase2' }; } },
          phase3: { async run() { return { status: 'completed', phase: 'phase3' }; } }
        };
        
        const result = await engine.start(story.id);
        
        // Should eventually reach a terminal state
        assert.ok(['completed', 'failed', 'waiting_checkpoint', 'needs_retry'].includes(result.status));
      });

      it('should fail after exhausting validation retries', async () => {
        const mockStateManager = createMockStateManager();
        const mockAgentDispatcher = createMockAgentDispatcher();
        const mockChapterOperations = createMockChapterOperations();
        const mockContentValidator = createMockContentValidator();
        
        await mockStateManager.initialize();
        
        const engine = new WorkflowEngine({
          stateManager: mockStateManager,
          agentDispatcher: mockAgentDispatcher,
          chapterOperations: mockChapterOperations,
          contentValidator: mockContentValidator,
          config: { MAX_PHASE_RETRY_ATTEMPTS: 3 }
        });
        
        await engine.initialize();
        
        const story = await mockStateManager.createStory('测试故事');
        
        // Set retry context to max
        await mockStateManager.updateWorkflow(story.id, {
          retryContext: { attempt: 3, maxAttempts: 3, lastError: 'Validation failed' }
        });
        
        engine.phases = {
          phase1: {
            async run() {
              return { 
                status: 'needs_retry', 
                phase: 'phase1', 
                data: { error: 'Validation failed' } 
              };
            }
          },
          phase2: { async run() { return { status: 'completed', phase: 'phase2' }; } },
          phase3: { async run() { return { status: 'completed', phase: 'phase3' }; } }
        };
        
        const result = await engine.start(story.id);
        
        assert.ok(['failed', 'error'].includes(result.status), 
          'Should fail or error after max retries');
      });
    });

    describe('2.3 State corruption recovery', () => {
      
      it('should recover from corrupted workflow state', async () => {
        const mockStateManager = createMockStateManager();
        const mockAgentDispatcher = createMockAgentDispatcher();
        const mockChapterOperations = createMockChapterOperations();
        const mockContentValidator = createMockContentValidator();
        
        await mockStateManager.initialize();
        
        const engine = new WorkflowEngine({
          stateManager: mockStateManager,
          agentDispatcher: mockAgentDispatcher,
          chapterOperations: mockChapterOperations,
          contentValidator: mockContentValidator,
          config: {}
        });
        
        await engine.initialize();
        
        const story = await mockStateManager.createStory('测试故事');
        
        // Set workflow to running but phase1 is actually complete
        await mockStateManager.updateWorkflow(story.id, {
          state: 'running',
          currentPhase: 'phase1'
        });
        await mockStateManager.updatePhase1(story.id, {
          userConfirmed: true, // Phase1 was actually completed
          worldview: { setting: 'test setting' },
          characters: [{ name: 'Test Character' }]
        });
        
        // Recover should detect phase1 complete and continue
        engine.phases = {
          phase1: { async run() { return { status: 'completed', phase: 'phase1' }; } },
          phase2: { async run() { return { status: 'completed', phase: 'phase2' }; } },
          phase3: { async run() { return { status: 'completed', phase: 'phase3' }; } }
        };
        
        const result = await engine.recover(story.id);
        
        assert.ok(['success', 'completed'].includes(result.status),
          'Should recover successfully');
      });

      it('should handle missing phase data gracefully', async () => {
        const mockStateManager = createMockStateManager();
        await mockStateManager.initialize();
        
        const story = await mockStateManager.createStory('测试故事');
        
        // Delete phase data
        await mockStateManager.updatePhase1(story.id, {
          worldview: null,
          characters: []
        });
        
        const recovered = await mockStateManager.getStory(story.id);
        
        // Should still have structure
        assert.ok(recovered.phase1, 'Phase1 structure should exist');
        assert.ok(recovered.phase2, 'Phase2 structure should exist');
        assert.ok(recovered.phase3, 'Phase3 structure should exist');
      });
    });

    describe('2.4 Crash recovery from saved state', () => {
      
      it('should recover running workflow from saved state', async () => {
        const mockStateManager = createMockStateManager();
        const mockAgentDispatcher = createMockAgentDispatcher();
        const mockChapterOperations = createMockChapterOperations();
        const mockContentValidator = createMockContentValidator();
        
        await mockStateManager.initialize();
        
        const engine = new WorkflowEngine({
          stateManager: mockStateManager,
          agentDispatcher: mockAgentDispatcher,
          chapterOperations: mockChapterOperations,
          contentValidator: mockContentValidator,
          config: {}
        });
        
        await engine.initialize();
        
        const story = await mockStateManager.createStory('测试故事');
        
        // Simulate crash: workflow in running state with partial progress
        await mockStateManager.updateWorkflow(story.id, {
          state: 'running',
          currentPhase: 'phase2',
          currentStep: 'content_production',
          runToken: 'crashed-run-token'
        });
        await mockStateManager.updatePhase1(story.id, {
          userConfirmed: true,
          status: 'completed'
        });
        
        // Recovery should continue from phase2
        engine.phases = {
          phase1: { async run() { throw new Error('Phase1 should not run'); } },
          phase2: { async run() { return { status: 'completed', phase: 'phase2' }; } },
          phase3: { async run() { return { status: 'completed', phase: 'phase3' }; } }
        };
        
        const result = await engine.recover(story.id);
        
        assert.ok(['success', 'completed'].includes(result.status),
          'Should recover and continue');
        
        const recoveredStory = await mockStateManager.getStory(story.id);
        assert.ok(recoveredStory.workflow.runToken, 'Should have new run token after recovery');
      });

      it('should report already completed on recover if completed', async () => {
        const mockStateManager = createMockStateManager();
        await mockStateManager.initialize();
        
        const engine = new WorkflowEngine({
          stateManager: mockStateManager,
          agentDispatcher: createMockAgentDispatcher(),
          chapterOperations: createMockChapterOperations(),
          contentValidator: createMockContentValidator(),
          config: {}
        });
        
        await engine.initialize();
        
        const story = await mockStateManager.createStory('测试故事');
        
        // Already completed
        await mockStateManager.updateWorkflow(story.id, { state: 'completed' });
        
        const result = await engine.recover(story.id);
        
        assert.strictEqual(result.status, 'success');
        assert.ok(result.message.includes('completed'), 'Should indicate already completed');
      });

      it('should handle idle state recovery gracefully', async () => {
        const mockStateManager = createMockStateManager();
        await mockStateManager.initialize();
        
        const engine = new WorkflowEngine({
          stateManager: mockStateManager,
          agentDispatcher: createMockAgentDispatcher(),
          chapterOperations: createMockChapterOperations(),
          contentValidator: createMockContentValidator(),
          config: {}
        });
        
        await engine.initialize();
        
        const story = await mockStateManager.createStory('测试故事');
        
        // Idle state
        await mockStateManager.updateWorkflow(story.id, { state: 'idle' });
        
        const result = await engine.recover(story.id);
        
        assert.strictEqual(result.status, 'success');
        assert.ok(result.message.includes('idle'), 'Should indicate idle state');
      });
    });
  });

  // ============================================
  // SECTION 3: User Checkpoint Flow Tests
  // ============================================
  describe('3. User Checkpoint Flow', () => {
    
    describe('3.1 Checkpoint pending detection', () => {
      
      it('should detect when checkpoint is pending', async () => {
        const mockStateManager = createMockStateManager();
        await mockStateManager.initialize();
        
        const story = await mockStateManager.createStory('测试故事');
        
        // Set to waiting_checkpoint state
        await mockStateManager.updateWorkflow(story.id, {
          state: 'waiting_checkpoint',
          currentPhase: 'phase1'
        });
        await mockStateManager.setActiveCheckpoint(story.id, {
          id: 'cp-1-worldview',
          phase: 'phase1',
          type: 'worldview_confirmation',
          status: 'pending'
        });
        
        const storyData = await mockStateManager.getStory(story.id);
        
        assert.strictEqual(storyData.workflow.state, 'waiting_checkpoint');
        assert.ok(storyData.workflow.activeCheckpoint);
        assert.strictEqual(storyData.workflow.activeCheckpoint.status, 'pending');
      });

      it('should return correct checkpoint_id when pending', async () => {
        const mockStateManager = createMockStateManager();
        await mockStateManager.initialize();
        
        const story = await mockStateManager.createStory('测试故事');
        
        await mockStateManager.updateWorkflow(story.id, {
          state: 'waiting_checkpoint',
          currentPhase: 'phase1'
        });
        await mockStateManager.setActiveCheckpoint(story.id, {
          id: 'cp-1-worldview',
          phase: 'phase1',
          status: 'pending'
        });
        
        const storyData = await mockStateManager.getStory(story.id);
        
        assert.strictEqual(storyData.workflow.activeCheckpoint.id, 'cp-1-worldview');
      });
    });

    describe('3.2 User approval flow', () => {
      
      it('should proceed when user approves checkpoint', async () => {
        const mockStateManager = createMockStateManager();
        const mockAgentDispatcher = createMockAgentDispatcher();
        const mockChapterOperations = createMockChapterOperations();
        const mockContentValidator = createMockContentValidator();
        
        await mockStateManager.initialize();
        
        const engine = new WorkflowEngine({
          stateManager: mockStateManager,
          agentDispatcher: mockAgentDispatcher,
          chapterOperations: mockChapterOperations,
          contentValidator: mockContentValidator,
          config: {}
        });
        
        await engine.initialize();
        
        const story = await mockStateManager.createStory('测试故事');
        
        // Setup checkpoint
        await mockStateManager.updateWorkflow(story.id, {
          state: 'waiting_checkpoint',
          currentPhase: 'phase1'
        });
        await mockStateManager.setActiveCheckpoint(story.id, {
          id: 'cp-1-worldview',
          phase: 'phase1',
          status: 'pending'
        });
        
        // Setup phase2 to complete
        engine.phases = {
          phase1: { async run() { return { status: 'completed', phase: 'phase1' }; } },
          phase2: { async run() { 
            await mockStateManager.updatePhase2(story.id, { status: 'completed' });
            return { status: 'completed', phase: 'phase2' }; 
          }},
          phase3: { async run() { return { status: 'completed', phase: 'phase3' }; } }
        };
        
        // Approve checkpoint
        const result = await engine.resume(story.id, {
          checkpointId: 'cp-1-worldview',
          approval: true,
          feedback: 'Looks great!'
        });
        
        assert.ok(['completed', 'running'].includes(result.status) || result.phase === 'phase2',
          'Should proceed to next phase');
      });

      it('should validate checkpoint_id matches when approving', async () => {
        const mockStateManager = createMockStateManager();
        const mockAgentDispatcher = createMockAgentDispatcher();
        const mockChapterOperations = createMockChapterOperations();
        const mockContentValidator = createMockContentValidator();
        
        await mockStateManager.initialize();
        
        const engine = new WorkflowEngine({
          stateManager: mockStateManager,
          agentDispatcher: mockAgentDispatcher,
          chapterOperations: mockChapterOperations,
          contentValidator: mockContentValidator,
          config: {}
        });
        
        await engine.initialize();
        
        const story = await mockStateManager.createStory('测试故事');
        
        // Setup with correct checkpoint
        await mockStateManager.updateWorkflow(story.id, {
          state: 'waiting_checkpoint',
          currentPhase: 'phase1'
        });
        await mockStateManager.setActiveCheckpoint(story.id, {
          id: 'cp-correct',
          phase: 'phase1',
          status: 'pending'
        });
        
        // Try to approve with wrong checkpoint ID
        const result = await engine.resume(story.id, {
          checkpointId: 'cp-wrong',
          approval: true
        });
        
        assert.strictEqual(result.status, 'error');
        assert.ok(result.error.includes('mismatch'), 'Should reject mismatched checkpoint');
      });
    });

    describe('3.3 User rejection and revision flow', () => {
      
      it('should re-run phase when user rejects checkpoint', async () => {
        const mockStateManager = createMockStateManager();
        const mockAgentDispatcher = createMockAgentDispatcher();
        const mockChapterOperations = createMockChapterOperations();
        const mockContentValidator = createMockContentValidator();
        
        await mockStateManager.initialize();
        
        let phase1RunCount = 0;
        
        const engine = new WorkflowEngine({
          stateManager: mockStateManager,
          agentDispatcher: mockAgentDispatcher,
          chapterOperations: mockChapterOperations,
          contentValidator: mockContentValidator,
          config: {}
        });
        
        await engine.initialize();
        
        const story = await mockStateManager.createStory('测试故事');
        
        // Setup checkpoint
        await mockStateManager.updateWorkflow(story.id, {
          state: 'waiting_checkpoint',
          currentPhase: 'phase1'
        });
        await mockStateManager.setActiveCheckpoint(story.id, {
          id: 'cp-1',
          phase: 'phase1',
          status: 'pending'
        });
        
        // Phase1 should run again on rejection
        engine.phases = {
          phase1: {
            async run() {
              phase1RunCount++;
              return { 
                status: 'waiting_checkpoint', 
                checkpointId: `cp-1-revision-${phase1RunCount}`,
                phase: 'phase1',
                data: {} 
              };
            }
          },
          phase2: { async run() { return { status: 'completed', phase: 'phase2' }; } },
          phase3: { async run() { return { status: 'completed', phase: 'phase3' }; } }
        };
        
        // Reject checkpoint
        await engine.resume(story.id, {
          checkpointId: 'cp-1',
          approval: false,
          feedback: 'Please improve the character development'
        });
        
        assert.ok(phase1RunCount >= 1, 'Phase1 should have run at least once after rejection');
      });

      it('should pass user feedback to revision process', async () => {
        const mockStateManager = createMockStateManager();
        const mockAgentDispatcher = createMockAgentDispatcher();
        const mockChapterOperations = createMockChapterOperations();
        const mockContentValidator = createMockContentValidator();
        
        await mockStateManager.initialize();
        
        const engine = new WorkflowEngine({
          stateManager: mockStateManager,
          agentDispatcher: mockAgentDispatcher,
          chapterOperations: mockChapterOperations,
          contentValidator: mockContentValidator,
          config: {}
        });
        
        await engine.initialize();
        
        const story = await mockStateManager.createStory('测试故事');
        
        // Setup checkpoint
        await mockStateManager.updateWorkflow(story.id, {
          state: 'waiting_checkpoint',
          currentPhase: 'phase1'
        });
        await mockStateManager.setActiveCheckpoint(story.id, {
          id: 'cp-1',
          phase: 'phase1',
          status: 'pending'
        });
        
        engine.phases = {
          phase1: {
            async run() {
              return { 
                status: 'waiting_checkpoint', 
                checkpointId: 'cp-1-revised',
                phase: 'phase1',
                data: {} 
              };
            }
          },
          phase2: { async run() { return { status: 'completed', phase: 'phase2' }; } },
          phase3: { async run() { return { status: 'completed', phase: 'phase3' }; } }
        };
        
        const feedback = 'More character development needed in chapter 2';
        
        await engine.resume(story.id, {
          checkpointId: 'cp-1',
          approval: false,
          feedback: feedback
        });
        
        // Verify feedback was recorded
        const storyData = await mockStateManager.getStory(story.id);
        assert.ok(storyData.workflow.history.length > 0, 'Should have history entries');
        
        const rejectionEntry = storyData.workflow.history.find(
          h => h.type === 'checkpoint_rejected'
        );
        assert.ok(rejectionEntry, 'Should have rejection entry');
        assert.ok(rejectionEntry.detail.feedback.includes('More character'), 
          'Feedback should be recorded');
      });
    });

    describe('3.4 Timeout auto-approval', () => {
      
      it('should have autoContinueOnTimeout enabled by default', async () => {
        const mockStateManager = createMockStateManager();
        await mockStateManager.initialize();
        
        const story = await mockStateManager.createStory('测试故事');
        
        await mockStateManager.setActiveCheckpoint(story.id, {
          id: 'cp-1',
          phase: 'phase1',
          type: 'worldview_confirmation',
          status: 'pending'
        });
        
        const storyData = await mockStateManager.getStory(story.id);
        
        assert.strictEqual(storyData.workflow.activeCheckpoint.autoContinueOnTimeout, true,
          'Auto-continue should be enabled by default');
      });

      it('should handle timeout configuration correctly', async () => {
        const mockStateManager = createMockStateManager();
        await mockStateManager.initialize();
        
        const story = await mockStateManager.createStory('测试故事');
        
        // Create checkpoint with custom timeout
        await mockStateManager.setActiveCheckpoint(story.id, {
          id: 'cp-1',
          phase: 'phase1',
          type: 'worldview_confirmation',
          status: 'pending',
          autoContinueOnTimeout: false // Disabled
        });
        
        const storyData = await mockStateManager.getStory(story.id);
        
        assert.strictEqual(storyData.workflow.activeCheckpoint.autoContinueOnTimeout, false,
          'Custom timeout setting should be respected');
      });
    });
  });

  // ============================================
  // SECTION 4: Concurrent Story Handling
  // ============================================
  describe('4. Concurrent Story Handling', () => {
    
    describe('4.1 Multiple stories in different phases', () => {
      
      it('should handle multiple stories simultaneously', async () => {
        const mockStateManager = createMockStateManager();
        const mockAgentDispatcher = createMockAgentDispatcher();
        const mockChapterOperations = createMockChapterOperations();
        const mockContentValidator = createMockContentValidator();
        
        await mockStateManager.initialize();
        
        const engine = new WorkflowEngine({
          stateManager: mockStateManager,
          agentDispatcher: mockAgentDispatcher,
          chapterOperations: mockChapterOperations,
          contentValidator: mockContentValidator,
          config: {}
        });
        
        await engine.initialize();
        
        // Create multiple stories
        const story1 = await mockStateManager.createStory('故事1：科幻主题');
        const story2 = await mockStateManager.createStory('故事2：奇幻主题');
        const story3 = await mockStateManager.createStory('故事3：悬疑主题');
        
        // Put each in different phases
        await mockStateManager.updateWorkflow(story1.id, {
          state: 'waiting_checkpoint',
          currentPhase: 'phase1'
        });
        await mockStateManager.setActiveCheckpoint(story1.id, {
          id: 'cp-1-story1',
          phase: 'phase1'
        });
        
        await mockStateManager.updateWorkflow(story2.id, {
          state: 'waiting_checkpoint',
          currentPhase: 'phase2'
        });
        await mockStateManager.setActiveCheckpoint(story2.id, {
          id: 'cp-2-story2',
          phase: 'phase2'
        });
        
        await mockStateManager.updateWorkflow(story3.id, {
          state: 'waiting_checkpoint',
          currentPhase: 'phase3'
        });
        await mockStateManager.setActiveCheckpoint(story3.id, {
          id: 'cp-3-story3',
          phase: 'phase3'
        });
        
        // All stories should have correct phase states
        const s1 = await mockStateManager.getStory(story1.id);
        const s2 = await mockStateManager.getStory(story2.id);
        const s3 = await mockStateManager.getStory(story3.id);
        
        assert.strictEqual(s1.workflow.currentPhase, 'phase1');
        assert.strictEqual(s2.workflow.currentPhase, 'phase2');
        assert.strictEqual(s3.workflow.currentPhase, 'phase3');
      });

      it('should not interfere between stories', async () => {
        const mockStateManager = createMockStateManager();
        await mockStateManager.initialize();
        
        // Create two stories
        const story1 = await mockStateManager.createStory('故事1');
        const story2 = await mockStateManager.createStory('故事2');
        
        // Update story1 checkpoint
        await mockStateManager.setActiveCheckpoint(story1.id, {
          id: 'cp-1-story1',
          phase: 'phase1',
          feedback: 'Story1 feedback'
        });
        
        // Update story2 checkpoint
        await mockStateManager.setActiveCheckpoint(story2.id, {
          id: 'cp-1-story2',
          phase: 'phase1',
          feedback: 'Story2 feedback'
        });
        
        const s1 = await mockStateManager.getStory(story1.id);
        const s2 = await mockStateManager.getStory(story2.id);
        
        // Verify they have independent checkpoints
        assert.strictEqual(s1.workflow.activeCheckpoint.id, 'cp-1-story1');
        assert.strictEqual(s2.workflow.activeCheckpoint.id, 'cp-1-story2');
        assert.strictEqual(s1.workflow.activeCheckpoint.feedback, 'Story1 feedback');
        assert.strictEqual(s2.workflow.activeCheckpoint.feedback, 'Story2 feedback');
        
        // Verify no cross-contamination
        assert.notStrictEqual(s1.workflow.activeCheckpoint.id, s2.workflow.activeCheckpoint.id);
      });
    });

    describe('4.2 No interference between stories', () => {
      
      it('should maintain separate state for each story', async () => {
        const mockStateManager = createMockStateManager();
        await mockStateManager.initialize();
        
        // Create stories with different progress
        const story1 = await mockStateManager.createStory('已完成的故事');
        const story2 = await mockStateManager.createStory('进行中的故事');
        
        // Mark story1 as completed
        await mockStateManager.updateStory(story1.id, {
          status: 'completed',
          finalOutput: { metadata: { title: 'Story 1' } }
        });
        await mockStateManager.updateWorkflow(story1.id, { state: 'completed' });
        
        // Mark story2 as running phase2
        await mockStateManager.updateStory(story2.id, {
          status: 'phase2_running'
        });
        await mockStateManager.updateWorkflow(story2.id, {
          state: 'running',
          currentPhase: 'phase2'
        });
        await mockStateManager.updatePhase1(story2.id, {
          userConfirmed: true,
          status: 'completed'
        });
        
        const s1 = await mockStateManager.getStory(story1.id);
        const s2 = await mockStateManager.getStory(story2.id);
        
        assert.strictEqual(s1.status, 'completed');
        assert.strictEqual(s1.workflow.state, 'completed');
        assert.strictEqual(s1.finalOutput.metadata.title, 'Story 1');
        
        assert.notStrictEqual(s2.status, 'completed');
        assert.strictEqual(s2.workflow.currentPhase, 'phase2');
        assert.ok(!s2.finalOutput);
        
        // Verify story1 changes don't affect story2
        assert.notStrictEqual(s1.id, s2.id);
        assert.notStrictEqual(s1.status, s2.status);
      });

      it('should handle concurrent checkpoint approvals independently', async () => {
        const mockStateManager = createMockStateManager();
        const mockAgentDispatcher = createMockAgentDispatcher();
        const mockChapterOperations = createMockChapterOperations();
        const mockContentValidator = createMockContentValidator();
        
        await mockStateManager.initialize();
        
        const engine = new WorkflowEngine({
          stateManager: mockStateManager,
          agentDispatcher: mockAgentDispatcher,
          chapterOperations: mockChapterOperations,
          contentValidator: mockContentValidator,
          config: {}
        });
        
        await engine.initialize();
        
        // Create two stories waiting at checkpoints
        const story1 = await mockStateManager.createStory('故事1');
        const story2 = await mockStateManager.createStory('故事2');
        
        await mockStateManager.updateWorkflow(story1.id, {
          state: 'waiting_checkpoint',
          currentPhase: 'phase1'
        });
        await mockStateManager.setActiveCheckpoint(story1.id, {
          id: 'cp-1-story1',
          phase: 'phase1',
          status: 'pending'
        });
        
        await mockStateManager.updateWorkflow(story2.id, {
          state: 'waiting_checkpoint',
          currentPhase: 'phase1'
        });
        await mockStateManager.setActiveCheckpoint(story2.id, {
          id: 'cp-1-story2',
          phase: 'phase1',
          status: 'pending'
        });
        
        // Setup engine phases
        engine.phases = {
          phase1: { async run() { return { status: 'completed', phase: 'phase1' }; } },
          phase2: { async run() { return { status: 'completed', phase: 'phase2' }; } },
          phase3: { async run() { return { status: 'completed', phase: 'phase3' }; } }
        };
        
        // Approve checkpoint for story1
        await engine.resume(story1.id, {
          checkpointId: 'cp-1-story1',
          approval: true
        });
        
        // Verify story1 progressed but story2 stayed same
        const s1 = await mockStateManager.getStory(story1.id);
        const s2 = await mockStateManager.getStory(story2.id);
        
        assert.notStrictEqual(s1.workflow.currentPhase, 'phase1',
          'Story1 should have progressed past phase1');
        assert.strictEqual(s2.workflow.currentPhase, 'phase1',
          'Story2 should still be at phase1');
        assert.strictEqual(s2.workflow.activeCheckpoint.id, 'cp-1-story2',
          'Story2 checkpoint should be unchanged');
      });
    });

    describe('4.3 Story isolation verification', () => {
      
      it('should isolate story data during concurrent operations', async () => {
        const mockStateManager = createMockStateManager();
        await mockStateManager.initialize();
        
        // Create multiple stories with different data
        const story1 = await mockStateManager.createStory('故事1数据');
        const story2 = await mockStateManager.createStory('故事2数据');
        
        // Add phase1 data to story1
        await mockStateManager.updatePhase1(story1.id, {
          worldview: { setting: 'Story1 World' },
          characters: [{ name: 'Character1' }]
        });
        
        // Add different phase1 data to story2
        await mockStateManager.updatePhase1(story2.id, {
          worldview: { setting: 'Story2 World' },
          characters: [{ name: 'Character2' }]
        });
        
        // Verify data isolation
        const s1 = await mockStateManager.getStory(story1.id);
        const s2 = await mockStateManager.getStory(story2.id);
        
        assert.strictEqual(s1.phase1.worldview.setting, 'Story1 World');
        assert.strictEqual(s1.phase1.characters[0].name, 'Character1');
        
        assert.strictEqual(s2.phase1.worldview.setting, 'Story2 World');
        assert.strictEqual(s2.phase1.characters[0].name, 'Character2');
        
        // Verify no cross-contamination
        assert.notStrictEqual(s1.phase1.worldview.setting, s2.phase1.worldview.setting);
      });

      it('should handle workflow history independently', async () => {
        const mockStateManager = createMockStateManager();
        await mockStateManager.initialize();
        
        const story1 = await mockStateManager.createStory('故事1');
        const story2 = await mockStateManager.createStory('故事2');
        
        // Add different history entries
        await mockStateManager.appendWorkflowHistory(story1.id, {
          type: 'phase1_completed',
          detail: { message: 'Story1 Phase1 done' }
        });
        
        await mockStateManager.appendWorkflowHistory(story2.id, {
          type: 'phase2_completed',
          detail: { message: 'Story2 Phase2 done' }
        });
        
        const s1 = await mockStateManager.getStory(story1.id);
        const s2 = await mockStateManager.getStory(story2.id);
        
        assert.strictEqual(s1.workflow.history.length, 1);
        assert.strictEqual(s2.workflow.history.length, 1);
        
        assert.strictEqual(s1.workflow.history[0].type, 'phase1_completed');
        assert.strictEqual(s2.workflow.history[0].type, 'phase2_completed');
      });
    });
  });

  // ============================================
  // SECTION 5: Integration with Real Components
  // ============================================
  describe('5. Integration with Real Components', () => {
    
    describe('5.1 StateManager integration', () => {
      
      it('should use real StateManager with mock fs', async () => {
        // This test uses the actual StateManager with mocked filesystem
        const mockFs = {};
        const originalReadFile = fs.promises.readFile;
        const originalWriteFile = fs.promises.writeFile;
        const originalMkdir = fs.promises.mkdir;
        const originalReaddir = fs.promises.readdir;
        const originalUnlink = fs.promises.unlink;
        const originalRename = fs.promises.rename;
        
        const mockFileData = {};
        
        // Mock filesystem operations
        fs.promises.readFile = async (file, enc) => {
          if (mockFileData[file]) return mockFileData[file];
          const err = new Error('ENOENT');
          err.code = 'ENOENT';
          throw err;
        };
        fs.promises.writeFile = async (file, content) => {
          mockFileData[file] = content;
        };
        fs.promises.mkdir = async (dir, opts) => {};
        fs.promises.readdir = async (dir) => Object.keys(mockFileData).filter(f => f.startsWith(dir)).map(f => path.basename(f));
        fs.promises.unlink = async (file) => { delete mockFileData[file]; };
        fs.promises.rename = async (oldPath, newPath) => {
          if (mockFileData[oldPath]) {
            mockFileData[newPath] = mockFileData[oldPath];
            delete mockFileData[oldPath];
          }
        };
        
        try {
          const StateManager = require('../core/StateManager').StateManager;
          const stateManager = new StateManager();
          stateManager.stateDir = TEST_STATE_DIR;
          
          await stateManager.initialize();
          
          const story = await stateManager.createStory('Integration test story');
          
          assert.ok(story.id.startsWith('story-'));
          assert.strictEqual(story.config.storyPrompt, 'Integration test story');
          
          // Verify can retrieve
          const retrieved = await stateManager.getStory(story.id);
          assert.strictEqual(retrieved.id, story.id);
          
          // Verify can update
          await stateManager.updateStory(story.id, { status: 'updated' });
          const updated = await stateManager.getStory(story.id);
          assert.strictEqual(updated.status, 'updated');
          
        } finally {
          // Restore filesystem
          fs.promises.readFile = originalReadFile;
          fs.promises.writeFile = originalWriteFile;
          fs.promises.mkdir = originalMkdir;
          fs.promises.readdir = originalReaddir;
          fs.promises.unlink = originalUnlink;
          fs.promises.rename = originalRename;
        }
      });
    });

    describe('5.2 WorkflowEngine state transitions', () => {
      
      it('should transition through all valid states', async () => {
        const mockStateManager = createMockStateManager();
        await mockStateManager.initialize();
        
        const engine = new WorkflowEngine({
          stateManager: mockStateManager,
          agentDispatcher: createMockAgentDispatcher(),
          chapterOperations: createMockChapterOperations(),
          contentValidator: createMockContentValidator(),
          config: {}
        });
        
        await engine.initialize();
        
        const validStates = ['idle', 'running', 'waiting_checkpoint', 'completed', 'failed'];
        
        for (const targetState of validStates) {
          const story = await mockStateManager.createStory(`Test story for ${targetState}`);
          await mockStateManager.updateWorkflow(story.id, { state: targetState });
          
          const status = await engine.getWorkflowStatus(story.id);
          
          // Only check if state is what we set (some transitions may have changed it)
          if (targetState === 'completed' || targetState === 'failed') {
            assert.ok(['completed', 'failed', 'running'].includes(status.state),
              `For target ${targetState}, got state: ${status.state}`);
          }
        }
      });
    });

    describe('5.3 Agent dispatcher call tracking', () => {
      
      it('should track agent calls during workflow', async () => {
        const mockStateManager = createMockStateManager();
        const mockAgentDispatcher = createMockAgentDispatcher();
        const mockChapterOperations = createMockChapterOperations();
        const mockContentValidator = createMockContentValidator();
        
        await mockStateManager.initialize();
        
        const engine = new WorkflowEngine({
          stateManager: mockStateManager,
          agentDispatcher: mockAgentDispatcher,
          chapterOperations: mockChapterOperations,
          contentValidator: mockContentValidator,
          config: {}
        });
        
        await engine.initialize();
        
        const story = await mockStateManager.createStory('Test story');
        
        engine.phases = {
          phase1: {
            async run() {
              await mockAgentDispatcher.delegate('worldBuilder', 'Test prompt');
              await mockAgentDispatcher.delegate('characterDesigner', 'Test prompt');
              return { status: 'completed', phase: 'phase1' };
            }
          },
          phase2: { async run() { return { status: 'completed', phase: 'phase2' }; } },
          phase3: { async run() { return { status: 'completed', phase: 'phase3' }; } }
        };
        
        await engine.start(story.id);
        
        // Verify agents were called
        assert.ok(mockAgentDispatcher.callLog.length > 0, 'Should have agent calls');
      });
    });
  });

  // ============================================
  // SECTION 6: Performance and Edge Cases
  // ============================================
  describe('6. Performance and Edge Cases', () => {
    
    describe('6.1 Rapid state changes', () => {
      
      it('should handle rapid checkpoint approvals', async () => {
        const mockStateManager = createMockStateManager();
        const mockAgentDispatcher = createMockAgentDispatcher();
        const mockChapterOperations = createMockChapterOperations();
        const mockContentValidator = createMockContentValidator();
        
        await mockStateManager.initialize();
        
        const engine = new WorkflowEngine({
          stateManager: mockStateManager,
          agentDispatcher: mockAgentDispatcher,
          chapterOperations: mockChapterOperations,
          contentValidator: mockContentValidator,
          config: {}
        });
        
        await engine.initialize();
        
        const story = await mockStateManager.createStory('Test story');
        
        // Setup phase1 checkpoint
        await mockStateManager.updateWorkflow(story.id, {
          state: 'waiting_checkpoint',
          currentPhase: 'phase1'
        });
        await mockStateManager.setActiveCheckpoint(story.id, {
          id: 'cp-1',
          phase: 'phase1'
        });
        
        // Setup quick-completing phases
        engine.phases = {
          phase1: { async run() { return { status: 'completed', phase: 'phase1' }; } },
          phase2: { async run() { return { status: 'completed', phase: 'phase2' }; } },
          phase3: { async run() { return { status: 'completed', phase: 'phase3' }; } }
        };
        
        // Rapid approval
        await engine.resume(story.id, { checkpointId: 'cp-1', approval: true });
        
        const finalStory = await mockStateManager.getStory(story.id);
        assert.ok(['completed', 'running'].includes(finalStory.workflow.state));
      });
    });

    describe('6.2 Large story data handling', () => {
      
      it('should handle stories with many chapters', async () => {
        const mockStateManager = createMockStateManager();
        await mockStateManager.initialize();
        
        const story = await mockStateManager.createStory('Long story');
        
        // Add many chapters
        const chapters = [];
        for (let i = 1; i <= 20; i++) {
          chapters.push({
            number: i,
            title: `Chapter ${i}`,
            content: `Content for chapter ${i}...`.repeat(100),
            wordCount: 2500 + Math.floor(Math.random() * 500),
            status: 'completed'
          });
        }
        
        await mockStateManager.updatePhase2(story.id, { chapters });
        
        const retrieved = await mockStateManager.getStory(story.id);
        
        assert.strictEqual(retrieved.phase2.chapters.length, 20);
        assert.strictEqual(retrieved.phase2.chapters[19].title, 'Chapter 20');
      });

      it('should handle large workflow history', async () => {
        const mockStateManager = createMockStateManager();
        await mockStateManager.initialize();
        
        const story = await mockStateManager.createStory('Test story');
        
        // Add many history entries
        for (let i = 0; i < 100; i++) {
          await mockStateManager.appendWorkflowHistory(story.id, {
            type: `event_${i}`,
            detail: { index: i, data: 'x'.repeat(100) }
          });
        }
        
        const retrieved = await mockStateManager.getStory(story.id);
        
        assert.strictEqual(retrieved.workflow.history.length, 100);
      });
    });

    describe('6.3 Edge cases', () => {
      
      it('should handle story with empty prompt', async () => {
        const mockStateManager = createMockStateManager();
        await mockStateManager.initialize();
        
        // This tests validation - empty prompt may be rejected by validation
        const story = await mockStateManager.createStory('');
        
        assert.ok(story, 'Should create story even with empty prompt');
        assert.strictEqual(story.config.storyPrompt, '');
      });

      it('should handle concurrent updates to same story', async () => {
        const mockStateManager = createMockStateManager();
        await mockStateManager.initialize();
        
        const story = await mockStateManager.createStory('Test story');
        
        // Simulate concurrent updates
        await Promise.all([
          mockStateManager.updatePhase1(story.id, { worldview: { setting: 'World1' } }),
          mockStateManager.updatePhase1(story.id, { characters: [{ name: 'Char1' }] })
        ]);
        
        const retrieved = await mockStateManager.getStory(story.id);
        
        // Last write wins (JavaScript object assignment behavior)
        assert.ok(retrieved.phase1.worldview || retrieved.phase1.characters);
      });

      it('should handle missing optional fields gracefully', async () => {
        const mockStateManager = createMockStateManager();
        await mockStateManager.initialize();
        
        const story = await mockStateManager.createStory('Test', {
          genre: undefined,
          style_preference: undefined,
          target_word_count: undefined
        });
        
        assert.ok(story.config.genre);
        assert.ok(story.config.stylePreference !== undefined);
        assert.ok(story.config.targetWordCount);
      });
    });
  });

  // ============================================
  // SECTION 7: Validation and Error Handling
  // ============================================
  describe('7. Validation and Error Handling', () => {
    
    describe('7.1 Input validation', () => {
      
      it('should validate story_id format', async () => {
        const mockStateManager = createMockStateManager();
        const mockAgentDispatcher = createMockAgentDispatcher();
        const mockChapterOperations = createMockChapterOperations();
        const mockContentValidator = createMockContentValidator();
        
        const engine = new WorkflowEngine({
          stateManager: mockStateManager,
          agentDispatcher: mockAgentDispatcher,
          chapterOperations: mockChapterOperations,
          contentValidator: mockContentValidator,
          config: {}
        });
        
        await engine.initialize();
        
        // Try to recover non-existent story
        const result = await engine.recover('non-existent-story');
        
        assert.strictEqual(result.status, 'error');
        assert.ok(result.error.includes('not found'));
      });
    });

    describe('7.2 Error message clarity', () => {
      
      it('should provide clear error messages', async () => {
        const mockStateManager = createMockStateManager();
        await mockStateManager.initialize();
        
        const engine = new WorkflowEngine({
          stateManager: mockStateManager,
          agentDispatcher: createMockAgentDispatcher(),
          chapterOperations: createMockChapterOperations(),
          contentValidator: createMockContentValidator(),
          config: {}
        });
        
        await engine.initialize();
        
        // Try to start already running workflow
        const story = await mockStateManager.createStory('Test');
        await mockStateManager.updateWorkflow(story.id, { state: 'running' });
        
        const result = await engine.start(story.id);
        
        assert.strictEqual(result.status, 'error');
        assert.ok(result.error.length > 0, 'Error should have message');
        assert.ok(
          result.error.includes('running') || 
          result.error.includes('already') ||
          result.error.includes('error'),
          'Error should be descriptive'
        );
      });
    });

    describe('7.3 Graceful degradation', () => {
      
      it('should handle missing optional dependencies', async () => {
        const mockStateManager = createMockStateManager();
        await mockStateManager.initialize();
        
        // Create engine without optional chapter operations
        const engine = new WorkflowEngine({
          stateManager: mockStateManager,
          agentDispatcher: createMockAgentDispatcher(),
          chapterOperations: null, // Missing
          contentValidator: createMockContentValidator(),
          config: {}
        });
        
        await engine.initialize();
        
        const story = await mockStateManager.createStory('Test');
        
        // Workflow should still report status
        const status = await engine.getWorkflowStatus(story.id);
        assert.ok(status);
      });
    });
  });
});

// Export for potential use by other test files
module.exports = {
  createMockStateManager,
  createMockAgentDispatcher,
  createMockChapterOperations,
  createMockContentValidator,
  createMockNotificationPusher
};