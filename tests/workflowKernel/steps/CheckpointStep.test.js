const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const { checkpointStep } = require('../../../modules/workflowKernel/steps/CheckpointStep');
const { CheckpointManager } = require('../../../modules/workflowKernel/core/CheckpointManager');

describe('CheckpointStep', () => {
  let kernel;

  afterEach(() => {
    if (kernel?.checkpointManager) kernel.checkpointManager.destroy();
  });

  it('creates a checkpoint and returns waiting_checkpoint status', async () => {
    kernel = { config: {} };
    const step = {
      id: 'review-cp',
      promptTemplate: 'Please review the output',
      timeoutMs: 300000
    };

    const result = await checkpointStep(step, { kernel, workflowId: 'wf-1', context: {} });

    assert.strictEqual(result.status, 'waiting_checkpoint');
    assert.ok(result.checkpoint.checkpointId);
    assert.strictEqual(result.checkpoint.type, 'generic');
    assert.strictEqual(result.checkpoint.promptTemplate, 'Please review the output');
    assert.ok(result.checkpoint.expiresAt);
  });

  it('reuses existing checkpoint manager on kernel', async () => {
    const manager = new CheckpointManager({});
    kernel = { checkpointManager: manager, config: {} };
    const step = { id: 'cp-2' };

    const result = await checkpointStep(step, { kernel, workflowId: 'wf-2', context: {} });
    assert.strictEqual(result.status, 'waiting_checkpoint');
    assert.strictEqual(manager.listPending().length, 1);
  });

  it('stores context snapshot in checkpoint metadata', async () => {
    kernel = { config: {} };
    const context = { outputs: { draft: 'chapter 1' } };
    const step = { id: 'cp-3' };

    const result = await checkpointStep(step, { kernel, workflowId: 'wf-3', context });
    assert.ok(result.checkpoint.checkpointId);
    const cp = kernel.checkpointManager.get(result.checkpoint.checkpointId);
    assert.deepStrictEqual(cp.metadata.contextSnapshot, context);
  });

  it('applies custom timeout from step config', async () => {
    kernel = { config: {} };
    const step = { id: 'cp-timeout', timeoutMs: 5000 };

    const result = await checkpointStep(step, { kernel, workflowId: 'wf-timeout', context: {} });
    const cp = kernel.checkpointManager.get(result.checkpoint.checkpointId);
    const expiresAt = new Date(cp.expiresAt);
    const createdAt = new Date(cp.createdAt);
    const diff = expiresAt.getTime() - createdAt.getTime();
    assert.strictEqual(diff, 5000);
  });

  it('resolves checkpoint after workflow resumes', async () => {
    kernel = { config: {} };
    const step = { id: 'cp-resume', promptTemplate: 'Approve to continue' };

    const result = await checkpointStep(step, { kernel, workflowId: 'wf-resume', context: {} });
    assert.strictEqual(result.status, 'waiting_checkpoint');

    const resolved = await kernel.checkpointManager.resolve(result.checkpoint.checkpointId, 'approve', { feedback: 'Approved' });
    assert.strictEqual(resolved.status, 'approved');
    assert.strictEqual(resolved.action, 'approve');
    assert.strictEqual(resolved.feedback, 'Approved');
  });

  it('works in nested workflow context', async () => {
    kernel = { config: {} };
    const step = { id: 'cp-nested', checkpointType: 'review' };
    const context = {
      steps: { parent: { outputs: { foo: 'bar' } } },
      outputs: { outer: 'value' }
    };

    const result = await checkpointStep(step, { kernel, workflowId: 'wf-nested', context });
    assert.strictEqual(result.status, 'waiting_checkpoint');
    assert.strictEqual(result.checkpoint.type, 'review');
    const cp = kernel.checkpointManager.get(result.checkpoint.checkpointId);
    assert.strictEqual(cp.workflowId, 'wf-nested');
    assert.deepStrictEqual(cp.metadata.contextSnapshot, context);
  });

  it('creates multiple checkpoints in sequence', async () => {
    kernel = { config: {} };
    const step1 = { id: 'cp-seq-1', promptTemplate: 'First review' };
    const step2 = { id: 'cp-seq-2', promptTemplate: 'Second review' };

    const result1 = await checkpointStep(step1, { kernel, workflowId: 'wf-seq', context: {} });
    const result2 = await checkpointStep(step2, { kernel, workflowId: 'wf-seq', context: {} });

    assert.notStrictEqual(result1.checkpoint.checkpointId, result2.checkpoint.checkpointId);
    assert.strictEqual(kernel.checkpointManager.listPending().length, 2);
    assert.strictEqual(result1.checkpoint.promptTemplate, 'First review');
    assert.strictEqual(result2.checkpoint.promptTemplate, 'Second review');
  });
});

describe('CheckpointManager', () => {
  let mgr;

  afterEach(() => {
    if (mgr) mgr.destroy();
  });

  it('creates checkpoint with defaults', async () => {
    mgr = new CheckpointManager({ defaultTimeoutMs: 1000 });
    const cp = await mgr.create('wf-1', { promptTemplate: 'test' });
    assert.strictEqual(cp.workflowId, 'wf-1');
    assert.strictEqual(cp.status, 'pending');
    assert.strictEqual(cp.autoContinueOnTimeout, true);
  });

  it('resolves checkpoint with approve action', async () => {
    mgr = new CheckpointManager({});
    const cp = await mgr.create('wf-1', {});
    const resolved = await mgr.resolve(cp.checkpointId, 'approve', { feedback: 'LGTM' });
    assert.strictEqual(resolved.status, 'approved');
    assert.strictEqual(resolved.action, 'approve');
    assert.strictEqual(resolved.feedback, 'LGTM');
  });

  it('throws on unknown checkpoint', async () => {
    mgr = new CheckpointManager({});
    await assert.rejects(
      mgr.resolve('unknown', 'approve'),
      /Checkpoint not found/
    );
  });

  it('auto-approves expired checkpoints', async () => {
    mgr = new CheckpointManager({ defaultTimeoutMs: 1, checkpointPollIntervalMs: 10 });
    const cp = await mgr.create('wf-1', { autoContinueOnTimeout: true });
    assert.strictEqual(cp.status, 'pending');

    // Wait for expiration + polling interval
    await new Promise(r => setTimeout(r, 50));

    const pending = mgr.listPending();
    assert.strictEqual(pending.length, 0); // Auto-approved and removed
  });

  it('lists only pending checkpoints', async () => {
    mgr = new CheckpointManager({});
    await mgr.create('wf-1', {});
    const cp2 = await mgr.create('wf-2', {});
    await mgr.resolve(cp2.checkpointId, 'reject');

    const pending = mgr.listPending();
    assert.strictEqual(pending.length, 1);
    assert.strictEqual(pending[0].workflowId, 'wf-1');
  });

  it('throws when resolving an already-resolved checkpoint', async () => {
    mgr = new CheckpointManager({});
    const cp = await mgr.create('wf-1', {});
    await mgr.resolve(cp.checkpointId, 'approve');

    // Resolved checkpoints are removed from active map, so second resolve throws not-found
    await assert.rejects(
      mgr.resolve(cp.checkpointId, 'reject'),
      /Checkpoint not found/
    );
  });

  it('retrieves a checkpoint by id via get()', async () => {
    mgr = new CheckpointManager({});
    const cp = await mgr.create('wf-1', { promptTemplate: 'get test' });
    const retrieved = mgr.get(cp.checkpointId);
    assert.strictEqual(retrieved.promptTemplate, 'get test');
  });

  it('returns null for unknown checkpoint id via get()', async () => {
    mgr = new CheckpointManager({});
    const retrieved = mgr.get('nonexistent');
    assert.strictEqual(retrieved, null);
  });
});
