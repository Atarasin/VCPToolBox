const {
    buildAgentAliases
} = require('./authContextResolver');
const {
    normalizeDiaryCanonicalName,
    resolveConfiguredAgentMemoryPolicy,
    resolveDiaryAliasesToAvailable
} = require('./mcpAgentMemoryPolicy');

function normalizePolicyString(value) {
    return typeof value === 'string' ? value.trim() : '';
}

function normalizePolicyStringArray(value) {
    if (Array.isArray(value)) {
        return value.map((item) => normalizePolicyString(item)).filter(Boolean);
    }
    if (typeof value === 'string') {
        return value.split(',').map((item) => item.trim()).filter(Boolean);
    }
    return [];
}

function isBridgeablePlugin(plugin) {
    if (!plugin || typeof plugin !== 'object') {
        return false;
    }
    if (plugin.isDistributed) {
        return true;
    }
    if (plugin.pluginType === 'hybridservice' && plugin.communication?.protocol === 'direct') {
        return true;
    }
    return (
        (plugin.pluginType === 'synchronous' || plugin.pluginType === 'asynchronous') &&
        plugin.communication?.protocol === 'stdio'
    );
}

function resolveAliasValue(policyMap, agentAliases, fieldName) {
    for (const alias of agentAliases) {
        const match = policyMap?.[alias];
        if (match && match[fieldName] !== undefined) {
            return match[fieldName];
        }
    }
    const wildcardMatch = policyMap?.['*'];
    return wildcardMatch ? wildcardMatch[fieldName] : undefined;
}

function collectConfiguredDiaries(agentAliases, ragConfig) {
    const configuredDiaries = new Set();
    agentAliases.forEach((alias) => {
        normalizePolicyStringArray(ragConfig.agentDiaryMap?.[alias])
            .forEach((diaryName) => configuredDiaries.add(diaryName));
    });
    normalizePolicyStringArray(ragConfig.agentDiaryMap?.['*'])
        .forEach((diaryName) => configuredDiaries.add(diaryName));
    normalizePolicyStringArray(ragConfig.defaultDiaries)
        .forEach((diaryName) => configuredDiaries.add(diaryName));
    return Array.from(configuredDiaries);
}

function filterAvailableDiaries(availableDiaries, allowedDiaryNames) {
    const normalizedAvailableDiaries = normalizePolicyStringArray(availableDiaries);
    if (allowedDiaryNames.length === 0) {
        return normalizedAvailableDiaries;
    }

    // Diary policy defines what an agent may access, even before a diary has
    // been materialized on disk. Prefer the backend-exposed canonical target
    // when available, otherwise fall back to the canonical storage name.
    const resolvedDiaries = resolveDiaryAliasesToAvailable(allowedDiaryNames, normalizedAvailableDiaries);
    return resolvedDiaries
        .map((diaryName) => normalizeDiaryCanonicalName(diaryName))
        .filter(Boolean)
        .filter((diaryName, index, array) => array.indexOf(diaryName) === index);
}

function resolveDiaryScopes({ authContext, availableDiaries, ragConfig, policyConfig }) {
    const agentAliases = buildAgentAliases(authContext.agentId);
    const configuredMemoryPolicy = resolveConfiguredAgentMemoryPolicy({
        agentId: authContext.agentId
    });
    const explicitDiaryScopes = normalizePolicyStringArray(
        resolveAliasValue(policyConfig.agentPolicyMap, agentAliases, 'diaryScopes') ||
        resolveAliasValue(policyConfig.agentPolicyMap, agentAliases, 'memoryTargets')
    );

    if (configuredMemoryPolicy.allowedDiaryNames.length > 0) {
        const defaultDiaryNames = configuredMemoryPolicy.defaultDiaryNames.length > 0
            ? configuredMemoryPolicy.defaultDiaryNames
            : configuredMemoryPolicy.allowedDiaryNames;
        return {
            allowedDiaryNames: filterAvailableDiaries(availableDiaries, configuredMemoryPolicy.allowedDiaryNames),
            defaultDiaryNames: filterAvailableDiaries(availableDiaries, defaultDiaryNames),
            policySource: 'mcp_agent_memory_policy'
        };
    }

    if (explicitDiaryScopes.length > 0) {
        const filtered = filterAvailableDiaries(availableDiaries, explicitDiaryScopes);
        return {
            allowedDiaryNames: filtered,
            defaultDiaryNames: filtered,
            policySource: 'agent_policy_map'
        };
    }
    if (ragConfig.allowCrossRoleAccess) {
        const unrestricted = normalizePolicyStringArray(availableDiaries);
        return {
            allowedDiaryNames: unrestricted,
            defaultDiaryNames: unrestricted,
            policySource: 'rag_allow_cross_role'
        };
    }

    const configuredDiaries = collectConfiguredDiaries(agentAliases, ragConfig);
    if (configuredDiaries.length > 0) {
        const filtered = filterAvailableDiaries(availableDiaries, configuredDiaries);
        return {
            allowedDiaryNames: filtered,
            defaultDiaryNames: filtered,
            policySource: 'rag_config'
        };
    }

    const normalizedAvailableDiaries = normalizePolicyStringArray(availableDiaries);
    if (normalizedAvailableDiaries.length === 0) {
        return {
            allowedDiaryNames: [],
            defaultDiaryNames: [],
            policySource: 'none'
        };
    }
    if (ragConfig.hasExplicitPolicy) {
        const filtered = normalizedAvailableDiaries.filter((diaryName) => agentAliases.includes(diaryName));
        return {
            allowedDiaryNames: filtered,
            defaultDiaryNames: filtered,
            policySource: 'rag_alias_fallback'
        };
    }
    return {
        allowedDiaryNames: [],
        defaultDiaryNames: [],
        policySource: 'restricted'
    };
}

function resolveToolScopes({ authContext, policyConfig, toolInvokerPort }) {
    const agentAliases = buildAgentAliases(authContext.agentId);
    const explicitToolScopes = normalizePolicyStringArray(
        resolveAliasValue(policyConfig.agentPolicyMap, agentAliases, 'toolScopes')
    );
    if (explicitToolScopes.length > 0) {
        return {
            allowedToolNames: explicitToolScopes,
            allowAllTools: false
        };
    }

    const defaultToolScopes = normalizePolicyStringArray(policyConfig.defaultToolScopes);
    if (defaultToolScopes.length > 0) {
        return {
            allowedToolNames: defaultToolScopes,
            allowAllTools: false
        };
    }

    return {
        allowedToolNames: Array.from(toolInvokerPort?.listTools?.() || [])
            .filter((plugin) => isBridgeablePlugin(plugin))
            .map((plugin) => plugin.name)
            .sort((left, right) => left.localeCompare(right)),
        allowAllTools: true
    };
}

function createAgentPolicyResolver(deps = {}) {
    const ragConfig = deps.ragConfig || deps.ports?.configuration?.rag || {};
    const policyConfig = deps.policyConfig || deps.ports?.configuration?.policy || {};
    const toolInvokerPort = deps.toolInvokerPort || deps.ports?.toolInvoker;

    return {
        async resolvePolicy({ authContext, availableDiaries }) {
            const resolvedAuthContext = authContext || {};
            const diaryScopeResult = resolveDiaryScopes({
                authContext: resolvedAuthContext,
                availableDiaries,
                ragConfig,
                policyConfig
            });
            const toolScopeResult = resolveToolScopes({
                authContext: resolvedAuthContext,
                policyConfig,
                toolInvokerPort
            });

            return {
                authContext: resolvedAuthContext,
                allowedDiaryNames: diaryScopeResult.allowedDiaryNames,
                defaultDiaryNames: diaryScopeResult.defaultDiaryNames,
                allowedToolNames: toolScopeResult.allowedToolNames,
                toolScopes: toolScopeResult.allowedToolNames,
                allowAllTools: toolScopeResult.allowAllTools,
                diaryScopes: diaryScopeResult.allowedDiaryNames,
                diaryDefaultScopes: diaryScopeResult.defaultDiaryNames,
                policySource: diaryScopeResult.policySource,
                resolvedAt: new Date().toISOString()
            };
        }
    };
}

module.exports = {
    createAgentPolicyResolver
};
