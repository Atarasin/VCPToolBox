const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const path = require('path');
const fs = require('fs/promises');
const { createStateStore, createDefaultProjectState } = require('../../lib/storage/stateStore');
const { executePendingWakeups } = require('../../lib/execution/agentAssistantBridge');

test('executePendingWakeups 可执行待处理任务并回写ACK', async () => {
  const pluginRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'nwo-bridge-'));
  const store = createStateStore({ pluginRoot, storageRoot: 'storage' });
  await store.ensureStorageLayout();
  const project = createDefaultProjectState('project_bridge', new Date());
  project.state = 'SETUP_WORLD';
  await store.putProjectState(project);

  const task = {
    wakeupId: 'wk_bridge_1',
    tickId: 'tick_bridge_1',
    projectId: 'project_bridge',
    stage: 'SETUP_WORLD',
    substate: null,
    targetAgent: 'world_agent',
    context: {
      objective: 'test objective'
    },
    status: 'dispatched',
    ackStatus: 'pending',
    executionStatus: 'queued',
    executionAttempt: 0,
    dispatchedAt: new Date().toISOString()
  };
  await store.putWakeupTask(task);

  const result = await executePendingWakeups({
    pluginRoot,
    storageDir: 'storage',
    maxWakeups: 10,
    executor: async () => ({
      status: 'success',
      result: { content: [{ type: 'text', text: 'ok' }] }
    })
  });

  assert.equal(result.scanned, 1);
  assert.equal(result.executed, 1);
  assert.equal(result.failed, 0);
  assert.equal(result.metrics.successRate, 1);
  assert.equal(result.metrics.retryRate, 0);
  assert.equal(result.metrics.averageDurationMs >= 0, true);
  assert.equal(result.backlogAlert.triggered, false);
  assert.equal(result.health.status, 'green');
  assert.equal(result.health.score, 100);
  const wakeup = await store.getWakeupTask('wk_bridge_1');
  assert.equal(wakeup.executionStatus, 'succeeded');

  const inbox = JSON.parse(await fs.readFile(path.join(store.paths.inbox, 'acks.json'), 'utf8'));
  assert.equal(inbox.acks.length, 1);
  assert.equal(inbox.acks[0].projectId, 'project_bridge');
  assert.equal(inbox.acks[0].wakeupId, 'wk_bridge_1');
  assert.equal(inbox.acks[0].ackStatus, 'acted');
});

test('executePendingWakeups 执行异常时先进入重试队列', async () => {
  const pluginRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'nwo-bridge-fail-'));
  const store = createStateStore({ pluginRoot, storageRoot: 'storage' });
  await store.ensureStorageLayout();
  const project = createDefaultProjectState('project_bridge_fail', new Date());
  project.state = 'SETUP_WORLD';
  await store.putProjectState(project);

  await store.putWakeupTask({
    wakeupId: 'wk_bridge_fail_1',
    tickId: 'tick_bridge_fail_1',
    projectId: 'project_bridge_fail',
    stage: 'SETUP_WORLD',
    substate: null,
    targetAgent: 'world_agent',
    context: {},
    status: 'dispatched',
    ackStatus: 'pending',
    executionStatus: 'queued',
    executionAttempt: 0,
    dispatchedAt: new Date().toISOString()
  });

  const result = await executePendingWakeups({
    pluginRoot,
    storageDir: 'storage',
    executor: async () => {
      throw new Error('mock executor error');
    }
  });

  assert.equal(result.scanned, 1);
  assert.equal(result.executed, 0);
  assert.equal(result.failed, 1);
  assert.equal(result.retried, 1);
  assert.equal(result.metrics.successRate, 0);
  assert.equal(result.metrics.retryRate, 1);
  assert.equal(result.backlogAlert.triggered, false);
  assert.equal(result.health.status, 'red');
  assert.equal(result.health.score <= 30, true);
  const wakeup = await store.getWakeupTask('wk_bridge_fail_1');
  assert.equal(wakeup.executionStatus, 'queued');
  assert.equal(typeof wakeup.nextRetryAt, 'string');
  assert.equal(typeof wakeup.lastError, 'string');

  const ackPath = path.join(store.paths.inbox, 'acks.json');
  const inboxRaw = await fs.readFile(ackPath, 'utf8').catch(() => JSON.stringify({ acks: [] }));
  const inbox = JSON.parse(inboxRaw);
  assert.equal(Array.isArray(inbox.acks), true);
  assert.equal(inbox.acks.length, 0);
});

test('executePendingWakeups 达到最大重试次数后写入阻塞ACK并标记失败', async () => {
  const pluginRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'nwo-bridge-fail-final-'));
  const store = createStateStore({ pluginRoot, storageRoot: 'storage' });
  await store.ensureStorageLayout();
  const project = createDefaultProjectState('project_bridge_fail_final', new Date());
  project.state = 'SETUP_WORLD';
  await store.putProjectState(project);

  await store.putWakeupTask({
    wakeupId: 'wk_bridge_fail_final_1',
    tickId: 'tick_bridge_fail_final_1',
    projectId: 'project_bridge_fail_final',
    stage: 'SETUP_WORLD',
    substate: null,
    targetAgent: 'world_agent',
    context: {},
    status: 'dispatched',
    ackStatus: 'pending',
    executionStatus: 'queued',
    executionAttempt: 0,
    dispatchedAt: new Date().toISOString()
  });

  const result = await executePendingWakeups({
    pluginRoot,
    storageDir: 'storage',
    maxRetries: 1,
    executor: async () => {
      throw new Error('mock executor error');
    }
  });

  assert.equal(result.scanned, 1);
  assert.equal(result.executed, 0);
  assert.equal(result.failed, 1);
  assert.equal(result.retried, 0);
  assert.equal(result.metrics.successRate, 0);
  assert.equal(result.metrics.retryRate, 0);
  assert.equal(result.backlogAlert.triggered, false);
  assert.equal(result.health.status, 'red');
  const wakeup = await store.getWakeupTask('wk_bridge_fail_final_1');
  assert.equal(wakeup.executionStatus, 'failed');
  assert.equal(typeof wakeup.lastError, 'string');

  const inbox = JSON.parse(await fs.readFile(path.join(store.paths.inbox, 'acks.json'), 'utf8'));
  assert.equal(inbox.acks.length, 1);
  assert.equal(inbox.acks[0].ackStatus, 'blocked');
  assert.equal(inbox.acks[0].resultType, 'executor_failed');
});

test('executePendingWakeups 可在积压超过阈值时触发告警', async () => {
  const pluginRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'nwo-bridge-backlog-alert-'));
  const store = createStateStore({ pluginRoot, storageRoot: 'storage' });
  await store.ensureStorageLayout();
  const project = createDefaultProjectState('project_bridge_backlog', new Date());
  project.state = 'SETUP_WORLD';
  await store.putProjectState(project);

  await store.putWakeupTask({
    wakeupId: 'wk_backlog_1',
    tickId: 'tick_backlog_1',
    projectId: 'project_bridge_backlog',
    stage: 'SETUP_WORLD',
    substate: null,
    targetAgent: 'world_agent',
    context: {},
    status: 'dispatched',
    ackStatus: 'pending',
    executionStatus: 'queued',
    executionAttempt: 0,
    dispatchedAt: new Date().toISOString()
  });
  await store.putWakeupTask({
    wakeupId: 'wk_backlog_2',
    tickId: 'tick_backlog_2',
    projectId: 'project_bridge_backlog',
    stage: 'SETUP_WORLD',
    substate: null,
    targetAgent: 'world_agent',
    context: {},
    status: 'dispatched',
    ackStatus: 'pending',
    executionStatus: 'queued',
    executionAttempt: 0,
    dispatchedAt: new Date().toISOString()
  });

  const result = await executePendingWakeups({
    pluginRoot,
    storageDir: 'storage',
    maxWakeups: 1,
    backlogAlertThreshold: 0,
    executor: async () => ({
      status: 'success',
      result: { content: [{ type: 'text', text: 'ok' }] }
    })
  });

  assert.equal(result.executed, 1);
  assert.equal(result.backlogAlert.triggered, true);
  assert.equal(result.backlogAlert.pendingTotal >= 1, true);
  assert.equal(result.health.status, 'red');
});
