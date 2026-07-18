const Ajv = require('ajv');
const { gatewayToolSchemas } = require('../operations');

const ajv = new Ajv({ coerceTypes: false, useDefaults: false, removeAdditional: false, allErrors: true });
function toCompatibilitySchema(schema) {
    if (Array.isArray(schema)) return schema.map(toCompatibilitySchema);
    if (!schema || typeof schema !== 'object') return schema;
    const result = Object.fromEntries(Object.entries(schema).map(([key, value]) => [key, toCompatibilitySchema(value)]));
    if (result.type === 'object' && result.additionalProperties === false) result.additionalProperties = true;
    if ((result.type === 'integer' || result.type === 'number') && !result.enum) {
        const numeric = { ...result };
        const stringPattern = result.type === 'integer' ? '^-?\\d+$' : '^-?(?:\\d+\\.?\\d*|\\.\\d+)$';
        return { anyOf: [numeric, { type: 'string', pattern: stringPattern }] };
    }
    return result;
}

const validators = new Map(Object.entries(gatewayToolSchemas).map(
    ([name, schema]) => [name, ajv.compile(toCompatibilitySchema(schema))]
));

function validateGatewayToolArguments(toolName, args) {
    const validate = validators.get(toolName);
    if (!validate || validate(args)) return [];
    return (validate.errors || []).map((error) => ({
        path: error.instancePath || '/',
        keyword: error.keyword,
        message: error.message || 'is invalid',
        params: error.params
    }));
}

module.exports = { toCompatibilitySchema, validateGatewayToolArguments };
