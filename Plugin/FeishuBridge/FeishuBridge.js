const fs = require('fs').promises;
const path = require('path');
const axios = require('axios');
const Lark = require('@larksuiteoapi/node-sdk');
const { TextDecoder } = require('util');

const EVENT_TTL_MS = 60 * 60 * 1000;
const SESSION_FLUSH_MS = 20 * 1000;

let state = {
    config: null,
    projectBasePath: null,
    vcpApiBaseUrl: null,
    vcpAccessKey: null,
    reconnectTimer: null,
    reconnectAttempt: 0,
    shuttingDown: false,
    sessionStore: new Map(),
    processedEvents: new Map(),
    sessionDirty: false,
    sessionFlushTimer: null,
    housekeepingTimer: null,
    agentMap: {},
    agentMapLoadedAt: 0,
    larkClient: null,
    larkWsClient: null,
    wsConnected: false,
    pushVcpInfo: () => {},
    metrics: {
        receivedMessages: 0,
        commandMessages: 0,
        chatMessages: 0,
        streamUpdates: 0,
        sendFailures: 0,
        chatFailures: 0
    }
};
// 插件运行时状态统一放在 state，避免跨函数共享时出现隐式全局变量。

function parseBoolean(value, fallback = false) {
    if (value === undefined || value === null) return fallback;
    return String(value).toLowerCase() === 'true';
}

function parseInteger(value, fallback) {
    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) ? parsed : fallback;
}

function splitCsv(value) {
    if (!value || typeof value !== 'string') return [];
    return value.split(',').map(item => item.trim()).filter(Boolean);
}

function buildConfig(config) {
    // 配置解析：统一把 env 风格输入转换为插件内部可直接使用的配置对象。
    return {
        enableWs: parseBoolean(config.FEISHU_ENABLE_WS, true),
        appId: (config.FEISHU_APP_ID || '').trim(),
        appSecret: (config.FEISHU_APP_SECRET || '').trim(),
        defaultAgent: (config.FEISHU_DEFAULT_AGENT || 'FeishuAemeath').trim(),
        allowedAgents: splitCsv(config.FEISHU_ALLOWED_AGENTS),
        model: (config.FEISHU_MODEL || 'gemini-2.5-pro').trim(),
        replyTarget: (config.FEISHU_REPLY_TARGET || 'chat').trim().toLowerCase(),
        enableMemoryHint: parseBoolean(config.FEISHU_ENABLE_MEMORY_HINT, true),
        maxContextMessages: parseInteger(config.FEISHU_MAX_CONTEXT_MESSAGES, 24),
        requestTimeoutMs: parseInteger(config.FEISHU_REQUEST_TIMEOUT_MS, 120000),
        enableDeepMemoArchive: parseBoolean(config.FEISHU_ENABLE_DEEPMEMO_ARCHIVE, true)
    };
}

function buildLarkBaseConfig() {
    const appType = (Lark && Lark.AppType && Lark.AppType.SelfBuild) ? Lark.AppType.SelfBuild : undefined;
    return {
        appId: state.config.appId,
        appSecret: state.config.appSecret,
        appType
    };
}

function getSessionStateFile() {
    return path.join(__dirname, 'state', 'sessions.json');
}

async function ensureStateDir() {
    await fs.mkdir(path.join(__dirname, 'state'), { recursive: true });
}

async function ensureDeepMemoArchiveDir() {
    await fs.mkdir(path.join(__dirname, 'state', 'deepmemo_archive'), { recursive: true });
}

async function loadSessionsFromDisk() {
    // 冷启动恢复会话状态，保证会话级 Agent/记忆开关在重启后仍可延续。
    try {
        const content = await fs.readFile(getSessionStateFile(), 'utf8');
        const raw = JSON.parse(content);
        const nextStore = new Map();
        if (raw && typeof raw === 'object') {
            for (const key of Object.keys(raw)) {
                const value = raw[key];
                if (!value || typeof value !== 'object') continue;
                nextStore.set(key, {
                    vcpSessionId: value.vcpSessionId || key,
                    selectedAgentAlias: value.selectedAgentAlias || state.config.defaultAgent,
                    memoryMode: value.memoryMode === 'off' ? 'off' : 'on',
                    history: Array.isArray(value.history) ? value.history.slice(-state.config.maxContextMessages) : [],
                    updatedAt: Number(value.updatedAt) || Date.now()
                });
            }
        }
        state.sessionStore = nextStore;
    } catch (error) {
        if (error.code !== 'ENOENT') {
            console.error('[FeishuBridge] Failed to load session state:', error.message);
        }
    }
}

async function flushSessionsToDisk() {
    // 仅在有变更时写盘，减少 IO 并降低磁盘磨损。
    if (!state.sessionDirty) return;
    const jsonObject = {};
    for (const [key, value] of state.sessionStore.entries()) {
        jsonObject[key] = value;
    }
    await ensureStateDir();
    await fs.writeFile(getSessionStateFile(), JSON.stringify(jsonObject, null, 2), 'utf8');
    state.sessionDirty = false;
}

function markSessionDirty() {
    state.sessionDirty = true;
}

function getSessionKey(chatId, userId) {
    return `${chatId || 'unknown_chat'}:${userId || 'unknown_user'}`;
}

function getOrCreateSession(chatId, userId) {
    const sessionKey = getSessionKey(chatId, userId);
    if (!state.sessionStore.has(sessionKey)) {
        state.sessionStore.set(sessionKey, {
            vcpSessionId: sessionKey,
            selectedAgentAlias: state.config.defaultAgent,
            memoryMode: 'on',
            history: [],
            updatedAt: Date.now()
        });
        markSessionDirty();
    }
    return state.sessionStore.get(sessionKey);
}

function pushHistory(session, role, content) {
    session.history.push({ role, content });
    const maxMessages = Math.max(2, state.config.maxContextMessages);
    if (session.history.length > maxMessages) {
        session.history = session.history.slice(-maxMessages);
    }
    session.updatedAt = Date.now();
    markSessionDirty();
}

async function loadAgentMap(force = false) {
    // Agent 映射带短缓存，既保证热更新，又避免每条消息都读文件。
    const now = Date.now();
    if (!force && now - state.agentMapLoadedAt < 3000 && Object.keys(state.agentMap).length > 0) {
        return state.agentMap;
    }
    const mapFile = path.join(state.projectBasePath, 'agent_map.json');
    const content = await fs.readFile(mapFile, 'utf8');
    const mapJson = JSON.parse(content);
    if (!mapJson || typeof mapJson !== 'object') {
        throw new Error('agent_map.json 格式无效');
    }
    state.agentMap = mapJson;
    state.agentMapLoadedAt = now;
    return state.agentMap;
}

function getAllowedAgentAliases() {
    const allAliases = Object.keys(state.agentMap);
    if (!state.config.allowedAgents.length) return allAliases;
    const allowedSet = new Set(state.config.allowedAgents);
    return allAliases.filter(alias => allowedSet.has(alias));
}

function normalizeAgentAlias(inputAlias) {
    if (!inputAlias || typeof inputAlias !== 'string') return null;
    const alias = inputAlias.trim();
    if (!alias) return null;
    const allowed = getAllowedAgentAliases();
    return allowed.includes(alias) ? alias : null;
}

function parseFeishuText(rawContent) {
    if (rawContent === null || rawContent === undefined) return '';
    if (typeof rawContent === 'object') {
        if (typeof rawContent.text === 'string') return rawContent.text.trim();
        return '';
    }
    if (typeof rawContent !== 'string') return '';
    const trimmed = rawContent.trim();
    if (!trimmed) return '';
    try {
        const json = JSON.parse(trimmed);
        if (json && typeof json.text === 'string') return json.text.trim();
        return '';
    } catch {
        return trimmed;
    }
}

function parseCommand(text) {
    const input = text.trim();
    if (!input.startsWith('/')) return null;
    const pieces = input.split(/\s+/).filter(Boolean);
    if (!pieces.length) return null;
    const head = pieces[0].toLowerCase();
    if (head === '/agent') {
        if (pieces.length === 1) return { type: 'agent-current' };
        if (pieces[1].toLowerCase() === 'list') return { type: 'agent-list' };
        return { type: 'agent-set', alias: pieces.slice(1).join(' ') };
    }
    if (head === '/memory') {
        if (pieces.length < 2) return { type: 'memory-current' };
        const mode = pieces[1].toLowerCase();
        if (mode === 'on' || mode === 'off') return { type: 'memory-set', mode };
        return { type: 'memory-current' };
    }
    return null;
}

async function handleCommand(command, session) {
    if (!command) return null;
    if (command.type === 'agent-current') {
        return `当前 Agent：${session.selectedAgentAlias}`;
    }
    if (command.type === 'agent-list') {
        const aliases = getAllowedAgentAliases();
        if (!aliases.length) return '当前没有可用 Agent。';
        return `可用 Agent：${aliases.join(', ')}`;
    }
    if (command.type === 'agent-set') {
        const alias = normalizeAgentAlias(command.alias);
        if (!alias) return `切换失败：Agent 不可用。`;
        session.selectedAgentAlias = alias;
        session.updatedAt = Date.now();
        markSessionDirty();
        return `已切换 Agent：${alias}`;
    }
    if (command.type === 'memory-current') {
        return `当前记忆增强：${session.memoryMode === 'on' ? 'on' : 'off'}`;
    }
    if (command.type === 'memory-set') {
        session.memoryMode = command.mode;
        session.updatedAt = Date.now();
        markSessionDirty();
        return `记忆增强已设置为：${command.mode}`;
    }
    return null;
}

function buildMemoryHint(session) {
    if (!state.config.enableMemoryHint) return '';
    if (session.memoryMode === 'off') {
        return '\n\n[系统提示: 当前会话关闭了额外记忆增强提示，保持常规回答。]';
    }
    return '\n\n[系统提示: 当用户涉及回顾、复盘、之前讨论内容时，可自主选择调用记忆相关插件以提升一致性。]';
}

function buildMessages(session, userText) {
    const agentAlias = normalizeAgentAlias(session.selectedAgentAlias) || state.config.defaultAgent;
    session.selectedAgentAlias = agentAlias;
    const systemContent = `{{agent:${agentAlias}}}${buildMemoryHint(session)}`;
    const history = Array.isArray(session.history) ? session.history.slice(-state.config.maxContextMessages) : [];
    return [{ role: 'system', content: systemContent }, ...history, { role: 'user', content: userText }];
}

function buildFeishuInjectedUserText(normalizedEvent, userText) {
    const chatId = normalizedEvent?.chatId || 'unknown_chat';
    const senderOpenId = normalizedEvent?.senderOpenId || 'unknown_user';
    const envPrompt = `[系统提示: 当前处于飞书交流环境。chat_id=${chatId}; sender_open_id=${senderOpenId}。请在回复风格上适配IM即时沟通场景，保持简洁、明确，并避免误判为其它渠道消息。]`;
    return `${envPrompt}\n\n${userText}`;
}

async function callVcpChat(session, userText, onDelta) {
    const payload = {
        model: state.config.model,
        messages: buildMessages(session, userText),
        stream: true,
        session_id: session.vcpSessionId
    };
    const headers = {
        Authorization: `Bearer ${state.vcpAccessKey}`,
        'Content-Type': 'application/json'
    };
    const response = await axios.post(`${state.vcpApiBaseUrl}/chat/completions`, payload, {
        headers,
        timeout: state.config.requestTimeoutMs,
        responseType: 'stream'
    });
    const decoder = new TextDecoder('utf-8');
    let sseBuffer = '';
    let fullText = '';
    // 这里按 SSE 协议逐行解析 data: 事件，持续累积模型文本并回调增量处理器。
    return await new Promise((resolve, reject) => {
        response.data.on('data', chunk => {
            sseBuffer += decoder.decode(chunk, { stream: true });
            const lines = sseBuffer.split('\n');
            sseBuffer = lines.pop() || '';
            for (const rawLine of lines) {
                const line = rawLine.trim();
                if (!line.startsWith('data:')) continue;
                const jsonText = line.substring(5).trim();
                if (!jsonText) continue;
                if (jsonText === '[DONE]') continue;
                try {
                    const parsed = JSON.parse(jsonText);
                    const contentDelta = extractVisibleContentDelta(parsed);
                    if (contentDelta) {
                        fullText += contentDelta;
                        if (typeof onDelta === 'function') {
                            onDelta(fullText);
                        }
                    }
                } catch {
                }
            }
        });
        response.data.on('end', () => resolve(fullText));
        response.data.on('error', reject);
    });
}

function extractVisibleContentDelta(streamChunk) {
    const delta = streamChunk?.choices?.[0]?.delta || {};
    return delta.content || '';
}

function resolveReplyReceiveId(normalizedEvent) {
    if (state.config.replyTarget === 'user') {
        return {
            receiveIdType: 'open_id',
            receiveId: normalizedEvent.senderOpenId
        };
    }
    return {
        receiveIdType: 'chat_id',
        receiveId: normalizedEvent.chatId
    };
}

function buildFeishuMarkdownCard(text) {
    const markdown = String(text || '').slice(0, 8000);
    return {
        config: { wide_screen_mode: true },
        elements: [{ tag: 'markdown', content: markdown }]
    };
}

async function sendFeishuAckReaction(normalizedEvent) {
    if (!normalizedEvent?.messageId) return;
    try {
        const result = await state.larkClient.im.v1.messageReaction.create({
            path: { message_id: normalizedEvent.messageId },
            data: {
                reaction_type: { emoji_type: 'OK' }
            }
        });
        if (result && result.code && result.code !== 0) {
            console.warn('[FeishuBridge] 添加👌表情反馈失败:', result.code, result.msg || '');
            notify({
                action: 'ack_reaction_failed',
                chatId: normalizedEvent.chatId,
                messageId: normalizedEvent.messageId,
                code: result.code,
                reason: result.msg || ''
            });
        }
    } catch (error) {
        console.warn('[FeishuBridge] 添加👌表情反馈异常:', error.message);
        notify({
            action: 'ack_reaction_error',
            chatId: normalizedEvent.chatId,
            messageId: normalizedEvent.messageId,
            reason: error.message
        });
    }
}

async function sendFeishuText(normalizedEvent, text) {
    if (!text) return;
    const target = resolveReplyReceiveId(normalizedEvent);
    if (!target.receiveId) return;
    const card = buildFeishuMarkdownCard(text);
    try {
        await state.larkClient.im.v1.message.create({
            params: { receive_id_type: target.receiveIdType },
            data: {
                receive_id: target.receiveId,
                msg_type: 'interactive',
                content: JSON.stringify(card)
            }
        });
    } catch (error) {
        state.metrics.sendFailures += 1;
        throw error;
    }
}

async function createFeishuTextMessage(normalizedEvent, text) {
    const target = resolveReplyReceiveId(normalizedEvent);
    if (!target.receiveId) return null;
    const responseText = String(text || '').slice(0, 8000);
    const result = await state.larkClient.im.v1.message.create({
        params: { receive_id_type: target.receiveIdType },
        data: {
            receive_id: target.receiveId,
            msg_type: 'text',
            content: JSON.stringify({ text: responseText })
        }
    });
    return result?.data?.message_id || result?.message_id || null;
}

async function updateFeishuTextMessage(messageId, text) {
    if (!messageId) return;
    const card = buildFeishuMarkdownCard(text);
    await state.larkClient.im.v1.message.reply({
        path: { message_id: messageId },
        data: {
            msg_type: 'interactive',
            content: JSON.stringify(card)
        }
    });
    state.metrics.streamUpdates += 1;
}

function computeDeltaFromSnapshot(fullText, sentLength) {
    // 计算“当前快照”相对“已发送长度”的差量片段，用于减少重复发送。
    const safeText = String(fullText || '');
    const safeLength = Number.isFinite(sentLength) && sentLength >= 0 ? sentLength : 0;
    if (safeText.length <= safeLength) {
        return {
            delta: '',
            nextLength: safeText.length
        };
    }
    return {
        delta: safeText.slice(safeLength),
        nextLength: safeText.length
    };
}

function extractToolRequests(fullText) {
    const blockRegex = /<<<\[TOOL_REQUEST\]>>>[\s\S]*?<<<\[END_TOOL_REQUEST\]>>>/g;
    const blocks = [];
    let match;
    while ((match = blockRegex.exec(fullText)) !== null) {
        blocks.push(match[0]);
    }
    const plainText = fullText.replace(blockRegex, '').trim();
    return { blocks, plainText };
}

function parseToolBlock(blockText) {
    const inner = blockText
        .replace('<<<[TOOL_REQUEST]>>>', '')
        .replace('<<<[END_TOOL_REQUEST]>>>', '')
        .trim();
    const lines = inner.split('\n').map(line => line.trim()).filter(Boolean);
    const pairs = [];
    for (const line of lines) {
        const idx = line.indexOf(':');
        if (idx <= 0) continue;
        const key = line.slice(0, idx).trim();
        let value = line.slice(idx + 1).trim();
        value = value.replace(/[「」]/g, '').replace(/始|末/g, '').trim();
        pairs.push({ key, value });
    }
    return pairs;
}

function buildToolCard(blockText, index) {
    const pairs = parseToolBlock(blockText);
    const toolName = pairs.find(pair => pair.key.toLowerCase() === 'tool_name')?.value || `工具调用 ${index + 1}`;
    const detailLines = pairs.map(pair => `**${pair.key}**: ${pair.value}`).join('\n');
    return {
        config: { wide_screen_mode: true },
        header: {
            template: 'orange',
            title: { tag: 'plain_text', content: `工具调用 · ${toolName}` }
        },
        elements: [
            { tag: 'markdown', content: detailLines || blockText }
        ]
    };
}

async function sendToolCard(normalizedEvent, blockText, index) {
    const target = resolveReplyReceiveId(normalizedEvent);
    if (!target.receiveId) return;
    const card = buildToolCard(blockText, index);
    await state.larkClient.im.v1.message.create({
        params: { receive_id_type: target.receiveIdType },
        data: {
            receive_id: target.receiveId,
            msg_type: 'interactive',
            content: JSON.stringify(card)
        }
    });
}

function addProcessedEvent(eventId) {
    if (!eventId) return;
    state.processedEvents.set(eventId, Date.now());
}

function isProcessedEvent(eventId) {
    if (!eventId) return false;
    return state.processedEvents.has(eventId);
}

function cleanupProcessedEvents() {
    const now = Date.now();
    for (const [eventId, ts] of state.processedEvents.entries()) {
        if (now - ts > EVENT_TTL_MS) {
            state.processedEvents.delete(eventId);
        }
    }
}

function normalizeMessageEvent(payload) {
    const eventId = payload?.header?.event_id || payload?.event_id || payload?.message_id || '';
    const eventType = payload?.header?.event_type || payload?.event_type || '';
    const event = payload?.event || payload?.data || payload;
    const message = event?.message || payload?.message;
    const sender = event?.sender || payload?.sender;
    const chatId = message?.chat_id || '';
    const messageId = message?.message_id || '';
    const content = parseFeishuText(message?.content || '');
    const senderOpenId = sender?.sender_id?.open_id || '';
    return { eventId, eventType, chatId, messageId, content, senderOpenId };
}

function notify(info) {
    try {
        state.pushVcpInfo({
            type: 'feishu_bridge',
            timestamp: new Date().toISOString(),
            ...info
        });
    } catch (error) {
        if (state.config.DebugMode) {
            console.error('[FeishuBridge] pushVcpInfo failed:', error.message);
        }
    }
}

async function appendDeepMemoArchive(normalizedEvent, role, content, session) {
    if (!state.config.enableDeepMemoArchive) return;
    if (!normalizedEvent.chatId) return;
    await ensureDeepMemoArchiveDir();
    const safeChatId = normalizedEvent.chatId.replace(/[\\/:*?"<>|]/g, '_');
    const filePath = path.join(__dirname, 'state', 'deepmemo_archive', `${safeChatId}.jsonl`);
    const line = JSON.stringify({
        timestamp: new Date().toISOString(),
        chatId: normalizedEvent.chatId,
        senderOpenId: normalizedEvent.senderOpenId || '',
        role,
        content,
        selectedAgentAlias: session.selectedAgentAlias,
        sessionId: session.vcpSessionId
    });
    await fs.appendFile(filePath, `${line}\n`, 'utf8');
}

async function processIncomingMessage(payload) {
    const normalized = normalizeMessageEvent(payload);
    if (normalized.eventType && normalized.eventType !== 'im.message.receive_v1') return;
    if (!normalized.content) return;
    if (!normalized.chatId) return;
    const dedupeKey = normalized.eventId || normalized.messageId;
    if (isProcessedEvent(dedupeKey)) return;
    addProcessedEvent(dedupeKey);
    state.metrics.receivedMessages += 1;
    const session = getOrCreateSession(normalized.chatId, normalized.senderOpenId);
    const command = parseCommand(normalized.content);
    const commandResponse = await handleCommand(command, session);
    if (commandResponse) {
        await sendFeishuText(normalized, commandResponse);
        state.metrics.commandMessages += 1;
        notify({ action: 'command', command: command.type, chatId: normalized.chatId, agent: session.selectedAgentAlias });
        return;
    }
    // 飞书不支持直接修改用户消息文本，这里用 reaction 作为“紧贴用户消息”的确认反馈。
    await sendFeishuAckReaction(normalized);
    pushHistory(session, 'user', normalized.content);
    await appendDeepMemoArchive(normalized, 'user', normalized.content, session);
    const injectedUserText = buildFeishuInjectedUserText(normalized, normalized.content);
    let assistantText = '';
    try {
        // 仅生成最终回复，避免额外占位消息造成视觉分段。
        assistantText = await callVcpChat(session, injectedUserText);
        if (!assistantText) assistantText = '未获取到模型回复。';
    } catch (error) {
        assistantText = `请求失败：${error.message}`;
        state.metrics.chatFailures += 1;
    }
    const extracted = extractToolRequests(assistantText);
    const userVisibleText = extracted.plainText || '已执行工具调用，请查看下方卡片。';
    pushHistory(session, 'assistant', userVisibleText);
    await appendDeepMemoArchive(normalized, 'assistant', userVisibleText, session);
    await sendFeishuText(normalized, userVisibleText);
    for (let i = 0; i < extracted.blocks.length; i += 1) {
        await sendToolCard(normalized, extracted.blocks[i], i);
    }
    state.metrics.chatMessages += 1;
    notify({
        action: 'chat',
        chatId: normalized.chatId,
        agent: session.selectedAgentAlias,
        responseLength: assistantText.length,
        toolRequestCount: extracted.blocks.length
    });
}

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
        ...buildLarkBaseConfig(),
        loggerLevel: (Lark.LoggerLevel && Lark.LoggerLevel.error) ? Lark.LoggerLevel.error : undefined
    });
    state.larkWsClient = wsClient;
    await wsClient.start({ eventDispatcher: dispatcher });
    state.wsConnected = true;
    state.reconnectAttempt = 0;
    notify({ action: 'ws_open_sdk' });
}

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

function getStatus() {
    return {
        wsEnabled: state.config?.enableWs || false,
        wsConnected: state.wsConnected,
        reconnectAttempt: state.reconnectAttempt,
        sessionCount: state.sessionStore.size,
        eventCacheSize: state.processedEvents.size,
        defaultAgent: state.config?.defaultAgent || '',
        allowedAgents: getAllowedAgentAliases(),
        metrics: state.metrics
    };
}

async function initialize(config, dependencies) {
    state.config = buildConfig(config || {});
    state.projectBasePath = config.PROJECT_BASE_PATH || path.join(__dirname, '..', '..');
    state.vcpApiBaseUrl = `http://127.0.0.1:${config.PORT || process.env.PORT}/v1`;
    state.vcpAccessKey = config.Key || process.env.Key;
    if (!state.config.appId || !state.config.appSecret) {
        throw new Error('FEISHU_APP_ID 和 FEISHU_APP_SECRET 为必填配置。');
    }
    state.larkClient = new Lark.Client(buildLarkBaseConfig());
    state.shuttingDown = false;
    if (dependencies && dependencies.vcpLogFunctions && typeof dependencies.vcpLogFunctions.pushVcpInfo === 'function') {
        state.pushVcpInfo = dependencies.vcpLogFunctions.pushVcpInfo;
    }
    try {
        await loadAgentMap(true);
    } catch (error) {
        console.warn('[FeishuBridge] Failed to load agent_map.json on initialize:', error.message);
        state.agentMap = {};
    }
    await loadSessionsFromDisk();
    if (state.sessionFlushTimer) clearInterval(state.sessionFlushTimer);
    state.sessionFlushTimer = setInterval(() => {
        flushSessionsToDisk().catch(error => {
            console.error('[FeishuBridge] flushSessionsToDisk failed:', error.message);
        });
    }, SESSION_FLUSH_MS);
    if (state.housekeepingTimer) clearInterval(state.housekeepingTimer);
    state.housekeepingTimer = setInterval(() => {
        cleanupProcessedEvents();
    }, 60 * 1000);
    await connectWebSocket();
    console.log('[FeishuBridge] Initialized.');
}

function registerRoutes(app, adminApiRouter) {
    if (adminApiRouter && typeof adminApiRouter.get === 'function') {
        adminApiRouter.get('/feishu-bridge/status', async (req, res) => {
            try {
                await loadAgentMap(true);
                res.json(getStatus());
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
                const map = await loadAgentMap(true);
                res.json({ success: true, aliases: Object.keys(map) });
            } catch (error) {
                res.status(500).json({ success: false, error: error.message });
            }
        });
    }
    if (app && typeof app.get === 'function') {
        app.get('/api/feishu-bridge/status', async (req, res) => {
            try {
                await loadAgentMap(true);
                res.json(getStatus());
            } catch (error) {
                res.status(500).json({ error: error.message });
            }
        });
    }
}

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
    await flushSessionsToDisk();
    console.log('[FeishuBridge] Shutdown.');
}

module.exports = {
    initialize,
    registerRoutes,
    shutdown,
    __test: {
        buildFeishuInjectedUserText,
        buildFeishuMarkdownCard,
        extractVisibleContentDelta,
        computeDeltaFromSnapshot,
        extractToolRequests,
        parseToolBlock,
        buildToolCard
    }
};
