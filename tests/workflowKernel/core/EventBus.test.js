const { describe, it } = require('node:test');
const assert = require('node:assert');
const { EventBus } = require('../../../modules/workflowKernel/core/EventBus');

describe('EventBus', () => {
  it('subscribe receives published events', () => {
    const bus = new EventBus();
    const received = [];
    bus.subscribe('test.event', (payload) => received.push(payload));

    bus.publish('test.event', { data: 1 });
    bus.publish('test.event', { data: 2 });

    assert.strictEqual(received.length, 2);
    assert.deepStrictEqual(received[0], { data: 1 });
    assert.deepStrictEqual(received[1], { data: 2 });
  });

  it('unsubscribe stops delivery', () => {
    const bus = new EventBus();
    const received = [];
    const handler = (payload) => received.push(payload);

    bus.subscribe('test.event', handler);
    bus.publish('test.event', { before: true });
    assert.strictEqual(received.length, 1);

    bus.unsubscribe('test.event', handler);
    bus.publish('test.event', { after: true });
    assert.strictEqual(received.length, 1);
  });

  it('returned unsubscribe function stops delivery', () => {
    const bus = new EventBus();
    const received = [];
    const unsubscribe = bus.subscribe('test.event', (payload) => received.push(payload));

    bus.publish('test.event', { before: true });
    assert.strictEqual(received.length, 1);

    unsubscribe();
    bus.publish('test.event', { after: true });
    assert.strictEqual(received.length, 1);
  });

  it('wildcard subscribers receive all events', () => {
    const bus = new EventBus();
    const wildcards = [];
    const specifics = [];

    bus.subscribe('*', (payload) => wildcards.push(payload));
    bus.subscribe('specific.event', (payload) => specifics.push(payload));

    bus.publish('specific.event', { type: 'specific' });
    bus.publish('other.event', { type: 'other' });

    assert.strictEqual(wildcards.length, 2);
    assert.deepStrictEqual(wildcards[0], { type: 'specific' });
    assert.deepStrictEqual(wildcards[1], { type: 'other' });

    assert.strictEqual(specifics.length, 1);
    assert.deepStrictEqual(specifics[0], { type: 'specific' });
  });

  it('handler error isolation - other handlers still run', () => {
    const bus = new EventBus();
    const received = [];

    bus.subscribe('test.event', () => {
      throw new Error('intentional failure');
    });
    bus.subscribe('test.event', (payload) => received.push(payload));

    bus.publish('test.event', { data: 42 });

    assert.strictEqual(received.length, 1);
    assert.deepStrictEqual(received[0], { data: 42 });
  });

  it('clear removes all subscribers', () => {
    const bus = new EventBus();
    const received = [];

    bus.subscribe('event.a', (payload) => received.push(payload));
    bus.subscribe('event.b', (payload) => received.push(payload));
    bus.subscribe('*', (payload) => received.push(payload));

    bus.clear();
    bus.publish('event.a', { data: 1 });
    bus.publish('event.b', { data: 2 });

    assert.strictEqual(received.length, 0);
  });

  it('publish with no subscribers is a no-op', () => {
    const bus = new EventBus();
    assert.doesNotThrow(() => bus.publish('nonexistent.event', { data: 1 }));
  });

  it('unsubscribe with non-existent handler is a no-op', () => {
    const bus = new EventBus();
    const handler = () => {};
    assert.doesNotThrow(() => bus.unsubscribe('nonexistent.event', handler));
  });

  it('multiple subscribers for same event all receive payload', () => {
    const bus = new EventBus();
    const receivedA = [];
    const receivedB = [];

    bus.subscribe('test.event', (payload) => receivedA.push(payload));
    bus.subscribe('test.event', (payload) => receivedB.push(payload));

    bus.publish('test.event', { data: 99 });

    assert.strictEqual(receivedA.length, 1);
    assert.strictEqual(receivedB.length, 1);
    assert.deepStrictEqual(receivedA[0], { data: 99 });
    assert.deepStrictEqual(receivedB[0], { data: 99 });
  });

  it('wildcard error isolation does not break specific handlers', () => {
    const bus = new EventBus();
    const received = [];

    bus.subscribe('*', () => {
      throw new Error('wildcard failure');
    });
    bus.subscribe('test.event', (payload) => received.push(payload));

    bus.publish('test.event', { data: 42 });

    assert.strictEqual(received.length, 1);
  });
});
