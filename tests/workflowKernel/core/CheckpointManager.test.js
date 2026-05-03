const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const { CheckpointManager } = require('../../../modules/workflowKernel/core/CheckpointManager');

describe('CheckpointManager', () => {
  let mgr;

  afterEach(() => {
    if (mgr) {
      mgr.destroy();
      mgr = null;
    }
  });

  it('creates checkpoint with defaults', async () => {
    mgr = new CheckpointManager({});
    const cp = await mgr.create('wf-1', { promptTemplate: 'Please review' });

    assert.strictEqual(cp.workflowId, 'wf-1');
    assert.strictEqual(cp.status, 'pending');
    assert.strictEqual(cp.type, 'generic');
    assert.strictEqual(cp.promptTemplate, 'Please review');
    assert.strictEqual(cp.autoContinueOnTimeout, true);
    assert.strictEqual(cp.onCheckpointReject, 'retry');
    assert.ok(cp.checkpointId);
    assert.ok(cp.createdAt);
    assert.ok(cp.expiresAt);
  });

  it('creates checkpoint with custom timeout and metadata', async () => {
    mgr = new CheckpointManager({ defaultTimeoutMs: 5000 });
    const now = Date.now();
    const cp = await mgr.create('wf-2', {
      id: 'custom-cp-id',
      type: 'review',
      timeoutMs: 1000,
      autoContinueOnTimeout: false,
      onCheckpointReject: 'abort',
      metadata: { chapter: 3 }
    });

    assert.strictEqual(cp.checkpointId, 'custom-cp-id');
    assert.strictEqual(cp.type, 'review');
    assert.strictEqual(cp.autoContinueOnTimeout, false);
    assert.strictEqual(cp.onCheckpointReject, 'abort');
    assert.deepStrictEqual(cp.metadata, { chapter: 3 });

    const expiresAtMs = new Date(cp.expiresAt).getTime();
    assert.ok(expiresAtMs >= now + 900 && expiresAtMs <= now + 1500,
      `expiresAt should be roughly now+1000ms, got ${expiresAtMs - now}ms offset`);
  });

  it('resolve with approve action', async () => {
    mgr = new CheckpointManager({});
    const cp = await mgr.create('wf-1', {});
    const resolved = await mgr.resolve(cp.checkpointId, 'approve', { feedback: 'LGTM' });

    assert.strictEqual(resolved.status, 'approved');
    assert.strictEqual(resolved.action, 'approve');
    assert.strictEqual(resolved.feedback, 'LGTM');
    assert.ok(resolved.resolvedAt);
  });

  it('resolve with reject action', async () => {
    mgr = new CheckpointManager({});
    const cp = await mgr.create('wf-1', {});
    const resolved = await mgr.resolve(cp.checkpointId, 'reject', { feedback: 'Needs work' });

    assert.strictEqual(resolved.status, 'rejected');
    assert.strictEqual(resolved.action, 'reject');
    assert.strictEqual(resolved.feedback, 'Needs work');
  });

  it('resolve with skip action', async () => {
    mgr = new CheckpointManager({});
    const cp = await mgr.create('wf-1', {});
    const resolved = await mgr.resolve(cp.checkpointId, 'skip');

    assert.strictEqual(resolved.status, 'skipped');
    assert.strictEqual(resolved.action, 'skip');
  });

  it('resolve with modify action carries modifiedData', async () => {
    mgr = new CheckpointManager({});
    const cp = await mgr.create('wf-1', {});
    const resolved = await mgr.resolve(cp.checkpointId, 'modify', {
      feedback: 'Changed title',
      modifiedData: { title: 'New Title' }
    });

    assert.strictEqual(resolved.status, 'modified');
    assert.strictEqual(resolved.action, 'modify');
    assert.deepStrictEqual(resolved.modifiedData, { title: 'New Title' });
  });

  it('resolve with timeout marks timed_out and reports timeout source', async () => {
    mgr = new CheckpointManager({});
    const cp = await mgr.create('wf-1', {});
    const resolved = await mgr.resolve(cp.checkpointId, 'timeout', {
      feedback: 'Timed out',
      resolutionSource: 'timeout'
    });

    assert.strictEqual(resolved.status, 'timed_out');
    assert.strictEqual(resolved.action, 'timeout');
    assert.strictEqual(resolved.resolutionSource, 'timeout');
  });

  it('resolve throws for unknown checkpoint', async () => {
    mgr = new CheckpointManager({});
    await assert.rejects(
      mgr.resolve('nonexistent-id', 'approve'),
      /Checkpoint not found: nonexistent-id/
    );
  });

  it('resolve throws for already-resolved checkpoint (removed from active)', async () => {
    mgr = new CheckpointManager({});
    const cp = await mgr.create('wf-1', {});
    await mgr.resolve(cp.checkpointId, 'approve');

    // Resolved checkpoints are deleted from activeCheckpoints, so second
    // resolve throws "not found" rather than "already resolved".
    await assert.rejects(
      mgr.resolve(cp.checkpointId, 'approve'),
      /Checkpoint not found: /
    );
  });

  it('get returns pending checkpoint or null', async () => {
    mgr = new CheckpointManager({});
    const cp = await mgr.create('wf-1', {});

    assert.strictEqual(mgr.get(cp.checkpointId), cp);
    assert.strictEqual(mgr.get('nonexistent'), null);

    await mgr.resolve(cp.checkpointId, 'approve');
    assert.strictEqual(mgr.get(cp.checkpointId), null);
  });

  it('listPending filters to pending only', async () => {
    mgr = new CheckpointManager({});
    const cp1 = await mgr.create('wf-1', {});
    const cp2 = await mgr.create('wf-2', {});
    const cp3 = await mgr.create('wf-3', {});

    await mgr.resolve(cp2.checkpointId, 'reject');

    const pending = mgr.listPending();
    assert.strictEqual(pending.length, 2);
    assert.ok(pending.find(p => p.checkpointId === cp1.checkpointId));
    assert.ok(pending.find(p => p.checkpointId === cp3.checkpointId));
  });

  it('auto-approves on timeout with fast poll interval', async () => {
    mgr = new CheckpointManager({ defaultTimeoutMs: 1, checkpointPollIntervalMs: 10 });
    const cp = await mgr.create('wf-1', { autoContinueOnTimeout: true });
    assert.strictEqual(cp.status, 'pending');

    // Wait for expiration + a couple of polling intervals
    await new Promise(r => setTimeout(r, 60));

    assert.strictEqual(mgr.listPending().length, 0);
    assert.strictEqual(mgr.get(cp.checkpointId), null);
  });

  it('triggers onAutoResolve callback when timeout continuation happens', async () => {
    const autoResolved = [];
    mgr = new CheckpointManager({
      defaultTimeoutMs: 1,
      checkpointPollIntervalMs: 10,
      onAutoResolve: async (checkpoint) => {
        autoResolved.push(checkpoint);
      }
    });

    const cp = await mgr.create('wf-1', { autoContinueOnTimeout: true });
    await new Promise((resolve) => setTimeout(resolve, 60));

    assert.strictEqual(autoResolved.length, 1);
    assert.strictEqual(autoResolved[0].checkpointId, cp.checkpointId);
    assert.strictEqual(autoResolved[0].action, 'timeout');
    assert.strictEqual(autoResolved[0].status, 'timed_out');
  });

  it('does not auto-approve when autoContinueOnTimeout is false', async () => {
    mgr = new CheckpointManager({ defaultTimeoutMs: 1, checkpointPollIntervalMs: 10 });
    const cp = await mgr.create('wf-1', { autoContinueOnTimeout: false });

    await new Promise(r => setTimeout(r, 60));

    // Should still be pending because auto-approve is disabled
    assert.strictEqual(mgr.listPending().length, 1);
    assert.strictEqual(mgr.get(cp.checkpointId).status, 'pending');
  });

  it('destroy clears timers and checkpoints', async () => {
    mgr = new CheckpointManager({ defaultTimeoutMs: 30000, checkpointPollIntervalMs: 1000 });
    await mgr.create('wf-1', {});
    await mgr.create('wf-2', {});

    assert.ok(mgr.pollTimer);
    assert.strictEqual(mgr.activeCheckpoints.size, 2);

    mgr.destroy();

    assert.strictEqual(mgr.pollTimer, null);
    assert.strictEqual(mgr.activeCheckpoints.size, 0);
  });

  it('stops polling when last checkpoint is resolved', async () => {
    mgr = new CheckpointManager({ defaultTimeoutMs: 30000, checkpointPollIntervalMs: 1000 });
    const cp = await mgr.create('wf-1', {});

    assert.ok(mgr.pollTimer);

    await mgr.resolve(cp.checkpointId, 'approve');

    assert.strictEqual(mgr.pollTimer, null);
    assert.strictEqual(mgr.activeCheckpoints.size, 0);
  });

  it('restarts polling after stop when new checkpoint is created', async () => {
    mgr = new CheckpointManager({ defaultTimeoutMs: 30000, checkpointPollIntervalMs: 1000 });
    const cp1 = await mgr.create('wf-1', {});
    await mgr.resolve(cp1.checkpointId, 'approve');

    assert.strictEqual(mgr.pollTimer, null);

    await mgr.create('wf-2', {});
    assert.ok(mgr.pollTimer);
  });
});
