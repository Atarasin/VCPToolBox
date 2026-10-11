const { createUnavailablePort, freezeAvailablePort } = require('./portUtils');

const REQUIRED_METHODS = Object.freeze(['search', 'listLibraries']);
// 可选能力：pendingIngestCount（未消化摄取项数）——试岗开考前做「索引就绪」
// 闸门用（2026-10-11 运维反馈：learn 完成 ≠ 知识可检索）。绑定方无此能力时
// 省略，调用方按「未知」处理。
const OPTIONAL_METHODS = Object.freeze(['pendingIngestCount']);

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
        throw new Error(`[KnowledgeStorePort] missing required bindings: ${missing.join(',')}`);
    }
    const optional = {};
    for (const name of OPTIONAL_METHODS) {
        if (typeof bindings[name] === 'function') {
            optional[name] = bindings[name];
        }
    }
    return freezeAvailablePort('knowledgeStore', {
        search: bindings.search,
        listLibraries: bindings.listLibraries,
        ...optional
    });
}

module.exports = { createKnowledgeStorePort, REQUIRED_METHODS, OPTIONAL_METHODS };
