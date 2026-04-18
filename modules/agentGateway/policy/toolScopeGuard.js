const {
    AGW_ERROR_CODES
} = require('../contracts/errorCodes');

function createForbiddenError(resourceType, resourceId, authContext = {}) {
    const error = new Error(`${resourceType} '${resourceId}' is not allowed for this agent`);
    error.code = AGW_ERROR_CODES.FORBIDDEN;
    error.status = 403;
    error.details = {
        resourceType,
        resourceId,
        agentId: authContext.agentId || '',
        sessionId: authContext.sessionId || '',
        requestId: authContext.requestId || ''
    };
    return error;
}

function isToolAllowed(policy, toolName) {
    const normalizedToolName = typeof toolName === 'string' ? toolName.trim() : '';
    if (!normalizedToolName) {
        return false;
    }
    if (policy?.allowAllTools) {
        return true;
    }
    const allowedToolNames = Array.isArray(policy?.allowedToolNames)
        ? policy.allowedToolNames
        : [];
    return allowedToolNames.includes(normalizedToolName);
}

function ensureToolAllowed({ policy, toolName, authContext }) {
    if (isToolAllowed(policy, toolName)) {
        return true;
    }
    throw createForbiddenError('tool', toolName, authContext);
}

module.exports = {
    createForbiddenError,
    isToolAllowed,
    ensureToolAllowed
};
