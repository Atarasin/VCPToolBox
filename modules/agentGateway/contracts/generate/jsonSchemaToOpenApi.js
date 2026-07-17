const UNSUPPORTED_OPENAPI_30_KEYWORDS = new Set([
    '$schema', '$id', 'if', 'then', 'else', 'unevaluatedProperties', 'dependentSchemas', 'minContains', 'maxContains'
]);

function convertJsonSchemaToOpenApi(schema) {
    if (Array.isArray(schema)) return schema.map(convertJsonSchemaToOpenApi);
    if (!schema || typeof schema !== 'object') return schema;
    const converted = {};
    for (const [key, value] of Object.entries(schema)) {
        if (UNSUPPORTED_OPENAPI_30_KEYWORDS.has(key)) continue;
        if (key === 'const') {
            converted.enum = [value];
            continue;
        }
        if (key === 'examples' && Array.isArray(value)) {
            if (value.length && converted.example === undefined) converted.example = value[0];
            continue;
        }
        converted[key] = convertJsonSchemaToOpenApi(value);
    }
    if (Array.isArray(converted.type) && converted.type.includes('null')) {
        const nonNullTypes = converted.type.filter((type) => type !== 'null');
        converted.type = nonNullTypes.length === 1 ? nonNullTypes[0] : nonNullTypes;
        converted.nullable = true;
    }
    return converted;
}

function convertSchemaNodes(value) {
    if (Array.isArray(value)) return value.map(convertSchemaNodes);
    if (!value || typeof value !== 'object') return value;
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [
        key,
        key === 'schema' ? convertJsonSchemaToOpenApi(entry) : convertSchemaNodes(entry)
    ]));
}

module.exports = { convertJsonSchemaToOpenApi, convertSchemaNodes };
