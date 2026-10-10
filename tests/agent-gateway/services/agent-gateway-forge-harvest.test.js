const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
    SEARCH_TOOL_CHAIN,
    extractEntriesFromText,
    createDomainThrottle,
    domainOf
} = require('../../../modules/agentGateway/services/forge/harvest');
const { writeBlueprint } = require('../../../modules/agentGateway/services/forge/blueprint');
const { createForgeRuntimeService } = require('../../../modules/agentGateway/services/forge/service');
const { createJobRuntimeService } = require('../../../modules/agentGateway/services/jobRuntimeService');

function createTempDir() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'forge-harvest-'));
}

function anySearchText(entries) {
    return entries.map((e) => `${e.title}\n${e.url}\n${e.snippet}`).join('\n\n');
}

function browserSearchText(entries) {
    const head = '## BrowserSearch 搜索结果\n- 查询: color theory\n';
    const body = entries.map((e, i) => `### ${i + 1}. [${e.title}](${e.url})\n> ${e.url}\n${e.snippet}`).join('\n');
    return `${head}${body}\n`;
}

function buildUiDesignerBlueprint() {
    return {
        name: 'UIDesigner',
        displayName: 'UI 设计专家',
        scope: { responsibilities: ['UI 设计'], boundaries: [] },
        subskills: [
            { id: 'color-theory', title: '配色理论', searchQueries: ['color theory UI design', '配色理论 界面设计'] }
        ],
        examOutline: [
            { subskillId: 'color-theory', conceptQuestions: 1, appliedQuestions: 1 }
        ],
        practicalExam: { prompt: 'SaaS 落地页设计方案', gradingDimensions: ['眼前一亮'] },
        acceptanceSample: '去 AI 味的设计图'
    };
}

// 验收（M2.S1）：对一个 subskill 关键词取回 ≥3 个不同域名的原始材料并落盘，每份带完整元数据。
test('harvest：多域名材料采集、永久存档与完整元数据', async () => {
    const baseDir = createTempDir();
    const blueprintPath = path.join(baseDir, 'blueprints', 'UIDesigner.json');
    await writeBlueprint(blueprintPath, buildUiDesignerBlueprint());

    const searchCalls = [];
    const toolInvoker = {
        async invoke(toolName, args) {
            searchCalls.push({ toolName, args });
            const isEnglishQuery = String(args.query || '').includes('color theory');
            if (toolName === 'AnySearch') {
                if (!isEnglishQuery) {
                    throw new Error('AnySearch: rate limited on this query');
                }
                return {
                    content: [{
                        type: 'text',
                        text: anySearchText([
                            { title: 'Color Theory Basics', url: 'https://www.interaction-design.org/literature/topics/color-theory', snippet: '色彩理论基础知识，涵盖色轮、对比与和谐。' },
                            { title: 'Color and UI', url: 'https://www.smashingmagazine.com/2020/04/color-ui-design/', snippet: 'UI 配色实践指南。' }
                        ])
                    }]
                };
            }
            if (toolName === 'BrowserSearch') {
                return {
                    content: [{
                        type: 'text',
                        text: browserSearchText([
                            { title: 'Material Design color', url: 'https://m3.material.io/styles/color/overview', snippet: '官方色彩系统文档。' }
                        ])
                    }]
                };
            }
            throw new Error('FlashDeepSearch is blocked');
        }
    };

    const jobRuntimeService = createJobRuntimeService();
    const forgeRuntimeService = createForgeRuntimeService({
        jobRuntimeService,
        llmCompletionPort: { available: true, complete: async () => ({ data: { choices: [{ message: { content: '{}' } }] } }) },
        toolInvokerPort: toolInvoker,
        baseDir,
        llmConfig: { url: 'http://t', apiKey: 'k', model: 'm' },
        // 跳过 blueprint LLM：直接给 override
        stepRunners: {}
    });

    // 用最小路径直接驱动 harvest：经完整 job（blueprintOverride 跳过 LLM）
    const { jobId } = await forgeRuntimeService.startExpertCreateJob({
        requirement: '造一个 UI 设计专家',
        blueprintOverride: buildUiDesignerBlueprint()
    });
    await waitForStatus(jobRuntimeService, jobId, 'pending_confirm');
    await forgeRuntimeService.confirmBlueprint(jobId, { approved: true });
    // harvest 完成后推进到 distill（fake LLM 返回 '{}' → 蒸馏输出不可解析而失败，
    // 错误点在 distill 即证明 harvest 已跑过）
    const job = await waitForFailure(jobRuntimeService, jobId);
    assert.equal(job.metadata.forge.error.step, 'distill', 'harvest 应已完成并推进到 distill');

    // 落盘验证
    const rawDir = path.join(baseDir, 'runs', jobId, 'raw', 'color-theory');
    const files = fs.readdirSync(rawDir);
    const materialFiles = files.filter((f) => f.endsWith('.md'));
    assert.equal(materialFiles.length, 3, '应取回 3 份材料');
    assert.ok(files.includes('manifest.json'));

    const metas = files.filter((f) => f.endsWith('.meta.json')).map((f) => JSON.parse(fs.readFileSync(path.join(rawDir, f), 'utf8')));
    assert.equal(metas.length, 3);
    const domains = new Set(metas.map((m) => m.domain));
    assert.equal(domains.size, 3, '三个不同域名');
    for (const meta of metas) {
        assert.ok(meta.url && /^https?:\/\//.test(meta.url), 'url');
        assert.ok(meta.fetchedAt && /\d{4}-\d{2}-\d{2}T/.test(meta.fetchedAt), '抓取时间戳');
        assert.ok(meta.contentHash && meta.contentHash.startsWith('sha256:'), '内容哈希');
        assert.ok(['AnySearch', 'BrowserSearch'].includes(meta.plugin), '插件名');
    }

    const manifest = JSON.parse(fs.readFileSync(path.join(rawDir, 'manifest.json'), 'utf8'));
    assert.equal(manifest.materials, 3);
    assert.equal(manifest.domains.length, 3);
    assert.deepEqual(manifest.warnings, [], '域名多样性达标无警告');

    // fallback 顺序：中文 query 上 AnySearch 失败 → FlashDeepSearch（block）→ BrowserSearch 兜底成功
    assert.ok(searchCalls.some((c) => c.toolName === 'AnySearch'));
    assert.ok(searchCalls.some((c) => c.toolName === 'FlashDeepSearch'));
    assert.ok(searchCalls.some((c) => c.toolName === 'BrowserSearch'));
    assert.deepEqual(SEARCH_TOOL_CHAIN, ['AnySearch', 'FlashDeepSearch', 'BrowserSearch']);
});

test('harvest：全部插件与关键词失败时报 FORGE_HARVEST_EMPTY', async () => {
    const baseDir = createTempDir();
    const jobRuntimeService = createJobRuntimeService();
    const forgeRuntimeService = createForgeRuntimeService({
        jobRuntimeService,
        llmCompletionPort: { available: true, complete: async () => ({ data: { choices: [{ message: { content: '{}' } }] } }) },
        toolInvokerPort: {
            async invoke() {
                throw new Error('all plugins down');
            }
        },
        baseDir,
        llmConfig: { url: 'http://t', apiKey: 'k', model: 'm' }
    });
    const { jobId } = await forgeRuntimeService.startExpertCreateJob({
        requirement: '造一个 UI 设计专家',
        blueprintOverride: buildUiDesignerBlueprint()
    });
    await waitForStatus(jobRuntimeService, jobId, 'pending_confirm');
    await forgeRuntimeService.confirmBlueprint(jobId, { approved: true });
    const job = await waitForFailure(jobRuntimeService, jobId);
    assert.equal(job.metadata.forge.error.code, 'FORGE_HARVEST_EMPTY');
});

test('harvest：结果解析器兼容 AnySearch 纯文本与 BrowserSearch markdown', () => {
    const plain = extractEntriesFromText('AnySearch', anySearchText([
        { title: 'A', url: 'https://a.com/x', snippet: 'sa' },
        { title: 'B', url: 'https://b.org/y', snippet: 'sb' }
    ]));
    assert.equal(plain.length, 2);
    assert.equal(plain[0].title, 'A');
    assert.equal(domainOf(plain[1].url), 'b.org');

    const markdown = extractEntriesFromText('BrowserSearch', browserSearchText([
        { title: 'C', url: 'https://c.io/z', snippet: 'sc' }
    ]));
    assert.equal(markdown.length, 1);
    assert.equal(markdown[0].title, 'C');
    assert.equal(markdown[0].url, 'https://c.io/z');
    assert.ok(markdown[0].snippet.includes('sc'));

    // 重复 URL 去重
    const deduped = extractEntriesFromText('AnySearch', `${anySearchText([{ title: 'A', url: 'https://a.com/x', snippet: 'sa' }])}\n\n${anySearchText([{ title: 'A2', url: 'https://a.com/x', snippet: 'sa2' }])}`);
    assert.equal(deduped.length, 1);
});

test('harvest：同域名节流 ≥2s（红线 6）', async () => {
    const throttle = createDomainThrottle(2000);
    const start = Date.now();
    await throttle.waitForDomain('a.com');
    await throttle.waitForDomain('a.com');
    await throttle.waitForDomain('b.com');
    const elapsed = Date.now() - start;
    assert.ok(elapsed >= 1900, `同域第二次请求应等待 ≥2s，实际 ${elapsed}ms`);
    assert.ok(elapsed < 3000, `不同域名不应串行等待，实际 ${elapsed}ms`);
});

async function waitForStatus(jobRuntimeService, jobId, status, timeoutMs = 5000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        const job = jobRuntimeService.pollJob(jobId, null).data.job;
        if (job.status === status) {
            return job;
        }
        await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error(`等待状态 ${status} 超时，当前 ${jobRuntimeService.pollJob(jobId, null).data.job.status}`);
}

async function waitForFailure(jobRuntimeService, jobId, timeoutMs = 5000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        const job = jobRuntimeService.pollJob(jobId, null).data.job;
        if (job.status === 'failed' || job.status === 'completed') {
            return job;
        }
        await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error('等待终态超时');
}
