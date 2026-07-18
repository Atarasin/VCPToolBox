const { createSchemaRegistry } = require('../infra/schemaRegistry');

function normalizeCapabilityString(value) {
    return typeof value === 'string' ? value.trim() : '';
}

function normalizeCapabilityStringArray(value) {
    if (Array.isArray(value)) {
        return value
            .map((item) => normalizeCapabilityString(item))
            .filter(Boolean);
    }
    if (typeof value === 'string') {
        return value
            .split(',')
            .map((item) => item.trim())
            .filter(Boolean);
    }
    return [];
}

function parseCapabilityBoolean(value, defaultValue = false) {
    if (value === undefined) {
        return defaultValue;
    }
    if (typeof value === 'boolean') {
        return value;
    }
    if (typeof value === 'string') {
        const normalizedValue = value.trim().toLowerCase();
        if (normalizedValue === 'true') {
            return true;
        }
        if (normalizedValue === 'false') {
            return false;
        }
    }
    return defaultValue;
}

function parseCapabilityJsonObject(value, fallbackValue = {}) {
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

function getToolTimeoutMs(plugin) {
    const timeoutMs = plugin?.communication?.timeout ?? plugin?.entryPoint?.timeout ?? 0;
    return Number.isFinite(timeoutMs) && timeoutMs >= 0 ? timeoutMs : 0;
}

function buildAgentAliases(agentId) {
    const aliases = new Set();
    const addAlias = (value) => {
        const normalizedValue = normalizeCapabilityString(value);
        if (!normalizedValue) {
            return;
        }
        aliases.add(normalizedValue);
        normalizedValue
            .split(/[./:\\]/)
            .map((segment) => segment.trim())
            .filter(Boolean)
            .forEach((segment) => aliases.add(segment));
    };

    addAlias(agentId);
    return aliases;
}

function collectConfiguredDiaries(agentId, ragConfig) {
    const agentAliases = buildAgentAliases(agentId);
    const configuredDiaries = new Set();

    for (const alias of agentAliases) {
        normalizeCapabilityStringArray(ragConfig.agentDiaryMap?.[alias])
            .forEach((diaryName) => configuredDiaries.add(diaryName));
    }
    normalizeCapabilityStringArray(ragConfig.agentDiaryMap?.['*'])
        .forEach((diaryName) => configuredDiaries.add(diaryName));
    normalizeCapabilityStringArray(ragConfig.defaultDiaries)
        .forEach((diaryName) => configuredDiaries.add(diaryName));

    return {
        agentAliases,
        configuredDiaries
    };
}

function resolveAllowedDiaries({ agentId, availableDiaries, ragConfig }) {
    const normalizedDiaries = normalizeCapabilityStringArray(availableDiaries);
    if (normalizedDiaries.length === 0) {
        return [];
    }
    if (ragConfig.allowCrossRoleAccess) {
        return normalizedDiaries;
    }

    const { agentAliases, configuredDiaries } = collectConfiguredDiaries(agentId, ragConfig);
    if (configuredDiaries.size > 0) {
        return normalizedDiaries.filter((diaryName) => configuredDiaries.has(diaryName));
    }

    const aliasMatchedDiaries = normalizedDiaries.filter((diaryName) => agentAliases.has(diaryName));
    if (ragConfig.hasExplicitPolicy) {
        return aliasMatchedDiaries;
    }

    return normalizedDiaries;
}

function createTargetDescriptor(diaryName) {
    return {
        id: diaryName,
        displayName: `${diaryName}日记本`,
        type: 'diary',
        allowed: true
    };
}

function getMemoryWriterInfo(diaryStorePort) {
    const dailyNotePlugin = diaryStorePort?.getWriter?.();
    if (dailyNotePlugin) {
        return {
            name: 'DailyNote',
            executionMode: 'tool'
        };
    }

    return null;
}

function createContextDescriptor(ragRetrieverPort) {
    const features = ragRetrieverPort?.capabilities?.() || {};
    return {
        features: {
            queryFromMessages: true,
            retrieval: Boolean(ragRetrieverPort?.available),
            timeAware: Boolean(features.parseTimeRanges),
            groupAware: Boolean(features.enhanceSemanticGroups),
            rerank: Boolean(features.rerank),
            tagMemo: Boolean(features.applyTagBoost),
            tokenBudget: true,
            minScore: true,
            truncation: true
        }
    };
}

function createMemoryDescriptor({ includeTargets, targets, ragRetrieverPort, diaryStorePort }) {
    const features = ragRetrieverPort?.capabilities?.() || {};
    return {
        targets: includeTargets ? targets : [],
        features: {
            timeAware: Boolean(features.parseTimeRanges),
            groupAware: Boolean(features.enhanceSemanticGroups),
            rerank: Boolean(features.rerank),
            tagMemo: Boolean(features.applyTagBoost),
            writeBack: Boolean(getMemoryWriterInfo(diaryStorePort))
        }
    };
}

function createToolDescriptor(plugin, toolInvokerPort, schemaRegistry) {
    return {
        name: plugin.name,
        displayName: plugin.displayName || plugin.name,
        pluginType: plugin.pluginType || (plugin.isDistributed ? 'distributed' : 'unknown'),
        distributed: Boolean(plugin.isDistributed),
        approvalRequired: Boolean(toolInvokerPort?.requiresApproval?.(plugin.name)),
        timeoutMs: getToolTimeoutMs(plugin),
        description: schemaRegistry.getToolDescription(plugin),
        inputSchema: schemaRegistry.getToolInputSchema(plugin),
        invocationCommands: schemaRegistry.getInvocationCommands(plugin)
    };
}

/**
 * CapabilityService 统一生成 capability/memory/context 描述。
 * adapter 只负责协议适配，不再直接拼装这些 payload。
 */
function createCapabilityService(deps = {}) {

    const schemaRegistry = deps.schemaRegistry || createSchemaRegistry();
    const serverName = deps.serverName || 'VCPToolBox';
    const bridgeVersion = deps.bridgeVersion || 'v1';
    const resolvedPackageJson = deps.packageJson || {};
    const authContextResolver = typeof deps.authContextResolver === 'function'
        ? deps.authContextResolver
        : null;
    const agentPolicyResolver = deps.agentPolicyResolver &&
        typeof deps.agentPolicyResolver.resolvePolicy === 'function'
        ? deps.agentPolicyResolver
        : null;
    const ragRetrieverPort = deps.ragRetrieverPort || deps.ports?.ragRetriever;
    const diaryStorePort = deps.diaryStorePort || deps.ports?.diaryStore;
    const toolInvokerPort = deps.toolInvokerPort || deps.ports?.toolInvoker;
    const ragConfig = deps.ragConfig || deps.ports?.configuration?.rag || {};

    return {
        async getMemoryTargets({ agentId, authContext }) {
            const availableDiaries = normalizeCapabilityStringArray(
                await Promise.resolve(ragRetrieverPort?.listDiaries?.() || [])
            );
            const resolvedAuthContext = authContextResolver
                ? authContextResolver({
                    authContext,
                    requestContext: {
                        agentId,
                        source: 'capability-service',
                        runtime: 'gateway'
                    },
                    adapter: 'gateway'
                })
                : { agentId };
            const allowedDiaries = agentPolicyResolver
                ? (await agentPolicyResolver.resolvePolicy({
                    authContext: resolvedAuthContext,
                    availableDiaries
                })).allowedDiaryNames
                : resolveAllowedDiaries({
                    agentId,
                    availableDiaries,
                    ragConfig
                });

            return allowedDiaries
                .slice()
                .sort((left, right) => left.localeCompare(right))
                .map((diaryName) => createTargetDescriptor(diaryName));
        },
        async getCapabilities({ agentId, includeMemoryTargets = true, authContext }) {
            const resolvedAuthContext = authContextResolver
                ? authContextResolver({
                    authContext,
                    requestContext: {
                        agentId,
                        source: 'capability-service',
                        runtime: 'gateway'
                    },
                    adapter: 'gateway'
                })
                : { agentId };
            const resolvedPolicy = agentPolicyResolver
                ? await agentPolicyResolver.resolvePolicy({
                    authContext: resolvedAuthContext
                })
                : null;
            const memoryTargets = includeMemoryTargets
                ? await this.getMemoryTargets({ agentId, authContext: resolvedAuthContext })
                : [];

            const tools = Array.from(toolInvokerPort?.listTools?.() || [])
                .filter((plugin) => isBridgeablePlugin(plugin))
                .filter((plugin) => !resolvedPolicy || resolvedPolicy.allowedToolNames.includes(plugin.name))
                .sort((left, right) => left.name.localeCompare(right.name))
                .map((plugin) => createToolDescriptor(plugin, toolInvokerPort, schemaRegistry));

            return {
                server: {
                    name: serverName,
                    version: resolvedPackageJson.version,
                    bridgeVersion
                },
                tools,
                memory: createMemoryDescriptor({
                    includeTargets: includeMemoryTargets,
                    targets: memoryTargets,
                    ragRetrieverPort,
                    diaryStorePort
                }),
                context: createContextDescriptor(ragRetrieverPort),
                jobs: {
                    supported: true,
                    states: ['accepted', 'running', 'waiting_approval', 'completed', 'failed', 'cancelled'],
                    actions: ['poll', 'cancel']
                },
                events: {
                    supported: true,
                    transports: ['sse'],
                    filters: ['jobId', 'agentId', 'sessionId']
                }
            };
        }
    };
}

module.exports = {
    createCapabilityService
};
