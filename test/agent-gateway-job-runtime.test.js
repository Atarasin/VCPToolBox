const assert = require('node:assert/strict');
const test = require('node:test');

const {
    JOB_STATUS,
    createJobRuntimeService
} = require('../modules/agentGateway/services/jobRuntimeService');

test('JobRuntimeService creates accepted and waiting_approval job handles', () => {
    const service = createJobRuntimeService();
    const authContext = {
        requestId: 'req-job-001',
        sessionId: 'sess-job-001',
        agentId: 'agent.nova',
        source: 'agent-gateway-tool',
        runtime: 'native'
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
    assert.equal(typeof acceptedJob.jobId, 'string');
    assert.equal(typeof waitingJob.jobId, 'string');
    assert.notEqual(acceptedJob.jobId, waitingJob.jobId);
});

test('JobRuntimeService supports minimal poll and cancel skeleton', () => {
    const service = createJobRuntimeService();
    const job = service.createWaitingApprovalJob({
        operation: 'tool.invoke',
        authContext: {
            requestId: 'req-job-002',
            sessionId: 'sess-job-002',
            agentId: 'agent.secure',
            source: 'openclaw',
            runtime: 'openclaw'
        },
        metadata: {
            toolName: 'ProtectedTool'
        }
    });

    const pollResult = service.pollJob(job.jobId);
    const cancelResult = service.cancelJob(job.jobId);
    const missingResult = service.pollJob('missing-job-id');

    assert.equal(pollResult.success, true);
    assert.equal(pollResult.data.job.status, JOB_STATUS.WAITING_APPROVAL);
    assert.equal(cancelResult.success, true);
    assert.equal(cancelResult.data.job.status, JOB_STATUS.CANCELLED);
    assert.equal(missingResult.success, false);
    assert.equal(missingResult.code, 'AGW_NOT_FOUND');
  });
