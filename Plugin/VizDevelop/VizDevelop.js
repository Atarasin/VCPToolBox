#!/usr/bin/env node
/**
 * VizDevelop — 显影（viz-develop）图像服务 VCP 网关插件
 *
 * 职责（docs/design/2026-11-14_VizDevelop插件设计.md）：
 *   ① 命令分发：command → 显影 MCP 工具映射 + 分级超时
 *   ② 参数护栏：付费开关 / operationId / display 校验（不合法直接拒绝，不发网络请求）
 *   ③ 协议转发：lib/mcpClient.js（零依赖 JSON-RPC over fetch）
 *   ④ 结果整形：URL 原样透传 / token 全程脱敏 / 结果 markdown 化
 *
 * 红线：不做设计判断与内容加工；付费操作零自动重试；不新增 shell 执行面。
 */

'use strict';

// --- 配置（由 Plugin.js initialize(config) 注入，模块内不读 process.env）---
let cfg = null;

const DEFAULTS = {
    VIZ_DEVELOP_MCP_URL: 'http://127.0.0.1:8787/mcp',
    VIZ_DEVELOP_ENABLE_IMAGE: true,
    VIZ_DEVELOP_TIMEOUT_FAST_MS: 30000,
    VIZ_DEVELOP_TIMEOUT_SLOW_MS: 660000
};

async function initialize(config = {}, _dependencies = {}) {
    // 只存配置、不发任何网络请求：显影宕机不影响本插件加载与其他插件（R5）。
    cfg = { ...DEFAULTS, ...config };
}

async function shutdown() {
    // 无本地资源需要释放；submit 均为 fire-and-forget，凭 operationId 可从服务端账本找回。
}

async function processToolCall(data, _context = {}) {
    if (!cfg) throw new Error('VizDevelop 尚未初始化');
    const command = String(data?.command || '').trim();
    return {
        status: 'error',
        error: `VizDevelop: 命令"${command || '(空)'}"尚未接线。支持的命令：health / list_image_models / create_image_input / get_image_operation / generate_image / edit_image`
    };
}

module.exports = { initialize, processToolCall, shutdown };

if (require.main === module) {
    (async () => {
        const input = await new Promise(resolve => {
            let buf = '';
            process.stdin.on('data', c => { buf += c; });
            process.stdin.on('end', () => resolve(buf));
        });
        try {
            await initialize();
            const result = await processToolCall(JSON.parse(input));
            process.stdout.write(JSON.stringify(result));
        } catch (error) {
            process.stdout.write(JSON.stringify({ status: 'error', error: `VizDevelop: ${error.message}` }));
            process.exitCode = 1;
        } finally {
            await shutdown();
        }
    })();
}
