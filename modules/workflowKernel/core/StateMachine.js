/**
 * Execution-state machine for WorkflowKernel.
 * Manages execution-state transitions only. Business-state (phase1/2/3) is plugin-owned.
 *
 * States: idle → running → waiting_checkpoint → retrying → failed | completed
 *                              ↑_________________________________|
 *                              └ recovering (crash recovery)
 */

const EXECUTION_STATES = {
  IDLE: 'idle',
  RUNNING: 'running',
  WAITING_CHECKPOINT: 'waiting_checkpoint',
  RETRYING: 'retrying',
  FAILED: 'failed',
  COMPLETED: 'completed',
  RECOVERING: 'recovering'
};

const VALID_TRANSITIONS = {
  [EXECUTION_STATES.IDLE]: [EXECUTION_STATES.RUNNING],
  [EXECUTION_STATES.RUNNING]: [
    EXECUTION_STATES.WAITING_CHECKPOINT,
    EXECUTION_STATES.RETRYING,
    EXECUTION_STATES.FAILED,
    EXECUTION_STATES.COMPLETED
  ],
  [EXECUTION_STATES.WAITING_CHECKPOINT]: [
    EXECUTION_STATES.RUNNING,
    EXECUTION_STATES.RECOVERING
  ],
  [EXECUTION_STATES.RETRYING]: [
    EXECUTION_STATES.RUNNING,
    EXECUTION_STATES.FAILED,
    EXECUTION_STATES.COMPLETED
  ],
  [EXECUTION_STATES.RECOVERING]: [
    EXECUTION_STATES.RUNNING,
    EXECUTION_STATES.FAILED
  ],
  [EXECUTION_STATES.FAILED]: [],
  [EXECUTION_STATES.COMPLETED]: []
};

class StateMachine {
  /**
   * Creates a new StateMachine instance.
   * @param {string} [initialState=EXECUTION_STATES.IDLE] - Starting execution state
   */
  constructor(initialState = EXECUTION_STATES.IDLE) {
    this.state = initialState;
    this.history = [];
    this._log('StateMachine initialized', { state: this.state });
  }

  /**
   * Returns the current execution state.
   * @returns {string} Current state string (e.g., 'idle', 'running', 'completed')
   */
  getState() {
    return this.state;
  }

  /**
   * Checks if a transition to the given state is valid from the current state.
   * @param {string} toState - Target state to transition to
   * @returns {boolean} True if the transition is allowed
   */
  canTransition(toState) {
    const allowed = VALID_TRANSITIONS[this.state] || [];
    return allowed.includes(toState);
  }

  /**
   * Performs a state transition. Throws StateTransitionError if the transition is invalid.
   * @param {string} toState - Target state to transition to
   * @param {string} [reason=''] - Human-readable reason for the transition
   * @returns {Object} Transition record: `{ from, to, reason, timestamp }`
   * @throws {StateTransitionError} If the transition is not allowed from the current state
   */
  transition(toState, reason = '') {
    const fromState = this.state;

    if (!this.canTransition(toState)) {
      const error = new StateTransitionError(
        `Invalid transition: ${fromState} → ${toState}`,
        { from: fromState, to: toState, reason }
      );
      this._log('Transition rejected', { from: fromState, to: toState, reason, error: error.message });
      throw error;
    }

    this.state = toState;
    const record = {
      from: fromState,
      to: toState,
      reason,
      timestamp: new Date().toISOString()
    };
    this.history.push(record);
    this._log('State transitioned', record);
    return record;
  }

  /**
   * Checks if the current state is terminal (completed or failed).
   * @returns {boolean} True if state is 'completed' or 'failed'
   */
  isTerminal() {
    return this.state === EXECUTION_STATES.FAILED || this.state === EXECUTION_STATES.COMPLETED;
  }

  /**
   * Checks if the current state is active (not idle and not terminal).
   * @returns {boolean} True if state is 'running', 'waiting_checkpoint', 'retrying', or 'recovering'
   */
  isActive() {
    return !this.isTerminal() && this.state !== EXECUTION_STATES.IDLE;
  }

  /**
   * Returns an immutable copy of the transition history.
   * @returns {Array<Object>} Array of transition records: `{ from, to, reason, timestamp }`
   */
  getHistory() {
    return [...this.history];
  }

  _log(message, context = {}) {
    console.log(`[StateMachine] ${message}`, JSON.stringify(context));
  }
}

class StateTransitionError extends Error {
  constructor(message, context) {
    super(message);
    this.name = 'StateTransitionError';
    this.context = context;
  }
}

module.exports = {
  StateMachine,
  StateTransitionError,
  EXECUTION_STATES
};
