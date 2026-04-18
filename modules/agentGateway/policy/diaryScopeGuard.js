const {
    createForbiddenError
} = require('./toolScopeGuard');

function isDiaryAllowed(policy, diaryName) {
    const normalizedDiaryName = typeof diaryName === 'string' ? diaryName.trim() : '';
    if (!normalizedDiaryName) {
        return false;
    }
    const allowedDiaryNames = Array.isArray(policy?.allowedDiaryNames)
        ? policy.allowedDiaryNames
        : [];
    return allowedDiaryNames.includes(normalizedDiaryName);
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
