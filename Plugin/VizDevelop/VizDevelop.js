#!/usr/bin/env node
/**
 * VizDevelop — 显影（viz-develop）图像服务 VCP 网关插件
 *
 * 设计依据 docs/design/2026-11-14_VizDevelop插件设计.md：
 *   ① 命令分发：command → 显影 MCP 工具映射 + fast/slow 分级超时（§2.1）
 *   ② 参数护栏：付费开关 / operationId / display 校验，不合法直接拒绝不发网络请求（§3.5）
 *   ③ 协议转发：lib/mcpClient.js（零依赖 JSON-RPC over fetch）（§3.3）
 *   ④ 结果整形：URL 原样透传 / token 全程脱敏 / 结果 markdown 化（§3.6 §3.7）
 *
 * 红线：不做设计判断与内容加工；付费操作零自动重试；不新增 shell 执行面。
 */

'use strict';

const { createMcpClient, VizMcpError, safeStringify } = require('./lib/mcpClient.js');

// --- 配置（由 Plugin.js initialize(config) 注入，模块内不读 process.env）---
let cfg = null;
let client = null;

const DEFAULTS = {
    VIZ_DEVELOP_MCP_URL: 'http://127.0.0.1:8787/mcp',
    VIZ_DEVELOP_ENABLE_IMAGE: true,
    VIZ_DEVELOP_TIMEOUT_FAST_MS: 30000,
    VIZ_DEVELOP_TIMEOUT_SLOW_MS: 660000
};

/** initialize 只存配置、不发任何网络请求：显影宕机或令牌缺失都不影响插件加载（§3.6 / R5）。 */
async function initialize(config = {}, _dependencies = {}) {
    cfg = { ...DEFAULTS, ...config };
    client = cfg.VIZ_DEVELOP_AUTH_TOKEN
        ? createMcpClient({ url: cfg.VIZ_DEVELOP_MCP_URL, token: cfg.VIZ_DEVELOP_AUTH_TOKEN })
        : null;
}

async function shutdown() {
    // 无本地资源需要释放；submit 均为 fire-and-forget，凭 operationId 可从服务端账本找回。
}

// ---------------------------------------------------------------------------
// 结果整形（§3.7）与错误映射（§3.6）
// ---------------------------------------------------------------------------

function success(text) {
    return { content: [{ type: 'text', text }] };
}

/** VizMcpError.category → 用户可读分类 + 指引；全程 token 脱敏。 */
function mapError(error) {
    const redact = s => safeStringify(s, cfg?.VIZ_DEVELOP_AUTH_TOKEN);
    let message;
    if (error instanceof VizMcpError) {
        if (error.category === 'tool') {
            // 显影结构化业务/校验错误：原样透传，不概括不改写（§3.6）。
            const detail = error.detail !== undefined ? error.detail : error.message;
            message = `显影业务错误（原样透传）：${redact(typeof detail === 'string' ? detail : JSON.stringify(detail))}`;
        } else {
            const hint = {
                network: `建议：先用 command:health 探活显影服务；确认服务已启动且 VIZ_DEVELOP_MCP_URL（当前：${cfg?.VIZ_DEVELOP_MCP_URL}）可达。`,
                unauthorized: '建议：检查插件 config.env 中 VIZ_DEVELOP_AUTH_TOKEN 是否与显影服务 config/auth-token 一致。',
                timeout: '建议：先用 command:health 探活；稍后重试只读命令（付费命令严禁自动重试）。',
                server: '建议：先用 command:health 探活显影服务；若持续失败请查看显影服务端日志。'
            }[error.category] || '';
            message = `${redact(error.message)}${hint ? '。' + hint : ''}`;
        }
    } else {
        message = `VizDevelop: ${redact(error && error.message ? error.message : String(error))}`;
    }
    console.log(`[VizDevelop] 命令失败（已脱敏）：${message}`);
    return { status: 'error', error: message };
}

// ---------------------------------------------------------------------------
// 命令实现（§3.4）
// ---------------------------------------------------------------------------

/** health：GET /healthz 探活，返回 ok / service / artifacts / projects 摘要。fast 档。 */
async function cmdHealth() {
    const h = await client.health(cfg.VIZ_DEVELOP_TIMEOUT_FAST_MS);
    const icon = h.ok === true ? '✅' : '⚠️';
    return `${icon} 显影服务健康检查\n\n` + [
        `- ok: ${h.ok}`,
        `- service: ${h.service}`,
        `- artifacts: ${h.artifacts}`,
        `- projects: ${h.projects}`
    ].join('\n');
}

/** list_image_models：透传 defaultModel + models 目录（含各路由能力字段）。fast 档。 */
async function cmdListImageModels() {
    const r = await client.callTool('viz_list_image_models', {}, cfg.VIZ_DEVELOP_TIMEOUT_FAST_MS);
    const routes = (Array.isArray(r.models) ? r.models : [])
        .map(m => `- ${m.routeId}${m.default ? '（服务默认）' : ''}：${(m.operations || []).join('/')}，输出 ${(m.outputFormats || []).join('/')}`)
        .join('\n');
    return `显影图像模型目录（默认模型：${r.defaultModel}，共 ${(r.models || []).length} 个路由）：\n\n${routes}\n\n完整能力目录（含尺寸规则等，原样透传）：\n\`\`\`json\n${JSON.stringify(r, null, 2)}\n\`\`\``;
}

// 命令表：command → { handler, 时档 }。M2 将补 create_image_input / get_image_operation /
// generate_image / edit_image。
const COMMANDS = {
    health: { handler: cmdHealth, tier: 'fast' },
    list_image_models: { handler: cmdListImageModels, tier: 'fast' }
};

const SUPPORTED = 'health / list_image_models / create_image_input / get_image_operation / generate_image / edit_image';

// ---------------------------------------------------------------------------
// 命令分发层（§2.1）
// ---------------------------------------------------------------------------

async function processToolCall(data, _context = {}) {
    if (!cfg) throw new Error('VizDevelop 尚未初始化');
    const command = String(data?.command || '').trim();
    const entry = COMMANDS[command];
    if (!entry) {
        return { status: 'error', error: `VizDevelop: 不支持的命令"${command || '(空)'}"。支持的命令：${SUPPORTED}` };
    }
    if (!client) {
        return { status: 'error', error: 'VizDevelop: 缺少 VIZ_DEVELOP_AUTH_TOKEN 配置，无法连接显影服务。建议：在插件目录 config.env 填入显影服务 config/auth-token 的内容后重载插件。' };
    }
    try {
        return success(await entry.handler(data));
    } catch (error) {
        return mapError(error);
    }
}

module.exports = { initialize, processToolCall, shutdown };

// CLI 独立验收模式：echo '{"command":"health"}' | node VizDevelop.js
// 从插件目录 config.env 读取配置直连显影（网络行为与 VCP 内运行完全一致）。
if (require.main === module) {
    (async () => {
        const fs = require('fs');
        const path = require('path');
        const dotenv = require('dotenv');
        const env = dotenv.parse(fs.readFileSync(path.join(__dirname, 'config.env'), 'utf-8'));
        let input = '';
        await new Promise(resolve => {
            process.stdin.on('data', c => { input += c; });
            process.stdin.on('end', resolve);
            setTimeout(resolve, 3000);
        });
        try {
            await initialize(env);
            const result = await processToolCall(input ? JSON.parse(input) : {});
            process.stdout.write(JSON.stringify(result));
        } catch (error) {
            process.stdout.write(JSON.stringify({ status: 'error', error: `VizDevelop: ${safeStringify(error.message, env.VIZ_DEVELOP_AUTH_TOKEN)}` }));
            process.exitCode = 1;
        } finally {
            await shutdown();
        }
    })();
}
