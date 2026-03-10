const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const plugin = require('./FeishuBridge');

function createRouter() {
    const routes = {
        get: new Map(),
        post: new Map()
    };
    return {
        routes,
        get(route, handler) {
            routes.get.set(route, handler);
        },
        post(route, handler) {
            routes.post.set(route, handler);
        }
    };
}

function createResponse() {
    return {
        statusCode: 200,
        payload: null,
        status(code) {
            this.statusCode = code;
            return this;
        },
        json(data) {
            this.payload = data;
            return this;
        }
    };
}

test('FeishuBridge initializes, registers routes, and shuts down', async () => {
    await plugin.initialize({
        FEISHU_ENABLE_WS: 'false',
        FEISHU_APP_ID: 'cli_test_app_id',
        FEISHU_APP_SECRET: 'cli_test_app_secret',
        FEISHU_DEFAULT_AGENT: 'Ariadne',
        PROJECT_BASE_PATH: path.join(__dirname, '..', '..'),
        PORT: '8181',
        Key: 'unit-test-key'
    }, {});

    const app = createRouter();
    const admin = createRouter();
    plugin.registerRoutes(app, admin);

    assert.equal(admin.routes.get.has('/feishu-bridge/status'), true);
    assert.equal(admin.routes.get.has('/feishu-bridge/sessions'), true);
    assert.equal(admin.routes.post.has('/feishu-bridge/reload-agent-map'), true);
    assert.equal(app.routes.get.has('/api/feishu-bridge/status'), true);

    const statusRes = createResponse();
    await admin.routes.get.get('/feishu-bridge/status')({}, statusRes);
    assert.equal(statusRes.statusCode, 200);
    assert.equal(typeof statusRes.payload.wsEnabled, 'boolean');
    assert.equal(Array.isArray(statusRes.payload.allowedAgents), true);

    await plugin.shutdown();
});

test('FeishuBridge requires app credentials', async () => {
    await assert.rejects(
        plugin.initialize({
            FEISHU_ENABLE_WS: 'false',
            FEISHU_APP_ID: '',
            FEISHU_APP_SECRET: '',
            PROJECT_BASE_PATH: path.join(__dirname, '..', '..'),
            PORT: '8181',
            Key: 'unit-test-key'
        }, {}),
        /必填配置/
    );
});

test('FeishuBridge tool block extraction works', () => {
    const text = [
        '普通回复前缀',
        '<<<[TOOL_REQUEST]>>>',
        'tool_name:「始」LightMemo「末」,',
        'query:「始」回忆上周计划「末」',
        '<<<[END_TOOL_REQUEST]>>>',
        '普通回复后缀'
    ].join('\n');
    const { blocks, plainText } = plugin.__test.extractToolRequests(text);
    assert.equal(blocks.length, 1);
    assert.equal(plainText.includes('普通回复前缀'), true);
    assert.equal(plainText.includes('普通回复后缀'), true);
});

test('FeishuBridge builds tool card from tool block', () => {
    const block = [
        '<<<[TOOL_REQUEST]>>>',
        'tool_name:「始」LightMemo「末」,',
        'query:「始」回忆上周计划「末」',
        '<<<[END_TOOL_REQUEST]>>>'
    ].join('\n');
    const card = plugin.__test.buildToolCard(block, 0);
    assert.equal(card.header.title.content.includes('LightMemo'), true);
    assert.equal(Array.isArray(card.elements), true);
    assert.equal(card.elements.length > 0, true);
});

test('FeishuBridge injects feishu environment prompt into user text', () => {
    const injected = plugin.__test.buildFeishuInjectedUserText(
        { chatId: 'oc_xxx', senderOpenId: 'ou_yyy' },
        '请帮我总结今天进展'
    );
    assert.equal(injected.includes('当前处于飞书交流环境'), true);
    assert.equal(injected.includes('chat_id=oc_xxx'), true);
    assert.equal(injected.includes('sender_open_id=ou_yyy'), true);
    assert.equal(injected.includes('请帮我总结今天进展'), true);
});

test('FeishuBridge builds markdown card for Feishu interactive message', () => {
    const card = plugin.__test.buildFeishuMarkdownCard('**标题**\n- 列表项');
    assert.equal(card.config.wide_screen_mode, true);
    assert.equal(Array.isArray(card.elements), true);
    assert.equal(card.elements[0].tag, 'markdown');
    assert.equal(card.elements[0].content.includes('**标题**'), true);
});

test('FeishuBridge computes delta from stream snapshots', () => {
    const step1 = plugin.__test.computeDeltaFromSnapshot('你好', 0);
    assert.equal(step1.delta, '你好');
    assert.equal(step1.nextLength, 2);

    const step2 = plugin.__test.computeDeltaFromSnapshot('你好，世界', step1.nextLength);
    assert.equal(step2.delta, '，世界');
    assert.equal(step2.nextLength, 5);

    const step3 = plugin.__test.computeDeltaFromSnapshot('你好，世界', step2.nextLength);
    assert.equal(step3.delta, '');
    assert.equal(step3.nextLength, 5);
});

test('FeishuBridge only exposes visible delta content from stream chunk', () => {
    const visible = plugin.__test.extractVisibleContentDelta({
        choices: [{
            delta: {
                content: '最终回复片段',
                reasoning_content: '不应展示的思考内容'
            }
        }]
    });
    assert.equal(visible, '最终回复片段');
});

test('FeishuBridge returns empty visible delta when chunk has only reasoning', () => {
    const visible = plugin.__test.extractVisibleContentDelta({
        choices: [{
            delta: {
                reasoning_content: '仅思考内容'
            }
        }]
    });
    assert.equal(visible, '');
});
