/**
 * WorkflowKernel — main orchestrator entry point.
 * Manages workflow execution, state transitions, and step dispatch.
 */

const { StateMachine, EXECUTION_STATES } = require('./StateMachine');
const { StepRegistry } = require('./StepRegistry');
const { RetryPolicy } = require('./RetryPolicy');
const { EventBus } = require('./EventBus');
const { CheckpointManager } = require('./CheckpointManager');
const { NoopTraceSink } = require('../tracing/NoopTraceSink');
const {
  normalizeExecutionCursor,
  normalizeRecoveryState,
  applyRecoveryState,
  resolveStepRecoveryMetadata,
  toBoundaryCursor
} = require('./RecoveryContract');
const {
  createLastErrorView,
  createRunStatusView,
  createStepTraceRecord,
  createTraceEvent
} = require('../tracing/traceModels');

const CHECKPOINT_ACTIONS = new Set(['approve', 'reject', 'skip', 'modify', 'timeout']);
const FAILURE_ACTION_ALIASES = {
  fail: 'fail',
  retry: 'retry',
  checkpoint: 'checkpoint',
  rollback: 'rollbackToSnapshot',
  rollback_to_snapshot: 'rollbackToSnapshot',
  rollbacktosnapshot: 'rollbackToSnapshot',
  restart_phase: 'restartPhase',
  restartphase: 'restartPhase',
  notify_and_halt: 'fail'
};

class WorkflowKernel {
  /**
   * Creates a new WorkflowKernel instance.
   * @param {Object} options
   * @param {Object} options.agentDispatcher - Must implement `delegate(agentId, prompt, options)`
   * @param {WorkflowStateRepository} [options.stateRepository] - Persistence adapter
   * @param {Object} [options.webSocketPusher] - Must implement `push(workflowId, event)`
   * @param {Object} [options.config={}] - Kernel configuration
   * @param {number} [options.config.defaultTimeoutMs=86400000] - Default checkpoint timeout
   * @param {number} [options.config.maxConcurrentWorkflows=100] - Max active workflows
   * @param {Object} [options.config.globalRetryPolicy] - Default retry configuration
   */
  constructor({ agentDispatcher, stateRepository, webSocketPusher, traceSink, config = {} }) {
    this.agentDispatcher = agentDispatcher;
    this.stateRepository = stateRepository;
    this.webSocketPusher = webSocketPusher;
    this.config = {
      defaultTimeoutMs: config.defaultTimeoutMs || 86400000,
      maxConcurrentWorkflows: config.maxConcurrentWorkflows || 100,
      observability: {
        enabled: config.observability?.enabled !== false,
        recentEventLimit: config.observability?.recentEventLimit || 20,
        ...(config.observability || {})
      },
      ...config
    };
    this.stepRegistry = new StepRegistry();
    this.retryPolicy = new RetryPolicy(config.globalRetryPolicy);
    this.activeWorkflows = new Map();
    this.eventBus = new EventBus();
    this.traceSink = traceSink || new NoopTraceSink();
    this.checkpointManager = config.checkpointManager || new CheckpointManager({
      ...config,
      onAutoResolve: async (resolvedCheckpoint) => {
        try {
          await this.resume(resolvedCheckpoint.workflowId, {
            checkpointId: resolvedCheckpoint.checkpointId,
            action: 'timeout',
            feedback: resolvedCheckpoint.feedback || 'Auto-continued on timeout',
            modifiedData: resolvedCheckpoint.modifiedData || null,
            resolutionSource: 'timeout'
          });
        } catch (error) {
          this._log('Timed-out checkpoint continuation failed', {
            workflowId: resolvedCheckpoint.workflowId,
            checkpointId: resolvedCheckpoint.checkpointId,
            error: error.message
          });
        }
      }
    });
    this.lifecycleHooks = {
      beforeStep: [],
      afterCheckpoint: [],
      onRecovery: []
    };
    this._log('WorkflowKernel initialized');
  }

  /**
   * Subscribes to kernel events. Returns an unsubscribe function.
   * @param {string} eventType - Event type or '*' for wildcard
   * @param {function} handler - Event handler: `(event) => void`
   * @returns {function} Unsubscribe function
   */
  onEvent(eventType, handler) {
    return this.eventBus.subscribe(eventType, handler);
  }

  /**
   * Registers a custom step type handler.
   * @param {string} name - Unique step type identifier
   * @param {function} handler - `async (step, stepContext) => StepResult`
   */
  registerStepType(name, handler) {
    this.stepRegistry.register(name, handler);
    this._log('Step type registered', { name });
  }

  /**
   * Registers a lifecycle hook for workflow execution events.
   * @param {string} name - Hook name: 'beforeStep', 'afterCheckpoint', 'onRecovery'
   * @param {function} handler - Async handler function
   */
  registerLifecycleHook(name, handler) {
    if (!this.lifecycleHooks[name]) {
      throw new Error(`Unknown lifecycle hook: ${name}. Valid hooks: ${Object.keys(this.lifecycleHooks).join(', ')}`);
    }
    this.lifecycleHooks[name].push(handler);
    this._log('Lifecycle hook registered', { name });
  }

  /**
   * Calls all registered handlers for a lifecycle hook.
   * @private
   */
  async _callHooks(name, context) {
    const hooks = this.lifecycleHooks[name] || [];
    for (const handler of hooks) {
      try {
        await handler(context);
      } catch (err) {
        this._log(`Lifecycle hook ${name} failed`, { error: err.message });
      }
    }
  }

  /**
   * Starts a new workflow execution.
   * @param {string} workflowId - Unique workflow identifier
   * @param {WorkflowDefinition} definition - Workflow definition
   * @param {Object} [initialContext={}] - Initial input data (available as `ctx.inputs`)
   * @returns {Promise<WorkflowRecord>} Workflow record
   * @throws {Error} If workflowId is already active
   */
  async execute(workflowId, definition, initialContext = {}, restoredOutputs = {}) {
    if (this.activeWorkflows.has(workflowId)) {
      throw new Error(`Workflow ${workflowId} is already active`);
    }

    const stateMachine = new StateMachine(EXECUTION_STATES.IDLE);
    const workflowRecord = {
      workflowId,
      definitionRef: definition.id || workflowId,
      status: stateMachine.getState(),
      executionCursor: [],
      context: { inputs: initialContext, outputs: { ...restoredOutputs }, steps: {} },
      checkpointState: null,
      retryContext: {},
      history: [],
      runToken: this._generateRunToken(),
      traceContext: this._createRunTraceContext(),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };
    applyRecoveryState(workflowRecord, {
      currentCursor: null,
      rollbackBoundaries: [],
      lastRecoveryAction: null,
      lastUpdatedAt: workflowRecord.updatedAt
    });

    if (this.stateRepository) {
      await this.stateRepository.create(workflowId, workflowRecord.definitionRef, workflowRecord.context);
    }

    this.activeWorkflows.set(workflowId, { stateMachine, definition, record: workflowRecord });

    stateMachine.transition(EXECUTION_STATES.RUNNING, 'workflow_started');
    workflowRecord.status = stateMachine.getState();
    await this._updateWorkflowState(workflowId, {
      status: workflowRecord.status,
      runToken: workflowRecord.runToken
    });
    await this._recordEvent(workflowRecord, 'workflow.started', {
      definitionRef: workflowRecord.definitionRef,
      initialContext
    }, {
      status: workflowRecord.status
    });

    try {
      await this._runWorkflow(workflowId);
    } catch (error) {
      this._log('Workflow execution error', { workflowId, error: error.message });
      throw error;
    }

    return workflowRecord;
  }

  /**
   * Resumes a workflow paused at a checkpoint.
   * @param {string} workflowId - Active workflow identifier
   * @param {CheckpointResponse} checkpointResponse - Human response to checkpoint
   * @returns {Promise<WorkflowRecord>} Updated workflow record
   * @throws {Error} If workflow is not active or not in waiting_checkpoint state
   */
  async resume(workflowId, checkpointResponse) {
    const active = this.activeWorkflows.get(workflowId);
    if (!active) {
      throw new Error(`Workflow ${workflowId} is not active`);
    }

    const { stateMachine, record } = active;
    const traceContext = this._ensureTraceContext(record);

    if (stateMachine.getState() !== EXECUTION_STATES.WAITING_CHECKPOINT) {
      throw new Error(`Workflow ${workflowId} is not waiting for checkpoint`);
    }

    const normalizedResponse = this._normalizeCheckpointResponse(checkpointResponse);
    const activeCheckpoint = record.checkpointState;
    if (!activeCheckpoint || activeCheckpoint.checkpointId !== normalizedResponse.checkpointId) {
      throw new Error(`Checkpoint mismatch. Expected: ${activeCheckpoint?.checkpointId || 'none'}, Got: ${normalizedResponse.checkpointId}`);
    }

    const resolvedCheckpoint = await this._resolveCheckpointRecord(activeCheckpoint, normalizedResponse);
    const continuation = this._buildCheckpointContinuation(record, resolvedCheckpoint);
    this._applyCheckpointResolutionToContext(record, resolvedCheckpoint, continuation);
    record.checkpointState = null;
    record.history.push({
      type: 'checkpoint_resolved',
      checkpointId: resolvedCheckpoint.checkpointId,
      action: resolvedCheckpoint.action,
      status: resolvedCheckpoint.status,
      continuation: continuation.kind,
      timestamp: resolvedCheckpoint.resolvedAt
    });

    stateMachine.transition(EXECUTION_STATES.RUNNING, continuation.reason);
    record.status = stateMachine.getState();
    await this._updateWorkflowState(workflowId, {
      status: record.status,
      executionCursor: record.executionCursor,
      context: record.context,
      checkpointState: record.checkpointState,
      retryContext: record.retryContext
    });
    await this._recordEvent(record, continuation.eventType, {
      checkpointId: resolvedCheckpoint.checkpointId,
      checkpointType: resolvedCheckpoint.type,
      action: resolvedCheckpoint.action,
      status: resolvedCheckpoint.status,
      feedback: resolvedCheckpoint.feedback,
      modifiedData: resolvedCheckpoint.modifiedData,
      continuation: continuation.kind,
      rejectStrategy: continuation.rejectStrategy,
      resolutionSource: resolvedCheckpoint.resolutionSource
    }, {
      status: record.status,
      phaseId: traceContext.currentPhaseId,
      stepId: traceContext.currentStepId,
      stepType: traceContext.currentStepType
    });

    // Call afterCheckpoint lifecycle hooks
    await this._callHooks('afterCheckpoint', {
      workflowId,
      checkpointId: resolvedCheckpoint.checkpointId,
      action: resolvedCheckpoint.action,
      checkpoint: resolvedCheckpoint,
      continuation,
      record,
      kernel: this
    });

    if (continuation.kind === 'fail') {
      stateMachine.transition(EXECUTION_STATES.FAILED, continuation.reason);
      record.status = stateMachine.getState();
      await this._updateWorkflowState(workflowId, {
        status: record.status,
        executionCursor: record.executionCursor,
        context: record.context,
        checkpointState: record.checkpointState,
        retryContext: record.retryContext
      });
      await this._recordEvent(record, 'workflow.failed', {
        error: resolvedCheckpoint.feedback || 'Checkpoint rejected',
        failedStepId: traceContext.currentStepId,
        errorCode: 'CHECKPOINT_REJECTED',
        phaseId: traceContext.currentPhaseId,
        stepType: traceContext.currentStepType
      }, {
        status: record.status,
        phaseId: traceContext.currentPhaseId,
        stepId: traceContext.currentStepId,
        stepType: traceContext.currentStepType
      });
      return record;
    }

    await this._runWorkflow(workflowId, continuation.resumeMode ? { resumeMode: continuation.resumeMode } : undefined);
    return record;
  }

  /**
   * Recovers a workflow from a crash by restoring state and resuming execution.
   * Calls onRecovery hooks before resuming to allow business-state restoration.
   * @param {string} workflowId - Workflow identifier
   * @param {Object} [options={}] - Recovery options
   * @param {Object} [options.checkpointResponse] - Optional checkpoint response if recovering from checkpoint
   * @returns {Promise<WorkflowRecord>} Recovered workflow record
   */
  async recover(workflowId, options = {}) {
    let record = null;
    if (this.stateRepository) {
      record = await this.stateRepository.get(workflowId);
    }

    const active = this.activeWorkflows.get(workflowId);
    if (!active && !record) {
      throw new Error(`Workflow ${workflowId} is not active and not found in persistence`);
    }

    const requestedAction = options.recoveryAction || options.action || 'continue';
    const effectiveRecord = active?.record || this._coercePersistedRecord(workflowId, record);
    this._ensureTraceContext(effectiveRecord);

    await this._callHooks('onRecovery', {
      workflowId,
      record: effectiveRecord,
      kernel: this
    });

    if (options.checkpointResponse) {
      if (!active && record) {
        const recoveryDefinition = options.definition;
        if (!recoveryDefinition || !Array.isArray(recoveryDefinition.phases)) {
          throw new Error(`Workflow ${workflowId} cannot recover checkpoint without a definition`);
        }

        const hydrated = this._rehydrateWorkflow(workflowId, effectiveRecord, recoveryDefinition, EXECUTION_STATES.WAITING_CHECKPOINT);
        await this._updateWorkflowState(workflowId, {
          status: hydrated.record.status,
          executionCursor: hydrated.record.executionCursor,
          context: hydrated.record.context,
          checkpointState: hydrated.record.checkpointState,
          retryContext: hydrated.record.retryContext,
          runToken: hydrated.record.runToken
        });
        await this._recordEvent(hydrated.record, 'workflow.recovered', {
          workflowId,
          recoveredAt: new Date().toISOString(),
          recoveryAction: 'continue',
          executionCursor: hydrated.record.executionCursor,
          recoveryCursor: normalizeRecoveryState(hydrated.record).currentCursor
        }, {
          status: hydrated.record.status
        });
      }
      return this.resume(workflowId, options.checkpointResponse);
    }

    let runtime = active;
    const shouldRehydrateActiveRuntime = Boolean(runtime?.stateMachine?.isTerminal());
    if (shouldRehydrateActiveRuntime) {
      runtime = this._rehydrateWorkflow(
        workflowId,
        effectiveRecord,
        runtime.definition || options.definition || { id: effectiveRecord.definitionRef, phases: [] },
        EXECUTION_STATES.RECOVERING
      );
    } else if (!runtime && record) {
      const hydrated = this._rehydrateWorkflow(
        workflowId,
        effectiveRecord,
        options.definition || { id: effectiveRecord.definitionRef, phases: [] },
        EXECUTION_STATES.RECOVERING
      );
      runtime = hydrated;
    }

    const definition = runtime?.definition || options.definition;
    if (!definition || !Array.isArray(definition.phases)) {
      throw new Error(`Workflow ${workflowId} cannot recover without a definition`);
    }

    let plan;
    if (requestedAction === 'restart_phase' || requestedAction === 'restartPhase') {
      plan = this._resolveRestartPhasePlan(runtime.record, definition, options.targetPhase);
    } else if (requestedAction === 'rollback' || requestedAction === 'rollbackToSnapshot') {
      plan = this._resolveRollbackPlan(runtime.record, definition, {
        targetPhase: options.targetPhase,
        targetCheckpointId: options.targetCheckpoint || options.targetCheckpointId,
        targetBoundaryType: options.targetBoundaryType,
        source: requestedAction === 'rollbackToSnapshot' ? 'rollback_to_snapshot' : 'rollback'
      });
    } else {
      plan = this._resolveContinueRecoveryPlan(runtime.record, definition);
    }

    if (runtime.stateMachine.canTransition(EXECUTION_STATES.RUNNING)) {
      runtime.stateMachine.transition(EXECUTION_STATES.RUNNING, `recovery:${requestedAction}`);
    }
    runtime.record.status = runtime.stateMachine.getState();
    await this._applyRecoveryPlan(workflowId, runtime.record, definition, plan, requestedAction, options);
    await this._recordEvent(runtime.record, 'workflow.recovered', {
      workflowId,
      recoveredAt: new Date().toISOString(),
      recoveryAction: requestedAction,
      executionCursor: runtime.record.executionCursor,
      recoveryCursor: plan.cursor
    }, {
      status: runtime.record.status,
      phaseId: plan.cursor?.phaseId || null,
      stepId: plan.cursor?.stepId || null,
      stepType: plan.cursor?.stepType || null
    });
    await this._runWorkflow(workflowId, { resumeMode: plan.resumeMode, fromRecovery: true });
    return this.activeWorkflows.get(workflowId)?.record;
  }

  _rehydrateWorkflow(workflowId, record, definition, initialState) {
    const stateMachine = new StateMachine(initialState);
    const persistedRecord = this._coercePersistedRecord(workflowId, record);
    const hydratedRecord = {
      ...persistedRecord,
      definitionRef: persistedRecord.definitionRef || definition?.id || workflowId,
      status: stateMachine.getState(),
      runToken: this._generateRunToken(),
      updatedAt: new Date().toISOString(),
      traceContext: persistedRecord.traceContext || this._createRunTraceContext()
    };
    this._commitRecoveryState(hydratedRecord, normalizeRecoveryState(hydratedRecord));

    this.activeWorkflows.set(workflowId, {
      stateMachine,
      definition,
      record: hydratedRecord
    });

    return this.activeWorkflows.get(workflowId);
  }

  /**
   * Retrieves current workflow status from memory or persistence.
   * @param {string} workflowId - Workflow identifier
   * @returns {Promise<Object|null>} Status object with state, executionCursor, context, checkpointState
   */
  async getStatus(workflowId) {
    const active = this.activeWorkflows.get(workflowId);
    if (active) {
      return {
        workflowId,
        state: active.stateMachine.getState(),
        executionCursor: active.record.executionCursor,
        context: active.record.context,
        checkpointState: active.record.checkpointState,
        recoveryCursor: normalizeRecoveryState(active.record).currentCursor
      };
    }

    if (this.stateRepository) {
      const persisted = await this.stateRepository.get(workflowId);
      const record = persisted ? this._coercePersistedRecord(workflowId, persisted) : null;
      if (!record) return null;
      return {
        workflowId: record.workflowId || record.workflow_id || workflowId,
        state: record.status || record.state,
        executionCursor: record.executionCursor || record.execution_cursor || record.current_step,
        context: record.context || {},
        checkpointState: record.checkpointState || null,
        recoveryCursor: normalizeRecoveryState(record).currentCursor
      };
    }

    return null;
  }

  async getRunStatus(workflowId, options = {}) {
    const active = this.activeWorkflows.get(workflowId);
    if (active) {
      return this._buildRunStatusView(active.record, active.stateMachine.getState());
    }

    const persistedRaw = this.stateRepository ? await this.stateRepository.get(workflowId) : null;
    const persisted = persistedRaw ? this._coercePersistedRecord(workflowId, persistedRaw) : null;
    const runToken = options.runToken || persisted?.runToken || persisted?.run_token || null;
    const traceStatus = await this._callTraceSinkRead('getRunStatus', workflowId, runToken);
    const lastError = await this._callTraceSinkRead('getLastError', workflowId, runToken);
    const recentEvents = await this._callTraceSinkRead(
      'listRecentEvents',
      workflowId,
      runToken,
      options.limit || this.config.observability.recentEventLimit
    );

    if (!persisted && !traceStatus) {
      return null;
    }

    return createRunStatusView({
      workflowId,
      runToken: traceStatus?.runToken || runToken,
      state: traceStatus?.state || persisted?.status || persisted?.state || null,
      currentPhaseId: traceStatus?.currentPhaseId || null,
      currentStepId: traceStatus?.currentStepId || null,
      currentStepType: traceStatus?.currentStepType || null,
      checkpointState: traceStatus?.checkpointState || persisted?.checkpointState || null,
      recoveryCursor: persisted?.recoveryCursor || null,
      lastEventAt: traceStatus?.lastEventAt || null,
      lastCompletedStep: traceStatus?.lastCompletedStep || null,
      lastFailedStep: traceStatus?.lastFailedStep || null,
      lastError: traceStatus?.lastError || lastError || null,
      recentEvents: traceStatus?.recentEvents || recentEvents || []
    });
  }

  _safeParseJson(value, fallback) {
    if (value === undefined || value === null || value === '') {
      return fallback;
    }

    if (typeof value !== 'string') {
      return value;
    }

    try {
      return JSON.parse(value);
    } catch {
      return fallback;
    }
  }

  _coercePersistedRecord(workflowId, record = {}) {
    const coerced = {
      ...record,
      workflowId: record.workflowId || record.workflow_id || workflowId,
      definitionRef: record.definitionRef || record.definition_ref || workflowId,
      status: record.status || record.state || EXECUTION_STATES.IDLE,
      executionCursor: normalizeExecutionCursor(
        record.executionCursor || record.execution_cursor || record.current_step
      ) || [],
      context: record.context || this._safeParseJson(record.workflow_state, { inputs: {}, outputs: {}, steps: {} }) || { inputs: {}, outputs: {}, steps: {} },
      checkpointState: record.checkpointState || this._safeParseJson(record.checkpoint_state_json, null) || null,
      retryContext: record.retryContext || this._safeParseJson(record.retry_context_json, {}) || {},
      history: Array.isArray(record.history) ? [...record.history] : [],
      runToken: record.runToken || record.run_token || this._generateRunToken(),
      createdAt: record.createdAt || record.created_at || new Date().toISOString(),
      updatedAt: record.updatedAt || record.updated_at || new Date().toISOString(),
      traceContext: record.traceContext || record.trace_context || this._createRunTraceContext()
    };
    applyRecoveryState(coerced, normalizeRecoveryState(coerced));
    return coerced;
  }

  _phaseIdFor(definition, phaseIndex) {
    const phase = definition?.phases?.[phaseIndex];
    return phase ? (phase.id || phaseIndex) : phaseIndex;
  }

  _phaseIndexFor(definition, targetPhase) {
    if (targetPhase === null || targetPhase === undefined) {
      return null;
    }
    if (Number.isInteger(targetPhase)) {
      return targetPhase;
    }

    return definition?.phases?.findIndex((phase, index) => (phase.id || index) === targetPhase) ?? null;
  }

  _buildRecoveryCursor(record, step, meta, recoveryMetadata, options = {}) {
    const executionCursor = normalizeExecutionCursor(options.executionCursor || record.executionCursor) || [];
    return {
      phaseId: meta.phaseId,
      phaseIndex: meta.phaseIndex,
      stepId: step.id,
      stepIndex: meta.stepIndex,
      boundaryType: options.boundaryType || recoveryMetadata.boundaryType,
      runToken: record.runToken,
      resumeAction: options.resumeAction || (recoveryMetadata.resumeFromCursor ? 'resume_step' : 'resume_next'),
      rollbackSafe: options.rollbackSafe === true,
      stepType: step.type,
      recovery: {
        isIdempotent: recoveryMetadata.isIdempotent,
        safeResumeBoundary: recoveryMetadata.safeResumeBoundary,
        rollbackBoundaries: recoveryMetadata.rollbackBoundaries
      },
      executionCursor,
      source: options.source || 'runtime',
      checkpointId: options.checkpointId || null,
      updatedAt: new Date().toISOString()
    };
  }

  _commitRecoveryState(record, recoveryState) {
    recoveryState.lastUpdatedAt = new Date().toISOString();
    applyRecoveryState(record, recoveryState);
    record.updatedAt = recoveryState.lastUpdatedAt;
    return recoveryState;
  }

  _registerRollbackBoundary(record, boundary) {
    if (!boundary || !boundary.executionCursor) {
      return;
    }

    const recoveryState = normalizeRecoveryState(record);
    const key = [
      boundary.boundaryType,
      boundary.phaseIndex,
      boundary.stepIndex,
      boundary.checkpointId || ''
    ].join(':');
    const nextBoundaries = recoveryState.rollbackBoundaries.filter((entry) => entry.key !== key);
    nextBoundaries.push({
      key,
      ...boundary,
      updatedAt: new Date().toISOString()
    });
    this._commitRecoveryState(record, {
      ...recoveryState,
      rollbackBoundaries: nextBoundaries
    });
  }

  _registerPhaseBoundary(record, definition, phase, phaseIndex) {
    const phaseId = phase?.id || phaseIndex;
    this._registerRollbackBoundary(record, {
      boundaryType: 'phase_boundary',
      phaseId,
      phaseIndex,
      stepId: null,
      stepIndex: -1,
      runToken: record.runToken,
      resumeAction: 'resume_next',
      rollbackSafe: true,
      executionCursor: toBoundaryCursor(phaseIndex, -1),
      source: 'phase_start'
    });
  }

  _findRollbackBoundary(record, options = {}) {
    const recoveryState = normalizeRecoveryState(record);
    const boundaries = recoveryState.rollbackBoundaries || [];
    const targetPhaseIndex = this._phaseIndexFor(this.activeWorkflows.get(record.workflowId)?.definition || options.definition, options.targetPhase);
    const targetCheckpointId = options.targetCheckpointId || null;
    const targetBoundaryType = options.targetBoundaryType || null;
    const currentCursor = recoveryState.currentCursor || null;

    const filtered = boundaries.filter((boundary) => {
      if (targetCheckpointId && boundary.checkpointId !== targetCheckpointId) {
        return false;
      }
      if (targetBoundaryType && boundary.boundaryType !== targetBoundaryType) {
        return false;
      }
      if (targetPhaseIndex !== null && targetPhaseIndex !== undefined && boundary.phaseIndex !== targetPhaseIndex) {
        return false;
      }
      if (
        !targetCheckpointId
        && !targetBoundaryType
        && (options.targetPhase === undefined || options.targetPhase === null)
        && currentCursor
        && boundary.executionCursor
        && currentCursor.executionCursor
        && JSON.stringify(boundary.executionCursor) === JSON.stringify(currentCursor.executionCursor)
        && boundary.boundaryType === currentCursor.boundaryType
      ) {
        return false;
      }
      return boundary.rollbackSafe !== false;
    });

    return filtered[filtered.length - 1] || null;
  }

  _resolveContinueRecoveryPlan(record, definition) {
    const recoveryState = normalizeRecoveryState(record);
    const currentCursor = recoveryState.currentCursor;

    if (currentCursor?.resumeAction === 'resume_step' && currentCursor.executionCursor) {
      return {
        executionCursor: currentCursor.executionCursor,
        resumeMode: 'current',
        cursor: currentCursor
      };
    }

    if (
      currentCursor?.resumeAction === 'resume_next'
      && currentCursor.executionCursor
      && currentCursor.rollbackSafe !== false
    ) {
      return {
        executionCursor: currentCursor.executionCursor,
        resumeMode: 'next',
        cursor: currentCursor
      };
    }

    const fallbackBoundary = this._findRollbackBoundary(record, { definition });
    if (fallbackBoundary) {
      return {
        executionCursor: fallbackBoundary.executionCursor,
        resumeMode: 'next',
        cursor: {
          ...currentCursor,
          boundaryType: fallbackBoundary.boundaryType,
          executionCursor: fallbackBoundary.executionCursor,
          resumeAction: 'resume_next',
          rollbackSafe: true
        }
      };
    }

    return {
      executionCursor: record.executionCursor || [],
      resumeMode: 'next',
      cursor: currentCursor || null
    };
  }

  _resolveRestartPhasePlan(record, definition, targetPhase) {
    const recoveryState = normalizeRecoveryState(record);
    const currentCursor = recoveryState.currentCursor;
    const phaseIndex = this._phaseIndexFor(definition, targetPhase ?? currentCursor?.phaseId ?? currentCursor?.phaseIndex ?? 0);

    if (phaseIndex === null || phaseIndex < 0 || !definition?.phases?.[phaseIndex]) {
      throw new Error(`Cannot restart phase: unknown target phase ${targetPhase ?? currentCursor?.phaseId ?? 'unknown'}`);
    }

    const phaseId = this._phaseIdFor(definition, phaseIndex);
    return {
      executionCursor: toBoundaryCursor(phaseIndex, -1),
      resumeMode: 'next',
      cursor: {
        phaseId,
        phaseIndex,
        stepId: null,
        stepIndex: -1,
        boundaryType: 'phase_boundary',
        runToken: record.runToken,
        resumeAction: 'resume_next',
        rollbackSafe: true,
        executionCursor: toBoundaryCursor(phaseIndex, -1),
        source: 'restart_phase',
        updatedAt: new Date().toISOString()
      }
    };
  }

  _resolveRollbackPlan(record, definition, options = {}) {
    const boundary = this._findRollbackBoundary(record, {
      definition,
      targetPhase: options.targetPhase,
      targetCheckpointId: options.targetCheckpointId,
      targetBoundaryType: options.targetBoundaryType
    });

    if (!boundary) {
      throw new Error('No rollback-safe boundary is available for this workflow state');
    }

    return {
      executionCursor: boundary.executionCursor,
      resumeMode: 'next',
      cursor: {
        phaseId: boundary.phaseId,
        phaseIndex: boundary.phaseIndex,
        stepId: boundary.stepId,
        stepIndex: boundary.stepIndex,
        boundaryType: boundary.boundaryType,
        runToken: record.runToken,
        resumeAction: boundary.resumeAction || 'resume_next',
        rollbackSafe: true,
        executionCursor: boundary.executionCursor,
        checkpointId: boundary.checkpointId || null,
        source: options.source || 'rollback',
        updatedAt: new Date().toISOString()
      }
    };
  }

  async _applyRecoveryPlan(workflowId, record, definition, plan, recoveryAction, options = {}) {
    record.executionCursor = plan.executionCursor;
    this._commitRecoveryState(record, {
      ...normalizeRecoveryState(record),
      currentCursor: plan.cursor,
      lastRecoveryAction: recoveryAction
    });

    await this._updateWorkflowState(workflowId, {
      status: record.status,
      executionCursor: record.executionCursor,
      context: record.context,
      checkpointState: record.checkpointState,
      retryContext: record.retryContext,
      runToken: record.runToken
    });

    if (recoveryAction === 'rollback') {
      await this._recordEvent(record, 'workflow.rollback', {
        workflowId,
        targetPhase: options.targetPhase || plan.cursor?.phaseId || null,
        targetCheckpointId: options.targetCheckpointId || plan.cursor?.checkpointId || null,
        boundaryType: plan.cursor?.boundaryType || null
      }, {
        status: record.status,
        phaseId: plan.cursor?.phaseId || null,
        stepId: plan.cursor?.stepId || null,
        stepType: plan.cursor?.stepType || null
      });
    }

    return plan;
  }

  _normalizeCheckpointResponse(checkpointResponse = {}) {
    const action = checkpointResponse.action
      || (checkpointResponse.approval === true ? 'approve' : null)
      || (checkpointResponse.approval === false ? 'reject' : null);

    if (!checkpointResponse.checkpointId) {
      throw new Error('checkpointId is required to resume a checkpoint');
    }
    if (!CHECKPOINT_ACTIONS.has(action)) {
      throw new Error(`Unsupported checkpoint action: ${action}`);
    }

    return {
      checkpointId: checkpointResponse.checkpointId,
      action,
      feedback: checkpointResponse.feedback || '',
      modifiedData: checkpointResponse.modifiedData || null,
      resolutionSource: checkpointResponse.resolutionSource || (action === 'timeout' ? 'timeout' : 'manual')
    };
  }

  async _resolveCheckpointRecord(activeCheckpoint, checkpointResponse) {
    let managerResolution = null;
    const pendingCheckpoint = this.checkpointManager?.get?.(checkpointResponse.checkpointId);
    if (pendingCheckpoint) {
      managerResolution = await this.checkpointManager.resolve(
        checkpointResponse.checkpointId,
        checkpointResponse.action,
        checkpointResponse,
        { triggerContinuation: false }
      );
    }

    return {
      ...activeCheckpoint,
      ...managerResolution,
      checkpointId: checkpointResponse.checkpointId,
      type: activeCheckpoint?.type || managerResolution?.type || 'generic',
      status: managerResolution?.status || this._statusForCheckpointAction(checkpointResponse.action),
      action: checkpointResponse.action,
      feedback: checkpointResponse.feedback,
      modifiedData: checkpointResponse.modifiedData,
      onCheckpointReject: activeCheckpoint?.onCheckpointReject || managerResolution?.onCheckpointReject || 'retry',
      metadata: activeCheckpoint?.metadata || managerResolution?.metadata || {},
      resolvedAt: managerResolution?.resolvedAt || new Date().toISOString(),
      resolutionSource: checkpointResponse.resolutionSource || managerResolution?.resolutionSource || 'manual'
    };
  }

  _buildCheckpointContinuation(record, resolvedCheckpoint) {
    const actionMap = {
      approve: {
        kind: 'continue',
        eventType: 'workflow.checkpoint_approved',
        reason: 'checkpoint_approved'
      },
      skip: {
        kind: 'continue',
        eventType: 'workflow.checkpoint_skipped',
        reason: 'checkpoint_skipped'
      },
      modify: {
        kind: 'continue',
        eventType: 'workflow.checkpoint_modified',
        reason: 'checkpoint_modified'
      },
      timeout: {
        kind: 'continue',
        eventType: 'workflow.checkpoint_timeout',
        reason: 'checkpoint_timeout'
      }
    };

    if (resolvedCheckpoint.action === 'reject') {
      const rejectStrategy = resolvedCheckpoint.onCheckpointReject || resolvedCheckpoint.metadata?.onCheckpointReject || 'fail';
      const rejectionResolution = this._resolveFailureAction({
        step: {
          id: resolvedCheckpoint.metadata?.stepId || resolvedCheckpoint.checkpointId,
          type: 'checkpoint',
          onFailure: rejectStrategy
        },
        definition: this.activeWorkflows.get(record.workflowId)?.definition,
        attempt: Number(record.retryContext?.attempt || 0) + 1,
        error: new Error(resolvedCheckpoint.feedback || 'Checkpoint rejected'),
        source: 'checkpoint_rejection',
        requestedAction: rejectStrategy
      });

      if (rejectionResolution.action === 'retry') {
        const retryPlan = this._resolveCheckpointRetryPlan(
          record,
          this.activeWorkflows.get(record.workflowId)?.definition,
          resolvedCheckpoint
        );
        this._applyCheckpointRetryPlan(record, retryPlan);
        this._syncRetryContext(record, resolvedCheckpoint);
        return {
          kind: 'retry_previous_step',
          eventType: 'workflow.checkpoint_rejected',
          reason: 'checkpoint_rejected:retry',
          rejectStrategy: rejectionResolution.action,
          resumeMode: retryPlan.resumeMode
        };
      }

      if (rejectionResolution.action === 'restartPhase') {
        this._rewindCursorToPhaseStart(record);
        this._syncRetryContext(record, resolvedCheckpoint, { reason: 'Checkpoint rejected - restart phase' });
        return {
          kind: 'restart_phase',
          eventType: 'workflow.checkpoint_rejected',
          reason: 'checkpoint_rejected:restartPhase',
          rejectStrategy: rejectionResolution.action
        };
      }

      return {
        kind: 'fail',
        eventType: 'workflow.checkpoint_rejected',
        reason: `checkpoint_rejected:${rejectionResolution.action}`,
        rejectStrategy: rejectionResolution.action
      };
    }

    return actionMap[resolvedCheckpoint.action];
  }

  _resolveCheckpointRetryPlan(record, definition, resolvedCheckpoint) {
    const recoveryState = normalizeRecoveryState(record);
    const currentCursor = recoveryState.currentCursor || null;
    const phaseCursor = record.executionCursor.find((cursor) => cursor.phase !== undefined);
    const stepCursor = record.executionCursor.find((cursor) => cursor.step !== undefined);
    const phaseIndex = currentCursor?.phaseIndex ?? phaseCursor?.phase ?? 0;
    const checkpointStepIndex = currentCursor?.stepIndex ?? stepCursor?.step ?? -1;
    const boundaries = Array.isArray(recoveryState.rollbackBoundaries) ? recoveryState.rollbackBoundaries : [];

    const candidate = boundaries
      .filter((boundary) => {
        if (boundary.rollbackSafe === false) {
          return false;
        }
        if (boundary.phaseIndex !== phaseIndex) {
          return false;
        }
        if (!Number.isInteger(boundary.stepIndex) || boundary.stepIndex < 0) {
          return false;
        }
        if ((boundary.stepIndex ?? -1) >= checkpointStepIndex) {
          return false;
        }
        if (boundary.boundaryType === 'checkpoint_boundary') {
          return false;
        }
        if (boundary.stepType === 'guard' || boundary.stepType === 'checkpoint') {
          return false;
        }
        return Array.isArray(boundary.executionCursor);
      })
      .pop();

    if (candidate) {
      return {
        executionCursor: candidate.executionCursor,
        resumeMode: 'current',
        cursor: {
          phaseId: candidate.phaseId,
          phaseIndex: candidate.phaseIndex,
          stepId: candidate.stepId,
          stepIndex: candidate.stepIndex,
          boundaryType: candidate.boundaryType,
          runToken: record.runToken,
          resumeAction: 'resume_step',
          rollbackSafe: true,
          stepType: candidate.stepType || null,
          executionCursor: candidate.executionCursor,
          checkpointId: null,
          source: 'checkpoint_retry',
          updatedAt: new Date().toISOString(),
          rejectedCheckpointId: resolvedCheckpoint.checkpointId
        }
      };
    }

    const phaseId = this._phaseIdFor(definition, phaseIndex);
    return {
      executionCursor: toBoundaryCursor(phaseIndex, -1),
      resumeMode: 'next',
      cursor: {
        phaseId,
        phaseIndex,
        stepId: null,
        stepIndex: -1,
        boundaryType: 'phase_boundary',
        runToken: record.runToken,
        resumeAction: 'resume_next',
        rollbackSafe: true,
        stepType: null,
        executionCursor: toBoundaryCursor(phaseIndex, -1),
        checkpointId: null,
        source: 'checkpoint_retry',
        updatedAt: new Date().toISOString(),
        rejectedCheckpointId: resolvedCheckpoint.checkpointId
      }
    };
  }

  _applyCheckpointRetryPlan(record, plan) {
    record.executionCursor = plan.executionCursor;
    this._commitRecoveryState(record, {
      ...normalizeRecoveryState(record),
      currentCursor: plan.cursor
    });
  }

  _rewindCursorToPhaseStart(record) {
    const phaseCursor = record.executionCursor.find((cursor) => cursor.phase !== undefined);
    if (!phaseCursor) {
      return;
    }

    record.executionCursor = toBoundaryCursor(phaseCursor.phase, -1);
  }

  _syncRetryContext(record, resolvedCheckpoint, overrides = {}) {
    const traceContext = this._ensureTraceContext(record);
    const previousAttempt = Number(record.retryContext?.attempt || 0);
    record.retryContext = {
      ...record.retryContext,
      phase: traceContext.currentPhaseId,
      step: resolvedCheckpoint.metadata?.stepId || traceContext.currentStepId,
      attempt: previousAttempt + 1,
      lastError: overrides.reason || resolvedCheckpoint.feedback || 'Checkpoint rejected'
    };
  }

  _applyCheckpointResolutionToContext(record, resolvedCheckpoint, continuation) {
    const traceContext = this._ensureTraceContext(record);
    const checkpointStepId = resolvedCheckpoint.metadata?.stepId || traceContext.currentStepId || resolvedCheckpoint.checkpointId;
    const previousStepState = record.context.steps[checkpointStepId] || {};

    record.context.steps[checkpointStepId] = {
      ...previousStepState,
      status: resolvedCheckpoint.status,
      outputs: resolvedCheckpoint.modifiedData || previousStepState.outputs || null,
      error: resolvedCheckpoint.action === 'reject'
        ? { message: resolvedCheckpoint.feedback || 'Checkpoint rejected', code: 'CHECKPOINT_REJECTED' }
        : null,
      type: previousStepState.type || 'checkpoint',
      checkpoint: {
        checkpointId: resolvedCheckpoint.checkpointId,
        type: resolvedCheckpoint.type,
        action: resolvedCheckpoint.action,
        status: resolvedCheckpoint.status,
        feedback: resolvedCheckpoint.feedback,
        modifiedData: resolvedCheckpoint.modifiedData,
        resolvedAt: resolvedCheckpoint.resolvedAt,
        continuation: continuation.kind,
        resolutionSource: resolvedCheckpoint.resolutionSource
      }
    };
  }

  _statusForCheckpointAction(action) {
    const actionStatusMap = {
      approve: 'approved',
      reject: 'rejected',
      skip: 'skipped',
      modify: 'modified',
      timeout: 'timed_out'
    };
    return actionStatusMap[action];
  }

  _normalizeFailureAction(action) {
    if (!action || typeof action !== 'string') {
      return null;
    }

    return FAILURE_ACTION_ALIASES[action] || FAILURE_ACTION_ALIASES[action.toLowerCase()] || null;
  }

  _resolveRetryPolicyForStep(step, definition) {
    const workflowPolicy = definition?.globalRetryPolicy || null;
    const policy = this.retryPolicy.resolve(step, workflowPolicy);
    const enabled = this.retryPolicy.isConfigured(step, workflowPolicy);
    let source = 'default';

    if (step.retryPolicy) {
      source = 'step';
    } else if (workflowPolicy) {
      source = 'workflow';
    } else if (this.config.globalRetryPolicy) {
      source = 'kernel';
    }

    return { enabled, source, policy };
  }

  _resolveFailureAction({ step, definition, attempt, error, source = 'step_failure', requestedAction = null }) {
    const retryPolicyResolution = this._resolveRetryPolicyForStep(step, definition);
    const explicitAction = this._normalizeFailureAction(
      requestedAction || step.failureAction || step.onFailure || definition?.onFailure || null
    );

    if (source === 'checkpoint_rejection') {
      return {
        action: explicitAction || 'fail',
        source: explicitAction ? 'checkpoint_rejection' : 'checkpoint_rejection_default'
      };
    }

    const retryDecision = retryPolicyResolution.policy
      ? this.retryPolicy.shouldRetry(attempt, error, retryPolicyResolution.policy)
      : { shouldRetry: false, reason: 'retry_policy_missing' };

    if (explicitAction === 'checkpoint') {
      return {
        action: 'checkpoint',
        source: 'explicit_failure_action'
      };
    }

    if (explicitAction === 'retry') {
      if (retryDecision.shouldRetry) {
        return {
          action: 'retry',
          source: retryPolicyResolution.enabled ? retryPolicyResolution.source : 'default_retry_action',
          retryPolicy: retryPolicyResolution.policy,
          delayMs: this.retryPolicy.getDelay(attempt - 1, retryPolicyResolution.policy),
          reason: retryDecision.reason
        };
      }

      return {
        action: 'fail',
        source: 'retry_exhausted',
        reason: retryDecision.reason
      };
    }

    if (explicitAction) {
      return {
        action: explicitAction,
        source: 'explicit_failure_action'
      };
    }

    if (retryPolicyResolution.enabled && retryDecision.shouldRetry) {
      return {
        action: 'retry',
        source: retryPolicyResolution.source,
        retryPolicy: retryPolicyResolution.policy,
        delayMs: this.retryPolicy.getDelay(attempt - 1, retryPolicyResolution.policy),
        reason: retryDecision.reason
      };
    }

    return {
      action: 'fail',
      source: retryPolicyResolution.enabled ? 'retry_exhausted' : 'default_failure',
      reason: retryDecision.reason
    };
  }

  _resolveFailureBoundary(step) {
    if (step.type === 'loop') {
      return 'loop_step';
    }
    if (step.type === 'parallelGroup') {
      return 'parallel_group';
    }

    const builtInStepTypes = new Set(['agentCall', 'checkpoint', 'guard', 'loop', 'parallelGroup', 'noop']);
    return builtInStepTypes.has(step.type) ? 'step' : 'custom_step';
  }

  async _markStepRecoveryStart(workflowId, step, record, meta, attempt) {
    const recoveryMetadata = resolveStepRecoveryMetadata(step, record.context.steps[step.id] || {});
    const currentCursor = this._buildRecoveryCursor(record, step, meta, recoveryMetadata, {
      source: 'step_started',
      rollbackSafe: false,
      resumeAction: recoveryMetadata.resumeFromCursor ? 'resume_step' : 'resume_next'
    });
    const existingStepState = record.context.steps[step.id] || {};
    record.context.steps[step.id] = {
      ...existingStepState,
      status: 'running',
      outputs: existingStepState.outputs || null,
      error: null,
      type: step.type,
      attempt,
      recovery: recoveryMetadata
    };
    this._commitRecoveryState(record, {
      ...normalizeRecoveryState(record),
      currentCursor
    });
    await this._updateWorkflowState(workflowId, {
      status: record.status,
      executionCursor: record.executionCursor,
      context: record.context,
      checkpointState: record.checkpointState,
      retryContext: record.retryContext
    });

    if (
      recoveryMetadata.rollbackBoundaries.includes(recoveryMetadata.boundaryType)
      && !recoveryMetadata.resumeFromCursor
    ) {
      this._registerRollbackBoundary(record, {
        boundaryType: recoveryMetadata.boundaryType,
        phaseId: meta.phaseId,
        phaseIndex: meta.phaseIndex,
        stepId: step.id,
        stepIndex: meta.stepIndex,
        stepType: step.type,
        runToken: record.runToken,
        resumeAction: 'resume_next',
        rollbackSafe: true,
        executionCursor: toBoundaryCursor(meta.phaseIndex, meta.stepIndex - 1),
        source: 'step_restart_boundary'
      });
    }

    return recoveryMetadata;
  }

  _markStepRecoveryCompletion(record, step, meta, recoveryMetadata, checkpointId = null) {
    const currentCursor = this._buildRecoveryCursor(record, step, meta, recoveryMetadata, {
      source: checkpointId ? 'checkpoint_boundary' : 'step_completed',
      rollbackSafe: true,
      resumeAction: 'resume_next',
      checkpointId
    });
    this._commitRecoveryState(record, {
      ...normalizeRecoveryState(record),
      currentCursor
    });

    if (recoveryMetadata.rollbackBoundaries.includes(currentCursor.boundaryType)) {
      this._registerRollbackBoundary(record, {
        boundaryType: currentCursor.boundaryType,
        phaseId: currentCursor.phaseId,
        phaseIndex: currentCursor.phaseIndex,
        stepId: currentCursor.stepId,
        stepIndex: currentCursor.stepIndex,
        stepType: currentCursor.stepType,
        runToken: currentCursor.runToken,
        resumeAction: currentCursor.resumeAction,
        rollbackSafe: true,
        executionCursor: currentCursor.executionCursor,
        checkpointId: currentCursor.checkpointId,
        source: currentCursor.source
      });
    }
  }

  async _dispatchStepRecovery(workflowId, step, record, meta, failureAction) {
    const active = this.activeWorkflows.get(workflowId);
    const definition = active?.definition;
    const recoveryAction = failureAction.action === 'rollbackToSnapshot' ? 'rollback' : 'restart_phase';
    const plan = recoveryAction === 'rollback'
      ? this._resolveRollbackPlan(record, definition, {
        targetPhase: meta.phaseId,
        source: 'rollback_to_snapshot'
      })
      : this._resolveRestartPhasePlan(record, definition, meta.phaseId);

    await this._applyRecoveryPlan(workflowId, record, definition, plan, recoveryAction, {
      targetPhase: meta.phaseId
    });
    throw new RecoveryDispatchSignal(recoveryAction, plan.resumeMode);
  }

  _clearRetryContext(record, stepId) {
    if (record.retryContext?.step === stepId) {
      const recoveryState = normalizeRecoveryState(record);
      record.retryContext = { __recovery: recoveryState };
    }
  }

  async _enterCheckpointWait(workflowId, step, record, phaseId, stepTraceRecord, startedAt, checkpoint) {
    const activeState = this.activeWorkflows.get(workflowId)?.stateMachine;
    if (activeState) {
      activeState.transition(EXECUTION_STATES.WAITING_CHECKPOINT, `checkpoint:${step.id}`);
      record.status = activeState.getState();
    }

    record.checkpointState = checkpoint;
    const recoveryMetadata = resolveStepRecoveryMetadata(step, record.context.steps[step.id] || {});
    this._markStepRecoveryCompletion(
      record,
      step,
      {
        phaseId,
        phaseIndex: record.executionCursor.find((entry) => entry.phase !== undefined)?.phase ?? 0,
        stepIndex: record.executionCursor.find((entry) => entry.step !== undefined)?.step ?? 0
      },
      {
        ...recoveryMetadata,
        boundaryType: 'checkpoint_boundary',
        rollbackBoundaries: Array.from(new Set([...(recoveryMetadata.rollbackBoundaries || []), 'checkpoint_boundary']))
      },
      checkpoint?.checkpointId || null
    );
    await this._updateWorkflowState(workflowId, {
      status: record.status,
      checkpointState: record.checkpointState,
      executionCursor: record.executionCursor,
      context: record.context,
      retryContext: record.retryContext
    });
    await this._recordEvent(record, 'workflow.checkpoint_pending', {
      checkpointId: checkpoint?.checkpointId,
      checkpointType: checkpoint?.type,
      promptTemplate: checkpoint?.promptTemplate
    }, {
      phaseId,
      stepId: step.id,
      stepType: step.type,
      status: record.status
    });
    await this._safeTraceWrite('upsertStepTrace', createStepTraceRecord({
      ...stepTraceRecord,
      status: 'waiting_checkpoint',
      finishedAt: new Date().toISOString(),
      durationMs: Date.now() - Date.parse(startedAt)
    }));
  }

  async _createFailureCheckpoint(workflowId, step, phaseId, failureMeta) {
    const checkpointId = `failure-${workflowId}-${step.id}-${Date.now()}`;
    const checkpoint = await this.checkpointManager.create(workflowId, {
      id: checkpointId,
      type: 'step_failure',
      promptTemplate: `Step ${step.id} failed. Approve to continue or reject to ${step.onCheckpointReject || 'retry'}.`,
      timeoutMs: step.timeoutMs,
      autoContinueOnTimeout: false,
      onCheckpointReject: step.onCheckpointReject || 'retry',
      metadata: {
        stepId: step.id,
        phaseId,
        failureBoundary: failureMeta.failureBoundary,
        failureActionSource: 'step_failure',
        failedAttempt: failureMeta.attempt,
        errorMessage: failureMeta.errorMessage
      }
    });

    return {
      checkpointId: checkpoint.checkpointId,
      type: checkpoint.type,
      promptTemplate: checkpoint.promptTemplate,
      expiresAt: checkpoint.expiresAt,
      autoContinueOnTimeout: checkpoint.autoContinueOnTimeout,
      onCheckpointReject: checkpoint.onCheckpointReject,
      metadata: checkpoint.metadata
    };
  }

  async _handleRetryAction(workflowId, step, record, phaseId, failureMeta, failureAction) {
    const activeState = this.activeWorkflows.get(workflowId)?.stateMachine;
    if (activeState?.canTransition(EXECUTION_STATES.RETRYING)) {
      activeState.transition(EXECUTION_STATES.RETRYING, `retry:${step.id}`);
      record.status = activeState.getState();
    }

    record.retryContext = {
      __recovery: normalizeRecoveryState(record),
      phase: phaseId,
      step: step.id,
      attempt: failureMeta.attempt,
      maxAttempts: failureAction.retryPolicy.maxAttempts,
      lastError: failureMeta.errorMessage
    };

    await this._updateWorkflowState(workflowId, {
      status: record.status,
      executionCursor: record.executionCursor,
      context: record.context,
      checkpointState: record.checkpointState,
      retryContext: record.retryContext
    });
    await this._recordEvent(record, 'workflow.retrying', {
      stepId: step.id,
      stepType: step.type,
      phaseId,
      attempt: failureMeta.attempt,
      maxAttempts: failureAction.retryPolicy.maxAttempts,
      delayMs: failureAction.delayMs,
      retryPolicySource: failureAction.source,
      failureBoundary: failureMeta.failureBoundary
    }, {
      phaseId,
      stepId: step.id,
      stepType: step.type,
      status: record.status
    });

    if (failureAction.delayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, failureAction.delayMs));
    }

    if (activeState?.canTransition(EXECUTION_STATES.RUNNING)) {
      activeState.transition(EXECUTION_STATES.RUNNING, `retry_attempt:${step.id}`);
      record.status = activeState.getState();
      await this._updateWorkflowState(workflowId, {
        status: record.status,
        retryContext: record.retryContext
      });
    }
  }

  async _runWorkflow(workflowId, options = {}) {
    const active = this.activeWorkflows.get(workflowId);
    if (!active) return;

    const { definition, stateMachine, record } = active;
    const resumeMode = options.resumeMode || 'next';

    let startPhaseIndex = 0;
    let startStepIndex = 0;

    if (record.executionCursor && record.executionCursor.length >= 2) {
      const phaseCursor = record.executionCursor.find(c => c.phase !== undefined);
      const stepCursor = record.executionCursor.find(c => c.step !== undefined);
      if (phaseCursor && stepCursor) {
        startPhaseIndex = phaseCursor.phase;
        startStepIndex = resumeMode === 'current' ? stepCursor.step : stepCursor.step + 1;

        const currentPhase = definition.phases[startPhaseIndex];
        if (currentPhase && startStepIndex >= currentPhase.steps.length) {
          startPhaseIndex += 1;
          startStepIndex = 0;
        }
      }
    }

    for (let phaseIndex = startPhaseIndex; phaseIndex < definition.phases.length; phaseIndex++) {
      if (stateMachine.isTerminal()) break;

      const phase = definition.phases[phaseIndex];
      this._registerPhaseBoundary(record, definition, phase, phaseIndex);
      const stepStart = (phaseIndex === startPhaseIndex) ? startStepIndex : 0;

      for (let stepIndex = stepStart; stepIndex < phase.steps.length; stepIndex++) {
        if (stateMachine.isTerminal()) break;

        const step = phase.steps[stepIndex];
        record.executionCursor = [{ phase: phaseIndex }, { step: stepIndex }];

        try {
          await this._executeStep(workflowId, step, record, {
            phase,
            phaseId: phase.id || phaseIndex,
            phaseIndex,
            stepIndex
          });
        } catch (error) {
          if (error instanceof CheckpointPauseError) {
            this._log('Workflow paused at checkpoint', { workflowId, stepId: step.id, checkpointId: error.checkpoint?.checkpointId });
            return;
          }
          if (error instanceof RecoveryDispatchSignal) {
            await this._runWorkflow(workflowId, { resumeMode: error.resumeMode, fromRecovery: true });
            return;
          }
          this._log('Step execution failed', { workflowId, stepId: step.id, error: error.message });
          if (stateMachine.canTransition(EXECUTION_STATES.FAILED)) {
            stateMachine.transition(EXECUTION_STATES.FAILED, `step_failed:${step.id}`);
          }
          record.status = stateMachine.getState();
          const failureMeta = error.workflowStepFailure || this._buildStepFailureMeta(record, step, {
            phaseId: phase.id || phaseIndex
          }, error);
          await this._updateWorkflowState(workflowId, {
            status: record.status,
            executionCursor: record.executionCursor,
            context: record.context,
            checkpointState: record.checkpointState,
            retryContext: record.retryContext
          });
          await this._recordEvent(record, 'workflow.failed', {
            error: failureMeta.errorMessage,
            failedStepId: step.id,
            errorCode: failureMeta.errorCode,
            phaseId: failureMeta.phaseId,
            stepType: failureMeta.stepType,
            attempt: failureMeta.attempt || 1,
            resolvedFailureAction: failureMeta.resolvedFailureAction || 'fail',
            failureBoundary: failureMeta.failureBoundary || 'step'
          }, {
            status: record.status,
            phaseId: failureMeta.phaseId,
            stepId: failureMeta.stepId,
            stepType: failureMeta.stepType
          });
          await this._safeTraceWrite('writeLastError', failureMeta.lastErrorView);
          return;
        }
      }
    }

    if (!stateMachine.isTerminal()) {
      stateMachine.transition(EXECUTION_STATES.COMPLETED, 'all_steps_completed');
      record.status = stateMachine.getState();
      await this._updateWorkflowState(workflowId, {
        status: record.status,
        executionCursor: record.executionCursor,
        context: record.context
      });
      await this._recordEvent(record, 'workflow.completed', {
        outputs: record.context.outputs
      }, {
        status: record.status,
        phaseId: record.traceContext.currentPhaseId,
        stepId: record.traceContext.currentStepId,
        stepType: record.traceContext.currentStepType
      });
    }
  }

  async _executeStep(workflowId, step, record, meta = {}) {
    const phaseId = meta.phaseId || step.phaseId || 'default';
    const active = this.activeWorkflows.get(workflowId);
    const definition = active?.definition || null;
    let attempt = 1;

    // Retry is resolved at runtime so local step policy can override workflow
    // policy while still reusing the same dispatch path.
    while (true) {
      const handler = this.stepRegistry.get(step.type);
      const startedAt = new Date().toISOString();
      const stepTraceRecord = createStepTraceRecord({
        workflowId,
        runToken: record.runToken,
        sequence: this._peekNextSequence(record),
        phaseId,
        stepId: step.id,
        stepType: step.type,
        status: 'running',
        startedAt
      });
      const recoveryMetadata = await this._markStepRecoveryStart(workflowId, step, record, {
        phaseId,
        phaseIndex: meta.phaseIndex ?? 0,
        stepIndex: meta.stepIndex ?? 0
      }, attempt);

      await this._recordEvent(record, 'workflow.step_started', {
        stepId: step.id,
        stepType: step.type,
        phaseId,
        stepIndex: meta.stepIndex,
        attempt
      }, {
        phaseId,
        stepId: step.id,
        stepType: step.type,
        status: 'running'
      });
      await this._safeTraceWrite('upsertStepTrace', stepTraceRecord);

      const stepContext = {
        workflowId,
        step,
        context: record.context,
        kernel: this
      };

      await this._callHooks('beforeStep', {
        workflowId,
        step,
        record,
        kernel: this
      });

      try {
        if (!handler) {
          throw new Error(`Unknown step type: ${step.type}`);
        }

        const result = await handler(step, stepContext);

        record.context.steps[step.id] = {
          status: result.status || 'completed',
          outputs: result.output || null,
          error: result.error || null,
          type: step.type,
          attempt,
          recovery: recoveryMetadata
        };

        if (result.output && step.outputKey) {
          record.context.outputs[step.outputKey] = result.output;
        }

        if (result.status === 'waiting_checkpoint') {
          await this._enterCheckpointWait(workflowId, step, record, phaseId, stepTraceRecord, startedAt, result.checkpoint);
          throw new CheckpointPauseError(`Checkpoint pending: ${step.id}`, result.checkpoint);
        }

        if (result.status === 'failed') {
          throw result.error || new Error(`Step ${step.id} failed: Unknown error`);
        }

        this._clearRetryContext(record, step.id);
        this._markStepRecoveryCompletion(record, step, {
          phaseId,
          phaseIndex: meta.phaseIndex ?? 0,
          stepIndex: meta.stepIndex ?? 0
        }, recoveryMetadata);
        await this._updateWorkflowState(workflowId, {
          executionCursor: record.executionCursor,
          context: record.context,
          retryContext: record.retryContext
        });
        await this._recordEvent(record, 'workflow.step_completed', {
          stepId: step.id,
          stepType: step.type,
          phaseId,
          stepIndex: meta.stepIndex,
          outputKey: step.outputKey,
          attempt
        }, {
          phaseId,
          stepId: step.id,
          stepType: step.type,
          status: 'completed'
        });
        await this._safeTraceWrite('upsertStepTrace', createStepTraceRecord({
          ...stepTraceRecord,
          status: 'completed',
          finishedAt: new Date().toISOString(),
          durationMs: Date.now() - Date.parse(startedAt)
        }));
        return;
      } catch (error) {
        if (error instanceof CheckpointPauseError) {
          throw error;
        }

        const failureBoundary = this._resolveFailureBoundary(step);
        const failureMeta = error.workflowStepFailure || this._buildStepFailureMeta(
          record,
          step,
          { phaseId },
          error,
          { attempt, failureBoundary }
        );
        const failureAction = this._resolveFailureAction({
          step,
          definition,
          attempt,
          error,
          source: 'step_failure'
        });

        record.context.steps[step.id] = {
          status: 'failed',
          outputs: null,
          error: { message: failureMeta.errorMessage, code: failureMeta.errorCode },
          type: step.type,
          attempt,
          failureBoundary,
          recovery: recoveryMetadata
        };
        await this._recordEvent(record, 'workflow.step_failed', {
          stepId: step.id,
          stepType: step.type,
          phaseId,
          errorCode: failureMeta.errorCode,
          errorMessage: failureMeta.errorMessage,
          attempt,
          resolvedFailureAction: failureAction.action,
          failureBoundary
        }, {
          phaseId,
          stepId: step.id,
          stepType: step.type,
          status: 'failed'
        });
        await this._safeTraceWrite('writeLastError', failureMeta.lastErrorView);
        await this._safeTraceWrite('upsertStepTrace', createStepTraceRecord({
          ...stepTraceRecord,
          status: 'failed',
          finishedAt: new Date().toISOString(),
          durationMs: Date.now() - Date.parse(startedAt),
          error: {
            errorCode: failureMeta.errorCode,
            errorMessage: failureMeta.errorMessage
          }
        }));

        if (failureAction.action === 'retry') {
          await this._handleRetryAction(workflowId, step, record, phaseId, failureMeta, failureAction);
          attempt += 1;
          continue;
        }

        if (failureAction.action === 'checkpoint') {
          const checkpoint = await this._createFailureCheckpoint(workflowId, step, phaseId, failureMeta);
          await this._enterCheckpointWait(workflowId, step, record, phaseId, stepTraceRecord, startedAt, checkpoint);
          throw new CheckpointPauseError(`Failure checkpoint pending: ${step.id}`, checkpoint);
        }

        if (failureAction.action === 'restartPhase' || failureAction.action === 'rollbackToSnapshot') {
          await this._dispatchStepRecovery(workflowId, step, record, {
            phaseId,
            phaseIndex: meta.phaseIndex ?? 0,
            stepIndex: meta.stepIndex ?? 0
          }, failureAction);
        }

        error.workflowStepFailure = {
          ...failureMeta,
          attempt,
          failureBoundary,
          resolvedFailureAction: failureAction.action
        };
        throw error;
      }
    }
  }

  _emitEvent(event) {
    const workflowId = event.workflowId;
    const type = event.type;

    // Publish to EventBus (generic event schema)
    this.eventBus.publish(type, event);

    // Maintain backward compatibility with webSocketPusher
    if (this.webSocketPusher && typeof this.webSocketPusher.push === 'function') {
      this.webSocketPusher.push(workflowId, event).catch(err => {
        this._log('Event push failed', { workflowId, type, error: err.message });
      });
    }
  }

  async _recordEvent(record, type, payload, meta = {}) {
    const event = this._createKernelEvent(record, type, payload, meta);
    this._applyTraceEvent(record, event);
    this._emitEvent(event);
    await this._persistEvent(record.workflowId, event);
    await this._dispatchTraceSinkEvent(type, event);
    await this._safeTraceWrite('updateRunStatus', this._buildRunStatusView(record));
    return event;
  }

  async _persistEvent(workflowId, event) {
    if (this.stateRepository && typeof this.stateRepository.appendHistory === 'function') {
      await this.stateRepository.appendHistory(workflowId, event);
    }
  }

  async _updateWorkflowState(workflowId, patch) {
    if (this.stateRepository && typeof this.stateRepository.update === 'function') {
      await this.stateRepository.update(workflowId, patch);
    }
  }

  _createRunTraceContext() {
    return {
      sequence: 0,
      currentPhaseId: null,
      currentStepId: null,
      currentStepType: null,
      lastCompletedStep: null,
      lastFailedStep: null,
      lastError: null,
      lastEventAt: null,
      recentEvents: []
    };
  }

  _ensureTraceContext(record) {
    if (!record.traceContext) {
      record.traceContext = this._createRunTraceContext();
    }
    return record.traceContext;
  }

  _peekNextSequence(record) {
    const traceContext = this._ensureTraceContext(record);
    return traceContext.sequence + 1;
  }

  _nextSequence(record) {
    const traceContext = this._ensureTraceContext(record);
    traceContext.sequence += 1;
    return traceContext.sequence;
  }

  _createKernelEvent(record, type, payload, meta = {}) {
    return createTraceEvent({
      workflowId: record.workflowId,
      runToken: record.runToken,
      sequence: this._nextSequence(record),
      type,
      phaseId: meta.phaseId,
      stepId: meta.stepId,
      stepType: meta.stepType,
      status: meta.status,
      payload
    });
  }

  _applyTraceEvent(record, event) {
    const traceContext = this._ensureTraceContext(record);
    traceContext.lastEventAt = event.timestamp;
    if (event.phaseId !== undefined) {
      traceContext.currentPhaseId = event.phaseId;
    }
    if (event.stepId !== undefined) {
      traceContext.currentStepId = event.stepId;
    }
    if (event.stepType !== undefined) {
      traceContext.currentStepType = event.stepType;
    }

    if (event.type === 'workflow.step_completed') {
      traceContext.lastCompletedStep = {
        phaseId: event.phaseId,
        stepId: event.stepId,
        stepType: event.stepType
      };
    }

    if (event.type === 'workflow.step_failed') {
      traceContext.lastFailedStep = {
        phaseId: event.phaseId,
        stepId: event.stepId,
        stepType: event.stepType
      };
      traceContext.lastError = createLastErrorView({
        workflowId: record.workflowId,
        runToken: record.runToken,
        failedAt: event.timestamp,
        phaseId: event.phaseId,
        stepId: event.stepId,
        stepType: event.stepType,
        errorCode: event.payload?.errorCode || 'STEP_EXECUTION_FAILED',
        errorMessage: event.payload?.errorMessage || 'Step execution failed',
        causeType: 'step_failure',
        attempt: event.payload?.attempt || 1
      });
    }

    const recentEvent = {
      type: event.type,
      timestamp: event.timestamp,
      phaseId: event.phaseId || null,
      stepId: event.stepId || null,
      stepType: event.stepType || null,
      status: event.status || null,
      sequence: event.sequence
    };
    traceContext.recentEvents.push(recentEvent);
    const limit = this.config.observability.recentEventLimit || 20;
    if (traceContext.recentEvents.length > limit) {
      traceContext.recentEvents = traceContext.recentEvents.slice(-limit);
    }
  }

  _buildRunStatusView(record, stateOverride) {
    const traceContext = this._ensureTraceContext(record);
    const recoveryState = normalizeRecoveryState(record);
    return createRunStatusView({
      workflowId: record.workflowId,
      runToken: record.runToken,
      state: stateOverride || record.status,
      currentPhaseId: traceContext.currentPhaseId,
      currentStepId: traceContext.currentStepId,
      currentStepType: traceContext.currentStepType,
      checkpointState: record.checkpointState,
      recoveryCursor: recoveryState.currentCursor,
      lastEventAt: traceContext.lastEventAt,
      lastCompletedStep: traceContext.lastCompletedStep,
      lastFailedStep: traceContext.lastFailedStep,
      lastError: traceContext.lastError,
      recentEvents: traceContext.recentEvents
    });
  }

  _buildStepFailureMeta(record, step, meta, error, extras = {}) {
    const phaseId = meta.phaseId || step.phaseId || 'default';
    const errorMessage = error?.message || `Step ${step.id} failed`;
    const attempt = extras.attempt || 1;
    const lastErrorView = createLastErrorView({
      workflowId: record.workflowId,
      runToken: record.runToken,
      failedAt: new Date().toISOString(),
      phaseId,
      stepId: step.id,
      stepType: step.type,
      errorCode: 'STEP_EXECUTION_FAILED',
      errorMessage,
      causeType: 'step_failure',
      attempt
    });

    const traceContext = this._ensureTraceContext(record);
    traceContext.lastError = lastErrorView;
    traceContext.lastFailedStep = {
      phaseId,
      stepId: step.id,
      stepType: step.type
    };

    return {
      phaseId,
      stepId: step.id,
      stepType: step.type,
      errorCode: 'STEP_EXECUTION_FAILED',
      errorMessage,
      lastErrorView,
      attempt,
      failureBoundary: extras.failureBoundary || 'step',
      resolvedFailureAction: extras.resolvedFailureAction || 'fail'
    };
  }

  async _dispatchTraceSinkEvent(type, event) {
    const methodMap = {
      'workflow.started': 'onRunStarted',
      'workflow.step_started': 'onStepStarted',
      'workflow.step_completed': 'onStepCompleted',
      'workflow.step_failed': 'onStepFailed',
      'workflow.checkpoint_pending': 'onCheckpointPending',
      'workflow.checkpoint_approved': 'onCheckpointResolved',
      'workflow.checkpoint_rejected': 'onCheckpointResolved',
      'workflow.checkpoint_skipped': 'onCheckpointResolved',
      'workflow.checkpoint_modified': 'onCheckpointResolved',
      'workflow.checkpoint_timeout': 'onCheckpointResolved',
      'workflow.recovered': 'onRunRecovered',
      'workflow.completed': 'onRunCompleted',
      'workflow.failed': 'onRunFailed'
    };

    const methodName = methodMap[type];
    if (!methodName) {
      return;
    }

    await this._safeTraceWrite(methodName, event);
  }

  async _safeTraceWrite(methodName, ...args) {
    if (!this.traceSink || typeof this.traceSink[methodName] !== 'function') {
      return null;
    }

    try {
      return await this.traceSink[methodName](...args);
    } catch (error) {
      this._log('Trace sink write failed', { methodName, error: error.message });
      return null;
    }
  }

  async _callTraceSinkRead(methodName, ...args) {
    if (!this.traceSink || typeof this.traceSink[methodName] !== 'function') {
      return null;
    }

    try {
      return await this.traceSink[methodName](...args);
    } catch (error) {
      this._log('Trace sink read failed', { methodName, error: error.message });
      return null;
    }
  }

  _generateRunToken() {
    return `${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
  }

  _log(message, context = {}) {
    console.log(`[WorkflowKernel] ${message}`, JSON.stringify(context));
  }
}

class CheckpointPauseError extends Error {
  constructor(message, checkpoint) {
    super(message);
    this.name = 'CheckpointPauseError';
    this.checkpoint = checkpoint;
  }
}

class RecoveryDispatchSignal extends Error {
  constructor(recoveryAction, resumeMode) {
    super(`Recovery dispatched: ${recoveryAction}`);
    this.name = 'RecoveryDispatchSignal';
    this.recoveryAction = recoveryAction;
    this.resumeMode = resumeMode;
  }
}

module.exports = { WorkflowKernel, CheckpointPauseError, RecoveryDispatchSignal };
