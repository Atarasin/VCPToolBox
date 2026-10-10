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

function llmResponse(content) {
    return { data: { choices: [{ message: { content } }], usage: { prompt_tokens: 800, completion_tokens: 600 } } };
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

function buildPipeline({ baseDir, llmOutputs, knowledgeStorePort, smokeRetries = null, smokeIntervalMs = null }) {
    const jobRuntimeService = createJobRuntimeService();
    const llmCalls = [];
    const toolInvoker = {
        async invoke() {
            return { content: [{ type: 'text', text: anySearchText(MATERIALS) }] };
        }
    };
    const llmPort = {
        available: true,
        complete: async (config, payload) => {
            llmCalls.push(payload);
            const next = llmOutputs.length > 1 ? llmOutputs.shift() : llmOutputs[0];
            return llmResponse(next);
        }
    };
    const forgeRuntimeService = createForgeRuntimeService({
        jobRuntimeService,
        llmCompletionPort: llmPort,
        toolInvokerPort: toolInvoker,
        knowledgeStorePort,
        baseDir,
        knowledgeRoot: path.join(baseDir, 'knowledge'),
        llmConfig: { url: 'http://t', apiKey: 'k', model: 'm' },
        ...(smokeRetries != null ? { smokeRetries } : {}),
        ...(smokeIntervalMs != null ? { smokeIntervalMs } : {})
    });
    return { jobRuntimeService, forgeRuntimeService, llmCalls };
}

async function runToDistillComplete(jobRuntimeService, forgeRuntimeService) {
    const { jobId } = await forgeRuntimeService.startExpertCreateJob({
        requirement: '造一个 UI 设计专家',
        blueprintOverride: buildUiDesignerBlueprint()
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
    const knowledgeStorePort = {
        available: true,
        listLibraries: async () => ['UIDesigner知识库'],
        search: async (query, options) => {
            smokeCalls.push({ query, options });
            return [{ text: '色轮与色彩三属性……', score: 0.87, library: 'UIDesigner知识库' }];
        }
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

    // 冒烟查询
    assert.equal(smokeCalls.length >= 1, true);
    assert.equal(smokeCalls[0].options.library, 'UIDesigner知识库');
    assert.equal(smokeCalls[0].query, 'color theory UI design');
});

test('distill：mergeInto 既有卡做来源并集，正文不动（红线 3）', async () => {
    const baseDir = createTempDir();
    const libDir = path.join(baseDir, 'knowledge', 'UIDesigner知识库');
    fs.mkdirSync(libDir, { recursive: true });
    const existingCard = `---
title: "既有卡：色轮基础"
oneLiner: "旧卡摘要"
type: concept
subskill: color-theory
sources:
  - { url: "https://old-source.example.com/page", fetchedAt: "2026-10-01T00:00:00.000Z" }
tags: [旧]
---

旧卡正文不可被修改。
`;
    fs.writeFileSync(path.join(libDir, 'K_color-theory_jyoukyuu.md'), existingCard);

    const output = JSON.stringify({
        knowledgeUnits: [{
            type: 'concept',
            title: '色轮（同义新说法）',
            oneLiner: '同义知识点',
            content: '不应成为新卡',
            tags: [],
            sourceUrls: ['https://www.interaction-design.org/literature/topics/color-theory'],
            mergeInto: '既有卡：色轮基础'
        }],
        droppedSources: []
    });
    const knowledgeStorePort = {
        available: true,
        listLibraries: async () => ['UIDesigner知识库'],
        search: async () => [{ text: 'hit', score: 0.9 }]
    };
    const { jobRuntimeService, forgeRuntimeService } = buildPipeline({
        baseDir,
        llmOutputs: [output],
        knowledgeStorePort
    });
    const jobId = await runToDistillComplete(jobRuntimeService, forgeRuntimeService);

    const files = fs.readdirSync(libDir);
    assert.equal(files.filter((f) => f.startsWith('K_')).length, 1, '不应新增知识卡');
    const mergedRaw = fs.readFileSync(path.join(libDir, 'K_color-theory_jyoukyuu.md'), 'utf8');
    assert.match(mergedRaw, /旧卡正文不可被修改。/, '正文不动');
    assert.match(mergedRaw, /old-source\.example\.com/);
    assert.match(mergedRaw, /interaction-design\.org/);
    // 多行 YAML 格式（设计 §3.4）：- url 行计数来源数
    const sourceCount = (mergedRaw.match(/  - url: /g) || []).length;
    assert.equal(sourceCount, 2, '来源并集');
    // S2：既有来源的原始 fetchedAt 不被合并时刻改写
    assert.match(mergedRaw, /fetchedAt: 2026-10-01T00:00:00\.000Z/, '旧来源时间戳保留');

    const runDir = path.join(baseDir, 'runs', jobId);
    const marker = JSON.parse(fs.readFileSync(path.join(runDir, 'steps', 'distill.json'), 'utf8'));
    assert.match(marker.summary, /1 次合并/);
});

test('distill：知识内容含密钥被阻断落盘（红线 2）', async () => {
    const baseDir = createTempDir();
    const leakyOutput = JSON.stringify({
        knowledgeUnits: [{
            type: 'concept',
            title: '带密钥的单元',
            oneLiner: 'x',
            content: '配置示例：sk-abcdefghijklmnopqrstuvwx',
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

test('distill：TDB 未启用时冒烟跳过（warning 不阻断）', async () => {
    const baseDir = createTempDir();
    const { jobRuntimeService, forgeRuntimeService } = buildPipeline({
        baseDir,
        llmOutputs: [DISTILL_OUTPUT],
        knowledgeStorePort: null
    });
    const jobId = await runToDistillComplete(jobRuntimeService, forgeRuntimeService);
    const marker = JSON.parse(fs.readFileSync(path.join(baseDir, 'runs', jobId, 'steps', 'distill.json'), 'utf8'));
    assert.match(marker.summary, /冒烟跳过：TDB 未启用/);
    assert.ok(fs.existsSync(path.join(baseDir, 'knowledge', 'UIDesigner知识库')));
});

test('distill：冒烟持续无结果降级为告警留痕，不阻断步骤（索引是 watcher 异步职责）', async () => {
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
                return [];
            }
        },
        smokeRetries: 2,
        smokeIntervalMs: 10
    });
    const jobId = await runToDistillComplete(jobRuntimeService, forgeRuntimeService);
    const job = jobRuntimeService.pollJob(jobId, null).data.job;
    // distill 完成-marker 落盘；job 失败点应是 synthesize 桩而非 distill
    assert.equal(job.metadata.forge.error.step, 'synthesize');
    const marker = JSON.parse(fs.readFileSync(path.join(baseDir, 'runs', jobId, 'steps', 'distill.json'), 'utf8'));
    assert.match(marker.summary, /冒烟未命中：索引延迟/);
    assert.equal(searches, 2, '短重试配置生效');
    assert.ok(fs.existsSync(path.join(baseDir, 'knowledge', 'UIDesigner知识库')), '知识文件已落盘');
});
