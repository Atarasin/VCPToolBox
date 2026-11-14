'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
    ForgeWritePausedError,
    assertExpertWritable,
    createExpertLeaseManager,
    leasePath,
    LEASE_FILE
} = require('../../../modules/agentGateway/services/forge/maintenanceLock');
const { JOB_STATUS, createJobRuntimeService } = require('../../../modules/agentGateway/services/jobRuntimeService');
const {
    FORGE_JOB_OPERATIONS,
    createForgeRuntimeService
} = require('../../../modules/agentGateway/services/forge/service');

function createTempDir(prefix = 'forge-lease-') {
    return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function writeLease(baseDir, expertName, lease) {
    const file = leasePath(baseDir, expertName);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(lease, null, 2), 'utf-8');
    return file;
}

// ── 模块语义 ─────────────────────────────────────────────────────────────

test('maintenanceLock：独占创建，第二个持有者被 FORGE_EXPERT_WRITE_PAUSED 拒绝', () => {
    const baseDir = createTempDir();
    const manager = createExpertLeaseManager({ baseDir, ttlMs: 60_000 });
    const first = manager.acquire({ expertName: 'yanchi_ui', ownerJobId: 'job_a', mode: 'rebuild' });
    assert.ok(fs.existsSync(first.path));

    assert.throws(
        () => manager.acquire({ expertName: 'yanchi_ui', ownerJobId: 'job_b', mode: 'learn' }),
        (error) => error instanceof ForgeWritePausedError
            && error.code === 'FORGE_EXPERT_WRITE_PAUSED'
            && error.status === 409
            && error.details.lease.ownerJobId === 'job_a'
    );

    // assertExpertWritable 同样拒绝（调度器/CLI 用）。
    assert.throws(
        () => assertExpertWritable(baseDir, 'yanchi_ui'),
        (error) => error.code === 'FORGE_EXPERT_WRITE_PAUSED'
    );

    first.release();
    assert.equal(fs.existsSync(first.path), false);
    // 释放后可写、可再次获取。
    assert.doesNotThrow(() => assertExpertWritable(baseDir, 'yanchi_ui'));
    const second = manager.acquire({ expertName: 'yanchi_ui', ownerJobId: 'job_c', mode: 'learn' });
    second.release();
});

test('maintenanceLock：同 owner 重复 acquire 幂等续期，不报冲突', () => {
    const baseDir = createTempDir();
    const manager = createExpertLeaseManager({ baseDir, ttlMs: 60_000 });
    const first = manager.acquire({ expertName: 'e1', ownerJobId: 'job_x', mode: 'learn' });
    const again = manager.acquire({ expertName: 'e1', ownerJobId: 'job_x', mode: 'learn' });
    assert.equal(again.ownerJobId, 'job_x');
    first.release();
    assert.equal(fs.existsSync(first.path), false);
});

test('maintenanceLock：过期租约可被接管，superseded 留痕', () => {
    const baseDir = createTempDir();
    const managerA = createExpertLeaseManager({ baseDir, ttlMs: 60_000 });
    const stale = managerA.acquire({ expertName: 'e1', ownerJobId: 'job_old', mode: 'rebuild' });
    // 用过去的 expiresAt 模拟过期（不改 now 注入，直接改文件更贴近真实）。
    const leaseJson = JSON.parse(fs.readFileSync(stale.path, 'utf-8'));
    leaseJson.expiresAt = Date.now() - 1000;
    writeLease(baseDir, 'e1', leaseJson);

    const managerB = createExpertLeaseManager({ baseDir, ttlMs: 60_000 });
    const takeover = managerB.acquire({ expertName: 'e1', ownerJobId: 'job_new', mode: 'rebuild' });
    const onDisk = JSON.parse(fs.readFileSync(takeover.path, 'utf-8'));
    assert.equal(onDisk.ownerJobId, 'job_new');
    assert.equal(onDisk.superseded.ownerJobId, 'job_old');
    assert.equal(onDisk.superseded.reason, 'expired');

    // 原 holder 的步骤检查发现被接管 → 抛 FORGE_EXPERT_WRITE_PAUSED。
    assert.throws(
        () => managerA.ensureStepLease('job_old', 'e1'),
        (error) => error.code === 'FORGE_EXPERT_WRITE_PAUSED'
    );
    // 原 holder release 不得删除接管者的租约。
    assert.equal(stale.release(), false);
    assert.ok(fs.existsSync(takeover.path));
    takeover.release();
});

test('maintenanceLock：持约进程已死可接管；损坏租约保守拒绝', () => {
    const baseDir = createTempDir();
    // PID 已死（取一个几乎不可能存活的 PID）。
    writeLease(baseDir, 'e1', {
        ownerJobId: 'job_ghost', mode: 'cleanup', pid: 3_999_999,
        heartbeatAt: new Date().toISOString(), expiresAt: Date.now() + 600_000
    });
    const manager = createExpertLeaseManager({ baseDir, ttlMs: 60_000 });
    const takeover = manager.acquire({ expertName: 'e1', ownerJobId: 'job_new', mode: 'learn' });
    assert.equal(JSON.parse(fs.readFileSync(takeover.path, 'utf-8')).superseded.reason, 'pid-dead');
    takeover.release();

    // 损坏文件：无法判定过期/PID → 保守拒绝写入。
    const file = leasePath(baseDir, 'e1');
    fs.writeFileSync(file, '{not json', 'utf-8');
    assert.throws(
        () => createExpertLeaseManager({ baseDir, ttlMs: 60_000 }).acquire({ expertName: 'e1', ownerJobId: 'job_z', mode: 'learn' }),
        (error) => error.code === 'FORGE_EXPERT_WRITE_PAUSED' && /损坏/.test(error.message)
    );
});

test('maintenanceLock：heartbeat 续期；step 检查对未持有 job 明确报错', () => {
    const baseDir = createTempDir();
    const manager = createExpertLeaseManager({ baseDir, ttlMs: 60_000 });
    const handle = manager.acquire({ expertName: 'e1', ownerJobId: 'job_run', mode: 'learn' });
    const before = JSON.parse(fs.readFileSync(handle.path, 'utf-8')).expiresAt;
    manager.ensureStepLease('job_run', 'e1');
    const after = JSON.parse(fs.readFileSync(handle.path, 'utf-8')).expiresAt;
    assert.ok(after >= before);

    assert.throws(
        () => manager.ensureStepLease('job_unknown', 'e1'),
        (error) => error.code === 'FORGE_EXPERT_WRITE_PAUSED'
    );
    handle.release();
});

test('maintenanceLock：detached 租约（pid=0）不依赖进程存活，仅靠 TTL 判定', () => {
    const baseDir = createTempDir();
    const managerA = createExpertLeaseManager({ baseDir, ttlMs: 60_000 });
    // detached=true：pid=0。模拟持有进程退出（另一个 manager 看到的 pid 已不存在）。
    const handle = managerA.acquire({ expertName: 'e1', ownerJobId: 'cli_window', mode: 'rebuild', detached: true });
    assert.equal(handle.lease.pid, 0);

    // 另一进程视角：未过期 → 活动（不可被 pid-dead 接管）。
    const managerB = createExpertLeaseManager({ baseDir, ttlMs: 60_000 });
    assert.throws(
        () => managerB.acquire({ expertName: 'e1', ownerJobId: 'job_other', mode: 'learn' }),
        (error) => error.code === 'FORGE_EXPERT_WRITE_PAUSED'
    );

    // 过期后可被接管。
    const leaseJson = JSON.parse(fs.readFileSync(handle.path, 'utf-8'));
    leaseJson.expiresAt = Date.now() - 1000;
    writeLease(baseDir, 'e1', leaseJson);
    const takeover = managerB.acquire({ expertName: 'e1', ownerJobId: 'job_new', mode: 'rebuild' });
    assert.equal(JSON.parse(fs.readFileSync(takeover.path, 'utf-8')).superseded.reason, 'expired');
    takeover.release();
});

// ── service 集成 ────────────────────────────────────────────────────────

function llmResponse(content) {
    return { data: { choices: [{ message: { content } }], usage: { prompt_tokens: 10, completion_tokens: 10 } } };
}

function validBlueprintJson(name = 'E1') {
    return JSON.stringify({
        name,
        displayName: '测试专家',
        scope: { responsibilities: ['测试'], boundaries: ['不做别的'] },
        subskills: [{ id: 's1', title: '子技能', searchQueries: ['q'] }],
        examOutline: [{ subskillId: 's1', conceptQuestions: 1, appliedQuestions: 1 }],
        practicalExam: { prompt: 'p', gradingDimensions: ['d'] },
        acceptanceSample: 'ok'
    });
}

function buildService({ baseDir, stepRunners = {} } = {}) {
    const jobRuntimeService = createJobRuntimeService();
    const events = [];
    const auditLogger = { logGatewayOperation: (event, payload) => events.push({ event: `gateway.${event}`, payload }) };
    const forgeRuntimeService = createForgeRuntimeService({
        jobRuntimeService,
        auditLogger,
        llmCompletionPort: { available: true, complete: async () => llmResponse(validBlueprintJson()) },
        baseDir,
        llmConfig: { url: 'http://test', apiKey: 'k', model: 'm' },
        stepRunners
    });
    return { jobRuntimeService, events, forgeRuntimeService };
}

async function waitFor(predicate, { timeoutMs = 5000, intervalMs = 25 } = {}) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (predicate()) return true;
        await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
    return false;
}

test('service 集成：维护租约持有期 startExpertLearnJob 同步拒绝 FORGE_EXPERT_WRITE_PAUSED', async () => {
    const baseDir = createTempDir('forge-lease-svc-');
    fs.mkdirSync(path.join(baseDir, 'blueprints'), { recursive: true });
    fs.writeFileSync(path.join(baseDir, 'blueprints', 'E1.json'), validBlueprintJson(), 'utf-8');
    const { jobRuntimeService, events, forgeRuntimeService } = buildService({ baseDir });

    const lease = createExpertLeaseManager({ baseDir, ttlMs: 60_000 })
        .acquire({ expertName: 'E1', ownerJobId: 'maint_1', mode: 'rebuild' });

    await assert.rejects(
        forgeRuntimeService.startExpertLearnJob({ expertName: 'E1' }),
        (error) => error.code === 'FORGE_EXPERT_WRITE_PAUSED' && error.status === 409
    );
    // 审计留痕：learn 入口明确写 paused 事件。
    assert.ok(events.some((entry) => entry.event === 'gateway.forge.learn.write_paused'));

    // 释放后可正常发起（job 进入执行，步骤由 fake runner 完成）。
    lease.release();
    const { jobId } = await forgeRuntimeService.startExpertLearnJob({ expertName: 'E1' });
    assert.ok(jobId);
});

test('service 集成：运行中的 learn job 在步骤边界被维护租约接管后停止', async () => {
    const baseDir = createTempDir('forge-lease-svc-');
    fs.mkdirSync(path.join(baseDir, 'blueprints'), { recursive: true });
    fs.writeFileSync(path.join(baseDir, 'blueprints', 'E1.json'), validBlueprintJson(), 'utf-8');

    let distillReached = false;
    // harvest 卡在可控 gate 上：确保检查发生在 job 持有 learn 租约期间。
    let releaseHarvest;
    const harvestGate = new Promise((resolve) => { releaseHarvest = resolve; });
    const { jobRuntimeService, forgeRuntimeService } = buildService({
        baseDir,
        stepRunners: {
            harvest: async () => {
                await harvestGate;
                return { summary: 'ok' };
            },
            distill: async () => {
                distillReached = true; // 若租约检查失效，这里会被执行到
                return { summary: 'ok' };
            }
        }
    });

    const { jobId } = await forgeRuntimeService.startExpertLearnJob({ expertName: 'E1' });
    // 等 learn job 持有租约（harvest 挂起期间租约必须在盘上）。
    const ok = await waitFor(() => fs.existsSync(leasePath(baseDir, 'E1')));
    assert.equal(ok, true, 'learn job 应已持有专家租约');
    const learnLease = JSON.parse(fs.readFileSync(leasePath(baseDir, 'E1'), 'utf-8'));
    assert.equal(learnLease.mode, 'learn');

    writeLease(baseDir, 'E1', {
        ownerJobId: 'maint_rebuild', mode: 'rebuild', pid: process.pid,
        heartbeatAt: new Date().toISOString(), expiresAt: Date.now() + 600_000
    });
    releaseHarvest();

    const stopped = await waitFor(() => {
        const job = jobRuntimeService.pollJob(jobId, null)?.data?.job;
        return job?.status === JOB_STATUS.FAILED
            && job?.metadata?.forge?.error?.code === 'FORGE_EXPERT_WRITE_PAUSED';
    }, { timeoutMs: 10_000 });
    assert.equal(stopped, true, 'job 应在下一步骤边界以 FORGE_EXPERT_WRITE_PAUSED 失败（可续跑）');
    assert.equal(distillReached, false, '被接管后不得再执行 distill 步骤');

    // 维护租约未被 learn job 的 finally 释放误删。
    const after = JSON.parse(fs.readFileSync(leasePath(baseDir, 'E1'), 'utf-8'));
    assert.equal(after.ownerJobId, 'maint_rebuild');
});

test('lifelongScheduler 集成：租约持有者被跳过并留审计事件，其余专家照常', async () => {
    const { createLifelongScheduler } = require('../../../modules/agentGateway/services/forge/lifelongScheduler');
    const baseDir = createTempDir('forge-lease-sched-');
    const events = [];
    const auditLogger = { logGatewayOperation: (event, payload) => events.push({ event, payload }) };

    const launched = [];
    const forgeRuntimeService = { baseDir };
    const scheduler = createLifelongScheduler({
        forgeRuntimeService,
        gapRegistry: { lastLearningAt: async () => null },
        listExpertNames: () => ['E1', 'E2'],
        auditLogger
    });
    const originalStart = forgeRuntimeService.startExpertLearnJob;
    forgeRuntimeService.startExpertLearnJob = async ({ expertName }) => {
        launched.push(expertName);
        return { jobId: `job_${expertName}` };
    };

    const lease = createExpertLeaseManager({ baseDir, ttlMs: 60_000 })
        .acquire({ expertName: 'E1', ownerJobId: 'maint_1', mode: 'cleanup' });

    await scheduler.runScheduledLearning('scheduled-daily');

    assert.deepEqual(launched, ['E2']);
    assert.ok(events.some((entry) => entry.event === 'forge.learn.write_paused' && entry.payload.expertName === 'E1'));
    lease.release();
    forgeRuntimeService.startExpertLearnJob = originalStart;
});
