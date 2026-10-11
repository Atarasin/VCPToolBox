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

    // 列表过滤
    assert.deepEqual(
        filterGatewayToolsForAgent(all, FORGE_MASTER_AGENT).map((t) => t.name),
        all.map((t) => t.name),
        'ForgeMaster 全量可见'
    );
    assert.deepEqual(
        filterGatewayToolsForAgent(all, 'Nexus').map((t) => t.name),
        ['gateway_job_get', 'gateway_gap_report'],
        '非 ForgeMaster 隐藏编排三件套，gap_report 保留（专家自报通道）'
    );
    assert.deepEqual(
        filterGatewayToolsForAgent(all, '').map((t) => t.name),
        ['gateway_job_get', 'gateway_gap_report'],
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
