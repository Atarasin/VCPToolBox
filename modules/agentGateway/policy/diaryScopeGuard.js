const {
    createForbiddenError
} = require('./toolScopeGuard');
const {
    areDiaryNamesEquivalent
} = require('./mcpAgentMemoryPolicy');
const {
    buildDiaryAccessDetails,
    buildDiaryForbiddenMessage
} = require('./diaryAccessError');

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
    const allowedDiaries = Array.isArray(policy?.allowedDiaryNames)
        ? policy.allowedDiaryNames
        : [];
    const error = createForbiddenError('diary', diaryName, authContext);
    error.message = buildDiaryForbiddenMessage({
        forbiddenDiaries: [diaryName],
        allowedDiaries
    });
    error.details = {
        ...error.details,
        ...buildDiaryAccessDetails({
            agentId: authContext?.agentId,
            allowedDiaries,
            forbiddenDiaries: [diaryName]
        })
    };
    throw error;
}

module.exports = {
    isDiaryAllowed,
    ensureDiaryAllowed
};
