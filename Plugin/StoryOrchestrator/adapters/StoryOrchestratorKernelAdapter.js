/**
 * StoryOrchestratorKernelAdapter — bridges StoryOrchestrator to WorkflowKernel.
 *
 * When USE_WORKFLOW_KERNEL is enabled, WorkflowEngine delegates phase execution
 * to WorkflowKernel via this adapter. When disabled, original phase classes run.
 *
 * This adapter is still in a transitional state. Its responsibilities currently
 * include:
 * 1. Kernel bridge and execution delegation
 * 2. Business snapshot / restore projection
 * 3. Legacy event compatibility
 * 4. StoryOrchestrator-specific helper and extraction glue
 *
 * The adapter-thinning change keeps the file intact for now, but keeps these
 * responsibility clusters on narrower seams so future refactors can split them
 * without reintroducing a monolithic coordination layer.
 */

const { WorkflowKernel } = require('../../../modules/workflowKernel');
const { StoryEventAdapter } = require('../../../modules/workflowKernel/adapters/StoryEventAdapter');
const { StoryStateRepositoryAdapter } = require('../../../modules/workflowKernel/persistence/StoryStateRepositoryAdapter');
const { WorkflowValidator } = require('../../../modules/workflowKernel/validators/WorkflowValidator');
const {
  createSchemaValidationStepHandler,
  extractWithMetrics,
  runExtractionStep
} = require('../../../modules/workflowKernel/pluginSdk');
const { SchemaValidator } = require('../utils/SchemaValidator');
const workflowContracts = require('../config/workflow-contracts');
const storySteps = require('../steps');

const ADAPTER_SEAM_STATES = Object.freeze({
  LONG_TERM_BRIDGE: 'long-term-bridge',
  TRANSITIONAL_RESIDUE: 'transitional-residue'
});

const ADAPTER_SEAM_INVENTORY = Object.freeze([
  Object.freeze({
    id: 'kernel-control-plane',
    label: 'Kernel Control Plane',
    state: ADAPTER_SEAM_STATES.LONG_TERM_BRIDGE,
    rationale: 'Creates the WorkflowKernel and repository bridge that remain the canonical execution handoff point for StoryOrchestrator.'
  }),
  Object.freeze({
    id: 'kernel-primitive-bridge',
    label: 'Kernel Primitive Bridge',
    state: ADAPTER_SEAM_STATES.LONG_TERM_BRIDGE,
    rationale: 'Registers kernel-native step handlers without turning the adapter into a second orchestration surface.'
  }),
  Object.freeze({
    id: 'story-step-glue',
    label: 'Story Step Glue',
    state: ADAPTER_SEAM_STATES.LONG_TERM_BRIDGE,
    rationale: 'Keeps plugin-owned step registration explicit while preventing generic SDK or platform semantics from leaking back into the adapter.'
  }),
  Object.freeze({
    id: 'compatibility-event-bridge',
    label: 'Compatibility Event Bridge',
    state: ADAPTER_SEAM_STATES.TRANSITIONAL_RESIDUE,
    rationale: 'Legacy event shaping still exists for compatibility, but it must remain a narrow delegation seam instead of regaining primary control semantics.'
  }),
  Object.freeze({
    id: 'kernel-runtime-delegation',
    label: 'Kernel Runtime Delegation',
    state: ADAPTER_SEAM_STATES.LONG_TERM_BRIDGE,
    rationale: 'The shouldContinue loop hook is a legitimate runtime handoff seam, not a place to grow a second control plane.'
  }),
  Object.freeze({
    id: 'business-projection-bridge',
    label: 'Business Projection Bridge',
    state: ADAPTER_SEAM_STATES.TRANSITIONAL_RESIDUE,
    rationale: 'Snapshot and recovery hooks are still adapter-adjacent, but phase 2 keeps them explicit and narrow until later state-boundary work can reduce them further.'
  })
]);

class StoryOrchestratorKernelAdapter {
  constructor({ stateManager, agentDispatcher, chapterOperations, contentValidator, config, legacyEventListener = null }) {
    this.stateManager = stateManager;
    this.agentDispatcher = agentDispatcher;
    this.chapterOperations = chapterOperations;
    this.contentValidator = contentValidator;
    this.config = config || {};
    this.legacyEventListener = typeof legacyEventListener === 'function' ? legacyEventListener : null;
    this.kernel = null;
    this.eventAdapter = null;
    this.useKernel = config.USE_WORKFLOW_KERNEL === 'true' || config.USE_WORKFLOW_KERNEL === true;
    this.snapshotGranularity = config.SNAPSHOT_GRANULARITY || 'phase_boundary';
    // snapshotGranularity: 'checkpoint_only' | 'phase_boundary' | 'every_step'

    // Extraction metrics for observability
    this.extractionMetrics = {
      totalAttempts: 0,
      totalSuccesses: 0,
      totalFailures: 0,
      byParser: {},
      byStep: {}
    };
    this.initializedSeams = [];
  }

  async initialize() {
    if (!this.useKernel) {
      console.log('[StoryOrchestratorKernelAdapter] WorkflowKernel is disabled, using legacy engine');
      return;
    }

    console.log('[StoryOrchestratorKernelAdapter] Initializing WorkflowKernel...');

    const stateRepository = this._createKernelStateRepository();

    this.kernel = this._createKernelControlPlane(stateRepository);
    this.initializedSeams = ['kernel-control-plane'];
    this._applyInitializationPlan(this._buildInitializationPlan());
    this._logInitializedKernelSeams();
  }

  _createKernelStateRepository() {
    return new StoryStateRepositoryAdapter(this.stateManager.repository || this.stateManager);
  }

  _createKernelControlPlane(stateRepository) {
    // Kernel bridge: create WorkflowKernel with the StoryOrchestrator-backed repository adapter.
    return new WorkflowKernel({
      agentDispatcher: this.agentDispatcher,
      stateRepository,
      config: this.config
    });
  }

  getAdapterSeamReport() {
    return ADAPTER_SEAM_INVENTORY.map((seam) => {
      const installationIndex = this.initializedSeams.indexOf(seam.id);
      return {
        ...seam,
        installed: installationIndex !== -1,
        installationOrder: installationIndex === -1 ? null : installationIndex + 1
      };
    });
  }

  getAdapterSeam(seamId) {
    const seam = this.getAdapterSeamReport().find((item) => item.id === seamId);
    return seam || null;
  }

  _buildInitializationPlan() {
    return [
      {
        seamId: 'kernel-primitive-bridge',
        install: () => this._installKernelBridgeSteps()
      },
      {
        seamId: 'story-step-glue',
        install: () => this._installStoryStepGlue()
      },
      {
        seamId: 'compatibility-event-bridge',
        install: () => this._installCompatibilityBridge()
      },
      {
        seamId: 'kernel-runtime-delegation',
        install: () => this._installKernelRuntimeBridge()
      },
      {
        seamId: 'business-projection-bridge',
        install: () => this._installProjectionBridge()
      }
    ];
  }

  _applyInitializationPlan(plan) {
    for (const seam of plan) {
      seam.install();
      this.initializedSeams.push(seam.seamId);
    }
  }

  _installKernelBridgeSteps() {
    this._registerBuiltInKernelSteps();
  }

  _installStoryStepGlue() {
    // Story-specific step glue is a legal plugin seam, but keep it focused on
    // domain handlers instead of letting generic platform semantics accumulate.
    this._registerCustomStepTypes();
  }

  _installCompatibilityBridge() {
    // Compatibility events remain transitional residue; make them explicit so
    // future cleanup does not confuse them with long-term bridge ownership.
    this._registerKernelEventCompatibilityBridge();
  }

  _installKernelRuntimeBridge() {
    // Keep shouldContinue as a narrow runtime seam instead of growing a second
    // control plane inside the adapter.
    this.kernel.config.shouldContinue = this.shouldContinue.bind(this);
  }

  _installProjectionBridge() {
    // Snapshot and recovery projection still sit near the adapter, but keep
    // them behind lifecycle hooks rather than a broader coordination layer.
    this._registerBackupRestoreHooks();
  }

  _logInitializedKernelSeams() {
    const installedSeams = this.getAdapterSeamReport()
      .filter((seam) => seam.installed)
      .map((seam) => `${seam.installationOrder}:${seam.id}:${seam.state}`);
    console.log('[StoryOrchestratorKernelAdapter] Adapter seams:', installedSeams);
    console.log('[StoryOrchestratorKernelAdapter] WorkflowKernel initialized with step registry:',
      Array.from(this.kernel.stepRegistry.handlers.keys()));
  }

  _registerBuiltInKernelSteps() {
    this.kernel.stepRegistry.register('agentCall', this._createAgentCallStepHandler());
    this._registerKernelPrimitiveSteps();
  }

  _createAgentCallStepHandler() {
    return async (step, stepContext) => {
      const { kernel, context } = stepContext;
      const { agentDispatcher } = kernel;

      if (!agentDispatcher) {
        return { status: 'failed', error: new Error('AgentDispatcher not available in kernel') };
      }

      const agentId = step.agent;
      if (!agentId) {
        return { status: 'failed', error: new Error('agentCall step missing "agent" field') };
      }

      let resolvedInput = {};
      try {
        resolvedInput = this._resolveAgentCallInput(step, context);
      } catch (err) {
        return { status: 'failed', error: new Error(`Input resolution failed: ${err.message}`) };
      }

      const prompt = this._buildAgentCallPrompt(agentId, resolvedInput);
      const options = step.options || {};

      try {
        const result = await agentDispatcher.delegate(agentId, prompt, options);
        return this._completeAgentCallResult(result, step);
      } catch (error) {
        return { status: 'failed', error: new Error(`Agent delegation failed: ${error.message}`) };
      }
    };
  }

  _resolveAgentCallInput(step, context) {
    const { resolveInput } = require('../../../modules/workflowKernel/steps/AgentCallStep');
    return step.input ? resolveInput(step.input, context) : {};
  }

  _buildAgentCallPrompt(agentId, resolvedInput) {
    let prompt = resolvedInput.prompt || JSON.stringify(resolvedInput);

    if (agentId === 'worldBuilder') {
      prompt = `【世界观设定任务】

请基于以下故事梗概，构建一个完整的世界观设定。

=== 故事梗概 ===
${resolvedInput.prompt || ''}

=== 题材类型 ===
${resolvedInput.genre || '通用'}

=== 文风要求 ===
${resolvedInput.stylePreference || '保持叙事流畅，注重逻辑严谨'}

=== 输出要求 ===
请以JSON格式输出完整世界观，结构如下：
{
  "setting": "时代背景与地理环境描述（至少50字）",
  "rules": {
    "physical": "物理规则描述",
    "special": "特殊设定描述（如有）",
    "limitations": "限制与代价描述"
  },
  "factions": [
    { "name": "势力名称", "description": "势力描述", "relationships": ["与其他势力的关系"] }
  ],
  "history": {
    "keyEvents": ["关键历史事件"],
    "coreConflicts": ["核心矛盾"]
  },
  "sceneNorms": ["场景规范列表"],
  "secrets": ["隐藏秘密/伏笔"]
}`;
    } else if (agentId === 'characterDesigner') {
      prompt = `【人物塑造任务】

请基于以下故事梗概，构建详细的人物档案。

=== 故事梗概 ===
${resolvedInput.prompt || ''}

=== 题材类型 ===
${resolvedInput.genre || '通用'}

=== 文风要求 ===
${resolvedInput.stylePreference || '保持叙事流畅，注重人物刻画'}

=== 输出要求 ===
请以JSON格式输出完整人物档案，结构如下：
{
  "protagonists": [
    {
      "name": "人物姓名",
      "identity": "身份描述",
      "appearance": "外貌特征",
      "personality": ["性格关键词"],
      "background": "背景故事",
      "motivation": "核心动机",
      "innerConflict": "内在矛盾",
      "growthArc": "成长弧线"
    }
  ],
  "supportingCharacters": [
    { "name": "配角姓名", "identity": "身份描述", "role": "功能定位", "relationship": "与主角的关系" }
  ],
  "relationshipNetwork": {
    "direct": [{"from": "人物A", "to": "人物B", "type": "关系类型"}],
    "hidden": [{"from": "人物A", "to": "人物B", "secret": "隐藏关系"}]
  },
  "oocRules": { "角色名": ["行为边界描述"] }
}`;
    }

    return prompt;
  }

  _completeAgentCallResult(result, step) {
    // Extraction remains adapter-private helper glue instead of broadening the
    // bridge into a general-purpose platform orchestration surface.
    if (step.extraction) {
      return this._runExtraction(result, step);
    }

    return {
      status: 'completed',
      output: { content: result.content, markers: result.markers, raw: result.raw }
    };
  }

  _registerKernelPrimitiveSteps() {
    this.kernel.stepRegistry.register('checkpoint', require('../../../modules/workflowKernel/steps/CheckpointStep').checkpointStep);
    this.kernel.stepRegistry.register('guard', require('../../../modules/workflowKernel/steps/GuardStep').guardStep);
    this.kernel.stepRegistry.register('loop', require('../../../modules/workflowKernel/steps/LoopStep').loopStep);
    this.kernel.stepRegistry.register('parallelGroup', require('../../../modules/workflowKernel/steps/ParallelGroupStep').parallelGroupStep);
    this.kernel.stepRegistry.register('noop', async () => ({ status: 'completed', output: {} }));
  }

  _registerKernelEventCompatibilityBridge() {
    this.eventAdapter = new StoryEventAdapter(this._createLegacyEventSink());
    const kernelEventTypes = this._getKernelCompatibilityEventTypes();

    for (const eventType of kernelEventTypes) {
      this.kernel.onEvent(eventType, (event) => {
        this._handleKernelCompatibilityEvent(event);
      });
    }
  }

  _createLegacyEventSink() {
    return {
      push: async (workflowId, event) => {
        await this._emitLegacyEvent(workflowId, event);
        if (this.legacyEventListener) {
          await this.legacyEventListener(workflowId, event);
        }
      }
    };
  }

  _getKernelCompatibilityEventTypes() {
    return [
      'workflow.started', 'workflow.state_changed', 'workflow.step_completed',
      'workflow.step_failed', 'workflow.retrying', 'workflow.checkpoint_pending',
      'workflow.checkpoint_approved', 'workflow.checkpoint_rejected',
      'workflow.checkpoint_skipped', 'workflow.checkpoint_modified',
      'workflow.checkpoint_timeout', 'workflow.completed', 'workflow.failed',
      'workflow.rollback'
    ];
  }

  _handleKernelCompatibilityEvent(event) {
    this.eventAdapter.onKernelEvent(event.workflowId, event);
    this._onKernelEventForSnapshot(event);
  }

  /**
   * Register backup/restore lifecycle hooks with the kernel.
   * @private
   */
  _registerBackupRestoreHooks() {
    this.kernel.registerLifecycleHook('beforeStep', this._handleBeforeStepSnapshot.bind(this));
    this.kernel.registerLifecycleHook('afterCheckpoint', this._handleAfterCheckpointSnapshot.bind(this));
    this.kernel.registerLifecycleHook('onRecovery', this._handleRecoveryStateRestore.bind(this));
  }

  async _handleBeforeStepSnapshot({ workflowId, step, record }) {
    if (!this.stateManager || !this.stateManager.repository) return;
    if (!step || !step.id) return;

    const definition = this.kernel.activeWorkflows.get(workflowId)?.definition;
    const phaseName = this._determinePhaseFromContext(record.executionCursor, definition);
    if (!phaseName) return;

    const isCheckpointStep = step.type === 'checkpoint';
    const isAgentCall = step.type === 'agentCall';

    if (isCheckpointStep) {
      this._createBusinessSnapshot(workflowId, phaseName, record.context, 'pre_checkpoint');
      return;
    }

    if (this.snapshotGranularity === 'every_step') {
      this._createBusinessSnapshot(workflowId, phaseName, record.context, 'before_step');
      return;
    }

    if (this.snapshotGranularity === 'phase_boundary' && isAgentCall) {
      const phaseSteps = this._getPhaseSteps(record.executionCursor, definition);
      const currentStepIndex = this._getCurrentStepIndex(record.executionCursor);
      const firstAgentCallIndex = phaseSteps.findIndex((registeredStep) => registeredStep.type === 'agentCall');
      if (currentStepIndex === firstAgentCallIndex) {
        this._createBusinessSnapshot(workflowId, phaseName, record.context, 'phase_start');
      }
    }
  }

  async _handleAfterCheckpointSnapshot({ workflowId, checkpointId, action, record }) {
    if (!this.stateManager || !this.stateManager.repository) return;
    if (!['approve', 'skip', 'modify', 'timeout'].includes(action)) return;

    const definition = this.kernel.activeWorkflows.get(workflowId)?.definition;
    const phaseName = this._determinePhaseFromContext(record.executionCursor, definition);
    if (!phaseName) return;

    const snapshotId = this._createBusinessSnapshot(workflowId, phaseName, record.context, 'approved');

    if (this.kernel.stateRepository && snapshotId) {
      await this.kernel.stateRepository.appendHistory(workflowId, {
        type: 'workflow.snapshot_created',
        timestamp: new Date().toISOString(),
        payload: {
          snapshotId,
          workflowId,
          phaseName,
          checkpointId,
          snapshotType: 'approved',
          stepId: record.executionCursor
        }
      });
    }
  }

  async _handleRecoveryStateRestore({ workflowId, record }) {
    if (!this.stateManager || !this.stateManager.repository) return;

    const phaseName = this._determinePhaseFromContext(record.executionCursor, record.definition);
    if (!phaseName) {
      const story = this.stateManager.repository.getStory(workflowId);
      if (story && story.current_phase) {
        const phaseMap = { phase1: 'phase1', phase2: 'phase2', phase3: 'phase3' };
        const inferredPhase = phaseMap[story.current_phase];
        if (inferredPhase) {
          this._restoreAndMergeBusinessState(workflowId, inferredPhase, record);
        }
      }
      return;
    }

    this._restoreAndMergeBusinessState(workflowId, phaseName, record);
  }

  /**
   * Restore business state from approved snapshots and merge into kernel record context.
   * Restores prior phases AND the target phase itself (for crash recovery mid-phase).
   * @private
   */
  _restoreAndMergeBusinessState(workflowId, phaseName, record) {
    // Restore prior phases so cross-phase $ref resolution works
    const restoredOutputs = this._buildRestoredOutputs(workflowId, phaseName);

    // Also restore the target phase itself (we may have crashed mid-phase)
    const targetSnapshot = this._restoreBusinessSnapshot(workflowId, phaseName);
    if (targetSnapshot) {
      if (phaseName === 'phase1') {
        if (targetSnapshot.worldview) restoredOutputs.worldview = targetSnapshot.worldview;
        if (targetSnapshot.characters) restoredOutputs.characters = targetSnapshot.characters;
        if (targetSnapshot.validation) restoredOutputs.phase1Validation = targetSnapshot.validation;
      }
      if (phaseName === 'phase2') {
        if (targetSnapshot.outline) restoredOutputs.outline = targetSnapshot.outline;
        if (targetSnapshot.chapters) {
          restoredOutputs.chaptersResult = {
            chapters: targetSnapshot.chapters,
            completedCount: targetSnapshot.currentChapter || targetSnapshot.chapters.length,
            totalWordCount: targetSnapshot.chapters.reduce((sum, ch) => sum + (ch.metrics?.counts?.actualCount || 0), 0)
          };
        }
      }
      if (phaseName === 'phase3') {
        if (targetSnapshot.polishedChapters) {
          restoredOutputs.polishedChapters = {
            chapters: targetSnapshot.polishedChapters,
            iterationCount: targetSnapshot.iterationCount || 0
          };
        }
      }
    }

    if (!restoredOutputs || Object.keys(restoredOutputs).length === 0) {
      console.log(`[StoryOrchestratorKernelAdapter] No approved snapshots to restore for ${workflowId}/${phaseName}`);
      return;
    }

    // Merge restored outputs into record context so steps can reference them via $ref
    if (!record.context) {
      record.context = { inputs: {}, outputs: {}, steps: {} };
    }
    if (!record.context.outputs) {
      record.context.outputs = {};
    }

    Object.assign(record.context.outputs, restoredOutputs);

    console.log(`[StoryOrchestratorKernelAdapter] Restored business state for ${workflowId}/${phaseName}:`, Object.keys(restoredOutputs));
  }

  /**
   * Register all StoryOrchestrator-specific custom step types
   * @private
   */
  _registerCustomStepTypes() {
    this._registerStoryValidationSteps();
    this._registerStoryGenerationSteps();
  }

  _registerStoryValidationSteps() {
    this.kernel.stepRegistry.register('parseAgentJson', storySteps.createParseAgentJsonStep(this));
    this.kernel.stepRegistry.register('schemaValidate', createSchemaValidationStepHandler({
      validators: {
        worldview: SchemaValidator.validateWorldview.bind(SchemaValidator),
        characters: SchemaValidator.validateCharacters.bind(SchemaValidator),
        outline: SchemaValidator.validateOutline.bind(SchemaValidator)
      }
    }));
    this.kernel.stepRegistry.register('storyValidate', storySteps.createStoryValidateStep(this));
    this.kernel.stepRegistry.register('parseOutline', storySteps.createParseOutlineStep(this));
  }

  _registerStoryGenerationSteps() {
    this.kernel.stepRegistry.register('generateOutline', storySteps.createGenerateOutlineStep(this));
    this.kernel.stepRegistry.register('produceChapters', storySteps.createProduceChaptersStep(this));
    this.kernel.stepRegistry.register('polishChapters', storySteps.createPolishChaptersStep(this));
    this.kernel.stepRegistry.register('finalEdit', storySteps.createFinalEditStep(this));
  }

  /**
   * Run two-phase extraction on an agent result.
   * @private
   */
  _runExtraction(result, step) {
    return runExtractionStep(result, step, {
      logger: { log: console.log, error: console.error, warn: console.warn },
      onMetrics: this._recordExtractionMetrics.bind(this)
    });
  }

  /**
   * Extract using ExtractionLayer with metrics tracking.
   * @private
   */
  _extractWithLayer(raw, options, stepId) {
    return extractWithMetrics(raw, options, {
      stepId,
      logger: { log: console.log, error: console.error, warn: console.warn },
      onMetrics: this._recordExtractionMetrics.bind(this)
    });
  }

  /**
   * Record extraction metrics for observability.
   * @private
   */
  _recordExtractionMetrics(stepId, meta, success) {
    this.extractionMetrics.totalAttempts++;
    if (success) {
      this.extractionMetrics.totalSuccesses++;
    } else {
      this.extractionMetrics.totalFailures++;
    }

    if (!this.extractionMetrics.byStep[stepId]) {
      this.extractionMetrics.byStep[stepId] = { attempts: 0, successes: 0, failures: 0 };
    }
    this.extractionMetrics.byStep[stepId].attempts++;
    if (success) {
      this.extractionMetrics.byStep[stepId].successes++;
    } else {
      this.extractionMetrics.byStep[stepId].failures++;
    }

    if (meta && meta.attempts) {
      for (const attempt of meta.attempts) {
        const parser = attempt.parser || 'unknown';
        if (!this.extractionMetrics.byParser[parser]) {
          this.extractionMetrics.byParser[parser] = { attempts: 0, successes: 0, failures: 0 };
        }
        this.extractionMetrics.byParser[parser].attempts++;
        if (attempt.success) {
          this.extractionMetrics.byParser[parser].successes++;
        } else {
          this.extractionMetrics.byParser[parser].failures++;
        }
      }
    }
  }

  /**
   * Get extraction metrics for diagnostics.
   * @returns {Object}
   */
  getExtractionMetrics() {
    return { ...this.extractionMetrics };
  }

  /**
   * Extract structured JSON with repair tracking
   * @private
   */
  _extractStructuredJsonWithRepair(content) {
    let repairUsed = false;
    if (!content || typeof content !== 'string') {
      return { parsed: null, raw: content, repairUsed };
    }

    const startIndex = content.indexOf('{');
    if (startIndex === -1) {
      return { parsed: { raw: content }, raw: content, repairUsed };
    }

    const candidate = content.slice(startIndex).trim();
    try {
      return { parsed: JSON.parse(candidate), raw: content, repairUsed };
    } catch (error) {
      const repaired = this._repairTruncatedJson(candidate);
      if (repaired) {
        try {
          return { parsed: JSON.parse(repaired), raw: content, repairUsed: true };
        } catch (repairError) {
          // Fall through
        }
      }
    }

    const endIndex = content.lastIndexOf('}');
    if (endIndex > startIndex) {
      const boundedCandidate = content.slice(startIndex, endIndex + 1);
      try {
        return { parsed: JSON.parse(boundedCandidate), raw: content, repairUsed };
      } catch (boundedError) {
        const repaired = this._repairTruncatedJson(boundedCandidate);
        if (repaired) {
          try {
            return { parsed: JSON.parse(repaired), raw: content, repairUsed: true };
          } catch (repairError) {
            // Fall through
          }
        }
      }
    }

    return { parsed: { raw: content }, raw: content, repairUsed: false };
  }

  /**
   * Repair truncated JSON
   * @private
   */
  _repairTruncatedJson(input) {
    if (!input || typeof input !== 'string') {
      return null;
    }
    let result = '';
    let inString = false;
    let escaped = false;
    let squareDepth = 0;
    let braceDepth = 0;

    for (let i = 0; i < input.length; i++) {
      const char = input[i];
      result += char;
      if (escaped) { escaped = false; continue; }
      if (char === '\\') { escaped = true; continue; }
      if (char === '"') { inString = !inString; continue; }
      if (inString) { continue; }
      if (char === '{') braceDepth++;
      if (char === '}') braceDepth = Math.max(0, braceDepth - 1);
      if (char === '[') squareDepth++;
      if (char === ']') squareDepth = Math.max(0, squareDepth - 1);
    }

    result = result.replace(/,\s*$/, '');
    if (inString) result += '"';
    while (squareDepth > 0) { result = result.replace(/,\s*$/, ''); result += ']'; squareDepth--; }
    while (braceDepth > 0) { result = result.replace(/,\s*$/, ''); result += '}'; braceDepth--; }
    result = result.replace(/,\s*([}\]])/g, '$1');
    return result;
  }

  // ==================== Business-State Snapshot / Restore ====================

  /**
   * Kernel event hook for automatic business-state snapshots.
   * Respects snapshotGranularity config.
   * @private
   */
  _onKernelEventForSnapshot(event) {
    if (!this.stateManager || !this.stateManager.repository) return;

    const { workflowId, type } = event;
    const active = this.kernel.activeWorkflows.get(workflowId);
    if (!active) return;

    const { record, definition } = active;
    const phaseName = this._determinePhaseFromContext(record.executionCursor, definition);
    if (!phaseName) return;

    // Always snapshot on checkpoint approval (phase boundary)
    if (
      type === 'workflow.checkpoint_approved'
      || type === 'workflow.checkpoint_skipped'
      || type === 'workflow.checkpoint_modified'
      || type === 'workflow.checkpoint_timeout'
    ) {
      this._createBusinessSnapshot(workflowId, phaseName, record.context, 'approved');
      return;
    }

    // Snapshot on workflow completion
    if (type === 'workflow.completed') {
      this._createBusinessSnapshot(workflowId, phaseName, record.context, 'approved');
      return;
    }

    // Granularity: phase_boundary — snapshot at last step of a phase
    if (this.snapshotGranularity === 'phase_boundary' && type === 'workflow.step_completed') {
      const isLastStep = this._isLastStepOfPhase(record.executionCursor, definition);
      if (isLastStep) {
        this._createBusinessSnapshot(workflowId, phaseName, record.context, 'candidate');
      }
      return;
    }

    // Granularity: every_step
    if (this.snapshotGranularity === 'every_step' && type === 'workflow.step_completed') {
      this._createBusinessSnapshot(workflowId, phaseName, record.context, 'candidate');
      return;
    }
  }

  /**
   * Create a business-state snapshot in StoryOrchestrator's snapshots table.
   * @private
   */
  _createBusinessSnapshot(storyId, phaseName, context, snapshotType) {
    try {
      const payload = this._extractBusinessPayload(phaseName, context);
      if (!payload) {
        console.log(`[StoryOrchestratorKernelAdapter] No business state to snapshot for ${storyId}/${phaseName}`);
        return null;
      }

      const repo = this.stateManager.repository;
      const snapshotId = repo.createSnapshot({
        story_id: storyId,
        phase_name: phaseName,
        snapshot_type: snapshotType || 'candidate',
        payload_json: payload,
        schema_version: 'kernel.v1',
        schema_valid: true
      });

      // Update story record with latest snapshot reference
      const snapshotField = `current_${phaseName}_snapshot_id`;
      const story = repo.getStory(storyId);
      if (story) {
        repo.updateStory(storyId, { [snapshotField]: snapshotId }, story.version);
      }

      console.log(`[StoryOrchestratorKernelAdapter] Business snapshot created: ${snapshotId} for ${storyId}/${phaseName} (${snapshotType})`);
      return snapshotId;
    } catch (err) {
      console.error('[StoryOrchestratorKernelAdapter] Snapshot creation failed:', err.message);
      return null;
    }
  }

  /**
   * Restore StoryOrchestrator business state from latest approved snapshot.
   * Returns an object that can be merged into initialContext/outputs.
   * @private
   */
  _restoreBusinessSnapshot(storyId, phaseName) {
    try {
      const repo = this.stateManager.repository;
      const snapshot = repo.getLatestApprovedSnapshot(storyId, phaseName);
      if (!snapshot) return null;
      return JSON.parse(snapshot.payload_json);
    } catch (err) {
      console.error('[StoryOrchestratorKernelAdapter] Snapshot restore failed:', err.message);
      return null;
    }
  }

  /**
   * Build restoredOutputs map from approved snapshots for prior phases.
   * When executing phaseN, restores snapshots from phase1..phase(N-1).
   * @private
   */
  _buildRestoredOutputs(storyId, targetPhase = null) {
    const restored = {};

    const phaseOrder = ['phase1', 'phase2', 'phase3'];
    const targetIndex = targetPhase ? phaseOrder.indexOf(targetPhase) : phaseOrder.length;

    for (let i = 0; i < targetIndex; i++) {
      const phaseName = phaseOrder[i];
      const snapshot = this._restoreBusinessSnapshot(storyId, phaseName);
      if (!snapshot) continue;

      const restoredOutputs = workflowContracts.buildRestoreOutputs(phaseName, snapshot);
      if (restoredOutputs.chaptersResult?.chapters && restoredOutputs.chaptersResult.totalWordCount === undefined) {
        restoredOutputs.chaptersResult.totalWordCount = restoredOutputs.chaptersResult.chapters
          .reduce((sum, ch) => sum + (ch.metrics?.counts?.actualCount || 0), 0);
      }

      Object.assign(restored, mergeNestedOutputs(restored, restoredOutputs));
    }

    return restored;
  }

  /**
   * Extract business payload shaped like StoryOrchestrator phase objects
   * from kernel execution context.outputs.
   * @private
   */
  _extractBusinessPayload(phaseName, context) {
    const outputs = context.outputs || {};
    const payload = workflowContracts.buildSnapshotPayload(phaseName, outputs);

    if (!payload || Object.keys(payload).length === 0) {
      return null;
    }

    if (phaseName === 'phase1') {
      payload.userConfirmed = false;
      payload.checkpointId = null;
      payload.status = 'running';
    } else if (phaseName === 'phase2') {
      payload.userConfirmed = false;
      payload.checkpointId = null;
      payload.status = 'running';
    } else if (phaseName === 'phase3') {
      payload.finalValidation = null;
      payload.userConfirmed = false;
      payload.checkpointId = null;
      payload.status = 'running';
    }

    return payload;
  }

  /**
   * Determine phase name from execution cursor and workflow definition.
   * @private
   */
  _determinePhaseFromContext(executionCursor, definition) {
    if (!executionCursor || !definition || !definition.phases) return null;
    const phaseCursor = executionCursor.find(c => c.phase !== undefined);
    if (!phaseCursor) return null;
    const phase = definition.phases[phaseCursor.phase];
    return phase?.id || null;
  }

  /**
   * Get all steps for the current phase from execution cursor.
   * @private
   */
  _getPhaseSteps(executionCursor, definition) {
    if (!executionCursor || !definition || !definition.phases) return [];
    const phaseCursor = executionCursor.find(c => c.phase !== undefined);
    if (!phaseCursor) return [];
    const phase = definition.phases[phaseCursor.phase];
    return phase?.steps || [];
  }

  /**
   * Get current step index from execution cursor.
   * @private
   */
  _getCurrentStepIndex(executionCursor) {
    if (!executionCursor) return -1;
    const stepCursor = executionCursor.find(c => c.step !== undefined);
    return stepCursor ? stepCursor.step : -1;
  }

  /**
   * Check if execution cursor is at the last step of the current phase.
   * @private
   */
  _isLastStepOfPhase(executionCursor, definition) {
    if (!executionCursor || !definition || !definition.phases) return false;
    const phaseCursor = executionCursor.find(c => c.phase !== undefined);
    const stepCursor = executionCursor.find(c => c.step !== undefined);
    if (!phaseCursor || stepCursor === undefined) return false;
    const phase = definition.phases[phaseCursor.phase];
    if (!phase || !phase.steps) return false;
    return stepCursor.step === phase.steps.length - 1;
  }

  /**
   * Execute a phase using WorkflowKernel (when enabled)
   */
  async executePhase(storyId, phaseName, definition) {
    if (!this.useKernel || !this.kernel) {
      throw new Error('WorkflowKernel is not enabled or initialized');
    }

    // Validate definition
    const validator = new WorkflowValidator(this.kernel.stepRegistry);
    const validation = validator.validate(definition);
    if (!validation.valid) {
      throw new Error(`Workflow validation failed: ${validation.errors.join('; ')}`);
    }

    // Restore prior-phase snapshots so steps can reference earlier outputs
    const restoredOutputs = this._buildRestoredOutputs(storyId, phaseName);

    // Execute workflow
    const result = await this.kernel.execute(storyId, definition, { storyId }, restoredOutputs);
    await this._syncStoryRuntimeState(storyId, result, definition, { fallbackPhase: phaseName });
    return result;
  }

  /**
   * Execute the full workflow definition for a story
   */
  async executeWorkflow(storyId, initialContext = {}) {
    if (!this.useKernel || !this.kernel) {
      throw new Error('WorkflowKernel is not enabled or initialized');
    }

    const path = require('path');
    const definitionPath = path.join(__dirname, '..', 'config', 'workflow-definition.js');
    const fullDefinition = require(definitionPath);

    const validator = new WorkflowValidator(this.kernel.stepRegistry);
    const validation = validator.validate(fullDefinition);
    if (!validation.valid) {
      throw new Error(`Workflow validation failed: ${validation.errors.join('; ')}`);
    }

    // Restore previous phase business-state snapshots into kernel context outputs
    // so that later phases can reference earlier phase outputs via $ref
    const restoredOutputs = this._buildRestoredOutputs(storyId);

    const result = await this.kernel.execute(storyId, fullDefinition, { ...initialContext, storyId }, restoredOutputs);
    await this._syncStoryRuntimeState(storyId, result, fullDefinition);
    return result;
  }

  /**
   * shouldContinue — evaluates whether a LoopStep should execute another iteration.
   *
   * Context shape: { inputs: {...}, outputs: {...}, steps: {...} }
   * Stops when:
   *   - maxIterations reached
   *   - qualityThreshold met (if quality score is present)
   *   - explicit stop signal in outputs
   */
  shouldContinue(context) {
    const outputs = context.outputs || {};
    const inputs = context.inputs || {};

    const maxIterations = inputs.maxIterations || inputs.MAX_PHASE_ITERATIONS || 5;
    const currentIteration = outputs.iterationCount || outputs.polishIteration || 0;

    if (currentIteration >= maxIterations) {
      return false;
    }

    const qualityThreshold = inputs.qualityThreshold || inputs.QUALITY_THRESHOLD || 8.0;
    const qualityScore = outputs.averageQualityScore || outputs.qualityScore || 0;

    // If we have a meaningful quality score and it's below threshold, continue polishing
    if (qualityScore > 0 && qualityScore < qualityThreshold) {
      return true;
    }

    // If quality threshold is met, stop
    if (qualityScore >= qualityThreshold) {
      return false;
    }

    // If an explicit stop signal is present, honor it
    if (outputs.stopLoop === true || outputs.shouldStop === true) {
      return false;
    }

    // Default: allow continuing up to max iterations
    return currentIteration < maxIterations;
  }

  /**
   * Map StoryOrchestrator story state to WorkflowKernel execution state.
   */
  mapStoryStateToKernelState(story) {
    if (!story || !story.workflow) return 'idle';

    const wfState = story.workflow.state;

    // Direct mapping for kernel-managed states
    if (['running', 'waiting_checkpoint', 'failed', 'completed', 'recovering', 'retrying'].includes(wfState)) {
      return wfState;
    }

    // Legacy phase-based mapping
    if (story.finalOutput || story.phase3?.userConfirmed) return 'completed';
    if (story.phase3?.status === 'pending_confirmation' || story.phase2?.status === 'pending_confirmation' || story.phase1?.status === 'pending_confirmation') {
      return 'waiting_checkpoint';
    }
    if (story.phase1?.status === 'running' || story.phase2?.status === 'running' || story.phase3?.status === 'running') {
      return 'running';
    }
    if (story.phase1?.status === 'failed' || story.phase2?.status === 'failed' || story.phase3?.status === 'failed') {
      return 'failed';
    }

    return 'idle';
  }

  /**
   * Map WorkflowKernel execution state back to StoryOrchestrator story state.
   */
  mapKernelStateToStoryState(kernelState, currentPhase = 'phase1') {
    const phaseStateMap = {
      phase1: { status: 'phase1_running', phase: 'phase1' },
      phase2: { status: 'phase2_running', phase: 'phase2' },
      phase3: { status: 'phase3_running', phase: 'phase3' }
    };

    switch (kernelState) {
      case 'running':
        return phaseStateMap[currentPhase] || phaseStateMap.phase1;
      case 'waiting_checkpoint':
        return { status: `${currentPhase}_waiting_checkpoint`, phase: currentPhase };
      case 'failed':
        return { status: `${currentPhase}_failed`, phase: currentPhase };
      case 'completed':
        return { status: 'completed', phase: 'completed' };
      case 'recovering':
        return { status: `${currentPhase}_recovering`, phase: currentPhase };
      case 'retrying':
        return { status: `${currentPhase}_retrying`, phase: currentPhase };
      default:
        return { status: 'idle', phase: 'phase1' };
    }
  }

  /**
   * Synchronize retry context from kernel record to StoryOrchestrator story state.
   */
  async syncRetryContext(storyId, kernelRecord) {
    if (!kernelRecord || !kernelRecord.retryContext) return;

    const retryContext = {
      phase: kernelRecord.retryContext.phase || kernelRecord.context?.currentPhase,
      step: kernelRecord.retryContext.step || 'unknown',
      attempt: kernelRecord.retryContext.attempt || 0,
      maxAttempts: kernelRecord.retryContext.maxAttempts || this.config.MAX_PHASE_RETRY_ATTEMPTS || 3,
      lastError: kernelRecord.retryContext.lastError || null
    };

    await this.stateManager.updateWorkflow(storyId, { retryContext });
  }

  _buildRuntimeView(record, definition, options = {}) {
    const executionCursor = record?.executionCursor || record?.execution_cursor || record?.current_step || [];
    const fallbackPhase = options.fallbackPhase || null;
    const phaseName = this._determinePhaseFromContext(executionCursor, definition)
      || fallbackPhase
      || record?.context?.currentPhase
      || 'phase1';
    const phaseSteps = this._getPhaseSteps(executionCursor, definition);
    const stepIndex = this._getCurrentStepIndex(executionCursor);
    const currentStep = Number.isInteger(stepIndex) && stepIndex >= 0
      ? phaseSteps[stepIndex]?.id || null
      : null;
    const kernelState = record?.status || record?.state || 'idle';
    const storyState = this.mapKernelStateToStoryState(kernelState, phaseName);

    return {
      state: kernelState,
      currentPhase: storyState.phase || phaseName,
      currentStep,
      activeCheckpoint: record?.checkpointState?.checkpointId || record?.checkpointState?.id || null,
      checkpointState: record?.checkpointState || null,
      recoveryCursor: record?.recoveryCursor || record?.recoveryState?.currentCursor || null,
      storyStatus: storyState.status
    };
  }

  async _syncStoryRuntimeState(storyId, kernelRecord, definition, options = {}) {
    if (!this.stateManager || !kernelRecord) {
      return null;
    }

    const runtimeView = this._buildRuntimeView(kernelRecord, definition, options);

    if (typeof this.stateManager.updateWorkflow === 'function') {
      await this.stateManager.updateWorkflow(storyId, {
        state: runtimeView.state,
        currentPhase: runtimeView.currentPhase,
        currentStep: runtimeView.currentStep,
        runToken: kernelRecord.runToken || kernelRecord.run_token || undefined
      });
    }

    if (typeof this.stateManager.updateStory === 'function') {
      await this.stateManager.updateStory(storyId, {
        status: runtimeView.storyStatus
      });
    }

    await this.syncRetryContext(storyId, kernelRecord);
    return runtimeView;
  }

  /**
   * Emit legacy event through stateManager
   */
  async _emitLegacyEvent(storyId, event) {
    try {
      const phaseName = event.payload?.phase || 'unknown';
      await this._appendLegacyWorkflowEventHistory(storyId, event, phaseName);

      if (this._isLegacyCheckpointPendingEvent(event) && event.payload?.checkpointId) {
        await this._syncLegacyPendingCheckpoint(storyId, phaseName, event.payload);
      }

      if (this._isLegacyCheckpointResolvedEvent(event)) {
        await this.stateManager.clearActiveCheckpoint(storyId);
      }
    } catch (err) {
      console.error('[StoryOrchestratorKernelAdapter] Event emit failed:', err.message);
    }
  }

  async _appendLegacyWorkflowEventHistory(storyId, event, phaseName) {
    await this.stateManager.appendWorkflowHistory(storyId, {
      type: event.eventType,
      phase: phaseName,
      detail: event.payload
    });
  }

  _isLegacyCheckpointPendingEvent(event) {
    return event.eventType === 'workflow.checkpoint_pending' || event.eventType === 'checkpoint_pending';
  }

  _isLegacyCheckpointResolvedEvent(event) {
    return (
      event.eventType === 'workflow.checkpoint_approved'
      || event.eventType === 'workflow.checkpoint_rejected'
      || event.eventType === 'workflow.checkpoint_skipped'
      || event.eventType === 'workflow.checkpoint_modified'
      || event.eventType === 'workflow.checkpoint_timeout'
      || event.eventType === 'checkpoint_approved'
      || event.eventType === 'checkpoint_rejected'
      || event.eventType === 'checkpoint_auto_approved'
    );
  }

  async _syncLegacyPendingCheckpoint(storyId, phaseName, checkpointEventPayload) {
    const activeOutputs = this._getActiveKernelOutputs(storyId);
    const checkpointPayload = workflowContracts.buildCheckpointPayload(checkpointEventPayload.checkpointType, activeOutputs);

    await this.stateManager.setActiveCheckpoint(storyId, {
      id: checkpointEventPayload.checkpointId,
      phase: checkpointEventPayload.phase || 'unknown',
      type: checkpointEventPayload.checkpointType || 'generic',
      status: 'pending',
      createdAt: new Date().toISOString(),
      autoContinueOnTimeout: true,
      contractVersion: checkpointPayload?.contractVersion || null,
      reviewPayload: checkpointPayload?.reviewData || null,
      reviewTitle: checkpointPayload?.title || null
    });

    await this._syncLegacyPhaseCheckpointState(storyId, phaseName, {
      checkpointId: checkpointEventPayload.checkpointId,
      status: 'pending_confirmation'
    });
  }

  _getActiveKernelOutputs(storyId) {
    return this.kernel?.activeWorkflows.get(storyId)?.record?.context?.outputs || {};
  }

  async _syncLegacyPhaseCheckpointState(storyId, phaseName, checkpointUpdate) {
    const updateMethodByPhase = {
      phase1: 'updatePhase1',
      phase2: 'updatePhase2',
      phase3: 'updatePhase3'
    };
    const updateMethod = updateMethodByPhase[phaseName];

    if (updateMethod && typeof this.stateManager[updateMethod] === 'function') {
      await this.stateManager[updateMethod](storyId, checkpointUpdate);
    }
  }

  /**
   * Resume workflow from checkpoint.
   * After resumption, syncs business-state snapshot to StoryOrchestrator tables.
   */
  async resume(storyId, checkpointResponse) {
    if (!this.useKernel || !this.kernel) {
      throw new Error('WorkflowKernel is not enabled or initialized');
    }

    let result;
    let definition = null;
    const normalizedResponse = {
      ...checkpointResponse,
      action: checkpointResponse.action || (checkpointResponse.approval === false ? 'reject' : 'approve')
    };
    try {
      result = await this.kernel.resume(storyId, normalizedResponse);
    } catch (error) {
      if (!/is not active/i.test(error.message || '')) {
        throw error;
      }

      definition = await this._loadRecoveryDefinition(storyId);
      result = await this.kernel.recover(storyId, {
        definition,
        checkpointResponse: normalizedResponse
      });
    }

    // Sync business-state snapshot after resumption so StoryOrchestrator
    // state is consistent with kernel execution state.
    const active = this.kernel.activeWorkflows.get(storyId);
    const runtimeDefinition = active?.definition || definition || await this._loadRecoveryDefinition(storyId);
    await this._syncStoryRuntimeState(storyId, active?.record || result, runtimeDefinition);

    if (active && this.stateManager && this.stateManager.repository) {
      const phaseName = this._determinePhaseFromContext(active.record.executionCursor, active.definition);
      if (phaseName) {
        this._createBusinessSnapshot(storyId, phaseName, active.record.context, 'approved');
      }
    }

    return result;
  }

  async recover(storyId, options = {}) {
    if (!this.useKernel || !this.kernel) {
      throw new Error('WorkflowKernel is not enabled or initialized');
    }

    const definition = options.definition || await this._loadRecoveryDefinition(storyId);
    const result = await this.kernel.recover(storyId, {
      ...options,
      definition
    });

    const active = this.kernel.activeWorkflows.get(storyId);
    await this._syncStoryRuntimeState(storyId, active?.record || result, active?.definition || definition, {
      fallbackPhase: options.targetPhase || null
    });

    return result;
  }

  async getRunStatus(storyId, options = {}) {
    if (!this.useKernel || !this.kernel) {
      return null;
    }

    return this.kernel.getRunStatus(storyId, options);
  }

  async _loadRecoveryDefinition(storyId) {
    const path = require('path');
    let definitionRef = null;

    if (this.kernel?.stateRepository && typeof this.kernel.stateRepository.get === 'function') {
      const record = await this.kernel.stateRepository.get(storyId);
      definitionRef = record?.definitionRef || record?.definition_ref || null;

      if (!definitionRef && record?.config_json) {
        try {
          definitionRef = JSON.parse(record.config_json).definitionRef || null;
        } catch (_error) {
          // Fall through to default definition resolution.
        }
      }
    }

    // Keep the old phase-only ref readable as migration input, but normalize it
    // onto the canonical full workflow definition so recovery no longer depends
    // on a separate compatibility-only definition file.
    this._normalizeRecoveryDefinitionRef(definitionRef);
    const definitionPath = path.join(__dirname, '..', 'config', 'workflow-definition.js');

    delete require.cache[require.resolve(definitionPath)];
    return require(definitionPath);
  }

  _normalizeRecoveryDefinitionRef(definitionRef) {
    // Accept the old phase-only alias as migration input, but do not preserve
    // it as a first-class supported definition entry.
    if (definitionRef === 'story-orchestrator-phase1') {
      return 'story-orchestrator-v1';
    }

    return definitionRef || 'story-orchestrator-v1';
  }

  /**
   * Get workflow status
   */
  async getStatus(storyId) {
    if (!this.useKernel || !this.kernel) {
      return null;
    }

    const active = this.kernel.activeWorkflows.get(storyId);
    const persisted = !active && this.kernel.stateRepository
      ? await this.kernel.stateRepository.get(storyId)
      : null;
    const runStatus = await this.getRunStatus(storyId);
    const definition = active?.definition || (active || persisted ? await this._loadRecoveryDefinition(storyId) : null);
    const runtimeView = active?.record || persisted
      ? this._buildRuntimeView(active?.record || persisted, definition, {
        fallbackPhase: runStatus?.currentPhaseId || null
      })
      : null;

    if (!runStatus && !runtimeView) {
      return null;
    }

    return {
      state: runStatus?.state || runtimeView?.state || null,
      currentPhase: runtimeView?.currentPhase || runStatus?.currentPhaseId || null,
      currentStep: runStatus?.currentStepId || runtimeView?.currentStep || null,
      activeCheckpoint: runStatus?.checkpointState?.checkpointId || runtimeView?.activeCheckpoint || null,
      recoveryCursor: runStatus?.recoveryCursor || runtimeView?.recoveryCursor || null,
      recentEvents: runStatus?.recentEvents || []
    };
  }
}

function mergeNestedOutputs(base, incoming) {
  const merged = {};

  for (const [key, value] of Object.entries(incoming || {})) {
    if (
      value
      && typeof value === 'object'
      && !Array.isArray(value)
      && base[key]
      && typeof base[key] === 'object'
      && !Array.isArray(base[key])
    ) {
      merged[key] = {
        ...base[key],
        ...value
      };
    } else {
      merged[key] = value;
    }
  }

  return merged;
}

module.exports = { StoryOrchestratorKernelAdapter };
