const crypto = require('crypto');

const JOB_STATUS = Object.freeze({
    ACCEPTED: 'accepted',
    WAITING_APPROVAL: 'waiting_approval',
    CANCELLED: 'cancelled'
});

function createJobId() {
    if (typeof crypto.randomUUID === 'function') {
        return `job_${crypto.randomUUID()}`;
    }
    return `job_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

function buildJobHandle({ status, operation, authContext, metadata, target }) {
    return {
        jobId: createJobId(),
        status,
        operation,
        target: target || null,
        metadata: metadata || {},
        authContext: {
            requestId: authContext?.requestId || '',
            sessionId: authContext?.sessionId || '',
            agentId: authContext?.agentId || '',
            source: authContext?.source || '',
            runtime: authContext?.runtime || ''
        },
        createdAt: new Date().toISOString()
    };
}

/**
 * JobRuntimeService 在 M6 只提供最小骨架。
 * 它负责标准化 job handle/state，而不是实现完整异步调度器。
 */
function createJobRuntimeService(deps = {}) {
    const store = deps.store || new Map();

    return {
        createAcceptedJob({ operation, authContext, metadata, target }) {
            const job = buildJobHandle({
                status: JOB_STATUS.ACCEPTED,
                operation,
                authContext,
                metadata,
                target
            });
            store.set(job.jobId, job);
            return job;
        },
        createWaitingApprovalJob({ operation, authContext, metadata, target }) {
            const job = buildJobHandle({
                status: JOB_STATUS.WAITING_APPROVAL,
                operation,
                authContext,
                metadata,
                target
            });
            store.set(job.jobId, job);
            return job;
        },
        pollJob(jobId) {
            const job = store.get(jobId);
            if (!job) {
                return {
                    success: false,
                    status: 404,
                    code: 'AGW_NOT_FOUND',
                    error: 'Job not found',
                    details: { jobId }
                };
            }
            return {
                success: true,
                data: {
                    job
                }
            };
        },
        cancelJob(jobId) {
            const job = store.get(jobId);
            if (!job) {
                return {
                    success: false,
                    status: 404,
                    code: 'AGW_NOT_FOUND',
                    error: 'Job not found',
                    details: { jobId }
                };
            }

            const cancelledJob = {
                ...job,
                status: JOB_STATUS.CANCELLED,
                cancelledAt: new Date().toISOString()
            };
            store.set(jobId, cancelledJob);

            return {
                success: true,
                data: {
                    job: cancelledJob
                }
            };
        }
    };
}

module.exports = {
    JOB_STATUS,
    createJobRuntimeService
};
