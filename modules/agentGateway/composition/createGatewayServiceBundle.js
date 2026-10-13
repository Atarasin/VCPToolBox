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
    createForgeRuntimeService
} = require('../services/forge/service');
const {
    createMemoryRuntimeService
} = require('../services/memoryRuntimeService');
const {
    createContextRuntimeService
} = require('../services/contextRuntimeService');
const { createKnowledgeRuntimeService } = require('../services/knowledgeRuntimeService');
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
const { createDownloadNonceStore, createFileDownloadNonceBackend } = require('../policy/downloadNonceStore');
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
const { normalizeString, parseBoolean: parseEnvBoolean } = require('../policy/shared/normalize');

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

/**
 * §6：生产 nonce store 三选一——pluginManager 注入外部共享 backend（跨主机
 * KV 等）、`AGENT_GATEWAY_DOWNLOAD_NONCE_DIR` 启用单机多 worker 文件
 * backend、或都缺省时的非生产内存 backend（mint 对其恒 503，fail-closed）。
 */
function resolveDownloadNonceStoreForBundle(pluginManager) {
    const injectedBackend = pluginManager?.agentGatewayDownloadNonceBackend || null;
    if (injectedBackend) {
        return createDownloadNonceStore({ backend: injectedBackend });
    }
    const nonceDir = normalizeString(process.env.AGENT_GATEWAY_DOWNLOAD_NONCE_DIR);
    if (nonceDir) {
        return createDownloadNonceStore({ backend: createFileDownloadNonceBackend({ dir: nonceDir }) });
    }
    return createDownloadNonceStore();
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
    // forge 铸造编排（专家铸造炉 M1）：五步状态机跑在 job 运行时之上，
    // 端口面只含 llmCompletion / toolInvoker / agentDirectory（只读），不接触记忆端口（红线 1）。
    const forgeRuntimeService = createForgeRuntimeService({
        jobRuntimeService,
        auditLogger,
        llmCompletionPort: ports.llmCompletion,
        toolInvokerPort: ports.toolInvoker,
        agentDirectoryPort: ports.agentDirectory,
        knowledgeStorePort: ports.knowledgeStore,
        baseDir: process.env.FORGE_BASE_DIR || undefined,
        knowledgeRoot: process.env.FORGE_KNOWLEDGE_ROOT || undefined,
        // D7 方案 C：Jev 对照试点——绑定仓库 jevClient 单例（typesafe-ai Jev，
        // 未配置 JEV_API_KEY 时 decide 抛 JEV_NOT_CONFIGURED，由 trial 捕获记 skipped）。
        // §3.8 触发 c：定期进修（默认每天 04:00，FORGE_LIFELONG_SCHEDULE/CRON 可配）。
        jevPort: {
            decide: (state, questions) => require('../../jevClient').decide(state, questions)
        }
    });
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
    // M4：冷知识库（TDB）检索运行时；端口不可用时服务仍可构造（search 返回 503）
    const knowledgeRuntimeService = createKnowledgeRuntimeService({
        knowledgeStorePort: ports.knowledgeStore,
        auditLogger
    });
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

    const { createLifelongScheduler } = require('../services/forge/lifelongScheduler');
    const { listExpertNames } = require('../services/forge/gapRegistry');
    // 定期进修：服务端常驻进程内启动（M5.S2）；AdminPanel/测试环境惰性不启动。
    // 名单口径必须与服务本体一致：用 forgeRuntimeService.baseDir（含
    // FORGE_BASE_DIR 缺省 <repo>/Agent/forge 的兜底）——2026-10-13 空转缺陷：
    // 此处曾直接读 process.env.FORGE_BASE_DIR，未配置时传 undefined，
    // 名单恒为空、每个周期的批次精确地空转且无任何报错。
    const forgeLifelongScheduler = createLifelongScheduler({
        forgeRuntimeService,
        gapRegistry: forgeRuntimeService.gapRegistry,
        listExpertNames: () => listExpertNames({ baseDir: forgeRuntimeService.baseDir }),
        auditLogger
    });
    if ((process.env.FORGE_LIFELONG_AUTOSTART || '1') !== '0') {
        forgeLifelongScheduler.start();
    }

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
        forgeRuntimeService,
        forgeLifelongScheduler,
        memoryRuntimeService,
        contextRuntimeService,
        knowledgeRuntimeService,
        toolRuntimeService,
        operabilityService,
        recallProfileResolver,
        recallRuntimeService,
        recallProjectionService,
        gatewayCredentialService,
        integrationSnapshotCoordinator,
        agentGuidanceService,
        skillDownloadSigningService: createSkillDownloadSigningService({
            downloadNonceStore: resolveDownloadNonceStoreForBundle(pluginManager),
            credentialResolver: gatewayCredentialService?.credentialResolver || null,
            adminGatewaySessionStore: gatewayCredentialService?.adminSessionStore || null,
            checkLegacyCredentialStatus: gatewayCredentialService?.builtinCredentialResolver?.checkLegacyCredentialStatus || null
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
