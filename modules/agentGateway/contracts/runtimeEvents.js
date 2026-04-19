const crypto = require('crypto');

const JOB_EVENT_TYPES = Object.freeze({
    ACCEPTED: 'job.accepted',
    RUNNING: 'job.running',
    WAITING_APPROVAL: 'job.waiting_approval',
    COMPLETED: 'job.completed',
    FAILED: 'job.failed',
    CANCELLED: 'job.cancelled'
});

function normalizeRuntimeEventString(value) {
    return typeof value === 'string' ? value.trim() : '';
}

function createEventId() {
    if (typeof crypto.randomUUID === 'function') {
        return `evt_${crypto.randomUUID()}`;
    }
    return `evt_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

function createRuntimeEvent({
    eventType,
    jobId,
    requestId,
    agentId,
    sessionId,
    gatewayId,
    data
}) {
    return {
        eventId: createEventId(),
        eventType: normalizeRuntimeEventString(eventType),
        jobId: normalizeRuntimeEventString(jobId),
        requestId: normalizeRuntimeEventString(requestId),
        agentId: normalizeRuntimeEventString(agentId),
        sessionId: normalizeRuntimeEventString(sessionId),
        gatewayId: normalizeRuntimeEventString(gatewayId),
        timestamp: new Date().toISOString(),
        data: data && typeof data === 'object' ? { ...data } : {}
    };
}

function filterRuntimeEvents(events, filters = {}) {
    const normalizedJobId = normalizeRuntimeEventString(filters.jobId);
    const normalizedAgentId = normalizeRuntimeEventString(filters.agentId);
    const normalizedSessionId = normalizeRuntimeEventString(filters.sessionId);

    return events.filter((event) => {
        if (normalizedJobId && event.jobId !== normalizedJobId) {
            return false;
        }
        if (normalizedAgentId && event.agentId !== normalizedAgentId) {
            return false;
        }
        if (normalizedSessionId && event.sessionId !== normalizedSessionId) {
            return false;
        }
        return true;
    });
}

module.exports = {
    JOB_EVENT_TYPES,
    createRuntimeEvent,
    filterRuntimeEvents
};
