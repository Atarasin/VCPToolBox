const axios = require('axios');
const path = require('node:path');
const defaultAgentManager = require('../../agentManager');
const {
    createAgentDirectoryPort,
    createDiaryStorePort,
    createLlmCompletionPort,
    createRagRetrieverPort,
    createToolInvokerPort
} = require('../ports');
const { normalizeStringArray, parseBoolean, parseJsonObject } = require('../policy/shared/normalize');
const { getProtocolGovernanceConfig } = require('../contracts/protocolGovernance');
const { createHostPromptRenderer } = require('./agentPromptRenderer');

function normalizeString(value) {
    return typeof value === 'string' ? value.trim() : '';
}

function createRagConfigSnapshot(pluginManager) {
    const bridge = pluginManager?.openClawBridgeConfig || pluginManager?.openClawBridge?.config ||
        pluginManager?.openClawBridge || {};
    const rag = parseJsonObject(bridge.rag, bridge.rag || {});
    const configuredMap = parseJsonObject(rag.agentDiaryMap, {});
    const envMap = parseJsonObject(process.env.OPENCLAW_RAG_AGENT_DIARY_MAP, {});
    const rawCrossRole = rag.allowCrossRoleAccess !== undefined
        ? rag.allowCrossRoleAccess
        : process.env.OPENCLAW_RAG_ALLOW_CROSS_ROLE_ACCESS;
    const defaultDiaries = normalizeStringArray(rag.defaultDiaries !== undefined
        ? rag.defaultDiaries
        : process.env.OPENCLAW_RAG_DEFAULT_DIARIES);
    const agentDiaryMap = Object.keys(configuredMap).length > 0 ? configuredMap : envMap;
    return Object.freeze({
        agentDiaryMap: Object.freeze({ ...agentDiaryMap }),
        defaultDiaries: Object.freeze([...defaultDiaries]),
        allowCrossRoleAccess: parseBoolean(rawCrossRole, false),
        hasExplicitPolicy: Object.keys(agentDiaryMap).length > 0 || defaultDiaries.length > 0 || rawCrossRole !== undefined
    });
}

function createPolicyConfigSnapshot(pluginManager) {
    const bridge = pluginManager?.openClawBridgeConfig || pluginManager?.openClawBridge?.config ||
        pluginManager?.openClawBridge || {};
    const policy = parseJsonObject(pluginManager?.agentGatewayPolicyConfig || bridge.policy,
        pluginManager?.agentGatewayPolicyConfig || bridge.policy || {});
    return Object.freeze({
        ...policy,
        agentPolicyMap: Object.freeze({ ...(policy.agentPolicyMap || {}) }),
        defaultToolScopes: Object.freeze([...normalizeStringArray(policy.defaultToolScopes)])
    });
}

function createOperabilityConfigSnapshot(pluginManager) {
    const config = pluginManager?.agentGatewayOperationalConfig ||
        pluginManager?.agentGatewayOperabilityConfig ||
        pluginManager?.openClawBridgeConfig?.agentGateway?.operability || {};
    return Object.freeze({
        ...config,
        defaults: Object.freeze({ ...(config.defaults || {}) }),
        operations: Object.freeze({ ...(config.operations || {}) })
    });
}

function createProtocolConfigSnapshot(pluginManager) {
    const config = pluginManager?.agentGatewayProtocolConfig ||
        pluginManager?.agentGatewayAuthConfig ||
        pluginManager?.openClawBridgeConfig?.agentGateway || {};
    return Object.freeze(getProtocolGovernanceConfig(config));
}

function createHealthSnapshot(pluginManager, knowledgeBaseManager) {
    return Object.freeze({
        pluginManagerReady: Boolean(pluginManager?.plugins && typeof pluginManager.getPlugin === 'function'),
        knowledgeBaseReady: Boolean(knowledgeBaseManager && typeof knowledgeBaseManager.listDiaryNames === 'function')
    });
}

function listDiariesFromHost(manager) {
    if (typeof manager?.listDiaryNames === 'function') return Promise.resolve(manager.listDiaryNames());
    if (!manager?.db?.prepare) return Promise.resolve([]);
    const rows = manager.db.prepare('SELECT DISTINCT diary_name FROM files ORDER BY diary_name COLLATE NOCASE').all();
    return Promise.resolve(rows.map((row) => normalizeString(row.diary_name)).filter(Boolean));
}

function getFileMetadataFromHost(manager, sourcePath) {
    if (!sourcePath) return Promise.resolve(null);
    if (typeof manager?.getOpenClawFileMetadata === 'function') {
        return Promise.resolve(manager.getOpenClawFileMetadata(sourcePath));
    }
    if (!manager?.db?.prepare) return Promise.resolve(null);
    const row = manager.db.prepare(`
        SELECT f.diary_name AS sourceDiary, f.path AS sourcePath, f.updated_at AS updatedAt,
            GROUP_CONCAT(t.name, '||') AS tags
        FROM files f
        LEFT JOIN file_tags ft ON ft.file_id = f.id
        LEFT JOIN tags t ON t.id = ft.tag_id
        WHERE f.path = ?
        GROUP BY f.id
    `).get(sourcePath);
    return Promise.resolve(row ? {
        sourceDiary: normalizeString(row.sourceDiary),
        sourcePath: normalizeString(row.sourcePath),
        updatedAt: row.updatedAt,
        tags: row.tags ? row.tags.split('||').filter(Boolean) : []
    } : null);
}

function createEmbeddingBinding(knowledgeBaseManager, ragPlugin, embeddingUtils) {
    if (typeof ragPlugin?.getSingleEmbeddingCached === 'function') {
        return (text) => ragPlugin.getSingleEmbeddingCached(text);
    }
    if (typeof embeddingUtils?.getEmbeddingsBatch !== 'function') return null;
    return async (text) => {
        const [vector] = await embeddingUtils.getEmbeddingsBatch([text], {
            apiKey: knowledgeBaseManager?.config?.apiKey,
            apiUrl: knowledgeBaseManager?.config?.apiUrl,
            model: knowledgeBaseManager?.config?.model
        });
        return vector || null;
    };
}

function createRagBindings(knowledgeBaseManager, ragPlugin, embeddingUtils) {
    if (!knowledgeBaseManager && !ragPlugin) return { enabled: false, reason: 'rag_unavailable' };
    return {
        embedQuery: createEmbeddingBinding(knowledgeBaseManager, ragPlugin, embeddingUtils),
        listDiaries: () => listDiariesFromHost(knowledgeBaseManager),
        // The host search API requires the historical 1.33 fusion coefficient.
        searchDiary: typeof knowledgeBaseManager?.search === 'function'
            ? (diary, vector, options = {}) => knowledgeBaseManager.search(
                diary, vector, options.k, options.tagBoost || 0, options.coreTags || [], 1.33,
                options.geodesicRerank ? { geodesicRerank: true } : null
            )
            : null,
        enhanceSemanticGroups: ragPlugin?.semanticGroups?.detectAndActivateGroups &&
            ragPlugin?.semanticGroups?.getEnhancedVector
            ? async (query, vector) => {
                const groups = ragPlugin.semanticGroups.detectAndActivateGroups(query);
                const enhanced = await ragPlugin.semanticGroups.getEnhancedVector(query, groups, vector);
                return { groups, vector: Array.isArray(enhanced) && enhanced.length ? enhanced : vector };
            }
            : null,
        applyTagBoost: typeof knowledgeBaseManager?.applyTagBoost === 'function'
            ? (vector, weight) => knowledgeBaseManager.applyTagBoost(new Float32Array(vector), weight)
            : null,
        parseTimeRanges: typeof ragPlugin?.timeParser?.parse === 'function'
            ? (query) => ragPlugin.timeParser.parse(query)
            : null,
        getTimeRangeFilePaths: typeof ragPlugin?._getTimeRangeFilePaths === 'function'
            ? (diary, range) => ragPlugin._getTimeRangeFilePaths(diary, range)
            : null,
        getChunksByFilePaths: typeof knowledgeBaseManager?.getChunksByFilePaths === 'function'
            ? (paths) => knowledgeBaseManager.getChunksByFilePaths(paths)
            : null,
        cosineSimilarity: typeof ragPlugin?.cosineSimilarity === 'function'
            ? (left, right) => ragPlugin.cosineSimilarity(left, right)
            : null,
        deduplicateResults: typeof knowledgeBaseManager?.deduplicateResults === 'function'
            ? (items, vector) => knowledgeBaseManager.deduplicateResults(items, vector)
            : null,
        rerank: typeof ragPlugin?._rerankDocuments === 'function'
            ? (query, items, k, options) => ragPlugin._rerankDocuments(query, items, k, options)
            : null,
        getFileMetadata: knowledgeBaseManager?.getOpenClawFileMetadata || knowledgeBaseManager?.db?.prepare
            ? (sourcePath) => getFileMetadataFromHost(knowledgeBaseManager, sourcePath)
            : null,
        getDiaryContent: typeof ragPlugin?.getDiaryContent === 'function'
            ? (diary) => ragPlugin.getDiaryContent(diary)
            : null,
        getConceptVectors: ragPlugin?.enhancedVectorCache ? (diaries) => {
            const cache = ragPlugin?.enhancedVectorCache;
            return diaries.flatMap((diary) => {
                const value = cache instanceof Map ? cache.get(diary) : cache[diary];
                if (Array.isArray(value)) return [value];
                if (value && Array.isArray(value.vector)) return [value.vector];
                return [];
            });
        } : null,
        processMessages: typeof ragPlugin?.processMessages === 'function'
            ? (...args) => ragPlugin.processMessages(...args)
            : null
    };
}

function createAgentDirectoryBindings(pluginManager, agentManager, ragRetrieverPort) {
    if (!agentManager) return {};
    return {
        async ensureLoaded() {
            if (agentManager.agentMap instanceof Map && agentManager.agentMap.size === 0) {
                await agentManager.loadMap?.();
            }
            if (typeof agentManager.getAllAgentFiles === 'function') await agentManager.getAllAgentFiles();
            else if (Array.isArray(agentManager.agentFiles) && !agentManager.agentFiles.length) {
                await agentManager.scanAgentFiles?.();
            }
        },
        listAgents: () => Array.from(agentManager.agentMap?.entries?.() || [])
            .map(([alias, sourceFile]) => ({ alias, sourceFile })),
        isAgent: (agentId) => Boolean(agentManager.isAgent?.(agentId)),
        getAgentPrompt: (agentId) => agentManager.getAgentPrompt(agentId),
        getAgentSourcePath: (agentId) => {
            const sourceFile = agentManager.agentMap?.get?.(agentId) || '';
            const agentDir = normalizeString(agentManager.agentDir) || path.join(__dirname, '..', '..', '..', 'Agent');
            return { sourceFile, absoluteSourcePath: path.join(agentDir, String(sourceFile).replace(/\//g, path.sep)) };
        },
        renderPrompt: createHostPromptRenderer(
            pluginManager,
            ragRetrieverPort,
            pluginManager.agentRegistryRenderPrompt
        )
    };
}

function bindVcpPorts(pluginManager, options = {}) {
    const knowledgeBaseManager = options.knowledgeBaseManager === undefined
        ? (pluginManager.vectorDBManager || pluginManager.knowledgeBaseManager ||
            pluginManager.openClawBridge?.knowledgeBaseManager || null)
        : options.knowledgeBaseManager;
    const ragPlugin = options.ragPlugin === undefined
        ? (pluginManager.messagePreprocessors?.get?.('RAGDiaryPlugin') ||
            pluginManager.openClawBridge?.ragPlugin || null)
        : options.ragPlugin;
    let embeddingUtils = options.embeddingUtils || null;
    if (!embeddingUtils && knowledgeBaseManager && !ragPlugin?.getSingleEmbeddingCached) {
        try { embeddingUtils = require('../../../EmbeddingUtils'); } catch (_error) { embeddingUtils = null; }
    }
    const ragRetriever = createRagRetrieverPort(createRagBindings(knowledgeBaseManager, ragPlugin, embeddingUtils));
    const agentManager = options.agentManager || pluginManager.agentManager || defaultAgentManager;
    const ports = {
        ragRetriever,
        diaryStore: createDiaryStorePort({
            invoke: typeof pluginManager.processToolCall === 'function'
                ? (...args) => pluginManager.processToolCall('DailyNote', ...args)
                : null,
            getWriter: () => {
                const plugin = pluginManager.getPlugin?.('DailyNote') || pluginManager.plugins?.get?.('DailyNote');
                return plugin ? { name: 'DailyNote', executionMode: 'tool' } : null;
            }
        }),
        toolInvoker: createToolInvokerPort({
            invoke: typeof pluginManager.processToolCall === 'function'
                ? (...args) => pluginManager.processToolCall(...args)
                : null,
            getTool: (name) => pluginManager.getPlugin?.(name) || pluginManager.plugins?.get?.(name) || null,
            requiresApproval: (name) => Boolean(pluginManager.toolApprovalManager?.shouldApprove?.(name)),
            listTools: () => Array.from(pluginManager.plugins?.values?.() || [])
        }),
        agentDirectory: createAgentDirectoryPort(
            createAgentDirectoryBindings(pluginManager, agentManager, ragRetriever)
        ),
        llmCompletion: createLlmCompletionPort({
            async complete(config, payload) {
                return axios.post(`${config.url}v1/chat/completions`, payload, {
                    headers: { Authorization: `Bearer ${config.apiKey}`, 'Content-Type': 'application/json' },
                    timeout: 60000
                });
            }
        }),
        configuration: Object.freeze({
            rag: createRagConfigSnapshot(pluginManager),
            policy: createPolicyConfigSnapshot(pluginManager),
            operability: createOperabilityConfigSnapshot(pluginManager),
            protocol: createProtocolConfigSnapshot(pluginManager),
            health: createHealthSnapshot(pluginManager, knowledgeBaseManager)
        })
    };
    return Object.freeze(ports);
}

function assertVcpHostReady(pluginManager) {
    if (!pluginManager?.plugins || !(pluginManager.plugins instanceof Map)) {
        throw new Error('[AgentGatewayBootstrap] plugin host is not ready: plugins are not loaded');
    }
    // 与 bindVcpPorts 的回退顺序保持一致：宿主未挂载时回退到 agentManager 单例
    if (!pluginManager.agentManager && !defaultAgentManager) {
        throw new Error('[AgentGatewayBootstrap] plugin host is not ready: agentManager is unavailable');
    }
}

function adaptLegacyGatewayDeps(deps = {}) {
    if (deps.ports) return deps;
    if (!deps.pluginManager) return deps;
    const legacyContext = deps.contextRuntimeService;
    const legacyManager = legacyContext?.getKnowledgeBaseManager?.(deps.pluginManager);
    const legacyKnowledgeBaseManager = legacyManager && typeof legacyManager.search !== 'function'
        ? Object.assign(Object.create(legacyManager), {
            search() {
                const error = new Error('Knowledge base search is unavailable in this legacy fixture');
                error.code = 'AGW_CAPABILITY_UNAVAILABLE';
                throw error;
            }
        })
        : legacyManager;
    const legacyBindings = legacyContext ? {
        knowledgeBaseManager: legacyKnowledgeBaseManager,
        ragPlugin: legacyContext.getRagPlugin?.(deps.pluginManager),
        ...(deps.portBindings || {})
    } : deps.portBindings;
    const ports = bindVcpPorts(deps.pluginManager, legacyBindings);
    return {
        ...deps,
        ports,
        ragRetrieverPort: deps.ragRetrieverPort || ports.ragRetriever,
        diaryStorePort: deps.diaryStorePort || ports.diaryStore,
        toolInvokerPort: deps.toolInvokerPort || ports.toolInvoker,
        agentDirectoryPort: deps.agentDirectoryPort || ports.agentDirectory,
        llmCompletionPort: deps.llmCompletionPort || ports.llmCompletion,
        ragConfig: deps.ragConfig || ports.configuration.rag,
        policyConfig: deps.policyConfig || ports.configuration.policy,
        operabilityConfig: deps.operabilityConfig || ports.configuration.operability,
        protocolConfig: deps.protocolConfig || ports.configuration.protocol
    };
}

module.exports = {
    adaptLegacyGatewayDeps,
    assertVcpHostReady,
    bindVcpPorts,
    createRagBindings,
    createRagConfigSnapshot,
    createPolicyConfigSnapshot,
    createOperabilityConfigSnapshot,
    createProtocolConfigSnapshot,
    createHealthSnapshot
};
