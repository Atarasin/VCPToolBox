const assert = require('node:assert/strict');
const test = require('node:test');

const {
    normalizeRequestContext,
    createRequestId
} = require('../../../modules/agentGateway/contracts/requestContext');
const {
    createResponseMeta,
    sendSuccessResponse,
    sendErrorResponse
} = require('../../../modules/agentGateway/contracts/responseEnvelope');
const {
    AGW_ERROR_CODES,
    OPENCLAW_ERROR_CODES,
    OPENCLAW_TO_AGENT_GATEWAY_CODE
} = require('../../../modules/agentGateway/contracts/errorCodes');
const {
    AGENT_GATEWAY_AUTH_MODES,
    AGENT_GATEWAY_HEADERS,
    GATEWAY_CAPABILITY_SECTIONS,
    resolveDedicatedGatewayAuth,
    resolveGovernedIdempotencyKey,
    resolveNativeRequestContext
} = require('../../../modules/agentGateway/contracts/protocolGovernance');
const {
    reuseRequestId,
    getDurationMs
} = require('../../../modules/agentGateway/infra/trace');
const {
    createAuditLogger
} = require('../../../modules/agentGateway/infra/auditLogger');
const {
    mapErrorByCategory,
    mapOpenClawMemoryWriteError,
    mapOpenClawToolExecutionError
} = require('../../../modules/agentGateway/infra/errorMapper');

function createMockResponse() {
    return {
        statusCode: 200,
        headers: {},
        jsonPayload: null,
        set(name, value) {
            this.headers[name.toLowerCase()] = value;
        },
        status(code) {
            this.statusCode = code;
            return this;
        },
        json(payload) {
            this.jsonPayload = payload;
            return payload;
        }
    };
}

test('requestContext normalizes values and fills defaults', () => {
    const requestContext = normalizeRequestContext({
        requestId: ' req-001 ',
        sessionId: ' sess-001 ',
        agentId: ' agent-001 ',
        source: ' openclaw '
    }, {
        defaultRuntime: 'openclaw',
        requestIdPrefix: 'ocw'
    });

    assert.deepEqual(requestContext, {
        requestId: 'req-001',
        sessionId: 'sess-001',
        agentId: 'agent-001',
        source: 'openclaw',
        runtime: 'openclaw'
    });
});

test('requestContext generates requestId when missing', () => {
    const requestContext = normalizeRequestContext({}, {
        defaultSource: 'openclaw-context',
        defaultRuntime: 'openclaw',
        requestIdPrefix: 'ocw'
    });

    assert.match(requestContext.requestId, /^ocw_/);
    assert.equal(requestContext.source, 'openclaw-context');
    assert.equal(requestContext.runtime, 'openclaw');
});

test('responseEnvelope sends success and error envelopes with compatibility headers', () => {
    const successResponse = createMockResponse();
    sendSuccessResponse(successResponse, {
        requestId: 'req-001',
        startedAt: Date.now() - 5,
        data: { ok: true },
        versionHeader: 'x-openclaw-bridge-version',
        versionValue: 'v1',
        versionKey: 'bridgeVersion'
    });

    assert.equal(successResponse.statusCode, 200);
    assert.equal(successResponse.headers['x-request-id'], 'req-001');
    assert.equal(successResponse.headers['x-openclaw-bridge-version'], 'v1');
    assert.equal(successResponse.jsonPayload.success, true);
    assert.equal(successResponse.jsonPayload.meta.bridgeVersion, 'v1');

    const errorResponse = createMockResponse();
    sendErrorResponse(errorResponse, {
        status: 400,
        requestId: 'req-002',
        startedAt: Date.now() - 5,
        code: 'OCW_INVALID_REQUEST',
        error: 'bad request',
        details: { field: 'agentId' },
        versionHeader: 'x-openclaw-bridge-version',
        versionValue: 'v1',
        versionKey: 'bridgeVersion'
    });

    assert.equal(errorResponse.statusCode, 400);
    assert.equal(errorResponse.jsonPayload.success, false);
    assert.equal(errorResponse.jsonPayload.code, 'OCW_INVALID_REQUEST');
    assert.equal(errorResponse.jsonPayload.meta.bridgeVersion, 'v1');
});

test('errorCodes expose stable AGW and OCW mappings', () => {
    assert.equal(AGW_ERROR_CODES.INVALID_REQUEST, 'AGW_INVALID_REQUEST');
    assert.equal(AGW_ERROR_CODES.UNAUTHORIZED, 'AGW_UNAUTHORIZED');
    assert.equal(AGW_ERROR_CODES.RATE_LIMITED, 'AGW_RATE_LIMITED');
    assert.equal(AGW_ERROR_CODES.CONCURRENCY_LIMITED, 'AGW_CONCURRENCY_LIMITED');
    assert.equal(AGW_ERROR_CODES.PAYLOAD_TOO_LARGE, 'AGW_PAYLOAD_TOO_LARGE');
    assert.equal(OPENCLAW_ERROR_CODES.TOOL_TIMEOUT, 'OCW_TOOL_TIMEOUT');
    assert.equal(
        OPENCLAW_TO_AGENT_GATEWAY_CODE[OPENCLAW_ERROR_CODES.TOOL_TIMEOUT],
        AGW_ERROR_CODES.TIMEOUT
    );
});

test('trace reuses requestId and computes duration', async () => {
    assert.equal(reuseRequestId(' req-003 ', { prefix: 'ocw' }), 'req-003');
    const createdRequestId = createRequestId('', 'ocw');
    assert.match(createdRequestId, /^ocw_/);

    await new Promise((resolve) => setTimeout(resolve, 2));
    assert.equal(getDurationMs(Date.now() - 10) >= 10, true);
    assert.equal(createResponseMeta({
        requestId: 'req-004',
        startedAt: Date.now() - 3,
        versionKey: 'bridgeVersion',
        versionValue: 'v1'
    }).bridgeVersion, 'v1');
});

test('auditLogger outputs compatible audit events', () => {
    const lines = [];
    const logger = createAuditLogger({
        prefix: '[OpenClawBridgeAudit]',
        write(line) {
            lines.push(line);
        }
    });

    logger.logGatewayOperation('request.started', { traceId: 'trace-a' });
    logger.logSearch('started', { requestId: 'req-a' });
    logger.logContext('completed', { requestId: 'req-b' }, Date.now() - 5);
    logger.logToolInvoke('failed', { requestId: 'req-c' }, Date.now() - 5);

    assert.equal(lines.length, 4);
    assert.match(lines[0], /^\[OpenClawBridgeAudit\] /);
    assert.match(lines[0], /"event":"gateway\.request\.started"/);
    assert.match(lines[1], /"event":"rag\.search\.started"/);
    assert.match(lines[2], /"event":"rag\.context\.completed"/);
    assert.match(lines[3], /"event":"tool\.failed"/);
});

test('errorMapper covers validation, forbidden, timeout, internal and OpenClaw plugin mappings', () => {
    assert.equal(mapErrorByCategory('validation').code, AGW_ERROR_CODES.VALIDATION_ERROR);
    assert.equal(mapErrorByCategory('forbidden').status, 403);
    assert.equal(mapErrorByCategory('timeout').status, 504);
    assert.equal(mapErrorByCategory('other').code, AGW_ERROR_CODES.INTERNAL_ERROR);

    const memoryValidation = mapOpenClawMemoryWriteError(new Error('memory.tags is required'));
    assert.equal(memoryValidation.code, OPENCLAW_ERROR_CODES.MEMORY_INVALID_PAYLOAD);

    const toolTimeout = mapOpenClawToolExecutionError('SciCalculator', new Error(JSON.stringify({
        plugin_error: 'Tool execution timed out after 30 seconds.'
    })));
    assert.equal(toolTimeout.code, OPENCLAW_ERROR_CODES.TOOL_TIMEOUT);

    const toolForbidden = mapOpenClawToolExecutionError('ProtectedTool', new Error(JSON.stringify({
        plugin_error: 'approval required and cannot proceed'
    })));
    assert.equal(toolForbidden.code, OPENCLAW_ERROR_CODES.TOOL_APPROVAL_REQUIRED);
});

test('protocolGovernance resolves dedicated auth, native request context and idempotency input', () => {
    const dedicatedAuth = resolveDedicatedGatewayAuth({
        headers: {
            [AGENT_GATEWAY_HEADERS.GATEWAY_KEY]: 'gw-secret',
            [AGENT_GATEWAY_HEADERS.GATEWAY_ID]: 'vcp-test-gateway'
        },
        pluginManager: {
            agentGatewayProtocolConfig: {
                gatewayKey: 'gw-secret'
            }
        }
    });

    assert.equal(dedicatedAuth.provided, true);
    assert.equal(dedicatedAuth.authenticated, true);
    assert.equal(dedicatedAuth.authMode, AGENT_GATEWAY_AUTH_MODES.GATEWAY_KEY);
    assert.equal(dedicatedAuth.gatewayId, 'vcp-test-gateway');

    const requestContext = resolveNativeRequestContext({
        agentId: 'Ariadne'
    }, {
        headers: {
            [AGENT_GATEWAY_HEADERS.REQUEST_ID]: 'req-governed-001',
            [AGENT_GATEWAY_HEADERS.SESSION_ID]: 'sess-governed-001',
            [AGENT_GATEWAY_HEADERS.SOURCE]: 'native-client'
        },
        defaultSource: 'agent-gateway-test',
        defaultRuntime: 'native',
        requestIdPrefix: 'agw'
    });

    assert.deepEqual(requestContext, {
        requestId: 'req-governed-001',
        sessionId: 'sess-governed-001',
        agentId: 'Ariadne',
        source: 'native-client',
        runtime: 'native'
    });

    const idempotencyKey = resolveGovernedIdempotencyKey({
        body: {
            options: {
                idempotencyKey: 'tool-idem-001'
            }
        },
        headers: {},
        pluginManager: {}
    });

    assert.equal(idempotencyKey, 'tool-idem-001');
    assert.deepEqual(GATEWAY_CAPABILITY_SECTIONS, ['tools', 'memory', 'context', 'jobs', 'events']);
});
