const packageJson = require('../../composition/packageMetadata');
const metadata = require('../schemas/openapiMetadata.json');
const components = require('../schemas/openapiComponents.json');
const { MCP_OPERATIONS, REST_OPERATIONS } = require('../operations');
const { convertJsonSchemaToOpenApi, convertSchemaNodes } = require('./jsonSchemaToOpenApi');

function clone(value) { return structuredClone(value); }

function generateOpenApiDocument() {
    return {
        ...clone(metadata),
        info: { ...clone(metadata.info), version: packageJson.version },
        paths: Object.fromEntries(REST_OPERATIONS.map((operation) => [operation.path, convertSchemaNodes(operation.openapi)])),
        components: {
            ...clone(components),
            schemas: Object.fromEntries(Object.entries(components.schemas).map(([name, schema]) => [
                name, convertJsonSchemaToOpenApi(schema)
            ]))
        }
    };
}

function generateMcpDescriptors() {
    return MCP_OPERATIONS.flatMap((operation) => operation.mcp.tool ? [clone(operation.mcp.tool)] : []);
}

function generateMcpPromptDescriptors() {
    return MCP_OPERATIONS.flatMap((operation) => operation.mcp.prompt ? [clone(operation.mcp.prompt)] : []);
}

module.exports = { generateMcpDescriptors, generateMcpPromptDescriptors, generateOpenApiDocument };
