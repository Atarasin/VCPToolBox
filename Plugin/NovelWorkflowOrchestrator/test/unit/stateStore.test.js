const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const path = require('path');
const fs = require('fs/promises');
const { createStateStore, createDefaultProjectState } = require('../../lib/storage/stateStore');
const { parseStageAgentsFromEnv, resolveTickInput } = require('../../NovelWorkflowOrchestrator');

test('stateStore 初始化目录并写入项目、快照、审计', async () => {
  const pluginRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'nwo-store-'));
  const store = createStateStore({
    pluginRoot,
    storageRoot: 'storage'
  });

  await store.ensureStorageLayout();
  const project = createDefaultProjectState('project_alpha', new Date('2026-03-18T00:00:00.000Z'));
  await store.putProjectState(project);

  const loaded = await store.getProjectState('project_alpha');
  assert.equal(loaded.projectId, 'project_alpha');
  assert.equal(loaded.state, 'INIT');

  const checkpointPath = await store.writeCheckpoint('project_alpha', {
    projectId: 'project_alpha',
    state: 'INIT'
  });
  const auditPath = await store.writeAudit('tick_test_1', { ok: true });

  const checkpointExists = await fs.stat(checkpointPath).then(() => true).catch(() => false);
  const auditExists = await fs.stat(auditPath).then(() => true).catch(() => false);
  assert.equal(checkpointExists, true);
  assert.equal(auditExists, true);
});

test('stateStore 并发写入项目状态时保持文件可读', async () => {
  const pluginRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'nwo-store-lock-'));
  const store = createStateStore({
    pluginRoot,
    storageRoot: 'storage'
  });
  await store.ensureStorageLayout();

  const writes = Array.from({ length: 12 }).map((_, index) => {
    const project = createDefaultProjectState('project_lock', new Date());
    project.state = index % 2 === 0 ? 'SETUP_WORLD' : 'SETUP_CHARACTER';
    project.substate = null;
    project.sequence = index;
    return store.putProjectState(project);
  });
  await Promise.all(writes);

  const loaded = await store.getProjectState('project_lock');
  assert.equal(typeof loaded.sequence, 'number');
  assert.equal(['SETUP_WORLD', 'SETUP_CHARACTER'].includes(loaded.state), true);
});

test('createDefaultProjectState 包含串行化改造字段', () => {
  const project = createDefaultProjectState('project_serial', new Date('2026-03-19T00:00:00.000Z'));
  assert.equal(project.activeWakeupId, null);
  assert.match(project.createdAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}[+-]\d{2}:\d{2}$/);
  assert.equal(project.createdAt.endsWith('Z'), false);
  assert.deepEqual(project.debate, {
    role: 'designer',
    round: 0,
    maxRounds: 3,
    lastDesignerWakeupId: null,
    lastCriticWakeupId: null
  });
});

test('parseStageAgentsFromEnv 解析设定阶段设计者与挑刺者配置', () => {
  const backup = { ...process.env };
  process.env.NWO_STAGE_SETUP_WORLD_DESIGNER = 'world_designer';
  process.env.NWO_STAGE_SETUP_WORLD_CRITIC = 'world_critic';
  process.env.NWO_STAGE_SETUP_CHARACTER_DESIGNER = 'character_designer';
  process.env.NWO_STAGE_SETUP_CHARACTER_CRITIC = 'character_critic';
  process.env.NWO_STAGE_SETUP_VOLUME_DESIGNER = 'volume_designer';
  process.env.NWO_STAGE_SETUP_VOLUME_CRITIC = 'volume_critic';
  process.env.NWO_STAGE_SETUP_CHAPTER_DESIGNER = 'chapter_designer';
  process.env.NWO_STAGE_SETUP_CHAPTER_CRITIC = 'chapter_critic';
  process.env.NWO_STAGE_CH_PRECHECK = 'precheck_agent';
  process.env.NWO_STAGE_SUPERVISOR = 'supervisor_agent';

  try {
    const stageAgents = parseStageAgentsFromEnv();
    assert.equal(stageAgents.SETUP_WORLD, 'world_designer');
    assert.equal(stageAgents.SETUP_WORLD_DESIGNER, 'world_designer');
    assert.equal(stageAgents.SETUP_WORLD_CRITIC, 'world_critic');
    assert.equal(stageAgents.SETUP_CHARACTER_DESIGNER, 'character_designer');
    assert.equal(stageAgents.SETUP_CHARACTER_CRITIC, 'character_critic');
    assert.equal(stageAgents.SETUP_VOLUME_DESIGNER, 'volume_designer');
    assert.equal(stageAgents.SETUP_VOLUME_CRITIC, 'volume_critic');
    assert.equal(stageAgents.SETUP_CHAPTER_DESIGNER, 'chapter_designer');
    assert.equal(stageAgents.SETUP_CHAPTER_CRITIC, 'chapter_critic');
    assert.equal(stageAgents.CH_PRECHECK, 'precheck_agent');
    assert.equal(stageAgents.SUPERVISOR, 'supervisor_agent');
  } finally {
    Object.keys(process.env).forEach(key => {
      if (!(key in backup)) {
        delete process.env[key];
      }
    });
    Object.entries(backup).forEach(([key, value]) => {
      process.env[key] = value;
    });
  }
});

test('stateStore 可消费 inbox 输入并清空文件', async () => {
  const pluginRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'nwo-store-inbox-'));
  const store = createStateStore({
    pluginRoot,
    storageRoot: 'storage'
  });
  await store.ensureStorageLayout();
  await fs.writeFile(
    path.join(store.paths.inbox, 'acks.json'),
    JSON.stringify({
      acks: [
        {
          projectId: 'project_inbox',
          wakeupId: 'wk_inbox_1',
          ackStatus: 'acted'
        }
      ]
    }),
    'utf8'
  );
  await fs.writeFile(
    path.join(store.paths.inbox, 'manual_replies.json'),
    JSON.stringify({
      manualReplies: [
        {
          projectId: 'project_inbox',
          decision: 'resume',
          resumeStage: 'SETUP_WORLD',
          resumeSubstate: null
        }
      ]
    }),
    'utf8'
  );

  const consumed = await store.consumeInboxInput();
  assert.equal(consumed.acks.length, 1);
  assert.equal(consumed.manualReplies.length, 1);

  const emptiedAcks = JSON.parse(await fs.readFile(path.join(store.paths.inbox, 'acks.json'), 'utf8'));
  const emptiedReplies = JSON.parse(await fs.readFile(path.join(store.paths.inbox, 'manual_replies.json'), 'utf8'));
  assert.deepEqual(emptiedAcks, { acks: [] });
  assert.deepEqual(emptiedReplies, { manualReplies: [] });
});

test('resolveTickInput 在无stdin时回退读取 inbox', async () => {
  const pluginRoot = path.resolve(path.join(__dirname, '..', '..'));
  const storageRoot = path.join(pluginRoot, 'storage');
  const inboxDir = path.join(storageRoot, 'inbox');
  await fs.mkdir(inboxDir, { recursive: true });
  const ackPath = path.join(inboxDir, 'acks.json');
  const manualPath = path.join(inboxDir, 'manual_replies.json');
  const backupAcks = await fs.readFile(ackPath, 'utf8').catch(() => null);
  const backupManual = await fs.readFile(manualPath, 'utf8').catch(() => null);

  await fs.writeFile(ackPath, JSON.stringify({ acks: [{ projectId: 'project_fallback', wakeupId: 'wk_fallback', ackStatus: 'acted' }] }), 'utf8');
  await fs.writeFile(manualPath, JSON.stringify({ manualReplies: [] }), 'utf8');

  try {
    const resolved = await resolveTickInput('', { storageDir: 'storage' });
    assert.equal(resolved.acks.length, 1);
    assert.equal(resolved.acks[0].projectId, 'project_fallback');
  } finally {
    if (backupAcks === null) {
      await fs.rm(ackPath, { force: true });
    } else {
      await fs.writeFile(ackPath, backupAcks, 'utf8');
    }
    if (backupManual === null) {
      await fs.rm(manualPath, { force: true });
    } else {
      await fs.writeFile(manualPath, backupManual, 'utf8');
    }
  }
});

test('stateStore 可追加ACK到inbox并按projectId+wakeupId去重', async () => {
  const pluginRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'nwo-store-inbox-append-'));
  const store = createStateStore({
    pluginRoot,
    storageRoot: 'storage'
  });
  await store.ensureStorageLayout();

  await store.appendAcksToInbox([
    { projectId: 'p1', wakeupId: 'wk1', ackStatus: 'waiting' },
    { projectId: 'p1', wakeupId: 'wk2', ackStatus: 'acted' }
  ]);
  await store.appendAcksToInbox([
    { projectId: 'p1', wakeupId: 'wk1', ackStatus: 'acted' }
  ]);

  const loaded = JSON.parse(await fs.readFile(path.join(store.paths.inbox, 'acks.json'), 'utf8'));
  assert.equal(loaded.acks.length, 2);
  const wk1 = loaded.acks.find(item => item.wakeupId === 'wk1');
  assert.equal(wk1.ackStatus, 'acted');
});

test('stateStore listPendingWakeups 仅返回到期重试任务', async () => {
  const pluginRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'nwo-store-pending-wakeups-'));
  const store = createStateStore({
    pluginRoot,
    storageRoot: 'storage'
  });
  await store.ensureStorageLayout();
  const now = new Date('2026-03-20T10:00:00.000Z');

  await store.putWakeupTask({
    wakeupId: 'wk_due',
    projectId: 'p_due',
    tickId: 't1',
    targetAgent: 'a1',
    status: 'dispatched',
    ackStatus: 'pending',
    executionStatus: 'queued',
    nextRetryAt: '2026-03-20T09:59:00.000+08:00',
    dispatchedAt: '2026-03-20T09:00:00.000+08:00'
  });
  await store.putWakeupTask({
    wakeupId: 'wk_not_due',
    projectId: 'p_not_due',
    tickId: 't1',
    targetAgent: 'a2',
    status: 'dispatched',
    ackStatus: 'pending',
    executionStatus: 'queued',
    nextRetryAt: '2099-01-01T00:00:00.000+08:00',
    dispatchedAt: '2026-03-20T09:00:01.000+08:00'
  });

  const pending = await store.listPendingWakeups(20, now);
  assert.equal(pending.length, 1);
  assert.equal(pending[0].wakeupId, 'wk_due');
});

test('stateStore summarizeWakeupQueue 可统计积压与执行状态', async () => {
  const pluginRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'nwo-store-queue-summary-'));
  const store = createStateStore({
    pluginRoot,
    storageRoot: 'storage'
  });
  await store.ensureStorageLayout();
  const now = new Date('2026-03-20T10:00:00.000Z');

  await store.putWakeupTask({
    wakeupId: 'wk_queue_ready',
    projectId: 'p1',
    tickId: 't1',
    targetAgent: 'a1',
    status: 'dispatched',
    ackStatus: 'pending',
    executionStatus: 'queued',
    nextRetryAt: null,
    dispatchedAt: '2026-03-20T09:00:00.000+08:00'
  });
  await store.putWakeupTask({
    wakeupId: 'wk_queue_delayed',
    projectId: 'p2',
    tickId: 't1',
    targetAgent: 'a2',
    status: 'dispatched',
    ackStatus: 'pending',
    executionStatus: 'queued',
    nextRetryAt: '2099-01-01T00:00:00.000+08:00',
    dispatchedAt: '2026-03-20T09:00:01.000+08:00'
  });
  await store.putWakeupTask({
    wakeupId: 'wk_queue_running',
    projectId: 'p3',
    tickId: 't1',
    targetAgent: 'a3',
    status: 'dispatched',
    ackStatus: 'pending',
    executionStatus: 'running',
    dispatchedAt: '2026-03-20T09:00:02.000+08:00'
  });

  const summary = await store.summarizeWakeupQueue(now);
  assert.equal(summary.pendingTotal, 2);
  assert.equal(summary.pendingReady, 1);
  assert.equal(summary.pendingDelayed, 1);
  assert.equal(summary.running, 1);
});
