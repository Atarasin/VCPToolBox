const { PUBLISHED_NATIVE_GATEWAY_PATHS } = require('./protocolGovernance');
const { generateOpenApiDocument } = require('./generate');

function createPublishedOpenApiDocument() {
    return generateOpenApiDocument();
}

module.exports = { createPublishedOpenApiDocument, PUBLISHED_NATIVE_GATEWAY_PATHS };
