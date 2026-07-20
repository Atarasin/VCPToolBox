#!/usr/bin/env node

'use strict';

/**
 * M2.S4 真实客户端 capability smoke（§5.3 / 06-execution-plan.md M2.S4）。
 *
 * 两部分：
 * 1. 直连 capability probe（确定性，M2 门禁证据）：
 *    - 绑定 credential 的 initialize.instructions 只含所属 agent guidance 摘要；
 *    - 未绑定（legacy key）只收通用 instructions，不泄露任何 agent 内容；
 *    - guidance resource / bootstrap `integrationGuidance` / REST binding
 *      三面内容与 revision 一致（tool-only host 经 bootstrap 获取等价内容）；
 *    - REST guidance 响应 `Cache-Control: private, no-store` + `Vary` 身份通道。
 * 2. 真实客户端运行（Claude Code / Codex / Kimi）：为每个客户端生成临时 MCP
 *    配置连到同一 gateway，用统一自检 prompt 采集 instructions/resources/
 *    bootstrap 的实际消费情况，并结合 gateway 侧观测到的 JSON-RPC 方法
 *    输出 §5.3 兼容性矩阵（结果登记 smoke-records.md）。
 */

const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const express = require('express');

const createAgentGatewayRoutes = require('../routes/agentGatewayRoutes');
const { createMcpHttpServer } = require('../modules/agentGateway/mcpHttpServer');
const { computeTokenDigest } = require('../modules/agentGateway/policy/credentialResolver');
const { GENERIC_INSTRUCTIONS } = require('../modules/agentGateway/services/agentGuidanceService');
const { getGatewayServiceBundle } = require('../modules/agentGateway/createGatewayServiceBundle');
const { createPluginManager } = require('../tests/agent-gateway/helpers/agent-gateway-test-helpers');
const {
    composeCodexConfig,
    stripInheritedMcpSections,
    readRenderTextFromToolCall
} = require('./run-agent-gateway-codex-e2e');

const DEFAULT_AGENT_ID = 'Ariadne';
const DEFAULT_USER_NAME = 'M2Smoke';
const DEFAULT_SERVER_NAME = 'vcp-agent-gateway-m2';
const DEFAULT_GATEWAY_KEY = 'gw-m2-smoke-legacy-key';
const DEFAULT_GATEWAY_ID = 'gw-m2-smoke';
const DEFAULT_MCP_PROTOCOL_VERSION = '2025-06-18';
const GUIDANCE_MARKER = 'M2-SMOKE-MARKER';
const SECRET_TAG = 'm2-smoke-secret-tag';
const SUPPORTED_CLIENTS = ['claude', 'codex', 'kimi'];
const DEFAULT_CLIENT_TIMEOUT_MS = 240000;

function printUsage() {
    process.stdout.write(`Agent Gateway M2 capability smoke

Usage:
  node scripts/run-agent-gateway-m2-smoke.js [options]

Options:
  --clients <a,b,c>   Real clients to run (subset of ${SUPPORTED_CLIENTS.join(',')}).
                      Default: all of them.
  --skip-clients      Only run the deterministic direct capability probes.
  --client-timeout-ms <n>  Per-client run timeout. Default: ${DEFAULT_CLIENT_TIMEOUT_MS}
  --keep-temp         Keep temporary files on success.
  --help              Show this help message.

Environment:
  CODEX_BIN / CLAUDE_BIN / KIMI_BIN   Override client executables.
  CODEX_MODEL                          Optional Codex model override.

Notes:
  - Starts a temporary native backend + Streamable HTTP MCP gateway with a
    file-credential bound to agent "${DEFAULT_AGENT_ID}" and a legacy gateway key.
  - Real client runs consume real model quota and require each client to be
    authenticated on this machine.
  - Results are meant to be recorded in
    modules/agentGateway/docs/agent-integration/smoke-records.md.
`);
}

function parseArgs(argv) {
    const parsed = {
        clients: [...SUPPORTED_CLIENTS],
        skipClients: false,
        keepTemp: false,
        clientTimeoutMs: DEFAULT_CLIENT_TIMEOUT_MS,
        help: false
    };
    for (let index = 0; index < argv.length; index += 1) {
        const argument = argv[index];
        if (argument === '--help') {
            parsed.help = true;
            continue;
        }
        if (argument === '--skip-clients') {
            parsed.skipClients = true;
            continue;
        }
        if (argument === '--keep-temp') {
            parsed.keepTemp = true;
            continue;
        }
        const nextValue = argv[index + 1];
        if (!nextValue) {
            throw new Error(`Missing value for ${argument}`);
        }
        if (argument === '--clients') {
            const requested = nextValue.split(',').map((entry) => entry.trim()).filter(Boolean);
            for (const client of requested) {
                if (!SUPPORTED_CLIENTS.includes(client)) {
                    throw new Error(`Unsupported client "${client}" (supported: ${SUPPORTED_CLIENTS.join(', ')})`);
                }
            }
            parsed.clients = requested;
            index += 1;
            continue;
        }
        if (argument === '--client-timeout-ms') {
            const value = Number.parseInt(nextValue, 10);
            if (!Number.isFinite(value) || value <= 0) {
                throw new Error('--client-timeout-ms requires a positive integer');
            }
            parsed.clientTimeoutMs = value;
            index += 1;
            continue;
        }
        throw new Error(`Unsupported argument: ${argument}`);
    }
    return parsed;
}

function createGuidanceConfig(agentId) {
    return {
        version: 1,
        shared: {
            workflow: [
                '先调用 gateway_recall_run 检查相关历史。',
                `${GUIDANCE_MARKER}: capability probe workflow line.`
            ],
            memoryWritePolicy: {
                write: ['已验证结论'],
                skip: ['密钥和敏感数据']
            }
        },
        agents: {
            [agentId]: {
                displayName: `${agentId} (M2 Smoke)`,
                memoryDefaults: {
                    tags: [SECRET_TAG],
                    metadata: { project: 'vcp-toolbox-m2-smoke' }
                }
            }
        }
    };
}

/**
 * 统一的客户端自检 prompt：四行 marker 输出，便于跨客户端机器判定。
 */
function createCapabilityPrompt({ serverName, agentId, userName }) {
    return [
        `You are running an MCP capability self-test against the MCP server named "${serverName}".`,
        'Perform these steps and output EXACTLY four lines, one per step, no other text:',
        `1. List the MCP tools that server "${serverName}" exposes. Output: TOOLS::<comma-separated tool names>`,
        `2. Call the MCP tool gateway_agent_bootstrap from that server with arguments {"agentId":"${agentId}","variables":{"VarUserName":"${userName}"}}. From the result read integrationGuidance.revision. Output: BOOTSTRAP::<revision value> (on failure output BOOTSTRAP_FAIL::<reason>)`,
        `3. If your environment can read MCP resources, read the resource vcp://agent-gateway/agents/${agentId}/guidance from that server and output: RESOURCE::<revision field of the JSON> (if you cannot access MCP resources output RESOURCE_UNSUPPORTED)`,
        `4. If you received server-provided instructions from this MCP server (the "instructions" field of its initialize response), output: INSTRUCTIONS::<the first 10 words> (otherwise output INSTRUCTIONS_UNSEEN)`
    ].join('\n');
}

function parseCapabilityMarkers(outputText) {
    const text = String(outputText || '');
    const lines = text.split('\n').map((line) => line.trim());
    const findLine = (prefix) => lines.find((line) => line.startsWith(prefix)) || '';
    const bootstrapLine = findLine('BOOTSTRAP::') || findLine('BOOTSTRAP_FAIL::');
    const resourceLine = findLine('RESOURCE::') || findLine('RESOURCE_UNSUPPORTED');
    const instructionsLine = findLine('INSTRUCTIONS::') || findLine('INSTRUCTIONS_UNSEEN');
    return {
        tools: findLine('TOOLS::').slice('TOOLS::'.length),
        bootstrapOk: bootstrapLine.startsWith('BOOTSTRAP::'),
        bootstrapRevision: bootstrapLine.startsWith('BOOTSTRAP::')
            ? bootstrapLine.slice('BOOTSTRAP::'.length).trim()
            : '',
        bootstrapFailReason: bootstrapLine.startsWith('BOOTSTRAP_FAIL::')
            ? bootstrapLine.slice('BOOTSTRAP_FAIL::'.length).trim()
            : '',
        resourceOk: resourceLine.startsWith('RESOURCE::'),
        resourceRevision: resourceLine.startsWith('RESOURCE::')
            ? resourceLine.slice('RESOURCE::'.length).trim()
            : '',
        resourceUnsupported: resourceLine.startsWith('RESOURCE_UNSUPPORTED'),
        instructionsSeen: instructionsLine.startsWith('INSTRUCTIONS::'),
        instructionsExcerpt: instructionsLine.startsWith('INSTRUCTIONS::')
            ? instructionsLine.slice('INSTRUCTIONS::'.length).trim()
            : ''
    };
}

/**
 * §5.3 兼容性矩阵行：客户端自述 marker + gateway 侧 JSON-RPC 观测交叉验证。
 */
function buildCapabilityMatrix(clientResults, expectedRevision) {
    const header = [
        '| 客户端 | 版本 | initialize | instructions 消费 | resources 消费 | bootstrap（tool-only 路径） | 备注 |',
        '|---|---|---|---|---|---|---|'
    ];
    const rows = clientResults.map((result) => {
        const rpc = result.rpcMethods || new Set();
        const initializeSeen = rpc.has('initialize');
        const resourceReadSeen = rpc.has('resources/read');
        const bootstrapCallSeen = (result.toolCallNames || []).includes('gateway_agent_bootstrap');
        const markers = result.markers || {};
        const instructionsCell = markers.instructionsSeen
            ? `模型可见（"${markers.instructionsExcerpt.slice(0, 40)}"）`
            : '未向模型呈现';
        const resourceCell = resourceReadSeen
            ? (markers.resourceOk && markers.resourceRevision === expectedRevision
                ? 'resources/read + revision 一致'
                : 'resources/read（revision 未回读）')
            : (markers.resourceUnsupported ? '不支持' : '未观测到');
        const bootstrapCell = bootstrapCallSeen
            ? (markers.bootstrapOk && markers.bootstrapRevision === expectedRevision
                ? '成功 + revision 一致'
                : '调用发生（revision 未回读）')
            : (markers.bootstrapFailReason ? `失败：${markers.bootstrapFailReason.slice(0, 60)}` : '未观测到');
        return `| ${result.client} | ${result.version || 'n/a'} | ${initializeSeen ? 'ok' : 'FAIL'} | ${instructionsCell} | ${resourceCell} | ${bootstrapCell} | ${result.note || ''} |`;
    });
    return header.concat(rows).join('\n');
}

async function readResponse(response) {
    const rawBody = await response.text();
    let body = null;
    if (rawBody) {
        try {
            body = JSON.parse(rawBody);
        } catch (_error) {
            body = null;
        }
    }
    return {
        status: response.status,
        headers: Object.fromEntries(response.headers.entries()),
        body,
        rawBody
    };
}

async function postJson(url, body, headers = {}) {
    const response = await fetch(url, {
        method: 'POST',
        headers: {
            accept: 'application/json, text/event-stream',
            'content-type': 'application/json',
            'mcp-protocol-version': DEFAULT_MCP_PROTOCOL_VERSION,
            ...headers
        },
        body: JSON.stringify(body)
    });
    return readResponse(response);
}

function stableStringify(value) {
    if (Array.isArray(value)) {
        return `[${value.map(stableStringify).join(',')}]`;
    }
    if (value && typeof value === 'object') {
        const keys = Object.keys(value).sort();
        return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
    }
    return JSON.stringify(value);
}

function deepEquals(left, right) {
    return stableStringify(left) === stableStringify(right);
}

async function createMcpSession(mcpUrl, token, gatewayId) {
    const sharedHeaders = {
        'x-agent-gateway-key': token,
        'x-agent-gateway-id': gatewayId
    };
    const initialize = await postJson(mcpUrl, {
        jsonrpc: '2.0',
        id: 'init-1',
        method: 'initialize',
        params: {
            protocolVersion: DEFAULT_MCP_PROTOCOL_VERSION,
            capabilities: {},
            clientInfo: { name: 'agent-gateway-m2-smoke', version: '1.0.0' }
        }
    }, sharedHeaders);
    const sessionId = initialize.headers['mcp-session-id'] || '';
    const sessionHeaders = {
        ...sharedHeaders,
        ...(sessionId ? { 'mcp-session-id': sessionId } : {})
    };
    await postJson(mcpUrl, { jsonrpc: '2.0', method: 'notifications/initialized' }, sessionHeaders);
    return {
        initialize,
        sessionId,
        call(id, method, params) {
            return postJson(mcpUrl, { jsonrpc: '2.0', id, method, ...(params ? { params } : {}) }, sessionHeaders);
        }
    };
}

/**
 * 确定性直连 probe：M2 门禁三项 + guidance 三面 revision 一致 + 缓存头。
 */
async function runDirectCapabilityProbes({
    mcpUrl,
    backendBaseUrl,
    boundToken,
    legacyKey,
    gatewayId,
    agentId,
    userName
}) {
    const issues = [];
    const check = (condition, label) => {
        if (!condition) {
            issues.push(label);
        }
    };

    // --- 绑定 credential：instructions 摘要 ---
    const bound = await createMcpSession(mcpUrl, boundToken, gatewayId);
    check(bound.initialize.status === 200, `bound initialize returned ${bound.initialize.status}`);
    const boundInstructions = String(bound.initialize.body?.result?.instructions || '');
    check(boundInstructions.includes(agentId), 'bound instructions do not mention the bound agent');
    check(boundInstructions.includes(`vcp://agent-gateway/agents/${agentId}/guidance`),
        'bound instructions do not include the guidance resource URI');
    check(/revision sha256:[0-9a-f]{64}/.test(boundInstructions),
        'bound instructions do not include the guidance revision');
    check(boundInstructions.includes(GUIDANCE_MARKER),
        'bound instructions do not include the workflow marker');

    // --- 未绑定（legacy key）：通用 instructions，不泄露 agent 内容 ---
    const unbound = await createMcpSession(mcpUrl, legacyKey, gatewayId);
    check(unbound.initialize.status === 200, `unbound initialize returned ${unbound.initialize.status}`);
    const unboundInstructions = String(unbound.initialize.body?.result?.instructions || '');
    check(unboundInstructions === GENERIC_INSTRUCTIONS,
        'unbound initialize did not return the canonical generic instructions');
    check(!unboundInstructions.includes(GUIDANCE_MARKER), 'unbound instructions leak guidance workflow content');
    check(!unboundInstructions.includes(SECRET_TAG), 'unbound instructions leak agent memoryDefaults tags');
    check(!unboundInstructions.includes(agentId), 'unbound instructions leak the agent id');

    // --- 绑定 session：tools / resources / bootstrap 三面一致 ---
    const toolsList = await bound.call('tools-1', 'tools/list');
    const toolNames = Array.isArray(toolsList.body?.result?.tools)
        ? toolsList.body.result.tools.map((tool) => tool.name)
        : [];
    check(toolNames.includes('gateway_agent_bootstrap'), 'tools/list does not expose gateway_agent_bootstrap');
    check(!toolNames.includes('gateway_agent_render'),
        'tools/list must not expose gateway_agent_render (publishedAsTool: false)');

    const resourcesList = await bound.call('res-1', 'resources/list');
    const resourceUris = Array.isArray(resourcesList.body?.result?.resources)
        ? resourcesList.body.result.resources.map((resource) => resource.uri)
        : [];
    const guidanceUri = `vcp://agent-gateway/agents/${agentId}/guidance`;
    check(resourceUris.includes(guidanceUri), 'resources/list does not publish the guidance resource');

    const resourceRead = await bound.call('res-2', 'resources/read', { uri: guidanceUri });
    let resourcePayload = null;
    try {
        resourcePayload = JSON.parse(resourceRead.body?.result?.contents?.[0]?.text || 'null');
    } catch (_error) {
        resourcePayload = null;
    }
    check(Boolean(resourcePayload?.revision), 'resources/read did not return a guidance bundle with revision');

    const bootstrap = await bound.call('boot-1', 'tools/call', {
        name: 'gateway_agent_bootstrap',
        arguments: { agentId, variables: { VarUserName: userName } }
    });
    const bootstrapResult = bootstrap.body?.result?.structuredContent?.result || null;
    const renderedPrompt = readRenderTextFromToolCall(bootstrap);
    check(Boolean(renderedPrompt) && renderedPrompt.includes(`Hello ${userName}`),
        'bootstrap did not return the expected rendered prompt');
    check(typeof bootstrapResult?.summary === 'string' && bootstrapResult.summary.length > 0,
        'bootstrap result is missing summary');
    check(Boolean(bootstrapResult?.integrationGuidance?.revision),
        'bootstrap result is missing integrationGuidance');
    check(resourcePayload && bootstrapResult
        && deepEquals(bootstrapResult.integrationGuidance, resourcePayload),
    'bootstrap integrationGuidance differs from the guidance resource payload');

    // --- REST binding：同一 revision + 缓存头 ---
    const restResponse = await fetch(`${backendBaseUrl}/agent_gateway/agents/${agentId}/guidance`, {
        headers: { 'x-agent-gateway-key': boundToken }
    });
    const rest = await readResponse(restResponse);
    check(rest.status === 200, `REST guidance returned ${rest.status}`);
    check(rest.body?.success === true, 'REST guidance envelope is not success');
    check(resourcePayload && rest.body?.data && deepEquals(rest.body.data, resourcePayload),
        'REST guidance bundle differs from the MCP resource payload');
    check((rest.headers['cache-control'] || '').includes('no-store'),
        'REST guidance is missing Cache-Control: no-store');
    check((rest.headers['cache-control'] || '').includes('private'),
        'REST guidance is missing Cache-Control: private');
    const varyHeader = String(rest.headers.vary || '');
    check(/authorization/i.test(varyHeader) && /x-agent-gateway-key/i.test(varyHeader),
        'REST guidance Vary header does not cover the identity channels');

    // --- 越界：绑定 credential 访问他人 guidance → 403 ---
    const crossResponse = await fetch(`${backendBaseUrl}/agent_gateway/agents/NotMyAgent/guidance`, {
        headers: { 'x-agent-gateway-key': boundToken }
    });
    check(crossResponse.status === 403, `cross-agent REST guidance returned ${crossResponse.status}, expected 403`);
    await crossResponse.text();

    // --- 越界：MCP resources/read 读他人 guidance → forbidden，不泄露内容 ---
    const crossResourceRead = await bound.call('res-3', 'resources/read', {
        uri: 'vcp://agent-gateway/agents/NotMyAgent/guidance'
    });
    const crossResourceError = crossResourceRead.body?.error
        || crossResourceRead.body?.result?.error
        || null;
    check(Boolean(crossResourceError), 'cross-agent MCP guidance resource read must fail');
    check(!JSON.stringify(crossResourceRead.body || {}).includes(GUIDANCE_MARKER),
        'cross-agent MCP guidance resource read leaks guidance content');

    return {
        ok: issues.length === 0,
        issues,
        revision: resourcePayload?.revision || '',
        boundInstructions,
        unboundInstructions,
        resourcePayload
    };
}

function runCommand(command, args, options = {}) {
    return new Promise((resolve, reject) => {
        const child = spawn(command, args, {
            cwd: options.cwd || process.cwd(),
            env: { ...process.env, ...(options.env || {}) },
            stdio: ['ignore', 'pipe', 'pipe']
        });
        let stdout = '';
        let stderr = '';
        let timedOut = false;
        let timer = null;
        if (options.timeoutMs) {
            timer = setTimeout(() => {
                timedOut = true;
                child.kill('SIGKILL');
            }, options.timeoutMs);
        }
        child.stdout.setEncoding('utf8');
        child.stderr.setEncoding('utf8');
        child.stdout.on('data', (chunk) => { stdout += chunk; });
        child.stderr.on('data', (chunk) => { stderr += chunk; });
        child.on('error', (error) => {
            if (timer) clearTimeout(timer);
            reject(error);
        });
        child.on('close', (code) => {
            if (timer) clearTimeout(timer);
            resolve({ code, stdout, stderr, timedOut });
        });
    });
}

async function resolveClientVersion(binary) {
    try {
        const result = await runCommand(binary, ['--version'], { timeoutMs: 20000 });
        return `${result.stdout || result.stderr}`.trim().split('\n')[0].slice(0, 80);
    } catch (_error) {
        return '';
    }
}

async function readIfExists(filePath) {
    try {
        return await fs.readFile(filePath, 'utf8');
    } catch (error) {
        if (error && error.code === 'ENOENT') {
            return '';
        }
        throw error;
    }
}

async function copyFileIfExists(sourcePath, targetPath) {
    try {
        await fs.copyFile(sourcePath, targetPath);
        return true;
    } catch (error) {
        if (error && error.code === 'ENOENT') {
            return false;
        }
        throw error;
    }
}

function createCodexMcpConfigToml({ serverName, mcpUrl, token, gatewayId }) {
    const escape = (value) => String(value).replaceAll('\\', '\\\\').replaceAll('"', '\\"');
    return [
        '# Auto-generated by scripts/run-agent-gateway-m2-smoke.js',
        `[mcp_servers.${serverName}]`,
        `url = "${escape(mcpUrl)}"`,
        `http_headers = { "x-agent-gateway-key" = "${escape(token)}", "x-agent-gateway-id" = "${escape(gatewayId)}" }`,
        'startup_timeout_sec = 20',
        'tool_timeout_sec = 120',
        'required = true',
        ''
    ].join('\n');
}

async function runCodexClient({ tempRoot, serverName, mcpUrl, token, gatewayId, prompt, timeoutMs }) {
    const codexBin = process.env.CODEX_BIN || 'codex';
    const codexHome = path.join(tempRoot, 'codex-home');
    await fs.mkdir(codexHome, { recursive: true });
    const existingHome = process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
    const existingConfig = stripInheritedMcpSections(await readIfExists(path.join(existingHome, 'config.toml')));
    await copyFileIfExists(path.join(existingHome, 'auth.json'), path.join(codexHome, 'auth.json'));
    await fs.writeFile(
        path.join(codexHome, 'config.toml'),
        composeCodexConfig(existingConfig, createCodexMcpConfigToml({ serverName, mcpUrl, token, gatewayId })),
        'utf8'
    );
    const lastMessagePath = path.join(tempRoot, 'codex-last-message.txt');
    const workDir = path.join(tempRoot, 'codex-workdir');
    await fs.mkdir(workDir, { recursive: true });
    const execArgs = [
        'exec', '--skip-git-repo-check', '--ephemeral',
        '--sandbox', 'read-only', '--color', 'never',
        // 非交互模式下 MCP tool call 需要显式免审批，否则被自动取消
        //（M0.S4 smoke 已知限制）。
        '-c', 'approval_policy="never"',
        '--cd', workDir,
        '--output-last-message', lastMessagePath
    ];
    if (process.env.CODEX_MODEL) {
        execArgs.push('--model', process.env.CODEX_MODEL);
    }
    execArgs.push(prompt);
    const result = await runCommand(codexBin, execArgs, {
        cwd: workDir,
        env: { CODEX_HOME: codexHome },
        timeoutMs
    });
    const lastMessage = (await readIfExists(lastMessagePath)).trim();
    return { result, outputText: `${lastMessage}\n${result.stdout}\n${result.stderr}` };
}

async function runClaudeClient({ tempRoot, serverName, mcpUrl, token, gatewayId, prompt, timeoutMs }) {
    const claudeBin = process.env.CLAUDE_BIN || 'claude';
    const workDir = path.join(tempRoot, 'claude-workdir');
    await fs.mkdir(workDir, { recursive: true });
    const mcpConfig = JSON.stringify({
        mcpServers: {
            [serverName]: {
                type: 'http',
                url: mcpUrl,
                headers: {
                    'x-agent-gateway-key': token,
                    'x-agent-gateway-id': gatewayId
                }
            }
        }
    });
    const result = await runCommand(claudeBin, [
        '-p', prompt,
        '--mcp-config', mcpConfig,
        '--strict-mcp-config',
        '--dangerously-skip-permissions',
        '--output-format', 'text'
    ], { cwd: workDir, timeoutMs });
    return { result, outputText: `${result.stdout}\n${result.stderr}` };
}

async function runKimiClient({ tempRoot, serverName, mcpUrl, token, gatewayId, prompt, timeoutMs }) {
    const kimiBin = process.env.KIMI_BIN || 'kimi';
    const workDir = path.join(tempRoot, 'kimi-workdir');
    await fs.mkdir(path.join(workDir, '.kimi-code'), { recursive: true });
    await fs.writeFile(
        path.join(workDir, '.kimi-code', 'mcp.json'),
        JSON.stringify({
            mcpServers: {
                [serverName]: {
                    url: mcpUrl,
                    headers: {
                        'x-agent-gateway-key': token,
                        'x-agent-gateway-id': gatewayId
                    }
                }
            }
        }, null, 2),
        'utf8'
    );
    // kimi 0.27：`-p` 不能与 `-y`/`--auto` 组合；prompt 模式默认非交互。
    const result = await runCommand(kimiBin, [
        '-p', prompt,
        '--output-format', 'text'
    ], { cwd: workDir, timeoutMs });
    return { result, outputText: `${result.stdout}\n${result.stderr}` };
}

const CLIENT_RUNNERS = {
    codex: runCodexClient,
    claude: runClaudeClient,
    kimi: runKimiClient
};

const CLIENT_BINARIES = {
    codex: () => process.env.CODEX_BIN || 'codex',
    claude: () => process.env.CLAUDE_BIN || 'claude',
    kimi: () => process.env.KIMI_BIN || 'kimi'
};

async function createTempAgentDir(baseDir) {
    const targetPath = path.join(baseDir, 'agent-fixture');
    await fs.mkdir(targetPath, { recursive: true });
    return targetPath;
}

async function writeAgentFile(baseDir, relativePath, content) {
    const absolutePath = path.join(baseDir, relativePath);
    await fs.mkdir(path.dirname(absolutePath), { recursive: true });
    await fs.writeFile(absolutePath, content, 'utf8');
}

function createAgentManager(agentDir, mappings) {
    const agentMap = new Map(Object.entries(mappings));
    return {
        agentDir,
        agentMap,
        isAgent(alias) {
            return agentMap.has(alias);
        },
        async getAgentPrompt(alias) {
            return fs.readFile(path.join(agentDir, agentMap.get(alias)), 'utf8');
        },
        async getAllAgentFiles() {
            return { files: Array.from(agentMap.values()), folderStructure: {} };
        }
    };
}

function createSmokePluginManager(agentDir, { agentId, gatewayKey, gatewayId }) {
    return createPluginManager({
        agentManager: createAgentManager(agentDir, { [agentId]: `${agentId}.md` }),
        agentGatewayProtocolConfig: { gatewayKey, gatewayId },
        agentRegistryRenderPrompt: async ({ rawPrompt, renderVariables }) =>
            rawPrompt.replaceAll('{{VarUserName}}', renderVariables?.VarUserName || 'Anon')
    });
}

async function startServer(app) {
    const http = require('node:http');
    const server = http.createServer(app);
    await new Promise((resolve) => {
        server.listen(0, '127.0.0.1', resolve);
    });
    return server;
}

async function startNativeBackend(pluginManager) {
    const app = express();
    app.use(express.json());
    app.use('/agent_gateway', createAgentGatewayRoutes(pluginManager));
    const server = await startServer(app);
    return {
        baseUrl: `http://127.0.0.1:${server.address().port}`,
        async close() {
            await new Promise((resolve, reject) => {
                server.close((error) => (error ? reject(error) : resolve()));
            });
        }
    };
}

/**
 * MCP gateway + JSON-RPC 方法观测：客户端消费证据来自这份 rpcLog。
 * 先挂 express.raw（设置 req._body），后续 transport 自带的 rawBodyParser
 * 会跳过重复解析，Buffer 原样送达。
 */
async function startMcpGateway({ pluginManager, backendUrl, credentialService }) {
    const app = express();
    const rpcLog = [];
    app.use('/mcp', express.raw({ type: '*/*', limit: 4 * 1024 * 1024 }), (req, _res, next) => {
        if (req.method === 'POST' && Buffer.isBuffer(req.body)) {
            try {
                const parsed = JSON.parse(req.body.toString('utf8'));
                const entries = Array.isArray(parsed) ? parsed : [parsed];
                for (const entry of entries) {
                    if (entry && typeof entry.method === 'string') {
                        rpcLog.push({
                            method: entry.method,
                            toolName: entry.method === 'tools/call' ? entry.params?.name || '' : '',
                            sessionId: String(req.headers['mcp-session-id'] || '')
                        });
                    }
                }
            } catch (_error) {
                // 非 JSON payload 由 transport 自己拒绝
            }
        }
        next();
    });
    const manager = createMcpHttpServer({
        pluginManager,
        backendUrl,
        credentialService,
        stderr: process.stderr
    });
    manager.attach(app);
    const server = await startServer(app);
    return {
        rpcLog,
        mcpUrl: `http://127.0.0.1:${server.address().port}/mcp`,
        async close() {
            await manager.close();
            await new Promise((resolve, reject) => {
                server.close((error) => (error ? reject(error) : resolve()));
            });
        }
    };
}

async function setupIdentityFixture(tempRoot, agentId) {
    const identityDir = path.join(tempRoot, 'identity');
    await fs.mkdir(identityDir, { recursive: true });
    const pepper = crypto.randomBytes(32);
    const boundToken = `m2-smoke-${crypto.randomBytes(24).toString('hex')}`;
    const credentialsPath = path.join(identityDir, 'credentials.json');
    const peppersPath = path.join(identityDir, 'peppers.json');
    await fs.writeFile(credentialsPath, JSON.stringify({
        version: 1,
        credentials: [{
            credentialId: 'cred-m2-smoke',
            pepperKid: 'kid-m2',
            tokenDigest: `hmac-sha256:${computeTokenDigest(pepper, boundToken)}`,
            boundAgentId: agentId,
            scopes: ['gateway:read', 'gateway:execute'],
            status: 'active',
            expiresAt: null
        }]
    }, null, 2), 'utf8');
    await fs.writeFile(peppersPath, JSON.stringify({
        keys: { 'kid-m2': pepper.toString('base64') }
    }, null, 2), 'utf8');
    return { credentialsPath, peppersPath, boundToken };
}

async function removeDirectoryIfNeeded(directoryPath) {
    if (!directoryPath) {
        return;
    }
    await fs.rm(directoryPath, { recursive: true, force: true });
}

async function main(argv = process.argv.slice(2)) {
    const options = parseArgs(argv);
    if (options.help) {
        printUsage();
        return 0;
    }

    const tempBaseDir = path.join(process.cwd(), '.tmp');
    await fs.mkdir(tempBaseDir, { recursive: true });
    const tempRoot = await fs.mkdtemp(path.join(tempBaseDir, 'agw-m2-smoke-'));
    const savedEnv = {
        AGENT_GATEWAY_GUIDANCE_CONFIG_PATH: process.env.AGENT_GATEWAY_GUIDANCE_CONFIG_PATH,
        AGENT_GATEWAY_CREDENTIALS_PATH: process.env.AGENT_GATEWAY_CREDENTIALS_PATH,
        AGENT_GATEWAY_CREDENTIAL_PEPPERS_PATH: process.env.AGENT_GATEWAY_CREDENTIAL_PEPPERS_PATH
    };
    let nativeBackend = null;
    let mcpGateway = null;

    try {
        // 1. Fixture：agent 文件、guidance 配置、credential/pepper 文件
        const agentDir = await createTempAgentDir(tempRoot);
        await writeAgentFile(agentDir, `${DEFAULT_AGENT_ID}.md`,
            `You are ${DEFAULT_AGENT_ID}. Hello {{VarUserName}}.`);
        const guidancePath = path.join(tempRoot, 'agent_guidance.json');
        await fs.writeFile(guidancePath, JSON.stringify(createGuidanceConfig(DEFAULT_AGENT_ID), null, 2), 'utf8');
        const identity = await setupIdentityFixture(tempRoot, DEFAULT_AGENT_ID);

        process.env.AGENT_GATEWAY_GUIDANCE_CONFIG_PATH = guidancePath;
        process.env.AGENT_GATEWAY_CREDENTIALS_PATH = identity.credentialsPath;
        process.env.AGENT_GATEWAY_CREDENTIAL_PEPPERS_PATH = identity.peppersPath;

        // 2. Native backend + MCP HTTP gateway（credentialService 接线绑定 credential）
        const backendPluginManager = createSmokePluginManager(agentDir, {
            agentId: DEFAULT_AGENT_ID,
            gatewayKey: DEFAULT_GATEWAY_KEY,
            gatewayId: DEFAULT_GATEWAY_ID
        });
        nativeBackend = await startNativeBackend(backendPluginManager);

        const proxyPluginManager = createSmokePluginManager(agentDir, {
            agentId: DEFAULT_AGENT_ID,
            gatewayKey: DEFAULT_GATEWAY_KEY,
            gatewayId: DEFAULT_GATEWAY_ID
        });
        const credentialService = getGatewayServiceBundle(proxyPluginManager).gatewayCredentialService;
        mcpGateway = await startMcpGateway({
            pluginManager: proxyPluginManager,
            backendUrl: nativeBackend.baseUrl,
            credentialService
        });

        // 3. 直连 capability probe（M2 门禁证据）
        const directProbe = await runDirectCapabilityProbes({
            mcpUrl: mcpGateway.mcpUrl,
            backendBaseUrl: nativeBackend.baseUrl,
            boundToken: identity.boundToken,
            legacyKey: DEFAULT_GATEWAY_KEY,
            gatewayId: DEFAULT_GATEWAY_ID,
            agentId: DEFAULT_AGENT_ID,
            userName: DEFAULT_USER_NAME
        });
        if (!directProbe.ok) {
            throw new Error([
                'M2 direct capability probes FAILED:',
                ...directProbe.issues.map((issue) => `- ${issue}`),
                `tempRoot=${tempRoot}`
            ].join('\n'));
        }
        process.stdout.write([
            '[M2 smoke] direct capability probes PASS',
            `guidance revision: ${directProbe.revision}`,
            ''
        ].join('\n'));

        // 4. 真实客户端 capability 运行
        const clientResults = [];
        if (!options.skipClients) {
            const prompt = createCapabilityPrompt({
                serverName: DEFAULT_SERVER_NAME,
                agentId: DEFAULT_AGENT_ID,
                userName: DEFAULT_USER_NAME
            });
            for (const client of options.clients) {
                const version = await resolveClientVersion(CLIENT_BINARIES[client]());
                const rpcStart = mcpGateway.rpcLog.length;
                process.stdout.write(`[M2 smoke] running client: ${client} (${version || 'version unknown'})\n`);
                let runResult = null;
                let note = '';
                try {
                    runResult = await CLIENT_RUNNERS[client]({
                        tempRoot,
                        serverName: DEFAULT_SERVER_NAME,
                        mcpUrl: mcpGateway.mcpUrl,
                        token: identity.boundToken,
                        gatewayId: DEFAULT_GATEWAY_ID,
                        prompt,
                        timeoutMs: options.clientTimeoutMs
                    });
                    if (runResult.result.timedOut) {
                        note = `timed out after ${options.clientTimeoutMs}ms`;
                    } else if (runResult.result.code !== 0) {
                        note = `exit code ${runResult.result.code}`;
                    }
                } catch (error) {
                    note = `spawn failed: ${error.message}`;
                }
                const slice = mcpGateway.rpcLog.slice(rpcStart);
                clientResults.push({
                    client,
                    version,
                    markers: parseCapabilityMarkers(runResult?.outputText || ''),
                    rpcMethods: new Set(slice.map((entry) => entry.method)),
                    toolCallNames: slice.filter((entry) => entry.method === 'tools/call').map((entry) => entry.toolName),
                    note,
                    rawOutput: runResult?.outputText || ''
                });
            }
        }

        // 5. 结果汇总
        const matrix = clientResults.length > 0
            ? buildCapabilityMatrix(clientResults, directProbe.revision)
            : '(clients skipped)';
        process.stdout.write(`\n[M2 smoke] §5.3 capability matrix (revision ${directProbe.revision}):\n${matrix}\n\n`);
        for (const result of clientResults) {
            process.stdout.write([
                `--- ${result.client} raw markers ---`,
                `rpc methods observed: ${Array.from(result.rpcMethods).join(', ') || '(none)'}`,
                `tools called: ${result.toolCallNames.join(', ') || '(none)'}`,
                `note: ${result.note || '(none)'}`,
                result.rawOutput.trim().split('\n').filter((line) => /^(TOOLS::|BOOTSTRAP|RESOURCE|INSTRUCTIONS)/.test(line.trim())).join('\n') || '(no markers in output)',
                ''
            ].join('\n'));
        }

        const failedClients = clientResults.filter((result) => !result.rpcMethods.has('initialize'));
        if (failedClients.length > 0) {
            throw new Error([
                'M2 smoke: the following clients never reached MCP initialize:',
                ...failedClients.map((result) => `- ${result.client}: ${result.note || 'no traffic observed'}`),
                `tempRoot=${tempRoot}`
            ].join('\n'));
        }

        process.stdout.write('[M2 smoke] PASS\n');
        if (!options.keepTemp) {
            await removeDirectoryIfNeeded(tempRoot);
        } else {
            process.stdout.write(`[M2 smoke] kept temp files at ${tempRoot}\n`);
        }
        return 0;
    } catch (error) {
        process.stderr.write(`${error.message || String(error)}\n`);
        process.stderr.write(`[M2 smoke] temp files kept for inspection: ${tempRoot}\n`);
        return 1;
    } finally {
        for (const [key, value] of Object.entries(savedEnv)) {
            if (value === undefined) {
                delete process.env[key];
            } else {
                process.env[key] = value;
            }
        }
        if (mcpGateway) {
            await mcpGateway.close().catch(() => {});
        }
        if (nativeBackend) {
            await nativeBackend.close().catch(() => {});
        }
    }
}

if (require.main === module) {
    main().then((exitCode) => {
        process.exit(exitCode);
    }).catch((error) => {
        process.stderr.write(`${error.message || String(error)}\n`);
        process.exit(1);
    });
}

module.exports = {
    buildCapabilityMatrix,
    createCapabilityPrompt,
    createCodexMcpConfigToml,
    createGuidanceConfig,
    parseArgs,
    parseCapabilityMarkers,
    runDirectCapabilityProbes,
    setupIdentityFixture,
    startMcpGateway,
    startNativeBackend,
    main
};
