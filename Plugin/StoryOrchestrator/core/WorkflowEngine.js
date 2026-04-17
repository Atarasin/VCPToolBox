const { v4: uuidv4 } = require('uuid');
const { Phase1_WorldBuilding } = require('./Phase1_WorldBuilding');
const { Phase2_OutlineDrafting } = require('./Phase2_OutlineDrafting');
const { Phase3_Refinement } = require('./Phase3_Refinement');

/**
 * WorkflowEngine - 工作流编排引擎
 * 
 * 职责：
 * 1. 管理 Phase 到 Phase 的转换
 * 2. 管理检查点等待和恢复
 * 3. 集中重试处理
 * 4. 发送 WebSocket 通知
 */
class WorkflowEngine {
  /**
   * @param {Object} dependencies
   * @param {Object} dependencies.stateManager - StateManager 实例
   * @param {Object} dependencies.agentDispatcher - AgentDispatcher 实例
   * @param {Object} dependencies.chapterOperations - ChapterOperations 实例
   * @param {Object} dependencies.contentValidator - ContentValidator 实例
   * @param {Object} dependencies.config - 配置对象
   */
  constructor({ stateManager, agentDispatcher, chapterOperations, contentValidator, config }) {
    this.stateManager = stateManager;
    this.agentDispatcher = agentDispatcher;
    this.chapterOperations = chapterOperations;
    this.contentValidator = contentValidator;
    this.config = config || {};

    // Phase 实例
    this.phases = {
      phase1: null,
      phase2: null,
      phase3: null
    };

    // 重试策略配置
    this.retryConfig = {
      maxAttempts: this.config.MAX_PHASE_RETRY_ATTEMPTS || 3,
      backoffDelays: [0, 250, 1000], // immediate, 250ms, 1000ms
      retryOnPhases: ['phase1', 'phase2', 'phase3']
    };

    // WebSocket 推送器（可选）
    this.webSocketPusher = null;

    // 初始化标志
    this.initialized = false;

    // 定期检查定时器
    this._expiryCheckTimer = null;
    this._expiryCheckIntervalMs = this.config.CHECKPOINT_EXPIRY_CHECK_INTERVAL_MS || 60000; // 默认 60 秒
  }

  /**
   * 初始化工作流引擎
   */
  async initialize() {
    if (this.initialized) {
      console.log('[WorkflowEngine] Already initialized');
      return;
    }

    console.log('[WorkflowEngine] Initializing...');

    // 初始化 StateManager
    if (this.stateManager && typeof this.stateManager.initialize === 'function') {
      await this.stateManager.initialize();
    }

    const { PromptBuilder } = require('../utils/PromptBuilder');
    
    this.phases.phase1 = new Phase1_WorldBuilding({
      stateManager: this.stateManager,
      agentDispatcher: this.agentDispatcher,
      promptBuilder: PromptBuilder,
      config: this.config
    });

    this.phases.phase2 = new Phase2_OutlineDrafting({
      stateManager: this.stateManager,
      agentDispatcher: this.agentDispatcher,
      chapterOperations: this.chapterOperations,
      contentValidator: this.contentValidator,
      promptBuilder: PromptBuilder,
      config: this.config
    });

    this.phases.phase3 = new Phase3_Refinement({
      stateManager: this.stateManager,
      agentDispatcher: this.agentDispatcher,
      chapterOperations: this.chapterOperations,
      contentValidator: this.contentValidator,
      promptBuilder: PromptBuilder,
      config: this.config
    });

    this.initialized = true;
    console.log('[WorkflowEngine] Initialized successfully');

    // 启动检查点过期定期检查
    this._startExpiryCheckTimer();
  }

  /**
   * 设置 WebSocket 推送器
   * @param {Object} pusher - WebSocket 推送器
   */
  setWebSocketPusher(pusher) {
    this.webSocketPusher = pusher;
  }

  /**
   * 启动检查点过期定期检查定时器
   * @private
   */
  _startExpiryCheckTimer() {
    if (this._expiryCheckTimer) {
      clearInterval(this._expiryCheckTimer);
    }
    this._expiryCheckTimer = setInterval(async () => {
      await this.checkExpiredCheckpoints();
    }, this._expiryCheckIntervalMs);
    console.log(`[WorkflowEngine] Expiry check timer started (interval: ${this._expiryCheckIntervalMs}ms)`);
  }

  /**
   * 停止检查点过期定期检查定时器
   * @private
   */
  _stopExpiryCheckTimer() {
    if (this._expiryCheckTimer) {
      clearInterval(this._expiryCheckTimer);
      this._expiryCheckTimer = null;
      console.log('[WorkflowEngine] Expiry check timer stopped');
    }
  }

  /**
   * 检查并自动批准所有过期的检查点
   * @returns {Object} 检查结果
   */
  async checkExpiredCheckpoints() {
    console.log('[WorkflowEngine] Running scheduled checkpoint expiry check...');

    try {
      const expiredCheckpoints = await this._findExpiredCheckpoints();

      if (expiredCheckpoints.length === 0) {
        console.log('[WorkflowEngine] No expired checkpoints found');
        return { processed: 0, autoApproved: 0 };
      }

      console.log(`[WorkflowEngine] Found ${expiredCheckpoints.length} expired checkpoint(s)`);

      let autoApprovedCount = 0;
      for (const item of expiredCheckpoints) {
        const { storyId, checkpoint } = item;
        const result = await this._autoApproveExpiredCheckpoint(storyId, checkpoint);
        if (result.success) {
          autoApprovedCount++;
        }
      }

      console.log(`[WorkflowEngine] Checkpoint expiry check complete: ${autoApprovedCount} auto-approved`);
      return { processed: expiredCheckpoints.length, autoApproved: autoApprovedCount };
    } catch (error) {
      console.error('[WorkflowEngine] Error during checkpoint expiry check:', error);
      return { processed: 0, autoApproved: 0, error: error.message };
    }
  }

  /**
   * 查找所有过期的检查点
   * @private
   * @returns {Array} 过期检查点列表 [{storyId, checkpoint}]
   */
  async _findExpiredCheckpoints() {
    const expiredCheckpoints = [];
    const stories = await this.stateManager.listStories();

    if (!stories || stories.length === 0) {
      return expiredCheckpoints;
    }

    const now = Date.now();

    for (const storyId of stories) {
      try {
        const story = await this.stateManager.getStory(storyId);
        if (!story || !story.workflow) continue;

        const activeCheckpoint = story.workflow.activeCheckpoint;
        if (!activeCheckpoint) continue;

        if (activeCheckpoint.autoContinueOnTimeout && activeCheckpoint.expiresAt) {
          const expiresAt = new Date(activeCheckpoint.expiresAt).getTime();
          if (now > expiresAt) {
            expiredCheckpoints.push({ storyId, checkpoint: activeCheckpoint });
          }
        }
      } catch (err) {
        console.warn(`[WorkflowEngine] Error checking story ${storyId}:`, err.message);
      }
    }

    return expiredCheckpoints;
  }

  /**
   * 自动批准过期的检查点
   * @private
   * @param {string} storyId - 故事ID
   * @param {Object} checkpoint - 检查点对象
   * @returns {Object} 处理结果
   */
  async _autoApproveExpiredCheckpoint(storyId, checkpoint) {
    console.log(`[WorkflowEngine] Auto-approving expired checkpoint ${checkpoint.id} for story ${storyId}`);
    console.log(`[WorkflowEngine] Expired at: ${checkpoint.expiresAt}, Now: ${new Date().toISOString()}`);

    try {
      await this.stateManager.appendWorkflowHistory(storyId, {
        type: 'checkpoint_auto_approved',
        phase: checkpoint.phase,
        detail: {
          checkpointId: checkpoint.id,
          expiredAt: checkpoint.expiresAt,
          autoApprovedAt: new Date().toISOString(),
          reason: 'timeout'
        }
      });

      await this._notify(storyId, 'checkpoint_auto_approved', {
        storyId,
        checkpointId: checkpoint.id,
        phase: checkpoint.phase,
        expiredAt: checkpoint.expiresAt,
        autoApprovedAt: new Date().toISOString()
      });

      await this.stateManager.clearActiveCheckpoint(storyId);

      const currentPhase = checkpoint.phase;
      if (currentPhase === 'phase1') {
        await this.stateManager.updateWorkflow(storyId, { state: 'running' });
        await this._runPhase2(storyId);
      } else if (currentPhase === 'phase2') {
        await this.stateManager.updateWorkflow(storyId, { state: 'running' });
        await this._runPhase3(storyId);
      } else if (currentPhase === 'phase3') {
        await this._markCompleted(storyId);
      }

      console.log(`[WorkflowEngine] Successfully auto-approved checkpoint ${checkpoint.id}`);
      return { success: true, checkpointId: checkpoint.id };
    } catch (error) {
      console.error(`[WorkflowEngine] Failed to auto-approve checkpoint ${checkpoint.id}:`, error);
      return { success: false, checkpointId: checkpoint.id, error: error.message };
    }
  }

  /**
   * 启动工作流
   * @param {string} storyId - 故事ID
   * @returns {Object} 启动结果
   */
  async start(storyId) {
    console.log(`[WorkflowEngine] Starting workflow for story: ${storyId}`);

    // 1. 加载故事
    const story = await this.stateManager.getStory(storyId);
    if (!story) {
      return {
        status: 'error',
        error: `Story not found: ${storyId}`
      };
    }

    // 2. 检查是否已在运行或完成
    const currentState = story.workflow?.state;
    if (currentState === 'running') {
      return {
        status: 'error',
        error: `Workflow already running for story: ${storyId}`,
        currentState,
        currentPhase: story.workflow?.currentPhase
      };
    }

    if (currentState === 'completed') {
      return {
        status: 'error',
        error: `Workflow already completed for story: ${storyId}`,
        currentState
      };
    }

    if (story.phase1?.status === 'completed' || story.phase1?.userConfirmed) {
      console.warn(`[WorkflowEngine] Story ${storyId} has already progressed beyond phase1 (phase1.status=${story.phase1?.status}, userConfirmed=${story.phase1?.userConfirmed}). start() should not be called on existing stories. Use RecoverStoryWorkflow or RetryPhase instead.`);
      return {
        status: 'error',
        error: `Story has already progressed beyond phase1. Current recorded phase: ${story.workflow?.currentPhase}. Use RecoverStoryWorkflow or RetryPhase instead of start().`,
        currentPhase: story.workflow?.currentPhase,
        phase1Status: story.phase1?.status,
        phase1UserConfirmed: story.phase1?.userConfirmed
      };
    }

    // 3. 生成新的 runToken
    const runToken = uuidv4();

    // 4. 设置 workflow 状态为 running，currentPhase = phase1
    await this.stateManager.updateWorkflow(storyId, {
      state: 'running',
      currentPhase: 'phase1',
      currentStep: 'initial',
      retryContext: {
        phase: 'phase1',
        step: 'initial',
        attempt: 0,
        maxAttempts: this.retryConfig.maxAttempts,
        lastError: null
      },
      runToken
    });

    // 5. 更新故事状态
    await this.stateManager.updateStory(storyId, {
      status: 'phase1_running'
    });

    // 6. 发送启动通知
    await this._notify(storyId, 'workflow_started', {
      storyId,
      phase: 'phase1',
      runToken
    });

    // 7. 执行 Phase 1
    const phase1Result = await this.phases.phase1.run(storyId);

    // 8. 处理 Phase 1 返回结果
    return await this._processPhaseResult(storyId, 'phase1', phase1Result);
  }

  /**
   * 从检查点恢复
   * @param {string} storyId - 故事ID
   * @param {Object} decision - 决策对象
   * @param {string} decision.checkpointId - 检查点ID
   * @param {boolean} decision.approval - 是否批准
   * @param {string} decision.feedback - 反馈信息
   * @param {string} decision.reason - 原因
   * @returns {Object} 恢复结果
   */
  async resume(storyId, { checkpointId, approval, feedback, reason }) {
    console.log(`[WorkflowEngine] Resuming workflow for story: ${storyId}`);
    console.log(`[WorkflowEngine] Checkpoint: ${checkpointId}, approval: ${approval}`);

    // 1. 加载故事并验证检查点
    const story = await this.stateManager.getStory(storyId);
    if (!story) {
      return {
        status: 'error',
        error: `Story not found: ${storyId}`
      };
    }

    // 2. 验证 checkpointId 匹配
    const activeCheckpoint = story.workflow?.activeCheckpoint;
    if (activeCheckpoint && activeCheckpoint.id !== checkpointId) {
      return {
        status: 'error',
        error: `Checkpoint mismatch. Expected: ${activeCheckpoint.id}, Got: ${checkpointId}`,
        activeCheckpointId: activeCheckpoint.id
      };
    }

    // 3. 检查检查点是否超时并自动批准
    if (activeCheckpoint?.expiresAt && activeCheckpoint?.autoContinueOnTimeout) {
      const now = Date.now();
      const expiresAt = new Date(activeCheckpoint.expiresAt).getTime();
      if (now > expiresAt) {
        console.log(`[WorkflowEngine] Checkpoint ${checkpointId} expired, auto-approving`);
        console.log(`[WorkflowEngine] Expired at: ${activeCheckpoint.expiresAt}, Now: ${new Date().toISOString()}`);
        
        // 记录到历史
        await this.stateManager.appendWorkflowHistory(storyId, {
          type: 'checkpoint_auto_approved',
          phase: activeCheckpoint.phase,
          detail: {
            checkpointId: activeCheckpoint.id,
            expiredAt: activeCheckpoint.expiresAt,
            autoApprovedAt: new Date().toISOString(),
            reason: 'timeout'
          }
        });

        // 发送超时自动批准通知
        await this._notify(storyId, 'checkpoint_auto_approved', {
          storyId,
          checkpointId: activeCheckpoint.id,
          phase: activeCheckpoint.phase,
          expiredAt: activeCheckpoint.expiresAt,
          autoApprovedAt: new Date().toISOString()
        });

        // 清除活跃检查点
        await this.stateManager.clearActiveCheckpoint(storyId);

        // 继续下一阶段
        const currentPhase = activeCheckpoint.phase;
        if (currentPhase === 'phase1') {
          await this.stateManager.updateWorkflow(storyId, { state: 'running' });
          return await this._runPhase2(storyId);
        }
        if (currentPhase === 'phase2') {
          await this.stateManager.updateWorkflow(storyId, { state: 'running' });
          return await this._runPhase3(storyId);
        }
        if (currentPhase === 'phase3') {
          return await this._markCompleted(storyId);
        }
      }
    }

    // 4. 获取当前 phase - 优先从 activeCheckpoint 获取
    const currentPhase = activeCheckpoint?.phase || story.workflow?.currentPhase;
    if (!currentPhase) {
      return {
        status: 'error',
        error: 'No current phase in workflow'
      };
    }

    // 5. 发送恢复开始通知
    await this._notify(storyId, 'workflow_resuming', {
      storyId,
      checkpointId,
      approval,
      currentPhase
    });

    // 6. 根据 approval 处理
    if (approval) {
      return await this._handleApproval(storyId, currentPhase, checkpointId, feedback);
    } else {
      return await this._handleRejection(storyId, currentPhase, checkpointId, feedback, reason);
    }
  }

  /**
   * 崩溃恢复
   * @param {string} storyId - 故事ID
   * @param {Object} options - 恢复选项
   * @param {string} options.recoveryAction - 恢复动作: continue, restart_phase, rollback
   * @param {string} options.targetPhase - 目标阶段 (phase1, phase2, phase3)
   * @param {string} options.targetCheckpoint - 目标检查点ID
   * @param {string} options.feedback - 反馈信息
   * @returns {Object} 恢复结果
   */
  async recover(storyId, options = {}) {
    console.log(`[WorkflowEngine] Attempting recovery for story: ${storyId}`);
    console.log(`[WorkflowEngine] Recovery options:`, options);

    const { recoveryAction = 'continue', targetPhase, targetCheckpoint, feedback } = options;

    // 1. 加载故事
    const story = await this.stateManager.getStory(storyId);
    if (!story) {
      return {
        status: 'error',
        error: `Story not found: ${storyId}`
      };
    }

    const workflow = story.workflow || {};
    const currentPhase = workflow.currentPhase;

    // 2. 处理不同恢复动作
    if (recoveryAction === 'restart_phase') {
      return await this._handleRestartPhase(storyId, targetPhase, story);
    }

    if (recoveryAction === 'rollback') {
      return await this._handleRollback(storyId, targetCheckpoint, story);
    }

    // 3. continue - 从当前状态继续 (默认行为)
    return await this._handleContinue(storyId, story, workflow, currentPhase, feedback);
  }

  /**
   * 处理 continue 恢复动作 - 从当前状态继续
   * @private
   */
  async _handleContinue(storyId, story, workflow, currentPhase, feedback) {
    // 如果已完成或 idle
    if (workflow.state === 'completed') {
      return {
        status: 'success',
        message: 'Workflow already completed',
        currentPhase,
        state: 'completed'
      };
    }

    if (workflow.state === 'idle') {
      return {
        status: 'success',
        message: 'Workflow is idle, can start fresh',
        currentPhase,
        state: 'idle'
      };
    }

    // 生成新的 runToken
    const recoveryRunToken = uuidv4();

    // 发送恢复开始通知
    await this._notify(storyId, 'workflow_recovery_started', {
      storyId,
      previousState: workflow.state,
      currentPhase,
      recoveryRunToken,
      recoveryAction: 'continue'
    });

    // 恢复重试上下文
    await this.stateManager.updateWorkflow(storyId, {
      state: 'running',
      runToken: recoveryRunToken,
      retryContext: {
        ...workflow.retryContext,
        attempt: 0,
        lastError: 'Recovered from crash'
      }
    });

    // 记录反馈如果有的话
    if (feedback) {
      await this.stateManager.recordPhaseFeedback(storyId, currentPhase, feedback);
    }

    // 根据当前 phase 继续执行
    if (currentPhase === 'phase1') {
      if (story.phase1?.userConfirmed || story.phase1?.status === 'pending_confirmation') {
        return await this._runPhase2(storyId);
      }
      return await this._runPhase1(storyId);
    }

    if (currentPhase === 'phase2') {
      if (story.phase2?.userConfirmed && story.phase2?.outline &&
          (!story.phase2?.chapters || story.phase2.chapters.length === 0) &&
          story.phase2?.status !== 'completed') {
        console.log(`[WorkflowEngine] Phase2 has approved outline but no chapters, re-entering content production`);
        return await this._runPhase2(storyId);
      }
      if (story.phase2?.userConfirmed || story.phase2?.status === 'completed') {
        return await this._runPhase3(storyId);
      }
      return await this._runPhase2(storyId);
    }

    if (currentPhase === 'phase3') {
      if (story.phase3?.userConfirmed || story.phase3?.status === 'completed') {
        await this._markCompleted(storyId);
        return {
          status: 'completed',
          message: 'Workflow recovered and completed',
          storyId
        };
      }
      return await this._runPhase3(storyId);
    }

    // 未知 phase，尝试从 Phase1 重新开始
    return await this._runPhase1(storyId);
  }

  /**
   * 处理 restart_phase 恢复动作 - 重新运行指定阶段
   * @private
   */
  async _handleRestartPhase(storyId, targetPhase, story) {
    // 验证 targetPhase
    if (!targetPhase || !['phase1', 'phase2', 'phase3'].includes(targetPhase)) {
      return {
        status: 'error',
        error: 'Invalid or missing target_phase. Must be phase1, phase2, or phase3'
      };
    }

    console.log(`[WorkflowEngine] Restarting phase ${targetPhase} for story: ${storyId}`);

    // 清除后续阶段的完成标记，以便重新执行
    if (targetPhase === 'phase1') {
      // 重启 phase1 需要清除 phase1 和后续阶段的数据
      await this.stateManager.updatePhase1(storyId, {
        worldview: null,
        characters: [],
        validation: null,
        userConfirmed: false,
        checkpointId: null,
        status: 'running'
      });
      await this.stateManager.updatePhase2(storyId, {
        outline: null,
        chapters: [],
        currentChapter: 0,
        userConfirmed: false,
        checkpointId: null,
        status: 'pending'
      });
      await this.stateManager.updatePhase3(storyId, {
        polishedChapters: [],
        finalValidation: null,
        iterationCount: 0,
        userConfirmed: false,
        checkpointId: null,
        status: 'pending'
      });
    } else if (targetPhase === 'phase2') {
      await this.stateManager.updatePhase2(storyId, {
        outline: null,
        chapters: [],
        currentChapter: 0,
        userConfirmed: false,
        checkpointId: null,
        status: 'pending'
      });
      await this.stateManager.updatePhase3(storyId, {
        polishedChapters: [],
        finalValidation: null,
        iterationCount: 0,
        userConfirmed: false,
        checkpointId: null,
        status: 'pending'
      });
    } else if (targetPhase === 'phase3') {
      // 重启 phase3 只清除 phase3 的数据，保留 phase1 和 phase2
      await this.stateManager.updatePhase3(storyId, {
        polishedChapters: [],
        finalValidation: null,
        iterationCount: 0,
        userConfirmed: false,
        checkpointId: null,
        status: 'pending'
      });
    }

    await this.stateManager.clearActiveCheckpoint(storyId);

    const recoveryRunToken = uuidv4();

    await this._notify(storyId, 'workflow_recovery_started', {
      storyId,
      previousState: story.workflow?.state,
      currentPhase: targetPhase,
      recoveryRunToken,
      recoveryAction: 'restart_phase',
      targetPhase
    });

    // 更新 workflow 状态
    await this.stateManager.updateWorkflow(storyId, {
      state: 'running',
      currentPhase: targetPhase,
      runToken: recoveryRunToken,
      retryContext: {
        phase: targetPhase,
        step: 'restart',
        attempt: 0,
        maxAttempts: this.retryConfig.maxAttempts,
        lastError: 'Manual restart requested'
      }
    });

    // 更新故事状态
    await this.stateManager.updateStory(storyId, {
      status: `${targetPhase}_running`
    });

    // 记录到历史
    await this.stateManager.appendWorkflowHistory(storyId, {
      type: 'phase_restart',
      phase: targetPhase,
      detail: { reason: 'Manual restart via recovery_action=restart_phase' }
    });

    let result;
    if (targetPhase === 'phase1') {
      result = await this._runPhase1(storyId);
    } else if (targetPhase === 'phase2') {
      result = await this._runPhase2(storyId);
    } else if (targetPhase === 'phase3') {
      result = await this._runPhase3(storyId);
    } else {
      return {
        status: 'error',
        error: `Unknown phase: ${targetPhase}`
      };
    }

    const persistedStory = await this.stateManager.getStory(storyId);
    if (result.status === 'waiting_checkpoint' && persistedStory) {
      const hasCheckpointMismatch = persistedStory.workflow?.activeCheckpoint?.id !== result.checkpointId;
      const hasStatusMismatch = persistedStory.status !== `${targetPhase}_waiting_checkpoint`;
      if (hasCheckpointMismatch || hasStatusMismatch) {
        console.error(`[WorkflowEngine] State inconsistency detected after restart_phase for ${storyId}. ` +
          `Checkpoint: expected ${result.checkpointId}, got ${persistedStory.workflow?.activeCheckpoint?.id}. ` +
          `Status: expected ${targetPhase}_waiting_checkpoint, got ${persistedStory.status}`);
        return {
          status: 'error',
          error: `State inconsistency after restart_phase: persisted state does not match computed result`,
          checkpointMismatch: hasCheckpointMismatch,
          statusMismatch: hasStatusMismatch
        };
      }
    }

    return result;
  }

  /**
   * 处理 rollback 恢复动作 - 回滚到指定检查点
   * @private
   */
  async _handleRollback(storyId, targetCheckpoint, story) {
    console.log(`[WorkflowEngine] Rolling back story: ${storyId} to checkpoint: ${targetCheckpoint}`);

    // 确定目标检查点
    let targetPhase = null;
    let checkpointId = targetCheckpoint;

    if (!checkpointId) {
      const approvedCheckpoints = this.stateManager.repository.getApprovedCheckpoints(storyId, 1);

      if (approvedCheckpoints && approvedCheckpoints.length > 0) {
        const latestApproved = approvedCheckpoints[0];
        targetPhase = latestApproved.phase_name;
        checkpointId = latestApproved.checkpoint_id;
      } else {
        return {
          status: 'error',
          error: 'No valid checkpoint found to rollback to'
        };
      }
    } else {
      const explicitCheckpoint = this.stateManager.repository.getCheckpoint(checkpointId);
      if (explicitCheckpoint) {
        targetPhase = explicitCheckpoint.phase_name;
      } else {
        return {
          status: 'error',
          error: 'Checkpoint not found'
        };
      }
    }

    console.log(`[WorkflowEngine] Rollback target: phase=${targetPhase}, checkpoint=${checkpointId}`);

    const checkpointRow = this.stateManager.repository.getCheckpoint(checkpointId);
    const rollbackSnapshotId = checkpointRow ? checkpointRow.snapshot_id : null;

    await this.stateManager.clearActiveCheckpoint(storyId);

    const refreshedStory = await this.stateManager.getStory(storyId);
    if (!refreshedStory) {
      return { status: 'error', error: 'Story not found during rollback' };
    }

    const repoUpdates = {};
    if (targetPhase === 'phase1' || !targetPhase) {
      refreshedStory.phase1 = {
        ...refreshedStory.phase1,
        userConfirmed: false,
        checkpointId: checkpointId,
        status: 'running'
      };
      refreshedStory.phase2 = {
        ...refreshedStory.phase2,
        outline: null,
        chapters: [],
        currentChapter: 0,
        userConfirmed: false,
        checkpointId: null,
        status: 'pending'
      };
      refreshedStory.phase3 = {
        ...refreshedStory.phase3,
        polishedChapters: [],
        finalValidation: null,
        iterationCount: 0,
        userConfirmed: false,
        checkpointId: null,
        status: 'pending'
      };
      repoUpdates.current_phase1_snapshot_id = rollbackSnapshotId;
      repoUpdates.current_phase2_snapshot_id = null;
      repoUpdates.current_phase3_snapshot_id = null;
    } else if (targetPhase === 'phase2') {
      refreshedStory.phase2 = {
        ...refreshedStory.phase2,
        chapters: [],
        currentChapter: 0,
        userConfirmed: false,
        checkpointId: checkpointId,
        status: 'pending'
      };
      refreshedStory.phase3 = {
        ...refreshedStory.phase3,
        polishedChapters: [],
        finalValidation: null,
        iterationCount: 0,
        userConfirmed: false,
        checkpointId: null,
        status: 'pending'
      };
      repoUpdates.current_phase2_snapshot_id = rollbackSnapshotId;
      repoUpdates.current_phase3_snapshot_id = null;
    } else if (targetPhase === 'phase3') {
      refreshedStory.phase3 = {
        ...refreshedStory.phase3,
        polishedChapters: [],
        finalValidation: null,
        iterationCount: 0,
        userConfirmed: false,
        checkpointId: checkpointId,
        status: 'pending'
      };
      repoUpdates.current_phase3_snapshot_id = rollbackSnapshotId;
    }

    await this.stateManager.updateStory(storyId, refreshedStory, repoUpdates);

    // 生成新的 runToken
    const recoveryRunToken = uuidv4();

    // 发送回滚通知
    await this._notify(storyId, 'workflow_rollback', {
      storyId,
      previousState: story.workflow?.state,
      targetPhase,
      checkpointId,
      recoveryRunToken
    });

    // 更新 workflow 状态
    await this.stateManager.updateWorkflow(storyId, {
      state: 'running',
      currentPhase: targetPhase || 'phase1',
      runToken: recoveryRunToken,
      retryContext: {
        phase: targetPhase || 'phase1',
        step: 'rollback',
        attempt: 0,
        maxAttempts: this.retryConfig.maxAttempts,
        lastError: 'Rollback to checkpoint'
      }
    });

    // 更新故事状态
    await this.stateManager.updateStory(storyId, {
      status: `${targetPhase || 'phase1'}_rollback`
    });

    // 记录到历史
    await this.stateManager.appendWorkflowHistory(storyId, {
      type: 'rollback',
      phase: targetPhase,
      detail: { checkpointId, reason: 'Manual rollback via recovery_action=rollback' }
    });

    // 执行对应阶段
    if (targetPhase === 'phase1') {
      return await this._runPhase1(storyId);
    }
    if (targetPhase === 'phase2') {
      return await this._runPhase2(storyId);
    }
    if (targetPhase === 'phase3') {
      return await this._runPhase3(storyId);
    }

    return await this._runPhase1(storyId);
  }

  /**
   * 重试指定 Phase
   * @param {string} storyId - 故事ID
   * @param {string} phaseName - Phase 名称 (phase1, phase2, phase3)
   * @param {string} reason - 重试原因
   * @returns {Object} 重试结果
   */
  async retryPhase(storyId, phaseName, reason) {
    console.log(`[WorkflowEngine] Retrying phase ${phaseName} for story: ${storyId}, reason: ${reason}`);

    if (!this.retryConfig.retryOnPhases.includes(phaseName)) {
      return {
        status: 'error',
        error: `Invalid phase name: ${phaseName}`,
        validPhases: this.retryConfig.retryOnPhases
      };
    }

    const story = await this.stateManager.getStory(storyId);
    if (!story) {
      return {
        status: 'error',
        error: `Story not found: ${storyId}`
      };
    }

    const phaseState = story[phaseName];
    if (phaseState?.status === 'completed' || phaseState?.userConfirmed) {
      return {
        status: 'error',
        error: `Cannot retry ${phaseName} because it has already been completed. Use RecoverStoryWorkflow with restart_phase=${phaseName} if you want to regenerate from scratch.`,
        phase: phaseName,
        phaseStatus: phaseState?.status,
        userConfirmed: phaseState?.userConfirmed
      };
    }

    const retryContext = story.workflow?.retryContext || {};
    const currentAttempt = (retryContext.attempt || 0) + 1;

    // 3. 检查是否超过最大重试次数
    if (currentAttempt > this.retryConfig.maxAttempts) {
      return {
        status: 'failed',
        error: `Max retry attempts (${this.retryConfig.maxAttempts}) exceeded for ${phaseName}`,
        attempt: currentAttempt,
        maxAttempts: this.retryConfig.maxAttempts,
        lastError: retryContext.lastError
      };
    }

    // 4. 获取退避延迟
    const backoffDelay = this.retryConfig.backoffDelays[
      Math.min(currentAttempt - 1, this.retryConfig.backoffDelays.length - 1)
    ];

    // 5. 更新重试上下文
    await this.stateManager.updateWorkflow(storyId, {
      state: 'running',
      currentPhase: phaseName,
      retryContext: {
        phase: phaseName,
        step: retryContext.step || 'retry',
        attempt: currentAttempt,
        maxAttempts: this.retryConfig.maxAttempts,
        lastError: reason
      }
    });

    // 6. 发送重试通知
    await this._notify(storyId, 'phase_retry', {
      storyId,
      phaseName,
      attempt: currentAttempt,
      maxAttempts: this.retryConfig.maxAttempts,
      reason,
      backoffDelay
    });

    // 7. 如果有退避延迟，等待
    if (backoffDelay > 0) {
      console.log(`[WorkflowEngine] Waiting ${backoffDelay}ms before retry...`);
      await this._sleep(backoffDelay);
    }

    // 8. 执行对应 phase
    if (phaseName === 'phase1') {
      return await this._runPhase1(storyId);
    }
    if (phaseName === 'phase2') {
      return await this._runPhase2(storyId);
    }
    if (phaseName === 'phase3') {
      return await this._runPhase3(storyId);
    }

    return {
      status: 'error',
      error: `Unknown phase: ${phaseName}`
    };
  }

  // ==================== 私有方法 ====================

  /**
   * 运行 Phase 1
   * @private
   */
  async _runPhase1(storyId) {
    console.log(`[WorkflowEngine] Running Phase 1 for story: ${storyId}`);

    // 更新 workflow 状态
    await this.stateManager.updateWorkflow(storyId, {
      currentPhase: 'phase1',
      currentStep: 'worldbuilding'
    });

    // 执行 Phase 1
    const phase1Result = await this.phases.phase1.run(storyId);

    // 处理返回结果
    return await this._processPhaseResult(storyId, 'phase1', phase1Result);
  }

  /**
   * 运行 Phase 2
   * @private
   */
  async _runPhase2(storyId) {
    console.log(`[WorkflowEngine] Running Phase 2 for story: ${storyId}`);

    // 更新 workflow 状态
    await this.stateManager.updateWorkflow(storyId, {
      currentPhase: 'phase2',
      currentStep: 'outline_drafting'
    });

    // 检查 phase2 是否有 continueFromCheckpoint 方法
    const story = await this.stateManager.getStory(storyId);
    const phase2NeedsResume = story.phase2?.checkpointId && !story.phase2?.userConfirmed;

    let phase2Result;
    if (phase2NeedsResume) {
      // 需要从检查点继续
      phase2Result = await this.phases.phase2.continueFromCheckpoint(storyId, 'approve', null);
    } else {
      // 正常执行
      phase2Result = await this.phases.phase2.run(storyId);
    }

    // 处理返回结果
    return await this._processPhaseResult(storyId, 'phase2', phase2Result);
  }

  /**
   * 运行 Phase 3
   * @private
   */
  async _runPhase3(storyId) {
    console.log(`[WorkflowEngine] Running Phase 3 for story: ${storyId}`);

    // 验证 Phase2 完成状态
    const story = await this.stateManager.getStory(storyId);
    const phase2 = story.phase2 || {};
    
    // 检查是否有可用的章节
    const hasChapters = phase2.chapters && phase2.chapters.length > 0;
    const phase2Completed = phase2.status === 'completed' || phase2.userConfirmed;
    
    if (!hasChapters || !phase2Completed) {
      console.error(`[WorkflowEngine] Cannot start Phase3: Phase2 incomplete or no chapters`);
      return {
        status: 'failed',
        phase: 'phase3',
        error: 'Phase2 has no approved chapters or is not completed',
        data: { hasChapters, phase2Status: phase2.status, userConfirmed: phase2.userConfirmed }
      };
    }

    // 更新 workflow 状态
    await this.stateManager.updateWorkflow(storyId, {
      currentPhase: 'phase3',
      currentStep: 'refinement'
    });

    // 检查 phase3 是否有 continueFromCheckpoint 方法
    const phase3NeedsResume = story.phase3?.checkpointId && !story.phase3?.userConfirmed;

    let phase3Result;
    if (phase3NeedsResume) {
      // 需要从检查点继续
      phase3Result = await this.phases.phase3.continueFromCheckpoint(storyId, 'approve', null);
    } else {
      // 正常执行
      phase3Result = await this.phases.phase3.run(storyId);
    }

    // 处理返回结果
    return await this._processPhaseResult(storyId, 'phase3', phase3Result);
  }

  /**
   * 处理 Phase 执行结果
   * @private
   */
  async _processPhaseResult(storyId, phaseName, result) {
    console.log(`[WorkflowEngine] Processing result for ${phaseName}:`, result.status);

    switch (result.status) {
      case 'completed':
        // Phase 完成，调用下一 phase
        return await this._handlePhaseCompleted(storyId, phaseName, result);

      case 'waiting_checkpoint':
        // 等待检查点，更新状态并通知
        return await this._handleWaitingCheckpoint(storyId, phaseName, result);

      case 'needs_retry':
        // 需要重试
        return await this._handleNeedsRetry(storyId, phaseName, result);

      case 'failed':
        // 失败
        return await this._handlePhaseFailed(storyId, phaseName, result);

      case 'error':
        // 错误
        return await this._handlePhaseError(storyId, phaseName, result);

      default:
        console.warn(`[WorkflowEngine] Unknown result status: ${result.status}`);
        return result;
    }
  }

  /**
   * 处理 Phase 完成
   * @private
   */
  async _handlePhaseCompleted(storyId, completedPhase, result) {
    console.log(`[WorkflowEngine] Phase ${completedPhase} completed`);

    // 记录到历史
    await this.stateManager.appendWorkflowHistory(storyId, {
      type: 'phase_completed',
      phase: completedPhase,
      detail: result.data || {}
    });

    // 发送通知
    await this._notify(storyId, 'phase_completed', {
      storyId,
      completedPhase,
      data: result.data
    });

    // 根据完成的 phase 决定下一步
    if (completedPhase === 'phase1') {
      // 继续 Phase 2
      return await this._runPhase2(storyId);
    }

    if (completedPhase === 'phase2') {
      // 继续 Phase 3
      return await this._runPhase3(storyId);
    }

    if (completedPhase === 'phase3') {
      // 全部完成
      return await this._markCompleted(storyId);
    }

    return result;
  }

  /**
   * 处理等待检查点
   * @private
   */
  async _handleWaitingCheckpoint(storyId, phaseName, result) {
    console.log(`[WorkflowEngine] ${phaseName} waiting for checkpoint: ${result.checkpointId}`);

    const timeoutMs = this.config.USER_CHECKPOINT_TIMEOUT_MS || 86400000;
    const expiresAt = new Date(Date.now() + timeoutMs).toISOString();

    const checkpointType = result.checkpointType || `${phaseName}_checkpoint`;

    await this.stateManager.setActiveCheckpoint(storyId, {
      id: result.checkpointId,
      phase: phaseName,
      type: checkpointType,
      status: 'pending',
      createdAt: new Date().toISOString(),
      expiresAt,
      autoContinueOnTimeout: true
    });

    // 更新 workflow 状态
    await this.stateManager.updateWorkflow(storyId, {
      state: 'waiting_checkpoint',
      currentPhase: phaseName,
      currentStep: 'checkpoint'
    });

    // 更新故事状态
    await this.stateManager.updateStory(storyId, {
      status: `${phaseName}_waiting_checkpoint`
    });

    // 记录到历史
    await this.stateManager.appendWorkflowHistory(storyId, {
      type: 'checkpoint_created',
      phase: phaseName,
      detail: {
        checkpointId: result.checkpointId,
        data: result.data
      }
    });

    // 发送通知
    await this._notify(storyId, 'checkpoint_pending', {
      storyId,
      phase: phaseName,
      checkpointId: result.checkpointId,
      data: result.data
    });

    return {
      status: 'waiting_checkpoint',
      phase: phaseName,
      checkpointId: result.checkpointId,
      data: result.data,
      message: `等待检查点确认: ${result.checkpointId}`
    };
  }

  /**
   * 处理需要重试
   * @private
   */
  async _handleNeedsRetry(storyId, phaseName, result) {
    console.log(`[WorkflowEngine] ${phaseName} needs retry`);

    // 获取当前重试次数
    const story = await this.stateManager.getStory(storyId);
    const retryContext = story.workflow?.retryContext || {};
    const currentAttempt = retryContext.attempt || 0;

    // 检查是否超过最大重试次数
    if (currentAttempt >= this.retryConfig.maxAttempts) {
      return await this._handlePhaseFailed(storyId, phaseName, {
        ...result,
        error: `Max retry attempts exceeded: ${result.data?.error || 'Unknown error'}`
      });
    }

    // 触发重试
    return await this.retryPhase(storyId, phaseName, result.data?.error || 'Validation failed');
  }

  /**
   * 处理 Phase 失败
   * @private
   */
  async _handlePhaseFailed(storyId, phaseName, result) {
    console.error(`[WorkflowEngine] Phase ${phaseName} failed:`, result);

    const errorMessage = result instanceof Error
      ? result.message
      : (result.error || result.data?.error || 'Unknown error');
    const errorData = result instanceof Error
      ? { stack: result.stack, name: result.name }
      : result.data;

    await this.stateManager.updateWorkflow(storyId, {
      state: 'failed',
      retryContext: {
        ...(await this.stateManager.getStory(storyId)).workflow?.retryContext,
        lastError: errorMessage
      }
    });

    await this.stateManager.updateStory(storyId, {
      status: `${phaseName}_failed`
    });

    await this.stateManager.appendWorkflowHistory(storyId, {
      type: 'phase_failed',
      phase: phaseName,
      detail: {
        error: errorMessage,
        data: errorData
      }
    });

    await this._notify(storyId, 'phase_failed', {
      storyId,
      phase: phaseName,
      error: errorMessage,
      data: errorData
    });

    return {
      status: 'failed',
      phase: phaseName,
      error: errorMessage,
      data: errorData
    };
  }

  async _handlePhaseError(storyId, phaseName, result) {
    const errorMessage = result instanceof Error ? result.message : result.error;
    console.error(`[WorkflowEngine] Phase ${phaseName} error:`, errorMessage);

    return await this._handlePhaseFailed(storyId, phaseName, result);
  }

  /**
   * 处理批准
   * @private
   */
  async _handleApproval(storyId, currentPhase, checkpointId, feedback) {
    console.log(`[WorkflowEngine] Handling approval for ${currentPhase}`);

    // 获取检查点类型（在清除前读取）
    const story = await this.stateManager.getStory(storyId);
    const checkpointType = story.workflow?.activeCheckpoint?.type;
    const approvalTime = new Date().toISOString();

    // 标记检查点为已批准
    await this.stateManager.recordPhaseFeedback(storyId, currentPhase, feedback || 'Approved', 'approved');

    const checkpointRow = this.stateManager.repository.getCheckpoint(checkpointId);
    if (checkpointRow && checkpointRow.snapshot_id) {
      const validatedSnapshot = this.stateManager.repository.getSnapshot(checkpointRow.snapshot_id);
      if (validatedSnapshot) {
        const approvedSnapshotId = this.stateManager.repository.createSnapshot({
          story_id: storyId,
          phase_name: currentPhase,
          snapshot_type: 'approved',
          payload_json: validatedSnapshot.payload_json,
          schema_version: validatedSnapshot.schema_version,
          schema_valid: validatedSnapshot.schema_valid,
          created_from_attempt_id: validatedSnapshot.created_from_attempt_id
        });
        const repoUpdates = {};
        if (currentPhase === 'phase1') repoUpdates.current_phase1_snapshot_id = approvedSnapshotId;
        if (currentPhase === 'phase2') repoUpdates.current_phase2_snapshot_id = approvedSnapshotId;
        if (currentPhase === 'phase3') repoUpdates.current_phase3_snapshot_id = approvedSnapshotId;
        if (Object.keys(repoUpdates).length > 0) {
          await this.stateManager.updateStory(storyId, {}, repoUpdates);
        }
      }
    }

    // 清除活跃检查点
    await this.stateManager.clearActiveCheckpoint(storyId);

    // 记录到历史
    await this.stateManager.appendWorkflowHistory(storyId, {
      type: 'checkpoint_approved',
      phase: currentPhase,
      detail: { checkpointId, feedback }
    });

    // 发送批准通知
    await this._notify(storyId, 'checkpoint_approved', {
      storyId,
      phase: currentPhase,
      checkpointId,
      feedback
    });

    if (currentPhase === 'phase1') {
      await this.stateManager.updatePhase1(storyId, {
        userConfirmed: true,
        checkpointId: null,
        status: 'completed',
        approvedAt: approvalTime
      });
      await this.stateManager.updateWorkflow(storyId, {
        state: 'running',
        currentPhase: 'phase2',
        currentStep: 'approved_transition'
      });
      await this.stateManager.updateStory(storyId, {
        status: 'phase2_running'
      });

      void this._continueApprovedPhaseInBackground(storyId, 'phase2');

      return {
        status: 'running',
        phase: 'phase2',
        background: true,
        checkpointId,
        message: `Checkpoint ${checkpointId} approved, continuing phase2`
      };
    }

    if (currentPhase === 'phase2') {
      if (checkpointType === 'phase2_content_confirmation') {
        await this.stateManager.updatePhase2(storyId, {
          userConfirmed: true,
          checkpointId: null,
          status: 'completed',
          approvedAt: approvalTime
        });
        await this.stateManager.updateWorkflow(storyId, {
          state: 'running',
          currentPhase: 'phase3',
          currentStep: 'approved_transition'
        });
        await this.stateManager.updateStory(storyId, {
          status: 'phase3_running'
        });

        void this._continueApprovedPhaseInBackground(storyId, 'phase3');

        return {
          status: 'running',
          phase: 'phase3',
          background: true,
          checkpointId,
          message: `Checkpoint ${checkpointId} approved, continuing phase3`
        };
      } else {
        console.log(`[WorkflowEngine] Phase2 outline checkpoint approved, continuing to content production`);
        const storyForApproval = await this.stateManager.getStory(storyId);
        if (storyForApproval) {
          storyForApproval.phase2 = {
            ...storyForApproval.phase2,
            userConfirmed: true,
            checkpointId: null,
            status: 'content_production',
            approvedAt: approvalTime
          };
          await this.stateManager.updateStory(storyId, storyForApproval);
        }
        await this.stateManager.updateWorkflow(storyId, {
          state: 'running',
          currentPhase: 'phase2',
          currentStep: 'approved_transition'
        });
        await this.stateManager.updateStory(storyId, {
          status: 'phase2_running'
        });

        void this._continueApprovedPhaseInBackground(storyId, 'phase2');

        return {
          status: 'running',
          phase: 'phase2',
          background: true,
          checkpointId,
          message: `Checkpoint ${checkpointId} approved, continuing phase2`
        };
      }
    }

    if (currentPhase === 'phase3') {
      // Phase3 批准后完成
      return await this._markCompleted(storyId);
    }

    return {
      status: 'success',
      message: `Checkpoint ${checkpointId} approved`,
      currentPhase
    };
  }

  async _continueApprovedPhaseInBackground(storyId, nextPhase) {
    try {
      if (nextPhase === 'phase2') {
        await this._runPhase2(storyId);
        return;
      }

      if (nextPhase === 'phase3') {
        await this._runPhase3(storyId);
      }
    } catch (error) {
      console.error(`[WorkflowEngine] Background continuation failed for ${storyId} -> ${nextPhase}:`, error.message);
      await this._handlePhaseError(storyId, nextPhase, error);
    }
  }

  /**
   * 处理拒绝
   * @private
   */
  async _handleRejection(storyId, currentPhase, checkpointId, feedback, reason) {
    console.log(`[WorkflowEngine] Handling rejection for ${currentPhase}`);
    console.log(`[WorkflowEngine] Feedback: ${feedback}`);

    // 记录反馈
    await this.stateManager.recordPhaseFeedback(storyId, currentPhase, feedback || 'Rejected', 'rejected');

    // 记录到历史
    await this.stateManager.appendWorkflowHistory(storyId, {
      type: 'checkpoint_rejected',
      phase: currentPhase,
      detail: { checkpointId, feedback, reason }
    });

    // 发送拒绝通知
    await this._notify(storyId, 'checkpoint_rejected', {
      storyId,
      phase: currentPhase,
      checkpointId,
      feedback,
      reason
    });

    // 立刻更新状态，让用户可感知到系统正在重新生成
    await this.stateManager.clearActiveCheckpoint(storyId);

    const phaseStatusUpdate = {
      userConfirmed: false,
      checkpointId: null,
      status: 'retrying',
      lastRejectionFeedback: feedback || '',
      lastRejectedAt: new Date().toISOString()
    };

    if (currentPhase === 'phase1') {
      await this.stateManager.updatePhase1(storyId, phaseStatusUpdate);
    }
    if (currentPhase === 'phase2') {
      await this.stateManager.updatePhase2(storyId, phaseStatusUpdate);
    }
    if (currentPhase === 'phase3') {
      await this.stateManager.updatePhase3(storyId, phaseStatusUpdate);
    }

    await this.stateManager.updateWorkflow(storyId, {
      state: 'running',
      currentPhase,
      currentStep: 'retrying_after_rejection',
      retryContext: {
        ...(await this.stateManager.getStory(storyId)).workflow?.retryContext,
        lastError: reason || feedback || 'Checkpoint rejected by user'
      }
    });

    await this.stateManager.updateStory(storyId, {
      status: `${currentPhase}_retrying`
    });

    void this._rerunRejectedPhaseInBackground(storyId, currentPhase);

    return {
      status: 'retrying',
      phase: currentPhase,
      background: true,
      checkpointId,
      message: `Checkpoint ${checkpointId} rejected, re-running ${currentPhase}`
    };
  }

  async _rerunRejectedPhaseInBackground(storyId, currentPhase) {
    try {
      if (currentPhase === 'phase1') {
        await this._runPhase1(storyId);
        return;
      }
      if (currentPhase === 'phase2') {
        await this._runPhase2(storyId);
        return;
      }
      if (currentPhase === 'phase3') {
        await this._runPhase3(storyId);
      }
    } catch (error) {
      console.error(`[WorkflowEngine] Background rerun failed for ${storyId}/${currentPhase}:`, error);
      await this._handlePhaseError(storyId, currentPhase, {
        status: 'error',
        phase: currentPhase,
        error: error.message,
        data: { error: error.message }
      });
    }
  }

  /**
   * 标记工作流完成
   * @private
   */
  async _markCompleted(storyId) {
    console.log(`[WorkflowEngine] Workflow completed for story: ${storyId}`);

    // 更新 workflow 状态
    await this.stateManager.updateWorkflow(storyId, {
      state: 'completed',
      currentStep: null
    });

    // 更新故事状态
    await this.stateManager.updateStory(storyId, {
      status: 'completed'
    });

    // 清除活跃检查点
    await this.stateManager.clearActiveCheckpoint(storyId);

    // 记录到历史
    await this.stateManager.appendWorkflowHistory(storyId, {
      type: 'workflow_completed',
      detail: { completedAt: new Date().toISOString() }
    });

    // 发送完成通知
    await this._notify(storyId, 'workflow_completed', {
      storyId,
      completedAt: new Date().toISOString()
    });

    return {
      status: 'completed',
      storyId,
      message: 'Workflow completed successfully'
    };
  }

  /**
   * 发送 WebSocket 通知
   * @private
   */
  async _notify(storyId, eventType, payload) {
    const notification = {
      type: 'workflow_event',
      eventType,
      storyId,
      timestamp: new Date().toISOString(),
      payload
    };

    // 如果有 WebSocket 推送器，发送通知
    if (this.webSocketPusher && typeof this.webSocketPusher.push === 'function') {
      try {
        await this.webSocketPusher.push(storyId, notification);
        console.log(`[WorkflowEngine] WebSocket notification sent: ${eventType}`);
      } catch (error) {
        console.error(`[WorkflowEngine] Failed to send WebSocket notification:`, error);
      }
    }

    // 记录到控制台日志
    console.log(`[WorkflowEngine] Event: ${eventType}`, JSON.stringify(payload, null, 2));
  }

  /**
   * 睡眠工具函数
   * @private
   */
  _sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * 获取工作流状态
   * @param {string} storyId - 故事ID
   * @returns {Object} 工作流状态
   */
  async getWorkflowStatus(storyId) {
    const story = await this.stateManager.getStory(storyId);
    if (!story) {
      return null;
    }

    return {
      state: story.workflow?.state || 'idle',
      currentPhase: story.workflow?.currentPhase || null,
      currentStep: story.workflow?.currentStep || null,
      activeCheckpoint: story.workflow?.activeCheckpoint || null,
      retryContext: story.workflow?.retryContext || null,
      historyLength: story.workflow?.history?.length || 0,
      runToken: story.workflow?.runToken || null
    };
  }
}

module.exports = { WorkflowEngine };
