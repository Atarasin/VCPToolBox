const assert = require('node:assert/strict');
const test = require('node:test');

const {
    JOB_STATUS,
    createJobRuntimeService
} = require('../modules/agentGateway/services/jobRuntimeService');

test('JobRuntimeService creates canonical deferred jobs with stable states', () => {
    const service = createJobRuntimeService();
    const authContext = {
        requestId: 'req-job-001',
        sessionId: 'sess-job-001',
        agentId: 'agent.nova',
        source: 'agent-gateway-tool',
        runtime: 'native',
        gatewayId: 'gw-nova'
    };

    const acceptedJob = service.createAcceptedJob({
        operation: 'tool.invoke',
        authContext,
        target: {
            type: 'tool',
            id: 'RemoteSearch'
        }
    });
    const waitingJob = service.createWaitingApprovalJob({
        operation: 'tool.invoke',
        authContext,
        target: {
            type: 'tool',
            id: 'ProtectedTool'
        }
    });

    assert.equal(acceptedJob.status, JOB_STATUS.ACCEPTED);
    assert.equal(waitingJob.status, JOB_STATUS.WAITING_APPROVAL);
    assert.equal(acceptedJob.authContext.gatewayId, 'gw-nova');
    assert.equal(acceptedJob.terminal, false);
    assert.equal(typeof acceptedJob.jobId, 'string');
    assert.equal(typeof waitingJob.jobId, 'string');
    assert.notEqual(acceptedJob.jobId, waitingJob.jobId);
    assert.equal(typeof acceptedJob.updatedAt, 'string');
});

test('JobRuntimeService supports formal update, poll, cancel and event listing', () => {
    const service = createJobRuntimeService();
    const authContext = {
        requestId: 'req-job-002',
        sessionId: 'sess-job-002',
        agentId: 'agent.secure',
        source: 'openclaw',
        runtime: 'openclaw',
        gatewayId: 'gw-secure'
    };
    const job = service.createWaitingApprovalJob({
        operation: 'tool.invoke',
        authContext,
        metadata: {
            toolName: 'ProtectedTool'
        }
    });

    const updateResult = service.updateJob(job.jobId, {
        status: JOB_STATUS.RUNNING,
        metadata: {
            worker: 'native-runtime'
        }
    });
    const pollResult = service.pollJob(job.jobId, authContext);
    const cancelResult = service.cancelJob(job.jobId, authContext);
    const missingResult = service.pollJob('missing-job-id');
    const eventsResult = service.listEvents({
        authContext,
        filters: {
            jobId: job.jobId
        }
    });

    assert.equal(updateResult.success, true);
    assert.equal(updateResult.data.job.status, JOB_STATUS.RUNNING);
    assert.equal(pollResult.success, true);
    assert.equal(pollResult.data.job.status, JOB_STATUS.RUNNING);
    assert.equal(cancelResult.success, true);
    assert.equal(cancelResult.data.job.status, JOB_STATUS.CANCELLED);
    assert.equal(cancelResult.data.job.terminal, true);
    assert.equal(missingResult.success, false);
    assert.equal(missingResult.code, 'AGW_NOT_FOUND');
    assert.equal(eventsResult.success, true);
    assert.deepEqual(
        eventsResult.data.events.map((event) => event.eventType),
        ['job.waiting_approval', 'job.running', 'job.cancelled']
    );
});

test('JobRuntimeService enforces canonical job ownership on poll and cancel', () => {
    const service = createJobRuntimeService();
    const job = service.createAcceptedJob({
        operation: 'tool.invoke',
        authContext: {
            requestId: 'req-job-003',
            sessionId: 'sess-job-003',
            agentId: 'agent.owner',
            source: 'native',
            runtime: 'native',
            gatewayId: 'gw-owner'
        },
        metadata: {
            toolName: 'RemoteSearch'
        }
    });

    const forbiddenPollResult = service.pollJob(job.jobId, {
        agentId: 'agent.other',
        sessionId: 'sess-job-003',
        gatewayId: 'gw-owner'
    });
    const forbiddenCancelResult = service.cancelJob(job.jobId, {
        agentId: 'agent.owner',
        sessionId: 'sess-other',
        gatewayId: 'gw-owner'
    });

    assert.equal(forbiddenPollResult.success, false);
    assert.equal(forbiddenPollResult.code, 'AGW_FORBIDDEN');
    assert.equal(forbiddenCancelResult.success, false);
    assert.equal(forbiddenCancelResult.code, 'AGW_FORBIDDEN');
});
