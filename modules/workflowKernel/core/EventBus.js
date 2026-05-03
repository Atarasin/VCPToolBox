/**
 * EventBus — generic publish/subscribe for kernel events.
 *
 * Event types:
 * - workflow.lifecycle: started, completed, failed, recovered
 * - workflow.step: step_started, step_completed, step_failed
 * - workflow.checkpoint: checkpoint_pending, checkpoint_approved, checkpoint_rejected, checkpoint_skipped, checkpoint_modified, checkpoint_timeout
 * - workflow.error: error_occurred, retry_scheduled
 * - agent.request: agent_call_initiated
 * - agent.response: agent_call_completed, agent_call_failed
 */

class EventBus {
  constructor() {
    this.subscribers = new Map();
  }

  /**
   * Subscribes to an event type. Returns an unsubscribe function.
   * @param {string} eventType - Event type or '*' for wildcard
   * @param {function} handler - Event handler: `(payload) => void`
   * @returns {function} Unsubscribe function
   */
  subscribe(eventType, handler) {
    if (!this.subscribers.has(eventType)) {
      this.subscribers.set(eventType, []);
    }
    this.subscribers.get(eventType).push(handler);
    return () => this.unsubscribe(eventType, handler);
  }

  /**
   * Removes a specific handler for an event type.
   * @param {string} eventType - Event type
   * @param {function} handler - Handler to remove
   */
  unsubscribe(eventType, handler) {
    const handlers = this.subscribers.get(eventType);
    if (!handlers) return;
    const idx = handlers.indexOf(handler);
    if (idx !== -1) {
      handlers.splice(idx, 1);
    }
  }

  /**
   * Publishes an event to all subscribers. Wildcard ('*') subscribers receive all events.
   * @param {string} eventType - Event type
   * @param {Object} payload - Event payload
   */
  publish(eventType, payload) {
    const handlers = this.subscribers.get(eventType) || [];
    const wildcards = this.subscribers.get('*') || [];
    const allHandlers = [...handlers, ...wildcards];
    if (allHandlers.length === 0) return;

    for (const handler of allHandlers) {
      try {
        handler(payload);
      } catch (err) {
        console.error(`[EventBus] Handler error for ${eventType}:`, err.message);
      }
    }
  }

  /**
   * Removes all subscribers.
   */
  clear() {
    this.subscribers.clear();
  }
}

module.exports = { EventBus };
