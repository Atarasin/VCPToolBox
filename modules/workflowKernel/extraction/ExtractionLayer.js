/**
 * ExtractionLayer — two-phase pipeline for structured data extraction from LLM markdown output.
 *
 * Phase 1: LLM outputs free-form markdown
 * Phase 2: ExtractionLayer parses structured data using configurable parsers
 */

const {
  jsonBlockParser,
  jsonObjectParser,
  xmlParser,
  fallbackRawParser
} = require('./parsers');

/**
 * ExtractionError codes:
 * - NO_MATCH: No parser could extract structured data
 * - INVALID_JSON: JSON parser found a candidate but it was malformed
 * - SCHEMA_MISMATCH: Extracted data failed schema validation
 * - MISSING_FIELDS: Required fields were absent from extracted data
 */
class ExtractionError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'ExtractionError';
    this.code = code;
    this.details = details;
  }
}

/**
 * ExtractionLayer class
 */
class ExtractionLayer {
  constructor(logger = null) {
    this.parsers = new Map();
    this.logger = logger || { log: () => {}, error: () => {}, warn: () => {} };
    this._attemptLog = [];

    // Register built-in parsers in default priority order
    this.registerParser('jsonBlock', jsonBlockParser);
    this.registerParser('jsonObject', jsonObjectParser);
    this.registerParser('xml', xmlParser);
    this.registerParser('fallbackRaw', fallbackRawParser);
  }

  /**
   * Register a parser by name.
   * @param {string} name
   * @param {function(string): any} parserFn — receives markdown, returns parsed value or undefined
   */
  registerParser(name, parserFn) {
    if (typeof parserFn !== 'function') {
      throw new Error(`Parser "${name}" must be a function`);
    }
    this.parsers.set(name, parserFn);
  }

  /**
   * Unregister a parser by name.
   * @param {string} name
   */
  unregisterParser(name) {
    this.parsers.delete(name);
  }

  /**
   * Extract structured data from markdown.
   *
   * @param {string} markdown — raw LLM output
   * @param {Object} [options={}] — extraction options
   * @param {string[]} [options.parserOrder] — ordered list of parser names to try
   * @param {Object} [options.schema] — schema for validation (shape: { type, properties, required })
   * @param {string[]} [options.requiredFields] — top-level field names that must be present
   * @param {*} [options.defaultValue] — returned when all parsers fail and no error is thrown
   * @param {boolean} [options.throwOnFailure=true] — if false, returns defaultValue on total failure
   *
   * @returns {{ data: any, meta: { attempts: Array<{parser: string, success: boolean, error?: string}>, usedParser: string|null } }}
   *
   * @throws {ExtractionError}
   */
  extract(markdown, options = {}) {
    const {
      parserOrder = ['jsonBlock', 'jsonObject', 'xml', 'fallbackRaw'],
      schema = null,
      requiredFields = null,
      defaultValue = undefined,
      throwOnFailure = true
    } = options;

    this._attemptLog = [];
    let data = undefined;
    let usedParser = null;

    for (const parserName of parserOrder) {
      const parser = this.parsers.get(parserName);
      if (!parser) {
        this._attemptLog.push({ parser: parserName, success: false, error: 'Parser not registered' });
        this.logger.warn(`[ExtractionLayer] Parser "${parserName}" not registered`);
        continue;
      }

      this.logger.log(`[ExtractionLayer] Trying parser: ${parserName}`);

      try {
        const result = parser(markdown);
        if (result !== undefined) {
          data = result;
          usedParser = parserName;
          this._attemptLog.push({ parser: parserName, success: true });
          this.logger.log(`[ExtractionLayer] Parser "${parserName}" succeeded`);
          break;
        } else {
          this._attemptLog.push({ parser: parserName, success: false, error: 'NO_MATCH' });
        }
      } catch (err) {
        this._attemptLog.push({ parser: parserName, success: false, error: err.message });
        this.logger.error(`[ExtractionLayer] Parser "${parserName}" threw: ${err.message}`);
      }
    }

    // If no parser matched and fallback is disabled or missing
    if (data === undefined) {
      if (throwOnFailure) {
        throw new ExtractionError(
          'NO_MATCH',
          'No parser could extract structured data from the provided markdown',
          { attempts: this._attemptLog }
        );
      }
      return {
        data: defaultValue,
        meta: { attempts: this._attemptLog, usedParser: null }
      };
    }

    // Schema validation
    if (schema) {
      const schemaError = this._validateSchema(data, schema);
      if (schemaError) {
        if (throwOnFailure) {
          throw new ExtractionError(
            'SCHEMA_MISMATCH',
            `Schema validation failed: ${schemaError}`,
            { attempts: this._attemptLog, data }
          );
        }
        return {
          data: defaultValue,
          meta: { attempts: this._attemptLog, usedParser }
        };
      }
    }

    // Required fields check
    if (requiredFields && Array.isArray(requiredFields)) {
      const missing = requiredFields.filter(f => data == null || data[f] === undefined);
      if (missing.length > 0) {
        if (throwOnFailure) {
          throw new ExtractionError(
            'MISSING_FIELDS',
            `Missing required fields: ${missing.join(', ')}`,
            { attempts: this._attemptLog, data, missing }
          );
        }
        return {
          data: defaultValue,
          meta: { attempts: this._attemptLog, usedParser }
        };
      }
    }

    return {
      data,
      meta: { attempts: this._attemptLog, usedParser }
    };
  }

  /**
   * Simple schema validator.
   * Supports { type: 'object', properties: { key: { type: 'string' } }, required: ['key'] }
   * Returns error message string or null if valid.
   */
  _validateSchema(data, schema) {
    if (!schema || typeof schema !== 'object') return null;

    if (schema.type === 'object') {
      if (data === null || typeof data !== 'object' || Array.isArray(data)) {
        return `Expected object, got ${Array.isArray(data) ? 'array' : typeof data}`;
      }

      if (schema.properties && typeof schema.properties === 'object') {
        for (const [key, propSchema] of Object.entries(schema.properties)) {
          if (data[key] !== undefined) {
            const propError = this._validateType(data[key], propSchema.type);
            if (propError) {
              return `Property "${key}" ${propError}`;
            }
          }
        }
      }

      if (schema.required && Array.isArray(schema.required)) {
        const missing = schema.required.filter(k => data[k] === undefined);
        if (missing.length > 0) {
          return `Missing required properties: ${missing.join(', ')}`;
        }
      }
    } else if (schema.type === 'array') {
      if (!Array.isArray(data)) {
        return `Expected array, got ${typeof data}`;
      }
    } else {
      const typeError = this._validateType(data, schema.type);
      if (typeError) return typeError;
    }

    return null;
  }

  _validateType(value, expectedType) {
    if (!expectedType) return null;
    const actualType = Array.isArray(value) ? 'array' : value === null ? 'null' : typeof value;
    if (actualType === expectedType) return null;
    // Coerce-friendly: number accepts numeric strings? No — strict
    return `expected type "${expectedType}", got "${actualType}"`;
  }

  /**
   * Get the attempt log from the last extraction call.
   * @returns {Array<{parser: string, success: boolean, error?: string}>}
   */
  getAttemptLog() {
    return [...this._attemptLog];
  }
}

module.exports = {
  ExtractionLayer,
  ExtractionError
};
