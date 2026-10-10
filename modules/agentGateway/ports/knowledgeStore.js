const { createUnavailablePort, freezeAvailablePort } = require('./portUtils');

const REQUIRED_METHODS = Object.freeze(['search', 'listLibraries']);

/**
 * M4.S1：冷知识库（TDB / TriviumDB）窄端口。
 * 仅暴露检索面——search（文本查询，内部完成嵌入）与 listLibraries（库清单）。
 * searchGraphFirst / queryTql 等原面不进网关端口（TQL 具备变更能力，不对外）。
 */
function createKnowledgeStorePort(bindings = {}) {
    if (bindings.enabled === false) return createUnavailablePort('knowledgeStore', bindings.reason);
    const missing = REQUIRED_METHODS.filter((name) => typeof bindings[name] !== 'function');
    if (missing.length > 0) {
        if (bindings.optional === true) return createUnavailablePort('knowledgeStore', `missing:${missing.join(',')}`);
        throw new Error(`[KnowledgeStorePort] missing required bindings: ${missing.join(', ')}`);
    }
    return freezeAvailablePort('knowledgeStore', {
        search: bindings.search,
        listLibraries: bindings.listLibraries
    });
}

module.exports = { createKnowledgeStorePort, REQUIRED_METHODS };
