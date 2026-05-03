/**
 * WorkflowStateRepository interface.
 * Abstract interface for workflow state persistence.
 * First adapter: existing StoryStateRepository.
 * Future adapters: independent SQLite workflows table.
 */

class WorkflowStateRepository {
  /**
   * Create a new workflow record.
   * @param {string} workflowId
   * @param {string} definitionRef
   * @param {Object} initialContext
   * @returns {Promise<Object>} WorkflowRecord
   */
  async create(workflowId, definitionRef, initialContext) {
    throw new Error('Method not implemented: create');
  }

  /**
   * Get a workflow record by id.
   * @param {string} workflowId
   * @returns {Promise<Object|null>} WorkflowRecord
   */
  async get(workflowId) {
    throw new Error('Method not implemented: get');
  }

  /**
   * Partially update a workflow record using deep-merge.
   * @param {string} workflowId
   * @param {Object} patch
   * @returns {Promise<void>}
   */
  async update(workflowId, patch) {
    throw new Error('Method not implemented: update');
  }

  /**
   * Append an event to workflow history.
   * @param {string} workflowId
   * @param {Object} event
   * @returns {Promise<void>}
   */
  async appendHistory(workflowId, event) {
    throw new Error('Method not implemented: appendHistory');
  }

  /**
   * List all active (non-terminal) workflows.
   * @returns {Promise<Object[]>} WorkflowRecord[]
   */
  async listActive() {
    throw new Error('Method not implemented: listActive');
  }
}

module.exports = { WorkflowStateRepository };
