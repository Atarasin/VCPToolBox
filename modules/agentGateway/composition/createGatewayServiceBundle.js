const packageJson = require('./packageMetadata');
const {
    createSchemaRegistry
} = require('../infra/schemaRegistry');
const {
    createAuditLogger,
    createConsoleAuditSink,
    createFileAuditSink
} = require('../infra/auditLogger');
const {
    mapOpenClawMemoryWriteError,
    mapOpenClawToolExecutionError
} = require('../infra/errorMapper');
const {
    resolveAuthContext
} = require('../policy/authContextResolver');
const {
    createAgentPolicyResolver
} = require('../policy/agentPolicyResolver');
const {
    ensureToolAllowed
} = require('../policy/toolScopeGuard');
const {
    ensureDiaryAllowed
} = require('../policy/diaryScopeGuard');
const {
    createCapabilityService
} = require('../services/capabilityService');
const {
    createAgentRegistryService
} = require('../services/agentRegistryService');
const {
    createJobRuntimeService
} = require('../services/jobRuntimeService');
const {
    JOB_STATUS
} = require('../services/jobRuntimeService');
const {
    createMemoryRuntimeService
} = require('../services/memoryRuntimeService');
const {
    createContextRuntimeService
} = require('../services/contextRuntimeService');
const {
    createToolRuntimeService
} = require('../services/toolRuntimeService');
const {
    createOperabilityService
} = require('../services/operabilityService');
const {
    RecallProfileResolver
} = require('../policy/recallProfileResolver');
const {
    createRecallRuntimeService
} = require('../services/recallRuntimeService');
const {
    createRecallProjectionService
} = require('../services/recallProjectionService');
const {
    createAgentGuidanceService
} = require('../services/agentGuidanceService');
const { createSkillDownloadSigningService } = require('../services/skillDownloadSigningService');
const { createDownloadNonceStore } = require('../policy/downloadNonceStore');
const { bindVcpPorts } = require('./vcpPortBindings');
const { createIntegrationSnapshotCoordinator } = require('./integrationSnapshotCoordinator');
const { DEFAULT_GUIDANCE_CONFIG_PATH } = require('../policy/agentGuidanceConfig');
const { resolveConfiguredAgentMemoryPolicy } = require('../policy/mcpAgentMemoryPolicy');
const { getProtocolGovernanceConfig } = require('../contracts/protocolGovernance');
const { createCredentialResolver } = require('../policy/credentialResolver');
const {
    createAuthMigrationMetrics,
    createBuiltinCredentialResolver,
    readMigrationSwitches
} = require('../policy/builtinCredentials');
const { createGatewayRequestContextBuilder } = require('../policy/gatewayRequestContext');
const {
    createAdminGatewaySessionStore,
    createInMemoryAdminSessionBackend
} = require('../policy/adminGatewaySessionStore');
const { parseBoolean: parseEnvBoolean } = require('../policy/shared/normalize');

const DEFAULT_GATEWAY_VERSION = 'v1';
const DEFAULT_AUDIT_PREFIX = '[AgentGatewayAudit]';
const DEFAULT_MEMORY_BRIDGE_TOOL_NAME = 'vcp_memory_write';

/**
 * 统一身份决议服务（M1）：文件 credential resolver + 内置 credential +
 * `buildGatewayRequestContext()`，供 Native routes 与 MCP transports 复用。
 */
function parseCookieHeader(headers = {}) {
    const header = typeof headers.cookie === 'string' ? headers.cookie : '';
    const cookies = {};
    for (const part of header.split(';')) {
        const [key, ...rest] = part.trim().split('=');
        if (key) cookies[key] = decodeURIComponent(rest.join('=') || '');
    }
    return cookies;
}

function resolveAdminSessionStoreForBundle(pluginManager) {
    const injectedBackend = pluginManager?.agentGatewayAdminSessionBackend || null;
    const allowDevStore = parseEnvBoolean(process.env.AGENT_GATEWAY_ADMIN_SESSION_DEV_STORE, false);
    if (!injectedBackend && !allowDevStore) return null;
    return createAdminGatewaySessionStore({
        backend: injectedBackend || createInMemoryAdminSessionBackend()
    });
}

function createGatewayCredentialService({ auditLogger, pluginManager, protocolConfig } = {}) {
    const switches = readMigrationSwitches();
    const adminSessionStore = resolveAdminSessionStoreForBundle(pluginManager);
    const credentialResolver = createCredentialResolver({
        credentialsPath: process.env.AGENT_GATEWAY_CREDENTIALS_PATH,
        pepperKeyringPath: process.env.AGENT_GATEWAY_CREDENTIAL_PEPPERS_PATH,
        legacyCredentialEnabled: !switches.legacyKeyDisabled,
        allowLegacyScopeNames: !switches.legacyScopeNamesDisabled
    });
    const authMigrationMetrics = createAuthMigrationMetrics();
    const builtinCredentialResolver = createBuiltinCredentialResolver({
        gatewayKey: getProtocolGovernanceConfig(protocolConfig || {}).gatewayKey,
        adminSessionStore,
        switches,
        authMigrationMetrics
    });
    const contextBuilder = createGatewayRequestContextBuilder({
        credentialResolver,
        // §3.3：requireCsrf 由入口按 HTTP method 传入——所有 cookie-authenticated
        // mutation 必须呈现 session-bound CSRF token。
        resolveBuiltinCredential: ({ token, headers, entry, requireCsrf }) => builtinCredentialResolver.resolveBuiltinCredential({
            token,
            surface: String(entry || '').startsWith('mcp') ? 'mcp' : 'native',
            adminSessionId: parseCookieHeader(headers).agw_admin_session || '',
            csrfToken: typeof headers?.['x-agent-gateway-csrf'] === 'string' ? headers['x-agent-gateway-csrf'] : null,
            requireCsrf: Boolean(requireCsrf)
        }),
        auditLogger
    });
    return Object.freeze({
        adminSessionStore,
        credentialResolver,
        builtinCredentialResolver,
        authMigrationMetrics,
        switches,
        buildGatewayRequestContext: contextBuilder.buildGatewayRequestContext,
        authorizeTarget: contextBuilder.authorizeTarget
    });
}

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

    const ports = options.ports || bindVcpPorts(pluginManager, options.portBindings);
    const schemaRegistry = createSchemaRegistry();
    const auditSinks = [createConsoleAuditSink()];
    const auditFile = options.auditFile || process.env.AGENT_GATEWAY_AUDIT_FILE;
    if (auditFile) auditSinks.push(createFileAuditSink(auditFile));
    const auditLogger = createAuditLogger({ prefix: options.auditPrefix || DEFAULT_AUDIT_PREFIX, sinks: auditSinks });
    const agentPolicyResolver = createAgentPolicyResolver({
        ports,
        ragConfig: ports.configuration.rag,
        policyConfig: ports.configuration.policy,
        toolInvokerPort: ports.toolInvoker
    });
    const jobRuntimeService = createJobRuntimeService({ auditLogger });
    const capabilityService = createCapabilityService({
        ports,
        ragRetrieverPort: ports.ragRetriever,
        diaryStorePort: ports.diaryStore,
        toolInvokerPort: ports.toolInvoker,
        agentDirectoryPort: ports.agentDirectory,
        llmCompletionPort: ports.llmCompletion,
        packageJson,
        bridgeVersion: options.gatewayVersion || DEFAULT_GATEWAY_VERSION,
        schemaRegistry,
        authContextResolver: resolveAuthContext,
        agentPolicyResolver
    });
    const memoryRuntimeService = createMemoryRuntimeService({
        ports,
        ragRetrieverPort: ports.ragRetriever,
        diaryStorePort: ports.diaryStore,
        toolInvokerPort: ports.toolInvoker,
        agentDirectoryPort: ports.agentDirectory,
        llmCompletionPort: ports.llmCompletion,
        ragConfig: ports.configuration.rag,
        auditLogger,
        mapMemoryWriteError: mapOpenClawMemoryWriteError,
        authContextResolver: resolveAuthContext,
        agentPolicyResolver,
        diaryScopeGuard: ensureDiaryAllowed
    });
    let recallRuntimeService;
    const contextRuntimeService = createContextRuntimeService({
        ports,
        ragRetrieverPort: ports.ragRetriever,
        diaryStorePort: ports.diaryStore,
        toolInvokerPort: ports.toolInvoker,
        agentDirectoryPort: ports.agentDirectory,
        llmCompletionPort: ports.llmCompletion,
        auditLogger,
        authContextResolver: resolveAuthContext,
        agentPolicyResolver,
        diaryScopeGuard: ensureDiaryAllowed,
        getRecallRuntimeService: () => recallRuntimeService
    });
    const toolRuntimeService = createToolRuntimeService({
        ports,
        ragRetrieverPort: ports.ragRetriever,
        diaryStorePort: ports.diaryStore,
        toolInvokerPort: ports.toolInvoker,
        agentDirectoryPort: ports.agentDirectory,
        llmCompletionPort: ports.llmCompletion,
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
        ports,
        ragRetrieverPort: ports.ragRetriever,
        diaryStorePort: ports.diaryStore,
        toolInvokerPort: ports.toolInvoker,
        agentDirectoryPort: ports.agentDirectory,
        llmCompletionPort: ports.llmCompletion,
        operabilityConfig: ports.configuration.operability,
        auditLogger
    });
    const agentRegistryService = createAgentRegistryService({
        ports,
        ragRetrieverPort: ports.ragRetriever,
        diaryStorePort: ports.diaryStore,
        toolInvokerPort: ports.toolInvoker,
        agentDirectoryPort: ports.agentDirectory,
        llmCompletionPort: ports.llmCompletion,
        renderPrompt: ports.agentDirectory.renderPrompt,
        schemaRegistry,
        authContextResolver: resolveAuthContext,
        agentPolicyResolver,
        capabilityService
    });
    const recallProfileResolver = new RecallProfileResolver();
    recallRuntimeService = createRecallRuntimeService({
        ports,
        ragRetrieverPort: ports.ragRetriever,
        diaryStorePort: ports.diaryStore,
        toolInvokerPort: ports.toolInvoker,
        agentDirectoryPort: ports.agentDirectory,
        llmCompletionPort: ports.llmCompletion,
        contextRuntimeService,
        recallProfileResolver
    });
    const recallProjectionService = createRecallProjectionService();
    const gatewayCredentialService = createGatewayCredentialService({ auditLogger, pluginManager, protocolConfig: ports.configuration.protocol });

    // M2.S1：guidance 单源产出。协调器发布冻结 integration snapshot（§4.3），
    // canonical guidance service 注入 memory policy diaries 后输出唯一 bundle。
    const integrationSnapshotCoordinator = createIntegrationSnapshotCoordinator({
        guidanceConfigPath: process.env.AGENT_GATEWAY_GUIDANCE_CONFIG_PATH || DEFAULT_GUIDANCE_CONFIG_PATH,
        credentialsPath: process.env.AGENT_GATEWAY_CREDENTIALS_PATH,
        pepperKeyringPath: process.env.AGENT_GATEWAY_CREDENTIAL_PEPPERS_PATH,
        listAgents: () => ports.agentDirectory.listAgents(),
        getMemoryPolicy: (agentId) => {
            const policy = resolveConfiguredAgentMemoryPolicy({ agentId });
            return {
                allowedDiaries: policy.allowedDiaryNames,
                defaultDiaries: policy.defaultDiaryNames
            };
        },
        legacyCredentialEnabled: !gatewayCredentialService.switches.legacyKeyDisabled,
        allowLegacyScopeNames: !gatewayCredentialService.switches.legacyScopeNamesDisabled
    });
    const agentGuidanceService = createAgentGuidanceService({
        snapshotCoordinator: integrationSnapshotCoordinator,
        agentPolicyResolver,
        ragRetrieverPort: ports.ragRetriever
    });

    pluginManager.__agentGatewayServiceBundle = {
        ports,
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
        recallProfileResolver,
        recallRuntimeService,
        recallProjectionService,
        gatewayCredentialService,
        integrationSnapshotCoordinator,
        agentGuidanceService,
        skillDownloadSigningService: createSkillDownloadSigningService({
            downloadNonceStore: createDownloadNonceStore(),
            credentialResolver: gatewayCredentialService?.credentialResolver || null,
            adminGatewaySessionStore: gatewayCredentialService?.adminSessionStore || null
        }),
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
