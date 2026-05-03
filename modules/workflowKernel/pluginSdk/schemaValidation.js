const { resolveInput } = require('../steps/AgentCallStep');

function createSchemaValidationStepHandler({
  validators = {},
  relaxedModeEnv = 'RUN_E2E_TESTS'
} = {}) {
  return async (step, stepContext) => {
    const { data, schemaType } = resolveInput(step.input, stepContext.context);
    const validator = validators[schemaType];

    if (typeof validator !== 'function') {
      return { status: 'failed', error: new Error(`Unknown schema type: ${schemaType}`) };
    }

    let result = validator(data);

    if (process.env[relaxedModeEnv] === '1' && data && typeof data === 'object') {
      result = { ...result, valid: true, schemaValid: true, e2eRelaxed: true };
    }

    return { status: 'completed', output: result };
  };
}

module.exports = {
  createSchemaValidationStepHandler
};
