const { ExtractionLayer, ExtractionError } = require('../extraction/ExtractionLayer');
const { resolveInput } = require('../steps/AgentCallStep');

const DEFAULT_EXTRACTION_PARSER_ORDER = ['jsonBlock', 'jsonObject', 'xml', 'fallbackRaw'];

function createExtractionLogger(logger = null) {
  if (logger && typeof logger.log === 'function' && typeof logger.error === 'function' && typeof logger.warn === 'function') {
    return logger;
  }

  return { log: console.log, error: console.error, warn: console.warn };
}

function normalizeExtractionOptions(extraction = {}, overrides = {}) {
  return {
    schema: extraction.schema,
    requiredFields: extraction.requiredFields,
    defaultValue: extraction.defaultValue,
    parserOrder: extraction.parserOrder || DEFAULT_EXTRACTION_PARSER_ORDER,
    throwOnFailure: extraction.throwOnFailure !== false,
    ...overrides
  };
}

function recordExtractionMetrics(onMetrics, stepId, meta, success) {
  if (typeof onMetrics === 'function') {
    onMetrics(stepId, meta, success);
  }
}

function extractWithMetrics(raw, extraction = {}, {
  stepId = 'extract',
  logger = null,
  onMetrics = null
} = {}) {
  const extractionLogger = createExtractionLogger(logger);
  const extractionLayer = new ExtractionLayer(extractionLogger);

  try {
    const extracted = extractionLayer.extract(raw, normalizeExtractionOptions(extraction));
    recordExtractionMetrics(onMetrics, stepId, extracted.meta, true);
    return extracted;
  } catch (err) {
    recordExtractionMetrics(onMetrics, stepId, { attempts: [{ success: false, error: err.message }] }, false);

    if (extraction.throwOnFailure !== false) {
      throw err;
    }

    return {
      data: extraction.defaultValue,
      meta: {
        attempts: [{ parser: 'none', success: false, error: err.message }],
        usedParser: null
      }
    };
  }
}

function runExtractionStep(result, step, {
  logger = null,
  onMetrics = null
} = {}) {
  const extractionConfig = step.extraction || {};
  const options = normalizeExtractionOptions(extractionConfig);
  const maxAttempts = extractionConfig.maxAttempts || 1;
  let lastError = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const extracted = extractWithMetrics(result.content, options, {
        stepId: step.id || step.agent || 'agentExtraction',
        logger,
        onMetrics
      });

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

      if (attempt < maxAttempts) {
        createExtractionLogger(logger).log(
          `[pluginSdk] Extraction retry ${attempt + 1}/${maxAttempts} for step ${step.id || step.agent || 'agentExtraction'}`
        );
      }
    }
  }

  return {
    status: 'failed',
    error: lastError instanceof ExtractionError
      ? lastError
      : new ExtractionError(
          'NO_MATCH',
          `Extraction failed after ${maxAttempts} attempt(s): ${lastError?.message}`,
          { cause: lastError }
        )
  };
}

function createParseStructuredDataStepHandler({
  resolveInputFn = resolveInput,
  getRaw = (input) => input.raw || '',
  getExtractionOptions = () => ({
    parserOrder: DEFAULT_EXTRACTION_PARSER_ORDER,
    throwOnFailure: false
  }),
  normalizeOutput = ({ extracted }) => extracted,
  logger = null,
  onMetrics = null
} = {}) {
  return async (step, stepContext) => {
    try {
      const input = resolveInputFn(step.input, stepContext.context);
      const raw = getRaw(input, step, stepContext);
      const extractionOptions = getExtractionOptions(input, step, stepContext);
      const extracted = extractWithMetrics(raw, extractionOptions, {
        stepId: step.id || step.type || 'parseStructuredData',
        logger,
        onMetrics
      });

      return {
        status: 'completed',
        output: normalizeOutput({ extracted, raw, input, step, stepContext })
      };
    } catch (error) {
      return {
        status: 'failed',
        error
      };
    }
  };
}

module.exports = {
  DEFAULT_EXTRACTION_PARSER_ORDER,
  normalizeExtractionOptions,
  extractWithMetrics,
  runExtractionStep,
  createParseStructuredDataStepHandler
};
