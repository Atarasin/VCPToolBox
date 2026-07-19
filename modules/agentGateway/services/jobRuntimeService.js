const crypto = require('crypto');
const {
    AGW_ERROR_CODES
} = require('../contracts/errorCodes');
const {
    JOB_EVENT_TYPES,
    createRuntimeEvent,
    filterRuntimeEvents
} = require('../contracts/runtimeEvents');

const JOB_STATUS = Object.freeze({
    ACCEPTED: 'accepted',
    RUNNING: 'running',
    WAITING_APPROVAL: 'waiting_approval',
    COMPLETED: 'completed',
    FAILED: 'failed',
    CANCELLED: 'cancelled'
});

const CANCELLABLE_JOB_STATUSES = new Set([
    JOB_STATUS.ACCEPTED,
    JOB_STATUS.RUNNING,
    JOB_STATUS.WAITING_APPROVAL
]);

const TERMINAL_JOB_STATUSES = new Set([
    JOB_STATUS.COMPLETED,
    JOB_STATUS.FAILED,
    JOB_STATUS.CANCELLED
]);

const {
    SESSION_STATES,
    applyAdoption,
    authorizeIndirectAccess
} = require('../policy/indirectObjectOwnership');

function normalizeJobRuntimeString(value) {
    return typeof value === 'string' ? value.trim() : '';
}

function createJobId() {
    if (typeof crypto.randomUUID === 'function') {
        return `job_${crypto.randomUUID()}`;
    }
    return `job_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

function buildAuthSnapshot(authContext) {
    const snapshot = {
        requestId: normalizeJobRuntimeString(authContext?.requestId),
        sessionId: normalizeJobRuntimeString(authContext?.sessionId),
        agentId: normalizeJobRuntimeString(authContext?.agentId),
        source: normalizeJobRuntimeString(authContext?.source),
        runtime: normalizeJobRuntimeString(authContext?.runtime),
        gatewayId: normalizeJobRuntimeString(authContext?.gatewayId),
        authMode: normalizeJobRuntimeString(authContext?.authMode),
        authSource: normalizeJobRuntimeString(authContext?.authSource)
    };
    // §3.4 / M1.S6.T1：创建时固化服务端 owner snapshot（不信任调用方声明）。
    const credentialSubject = normalizeJobRuntimeString(authContext?.credentialSubject);
    if (credentialSubject) {
        snapshot.owner = {
            credentialSubject,
            credentialId: normalizeJobRuntimeString(authContext?.credentialId),
            credentialRevision: normalizeJobRuntimeString(authContext?.credentialRevision),
            effectiveAgentId: normalizeJobRuntimeString(authContext?.effectiveAgentId || authContext?.agentId) || null,
            trustedSessionId: normalizeJobRuntimeString(authContext?.trustedSessionId) || null,
            credentialRecord: authContext?.credentialRecord && typeof authContext.credentialRecord === 'object'
                ? { ...authContext.credentialRecord }
                : null
        };
    }
    return snapshot;
}

function buildRequesterContextFromAuth(authContext) {
    const credentialSubject = normalizeJobRuntimeString(authContext?.credentialSubject);
    if (!credentialSubject) {
        return null;
    }
    const record = authContext?.credentialRecord && typeof authContext.credentialRecord === 'object'
        ? authContext.credentialRecord
        : null;
    return {
        ok: true,
        credentialSubject,
        credentialId: normalizeJobRuntimeString(authContext?.credentialId),
        credentialRevision: normalizeJobRuntimeString(authContext?.credentialRevision),
        credential: record,
        isAdmin: Array.isArray(record?.scopes) && record.scopes.includes('admin')
    };
}

function mapStatusToEventType(status) {
    switch (status) {
    case JOB_STATUS.ACCEPTED:
        return JOB_EVENT_TYPES.ACCEPTED;
    case JOB_STATUS.RUNNING:
        return JOB_EVENT_TYPES.RUNNING;
    case JOB_STATUS.WAITING_APPROVAL:
        return JOB_EVENT_TYPES.WAITING_APPROVAL;
    case JOB_STATUS.COMPLETED:
        return JOB_EVENT_TYPES.COMPLETED;
    case JOB_STATUS.FAILED:
        return JOB_EVENT_TYPES.FAILED;
    case JOB_STATUS.CANCELLED:
        return JOB_EVENT_TYPES.CANCELLED;
    default:
        return '';
    }
}

function buildJobRecord({ jobId, status, operation, authContext, metadata, target }) {
    const now = new Date().toISOString();
    return {
        jobId: jobId || createJobId(),
        status,
        operation: normalizeJobRuntimeString(operation),
        target: target && typeof target === 'object' ? { ...target } : null,
        metadata: metadata && typeof metadata === 'object' ? { ...metadata } : {},
        authContext: buildAuthSnapshot(authContext),
        createdAt: now,
        updatedAt: now,
        terminal: TERMINAL_JOB_STATUSES.has(status)
    };
}

function cloneJob(job) {
    if (!job || typeof job !== 'object') {
        return job;
    }
    // 出站快照：owner（含 credentialRecord.tokenDigest、原始 trustedSessionId）
    // 与 adoptionAudit 只存在于服务端 store，绝不进客户端响应（§3.4 / 05 第 6 条）。
    let authContext = job.authContext;
    if (authContext && typeof authContext === 'object') {
        const { owner: _owner, adoptionAudit: _adoptionAudit, ...publicAuthContext } = authContext;
        authContext = publicAuthContext;
    }
    return {
        ...job,
        target: job.target && typeof job.target === 'object' ? { ...job.target } : job.target,
        metadata: job.metadata && typeof job.metadata === 'object' ? { ...job.metadata } : job.metadata,
        authContext
    };
}

function canAccessJob(job, authContext, { allowAdoption = true } = {}) {
    if (!authContext || typeof authContext !== 'object') {
        return true;
    }

    const owner = job?.authContext?.owner;
    const requesterContext = buildRequesterContextFromAuth(authContext);
    if (owner && requesterContext) {
        const decision = authorizeIndirectAccess({
            owner,
            requesterContext,
            requesterSessionId: normalizeJobRuntimeString(authContext.trustedSessionId) || null,
            ownerSessionState: authContext.ownerSessionState || SESSION_STATES.UNKNOWN
        });
        if (decision.allowed && decision.adoption && allowAdoption) {
            // 首次收养：原子替换 owner 的 trustedSessionId 并留下审计标记
            job.authContext.owner = { ...applyAdoption(owner, decision.adoption) };
            job.authContext.adoptionAudit = {
                previousTrustedSessionId: decision.adoption.previousTrustedSessionId,
                newTrustedSessionId: decision.adoption.newTrustedSessionId,
                at: new Date().toISOString()
            };
        }
        return decision.allowed;
    }
    if (owner && !requesterContext) {
        // 有 owner 的对象不接受无凭据身份的访问
        return false;
    }

    const requestedAgentId = normalizeJobRuntimeString(authContext.agentId);
    const requestedSessionId = normalizeJobRuntimeString(authContext.sessionId);
    const requestedGatewayId = normalizeJobRuntimeString(authContext.gatewayId);

    if (requestedAgentId && requestedAgentId !== normalizeJobRuntimeString(job?.authContext?.agentId)) {
        return false;
    }
    if (requestedSessionId && requestedSessionId !== normalizeJobRuntimeString(job?.authContext?.sessionId)) {
        return false;
    }
    if (requestedGatewayId && requestedGatewayId !== normalizeJobRuntimeString(job?.authContext?.gatewayId)) {
        return false;
    }
    return true;
}

function createMissingJobResult(jobId) {
    return {
        success: false,
        status: 404,
        code: AGW_ERROR_CODES.NOT_FOUND,
        error: 'Job not found',
        details: {
            jobId: normalizeJobRuntimeString(jobId)
        }
    };
}

function createForbiddenJobResult(jobId) {
    return {
        success: false,
        status: 403,
        code: AGW_ERROR_CODES.FORBIDDEN,
        error: 'Job access is not allowed for this identity',
        details: {
            jobId: normalizeJobRuntimeString(jobId)
        }
    };
}

function createEventSnapshot(event) {
    return {
        ...event,
        data: event.data && typeof event.data === 'object' ? { ...event.data } : event.data
    };
}

/**
 * JobRuntimeService 在 M8 扩展为正式的共享 runtime contract，
 * 负责统一 job 状态、poll/cancel 行为与最小 runtime event 语义。
 */
function createJobStoreApi(store, eventStore) {
    function appendJobEvent(job, extraData = {}) {
        const eventType = mapStatusToEventType(job.status);
        if (!eventType) {
            return null;
        }

        // M8 第一版事件流只围绕 job lifecycle，避免过早引入通用事件总线复杂度。
        const event = createRuntimeEvent({
            eventType,
            jobId: job.jobId,
            requestId: job.authContext?.requestId,
            agentId: job.authContext?.agentId,
            sessionId: job.authContext?.sessionId,
            gatewayId: job.authContext?.gatewayId,
            data: {
                status: job.status,
                operation: job.operation,
                target: job.target,
                metadata: job.metadata,
                ...extraData
            }
        });
        eventStore.push(event);
        return event;
    }

    function saveJob(job, eventData) {
        store.set(job.jobId, job);
        appendJobEvent(job, eventData);
        return cloneJob(job);
    }

    function createJob({ status, operation, authContext, metadata, target }) {
        const job = buildJobRecord({
            status,
            operation,
            authContext,
            metadata,
            target
        });
        return saveJob(job, {
            phase: 'created'
        });
    }

    function updateJob(jobId, updates = {}) {
        const normalizedJobId = normalizeJobRuntimeString(jobId);
        const existingJob = store.get(normalizedJobId);
        if (!existingJob) {
            return createMissingJobResult(normalizedJobId);
        }

        const nextStatus = normalizeJobRuntimeString(updates.status) || existingJob.status;
        const updatedAt = new Date().toISOString();
        const nextMetadata = updates.metadata && typeof updates.metadata === 'object'
            ? {
                ...existingJob.metadata,
                ...updates.metadata
            }
            : { ...existingJob.metadata };

        const nextJob = {
            ...existingJob,
            status: nextStatus,
            metadata: nextMetadata,
            updatedAt,
            terminal: TERMINAL_JOB_STATUSES.has(nextStatus)
        };

        if (nextStatus === JOB_STATUS.COMPLETED) {
            nextJob.completedAt = updatedAt;
        }
        if (nextStatus === JOB_STATUS.FAILED) {
            nextJob.failedAt = updatedAt;
        }
        if (nextStatus === JOB_STATUS.CANCELLED) {
            nextJob.cancelledAt = updatedAt;
        }

        return {
            success: true,
            data: {
                job: saveJob(nextJob, {
                    phase: 'updated',
                    previousStatus: existingJob.status
                })
            }
        };
    }

    return { createJob, updateJob };
}

function createJobRuntimeApi(store, eventStore, jobStore) {
    const { createJob, updateJob } = jobStore;
    return {
        createAcceptedJob({ operation, authContext, metadata, target }) {
            return createJob({
                status: JOB_STATUS.ACCEPTED,
                operation,
                authContext,
                metadata,
                target
            });
        },
        createWaitingApprovalJob({ operation, authContext, metadata, target }) {
            return createJob({
                status: JOB_STATUS.WAITING_APPROVAL,
                operation,
                authContext,
                metadata,
                target
            });
        },
        updateJob,
        completeJob(jobId, metadata) {
            return updateJob(jobId, {
                status: JOB_STATUS.COMPLETED,
                metadata
            });
        },
        failJob(jobId, metadata) {
            return updateJob(jobId, {
                status: JOB_STATUS.FAILED,
                metadata
            });
        },
        pollJob(jobId, authContext) {
            const normalizedJobId = normalizeJobRuntimeString(jobId);
            const job = store.get(normalizedJobId);
            if (!job) {
                return createMissingJobResult(normalizedJobId);
            }
            if (!canAccessJob(job, authContext)) {
                return createForbiddenJobResult(normalizedJobId);
            }
            return {
                success: true,
                data: {
                    job: cloneJob(job)
                }
            };
        },
        cancelJob(jobId, authContext) {
            const normalizedJobId = normalizeJobRuntimeString(jobId);
            const job = store.get(normalizedJobId);
            if (!job) {
                return createMissingJobResult(normalizedJobId);
            }
            if (!canAccessJob(job, authContext)) {
                return createForbiddenJobResult(normalizedJobId);
            }
            if (!CANCELLABLE_JOB_STATUSES.has(job.status)) {
                return {
                    success: false,
                    status: 409,
                    code: AGW_ERROR_CODES.VALIDATION_ERROR,
                    error: 'Job cannot be cancelled in current state',
                    details: {
                        jobId: normalizedJobId,
                        status: job.status
                    }
                };
            }

            return updateJob(normalizedJobId, {
                status: JOB_STATUS.CANCELLED
            });
        },
        listEvents({ authContext, filters } = {}) {
            // §3.4 / M1.S6.T1：事件可见性从关联 job 的服务端 owner snapshot 决议
            // （先 lookup owner 再授权），不使用事件弱字段（agentId/sessionId/
            // gatewayId）合成身份——两侧 gatewayId 同值会导致跨 credential 泄漏。
            // 事件流授权不触发收养（收养只发生在显式 job poll/cancel）。
            const normalizedFilters = filters && typeof filters === 'object' ? filters : {};
            const visibleEvents = filterRuntimeEvents(eventStore, normalizedFilters)
                .filter((event) => {
                    const job = event.jobId ? store.get(event.jobId) : null;
                    if (job) {
                        return canAccessJob(job, authContext, { allowAdoption: false });
                    }
                    // 无关联 job 的孤儿事件退回弱比较（仅限旧数据；新事件均带 jobId）
                    return canAccessJob({
                        authContext: {
                            agentId: event.agentId,
                            sessionId: event.sessionId,
                            gatewayId: event.gatewayId
                        }
                    }, authContext);
                })
                .map(createEventSnapshot);

            return {
                success: true,
                data: {
                    events: visibleEvents
                }
            };
        }
    };
}

function createJobRuntimeService() {
    const store = new Map();
    const eventStore = [];
    return createJobRuntimeApi(store, eventStore, createJobStoreApi(store, eventStore));
}

module.exports = {
    JOB_STATUS,
    createJobRuntimeService
};
