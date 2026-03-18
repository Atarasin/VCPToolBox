const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const path = require('path');
const fs = require('fs/promises');
const { createStateStore, createDefaultProjectState } = require('../../lib/storage/stateStore');

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
