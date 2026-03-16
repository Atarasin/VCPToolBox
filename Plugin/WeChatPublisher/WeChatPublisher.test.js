const test = require('node:test');
const assert = require('node:assert/strict');

const { parseScheduleHours, computeUpcomingRuns } = require('./modules/scheduler');
const { estimateLength, buildDraft } = require('./modules/content-generator');
const { buildReviewMarkdown, resolveAdminCredential } = require('./modules/reviewer');
const { normalizeWorkflowInput, parseInput } = require('./index');

test('scheduler 解析并去重小时配置', () => {
    const hours = parseScheduleHours('20,8,14,8,50');
    assert.deepEqual(hours, [8, 14, 20]);
});

test('scheduler 生成未来运行时间', () => {
    const now = new Date('2026-03-16T09:10:00.000Z');
    const runs = computeUpcomingRuns(now, [8, 14, 20], 1);
    assert.equal(runs.length >= 1, true);
    assert.equal(runs.length <= 3, true);
    assert.equal(runs.every(item => item.getTime() > now.getTime()), true);
});

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
});

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

test('credential 解析支持多命名来源', () => {
    const credential = resolveAdminCredential({
        ADMIN_USERNAME: 'admin',
        ADMIN_PASSWORD: '123456'
    });
    assert.equal(credential.username, 'admin');
    assert.equal(credential.password, '123456');
});

test('workflow 输入解析默认值正确', () => {
    const normalized = normalizeWorkflowInput({});
    assert.equal(normalized.force, false);
    assert.equal(normalized.dryRun, false);
    assert.equal(normalized.limit, 20);
});

test('stdin 输入解析正确', () => {
    const parsed = parseInput('{"command":"RunWorkflow","force":true}');
    assert.equal(parsed.command, 'RunWorkflow');
    assert.equal(parsed.force, true);
});
