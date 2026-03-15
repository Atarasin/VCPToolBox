const fs = require('fs').promises;
const path = require('path');

/**
 * bridgeState.js
 * 
 * 职责：负责管理 FeishuBridge 的全局状态、配置、会话持久化以及事件去重。
 * 该模块不包含具体的业务逻辑或外部 API 调用，专注于数据的存储与存取。
 */

// 事件去重缓存的有效期（1小时）
const EVENT_TTL_MS = 60 * 60 * 1000;
// 会话持久化到磁盘的间隔（20秒）
const SESSION_FLUSH_MS = 20 * 1000;
const ROOT_DIR = path.join(__dirname, '..');

/**
 * 创建并初始化全局状态对象
 * @returns {Object} 初始化的状态对象
 */
function createState() {
    return {
        config: null,
        projectBasePath: null,
        vcpApiBaseUrl: null,
        vcpAccessKey: null,
        reconnectTimer: null,
        reconnectAttempt: 0,
        shuttingDown: false,
        sessionStore: new Map(),      // 内存中的会话存储
        processedEvents: new Map(),   // 已处理事件的去重缓存
        sessionDirty: false,          // 标记会话是否有变更需要落盘
        sessionFlushTimer: null,
        housekeepingTimer: null,
        agentMap: {},                 // Agent 别名映射表
        agentMapLoadedAt: 0,
        larkClient: null,             // 飞书 SDK 客户端实例
        larkWsClient: null,           // 飞书 WebSocket 客户端实例
        wsConnected: false,
        tenantAccessToken: '',        // 飞书 Tenant Access Token
        tenantAccessTokenExpireAt: 0, // Token 过期时间戳
        pushVcpInfo: () => {},        // VCP 日志推送回调
        metrics: {                    // 运行时统计指标
            receivedMessages: 0,
            commandMessages: 0,
            chatMessages: 0,
            streamUpdates: 0,
            sendFailures: 0,
            chatFailures: 0
        }
    };
}

/**
 * 解析布尔配置项
 */
function parseBoolean(value, fallback = false) {
    if (value === undefined || value === null) return fallback;
    return String(value).toLowerCase() === 'true';
}

/**
 * 解析整数配置项
 */
function parseInteger(value, fallback) {
    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) ? parsed : fallback;
}

/**
 * 解析 CSV 格式的字符串为数组
 */
function splitCsv(value) {
    if (!value || typeof value !== 'string') return [];
    return value.split(',').map(item => item.trim()).filter(Boolean);
}

/**
 * 构建配置对象，处理环境变量和默认值
 * @param {Object} config 原始配置对象
 */
function buildConfig(config) {
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
        enableDeepMemoArchive: parseBoolean(config.FEISHU_ENABLE_DEEPMEMO_ARCHIVE, true),
        maxInlineAttachmentBytes: parseInteger(config.FEISHU_MAX_INLINE_ATTACHMENT_BYTES, 2 * 1024 * 1024)
    };
}

/**
 * 构建飞书 SDK 基础配置
 */
function buildLarkBaseConfig(state, Lark) {
    const appType = (Lark && Lark.AppType && Lark.AppType.SelfBuild) ? Lark.AppType.SelfBuild : undefined;
    return {
        appId: state.config.appId,
        appSecret: state.config.appSecret,
        appType
    };
}

function getSessionStateFile() {
    return path.join(ROOT_DIR, 'state', 'sessions.json');
}

async function ensureStateDir() {
    await fs.mkdir(path.join(ROOT_DIR, 'state'), { recursive: true });
}

async function ensureDeepMemoArchiveDir() {
    await fs.mkdir(path.join(ROOT_DIR, 'state', 'deepmemo_archive'), { recursive: true });
}

/**
 * 确保附件存储目录存在
 * @param {string} chatId 会话ID
 * @returns {string} 附件存储目录的绝对路径
 */
async function ensureAttachmentDir(chatId) {
    const safeChatId = String(chatId || 'unknown_chat').replace(/[\\/:*?"<>|]/g, '_');
    const dateSegment = new Date().toISOString().slice(0, 10);
    const dirPath = path.join(ROOT_DIR, 'state', 'attachments', safeChatId, dateSegment);
    await fs.mkdir(dirPath, { recursive: true });
    return dirPath;
}

function markSessionDirty(state) {
    state.sessionDirty = true;
}

function getSessionKey(chatId, userId) {
    return `${chatId || 'unknown_chat'}:${userId || 'unknown_user'}`;
}

/**
 * 获取或创建会话对象
 * @param {Object} state 全局状态
 * @param {string} chatId 飞书群聊ID
 * @param {string} userId 发送者ID
 */
function getOrCreateSession(state, chatId, userId) {
    const sessionKey = getSessionKey(chatId, userId);
    if (!state.sessionStore.has(sessionKey)) {
        state.sessionStore.set(sessionKey, {
            vcpSessionId: sessionKey,
            selectedAgentAlias: state.config.defaultAgent,
            memoryMode: 'on',
            history: [],
            updatedAt: Date.now()
        });
        markSessionDirty(state);
    }
    return state.sessionStore.get(sessionKey);
}

/**
 * 生成新的会话 ID，用于重置上下文
 */
function buildRenewedSessionId(sessionKey) {
    const suffix = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    return `${sessionKey || 'session'}:${suffix}`;
}

/**
 * 重置会话状态（清空历史，生成新 Session ID）
 */
function resetSession(state, session, sessionKey) {
    if (!session || typeof session !== 'object') return;
    session.history = [];
    session.vcpSessionId = buildRenewedSessionId(sessionKey || session.vcpSessionId);
    session.updatedAt = Date.now();
    markSessionDirty(state);
}

/**
 * 追加对话历史
 */
function pushHistory(state, session, role, content) {
    session.history.push({ role, content });
    const maxMessages = Math.max(2, state.config.maxContextMessages);
    if (session.history.length > maxMessages) {
        session.history = session.history.slice(-maxMessages);
    }
    session.updatedAt = Date.now();
    markSessionDirty(state);
}

/**
 * 从磁盘加载会话状态
 */
async function loadSessionsFromDisk(state) {
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

/**
 * 将会话状态持久化到磁盘
 */
async function flushSessionsToDisk(state) {
    if (!state.sessionDirty) return;
    const jsonObject = {};
    for (const [key, value] of state.sessionStore.entries()) {
        jsonObject[key] = value;
    }
    await ensureStateDir();
    await fs.writeFile(getSessionStateFile(), JSON.stringify(jsonObject, null, 2), 'utf8');
    state.sessionDirty = false;
}

/**
 * 加载 Agent 别名映射配置
 */
async function loadAgentMap(state, force = false) {
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

/**
 * 获取允许使用的 Agent 别名列表
 */
function getAllowedAgentAliases(state) {
    const allAliases = Object.keys(state.agentMap);
    if (!state.config.allowedAgents.length) return allAliases;
    const allowedSet = new Set(state.config.allowedAgents);
    return allAliases.filter(alias => allowedSet.has(alias));
}

/**
 * 校验并标准化 Agent 别名
 */
function normalizeAgentAlias(state, inputAlias) {
    if (!inputAlias || typeof inputAlias !== 'string') return null;
    const alias = inputAlias.trim();
    if (!alias) return null;
    const allowed = getAllowedAgentAliases(state);
    return allowed.includes(alias) ? alias : null;
}

/**
 * 记录已处理的事件 ID
 */
function addProcessedEvent(state, eventId) {
    if (!eventId) return;
    state.processedEvents.set(eventId, Date.now());
}

/**
 * 检查事件是否已处理（防重）
 */
function isProcessedEvent(state, eventId) {
    if (!eventId) return false;
    return state.processedEvents.has(eventId);
}

/**
 * 清理过期的已处理事件记录
 */
function cleanupProcessedEvents(state) {
    const now = Date.now();
    for (const [eventId, ts] of state.processedEvents.entries()) {
        if (now - ts > EVENT_TTL_MS) {
            state.processedEvents.delete(eventId);
        }
    }
}

/**
 * 推送状态信息到 VCP 系统日志
 */
function notify(state, info) {
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

/**
 * 深度记忆归档（将对话日志追加到文件）
 */
async function appendDeepMemoArchive(state, normalizedEvent, role, content, session) {
    if (!state.config.enableDeepMemoArchive) return;
    if (!normalizedEvent.chatId) return;
    await ensureDeepMemoArchiveDir();
    const safeChatId = normalizedEvent.chatId.replace(/[\\/:*?"<>|]/g, '_');
    const filePath = path.join(ROOT_DIR, 'state', 'deepmemo_archive', `${safeChatId}.jsonl`);
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

/**
 * 获取当前插件的运行状态摘要
 */
function getStatus(state, allowedAgents) {
    return {
        wsEnabled: state.config?.enableWs || false,
        wsConnected: state.wsConnected,
        reconnectAttempt: state.reconnectAttempt,
        sessionCount: state.sessionStore.size,
        eventCacheSize: state.processedEvents.size,
        defaultAgent: state.config?.defaultAgent || '',
        allowedAgents,
        metrics: state.metrics
    };
}

module.exports = {
    EVENT_TTL_MS,
    SESSION_FLUSH_MS,
    createState,
    buildConfig,
    buildLarkBaseConfig,
    markSessionDirty,
    getSessionKey,
    getOrCreateSession,
    resetSession,
    pushHistory,
    loadSessionsFromDisk,
    flushSessionsToDisk,
    loadAgentMap,
    getAllowedAgentAliases,
    normalizeAgentAlias,
    addProcessedEvent,
    isProcessedEvent,
    cleanupProcessedEvents,
    notify,
    appendDeepMemoArchive,
    getStatus,
    ensureAttachmentDir
};
