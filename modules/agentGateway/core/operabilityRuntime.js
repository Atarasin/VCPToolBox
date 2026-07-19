const { AGW_ERROR_CODES } = require('../contracts/errorCodes');
const { resolveTraceId } = require('../infra/trace');

function getMetricEntry(state, operationName) {
    const normalized = state.helpers.normalizeString(operationName) || 'unknown';
    if (!state.metrics.has(normalized)) {
        state.metrics.set(normalized, state.helpers.createMetricEntry(
            normalized,
            state.helpers.resolvePolicy(state.config, normalized)
        ));
    }
    return state.metrics.get(normalized);
}

function createSubjectKey(state, operationName, requestContext = {}, authContext = {}) {
    return [
        state.helpers.normalizeString(operationName) || 'unknown',
        state.helpers.normalizeString(authContext.gatewayId) || 'anonymous',
        state.helpers.normalizeString(requestContext.agentId) || 'no-agent'
    ].join('::');
}

function pruneRateWindow(state, subjectKey, windowMs, timestamp) {
    const timestamps = state.rateWindows.get(subjectKey) || [];
    const pruned = timestamps.filter((entry) => entry > timestamp - windowMs);
    state.rateWindows.set(subjectKey, pruned);
    return pruned;
}

function recordRejection(state, rejection, subjectKey) {
    const metric = getMetricEntry(state, rejection.operationName);
    metric.totals.rejected += 1;
    metric.lastTraceId = rejection.traceId;
    metric.lastRequestId = rejection.requestId;
    metric.lastOutcome = 'rejected';
    metric.lastUpdatedAt = new Date(state.now()).toISOString();
    if (rejection.code === AGW_ERROR_CODES.RATE_LIMITED) metric.totals.rejectedRateLimit += 1;
    if (rejection.code === AGW_ERROR_CODES.CONCURRENCY_LIMITED) metric.totals.rejectedConcurrency += 1;
    if (rejection.code === AGW_ERROR_CODES.PAYLOAD_TOO_LARGE) metric.totals.rejectedPayload += 1;
    state.rejections.unshift(state.helpers.createRecentRejection({
        ...rejection, subjectKey, reason: rejection.details?.reason || '', timestamp: state.now()
    }));
    state.rejections.splice(state.config.maxRecentRejections);
    state.audit.logGatewayOperation('request.rejected', {
        requestId: rejection.requestId, traceId: rejection.traceId,
        operationName: rejection.operationName, code: rejection.code,
        reason: rejection.details?.reason || '', retryAfterMs: rejection.details?.retryAfterMs || 0
    });
}

function rejectRequest(state, subjectKey, details) {
    const rejection = state.helpers.createGovernanceError(details);
    recordRejection(state, rejection, subjectKey);
    return { allowed: false, traceId: details.traceId, operationName: details.operationName, rejection };
}

function finishRequest(state, control, outcome, code) {
    const current = state.active.get(control.subjectKey) || 0;
    if (current <= 1) state.active.delete(control.subjectKey);
    else state.active.set(control.subjectKey, current - 1);
    control.metric.active = Math.max(0, control.metric.active - 1);
    control.metric.lastTraceId = control.traceId;
    control.metric.lastRequestId = control.requestId;
    control.metric.lastUpdatedAt = new Date(state.now()).toISOString();
    if (outcome === 'success') control.metric.totals.succeeded += 1;
    else control.metric.totals.failed += 1;
    control.metric.lastOutcome = outcome === 'success' ? 'success' : 'failure';
    state.audit.logGatewayOperation(`request.${outcome === 'success' ? 'completed' : 'failed'}`, {
        requestId: control.requestId, traceId: control.traceId,
        operationName: control.operationName, code: state.helpers.normalizeString(code, 64),
        ...(control.auditIdentity || {})
    });
}

function buildAuditIdentityFields(state, requestContext, authContext) {
    // M1 门禁第 6 条：审计事件包含 credential 身份链（不含 token/digest/pepper）。
    const fields = {};
    const identitySource = authContext || {};
    for (const [auditKey, sourceKey] of [
        ['credentialId', 'credentialId'],
        ['credentialRevision', 'credentialRevision'],
        ['credentialSubject', 'credentialSubject'],
        ['effectiveAgentId', 'effectiveAgentId'],
        ['targetAgentId', 'targetAgentId']
    ]) {
        const value = state.helpers.normalizeString(identitySource[sourceKey], 256);
        if (value) fields[auditKey] = value;
    }
    const boundAgent = state.helpers.normalizeString(
        identitySource.credentialRecord?.boundAgentId || identitySource.boundAgentId, 256);
    if (boundAgent) fields.boundAgentId = boundAgent;
    const agentId = state.helpers.normalizeString(identitySource.agentId || requestContext?.agentId, 256);
    if (agentId && !fields.effectiveAgentId) fields.effectiveAgentId = agentId;
    return fields;
}

function beginRequest(state, { operationName, requestContext, authContext, payloadBytes } = {}) {
    const name = state.helpers.normalizeString(operationName) || 'unknown';
    const requestId = state.helpers.normalizeString(requestContext?.requestId, 128);
    const traceId = resolveTraceId(requestContext?.traceId, 'agwop');
    const auditIdentity = buildAuditIdentityFields(state, requestContext, authContext);
    const timestamp = state.now();
    const subjectKey = createSubjectKey(state, name, requestContext, authContext);
    const policy = state.helpers.resolvePolicy(state.config, name);
    const metric = getMetricEntry(state, name);
    const bytes = state.helpers.normalizePositiveInteger(payloadBytes);
    metric.totals.attempted += 1;
    Object.assign(metric, { lastTraceId: traceId, lastRequestId: requestId, lastUpdatedAt: new Date(timestamp).toISOString() });

    if (state.config.enabled && policy.payloadBytes > 0 && bytes > policy.payloadBytes) {
        return rejectRequest(state, subjectKey, {
            requestId, traceId, operationName: name, httpStatus: 413,
            code: AGW_ERROR_CODES.PAYLOAD_TOO_LARGE,
            error: 'Request payload exceeds the configured operation limit',
            details: { reason: 'payload_too_large', payloadBytes: bytes, maxPayloadBytes: policy.payloadBytes }
        });
    }
    if (state.config.enabled && policy.rateLimit) {
        const window = pruneRateWindow(state, subjectKey, policy.rateLimit.windowMs, timestamp);
        if (window.length >= policy.rateLimit.limit) {
            const retryAfterMs = Math.max(0, window[0] + policy.rateLimit.windowMs - timestamp);
            return rejectRequest(state, subjectKey, {
                requestId, traceId, operationName: name, httpStatus: 429,
                code: AGW_ERROR_CODES.RATE_LIMITED, error: 'Request rate limit exceeded for this operation',
                details: { reason: 'rate_limited', retryAfterMs, ...policy.rateLimit }, retryAfterMs
            });
        }
        window.push(timestamp);
        state.rateWindows.set(subjectKey, window);
    }
    const activeCount = state.active.get(subjectKey) || 0;
    if (state.config.enabled && policy.concurrencyLimit > 0 && activeCount >= policy.concurrencyLimit) {
        return rejectRequest(state, subjectKey, {
            requestId, traceId, operationName: name, httpStatus: 429,
            code: AGW_ERROR_CODES.CONCURRENCY_LIMITED, error: 'Operation concurrency limit exceeded',
            details: { reason: 'concurrency_limited', activeRequests: activeCount, concurrencyLimit: policy.concurrencyLimit }
        });
    }
    state.active.set(subjectKey, activeCount + 1);
    metric.active += 1;
    metric.lastOutcome = 'started';
    state.audit.logGatewayOperation('request.started', { requestId, traceId, operationName: name, payloadBytes: bytes, ...auditIdentity });
    let finished = false;
    return {
        allowed: true, traceId, operationName: name,
        finish({ outcome, code } = {}) {
            if (finished) return;
            finished = true;
            finishRequest(state, { subjectKey, metric, traceId, requestId, operationName: name, auditIdentity }, outcome, code);
        }
    };
}

function getMetricsSnapshot(state) {
    const operations = Array.from(state.metrics.values()).sort((a, b) => a.operationName.localeCompare(b.operationName))
        .map((entry) => ({
            operationName: entry.operationName,
            policy: { ...entry.policy, rateLimit: entry.policy.rateLimit ? { ...entry.policy.rateLimit } : null },
            active: entry.active, totals: { ...entry.totals }, lastTraceId: entry.lastTraceId,
            lastRequestId: entry.lastRequestId, lastOutcome: entry.lastOutcome, lastUpdatedAt: entry.lastUpdatedAt
        }));
    return {
        totals: operations.reduce((total, operation) => ({
            attempted: total.attempted + operation.totals.attempted,
            succeeded: total.succeeded + operation.totals.succeeded,
            failed: total.failed + operation.totals.failed,
            rejected: total.rejected + operation.totals.rejected,
            active: total.active + operation.active
        }), { attempted: 0, succeeded: 0, failed: 0, rejected: 0, active: 0 }),
        operations,
        recentRejections: state.rejections.map((entry) => ({ ...entry }))
    };
}

function createOperabilityRuntime({ config, now, audit, helpers }) {
    const state = {
        config, now, audit, helpers,
        metrics: new Map(), active: new Map(), rateWindows: new Map(), rejections: []
    };
    return {
        beginRequest: (input) => beginRequest(state, input),
        getMetricsSnapshot: () => getMetricsSnapshot(state)
    };
}

module.exports = { createOperabilityRuntime };
