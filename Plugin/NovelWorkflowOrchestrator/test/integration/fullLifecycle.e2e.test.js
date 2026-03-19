const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const path = require('path');
const fs = require('fs/promises');
const { runTick } = require('../../lib/core/tickRunner');
const { createStateStore } = require('../../lib/storage/stateStore');
const { executePendingWakeups } = require('../../lib/execution/agentAssistantBridge');

async function findLatestWakeupId(pluginRoot, projectId) {
  const wakeupDir = path.join(pluginRoot, 'storage', 'wakeups');
  const files = await fs.readdir(wakeupDir);
  const jsonFiles = files.filter(name => name.endsWith('.json'));
  const tasks = await Promise.all(
    jsonFiles.map(async name => {
      const filePath = path.join(wakeupDir, name);
      const raw = await fs.readFile(filePath, 'utf8');
      return JSON.parse(raw);
    })
  );
  const matched = tasks
    .filter(item => item.projectId === projectId)
    .sort((a, b) => String(b.dispatchedAt || '').localeCompare(String(a.dispatchedAt || '')));
  return matched.length > 0 ? matched[0].wakeupId : null;
}

async function fastForwardLatestQueuedRetry(store, projectId) {
  const wakeups = await store.listWakeupsByProject(projectId, 50);
  const queued = wakeups.find(item => item.executionStatus === 'queued' && item.nextRetryAt);
  if (!queued) {
    return false;
  }
  queued.nextRetryAt = '2000-01-01T00:00:00.000+08:00';
  await store.putWakeupTask(queued);
  return true;
}

test('全生命周期端到端：初始化到整书完成（含执行桥接与ACK映射）', async () => {
  const pluginRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'nwo-e2e-lifecycle-'));
  const projectId = 'novel_e2e_lifecycle';
  const config = {
    enableAutonomousTick: true,
    tickMaxProjects: 5,
    tickMaxWakeups: 20,
    storageDir: 'storage',
    bootstrapProjectId: projectId,
    defaultStagnantTickThreshold: 3,
    stagnantTickThreshold: 3,
    pauseWakeupWhenManualPending: true,
    setupPassThreshold: 85,
    setupMaxDebateRounds: 3,
    chapterMaxIterations: 3,
    stageAgents: {
      SETUP_WORLD_DESIGNER: 'world_designer',
      SETUP_WORLD_CRITIC: 'world_critic',
      SETUP_CHARACTER_DESIGNER: 'character_designer',
      SETUP_CHARACTER_CRITIC: 'character_critic',
      SETUP_VOLUME_DESIGNER: 'volume_designer',
      SETUP_VOLUME_CRITIC: 'volume_critic',
      SETUP_CHAPTER_DESIGNER: 'chapter_designer',
      SETUP_CHAPTER_CRITIC: 'chapter_critic',
      CH_PRECHECK: 'chapter_precheck',
      CH_GENERATE: 'chapter_generate',
      CH_REVIEW: 'chapter_review',
      CH_REFLOW: 'chapter_reflow',
      SUPERVISOR: 'supervisor_agent'
    }
  };

  const store = createStateStore({ pluginRoot, storageRoot: 'storage' });
  const stateTrace = [];
  let tick = await runTick({ pluginRoot, input: {}, config });
  stateTrace.push(`${tick.wakeupSummary[0].stage}:${tick.wakeupSummary[0].substate || '-'}`);
  assert.equal(tick.wakeupSummary[0].stage, 'SETUP_WORLD');
  assert.equal(tick.wakeupSummary[0].targetAgents[0], 'world_designer');

  for (let step = 0; step < 20; step += 1) {
    const execution = await executePendingWakeups({
      pluginRoot,
      storageDir: 'storage',
      maxWakeups: 20,
      maxRetries: 1,
      executor: async task => ({
        status: 'success',
        result: {
          content: [{ type: 'text', text: `${task.stage}/${task.substate || '-'}/ok` }]
        }
      })
    });
    assert.equal(execution.failed, 0);
    assert.equal(execution.health.status, 'green');

    const inboxInput = await store.consumeInboxInput();
    assert.equal(inboxInput.acks.length >= execution.producedAcks, true);

    tick = await runTick({
      pluginRoot,
      input: inboxInput,
      config
    });
    stateTrace.push(`${tick.wakeupSummary[0].stage}:${tick.wakeupSummary[0].substate || '-'}`);
    if (tick.wakeupSummary[0].decision === 'terminal_state') {
      break;
    }
  }

  const expectedTrace = [
    'SETUP_WORLD:-',
    'SETUP_WORLD:-',
    'SETUP_CHARACTER:-',
    'SETUP_CHARACTER:-',
    'SETUP_VOLUME:-',
    'SETUP_VOLUME:-',
    'SETUP_CHAPTER:-',
    'SETUP_CHAPTER:-',
    'CHAPTER_CREATION:CH_PRECHECK',
    'CHAPTER_CREATION:CH_GENERATE',
    'CHAPTER_CREATION:CH_REVIEW',
    'COMPLETED:CH_ARCHIVE'
  ];
  assert.deepEqual(stateTrace, expectedTrace);

  const project = await store.getProjectState(projectId);
  assert.equal(project.state, 'COMPLETED');
  assert.equal(project.substate, 'CH_ARCHIVE');
  assert.equal(project.activeWakeupId, null);

  const counters = await store.getCounters(projectId);
  assert.equal(counters.setupDebateRounds.world, 1);
  assert.equal(counters.setupDebateRounds.character, 1);
  assert.equal(counters.setupDebateRounds.volume, 1);
  assert.equal(counters.setupDebateRounds.chapter, 1);
  assert.equal(counters.chapterIterations.default_chapter, 0);

  const wakeups = await store.listWakeupsByProject(projectId, 50);
  assert.equal(wakeups.length >= 11, true);
  assert.equal(wakeups.every(item => Boolean(item.context?.stageMappingKey)), true);
  assert.equal(wakeups.every(item => Boolean(item.context?.objective)), true);
  assert.equal(wakeups.every(item => item.ackStatus !== 'pending'), true);
  const mappedResultTypes = wakeups
    .map(item => item.ackPayload?.resultType)
    .filter(Boolean);
  assert.equal(mappedResultTypes.includes('setup_score_passed'), true);
  assert.equal(mappedResultTypes.includes('review_passed'), true);

  assert.equal(tick.wakeupSummary[0].decision, 'terminal_state');
  assert.equal(tick.wakeupsDispatched, 0);
  assert.equal(tick.manualInterventionsOpened, 0);
});

test('全生命周期端到端：执行失败后重试成功并最终完成', async () => {
  const pluginRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'nwo-e2e-lifecycle-retry-'));
  const projectId = 'novel_e2e_retry_lifecycle';
  const config = {
    enableAutonomousTick: true,
    tickMaxProjects: 5,
    tickMaxWakeups: 20,
    storageDir: 'storage',
    bootstrapProjectId: projectId,
    defaultStagnantTickThreshold: 3,
    stagnantTickThreshold: 3,
    pauseWakeupWhenManualPending: true,
    setupPassThreshold: 85,
    setupMaxDebateRounds: 3,
    chapterMaxIterations: 3,
    stageAgents: {
      SETUP_WORLD_DESIGNER: 'world_designer',
      SETUP_WORLD_CRITIC: 'world_critic',
      SETUP_CHARACTER_DESIGNER: 'character_designer',
      SETUP_CHARACTER_CRITIC: 'character_critic',
      SETUP_VOLUME_DESIGNER: 'volume_designer',
      SETUP_VOLUME_CRITIC: 'volume_critic',
      SETUP_CHAPTER_DESIGNER: 'chapter_designer',
      SETUP_CHAPTER_CRITIC: 'chapter_critic',
      CH_PRECHECK: 'chapter_precheck',
      CH_GENERATE: 'chapter_generate',
      CH_REVIEW: 'chapter_review',
      CH_REFLOW: 'chapter_reflow',
      SUPERVISOR: 'supervisor_agent'
    }
  };

  const store = createStateStore({ pluginRoot, storageRoot: 'storage' });
  let tick = await runTick({ pluginRoot, input: {}, config });
  assert.equal(tick.wakeupSummary[0].stage, 'SETUP_WORLD');

  const failedOnceWakeups = new Set();
  let retryObserved = false;

  for (let step = 0; step < 30; step += 1) {
    const execution = await executePendingWakeups({
      pluginRoot,
      storageDir: 'storage',
      maxWakeups: 20,
      maxRetries: 2,
      retryBackoffSeconds: 1,
      executor: async task => {
        if (!failedOnceWakeups.has(task.wakeupId)) {
          failedOnceWakeups.add(task.wakeupId);
          throw new Error('mock transient error for retry path');
        }
        return {
          status: 'success',
          result: {
            content: [{ type: 'text', text: `${task.stage}/${task.substate || '-'}/ok` }]
          }
        };
      }
    });

    if (execution.retried > 0) {
      retryObserved = true;
      const fastForwarded = await fastForwardLatestQueuedRetry(store, projectId);
      assert.equal(fastForwarded, true);
      const retryExecution = await executePendingWakeups({
        pluginRoot,
        storageDir: 'storage',
        maxWakeups: 20,
        maxRetries: 2,
        retryBackoffSeconds: 1,
        executor: async task => ({
          status: 'success',
          result: {
            content: [{ type: 'text', text: `${task.stage}/${task.substate || '-'}/retry-ok` }]
          }
        })
      });
      assert.equal(retryExecution.executed >= 1, true);
    }

    const inboxInput = await store.consumeInboxInput();
    tick = await runTick({
      pluginRoot,
      input: inboxInput,
      config
    });
    if (tick.wakeupSummary[0].decision === 'terminal_state') {
      break;
    }
  }

  assert.equal(retryObserved, true);
  const project = await store.getProjectState(projectId);
  assert.equal(project.state, 'COMPLETED');
  assert.equal(project.substate, 'CH_ARCHIVE');

  const wakeups = await store.listWakeupsByProject(projectId, 120);
  assert.equal(wakeups.length >= 11, true);
  assert.equal(wakeups.some(item => item.executionAttempt >= 2), true);
  assert.equal(wakeups.some(item => item.lastError), true);
  assert.equal(wakeups.every(item => item.ackStatus !== 'pending'), true);
});

test('全生命周期端到端：达到最大重试后写入blocked ACK并触发人工介入', async () => {
  const pluginRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'nwo-e2e-lifecycle-blocked-manual-'));
  const projectId = 'novel_e2e_blocked_manual';
  const config = {
    enableAutonomousTick: true,
    tickMaxProjects: 5,
    tickMaxWakeups: 20,
    storageDir: 'storage',
    bootstrapProjectId: projectId,
    defaultStagnantTickThreshold: 1,
    stagnantTickThreshold: 1,
    pauseWakeupWhenManualPending: true,
    setupPassThreshold: 85,
    setupMaxDebateRounds: 3,
    chapterMaxIterations: 3,
    stageAgents: {
      SETUP_WORLD_DESIGNER: 'world_designer',
      SETUP_WORLD_CRITIC: 'world_critic',
      SUPERVISOR: 'supervisor_agent'
    }
  };

  const store = createStateStore({ pluginRoot, storageRoot: 'storage' });
  let tick = await runTick({ pluginRoot, input: {}, config });
  assert.equal(tick.wakeupSummary[0].stage, 'SETUP_WORLD');
  assert.equal(tick.wakeupSummary[0].decision, 'wakeup_sent');

  const execution = await executePendingWakeups({
    pluginRoot,
    storageDir: 'storage',
    maxWakeups: 20,
    maxRetries: 1,
    retryBackoffSeconds: 1,
    executor: async () => {
      throw new Error('mock permanent error for blocked ack path');
    }
  });
  assert.equal(execution.failed >= 1, true);
  assert.equal(execution.retried, 0);
  assert.equal(execution.producedAcks >= 1, true);

  const inboxInput = await store.consumeInboxInput();
  assert.equal(inboxInput.acks.length >= 1, true);
  assert.equal(inboxInput.acks[0].ackStatus, 'blocked');
  assert.equal(inboxInput.acks[0].resultType, 'executor_failed');

  tick = await runTick({
    pluginRoot,
    input: inboxInput,
    config
  });
  assert.equal(tick.manualInterventionsOpened >= 1, true);
  assert.equal(tick.wakeupSummary[0].decision, 'manual_review_opened');
  assert.equal(tick.manualReviewPending.length >= 1, true);
  assert.equal(tick.manualReviewPending[0].projectId, projectId);

  const project = await store.getProjectState(projectId);
  assert.equal(project.state, 'PAUSED_MANUAL_REVIEW');
  assert.equal(project.manualReview.status, 'waiting_human_reply');
  assert.equal(project.manualReview.triggerReason, 'stagnant_ticks_exceeded');

  const manualRecord = await store.getManualReview(projectId);
  assert.equal(manualRecord.status, 'waiting_human_reply');
});
