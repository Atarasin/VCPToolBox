const path = require('path');

const { createHotJsonConfigLoader } = require('./shared/hotJsonConfigLoader');
const { normalizeString, normalizeStringArray } = require('./shared/normalize');
const { createForbiddenError } = require('./toolScopeGuard');

const DEFAULT_POLICY_PATH = path.join(__dirname, '..', 'config', 'mcp_agent_knowledge_policy.json');

/**
 * M4.S3（Q2）：冷知识库权限边界——受限库仅对白名单 agent 开放（付鹏观点库仅 FuPeng），
 * 其余库对全体 agent 开放。复用日记本 diaryScopeGuard 的白名单思路：
 * - 显式请求受限且未授权的库 → 403（Forbidden，带可访问清单）
 * - 未指定库 → 默认检索该 agent 可访问的全部库（自动排除受限未授权库）
 */
const loadKnowledgePolicy = createHotJsonConfigLoader({
    fallback: {},
    normalize(parsed) {
        const restricted = parsed?.restrictedLibraries &&
            typeof parsed.restrictedLibraries === 'object' &&
            !Array.isArray(parsed.restrictedLibraries)
            ? parsed.restrictedLibraries
            : {};
        const restrictedLibraries = {};
        for (const [libraryName, rule] of Object.entries(restricted)) {
            const allowedAgents = normalizeStringArray(rule?.allowedAgents ?? rule);
            if (allowedAgents.length > 0) {
                restrictedLibraries[normalizeString(libraryName)] = Object.freeze(allowedAgents);
            }
        }
        return Object.freeze({ restrictedLibraries: Object.freeze(restrictedLibraries) });
    }
});

function isLibraryRestrictedFor(restrictedLibraries, libraryName, agentId) {
    const allowedAgents = restrictedLibraries?.[libraryName];
    return Array.isArray(allowedAgents) && !allowedAgents.includes(normalizeString(agentId));
}

function resolveKnowledgeLibraryAccess({
    requestedLibraries,
    availableLibraries,
    agentId,
    policyPath = DEFAULT_POLICY_PATH
}) {
    const policy = loadKnowledgePolicy(policyPath);
    const restricted = policy.restrictedLibraries;
    const available = normalizeStringArray(availableLibraries);
    const requested = normalizeStringArray(requestedLibraries);

    // 显式请求的库必须存在且对该 agent 开放；受限未授权 → Forbidden（403）
    if (requested.length > 0) {
        const unknown = requested.filter((name) => !available.includes(name));
        if (unknown.length > 0) {
            const error = createForbiddenError('knowledge-library', unknown.join(', '), { agentId });
            error.message = `Unknown knowledge libraries: ${unknown.join(', ')}. Available: ${available.join(', ') || '(none)'}.`;
            error.details = { ...error.details, unknownLibraries: unknown, availableLibraries: available };
            throw error;
        }
        const forbidden = requested.filter((name) => isLibraryRestrictedFor(restricted, name, agentId));
        if (forbidden.length > 0) {
            const accessible = available.filter((name) => !isLibraryRestrictedFor(restricted, name, agentId));
            const error = createForbiddenError('knowledge-library', forbidden.join(', '), { agentId });
            error.message =
                `Requested knowledge libraries are not permitted for agent ${normalizeString(agentId) || '(unauthenticated)'}: ` +
                `${forbidden.join(', ')}. Allowed: ${accessible.join(', ') || '(none)'}.`;
            error.details = {
                ...error.details,
                forbiddenLibraries: forbidden,
                allowedLibraries: accessible
            };
            throw error;
        }
        return { targetLibraries: requested };
    }

    // 未指定 → 全部可访问库（排除受限未授权库）
    return {
        targetLibraries: available.filter((name) => !isLibraryRestrictedFor(restricted, name, agentId))
    };
}

module.exports = {
    DEFAULT_POLICY_PATH,
    loadKnowledgePolicy,
    resolveKnowledgeLibraryAccess
};
