const axios = require('axios');
const fs = require('fs').promises;
const path = require('path');
const { TextDecoder } = require('util');

/**
 * feishuGateway.js
 * 
 * 职责：封装所有与外部系统的网络交互，包括飞书开放平台 API 和 VCP 后端 API。
 * 处理 HTTP 请求、Token 管理、文件上传下载以及 SSE 流式响应。
 */

/**
 * 获取或刷新飞书 Tenant Access Token
 * Token 会在内存中缓存，并在过期前自动刷新
 */
async function ensureTenantAccessToken(state) {
    const now = Date.now();
    // 如果 Token 存在且有效期剩余大于 30秒，则直接使用缓存
    if (state.tenantAccessToken && state.tenantAccessTokenExpireAt - 30000 > now) {
        return state.tenantAccessToken;
    }
    const response = await axios.post(
        'https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal',
        {
            app_id: state.config.appId,
            app_secret: state.config.appSecret
        },
        {
            headers: { 'Content-Type': 'application/json' },
            timeout: state.config.requestTimeoutMs
        }
    );
    if (response?.data?.code !== 0 || !response?.data?.tenant_access_token) {
        throw new Error(`获取 tenant_access_token 失败: ${response?.data?.msg || 'unknown_error'}`);
    }
    state.tenantAccessToken = response.data.tenant_access_token;
    const expire = Number(response.data.expire || 7200);
    state.tenantAccessTokenExpireAt = now + expire * 1000;
    return state.tenantAccessToken;
}

/**
 * 上传图片到飞书
 * 使用 fetch 和 FormData 以支持二进制流上传
 */
async function uploadFeishuImage(state, buffer, fileName, mimeType, helpers) {
    const token = await ensureTenantAccessToken(state);
    const form = new FormData();
    form.append('image_type', 'message');
    const safeName = helpers.sanitizeFileName(fileName) || helpers.inferFileNameByMime(mimeType, 'upload.png');
    form.append('image', new Blob([buffer], { type: mimeType || 'application/octet-stream' }), safeName);
    const response = await fetch('https://open.feishu.cn/open-apis/im/v1/images', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
        body: form
    });
    const data = await response.json();
    if (!response.ok || data?.code !== 0 || !data?.data?.image_key) {
        throw new Error(`上传图片失败: ${data?.msg || response.statusText}`);
    }
    return data.data.image_key;
}

/**
 * 上传文件到飞书
 */
async function uploadFeishuFile(state, buffer, fileName, mimeType, helpers) {
    const token = await ensureTenantAccessToken(state);
    const form = new FormData();
    form.append('file_type', 'stream');
    const safeName = helpers.sanitizeFileName(fileName) || helpers.inferFileNameByMime(mimeType, 'upload.bin');
    form.append('file_name', safeName);
    form.append('file', new Blob([buffer], { type: mimeType || 'application/octet-stream' }), safeName);
    const response = await fetch('https://open.feishu.cn/open-apis/im/v1/files', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
        body: form
    });
    const data = await response.json();
    if (!response.ok || data?.code !== 0 || !data?.data?.file_key) {
        throw new Error(`上传文件失败: ${data?.msg || response.statusText}`);
    }
    return data.data.file_key;
}

/**
 * 下载飞书消息中的资源文件（图片或文件）
 */
async function downloadFeishuMessageResource(state, messageId, resourceKey, resourceType, fileName) {
    const token = await ensureTenantAccessToken(state);
    const url = new URL(`https://open.feishu.cn/open-apis/im/v1/messages/${encodeURIComponent(messageId)}/resources/${encodeURIComponent(resourceKey)}`);
    url.searchParams.set('type', resourceType);
    if (resourceType === 'file' && fileName) {
        url.searchParams.set('file_name', fileName);
    }
    const response = await fetch(url.toString(), {
        method: 'GET',
        headers: { Authorization: `Bearer ${token}` }
    });
    if (!response.ok) {
        throw new Error(`下载资源失败: ${response.status}`);
    }
    const arrayBuffer = await response.arrayBuffer();
    const contentType = response.headers && typeof response.headers.get === 'function'
        ? String(response.headers.get('content-type') || '').split(';')[0].trim().toLowerCase()
        : '';
    return {
        buffer: Buffer.from(arrayBuffer),
        contentType
    };
}

/**
 * 保存传入的附件到本地文件系统
 */
async function saveIncomingAttachment(state, normalizedEvent, helpers, ensureAttachmentDir, fs) {
    const messageType = normalizedEvent.messageType;
    if (messageType !== 'image' && messageType !== 'file') return null;
    const resourceKey = messageType === 'image' ? normalizedEvent.imageKey : normalizedEvent.fileKey;
    if (!resourceKey || !normalizedEvent.messageId) return null;
    const rawName = messageType === 'file' ? normalizedEvent.fileName : `${resourceKey}.png`;
    const safeName = helpers.sanitizeFileName(rawName) || `${resourceKey}.bin`;
    const dirPath = await ensureAttachmentDir(normalizedEvent.chatId);
    const localPath = require('path').join(dirPath, safeName);
    const downloaded = await downloadFeishuMessageResource(
        state,
        normalizedEvent.messageId,
        resourceKey,
        messageType,
        normalizedEvent.fileName
    );
    const fileBuffer = downloaded.buffer;
    const mimeType = downloaded.contentType || '';
    await fs.writeFile(localPath, fileBuffer);
    const dataUrl = mimeType ? `data:${mimeType};base64,${fileBuffer.toString('base64')}` : '';
    return {
        kind: messageType,
        fileName: safeName,
        localPath,
        size: fileBuffer.length,
        resourceKey,
        mimeType,
        dataUrl
    };
}

/**
 * 解析回复的目标 ID（根据配置决定回复到 Chat 还是 OpenID）
 */
function resolveReplyReceiveId(state, normalizedEvent) {
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

/**
 * 对飞书消息进行点赞确认（ACK）
 */
async function sendFeishuAckReaction(state, normalizedEvent, notify) {
    if (!normalizedEvent?.messageId) return;
    try {
        const result = await state.larkClient.im.v1.messageReaction.create({
            path: { message_id: normalizedEvent.messageId },
            data: {
                reaction_type: { emoji_type: 'OK' }
            }
        });
        if (result && result.code && result.code !== 0) {
            notify({
                action: 'ack_reaction_failed',
                chatId: normalizedEvent.chatId,
                messageId: normalizedEvent.messageId,
                code: result.code,
                reason: result.msg || ''
            });
        }
    } catch (error) {
        notify({
            action: 'ack_reaction_error',
            chatId: normalizedEvent.chatId,
            messageId: normalizedEvent.messageId,
            reason: error.message
        });
    }
}

/**
 * 发送文本消息到飞书
 */
async function sendFeishuText(state, normalizedEvent, text, buildFeishuMarkdownCard) {
    if (!text) return;
    const target = resolveReplyReceiveId(state, normalizedEvent);
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

/**
 * 发送工具调用结果卡片到飞书
 */
async function sendToolCard(state, normalizedEvent, blockText, index, buildToolCard) {
    const target = resolveReplyReceiveId(state, normalizedEvent);
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

/**
 * 主动推送消息到飞书（支持文本、图片、文件）
 */
async function sendFeishuPushMessage(state, options, helpers) {
    const receiveIdType = options?.receiveIdType === 'open_id' ? 'open_id' : options?.receiveIdType === 'chat_id' ? 'chat_id' : null;
    const receiveId = String(options?.receiveId || '').trim();
    const messageType = helpers.parsePushMessageType(options?.messageType);
    const text = String(options?.text || '');
    if (!receiveIdType) {
        throw new Error('receiveIdType 仅支持 chat_id 或 open_id。');
    }
    if (!receiveId) {
        throw new Error('receiveId 不能为空。');
    }
    if (!messageType) {
        throw new Error('messageType 仅支持 text、markdown、image 或 file。');
    }
    if ((messageType === 'text' || messageType === 'markdown') && !text.trim()) {
        throw new Error('text 不能为空。');
    }
    const data = { receive_id: receiveId };
    if (messageType === 'image' || messageType === 'file') {
        const parsedPayload = helpers.parseBase64Payload(options?.binaryBase64);
        if (!parsedPayload || !parsedPayload.buffer || parsedPayload.buffer.length === 0) {
            throw new Error('binaryBase64 不能为空。');
        }
        const payloadMimeType = String(options?.mimeType || parsedPayload.mimeType || '').trim().toLowerCase();
        const safeName = helpers.sanitizeFileName(options?.fileName) || helpers.inferFileNameByMime(payloadMimeType, '');
        if (messageType === 'image') {
            const imageKey = await uploadFeishuImage(state, parsedPayload.buffer, safeName || 'upload.png', payloadMimeType || 'image/png', helpers);
            data.msg_type = 'image';
            data.content = JSON.stringify({ image_key: imageKey });
        } else {
            const fileKey = await uploadFeishuFile(state, parsedPayload.buffer, safeName || 'upload.bin', payloadMimeType || 'application/octet-stream', helpers);
            data.msg_type = 'file';
            data.content = JSON.stringify({ file_key: fileKey });
        }
    } else if (messageType === 'text') {
        data.msg_type = 'text';
        data.content = JSON.stringify({ text: text.slice(0, 8000) });
    } else {
        data.msg_type = 'interactive';
        data.content = JSON.stringify(helpers.buildFeishuMarkdownCard(text));
    }
    const response = await state.larkClient.im.v1.message.create({
        params: { receive_id_type: receiveIdType },
        data
    });
    return {
        messageId: response?.data?.message_id || response?.message_id || '',
        messageType
    };
}

/**
 * 发送二进制消息（图片/文件）到飞书
 * 用于对话流中的二进制回复
 */
async function sendFeishuBinary(state, normalizedEvent, messageType, payload, helpers) {
    const target = resolveReplyReceiveId(state, normalizedEvent);
    if (!target.receiveId || (messageType !== 'image' && messageType !== 'file')) return;
    let buffer = null;
    let mimeType = String(payload?.mimeType || '').trim().toLowerCase();
    let fileName = helpers.sanitizeFileName(payload?.fileName);
    const parsed = helpers.parseBase64Payload(payload?.binaryBase64);
    if (parsed && parsed.buffer && parsed.buffer.length > 0) {
        buffer = parsed.buffer;
        if (!mimeType) mimeType = String(parsed.mimeType || '').trim().toLowerCase();
    } else {
        const attachmentPath = String(payload?.attachmentPath || '').trim();
        if (!attachmentPath) {
            throw new Error('binaryBase64 或 attachmentPath 至少提供一个。');
        }
        buffer = await fs.readFile(attachmentPath);
        if (!fileName) {
            fileName = helpers.sanitizeFileName(path.basename(attachmentPath));
        }
    }
    if (!buffer || buffer.length === 0) {
        throw new Error('二进制内容为空。');
    }
    fileName = fileName || helpers.inferFileNameByMime(mimeType, '');
    if (messageType === 'image') {
        const imageKey = await uploadFeishuImage(state, buffer, fileName || 'upload.png', mimeType || 'image/png', helpers);
        await state.larkClient.im.v1.message.create({
            params: { receive_id_type: target.receiveIdType },
            data: {
                receive_id: target.receiveId,
                msg_type: 'image',
                content: JSON.stringify({ image_key: imageKey })
            }
        });
    } else {
        const fileKey = await uploadFeishuFile(state, buffer, fileName || 'upload.bin', mimeType || 'application/octet-stream', helpers);
        await state.larkClient.im.v1.message.create({
            params: { receive_id_type: target.receiveIdType },
            data: {
                receive_id: target.receiveId,
                msg_type: 'file',
                content: JSON.stringify({ file_key: fileKey })
            }
        });
    }
}

/**
 * 调用 VCP 聊天 API
 * 处理流式响应 (SSE) 并拼接结果
 */
async function callVcpChat(state, session, userText, buildMessages, normalizeAgentAlias, extractVisibleContentDelta) {
    const payload = {
        model: state.config.model,
        messages: buildMessages(state, session, userText, normalizeAgentAlias),
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
    return await new Promise((resolve, reject) => {
        response.data.on('data', chunk => {
            sseBuffer += decoder.decode(chunk, { stream: true });
            const lines = sseBuffer.split('\n');
            sseBuffer = lines.pop() || '';
            for (const rawLine of lines) {
                const line = rawLine.trim();
                if (!line.startsWith('data:')) continue;
                const jsonText = line.substring(5).trim();
                if (!jsonText || jsonText === '[DONE]') continue;
                try {
                    const parsed = JSON.parse(jsonText);
                    const contentDelta = extractVisibleContentDelta(parsed);
                    if (contentDelta) fullText += contentDelta;
                } catch {
                }
            }
        });
        response.data.on('end', () => resolve(fullText));
        response.data.on('error', reject);
    });
}

module.exports = {
    ensureTenantAccessToken,
    saveIncomingAttachment,
    sendFeishuAckReaction,
    sendFeishuText,
    sendToolCard,
    sendFeishuPushMessage,
    sendFeishuBinary,
    callVcpChat,
    resolveReplyReceiveId
};
