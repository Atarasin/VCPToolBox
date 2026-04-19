const crypto = require('crypto');

const {
    AGW_ERROR_CODES
} = require('../contracts/errorCodes');

const DEFAULT_MAX_RECENT_REJECTIONS = 20;

function normalizeOperabilityString(value, maxLength = 128) {
    if (typeof value !== 'string') {
        return '';
    }
    const normalizedValue = value.trim();
    if (!normalizedValue) {
        return '';
    }
    return normalizedValue.slice(0, maxLength);
}

function normalizePositiveInteger(value, fallbackValue = 0) {
    const normalizedValue = Number(value);
    return Number.isInteger(normalizedValue) && normalizedValue > 0 ? normalizedValue : fallbackValue;
}

function normalizeBoolean(value, fallbackValue = false) {
    if (typeof value === 'boolean') {
        return value;
    }
    if (typeof value === 'string') {
        const normalizedValue = value.trim().toLowerCase();
        if (normalizedValue === 'true') {
            return true;
        }
        if (normalizedValue === 'false') {
            return false;
        }
    }
    return fallbackValue;
}

function createTraceId(prefix = 'agt') {
    return `${prefix}_${crypto.randomUUID().replace(/-/g, '').slice(0, 24)}`;
}

function getOperationalConfig(pluginManager) {
    const config = pluginManager?.agentGatewayOperationalConfig ||
        pluginManager?.agentGatewayOperabilityConfig ||
        pluginManager?.openClawBridgeConfig?.agentGateway?.operability ||
        {};
    const defaults = config.defaults && typeof config.defaults === 'object' ? config.defaults : {};
    const operations = config.operations && typeof config.operations === 'object' ? config.operations : {};

    return {
        enabled: normalizeBoolean(config.enabled, true),
        maxRecentRejections: normalizePositiveInteger(
            config.maxRecentRejections,
            DEFAULT_MAX_RECENT_REJECTIONS
        ),
        defaults,
        operations
    };
}

function normalizeOperationPolicy(policy = {}) {
    if (!policy || typeof policy !== 'object') {
        return {
            rateLimit: null,
            concurrencyLimit: 0,
            payloadBytes: 0
        };
    }

    const rateLimit = policy.rateLimit && typeof policy.rateLimit === 'object'
        ? {
            limit: normalizePositiveInteger(policy.rateLimit.limit),
            windowMs: normalizePositiveInteger(policy.rateLimit.windowMs)
        }
        : null;

    return {
        rateLimit: rateLimit && rateLimit.limit > 0 && rateLimit.windowMs > 0 ? rateLimit : null,
        concurrencyLimit: normalizePositiveInteger(policy.concurrencyLimit || policy.concurrency?.limit),
        payloadBytes: normalizePositiveInteger(
            policy.payloadBytes || policy.payload?.maxBytes || policy.maxPayloadBytes
        )
    };
}

function resolveOperationPolicy(config, operationName) {
    const defaultPolicy = normalizeOperationPolicy(config.defaults);
    const operationPolicy = normalizeOperationPolicy(config.operations?.[operationName]);

    return {
        rateLimit: operationPolicy.rateLimit || defaultPolicy.rateLimit,
        concurrencyLimit: operationPolicy.concurrencyLimit || defaultPolicy.concurrencyLimit,
        payloadBytes: operationPolicy.payloadBytes || defaultPolicy.payloadBytes
    };
}

function createMetricEntry(operationName, policy) {
    return {
        operationName,
        policy: {
            rateLimit: policy.rateLimit ? { ...policy.rateLimit } : null,
            concurrencyLimit: policy.concurrencyLimit || 0,
            payloadBytes: policy.payloadBytes || 0
        },
        totals: {
            attempted: 0,
            succeeded: 0,
            failed: 0,
            rejected: 0,
            rejectedRateLimit: 0,
            rejectedConcurrency: 0,
            rejectedPayload: 0
        },
        active: 0,
        lastTraceId: '',
        lastRequestId: '',
        lastOutcome: '',
        lastUpdatedAt: null
    };
}

function createGovernanceError({
    requestId,
    traceId,
    operationName,
    httpStatus,
    code,
    error,
    details,
    retryAfterMs
}) {
    const normalizedRetryAfterMs = normalizePositiveInteger(retryAfterMs);

    return {
        requestId,
        traceId,
        operationName,
        httpStatus,
        code,
        error,
        details: {
            operationName,
            traceId,
            ...(details && typeof details === 'object' ? details : {})
        },
        headers: normalizedRetryAfterMs > 0
            ? {
                'retry-after': Math.max(1, Math.ceil(normalizedRetryAfterMs / 1000))
            }
            : {}
    };
}

function createRecentRejectionEntry({
    traceId,
    requestId,
    operationName,
    code,
    reason,
    retryAfterMs,
    subjectKey,
    timestamp
}) {
    return {
        traceId,
        requestId,
        operationName,
        code,
        reason,
        retryAfterMs: normalizePositiveInteger(retryAfterMs),
        subjectKey,
        timestamp: new Date(timestamp).toISOString()
    };
}

/**
 * 共享 Agent Gateway 运营保护与指标服务。
 * 第一阶段保持实例内存实现，先为 Native Gateway 提供统一的限流、并发和观测语义。
 */
function createOperabilityService(deps = {}) {
    const pluginManager = deps.pluginManager;
    if (!pluginManager) {
        throw new Error('[OperabilityService] pluginManager is required');
    }

    const config = getOperationalConfig(pluginManager);
    const now = typeof deps.now === 'function' ? deps.now : () => Date.now();
    const auditLogger = deps.auditLogger && typeof deps.auditLogger.logGatewayOperation === 'function'
        ? deps.auditLogger
        : {
            logGatewayOperation() {}
        };

    const metricsByOperation = new Map();
    const activeBySubject = new Map();
    const rateWindowBySubject = new Map();
    const recentRejections = [];

    function getMetricEntry(operationName) {
        const normalizedOperationName = normalizeOperabilityString(operationName) || 'unknown';
        if (!metricsByOperation.has(normalizedOperationName)) {
            metricsByOperation.set(
                normalizedOperationName,
                createMetricEntry(normalizedOperationName, resolveOperationPolicy(config, normalizedOperationName))
            );
        }
        return metricsByOperation.get(normalizedOperationName);
    }

    function createSubjectKey(operationName, requestContext = {}, authContext = {}) {
        return [
            normalizeOperabilityString(operationName) || 'unknown',
            normalizeOperabilityString(authContext.gatewayId) || 'anonymous',
            normalizeOperabilityString(requestContext.agentId) || 'no-agent'
        ].join('::');
    }

    function pruneRateWindow(subjectKey, windowMs, timestamp) {
        if (!subjectKey || !windowMs) {
            return [];
        }
        const timestamps = rateWindowBySubject.get(subjectKey) || [];
        const cutoff = timestamp - windowMs;
        const prunedTimestamps = timestamps.filter((entry) => entry > cutoff);
        rateWindowBySubject.set(subjectKey, prunedTimestamps);
        return prunedTimestamps;
    }

    function recordRejection(rejection, subjectKey) {
        const metricEntry = getMetricEntry(rejection.operationName);
        metricEntry.totals.rejected += 1;
        metricEntry.lastTraceId = rejection.traceId;
        metricEntry.lastRequestId = rejection.requestId;
        metricEntry.lastOutcome = 'rejected';
        metricEntry.lastUpdatedAt = new Date(now()).toISOString();

        if (rejection.code === AGW_ERROR_CODES.RATE_LIMITED) {
            metricEntry.totals.rejectedRateLimit += 1;
        } else if (rejection.code === AGW_ERROR_CODES.CONCURRENCY_LIMITED) {
            metricEntry.totals.rejectedConcurrency += 1;
        } else if (rejection.code === AGW_ERROR_CODES.PAYLOAD_TOO_LARGE) {
            metricEntry.totals.rejectedPayload += 1;
        }

        recentRejections.unshift(createRecentRejectionEntry({
            ...rejection,
            subjectKey,
            reason: rejection.details?.reason || '',
            timestamp: now()
        }));
        recentRejections.splice(config.maxRecentRejections);

        auditLogger.logGatewayOperation('request.rejected', {
            requestId: rejection.requestId,
            traceId: rejection.traceId,
            operationName: rejection.operationName,
            code: rejection.code,
            reason: rejection.details?.reason || '',
            retryAfterMs: rejection.details?.retryAfterMs || 0
        });
    }

    return {
        beginRequest({ operationName, requestContext, authContext, payloadBytes } = {}) {
            const normalizedOperationName = normalizeOperabilityString(operationName) || 'unknown';
            const requestId = normalizeOperabilityString(requestContext?.requestId, 128);
            const traceId = createTraceId('agwop');
            const timestamp = now();
            const subjectKey = createSubjectKey(normalizedOperationName, requestContext, authContext);
            const policy = resolveOperationPolicy(config, normalizedOperationName);
            const metricEntry = getMetricEntry(normalizedOperationName);
            const normalizedPayloadBytes = normalizePositiveInteger(payloadBytes);

            metricEntry.totals.attempted += 1;
            metricEntry.lastTraceId = traceId;
            metricEntry.lastRequestId = requestId;
            metricEntry.lastUpdatedAt = new Date(timestamp).toISOString();

            if (config.enabled && policy.payloadBytes > 0 && normalizedPayloadBytes > policy.payloadBytes) {
                const rejection = createGovernanceError({
                    requestId,
                    traceId,
                    operationName: normalizedOperationName,
                    httpStatus: 413,
                    code: AGW_ERROR_CODES.PAYLOAD_TOO_LARGE,
                    error: 'Request payload exceeds the configured operation limit',
                    details: {
                        reason: 'payload_too_large',
                        payloadBytes: normalizedPayloadBytes,
                        maxPayloadBytes: policy.payloadBytes
                    }
                });
                recordRejection(rejection, subjectKey);
                return {
                    allowed: false,
                    traceId,
                    operationName: normalizedOperationName,
                    rejection
                };
            }

            if (config.enabled && policy.rateLimit) {
                const rateWindow = pruneRateWindow(subjectKey, policy.rateLimit.windowMs, timestamp);
                if (rateWindow.length >= policy.rateLimit.limit) {
                    const retryAfterMs = Math.max(0, rateWindow[0] + policy.rateLimit.windowMs - timestamp);
                    const rejection = createGovernanceError({
                        requestId,
                        traceId,
                        operationName: normalizedOperationName,
                        httpStatus: 429,
                        code: AGW_ERROR_CODES.RATE_LIMITED,
                        error: 'Request rate limit exceeded for this operation',
                        details: {
                            reason: 'rate_limited',
                            retryAfterMs,
                            limit: policy.rateLimit.limit,
                            windowMs: policy.rateLimit.windowMs
                        },
                        retryAfterMs
                    });
                    recordRejection(rejection, subjectKey);
                    return {
                        allowed: false,
                        traceId,
                        operationName: normalizedOperationName,
                        rejection
                    };
                }
                rateWindow.push(timestamp);
                rateWindowBySubject.set(subjectKey, rateWindow);
            }

            if (config.enabled && policy.concurrencyLimit > 0) {
                const activeCount = activeBySubject.get(subjectKey) || 0;
                if (activeCount >= policy.concurrencyLimit) {
                    const rejection = createGovernanceError({
                        requestId,
                        traceId,
                        operationName: normalizedOperationName,
                        httpStatus: 429,
                        code: AGW_ERROR_CODES.CONCURRENCY_LIMITED,
                        error: 'Operation concurrency limit exceeded',
                        details: {
                            reason: 'concurrency_limited',
                            activeRequests: activeCount,
                            concurrencyLimit: policy.concurrencyLimit
                        }
                    });
                    recordRejection(rejection, subjectKey);
                    return {
                        allowed: false,
                        traceId,
                        operationName: normalizedOperationName,
                        rejection
                    };
                }
            }

            activeBySubject.set(subjectKey, (activeBySubject.get(subjectKey) || 0) + 1);
            metricEntry.active += 1;
            metricEntry.lastOutcome = 'started';

            auditLogger.logGatewayOperation('request.started', {
                requestId,
                traceId,
                operationName: normalizedOperationName,
                payloadBytes: normalizedPayloadBytes
            });

            let finished = false;

            return {
                allowed: true,
                traceId,
                operationName: normalizedOperationName,
                finish({ outcome, code } = {}) {
                    if (finished) {
                        return;
                    }
                    finished = true;

                    const currentActive = activeBySubject.get(subjectKey) || 0;
                    if (currentActive <= 1) {
                        activeBySubject.delete(subjectKey);
                    } else {
                        activeBySubject.set(subjectKey, currentActive - 1);
                    }
                    metricEntry.active = Math.max(0, metricEntry.active - 1);
                    metricEntry.lastTraceId = traceId;
                    metricEntry.lastRequestId = requestId;
                    metricEntry.lastUpdatedAt = new Date(now()).toISOString();

                    if (outcome === 'success') {
                        metricEntry.totals.succeeded += 1;
                        metricEntry.lastOutcome = 'success';
                    } else {
                        metricEntry.totals.failed += 1;
                        metricEntry.lastOutcome = 'failure';
                    }

                    auditLogger.logGatewayOperation(`request.${outcome === 'success' ? 'completed' : 'failed'}`, {
                        requestId,
                        traceId,
                        operationName: normalizedOperationName,
                        code: normalizeOperabilityString(code, 64)
                    });
                }
            };
        },

        getMetricsSnapshot() {
            const operations = Array.from(metricsByOperation.values())
                .sort((left, right) => left.operationName.localeCompare(right.operationName))
                .map((entry) => ({
                    operationName: entry.operationName,
                    policy: {
                        rateLimit: entry.policy.rateLimit ? { ...entry.policy.rateLimit } : null,
                        concurrencyLimit: entry.policy.concurrencyLimit,
                        payloadBytes: entry.policy.payloadBytes
                    },
                    active: entry.active,
                    totals: { ...entry.totals },
                    lastTraceId: entry.lastTraceId,
                    lastRequestId: entry.lastRequestId,
                    lastOutcome: entry.lastOutcome,
                    lastUpdatedAt: entry.lastUpdatedAt
                }));

            return {
                totals: operations.reduce((accumulator, operation) => ({
                    attempted: accumulator.attempted + operation.totals.attempted,
                    succeeded: accumulator.succeeded + operation.totals.succeeded,
                    failed: accumulator.failed + operation.totals.failed,
                    rejected: accumulator.rejected + operation.totals.rejected,
                    active: accumulator.active + operation.active
                }), {
                    attempted: 0,
                    succeeded: 0,
                    failed: 0,
                    rejected: 0,
                    active: 0
                }),
                operations,
                recentRejections: recentRejections.map((entry) => ({ ...entry }))
            };
        }
    };
}

module.exports = {
    createOperabilityService,
    getOperationalConfig,
    resolveOperationPolicy
};
