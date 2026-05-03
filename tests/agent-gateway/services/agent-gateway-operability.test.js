const assert = require('node:assert/strict');
const test = require('node:test');

const {
    createOperabilityService
} = require('../../../modules/agentGateway/services/operabilityService');
const {
    createPluginManager
} = require('../helpers/agent-gateway-test-helpers');

test('OperabilityService rejects excess rate and records a metrics snapshot', () => {
    let currentTime = Date.parse('2026-04-20T10:00:00.000Z');
    const pluginManager = createPluginManager({
        agentGatewayOperationalConfig: {
            operations: {
                'tool.invoke': {
                    rateLimit: {
                        limit: 1,
                        windowMs: 60000
                    }
                }
            }
        }
    });
    const service = createOperabilityService({
        pluginManager,
        now: () => currentTime
    });
    const baseRequest = {
        operationName: 'tool.invoke',
        requestContext: {
            requestId: 'req-rate-001',
            agentId: 'Ariadne'
        },
        authContext: {
            gatewayId: 'gw-prod'
        },
        payloadBytes: 64
    };

    const firstControl = service.beginRequest(baseRequest);
    assert.equal(firstControl.allowed, true);
    firstControl.finish({ outcome: 'success' });

    currentTime += 1000;
    const secondControl = service.beginRequest({
        ...baseRequest,
        requestContext: {
            ...baseRequest.requestContext,
            requestId: 'req-rate-002'
        }
    });

    assert.equal(secondControl.allowed, false);
    assert.equal(secondControl.rejection.code, 'AGW_RATE_LIMITED');
    assert.equal(secondControl.rejection.details.reason, 'rate_limited');

    const snapshot = service.getMetricsSnapshot();
    const metric = snapshot.operations.find((entry) => entry.operationName === 'tool.invoke');

    assert.equal(snapshot.totals.attempted, 2);
    assert.equal(snapshot.totals.rejected, 1);
    assert.equal(metric.totals.succeeded, 1);
    assert.equal(metric.totals.rejectedRateLimit, 1);
    assert.equal(snapshot.recentRejections[0].requestId, 'req-rate-002');
});

test('OperabilityService rejects excess concurrency until the active request finishes', () => {
    const pluginManager = createPluginManager({
        agentGatewayOperationalConfig: {
            operations: {
                'memory.write': {
                    concurrencyLimit: 1
                }
            }
        }
    });
    const service = createOperabilityService({
        pluginManager
    });
    const firstControl = service.beginRequest({
        operationName: 'memory.write',
        requestContext: {
            requestId: 'req-concurrency-001',
            agentId: 'Ariadne'
        },
        authContext: {
            gatewayId: 'gw-prod'
        },
        payloadBytes: 32
    });

    assert.equal(firstControl.allowed, true);

    const secondControl = service.beginRequest({
        operationName: 'memory.write',
        requestContext: {
            requestId: 'req-concurrency-002',
            agentId: 'Ariadne'
        },
        authContext: {
            gatewayId: 'gw-prod'
        },
        payloadBytes: 32
    });

    assert.equal(secondControl.allowed, false);
    assert.equal(secondControl.rejection.code, 'AGW_CONCURRENCY_LIMITED');

    firstControl.finish({ outcome: 'success' });

    const thirdControl = service.beginRequest({
        operationName: 'memory.write',
        requestContext: {
            requestId: 'req-concurrency-003',
            agentId: 'Ariadne'
        },
        authContext: {
            gatewayId: 'gw-prod'
        },
        payloadBytes: 32
    });

    assert.equal(thirdControl.allowed, true);
    thirdControl.finish({ outcome: 'failure', code: 'AGW_INTERNAL_ERROR' });

    const snapshot = service.getMetricsSnapshot();
    const metric = snapshot.operations.find((entry) => entry.operationName === 'memory.write');

    assert.equal(metric.totals.rejectedConcurrency, 1);
    assert.equal(metric.totals.failed, 1);
    assert.equal(metric.active, 0);
});

test('OperabilityService rejects payloads above the configured limit', () => {
    const pluginManager = createPluginManager({
        agentGatewayOperationalConfig: {
            operations: {
                'context.assemble': {
                    payloadBytes: 128
                }
            }
        }
    });
    const service = createOperabilityService({
        pluginManager
    });
    const control = service.beginRequest({
        operationName: 'context.assemble',
        requestContext: {
            requestId: 'req-payload-001',
            agentId: 'Ariadne'
        },
        authContext: {
            gatewayId: 'gw-prod'
        },
        payloadBytes: 512
    });

    assert.equal(control.allowed, false);
    assert.equal(control.rejection.httpStatus, 413);
    assert.equal(control.rejection.code, 'AGW_PAYLOAD_TOO_LARGE');
    assert.equal(control.rejection.details.maxPayloadBytes, 128);
});
