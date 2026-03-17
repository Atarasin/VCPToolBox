const test = require('node:test');
const assert = require('node:assert/strict');

const { parseScheduleHours, computeUpcomingRuns } = require('./modules/scheduler');
const { buildSearchQueries, applyTemplateWeightRanking } = require('./modules/github-fetcher');
const { estimateLength, buildDraft, buildAgentPrompt, parseDraftFromAgentText, generateDrafts } = require('./modules/content-generator');
const { buildReviewMarkdown, resolveAdminCredential, postReviewWithRetry } = require('./modules/reviewer');
const { normalizeWorkflowInput, parseInput, runWorkflow } = require('./index');

// 测试 scheduler 模块的配置解析功能
test('scheduler 解析并去重小时配置', () => {
    const hours = parseScheduleHours('20,8,14,8,50');
    assert.deepEqual(hours, [8, 14, 20]);
});

// 测试 scheduler 模块的未来运行时间计算逻辑
test('scheduler 生成未来运行时间', () => {
    const now = new Date('2026-03-16T09:10:00.000Z');
    const runs = computeUpcomingRuns(now, [8, 14, 20], 1);
    assert.equal(runs.length >= 1, true);
    assert.equal(runs.length <= 3, true);
    assert.equal(runs.every(item => item.getTime() > now.getTime()), true);
});

// 测试 content-generator 模块的草稿构建逻辑，确保字段类型正确
test('content draft 结构完整', () => {
    const draft = buildDraft(
        {
            full_name: 'foo/bar',
            name: 'bar',
            description: 'A useful AI project',
            url: 'https://github.com/foo/bar',
            stars: 123,
            forks: 10,
            owner: 'foo'
        },
        new Date('2026-03-16T00:00:00.000Z')
    );
    assert.equal(typeof draft.title, 'string');
    assert.equal(typeof draft.body, 'string');
    assert.equal(draft.references[0].url, 'https://github.com/foo/bar');
    assert.equal(draft.word_count, estimateLength(draft.body));
    assert.equal(typeof draft.generation_source, 'string');
});

test('content 可解析Agent JSON响应', () => {
    const parsed = parseDraftFromAgentText(
        '{"title":"测试标题","body":"测试正文"}',
        {
            name: 'bar',
            full_name: 'foo/bar',
            description: 'd',
            url: 'https://github.com/foo/bar',
            stars: 1,
            forks: 1,
            owner: 'foo'
        }
    );
    assert.equal(parsed.title, '测试标题');
    assert.equal(parsed.body, '测试正文');
});

test('content 可构建Agent提示词并包含模板上下文', () => {
    const prompt = buildAgentPrompt(
        {
            full_name: 'foo/bar',
            description: 'demo',
            stars: 100,
            forks: 10,
            language: 'Python',
            owner: 'foo',
            url: 'https://github.com/foo/bar'
        },
        { templateIds: ['high_value_active_ai'] }
    );
    assert.equal(prompt.includes('high_value_active_ai'), true);
    assert.equal(prompt.includes('foo/bar'), true);
});

test('content 在未配置Agent时使用模板文案', async () => {
    const result = await generateDrafts(
        [
            {
                full_name: 'foo/bar',
                name: 'bar',
                description: 'demo',
                url: 'https://github.com/foo/bar',
                stars: 100,
                forks: 5,
                owner: 'foo'
            }
        ],
        {
            config: { WECHAT_PUBLISHER_DRAFT_AGENT_NAME: '' }
        }
    );
    assert.equal(result.total, 1);
    assert.equal(result.drafts[0].generation_source, 'template');
});

// 测试 reviewer 模块生成的 Markdown 内容是否包含必要的审核操作指令
test('review markdown 包含审核动作', () => {
    const markdown = buildReviewMarkdown({
        draft_id: 'd1',
        title: 't',
        body: 'b',
        word_count: 111,
        source: {
            full_name: 'foo/bar',
            stars: 10,
            forks: 1,
            url: 'https://github.com/foo/bar'
        }
    });
    assert.equal(markdown.includes('通过并发布'), true);
    assert.equal(markdown.includes('编辑后发布'), true);
    assert.equal(markdown.includes('驳回重写'), true);
});

// 测试 reviewer 模块的凭证解析，验证对不同命名风格的支持
test('credential 解析支持多命名来源', () => {
    const credential = resolveAdminCredential({
        ADMIN_USERNAME: 'admin',
        ADMIN_PASSWORD: '123456'
    });
    assert.equal(credential.username, 'admin');
    assert.equal(credential.password, '123456');
});

test('reviewer 在 502 场景会按配置重试', async () => {
    let attempts = 0;
    const mockHttp = {
        async post() {
            attempts += 1;
            if (attempts < 3) {
                const error = new Error('Request failed with status code 502');
                error.response = { status: 502 };
                throw error;
            }
            return { data: { success: true } };
        }
    };
    const response = await postReviewWithRetry(
        'http://127.0.0.1:6005/admin_api/feishu-bridge/push',
        { text: 'demo' },
        {},
        { httpClient: mockHttp, retryTimes: 3, retryDelayMs: 0 }
    );
    assert.equal(response.data.success, true);
    assert.equal(attempts, 3);
});

// 测试 index 模块的工作流参数标准化，验证默认值逻辑
test('workflow 输入解析默认值正确', () => {
    const normalized = normalizeWorkflowInput({});
    assert.equal(normalized.force, false);
    assert.equal(normalized.dryRun, false);
    assert.equal(normalized.limit, 20);
    assert.equal(Array.isArray(normalized.templateIds), true);
    assert.equal(normalized.templateLimitsJson, '');
    assert.equal(normalized.templateWeightsJson, '');
});

test('github 搜索模板可按ID筛选', () => {
    const queries = buildSearchQueries(new Date('2026-03-16T00:00:00.000Z'), {
        templateIds: 'high_value_active_ai,latest_created_ai',
        defaultLimit: 10
    });
    assert.equal(queries.length, 2);
    assert.deepEqual(queries.map(item => item.id), ['high_value_active_ai', 'latest_created_ai']);
    assert.equal(queries[0].query.includes('pushed:>=2026-03-09'), true);
    assert.equal(queries[1].query.includes('created:>=2026-02-14'), true);
});

test('github 搜索模板支持自定义覆盖', () => {
    const queries = buildSearchQueries(new Date('2026-03-16T00:00:00.000Z'), {
        templateIds: 'latest_created_ai,custom_ai',
        defaultLimit: 5,
        customTemplatesJson: JSON.stringify([
            {
                id: 'custom_ai',
                label: '自定义模板',
                sort: 'updated',
                queryTemplate: 'topic:ai pushed:>=${DATE_7D} stars:>=50 fork:false'
            }
        ])
    });
    assert.equal(queries.length, 2);
    assert.equal(queries[1].id, 'custom_ai');
    assert.equal(queries[1].query.includes('pushed:>=2026-03-09'), true);
});

test('github 搜索模板支持独立limit与权重覆盖', () => {
    const queries = buildSearchQueries(new Date('2026-03-16T00:00:00.000Z'), {
        templateIds: 'high_value_active_ai,latest_created_ai',
        defaultLimit: 5,
        templateLimitsJson: JSON.stringify({
            high_value_active_ai: 30
        }),
        templateWeightsJson: JSON.stringify({
            high_value_active_ai: 4,
            latest_created_ai: 2
        })
    });
    assert.equal(queries.length, 2);
    assert.equal(queries[0].limit, 30);
    assert.equal(queries[0].weight, 4);
    assert.equal(queries[1].limit, 20);
    assert.equal(queries[1].weight, 2);
});

test('模板权重排序优先高权重项目', () => {
    const ranked = applyTemplateWeightRanking([
        { full_name: 'a', stars: 120, template_weight_max: 1 },
        { full_name: 'b', stars: 80, template_weight_max: 3 }
    ]);
    assert.equal(ranked[0].full_name, 'b');
});

test('runWorkflow 在单条推送失败时继续处理后续草稿', async () => {
    const result = await runWorkflow(
        { force: true, dry_run: false },
        {},
        {
            fetchGithubCorpus: async () => ({
                repos: [
                    { full_name: 'foo/a', name: 'a', description: '', url: 'https://x/a', stars: 1, forks: 1, owner: 'foo' },
                    { full_name: 'foo/b', name: 'b', description: '', url: 'https://x/b', stars: 1, forks: 1, owner: 'foo' }
                ],
                templateIds: ['high_value_active_ai']
            }),
            generateDrafts: async () => ({
                drafts: [
                    { draft_id: 'd1', title: 't1', body: 'b1', source: { full_name: 'foo/a', stars: 1, forks: 1, url: 'https://x/a' } },
                    { draft_id: 'd2', title: 't2', body: 'b2', source: { full_name: 'foo/b', stars: 1, forks: 1, url: 'https://x/b' } }
                ]
            }),
            pushReviewMessage: async draft => {
                if (draft.draft_id === 'd1') {
                    throw new Error('Request failed with status code 502');
                }
                return { success: true, dryRun: false };
            }
        }
    );
    assert.equal(result.stage3.totalAttempted, 2);
    assert.equal(result.stage3.totalPushed, 1);
    assert.equal(result.stage3.details[0].success, false);
    assert.equal(result.stage3.details[1].success, true);
});

// 测试 index 模块的 stdin 输入解析
test('stdin 输入解析正确', () => {
    const parsed = parseInput('{"command":"RunWorkflow","force":true}');
    assert.equal(parsed.command, 'RunWorkflow');
    assert.equal(parsed.force, true);
});
