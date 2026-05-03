/**
 * WorkflowDefinition schema and type definitions.
 * Used for validation and documentation.
 */

/**
 * @typedef {Object} WorkflowDefinition
 * @property {string} id - Workflow definition identifier
 * @property {string} version - Semantic version
 * @property {PhaseDefinition[]} phases - Ordered phases
 * @property {Object} [globalRetryPolicy] - Global retry configuration
 * @property {string} [onFailure] - Global failure strategy
 */

/**
 * @typedef {Object} PhaseDefinition
 * @property {string} id - Phase identifier (unique within workflow)
 * @property {string} name - Human-readable phase name
 * @property {StepDefinition[]} steps - Ordered steps within phase
 */

/**
 * @typedef {Object} StepDefinition
 * @property {string} id - Step identifier (unique within workflow)
 * @property {string} type - Step type (registered in StepRegistry)
 * @property {string} [outputKey] - Key for storing output in context.outputs
 * @property {Object} [input] - Input mapping (literals or $ref)
 * @property {Object} [config] - Step-specific configuration
 * @property {Object} [retryPolicy] - Step-level retry override
 */

/**
 * @typedef {Object} StepResult
 * @property {string} status - 'completed' | 'waiting_checkpoint' | 'failed' | 'skipped'
 * @property {*} [output] - Step output data
 * @property {Object} [checkpoint] - Checkpoint info (if status === 'waiting_checkpoint')
 * @property {Error} [error] - Error (if status === 'failed')
 */

/**
 * @typedef {Object} CheckpointResponse
 * @property {string} checkpointId - Checkpoint identifier
 * @property {string} action - 'approve' | 'reject' | 'skip' | 'modify'
 * @property {string} [feedback] - Optional feedback text
 * @property {Object} [modifiedData] - Modified data (if action === 'modify')
 */

/**
 * Minimal schema validator (placeholder for WorkflowValidator in S03).
 */
class WorkflowDefinitionSchema {
  static validate(definition) {
    const errors = [];

    if (!definition.id || typeof definition.id !== 'string') {
      errors.push('Workflow definition must have a non-empty string id');
    }

    if (!Array.isArray(definition.phases) || definition.phases.length === 0) {
      errors.push('Workflow definition must have at least one phase');
    }

    const stepIds = new Set();
    for (const phase of definition.phases || []) {
      if (!phase.id || typeof phase.id !== 'string') {
        errors.push('Phase must have a non-empty string id');
      }
      if (!Array.isArray(phase.steps)) {
        errors.push(`Phase ${phase.id} must have a steps array`);
        continue;
      }
      for (const step of phase.steps) {
        if (!step.id || typeof step.id !== 'string') {
          errors.push('Step must have a non-empty string id');
        } else if (stepIds.has(step.id)) {
          errors.push(`Duplicate step id: ${step.id}`);
        } else {
          stepIds.add(step.id);
        }
        if (!step.type || typeof step.type !== 'string') {
          errors.push(`Step ${step.id} must have a non-empty string type`);
        }
      }
    }

    if (errors.length > 0) {
      const error = new Error('Workflow definition validation failed');
      error.validationErrors = errors;
      throw error;
    }

    return true;
  }
}

module.exports = { WorkflowDefinitionSchema };
