const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
    createIntegrationSnapshotCoordinator
} = require('../../../modules/agentGateway/composition/integrationSnapshotCoordinator');
const {
    createAgentGuidanceService,
    estimateTokenCount
} = require('../../../modules/agentGateway/services/agentGuidanceService');

const GUIDANCE_FIXTURE = {
    version: 1,
    shared: {
        workflow: [
            '任务依赖历史决策时先调用 gateway_recall_run。',
            '已知日记本才使用 gateway_memory_search。'
        ],
        memoryWritePolicy: {
            write: ['用户偏好与纠正', '已验证结论'],
            skip: ['密钥和敏感数据', '未经确认的推测']
        }
    },
    agents: {
        Ariadne: {
            displayName: '阿里阿德涅',
            memoryDefaults: {
                tags: ['vcp', 'gateway'],
                metadata: { project: 'vcp-toolbox' }
            }
        }
    }
};

async function createTempGuidanceFile(config = GUIDANCE_FIXTURE) {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'agw-guidance-service-'));
    const filePath = path.join(dir, 'agent_guidance.json');
    await fs.writeFile(filePath, JSON.stringify(config, null, 2), 'utf8');
    return { dir, filePath };
}

function createCoordinator(guidancePath, overrides = {}) {
    return createIntegrationSnapshotCoordinator({
        guidanceConfigPath: guidancePath,
        listAgents: overrides.listAgents || (() => [{ alias: 'Ariadne', sourceFile: 'Ariadne.md' }]),
        getMemoryPolicy: overrides.getMemoryPolicy,
        logger: { info() {}, warn() {}, error() {} }
    });
}

function createPolicyResolverStub({ allowed = ['Nova', 'SharedMemory'], defaults = ['Nova'] } = {}) {
    const calls = [];
    return {
        calls,
        async resolvePolicy({ authContext, availableDiaries }) {
            calls.push({ authContext, availableDiaries });
            return {
                allowedDiaryNames: allowed,
                defaultDiaryNames: defaults
            };
        }
    };
}

test('AgentGuidanceService S1 — canonical guidance bundle', async (t) => {
    await t.test('returns the full bundle with memory-policy-injected diaries and snapshot revision', async () => {
        const { dir, filePath } = await createTempGuidanceFile();
        try {
            const coordinator = createCoordinator(filePath);
            const policyResolver = createPolicyResolverStub();
            const service = createAgentGuidanceService({
                snapshotCoordinator: coordinator,
                agentPolicyResolver: policyResolver,
                ragRetrieverPort: { listDiaries: () => ['Nova', 'SharedMemory', 'Other'] }
            });

            const result = await service.getAgentGuidance('Ariadne');
            assert.equal(result.ok, true);
            const guidance = result.guidance;
            assert.equal(guidance.agentId, 'Ariadne');
            assert.equal(guidance.displayName, '阿里阿德涅');
            assert.deepEqual([...guidance.workflow], GUIDANCE_FIXTURE.shared.workflow);
            assert.deepEqual(
                { write: [...guidance.memoryWritePolicy.write], skip: [...guidance.memoryWritePolicy.skip] },
                GUIDANCE_FIXTURE.shared.memoryWritePolicy
            );
            assert.deepEqual([...guidance.allowedDiaries], ['Nova', 'SharedMemory']);
            assert.deepEqual([...guidance.defaultDiaries], ['Nova']);
            assert.deepEqual(structuredClone(guidance.memoryDefaults), GUIDANCE_FIXTURE.agents.Ariadne.memoryDefaults);
            assert.match(guidance.revision, /^sha256:[0-9a-f]{64}$/);
            assert.ok(guidance.updatedAt);

            // diary 注入来源是 memory policy 决议，可用日记本集合已传入
            assert.equal(policyResolver.calls.length, 1);
            assert.equal(policyResolver.calls[0].authContext.agentId, 'Ariadne');
            assert.deepEqual(policyResolver.calls[0].availableDiaries, ['Nova', 'SharedMemory', 'Other']);

            // revision 与冻结 integration snapshot 一致（M2.S1.T3）
            const status = coordinator.getIntegrationStatus();
            assert.equal(guidance.revision, status.snapshot.revision);
            assert.equal(service.getIntegrationRevision(), status.snapshot.revision);
        } finally {
            await fs.rm(dir, { recursive: true, force: true });
        }
    });

    await t.test('unknown agent returns AGW_NOT_FOUND without leaking other agent guidance', async () => {
        const { dir, filePath } = await createTempGuidanceFile();
        try {
            const service = createAgentGuidanceService({
                snapshotCoordinator: createCoordinator(filePath),
                agentPolicyResolver: createPolicyResolverStub(),
                ragRetrieverPort: { listDiaries: () => [] }
            });
            const result = await service.getAgentGuidance('Bard');
            assert.equal(result.ok, false);
            assert.equal(result.code, 'AGW_NOT_FOUND');
            assert.equal(result.httpStatus, 404);
        } finally {
            await fs.rm(dir, { recursive: true, force: true });
        }
    });

    await t.test('missing agentId returns AGW_INVALID_REQUEST', async () => {
        const { dir, filePath } = await createTempGuidanceFile();
        try {
            const service = createAgentGuidanceService({
                snapshotCoordinator: createCoordinator(filePath)
            });
            const result = await service.getAgentGuidance('');
            assert.equal(result.ok, false);
            assert.equal(result.code, 'AGW_INVALID_REQUEST');
            assert.equal(result.httpStatus, 400);
        } finally {
            await fs.rm(dir, { recursive: true, force: true });
        }
    });

    await t.test('initial load failure returns AGW_CONFIG_UNAVAILABLE instead of empty config', async () => {
        const service = createAgentGuidanceService({
            snapshotCoordinator: createCoordinator('/nonexistent/agent_guidance.json'),
            agentPolicyResolver: createPolicyResolverStub(),
            ragRetrieverPort: { listDiaries: () => [] }
        });
        const result = await service.getAgentGuidance('Ariadne');
        assert.equal(result.ok, false);
        assert.equal(result.code, 'AGW_CONFIG_UNAVAILABLE');
        assert.equal(result.httpStatus, 503);
    });

    await t.test('hot reload failure keeps serving the last-known-good bundle and revision', async () => {
        const { dir, filePath } = await createTempGuidanceFile();
        try {
            const coordinator = createCoordinator(filePath);
            const service = createAgentGuidanceService({
                snapshotCoordinator: coordinator,
                agentPolicyResolver: createPolicyResolverStub(),
                ragRetrieverPort: { listDiaries: () => [] }
            });

            const first = await service.getAgentGuidance('Ariadne');
            assert.equal(first.ok, true);
            const goodRevision = first.guidance.revision;

            await fs.writeFile(filePath, '{ this is broken json', 'utf8');
            const second = await service.getAgentGuidance('Ariadne');
            assert.equal(second.ok, true, 'last-known-good must survive hot reload failure');
            assert.equal(second.guidance.revision, goodRevision);
        } finally {
            await fs.rm(dir, { recursive: true, force: true });
        }
    });

    await t.test('concurrent guidance reads coalesce the snapshot refresh', async () => {
        const { dir, filePath } = await createTempGuidanceFile();
        try {
            const coordinator = createCoordinator(filePath);
            let refreshCount = 0;
            const wrapped = {
                ...coordinator,
                refreshIntegrationSnapshot: async () => {
                    refreshCount += 1;
                    return coordinator.refreshIntegrationSnapshot();
                }
            };
            const service = createAgentGuidanceService({
                snapshotCoordinator: wrapped,
                agentPolicyResolver: createPolicyResolverStub(),
                ragRetrieverPort: { listDiaries: () => [] }
            });
            await Promise.all([
                service.getAgentGuidance('Ariadne'),
                service.getAgentGuidance('Ariadne'),
                service.getAgentGuidance('Ariadne')
            ]);
            assert.equal(refreshCount, 1, 'in-flight refresh must be shared');
        } finally {
            await fs.rm(dir, { recursive: true, force: true });
        }
    });
});

test('estimateTokenCount — canonical ceil(codePoints/4) single-point implementation', () => {
    assert.equal(estimateTokenCount(''), 0);
    assert.equal(estimateTokenCount('abcd'), 1);
    assert.equal(estimateTokenCount('abcde'), 2);
    // 中文与 emoji 按 code point 计数（代理对算 1）
    assert.equal(estimateTokenCount('你好世界'), 1);
    assert.equal(estimateTokenCount('😀😀😀😀'), 1);
    assert.equal(estimateTokenCount(null), 0);
});
