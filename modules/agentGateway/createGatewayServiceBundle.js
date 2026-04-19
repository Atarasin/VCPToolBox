const packageJson = require('../../package.json');
const {
    createSchemaRegistry
} = require('./infra/schemaRegistry');
const {
    createAuditLogger
} = require('./infra/auditLogger');
const {
    mapOpenClawMemoryWriteError,
    mapOpenClawToolExecutionError
} = require('./infra/errorMapper');
const {
    resolveAuthContext
} = require('./policy/authContextResolver');
const {
    createAgentPolicyResolver
} = require('./policy/agentPolicyResolver');
const {
    ensureToolAllowed
} = require('./policy/toolScopeGuard');
const {
    ensureDiaryAllowed
} = require('./policy/diaryScopeGuard');
const {
    createCapabilityService
} = require('./services/capabilityService');
const {
    createAgentRegistryService
} = require('./services/agentRegistryService');
const {
    createJobRuntimeService
} = require('./services/jobRuntimeService');
const {
    JOB_STATUS
} = require('./services/jobRuntimeService');
const {
    createMemoryRuntimeService
} = require('./services/memoryRuntimeService');
const {
    createContextRuntimeService
} = require('./services/contextRuntimeService');
const {
    createToolRuntimeService
} = require('./services/toolRuntimeService');
const {
    createOperabilityService
} = require('./services/operabilityService');
const DEFAULT_GATEWAY_VERSION = 'v1';
const DEFAULT_AUDIT_PREFIX = '[AgentGatewayAudit]';
const DEFAULT_MEMORY_BRIDGE_TOOL_NAME = 'vcp_memory_write';

/**
 * 统一构建并缓存 Gateway Core 的共享 service bundle。
 * OpenClaw 与 Native adapter 都应通过这里获取同一组 service 实例。
 */
function getGatewayServiceBundle(pluginManager, options = {}) {
    if (!pluginManager) {
        throw new Error('[AgentGatewayServices] pluginManager is required');
    }

    if (pluginManager.__agentGatewayServiceBundle) {
        return pluginManager.__agentGatewayServiceBundle;
    }

    const schemaRegistry = createSchemaRegistry();
    const auditLogger = createAuditLogger({
        prefix: options.auditPrefix || DEFAULT_AUDIT_PREFIX
    });
    const agentPolicyResolver = createAgentPolicyResolver({
        pluginManager
    });
    const jobRuntimeService = createJobRuntimeService();
    const capabilityService = createCapabilityService({
        pluginManager,
        packageJson,
        bridgeVersion: options.gatewayVersion || DEFAULT_GATEWAY_VERSION,
        schemaRegistry,
        authContextResolver: resolveAuthContext,
        agentPolicyResolver
    });
    const memoryRuntimeService = createMemoryRuntimeService({
        pluginManager,
        auditLogger,
        mapMemoryWriteError: mapOpenClawMemoryWriteError,
        authContextResolver: resolveAuthContext,
        agentPolicyResolver,
        diaryScopeGuard: ensureDiaryAllowed
    });
    const contextRuntimeService = createContextRuntimeService({
        pluginManager,
        auditLogger,
        authContextResolver: resolveAuthContext,
        agentPolicyResolver,
        diaryScopeGuard: ensureDiaryAllowed
    });
    const toolRuntimeService = createToolRuntimeService({
        pluginManager,
        schemaRegistry,
        memoryRuntimeService,
        auditLogger,
        mapToolExecutionError: mapOpenClawToolExecutionError,
        memoryBridgeToolName: options.memoryBridgeToolName || DEFAULT_MEMORY_BRIDGE_TOOL_NAME,
        authContextResolver: resolveAuthContext,
        agentPolicyResolver,
        toolScopeGuard: ensureToolAllowed,
        jobRuntimeService
    });
    const operabilityService = createOperabilityService({
        pluginManager,
        auditLogger
    });
    const agentRegistryService = createAgentRegistryService({
        pluginManager,
        agentManager: pluginManager.agentManager,
        renderPrompt: pluginManager.agentRegistryRenderPrompt,
        schemaRegistry,
        authContextResolver: resolveAuthContext,
        agentPolicyResolver,
        capabilityService
    });

    pluginManager.__agentGatewayServiceBundle = {
        schemaRegistry,
        auditLogger,
        authContextResolver: resolveAuthContext,
        agentPolicyResolver,
        toolScopeGuard: ensureToolAllowed,
        diaryScopeGuard: ensureDiaryAllowed,
        capabilityService,
        agentRegistryService,
        jobRuntimeService,
        memoryRuntimeService,
        contextRuntimeService,
        toolRuntimeService,
        operabilityService,
        jobStatus: JOB_STATUS,
        gatewayVersion: options.gatewayVersion || DEFAULT_GATEWAY_VERSION,
        memoryBridgeToolName: options.memoryBridgeToolName || DEFAULT_MEMORY_BRIDGE_TOOL_NAME
    };

    return pluginManager.__agentGatewayServiceBundle;
}

module.exports = {
    DEFAULT_GATEWAY_VERSION,
    DEFAULT_MEMORY_BRIDGE_TOOL_NAME,
    getGatewayServiceBundle
};
