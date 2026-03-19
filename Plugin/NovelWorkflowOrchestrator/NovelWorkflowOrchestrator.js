const path = require('path');
const dotenv = require('dotenv');
const { runTick } = require('./lib/core/tickRunner');
const { createStateStore } = require('./lib/storage/stateStore');
const { executePendingWakeups } = require('./lib/execution/agentAssistantBridge');

const PLUGIN_ROOT = __dirname;

dotenv.config({ path: path.join(PLUGIN_ROOT, 'config.env') });
dotenv.config({ path: path.join(PLUGIN_ROOT, '..', '..', 'config.env') });

function parseBoolean(value, defaultValue) {
  if (value === undefined || value === null || value === '') {
    return defaultValue;
  }
  return String(value).toLowerCase() === 'true';
}

function parseInteger(value, defaultValue) {
  const parsed = Number.parseInt(value, 10);
  if (Number.isNaN(parsed)) {
    return defaultValue;
  }
  return parsed;
}

function parseFloatNumber(value, defaultValue) {
  const parsed = Number.parseFloat(value);
  if (Number.isNaN(parsed)) {
    return defaultValue;
  }
  return parsed;
}

function readStdin() {
  if (process.stdin.isTTY) {
    return Promise.resolve('');
  }
  return new Promise((resolve, reject) => {
    const chunks = [];
    process.stdin.on('data', chunk => chunks.push(chunk));
    process.stdin.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    process.stdin.on('error', reject);
  });
}

function parseInput(rawInput) {
  const trimmed = String(rawInput || '').trim();
  if (!trimmed) {
    return {};
  }
  return JSON.parse(trimmed);
}

async function resolveTickInput(rawInput, runtimeConfig) {
  const trimmed = String(rawInput || '').trim();
  if (trimmed) {
    return parseInput(trimmed);
  }
  const store = createStateStore({
    pluginRoot: PLUGIN_ROOT,
    storageRoot: runtimeConfig.storageDir || 'storage'
  });
  await store.ensureStorageLayout();
  const inboxInput = await store.consumeInboxInput();
  if (
    Array.isArray(inboxInput.acks) && inboxInput.acks.length > 0 ||
    Array.isArray(inboxInput.manualReplies) && inboxInput.manualReplies.length > 0
  ) {
    return inboxInput;
  }
  return {};
}

function parseStageAgentsFromEnv() {
  const setupWorldDesigner = process.env.NWO_STAGE_SETUP_WORLD_DESIGNER || '';
  const setupCharacterDesigner = process.env.NWO_STAGE_SETUP_CHARACTER_DESIGNER || '';
  const setupVolumeDesigner = process.env.NWO_STAGE_SETUP_VOLUME_DESIGNER || '';
  const setupChapterDesigner = process.env.NWO_STAGE_SETUP_CHAPTER_DESIGNER || '';
  return {
    SETUP_WORLD: setupWorldDesigner,
    SETUP_CHARACTER: setupCharacterDesigner,
    SETUP_VOLUME: setupVolumeDesigner,
    SETUP_CHAPTER: setupChapterDesigner,
    SETUP_WORLD_DESIGNER: setupWorldDesigner,
    SETUP_WORLD_CRITIC: process.env.NWO_STAGE_SETUP_WORLD_CRITIC || '',
    SETUP_CHARACTER_DESIGNER: setupCharacterDesigner,
    SETUP_CHARACTER_CRITIC: process.env.NWO_STAGE_SETUP_CHARACTER_CRITIC || '',
    SETUP_VOLUME_DESIGNER: setupVolumeDesigner,
    SETUP_VOLUME_CRITIC: process.env.NWO_STAGE_SETUP_VOLUME_CRITIC || '',
    SETUP_CHAPTER_DESIGNER: setupChapterDesigner,
    SETUP_CHAPTER_CRITIC: process.env.NWO_STAGE_SETUP_CHAPTER_CRITIC || '',
    CH_PRECHECK: process.env.NWO_STAGE_CH_PRECHECK || '',
    CH_GENERATE: process.env.NWO_STAGE_CH_GENERATE || '',
    CH_REVIEW: process.env.NWO_STAGE_CH_REVIEW || '',
    CH_REFLOW: process.env.NWO_STAGE_CH_REFLOW || '',
    PAUSED_MANUAL_REVIEW: process.env.NWO_HUMAN_REVIEWER || '',
    SUPERVISOR: process.env.NWO_STAGE_SUPERVISOR || ''
  };
}

function getRuntimeConfig() {
  return {
    enableAutonomousTick: parseBoolean(process.env.NWO_ENABLE_AUTONOMOUS_TICK, true),
    tickMaxProjects: parseInteger(process.env.NWO_TICK_MAX_PROJECTS, 5),
    tickMaxWakeups: parseInteger(process.env.NWO_TICK_MAX_WAKEUPS, 20),
    storageDir: process.env.NWO_STORAGE_DIR || 'storage',
    bootstrapProjectId: process.env.NWO_BOOTSTRAP_PROJECT_ID || 'novel_demo_project',
    defaultStagnantTickThreshold: parseInteger(process.env.NWO_DEFAULT_STAGNANT_TICK_THRESHOLD, 3),
    stagnantTickThreshold: parseInteger(process.env.NWO_STAGNANT_TICK_THRESHOLD, 3),
    pauseWakeupWhenManualPending: parseBoolean(process.env.NWO_PAUSE_WAKEUP_WHEN_MANUAL_PENDING, true),
    setupMaxDebateRounds: parseInteger(process.env.NWO_SETUP_MAX_DEBATE_ROUNDS, 3),
    chapterMaxIterations: parseInteger(process.env.NWO_CHAPTER_MAX_ITERATIONS, 3),
    setupPassThreshold: parseInteger(process.env.NWO_SETUP_PASS_THRESHOLD, 85),
    chapterOutlineCoverageMin: parseFloatNumber(process.env.NWO_CHAPTER_OUTLINE_COVERAGE_MIN, 0.9),
    chapterPointCoverageMin: parseFloatNumber(process.env.NWO_CHAPTER_POINT_COVERAGE_MIN, 0.95),
    chapterWordcountMinRatio: parseFloatNumber(process.env.NWO_CHAPTER_WORDCOUNT_MIN_RATIO, 0.9),
    chapterWordcountMaxRatio: parseFloatNumber(process.env.NWO_CHAPTER_WORDCOUNT_MAX_RATIO, 1.1),
    criticalInconsistencyZeroTolerance: parseBoolean(process.env.NWO_CRITICAL_INCONSISTENCY_ZERO_TOLERANCE, true),
    executorEnabled: parseBoolean(process.env.NWO_EXECUTOR_ENABLED, false),
    executorType: process.env.NWO_EXECUTOR_TYPE || 'agent_assistant',
    executorMaxWakeups: parseInteger(process.env.NWO_EXECUTOR_MAX_WAKEUPS, 20),
    executorMaxRetries: parseInteger(process.env.NWO_EXECUTOR_MAX_RETRIES, 3),
    executorRetryBackoffSec: parseInteger(process.env.NWO_EXECUTOR_RETRY_BACKOFF_SEC, 30),
    executorBacklogAlertThreshold: parseInteger(process.env.NWO_EXECUTOR_BACKLOG_ALERT_THRESHOLD, 100),
    agentAssistantTemporaryContact: parseBoolean(process.env.NWO_AGENTASSISTANT_TEMPORARY_CONTACT, false),
    agentAssistantTimeoutMs: parseInteger(process.env.NWO_AGENTASSISTANT_TIMEOUT_MS, 120000),
    agentAssistantApiHost: process.env.NWO_AGENTASSISTANT_API_HOST || '127.0.0.1',
    agentAssistantApiPort: parseInteger(process.env.NWO_AGENTASSISTANT_API_PORT, parseInteger(process.env.PORT, 0)),
    agentAssistantApiPath: process.env.NWO_AGENTASSISTANT_API_PATH || '/v1/human/tool',
    agentAssistantApiKey: process.env.NWO_AGENTASSISTANT_API_KEY || process.env.Key || '',
    stageAgents: parseStageAgentsFromEnv()
  };
}

function resolveTopLevelHealth(result, config) {
  const execution = result?.execution;
  if (!config.executorEnabled || String(config.executorType || '').toLowerCase() !== 'agent_assistant') {
    return {
      status: 'not_available',
      score: null,
      source: 'executor_disabled',
      backlogAlertTriggered: false
    };
  }
  if (!execution || !execution.health) {
    return {
      status: 'unknown',
      score: null,
      source: 'execution_missing',
      backlogAlertTriggered: false
    };
  }
  return {
    status: execution.health.status,
    score: execution.health.score,
    source: 'execution_bridge',
    backlogAlertTriggered: Boolean(execution?.backlogAlert?.triggered)
  };
}

async function main() {
  try {
    const config = getRuntimeConfig();
    const input = await resolveTickInput(await readStdin(), config);
    const result = await runTick({
      pluginRoot: PLUGIN_ROOT,
      input,
      config
    });
    if (config.executorEnabled && String(config.executorType || '').toLowerCase() === 'agent_assistant') {
      result.execution = await executePendingWakeups({
        pluginRoot: PLUGIN_ROOT,
        storageDir: config.storageDir,
        maxWakeups: config.executorMaxWakeups,
        maxRetries: config.executorMaxRetries,
        retryBackoffSeconds: config.executorRetryBackoffSec,
        backlogAlertThreshold: config.executorBacklogAlertThreshold,
        temporaryContact: config.agentAssistantTemporaryContact,
        timeoutMs: config.agentAssistantTimeoutMs,
        apiHost: config.agentAssistantApiHost,
        apiPort: config.agentAssistantApiPort,
        apiPath: config.agentAssistantApiPath,
        apiKey: config.agentAssistantApiKey
      });
    }
    result.health = resolveTopLevelHealth(result, config);
    process.stdout.write(JSON.stringify(result, null, 2));
    console.error('[NovelWorkflowOrchestrator] Tick completed successfully');
  } catch (error) {
    console.error(`[NovelWorkflowOrchestrator] Tick failed: ${error.message}`);
    process.stdout.write(
      JSON.stringify(
        {
          status: 'error',
          error: error.message,
          code: 'NWO_TICK_FAILED'
        },
        null,
        2
      )
    );
    process.exitCode = 1;
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  main,
  parseInput,
  resolveTickInput,
  getRuntimeConfig,
  parseStageAgentsFromEnv,
  resolveTopLevelHealth
};
