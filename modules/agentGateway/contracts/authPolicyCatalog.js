const { MCP_OPERATIONS, REST_OPERATIONS } = require('./operations');

/**
 * Auth policy catalog（§3.5 / M0.S2）。
 *
 * 每个 credential-authenticated operation/surface 必须声明恰好一个
 * `credentialAction`（"read" | "execute" | "authenticated"），或者是唯一的
 * pre-credential bridge 并声明 `authMechanism: "adminAuthBridge"`。REST 与
 * MCP binding 引用同一 canonical action；校验失败按 §3.5 fail-fast：拒绝
 * 发布候选 snapshot（由 M0.S3 协调器接入 health degraded / strict startup）。
 */

const CREDENTIAL_ACTIONS = Object.freeze(['authenticated', 'read', 'execute']);
const AUTH_MECHANISMS = Object.freeze(['adminAuthBridge']);

const ACTION_SCOPES = Object.freeze({
    authenticated: Object.freeze([]),
    read: Object.freeze(['gateway:read', 'admin']),
    execute: Object.freeze(['gateway:execute', 'admin'])
});

// 不完全对应业务 operation 的 surface（M0.S2.T2）。
// integration/skill surface 自 M4.S1 起由 restOperations.json 的
// getAgentGatewayAgentIntegration / getAgentGatewayAgentIntegrationSkill
// （credentialAction: read）登记；skill 签名下载 mint/redeem 见 M4.S2。
const SURFACE_ENTRIES = Object.freeze([
    { surface: 'mcp.initialize', kind: 'mcp-protocol', credentialAction: 'authenticated' },
    { surface: 'mcp.notifications/initialized', kind: 'mcp-protocol', credentialAction: 'authenticated' },
    { surface: 'mcp.ping', kind: 'mcp-protocol', credentialAction: 'authenticated' },
    { surface: 'mcp.tools/list', kind: 'mcp-discovery', credentialAction: 'read' },
    { surface: 'mcp.resources/list', kind: 'mcp-discovery', credentialAction: 'read' },
    { surface: 'mcp.prompts/list', kind: 'mcp-discovery', credentialAction: 'read' },
    { surface: 'mcp.prompts/get', kind: 'mcp-discovery', credentialAction: 'read' },
    { surface: 'mcp.resources/read', kind: 'mcp-resource', credentialAction: 'read' },
    { surface: 'rest.integration/skill-download-redeem', kind: 'rest-download-redeem', credentialAction: 'authenticated' }
    // admin session bridge 自 M1.S3 起由 restOperations.json 的
    // createAgentGatewayAdminSession（authMechanism: adminAuthBridge）登记。
].map(Object.freeze));

// canonical operation 在两套 binding 中的对应关系；两侧 action 必须一致。
const REST_BINDING_BY_OPERATION_ID = Object.freeze({
    'memory.search': 'searchAgentGatewayMemory',
    'memory.write': 'writeAgentGatewayMemory',
    'context.assemble': 'assembleAgentGatewayContext',
    'recall.run': 'runAgentGatewayRecall',
    'jobs.read': 'getAgentGatewayJob',
    'jobs.cancel': 'cancelAgentGatewayJob',
    'agents.render': 'renderAgentGatewayAgent'
});

// route/adapter operationName → canonical credentialAction（§3.5）。
// 供审计事件登记 credentialAction；health/metrics 是 adminAuth 排除项。
const OPERATION_CREDENTIAL_ACTIONS = Object.freeze({
    'agents.list': 'read',
    'agents.detail': 'read',
    'agents.guidance': 'read',
    'agents.integration': 'read',
    'agents.integration.skill': 'read',
    'agents.render': 'read',
    'capabilities.read': 'read',
    'memory.targets': 'read',
    'memory.search': 'read',
    'memory.write': 'execute',
    'context.assemble': 'read',
    'recall.run': 'read',
    'tool.invoke': 'execute',
    'jobs.read': 'read',
    'jobs.cancel': 'execute',
    'events.stream': 'read'
});

function entryError(entryName, message) {
    return { entry: entryName, message };
}

function validateEntryAuthDeclaration(entryName, credentialAction, authMechanism, errors) {
    const hasAction = credentialAction !== undefined && credentialAction !== null;
    const hasMechanism = authMechanism !== undefined && authMechanism !== null;
    if (hasAction && hasMechanism) {
        errors.push(entryError(entryName, 'declares both credentialAction and authMechanism; they are mutually exclusive'));
        return;
    }
    if (!hasAction && !hasMechanism) {
        errors.push(entryError(entryName, 'declares neither credentialAction nor authMechanism'));
        return;
    }
    if (hasAction && !CREDENTIAL_ACTIONS.includes(credentialAction)) {
        errors.push(entryError(entryName, `unknown credentialAction "${credentialAction}"`));
    }
    if (hasMechanism && !AUTH_MECHANISMS.includes(authMechanism)) {
        errors.push(entryError(entryName, `unknown authMechanism "${authMechanism}"`));
    }
}

/**
 * 汇集 MCP catalog、REST catalog 与 surface 登记表，构建候选 auth policy
 * catalog 并执行 §3.5 fail-fast 校验。
 * @returns {{ valid: boolean, errors: Array, catalog: object|null }}
 */
function buildAuthPolicyCatalog({
    mcpOperations = MCP_OPERATIONS,
    restOperations = REST_OPERATIONS,
    surfaceEntries = SURFACE_ENTRIES
} = {}) {
    const errors = [];
    const entries = [];

    for (const operation of mcpOperations) {
        const entryName = `mcp:${operation.toolName}`;
        const credentialAction = operation.execution?.credentialAction;
        const authMechanism = operation.execution?.authMechanism;
        validateEntryAuthDeclaration(entryName, credentialAction, authMechanism, errors);
        entries.push({
            entry: entryName,
            binding: 'mcp',
            operationId: operation.operationId,
            toolName: operation.toolName,
            ...(credentialAction !== undefined ? { credentialAction } : {}),
            ...(authMechanism !== undefined ? { authMechanism } : {})
        });
    }

    const restByOperationId = new Map();
    for (const operation of restOperations) {
        const entryName = `rest:${operation.operationId}`;
        if (operation.authExclusion === 'adminAuth') {
            // §3.4 固定排除清单：health/metrics 继续由 adminAuth 保护，不进入 credential catalog。
            entries.push({
                entry: entryName,
                binding: 'rest',
                operationId: operation.operationId,
                path: operation.path,
                authExclusion: 'adminAuth'
            });
            continue;
        }
        const credentialAction = operation.credentialAction;
        const authMechanism = operation.authMechanism;
        validateEntryAuthDeclaration(entryName, credentialAction, authMechanism, errors);
        restByOperationId.set(operation.operationId, operation);
        entries.push({
            entry: entryName,
            binding: 'rest',
            operationId: operation.operationId,
            path: operation.path,
            ...(credentialAction !== undefined ? { credentialAction } : {}),
            ...(authMechanism !== undefined ? { authMechanism } : {})
        });
    }

    for (const surfaceEntry of surfaceEntries) {
        const entryName = `surface:${surfaceEntry.surface}`;
        validateEntryAuthDeclaration(entryName, surfaceEntry.credentialAction, surfaceEntry.authMechanism, errors);
        if (surfaceEntry.authMechanism === 'adminAuthBridge' && surfaceEntry.kind !== 'admin-session-bridge') {
            errors.push(entryError(entryName, 'authMechanism "adminAuthBridge" is reserved for the admin-session-bridge surface'));
        }
        entries.push({ ...surfaceEntry, entry: entryName, binding: 'surface' });
    }

    const bridgeEntries = entries.filter((entry) => entry.authMechanism === 'adminAuthBridge');
    if (bridgeEntries.length > 1) {
        errors.push(entryError(bridgeEntries.map((entry) => entry.entry).join(', '), 'only one adminAuthBridge surface is allowed'));
    }

    for (const mcpOperation of mcpOperations) {
        const restOperationId = REST_BINDING_BY_OPERATION_ID[mcpOperation.operationId];
        if (!restOperationId) {
            continue;
        }
        const restOperation = restByOperationId.get(restOperationId);
        if (!restOperation) {
            continue;
        }
        const mcpAction = mcpOperation.execution?.credentialAction;
        const restAction = restOperation.credentialAction;
        if (mcpAction && restAction && mcpAction !== restAction) {
            errors.push(entryError(
                `mcp:${mcpOperation.toolName} / rest:${restOperationId}`,
                `binding credentialAction mismatch for canonical operation "${mcpOperation.operationId}": mcp="${mcpAction}" rest="${restAction}"`
            ));
        }
    }

    if (errors.length > 0) {
        return { valid: false, errors, catalog: null };
    }
    return {
        valid: true,
        errors: [],
        catalog: Object.freeze({
            actions: CREDENTIAL_ACTIONS,
            actionScopes: ACTION_SCOPES,
            entries: Object.freeze(entries.map(Object.freeze))
        })
    };
}

/**
 * strict startup 入口：校验失败时抛错（进程退出由启动器决定）。
 * 非 strict 部署由 M0.S3 协调器把失败转为 health degraded。
 */
function assertValidAuthPolicyCatalog(options) {
    const result = buildAuthPolicyCatalog(options);
    if (!result.valid) {
        const detail = result.errors.map((error) => `${error.entry}: ${error.message}`).join('; ');
        throw new Error(`[authPolicyCatalog] invalid catalog: ${detail}`);
    }
    return result.catalog;
}

module.exports = {
    ACTION_SCOPES,
    AUTH_MECHANISMS,
    CREDENTIAL_ACTIONS,
    OPERATION_CREDENTIAL_ACTIONS,
    REST_BINDING_BY_OPERATION_ID,
    SURFACE_ENTRIES,
    assertValidAuthPolicyCatalog,
    buildAuthPolicyCatalog
};
