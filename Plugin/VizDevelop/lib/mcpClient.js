#!/usr/bin/env node
/**
 * lib/mcpClient.js — 零依赖 MCP（Streamable HTTP）客户端
 *
 * 设计依据 docs/design/2026-11-14_VizDevelop插件设计.md §3.3 / §3.6：
 * - fetch POST /mcp 直发 tools/call，Accept 同时声明 JSON 与 SSE 双格式；
 * - 响应按 Content-Type 解析：application/json 直接 parse；text/event-stream
 *   逐帧取 data: 并匹配请求 id（显影实测以 SSE 返回，见设计 §8 风险 1）；
 * - initialize 预握手兜底：进程级一次性，仅当错误指向会话/初始化时触发；
 * - health 探活不走 /mcp：直接 GET ${base}/healthz（无鉴权）；
 * - safeError：任何错误信息中出现 token 值即替换为 [REDACTED]（R1 全程脱敏）。
 */

'use strict';

/** MCP 协议级 / 传输级错误。category 供上层映射为用户可读分类。 */
class VizMcpError extends Error {
    constructor(category, message, detail) {
        super(message);
        this.name = 'VizMcpError';
        this.category = category; // network | unauthorized | timeout | server | tool
        this.detail = detail;     // 显影结构化错误原样透传（不概括不改写）
    }
}

/** 把任意值安全字符串化并抹掉 token（防御性用于所有错误路径与日志）。 */
function safeStringify(value, token) {
    let text;
    try {
        text = typeof value === 'string' ? value : JSON.stringify(value);
    } catch (_) {
        text = String(value);
    }
    if (!text) return text;
    return token && token.length >= 8 ? text.split(token).join('[REDACTED]') : text;
}

/** 从 SSE 文本流中提取匹配请求 id 的 JSON-RPC 响应（忽略服务端主动通知）。 */
function parseSseResponse(text, requestId) {
    let dataBuffer = [];
    const flush = () => {
        if (!dataBuffer.length) return null;
        const payload = dataBuffer.join('\n');
        dataBuffer = [];
        try {
            const msg = JSON.parse(payload);
            if (msg && msg.id === requestId && (msg.result !== undefined || msg.error !== undefined)) {
                return msg;
            }
        } catch (_) { /* 非 JSON 帧（注释/心跳）忽略 */ }
        return null;
    };
    for (const rawLine of text.split(/\r?\n/)) {
        if (rawLine === '') {
            const hit = flush();
            if (hit) return hit;
        } else if (rawLine.startsWith('data:')) {
            dataBuffer.push(rawLine.slice(5).replace(/^ /, ''));
        }
    }
    return flush();
}

/**
 * 创建客户端实例。
 * @param {object} options
 * @param {string} options.url      显影 MCP 端点（…/mcp）
 * @param {string} options.token    Bearer 令牌
 */
function createMcpClient({ url, token }) {
    if (!url) throw new Error('mcpClient: 缺少 VIZ_DEVELOP_MCP_URL');
    let rpcId = 0;
    let initialized = false; // 进程级一次性 initialize 兜底标记

    const base = url.replace(/\/mcp\/?$/, '');

    async function post(body, timeoutMs) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(new Error(`请求超时（${timeoutMs}ms）`)), timeoutMs);
        try {
            return await fetch(url, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Accept': 'application/json, text/event-stream',
                    'Authorization': `Bearer ${token}`
                },
                body: JSON.stringify(body),
                signal: controller.signal
            });
        } finally {
            clearTimeout(timer);
        }
    }

    /** HTTP 层错误分类（§3.6：网络不可达 / 未授权(401) / 超时 / 服务端错误）。 */
    function classifyTransportError(error) {
        if (error && error.name === 'AbortError') return new VizMcpError('timeout', `请求超时：${safeStringify(error.message, token)}`);
        return new VizMcpError('network', `网络不可达：${safeStringify(error.message, token)}`);
    }

    /** 解析 JSON / SSE 双格式响应体为 JSON-RPC 消息。 */
    async function readRpcMessage(response, requestId) {
        const contentType = String(response.headers.get('content-type') || '');
        const body = await response.text();
        if (contentType.includes('application/json')) {
            try { return JSON.parse(body); } catch (_) { return null; }
        }
        if (contentType.includes('text/event-stream')) {
            return parseSseResponse(body, requestId);
        }
        // 未知 Content-Type：先按 JSON 尝试，失败按 SSE 尝试
        try { return JSON.parse(body); } catch (_) { /* fallthrough */ }
        return parseSseResponse(body, requestId);
    }

    /** JSON-RPC 层消息 → 结果 / 抛错。 */
    function unwrapRpcMessage(message) {
        if (!message) throw new VizMcpError('server', '服务端返回了无法解析的响应');
        if (message.error) {
            throw new VizMcpError('server', `服务端错误 ${message.error.code || ''}: ${safeStringify(message.error.message, token)}`, message.error.data);
        }
        return message.result;
    }

    /** tools/call 结果解包：content[0].text 为 JSON 字符串则 parse；isError 走错误路径。 */
    function unwrapToolResult(result) {
        if (!result || !Array.isArray(result.content) || result.content.length === 0) {
            throw new VizMcpError('server', '服务端返回了空的工具结果');
        }
        const text = result.content[0].text;
        let parsed = text;
        try { parsed = JSON.parse(text); } catch (_) { /* 非 JSON 文本原样返回 */ }
        if (result.isError === true) {
            // 显影结构化业务/校验错误：原样透传，不概括不改写（§3.6）。
            throw new VizMcpError('tool', safeStringify(typeof parsed === 'string' ? text : parsed, token), parsed);
        }
        return parsed;
    }

    /** 错误是否指向会话/初始化（触发 initialize 兜底重试）。 */
    function hintsInitializationProblem(error) {
        const text = `${error.message || ''} ${safeStringify(error.detail, token) || ''}`;
        return /initial|session|initialized|32600|32002/i.test(text);
    }

    async function rpcCall(method, params, timeoutMs) {
        const requestId = ++rpcId;
        const body = { jsonrpc: '2.0', id: requestId, method, params };
        let response;
        try {
            response = await post(body, timeoutMs);
        } catch (error) {
            throw classifyTransportError(error);
        }
        if (response.status === 401 || response.status === 403) {
            throw new VizMcpError('unauthorized', `未授权（${response.status}）：请检查插件 config.env 的 VIZ_DEVELOP_AUTH_TOKEN`);
        }
        if (!response.ok) {
            const snippet = safeStringify((await response.text()).slice(0, 300), token);
            throw new VizMcpError('server', `服务端错误（HTTP ${response.status}）：${snippet}`);
        }
        let message;
        try {
            message = await readRpcMessage(response, requestId);
        } catch (error) {
            throw new VizMcpError('server', `响应解析失败：${safeStringify(error.message, token)}`);
        }
        return unwrapRpcMessage(message);
    }

    /** 进程级一次性 initialize 兜底（显影无状态，预期不会触发）。 */
    async function ensureInitialized(timeoutMs) {
        if (initialized) return;
        await rpcCall('initialize', {
            protocolVersion: '2025-03-26',
            capabilities: {},
            clientInfo: { name: 'VCP-VizDevelop', version: '1.0.0' }
        }, timeoutMs);
        try {
            await rpcCall('notifications/initialized', {}, timeoutMs);
        } catch (_) { /* 通知无响应体，失败可忽略 */ }
        initialized = true;
    }

    /**
     * 调用显影 MCP 工具。
     * @returns 解析后的结果对象（或原始文本）
     * @throws {VizMcpError} category + 脱敏 message + 结构化 detail
     */
    async function callTool(name, args = {}, timeoutMs = 30000) {
        try {
            const result = await rpcCall('tools/call', { name, arguments: args }, timeoutMs);
            return unwrapToolResult(result);
        } catch (error) {
            if (error instanceof VizMcpError && error.category === 'server' && hintsInitializationProblem(error) && !initialized) {
                await ensureInitialized(timeoutMs);
                const result = await rpcCall('tools/call', { name, arguments: args }, timeoutMs);
                return unwrapToolResult(result);
            }
            throw error;
        }
    }

    /** health 探活：GET ${base}/healthz，无鉴权（§3.3）。 */
    async function health(timeoutMs = 10000) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(new Error('health 探活超时')), timeoutMs);
        try {
            const response = await fetch(`${base}/healthz`, { method: 'GET', signal: controller.signal });
            if (!response.ok) throw new VizMcpError('server', `healthz 返回 HTTP ${response.status}`);
            return await response.json();
        } catch (error) {
            if (error instanceof VizMcpError) throw error;
            if (error && error.name === 'AbortError') throw new VizMcpError('timeout', 'health 探活超时');
            throw new VizMcpError('network', `网络不可达：${safeStringify(error.message, token)}`);
        } finally {
            clearTimeout(timer);
        }
    }

    return { callTool, health };
}

module.exports = { createMcpClient, VizMcpError, safeStringify, parseSseResponse };

// CLI 独立验收模式：node lib/mcpClient.js <toolName> ['{"json":"args"}'] [timeoutMs]
// 用插件目录 config.env 提供的 URL/token 直连显影，供 M1.S2 验收使用。
if (require.main === module) {
    (async () => {
        const fs = require('fs');
        const path = require('path');
        const dotenv = require('dotenv');
        const env = dotenv.parse(fs.readFileSync(path.join(__dirname, '..', 'config.env'), 'utf-8'));
        const [toolName, argsJson = '{}', timeoutMs = '30000'] = process.argv.slice(2);
        if (!toolName) {
            console.error('用法: node lib/mcpClient.js <toolName> [jsonArgs] [timeoutMs]');
            process.exit(2);
        }
        const client = createMcpClient({ url: env.VIZ_DEVELOP_MCP_URL, token: env.VIZ_DEVELOP_AUTH_TOKEN });
        try {
            const result = toolName === 'healthz'
                ? await client.health(Number(timeoutMs))
                : await client.callTool(toolName, JSON.parse(argsJson), Number(timeoutMs));
            console.log(JSON.stringify(result, null, 2));
        } catch (error) {
            const message = safeStringify(error.message, env.VIZ_DEVELOP_AUTH_TOKEN);
            console.error(JSON.stringify({ category: error.category, error: message }, null, 2));
            process.exit(1);
        }
    })();
}
