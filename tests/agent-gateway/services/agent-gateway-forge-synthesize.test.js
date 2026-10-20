const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { createForgeRuntimeService } = require('../../../modules/agentGateway/services/forge/service');
const { createJobRuntimeService, JOB_STATUS } = require('../../../modules/agentGateway/services/jobRuntimeService');
const {
    renderPersona,
    FALLBACK_TEMPLATE,
    PERSONA_BOUNDARY_CLAUSE
} = require('../../../modules/agentGateway/services/forge/synthesize');
const { resolveKnowledgeLibraryAccess } = require('../../../modules/agentGateway/policy/knowledgeScopeGuard');
const { validateAgentGuidanceConfig } = require('../../../modules/agentGateway/policy/agentGuidanceConfig');
const { resolveConfiguredAgentMemoryPolicy } = require('../../../modules/agentGateway/policy/mcpAgentMemoryPolicy');
const { isDiaryAllowed } = require('../../../modules/agentGateway/policy/diaryScopeGuard');
const { RecallProfileResolver } = require('../../../modules/agentGateway/policy/recallProfileResolver');
const {
    registerMemoryPolicy,
    registerRecallProfile,
    expertDiaryName,
    resolveDiaryMaid
} = require('../../../modules/agentGateway/services/forge/synthesize');

// ── 工作日志注册（§3.6 注册绑定四件套之三/四）────────────────────────────

test('工作日志：日记名派生与 maid 解析（人格名优先，旧画像回落 agent 名）', () => {
    assert.equal(expertDiaryName('yanchi_ui'), 'yanchi_ui工作日志日记本');
    assert.equal(resolveDiaryMaid({ name: 'yanchi_ui', persona: { name: '砚尺' } }), '砚尺');
    assert.equal(resolveDiaryMaid({ name: 'FullStackUIDesignExpert' }), 'FullStackUIDesignExpert');
    assert.equal(resolveDiaryMaid({ name: 'X', persona: { name: '  ' } }), 'X', '空白人格名回落 agent 名');
});

test('工作日志：registerMemoryPolicy 新建条目，缺文件可自建结构', async () => {
    const baseDir = createTempDir();
    const memoryPolicyPath = path.join(baseDir, 'mcp_agent_memory_policy.json');
    const result = await registerMemoryPolicy({ memoryPolicyPath, name: 'NewExpert', maid: '新专家', diaryName: expertDiaryName('NewExpert') });
    assert.equal(result.registered, true);
    const policy = JSON.parse(fs.readFileSync(memoryPolicyPath, 'utf8'));
    assert.deepEqual(policy.agents.NewExpert, {
        maid: '新专家',
        allowedDiaries: ['NewExpert工作日志日记本'],
        defaultDiaries: ['NewExpert工作日志日记本']
    });
});

test('工作日志：registerMemoryPolicy 既有条目只增不减（人工调优优先，红线 3）', async () => {
    const baseDir = createTempDir();
    const memoryPolicyPath = path.join(baseDir, 'mcp_agent_memory_policy.json');
    fs.writeFileSync(memoryPolicyPath, JSON.stringify({
        agents: {
            Tuned: { maid: '人工调优的署名', allowedDiaries: ['Tuned主日记本'], defaultDiaries: ['Tuned主日记本'] },
            Partial: {}
        }
    }, null, 2));

    // 人工调优条目：日志追加进白名单，maid/默认日记不剥夺
    const tuned = await registerMemoryPolicy({ memoryPolicyPath, name: 'Tuned', maid: 'Tuned', diaryName: 'Tuned工作日志日记本' });
    assert.equal(tuned.registered, false, '已存在条目按追加处理');
    const policy = JSON.parse(fs.readFileSync(memoryPolicyPath, 'utf8'));
    assert.equal(policy.agents.Tuned.maid, '人工调优的署名', 'maid 不覆盖');
    assert.deepEqual(policy.agents.Tuned.allowedDiaries, ['Tuned主日记本', 'Tuned工作日志日记本'], '日志只增');
    assert.deepEqual(policy.agents.Tuned.defaultDiaries, ['Tuned主日记本'], '默认日记不动');

    // 空条目：补齐 maid/白名单/默认日记
    await registerMemoryPolicy({ memoryPolicyPath, name: 'Partial', maid: 'Partial', diaryName: 'Partial工作日志日记本' });
    const policy2 = JSON.parse(fs.readFileSync(memoryPolicyPath, 'utf8'));
    assert.deepEqual(policy2.agents.Partial, {
        maid: 'Partial',
        allowedDiaries: ['Partial工作日志日记本'],
        defaultDiaries: ['Partial工作日志日记本']
    });

    // 再跑一遍完全无变化（幂等）
    const before = fs.readFileSync(memoryPolicyPath, 'utf8');
    await registerMemoryPolicy({ memoryPolicyPath, name: 'Partial', maid: 'Partial', diaryName: 'Partial工作日志日记本' });
    assert.equal(fs.readFileSync(memoryPolicyPath, 'utf8'), before, '幂等：无变化不写盘');
});

test('工作日志：registerRecallProfile 新建可解析、既有条目不覆盖', async () => {
    const baseDir = createTempDir();
    const recallProfilesPath = path.join(baseDir, 'recall_profiles.json');
    fs.writeFileSync(recallProfilesPath, JSON.stringify({
        recallMode: 'river',
        agents: { Tuned: { defaultProfile: 'tuned-custom' } },
        profiles: {}
    }, null, 2));

    const created = await registerRecallProfile({ recallProfilesPath, name: 'NewExpert', diaryName: 'NewExpert工作日志日记本' });
    assert.equal(created.registered, true);
    const kept = await registerRecallProfile({ recallProfilesPath, name: 'Tuned', diaryName: 'Tuned工作日志日记本' });
    assert.equal(kept.registered, false, '人工调优条目不覆盖');

    const config = JSON.parse(fs.readFileSync(recallProfilesPath, 'utf8'));
    assert.equal(config.recallMode, 'river', '顶层 recallMode 保留');
    assert.equal(config.agents.Tuned.defaultProfile, 'tuned-custom', '人工档案不动');
    assert.equal(config.agents.NewExpert.defaultProfile, 'NewExpert-default');
    assert.ok(config.profiles['NewExpert-default'].rules[0].targets.diaries.includes('NewExpert工作日志日记本'));

    const resolver = new RecallProfileResolver({ configPath: recallProfilesPath });
    const resolved = resolver.resolveForAgent('NewExpert');
    assert.equal(resolved.resolved, true, '写入的档案可被解析器消费');
});

test('工作日志：maid 经生产策略解析器可解析（写链路 buildMemoryWriteMaid 的前置条件）', async () => {
    const baseDir = createTempDir();
    const memoryPolicyPath = path.join(baseDir, 'mcp_agent_memory_policy.json');
    await registerMemoryPolicy({ memoryPolicyPath, name: 'MaidProbe', maid: '砚尺', diaryName: 'MaidProbe工作日志日记本' });
    const previousPath = process.env.MCP_AGENT_MEMORY_POLICY_PATH;
    process.env.MCP_AGENT_MEMORY_POLICY_PATH = memoryPolicyPath;
    try {
        const resolved = resolveConfiguredAgentMemoryPolicy({ agentId: 'MaidProbe' });
        assert.equal(resolved.maid, '砚尺');
        assert.deepEqual(resolved.allowedDiaryNames, ['MaidProbe工作日志日记本']);
        assert.equal(resolveConfiguredAgentMemoryPolicy({ agentId: 'UnknownAgent' }).maid, '', '未登记 agent 无 maid（写入即 500，门禁语义正确）');
    } finally {
        if (previousPath === undefined) {
            delete process.env.MCP_AGENT_MEMORY_POLICY_PATH;
        } else {
            process.env.MCP_AGENT_MEMORY_POLICY_PATH = previousPath;
        }
    }
});

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

function buildEnv(baseDir, { agentMap = {}, policy = null, guidance = null, memoryPolicy = null, recallProfiles = null } = {}) {
    const paths = {
        agentMapPath: path.join(baseDir, 'agent_map.json'),
        knowledgePolicyPath: path.join(baseDir, 'mcp_agent_knowledge_policy.json'),
        guidanceConfigPath: path.join(baseDir, 'agent_guidance.json'),
        memoryPolicyPath: path.join(baseDir, 'mcp_agent_memory_policy.json'),
        recallProfilesPath: path.join(baseDir, 'recall_profiles.json')
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
    fs.writeFileSync(paths.memoryPolicyPath, JSON.stringify(memoryPolicy || {
        agents: { Nexus: { maid: 'Nexus', allowedDiaries: ['Nexus工程经验日记本'], defaultDiaries: ['Nexus工程经验日记本'] } }
    }, null, 2));
    fs.writeFileSync(paths.recallProfilesPath, JSON.stringify(recallProfiles || {
        recallMode: 'river',
        agents: {},
        profiles: {}
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

async function driveToEnd(jobRuntimeService, forgeRuntimeService, blueprint = buildUiDesignerBlueprint()) {
    const { jobId } = await forgeRuntimeService.startExpertCreateJob({
        requirement: '造一个 UI 设计专家',
        blueprintOverride: blueprint
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
    assert.match(persona, /本事.{0,20}只存在于冷知识库.{0,40}绝不写入工作日志/s, '红线 1 写入人设（本事与经历两条线）');
    assert.match(persona, /# 工作日志纪律（经历记忆）/, '工作日志纪律章节（§3.5）');
    assert.match(persona, /UIDesigner工作日志日记本/, '日志名由 agent 名派生');
    assert.match(persona, /gateway_recall_run/, '召回既往经历指引');
    assert.match(persona, /gateway_memory_write/, '写入经历指引');
    assert.match(persona, /gateway_gap_report/, '缺口登记指引（§3.5）');
    // 红线 2：人设零密钥
    assert.ok(!/sk-[A-Za-z0-9]{20,}/.test(persona));

    // M3.S2 T1：agent_map 自动登记（保留既有条目）
    const map = JSON.parse(fs.readFileSync(paths.agentMapPath, 'utf8'));
    assert.equal(map.Nexus, 'coding/Nexus.txt', '既有条目保留');
    assert.equal(map.UIDesigner, 'forge/UIDesigner.txt', '新条目登记为 forge/ 相对路径');
});

// ── 人格化铸造（参考 Agent/Yui.txt）：铸造时设计的名字与性格渲染进人设 ──

function buildMinqingPersona(overrides = {}) {
    return {
        name: '沐晴',
        title: '像素炼金术士',
        appearance: '束马尾的年轻设计师，瞳孔里常映着栅格线。',
        backstory: '从专家铸造炉中醒来，专属知识库就是她被铸出来的记忆。',
        coreMotto: '设计是戴着镣铐的舞蹈',
        cognitiveStyle: ['先看信息层级再看细节', '每个取舍都要给出理由'],
        toneAndExpression: ['温和但直接', '评审意见按优先级分层给出'],
        quirks: ['爱用「这里差一口气」形容临门一脚的缺陷'],
        ...overrides
    };
}

test('synthesize：画像带 persona 时渲染角色人格章节（人格名/形象/身世/箴言/认知风格/语气/使用边界）', () => {
    const rendered = renderPersona(FALLBACK_TEMPLATE, buildUiDesignerBlueprint({ persona: buildMinqingPersona() }));
    assert.match(rendered, /# 角色人格/, '角色人格章节');
    assert.match(rendered, /\*\*Name\*\*: 沐晴·UI 设计专家（UIDesigner）/, 'Name 行 = 人格名·职能名（agent 名）');
    assert.match(rendered, /你是沐晴——像素炼金术士，由专家铸造炉铸造的「UI 设计专家」。/, '人格开场衔接铸造炉世界观');
    assert.match(rendered, /\*\*形象\*\*：束马尾的年轻设计师/, '形象（Yui 式）');
    assert.match(rendered, /\*\*身世\*\*：从专家铸造炉中醒来/, '身世（Yui 式）');
    assert.match(rendered, /\*\*核心箴言\*\*：「设计是戴着镣铐的舞蹈」/, '核心箴言');
    assert.match(rendered, /## 认知风格/, '认知风格清单');
    assert.match(rendered, /## 语气与表达/, '语气与表达清单');
    assert.match(rendered, /标志性表达.*这里差一口气/, '标志性口癖');
    assert.ok(rendered.includes(PERSONA_BOUNDARY_CLAUSE), '固定人格使用边界条款（人设不削弱专业纪律）');
    // 红线章节不受人格影响
    assert.match(rendered, /# 知识库调用纪律/, '红线章节保留');
    assert.match(rendered, /"agentId": "UIDesigner"/, 'agentId 规范不变');
});

test('synthesize：画像无 persona 时整章省略，输出与旧版一致（旧画像兼容）', () => {
    const rendered = renderPersona(FALLBACK_TEMPLATE, buildUiDesignerBlueprint());
    assert.ok(!rendered.includes('# 角色人格'), '无空章节');
    assert.ok(!rendered.includes('人格使用边界'), '无边界条款残留');
    assert.match(rendered, /\*\*Name\*\*: UI 设计专家（UIDesigner）/, 'Name 行保持职能名');
    assert.ok(!/\n{3,}/.test(rendered), '省略整章后不残留多余空行');
});

test('synthesize：全链路带 persona 铸造——人设 txt 落盘含名字与性格', async () => {
    const baseDir = createTempDir();
    const { jobRuntimeService, forgeRuntimeService } = buildEnv(baseDir, {
        agentMap: { Nexus: 'coding/Nexus.txt' }
    });
    const jobId = await driveToEnd(jobRuntimeService, forgeRuntimeService, buildUiDesignerBlueprint({
        persona: buildMinqingPersona()
    }));

    const job = jobRuntimeService.pollJob(jobId, null).data.job;
    assert.equal(job.metadata.forge.error.step, 'trial', 'synthesize 应完成，止步 trial 桩');

    const persona = fs.readFileSync(path.join(baseDir, 'forge', 'UIDesigner.txt'), 'utf8');
    assert.match(persona, /# 角色人格/, '落盘人设含角色人格章节');
    assert.match(persona, /\*\*Name\*\*: 沐晴·UI 设计专家（UIDesigner）/, 'Name 行含人格名');
    assert.match(persona, /你是沐晴——像素炼金术士/, '人格开场');
    assert.ok(persona.includes(PERSONA_BOUNDARY_CLAUSE), '人格使用边界条款');
    assert.ok(!/sk-[A-Za-z0-9]{20,}/.test(persona), '人格内容零密钥（红线 2）');
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

    // 记忆策略（§3.6 工作日志）：新专家可写专属工作日志，既有条目不动
    const memoryPolicy = JSON.parse(fs.readFileSync(paths.memoryPolicyPath, 'utf8'));
    assert.deepEqual(memoryPolicy.agents.UIDesigner, {
        maid: 'UIDesigner',
        allowedDiaries: ['UIDesigner工作日志日记本'],
        defaultDiaries: ['UIDesigner工作日志日记本']
    });
    assert.equal(memoryPolicy.agents.Nexus.maid, 'Nexus', '既有条目不动');
    // 写门禁语义（与 diaryScopeGuard 同一判定函数）：本人日志可写、他人日志与其他 agent 均不可写
    assert.ok(isDiaryAllowed({ allowedDiaryNames: memoryPolicy.agents.UIDesigner.allowedDiaries }, 'UIDesigner工作日志日记本'), '本人日志可写');
    assert.ok(!isDiaryAllowed({ allowedDiaryNames: memoryPolicy.agents.UIDesigner.allowedDiaries }, 'Nexus工程经验日记本'), '他人日志不可写');
    assert.ok(!isDiaryAllowed({ allowedDiaryNames: memoryPolicy.agents.Nexus.allowedDiaries }, 'UIDesigner工作日志日记本'), '其他 agent 写专家日志被拒');

    // 召回档案（§3.6 工作日志）：gateway_recall_run 可解析（无档案即 RECALL_NO_PROFILE）
    const resolver = new RecallProfileResolver({ configPath: paths.recallProfilesPath });
    const resolved = resolver.resolveForAgent('UIDesigner');
    assert.equal(resolved.resolved, true, '召回档案可解析');
    assert.equal(resolved.profileName, 'UIDesigner-default');
    assert.deepEqual(resolved.targets, ['UIDesigner工作日志日记本']);
    assert.equal(resolver.resolveForAgent('Nexus').code, 'RECALL_NO_PROFILE', '未登记的 agent 无档案');
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
