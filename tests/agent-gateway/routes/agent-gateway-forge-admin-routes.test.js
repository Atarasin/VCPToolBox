const assert = require('node:assert/strict');
const test = require('node:test');
const express = require('express');

const createForgeAdminRoutes = require('../../../routes/admin/forge');

// AdminPanel「专家铸造」只读接口（/admin_api/forge/*）。
// 鉴权由 /admin_api 挂载层 adminAuth 承担（此处不模拟），模块只测只读数据面。

function createStubPluginManager({ forgeRuntimeService } = {}) {
    return {
        __agentGatewayServiceBundle: {
            forgeRuntimeService: forgeRuntimeService || null
        }
    };
}

async function createServer(pluginManager) {
    const app = express();
    app.use('/admin_api', createForgeAdminRoutes({ pluginManager }));
    const server = await new Promise((resolve) => {
        const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
    });
    return {
        baseUrl: `http://127.0.0.1:${server.address().port}`,
        async close() {
            await new Promise((resolve) => server.close(resolve));
        }
    };
}

test('GET /admin_api/forge/jobs 返回任务摘要列表', async () => {
    const pluginManager = createStubPluginManager({
        forgeRuntimeService: {
            async listJobs() {
                return [{
                    jobId: 'job_forge_1',
                    operation: 'forge.expert.create',
                    type: 'create',
                    expertName: 'UIDesigner',
                    status: 'pending_confirm',
                    terminal: false,
                    currentStep: null,
                    steps: [],
                    costSoFarCny: 0.42,
                    budgetCny: 10,
                    createdAt: '2026-10-11T08:00:00.000Z',
                    updatedAt: '2026-10-11T08:01:00.000Z'
                }];
            }
        }
    });
    const server = await createServer(pluginManager);
    try {
        const response = await fetch(`${server.baseUrl}/admin_api/forge/jobs`);
        assert.equal(response.status, 200);
        const body = await response.json();
        assert.equal(body.status, 'success');
        assert.equal(body.jobs.length, 1);
        assert.equal(body.jobs[0].expertName, 'UIDesigner');
        assert.equal(body.jobs[0].status, 'pending_confirm');
        assert.equal(body.jobs[0].budgetCny, 10);
    } finally {
        await server.close();
    }
});

test('GET /admin_api/forge/jobs/:jobId 返回详情（步骤/费用/产物/事件）', async () => {
    const pluginManager = createStubPluginManager({
        forgeRuntimeService: {
            async getJobDetail(jobId) {
                if (jobId !== 'job_forge_1') {
                    const error = new Error('Job not found');
                    error.status = 404;
                    throw error;
                }
                return {
                    job: { jobId, status: 'running', steps: [], costSoFarCny: 1, budgetCny: 10 },
                    forge: {},
                    run: { jobId, jobKind: 'expert.create', requirement: '造一个 UI 设计专家' },
                    cost: { costSoFarCny: 1, budgetCny: 10, warnThresholdCny: 9, byModel: {}, entries: [] },
                    artifacts: [{ path: 'run.json', bytes: 128 }],
                    events: [{ eventId: 'evt_1', eventType: 'job.running', jobId, timestamp: '2026-10-11T08:00:01.000Z', data: {} }]
                };
            }
        }
    });
    const server = await createServer(pluginManager);
    try {
        const response = await fetch(`${server.baseUrl}/admin_api/forge/jobs/job_forge_1`);
        assert.equal(response.status, 200);
        const body = await response.json();
        assert.equal(body.status, 'success');
        assert.equal(body.job.jobId, 'job_forge_1');
        assert.equal(body.run.requirement, '造一个 UI 设计专家');
        assert.equal(body.artifacts.length, 1);
        assert.equal(body.events.length, 1);

        const missing = await fetch(`${server.baseUrl}/admin_api/forge/jobs/job_missing`);
        assert.equal(missing.status, 404);
        const missingBody = await missing.json();
        assert.equal(missingBody.status, 'error');
    } finally {
        await server.close();
    }
});

test('forge 服务未就绪（bundle 无 forgeRuntimeService）返回 503', async () => {
    const server = await createServer(createStubPluginManager());
    try {
        const response = await fetch(`${server.baseUrl}/admin_api/forge/jobs`);
        assert.equal(response.status, 503);
        const body = await response.json();
        assert.equal(body.status, 'error');
    } finally {
        await server.close();
    }
});
