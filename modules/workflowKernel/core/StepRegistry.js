/**
 * Extensible step type registry.
 * Plugins can register custom step handlers at runtime.
 */

class StepRegistry {
  constructor() {
    this.handlers = new Map();
  }

  /**
   * Registers a custom step type handler.
   * @param {string} name - Unique step type identifier (non-empty string)
   * @param {function} handler - Async step handler: `async (step, stepContext) => StepResult`
   * @throws {Error} If name is not a non-empty string or handler is not a function
   */
  register(name, handler) {
    if (typeof name !== 'string' || name.length === 0) {
      throw new Error('Step type name must be a non-empty string');
    }
    if (typeof handler !== 'function') {
      throw new Error('Step handler must be a function');
    }
    this.handlers.set(name, handler);
  }

  /**
   * Retrieves a registered step handler by name.
   * @param {string} name - Step type identifier
   * @returns {function|undefined} The registered handler, or undefined if not found
   */
  get(name) {
    return this.handlers.get(name);
  }

  /**
   * Checks if a step type is registered.
   * @param {string} name - Step type identifier
   * @returns {boolean} True if the step type is registered
   */
  has(name) {
    return this.handlers.has(name);
  }

  /**
   * Lists all registered step type names.
   * @returns {Array<string>} Array of registered step type identifiers
   */
  list() {
    return Array.from(this.handlers.keys());
  }

  /**
   * Unregisters a step type handler.
   * @param {string} name - Step type identifier to remove
   * @returns {boolean} True if a handler was removed, false if not found
   */
  unregister(name) {
    return this.handlers.delete(name);
  }
}

module.exports = { StepRegistry };
