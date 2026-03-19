const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const path = require('path');
const fs = require('fs/promises');
const { createStateStore, createDefaultProjectState } = require('../../lib/storage/stateStore');
const { parseStageAgentsFromEnv } = require('../../NovelWorkflowOrchestrator');

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
