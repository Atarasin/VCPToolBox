const {
    AGW_ERROR_CODES,
    OPENCLAW_TO_AGENT_GATEWAY_CODE
} = require('../../contracts/errorCodes');
const { MCP_ERROR_CODES } = require('./constants');

function mapGatewayFailureToMcpErrorCode(code) {
    const canonicalCode = OPENCLAW_TO_AGENT_GATEWAY_CODE[code] || code || AGW_ERROR_CODES.INTERNAL_ERROR;
    switch (canonicalCode) {
    case AGW_ERROR_CODES.INVALID_REQUEST:
        return MCP_ERROR_CODES.INVALID_REQUEST;
    case AGW_ERROR_CODES.VALIDATION_ERROR:
    case AGW_ERROR_CODES.RECALL_INVALID_QUERY:
    case AGW_ERROR_CODES.RECALL_INVALID_PROFILE:
    case AGW_ERROR_CODES.RECALL_INVALID_RULE:
    case AGW_ERROR_CODES.RECALL_INVALID_MODIFIER:
    case AGW_ERROR_CODES.RECALL_INVALID_DIARY:
        return MCP_ERROR_CODES.INVALID_ARGUMENTS;
    case AGW_ERROR_CODES.FORBIDDEN:
    case AGW_ERROR_CODES.RECALL_FORBIDDEN:
        return MCP_ERROR_CODES.FORBIDDEN;
    case AGW_ERROR_CODES.NOT_FOUND:
    case AGW_ERROR_CODES.RECALL_NO_PROFILE:
        return MCP_ERROR_CODES.NOT_FOUND;
    case AGW_ERROR_CODES.TIMEOUT:
        return MCP_ERROR_CODES.TIMEOUT;
    default:
        return MCP_ERROR_CODES.RUNTIME_ERROR;
    }
}

module.exports = {
    mapGatewayFailureToMcpErrorCode
};
