const { normalizeString, normalizeStringArray } = require('./shared/normalize');

/**
 * 交叉引用校验助手（§4.3 第 4 条）。单项检查在此实现，
 * M0.S3 的 integrationSnapshotCoordinator 统一编排全集校验。
 */

function crossValidateCredentialPepperKids(credentialConfig, keyringConfig) {
    const errors = [];
    const knownKids = new Set(Object.keys(keyringConfig?.keys || {}));
    const credentials = Array.isArray(credentialConfig?.credentials) ? credentialConfig.credentials : [];
    credentials.forEach((record, index) => {
        const kid = normalizeString(record?.pepperKid);
        if (kid && !knownKids.has(kid)) {
            errors.push({
                path: `$.credentials[${index}].pepperKid`,
                message: `unknown pepperKid "${kid}" (not present in pepper keyring)`
            });
        }
    });
    return errors;
}

function crossValidateGuidanceAgents(guidanceConfig, directoryAgentIds) {
    const errors = [];
    const knownAgents = new Set(normalizeStringArray(directoryAgentIds));
    for (const agentId of Object.keys(guidanceConfig?.agents || {})) {
        if (!knownAgents.has(agentId)) {
            errors.push({
                path: `$.agents.${agentId}`,
                message: `unknown agent "${agentId}" (not present in agent directory)`
            });
        }
    }
    return errors;
}

function crossValidateMemoryPolicyDiaries({ agentId, allowedDiaries, defaultDiaries } = {}) {
    const errors = [];
    const allowed = new Set(normalizeStringArray(allowedDiaries));
    const defaults = normalizeStringArray(defaultDiaries);
    if (allowed.size === 0) {
        return errors;
    }
    defaults.forEach((diary) => {
        if (!allowed.has(diary)) {
            errors.push({
                path: `$.agents.${normalizeString(agentId) || '<unknown>'}.defaultDiaries`,
                message: `default diary "${diary}" is not in allowedDiaries`
            });
        }
    });
    return errors;
}

module.exports = {
    crossValidateCredentialPepperKids,
    crossValidateGuidanceAgents,
    crossValidateMemoryPolicyDiaries
};
