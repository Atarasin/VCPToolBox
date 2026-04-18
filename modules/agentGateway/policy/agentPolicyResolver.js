const {
    buildAgentAliases
} = require('./authContextResolver');

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

function parsePolicyJsonObject(value, fallbackValue = {}) {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
        return value;
    }
    if (typeof value !== 'string' || !value.trim()) {
        return fallbackValue;
    }
    try {
        const parsedValue = JSON.parse(value);
        return parsedValue && typeof parsedValue === 'object' && !Array.isArray(parsedValue)
            ? parsedValue
            : fallbackValue;
    } catch (error) {
        return fallbackValue;
    }
}

function getBridgeConfig(pluginManager) {
    return pluginManager?.openClawBridgeConfig ||
        pluginManager?.openClawBridge?.config ||
        pluginManager?.openClawBridge ||
        {};
}

function getRagConfig(pluginManager) {
    const bridgeConfig = getBridgeConfig(pluginManager);
    const ragConfig = parsePolicyJsonObject(bridgeConfig.rag, bridgeConfig.rag || {});
    const configuredAgentDiaryMap = parsePolicyJsonObject(ragConfig.agentDiaryMap, {});
    const envAgentDiaryMap = parsePolicyJsonObject(process.env.OPENCLAW_RAG_AGENT_DIARY_MAP, {});
    const rawAllowCrossRoleAccess = ragConfig.allowCrossRoleAccess !== undefined
        ? ragConfig.allowCrossRoleAccess
        : process.env.OPENCLAW_RAG_ALLOW_CROSS_ROLE_ACCESS;
    const defaultDiaries = normalizePolicyStringArray(
        ragConfig.defaultDiaries !== undefined
            ? ragConfig.defaultDiaries
            : process.env.OPENCLAW_RAG_DEFAULT_DIARIES
    );
    const agentDiaryMap = Object.keys(configuredAgentDiaryMap).length > 0
        ? configuredAgentDiaryMap
        : envAgentDiaryMap;

    return {
        agentDiaryMap,
        defaultDiaries,
        allowCrossRoleAccess: rawAllowCrossRoleAccess === true || rawAllowCrossRoleAccess === 'true',
        hasExplicitPolicy: (
            Object.keys(agentDiaryMap).length > 0 ||
            defaultDiaries.length > 0 ||
            rawAllowCrossRoleAccess !== undefined
        )
    };
}

function getPolicyConfig(pluginManager) {
    const bridgeConfig = getBridgeConfig(pluginManager);
    return parsePolicyJsonObject(
        pluginManager?.agentGatewayPolicyConfig || bridgeConfig.policy,
        pluginManager?.agentGatewayPolicyConfig || bridgeConfig.policy || {}
    );
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

function resolveDiaryScopes({ authContext, availableDiaries, pluginManager }) {
    const ragConfig = getRagConfig(pluginManager);
    const policyConfig = getPolicyConfig(pluginManager);
    const agentAliases = buildAgentAliases(authContext.agentId, authContext.maid);
    const explicitDiaryScopes = normalizePolicyStringArray(
        resolveAliasValue(policyConfig.agentPolicyMap, agentAliases, 'diaryScopes') ||
        resolveAliasValue(policyConfig.agentPolicyMap, agentAliases, 'memoryTargets')
    );
    const normalizedAvailableDiaries = normalizePolicyStringArray(availableDiaries);

    if (explicitDiaryScopes.length > 0) {
        return normalizedAvailableDiaries.length > 0
            ? normalizedAvailableDiaries.filter((diaryName) => explicitDiaryScopes.includes(diaryName))
            : explicitDiaryScopes;
    }
    if (ragConfig.allowCrossRoleAccess) {
        return normalizedAvailableDiaries;
    }

    const configuredDiaries = collectConfiguredDiaries(agentAliases, ragConfig);
    if (configuredDiaries.length > 0) {
        return normalizedAvailableDiaries.length > 0
            ? normalizedAvailableDiaries.filter((diaryName) => configuredDiaries.includes(diaryName))
            : configuredDiaries;
    }

    if (normalizedAvailableDiaries.length === 0) {
        return [];
    }
    if (ragConfig.hasExplicitPolicy) {
        return normalizedAvailableDiaries.filter((diaryName) => agentAliases.includes(diaryName));
    }
    return normalizedAvailableDiaries;
}

function resolveToolScopes({ authContext, pluginManager }) {
    const policyConfig = getPolicyConfig(pluginManager);
    const agentAliases = buildAgentAliases(authContext.agentId, authContext.maid);
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
        allowedToolNames: Array.from(pluginManager?.plugins?.values?.() || [])
            .filter((plugin) => isBridgeablePlugin(plugin))
            .map((plugin) => plugin.name)
            .sort((left, right) => left.localeCompare(right)),
        allowAllTools: true
    };
}

function createAgentPolicyResolver(deps = {}) {
    const pluginManager = deps.pluginManager;
    if (!pluginManager) {
        throw new Error('[AgentPolicyResolver] pluginManager is required');
    }

    return {
        async resolvePolicy({ authContext, availableDiaries }) {
            const resolvedAuthContext = authContext || {};
            const allowedDiaryNames = resolveDiaryScopes({
                authContext: resolvedAuthContext,
                availableDiaries,
                pluginManager
            });
            const toolScopeResult = resolveToolScopes({
                authContext: resolvedAuthContext,
                pluginManager
            });

            return {
                authContext: resolvedAuthContext,
                allowedDiaryNames,
                allowedToolNames: toolScopeResult.allowedToolNames,
                toolScopes: toolScopeResult.allowedToolNames,
                allowAllTools: toolScopeResult.allowAllTools,
                diaryScopes: allowedDiaryNames,
                resolvedAt: new Date().toISOString()
            };
        }
    };
}

module.exports = {
    createAgentPolicyResolver,
    getPolicyConfig
};
