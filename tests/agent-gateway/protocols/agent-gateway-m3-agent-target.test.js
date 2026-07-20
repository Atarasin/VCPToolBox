const assert = require('node:assert/strict');
const test = require('node:test');

const {
    createMcpAdapter
} = require('../../../modules/agentGateway/protocols/mcp/inProcessExecutor');
const {
    createBackendProxyMcpAdapter
} = require('../../../modules/agentGateway/protocols/mcp/backendProxyExecutor');
const {
    createTrustedCredentialContext
} = require('../../../modules/agentGateway/policy/trustedCredentialContext');
const {
    createAgentTargetTelemetry,
    defaultAgentTargetTelemetry
} = require('../../../modules/agentGateway/policy/agentTargetTelemetry');
const { getGatewayServiceBundle } = require('../../../modules/agentGateway/createGatewayServiceBundle');
const { createPluginManager } = require('../helpers/agent-gateway-test-helpers');

/**
 * M3 门禁（06-execution-plan.md M3.S2.T3）：
 * 绑定省略成功 / 显式同 agent 成功 / 显式他 agent 403 /
 * 未绑定省略 400 / job 按 owner 授权（jobId-only，schema 不变）。
 */

function createRecallCapturePluginManager() {
    const pluginManager = createPluginManager();
    const bundle = getGatewayServiceBundle(pluginManager);
    const calls = [];
    bundle.recallRuntimeService = {
        async executeRecall(input) {
            calls.push(input);
            return {
                success: true,
                requestId: input.requestContext?.requestId || 'req-recall',
                data: {
                    items: [{ content: 'entry', score: 1, sourceDiary: 'Nova' }],
                    recallBlocks: [],
                    diagnostics: {}
                }
            };
        }
    };
    bundle.recallProjectionService = {
        project(result) {
            return { ...result, activeProjection: 'items' };
        },
        projectFullResult(result) {
            return { ...result, activeProjection: 'items' };
        }
    };
    return { pluginManager, bundle, calls };
}

function boundContext(agentId, scopes = ['gateway:read', 'gateway:execute']) {
    return createTrustedCredentialContext({
        credentialId: `cred-${agentId}`,
        credentialSubject: `cred-${agentId}`,
        boundAgentId: agentId,
        scopes
    });
}

test('M3 gate: bound credential may omit agentId on gateway_recall_run (in-process)', async () => {
    const { pluginManager, bundle, calls } = createRecallCapturePluginManager();
    const adapter = createMcpAdapter(pluginManager, { gatewayServiceBundle: bundle });

    const result = await adapter.callTool({
        name: 'gateway_recall_run',
        arguments: { query: 'omitted target' },
        authContext: boundContext('Ariadne'),
        sessionId: 'sess-m3-bound-omit',
        requestContext: { requestId: 'req-m3-bound-omit' }
    });
    assert.equal(result.isError, false);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].requestContext.agentId, 'Ariadne');
});

test('M3 gate: bound credential with explicit same agent succeeds; other agent is 403 (in-process)', async () => {
    const { pluginManager, bundle, calls } = createRecallCapturePluginManager();
    const adapter = createMcpAdapter(pluginManager, { gatewayServiceBundle: bundle });

    const same = await adapter.callTool({
        name: 'gateway_recall_run',
        arguments: { agentId: 'Ariadne', query: 'explicit same' },
        authContext: boundContext('Ariadne'),
        sessionId: 'sess-m3-explicit-same',
        requestContext: { requestId: 'req-m3-explicit-same' }
    });
    assert.equal(same.isError, false);
    assert.equal(calls[calls.length - 1].requestContext.agentId, 'Ariadne');

    await assert.rejects(
        () => adapter.callTool({
            name: 'gateway_recall_run',
            arguments: { agentId: 'Nexus', query: 'explicit other' },
            authContext: boundContext('Ariadne'),
            sessionId: 'sess-m3-explicit-other',
            requestContext: { requestId: 'req-m3-explicit-other' }
        }),
        (error) => {
            assert.equal(error.code, 'MCP_FORBIDDEN');
            return true;
        }
    );
});

test('M3 gate: unbound omission keeps the controlled agentId-required failure (in-process)', async () => {
    const { pluginManager, bundle } = createRecallCapturePluginManager();
    const adapter = createMcpAdapter(pluginManager, { gatewayServiceBundle: bundle });

    // 无 trusted 绑定、无显式 agentId：schema 已放宽，决议树仍受控失败。
    // fixture 目录发布多个 agent，单一 agent 兜底不生效。
    await assert.rejects(
        () => adapter.callTool({
            name: 'gateway_recall_run',
            arguments: { query: 'unbound omitted' },
            requestContext: { requestId: 'req-m3-unbound-omit' }
        }),
        (error) => {
            assert.equal(error.code, 'MCP_INVALID_REQUEST');
            assert.match(error.message, /agentId/);
            return true;
        }
    );
});

test('M3 gate: bound credential omitting agentId resolves to bound agent on backend-proxy bootstrap/recall', async () => {
    const requests = [];
    const backendClient = {
        async renderAgent(agentId, body) {
            requests.push({ kind: 'render', agentId, body });
            return {
                ok: true,
                httpStatus: 200,
                payload: {
                    success: true,
                    data: { agentId, renderedPrompt: `prompt for ${agentId}`, warnings: [] },
                    meta: { requestId: 'req-proxy-m3' }
                }
            };
        },
        async runRecall(body) {
            requests.push({ kind: 'recall', body });
            return {
                ok: true,
                httpStatus: 200,
                payload: {
                    success: true,
                    data: { items: [], recallBlocks: [], diagnostics: {} },
                    meta: { requestId: 'req-proxy-m3-recall' }
                }
            };
        },
        async getAgentGuidance() {
            return { ok: false, httpStatus: 404, payload: { success: false } };
        }
    };
    const adapter = createBackendProxyMcpAdapter({
        backendClient,
        defaultAgentId: '',
        discoveryDefaultAgentEnabled: false
    });
    const authContext = { boundAgentId: 'Ariadne', credentialScopes: ['gateway:read', 'gateway:execute'] };

    const bootstrap = await adapter.callTool({
        name: 'gateway_agent_bootstrap',
        arguments: { variables: {} },
        authContext,
        requestContext: { requestId: 'req-proxy-m3-bootstrap' }
    });
    assert.equal(bootstrap.isError, false);
    assert.equal(requests.find((entry) => entry.kind === 'render').agentId, 'Ariadne');

    const recall = await adapter.callTool({
        name: 'gateway_recall_run',
        arguments: { query: 'proxy omitted' },
        authContext,
        requestContext: { requestId: 'req-proxy-m3-recall' }
    });
    assert.equal(recall.isError, false);
    const recallRequest = requests.find((entry) => entry.kind === 'recall');
    assert.equal(recallRequest.body.requestContext.agentId, 'Ariadne');
});

test('M3 gate: unbound backend-proxy omission forwards without a fabricated agent target', async () => {
    const requests = [];
    const backendClient = {
        async runRecall(body) {
            requests.push(body);
            // canonical backend 决议树对未绑定省略返回受控 400
            return {
                ok: false,
                httpStatus: 400,
                payload: {
                    success: false,
                    error: 'agent-scoped operation requires a target agent',
                    code: 'AGW_INVALID_REQUEST'
                }
            };
        }
    };
    const adapter = createBackendProxyMcpAdapter({
        backendClient,
        defaultAgentId: '',
        discoveryDefaultAgentEnabled: false
    });
    const result = await adapter.callTool({
        name: 'gateway_recall_run',
        arguments: { query: 'unbound proxy omitted' },
        requestContext: { requestId: 'req-proxy-m3-unbound' }
    });
    assert.equal(result.isError, true);
    assert.equal(result.error.details.gatewayCode, 'AGW_INVALID_REQUEST');
    assert.equal(requests[0].requestContext.agentId, undefined);
});

test('M3 gate: gateway_job_get stays jobId-only and resolves by server-side owner (schema unchanged)', async () => {
    const { OPERATION_CATALOG } = require('../../../modules/agentGateway/contracts/operations');
    const jobGet = OPERATION_CATALOG.mcp.find((operation) => operation.toolName === 'gateway_job_get');
    const jobCancel = OPERATION_CATALOG.mcp.find((operation) => operation.toolName === 'gateway_job_cancel');
    assert.deepEqual(jobGet.argsSchema.required, ['jobId']);
    assert.equal(jobGet.argsSchema.properties.agentId, undefined);
    assert.deepEqual(jobCancel.argsSchema.required, ['jobId']);
    assert.equal(jobCancel.argsSchema.properties.agentId, undefined);
});

test('agent target telemetry counts explicit vs bound-omitted calls', () => {
    const telemetry = createAgentTargetTelemetry();
    telemetry.record({ surface: 'tools/call:gateway_recall_run', outcome: 'explicit' });
    telemetry.record({ surface: 'tools/call:gateway_recall_run', outcome: 'boundOmitted' });
    telemetry.record({ surface: 'tools/call:gateway_recall_run', outcome: 'boundOmitted' });
    const snapshot = telemetry.snapshot();
    assert.equal(snapshot.totals.explicit, 1);
    assert.equal(snapshot.totals.boundOmitted, 2);
    assert.ok(Math.abs(snapshot.totals.explicitRatio - 1 / 3) < 1e-9);
    assert.deepEqual(snapshot.bySurface['tools/call:gateway_recall_run'], { explicit: 1, boundOmitted: 2 });

    telemetry.reset();
    assert.equal(telemetry.snapshot().totals.explicitRatio, null);
});

test('in-process bound calls feed the process-level agent target telemetry', async () => {
    defaultAgentTargetTelemetry.reset();
    const { pluginManager, bundle } = createRecallCapturePluginManager();
    const adapter = createMcpAdapter(pluginManager, { gatewayServiceBundle: bundle });

    await adapter.callTool({
        name: 'gateway_recall_run',
        arguments: { query: 'telemetry omitted' },
        authContext: boundContext('Ariadne'),
        sessionId: 'sess-m3-telemetry',
        requestContext: { requestId: 'req-m3-telemetry-1' }
    });
    await adapter.callTool({
        name: 'gateway_recall_run',
        arguments: { agentId: 'Ariadne', query: 'telemetry explicit' },
        authContext: boundContext('Ariadne'),
        sessionId: 'sess-m3-telemetry',
        requestContext: { requestId: 'req-m3-telemetry-2' }
    });

    const snapshot = defaultAgentTargetTelemetry.snapshot();
    assert.equal(snapshot.totals.boundOmitted >= 1, true);
    assert.equal(snapshot.totals.explicit >= 1, true);
    defaultAgentTargetTelemetry.reset();
});
