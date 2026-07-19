const { normalizeString } = require('./shared/normalize');

/**
 * agentGuidanceResolver 骨架（§4.1 / M0.S1.T4）。
 *
 * 经窄端口读取 agent directory 快照，与 guidance 配置合成只读 integration
 * snapshot。agent 目录只提供 alias/sourceFile 与存在性；displayName 来自
 * guidance 配置（§4.2），不来自目录。完整 guidance bundle（workflow、
 * memoryWritePolicy、diaries 注入、revision）在 M2.S1 实现。
 */
function createAgentGuidanceResolver({ listAgents, getGuidanceConfig } = {}) {
    if (typeof listAgents !== 'function') {
        throw new TypeError('createAgentGuidanceResolver requires a listAgents() port');
    }
    if (typeof getGuidanceConfig !== 'function') {
        throw new TypeError('createAgentGuidanceResolver requires a getGuidanceConfig() accessor');
    }

    function buildIntegrationSnapshot() {
        const directoryEntries = listAgents() || [];
        const directoryByAgentId = new Map();
        for (const entry of directoryEntries) {
            const alias = normalizeString(entry?.alias);
            if (alias) {
                directoryByAgentId.set(alias, entry);
            }
        }

        const guidanceConfig = getGuidanceConfig();
        const guidanceAgents = guidanceConfig?.agents || {};
        const unknownAgents = [];
        const agents = [];

        for (const [agentId, guidanceEntry] of Object.entries(guidanceAgents)) {
            const directoryEntry = directoryByAgentId.get(agentId);
            if (!directoryEntry) {
                unknownAgents.push(agentId);
                continue;
            }
            agents.push(Object.freeze({
                agentId,
                alias: normalizeString(directoryEntry.alias) || agentId,
                displayName: normalizeString(guidanceEntry.displayName) || agentId,
                guidanceRef: agentId,
                memoryPolicyRef: agentId,
                recallProfileRef: agentId
            }));
        }

        return Object.freeze({
            agents: Object.freeze(agents),
            unknownAgents: Object.freeze(unknownAgents)
        });
    }

    function resolveIntegrationEntry(agentId) {
        const normalizedAgentId = normalizeString(agentId);
        if (!normalizedAgentId) {
            return null;
        }
        const snapshot = buildIntegrationSnapshot();
        return snapshot.agents.find((entry) => entry.agentId === normalizedAgentId) || null;
    }

    return Object.freeze({
        buildIntegrationSnapshot,
        resolveIntegrationEntry
    });
}

module.exports = { createAgentGuidanceResolver };
