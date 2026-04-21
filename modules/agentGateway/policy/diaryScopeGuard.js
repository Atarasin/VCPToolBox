const {
    createForbiddenError
} = require('./toolScopeGuard');
const {
    areDiaryNamesEquivalent
} = require('./mcpAgentMemoryPolicy');

function isDiaryAllowed(policy, diaryName) {
    const normalizedDiaryName = typeof diaryName === 'string' ? diaryName.trim() : '';
    if (!normalizedDiaryName) {
        return false;
    }
    const allowedDiaryNames = Array.isArray(policy?.allowedDiaryNames)
        ? policy.allowedDiaryNames
        : [];
    return allowedDiaryNames.some((allowedDiaryName) => areDiaryNamesEquivalent(allowedDiaryName, normalizedDiaryName));
}

function ensureDiaryAllowed({ policy, diaryName, authContext }) {
    if (isDiaryAllowed(policy, diaryName)) {
        return true;
    }
    throw createForbiddenError('diary', diaryName, authContext);
}

module.exports = {
    isDiaryAllowed,
    ensureDiaryAllowed
};
