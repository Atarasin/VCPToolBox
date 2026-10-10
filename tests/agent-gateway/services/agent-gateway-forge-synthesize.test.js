const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { createForgeRuntimeService } = require('../../../modules/agentGateway/services/forge/service');
const { createJobRuntimeService, JOB_STATUS } = require('../../../modules/agentGateway/services/jobRuntimeService');
const { resolveKnowledgeLibraryAccess } = require('../../../modules/agentGateway/policy/knowledgeScopeGuard');
const { validateAgentGuidanceConfig } = require('../../../modules/agentGateway/policy/agentGuidanceConfig');

function createTempDir() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'forge-synthesize-'));
}

function buildUiDesignerBlueprint(overrides = {}) {
    return {
        name: 'UIDesigner',
        displayName: 'UI 设计专家',
        scope: {
            responsibilities: ['落地页/UI 界面设计评审', '组件规范建议'],
            boundaries: ['不做前端代码实现']
        },
        subskills: [
            { id: 'color-theory', title: '配色理论', searchQueries: ['color theory UI design'] }
        ],
        examOutline: [
            { subskillId: 'color-theory', conceptQuestions: 1, appliedQuestions: 1 }
        ],
        practicalExam: { prompt: 'SaaS 落地页设计方案', gradingDimensions: ['眼前一亮', '去 AI 味'] },
        acceptanceSample: '能给出一份眼前一亮、去AI味的 UI 设计图',
        ...overrides
    };
}

function anySearchText() {
    return [
        'Color Theory Basics\nhttps://www.interaction-design.org/literature/topics/color-theory\n色彩理论基础知识。',
        'Color and UI\nhttps://www.smashingmagazine.com/2020/04/color-ui-design/\nUI 配色实践指南。',
        'Material Design color\nhttps://m3.material.io/styles/color/overview\n官方色彩系统文档。'
    ].join('\n\n');
}

const DISTILL_OUTPUT = JSON.stringify({
    knowledgeUnits: [{
        type: 'concept',
        title: '色轮与色彩三属性',
        oneLiner: '色相/饱和度/明度。',
        content: '色轮组织颜色……',
        tags: ['配色'],
        sourceUrls: ['https://www.interaction-design.org/literature/topics/color-theory'],
        mergeInto: null
    }],
    droppedSources: []
});

function buildEnv(baseDir, { agentMap = {}, policy = null, guidance = null } = {}) {
    const paths = {
        agentMapPath: path.join(baseDir, 'agent_map.json'),
        knowledgePolicyPath: path.join(baseDir, 'mcp_agent_knowledge_policy.json'),
        guidanceConfigPath: path.join(baseDir, 'agent_guidance.json')
    };
    fs.writeFileSync(paths.agentMapPath, JSON.stringify(agentMap, null, 2));
    fs.writeFileSync(paths.knowledgePolicyPath, JSON.stringify(policy || {
        _comment: 'test',
        restrictedLibraries: { '付鹏观点库': { allowedAgents: ['MCPFuPeng'] } }
    }, null, 2));
    fs.writeFileSync(paths.guidanceConfigPath, JSON.stringify(guidance || {
        version: 1,
        shared: { workflow: ['共享指引'], memoryWritePolicy: { write: [], skip: [] } },
        agents: {}
    }, null, 2));

    const jobRuntimeService = createJobRuntimeService();
    const forgeRuntimeService = createForgeRuntimeService({
        jobRuntimeService,
        llmCompletionPort: {
            available: true,
            complete: async () => ({
                data: { choices: [{ message: { content: DISTILL_OUTPUT } }], usage: { prompt_tokens: 100, completion_tokens: 50 } }
            })
        },
        toolInvokerPort: {
            invoke: async () => ({ content: [{ type: 'text', text: anySearchText() }] })
        },
        knowledgeStorePort: {
            available: true,
            listLibraries: async () => ['UIDesigner知识库'],
            search: async () => [{ text: 'hit', score: 0.9 }]
        },
        baseDir: path.join(baseDir, 'forge'),
        knowledgeRoot: path.join(baseDir, 'knowledge'),
        llmConfig: { url: 'http://t', apiKey: 'k', model: 'm' },
        ...paths
    });
    return { jobRuntimeService, forgeRuntimeService, paths };
}

async function driveToEnd(jobRuntimeService, forgeRuntimeService) {
    const { jobId } = await forgeRuntimeService.startExpertCreateJob({
        requirement: '造一个 UI 设计专家',
        blueprintOverride: buildUiDesignerBlueprint()
    });
    await waitFor(() => jobRuntimeService.pollJob(jobId, null).data.job.status === JOB_STATUS.PENDING_CONFIRM);
    await forgeRuntimeService.confirmBlueprint(jobId, { approved: true });
    await waitFor(() => jobRuntimeService.pollJob(jobId, null).data.job.terminal);
    return jobId;
}

async function waitFor(predicate, timeoutMs = 8000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (predicate()) {
            return true;
        }
        await new Promise((resolve) => setTimeout(resolve, 25));
    }
    return false;
}

// 验收（M3.S1）：生成的 txt 含「知识库调用纪律」章节且 agentId 规范正确。
test('synthesize：人设合成含知识库纪律章节、agentId 规范与画像一致', async () => {
    const baseDir = createTempDir();
    const { jobRuntimeService, forgeRuntimeService, paths } = buildEnv(baseDir, {
        agentMap: { Nexus: 'coding/Nexus.txt' }
    });
    const jobId = await driveToEnd(jobRuntimeService, forgeRuntimeService);

    const job = jobRuntimeService.pollJob(jobId, null).data.job;
    assert.equal(job.status, 'failed');
    assert.equal(job.metadata.forge.error.step, 'trial', 'synthesize 应完成，止步 trial 桩（M4）');

    const personaPath = path.join(baseDir, 'forge', 'UIDesigner.txt');
    const persona = fs.readFileSync(personaPath, 'utf8');
    assert.match(persona, /# 知识库调用纪律/, '知识库调用纪律章节');
    assert.match(persona, /值必须为[^。]{0,8}"UIDesigner"/, 'MCP 强制规范显式 agentId');
    assert.match(persona, /"agentId": "UIDesigner"/, 'JSON 示例携带 agentId');
    assert.match(persona, /libraries\[": ]*\["?UIDesigner知识库|"libraries": \["UIDesigner知识库"\]/, '知识库指引指向专属库');
    assert.match(persona, /落地页\/UI 界面设计评审/, '自我介绍含画像职责（scope 一致）');
    assert.match(persona, /不做前端代码实现/, '含画像边界');
    assert.match(persona, /绝不写入.*记忆日记本/, '红线 1 写入人设');
    assert.match(persona, /gateway_gap_report/, '缺口登记指引（§3.5）');
    // 红线 2：人设零密钥
    assert.ok(!/sk-[A-Za-z0-9]{20,}/.test(persona));

    // M3.S2 T1：agent_map 自动登记（保留既有条目）
    const map = JSON.parse(fs.readFileSync(paths.agentMapPath, 'utf8'));
    assert.equal(map.Nexus, 'coding/Nexus.txt', '既有条目保留');
    assert.equal(map.UIDesigner, 'forge/UIDesigner.txt', '新条目登记为 forge/ 相对路径');
});

// 验收（M3.S2）：权限绑定 + 引导配置，403 边界正确。
test('synthesize：知识库受限白名单（D5）与 guidance 写入，403 边界正确', async () => {
    const baseDir = createTempDir();
    const { jobRuntimeService, forgeRuntimeService, paths } = buildEnv(baseDir);
    await driveToEnd(jobRuntimeService, forgeRuntimeService);

    // policy：新库受限，只对新专家开放；既有条目不动
    const policy = JSON.parse(fs.readFileSync(paths.knowledgePolicyPath, 'utf8'));
    assert.deepEqual(policy.restrictedLibraries['UIDesigner知识库'], { allowedAgents: ['UIDesigner'] });
    assert.deepEqual(policy.restrictedLibraries['付鹏观点库'], { allowedAgents: ['MCPFuPeng'] }, '既有条目不动');

    // 403 语义（与 gateway_knowledge_search 同一守卫）
    const guardOptions = { policyPath: paths.knowledgePolicyPath };
    const allowed = resolveKnowledgeLibraryAccess({
        requestedLibraries: ['UIDesigner知识库'],
        availableLibraries: ['UIDesigner知识库'],
        agentId: 'UIDesigner',
        ...guardOptions
    });
    assert.deepEqual(allowed.targetLibraries, ['UIDesigner知识库'], '本专家可检索');
    // 守卫为 throw 语义（与 gateway_knowledge_search 的 403 同一函数）
    assert.throws(
        () => resolveKnowledgeLibraryAccess({
            requestedLibraries: ['UIDesigner知识库'],
            availableLibraries: ['UIDesigner知识库'],
            agentId: 'Nexus',
            ...guardOptions
        }),
        (error) => error.status === 403 && error.code === 'AGW_FORBIDDEN' && error.details.forbiddenLibraries.includes('UIDesigner知识库')
    , '其他 agentId 403');

    // guidance：结构合法（过官方校验器）且含知识库纪律
    const guidance = JSON.parse(fs.readFileSync(paths.guidanceConfigPath, 'utf8'));
    validateAgentGuidanceConfig(guidance); // 不抛即合法
    const entry = guidance.agents.UIDesigner;
    assert.equal(entry.displayName, 'UI 设计专家');
    assert.ok(entry.workflow.some((line) => line.includes('gateway_knowledge_search') && line.includes('UIDesigner知识库')));
    assert.equal(guidance.shared.workflow[0], '共享指引', '共享段保留');
});

test('synthesize：冲突转 pending_confirm，改名后迁移画像与知识库目录且仅重跑 synthesize', async () => {
    const baseDir = createTempDir();
    const { jobRuntimeService, forgeRuntimeService, paths } = buildEnv(baseDir);
    // 先跑完 blueprint/harvest/distill 三步（止步 synthesize 前先手工暂停场景）：
    // 直接构造 synthesize 冲突状态——确认画像后、synthesize 执行前外部写入了同名文件。
    const forgeRoot = path.join(baseDir, 'forge');
    const { jobId } = await forgeRuntimeService.startExpertCreateJob({
        requirement: '造一个 UI 设计专家',
        blueprintOverride: buildUiDesignerBlueprint()
    });
    await waitFor(() => jobRuntimeService.pollJob(jobId, null).data.job.status === JOB_STATUS.PENDING_CONFIRM);
    const runDir = path.join(forgeRoot, 'runs', jobId);
    const runJsonPath = path.join(runDir, 'run.json');
    const runBefore = JSON.parse(fs.readFileSync(runJsonPath, 'utf8'));

    // 手工注入 synthesize 冲突：blueprint 已确认（marker 在），外部写入同名旧人设
    fs.writeFileSync(path.join(forgeRoot, 'UIDesigner.txt'), '外部新写入的旧人设，不可默认覆盖');
    fs.mkdirSync(path.join(baseDir, 'knowledge', 'UIDesigner知识库'), { recursive: true });
    fs.writeFileSync(path.join(baseDir, 'knowledge', 'UIDesigner知识库', 'K_color-theory_x.md'), 'card');
    await require('node:fs/promises').writeFile(runJsonPath, JSON.stringify({
        ...runBefore,
        pendingNameConflict: {
            step: 'synthesize',
            draft: buildUiDesignerBlueprint(),
            conflicts: [{ kind: 'file', file: 'forge/UIDesigner.txt' }]
        }
    }, null, 2));
    jobRuntimeService.updateJob(jobId, {
        status: JOB_STATUS.PENDING_CONFIRM,
        metadata: { forge: { pendingConfirm: { kind: 'name-conflict' } } }
    });

    // 改名确认 → 画像改名、知识库目录迁移、旧人设删除、续跑止步 trial 桩
    await forgeRuntimeService.confirmBlueprint(jobId, { approved: true, renameTo: 'UiDesignerV2' });
    assert.equal(await waitFor(() => jobRuntimeService.pollJob(jobId, null).data.job.terminal), true);
    const finalJob = jobRuntimeService.pollJob(jobId, null).data.job;
    assert.equal(finalJob.metadata.forge.error.step, 'trial', '改名后止步 trial 桩');

    assert.equal(fs.existsSync(path.join(forgeRoot, 'UIDesigner.txt')), false, '旧名人设删除');
    const newPersona = fs.readFileSync(path.join(forgeRoot, 'UiDesignerV2.txt'), 'utf8');
    assert.match(newPersona, /值必须为[^。]{0,8}"UiDesignerV2"/);
    assert.equal(fs.existsSync(path.join(baseDir, 'knowledge', 'UiDesignerV2知识库', 'K_color-theory_x.md')), true, '知识库目录迁移');
    assert.equal(fs.existsSync(path.join(baseDir, 'knowledge', 'UIDesigner知识库')), false, '旧库目录不在');
    assert.deepEqual(fs.readdirSync(path.join(forgeRoot, 'blueprints')), ['UiDesignerV2.json'], '画像文件改名');
    const markers = fs.readdirSync(path.join(runDir, 'steps')).sort();
    assert.ok(markers.includes('harvest.json') && markers.includes('distill.json'), '前序步骤 marker 保留（仅重跑 synthesize）');
    const map = JSON.parse(fs.readFileSync(paths.agentMapPath, 'utf8'));
    assert.equal(map.UiDesignerV2, 'forge/UiDesignerV2.txt', '新名登记');
});

test('synthesize：人工明确覆盖（overwrite）允许写同名人设与 agent_map 条目', async () => {
    const baseDir = createTempDir();
    const { jobRuntimeService, forgeRuntimeService, paths } = buildEnv(baseDir, {
        agentMap: { UIDesigner: 'legacy/old-persona.txt' }
    });
    const forgeRoot = path.join(baseDir, 'forge');
    const { jobId } = await forgeRuntimeService.startExpertCreateJob({
        requirement: '造一个 UI 设计专家',
        blueprintOverride: buildUiDesignerBlueprint()
    });
    await waitFor(() => jobRuntimeService.pollJob(jobId, null).data.job.status === JOB_STATUS.PENDING_CONFIRM);
    const runJsonPath = path.join(forgeRoot, 'runs', jobId, 'run.json');
    const runBefore = JSON.parse(fs.readFileSync(runJsonPath, 'utf8'));

    fs.writeFileSync(path.join(forgeRoot, 'UIDesigner.txt'), '旧人设');
    await require('node:fs/promises').writeFile(runJsonPath, JSON.stringify({
        ...runBefore,
        pendingNameConflict: { step: 'synthesize', draft: buildUiDesignerBlueprint(), conflicts: [{ kind: 'file', file: 'forge/UIDesigner.txt' }] }
    }, null, 2));
    jobRuntimeService.updateJob(jobId, {
        status: JOB_STATUS.PENDING_CONFIRM,
        metadata: { forge: { pendingConfirm: { kind: 'name-conflict' } } }
    });

    // 未带 overwrite 的确认被拒绝（默认绝不覆盖）
    await assert.rejects(
        forgeRuntimeService.confirmBlueprint(jobId, { approved: true }),
        (error) => error.status === 400
    );

    await forgeRuntimeService.confirmBlueprint(jobId, { approved: true, overwrite: true });
    assert.equal(await waitFor(() => jobRuntimeService.pollJob(jobId, null).data.job.terminal), true);
    const persona = fs.readFileSync(path.join(forgeRoot, 'UIDesigner.txt'), 'utf8');
    assert.match(persona, /# 知识库调用纪律/, '人设被新人设覆盖');
    const map = JSON.parse(fs.readFileSync(paths.agentMapPath, 'utf8'));
    assert.equal(map.UIDesigner, 'forge/UIDesigner.txt', 'agent_map 条目改指新人设（人工明确覆盖）');
});
