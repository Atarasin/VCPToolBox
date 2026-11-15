const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { createForgeRuntimeService } = require('../../../modules/agentGateway/services/forge/service');
const { createJobRuntimeService, JOB_STATUS } = require('../../../modules/agentGateway/services/jobRuntimeService');
const { writeBlueprint } = require('../../../modules/agentGateway/services/forge/blueprint');

function createTempDir() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'forge-distill-'));
}

function buildUiDesignerBlueprint() {
    return {
        name: 'UIDesigner',
        displayName: 'UI 设计专家',
        scope: { responsibilities: ['UI 设计'], boundaries: [] },
        subskills: [
            { id: 'color-theory', title: '配色理论', searchQueries: ['color theory UI design'] }
        ],
        examOutline: [
            { subskillId: 'color-theory', conceptQuestions: 1, appliedQuestions: 1 }
        ],
        practicalExam: { prompt: 'SaaS 落地页设计方案', gradingDimensions: ['眼前一亮'] },
        acceptanceSample: '去 AI 味的设计图'
    };
}

function llmResponse(content, finishReason) {
    return {
        data: {
            choices: [{ message: { content }, ...(finishReason ? { finish_reason: finishReason } : {}) }],
            usage: { prompt_tokens: 800, completion_tokens: 600 }
        }
    };
}

function anySearchText(entries) {
    return entries.map((e) => `${e.title}\n${e.url}\n${e.snippet}`).join('\n\n');
}

const MATERIALS = [
    { title: 'Color Theory Basics', url: 'https://www.interaction-design.org/literature/topics/color-theory', snippet: '色彩理论基础知识。' },
    { title: 'Color and UI', url: 'https://www.smashingmagazine.com/2020/04/color-ui-design/', snippet: 'UI 配色实践指南。' },
    { title: 'Material Design color', url: 'https://m3.material.io/styles/color/overview', snippet: '官方色彩系统文档。' }
];

const DISTILL_OUTPUT = JSON.stringify({
    knowledgeUnits: [
        {
            type: 'concept',
            title: '色轮与色彩三属性',
            oneLiner: '色相/饱和度/明度构成色彩描述的基础坐标系。',
            content: '## 色轮\n\n色轮以色相环形式组织颜色……\n\n- 色相（Hue）\n- 饱和度（Saturation）\n- 明度（Value）',
            tags: ['配色', '基础'],
            sourceUrls: ['https://www.interaction-design.org/literature/topics/color-theory'],
            mergeInto: null
        },
        {
            type: 'methodology',
            title: '界面配色工作流',
            oneLiner: '从品牌主色到中性色阶的系统化配色流程。',
            content: '1. 确定品牌主色\n2. 生成色阶\n3. 定义语义色\n4. 校验对比度',
            tags: ['方法论'],
            sourceUrls: ['https://www.smashingmagazine.com/2020/04/color-ui-design/', 'https://m3.material.io/styles/color/overview'],
            mergeInto: null
        },
        {
            type: 'concept',
            title: '对比度无源概念',
            oneLiner: '无出处的知识点不应入库。',
            content: '这个单元没有来源。',
            tags: [],
            sourceUrls: [],
            mergeInto: null
        },
        {
            type: 'pitfall',
            title: '编造来源的单元',
            oneLiner: '声称的 URL 不在材料清单中。',
            content: '来源是 LLM 幻觉。',
            tags: [],
            sourceUrls: ['https://totally-fabricated.example.com/fake'],
            mergeInto: null
        },
        {
            type: 'case',
            title: '半真半假来源的单元',
            oneLiner: '一条真一条编。',
            content: '部分来源有效。',
            tags: [],
            sourceUrls: ['https://www.smashingmagazine.com/2020/04/color-ui-design/', 'https://fabricated.example.com/also-fake'],
            mergeInto: null
        }
    ],
    droppedSources: [
        { url: 'https://m3.material.io/styles/color/overview', reason: '已部分采用，示例性丢弃条目' }
    ]
});

async function waitFor(predicate, timeoutMs = 8000, intervalMs = 25) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (predicate()) {
            return true;
        }
        await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
    return false;
}

// M4 T30/T31：索引就绪端口的测试替身——search 命中"已写文件"（sourceFile 对齐
// assertIndexReady 的正向探针），状态 compatible、队列空。
function readyPort(baseDir, { hits } = {}) {
    return {
        available: true,
        listLibraries: async () => ['UIDesigner知识库'],
        search: async () => {
            if (hits !== undefined) return hits;
            try {
                const libDir = path.join(baseDir, 'knowledge', 'UIDesigner知识库');
                return fs.readdirSync(libDir).map((f) => ({ sourceFile: `UIDesigner知识库/${f}`, text: f, score: 1 }));
            } catch {
                return [];
            }
        },
        getInitializationStatus: () => ({ state: 'compatible', initialized: true }),
        pendingIngestCount: () => 0
    };
}

function buildPipeline({ baseDir, llmOutputs, finishReason, knowledgeStorePort, smokeRetries = null, smokeIntervalMs = null, materials = MATERIALS, llmComplete = null, blueprint = null }) {
    const jobRuntimeService = createJobRuntimeService();
    const llmCalls = [];
    const toolInvoker = {
        // M4 T25：取证链调用返回主题全文（>200 字符）供证据归档与主张核验；
        // 搜索调用返回发现摘要。主张提示由 llmOutputs 单输出风格兜底
        //（返回蒸馏 JSON → claims 为空 → CLAIMS_EMPTY 非阻断）。
        async invoke(toolName, args) {
            const isFetch = ['UrlFetch', 'ChromeBridge'].includes(toolName)
                || args?.command === 'web_fetch' || args?.command === 'extract';
            if (isFetch) {
                const long = '配色理论完整指南（证据全文）：色轮以色相环组织颜色，色相决定色系，饱和度决定纯度，明度决定深浅，三者共同构成配色的坐标系。'
                    + 'UI 配色实践中先确定品牌主色，再由主色生成完整色阶，语义色沿用同一色板体系命名。对比度校验遵循 WCAG：普通文本与背景对比度至少 4.5:1，'
                    + '大字号文本（≥18pt 或 ≥14pt 粗体）至少 3:1。深色模式先降低大面积背景明度，再提升前景与背景对比度。'
                    + '栅格与间距遵循 8pt 体系，本全文超过取证链 200 字符最小阈值，用于证据归档与主张核验。';
                return { content: [{ type: 'text', text: long }] };
            }
            return { content: [{ type: 'text', text: anySearchText(materials) }] };
        }
    };
    const llmPort = {
        available: true,
        complete: llmComplete
            ? async (config, payload) => {
                llmCalls.push(payload);
                return llmComplete(config, payload);
            }
            : async (config, payload) => {
                llmCalls.push(payload);
                const content = payload.messages[0].content;
                // M4 主张核验提示：返回空集（无主张 → CLAIMS_EMPTY 非阻断），
                // 不与蒸馏批输出混用（截断输出会给核验器喂坏 JSON）。
                if (content.includes('知识主张提取器')) {
                    return llmResponse(JSON.stringify({ claims: [] }));
                }
                if (content.includes('独立主张核验员')) {
                    return llmResponse(JSON.stringify({ judged: [] }));
                }
                const next = llmOutputs.length > 1 ? llmOutputs.shift() : llmOutputs[0];
                return llmResponse(next, finishReason);
            }
    };
    const forgeRuntimeService = createForgeRuntimeService({
        jobRuntimeService,
        llmCompletionPort: llmPort,
        toolInvokerPort: toolInvoker,
        knowledgeStorePort,
        baseDir,
        knowledgeRoot: path.join(baseDir, 'knowledge'),
        // M4 fail-closed：不显式给端口时用"就绪"替身（探针按已写文件命中）；
        // 显式传 null/坏端口即测 fail-closed 路径。
        knowledgeStorePort: knowledgeStorePort === undefined ? readyPort(baseDir) : knowledgeStorePort,
        llmConfig: { url: 'http://t', apiKey: 'k', model: 'm' },
        ...(smokeRetries != null ? { smokeRetries } : {}),
        ...(smokeIntervalMs != null ? { smokeIntervalMs } : {})
    });
    return { jobRuntimeService, forgeRuntimeService, llmCalls, blueprint: blueprint || buildUiDesignerBlueprint() };
}

async function runToDistillComplete(jobRuntimeService, forgeRuntimeService, blueprintOverride = null) {
    const { jobId } = await forgeRuntimeService.startExpertCreateJob({
        requirement: '造一个 UI 设计专家',
        blueprintOverride: blueprintOverride || buildUiDesignerBlueprint()
    });
    await waitFor(() => jobRuntimeService.pollJob(jobId, null).data.job.status === JOB_STATUS.PENDING_CONFIRM);
    await forgeRuntimeService.confirmBlueprint(jobId, { approved: true });
    // harvest → distill → synthesize(pending 桩) → failed
    await waitFor(() => jobRuntimeService.pollJob(jobId, null).data.job.terminal);
    return jobId;
}

// 验收（M2.S2）：蒸馏完成后新库可检索（冒烟），每个知识卡带 ≥1 条出处。
test('distill：分流落盘、出处 frontmatter、质量过滤留档、冒烟验证通过', async () => {
    const baseDir = createTempDir();
    const smokeCalls = [];
    // 目录扫描替身：探针运行时文件已写盘，readdir 即真实命中集。
    const knowledgeStorePort = readyPort(baseDir);
    const originalSearch = knowledgeStorePort.search;
    knowledgeStorePort.search = async (query, options) => {
        smokeCalls.push({ query, options });
        return originalSearch(query, options);
    };
    const { jobRuntimeService, forgeRuntimeService } = buildPipeline({
        baseDir,
        llmOutputs: [DISTILL_OUTPUT],
        knowledgeStorePort
    });
    const jobId = await runToDistillComplete(jobRuntimeService, forgeRuntimeService);

    const job = jobRuntimeService.pollJob(jobId, null).data.job;
    assert.equal(job.status, 'failed');
    assert.equal(job.metadata.forge.error.step, 'synthesize', 'distill 应已完成，失败点在 synthesize 桩');

    const libDir = path.join(baseDir, 'knowledge', 'UIDesigner知识库');
    const files = fs.readdirSync(libDir);
    const cardFile = files.find((f) => f.startsWith('K_color-theory_') && f.includes('色轮'));
    assert.ok(cardFile, `知识卡应存在，实际：${files}`);
    const cardRaw = fs.readFileSync(path.join(libDir, cardFile), 'utf8');
    assert.match(cardRaw, /^---\n/);
    assert.match(cardRaw, /title: 色轮与色彩三属性/);
    assert.match(cardRaw, /type: concept/);
    assert.match(cardRaw, /subskill: color-theory/);
    assert.match(cardRaw, /url: https:\/\/www\.interaction-design\.org/);
    assert.match(cardRaw, /fetchedAt: \d{4}-\d{2}-\d{2}T/);
    assert.match(cardRaw, /tags: \[配色, 基础\]/);

    // D2 分流：methodology → NN 长文档
    const longDoc = files.find((f) => /^\d{2}_/.test(f));
    assert.ok(longDoc, `长文档应存在，实际：${files}`);
    const docRaw = fs.readFileSync(path.join(libDir, longDoc), 'utf8');
    assert.match(docRaw, /^# 界面配色工作流/);
    assert.match(docRaw, /> 来源：https:\/\/www\.smashingmagazine\.com/);

    // 红线 4：无出处单元不入库；编造 URL 的单元整卡拒绝
    assert.ok(!files.some((f) => f.includes('无源概念') || f.includes('对比度无源')), '无出处单元不应入库');
    assert.ok(!files.some((f) => f.includes('fabricated') || f.includes('编造来源')), '纯编造来源单元不应入库');
    // 半真半假：入库但剔除编造 URL，只留真实材料来源
    const halfTrue = files.find((f) => f.includes('半真半假'));
    assert.ok(halfTrue, '半真半假单元应入库（存在有效来源）');
    const halfTrueRaw = fs.readFileSync(path.join(libDir, halfTrue), 'utf8');
    assert.match(halfTrueRaw, /smashingmagazine\.com/);
    assert.ok(!halfTrueRaw.includes('fabricated.example.com'), '编造 URL 不应出现在知识卡');

    // 质量过滤留档
    const droppedPath = path.join(baseDir, 'runs', jobId, 'distill-dropped.json');
    assert.ok(fs.existsSync(droppedPath));
    const dropped = JSON.parse(fs.readFileSync(droppedPath, 'utf8'));
    assert.ok(dropped.dropped.length >= 4, '丢弃留档含 LLM 丢弃 + 无出处 + 编造来源');
    assert.ok(dropped.dropped.some((d) => d.url === '(no source)' && d.reason.includes('红线 4')));
    assert.ok(dropped.dropped.some((d) => d.url === 'https://totally-fabricated.example.com/fake' && d.reason.includes('疑似编造')), '编造来源留档');
    assert.ok(dropped.dropped.some((d) => d.url === 'https://fabricated.example.com/also-fake' && d.reason.includes('疑似编造')), '半真单元的编造来源留档');

    // S3：知识卡 fetchedAt 回填材料抓取时刻（而非蒸馏时刻）
    const cardMeta = fs.readdirSync(path.join(baseDir, 'runs', jobId, 'raw', 'color-theory'))
        .filter((f) => f.endsWith('.meta.json'))
        .map((f) => JSON.parse(fs.readFileSync(path.join(baseDir, 'runs', jobId, 'raw', 'color-theory', f), 'utf8')))
        .find((meta) => meta.url.includes('interaction-design.org'));
    const cardFetchedAt = cardRaw.match(/fetchedAt: (\S+)\s*\n|fetchedAt: ([^\n}]+)/)?.[0] || '';
    assert.ok(cardFetchedAt.includes(cardMeta.fetchedAt.slice(0, 19)), `卡片时间应回填材料抓取时刻：${cardFetchedAt} vs ${cardMeta.fetchedAt}`);

    // 索引就绪探针（T30）：全部预期文件正向命中后才允许落成功 marker
    assert.equal(smokeCalls.length >= 1, true);
    assert.deepEqual(smokeCalls[0].options.libraries, ['UIDesigner知识库']);
});

// M4 T29（§3.3.3）：合并先分类——纯重复（正文一致）自动并来源；
// 内容变化 → 复核建议 + 单元落复核区，绝不静默覆盖（红线 6）。
const OLD_CARD_BODY = '旧卡正文不可被修改，讲述色轮基础与配色理论的关系，正文保持原样即可支撑检索。';

function writeOldCard(libDir) {
    const existingCard = `---
title: "既有卡：色轮基础"
oneLiner: "旧卡摘要"
type: concept
subskill: color-theory
sources:
  - { url: "https://old-source.example.com/page", fetchedAt: "2026-10-01T00:00:00.000Z" }
tags: [旧]
---

${OLD_CARD_BODY}
`;
    fs.writeFileSync(path.join(libDir, 'K_color-theory_jyoukyuu.md'), existingCard);
}

function mergeUnitOutput(content) {
    return JSON.stringify({
        knowledgeUnits: [{
            type: 'concept',
            title: '色轮（同义新说法）',
            oneLiner: '同义知识点',
            content,
            tags: [],
            sourceUrls: ['https://www.interaction-design.org/literature/topics/color-theory'],
            mergeInto: '既有卡：色轮基础'
        }],
        droppedSources: []
    });
}

test('distill：mergeInto 纯重复（正文一致）自动并来源，正文不动（红线 3）', async () => {
    const baseDir = createTempDir();
    const libDir = path.join(baseDir, 'knowledge', 'UIDesigner知识库');
    fs.mkdirSync(libDir, { recursive: true });
    writeOldCard(libDir);

    const { jobRuntimeService, forgeRuntimeService } = buildPipeline({
        baseDir,
        llmOutputs: [mergeUnitOutput(OLD_CARD_BODY)]
    });
    const jobId = await runToDistillComplete(jobRuntimeService, forgeRuntimeService);

    const files = fs.readdirSync(libDir);
    assert.equal(files.filter((f) => f.startsWith('K_')).length, 1, '不应新增知识卡');
    const mergedRaw = fs.readFileSync(path.join(libDir, 'K_color-theory_jyoukyuu.md'), 'utf8');
    assert.match(mergedRaw, /旧卡正文不可被修改/, '正文不动');
    assert.match(mergedRaw, /old-source\.example\.com/);
    assert.match(mergedRaw, /interaction-design\.org/);
    const sourceCount = (mergedRaw.match(/  - url: /g) || []).length;
    assert.equal(sourceCount, 2, '来源并集');
    assert.match(mergedRaw, /fetchedAt: 2026-10-01T00:00:00\.000Z/, '旧来源时间戳保留');

    const runDir = path.join(baseDir, 'runs', jobId);
    const marker = JSON.parse(fs.readFileSync(path.join(runDir, 'steps', 'distill.json'), 'utf8'));
    assert.match(marker.summary, /1 次合并/);
    assert.equal(marker.state.mergeProposals.length, 0);
});

test('distill：mergeInto 内容变化生成复核建议，不自动覆盖（红线 6）', async () => {
    const baseDir = createTempDir();
    const libDir = path.join(baseDir, 'knowledge', 'UIDesigner知识库');
    fs.mkdirSync(libDir, { recursive: true });
    writeOldCard(libDir);

    const { jobRuntimeService, forgeRuntimeService } = buildPipeline({
        baseDir,
        llmOutputs: [mergeUnitOutput('与旧卡不同的新表述：色轮应按感知均匀色彩空间组织，并给出新的配色理论推导路径。' + '补充细节。'.repeat(20))]
    });
    const jobId = await runToDistillComplete(jobRuntimeService, forgeRuntimeService);

    const mergedRaw = fs.readFileSync(path.join(libDir, 'K_color-theory_jyoukyuu.md'), 'utf8');
    assert.doesNotMatch(mergedRaw, /感知均匀/, '旧卡正文不被新内容覆盖');
    assert.doesNotMatch(mergedRaw, /interaction-design\.org/, '来源也不并入（未确认纯重复）');

    const marker = JSON.parse(fs.readFileSync(path.join(baseDir, 'runs', jobId, 'steps', 'distill.json'), 'utf8'));
    assert.equal(marker.state.mergeProposals.length, 1);
    assert.equal(marker.state.mergeProposals[0].classification, 'content-revision');
    // 单元本身落复核区，供用户对照采纳。
    const reviewDir = path.join(baseDir, 'runs', jobId, 'review', 'UIDesigner知识库');
    assert.ok(fs.readdirSync(reviewDir).some((f) => f.includes('R_')), '复核区应有待审单元');
});

test('distill：知识内容含密钥被阻断落盘（红线 2）', async () => {
    const baseDir = createTempDir();
    const leakyOutput = JSON.stringify({
        knowledgeUnits: [{
            type: 'concept',
            title: '带密钥的单元',
            oneLiner: 'x',
            content: '配置示例与部署说明如下，密钥形如 sk-abcdefghijklmnopqrstuvwx，其余正文撑到完整性与主题门禁阈值之上，避免被薄内容门禁先行拦截。',
            tags: [],
            sourceUrls: ['https://www.interaction-design.org/literature/topics/color-theory'],
            mergeInto: null
        }],
        droppedSources: []
    });
    const { jobRuntimeService, forgeRuntimeService } = buildPipeline({
        baseDir,
        llmOutputs: [leakyOutput],
        knowledgeStorePort: { available: true, listLibraries: async () => [], search: async () => [{ text: 'x' }] }
    });
    const jobId = await runToDistillComplete(jobRuntimeService, forgeRuntimeService);
    const job = jobRuntimeService.pollJob(jobId, null).data.job;
    assert.equal(job.status, 'failed');
    assert.equal(job.metadata.forge.error.code, 'FORGE_SECRET_DETECTED');
    assert.equal(job.metadata.forge.error.step, 'distill');
    const libDir = path.join(baseDir, 'knowledge', 'UIDesigner知识库');
    assert.ok(!fs.existsSync(libDir) || fs.readdirSync(libDir).length === 0, '不应有任何文件落盘');
});

// M4 T31（§3.8.2 fail-open 反转）：索引不可用/未知 → distill 不得完成。
test('distill：TDB 未启用（端口不可用）fail closed——不落成功 marker，已写文件 demote（§3.6.1）', async () => {
    const baseDir = createTempDir();
    const { jobRuntimeService, forgeRuntimeService } = buildPipeline({
        baseDir,
        llmOutputs: [DISTILL_OUTPUT],
        knowledgeStorePort: null
    });
    const jobId = await runToDistillComplete(jobRuntimeService, forgeRuntimeService);
    const job = jobRuntimeService.pollJob(jobId, null).data.job;
    assert.equal(job.metadata.forge.error.step, 'distill', '失败点必须是 distill');
    assert.equal(job.metadata.forge.error.code, 'FORGE_INDEX_NOT_READY');
    // 不落成功 marker
    assert.ok(!fs.existsSync(path.join(baseDir, 'runs', jobId, 'steps', 'distill.json')), 'distill marker 不得落盘');
    // 已写文件 demote 到复核区（活动库零污染），源库目录应为空/不存在
    const libDir = path.join(baseDir, 'knowledge', 'UIDesigner知识库');
    assert.ok(!fs.existsSync(libDir) || fs.readdirSync(libDir).length === 0, '活动库不应残留未验证文件');
    const reviewDir = path.join(baseDir, 'runs', jobId, 'review', 'UIDesigner知识库');
    assert.ok(fs.existsSync(reviewDir) && fs.readdirSync(reviewDir).length > 0, '已写文件应 demote 到复核区');
});

test('distill：探针持续未命中 fail closed（不再降级为告警放行）', async () => {
    const baseDir = createTempDir();
    let searches = 0;
    const { jobRuntimeService, forgeRuntimeService } = buildPipeline({
        baseDir,
        llmOutputs: [DISTILL_OUTPUT],
        knowledgeStorePort: {
            available: true,
            listLibraries: async () => ['UIDesigner知识库'],
            search: async () => {
                searches += 1;
                return []; // 永不命中
            },
            getInitializationStatus: () => ({ state: 'compatible', initialized: true }),
            pendingIngestCount: () => 0
        },
        smokeRetries: 2,
        smokeIntervalMs: 10
    });
    const jobId = await runToDistillComplete(jobRuntimeService, forgeRuntimeService);
    const job = jobRuntimeService.pollJob(jobId, null).data.job;
    assert.equal(job.metadata.forge.error.code, 'FORGE_INDEX_NOT_READY');
    assert.ok(searches >= 2, '超时窗口内多次探针');
    assert.ok(!fs.existsSync(path.join(baseDir, 'runs', jobId, 'steps', 'distill.json')), '未就绪不落 marker');
    const libDir = path.join(baseDir, 'knowledge', 'UIDesigner知识库');
    assert.ok(!fs.existsSync(libDir) || fs.readdirSync(libDir).length === 0, '活动库零污染');
});

test('distill：LLM 输出不可解析时带重试指令重试一次（费用入护栏）', async () => {
    const baseDir = createTempDir();
    const llmCalls = [];
    const jobRuntimeService = require('node:assert');
    const { createJobRuntimeService: createJrs } = require('../../../modules/agentGateway/services/jobRuntimeService');
    const jrs = createJrs();
    const toolInvoker = {
        async invoke() {
            return { content: [{ type: 'text', text: anySearchText(MATERIALS) }] };
        }
    };
    const llmPort = {
        available: true,
        complete: async (config, payload) => {
            llmCalls.push(payload);
            // 第一次输出垃圾，第二次输出合法蒸馏 JSON
            if (llmCalls.length === 1) {
                return llmResponse('这不是 JSON，只是模型抖动输出。');
            }
            return llmResponse(DISTILL_OUTPUT);
        }
    };
    const { createForgeRuntimeService } = require('../../../modules/agentGateway/services/forge/service');
    const svc = createForgeRuntimeService({
        jobRuntimeService: jrs,
        llmCompletionPort: llmPort,
        toolInvokerPort: toolInvoker,
        knowledgeStorePort: readyPort(baseDir),
        baseDir,
        knowledgeRoot: path.join(baseDir, 'knowledge'),
        llmConfig: { url: 'http://t', apiKey: 'k', model: 'm' },
        smokeRetries: 1,
        smokeIntervalMs: 5
    });
    const { jobId } = await svc.startExpertCreateJob({
        requirement: '造一个 UI 设计专家',
        blueprintOverride: buildUiDesignerBlueprint()
    });
    await waitFor(() => jrs.pollJob(jobId, null).data.job.status === 'pending_confirm');
    await svc.confirmBlueprint(jobId, { approved: true });
    await waitFor(() => jrs.pollJob(jobId, null).data.job.terminal);
    const job = jrs.pollJob(jobId, null).data.job;
    assert.equal(job.metadata.forge.error.step, 'synthesize', '重试后 distill 应完成');
    // M4：主张提取/判定会追加 LLM 调用——蒸馏批调用按 prompt 过滤计数。
    const distillCalls = llmCalls.filter((call) => call.messages[0].content.includes('知识蒸馏引擎'));
    assert.equal(distillCalls.length, 2, '蒸馏批恰好调用两次（重试一次）');
    // 2026-10-17：重试不再原样重放——基 prompt 相同，重试附「直接输出 JSON」强指令。
    const basePrompt = llmCalls[0].messages[0].content;
    assert.ok(llmCalls[1].messages[0].content.startsWith(basePrompt), '重试 prompt 保留基 prompt');
    assert.match(llmCalls[1].messages[0].content.slice(basePrompt.length), /【重试要求】/, '重试附强指令');
    // 蒸馏缺省关思考（2026-10-17）：否则思考段会把输出预算吃光、正文为空。
    assert.deepEqual(llmCalls[0].thinking, { type: 'disabled' }, '蒸馏请求关思考');
    assert.equal(llmCalls[0].max_tokens, 8000, '首次预算 8000');
    assert.equal(llmCalls[1].max_tokens, 8000, '纯抖动（非空非截断）不抬预算');
    const marker = JSON.parse(fs.readFileSync(path.join(baseDir, 'runs', jobId, 'steps', 'distill.json'), 'utf8'));
    assert.ok(marker.state && marker.state.libraryName === 'UIDesigner知识库', 'marker 携带机器可读 state');
    assert.equal(marker.state.indexReady.ok, true);
});

// 2026-10-11 事故回归：两单 distill 连续败于 max_tokens=8000 截断
// （completion 稳定顶满 8000，JSON 半途被切断）。
test('distill：max_tokens 截断时抢救完整知识单元，被切断的尾单元丢弃', async () => {
    const baseDir = createTempDir();
    // 模拟 finish_reason=length：JSON 在 case 单元（半真半假）的 oneLiner 中途被切断
    const cutAt = DISTILL_OUTPUT.indexOf('半真半假') + 10;
    const truncated = DISTILL_OUTPUT.slice(0, cutAt);
    assert.ok(!truncated.trim().endsWith('}'), '模拟输出应是非完整 JSON');
    const { jobRuntimeService, forgeRuntimeService } = buildPipeline({
        baseDir,
        llmOutputs: [truncated],
        finishReason: 'length',
        knowledgeStorePort: readyPort(baseDir),
        smokeRetries: 1,
        smokeIntervalMs: 5
    });
    const jobId = await runToDistillComplete(jobRuntimeService, forgeRuntimeService);
    const job = jobRuntimeService.pollJob(jobId, null).data.job;
    assert.equal(job.metadata.forge.error.step, 'synthesize', '抢救后 distill 应完成');

    const libDir = path.join(baseDir, 'knowledge', 'UIDesigner知识库');
    const files = fs.readdirSync(libDir);
    assert.ok(files.some((f) => f.includes('色轮')), '抢救出的完整单元应入库');
    assert.ok(files.some((f) => /^\d{2}_/.test(f)), '抢救出的 methodology 长文档应入库');
    assert.ok(!files.some((f) => f.includes('半真半假')), '被截断的尾单元不应入库');
    const marker = JSON.parse(fs.readFileSync(path.join(baseDir, 'runs', jobId, 'steps', 'distill.json'), 'utf8'));
    assert.equal(marker.state.salvagedBatches.length, 1);
    assert.match(marker.summary, /截断抢救/);
});

// 2026-10-17 事故回归：定期进修 distill 三次尝试 reasoning_tokens 7467/6119/7247、
// 正文 0 字符（思考段把 8000 输出预算吃光），同 prompt 同上限重试等于确定性重演。
test('distill：正文为空（推理段吃满预算）时抬预算重试并完成', async () => {
    const baseDir = createTempDir();
    const calls = [];
    const { jobRuntimeService, forgeRuntimeService } = buildPipeline({
        baseDir,
        llmOutputs: [DISTILL_OUTPUT],
        knowledgeStorePort: readyPort(baseDir),
        smokeRetries: 1,
        smokeIntervalMs: 5,
        llmComplete: async (config, payload) => {
            calls.push(payload);
            if (calls.length === 1) {
                // 空正文 + 推理段只有叙述（无可抢救 JSON）：模型把预算耗在思考上。
                return {
                    data: {
                        choices: [{ message: { content: '', reasoning_content: '我先分析这批材料的结构……' }, finish_reason: 'length' }],
                        usage: { prompt_tokens: 1892, completion_tokens: 8000, completion_tokens_details: { reasoning_tokens: 7467 } }
                    }
                };
            }
            return llmResponse(DISTILL_OUTPUT);
        }
    });
    const jobId = await runToDistillComplete(jobRuntimeService, forgeRuntimeService);
    const job = jobRuntimeService.pollJob(jobId, null).data.job;
    assert.equal(job.metadata.forge.error.step, 'synthesize', '抬预算重试后 distill 应完成（不再整单报废）');
    const distillCalls = calls.filter((call) => call.messages[0].content.includes('知识蒸馏引擎'));
    assert.deepEqual(distillCalls.map((call) => call.max_tokens), [8000, 16000], '空正文触发抬预算');
    assert.deepEqual(distillCalls[0].thinking, { type: 'disabled' }, '蒸馏关思考（缺省）');
    assert.ok(fs.readdirSync(path.join(baseDir, 'knowledge', 'UIDesigner知识库')).length > 0, '知识卡已入库');
});

test('distill：全部尝试正文为空 → FORGE_LLM_EMPTY_CONTENT（与不可解析分开报）', async () => {
    const baseDir = createTempDir();
    const calls = [];
    const { jobRuntimeService, forgeRuntimeService } = buildPipeline({
        baseDir,
        llmOutputs: [DISTILL_OUTPUT],
        knowledgeStorePort: null,
        smokeRetries: 1,
        smokeIntervalMs: 5,
        llmComplete: async (config, payload) => {
            calls.push(payload);
            return {
                data: {
                    choices: [{ message: { content: '', reasoning_content: '（只有思考，没有正文）' }, finish_reason: 'stop' }],
                    usage: { prompt_tokens: 1892, completion_tokens: 7000, completion_tokens_details: { reasoning_tokens: 6900 } }
                }
            };
        }
    });
    const jobId = await runToDistillComplete(jobRuntimeService, forgeRuntimeService);
    const job = jobRuntimeService.pollJob(jobId, null).data.job;
    assert.equal(job.status, 'failed');
    assert.equal(job.metadata.forge.error.code, 'FORGE_LLM_EMPTY_CONTENT');
    assert.equal(job.metadata.forge.error.step, 'distill');
    assert.match(job.metadata.forge.error.message, /正文为空/);
    assert.match(job.metadata.forge.error.message, /推理段 token/, '错误消息点名推理段 token 用量');
    const distillCalls = calls.filter((call) => call.messages[0].content.includes('知识蒸馏引擎'));
    assert.deepEqual(distillCalls.map((call) => call.max_tokens), [8000, 16000, 16000], '三次尝试：抬预算后不再回退');
    const failedDir = path.join(baseDir, 'runs', jobId, 'distill-failed');
    assert.equal(fs.readdirSync(failedDir).length, 3, '三次尝试的原始输出都留档');
});

test('distill：多子技能中途失败 → 已写盘部分入库并写进错误消息（不再记 0）', async () => {
    const baseDir = createTempDir();
    const twoSubskills = {
        ...buildUiDesignerBlueprint(),
        subskills: [
            { id: 'color-theory', title: '配色理论', searchQueries: ['color theory UI design'] },
            { id: 'layout-basics', title: '版式基础', searchQueries: ['layout basics UI'] }
        ],
        examOutline: [
            { subskillId: 'color-theory', conceptQuestions: 1, appliedQuestions: 1 },
            { subskillId: 'layout-basics', conceptQuestions: 1, appliedQuestions: 1 }
        ]
    };
    const calls = [];
    const { jobRuntimeService, forgeRuntimeService } = buildPipeline({
        baseDir,
        llmOutputs: [DISTILL_OUTPUT],
        knowledgeStorePort: null,
        smokeRetries: 1,
        smokeIntervalMs: 5,
        blueprint: twoSubskills,
        llmComplete: async (config, payload) => {
            calls.push(payload);
            const prompt = payload.messages[0].content;
            // 第一个子技能正常蒸馏，第二个子技能的整批蒸馏恒定空正文。
            if (prompt.includes('版式基础')) {
                return {
                    data: {
                        choices: [{ message: { content: '', reasoning_content: '（只有思考）' }, finish_reason: 'stop' }],
                        usage: { prompt_tokens: 1000, completion_tokens: 7000, completion_tokens_details: { reasoning_tokens: 6900 } }
                    }
                };
            }
            return llmResponse(DISTILL_OUTPUT);
        }
    });
    const jobId = await runToDistillComplete(jobRuntimeService, forgeRuntimeService, twoSubskills);
    const job = jobRuntimeService.pollJob(jobId, null).data.job;
    assert.equal(job.status, 'failed');
    assert.equal(job.metadata.forge.error.code, 'FORGE_LLM_EMPTY_CONTENT');
    const partialNote = job.metadata.forge.error.message.match(/已完成部分入库：(\d+) 个新文件/);
    assert.ok(partialNote, `错误消息点名部分入库，实际：${job.metadata.forge.error.message}`);

    const libDir = path.join(baseDir, 'knowledge', 'UIDesigner知识库');
    assert.ok(fs.readdirSync(libDir).length > 0, '第一个子技能的卡片已落盘且保留');
    assert.equal(Number(partialNote[1]), fs.readdirSync(libDir).length, '消息中的已写盘数与实际一致');
    const run = JSON.parse(fs.readFileSync(path.join(baseDir, 'runs', jobId, 'run.json'), 'utf8'));
    assert.equal(run.finalStatus, 'failed');
});

test('distill：确认截断且无可抢救单元时拆半重蒸，彻底失败留档原始输出', async () => {
    const baseDir = createTempDir();
    // 第一个单元就被切断：无完整单元可抢救
    const truncated = '{"knowledgeUnits": [{"type": "concept", "title": "被切断的单元", "oneLiner": "输出在半途被 max_tokens';
    const { jobRuntimeService, forgeRuntimeService, llmCalls } = buildPipeline({
        baseDir,
        llmOutputs: [truncated],
        finishReason: 'length',
        knowledgeStorePort: null,
        smokeRetries: 1,
        smokeIntervalMs: 5
    });
    const jobId = await runToDistillComplete(jobRuntimeService, forgeRuntimeService);
    const job = jobRuntimeService.pollJob(jobId, null).data.job;
    assert.equal(job.status, 'failed');
    assert.equal(job.metadata.forge.error.code, 'FORGE_DISTILL_OUTPUT_INVALID');
    assert.equal(job.metadata.forge.error.step, 'distill');
    assert.match(job.metadata.forge.error.message, /finish_reason=length/);

    // 拆半轨迹：根批(3 份) → 拆半(2 份) → 再拆(1 份) → 单材料重试两次 = 5 次蒸馏调用
    const distillPrompts = llmCalls.map((call) => call.messages[0].content)
        .filter((content) => content.includes('知识蒸馏引擎'));
    assert.equal(distillPrompts.length, 5, `拆半+重试调用数，实际 ${distillPrompts.length}`);

    // 留档：单材料批的两次尝试原始输出（含 finish_reason 与批内材料 URL）
    const failedDir = path.join(baseDir, 'runs', jobId, 'distill-failed');
    const dumps = fs.readdirSync(failedDir).filter((f) => f.endsWith('.json')).sort();
    assert.deepEqual(dumps, ['color-theory.attempt-1.json', 'color-theory.attempt-2.json', 'color-theory.attempt-3.json']);
    const dump = JSON.parse(fs.readFileSync(path.join(failedDir, 'color-theory.attempt-3.json'), 'utf8'));
    assert.equal(dump.finishReason, 'length');
    assert.equal(dump.rawContent, truncated);
    assert.ok(Array.isArray(dump.batchUrls) && dump.batchUrls.length === 1, '留档含批内材料 URL');
});

test('distill：材料分批蒸馏，跨批 mergeInto 合并且批间刷新既有卡', async () => {
    const baseDir = createTempDir();
    // 异域材料：红线 6 同域节流为 ≥2s/份，同域 5 份会把测试拖进 8s+ 超时。
    // 主题相关材料（M4 主题门禁：空话题材料会如实判 uncertain 转复核）。
    const fiveMaterials = [1, 2, 3, 4, 5].map((i) => ({
        title: `Color theory and UI palette guide ${i}`, url: `https://site${i}.example.org/m${i}`, snippet: `配色理论与 UI 色板实践第 ${i} 部分。`
    }));
    const batch1Output = JSON.stringify({
        knowledgeUnits: [{
            type: 'concept', title: '批次一知识卡', oneLiner: 'x',
            content: '批次一内容', tags: [],
            sourceUrls: ['https://site1.example.org/m1'], mergeInto: null
        }],
        droppedSources: []
    });
    // M4 T29：跨批 mergeInto 走合并分类——纯重复（正文与批次一一致）自动并来源。
    const batch2Output = JSON.stringify({
        knowledgeUnits: [{
            type: 'concept', title: '批次二同义单元', oneLiner: 'x',
            content: '批次一内容', tags: [],
            sourceUrls: ['https://site5.example.org/m5'], mergeInto: '批次一知识卡'
        }],
        droppedSources: []
    });
    const { jobRuntimeService, forgeRuntimeService, llmCalls } = buildPipeline({
        baseDir,
        llmOutputs: [batch1Output, batch2Output],
        materials: fiveMaterials,
        knowledgeStorePort: readyPort(baseDir),
        smokeRetries: 1,
        smokeIntervalMs: 5
    });
    const jobId = await runToDistillComplete(jobRuntimeService, forgeRuntimeService);
    const job = jobRuntimeService.pollJob(jobId, null).data.job;
    assert.equal(job.metadata.forge.error.step, 'synthesize');

    const distillPrompts = llmCalls.map((call) => call.messages[0].content)
        .filter((content) => content.includes('知识蒸馏引擎'));
    assert.equal(distillPrompts.length, 2, '5 份材料默认 4 份/批 → 2 次蒸馏调用');
    assert.ok(distillPrompts[0].includes('https://site4.example.org/m4') && !distillPrompts[0].includes('https://site5.example.org/m5'),
        '第一批含 1–4 号材料');
    assert.ok(distillPrompts[1].includes('https://site5.example.org/m5'), '第二批含第 5 号材料');
    assert.ok(distillPrompts[1].includes('- 批次一知识卡'), '第二批 prompt 应看到第一批写入的既有卡（批间刷新）');

    const libDir = path.join(baseDir, 'knowledge', 'UIDesigner知识库');
    const cards = fs.readdirSync(libDir).filter((f) => f.startsWith('K_'));
    assert.equal(cards.length, 1, '跨批同义单元应合并而非新建');
    const mergedRaw = fs.readFileSync(path.join(libDir, cards[0]), 'utf8');
    assert.match(mergedRaw, /site1\.example\.org\/m1/);
    assert.match(mergedRaw, /site5\.example\.org\/m5/);
    const marker = JSON.parse(fs.readFileSync(path.join(baseDir, 'runs', jobId, 'steps', 'distill.json'), 'utf8'));
    assert.match(marker.summary, /1 次合并/);
});
