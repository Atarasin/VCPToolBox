/**
 * messageHelpers.js
 * 
 * 职责：提供纯函数用于消息解析、格式化、构建飞书卡片以及处理命令逻辑。
 * 该模块不依赖全局状态，只负责数据的转换和处理。
 */

/**
 * 解析飞书消息内容的文本字段
 * 飞书消息内容通常是 JSON 字符串，需要解析后提取 text 字段
 */
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

/**
 * 解析飞书消息内容的完整对象（包含 image_key, file_key 等）
 */
function parseMessageContent(rawContent) {
    if (rawContent === null || rawContent === undefined) return {};
    if (typeof rawContent === 'object' && !Array.isArray(rawContent)) return rawContent;
    if (typeof rawContent !== 'string') return {};
    const trimmed = rawContent.trim();
    if (!trimmed) return {};
    try {
        const parsed = JSON.parse(trimmed);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
        return {};
    } catch {
        return {};
    }
}

/**
 * 解析用户输入的指令
 * 支持的指令：
 * - /agent [list|set <alias>]
 * - /memory [on|off]
 * - /new (重置会话)
 */
function parseCommand(text) {
    const input = String(text || '').trim();
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
    if (head === '/new') {
        return { type: 'session-reset' };
    }
    return null;
}

/**
 * 执行具体的指令逻辑
 * @param {Object} state 全局状态
 * @param {Object} command 解析后的指令对象
 * @param {Object} session 当前会话对象
 * @param {string} sessionKey 会话键
 * @param {Object} helpers 依赖的辅助函数集合
 * @returns {Promise<string|null>} 返回给用户的文本反馈，如果为 null 则不回复
 */
async function handleCommand(state, command, session, sessionKey, helpers) {
    if (!command) return null;
    if (command.type === 'agent-current') {
        return `当前 Agent：${session.selectedAgentAlias}`;
    }
    if (command.type === 'agent-list') {
        const aliases = helpers.getAllowedAgentAliases(state);
        if (!aliases.length) return '当前没有可用 Agent。';
        return `可用 Agent：${aliases.join(', ')}`;
    }
    if (command.type === 'agent-set') {
        const alias = helpers.normalizeAgentAlias(state, command.alias);
        if (!alias) return '切换失败：Agent 不可用。';
        session.selectedAgentAlias = alias;
        session.updatedAt = Date.now();
        helpers.markSessionDirty(state);
        return `已切换 Agent：${alias}`;
    }
    if (command.type === 'memory-current') {
        return `当前记忆增强：${session.memoryMode === 'on' ? 'on' : 'off'}`;
    }
    if (command.type === 'memory-set') {
        session.memoryMode = command.mode;
        session.updatedAt = Date.now();
        helpers.markSessionDirty(state);
        return `记忆增强已设置为：${command.mode}`;
    }
    if (command.type === 'session-reset') {
        helpers.resetSession(state, session, sessionKey);
        return '已清空当前会话历史，并创建新会话。';
    }
    return null;
}

/**
 * 构建记忆增强提示词
 */
function buildMemoryHint(state, session) {
    if (!state.config.enableMemoryHint) return '';
    if (session.memoryMode === 'off') {
        return '\n\n[系统提示: 当前会话关闭了额外记忆增强提示，保持常规回答。]';
    }
    return '\n\n[系统提示: 当用户涉及回顾、复盘、之前讨论内容时，可自主选择调用记忆相关插件以提升一致性。]';
}

/**
 * 构建发送给 LLM 的完整消息列表（System + History + User）
 */
function buildMessages(state, session, userText, normalizeAgentAlias) {
    const agentAlias = normalizeAgentAlias(state, session.selectedAgentAlias) || state.config.defaultAgent;
    session.selectedAgentAlias = agentAlias;
    const systemContent = `{{agent:${agentAlias}}}${buildMemoryHint(state, session)}`;
    const history = Array.isArray(session.history) ? session.history.slice(-state.config.maxContextMessages) : [];
    return [{ role: 'system', content: systemContent }, ...history, { role: 'user', content: userText }];
}

/**
 * 构建注入了环境提示的用户文本
 * 告知 LLM 当前处于飞书 IM 环境
 */
function buildFeishuInjectedUserText(normalizedEvent, userText) {
    const chatId = normalizedEvent?.chatId || 'unknown_chat';
    const senderOpenId = normalizedEvent?.senderOpenId || 'unknown_user';
    const envPrompt = [
        `[系统提示: 当前处于飞书交流环境。chat_id=${chatId}; sender_open_id=${senderOpenId}。请在回复风格上适配IM即时沟通场景，保持简洁、明确，并避免误判为其它渠道消息。]`,
        '[系统提示: 当你需要回传图片或文件给用户时，可在回复中输出二进制块并由桥接层自动发送。格式为：',
        '<<<[BINARY_REPLY]>>>',
        'message_type:「始」image 或 file「末」,',
        'mime_type:「始」可选，例如 image/png 或 application/pdf「末」,',
        'file_name:「始」可选文件名「末」,',
        'binary_base64:「始」可选，data:...;base64,...「末」,',
        'attachment_path:「始」可选，本地绝对路径（与 binary_base64 二选一），优先使用该参数「末」',
        '<<<[END_BINARY_REPLY]>>>',
        '若无需发送二进制内容，请按正常文本回复。]'
    ].join('\n');
    if (Array.isArray(userText)) {
        const parts = userText.map(part => ({ ...part }));
        const firstTextPartIndex = parts.findIndex(part => part && part.type === 'text' && typeof part.text === 'string');
        if (firstTextPartIndex >= 0) {
            const textValue = parts[firstTextPartIndex].text || '';
            parts[firstTextPartIndex] = {
                ...parts[firstTextPartIndex],
                text: `${envPrompt}\n\n${textValue}`
            };
            return parts;
        }
        return [{ type: 'text', text: envPrompt }, ...parts];
    }
    return `${envPrompt}\n\n${String(userText || '')}`;
}

/**
 * 从 SSE 块中提取可见的内容增量
 */
function extractVisibleContentDelta(streamChunk) {
    const delta = streamChunk?.choices?.[0]?.delta || {};
    return delta.content || '';
}

/**
 * 构建飞书 Markdown 卡片结构
 */
function buildFeishuMarkdownCard(text) {
    const markdown = String(text || '').slice(0, 8000);
    return {
        config: { wide_screen_mode: true },
        elements: [{ tag: 'markdown', content: markdown }]
    };
}

/**
 * 计算增量文本（用于流式输出）
 */
function computeDeltaFromSnapshot(fullText, sentLength) {
    const safeText = String(fullText || '');
    const safeLength = Number.isFinite(sentLength) && sentLength >= 0 ? sentLength : 0;
    if (safeText.length <= safeLength) {
        return { delta: '', nextLength: safeText.length };
    }
    return {
        delta: safeText.slice(safeLength),
        nextLength: safeText.length
    };
}

/**
 * 从 LLM 回复中提取工具调用请求块
 * 格式：<<<[TOOL_REQUEST]>>>...<<<[END_TOOL_REQUEST]>>>
 */
function extractToolRequests(fullText) {
    const blockRegex = /<<<\[TOOL_REQUEST\]>>>[\s\S]*?<<<\[END_TOOL_REQUEST\]>>>/g;
    const blocks = [];
    let match;
    while ((match = blockRegex.exec(fullText)) !== null) {
        blocks.push(match[0]);
    }
    const plainText = String(fullText || '').replace(blockRegex, '').trim();
    return { blocks, plainText };
}

/**
 * 解析单个工具调用块的内容为键值对
 */
function parseToolBlock(blockText) {
    const inner = String(blockText || '')
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
        value = value.replace(/[「」]/g, '').replace(/始|末/g, '').replace(/,$/, '').trim();
        pairs.push({ key, value });
    }
    return pairs;
}

function extractBinaryReplies(fullText) {
    const blockRegex = /<<<\[BINARY_REPLY\]>>>[\s\S]*?<<<\[END_BINARY_REPLY\]>>>/g;
    const blocks = [];
    let match;
    while ((match = blockRegex.exec(fullText)) !== null) {
        blocks.push(match[0]);
    }
    const plainText = String(fullText || '').replace(blockRegex, '').trim();
    return { blocks, plainText };
}

function parseBinaryReplyBlock(blockText) {
    const inner = String(blockText || '')
        .replace('<<<[BINARY_REPLY]>>>', '')
        .replace('<<<[END_BINARY_REPLY]>>>', '')
        .trim();
    const lines = inner.split('\n').map(line => line.trim()).filter(Boolean);
    const data = {};
    for (const line of lines) {
        const idx = line.indexOf(':');
        if (idx <= 0) continue;
        const key = line.slice(0, idx).trim();
        let value = line.slice(idx + 1).trim();
        value = value.replace(/[「」]/g, '').replace(/始|末/g, '').replace(/,$/, '').trim();
        data[key] = value;
    }
    const messageTypeRaw = String(data.message_type || data.messageType || data.type || '').trim().toLowerCase();
    const messageType = messageTypeRaw === 'image' || messageTypeRaw === 'file' ? messageTypeRaw : '';
    const binaryBase64 = String(data.binary_base64 || data.binaryBase64 || data.base64 || data.data_uri || data.dataUrl || '').trim();
    const attachmentPath = String(data.attachment_path || data.attachmentPath || data.path || data.local_path || data.localPath || '').trim();
    if (!messageType || (!binaryBase64 && !attachmentPath)) return null;
    const fileName = String(data.file_name || data.fileName || '').trim();
    const mimeType = String(data.mime_type || data.mimeType || '').trim().toLowerCase() || inferMimeTypeByFileName(fileName || attachmentPath);
    return {
        messageType,
        binaryBase64,
        attachmentPath,
        mimeType,
        fileName
    };
}

/**
 * 为工具调用构建展示卡片
 */
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
        elements: [{ tag: 'markdown', content: detailLines || blockText }]
    };
}

/**
 * 解析推送消息类型
 */
function parsePushMessageType(messageType) {
    const value = String(messageType || 'text').trim().toLowerCase();
    if (value === 'text' || value === 'markdown' || value === 'image' || value === 'file') return value;
    return null;
}

/**
 * 根据 MIME 类型推断文件名
 */
function inferFileNameByMime(mimeType, fallback) {
    if (fallback) return fallback;
    const map = {
        'image/png': 'upload.png',
        'image/jpeg': 'upload.jpg',
        'image/jpg': 'upload.jpg',
        'image/webp': 'upload.webp',
        'image/gif': 'upload.gif',
        'application/pdf': 'upload.pdf',
        'text/plain': 'upload.txt'
    };
    return map[String(mimeType || '').toLowerCase()] || 'upload.bin';
}

function inferMimeTypeByFileName(fileName) {
    const name = String(fileName || '').trim().toLowerCase();
    if (name.endsWith('.png')) return 'image/png';
    if (name.endsWith('.jpg') || name.endsWith('.jpeg')) return 'image/jpeg';
    if (name.endsWith('.webp')) return 'image/webp';
    if (name.endsWith('.gif')) return 'image/gif';
    if (name.endsWith('.pdf')) return 'application/pdf';
    if (name.endsWith('.txt')) return 'text/plain';
    return '';
}

/**
 * 净化文件名，移除非法字符
 */
function sanitizeFileName(fileName) {
    const raw = String(fileName || '').trim();
    if (!raw) return '';
    const replaced = raw.replace(/[\\/:*?"<>|]/g, '_').replace(/\s+/g, ' ').trim();
    return replaced.slice(0, 120);
}

/**
 * 解析 Base64 数据（支持带前缀和不带前缀）
 */
function parseBase64Payload(base64Text) {
    const raw = String(base64Text || '').trim();
    if (!raw) return null;
    const match = raw.match(/^data:([^;]+);base64,(.+)$/i);
    if (match) {
        return {
            mimeType: match[1].trim().toLowerCase(),
            buffer: Buffer.from(match[2], 'base64')
        };
    }
    return {
        mimeType: '',
        buffer: Buffer.from(raw, 'base64')
    };
}

/**
 * 标准化飞书事件对象，提取关键信息
 */
function normalizeMessageEvent(payload) {
    const eventId = payload?.header?.event_id || payload?.event_id || payload?.message_id || '';
    const eventType = payload?.header?.event_type || payload?.event_type || '';
    const event = payload?.event || payload?.data || payload;
    const message = event?.message || payload?.message;
    const sender = event?.sender || payload?.sender;
    const chatId = message?.chat_id || '';
    const messageId = message?.message_id || '';
    const messageType = message?.message_type || 'text';
    const contentObject = parseMessageContent(message?.content || '');
    const content = parseFeishuText(message?.content || '');
    const imageKey = contentObject.image_key || '';
    const fileKey = contentObject.file_key || '';
    const fileName = contentObject.file_name || '';
    const senderOpenId = sender?.sender_id?.open_id || '';
    return { eventId, eventType, chatId, messageId, messageType, content, senderOpenId, imageKey, fileKey, fileName };
}

/**
 * 构建接收到附件时的系统提示词
 */
function buildIncomingAttachmentPrompt(normalizedEvent, attachment) {
    if (!attachment) return normalizedEvent.content || '';
    const lines = [];
    lines.push(`[系统提示: 用户上传了${attachment.kind === 'image' ? '图片' : '文件'}附件。]`);
    lines.push(`- 附件类型: ${attachment.kind}`);
    lines.push(`- 文件名: ${attachment.fileName}`);
    lines.push(`- 文件大小: ${attachment.size} bytes`);
    lines.push(`- 本地路径: ${attachment.localPath}`);
    if (normalizedEvent.content) {
        lines.push(`- 用户附言: ${normalizedEvent.content}`);
    }
    return lines.join('\n');
}

function buildIncomingMultimodalUserContent(normalizedEvent, attachment, maxInlineAttachmentBytes) {
    if (!attachment) return normalizedEvent.content || '';
    const promptText = buildIncomingAttachmentPrompt(normalizedEvent, attachment);
    const maxBytes = Number.isFinite(maxInlineAttachmentBytes) && maxInlineAttachmentBytes > 0 ? maxInlineAttachmentBytes : 0;
    if (!attachment.dataUrl || !maxBytes || attachment.size > maxBytes) {
        return promptText;
    }
    if (attachment.kind === 'image') {
        return [
            { type: 'text', text: promptText },
            { type: 'image_url', image_url: { url: attachment.dataUrl } }
        ];
    }
    const fileType = attachment.mimeType ? `; mime=${attachment.mimeType}` : '';
    const fileText = `[系统提示: 以下是用户上传文件的数据URI，可作为文档上下文解析]\n- 文件名: ${attachment.fileName}${fileType}\n- data_uri: ${attachment.dataUrl}`;
    return [
        { type: 'text', text: promptText },
        { type: 'text', text: fileText }
    ];
}

module.exports = {
    parseFeishuText,
    parseMessageContent,
    parseCommand,
    handleCommand,
    buildMessages,
    buildFeishuInjectedUserText,
    extractVisibleContentDelta,
    buildFeishuMarkdownCard,
    computeDeltaFromSnapshot,
    extractToolRequests,
    parseToolBlock,
    extractBinaryReplies,
    parseBinaryReplyBlock,
    buildToolCard,
    parsePushMessageType,
    inferFileNameByMime,
    sanitizeFileName,
    parseBase64Payload,
    normalizeMessageEvent,
    buildIncomingAttachmentPrompt,
    buildIncomingMultimodalUserContent
};
