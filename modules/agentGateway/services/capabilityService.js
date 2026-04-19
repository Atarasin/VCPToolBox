const packageJson = require('../../../package.json');
const { createSchemaRegistry } = require('../infra/schemaRegistry');

let cachedKnowledgeBaseManager = null;
let cachedRagPlugin = null;

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

function getBridgeConfig(pluginManager) {
    return pluginManager?.openClawBridgeConfig ||
        pluginManager?.openClawBridge?.config ||
        pluginManager?.openClawBridge ||
        {};
}

function getRagConfig(pluginManager) {
    const bridgeConfig = getBridgeConfig(pluginManager);
    const ragConfig = parseCapabilityJsonObject(bridgeConfig.rag, bridgeConfig.rag || {});
    const configuredAgentDiaryMap = parseCapabilityJsonObject(ragConfig.agentDiaryMap, {});
    const envAgentDiaryMap = parseCapabilityJsonObject(process.env.OPENCLAW_RAG_AGENT_DIARY_MAP, {});
    const rawAllowCrossRoleAccess = ragConfig.allowCrossRoleAccess !== undefined
        ? ragConfig.allowCrossRoleAccess
        : process.env.OPENCLAW_RAG_ALLOW_CROSS_ROLE_ACCESS;
    const defaultDiaries = normalizeCapabilityStringArray(
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
        allowCrossRoleAccess: parseCapabilityBoolean(rawAllowCrossRoleAccess, false),
        hasExplicitPolicy: (
            Object.keys(agentDiaryMap).length > 0 ||
            defaultDiaries.length > 0 ||
            rawAllowCrossRoleAccess !== undefined
        )
    };
}

function getKnowledgeBaseManager(pluginManager) {
    if (pluginManager?.vectorDBManager) {
        return pluginManager.vectorDBManager;
    }
    if (pluginManager?.knowledgeBaseManager) {
        return pluginManager.knowledgeBaseManager;
    }
    if (pluginManager?.openClawBridge?.knowledgeBaseManager) {
        return pluginManager.openClawBridge.knowledgeBaseManager;
    }
    if (!cachedKnowledgeBaseManager) {
        cachedKnowledgeBaseManager = require('../../../KnowledgeBaseManager');
    }
    return cachedKnowledgeBaseManager;
}

function getRagPlugin(pluginManager) {
    const pluginManagerRagPlugin = pluginManager?.messagePreprocessors?.get?.('RAGDiaryPlugin');
    if (pluginManagerRagPlugin) {
        return pluginManagerRagPlugin;
    }
    if (pluginManager?.openClawBridge?.ragPlugin) {
        return pluginManager.openClawBridge.ragPlugin;
    }
    if (!cachedRagPlugin) {
        try {
            cachedRagPlugin = require('../../../Plugin/RAGDiaryPlugin/RAGDiaryPlugin');
        } catch (error) {
            cachedRagPlugin = null;
        }
    }
    return cachedRagPlugin;
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

function buildAgentAliases(agentId, maid) {
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
    addAlias(maid);
    return aliases;
}

function collectConfiguredDiaries(agentId, maid, ragConfig) {
    const agentAliases = buildAgentAliases(agentId, maid);
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

function resolveAllowedDiaries({ agentId, maid, availableDiaries, ragConfig }) {
    const normalizedDiaries = normalizeCapabilityStringArray(availableDiaries);
    if (normalizedDiaries.length === 0) {
        return [];
    }
    if (ragConfig.allowCrossRoleAccess) {
        return normalizedDiaries;
    }

    const { agentAliases, configuredDiaries } = collectConfiguredDiaries(agentId, maid, ragConfig);
    if (configuredDiaries.size > 0) {
        return normalizedDiaries.filter((diaryName) => configuredDiaries.has(diaryName));
    }

    const aliasMatchedDiaries = normalizedDiaries.filter((diaryName) => agentAliases.has(diaryName));
    if (ragConfig.hasExplicitPolicy) {
        return aliasMatchedDiaries;
    }

    return normalizedDiaries;
}

async function listDiaryTargets(knowledgeBaseManager) {
    if (typeof knowledgeBaseManager?.listDiaryNames === 'function') {
        const diaryNames = await Promise.resolve(knowledgeBaseManager.listDiaryNames());
        return normalizeCapabilityStringArray(diaryNames);
    }
    if (!knowledgeBaseManager?.db?.prepare) {
        return [];
    }

    const rows = knowledgeBaseManager.db
        .prepare('SELECT DISTINCT diary_name FROM files ORDER BY diary_name COLLATE NOCASE')
        .all();

    return rows
        .map((row) => normalizeCapabilityString(row.diary_name))
        .filter(Boolean);
}

function createTargetDescriptor(diaryName) {
    return {
        id: diaryName,
        displayName: `${diaryName}日记本`,
        type: 'diary',
        allowed: true
    };
}

function getMemoryWriterInfo(pluginManager) {
    const resolvePlugin = (pluginName) =>
        pluginManager?.getPlugin?.(pluginName) || pluginManager?.plugins?.get?.(pluginName) || null;

    const dailyNotePlugin = resolvePlugin('DailyNote');
    if (dailyNotePlugin) {
        return {
            name: 'DailyNote',
            executionMode: 'tool'
        };
    }

    return null;
}

function createContextDescriptor({ ragPlugin, knowledgeBaseManager }) {
    return {
        features: {
            queryFromMessages: true,
            retrieval: Boolean(knowledgeBaseManager?.search),
            timeAware: Boolean(ragPlugin?.timeParser?.parse),
            groupAware: Boolean(ragPlugin?.semanticGroups?.getEnhancedVector),
            rerank: Boolean(ragPlugin?._rerankDocuments),
            tagMemo: Boolean(knowledgeBaseManager?.applyTagBoost),
            tokenBudget: true,
            minScore: true,
            truncation: true
        }
    };
}

function createMemoryDescriptor({ includeTargets, targets, ragPlugin, knowledgeBaseManager, pluginManager }) {
    return {
        targets: includeTargets ? targets : [],
        features: {
            timeAware: Boolean(ragPlugin?.timeParser?.parse),
            groupAware: Boolean(ragPlugin?.semanticGroups?.getEnhancedVector),
            rerank: Boolean(ragPlugin?._rerankDocuments),
            tagMemo: Boolean(knowledgeBaseManager?.applyTagBoost),
            writeBack: Boolean(getMemoryWriterInfo(pluginManager))
        }
    };
}

function createToolDescriptor(plugin, pluginManager, schemaRegistry) {
    return {
        name: plugin.name,
        displayName: plugin.displayName || plugin.name,
        pluginType: plugin.pluginType || (plugin.isDistributed ? 'distributed' : 'unknown'),
        distributed: Boolean(plugin.isDistributed),
        approvalRequired: Boolean(pluginManager?.toolApprovalManager?.shouldApprove?.(plugin.name)),
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
    const pluginManager = deps.pluginManager;
    if (!pluginManager) {
        throw new Error('[CapabilityService] pluginManager is required');
    }

    const schemaRegistry = deps.schemaRegistry || createSchemaRegistry();
    const serverName = deps.serverName || 'VCPToolBox';
    const bridgeVersion = deps.bridgeVersion || 'v1';
    const resolvedPackageJson = deps.packageJson || packageJson;
    const authContextResolver = typeof deps.authContextResolver === 'function'
        ? deps.authContextResolver
        : null;
    const agentPolicyResolver = deps.agentPolicyResolver &&
        typeof deps.agentPolicyResolver.resolvePolicy === 'function'
        ? deps.agentPolicyResolver
        : null;

    return {
        async getMemoryTargets({ agentId, maid, authContext }) {
            const knowledgeBaseManager = getKnowledgeBaseManager(pluginManager);
            const availableDiaries = await listDiaryTargets(knowledgeBaseManager);
            const resolvedAuthContext = authContextResolver
                ? authContextResolver({
                    authContext,
                    requestContext: {
                        agentId,
                        source: 'capability-service',
                        runtime: 'gateway'
                    },
                    maid,
                    adapter: 'gateway'
                })
                : { agentId, maid };
            const allowedDiaries = agentPolicyResolver
                ? (await agentPolicyResolver.resolvePolicy({
                    authContext: resolvedAuthContext,
                    availableDiaries
                })).allowedDiaryNames
                : resolveAllowedDiaries({
                    agentId,
                    maid,
                    availableDiaries,
                    ragConfig: getRagConfig(pluginManager)
                });

            return allowedDiaries
                .slice()
                .sort((left, right) => left.localeCompare(right))
                .map((diaryName) => createTargetDescriptor(diaryName));
        },
        async getCapabilities({ agentId, maid, includeMemoryTargets = true, authContext }) {
            const ragPlugin = getRagPlugin(pluginManager);
            const knowledgeBaseManager = getKnowledgeBaseManager(pluginManager);
            const resolvedAuthContext = authContextResolver
                ? authContextResolver({
                    authContext,
                    requestContext: {
                        agentId,
                        source: 'capability-service',
                        runtime: 'gateway'
                    },
                    maid,
                    adapter: 'gateway'
                })
                : { agentId, maid };
            const resolvedPolicy = agentPolicyResolver
                ? await agentPolicyResolver.resolvePolicy({
                    authContext: resolvedAuthContext
                })
                : null;
            const memoryTargets = includeMemoryTargets
                ? await this.getMemoryTargets({ agentId, maid, authContext: resolvedAuthContext })
                : [];

            const tools = Array.from(pluginManager.plugins.values())
                .filter((plugin) => isBridgeablePlugin(plugin))
                .filter((plugin) => !resolvedPolicy || resolvedPolicy.allowedToolNames.includes(plugin.name))
                .sort((left, right) => left.name.localeCompare(right.name))
                .map((plugin) => createToolDescriptor(plugin, pluginManager, schemaRegistry));

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
                    ragPlugin,
                    knowledgeBaseManager,
                    pluginManager
                }),
                context: createContextDescriptor({
                    ragPlugin,
                    knowledgeBaseManager
                }),
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
