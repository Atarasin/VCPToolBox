'use strict';

const { AGENT_GATEWAY_ROUTE_BINDINGS } = require('../routeBindings');

/**
 * 网关托管 MCP 工具的 REST 执行注册表（2026-10-11 双面接线收敛，方向 2）。
 *
 * 背景：同一工具要在两面各接一次线（in-process 直调 service；backend-proxy 经
 * GatewayBackendClient → REST），历史上分处 4 个文件（inProcessOperations /
 * backendProxyExecutor / GatewayBackendClient / routeBindings）+ 3 份契约
 * （restOperations / protocolGovernance 白名单 / OpenAPI 产物），三次事故均为
 * 「改了一面忘另一面」（forge 族 -32000、proxy listTools 漏过滤、
 * knowledge.search 整条 REST 链缺失——最后一项至今仍是生产缺口）。
 *
 * 本注册表是每个工具 REST 面的**单点元数据**：method / routeBindings 键 /
 * 路径参数 / GatewayBackendClient 方法名 / 标准 proxy 前置参数校验。
 * - GatewayBackendClient 据此生成 signature='body' 的转发方法；
 * - backendProxyExecutor 据此生成标准 handler（ensureAgentId + buildBody + 调用），
 *   diary 策略门等特殊语义仍保留 bespoke handler；
 * - mcp-shared-core 完整性测试据此对齐：双面 handler 覆盖、实例化路径 ∈
 *   治理白名单 ∧ restOperations 路径集、clientMethod 真实存在。
 *
 * 新增工具的接线 = mcpOperations 契约 + 本表 1 条 + REST 路由实现
 * （in-process 直调实现仍在 inProcessOperations）。
 */

// signature:
//   'body'         — client 方法 (body, requestOptions)，可由注册表生成
//   'pathParamBody'— client 方法 (pathValue, body, requestOptions)，手写
//   'pathParamQuery'— client 方法 (pathValue, query, requestOptions)，手写
// proxy: 'standard' — 由注册表生成标准 handler；'bespoke' — backendProxyExecutor 内保留专门实现
const TOOL_REST_REGISTRY = Object.freeze({
    render: {
        method: 'POST', signature: 'pathParamBody', proxy: 'bespoke',
        binding: 'agentRender', pathParam: 'agentId', clientMethod: 'renderAgent'
    },
    jobGet: {
        method: 'GET', signature: 'pathParamQuery', proxy: 'bespoke',
        binding: 'jobGet', pathParam: 'jobId', clientMethod: 'getJob'
    },
    jobCancel: {
        method: 'POST', signature: 'pathParamBody', proxy: 'bespoke',
        binding: 'jobCancel', pathParam: 'jobId', clientMethod: 'cancelJob'
    },
    memorySearch: {
        method: 'POST', signature: 'body', proxy: 'bespoke', // diary 策略门
        binding: 'memorySearch', clientMethod: 'searchMemory'
    },
    contextAssemble: {
        method: 'POST', signature: 'body', proxy: 'bespoke', // diary 策略门
        binding: 'contextAssemble', clientMethod: 'assembleContext'
    },
    memoryWrite: {
        method: 'POST', signature: 'body', proxy: 'bespoke', // diary 规范化 + 幂等键归一
        binding: 'memoryWrite', clientMethod: 'writeMemory'
    },
    recallRun: {
        method: 'POST', signature: 'body', proxy: 'bespoke', // query 前置校验
        binding: 'recallRun', clientMethod: 'runRecall', requireArgs: ['query']
    },
    knowledgeSearch: {
        method: 'POST', signature: 'body', proxy: 'standard',
        binding: 'knowledgeSearch', clientMethod: 'searchKnowledge'
    },
    gapReport: {
        method: 'POST', signature: 'body', proxy: 'standard',
        binding: 'gapReport', clientMethod: 'gapReport'
    },
    forgeCreate: {
        method: 'POST', signature: 'body', proxy: 'standard',
        binding: 'forgeCreate', clientMethod: 'forgeCreate'
    },
    forgeLearn: {
        method: 'POST', signature: 'body', proxy: 'standard',
        binding: 'forgeLearn', clientMethod: 'forgeLearn'
    },
    forgeRetrial: {
        method: 'POST', signature: 'body', proxy: 'standard',
        binding: 'forgeRetrial', clientMethod: 'forgeRetrial'
    },
    forgeRegrade: {
        method: 'POST', signature: 'body', proxy: 'standard',
        binding: 'forgeRegrade', clientMethod: 'forgeRegrade'
    },
    forgeConfirm: {
        method: 'POST', signature: 'pathParamBody', proxy: 'standard',
        binding: 'forgeConfirm', pathParam: 'jobId', clientMethod: 'forgeConfirm',
        requireArgs: ['jobId']
    }
});

// 实例化为**模板路径**（与治理白名单/restOperations 的 {param} 形式同口径）。
// 占位段 'param-placeholder' 经 encodeURIComponent 不变（字母+连字符），
// 随后还原为 {pathParam} 模板段。
const PATH_PLACEHOLDER = 'param-placeholder';
function registryPathFor(entry) {
    const route = AGENT_GATEWAY_ROUTE_BINDINGS[entry.binding];
    const resolved = typeof route === 'function' ? route(PATH_PLACEHOLDER) : route;
    if (!entry.pathParam) {
        return resolved;
    }
    return resolved
        .split('/')
        .map((segment) => (segment === PATH_PLACEHOLDER ? `{${entry.pathParam}}` : segment))
        .join('/');
}

module.exports = {
    TOOL_REST_REGISTRY,
    registryPathFor
};
