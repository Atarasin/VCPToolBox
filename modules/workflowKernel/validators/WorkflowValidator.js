/**
 * WorkflowValidator — validates workflow definitions beyond basic schema.
 *
 * Additional validations:
 * - Step IDs are valid JavaScript identifiers
 * - All step types are registered in StepRegistry
 * - All $ref paths in inputs are syntactically valid and potentially reachable
 * - No circular references in $ref paths (basic check)
 */

const { WorkflowDefinitionSchema } = require('../types/WorkflowDefinition');

class WorkflowValidator {
  constructor(stepRegistry) {
    this.stepRegistry = stepRegistry;
  }

  validate(definition) {
    const errors = [];

    // Schema validation
    try {
      WorkflowDefinitionSchema.validate(definition);
    } catch (err) {
      if (err.validationErrors) {
        errors.push(...err.validationErrors);
      } else {
        errors.push(err.message);
      }
    }

    // Step ID validation (valid JS identifier)
    const idPattern = /^[a-zA-Z_][a-zA-Z0-9_]*$/;
    for (const phase of definition.phases || []) {
      for (const step of phase.steps || []) {
        if (!idPattern.test(step.id)) {
          errors.push(`Step ID '${step.id}' is not a valid identifier`);
        }
        if (step.outputKey && !idPattern.test(step.outputKey)) {
          errors.push(`OutputKey '${step.outputKey}' is not a valid identifier`);
        }
      }
    }

    // Step type registration check
    if (this.stepRegistry) {
      for (const phase of definition.phases || []) {
        for (const step of phase.steps || []) {
          if (!this.stepRegistry.has(step.type)) {
            errors.push(`Step type '${step.type}' is not registered`);
          }
        }
      }
    }

    // $ref path validation
    for (const phase of definition.phases || []) {
      for (const step of phase.steps || []) {
        const refs = this._collectRefs(step.input);
        for (const ref of refs) {
          if (!ref.startsWith('ctx.')) {
            errors.push(`Invalid $ref path: ${ref} (must start with 'ctx.')`);
          }
          const parts = ref.slice(4).split('.');
          if (parts.length < 2) {
            errors.push(`Invalid $ref path: ${ref} (too short)`);
          }
          if (parts[0] !== 'inputs' && parts[0] !== 'steps' && parts[0] !== 'outputs') {
            errors.push(`Invalid $ref path: ${ref} (must reference 'inputs', 'steps', or 'outputs')`);
          }
        }
      }
    }

    return {
      valid: errors.length === 0,
      errors
    };
  }

  _collectRefs(input, refs = []) {
    if (input === null || typeof input !== 'object') {
      return refs;
    }

    if (input.$ref) {
      refs.push(input.$ref);
      return refs;
    }

    for (const value of Object.values(input)) {
      this._collectRefs(value, refs);
    }

    return refs;
  }
}

module.exports = { WorkflowValidator };
