const { describe, it } = require('node:test');
const assert = require('node:assert');
const { RetryPolicy } = require('../../../modules/workflowKernel/core/RetryPolicy');

describe('RetryPolicy', () => {
  it('provides default policy', () => {
    const policy = new RetryPolicy();
    const resolved = policy.resolve();
    assert.strictEqual(resolved.maxAttempts, 3);
    assert.deepStrictEqual(resolved.backoffDelays, [0, 250, 1000]);
  });

  it('supports global override', () => {
    const policy = new RetryPolicy({ maxAttempts: 5, backoffDelays: [100, 200] });
    const resolved = policy.resolve();
    assert.strictEqual(resolved.maxAttempts, 5);
    assert.deepStrictEqual(resolved.backoffDelays, [100, 200]);
  });

  it('supports step-level override preserving global backoff', () => {
    const policy = new RetryPolicy({ maxAttempts: 5, backoffDelays: [100, 200] });
    const stepOverride = policy.resolve({ retryPolicy: { maxAttempts: 2 } });
    assert.strictEqual(stepOverride.maxAttempts, 2);
    assert.deepStrictEqual(stepOverride.backoffDelays, [100, 200]);
  });

  it('supports workflow-level retry policy inheritance before step override', () => {
    const policy = new RetryPolicy({ maxAttempts: 5, backoffDelays: [100, 200] });
    const resolved = policy.resolve(
      { retryPolicy: { maxAttempts: 2 } },
      { maxAttempts: 4, backoffDelays: [25, 50] }
    );
    assert.strictEqual(resolved.maxAttempts, 2);
    assert.deepStrictEqual(resolved.backoffDelays, [25, 50]);
  });

  it('determines retry eligibility', () => {
    const policy = new RetryPolicy();
    const resolved = policy.resolve();
    assert.strictEqual(policy.shouldRetry(1, new Error('test'), resolved).shouldRetry, true);
    assert.strictEqual(policy.shouldRetry(3, new Error('test'), resolved).shouldRetry, false);
    assert.strictEqual(policy.shouldRetry(3, new Error('test'), resolved).reason, 'max_attempts_exceeded');
  });

  it('returns correct delay for attempt index', () => {
    const policy = new RetryPolicy();
    const resolved = policy.resolve();
    assert.strictEqual(policy.getDelay(0, resolved), 0);
    assert.strictEqual(policy.getDelay(1, resolved), 250);
    assert.strictEqual(policy.getDelay(2, resolved), 1000);
    assert.strictEqual(policy.getDelay(5, resolved), 1000);
  });

  it('reports whether retry was explicitly configured', () => {
    const policy = new RetryPolicy();
    assert.strictEqual(policy.isConfigured(), false);
    assert.strictEqual(policy.isConfigured({}, { maxAttempts: 2, backoffDelays: [0] }), true);
    assert.strictEqual(policy.isConfigured({ retryPolicy: { maxAttempts: 2 } }), true);
  });
});
