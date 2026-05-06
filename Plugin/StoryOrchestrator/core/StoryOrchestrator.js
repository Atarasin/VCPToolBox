const fs = require('fs');
const path = require('path');

const { AgentDispatcher } = require('../../../modules/agentDispatcher');
const { StoryOrchestratorKernelAdapter } = require('../adapters/StoryOrchestratorKernelAdapter');
const { TextMetrics } = require('../utils/TextMetrics');
const { ChapterOperations } = require('./ChapterOperations');
const { commandMap, chapterCommands, workflowLifecycleCommands } = require('./commands');
const { ContentValidator } = require('./ContentValidator');
const { StateManager } = require('./StateManager');
const {
  exportAsMarkdown,
  exportAsPlainText
} = require('./services/storyExport');
const { getPlaceholderValue } = require('./services/storyPlaceholders');
const {
  calculateProgress,
  calculateTotalWordCount,
  getCurrentCheckpointId,
  getCurrentPhase,
  getPhaseName,
  isCheckpointPending
} = require('./services/storyProjection');
const { WorkflowEngine } = require('./WorkflowEngine');

class StoryOrchestrator {
  constructor() {
    this.stateManager = new StateManager();
    this.agentDispatcher = null;
    this.chapterOperations = null;
    this.contentValidator = null;
    this.workflowEngine = null;
    this.kernelAdapter = null;
    this.useKernel = false;
    this.textMetrics = new TextMetrics();
    this.globalConfig = {};
    this.metrics = this._createMetrics();
  }

  async initialize(config, dependencies) {
    console.log('[StoryOrchestrator] Initializing...');

    this.globalConfig = config || {};

    const pluginConfigPath = path.join(__dirname, '..', 'config.env');
    if (fs.existsSync(pluginConfigPath)) {
      const envConfig = require('dotenv').parse(fs.readFileSync(pluginConfigPath));
      this.globalConfig = { ...envConfig, ...this.globalConfig };
      console.log(`[StoryOrchestrator] Loaded config from ${pluginConfigPath}`);
    }

    await this.stateManager.initialize();

    this.agentDispatcher = new AgentDispatcher(this.globalConfig, this.stateManager);
    await this.agentDispatcher.initialize();

    this.chapterOperations = new ChapterOperations(this.agentDispatcher, this.stateManager);
    this.contentValidator = new ContentValidator(this.agentDispatcher);

    // The entry remains responsible for wiring the compatibility facade to the kernel adapter.
    this.workflowEngine = new WorkflowEngine({
      stateManager: this.stateManager,
      agentDispatcher: this.agentDispatcher,
      chapterOperations: this.chapterOperations,
      contentValidator: this.contentValidator,
      config: this.globalConfig
    });

    this.useKernel = this.globalConfig.USE_WORKFLOW_KERNEL === 'true' || this.globalConfig.USE_WORKFLOW_KERNEL === true;
    if (this.useKernel) {
      try {
        this.kernelAdapter = new StoryOrchestratorKernelAdapter({
          stateManager: this.stateManager,
          agentDispatcher: this.agentDispatcher,
          chapterOperations: this.chapterOperations,
          contentValidator: this.contentValidator,
          config: this.globalConfig,
          legacyEventListener: this.workflowEngine.createLegacyEventListener()
        });
        await this.kernelAdapter.initialize();
        this.workflowEngine.bindKernelAdapter(this.kernelAdapter);
        console.log('[StoryOrchestrator] WorkflowKernel adapter initialized');
      } catch (err) {
        console.error('[StoryOrchestrator] Failed to initialize WorkflowKernel adapter:', err.message);
        console.log('[StoryOrchestrator] Falling back to legacy WorkflowEngine');
        this.useKernel = false;
        this.kernelAdapter = null;
        this.workflowEngine.bindKernelAdapter(null);
      }
    }

    await this.workflowEngine.initialize();

    console.log('[StoryOrchestrator] Initialized successfully (kernel:', this.useKernel, ')');
  }

  async shutdown() {
    console.log('[StoryOrchestrator] Shutting down...');
    const cleaned = await this.stateManager.cleanupExpired(
      this.globalConfig.STORY_STATE_RETENTION_DAYS || 30
    );
    console.log(`[StoryOrchestrator] Cleaned up ${cleaned} expired stories`);
  }

  async processToolCall(args) {
    const command = args?.command;
    console.log(`[StoryOrchestrator] Processing command: ${command}`);

    try {
      const handler = commandMap[command];
      if (!handler) {
        return {
          status: 'error',
          error: `Unknown command: ${command}`
        };
      }

      return await handler(this, args);
    } catch (error) {
      console.error(`[StoryOrchestrator] Error processing ${command}:`, error);
      return {
        status: 'error',
        error: error.message
      };
    }
  }

  async startStoryProject(args) {
    return workflowLifecycleCommands.startStoryProject(this, args);
  }

  async queryStoryStatus(args) {
    return workflowLifecycleCommands.queryStoryStatus(this, args);
  }

  async userConfirmCheckpoint(args) {
    return workflowLifecycleCommands.userConfirmCheckpoint(this, args);
  }

  async exportStory(args) {
    return chapterCommands.exportStory(this, args);
  }

  async recoverStoryWorkflow(args) {
    return workflowLifecycleCommands.recoverStoryWorkflow(this, args);
  }

  async retryPhase(args) {
    return workflowLifecycleCommands.retryPhase(this, args);
  }

  _createMetrics() {
    return {
      kernel: { success: 0, failure: 0, error: 0, total: 0 },
      legacy: { success: 0, failure: 0, error: 0, total: 0 },
      routingDecisions: [],
      startedAt: new Date().toISOString()
    };
  }

  _logRoutingDecision(command, storyId, pathName) {
    const entry = {
      timestamp: new Date().toISOString(),
      command,
      storyId,
      path: pathName,
      useKernel: this.useKernel,
      kernelAdapterReady: !!this.kernelAdapter
    };
    this.metrics.routingDecisions.push(entry);
    if (this.metrics.routingDecisions.length > 100) {
      this.metrics.routingDecisions = this.metrics.routingDecisions.slice(-100);
    }
    console.log(`[StoryOrchestrator] Routing decision: command=${command} story=${storyId} path=${pathName}`);
  }

  _recordOutcome(pathName, outcome, details = {}) {
    if (!this.metrics[pathName]) return;
    this.metrics[pathName][outcome] = (this.metrics[pathName][outcome] || 0) + 1;
    this.metrics[pathName].total += 1;
    console.log(`[StoryOrchestrator] Outcome recorded: path=${pathName} outcome=${outcome}`, details);
  }

  getMetrics() {
    return {
      ...this.metrics,
      currentConfig: {
        USE_WORKFLOW_KERNEL: this.useKernel,
        kernelAdapterInitialized: !!this.kernelAdapter
      },
      queriedAt: new Date().toISOString()
    };
  }

  async getPlaceholderValue(placeholder) {
    return getPlaceholderValue(this, placeholder);
  }

  _calculateProgress(story) {
    return calculateProgress(story);
  }

  _getCurrentPhase(story) {
    return getCurrentPhase(story);
  }

  _getPhaseName(story) {
    return getPhaseName(story);
  }

  _isCheckpointPending(story) {
    return isCheckpointPending(story);
  }

  _getCurrentCheckpointId(story) {
    return getCurrentCheckpointId(story);
  }

  _calculateTotalWordCount(story) {
    return calculateTotalWordCount(story);
  }

  _exportAsMarkdown(story) {
    return exportAsMarkdown(story);
  }

  _exportAsPlainText(story) {
    return exportAsPlainText(story);
  }
}

const singleton = new StoryOrchestrator();
singleton.StoryOrchestrator = StoryOrchestrator;
module.exports = singleton;
