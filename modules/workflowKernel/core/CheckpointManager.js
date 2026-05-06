/**
 * CheckpointManager — manages checkpoint lifecycle.
 * Handles creation, timeout, auto-approve, and polling.
 */

class CheckpointManager {
  /**
   * Creates a new CheckpointManager instance.
   * @param {Object} config
   * @param {number} [config.defaultTimeoutMs=86400000] - Default checkpoint timeout
   * @param {number} [config.checkpointPollIntervalMs=60000] - Poll interval for timeout checks
   */
  constructor(config = {}) {
    this.defaultTimeoutMs = config.defaultTimeoutMs ?? 86400000;
    this.pollIntervalMs = config.checkpointPollIntervalMs ?? 60000;
    this.onAutoResolve = typeof config.onAutoResolve === 'function' ? config.onAutoResolve : null;
    this.activeCheckpoints = new Map();
    this.pollTimer = null;
    this._log('CheckpointManager initialized');
  }

  /**
   * Creates a new checkpoint.
   * @param {string} workflowId - Owning workflow identifier
   * @param {Object} checkpointConfig - Checkpoint configuration
   * @param {string} [checkpointConfig.id] - Optional checkpoint ID (auto-generated if omitted)
   * @param {string} [checkpointConfig.type='generic'] - Checkpoint classification
   * @param {string} [checkpointConfig.promptTemplate=''] - Human-facing prompt
   * @param {number} [checkpointConfig.timeoutMs] - Override default timeout
   * @param {boolean} [checkpointConfig.autoContinueOnTimeout=true] - Auto-approve on timeout
   * @param {string} [checkpointConfig.onCheckpointReject='retry'] - Action on rejection
   * @param {Object} [checkpointConfig.metadata={}] - Arbitrary metadata
   * @returns {Promise<Object>} Created checkpoint
   */
  async create(workflowId, checkpointConfig) {
    const checkpointId = checkpointConfig.id || `cp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const now = new Date();
    const timeoutMs = checkpointConfig.timeoutMs ?? this.defaultTimeoutMs;
    const expiresAt = new Date(now.getTime() + timeoutMs);

    const checkpoint = {
      checkpointId,
      workflowId,
      type: checkpointConfig.type || 'generic',
      promptTemplate: checkpointConfig.promptTemplate || '',
      status: 'pending',
      createdAt: now.toISOString(),
      expiresAt: expiresAt.toISOString(),
      autoContinueOnTimeout: checkpointConfig.autoContinueOnTimeout !== false,
      onCheckpointReject: checkpointConfig.onCheckpointReject || 'retry',
      metadata: checkpointConfig.metadata || {}
    };

    this.activeCheckpoints.set(checkpointId, checkpoint);
    this._startPollingIfNeeded();

    this._log('Checkpoint created', { checkpointId, workflowId, expiresAt: checkpoint.expiresAt });
    return checkpoint;
  }

  /**
   * Resolves a pending checkpoint.
   * @param {string} checkpointId - Checkpoint identifier
   * @param {string} action - 'approve' | 'reject' | 'skip' | 'modify' | 'timeout'
   * @param {Object} [response={}] - Optional response data
   * @param {string} [response.feedback] - Human feedback text
   * @param {Object} [response.modifiedData] - Modified data (if action === 'modify')
   * @param {Object} [options={}] - Resolution options
   * @param {boolean} [options.triggerContinuation=true] - Trigger timeout continuation callback
   * @returns {Promise<Object>} Resolved checkpoint
   * @throws {Error} If checkpoint not found or already resolved
   */
  async resolve(checkpointId, action, response = {}, options = {}) {
    const checkpoint = this.activeCheckpoints.get(checkpointId);
    if (!checkpoint) {
      throw new Error(`Checkpoint not found: ${checkpointId}`);
    }

    if (checkpoint.status !== 'pending') {
      throw new Error(`Checkpoint ${checkpointId} is already ${checkpoint.status}`);
    }

    const normalizedAction = this._normalizeAction(action);
    checkpoint.status = this._statusForAction(normalizedAction);
    checkpoint.resolvedAt = new Date().toISOString();
    checkpoint.action = normalizedAction;
    checkpoint.feedback = response.feedback || '';
    checkpoint.modifiedData = response.modifiedData || null;
    checkpoint.resolutionSource = response.resolutionSource || (normalizedAction === 'timeout' ? 'timeout' : 'manual');

    this.activeCheckpoints.delete(checkpointId);
    this._stopPollingIfEmpty();

    this._log('Checkpoint resolved', { checkpointId, action: normalizedAction, status: checkpoint.status });

    if (normalizedAction === 'timeout' && options.triggerContinuation !== false && this.onAutoResolve) {
      await this.onAutoResolve({ ...checkpoint });
    }

    return checkpoint;
  }

  /**
   * Retrieves a pending checkpoint by ID.
   * @param {string} checkpointId - Checkpoint identifier
   * @returns {Object|null} Checkpoint or null if not found
   */
  get(checkpointId) {
    return this.activeCheckpoints.get(checkpointId) || null;
  }

  /**
   * Lists all pending checkpoints.
   * @returns {Array<Object>} Array of pending checkpoints
   */
  listPending() {
    return Array.from(this.activeCheckpoints.values()).filter(cp => cp.status === 'pending');
  }

  _startPollingIfNeeded() {
    if (this.pollTimer) return;
    this.pollTimer = setInterval(() => {
      void this._checkExpired();
    }, this.pollIntervalMs);
    if (typeof this.pollTimer.unref === 'function') {
      this.pollTimer.unref();
    }
  }

  _stopPollingIfEmpty() {
    if (this.activeCheckpoints.size === 0 && this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  async _checkExpired() {
    const now = new Date();
    for (const [checkpointId, checkpoint] of this.activeCheckpoints) {
      if (checkpoint.status !== 'pending') continue;
      if (checkpoint.autoContinueOnTimeout && new Date(checkpoint.expiresAt) <= now) {
        this._log('Auto-continuing expired checkpoint', { checkpointId, workflowId: checkpoint.workflowId });
        await this.resolve(checkpointId, 'timeout', {
          feedback: 'Auto-continued on timeout',
          resolutionSource: 'timeout'
        });
      }
    }
  }

  /**
   * Cleans up polling timer and active checkpoints. Call on shutdown.
   */
  destroy() {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    this.activeCheckpoints.clear();
  }

  _log(message, context = {}) {
    console.log(`[CheckpointManager] ${message}`, JSON.stringify(context));
  }

  _normalizeAction(action) {
    const allowedActions = new Set(['approve', 'reject', 'skip', 'modify', 'timeout']);
    if (!allowedActions.has(action)) {
      throw new Error(`Unsupported checkpoint action: ${action}`);
    }
    return action;
  }

  _statusForAction(action) {
    const actionStatusMap = {
      approve: 'approved',
      reject: 'rejected',
      skip: 'skipped',
      modify: 'modified',
      timeout: 'timed_out'
    };

    return actionStatusMap[action];
  }
}

module.exports = { CheckpointManager };
