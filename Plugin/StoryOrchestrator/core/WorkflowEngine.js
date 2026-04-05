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

    // 初始化 Phase1
    this.phases.phase1 = new Phase1_WorldBuilding({
      stateManager: this.stateManager,
      agentDispatcher: this.agentDispatcher,
      promptBuilder: require('../utils/PromptBuilder'),
      config: this.config
    });

    // 初始化 Phase2
    this.phases.phase2 = new Phase2_OutlineDrafting({
      stateManager: this.stateManager,
      agentDispatcher: this.agentDispatcher,
      chapterOperations: this.chapterOperations,
      contentValidator: this.contentValidator,
      promptBuilder: require('../utils/PromptBuilder'),
      config: this.config
    });

    // 初始化 Phase3
    this.phases.phase3 = new Phase3_Refinement({
      stateManager: this.stateManager,
      agentDispatcher: this.agentDispatcher,
      chapterOperations: this.chapterOperations,
      contentValidator: this.contentValidator,
      promptBuilder: require('../utils/PromptBuilder'),
      config: this.config
    });

    this.initialized = true;
    console.log('[WorkflowEngine] Initialized successfully');
  }

  /**
   * 设置 WebSocket 推送器
   * @param {Object} pusher - WebSocket 推送器
   */
  setWebSocketPusher(pusher) {
    this.webSocketPusher = pusher;
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

    // 3. 获取当前 phase
    const currentPhase = story.workflow?.currentPhase;
    if (!currentPhase) {
      return {
        status: 'error',
        error: 'No current phase in workflow'
      };
    }

    // 4. 发送恢复开始通知
    await this._notify(storyId, 'workflow_resuming', {
      storyId,
      checkpointId,
      approval,
      currentPhase
    });

    // 5. 根据 approval 处理
    if (approval) {
      return await this._handleApproval(storyId, currentPhase, checkpointId, feedback);
    } else {
      return await this._handleRejection(storyId, currentPhase, checkpointId, feedback, reason);
    }
  }

  /**
   * 崩溃恢复
   * @param {string} storyId - 故事ID
   * @returns {Object} 恢复结果
   */
  async recover(storyId) {
    console.log(`[WorkflowEngine] Attempting recovery for story: ${storyId}`);

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

    // 2. 如果已完成或 idle，无需恢复
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

    // 3. 生成新的 runToken 表示恢复操作
    const recoveryRunToken = uuidv4();

    // 4. 发送恢复开始通知
    await this._notify(storyId, 'workflow_recovery_started', {
      storyId,
      previousState: workflow.state,
      currentPhase,
      recoveryRunToken
    });

    // 5. 恢复重试上下文
    await this.stateManager.updateWorkflow(storyId, {
      state: 'running',
      runToken: recoveryRunToken,
      retryContext: {
        ...workflow.retryContext,
        attempt: 0, // 重置尝试次数
        lastError: 'Recovered from crash'
      }
    });

    // 6. 根据当前 phase 继续执行
    if (currentPhase === 'phase1') {
      // Phase1 需要检查是否已完成
      if (story.phase1?.userConfirmed || story.phase1?.status === 'pending_confirmation') {
        // 跳过 Phase1，继续 Phase2
        return await this._runPhase2(storyId);
      }
      return await this._runPhase1(storyId);
    }

    if (currentPhase === 'phase2') {
      // Phase2 需要检查状态
      if (story.phase2?.userConfirmed || story.phase2?.status === 'completed') {
        // 跳过 Phase2，继续 Phase3
        return await this._runPhase3(storyId);
      }
      return await this._runPhase2(storyId);
    }

    if (currentPhase === 'phase3') {
      // Phase3 需要检查状态
      if (story.phase3?.userConfirmed || story.phase3?.status === 'completed') {
        // 跳过 Phase3，标记完成
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
   * 重试指定 Phase
   * @param {string} storyId - 故事ID
   * @param {string} phaseName - Phase 名称 (phase1, phase2, phase3)
   * @param {string} reason - 重试原因
   * @returns {Object} 重试结果
   */
  async retryPhase(storyId, phaseName, reason) {
    console.log(`[WorkflowEngine] Retrying phase ${phaseName} for story: ${storyId}, reason: ${reason}`);

    // 1. 验证 phaseName
    if (!this.retryConfig.retryOnPhases.includes(phaseName)) {
      return {
        status: 'error',
        error: `Invalid phase name: ${phaseName}`,
        validPhases: this.retryConfig.retryOnPhases
      };
    }

    // 2. 加载故事
    const story = await this.stateManager.getStory(storyId);
    if (!story) {
      return {
        status: 'error',
        error: `Story not found: ${storyId}`
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

    // 更新 workflow 状态
    await this.stateManager.updateWorkflow(storyId, {
      currentPhase: 'phase3',
      currentStep: 'refinement'
    });

    // 检查 phase3 是否有 continueFromCheckpoint 方法
    const story = await this.stateManager.getStory(storyId);
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

    // 设置活跃检查点
    await this.stateManager.setActiveCheckpoint(storyId, {
      id: result.checkpointId,
      phase: phaseName,
      type: `${phaseName}_checkpoint`,
      status: 'pending',
      createdAt: new Date().toISOString(),
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

    // 更新 workflow 状态为失败
    await this.stateManager.updateWorkflow(storyId, {
      state: 'failed',
      retryContext: {
        ...(await this.stateManager.getStory(storyId)).workflow?.retryContext,
        lastError: result.error || result.data?.error
      }
    });

    // 更新故事状态
    await this.stateManager.updateStory(storyId, {
      status: `${phaseName}_failed`
    });

    // 记录到历史
    await this.stateManager.appendWorkflowHistory(storyId, {
      type: 'phase_failed',
      phase: phaseName,
      detail: {
        error: result.error || result.data?.error,
        data: result.data
      }
    });

    // 发送失败通知
    await this._notify(storyId, 'phase_failed', {
      storyId,
      phase: phaseName,
      error: result.error || result.data?.error,
      data: result.data
    });

    return {
      status: 'failed',
      phase: phaseName,
      error: result.error || result.data?.error,
      data: result.data
    };
  }

  /**
   * 处理 Phase 错误
   * @private
   */
  async _handlePhaseError(storyId, phaseName, result) {
    console.error(`[WorkflowEngine] Phase ${phaseName} error:`, result.error);

    // 与失败处理类似
    return await this._handlePhaseFailed(storyId, phaseName, result);
  }

  /**
   * 处理批准
   * @private
   */
  async _handleApproval(storyId, currentPhase, checkpointId, feedback) {
    console.log(`[WorkflowEngine] Handling approval for ${currentPhase}`);

    // 标记检查点为已批准
    await this.stateManager.recordPhaseFeedback(storyId, currentPhase, feedback || 'Approved');

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

    // 根据当前 phase 继续下一阶段
    if (currentPhase === 'phase1') {
      // Phase1 批准后继续 Phase2
      await this.stateManager.updateWorkflow(storyId, {
        state: 'running'
      });
      return await this._runPhase2(storyId);
    }

    if (currentPhase === 'phase2') {
      // Phase2 批准后继续 Phase3
      await this.stateManager.updateWorkflow(storyId, {
        state: 'running'
      });
      return await this._runPhase3(storyId);
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

  /**
   * 处理拒绝
   * @private
   */
  async _handleRejection(storyId, currentPhase, checkpointId, feedback, reason) {
    console.log(`[WorkflowEngine] Handling rejection for ${currentPhase}`);
    console.log(`[WorkflowEngine] Feedback: ${feedback}`);

    // 记录反馈
    await this.stateManager.recordPhaseFeedback(storyId, currentPhase, feedback || 'Rejected');

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

    // 重新运行当前 phase
    await this.stateManager.updateWorkflow(storyId, {
      state: 'running'
    });

    if (currentPhase === 'phase1') {
      return await this._runPhase1(storyId);
    }
    if (currentPhase === 'phase2') {
      return await this._runPhase2(storyId);
    }
    if (currentPhase === 'phase3') {
      return await this._runPhase3(storyId);
    }

    return {
      status: 'success',
      message: `Checkpoint ${checkpointId} rejected, re-running ${currentPhase}`,
      currentPhase
    };
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
