const fs = require('fs').promises;
const path = require('path');
const Lark = require('@larksuiteoapi/node-sdk');

const stateModule = require('./lib/bridgeState');
const helperModule = require('./lib/messageHelpers');
const gatewayModule = require('./lib/feishuGateway');

/**
 * FeishuBridge.js
 * 
 * 职责：插件主入口，负责整体流程编排。
 * 将具体的业务逻辑委托给 lib/ 下的子模块，自身主要处理生命周期管理、
 * 路由注册、以及消息处理流程的高层调度（Flow Orchestration）。
 */

// 初始化全局状态
const state = stateModule.createState();

/**
 * 创建指令处理所需的依赖集合
 */
function createCommandDependencies() {
    return {
        getAllowedAgentAliases: stateModule.getAllowedAgentAliases,
        normalizeAgentAlias: stateModule.normalizeAgentAlias,
        markSessionDirty: stateModule.markSessionDirty,
        resetSession: stateModule.resetSession
    };
}

/**
 * 创建消息推送所需的依赖集合
 */
function createPushMessageDependencies() {
    return {
        parsePushMessageType: helperModule.parsePushMessageType,
        parseBase64Payload: helperModule.parseBase64Payload,
        sanitizeFileName: helperModule.sanitizeFileName,
        inferFileNameByMime: helperModule.inferFileNameByMime,
        buildFeishuMarkdownCard: helperModule.buildFeishuMarkdownCard
    };
}

/**
 * 创建二进制消息处理所需的依赖集合
 */
function createBinaryMessageDependencies() {
    return {
        parseBase64Payload: helperModule.parseBase64Payload,
        sanitizeFileName: helperModule.sanitizeFileName,
        inferFileNameByMime: helperModule.inferFileNameByMime
    };
}

/**
 * 二进制文件/图片处理流程
 * 1. 下载用户上传的附件
 * 2. 保存到本地临时目录
 * 3. 构建包含附件信息的 Prompt
 */
async function binaryFlow(normalized) {
    if (normalized.messageType !== 'image' && normalized.messageType !== 'file') {
        return normalized.content;
    }
    let attachment = null;
    try {
        attachment = await gatewayModule.saveIncomingAttachment(
            state,
            normalized,
            helperModule,
            stateModule.ensureAttachmentDir,
            fs
        );
    } catch (error) {
        stateModule.notify(state, {
            action: 'attachment_download_failed',
            chatId: normalized.chatId,
            messageId: normalized.messageId,
            reason: error.message
        });
    }
    return helperModule.buildIncomingMultimodalUserContent(
        normalized,
        attachment,
        state.config.maxInlineAttachmentBytes
    );
}

/**
 * 指令处理流程
 * 1. 解析文本是否为指令
 * 2. 执行指令逻辑
 * 3. 发送指令执行结果
 */
async function commandFlow(normalized, session, sessionKey) {
    const command = helperModule.parseCommand(normalized.content || '');
    const commandResponse = await helperModule.handleCommand(
        state,
        command,
        session,
        sessionKey,
        createCommandDependencies()
    );
    if (!commandResponse) {
        return false;
    }
    await gatewayModule.sendFeishuText(state, normalized, commandResponse, helperModule.buildFeishuMarkdownCard);
    state.metrics.commandMessages += 1;
    stateModule.notify(state, {
        action: 'command',
        command: command.type,
        chatId: normalized.chatId,
        agent: session.selectedAgentAlias
    });
    return true;
}

/**
 * 正常对话处理流程
 * 1. 记录用户消息历史
 * 2. 深度记忆归档
 * 3. 调用 LLM 获取回复
 * 4. 处理工具调用请求
 * 5. 发送最终回复和工具卡片
 */
async function chatFlow(normalized, session, userInputText) {
    stateModule.pushHistory(state, session, 'user', userInputText);
    await stateModule.appendDeepMemoArchive(state, normalized, 'user', userInputText, session);
    const injectedUserText = helperModule.buildFeishuInjectedUserText(normalized, userInputText);

    let assistantText = '';
    try {
        assistantText = await gatewayModule.callVcpChat(
            state,
            session,
            injectedUserText,
            helperModule.buildMessages,
            stateModule.normalizeAgentAlias,
            helperModule.extractVisibleContentDelta
        );
        if (!assistantText) assistantText = '未获取到模型回复。';
    } catch (error) {
        assistantText = `请求失败：${error.message}`;
        state.metrics.chatFailures += 1;
    }

    const binaryExtracted = helperModule.extractBinaryReplies(assistantText);
    const binaryPayloads = binaryExtracted.blocks
        .map(block => helperModule.parseBinaryReplyBlock(block))
        .filter(Boolean);
    const extracted = helperModule.extractToolRequests(binaryExtracted.plainText);
    const userVisibleText = extracted.plainText || (binaryPayloads.length ? '已发送二进制内容，请查收。' : '已执行工具调用，请查看下方卡片。');
    stateModule.pushHistory(state, session, 'assistant', userVisibleText);
    await stateModule.appendDeepMemoArchive(state, normalized, 'assistant', userVisibleText, session);
    await gatewayModule.sendFeishuText(state, normalized, userVisibleText, helperModule.buildFeishuMarkdownCard);
    for (let i = 0; i < extracted.blocks.length; i += 1) {
        await gatewayModule.sendToolCard(state, normalized, extracted.blocks[i], i, helperModule.buildToolCard);
    }
    let binarySendFailures = 0;
    for (let i = 0; i < binaryPayloads.length; i += 1) {
        const payload = binaryPayloads[i];
        try {
            await gatewayModule.sendFeishuBinary(
                state,
                normalized,
                payload.messageType,
                {
                    binaryBase64: payload.binaryBase64,
                    attachmentPath: payload.attachmentPath,
                    mimeType: payload.mimeType,
                    fileName: payload.fileName
                },
                createBinaryMessageDependencies()
            );
        } catch (error) {
            binarySendFailures += 1;
            stateModule.notify(state, {
                action: 'binary_reply_failed',
                chatId: normalized.chatId,
                messageType: payload.messageType,
                reason: error.message
            });
        }
    }
    if (binarySendFailures > 0) {
        await gatewayModule.sendFeishuText(
            state,
            normalized,
            `有 ${binarySendFailures} 条二进制消息发送失败，请检查模型输出格式或附件数据。`,
            helperModule.buildFeishuMarkdownCard
        );
    }
    state.metrics.chatMessages += 1;
    stateModule.notify(state, {
        action: 'chat',
        chatId: normalized.chatId,
        agent: session.selectedAgentAlias,
        responseLength: assistantText.length,
        toolRequestCount: extracted.blocks.length,
        binaryReplyCount: binaryPayloads.length
    });
}

/**
 * 消息处理主入口
 * 负责事件规范化、去重、会话获取以及分发到不同的子流程
 */
async function processIncomingMessage(payload) {
    const normalized = helperModule.normalizeMessageEvent(payload);
    if (normalized.eventType && normalized.eventType !== 'im.message.receive_v1') return;
    const isBinaryMessage = normalized.messageType === 'image' || normalized.messageType === 'file';
    if (!normalized.content && !isBinaryMessage) return;
    if (!normalized.chatId) return;
    const dedupeKey = normalized.eventId || normalized.messageId;
    if (stateModule.isProcessedEvent(state, dedupeKey)) return;
    stateModule.addProcessedEvent(state, dedupeKey);
    state.metrics.receivedMessages += 1;

    const sessionKey = stateModule.getSessionKey(normalized.chatId, normalized.senderOpenId);
    const session = stateModule.getOrCreateSession(state, normalized.chatId, normalized.senderOpenId);
    const isCommandHandled = await commandFlow(normalized, session, sessionKey);
    if (isCommandHandled) return;

    await gatewayModule.sendFeishuAckReaction(state, normalized, info => stateModule.notify(state, info));
    const userInputText = isBinaryMessage ? await binaryFlow(normalized) : normalized.content;
    await chatFlow(normalized, session, userInputText);
}

/**
 * 使用飞书官方 SDK 建立 WebSocket 连接
 */
async function connectWebSocketViaSdk() {
    const dispatcher = new Lark.EventDispatcher({}).register({
        'im.message.receive_v1': async data => {
            await processIncomingMessage({
                header: { event_type: 'im.message.receive_v1' },
                event: data
            });
        }
    });
    const wsClient = new Lark.WSClient({
        ...stateModule.buildLarkBaseConfig(state, Lark),
        loggerLevel: (Lark.LoggerLevel && Lark.LoggerLevel.error) ? Lark.LoggerLevel.error : undefined
    });
    state.larkWsClient = wsClient;
    await wsClient.start({ eventDispatcher: dispatcher });
    state.wsConnected = true;
    state.reconnectAttempt = 0;
    stateModule.notify(state, { action: 'ws_open_sdk' });
}

/**
 * 调度 WebSocket 重连
 */
function scheduleReconnect() {
    if (state.shuttingDown) return;
    if (state.reconnectTimer) return;
    state.reconnectAttempt += 1;
    const waitMs = Math.min(60000, 1000 * (2 ** Math.min(state.reconnectAttempt, 6)));
    state.reconnectTimer = setTimeout(async () => {
        state.reconnectTimer = null;
        await connectWebSocket();
    }, waitMs);
}

/**
 * 初始化 WebSocket 连接，包含错误处理和重试机制
 */
async function connectWebSocket() {
    if (!state.config.enableWs) return;
    if (!state.config.appId || !state.config.appSecret) {
        throw new Error('FEISHU_APP_ID 或 FEISHU_APP_SECRET 未配置，无法启动飞书长连接。');
    }
    try {
        await connectWebSocketViaSdk();
    } catch (error) {
        state.wsConnected = false;
        console.error('[FeishuBridge] SDK WS 连接失败:', error.message);
        scheduleReconnect();
    }
}

/**
 * 关闭 WebSocket 连接
 */
function closeWebSocket() {
    if (state.larkWsClient && typeof state.larkWsClient.stop === 'function') {
        try {
            state.larkWsClient.stop();
        } catch (error) {
            if (state.config && state.config.DebugMode) {
                console.error('[FeishuBridge] stop lark ws client failed:', error.message);
            }
        }
    }
    state.larkWsClient = null;
    state.wsConnected = false;
}

/**
 * 插件初始化
 * 加载配置、状态、并启动长连接
 */
async function initialize(config, dependencies) {
    state.config = stateModule.buildConfig(config || {});
    state.projectBasePath = config.PROJECT_BASE_PATH || path.join(__dirname, '..', '..');
    state.vcpApiBaseUrl = `http://127.0.0.1:${config.PORT || process.env.PORT}/v1`;
    state.vcpAccessKey = config.Key || process.env.Key;
    if (!state.config.appId || !state.config.appSecret) {
        throw new Error('FEISHU_APP_ID 和 FEISHU_APP_SECRET 为必填配置。');
    }
    state.larkClient = new Lark.Client(stateModule.buildLarkBaseConfig(state, Lark));
    state.shuttingDown = false;
    if (dependencies && dependencies.vcpLogFunctions && typeof dependencies.vcpLogFunctions.pushVcpInfo === 'function') {
        state.pushVcpInfo = dependencies.vcpLogFunctions.pushVcpInfo;
    }
    try {
        await stateModule.loadAgentMap(state, true);
    } catch (error) {
        console.warn('[FeishuBridge] Failed to load agent_map.json on initialize:', error.message);
        state.agentMap = {};
    }
    await stateModule.loadSessionsFromDisk(state);
    if (state.sessionFlushTimer) clearInterval(state.sessionFlushTimer);
    state.sessionFlushTimer = setInterval(() => {
        stateModule.flushSessionsToDisk(state).catch(error => {
            console.error('[FeishuBridge] flushSessionsToDisk failed:', error.message);
        });
    }, stateModule.SESSION_FLUSH_MS);
    if (state.housekeepingTimer) clearInterval(state.housekeepingTimer);
    state.housekeepingTimer = setInterval(() => {
        stateModule.cleanupProcessedEvents(state);
    }, 60 * 1000);
    await connectWebSocket();
    console.log('[FeishuBridge] Initialized.');
}

/**
 * 注册 HTTP 路由接口
 * 提供状态查询、手动推送消息等管理功能
 */
function registerRoutes(app, adminApiRouter, pluginConfig, projectBasePath) {
    if (adminApiRouter && typeof adminApiRouter.get === 'function') {
        adminApiRouter.get('/feishu-bridge/status', async (req, res) => {
            try {
                await stateModule.loadAgentMap(state, true);
                res.json(stateModule.getStatus(state, stateModule.getAllowedAgentAliases(state)));
            } catch (error) {
                res.status(500).json({ error: error.message });
            }
        });
        adminApiRouter.get('/feishu-bridge/sessions', (req, res) => {
            const sessions = [];
            for (const [key, value] of state.sessionStore.entries()) {
                sessions.push({
                    key,
                    selectedAgentAlias: value.selectedAgentAlias,
                    memoryMode: value.memoryMode,
                    historySize: Array.isArray(value.history) ? value.history.length : 0,
                    updatedAt: value.updatedAt
                });
            }
            res.json({ sessions });
        });
        adminApiRouter.post('/feishu-bridge/reload-agent-map', async (req, res) => {
            try {
                const map = await stateModule.loadAgentMap(state, true);
                res.json({ success: true, aliases: Object.keys(map) });
            } catch (error) {
                res.status(500).json({ success: false, error: error.message });
            }
        });
        adminApiRouter.post('/feishu-bridge/push', async (req, res) => {
            try {
                const payload = req && req.body ? req.body : {};
                const result = await gatewayModule.sendFeishuPushMessage(state, payload, createPushMessageDependencies());
                stateModule.notify(state, {
                    action: 'push',
                    receiveIdType: payload.receiveIdType,
                    messageType: result.messageType
                });
                res.json({ success: true, ...result });
            } catch (error) {
                res.status(400).json({ success: false, error: error.message });
            }
        });
    }
    if (app && typeof app.get === 'function') {
        app.get('/api/feishu-bridge/status', async (req, res) => {
            try {
                await stateModule.loadAgentMap(state, true);
                res.json(stateModule.getStatus(state, stateModule.getAllowedAgentAliases(state)));
            } catch (error) {
                res.status(500).json({ error: error.message });
            }
        });
    }
}

/**
 * 插件关闭清理逻辑
 */
async function shutdown() {
    state.shuttingDown = true;
    if (state.reconnectTimer) {
        clearTimeout(state.reconnectTimer);
        state.reconnectTimer = null;
    }
    if (state.sessionFlushTimer) {
        clearInterval(state.sessionFlushTimer);
        state.sessionFlushTimer = null;
    }
    if (state.housekeepingTimer) {
        clearInterval(state.housekeepingTimer);
        state.housekeepingTimer = null;
    }
    closeWebSocket();
    await stateModule.flushSessionsToDisk(state);
    console.log('[FeishuBridge] Shutdown.');
}

module.exports = {
    initialize,
    registerRoutes,
    shutdown,
    // 导出内部方法用于测试
    __test: {
        buildFeishuInjectedUserText: helperModule.buildFeishuInjectedUserText,
        buildFeishuMarkdownCard: helperModule.buildFeishuMarkdownCard,
        extractVisibleContentDelta: helperModule.extractVisibleContentDelta,
        computeDeltaFromSnapshot: helperModule.computeDeltaFromSnapshot,
        extractToolRequests: helperModule.extractToolRequests,
        parseToolBlock: helperModule.parseToolBlock,
        extractBinaryReplies: helperModule.extractBinaryReplies,
        parseBinaryReplyBlock: helperModule.parseBinaryReplyBlock,
        buildToolCard: helperModule.buildToolCard,
        parseCommand: helperModule.parseCommand,
        handleCommand(command, session, sessionKey) {
            return helperModule.handleCommand(state, command, session, sessionKey, createCommandDependencies());
        },
        resetSession(session, sessionKey) {
            return stateModule.resetSession(state, session, sessionKey);
        },
        sendFeishuPushMessage(options) {
            return gatewayModule.sendFeishuPushMessage(state, options, createPushMessageDependencies());
        },
        parsePushMessageType: helperModule.parsePushMessageType,
        parseBase64Payload: helperModule.parseBase64Payload,
        normalizeMessageEvent: helperModule.normalizeMessageEvent,
        buildIncomingAttachmentPrompt: helperModule.buildIncomingAttachmentPrompt,
        buildIncomingMultimodalUserContent: helperModule.buildIncomingMultimodalUserContent,
        sendFeishuBinary(normalizedEvent, messageType, payload) {
            return gatewayModule.sendFeishuBinary(state, normalizedEvent, messageType, payload, createBinaryMessageDependencies());
        },
        setLarkClient(client) {
            state.larkClient = client;
        },
        setTokenFetcher(token) {
            state.tenantAccessToken = token;
            state.tenantAccessTokenExpireAt = Date.now() + 3600 * 1000;
        }
    }
};
