const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs').promises;
const os = require('os');
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
    assert.equal(admin.routes.post.has('/feishu-bridge/push'), true);
    assert.equal(app.routes.get.has('/api/feishu-bridge/status'), true);

    const statusRes = createResponse();
    await admin.routes.get.get('/feishu-bridge/status')({}, statusRes);
    assert.equal(statusRes.statusCode, 200);
    assert.equal(typeof statusRes.payload.wsEnabled, 'boolean');
    assert.equal(Array.isArray(statusRes.payload.allowedAgents), true);

    await plugin.shutdown();
});

test('FeishuBridge registerRoutes signature is PluginManager compatible', () => {
    assert.equal(plugin.registerRoutes.length >= 4, true);
    const app = createRouter();
    const admin = createRouter();
    plugin.registerRoutes(app, admin, {}, path.join(__dirname, '..', '..'));
    assert.equal(admin.routes.post.has('/feishu-bridge/push'), true);
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

test('FeishuBridge binary reply block extraction works', () => {
    const text = [
        '普通回复前缀',
        '<<<[BINARY_REPLY]>>>',
        'message_type:「始」image「末」,',
        'binary_base64:「始」data:image/png;base64,aGVsbG8=「末」',
        '<<<[END_BINARY_REPLY]>>>',
        '普通回复后缀'
    ].join('\n');
    const { blocks, plainText } = plugin.__test.extractBinaryReplies(text);
    assert.equal(blocks.length, 1);
    assert.equal(plainText.includes('普通回复前缀'), true);
    assert.equal(plainText.includes('普通回复后缀'), true);
});

test('FeishuBridge parses binary reply block payload', () => {
    const block = [
        '<<<[BINARY_REPLY]>>>',
        'message_type:「始」file「末」,',
        'mime_type:「始」application/pdf「末」,',
        'file_name:「始」report.pdf「末」,',
        'binary_base64:「始」data:application/pdf;base64,aGVsbG8=「末」',
        '<<<[END_BINARY_REPLY]>>>'
    ].join('\n');
    const payload = plugin.__test.parseBinaryReplyBlock(block);
    assert.equal(payload.messageType, 'file');
    assert.equal(payload.mimeType, 'application/pdf');
    assert.equal(payload.fileName, 'report.pdf');
    assert.equal(payload.binaryBase64.includes('data:application/pdf;base64,'), true);
});

test('FeishuBridge parses binary reply block payload with attachment path', () => {
    const block = [
        '<<<[BINARY_REPLY]>>>',
        'message_type:「始」image「末」,',
        'attachment_path:「始」/tmp/demo.png「末」',
        '<<<[END_BINARY_REPLY]>>>'
    ].join('\n');
    const payload = plugin.__test.parseBinaryReplyBlock(block);
    assert.equal(payload.messageType, 'image');
    assert.equal(payload.attachmentPath, '/tmp/demo.png');
    assert.equal(payload.binaryBase64, '');
    assert.equal(payload.mimeType, 'image/png');
});

test('FeishuBridge ignores invalid binary reply block payload', () => {
    const block = [
        '<<<[BINARY_REPLY]>>>',
        'message_type:「始」image「末」',
        '<<<[END_BINARY_REPLY]>>>'
    ].join('\n');
    const payload = plugin.__test.parseBinaryReplyBlock(block);
    assert.equal(payload, null);
});

test('FeishuBridge injects feishu environment prompt into user text', () => {
    const injected = plugin.__test.buildFeishuInjectedUserText(
        { chatId: 'oc_xxx', senderOpenId: 'ou_yyy' },
        '请帮我总结今天进展'
    );
    assert.equal(injected.includes('当前处于飞书交流环境'), true);
    assert.equal(injected.includes('chat_id=oc_xxx'), true);
    assert.equal(injected.includes('sender_open_id=ou_yyy'), true);
    assert.equal(injected.includes('<<<[BINARY_REPLY]>>>'), true);
    assert.equal(injected.includes('binary_base64'), true);
    assert.equal(injected.includes('attachment_path'), true);
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

test('FeishuBridge parses /new command', () => {
    const command = plugin.__test.parseCommand('/new');
    assert.deepEqual(command, { type: 'session-reset' });
});

test('FeishuBridge resets session on /new command', async () => {
    const session = {
        vcpSessionId: 'oc_chat:ou_user',
        selectedAgentAlias: 'Ariadne',
        memoryMode: 'on',
        history: [{ role: 'user', content: '你好' }],
        updatedAt: Date.now() - 1000
    };
    const oldSessionId = session.vcpSessionId;
    const oldUpdatedAt = session.updatedAt;
    const reply = await plugin.__test.handleCommand({ type: 'session-reset' }, session, 'oc_chat:ou_user');
    assert.equal(reply.includes('已清空当前会话历史'), true);
    assert.equal(Array.isArray(session.history), true);
    assert.equal(session.history.length, 0);
    assert.notEqual(session.vcpSessionId, oldSessionId);
    assert.equal(session.vcpSessionId.startsWith('oc_chat:ou_user:'), true);
    assert.equal(session.updatedAt >= oldUpdatedAt, true);
});

test('FeishuBridge push route validates required fields', async () => {
    const admin = createRouter();
    plugin.registerRoutes({}, admin);
    const handler = admin.routes.post.get('/feishu-bridge/push');
    const res = createResponse();
    await handler({ body: { receiveIdType: 'chat_id', messageType: 'text', text: 'hello' } }, res);
    assert.equal(res.statusCode, 400);
    assert.equal(res.payload.success, false);
    assert.equal(typeof res.payload.error, 'string');
});

test('FeishuBridge sends push message as text', async () => {
    const sentPayloads = [];
    plugin.__test.setLarkClient({
        im: {
            v1: {
                message: {
                    create: async payload => {
                        sentPayloads.push(payload);
                        return { data: { message_id: 'om_123' } };
                    }
                }
            }
        }
    });
    const result = await plugin.__test.sendFeishuPushMessage({
        receiveIdType: 'chat_id',
        receiveId: 'oc_xxx',
        messageType: 'text',
        text: '推送内容'
    });
    assert.equal(result.messageId, 'om_123');
    assert.equal(result.messageType, 'text');
    assert.equal(sentPayloads.length, 1);
    assert.equal(sentPayloads[0].params.receive_id_type, 'chat_id');
    assert.equal(sentPayloads[0].data.msg_type, 'text');
});

test('FeishuBridge sends push message as markdown', async () => {
    const sentPayloads = [];
    plugin.__test.setLarkClient({
        im: {
            v1: {
                message: {
                    create: async payload => {
                        sentPayloads.push(payload);
                        return { data: { message_id: 'om_456' } };
                    }
                }
            }
        }
    });
    const result = await plugin.__test.sendFeishuPushMessage({
        receiveIdType: 'open_id',
        receiveId: 'ou_yyy',
        messageType: 'markdown',
        text: '**标题**'
    });
    assert.equal(result.messageId, 'om_456');
    assert.equal(result.messageType, 'markdown');
    assert.equal(sentPayloads.length, 1);
    assert.equal(sentPayloads[0].params.receive_id_type, 'open_id');
    assert.equal(sentPayloads[0].data.msg_type, 'interactive');
});

test('FeishuBridge parse push message type supports image and file', () => {
    assert.equal(plugin.__test.parsePushMessageType('image'), 'image');
    assert.equal(plugin.__test.parsePushMessageType('file'), 'file');
    assert.equal(plugin.__test.parsePushMessageType('unknown'), null);
});

test('FeishuBridge normalizes image message event', () => {
    const normalized = plugin.__test.normalizeMessageEvent({
        header: { event_type: 'im.message.receive_v1', event_id: 'evt_1' },
        event: {
            message: {
                chat_id: 'oc_123',
                message_id: 'om_123',
                message_type: 'image',
                content: JSON.stringify({ image_key: 'img_123' })
            },
            sender: {
                sender_id: { open_id: 'ou_123' }
            }
        }
    });
    assert.equal(normalized.eventType, 'im.message.receive_v1');
    assert.equal(normalized.messageType, 'image');
    assert.equal(normalized.imageKey, 'img_123');
    assert.equal(normalized.chatId, 'oc_123');
    assert.equal(normalized.senderOpenId, 'ou_123');
});

test('FeishuBridge builds attachment prompt with metadata', () => {
    const text = plugin.__test.buildIncomingAttachmentPrompt(
        { content: '请帮我看这个文件' },
        {
            kind: 'file',
            fileName: 'report.pdf',
            size: 128,
            localPath: '/tmp/report.pdf'
        }
    );
    assert.equal(text.includes('用户上传了文件附件'), true);
    assert.equal(text.includes('report.pdf'), true);
    assert.equal(text.includes('/tmp/report.pdf'), true);
    assert.equal(text.includes('请帮我看这个文件'), true);
});

test('FeishuBridge builds multimodal user content for image attachment', () => {
    const content = plugin.__test.buildIncomingMultimodalUserContent(
        { content: '请分析图片里的内容' },
        {
            kind: 'image',
            fileName: 'demo.png',
            size: 32,
            localPath: '/tmp/demo.png',
            mimeType: 'image/png',
            dataUrl: 'data:image/png;base64,aGVsbG8='
        },
        1024
    );
    assert.equal(Array.isArray(content), true);
    assert.equal(content.length, 2);
    assert.equal(content[0].type, 'text');
    assert.equal(content[1].type, 'image_url');
    assert.equal(content[1].image_url.url.includes('data:image/png;base64,'), true);
});

test('FeishuBridge builds multimodal user content for file attachment', () => {
    const content = plugin.__test.buildIncomingMultimodalUserContent(
        { content: '请总结这份文档' },
        {
            kind: 'file',
            fileName: 'report.pdf',
            size: 64,
            localPath: '/tmp/report.pdf',
            mimeType: 'application/pdf',
            dataUrl: 'data:application/pdf;base64,aGVsbG8='
        },
        1024
    );
    assert.equal(Array.isArray(content), true);
    assert.equal(content.length, 2);
    assert.equal(content[0].type, 'text');
    assert.equal(content[1].type, 'text');
    assert.equal(content[1].text.includes('data:application/pdf;base64,'), true);
});

test('FeishuBridge falls back to text prompt when attachment exceeds inline limit', () => {
    const content = plugin.__test.buildIncomingMultimodalUserContent(
        { content: '请查看大文件' },
        {
            kind: 'file',
            fileName: 'large.pdf',
            size: 2048,
            localPath: '/tmp/large.pdf',
            mimeType: 'application/pdf',
            dataUrl: 'data:application/pdf;base64,aGVsbG8='
        },
        1024
    );
    assert.equal(typeof content, 'string');
    assert.equal(content.includes('large.pdf'), true);
});

test('FeishuBridge sends push message as image', async () => {
    const originalFetch = global.fetch;
    const sentPayloads = [];
    global.fetch = async (url) => {
        if (String(url).includes('/im/v1/images')) {
            return {
                ok: true,
                statusText: 'OK',
                async json() {
                    return { code: 0, data: { image_key: 'img_uploaded_1' } };
                }
            };
        }
        throw new Error(`unexpected fetch url: ${url}`);
    };
    plugin.__test.setTokenFetcher('unit_token');
    plugin.__test.setLarkClient({
        im: {
            v1: {
                message: {
                    create: async payload => {
                        sentPayloads.push(payload);
                        return { data: { message_id: 'om_789' } };
                    }
                }
            }
        }
    });
    const result = await plugin.__test.sendFeishuPushMessage({
        receiveIdType: 'chat_id',
        receiveId: 'oc_xxx',
        messageType: 'image',
        binaryBase64: 'data:image/png;base64,aGVsbG8=',
        fileName: 'demo.png'
    });
    global.fetch = originalFetch;
    assert.equal(result.messageId, 'om_789');
    assert.equal(result.messageType, 'image');
    assert.equal(sentPayloads[0].data.msg_type, 'image');
    assert.equal(sentPayloads[0].data.content.includes('img_uploaded_1'), true);
});

test('FeishuBridge sends push message as file', async () => {
    const originalFetch = global.fetch;
    const sentPayloads = [];
    global.fetch = async (url) => {
        if (String(url).includes('/im/v1/files')) {
            return {
                ok: true,
                statusText: 'OK',
                async json() {
                    return { code: 0, data: { file_key: 'file_uploaded_1' } };
                }
            };
        }
        throw new Error(`unexpected fetch url: ${url}`);
    };
    plugin.__test.setTokenFetcher('unit_token');
    plugin.__test.setLarkClient({
        im: {
            v1: {
                message: {
                    create: async payload => {
                        sentPayloads.push(payload);
                        return { data: { message_id: 'om_790' } };
                    }
                }
            }
        }
    });
    const result = await plugin.__test.sendFeishuPushMessage({
        receiveIdType: 'chat_id',
        receiveId: 'oc_xxx',
        messageType: 'file',
        binaryBase64: 'aGVsbG8=',
        fileName: 'demo.txt',
        mimeType: 'text/plain'
    });
    global.fetch = originalFetch;
    assert.equal(result.messageId, 'om_790');
    assert.equal(result.messageType, 'file');
    assert.equal(sentPayloads[0].data.msg_type, 'file');
    assert.equal(sentPayloads[0].data.content.includes('file_uploaded_1'), true);
});

test('FeishuBridge sends binary message by attachment path', async () => {
    const originalFetch = global.fetch;
    const sentPayloads = [];
    const tempPath = path.join(os.tmpdir(), `feishu-binary-${Date.now()}.png`);
    await fs.writeFile(tempPath, Buffer.from('hello'));
    global.fetch = async (url) => {
        if (String(url).includes('/im/v1/images')) {
            return {
                ok: true,
                statusText: 'OK',
                async json() {
                    return { code: 0, data: { image_key: 'img_uploaded_path' } };
                }
            };
        }
        throw new Error(`unexpected fetch url: ${url}`);
    };
    plugin.__test.setTokenFetcher('unit_token');
    plugin.__test.setLarkClient({
        im: {
            v1: {
                message: {
                    create: async payload => {
                        sentPayloads.push(payload);
                        return { data: { message_id: 'om_791' } };
                    }
                }
            }
        }
    });
    await plugin.__test.sendFeishuBinary(
        { chatId: 'oc_xxx', senderOpenId: 'ou_xxx' },
        'image',
        { attachmentPath: tempPath }
    );
    await fs.unlink(tempPath);
    global.fetch = originalFetch;
    assert.equal(sentPayloads.length, 1);
    assert.equal(sentPayloads[0].data.msg_type, 'image');
    assert.equal(sentPayloads[0].data.content.includes('img_uploaded_path'), true);
});
