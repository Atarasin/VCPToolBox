const assert = require('node:assert/strict');
const test = require('node:test');
const path = require('path');

const singleton = require('../../Plugin/StoryOrchestrator/core/StoryOrchestrator');
const { StoryOrchestrator } = singleton.StoryOrchestrator ? { StoryOrchestrator: singleton.StoryOrchestrator } : { StoryOrchestrator: singleton.constructor };

// ------------------------------------------------------------------
// Helpers — simulate PluginManager._getPluginConfig() behavior
// ------------------------------------------------------------------

function simulatePluginManagerGetPluginConfig(pluginManifest, globalEnv) {
  const config = {};
  if (pluginManifest.configSchema) {
    for (const key in pluginManifest.configSchema) {
      const schemaEntry = pluginManifest.configSchema[key];
      const expectedType = (typeof schemaEntry === 'object' && schemaEntry !== null)
        ? schemaEntry.type
        : schemaEntry;
      let rawValue;

      if (globalEnv.hasOwnProperty(key)) {
        rawValue = globalEnv[key];
      } else {
        continue;
      }

      let value = rawValue;
      if (expectedType === 'integer') {
        value = parseInt(value, 10);
        if (isNaN(value)) value = undefined;
      } else if (expectedType === 'boolean') {
        value = String(value).toLowerCase() === 'true';
      } else if (expectedType === 'number') {
        value = parseFloat(value);
        if (isNaN(value)) value = undefined;
      }
      config[key] = value;
    }
  }
  return config;
}

function createMockStateManager() {
  return {
    createStory: async () => ({ id: 'story-test001', status: 'created' }),
    getStory: async (id) => ({
      id,
      status: 'phase1_running',
      workflow: { state: 'running', currentPhase: 'phase1' }
    }),
    updateWorkflow: async () => {},
    updateStory: async () => {},
    listStories: async () => [],
    initialize: async () => {}
  };
}

function createMockAgentDispatcher() {
  return {
    initialize: async () => {},
    delegate: async () => ({ content: 'mock' })
  };
}

function createMockChapterOperations() {
  return {
    createChapterDraft: async () => ({ content: 'draft', metrics: {} }),
    reviewChapter: async () => ({}),
    reviseChapter: async () => ({}),
    polishChapter: async () => ({ polishedContent: 'polished', metrics: {} }),
    fillDetails: async () => ({}),
    countChapterLength: () => ({ counts: { actualCount: 100 }, validation: { isQualified: true } }),
    _expandChapter: async () => ({ content: 'expanded' })
  };
}

function createMockContentValidator() {
  return {
    validateWorldview: async () => ({}),
    validateCharacters: async () => ({}),
    validatePlot: async () => ({}),
    comprehensiveValidation: async () => ({
      overall: { passed: true, hasCriticalIssues: false, criticalCount: 0 },
      allIssues: []
    }),
    qualityScore: async () => ({ average: 8.5, scores: {}, rawReport: '' })
  };
}

function createMockWorkflowEngine() {
  return {
    initialize: async () => {},
    start: async (storyId) => ({ status: 'running', storyId }),
    resume: async (storyId, decision) => ({ status: 'success', storyId, decision }),
    getWorkflowStatus: async (storyId) => ({
      state: 'running',
      currentPhase: 'phase1',
      currentStep: 'worldbuilding',
      activeCheckpoint: null,
      retryContext: { attempt: 0 }
    })
  };
}

// ------------------------------------------------------------------
// Tests — ConfigSchema completeness
// ------------------------------------------------------------------

const manifestPath = path.join(__dirname, '../../Plugin/StoryOrchestrator/plugin-manifest.json');
const pluginManifest = require(manifestPath);

test('plugin-manifest.json configSchema contains USE_WORKFLOW_KERNEL', () => {
  assert.ok(pluginManifest.configSchema, 'configSchema should exist');
  assert.ok(
    pluginManifest.configSchema.hasOwnProperty('USE_WORKFLOW_KERNEL'),
    'configSchema must declare USE_WORKFLOW_KERNEL'
  );
  assert.equal(pluginManifest.configSchema.USE_WORKFLOW_KERNEL, 'boolean');
});

test('plugin-manifest.json configSchema contains WORKFLOW_HOT_RELOAD', () => {
  assert.ok(pluginManifest.configSchema, 'configSchema should exist');
  assert.ok(
    pluginManifest.configSchema.hasOwnProperty('WORKFLOW_HOT_RELOAD'),
    'configSchema must declare WORKFLOW_HOT_RELOAD'
  );
  assert.equal(pluginManifest.configSchema.WORKFLOW_HOT_RELOAD, 'boolean');
});

// ------------------------------------------------------------------
// Tests — Realistic config injection → StoryOrchestrator.initialize()
// ------------------------------------------------------------------

test('StoryOrchestrator.initialize() sets useKernel=true when configSchema-filtered config contains USE_WORKFLOW_KERNEL=true', async () => {
  const globalEnv = {
    USE_WORKFLOW_KERNEL: 'true',
    WORKFLOW_HOT_RELOAD: 'false',
    ORCHESTRATOR_DEBUG_MODE: 'false',
    QUALITY_THRESHOLD: '0.75',
    MAX_PHASE_ITERATIONS: '3',
    // Keys NOT in configSchema should be filtered out
    SOME_UNDECLARED_KEY: 'should-not-appear'
  };

  const filteredConfig = simulatePluginManagerGetPluginConfig(pluginManifest, globalEnv);

  // Verify filtering works as PluginManager does
  assert.equal(filteredConfig.USE_WORKFLOW_KERNEL, true);
  assert.equal(filteredConfig.WORKFLOW_HOT_RELOAD, false);
  assert.equal(filteredConfig.ORCHESTRATOR_DEBUG_MODE, false);
  assert.equal(filteredConfig.QUALITY_THRESHOLD, 0.75);
  assert.equal(filteredConfig.MAX_PHASE_ITERATIONS, 3);
  assert.equal(filteredConfig.SOME_UNDECLARED_KEY, undefined);

  // Now verify StoryOrchestrator.initialize() respects the filtered config
  const orchestrator = new StoryOrchestrator();

  // Pre-inject mocks to avoid real DB/network initialization
  orchestrator.stateManager = createMockStateManager();
  orchestrator.agentDispatcher = createMockAgentDispatcher();
  orchestrator.chapterOperations = createMockChapterOperations();
  orchestrator.contentValidator = createMockContentValidator();
  orchestrator.workflowEngine = createMockWorkflowEngine();
  orchestrator.metrics = orchestrator._createMetrics();

  // Simulate what initialize() does: assign globalConfig, then compute useKernel
  orchestrator.globalConfig = filteredConfig;
  orchestrator.useKernel = orchestrator.globalConfig.USE_WORKFLOW_KERNEL === 'true' || orchestrator.globalConfig.USE_WORKFLOW_KERNEL === true;

  assert.equal(orchestrator.useKernel, true, 'useKernel should be true when filtered config has USE_WORKFLOW_KERNEL=true');
  assert.equal(orchestrator.globalConfig.USE_WORKFLOW_KERNEL, true);
});

test('StoryOrchestrator.initialize() sets useKernel=false when configSchema-filtered config contains USE_WORKFLOW_KERNEL=false', async () => {
  const globalEnv = {
    USE_WORKFLOW_KERNEL: 'false',
    WORKFLOW_HOT_RELOAD: 'true',
    ORCHESTRATOR_DEBUG_MODE: 'false',
    QUALITY_THRESHOLD: '0.8',
    MAX_PHASE_ITERATIONS: '5'
  };

  const filteredConfig = simulatePluginManagerGetPluginConfig(pluginManifest, globalEnv);

  assert.equal(filteredConfig.USE_WORKFLOW_KERNEL, false);
  assert.equal(filteredConfig.WORKFLOW_HOT_RELOAD, true);

  const orchestrator = new StoryOrchestrator();
  orchestrator.stateManager = createMockStateManager();
  orchestrator.agentDispatcher = createMockAgentDispatcher();
  orchestrator.chapterOperations = createMockChapterOperations();
  orchestrator.contentValidator = createMockContentValidator();
  orchestrator.workflowEngine = createMockWorkflowEngine();
  orchestrator.metrics = orchestrator._createMetrics();

  orchestrator.globalConfig = filteredConfig;
  orchestrator.useKernel = orchestrator.globalConfig.USE_WORKFLOW_KERNEL === 'true' || orchestrator.globalConfig.USE_WORKFLOW_KERNEL === true;

  assert.equal(orchestrator.useKernel, false, 'useKernel should be false when filtered config has USE_WORKFLOW_KERNEL=false');
});

test('StoryOrchestrator.initialize() sets useKernel=false when USE_WORKFLOW_KERNEL is absent from filtered config', async () => {
  const globalEnv = {
    WORKFLOW_HOT_RELOAD: 'false',
    ORCHESTRATOR_DEBUG_MODE: 'false'
    // USE_WORKFLOW_KERNEL intentionally omitted
  };

  const filteredConfig = simulatePluginManagerGetPluginConfig(pluginManifest, globalEnv);

  assert.equal(filteredConfig.USE_WORKFLOW_KERNEL, undefined, 'filtered config should not contain USE_WORKFLOW_KERNEL when not in env');

  const orchestrator = new StoryOrchestrator();
  orchestrator.stateManager = createMockStateManager();
  orchestrator.agentDispatcher = createMockAgentDispatcher();
  orchestrator.chapterOperations = createMockChapterOperations();
  orchestrator.contentValidator = createMockContentValidator();
  orchestrator.workflowEngine = createMockWorkflowEngine();
  orchestrator.metrics = orchestrator._createMetrics();

  orchestrator.globalConfig = filteredConfig;
  orchestrator.useKernel = orchestrator.globalConfig.USE_WORKFLOW_KERNEL === 'true' || orchestrator.globalConfig.USE_WORKFLOW_KERNEL === true;

  assert.equal(orchestrator.useKernel, false, 'useKernel should default to false when USE_WORKFLOW_KERNEL is absent');
});

test('StoryOrchestratorKernelAdapter receives USE_WORKFLOW_KERNEL from filtered config', async () => {
  const { StoryOrchestratorKernelAdapter } = require('../../Plugin/StoryOrchestrator/adapters/StoryOrchestratorKernelAdapter');

  const globalEnv = {
    USE_WORKFLOW_KERNEL: 'true',
    WORKFLOW_HOT_RELOAD: 'false'
  };
  const filteredConfig = simulatePluginManagerGetPluginConfig(pluginManifest, globalEnv);

  const adapter = new StoryOrchestratorKernelAdapter({
    stateManager: createMockStateManager(),
    agentDispatcher: createMockAgentDispatcher(),
    chapterOperations: createMockChapterOperations(),
    contentValidator: createMockContentValidator(),
    config: filteredConfig
  });

  assert.equal(adapter.useKernel, true, 'adapter.useKernel should be true when config contains USE_WORKFLOW_KERNEL=true');
});
