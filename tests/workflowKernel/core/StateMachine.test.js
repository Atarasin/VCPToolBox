const { describe, it } = require('node:test');
const assert = require('node:assert');
const { StateMachine, StateTransitionError, EXECUTION_STATES } = require('../../../modules/workflowKernel/core/StateMachine');

describe('StateMachine', () => {
  it('starts in idle state', () => {
    const sm = new StateMachine();
    assert.strictEqual(sm.getState(), EXECUTION_STATES.IDLE);
    assert.strictEqual(sm.isTerminal(), false);
    assert.strictEqual(sm.isActive(), false);
  });

  it('transitions through valid states', () => {
    const sm = new StateMachine();
    sm.transition(EXECUTION_STATES.RUNNING);
    assert.strictEqual(sm.getState(), EXECUTION_STATES.RUNNING);
    assert.strictEqual(sm.isActive(), true);

    sm.transition(EXECUTION_STATES.WAITING_CHECKPOINT);
    assert.strictEqual(sm.getState(), EXECUTION_STATES.WAITING_CHECKPOINT);

    sm.transition(EXECUTION_STATES.RUNNING, 'resumed');
    assert.strictEqual(sm.getState(), EXECUTION_STATES.RUNNING);

    sm.transition(EXECUTION_STATES.COMPLETED);
    assert.strictEqual(sm.getState(), EXECUTION_STATES.COMPLETED);
    assert.strictEqual(sm.isTerminal(), true);
    assert.strictEqual(sm.isActive(), false);
  });

  it('rejects invalid transitions', () => {
    const sm = new StateMachine(EXECUTION_STATES.RUNNING);
    assert.throws(() => sm.transition(EXECUTION_STATES.IDLE), StateTransitionError);
    assert.throws(() => sm.transition(EXECUTION_STATES.IDLE), /Invalid transition/);
  });

  it('records transition history', () => {
    const sm = new StateMachine();
    sm.transition(EXECUTION_STATES.RUNNING, 'start');
    sm.transition(EXECUTION_STATES.COMPLETED, 'done');
    const history = sm.getHistory();
    assert.strictEqual(history.length, 2);
    assert.strictEqual(history[0].from, EXECUTION_STATES.IDLE);
    assert.strictEqual(history[0].to, EXECUTION_STATES.RUNNING);
    assert.strictEqual(history[0].reason, 'start');
    assert.ok(history[0].timestamp);
  });

  it('canTransition checks validity without mutating', () => {
    const sm = new StateMachine(EXECUTION_STATES.RUNNING);
    assert.strictEqual(sm.canTransition(EXECUTION_STATES.FAILED), true);
    assert.strictEqual(sm.canTransition(EXECUTION_STATES.IDLE), false);
    assert.strictEqual(sm.getState(), EXECUTION_STATES.RUNNING);
  });

  it('supports recovery transitions', () => {
    const sm = new StateMachine(EXECUTION_STATES.WAITING_CHECKPOINT);
    sm.transition(EXECUTION_STATES.RECOVERING, 'crash');
    assert.strictEqual(sm.getState(), EXECUTION_STATES.RECOVERING);

    sm.transition(EXECUTION_STATES.RUNNING, 'recovered');
    assert.strictEqual(sm.getState(), EXECUTION_STATES.RUNNING);
  });
});
