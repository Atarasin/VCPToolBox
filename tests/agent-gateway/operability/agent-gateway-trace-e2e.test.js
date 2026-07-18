const assert = require('node:assert/strict');
const http = require('node:http');
const test = require('node:test');
const express = require('express');

const createAgentGatewayRoutes = require('../../../routes/agentGatewayRoutes');
const { GatewayBackendClient } = require('../../../modules/agentGateway/clients/GatewayBackendClient');
const { createBackendProxyMcpServerHarness } = require('../../../modules/agentGateway/protocols/mcp/backendProxyExecutor');
const { createMcpHttpServer, MCP_SESSION_HEADER } = require('../../../modules/agentGateway/mcpHttpServer');
const { createRecallProjectionService } = require('../../../modules/agentGateway/services/recallProjectionService');
const { createAuditLogger } = require('../../../modules/agentGateway/infra/auditLogger');

async function listen(app) {
    const server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address();
    return { server, baseUrl: `http://127.0.0.1:${port}` };
}

async function close(server) {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

test('HTTP MCP backend-proxy keeps one trace through Native service and audit sink', async () => {
    const traceId = 'trace-cross-boundary-e2e';
    const observed = { auditLines: [] };
    const auditLogger = createAuditLogger({ sinks: [{ name: 'capture', write: (line) => observed.auditLines.push(line) }] });
    const pluginManager = {};
    pluginManager.__agentGatewayServiceBundle = {
        authContextResolver: ({ authContext, requestContext }) => ({ ...requestContext, ...(authContext || {}) }),
        agentPolicyResolver: null,
        recallProjectionService: createRecallProjectionService(),
        recallRuntimeService: {
            async executeRecall(input) {
                observed.nativeRequestContext = input.requestContext;
                return { success: true, items: [{ text: 'trace result', content: 'trace result', score: 0.9,
                    sourceDiary: 'Nova', sourceFile: 'trace.md' }], diagnostics: {
                    totalDurationMs: 1, rules: [], pipelineStages: [], profileMeta: { profileName: 'default' }
                } };
            }
        },
        operabilityService: {
            beginRequest(input) {
                observed.operability = input;
                auditLogger.logGatewayOperation('request.started', {
                    requestId: input.requestContext.requestId,
                    traceId: input.requestContext.traceId,
                    operationName: input.operationName
                });
                return { allowed: true, traceId: input.requestContext.traceId, operationName: input.operationName,
                    finish() { auditLogger.logGatewayOperation('request.completed', {
                        requestId: input.requestContext.requestId,
                        traceId: input.requestContext.traceId,
                        operationName: input.operationName
                    }); } };
            }
        }
    };

    const nativeApp = express();
    nativeApp.use(express.json());
    nativeApp.use((req, _res, next) => {
        observed.backendHeader = req.headers['x-agent-gateway-trace-id'];
        next();
    });
    nativeApp.use('/agent_gateway', createAgentGatewayRoutes(pluginManager));
    const native = await listen(nativeApp);

    const backendClient = new GatewayBackendClient({ baseUrl: native.baseUrl });
    const baseHarness = createBackendProxyMcpServerHarness({ backendClient, defaultAgentId: 'Ariadne' });
    const harness = {
        async handleRequest(message) {
            if (message.method === 'tools/call') observed.transportContext = message.params.requestContext;
            return baseHarness.handleRequest(message);
        }
    };
    const mcpApp = express();
    const mcp = createMcpHttpServer({ harness, resolveAuth: async () => ({ provided: true,
        authenticated: true, gatewayId: 'gw-e2e', authMode: 'gateway_key', authSource: 'test', roles: [] }) });
    mcp.attach(mcpApp);
    const transport = await listen(mcpApp);

    try {
        const initialized = await fetch(`${transport.baseUrl}/mcp`, { method: 'POST', headers: {
            'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1,
            method: 'initialize', params: { protocolVersion: '2025-03-26' } }) });
        const sessionId = initialized.headers.get(MCP_SESSION_HEADER);
        const response = await fetch(`${transport.baseUrl}/mcp`, { method: 'POST', headers: {
            'content-type': 'application/json', [MCP_SESSION_HEADER]: sessionId }, body: JSON.stringify({
            jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'gateway_recall_run',
                arguments: { agentId: 'Ariadne', query: 'trace me', profile: 'default' },
                requestContext: { requestId: 'req-trace-e2e', traceId } } }) });
        const payload = await response.json();
        const responseTrace = payload.result.structuredContent.operability.traceId;

        assert.equal(observed.transportContext.traceId, traceId);
        assert.equal(observed.backendHeader, traceId);
        assert.equal(observed.nativeRequestContext.traceId, traceId);
        assert.equal(observed.operability.requestContext.traceId, traceId);
        assert.equal(responseTrace, traceId);
        assert.ok(observed.auditLines.length >= 2);
        assert.ok(observed.auditLines.every((line) => JSON.parse(line.slice(line.indexOf('{'))).traceId === traceId));
    } finally {
        await mcp.close();
        await close(transport.server);
        await close(native.server);
    }
});
