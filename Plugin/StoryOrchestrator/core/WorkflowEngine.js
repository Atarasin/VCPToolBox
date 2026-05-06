'use strict';

const WORKFLOW_ENGINE_COMPATIBILITY_SURFACE = Object.freeze({
  id: 'workflow-engine',
  label: 'WorkflowEngine',
  modulePath: 'Plugin/StoryOrchestrator/core/WorkflowEngine.js',
  state: 'retain-as-shell',
  replacementPath: 'WorkflowKernel control plane via StoryOrchestratorKernelAdapter',
  rationale: 'Still exposes start/resume/recover/retry compatibility entrypoints and diagnostic delegation, but phase execution now belongs to WorkflowKernel and must not return to phase-class shells.',
  readinessNote: 'Retention of WorkflowEngine as a shell does not imply thin reference plugin readiness.'
});

/**
 * WorkflowEngine - StoryOrchestrator 的兼容工作流外壳。
 *
 * Compatibility surface state: `retain-as-shell`.
 *
 * phase-class shells 退役后，这个外壳只保留兼容入口、状态投影与
 * WorkflowKernel delegation，不再重新持有 phase-class runtime dependency。
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

    // Keep the historical flag readable for diagnostics, but runtime execution
    // now always prefers the adapter-backed control plane.
    this.useKernel = config.USE_WORKFLOW_KERNEL === 'true' || config.USE_WORKFLOW_KERNEL === true;
    this.kernelAdapter = null;

    // Retain an inert object so older tests can still stub properties without
    // reviving phase-class construction as a supported execution model.
    this.phases = {};

    this.retryConfig = {
      maxAttempts: this.config.MAX_PHASE_RETRY_ATTEMPTS || 3,
      backoffDelays: [0, 250, 1000],
      retryOnPhases: ['phase1', 'phase2', 'phase3']
    };

    this.webSocketPusher = null;
    this.initialized = false;
    this._expiryCheckTimer = null;
    this._expiryCheckIntervalMs = this.config.CHECKPOINT_EXPIRY_CHECK_INTERVAL_MS || 60000;
  }

  _hasKernelControlPlane() {
    return Boolean(this.kernelAdapter);
  }

  bindKernelAdapter(kernelAdapter) {
    this.kernelAdapter = kernelAdapter || null;
    return this;
  }

  createLegacyEventListener() {
    return async (workflowId, event) => {
      await this._notify(workflowId, event.eventType, event.payload);
    };
  }

  getCompatibilitySurfaceReport() {
    return [WorkflowEngine.compatibilitySurface];
  }

  getCompatibilitySurface(surfaceId) {
    return surfaceId === WorkflowEngine.compatibilitySurface.id
      ? WorkflowEngine.compatibilitySurface
      : null;
  }

  async initialize() {
    if (this.initialized) {
      console.log('[WorkflowEngine] Already initialized');
      return;
    }

    console.log('[WorkflowEngine] Initializing...');

    if (this.stateManager && typeof this.stateManager.initialize === 'function') {
      await this.stateManager.initialize();
    }

    if (this._hasKernelControlPlane() && typeof this.kernelAdapter.initialize === 'function') {
      await this.kernelAdapter.initialize();
    }

    this.initialized = true;
    console.log('[WorkflowEngine] Initialized successfully');
    this._startExpiryCheckTimer();
  }

  setWebSocketPusher(pusher) {
    this.webSocketPusher = pusher;
  }

  _startExpiryCheckTimer() {
    if (this._expiryCheckTimer) {
      clearInterval(this._expiryCheckTimer);
    }

    this._expiryCheckTimer = setInterval(async () => {
      await this.checkExpiredCheckpoints();
    }, this._expiryCheckIntervalMs);

    if (typeof this._expiryCheckTimer.unref === 'function') {
      this._expiryCheckTimer.unref();
    }

    console.log(`[WorkflowEngine] Expiry check timer started (interval: ${this._expiryCheckIntervalMs}ms)`);
  }

  _stopExpiryCheckTimer() {
    if (this._expiryCheckTimer) {
      clearInterval(this._expiryCheckTimer);
      this._expiryCheckTimer = null;
      console.log('[WorkflowEngine] Expiry check timer stopped');
    }
  }

  async shutdown() {
    this._stopExpiryCheckTimer();
  }

  async checkExpiredCheckpoints() {
    console.log('[WorkflowEngine] Running scheduled checkpoint expiry check...');

    try {
      if (this._hasKernelControlPlane()) {
        console.log('[WorkflowEngine] Checkpoint timeout continuation is kernel-owned; skipping legacy expiry scan');
        return { processed: 0, autoApproved: 0, mode: 'kernel' };
      }

      return {
        processed: 0,
        autoApproved: 0,
        mode: 'retired-phase-shell',
        error: 'WorkflowKernel control plane is unavailable; retired phase-class timeout fallback is no longer supported'
      };
    } catch (error) {
      console.error('[WorkflowEngine] Error during checkpoint expiry check:', error);
      return { processed: 0, autoApproved: 0, error: error.message };
    }
  }

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

  async start(storyId) {
    console.log(`[WorkflowEngine] Starting workflow for story: ${storyId}`);

    const story = await this.stateManager.getStory(storyId);
    if (!story) {
      return {
        status: 'error',
        error: `Story not found: ${storyId}`
      };
    }

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

    if (!this._hasKernelControlPlane()) {
      return this._retiredShellError('start');
    }

    console.log('[WorkflowEngine] Delegating workflow start to WorkflowKernel control plane');
    return this._delegateControlPlaneAction(storyId, async () => {
      return this.kernelAdapter.executeWorkflow(storyId, this._buildWorkflowStartContext(story));
    }, {
      fallbackPhase: 'phase1'
    });
  }

  async resume(storyId, { checkpointId, approval, feedback, reason, chapter_number }) {
    console.log(`[WorkflowEngine] Resuming workflow for story: ${storyId}`);
    console.log(`[WorkflowEngine] Checkpoint: ${checkpointId}, approval: ${approval}`);

    const story = await this.stateManager.getStory(storyId);
    if (!story) {
      return {
        status: 'error',
        error: `Story not found: ${storyId}`
      };
    }

    const activeCheckpoint = story.workflow?.activeCheckpoint;
    if (activeCheckpoint && activeCheckpoint.id !== checkpointId) {
      return {
        status: 'error',
        error: `Checkpoint mismatch. Expected: ${activeCheckpoint.id}, Got: ${checkpointId}`,
        activeCheckpointId: activeCheckpoint.id
      };
    }

    if (!this._hasKernelControlPlane()) {
      return this._retiredShellError('resume');
    }

    return this._delegateControlPlaneAction(storyId, async () => {
      return this.kernelAdapter.resume(storyId, {
        checkpointId,
        approval,
        feedback,
        reason,
        chapter_number
      });
    }, {
      fallbackPhase: activeCheckpoint?.phase || story.workflow?.currentPhase || null
    });
  }

  async recover(storyId, options = {}) {
    console.log(`[WorkflowEngine] Attempting recovery for story: ${storyId}`);
    console.log('[WorkflowEngine] Recovery options:', options);

    const story = await this.stateManager.getStory(storyId);
    if (!story) {
      return {
        status: 'error',
        error: `Story not found: ${storyId}`
      };
    }

    if (!this._hasKernelControlPlane()) {
      return this._retiredShellError('recover');
    }

    return this._delegateControlPlaneAction(storyId, async () => {
      return this.kernelAdapter.recover(storyId, options);
    }, {
      fallbackPhase: options.targetPhase || story.workflow?.currentPhase || null
    });
  }

  async retryPhase(storyId, phaseName, reason) {
    console.log(`[WorkflowEngine] Retrying phase ${phaseName} for story: ${storyId}, reason: ${reason}`);

    if (!this.retryConfig.retryOnPhases.includes(phaseName)) {
      return {
        status: 'error',
        error: `Invalid phase name: ${phaseName}`,
        validPhases: this.retryConfig.retryOnPhases
      };
    }

    if (!this._hasKernelControlPlane()) {
      return this._retiredShellError('retryPhase');
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
    if (currentAttempt > this.retryConfig.maxAttempts) {
      return {
        status: 'failed',
        error: `Max retry attempts (${this.retryConfig.maxAttempts}) exceeded for ${phaseName}`,
        attempt: currentAttempt,
        maxAttempts: this.retryConfig.maxAttempts,
        lastError: retryContext.lastError
      };
    }

    return this._delegateControlPlaneAction(storyId, async () => {
      return this.kernelAdapter.recover(storyId, {
        recoveryAction: 'restart_phase',
        targetPhase: phaseName,
        feedback: reason
      });
    }, {
      fallbackPhase: phaseName
    });
  }

  async handleChapterRetry(storyId, args) {
    const { phase, chapter_number, feedback } = args;
    const story = await this.stateManager.getStory(storyId);
    if (!story) {
      return { status: 'error', error: 'Story not found' };
    }

    const checkpointId = story.workflow?.activeCheckpoint?.id || null;
    if (!checkpointId) {
      return {
        status: 'error',
        error: 'No active checkpoint available for chapter retry'
      };
    }

    return this.resume(storyId, {
      checkpointId,
      approval: false,
      feedback,
      chapter_number,
      reason: `Manual chapter retry requested for ${phase} chapter ${chapter_number}`
    });
  }

  async _delegateControlPlaneAction(storyId, action, options = {}) {
    const result = await action();
    const status = this.kernelAdapter && typeof this.kernelAdapter.getStatus === 'function'
      ? await this.kernelAdapter.getStatus(storyId)
      : null;

    if (!status) {
      return result;
    }

    return {
      ...result,
      status: status.state,
      state: status.state,
      currentPhase: status.currentPhase || options.fallbackPhase || null,
      currentStep: status.currentStep || null,
      activeCheckpoint: status.activeCheckpoint
        ? { checkpointId: status.activeCheckpoint }
        : result?.checkpointState || null,
      recoveryCursor: status.recoveryCursor || null
    };
  }

  async _notify(storyId, eventType, payload) {
    if (!this.webSocketPusher || typeof this.webSocketPusher.push !== 'function') {
      return;
    }

    const notification = {
      type: 'workflow_event',
      eventType,
      storyId,
      timestamp: new Date().toISOString(),
      payload
    };

    try {
      await this.webSocketPusher.push(storyId, notification);
    } catch (error) {
      console.warn('[WorkflowEngine] Failed to push workflow notification:', error.message);
    }
  }

  _sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  async getWorkflowStatus(storyId) {
    const kernelStatus = this._hasKernelControlPlane() && typeof this.kernelAdapter.getStatus === 'function'
      ? await this.kernelAdapter.getStatus(storyId)
      : null;
    const workflow = typeof this.stateManager.getWorkflowCompatibilityView === 'function'
      ? await this.stateManager.getWorkflowCompatibilityView(storyId)
      : ((await this.stateManager.getStory(storyId))?.workflow || null);

    if (!workflow && !kernelStatus) {
      return null;
    }

    return {
      state: kernelStatus?.state || workflow?.state || 'idle',
      currentPhase: kernelStatus?.currentPhase || workflow?.currentPhase || null,
      currentStep: kernelStatus?.currentStep || workflow?.currentStep || null,
      activeCheckpoint: kernelStatus?.activeCheckpoint || workflow?.activeCheckpoint || null,
      retryContext: workflow?.retryContext || null,
      historyLength: workflow?.history?.length || 0,
      runToken: workflow?.runToken || null,
      recoveryCursor: kernelStatus?.recoveryCursor || null
    };
  }

  _buildWorkflowStartContext(story) {
    const storyConfig = story?.config || {};
    return {
      storyId: story.id,
      storyPrompt: storyConfig.storyPrompt || storyConfig.story_prompt || '',
      targetWordCount: storyConfig.targetWordCount || storyConfig.target_word_count || {
        min: 2500,
        max: 3500
      },
      genre: storyConfig.genre || 'general',
      stylePreference: storyConfig.stylePreference || storyConfig.style_preference || ''
    };
  }

  _retiredShellError(operation) {
    return {
      status: 'error',
      error: `WorkflowEngine.${operation} requires WorkflowKernel control plane; the phase-class shell runtime has been retired`
    };
  }
}

WorkflowEngine.compatibilitySurface = WORKFLOW_ENGINE_COMPATIBILITY_SURFACE;

module.exports = { WorkflowEngine };
