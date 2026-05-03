/**
 * RecoveryManager — handles startup crash recovery for workflows.
 *
 * On startup:
 * 1. Scans all active (non-terminal) workflows
 * 2. Detects crash residues (workflows that were running when VCP crashed)
 * 3. Resumes from last completed step boundary
 *
 * Recovery rules:
 * - Only resume from 'completed' step boundaries
 * - Non-idempotent steps (agentCall with side effects) are re-evaluated
 * - Checkpoints are safe to resume from
 */

const { EXECUTION_STATES } = require('./StateMachine');
const {
  SAFE_TO_RESUME_STEP_TYPES,
  NON_IDEMPOTENT_STEP_TYPES,
  normalizeExecutionCursor,
  getCursorIndices,
  resolveStepRecoveryMetadata,
  normalizeRecoveryState
} = require('./RecoveryContract');

class RecoveryManager {
  /**
   * Creates a new RecoveryManager instance.
   * @param {WorkflowKernel} workflowKernel - Kernel instance
   * @param {WorkflowStateRepository} stateRepository - State repository for persistence
   */
  constructor(workflowKernel, stateRepository) {
    this.kernel = workflowKernel;
    this.stateRepository = stateRepository;
  }

  /**
   * Scans all active workflows and attempts recovery on startup.
   * Safe-to-resume step types (checkpoint, guard, noop) resume from cursor.
   * Non-idempotent steps (agentCall) roll back to last safe boundary.
   * @returns {Promise<{recovered: Array, failed: Array}>} Recovery results
   */
  async startupRecovery() {
    const activeWorkflows = await this.stateRepository.listActive();
    const recovered = [];
    const failed = [];

    for (const record of activeWorkflows) {
      try {
        const result = await this._recoverWorkflow(record);
        recovered.push(result);
      } catch (error) {
        console.error(`[RecoveryManager] Failed to recover workflow ${record.workflowId || record.story_id}:`, error.message);
        failed.push({ workflowId: record.workflowId || record.story_id, error: error.message });
      }
    }

    console.log(`[RecoveryManager] Recovery complete: ${recovered.length} recovered, ${failed.length} failed`);
    return { recovered, failed };
  }

  /**
   * Alias for startupRecovery().
   * @returns {Promise<{recovered: Array, failed: Array}>}
   */
  async scanAndRecover() {
    return this.startupRecovery();
  }

  async _recoverWorkflow(record) {
    const workflowId = record.workflowId || record.story_id;
    const context = record.context || this._parseContext(record.workflow_state);
    const recoveryState = normalizeRecoveryState(record);
    const currentCursor = recoveryState.currentCursor || null;
    const cursor = normalizeExecutionCursor(currentCursor?.executionCursor || record.executionCursor || record.execution_cursor || record.current_step);
    const runToken = record.runToken || record.run_token;

    const activeInKernel = this.kernel?.activeWorkflows?.get(workflowId);
    if (activeInKernel && activeInKernel.record?.runToken && runToken && activeInKernel.record.runToken !== runToken) {
      console.error(`[RecoveryManager] RunToken mismatch for workflow ${workflowId}. Persisted=${runToken}, Active=${activeInKernel.record.runToken}. Skipping recovery.`);
      return { workflowId, action: 'skipped', reason: 'runToken_mismatch', runToken };
    }

    if (!cursor || cursor.length === 0) {
      console.log(`[RecoveryManager] Workflow ${workflowId} has no execution cursor. Marking idle. runToken=${runToken}`);
      return { workflowId, action: 'marked_idle', reason: 'no_execution_cursor', runToken };
    }

    const persistedStep = this._getPersistedStepState(context, currentCursor, cursor);
    const lastStepType = currentCursor?.stepType || persistedStep?.type || null;
    const lastStepId = currentCursor?.stepId || persistedStep?.id || cursor.find((entry) => entry.step !== undefined)?.step;
    const recoveryMetadata = resolveStepRecoveryMetadata({ type: lastStepType }, persistedStep || {});

    if (
      currentCursor?.resumeAction === 'resume_step'
      || (currentCursor?.resumeAction === 'resume_next' && currentCursor?.rollbackSafe !== false)
      || (!currentCursor && recoveryMetadata.resumeFromCursor)
    ) {
      console.log(`[RecoveryManager] Workflow ${workflowId} safe to resume from cursor. stepId=${lastStepId}, stepType=${lastStepType}, runToken=${runToken}`);
      return {
        workflowId,
        action: 'resume_from_cursor',
        cursor,
        recoveryCursor: currentCursor,
        lastStepType,
        runToken
      };
    }

    const safeBoundary = this._findSafeBoundary(recoveryState, currentCursor);
    const safeCursor = safeBoundary?.executionCursor || this._findLastSafeCursor(context, cursor);
    if (safeCursor && normalizeExecutionCursor(safeCursor)) {
      console.log(`[RecoveryManager] Workflow ${workflowId} non-idempotent step detected (type=${lastStepType}, step=${lastStepId}). Rolling back to safe boundary. runToken=${runToken}`);
      return {
        workflowId,
        action: 'resume_from_safe_boundary',
        cursor: safeCursor,
        recoveryCursor: currentCursor,
        safeBoundary,
        originalCursor: cursor,
        reason: recoveryMetadata.isIdempotent === false ? 'non_idempotent_step_found' : 'rollback_boundary_required',
        lastStepType,
        runToken
      };
    }

    console.error(`[RecoveryManager] Workflow ${workflowId} cannot safely resume. No safe boundary found. stepType=${lastStepType}, step=${lastStepId}. runToken=${runToken}. Marking as failed.`);
    await this.stateRepository.update(workflowId, {
      status: EXECUTION_STATES.FAILED,
      retryContext: { ...record.retryContext, recoveryFailed: true }
    });

    return {
      workflowId,
      action: 'marked_failed',
      reason: 'no_safe_boundary_found',
      lastStepType,
      runToken
    };
  }

  _parseContext(workflowStateStr) {
    if (!workflowStateStr) return { inputs: {}, outputs: {}, steps: {} };
    try {
      return JSON.parse(workflowStateStr);
    } catch {
      return { inputs: {}, outputs: {}, steps: {} };
    }
  }

  _parseCursor(currentStepStr) {
    return normalizeExecutionCursor(currentStepStr);
  }

  _getPersistedStepState(context, recoveryCursor, cursor) {
    if (recoveryCursor?.stepId && context.steps?.[recoveryCursor.stepId]) {
      return {
        id: recoveryCursor.stepId,
        ...context.steps[recoveryCursor.stepId]
      };
    }

    const { stepIndex } = getCursorIndices(cursor);
    if (stepIndex === null || stepIndex === undefined) {
      return null;
    }

    const stepKey = Object.keys(context.steps || {})[stepIndex];
    if (!stepKey) {
      return null;
    }

    return {
      id: stepKey,
      ...context.steps[stepKey]
    };
  }

  _isSafeToResume(stepType) {
    if (!stepType) return true;
    return SAFE_TO_RESUME_STEP_TYPES.includes(stepType);
  }

  _findSafeBoundary(recoveryState, currentCursor) {
    const boundaries = Array.isArray(recoveryState.rollbackBoundaries) ? recoveryState.rollbackBoundaries : [];
    const candidates = boundaries.filter((boundary) => {
      if (boundary.rollbackSafe === false) {
        return false;
      }
      if (!currentCursor) {
        return true;
      }
      return boundary.phaseIndex === currentCursor.phaseIndex || boundary.boundaryType === 'phase_boundary';
    });
    return candidates[candidates.length - 1] || null;
  }

  _findLastSafeCursor(context, currentCursor) {
    const stepEntries = Object.entries(context.steps || {});

    for (let i = stepEntries.length - 1; i >= 0; i--) {
      const [, stepData] = stepEntries[i];
      const recoveryMetadata = resolveStepRecoveryMetadata({ type: stepData.type }, stepData);
      if (recoveryMetadata.resumeFromCursor || this._isSafeToResume(stepData.type)) {
        const { phaseIndex } = getCursorIndices(currentCursor);
        return [{ phase: phaseIndex ?? 0 }, { step: i }];
      }
    }

    return null;
  }
}

module.exports = { RecoveryManager, SAFE_TO_RESUME_STEP_TYPES, NON_IDEMPOTENT_STEP_TYPES };
