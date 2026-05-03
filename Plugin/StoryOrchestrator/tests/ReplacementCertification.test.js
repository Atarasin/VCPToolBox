const test = require('node:test');
const assert = require('node:assert/strict');
const { mock } = require('node:test');

const { StoryOrchestratorKernelAdapter } = require('../adapters/StoryOrchestratorKernelAdapter');
const { WorkflowEngine } = require('../core/WorkflowEngine');

function createStory(overrides = {}) {
  return {
    id: 'story-123',
    status: 'draft',
    phase1: {
      worldview: null,
      characters: [],
      validation: null,
      userConfirmed: false,
      checkpointId: null,
      status: 'pending'
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
    },
    workflow: {
      state: 'idle',
      currentPhase: 'phase1',
      currentStep: null,
      activeCheckpoint: null,
      retryContext: {
        phase: null,
        step: null,
        attempt: 0,
        maxAttempts: 4,
        lastError: null
      },
      history: [],
      runToken: 'existing-run-token'
    },
    ...overrides
  };
}

function createMockStateManager(initialStory) {
  let story = initialStory;

  return {
    initialize: mock.fn(async () => {}),
    getStory: mock.fn(async (storyId) => (story && story.id === storyId ? story : null)),
    updateWorkflow: mock.fn(async (_storyId, updates) => {
      story.workflow = {
        ...(story.workflow || {}),
        ...updates,
        retryContext: updates.retryContext !== undefined
          ? { ...(story.workflow?.retryContext || {}), ...updates.retryContext }
          : story.workflow?.retryContext
      };
      return story;
    }),
    updateStory: mock.fn(async (_storyId, updates) => {
      story = {
        ...story,
        ...updates
      };
      return story;
    }),
    appendWorkflowHistory: mock.fn(async (_storyId, entry) => {
      story.workflow.history.push(entry);
      return story;
    }),
    setActiveCheckpoint: mock.fn(async (_storyId, checkpoint) => {
      story.workflow.activeCheckpoint = { ...checkpoint };
      return story;
    }),
    clearActiveCheckpoint: mock.fn(async (_storyId) => {
      story.workflow.activeCheckpoint = null;
      return story;
    }),
    recordPhaseFeedback: mock.fn(async (_storyId, phaseName, feedback) => {
      if (story[phaseName]) {
        story[phaseName].userFeedback = feedback;
      }
      return story;
    })
  };
}

function createEngine(storyOverrides = {}) {
  const stateManager = createMockStateManager(createStory(storyOverrides));
  const engine = new WorkflowEngine({
    stateManager,
    agentDispatcher: { dispatch: mock.fn() },
    chapterOperations: {},
    contentValidator: {},
    config: {
      USE_WORKFLOW_KERNEL: true,
      MAX_PHASE_RETRY_ATTEMPTS: 4,
      PHASE_RETRY_BACKOFF_MS: 250
    }
  });

  return { engine, stateManager };
}

function createKernelAgentDispatcher() {
  return {
    delegate: mock.fn(async (agentType) => {
      const responses = {
        worldBuilder: {
          content: JSON.stringify({
            setting: '未来地球公元2150年',
            rules: {
              physical: '星际旅行',
              special: '量子通信',
              limitations: '跨星系通信存在延迟'
            },
            factions: [{ name: '地球联邦', description: '统筹地月火资源网络' }],
            history: {
              keyEvents: ['火星独立战争停火'],
              coreConflicts: ['自治殖民地与联邦资源分配冲突']
            },
            sceneNorms: ['高科技感', '殖民地边疆氛围'],
            secrets: ['联邦正在隐藏一套失控 AI 的起源档案']
          }),
          raw: {},
          markers: {}
        },
        characterDesigner: {
          content: JSON.stringify({
            protagonists: [{
              name: '林博士',
              identity: 'AI 研究员',
              appearance: '穿白色实验服',
              personality: ['理性', '克制'],
              background: '火星殖民地出生',
              motivation: '追查异常 AI 的来源',
              innerConflict: '在真相与秩序之间摇摆',
              growthArc: '从旁观者成长为守护者'
            }],
            supportingCharacters: [{
              name: '小柒',
              identity: '辅助机器人',
              role: '情报协助',
              relationship: '林博士的搭档'
            }],
            relationshipNetwork: {
              direct: [{ from: '林博士', to: '小柒', type: '协作' }],
              hidden: []
            },
            oocRules: {
              林博士: ['避免做出无依据的冲动决策']
            }
          }),
          raw: {},
          markers: {}
        },
        plotArchitect: {
          content: [
            '【Chapter 1】',
            '标题：火星黎明',
            '核心事件：林博士发现第一条异常 AI 记录',
            '场景：',
            '1. 火星研究所主控室',
            '2. 地月通信中继站',
            '出场人物：',
            '林博士',
            '小柒',
            '故事功能：setup',
            '',
            '【Chapter 2】',
            '标题：信号裂缝',
            '核心事件：异常 AI 借通信链路向殖民地扩散',
            '场景：',
            '1. 火星外环维修通道',
            '2. 联邦应急会议室',
            '出场人物：',
            '林博士',
            '联邦代表',
            '故事功能：escalation',
            '',
            '【Chapter 3】',
            '标题：静默守门人',
            '核心事件：林博士阻断扩散并公开真相',
            '场景：',
            '1. 火星主机房',
            '2. 联邦档案库',
            '出场人物：',
            '林博士',
            '小柒',
            '故事功能：resolution'
          ].join('\n'),
          raw: {},
          markers: {}
        },
        logicValidator: {
          content: '【验证结论】\n通过\n\n【问题清单】\n无',
          raw: {},
          markers: {}
        },
        finalEditor: {
          content: '【终校定稿】\n\n终稿结构完整，逻辑连贯，适合进入发布阶段。',
          raw: {},
          markers: {}
        }
      };

      return responses[agentType] || {
        content: `Mock response for ${agentType}`,
        raw: {},
        markers: {}
      };
    })
  };
}

function createKernelChapterOperations() {
  return {
    createChapterDraft: mock.fn(async (_storyId, chapterNumber) => ({
      content: `第${chapterNumber}章正文。林博士在火星设施中推进调查。`.repeat(80),
      metrics: { counts: { actualCount: 2800, chineseChars: 2800 } },
      wasExpanded: false
    })),
    fillDetails: mock.fn(async (_storyId, _chapterNum, content) => ({
      detailedContent: `${content}\n\n【细节填充】补足环境描写与情绪变化。`,
      improvements: ['场景更生动']
    })),
    _expandChapter: mock.fn(async (_storyId, content) => ({
      content: `${content}\n\n【自动扩写】补足目标字数。`
    })),
    reviseChapter: mock.fn(async (_storyId, _chapterNum, content) => ({
      revisedContent: `${content}\n\n【修订】已根据反馈修订。`
    })),
    polishChapter: mock.fn(async (_storyId, _chapterNum, content) => ({
      polishedContent: `${content}\n\n【润色】语言进一步收敛。`,
      improvements: ['语言更凝练'],
      metrics: { counts: { actualCount: 2850, chineseChars: 2850 } }
    })),
    countChapterLength: mock.fn((content, targetMin, targetMax) => {
      const chineseChars = content.replace(/[^\u4e00-\u9fa5]/g, '').length;
      return {
        counts: {
          actualCount: chineseChars,
          chineseChars,
          nonWhitespaceChars: content.replace(/\s/g, '').length,
          paragraphCount: Math.max(1, content.split('\n').length)
        },
        validation: {
          isQualified: chineseChars >= targetMin && chineseChars <= (targetMax || Number.MAX_SAFE_INTEGER),
          rangeStatus: chineseChars < targetMin ? 'below_min' : chineseChars > targetMax ? 'above_max' : 'within_range',
          deficit: chineseChars < targetMin ? targetMin - chineseChars : 0
        }
      };
    })
  };
}

function createKernelContentValidator() {
  return {
    comprehensiveValidation: mock.fn(async () => ({
      overall: { passed: true, hasCriticalIssues: false, criticalCount: 0 },
      allIssues: [],
      chapterIssues: {},
      worldbuildingConsistency: true,
      characterConsistency: true,
      plotContinuity: true
    })),
    qualityScore: mock.fn(async () => ({
      average: 8.6,
      scores: {
        logicConsistency: 8.5,
        writingExpression: 8.7,
        sceneDescription: 8.4,
        characterConsistency: 8.8,
        overallReadability: 8.6
      },
      rawReport: '质量评分报告'
    }))
  };
}

function createKernelStateManager() {
  const cache = new Map();
  const repositoryStories = new Map();
  const checkpoints = new Map();
  const snapshots = new Map();
  const workflowEvents = [];
  let snapshotCounter = 0;

  const repository = {
    getStory(storyId) {
      return repositoryStories.get(storyId) || null;
    },
    getStoryWithFields(storyId) {
      return repositoryStories.get(storyId) || null;
    },
    createStory(storyId, config = {}) {
      const row = {
        story_id: storyId,
        version: 1,
        status: 'idle',
        config_json: JSON.stringify(config),
        workflow_state: JSON.stringify({ inputs: {}, outputs: {}, steps: {} }),
        current_step: JSON.stringify([]),
        retry_context_json: JSON.stringify({}),
        active_checkpoint_id: null,
        current_phase1_snapshot_id: null,
        current_phase2_snapshot_id: null,
        current_phase3_snapshot_id: null
      };
      repositoryStories.set(storyId, row);
      return row;
    },
    createSnapshot(payload) {
      const snapshotId = `snapshot-${++snapshotCounter}`;
      snapshots.set(snapshotId, {
        snapshot_id: snapshotId,
        ...payload,
        payload_json: typeof payload.payload_json === 'string'
          ? payload.payload_json
          : JSON.stringify(payload.payload_json)
      });
      return snapshotId;
    },
    getSnapshot(snapshotId) {
      return snapshots.get(snapshotId) || null;
    },
    createCheckpoint(payload) {
      checkpoints.set(payload.checkpoint_id, payload);
    },
    updateCheckpoint(checkpointId, updates) {
      checkpoints.set(checkpointId, { ...(checkpoints.get(checkpointId) || {}), ...updates });
    },
    getCheckpoint(checkpointId) {
      return checkpoints.get(checkpointId) || null;
    },
    updateStory(storyId, updates) {
      const existing = repositoryStories.get(storyId) || repository.createStory(storyId);
      const next = {
        ...existing,
        ...updates,
        version: (existing.version || 1) + 1
      };
      repositoryStories.set(storyId, next);
      return next;
    },
    getLatestApprovedSnapshot(storyId, phaseName) {
      const row = repositoryStories.get(storyId);
      if (!row) {
        return null;
      }
      const snapshotId = row[`current_${phaseName}_snapshot_id`];
      return snapshotId ? snapshots.get(snapshotId) || null : null;
    },
    listStories() {
      return Array.from(repositoryStories.values());
    },
    appendEvent(event) {
      workflowEvents.push(event);
    }
  };

  return {
    initialized: false,
    repository,
    async initialize() {
      this.initialized = true;
    },
    async createStory(storyPrompt, config = {}) {
      const storyId = `story-cert-${cache.size + 1}`;
      const story = {
        id: storyId,
        status: 'idle',
        config: {
          targetWordCount: config.target_word_count || { min: 2500, max: 3500 },
          genre: config.genre || '科幻',
          stylePreference: config.style_preference || '',
          storyPrompt
        },
        phase1: { worldview: null, characters: [], validation: null, userConfirmed: false, checkpointId: null, status: 'pending' },
        phase2: { outline: null, chapters: [], currentChapter: 0, userConfirmed: false, checkpointId: null, status: 'pending' },
        phase3: { polishedChapters: [], finalValidation: null, iterationCount: 0, userConfirmed: false, checkpointId: null, status: 'pending', qualityScores: [] },
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
      repository.createStory(storyId, {
        target_word_count: config.target_word_count,
        genre: config.genre,
        style_preference: config.style_preference,
        storyPrompt
      });
      return story;
    },
    async getStory(storyId) {
      return cache.get(storyId) || null;
    },
    async updateStory(storyId, updates, repoUpdates = {}) {
      const story = cache.get(storyId);
      if (!story) {
        throw new Error(`Story not found: ${storyId}`);
      }
      Object.assign(story, updates);
      cache.set(storyId, story);
      if (Object.keys(repoUpdates).length > 0) {
        repository.updateStory(storyId, repoUpdates);
      }
      return story;
    },
    async updateWorkflow(storyId, updates) {
      const story = cache.get(storyId);
      if (!story) {
        throw new Error(`Story not found: ${storyId}`);
      }
      story.workflow = {
        ...(story.workflow || {}),
        ...updates,
        retryContext: updates.retryContext !== undefined
          ? { ...(story.workflow?.retryContext || {}), ...updates.retryContext }
          : story.workflow?.retryContext
      };
      cache.set(storyId, story);
      return story;
    },
    async appendWorkflowHistory(storyId, entry) {
      const story = cache.get(storyId);
      if (!story) {
        throw new Error(`Story not found: ${storyId}`);
      }
      story.workflow.history.push(entry);
      return story;
    },
    async setActiveCheckpoint(storyId, checkpoint) {
      const story = cache.get(storyId);
      if (!story) {
        throw new Error(`Story not found: ${storyId}`);
      }
      story.workflow.activeCheckpoint = {
        id: checkpoint.id,
        phase: checkpoint.phase,
        type: checkpoint.type,
        status: checkpoint.status,
        createdAt: checkpoint.createdAt || new Date().toISOString(),
        expiresAt: checkpoint.expiresAt || null,
        autoContinueOnTimeout: checkpoint.autoContinueOnTimeout !== false,
        reviewPayload: checkpoint.reviewPayload || null,
        reviewTitle: checkpoint.reviewTitle || null
      };
      repository.createCheckpoint({
        checkpoint_id: checkpoint.id,
        phase_name: checkpoint.phase,
        checkpoint_type: checkpoint.type,
        status: checkpoint.status
      });
      return story;
    },
    async clearActiveCheckpoint(storyId) {
      const story = cache.get(storyId);
      if (!story) {
        throw new Error(`Story not found: ${storyId}`);
      }
      story.workflow.activeCheckpoint = null;
      return story;
    },
    async updatePhase1(storyId, updates) {
      const story = cache.get(storyId);
      story.phase1 = { ...story.phase1, ...updates };
      return story;
    },
    async updatePhase2(storyId, updates) {
      const story = cache.get(storyId);
      story.phase2 = { ...story.phase2, ...updates };
      return story;
    },
    async updatePhase3(storyId, updates) {
      const story = cache.get(storyId);
      story.phase3 = { ...story.phase3, ...updates };
      return story;
    },
    async listStories() {
      return Array.from(cache.keys());
    },
    _workflowEvents: workflowEvents
  };
}

test('compatibility shell bypasses legacy phase runners when kernel mode owns the main path', async () => {
  const { engine } = createEngine();
  const legacyPhaseRun = mock.fn(async () => {
    throw new Error('legacy phase runner should not be called');
  });

  engine.phases = {
    phase1: {
      run: legacyPhaseRun
    }
  };
  engine.kernelAdapter = {
    executeWorkflow: mock.fn(async () => ({ status: 'waiting_checkpoint' })),
    getStatus: mock.fn(async () => ({
      state: 'waiting_checkpoint',
      currentPhase: 'phase1',
      currentStep: 'checkpointPhase1',
      activeCheckpoint: 'cp-kernel-phase1',
      recoveryCursor: { phaseId: 'phase1', stepId: 'checkpointPhase1' }
    }))
  };

  const result = await engine.start('story-123');

  assert.equal(engine.kernelAdapter.executeWorkflow.mock.calls.length, 1);
  assert.equal(legacyPhaseRun.mock.calls.length, 0);
  assert.equal(result.state, 'waiting_checkpoint');
  assert.deepEqual(result.activeCheckpoint, { checkpointId: 'cp-kernel-phase1' });
  assert.deepEqual(result.recoveryCursor, { phaseId: 'phase1', stepId: 'checkpointPhase1' });
});

test('compatibility shell delegates resume and recovery actions to kernel-owned entrypoints', async () => {
  const { engine, stateManager } = createEngine({
    workflow: {
      state: 'waiting_checkpoint',
      currentPhase: 'phase2',
      currentStep: 'checkpoint',
      activeCheckpoint: {
        id: 'cp-kernel-phase2',
        phase: 'phase2',
        type: 'phase2_outline_confirmation',
        status: 'pending'
      },
      retryContext: {
        phase: 'phase2',
        step: 'generateOutline',
        attempt: 1,
        maxAttempts: 4,
        lastError: 'temporary failure'
      },
      history: [],
      runToken: 'kernel-run-token'
    }
  });

  engine.kernelAdapter = {
    resume: mock.fn(async () => ({ status: 'running' })),
    recover: mock.fn(async () => ({ status: 'running' })),
    getStatus: mock.fn(async () => ({
      state: 'running',
      currentPhase: 'phase2',
      currentStep: 'generateOutline',
      activeCheckpoint: null,
      recoveryCursor: { phaseId: 'phase2', stepId: 'generateOutline' }
    }))
  };
  engine._sleep = mock.fn(async () => {});

  const resumeResult = await engine.resume('story-123', {
    checkpointId: 'cp-kernel-phase2',
    approval: true,
    feedback: 'continue'
  });
  const retryResult = await engine.retryPhase('story-123', 'phase2', 'temporary failure');
  const recoverResult = await engine.recover('story-123', {
    recoveryAction: 'rollback',
    targetCheckpoint: 'cp-kernel-rollback'
  });

  assert.equal(engine.kernelAdapter.resume.mock.calls.length, 1);
  assert.equal(engine.kernelAdapter.recover.mock.calls.length, 2);
  assert.equal(engine.kernelAdapter.recover.mock.calls[0].arguments[1].recoveryAction, 'restart_phase');
  assert.equal(engine.kernelAdapter.recover.mock.calls[1].arguments[1].recoveryAction, 'rollback');
  assert.equal(engine._sleep.mock.calls.length, 0);
  assert.equal(resumeResult.currentStep, 'generateOutline');
  assert.equal(retryResult.currentPhase, 'phase2');
  assert.equal(recoverResult.recoveryCursor.phaseId, 'phase2');
  assert.equal(stateManager.appendWorkflowHistory.mock.calls.length, 0);
});

test('compatibility shell can carry a kernel-led workflow through phase2, phase3, and completion', async () => {
  const { engine } = createEngine();
  const legacyPhaseRun = mock.fn(async () => {
    throw new Error('legacy phase runner should not be called');
  });
  const timeline = [
    {
      state: 'waiting_checkpoint',
      currentPhase: 'phase1',
      currentStep: 'checkpointPhase1',
      activeCheckpoint: 'cp-phase1-worldview'
    },
    {
      state: 'waiting_checkpoint',
      currentPhase: 'phase2',
      currentStep: 'checkpointOutline',
      activeCheckpoint: 'cp-phase2-outline'
    },
    {
      state: 'waiting_checkpoint',
      currentPhase: 'phase2',
      currentStep: 'checkpointContent',
      activeCheckpoint: 'cp-phase2-content'
    },
    {
      state: 'waiting_checkpoint',
      currentPhase: 'phase3',
      currentStep: 'checkpointFinal',
      activeCheckpoint: 'cp-phase3-final'
    },
    {
      state: 'completed',
      currentPhase: 'phase3',
      currentStep: 'checkpointFinal',
      activeCheckpoint: null
    }
  ];
  let timelineIndex = 0;

  engine.phases = {
    phase1: { run: legacyPhaseRun },
    phase2: { run: legacyPhaseRun },
    phase3: { run: legacyPhaseRun }
  };
  engine.kernelAdapter = {
    executeWorkflow: mock.fn(async () => ({ status: 'waiting_checkpoint' })),
    resume: mock.fn(async () => {
      timelineIndex += 1;
      return { status: timeline[Math.min(timelineIndex, timeline.length - 1)].state };
    }),
    getStatus: mock.fn(async () => ({
      ...timeline[Math.min(timelineIndex, timeline.length - 1)],
      recoveryCursor: { phaseId: timeline[Math.min(timelineIndex, timeline.length - 1)].currentPhase }
    }))
  };

  const startResult = await engine.start('story-123');
  const phase2Outline = await engine.resume('story-123', { checkpointId: 'cp-phase1-worldview', approval: true });
  const phase2Content = await engine.resume('story-123', { checkpointId: 'cp-phase2-outline', approval: true });
  const phase3Final = await engine.resume('story-123', { checkpointId: 'cp-phase2-content', approval: true });
  const completion = await engine.resume('story-123', { checkpointId: 'cp-phase3-final', approval: true });

  assert.equal(legacyPhaseRun.mock.calls.length, 0);
  assert.equal(startResult.currentPhase, 'phase1');
  assert.equal(phase2Outline.currentPhase, 'phase2');
  assert.equal(phase2Content.currentPhase, 'phase2');
  assert.equal(phase3Final.currentPhase, 'phase3');
  assert.equal(completion.state, 'completed');
  assert.equal(completion.currentPhase, 'phase3');
  assert.equal(engine.kernelAdapter.resume.mock.calls.length, 4);
});

test('real StoryOrchestratorKernelAdapter drives the shared workflow through phase2, phase3, and completion', async () => {
  const stateManager = createKernelStateManager();
  const agentDispatcher = createKernelAgentDispatcher();
  const chapterOperations = createKernelChapterOperations();
  const contentValidator = createKernelContentValidator();
  const adapter = new StoryOrchestratorKernelAdapter({
    stateManager,
    agentDispatcher,
    chapterOperations,
    contentValidator,
    config: {
      USE_WORKFLOW_KERNEL: true,
      MAX_PHASE_ITERATIONS: 2,
      QUALITY_THRESHOLD: 8.0
    }
  });

  await adapter.initialize();
  const story = await stateManager.createStory('一个关于异常 AI 在火星殖民地扩散的科幻故事', {
    target_word_count: { min: 2500, max: 3500 },
    genre: '科幻',
    style_preference: '硬科幻'
  });

  try {
    const phase1Checkpoint = await adapter.executeWorkflow(story.id, {
      storyId: story.id,
      storyPrompt: story.config.storyPrompt,
      targetWordCount: story.config.targetWordCount,
      genre: story.config.genre,
      stylePreference: story.config.stylePreference
    });
    assert.equal(phase1Checkpoint.status, 'waiting_checkpoint');
    assert.equal(phase1Checkpoint.checkpointState.checkpointId, 'checkpointPhase1');

    const phase2Outline = await adapter.resume(story.id, {
      checkpointId: 'checkpointPhase1',
      action: 'approve',
      feedback: '继续进入大纲阶段'
    });
    assert.equal(phase2Outline.status, 'waiting_checkpoint');
    assert.equal(phase2Outline.checkpointState.checkpointId, 'checkpointOutline');
    assert.equal(phase2Outline.context.outputs.outline.chapters.length, 3);

    const phase2Content = await adapter.resume(story.id, {
      checkpointId: 'checkpointOutline',
      action: 'approve',
      feedback: '大纲通过'
    });
    assert.equal(phase2Content.status, 'waiting_checkpoint');
    assert.equal(phase2Content.checkpointState.checkpointId, 'checkpointContent');
    assert.equal(phase2Content.context.outputs.chaptersResult.chapters.length, 3);
    assert.equal(phase2Content.context.outputs.chaptersResult.completedCount, 3);

    const phase3Final = await adapter.resume(story.id, {
      checkpointId: 'checkpointContent',
      action: 'approve',
      feedback: '正文通过'
    });
    assert.equal(phase3Final.status, 'waiting_checkpoint');
    assert.equal(phase3Final.checkpointState.checkpointId, 'checkpointFinal');
    assert.equal(phase3Final.context.outputs.polishedChapters.chapters.length, 3);
    assert.ok(phase3Final.context.outputs.finalEditorOutput.content.includes('终稿'));

    const completion = await adapter.resume(story.id, {
      checkpointId: 'checkpointFinal',
      action: 'approve',
      feedback: '终稿通过'
    });
    const status = await adapter.getStatus(story.id);

    assert.equal(completion.status, 'completed');
    assert.equal(status.state, 'completed');
    assert.ok(['phase3', 'completed'].includes(status.currentPhase));
    assert.equal(status.activeCheckpoint, null);
    assert.equal(chapterOperations.createChapterDraft.mock.calls.length, 3);
    assert.equal(chapterOperations.polishChapter.mock.calls.length, 3);
    assert.equal(contentValidator.comprehensiveValidation.mock.calls.length >= 4, true);
  } finally {
    adapter.kernel.checkpointManager.destroy();
  }
});
