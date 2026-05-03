/**
 * AgentCallStep — delegates to an agent via AgentDispatcher.
 *
 * Config:
 *   agent: string — agent type identifier
 *   input: Object — literal values or { $ref: 'ctx.steps.x.outputs.y' }
 *   outputKey: string — where to store result
 *   options: Object — timeoutMs, taskDelegation, etc.
 *   extraction: Object — schema, requiredFields, defaultValue, maxAttempts, parserOrder
 */

const { ExtractionLayer, ExtractionError } = require('../extraction/ExtractionLayer');

function resolveRef(refPath, context) {
  if (!refPath.startsWith('ctx.')) {
    throw new Error(`Invalid $ref path: ${refPath}. Must start with 'ctx.'`);
  }
  const parts = refPath.slice(4).split('.'); // Remove 'ctx.' prefix
  let current = context;
  for (const part of parts) {
    if (current == null || typeof current !== 'object') {
      throw new Error(`Cannot resolve $ref path: ${refPath} (failed at '${part}')`);
    }
    current = current[part];
  }
  return current;
}

function resolveInput(input, context) {
  if (input === null || typeof input !== 'object') {
    return input;
  }

  if (input.$ref) {
    return resolveRef(input.$ref, context);
  }

  const resolved = {};
  for (const [key, value] of Object.entries(input)) {
    resolved[key] = resolveInput(value, context);
  }
  return resolved;
}

async function agentCallStep(step, stepContext) {
  const { kernel, context } = stepContext;
  const { agentDispatcher } = kernel;

  if (!agentDispatcher) {
    return {
      status: 'failed',
      error: new Error('AgentDispatcher not available in kernel')
    };
  }

  const agentId = step.agent;
  if (!agentId) {
    return {
      status: 'failed',
      error: new Error('agentCall step missing "agent" field')
    };
  }

  // Resolve inputs
  let resolvedInput = {};
  try {
    resolvedInput = step.input ? resolveInput(step.input, context) : {};
  } catch (err) {
    return {
      status: 'failed',
      error: new Error(`Input resolution failed: ${err.message}`)
    };
  }

  // Build prompt from resolved input
  const prompt = resolvedInput.prompt || JSON.stringify(resolvedInput);

  const options = step.options || {};

  try {
    const result = await agentDispatcher.delegate(agentId, prompt, options);

    // Two-phase extraction: if extraction config is present, parse structured data
    if (step.extraction) {
      const logger = kernel.logger || { log: () => {}, error: () => {}, warn: () => {} };
      const extractionLayer = new ExtractionLayer(logger);

      const extractionOptions = {
        schema: step.extraction.schema,
        requiredFields: step.extraction.requiredFields,
        defaultValue: step.extraction.defaultValue,
        parserOrder: step.extraction.parserOrder,
        throwOnFailure: true
      };

      const maxAttempts = step.extraction.maxAttempts || 1;
      let lastError = null;

      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        logger.log(`[AgentCallStep] Extraction attempt ${attempt}/${maxAttempts} for step ${step.id || agentId}`);

        try {
          const extracted = extractionLayer.extract(result.content, extractionOptions);

          return {
            status: 'completed',
            output: {
              content: result.content,
              data: extracted.data,
              meta: extracted.meta,
              markers: result.markers,
              raw: result.raw
            }
          };
        } catch (err) {
          lastError = err;
          logger.error(`[AgentCallStep] Extraction attempt ${attempt}/${maxAttempts} failed: ${err.message}`);

          if (attempt < maxAttempts) {
            logger.log(`[AgentCallStep] Retrying extraction (${attempt + 1}/${maxAttempts})...`);
          }
        }
      }

      // All extraction attempts exhausted
      return {
        status: 'failed',
        error: lastError instanceof ExtractionError
          ? lastError
          : new ExtractionError('NO_MATCH', `Extraction failed after ${maxAttempts} attempt(s): ${lastError?.message}`, { cause: lastError })
      };
    }

    // No extraction config — return raw content (backward compatibility)
    return {
      status: 'completed',
      output: {
        content: result.content,
        markers: result.markers,
        raw: result.raw
      }
    };
  } catch (error) {
    return {
      status: 'failed',
      error: new Error(`Agent delegation failed: ${error.message}`)
    };
  }
}

module.exports = { agentCallStep, resolveRef, resolveInput };
