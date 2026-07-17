const axios = require('axios');
const {
    createAgentDirectoryPort,
    createDiaryStorePort,
    createLlmCompletionPort,
    createRagRetrieverPort,
    createToolInvokerPort
} = require('../ports');

function bindVcpPorts(pluginManager, options = {}) {
    const knowledgeBaseManager = options.knowledgeBaseManager || pluginManager.vectorDBManager ||
        pluginManager.knowledgeBaseManager || pluginManager.openClawBridge?.knowledgeBaseManager ||
        require('../../../KnowledgeBaseManager');
    let ragPlugin = options.ragPlugin || pluginManager.messagePreprocessors?.get?.('RAGDiaryPlugin') ||
        pluginManager.openClawBridge?.ragPlugin || null;
    if (!ragPlugin) {
        try { ragPlugin = require('../../../Plugin/RAGDiaryPlugin/RAGDiaryPlugin'); } catch (_error) { ragPlugin = null; }
    }
    const ports = {
        ragRetriever: createRagRetrieverPort({
            knowledgeBaseManager,
            ragPlugin,
            embeddingUtilsLoader: options.embeddingUtilsLoader || (() => require('../../../EmbeddingUtils'))
        }),
        diaryStore: createDiaryStorePort({
            invoke: typeof pluginManager.processToolCall === 'function'
                ? (...args) => pluginManager.processToolCall('DailyNote', ...args)
                : null,
            getWriter: () => pluginManager.getPlugin?.('DailyNote') || pluginManager.plugins?.get?.('DailyNote') || null
        }),
        toolInvoker: createToolInvokerPort({
            invoke: typeof pluginManager.processToolCall === 'function'
                ? (...args) => pluginManager.processToolCall(...args)
                : null,
            getTool: (name) => pluginManager.getPlugin?.(name) || pluginManager.plugins?.get?.(name) || null,
            requiresApproval: (name) => Boolean(pluginManager.toolApprovalManager?.shouldApprove?.(name))
        }),
        agentDirectory: createAgentDirectoryPort({
            agentManager: pluginManager.agentManager,
            renderPrompt: pluginManager.agentRegistryRenderPrompt
        }),
        llmCompletion: createLlmCompletionPort({
            async complete(config, payload) {
                return axios.post(`${config.url}v1/chat/completions`, payload, {
                    headers: { Authorization: `Bearer ${config.apiKey}`, 'Content-Type': 'application/json' },
                    timeout: 60000
                });
            }
        })
    };
    return Object.freeze(ports);
}

function assertVcpHostReady(pluginManager) {
    if (!pluginManager?.plugins || !(pluginManager.plugins instanceof Map)) {
        throw new Error('[AgentGatewayBootstrap] plugin host is not ready: plugins are not loaded');
    }
    if (!pluginManager.agentManager) {
        throw new Error('[AgentGatewayBootstrap] plugin host is not ready: agentManager is unavailable');
    }
}

module.exports = { assertVcpHostReady, bindVcpPorts };
