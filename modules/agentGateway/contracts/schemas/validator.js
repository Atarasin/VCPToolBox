const Ajv = require('ajv');
const { gatewayToolSchemas } = require('../operations');

const ajv = new Ajv({ coerceTypes: false, useDefaults: false, removeAdditional: false, allErrors: true });
const validators = new Map(Object.entries(gatewayToolSchemas).map(([name, schema]) => [name, ajv.compile(schema)]));

function validateGatewayToolArguments(toolName, args) {
    const validate = validators.get(toolName);
    if (!validate || validate(args)) return [];
    return (validate.errors || []).map((error) => ({
        path: error.instancePath || '/',
        keyword: error.keyword,
        message: error.message || 'is invalid'
    }));
}

module.exports = { validateGatewayToolArguments };
