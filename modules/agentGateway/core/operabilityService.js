const {
    AGW_ERROR_CODES
} = require('../contracts/errorCodes');
const { createOperabilityRuntime } = require('./operabilityRuntime');

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
    if (!deps.pluginManager) throw new Error('[OperabilityService] pluginManager is required');
    const audit = deps.auditLogger && typeof deps.auditLogger.logGatewayOperation === 'function'
        ? deps.auditLogger : { logGatewayOperation() {} };
    return createOperabilityRuntime({
        config: getOperationalConfig(deps.pluginManager),
        now: typeof deps.now === 'function' ? deps.now : () => Date.now(),
        audit,
        helpers: {
            createGovernanceError,
            createMetricEntry,
            createRecentRejection: createRecentRejectionEntry,
            normalizePositiveInteger,
            normalizeString: normalizeOperabilityString,
            resolvePolicy: resolveOperationPolicy
        }
    });
}

module.exports = {
    createOperabilityService,
    getOperationalConfig,
    resolveOperationPolicy
};
