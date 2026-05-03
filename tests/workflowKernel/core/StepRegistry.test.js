const { describe, it } = require('node:test');
const assert = require('node:assert');
const { StepRegistry } = require('../../../modules/workflowKernel/core/StepRegistry');

describe('StepRegistry', () => {
  it('registers and retrieves handlers', () => {
    const registry = new StepRegistry();
    const handler = async () => ({ status: 'completed' });
    registry.register('testStep', handler);
    assert.strictEqual(registry.has('testStep'), true);
    assert.strictEqual(registry.get('testStep'), handler);
    assert.deepStrictEqual(registry.list(), ['testStep']);
  });

  it('overwrites on duplicate registration', () => {
    const registry = new StepRegistry();
    const h1 = async () => ({ status: 'completed' });
    const h2 = async () => ({ status: 'failed' });
    registry.register('step', h1);
    registry.register('step', h2);
    assert.strictEqual(registry.get('step'), h2);
  });

  it('unregisters handlers', () => {
    const registry = new StepRegistry();
    registry.register('step', async () => ({}));
    registry.unregister('step');
    assert.strictEqual(registry.has('step'), false);
    assert.strictEqual(registry.get('step'), undefined);
  });

  it('rejects invalid registrations', () => {
    const registry = new StepRegistry();
    assert.throws(() => registry.register('', async () => {}), /non-empty string/);
    assert.throws(() => registry.register('bad', 'not-a-function'), /function/);
  });
});
