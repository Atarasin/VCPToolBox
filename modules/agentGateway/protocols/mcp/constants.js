const packageMetadata = require('../../composition/packageMetadata');

const MCP_PROTOCOL_VERSION = '2025-06-18';

const MCP_ERROR_CODES = Object.freeze({
    INVALID_REQUEST: 'MCP_INVALID_REQUEST',
    INVALID_ARGUMENTS: 'MCP_INVALID_ARGUMENTS',
    FORBIDDEN: 'MCP_FORBIDDEN',
    NOT_FOUND: 'MCP_NOT_FOUND',
    TIMEOUT: 'MCP_TIMEOUT',
    RUNTIME_ERROR: 'MCP_RUNTIME_ERROR',
    RESOURCE_UNSUPPORTED: 'MCP_RESOURCE_UNSUPPORTED',
    SERVICE_UNAVAILABLE: 'MCP_SERVICE_UNAVAILABLE',
    UNAUTHORIZED: 'MCP_UNAUTHORIZED'
});

const MCP_ERROR_CODE_SET = new Set(Object.values(MCP_ERROR_CODES));

const JSON_RPC_ERROR_CODES = Object.freeze({
    METHOD_NOT_FOUND: -32601,
    SERVER_ERROR: -32000
});

const MCP_SERVER_INFO = Object.freeze({
    name: 'vcp-agent-gateway',
    version: packageMetadata.version
});

const MCP_STRING_LIMITS = Object.freeze({
    MESSAGE: 256,
    CODE: 64,
    CONTEXT: 128
});

module.exports = {
    JSON_RPC_ERROR_CODES,
    MCP_ERROR_CODES,
    MCP_ERROR_CODE_SET,
    MCP_PROTOCOL_VERSION,
    MCP_SERVER_INFO,
    MCP_STRING_LIMITS
};
