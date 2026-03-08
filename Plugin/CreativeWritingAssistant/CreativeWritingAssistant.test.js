const test = require('node:test');
const assert = require('node:assert/strict');

const plugin = require('./CreativeWritingAssistant');

test('CountChapterLength 在区间内返回达标', () => {
    const text = '第一段中文。\n\n第二段中文。';
    const response = plugin.buildCountChapterLengthResult(text, {
        countMode: 'cn_chars',
        targetMin: 4,
        targetMax: 20
    });

    assert.equal(response.status, 'success');
    assert.equal(response.result.command, 'CountChapterLength');
    assert.equal(response.result.validation.rangeStatus, 'within_range');
    assert.equal(response.result.validation.isQualified, true);
    assert.equal(response.result.counts.paragraphCount, 2);
});

test('CountChapterLength 对非法区间参数报错', () => {
    assert.throws(() => {
        plugin.buildCountChapterLengthResult('正文', {
            targetMin: 100,
            targetMax: 10
        });
    }, /targetMin 不能大于 targetMax/);
});

test('CountChapterLength 在 min_only 策略下高于上限也达标', () => {
    const response = plugin.buildCountChapterLengthResult('这是一段足够长的章节正文内容，用于验证字数策略在超过上限时的行为。', {
        countMode: 'cn_chars',
        targetMin: 10,
        targetMax: 20,
        lengthPolicy: 'min_only'
    });
    assert.equal(response.status, 'success');
    assert.equal(response.result.lengthPolicy, 'min_only');
    assert.equal(response.result.validation.rangeStatus, 'above_max_ignored');
    assert.equal(response.result.validation.isQualified, true);
});

test('CountChapterLength 在默认 range 策略下高于上限不达标', () => {
    const response = plugin.buildCountChapterLengthResult('这是一段足够长的章节正文内容，用于验证默认策略在超过上限时会触发不达标。', {
        countMode: 'cn_chars',
        targetMin: 10,
        targetMax: 20
    });
    assert.equal(response.status, 'success');
    assert.equal(response.result.lengthPolicy, 'range');
    assert.equal(response.result.validation.rangeStatus, 'above_max');
    assert.equal(response.result.validation.isQualified, false);
});

test('CountChapterLength 在 min_only 策略下允许 targetMin 大于 targetMax', () => {
    const response = plugin.buildCountChapterLengthResult('这是一段用于最小阈值策略的章节正文。', {
        targetMin: 30,
        targetMax: 10,
        lengthPolicy: 'min_only'
    });
    assert.equal(response.status, 'success');
});

test('RequestChapterDraft dryRun 保持兼容输出结构', async () => {
    const response = await plugin.handleChapterDraft({
        text: '锁死项与大纲',
        dryRun: true,
        agentName: 'DemoDraftAgent'
    }, '锁死项与大纲');

    assert.equal(response.status, 'success');
    assert.equal(response.result.command, 'RequestChapterDraft');
    assert.equal(response.result.dryRun, true);
    assert.match(response.result.payload, /tool_name:「始」AgentAssistant「末」/);
});

test('RequestExternalReview 非 dryRun 时调用注入 API', async () => {
    const response = await plugin.handleExternalReview({
        text: '章节正文',
        dryRun: false,
        agentName: 'DemoReviewAgent',
        timeoutMs: 1234
    }, '章节正文', {
        callHumanToolApi: async (payload, timeoutMs) => ({
            statusCode: 200,
            body: { payloadLength: payload.length, timeoutMs }
        })
    });

    assert.equal(response.status, 'success');
    assert.equal(response.result.command, 'RequestExternalReview');
    assert.equal(response.result.reviewAgent, 'DemoReviewAgent');
    assert.equal(response.result.apiResponse.statusCode, 200);
    assert.equal(response.result.request.timeoutMs, 1234);
});

test('EditChapterContent dryRun 输出修订请求载荷', async () => {
    const response = await plugin.handleChapterEdit({
        text: '第一段。\n第二段。\n第三段。',
        dryRun: true,
        editInstructions: '修复逻辑断裂并保持主线一致',
        editTargets: '2,3',
        issues: ['第二段人物动机不足', '第三段转折突兀'],
        mustKeep: ['主线事件节点不可改写'],
        maxRewriteRatio: 0.4
    }, '第一段。\n第二段。\n第三段。');

    assert.equal(response.status, 'success');
    assert.equal(response.result.command, 'EditChapterContent');
    assert.equal(response.result.request.maxRewriteRatio, 0.4);
    assert.deepEqual(response.result.request.editTargets, [2, 3]);
    assert.equal(response.result.request.issuesCount, 2);
    assert.match(response.result.payload, /【修订后章节正文】/);
});

test('EditChapterContent 非 dryRun 时调用注入 API', async () => {
    const response = await plugin.handleChapterEdit({
        text: '正文',
        dryRun: false,
        editTargets: [1],
        issues: ['逻辑冲突'],
        timeoutMs: 2222
    }, '正文', {
        callHumanToolApi: async (_payload, timeoutMs) => ({
            statusCode: 200,
            body: { timeoutMs }
        })
    });

    assert.equal(response.status, 'success');
    assert.equal(response.result.command, 'EditChapterContent');
    assert.equal(response.result.request.timeoutMs, 2222);
    assert.equal(response.result.apiResponse.statusCode, 200);
});

test('EditChapterContent 对非法 maxRewriteRatio 报错', async () => {
    await assert.rejects(async () => {
        await plugin.handleChapterEdit({
            text: '正文',
            maxRewriteRatio: 1.2
        }, '正文');
    }, /maxRewriteRatio 必须是 0 到 1 之间的数字/);
});

test('processInputData 处理非法 JSON', async () => {
    const response = await plugin.processInputData('{bad json}');
    assert.equal(response.status, 'error');
    assert.match(response.error, /合法 JSON/);
});

test('executeCommand 对未知命令返回错误对象', async () => {
    const response = await plugin.executeCommand({
        command: 'UnknownCommand',
        text: '正文'
    });
    assert.equal(response.status, 'error');
    assert.match(response.error, /未知命令/);
});

test('executeCommand 拦截 CountChapterLength 的标题类 text', async () => {
    await assert.rejects(async () => {
        await plugin.executeCommand({
            command: 'CountChapterLength',
            text: '【二次修订后章节正文·第 1 章 钥匙】（3781 字）'
        });
    }, /完整章节正文全文/);
});

test('executeCommand 拦截 RequestExternalReview 的摘要类 text', async () => {
    await assert.rejects(async () => {
        await plugin.executeCommand({
            command: 'RequestExternalReview',
            text: '第1章 钥匙（摘要）',
            dryRun: true
        });
    }, /完整章节正文全文/);
});

test('executeCommand 允许 RequestChapterDraft 使用上下文 text', async () => {
    const response = await plugin.executeCommand({
        command: 'RequestChapterDraft',
        text: '锁死项摘要：A；本章大纲：B；上一章结尾：C',
        dryRun: true
    });
    assert.equal(response.status, 'success');
    assert.equal(response.result.command, 'RequestChapterDraft');
});
