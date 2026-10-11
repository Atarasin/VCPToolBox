const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { createForgeRuntimeService } = require('../../../modules/agentGateway/services/forge/service');
const { createJobRuntimeService, JOB_STATUS } = require('../../../modules/agentGateway/services/jobRuntimeService');
const { writeBlueprint } = require('../../../modules/agentGateway/services/forge/blueprint');
const { resolveLifelongRule } = require('../../../modules/agentGateway/services/forge/lifelongScheduler');

function createTempDir() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'forge-lifelong-'));
}

function blueprint() {
    return {
        name: 'UIDesigner',
        displayName: 'UI 设计专家',
        scope: { responsibilities: ['UI 设计'], boundaries: [] },
        subskills: [{ id: 'color-theory', title: '配色理论', searchQueries: ['color theory UI design'] }],
        examOutline: [{ subskillId: 'color-theory', conceptQuestions: 1, appliedQuestions: 1 }],
        practicalExam: { prompt: 'p', gradingDimensions: ['d'] },
        acceptanceSample: 'a'
    };
}

const DISTILL_JSON = JSON.stringify({
    knowledgeUnits: [{
        type: 'concept', title: '新知识卡', oneLiner: 'o', content: 'c', tags: [],
        sourceUrls: ['https://fresh.example.com/new'], mergeInto: null
    }],
    droppedSources: []
});

function buildEnv(baseDir) {
    const jobRuntimeService = createJobRuntimeService();
    const forgeRuntimeService = createForgeRuntimeService({
        jobRuntimeService,
        llmCompletionPort: {
            available: true,
            complete: async (config, payload) => {
                const content = payload.messages[0].content;
                const output = (content.includes('知识蒸馏') || content.includes('材料清单'))
                    ? DISTILL_JSON
                    : 'answer';
                return { data: { choices: [{ message: { content: output } }], usage: { prompt_tokens: 100, completion_tokens: 50 } } };
            }
        },
        toolInvokerPort: {
            invoke: async () => ({ content: [{ type: 'text', text: '新材料\nhttps://fresh.example.com/new\n增量内容' }] })
        },
        knowledgeStorePort: {
            available: true,
            listLibraries: async () => ['UIDesigner知识库'],
            search: async () => [{ title: '新知识卡', text: 'x', score: 0.9 }]
        },
        baseDir: path.join(baseDir, 'forge'),
        knowledgeRoot: path.join(baseDir, 'knowledge'),
        llmConfig: { url: 'http://t', apiKey: 'k', model: 'm' },
        agentMapPath: path.join(baseDir, 'agent_map.json'),
        knowledgePolicyPath: path.join(baseDir, 'policy.json'),
        guidanceConfigPath: path.join(baseDir, 'guidance.json')
    });
    for (const [file, content] of [
        ['agent_map.json', '{}'],
        ['policy.json', JSON.stringify({ restrictedLibraries: {} })],
        ['guidance.json', JSON.stringify({ version: 1, shared: { workflow: [], memoryWritePolicy: { write: [], skip: [] } }, agents: {} })]
    ]) {
        fs.writeFileSync(path.join(baseDir, file), content);
    }
    return { jobRuntimeService, forgeRuntimeService };
}

async function waitFor(predicate, timeoutMs = 10000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (predicate()) {
            return true;
        }
        await new Promise((resolve) => setTimeout(resolve, 25));
    }
    return false;
}

// 验收（M5.S1）：对话中标记的缺口生成并完成一次增量学习；新增知识卡入库且既有旧卡未被删除/修改。
test('gap 登记缺口 → 手动进修（forge.expert.learn）→ 新卡入库 + 旧卡不动 + 缺口关闭 + 学习档案', async () => {
    const baseDir = createTempDir();
    const env = buildEnv(baseDir);
    const forgeRoot = path.join(baseDir, 'forge');
    await writeBlueprint(path.join(forgeRoot, 'blueprints', 'UIDesigner.json'), blueprint());

    // 既有旧卡（进修前）
    const libDir = path.join(baseDir, 'knowledge', 'UIDesigner知识库');
    fs.mkdirSync(libDir, { recursive: true });
    const oldCard = `---\ntitle: 旧卡\ntype: concept\nsubskill: color-theory\nsources:\n  - url: https://old.example.com/a\n    fetchedAt: 2026-10-01T00:00:00.000Z\ntags: [旧]\n---\n\n旧卡正文保持不变。\n`;
    fs.writeFileSync(path.join(libDir, 'K_color-theory_jiuka.md'), oldCard);

    // 1. 专家登记缺口（gateway_gap_report 的服务端）
    const { gap } = await env.forgeRuntimeService.reportGap({
        agentId: 'UIDesigner',
        subskillId: 'color-theory',
        question: '深色模式下的配色策略',
        whyInsufficient: '知识库查不到深色模式条目'
    });
    assert.equal(gap.status, 'open');
    const gapsOnDisk = JSON.parse(fs.readFileSync(path.join(forgeRoot, 'UIDesigner', 'gaps.json'), 'utf8'));
    assert.equal(gapsOnDisk.length, 1);
    assert.equal(gapsOnDisk[0].subskillId, 'color-theory');
    assert.equal((await env.forgeRuntimeService.listOpenGaps('UIDesigner')).length, 1);

    // 未知专家 404
    await assert.rejects(
        env.forgeRuntimeService.reportGap({ agentId: 'Ghost', question: 'q' }),
        (error) => error.status === 404
    );

    // 2. 手动进修（T2：铸造师解析「去学一下 XX」→ forge.expert.learn）
    const learn = await env.forgeRuntimeService.startExpertLearnJob({
        expertName: 'UIDesigner',
        scope: { subskillIds: ['color-theory'], reason: 'manual', topic: '深色模式' }
    });
    await waitFor(() => env.jobRuntimeService.pollJob(learn.jobId, null).data.job.terminal);

    // 3. 新增知识卡入库（红线 3：既有旧卡 diff 为空）
    const newCardFile = fs.readdirSync(libDir).find((f) => f.startsWith('K_') && f !== 'K_color-theory_jiuka.md');
    assert.ok(newCardFile, `新知识卡入库，实际：${fs.readdirSync(libDir)}`);
    const newCard = fs.readFileSync(path.join(libDir, newCardFile), 'utf8');
    assert.match(newCard, /url: https:\/\/fresh\.example\.com\/new/, '新卡带出处');
    assert.equal(fs.readFileSync(path.join(libDir, 'K_color-theory_jiuka.md'), 'utf8'), oldCard, '既有旧卡未被删除/修改（红线 3）');

    // 4. 缺口关闭 + 学习档案留痕（§3.8）
    assert.equal((await env.forgeRuntimeService.listOpenGaps('UIDesigner')).length, 0, '进修完成后缺口关闭');
    const closedGaps = JSON.parse(fs.readFileSync(path.join(forgeRoot, 'UIDesigner', 'gaps.json'), 'utf8'));
    assert.equal(closedGaps[0].status, 'closed');
    assert.ok(closedGaps[0].closedAt);
    const history = fs.readFileSync(path.join(forgeRoot, 'UIDesigner', 'learning-history.jsonl'), 'utf8').trim().split('\n');
    assert.equal(history.length, 1);
    const entry = JSON.parse(history[0]);
    assert.equal(entry.trigger, 'manual');
    assert.equal(entry.sources, 1, '档案记录来源数');
    assert.equal(entry.distilledFiles, 1, '档案记录产出文件数');
    assert.ok(entry.jobId);
});

test('lifelong 调度：手动触发一次周期进修（M5.S2 验收），since 取学习档案', async () => {
    const baseDir = createTempDir();
    const env = buildEnv(baseDir);
    const forgeRoot = path.join(baseDir, 'forge');
    await writeBlueprint(path.join(forgeRoot, 'blueprints', 'UIDesigner.json'), blueprint());

    const { createLifelongScheduler } = require('../../../modules/agentGateway/services/forge/lifelongScheduler');
    const { listExpertNames } = require('../../../modules/agentGateway/services/forge/gapRegistry');
    const scheduler = createLifelongScheduler({
        forgeRuntimeService: env.forgeRuntimeService,
        gapRegistry: env.forgeRuntimeService.gapRegistry,
        listExpertNames: () => listExpertNames({ baseDir: forgeRoot }),
        env: { FORGE_LIFELONG_SCHEDULE: 'disabled', FORGE_LIFELONG_CRON: '' }
    });

    // 预置一条历史（since 应取其 ts）
    await env.forgeRuntimeService.gapRegistry.appendLearningHistory('UIDesigner', {
        trigger: 'manual', scope: null, sources: 0, distilledFiles: 0, jobId: 'job_prev'
    });

    const launched = await scheduler.runScheduledLearning('scheduled-weekly');
    assert.equal(launched.length, 1);
    assert.equal(launched[0].expertName, 'UIDesigner');
    assert.ok(launched[0].since, 'since 取学习档案最后时间');
    await waitFor(() => env.jobRuntimeService.pollJob(launched[0].jobId, null).data.job.terminal);

    const history = fs.readFileSync(path.join(forgeRoot, 'UIDesigner', 'learning-history.jsonl'), 'utf8').trim().split('\n');
    assert.equal(history.length, 2, '周期进修追加档案');
    assert.equal(JSON.parse(history[1]).trigger, 'scheduled-weekly');

    // 规则解析：默认 weekly、disabled、cron 覆盖
    assert.equal(resolveLifelongRule({}).mode, 'weekly');
    assert.equal(resolveLifelongRule({ FORGE_LIFELONG_SCHEDULE: 'disabled' }).mode, 'disabled');
    assert.equal(resolveLifelongRule({ FORGE_LIFELONG_CRON: '0 5 * * 2' }).value, '0 5 * * 2');
});

test('gateway_gap_report / gateway_forge_learn 契约注册（第 9/10 个 MCP 工具）', () => {
    const { MCP_GATEWAY_TOOL_NAMES, GATEWAY_OPERATIONS, gatewayToolSchemas } = require('../../../modules/agentGateway/contracts/operations');
    assert.equal(MCP_GATEWAY_TOOL_NAMES.GAP_REPORT, 'gateway_gap_report');
    assert.equal(MCP_GATEWAY_TOOL_NAMES.FORGE_LEARN, 'gateway_forge_learn');
    const gap = GATEWAY_OPERATIONS['gateway_gap_report'];
    assert.equal(gap.operationId, 'gap.report');
    assert.equal(gap.executor, 'gapReport');
    assert.ok(gatewayToolSchemas['gateway_gap_report'].properties.question);
    assert.ok(gatewayToolSchemas['gateway_forge_learn'].properties.expertName);
    // in-process 执行器注册
    const handlers = require('../../../modules/agentGateway/protocols/mcp/inProcessOperations');
    void handlers;
    const source = require('fs').readFileSync('modules/agentGateway/protocols/mcp/inProcessOperations.js', 'utf8');
    assert.ok(source.includes('gapReport:') && source.includes('forgeLearn:'));
});

test('gateway_forge_learn 的 MCP 参数映射：subskillIds/topic 组装为 scope（阻断项 A 回归）', () => {
    const { buildForgeLearnRequest } = require('../../../modules/agentGateway/protocols/mcp/inProcessOperations');
    assert.deepEqual(
        buildForgeLearnRequest({ expertName: 'UIDesigner', subskillIds: ['color-theory'], topic: '深色模式' }),
        { expertName: 'UIDesigner', scope: { subskillIds: ['color-theory'], topic: '深色模式', reason: 'manual' } }
    );
    assert.deepEqual(
        buildForgeLearnRequest({ expertName: 'UIDesigner' }),
        { expertName: 'UIDesigner' }, '无 subskillIds/topic 不产生空 scope（全量增量）'
    );
    assert.deepEqual(
        buildForgeLearnRequest({ expertName: 'UIDesigner', topic: 'YY', since: '2026-01-01T00:00:00.000Z' }),
        { expertName: 'UIDesigner', since: '2026-01-01T00:00:00.000Z', scope: { topic: 'YY', reason: 'manual' } }
    );
});

test('since 时间过滤：已有出处的来源不重采，BrowserSearch 带 timeRange（阻断项 B 回归）', async () => {
    const baseDir = createTempDir();
    const libDir = path.join(baseDir, 'knowledge', 'UIDesigner知识库');
    fs.mkdirSync(libDir, { recursive: true });
    fs.writeFileSync(path.join(libDir, 'K_color-theory_jiu.md'), `---\ntitle: 旧卡\ntype: concept\nsources:\n  - url: https://old.example.com/seen\n    fetchedAt: 2026-10-01T00:00:00.000Z\n---\n\n旧卡。\n`);

    const searchCalls = [];
    const jobRuntimeService = createJobRuntimeService();
    const forgeRuntimeService = createForgeRuntimeService({
        jobRuntimeService,
        llmCompletionPort: {
            available: true,
            complete: async (config, payload) => {
                const output = (payload.messages[0].content.includes('知识蒸馏') || payload.messages[0].content.includes('材料清单'))
                    ? DISTILL_JSON : 'answer';
                return { data: { choices: [{ message: { content: output } }], usage: { prompt_tokens: 1, completion_tokens: 1 } } };
            }
        },
        toolInvokerPort: {
            invoke: async (toolName, args) => {
                searchCalls.push({ toolName, args });
                if (toolName === 'BrowserSearch') {
                    return { content: [{ type: 'text', text: '新\nhttps://fresh.example.com/next\n新内容' }] };
                }
                // AnySearch 返回新旧混合（旧来源应被 since 过滤掉）
                return { content: [{ type: 'text', text: '旧\nhttps://old.example.com/seen\n已蒸馏\n\n新\nhttps://fresh.example.com/next\n新内容' }] };
            }
        },
        knowledgeStorePort: {
            available: true,
            listLibraries: async () => ['UIDesigner知识库'],
            search: async () => [{ title: 't', text: 'x', score: 1 }]
        },
        baseDir: path.join(baseDir, 'forge'),
        knowledgeRoot: path.join(baseDir, 'knowledge'),
        llmConfig: { url: 'http://t', apiKey: 'k', model: 'm' },
        agentMapPath: path.join(baseDir, 'a.json'),
        knowledgePolicyPath: path.join(baseDir, 'p.json'),
        guidanceConfigPath: path.join(baseDir, 'g.json')
    });
    await writeBlueprint(path.join(baseDir, 'forge', 'blueprints', 'UIDesigner.json'), blueprint());

    const { jobId } = await forgeRuntimeService.startExpertLearnJob({
        expertName: 'UIDesigner',
        since: new Date(Date.now() - 14 * 86400000).toISOString(), // 两周前 → month 档
        scope: { reason: 'scheduled-weekly' }
    });
    await waitFor(() => jobRuntimeService.pollJob(jobId, null).data.job.terminal);

    // 旧来源未重采，只保留新增来源
    const rawDir = path.join(baseDir, 'forge', 'runs', jobId, 'raw', 'color-theory');
    const metas = fs.readdirSync(rawDir).filter((f) => f.endsWith('.meta.json'))
        .map((f) => JSON.parse(fs.readFileSync(path.join(rawDir, f), 'utf8')));
    assert.equal(metas.length, 1, `只采新来源，实际 ${JSON.stringify(metas.map((m) => m.url))}`);
    assert.equal(metas[0].url, 'https://fresh.example.com/next');
    const manifest = JSON.parse(fs.readFileSync(path.join(rawDir, 'manifest.json'), 'utf8'));
    assert.equal(manifest.incremental, true);
    assert.ok(manifest.since);
    // timeRange 档位计算（两周前 → month）；AnySearch 调用不带 timeRange（插件不支持）
    const { timeRangeFromSince } = require('../../../modules/agentGateway/services/forge/harvest');
    assert.equal(timeRangeFromSince(new Date(Date.now() - 14 * 86400000).toISOString()), 'month');
    assert.equal(timeRangeFromSince(new Date(Date.now() - 3 * 86400000).toISOString()), 'week');
    assert.equal(timeRangeFromSince(new Date(Date.now() - 200 * 86400000).toISOString()), 'year');
    assert.equal(timeRangeFromSince(new Date(Date.now() - 400 * 86400000).toISOString()), null, '超一年不过滤');
    assert.equal(timeRangeFromSince(null), null);
    const anyCalls = searchCalls.filter((c) => c.toolName === 'AnySearch');
    assert.ok(anyCalls.length >= 1);
    assert.equal(anyCalls.every((c) => !c.args.timeRange), true, 'AnySearch 不带 timeRange');
});

test('gateway_forge_create / gateway_forge_confirm 的 MCP 参数映射', () => {
    const { buildForgeCreateRequest, buildForgeConfirmRequest } = require('../../../modules/agentGateway/protocols/mcp/inProcessOperations');
    assert.deepEqual(
        buildForgeCreateRequest({ requirement: '造一个 UI 设计专家', budgetCny: 5 }),
        { requirement: '造一个 UI 设计专家', budgetCny: 5 }
    );
    assert.deepEqual(
        buildForgeCreateRequest({ requirement: 'r' }),
        { requirement: 'r' }, '缺省预算不注入'
    );
    assert.deepEqual(
        buildForgeCreateRequest({ requirement: 'r', blueprintJson: { name: 'X' } }),
        { requirement: 'r', blueprintOverride: { name: 'X' } }, 'blueprintJson → blueprintOverride'
    );
    assert.deepEqual(
        buildForgeConfirmRequest({ jobId: 'j1', approved: true, feedback: '', renameTo: 'New', overwrite: false }),
        { approved: true, renameTo: 'New' }, '空 feedback/未开 overwrite 不注入'
    );
    assert.deepEqual(
        buildForgeConfirmRequest({ approved: 'true' }),
        { approved: false }, '非布尔 true 一律视为拒绝（受控）'
    );
});

// ── forge 工具访问边界（用户决策：编排三件套仅 ForgeMaster；gap_report 自报/代报）──

test('toolAccess：编排工具列表对非 ForgeMaster 隐藏，gap_report 保持可见；调用守卫 403 矩阵', () => {
    const {
        FORGE_MASTER_AGENT,
        filterGatewayToolsForAgent,
        assertForgeToolAccess
    } = require('../../../modules/agentGateway/services/forge/toolAccess');

    const all = ['gateway_job_get', 'gateway_forge_create', 'gateway_forge_confirm', 'gateway_forge_learn', 'gateway_gap_report']
        .map((name) => ({ name }));

    // 列表过滤（注入 baseDir 模拟铸造状态，避免依赖真实运行数据）
    const os = require('node:os');
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-vis-'));
    fs.mkdirSync(path.join(tmpRoot, 'blueprints'), { recursive: true });
    fs.writeFileSync(path.join(tmpRoot, 'blueprints', 'UIDesigner.json'), '{}');
    const options = { baseDir: tmpRoot };

    assert.deepEqual(
        filterGatewayToolsForAgent(all, FORGE_MASTER_AGENT, options).map((t) => t.name),
        all.map((t) => t.name),
        'ForgeMaster 全量可见'
    );
    assert.deepEqual(
        filterGatewayToolsForAgent(all, 'UIDesigner', options).map((t) => t.name),
        ['gateway_job_get', 'gateway_gap_report'],
        '已铸造专家：仅 gap_report（自报通道），编排三件套不可见'
    );
    assert.deepEqual(
        filterGatewayToolsForAgent(all, 'Nexus', options).map((t) => t.name),
        ['gateway_job_get'],
        '非铸造 agent：0 个 forge 工具可见'
    );
    assert.deepEqual(
        filterGatewayToolsForAgent(all, '', options).map((t) => t.name),
        ['gateway_job_get'],
        '未认证发现请求同样不可见'
    );

    // 调用守卫矩阵
    for (const tool of ['gateway_forge_create', 'gateway_forge_confirm', 'gateway_forge_learn']) {
        assert.throws(
            () => assertForgeToolAccess({ toolName: tool, requesterAgentId: 'Nexus' }),
            (error) => error.status === 403 && error.code === 'AGW_FORBIDDEN',
            `${tool} 非 ForgeMaster 403`
        );
        assertForgeToolAccess({ toolName: tool, requesterAgentId: FORGE_MASTER_AGENT });
    }
    // gap_report：自报放行、代报仅 ForgeMaster、冒名 403
    assertForgeToolAccess({ toolName: 'gateway_gap_report', requesterAgentId: 'UIDesigner', targetAgentId: 'UIDesigner' });
    assertForgeToolAccess({ toolName: 'gateway_gap_report', requesterAgentId: 'UIDesigner', targetAgentId: null });
    assertForgeToolAccess({ toolName: 'gateway_gap_report', requesterAgentId: FORGE_MASTER_AGENT, targetAgentId: 'UIDesigner' });
    assert.throws(
        () => assertForgeToolAccess({ toolName: 'gateway_gap_report', requesterAgentId: 'Nexus', targetAgentId: 'UIDesigner' }),
        (error) => error.status === 403,
        '非 ForgeMaster 冒名代报 403'
    );
});

// backend-proxy 模式的 tools/list 同边界：midas 等非铸造师 agent 不可见编排工具
// （用户实测反馈：midas 连接仍能看到 gateway_forge_confirm —— 根因是 proxy 路径漏过滤）。
test('backendProxy tools/list：非 ForgeMaster 隐藏编排三件套，ForgeMaster 全量', async () => {
    const { createBackendProxyMcpAdapter } = require('../../../modules/agentGateway/protocols/mcp/backendProxyExecutor');
    const toolNames = (result) => result.tools.map((tool) => tool.name);

    const adapter = createBackendProxyMcpAdapter({
        backendClient: { /* listTools 不经网络，占位即可 */ },
        defaultAgentId: 'MCPMidas',
        discoveryDefaultAgentEnabled: true
    });

    // midas（默认 agent、非铸造）视角：0 个 forge 工具
    const midasList = await adapter.listTools({ requestContext: { requestId: 'req-midas' } });
    const midasTools = toolNames(midasList);
    assert.ok(!midasTools.includes('gateway_forge_create'), 'midas 不可见 forge_create');
    assert.ok(!midasTools.includes('gateway_forge_confirm'), 'midas 不可见 forge_confirm');
    assert.ok(!midasTools.includes('gateway_forge_learn'), 'midas 不可见 forge_learn');
    assert.ok(!midasTools.includes('gateway_gap_report'), 'midas 非铸造专家，gap_report 也不可见');
    assert.ok(midasTools.includes('gateway_job_get'), '常规工具不受影响');

    // 显式请求 ForgeMaster 视角（绑定凭据场景由 resolveDiscoveryScope 决议，此处直接传）
    const masterList = await adapter.listTools({
        agentId: 'ForgeMaster',
        requestContext: { requestId: 'req-master' }
    });
    assert.ok(toolNames(masterList).includes('gateway_forge_confirm'), 'ForgeMaster 全量可见');

    // agent-less（无默认、无请求 agent）也不可见
    const anonAdapter = createBackendProxyMcpAdapter({
        backendClient: {},
        defaultAgentId: '',
        discoveryDefaultAgentEnabled: false
    });
    const anonList = await anonAdapter.listTools({ requestContext: { requestId: 'req-anon' } });
    assert.ok(!toolNames(anonList).includes('gateway_forge_create'), '匿名发现请求不可见');
});

// SKILL.md 生成按记忆面定制：无日记面的 agent（ForgeMaster）不被教唆调记忆工具。
test('skillGenerator：无记忆面 agent 的 SKILL.md 不含 recall/memory 教唆，含记忆边界说明', () => {
    const { generateSkillArtifact, hasMemorySurface } = require('../../../modules/agentGateway/services/skillGeneratorService');
    const guidance = {
        agentId: 'ForgeMaster',
        displayName: 'ForgeMaster（铸造师）',
        allowedDiaries: [],
        defaultDiaries: [],
        memoryDefaults: { tags: ['ForgeMaster'], metadata: {} },
        workflow: ['发起铸造用 gateway_forge_create'],
        skill: { domain: '专家铸造炉对话入口', triggers: ['铸造新专家'], notFor: ['无关问答'] }
    };
    assert.equal(hasMemorySurface(guidance), false, 'ForgeMaster 无记忆面');

    const artifact = generateSkillArtifact({ guidance, format: 'claude', baseUrl: 'http://127.0.0.1:6005' });
    assert.equal(artifact.ok, true, `生成成功，实际 ${JSON.stringify(artifact).slice(0, 120)}`);
    const skillFile = artifact.files.find((file) => file.path.endsWith('.md')) || artifact.files[0];
    const markdown = skillFile.content;
    // 断言「教唆」形态：调用示例与速查表行不出现；禁止性提及（记忆边界说明）允许存在
    assert.ok(!markdown.includes('gateway_recall_run {'), '不教唆调 recall_run');
    assert.ok(!markdown.includes('gateway_memory_write {'), '不教唆调 memory_write（无调用示例）');
    assert.ok(!/\| `gateway_memory_write`/.test(markdown), '速查表不含 memory_write 行');
    assert.ok(!/\| `gateway_memory_search`/.test(markdown), '速查表不含 memory_search 行');
    assert.match(markdown, /记忆边界（本 agent 无记忆面）/, '含记忆边界说明段');
    assert.match(markdown, /不要调用.*gateway_memory_write/, '边界说明明确禁止记忆工具');
    assert.match(markdown, /gateway_forge_create/, 'workflow 指引保留');
    // 对照：有记忆面的 agent 行为不变
    const withMemory = generateSkillArtifact({
        guidance: {
            ...guidance,
            agentId: 'MCPFuPeng',
            displayName: '付鹏',
            allowedDiaries: ['付鹏市场判断日记本'],
            defaultDiaries: ['付鹏市场判断日记本']
        },
        format: 'claude',
        baseUrl: 'http://127.0.0.1:6005'
    });
    const withMemoryFile = withMemory.files.find((file) => file.path.endsWith('.md')) || withMemory.files[0];
    const withMemoryMd = withMemoryFile.content;
    assert.match(withMemoryMd, /gateway_recall_run/, '有记忆面 agent 保留召回指引');
    assert.match(withMemoryMd, /gateway_memory_write/, '有记忆面 agent 保留存档指引');
});
