const { normalizeString, normalizeStringArray } = require('./shared/normalize');

/**
 * agentGuidanceResolver（§4.1、§4.2 / M0.S1.T4、M2.S1.T1）。
 *
 * 经窄端口读取 agent directory 快照，与 guidance 配置合成只读 integration
 * snapshot。agent 目录只提供 alias/sourceFile 与存在性；displayName 来自
 * guidance 配置（§4.2），不来自目录。
 *
 * `buildGuidanceBundle` 输出唯一的 guidance bundle：workflow/memoryWritePolicy
 * 来自 shared 段，allowed/defaultDiaries 由 memory policy 模块注入（调用方
 * 传入，guidance 配置不重新维护日记本路由），revision 与冻结 integration
 * snapshot 一致。initialize.instructions、guidance resource、bootstrap、
 * Native REST 与 skill generator 只消费该 bundle。
 */

/**
 * 从冻结 integration snapshot 组装单个 agent 的 guidance bundle（§4.2）。
 * 纯函数：不做 I/O；diaries 由 memory policy 注入。
 * @returns {object|null} snapshot 中不存在该 agent 时返回 null。
 */
function buildGuidanceBundle({ snapshot, agentId, allowedDiaries = [], defaultDiaries = [] } = {}) {
    const normalizedAgentId = normalizeString(agentId);
    if (!snapshot || !normalizedAgentId) {
        return null;
    }
    const agentEntry = snapshot.agents?.[normalizedAgentId];
    if (!agentEntry) {
        return null;
    }
    const shared = snapshot.shared || {};
    return Object.freeze({
        agentId: normalizedAgentId,
        displayName: agentEntry.displayName || normalizedAgentId,
        workflow: Object.freeze([...(shared.workflow || [])]),
        memoryWritePolicy: Object.freeze({
            write: Object.freeze([...(shared.memoryWritePolicy?.write || [])]),
            skip: Object.freeze([...(shared.memoryWritePolicy?.skip || [])])
        }),
        allowedDiaries: Object.freeze(normalizeStringArray(allowedDiaries)),
        defaultDiaries: Object.freeze(normalizeStringArray(defaultDiaries)),
        memoryDefaults: Object.freeze(structuredClone(agentEntry.memoryDefaults || {})),
        revision: snapshot.revision,
        updatedAt: snapshot.publishedAt
    });
}

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

module.exports = { buildGuidanceBundle, createAgentGuidanceResolver };
