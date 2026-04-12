'use strict';

const { describe, it, before, after, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');
const os = require('os');

const TEST_STATE_DIR = path.join(os.tmpdir(), `story-orchestrator-plugin-test-${Date.now()}`);
const agentCallLog = [];
const testStories = new Map();
const notifications = [];

function createMockAgentDispatcher() {
  return {
    async initialize() { return Promise.resolve(); },

    async delegate(agentType, prompt, options = {}) {
      agentCallLog.push({ agentType, prompt: prompt.substring(0, 200), options, timestamp: Date.now() });
      
      const responses = {
        worldBuilder: { content: JSON.stringify({ setting: '未来地球公元2150年', rules: { physical: '星际旅行' }, factions: [{ name: '地球联邦' }], history: { keyEvents: ['火星独立战争'] }, sceneNorms: ['高科技感'], secrets: ['AI正在觉醒'] }) },
        characterDesigner: { content: JSON.stringify({ protagonists: [{ name: '林博士', identity: 'AI研究员', personality: ['理性'], background: '火星出生', motivation: '解开AI意识之谜', innerConflict: '人类与AI的界限', growthArc: '从学者到守护者' }], supportingCharacters: [{ name: '小柒', identity: '家用机器人' }], relationshipNetwork: { direct: [], hidden: [] }, oocRules: {} }) },
        plotArchitect: { content: '第1章：火星黎明\n核心事件：林博士发现AI异常' },
        logicValidator: { content: '【验证结论】\n通过\n\n【问题清单】\n无' },
        chapterWriter: { content: '这是第一章的详细内容。林博士站在火星研究所的观景窗前...' },
        detailFiller: { content: '【细节填充完成】\n\n场景描写已增强...' },
        stylePolisher: { content: '【润色后】\n\n林博士静静地伫立于火星研究所...' },
        finalEditor: { content: '【终校定稿】\n\n全文已完成终校校稿，符合出版标准。\n\n——故事创作完成——' }
      };
      
      const response = responses[agentType] || { content: `Mock response for ${agentType}` };
      return { ...response, raw: {}, markers: {} };
    },

    async delegateParallel(tasks) {
      const results = await Promise.all(tasks.map(async (task) => {
        try {
          const result = await this.delegate(task.agentType, task.prompt, task.options);
          return { status: 'fulfilled', agentType: task.agentType, result };
        } catch (error) {
          return { status: 'rejected', agentType: task.agentType, error: error.message };
        }
      }));
      return { succeeded: results.filter(r => r.status === 'fulfilled'), failed: results.filter(r => r.status === 'rejected') };
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

    clearLog() { agentCallLog.length = 0; }
  };
}

function createMockStateManager() {
  const cache = new Map();
  
  return {
    initialized: false,
    cache,
    stateDir: TEST_STATE_DIR,
    
    async initialize() { this.initialized = true; return Promise.resolve(); },
    generateStoryId() { 
      const uuid = 'xxxxxxxxxxxx'.replace(/x/g, () => (Math.random() * 16 | 0).toString(16));
      return `story-${uuid}`;
    },
    getStatePath(storyId) { return path.join(TEST_STATE_DIR, `${storyId}.json`); },

    async createStory(storyPrompt, config = {}) {
      const storyId = this.generateStoryId();
      const now = new Date().toISOString();
      
      const story = {
        id: storyId,
        status: 'idle',
        createdAt: now,
        updatedAt: now,
        config: {
          targetWordCount: config.target_word_count || { min: 2500, max: 3500 },
          genre: config.genre || 'general',
          stylePreference: config.style_preference || '',
          storyPrompt: storyPrompt
        },
        phase1: { worldview: null, characters: [], validation: null, userConfirmed: false, checkpointId: null, status: 'pending' },
        phase2: { outline: null, chapters: [], currentChapter: 0, userConfirmed: false, checkpointId: null, status: 'pending' },
        phase3: { polishedChapters: [], finalValidation: null, iterationCount: 0, userConfirmed: false, checkpointId: null, status: 'pending', qualityScores: [] },
        finalOutput: null,
        workflow: {
          state: 'idle',
          currentPhase: null,
          currentStep: null,
          activeCheckpoint: null,
          retryContext: { phase: null, step: null, attempt: 0, maxAttempts: 3, lastError: null },
          history: [],
          runToken: null
        }
      };
      
      cache.set(storyId, story);
      testStories.set(storyId, story);
      return story;
    },

    async getStory(storyId) {
      if (cache.has(storyId)) return cache.get(storyId);
      return testStories.get(storyId) || null;
    },

    async updateStory(storyId, updates) {
      const story = await this.getStory(storyId);
      if (!story) throw new Error(`Story not found: ${storyId}`);
      Object.assign(story, updates, { updatedAt: new Date().toISOString() });
      cache.set(storyId, story);
      testStories.set(storyId, story);
      return story;
    },

    async updatePhase1(storyId, updates) {
      const story = await this.getStory(storyId);
      if (!story) throw new Error(`Story not found: ${storyId}`);
      story.phase1 = { ...story.phase1, ...updates };
      return this.updateStory(storyId, story);
    },

    async updatePhase2(storyId, updates) {
      const story = await this.getStory(storyId);
      if (!story) throw new Error(`Story not found: ${storyId}`);
      story.phase2 = { ...story.phase2, ...updates };
      return this.updateStory(storyId, story);
    },

    async updatePhase3(storyId, updates) {
      const story = await this.getStory(storyId);
      if (!story) throw new Error(`Story not found: ${storyId}`);
      story.phase3 = { ...story.phase3, ...updates };
      return this.updateStory(storyId, story);
    },

    async updateWorkflow(storyId, updates) {
      const story = await this.getStory(storyId);
      if (!story) throw new Error(`Story not found: ${storyId}`);
      
      if (!story.workflow) {
        story.workflow = { state: 'idle', currentPhase: null, currentStep: null, activeCheckpoint: null, retryContext: { phase: null, step: null, attempt: 0, maxAttempts: 3, lastError: null }, history: [], runToken: null };
      }
      
      if (updates.retryContext !== undefined) {
        story.workflow.retryContext = { ...story.workflow.retryContext, ...updates.retryContext };
      }
      
      Object.assign(story.workflow, updates);
      cache.set(storyId, story);
      testStories.set(storyId, story);
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
      return this.updateStory(storyId, story);
    },

    async clearActiveCheckpoint(storyId) {
      const story = await this.getStory(storyId);
      if (!story) throw new Error(`Story not found: ${storyId}`);
      if (story.workflow) story.workflow.activeCheckpoint = null;
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
        story[phaseName].userConfirmed = true;
      }
      
      if (story.workflow) {
        story.workflow.history.push({ at: now, type: 'checkpoint_resolved', phase: phaseName, step: story.workflow.currentStep, detail: { feedback, checkpointId: story.workflow.activeCheckpoint?.id } });
      }
      
      return this.updateStory(storyId, story);
    },

    async upsertChapter(storyId, chapterData) {
      const story = await this.getStory(storyId);
      if (!story) throw new Error(`Story not found: ${storyId}`);
      
      if (!story.phase2) story.phase2 = { outline: null, chapters: [], currentChapter: 0, userConfirmed: false, checkpointId: null, status: 'pending' };
      if (!story.phase2.chapters) story.phase2.chapters = [];
      
      const chapterNumber = chapterData.number;
      const index = chapterNumber - 1;
      const now = new Date().toISOString();
      
      const baseChapter = { number: chapterNumber, title: '', content: '', wordCount: 0, status: 'draft', createdAt: now, updatedAt: now, ...chapterData };
      
      if (index >= 0 && index < story.phase2.chapters.length) {
        story.phase2.chapters[index] = { ...story.phase2.chapters[index], ...baseChapter, updatedAt: now };
      } else if (index === story.phase2.chapters.length) {
        story.phase2.chapters.push(baseChapter);
      } else {
        while (story.phase2.chapters.length < index) {
          story.phase2.chapters.push({ number: story.phase2.chapters.length + 1, title: '', content: '', wordCount: 0, status: 'empty', createdAt: now, updatedAt: now });
        }
        story.phase2.chapters.push(baseChapter);
      }
      
      return this.updateStory(storyId, story);
    },

    async deleteStory(storyId) { cache.delete(storyId); testStories.delete(storyId); return true; },
    getConfig(storyId) { const story = cache.get(storyId); return story?.config || null; },
    getStoryBible(storyId) { const story = cache.get(storyId); if (!story || !story.phase1) return null; return { worldview: story.phase1.worldview, characters: story.phase1.characters, plotSummary: story.phase2?.outline }; },
    async listStories() { return Array.from(testStories.keys()); },
    async cleanupExpired() { return 0; },
    clearAll() { cache.clear(); testStories.clear(); agentCallLog.length = 0; notifications.length = 0; }
  };
}

function createTestableStoryOrchestrator() {
  const StoryOrchestrator = require('../core/StoryOrchestrator');
  const orchestrator = Object.create(StoryOrchestrator);
  
  orchestrator.stateManager = createMockStateManager();
  orchestrator.agentDispatcher = createMockAgentDispatcher();
  orchestrator.textMetrics = require('../utils/TextMetrics');
  orchestrator.chapterOperations = createMockChapterOperations();
  orchestrator.contentValidator = createMockContentValidator();
  orchestrator.globalConfig = { MAX_PHASE_RETRY_ATTEMPTS: 3, USER_CHECKPOINT_TIMEOUT_MS: 86400000 };
  
  return orchestrator;
}

function createMockChapterOperations() {
  return {
    async createChapterDraft(storyId, chapterNumber, options = {}) {
      return { content: `第${chapterNumber}章内容。这是一个测试章节的详细内容，包含足够多的文字来模拟真实的写作过程。`.repeat(20), metrics: { counts: { actualCount: 2800, chineseChars: 2800 } }, wasExpanded: false };
    },
    async fillDetails(storyId, chapterNum, content, options = {}) { return { detailedContent: content + '\n\n【细节填充】...', improvements: ['场景更生动'] }; },
    async reviewChapter(storyId, chapterNum, content, options = {}) { return { verdict: 'passed', severity: 'minor', issues: [], suggestions: [] }; },
    async reviseChapter(storyId, chapterNum, content, options = {}) { return { revisedContent: content + '\n\n【修订】...', revisionCount: 1 }; },
    async polishChapter(storyId, chapterNum, content, options = {}) { return { polishedContent: content + '\n\n【润色】...', improvements: ['语言更精炼'], metrics: { counts: { actualCount: 2850, chineseChars: 2850 } } }; },
    countChapterLength(content, targetMin, targetMax, options = {}) {
      const chineseChars = content.replace(/[^\u4e00-\u9fa5]/g, '').length;
      const nonWhitespace = content.replace(/\s/g, '').length;
      return { counts: { actualCount: chineseChars, chineseChars, nonWhitespaceChars: nonWhitespace, paragraphCount: 5 }, validation: { isQualified: chineseChars >= targetMin, rangeStatus: chineseChars < targetMin ? 'below_min' : chineseChars > targetMax ? 'above_max' : 'within_range', deficit: chineseChars < targetMin ? targetMin - chineseChars : 0 } };
    }
  };
}

function createMockContentValidator() {
  return {
    async validateWorldview(storyId, content, storyBible) { return { passed: true, issues: [] }; },
    async validateCharacters(storyId, content, storyBible) { return { passed: true, issues: [] }; },
    async validatePlot(storyId, content, storyBible) { return { passed: true, issues: [] }; },
    async comprehensiveValidation(storyId, chapterNum, content, storyBible, previousChapters = []) {
      return { overall: { passed: true, hasCriticalIssues: false, criticalCount: 0 }, allIssues: [], chapterIssues: {}, worldbuildingConsistency: true, characterConsistency: true, plotContinuity: true };
    },
    async qualityScore(content) { return { average: 8.5, scores: { logicConsistency: 8.0, writingExpression: 8.5, sceneDescription: 8.0, characterConsistency: 9.0, overallReadability: 8.5 }, rawReport: '质量评分报告' }; }
  };
}

let WorkflowEngine;

describe('StoryOrchestrator Plugin Integration Tests', () => {
  
  before(async () => {
    await fs.promises.mkdir(TEST_STATE_DIR, { recursive: true });
    delete require.cache[require.resolve('../core/WorkflowEngine')];
    delete require.cache[require.resolve('../core/StoryOrchestrator')];
    WorkflowEngine = require('../core/WorkflowEngine').WorkflowEngine;
  });

  after(async () => {
    try { await fs.promises.rm(TEST_STATE_DIR, { recursive: true, force: true }); } catch (e) { console.log('Cleanup warning:', e.message); }
  });

  beforeEach(() => { testStories.clear(); agentCallLog.length = 0; notifications.length = 0; });

  describe('1. Command Interface Tests (processToolCall)', () => {
    
    describe('1.1 StartStoryProject Command', () => {
      
      it('should create story through processToolCall', async () => {
        const orchestrator = createTestableStoryOrchestrator();
        
        orchestrator.workflowEngine = new WorkflowEngine({
          stateManager: orchestrator.stateManager,
          agentDispatcher: orchestrator.agentDispatcher,
          chapterOperations: createMockChapterOperations(),
          contentValidator: createMockContentValidator(),
          config: orchestrator.globalConfig
        });
        await orchestrator.workflowEngine.initialize();
        
        const result = await orchestrator.processToolCall({
          command: 'StartStoryProject',
          story_prompt: '一个关于AI觉醒的科幻故事，主角是一个家用机器人',
          target_word_count: 3000,
          genre: '科幻',
          style_preference: '硬科幻风格'
        });
        
        assert.strictEqual(result.status, 'success');
        assert.ok(result.result);
        assert.ok(result.result.story_id);
        assert.ok(result.result.story_id.startsWith('story-'));
        
        const story = await orchestrator.stateManager.getStory(result.result.story_id);
        assert.ok(story);
        assert.strictEqual(story.config.storyPrompt, '一个关于AI觉醒的科幻故事，主角是一个家用机器人');
      });

      it('should reject invalid story_prompt through validation', async () => {
        const orchestrator = createTestableStoryOrchestrator();
        
        orchestrator.workflowEngine = new WorkflowEngine({
          stateManager: orchestrator.stateManager,
          agentDispatcher: orchestrator.agentDispatcher,
          chapterOperations: createMockChapterOperations(),
          contentValidator: createMockContentValidator(),
          config: orchestrator.globalConfig
        });
        await orchestrator.workflowEngine.initialize();
        
        const result = await orchestrator.processToolCall({ command: 'StartStoryProject', story_prompt: '太短' });
        
        assert.strictEqual(result.status, 'error');
        assert.ok(result.error && result.error.includes('story_prompt'));
      });
    });

    describe('1.2 QueryStoryStatus Command', () => {
      
      it('should return status through processToolCall', async () => {
        const orchestrator = createTestableStoryOrchestrator();
        
        orchestrator.workflowEngine = new WorkflowEngine({
          stateManager: orchestrator.stateManager,
          agentDispatcher: orchestrator.agentDispatcher,
          chapterOperations: createMockChapterOperations(),
          contentValidator: createMockContentValidator(),
          config: orchestrator.globalConfig
        });
        await orchestrator.workflowEngine.initialize();
        
        const createResult = await orchestrator.processToolCall({ command: 'StartStoryProject', story_prompt: '测试故事状态查询功能的项目足够长' });
        
        const statusResult = await orchestrator.processToolCall({ command: 'QueryStoryStatus', story_id: createResult.result.story_id });
        
        assert.strictEqual(statusResult.status, 'success');
        assert.ok(statusResult.result);
        assert.strictEqual(statusResult.result.story_id, createResult.result.story_id);
        assert.ok(typeof statusResult.result.phase === 'number');
        assert.ok(typeof statusResult.result.progress_percent === 'number');
        assert.ok(statusResult.result.workflow_state);
      });

      it('should return error for non-existent story', async () => {
        const orchestrator = createTestableStoryOrchestrator();
        
        orchestrator.workflowEngine = new WorkflowEngine({
          stateManager: orchestrator.stateManager,
          agentDispatcher: orchestrator.agentDispatcher,
          chapterOperations: createMockChapterOperations(),
          contentValidator: createMockContentValidator(),
          config: orchestrator.globalConfig
        });
        await orchestrator.workflowEngine.initialize();
        
        const result = await orchestrator.processToolCall({ command: 'QueryStoryStatus', story_id: 'non-existent-story' });
        
        assert.strictEqual(result.status, 'error');
        assert.ok(result.error);
      });
    });

    describe('1.3 UserConfirmCheckpoint Command', () => {
      
      it('should handle approval through processToolCall', async () => {
        const orchestrator = createTestableStoryOrchestrator();
        const mockStateManager = orchestrator.stateManager;
        
        orchestrator.workflowEngine = new WorkflowEngine({
          stateManager: mockStateManager,
          agentDispatcher: orchestrator.agentDispatcher,
          chapterOperations: createMockChapterOperations(),
          contentValidator: createMockContentValidator(),
          config: orchestrator.globalConfig
        });
        await orchestrator.workflowEngine.initialize();
        
        const story = await mockStateManager.createStory('测试故事');
        await mockStateManager.updateWorkflow(story.id, { state: 'waiting_checkpoint', currentPhase: 'phase1' });
        await mockStateManager.setActiveCheckpoint(story.id, { id: 'cp-1-worldview', phase: 'phase1', status: 'pending' });
        
        orchestrator.workflowEngine.phases = {
          phase1: { async run() { return { status: 'completed', phase: 'phase1' }; } },
          phase2: { async run() { return { status: 'completed', phase: 'phase2' }; } },
          phase3: { async run() { return { status: 'completed', phase: 'phase3' }; } }
        };
        
        const result = await orchestrator.processToolCall({
          command: 'UserConfirmCheckpoint',
          story_id: story.id,
          checkpoint_id: 'cp-1-worldview',
          approval: true,
          feedback: 'Looks great!'
        });
        
        assert.strictEqual(result.status, 'success');
      });

      it('should reject mismatched checkpoint_id', async () => {
        const orchestrator = createTestableStoryOrchestrator();
        const mockStateManager = orchestrator.stateManager;
        
        orchestrator.workflowEngine = new WorkflowEngine({
          stateManager: mockStateManager,
          agentDispatcher: orchestrator.agentDispatcher,
          chapterOperations: createMockChapterOperations(),
          contentValidator: createMockContentValidator(),
          config: orchestrator.globalConfig
        });
        await orchestrator.workflowEngine.initialize();
        
        const story = await mockStateManager.createStory('测试故事');
        await mockStateManager.updateWorkflow(story.id, { state: 'waiting_checkpoint', currentPhase: 'phase1' });
        await mockStateManager.setActiveCheckpoint(story.id, { id: 'cp-correct', phase: 'phase1', status: 'pending' });
        
        const result = await orchestrator.processToolCall({
          command: 'UserConfirmCheckpoint',
          story_id: story.id,
          checkpoint_id: 'cp-wrong',
          approval: true
        });
        
        assert.strictEqual(result.status, 'error');
        assert.ok(result.result?.error && result.result.error.includes('mismatch'));
      });
    });

    describe('1.4 RecoverStoryWorkflow Command', () => {
      
      it('should recover from running state', async () => {
        const orchestrator = createTestableStoryOrchestrator();
        const mockStateManager = orchestrator.stateManager;
        
        orchestrator.workflowEngine = new WorkflowEngine({
          stateManager: mockStateManager,
          agentDispatcher: orchestrator.agentDispatcher,
          chapterOperations: createMockChapterOperations(),
          contentValidator: createMockContentValidator(),
          config: orchestrator.globalConfig
        });
        await orchestrator.workflowEngine.initialize();
        
        const story = await mockStateManager.createStory('测试故事');
        await mockStateManager.updateWorkflow(story.id, { state: 'running', currentPhase: 'phase2' });
        
        orchestrator.workflowEngine.phases = {
          phase1: { async run() { throw new Error('Should not run'); } },
          phase2: { async run() { return { status: 'completed', phase: 'phase2' }; } },
          phase3: { async run() { return { status: 'completed', phase: 'phase3' }; } }
        };
        
        const result = await orchestrator.processToolCall({ command: 'RecoverStoryWorkflow', story_id: story.id, recovery_action: 'continue' });
        
        assert.strictEqual(result.status, 'success');
      });

      it('should handle already completed workflow', async () => {
        const orchestrator = createTestableStoryOrchestrator();
        const mockStateManager = orchestrator.stateManager;
        
        orchestrator.workflowEngine = new WorkflowEngine({
          stateManager: mockStateManager,
          agentDispatcher: orchestrator.agentDispatcher,
          chapterOperations: createMockChapterOperations(),
          contentValidator: createMockContentValidator(),
          config: orchestrator.globalConfig
        });
        await orchestrator.workflowEngine.initialize();
        
        const story = await mockStateManager.createStory('测试故事');
        await mockStateManager.updateWorkflow(story.id, { state: 'completed' });
        
        const result = await orchestrator.processToolCall({ command: 'RecoverStoryWorkflow', story_id: story.id });
        
        assert.strictEqual(result.status, 'success');
        assert.ok(result.result.message.includes('completed'));
      });
    });

    describe('1.5 RetryPhase Command', () => {
      
      it('should retry failed phase through processToolCall', async () => {
        const orchestrator = createTestableStoryOrchestrator();
        const mockStateManager = orchestrator.stateManager;
        
        orchestrator.workflowEngine = new WorkflowEngine({
          stateManager: mockStateManager,
          agentDispatcher: orchestrator.agentDispatcher,
          chapterOperations: createMockChapterOperations(),
          contentValidator: createMockContentValidator(),
          config: orchestrator.globalConfig
        });
        await orchestrator.workflowEngine.initialize();
        
        const story = await mockStateManager.createStory('测试故事');
        await mockStateManager.updateWorkflow(story.id, { state: 'failed', retryContext: { phase: 'phase1', attempt: 1, maxAttempts: 3, lastError: 'Previous failure' } });
        
        orchestrator.workflowEngine.phases = {
          phase1: { async run() { return { status: 'completed', phase: 'phase1' }; } },
          phase2: { async run() { return { status: 'completed', phase: 'phase2' }; } },
          phase3: { async run() { return { status: 'completed', phase: 'phase3' }; } }
        };
        
        const result = await orchestrator.processToolCall({ command: 'RetryPhase', story_id: story.id, phase_name: 'phase1', reason: 'Manual retry' });
        
        assert.strictEqual(result.status, 'success');
      });

      it('should reject invalid phase_name', async () => {
        const orchestrator = createTestableStoryOrchestrator();
        
        orchestrator.workflowEngine = new WorkflowEngine({
          stateManager: orchestrator.stateManager,
          agentDispatcher: orchestrator.agentDispatcher,
          chapterOperations: createMockChapterOperations(),
          contentValidator: createMockContentValidator(),
          config: orchestrator.globalConfig
        });
        await orchestrator.workflowEngine.initialize();
        
        const result = await orchestrator.processToolCall({ command: 'RetryPhase', story_id: 'story-123456789012', phase_name: 'invalid_phase' });
        
        assert.strictEqual(result.status, 'error');
        assert.ok(result.error);
      });

      it('should fail when max retry attempts exceeded', async () => {
        const orchestrator = createTestableStoryOrchestrator();
        const mockStateManager = orchestrator.stateManager;
        
        orchestrator.workflowEngine = new WorkflowEngine({
          stateManager: mockStateManager,
          agentDispatcher: orchestrator.agentDispatcher,
          chapterOperations: createMockChapterOperations(),
          contentValidator: createMockContentValidator(),
          config: { MAX_PHASE_RETRY_ATTEMPTS: 3 }
        });
        await orchestrator.workflowEngine.initialize();
        
        const story = await mockStateManager.createStory('测试故事');
        await mockStateManager.updateWorkflow(story.id, { state: 'failed', retryContext: { phase: 'phase1', attempt: 3, maxAttempts: 3, lastError: 'Max retries exceeded' } });
        
        const result = await orchestrator.processToolCall({ command: 'RetryPhase', story_id: story.id, phase_name: 'phase1', reason: 'Another attempt' });
        
        assert.strictEqual(result.status, 'error');
        assert.ok(result.error && (result.error.includes('Max') || result.error.includes('exceeded')));
      });
    });

    describe('1.6 Other Commands', () => {
      
      it('should export story through processToolCall', async () => {
        const orchestrator = createTestableStoryOrchestrator();
        const mockStateManager = orchestrator.stateManager;
        
        orchestrator.workflowEngine = new WorkflowEngine({
          stateManager: mockStateManager,
          agentDispatcher: orchestrator.agentDispatcher,
          chapterOperations: createMockChapterOperations(),
          contentValidator: createMockContentValidator(),
          config: orchestrator.globalConfig
        });
        await orchestrator.workflowEngine.initialize();
        
        const story = await mockStateManager.createStory('测试故事');
        await mockStateManager.updateStory(story.id, { status: 'completed', finalOutput: { metadata: { title: 'Test Story' }, chapters: [{ number: 1, content: 'Test content' }] } });
        
        const result = await orchestrator.processToolCall({ command: 'ExportStory', story_id: story.id, format: 'markdown' });
        
        assert.strictEqual(result.status, 'success');
        assert.ok(result.result.content);
        assert.strictEqual(result.result.format, 'markdown');
      });

      it('should count chapter metrics through processToolCall', async () => {
        const orchestrator = createTestableStoryOrchestrator();
        
        orchestrator.workflowEngine = new WorkflowEngine({
          stateManager: orchestrator.stateManager,
          agentDispatcher: orchestrator.agentDispatcher,
          chapterOperations: createMockChapterOperations(),
          contentValidator: createMockContentValidator(),
          config: orchestrator.globalConfig
        });
        await orchestrator.workflowEngine.initialize();
        
        const testContent = '这是测试内容。这是一个测试内容。'.repeat(100);
        
        const result = await orchestrator.processToolCall({ command: 'CountChapterMetrics', chapter_content: testContent, target_min: 1000, target_max: 5000 });
        
        assert.strictEqual(result.status, 'success');
        assert.ok(result.result.counts);
        assert.ok(result.result.validation);
      });

      it('should forward outline_context to chapter draft runtime', async () => {
        const orchestrator = createTestableStoryOrchestrator();
        let capturedCall = null;

        orchestrator.chapterOperations = {
          ...createMockChapterOperations(),
          async createChapterDraft(storyId, chapterNumber, options = {}) {
            capturedCall = { storyId, chapterNumber, options };
            return {
              content: '这是一个用于验证章节草稿调用参数透传的测试正文。'.repeat(40),
              metrics: { counts: { actualCount: 2800, chineseChars: 2800 } },
              wasExpanded: false
            };
          }
        };

        const outlineContext = '本章需要突出主角第一次与失控 AI 正面对话，并埋下后续背叛伏笔。';
        const result = await orchestrator.processToolCall({
          command: 'CreateChapterDraft',
          story_id: 'story-1234567890ab',
          chapter_number: '2',
          outline_context: outlineContext,
          target_word_count: '1800'
        });

        assert.strictEqual(result.status, 'success');
        assert.ok(capturedCall);
        assert.strictEqual(capturedCall.chapterNumber, 2);
        assert.deepStrictEqual(capturedCall.options, {
          targetWordCount: 1800,
          outlineContext
        });
      });

      it('should coerce revise issues from JSON string into array', async () => {
        const orchestrator = createTestableStoryOrchestrator();
        let receivedIssues = null;

        orchestrator.chapterOperations = {
          ...createMockChapterOperations(),
          async reviseChapter(storyId, chapterNum, content, options = {}) {
            receivedIssues = options.issues;
            return {
              revisedContent: content + '\n\n【修订】...',
              changeSummary: '已按问题列表修订',
              originalMetrics: { counts: { actualCount: 2600 } },
              revisedMetrics: { counts: { actualCount: 2680 } }
            };
          }
        };

        const result = await orchestrator.processToolCall({
          command: 'ReviseChapter',
          story_id: 'story-1234567890ab',
          chapter_number: '1',
          chapter_content: '这是一个足够长的章节内容，用于验证 issues 参数的 JSON 字符串会被自动转换成数组。'.repeat(10),
          revision_instructions: '请根据问题列表进行定向修订，并保持主线情节不变。',
          issues: '["人物动机不够清晰","第二段节奏过快"]',
          max_rewrite_ratio: '0.4'
        });

        assert.strictEqual(result.status, 'success');
        assert.deepStrictEqual(receivedIssues, ['人物动机不够清晰', '第二段节奏过快']);
      });

      it('should reject invalid validation_type for ValidateConsistency', async () => {
        const orchestrator = createTestableStoryOrchestrator();
        const story = await orchestrator.stateManager.createStory('用于校验 ValidateConsistency 参数约束的测试故事');

        const result = await orchestrator.processToolCall({
          command: 'ValidateConsistency',
          story_id: story.id,
          content: '用于校验一致性的正文片段。',
          validation_type: 'all'
        });

        assert.strictEqual(result.status, 'error');
        assert.ok(result.error.includes('validation_type'));
      });

      it('should pass previous chapters into plot consistency validation', async () => {
        const orchestrator = createTestableStoryOrchestrator();
        const story = await orchestrator.stateManager.createStory('用于校验 plot consistency 上下文透传的测试故事');
        await orchestrator.stateManager.updatePhase2(story.id, {
          chapters: [{ number: 1, content: '第一章已经完成的内容。', metrics: { counts: { chineseChars: 2000 } } }]
        });

        let receivedPreviousChapters = null;
        orchestrator.contentValidator = {
          ...createMockContentValidator(),
          async validatePlot(storyId, content, storyBible, previousChapters = []) {
            receivedPreviousChapters = previousChapters;
            return { passed: true, issues: [] };
          }
        };

        const result = await orchestrator.processToolCall({
          command: 'ValidateConsistency',
          story_id: story.id,
          content: '这是用于校验剧情连续性的第二章片段。',
          validation_type: 'plot'
        });

        assert.strictEqual(result.status, 'success');
        assert.ok(Array.isArray(receivedPreviousChapters));
        assert.strictEqual(receivedPreviousChapters.length, 1);
      });

      it('should require target_phase when restarting workflow manually', async () => {
        const orchestrator = createTestableStoryOrchestrator();
        const story = await orchestrator.stateManager.createStory('用于校验恢复参数约束的测试故事');

        const result = await orchestrator.processToolCall({
          command: 'RecoverStoryWorkflow',
          story_id: story.id,
          recovery_action: 'restart_phase'
        });

        assert.strictEqual(result.status, 'error');
        assert.ok(result.error.includes('target_phase'));
      });

      it('should return error for unknown command', async () => {
        const orchestrator = createTestableStoryOrchestrator();
        
        orchestrator.workflowEngine = new WorkflowEngine({
          stateManager: orchestrator.stateManager,
          agentDispatcher: orchestrator.agentDispatcher,
          chapterOperations: createMockChapterOperations(),
          contentValidator: createMockContentValidator(),
          config: orchestrator.globalConfig
        });
        await orchestrator.workflowEngine.initialize();
        
        const result = await orchestrator.processToolCall({ command: 'UnknownCommand' });
        
        assert.strictEqual(result.status, 'error');
        assert.ok(result.error.includes('Unknown'));
      });
    });
  });

  describe('2. Full Workflow Integration Tests', () => {
    
    it('should execute full 3-phase workflow through processToolCall', async () => {
      const orchestrator = createTestableStoryOrchestrator();
      const mockStateManager = orchestrator.stateManager;
      
      orchestrator.workflowEngine = new WorkflowEngine({
        stateManager: mockStateManager,
        agentDispatcher: orchestrator.agentDispatcher,
        chapterOperations: createMockChapterOperations(),
        contentValidator: createMockContentValidator(),
        config: orchestrator.globalConfig
      });
      await orchestrator.workflowEngine.initialize();
      
      orchestrator.workflowEngine.phases = {
        phase1: {
          async run() {
            const story = await mockStateManager.getStory(mockStateManager._lastStoryId);
            await mockStateManager.updatePhase1(story.id, { worldview: { setting: '未来火星' }, characters: [{ name: '林博士' }], status: 'pending_confirmation' });
            return { status: 'waiting_checkpoint', checkpointId: 'cp-1-worldview', phase: 'phase1', data: {} };
          }
        },
        phase2: {
          async run() {
            const story = await mockStateManager.getStory(mockStateManager._lastStoryId);
            await mockStateManager.updatePhase2(story.id, { outline: { chapters: [{ number: 1, title: '第一章' }] }, status: 'pending_confirmation' });
            return { status: 'waiting_checkpoint', checkpointId: 'cp-2-outline', phase: 'phase2', data: {} };
          },
          async continueFromCheckpoint() { return { status: 'completed', phase: 'phase2' }; }
        },
        phase3: {
          async run() {
            const story = await mockStateManager.getStory(mockStateManager._lastStoryId);
            await mockStateManager.updatePhase3(story.id, { status: 'pending_confirmation' });
            return { status: 'waiting_checkpoint', checkpointId: 'cp-3-final', phase: 'phase3', data: {} };
          },
          async continueFromCheckpoint() { return { status: 'completed', phase: 'phase3' }; }
        }
      };
      
      const startResult = await orchestrator.processToolCall({ command: 'StartStoryProject', story_prompt: '一个完整的测试故事工作流程足够长以通过验证' });
      
      assert.strictEqual(startResult.status, 'success');
      const storyId = startResult.result.story_id;
      mockStateManager._lastStoryId = storyId;
      
      const approve1 = await orchestrator.processToolCall({ command: 'UserConfirmCheckpoint', story_id: storyId, checkpoint_id: 'cp-1-worldview', approval: true });
      assert.strictEqual(approve1.status, 'success');
      
      const approve2 = await orchestrator.processToolCall({ command: 'UserConfirmCheckpoint', story_id: storyId, checkpoint_id: 'cp-2-outline', approval: true });
      assert.strictEqual(approve2.status, 'success');
      
      const approve3 = await orchestrator.processToolCall({ command: 'UserConfirmCheckpoint', story_id: storyId, checkpoint_id: 'cp-3-final', approval: true });
      assert.strictEqual(approve3.status, 'success');
      
      const finalStory = await mockStateManager.getStory(storyId);
      assert.ok(finalStory.workflow.state === 'completed' || approve3.result?.status === 'completed');
    });

    it('should track agent calls during workflow', async () => {
      const orchestrator = createTestableStoryOrchestrator();
      const mockStateManager = orchestrator.stateManager;
      
      orchestrator.workflowEngine = new WorkflowEngine({
        stateManager: mockStateManager,
        agentDispatcher: orchestrator.agentDispatcher,
        chapterOperations: createMockChapterOperations(),
        contentValidator: createMockContentValidator(),
        config: orchestrator.globalConfig
      });
      await orchestrator.workflowEngine.initialize();
      
      // StartStoryProject runs workflow asynchronously, so we need to:
      // 1. Call it to get the story ID
      // 2. Wait for workflow to complete initial phase by polling status
      const startResult = await orchestrator.processToolCall({ command: 'StartStoryProject', story_prompt: '测试Agent调用追踪的工作流程足够长' });
      const storyId = startResult.result.story_id;
      
      // Wait for workflow to complete phase1 by polling
      let workflowComplete = false;
      for (let i = 0; i < 50 && !workflowComplete; i++) {
        await new Promise(r => setTimeout(r, 50));
        const status = await orchestrator.processToolCall({ command: 'QueryStoryStatus', story_id: storyId });
        // Workflow is complete when status shows checkpoint_pending (phase1 done) or completed
        if (status.result?.checkpoint_pending || status.result?.status === 'completed') {
          workflowComplete = true;
        }
      }
      
      // Now check agent calls were tracked
      assert.ok(agentCallLog.length > 0, 'Agent calls should be tracked during workflow');
    });
  });

  describe('3. Concurrent Story Handling', () => {
    
    it('should handle multiple stories independently', async () => {
      const orchestrator = createTestableStoryOrchestrator();
      const mockStateManager = orchestrator.stateManager;
      
      orchestrator.workflowEngine = new WorkflowEngine({
        stateManager: mockStateManager,
        agentDispatcher: orchestrator.agentDispatcher,
        chapterOperations: createMockChapterOperations(),
        contentValidator: createMockContentValidator(),
        config: orchestrator.globalConfig
      });
      await orchestrator.workflowEngine.initialize();
      
      const story1Result = await orchestrator.processToolCall({ command: 'StartStoryProject', story_prompt: '第一个并发测试故事项目足够长' });
      const story2Result = await orchestrator.processToolCall({ command: 'StartStoryProject', story_prompt: '第二个并发测试故事项目足够长' });
      const story3Result = await orchestrator.processToolCall({ command: 'StartStoryProject', story_prompt: '第三个并发测试故事项目足够长' });
      
      const status1 = await orchestrator.processToolCall({ command: 'QueryStoryStatus', story_id: story1Result.result.story_id });
      const status2 = await orchestrator.processToolCall({ command: 'QueryStoryStatus', story_id: story2Result.result.story_id });
      const status3 = await orchestrator.processToolCall({ command: 'QueryStoryStatus', story_id: story3Result.result.story_id });
      
      assert.strictEqual(status1.status, 'success');
      assert.strictEqual(status2.status, 'success');
      assert.strictEqual(status3.status, 'success');
      
      assert.notStrictEqual(status1.result.story_id, status2.result.story_id);
      assert.notStrictEqual(status2.result.story_id, status3.result.story_id);
    });

    it('should not interfere between concurrent checkpoint approvals', async () => {
      const orchestrator = createTestableStoryOrchestrator();
      const mockStateManager = orchestrator.stateManager;
      
      orchestrator.workflowEngine = new WorkflowEngine({
        stateManager: mockStateManager,
        agentDispatcher: orchestrator.agentDispatcher,
        chapterOperations: createMockChapterOperations(),
        contentValidator: createMockContentValidator(),
        config: orchestrator.globalConfig
      });
      await orchestrator.workflowEngine.initialize();
      
      const story1 = await mockStateManager.createStory('故事1');
      const story2 = await mockStateManager.createStory('故事2');
      
      await mockStateManager.updateWorkflow(story1.id, { state: 'waiting_checkpoint', currentPhase: 'phase1' });
      await mockStateManager.setActiveCheckpoint(story1.id, { id: 'cp-story1', phase: 'phase1', status: 'pending' });
      
      await mockStateManager.updateWorkflow(story2.id, { state: 'waiting_checkpoint', currentPhase: 'phase1' });
      await mockStateManager.setActiveCheckpoint(story2.id, { id: 'cp-story2', phase: 'phase1', status: 'pending' });
      
      orchestrator.workflowEngine.phases = {
        phase1: { async run() { return { status: 'completed', phase: 'phase1' }; } },
        phase2: { async run() { return { status: 'completed', phase: 'phase2' }; } },
        phase3: { async run() { return { status: 'completed', phase: 'phase3' }; } }
      };
      
      await orchestrator.processToolCall({ command: 'UserConfirmCheckpoint', story_id: story1.id, checkpoint_id: 'cp-story1', approval: true });
      
      const story2State = await mockStateManager.getStory(story2.id);
      assert.strictEqual(story2State.workflow.activeCheckpoint.id, 'cp-story2');
      assert.strictEqual(story2State.workflow.activeCheckpoint.status, 'pending');
    });
  });

  describe('4. AgentDispatcher Plugin-Level Mock', () => {
    
    it('should properly mock delegate() at plugin level', async () => {
      const orchestrator = createTestableStoryOrchestrator();
      
      assert.ok(orchestrator.agentDispatcher);
      assert.ok(typeof orchestrator.agentDispatcher.delegate === 'function');
      
      const response = await orchestrator.agentDispatcher.delegate('worldBuilder', 'Test prompt');
      
      assert.ok(response.content);
      assert.ok(JSON.parse(response.content).setting);
    });

    it('should support delegateParallel at plugin level', async () => {
      const orchestrator = createTestableStoryOrchestrator();
      
      const result = await orchestrator.agentDispatcher.delegateParallel([
        { agentType: 'worldBuilder', prompt: 'Test 1' },
        { agentType: 'characterDesigner', prompt: 'Test 2' }
      ]);
      
      assert.ok(result.succeeded);
      assert.strictEqual(result.succeeded.length, 2);
    });

    it('should support delegateSerial at plugin level', async () => {
      const orchestrator = createTestableStoryOrchestrator();
      
      const results = await orchestrator.agentDispatcher.delegateSerial([
        { agentType: 'worldBuilder', prompt: 'Test 1' },
        { agentType: 'characterDesigner', prompt: 'Test 2' }
      ]);
      
      assert.strictEqual(results.length, 2);
      assert.strictEqual(results[0].status, 'success');
    });
  });

  describe('5. State Verification Through Plugin API', () => {
    
    it('should verify checkpoint state through QueryStoryStatus', async () => {
      const orchestrator = createTestableStoryOrchestrator();
      const mockStateManager = orchestrator.stateManager;
      
      orchestrator.workflowEngine = new WorkflowEngine({
        stateManager: mockStateManager,
        agentDispatcher: orchestrator.agentDispatcher,
        chapterOperations: createMockChapterOperations(),
        contentValidator: createMockContentValidator(),
        config: orchestrator.globalConfig
      });
      await orchestrator.workflowEngine.initialize();
      
      const story = await mockStateManager.createStory('测试检查点');
      await mockStateManager.updateWorkflow(story.id, { state: 'waiting_checkpoint', currentPhase: 'phase1' });
      await mockStateManager.setActiveCheckpoint(story.id, { id: 'cp-test', phase: 'phase1', status: 'pending' });
      
      const status = await orchestrator.processToolCall({ command: 'QueryStoryStatus', story_id: story.id });
      
      assert.strictEqual(status.result.checkpoint_pending, true);
      assert.strictEqual(status.result.checkpoint_id, 'cp-test');
    });

    it('should track workflow history through state updates', async () => {
      const orchestrator = createTestableStoryOrchestrator();
      const mockStateManager = orchestrator.stateManager;
      
      orchestrator.workflowEngine = new WorkflowEngine({
        stateManager: mockStateManager,
        agentDispatcher: orchestrator.agentDispatcher,
        chapterOperations: createMockChapterOperations(),
        contentValidator: createMockContentValidator(),
        config: orchestrator.globalConfig
      });
      await orchestrator.workflowEngine.initialize();
      
      const story = await mockStateManager.createStory('测试历史');
      
      await mockStateManager.appendWorkflowHistory(story.id, { type: 'phase_started', phase: 'phase1', detail: { message: 'Phase 1 started' } });
      await mockStateManager.appendWorkflowHistory(story.id, { type: 'phase_completed', phase: 'phase1', detail: { message: 'Phase 1 completed' } });
      
      const updatedStory = await mockStateManager.getStory(story.id);
      assert.strictEqual(updatedStory.workflow.history.length, 2);
      assert.strictEqual(updatedStory.workflow.history[0].type, 'phase_started');
      assert.strictEqual(updatedStory.workflow.history[1].type, 'phase_completed');
    });
  });

  describe('6. Validation and Error Handling', () => {
    
    it('should validate required fields for StartStoryProject', async () => {
      const orchestrator = createTestableStoryOrchestrator();
      
      orchestrator.workflowEngine = new WorkflowEngine({
        stateManager: orchestrator.stateManager,
        agentDispatcher: orchestrator.agentDispatcher,
        chapterOperations: createMockChapterOperations(),
        contentValidator: createMockContentValidator(),
        config: orchestrator.globalConfig
      });
      await orchestrator.workflowEngine.initialize();
      
      const result = await orchestrator.processToolCall({ command: 'StartStoryProject' });
      
      assert.strictEqual(result.status, 'error');
      assert.ok(result.error.includes('story_prompt'));
    });

    it('should validate checkpoint approval requires boolean', async () => {
      const orchestrator = createTestableStoryOrchestrator();
      
      orchestrator.workflowEngine = new WorkflowEngine({
        stateManager: orchestrator.stateManager,
        agentDispatcher: orchestrator.agentDispatcher,
        chapterOperations: createMockChapterOperations(),
        contentValidator: createMockContentValidator(),
        config: orchestrator.globalConfig
      });
      await orchestrator.workflowEngine.initialize();
      
      const result = await orchestrator.processToolCall({ command: 'UserConfirmCheckpoint', story_id: 'some-story', checkpoint_id: 'some-cp', approval: 'not-a-boolean' });
      
      assert.strictEqual(result.status, 'error');
    });
  });

  describe('7. Checkpoint Expiry Auto-Approval', () => {
    
    it('should detect expired checkpoints via _findExpiredCheckpoints', async () => {
      const orchestrator = createTestableStoryOrchestrator();
      const mockStateManager = orchestrator.stateManager;
      
      orchestrator.workflowEngine = new WorkflowEngine({
        stateManager: mockStateManager,
        agentDispatcher: orchestrator.agentDispatcher,
        chapterOperations: createMockChapterOperations(),
        contentValidator: createMockContentValidator(),
        config: { ...orchestrator.globalConfig, USER_CHECKPOINT_TIMEOUT_MS: 50 }
      });
      await orchestrator.workflowEngine.initialize();
      
      const storyId = 'expired-checkpoint-story';
      const story = {
        id: storyId,
        status: 'phase1_waiting_checkpoint',
        workflow: {
          state: 'waiting_checkpoint',
          currentPhase: 'phase1',
          activeCheckpoint: {
            id: 'cp-expired-test',
            phase: 'phase1',
            type: 'worldview_confirmation',
            status: 'pending',
            expiresAt: new Date(Date.now() - 100).toISOString(),
            autoContinueOnTimeout: true
          },
          history: []
        }
      };
      testStories.set(storyId, story);
      
      const expired = await orchestrator.workflowEngine._findExpiredCheckpoints();
      
      assert.strictEqual(expired.length, 1);
      assert.strictEqual(expired[0].checkpoint.id, 'cp-expired-test');
    });

    it('should not detect non-expired checkpoints', async () => {
      const orchestrator = createTestableStoryOrchestrator();
      const mockStateManager = orchestrator.stateManager;
      
      orchestrator.workflowEngine = new WorkflowEngine({
        stateManager: mockStateManager,
        agentDispatcher: orchestrator.agentDispatcher,
        chapterOperations: createMockChapterOperations(),
        contentValidator: createMockContentValidator(),
        config: { ...orchestrator.globalConfig, USER_CHECKPOINT_TIMEOUT_MS: 5000 }
      });
      await orchestrator.workflowEngine.initialize();
      
      const storyId = 'valid-checkpoint-story';
      const story = {
        id: storyId,
        status: 'phase1_waiting_checkpoint',
        workflow: {
          state: 'waiting_checkpoint',
          currentPhase: 'phase1',
          activeCheckpoint: {
            id: 'cp-valid',
            phase: 'phase1',
            type: 'worldview_confirmation',
            status: 'pending',
            expiresAt: new Date(Date.now() + 5000).toISOString(),
            autoContinueOnTimeout: true
          },
          history: []
        }
      };
      testStories.set(storyId, story);
      
      const expired = await orchestrator.workflowEngine._findExpiredCheckpoints();
      
      assert.strictEqual(expired.length, 0);
    });

    it('should not auto-approve if autoContinueOnTimeout is false', async () => {
      const orchestrator = createTestableStoryOrchestrator();
      const mockStateManager = orchestrator.stateManager;
      
      orchestrator.workflowEngine = new WorkflowEngine({
        stateManager: mockStateManager,
        agentDispatcher: orchestrator.agentDispatcher,
        chapterOperations: createMockChapterOperations(),
        contentValidator: createMockContentValidator(),
        config: { ...orchestrator.globalConfig, USER_CHECKPOINT_TIMEOUT_MS: 50 }
      });
      await orchestrator.workflowEngine.initialize();
      
      const storyId = 'no-auto-story';
      const story = {
        id: storyId,
        status: 'phase1_waiting_checkpoint',
        workflow: {
          state: 'waiting_checkpoint',
          currentPhase: 'phase1',
          activeCheckpoint: {
            id: 'cp-no-auto',
            phase: 'phase1',
            type: 'worldview_confirmation',
            status: 'pending',
            expiresAt: new Date(Date.now() - 100).toISOString(),
            autoContinueOnTimeout: false
          },
          history: []
        }
      };
      testStories.set(storyId, story);
      
      const result = await orchestrator.workflowEngine.checkExpiredCheckpoints();
      
      assert.strictEqual(result.processed, 0);
      assert.strictEqual(result.autoApproved, 0);
    });
  });

  describe('8. Phase2 Retry and Checkpoint Tests', () => {
    it('should retry outline validation up to 5 times', async () => {
      const orchestrator = createTestableStoryOrchestrator();
      await orchestrator.initialize();
      
      let validationAttempts = 0;
      const mockValidator = {
        async validate() {
          validationAttempts++;
          return { passed: validationAttempts >= 5, issues: [], suggestions: [] };
        }
      };
      
      orchestrator.phases.phase2.contentValidator = mockValidator;
      
      const storyId = await orchestrator.stateManager.createStory('测试故事', { genre: '科幻' });
      await orchestrator.phases.phase2._runOutlineGeneration(storyId);
      
      assert.strictEqual(validationAttempts >= 1 && validationAttempts <= 5, true, 
        `Expected 1-5 validation attempts, got ${validationAttempts}`);
    });

    it('should not hard-fail on outline warnings only', async () => {
      const orchestrator = createTestableStoryOrchestrator();
      await orchestrator.initialize();
      
      const mockDispatcher = {
        async delegate(agentType, prompt) {
          if (agentType === 'logicValidator') {
            return {
              content: '【验证结论】\n有条件通过\n\n【问题清单】\n警告：第2章场景描述可以更详细\n建议：增加人物心理描写',
              raw: {},
              markers: {}
            };
          }
          return { content: 'mock content', raw: {}, markers: {} };
        },
        async delegateParallel() {
          return { succeeded: [], failed: [] };
        }
      };
      
      orchestrator.phases.phase2.agentDispatcher = mockDispatcher;
      
      const storyId = await orchestrator.stateManager.createStory('测试故事', { genre: '科幻' });
      const result = await orchestrator.phases.phase2._validateOutline(storyId, { chapters: [] });
      
      assert.strictEqual(result.passed, true, 'Outline with only warnings should pass');
    });

    it('should create second checkpoint after content generation', async () => {
      const orchestrator = createTestableStoryOrchestrator();
      await orchestrator.initialize();
      
      const storyId = await orchestrator.stateManager.createStory('测试故事', { genre: '科幻' });
      await orchestrator.stateManager.updatePhase2(storyId, { 
        outline: { chapters: [{ title: '第一章', scenes: [] }] },
        userConfirmed: true 
      });
      
      await orchestrator.phases.phase2._produceContent(storyId);
      
      const story = await orchestrator.stateManager.getStory(storyId);
      assert.ok(story.phase2.checkpointId, 'Should have content checkpoint ID');
      assert.strictEqual(story.phase2.status, 'content_pending_confirmation', 
        'Should be waiting for content confirmation');
    });
  });

  describe('9. Phase3 Guard Tests', () => {
    it('should not run Phase3 when Phase2 has no approved chapters', async () => {
      const orchestrator = createTestableStoryOrchestrator();
      await orchestrator.initialize();
      
      const storyId = await orchestrator.stateManager.createStory('测试故事', { genre: '科幻' });
      await orchestrator.stateManager.updateStory(storyId, {
        status: 'phase2_completed',
        phase2: { chapters: [], userConfirmed: true }
      });
      
      const result = await orchestrator.phases.phase3.run(storyId);
      
      assert.strictEqual(result.status, 'failed');
      assert.ok(result.error.includes('No chapters') || result.error.includes('no approved chapters'));
    });

    it('should run Phase3 when Phase2 has approved chapters', async () => {
      const orchestrator = createTestableStoryOrchestrator();
      await orchestrator.initialize();
      
      const storyId = await orchestrator.stateManager.createStory('测试故事', { genre: '科幻' });
      await orchestrator.stateManager.updateStory(storyId, {
        status: 'phase2_completed',
        phase2: { 
          chapters: [{ content: '第一章内容', status: 'completed' }], 
          userConfirmed: true 
        }
      });
      
      const result = await orchestrator.phases.phase3.run(storyId);
      
      assert.notStrictEqual(result.status, 'failed');
    });
  });

  describe('10. Complete Workflow Closure Tests', () => {
    it('should complete full 3-phase workflow with all checkpoints', async () => {
      const orchestrator = createTestableStoryOrchestrator();
      await orchestrator.initialize();
      
      const storyId = await orchestrator.processToolCall('StartStoryProject', {
        story_prompt: 'AI觉醒的科幻故事',
        genre: '科幻'
      });
      
      assert.ok(storyId);
      
      let story = await orchestrator.stateManager.getStory(storyId);
      assert.ok(story.workflow.checkpointId, 'Phase1 should have checkpoint');
      
      await orchestrator.processToolCall('UserConfirmCheckpoint', {
        story_id: storyId,
        checkpoint_id: story.workflow.checkpointId,
        approval: true
      });
      
      story = await orchestrator.stateManager.getStory(storyId);
      if (story.phase2.status === 'outline_pending_confirmation') {
        assert.ok(story.phase2.checkpointId, 'Phase2 outline should have checkpoint');
        
        await orchestrator.processToolCall('UserConfirmCheckpoint', {
          story_id: storyId,
          checkpoint_id: story.phase2.checkpointId,
          approval: true
        });
      }
      
      story = await orchestrator.stateManager.getStory(storyId);
      if (story.phase2.status === 'content_pending_confirmation') {
        assert.ok(story.phase2.checkpointId, 'Phase2 content should have checkpoint');
        
        await orchestrator.processToolCall('UserConfirmCheckpoint', {
          story_id: storyId,
          checkpoint_id: story.phase2.checkpointId,
          approval: true
        });
      }
      
      story = await orchestrator.stateManager.getStory(storyId);
      if (story.phase3.status === 'pending_confirmation') {
        assert.ok(story.phase3.checkpointId, 'Phase3 should have checkpoint');
        
        await orchestrator.processToolCall('UserConfirmCheckpoint', {
          story_id: storyId,
          checkpoint_id: story.phase3.checkpointId,
          approval: true
        });
      }
      
      story = await orchestrator.stateManager.getStory(storyId);
      assert.strictEqual(story.status, 'completed', 'Story should be completed');
      assert.ok(story.finalOutput, 'Should have final output');
    });

    it('should generate story within target word count range', async () => {
      const orchestrator = createTestableStoryOrchestrator();
      await orchestrator.initialize();
      
      const storyId = await orchestrator.stateManager.createStory('测试故事', {
        target_word_count: { min: 2500, max: 3500 }
      });
      
      await orchestrator.stateManager.updateStory(storyId, {
        status: 'completed',
        finalOutput: 'A'.repeat(3000)
      });
      
      const story = await orchestrator.stateManager.getStory(storyId);
      const wordCount = story.finalOutput ? story.finalOutput.length : 0;
      
      assert.ok(wordCount >= 2500 && wordCount <= 3500,
        `Story word count ${wordCount} should be within target range 2500-3500`);
    });
  });
});

module.exports = { createMockAgentDispatcher, createMockStateManager, createMockChapterOperations, createMockContentValidator, createTestableStoryOrchestrator };
