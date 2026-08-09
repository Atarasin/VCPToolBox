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
 * MCP agent target 门禁（2026-08 恢复绑定补全语义）：
 * 绑定 credential 省略 agentId → 以绑定身份为 target / 显式同 agent 成功 /
 * 显式他 agent 403 / 未绑定缺少 agentId 一律受控失败 /
 * job 工具保持 jobId 必填、agentId 可由绑定身份补全（不计入遥测）。
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

test('MCP gate: bound credential may omit agentId on gateway_recall_run (in-process)', async () => {
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

test('MCP gate: unbound omission keeps the controlled agentId-required failure (in-process)', async () => {
    const { pluginManager, bundle } = createRecallCapturePluginManager();
    const adapter = createMcpAdapter(pluginManager, { gatewayServiceBundle: bundle });

    await assert.rejects(
        () => adapter.callTool({
            name: 'gateway_recall_run',
            arguments: { query: 'unbound omitted' },
            requestContext: { requestId: 'req-m3-unbound-omit' }
        }),
        (error) => {
            assert.equal(error.code, 'MCP_INVALID_REQUEST');
            assert.match(error.message, /agentId is required/);
            return true;
        }
    );
});

test('MCP gate: backend-proxy bound credential may omit agentId on bootstrap/recall', async () => {
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

    const recall = await adapter.callTool({
        name: 'gateway_recall_run',
        arguments: { query: 'proxy omitted' },
        authContext,
        requestContext: { requestId: 'req-proxy-m3-recall' }
    });
    assert.equal(recall.isError, false);

    assert.equal(requests.length, 2);
    assert.equal(requests[0].agentId, 'Ariadne');
    assert.equal(requests[1].body.requestContext.agentId, 'Ariadne');
});

test('MCP gate: backend-proxy memory tools fill agentId from bound credential before the diary policy gate', async () => {
    const requests = [];
    const backendClient = {
        async searchMemory(body) {
            requests.push(body);
            return {
                ok: true,
                httpStatus: 200,
                payload: {
                    success: true,
                    data: { items: [] },
                    meta: { requestId: 'req-proxy-m3-search' }
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
        name: 'gateway_memory_search',
        arguments: { query: 'bound omitted search' },
        authContext: { boundAgentId: 'Ariadne', credentialScopes: ['gateway:read'] },
        sessionId: 'sess-proxy-m3-search',
        requestContext: { requestId: 'req-proxy-m3-search' }
    });
    assert.equal(result.isError, false);
    assert.equal(requests.length, 1);
    assert.equal(requests[0].requestContext.agentId, 'Ariadne');
});

test('MCP gate: unbound backend-proxy omission is rejected before any fabricated agent target appears', async () => {
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
    await assert.rejects(
        () => adapter.callTool({
            name: 'gateway_recall_run',
            arguments: { query: 'unbound proxy omitted' },
            requestContext: { requestId: 'req-proxy-m3-unbound' }
        }),
        (error) => {
            assert.equal(error.code, 'MCP_INVALID_REQUEST');
            assert.match(error.message, /agentId is required/);
            return true;
        }
    );
    assert.equal(requests.length, 0);
});

test('MCP gate: gateway_job_get and gateway_job_cancel keep jobId required; agentId is bound-omittable', async () => {
    const { OPERATION_CATALOG } = require('../../../modules/agentGateway/contracts/operations');
    const jobGet = OPERATION_CATALOG.mcp.find((operation) => operation.toolName === 'gateway_job_get');
    const jobCancel = OPERATION_CATALOG.mcp.find((operation) => operation.toolName === 'gateway_job_cancel');
    assert.deepEqual(jobGet.argsSchema.required, ['jobId']);
    assert.equal(jobGet.argsSchema.properties.agentId.type, 'string');
    assert.deepEqual(jobCancel.argsSchema.required, ['jobId']);
    assert.equal(jobCancel.argsSchema.properties.agentId.type, 'string');
});

test('MCP gate: backend-proxy job tools fill agentId from bound credential when omitted', async () => {
    const requests = [];
    const backendClient = {
        async getJob(jobId, query) {
            requests.push({ kind: 'getJob', jobId, query });
            return {
                ok: true,
                httpStatus: 200,
                payload: {
                    success: true,
                    data: { jobId, status: 'succeeded' },
                    meta: { requestId: 'req-proxy-m3-job' }
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
        name: 'gateway_job_get',
        arguments: { jobId: 'job-1' },
        authContext: { boundAgentId: 'Ariadne', credentialScopes: ['gateway:read'] },
        requestContext: { requestId: 'req-proxy-m3-job' }
    });
    assert.equal(result.isError, false);
    assert.equal(requests.length, 1);
    assert.equal(requests[0].query.agentId, 'Ariadne');
});

test('agent target telemetry counts explicit vs bound-omitted calls', () => {
    const telemetry = createAgentTargetTelemetry();
    telemetry.record({ surface: 'tools/call:gateway_recall_run', outcome: 'explicit' });
    const snapshot = telemetry.snapshot();
    assert.equal(snapshot.totals.explicit, 1);
    assert.equal(snapshot.totals.boundOmitted, 0);
    assert.ok(Math.abs(snapshot.totals.explicitRatio - 1) < 1e-9);
    assert.deepEqual(snapshot.bySurface['tools/call:gateway_recall_run'], { explicit: 1, boundOmitted: 0 });

    telemetry.reset();
    assert.equal(telemetry.snapshot().totals.explicitRatio, null);
});

test('in-process explicit calls feed the process-level agent target telemetry', async () => {
    defaultAgentTargetTelemetry.reset();
    const { pluginManager, bundle } = createRecallCapturePluginManager();
    const adapter = createMcpAdapter(pluginManager, { gatewayServiceBundle: bundle });

    await adapter.callTool({
        name: 'gateway_recall_run',
        arguments: { agentId: 'Ariadne', query: 'telemetry explicit' },
        authContext: boundContext('Ariadne'),
        sessionId: 'sess-m3-telemetry',
        requestContext: { requestId: 'req-m3-telemetry-2' }
    });

    const snapshot = defaultAgentTargetTelemetry.snapshot();
    assert.equal(snapshot.totals.explicit >= 1, true);
    assert.equal(snapshot.totals.boundOmitted, 0);
    defaultAgentTargetTelemetry.reset();
});

test('in-process bound-omitted calls feed the process-level agent target telemetry', async () => {
    defaultAgentTargetTelemetry.reset();
    const { pluginManager, bundle } = createRecallCapturePluginManager();
    const adapter = createMcpAdapter(pluginManager, { gatewayServiceBundle: bundle });

    await adapter.callTool({
        name: 'gateway_recall_run',
        arguments: { query: 'telemetry bound omitted' },
        authContext: boundContext('Ariadne'),
        sessionId: 'sess-m3-telemetry-bound',
        requestContext: { requestId: 'req-m3-telemetry-bound' }
    });

    const snapshot = defaultAgentTargetTelemetry.snapshot();
    assert.equal(snapshot.totals.boundOmitted >= 1, true);
    assert.equal(snapshot.bySurface['in-process:tools/call:gateway_recall_run'].boundOmitted >= 1, true);
    defaultAgentTargetTelemetry.reset();
});
