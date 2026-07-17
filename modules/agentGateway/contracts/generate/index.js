const packageJson = require('../../composition/packageMetadata');
const sourceDocument = require('../schemas/openapiDocument.json');
const { createGatewayManagedToolDescriptors } = require('../../protocols/mcp/descriptors');

function generateOpenApiDocument() {
    const document = structuredClone(sourceDocument);
    document.info.version = packageJson.version;
    return document;
}

function generateMcpDescriptors() {
    return createGatewayManagedToolDescriptors();
}

module.exports = { generateMcpDescriptors, generateOpenApiDocument };
