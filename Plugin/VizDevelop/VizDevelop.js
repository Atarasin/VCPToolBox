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

/** 插件层参数护栏拒绝（§3.5）：不发网络请求，message 本身即给 AI 的修正指引。 */
class GuardError extends Error {
    constructor(message) {
        super(message);
        this.name = 'GuardError';
    }
}

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
    // 类型规范化（与 configSchema 一致）：Plugin.js 链路已转换，CLI/裸 dotenv 场景兜底。
    cfg.VIZ_DEVELOP_ENABLE_IMAGE = String(cfg.VIZ_DEVELOP_ENABLE_IMAGE).toLowerCase() === 'true';
    for (const key of ['VIZ_DEVELOP_TIMEOUT_FAST_MS', 'VIZ_DEVELOP_TIMEOUT_SLOW_MS']) {
        const num = Number(cfg[key]);
        cfg[key] = Number.isFinite(num) && num > 0 ? num : DEFAULTS[key];
    }
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
    if (error instanceof GuardError) {
        message = redact(error.message);
    } else if (error instanceof VizMcpError) {
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
async function cmdHealth(_data, timeoutMs) {
    const h = await client.health(timeoutMs);
    const icon = h.ok === true ? '✅' : '⚠️';
    return `${icon} 显影服务健康检查\n\n` + [
        `- ok: ${h.ok}`,
        `- service: ${h.service}`,
        `- artifacts: ${h.artifacts}`,
        `- projects: ${h.projects}`
    ].join('\n');
}

/** list_image_models：透传 defaultModel + models 目录（含各路由能力字段）。fast 档。 */
async function cmdListImageModels(_data, timeoutMs) {
    const r = await client.callTool('viz_list_image_models', {}, timeoutMs);
    const routes = (Array.isArray(r.models) ? r.models : [])
        .map(m => `- ${m.routeId}${m.default ? '（服务默认）' : ''}：${(m.operations || []).join('/')}，输出 ${(m.outputFormats || []).join('/')}`)
        .join('\n');
    return `显影图像模型目录（默认模型：${r.defaultModel}，共 ${(r.models || []).length} 个路由）：\n\n${routes}\n\n完整能力目录（含尺寸规则等，原样透传）：\n\`\`\`json\n${JSON.stringify(r, null, 2)}\n\`\`\``;
}

/** create_image_input：上传源图（纯 base64，拒绝 data: 前缀）。fast 档（§3.4 命令 3）。 */
async function cmdCreateImageInput(data, timeoutMs) {
    const contentBase64 = typeof data.contentBase64 === 'string' ? data.contentBase64.trim() : '';
    if (!contentBase64) {
        throw new GuardError('create_image_input 需要参数 contentBase64（纯 base64 图片内容，不带 data: 前缀）');
    }
    if (/^data:/i.test(contentBase64)) {
        throw new GuardError('contentBase64 必须是纯 base64（服务端契约拒绝 data URL）。请去掉开头的 "data:image/...;base64," 前缀后重发');
    }
    const args = { contentBase64: data.contentBase64 };
    if (data.filename !== undefined && data.filename !== '') args.filename = String(data.filename);
    if (data.mimeType !== undefined && data.mimeType !== '') args.mimeType = String(data.mimeType);
    const r = await client.callTool('viz_create_image_input', args, timeoutMs);
    return `✅ 源图已上传（inputId 可用于 edit_image 的 image_input_id）\n\n` + [
        `- inputId: ${r.inputId}`,
        `- mimeType: ${r.mimeType}`,
        `- 尺寸: ${r.width}x${r.height}`,
        `- bytes: ${r.bytes}`,
        `- sha256: ${r.sha256}`
    ].join('\n');
}

/** get_image_operation：凭 operationId 只读查询透传。fast 档（§3.4 命令 4）。 */
async function cmdGetImageOperation(data, timeoutMs) {
    const operationId = String(data.operationId || '').trim();
    if (!operationId) {
        throw new GuardError('get_image_operation 需要参数 operationId');
    }
    const r = await client.callTool('viz_get_image_operation', { operationId }, timeoutMs);
    const lines = [`显影任务查询（operationId: ${operationId}）\n`];
    lines.push(`- status: ${r.status}${r.outcome !== undefined ? ` | outcome: ${r.outcome}` : ''}`);
    if (r.upstreamAttempts !== undefined) lines.push(`- upstreamAttempts: ${r.upstreamAttempts}`);
    if (Array.isArray(r.images) && r.images.length > 0) {
        lines.push(`- 图片（${r.images.length} 张，公网 URL 原样透传）：`);
        for (const img of r.images) {
            const meta = [img.width, img.height].filter(v => v !== undefined).join('x');
            lines.push(`  - ${img.url}${meta ? `（${meta}）` : ''}${img.sha256 ? ` sha256=${String(img.sha256).slice(0, 16)}…` : ''}`);
        }
    }
    if (Array.isArray(r.previews) && r.previews.length > 0) {
        lines.push(`- 当前有效预览（${r.previews.length} 个）：`);
        for (const p of r.previews) lines.push(`  - ${typeof p === 'string' ? p : JSON.stringify(p)}`);
    }
    if (r.error !== undefined && r.error !== null) {
        lines.push(`- error（原样透传）：${typeof r.error === 'string' ? r.error : JSON.stringify(r.error)}`);
    }
    if (r.status === 'unknown') {
        // R2 纪律：unknown 状态绝不换 ID 重发（费用可能已发生），必须人工核对。
        lines.push(`\n⚠️ 该 operationId 在服务端状态为 unknown：请原样告知用户人工核对，禁止换新 operationId 重发。`);
    } else if (['queued', 'running', 'pending', 'executing', 'dispatching'].includes(String(r.status).toLowerCase())) {
        lines.push(`\n提示：任务未完成，可每 1~2 分钟重新查询（command:get_image_operation + operationId）。`);
    }
    lines.push(`\n<details>完整记录（原样透传）：\n\`\`\`json\n${JSON.stringify(r, null, 2)}\n\`\`\`\n</details>`);
    return lines.join('\n');
}

// ---------------------------------------------------------------------------
// 付费图像命令（submit + query，§3.4 命令 5/6；护栏 §3.5）
// ---------------------------------------------------------------------------

/** operationId 幂等键格式（显影服务端契约）。 */
const OPERATION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

// VCP 工具协议平铺参数全为字符串；重组为显影 MCP 类型化/嵌套参数时按此表转换。
const NUMBER_PARAMS = ['n', 'partialImages', 'frameCount', 'frameDurationMs', 'outputCompression'];
const BOOLEAN_PARAMS = ['stream'];
const STRING_PARAMS = ['model', 'size', 'outputFormat', 'quality', 'complexity', 'background', 'moderation', 'user'];

/** 付费命令公共护栏：开关 / operationId / display / prompt（§3.5，全部插件层拒绝、不发网络请求）。 */
function guardPaidCommand(data, { requireImage = false } = {}) {
    if (cfg.VIZ_DEVELOP_ENABLE_IMAGE !== true) {
        throw new GuardError('付费图像命令已被关闭（VIZ_DEVELOP_ENABLE_IMAGE=false），本命令被拦截且未发起任何网络请求。开启方法：在插件目录 config.env 中设置 VIZ_DEVELOP_ENABLE_IMAGE=true，保存后重载插件（AdminPanel 插件管理）或重启 VCP 生效。');
    }
    const operationId = String(data.operationId || '').trim();
    if (!operationId) {
        throw new GuardError('付费命令必须提供 operationId（幂等键，格式 ^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$，如 img-主题-v1）。传输层重试必须复用同一 ID；新 ID = 新付费意图。');
    }
    if (!OPERATION_ID_RE.test(operationId)) {
        throw new GuardError(`operationId "${operationId.slice(0, 40)}" 不符合格式 ^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$（字母/数字开头，可含 . _ : -，最长 128 字符）。请修正后重发（同一付费意图请保持同一 ID）。`);
    }
    const title = String(data.display_title || '').trim();
    if (!title) throw new GuardError('付费命令必须提供 display_title（公开信息，≤60 字符）：说明图片是什么。禁止填写密钥或隐私。');
    if (title.length > 60) throw new GuardError(`display_title 超长（${title.length} > 60 字符）。请精简为图片内容的简短标题。`);
    const description = String(data.display_description || '').trim();
    if (!description) throw new GuardError('付费命令必须提供 display_description（公开信息，≤240 字符）：说明为什么生成、准备用在哪里。禁止填写密钥或隐私。');
    if (description.length > 240) throw new GuardError(`display_description 超长（${description.length} > 240 字符）。请精简用途说明。`);
    const prompt = typeof data.prompt === 'string' ? data.prompt : '';
    if (!prompt.trim()) throw new GuardError('付费命令必须提供 prompt（图片描述原文，服务端原样透传不 trim 不改写）。');
    return { operationId, title, description, prompt };
}

/** 平铺字符串参数 → 显影 MCP 类型化参数（可选字段原样透传，R3 不加工）。 */
function buildMcpArgs(data, base) {
    const args = { ...base };
    for (const key of STRING_PARAMS) {
        if (data[key] !== undefined && data[key] !== '') args[key] = String(data[key]);
    }
    for (const key of NUMBER_PARAMS) {
        if (data[key] !== undefined && data[key] !== '') {
            const num = Number(data[key]);
            if (Number.isFinite(num)) args[key] = num;
        }
    }
    for (const key of BOOLEAN_PARAMS) {
        if (data[key] !== undefined && data[key] !== '') args[key] = String(data[key]).toLowerCase() === 'true';
    }
    return args;
}

/** submit 即发即回：fire-and-forget 发起 tools/call，立即返回 operationId 回执与轮询指引。 */
function submitFireAndForget(mcpToolName, args, operationId, label) {
    Promise.resolve(client.callTool(mcpToolName, args, cfg.VIZ_DEVELOP_TIMEOUT_SLOW_MS))
        .then(r => console.log(`[VizDevelop] submit 受理完成（${operationId}）：outcome=${r?.outcome} reused=${r?.reused} attempts=${r?.stats?.upstreamAttempts}`))
        .catch(err => console.log(`[VizDevelop] submit 后台失败（${operationId}，已脱敏，零自动重试）：${safeStringify(err.message, cfg.VIZ_DEVELOP_AUTH_TOKEN)}`));
    return `🚀 显影${label}任务已提交（付费操作，受理与生成在服务端继续，本回执不等待生图结果）\n\n` + [
        `- operationId: ${operationId}（幂等键；任何重试必须复用此 ID，新 ID = 新付费意图）`,
        `- 轮询：每 1~2 分钟调用 command:get_image_operation + operationId:${operationId} 查询结果`,
        '- 纪律：零自动重试；若查询返回 unknown 状态，禁止换新 operationId 重发，须原样告知用户人工核对'
    ].join('\n');
}

/** generate_image（submit，§3.4 命令 5）。slow 档（后台受理预算）。 */
function cmdGenerateImage(data) {
    const guard = guardPaidCommand(data);
    const args = buildMcpArgs(data, {
        operationId: guard.operationId,
        display: { title: guard.title, description: guard.description },
        prompt: guard.prompt
    });
    return submitFireAndForget('viz_generate_image', args, guard.operationId, '图像生成');
}

/** edit_image（submit，§3.4 命令 6）：源图二选一，mask/markup 至多一个。 */
function cmdEditImage(data) {
    const guard = guardPaidCommand(data);
    const imageInputId = String(data.image_input_id || '').trim();
    const artifactToken = String(data.image_artifact_token || '').trim();
    if (!imageInputId && !artifactToken) {
        throw new GuardError('edit_image 需要源图二选一：image_input_id（create_image_input 上传所得 inputId）或 image_artifact_token（已发布产物 token）。');
    }
    if (imageInputId && artifactToken) {
        throw new GuardError('edit_image 的 image_input_id 与 image_artifact_token 只能提供其中一个。');
    }
    const maskInputId = String(data.mask_input_id || '').trim();
    const markupInputId = String(data.markup_input_id || '').trim();
    if (maskInputId && markupInputId) {
        throw new GuardError('mask_input_id 与 markup_input_id 至多提供一个（显影服务端契约）。');
    }
    const args = buildMcpArgs(data, {
        operationId: guard.operationId,
        display: { title: guard.title, description: guard.description },
        prompt: guard.prompt,
        image: imageInputId ? { inputId: imageInputId } : { artifactToken }
    });
    if (maskInputId) args.mask = { inputId: maskInputId };
    if (markupInputId) args.markup = { inputId: markupInputId };
    if (data.input_fidelity !== undefined && data.input_fidelity !== '') args.inputFidelity = String(data.input_fidelity);
    return submitFireAndForget('viz_edit_image', args, guard.operationId, '图像编辑');
}

// 命令表：command → { handler, 时档 }。submit 命令的 slow 档为后台受理预算。
const COMMANDS = {
    health: { handler: cmdHealth, tier: 'fast' },
    list_image_models: { handler: cmdListImageModels, tier: 'fast' },
    create_image_input: { handler: cmdCreateImageInput, tier: 'fast' },
    get_image_operation: { handler: cmdGetImageOperation, tier: 'fast' },
    generate_image: { handler: cmdGenerateImage, tier: 'slow' },
    edit_image: { handler: cmdEditImage, tier: 'slow' }
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
    const timeoutMs = entry.tier === 'slow'
        ? cfg.VIZ_DEVELOP_TIMEOUT_SLOW_MS
        : cfg.VIZ_DEVELOP_TIMEOUT_FAST_MS;
    try {
        return success(await entry.handler(data, timeoutMs));
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
