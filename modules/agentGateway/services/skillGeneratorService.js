const crypto = require('crypto');

const { normalizeString } = require('../policy/shared/normalize');

/**
 * L3 skill generator（§6 / M4.S1）。
 *
 * 三种 format（claude / codex / kimi）各自固定模板、manifest 与文件清单；
 * 模板变量全部来自 guidance bundle 与受信任部署配置。生成物零 secret：
 * 只含 endpoint、工具说明与「从客户端安全 secret store 读取 credential」
 * 的指引——绝不包含 API key、gateway key、token、`.env` 内容或下载签名。
 * `format` 走 allowlist；文件名与 archive path 不接受用户输入。
 */

const SKILL_FORMATS = Object.freeze(['claude', 'codex', 'kimi']);

const PUBLIC_BASE_URL_ENV = 'AGENT_GATEWAY_PUBLIC_BASE_URL';

/**
 * §6：对外 base URL 只能读取 AGENT_GATEWAY_PUBLIC_BASE_URL，不从请求 host
 * 推导。必须是绝对 URL，无 userinfo/query/fragment；生产只允许 HTTPS，
 * loopback 开发环境可显式 HTTP。
 */
function validatePublicBaseUrl(rawValue, { allowInsecure = false } = {}) {
    const value = normalizeString(rawValue);
    if (!value) {
        return { ok: false, reason: `${PUBLIC_BASE_URL_ENV} is not configured` };
    }
    let parsed;
    try {
        parsed = new URL(value);
    } catch (_error) {
        return { ok: false, reason: `${PUBLIC_BASE_URL_ENV} is not an absolute URL` };
    }
    if (parsed.username || parsed.password) {
        return { ok: false, reason: `${PUBLIC_BASE_URL_ENV} must not contain userinfo` };
    }
    if (parsed.search || parsed.hash) {
        return { ok: false, reason: `${PUBLIC_BASE_URL_ENV} must not contain query or fragment` };
    }
    const isLoopback = ['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname)
        || parsed.hostname === '::1';
    if (parsed.protocol === 'http:' && !isLoopback && !allowInsecure) {
        return { ok: false, reason: `${PUBLIC_BASE_URL_ENV} must use HTTPS outside loopback` };
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        return { ok: false, reason: `${PUBLIC_BASE_URL_ENV} must be http(s)` };
    }
    // 去掉尾斜杠，模板内统一拼接
    const baseUrl = `${parsed.origin}${parsed.pathname.replace(/\/+$/, '')}`;
    return { ok: true, baseUrl };
}

function sha256Hex(value) {
    return crypto.createHash('sha256').update(value, 'utf8').digest('hex');
}

function renderToolCheatsheet() {
    return [
        '## Gateway tools',
        '',
        '- `gateway_recall_run` — run the agent\'s preconfigured recall profile. Use FIRST when the task depends on prior decisions, known bugs, or user preferences.',
        '- `gateway_memory_search` — targeted search in a known diary or for a narrow historical question.',
        '- `gateway_context_assemble` — assemble a token-budgeted recall context block.',
        '- `gateway_memory_write` — persist durable conclusions; skip secrets and unconfirmed speculation.',
        '- `gateway_agent_bootstrap` — tool-only fallback returning the rendered prompt and `integrationGuidance`.',
        '- `gateway_job_get` / `gateway_job_cancel` — poll or cancel deferred jobs by `jobId`.'
    ].join('\n');
}

function renderGuidanceSection(guidance) {
    const lines = ['## Agent guidance', ''];
    const workflow = Array.isArray(guidance.workflow) ? guidance.workflow : [];
    if (workflow.length > 0) {
        lines.push('Workflow:');
        for (const step of workflow) {
            lines.push(`- ${step}`);
        }
        lines.push('');
    }
    const writePolicy = guidance.memoryWritePolicy || {};
    if (Array.isArray(writePolicy.write) && writePolicy.write.length > 0) {
        lines.push(`Write to memory: ${writePolicy.write.join('; ')}.`);
    }
    if (Array.isArray(writePolicy.skip) && writePolicy.skip.length > 0) {
        lines.push(`Do not write: ${writePolicy.skip.join('; ')}.`);
    }
    if (Array.isArray(guidance.defaultDiaries) && guidance.defaultDiaries.length > 0) {
        lines.push(`Default diaries: ${guidance.defaultDiaries.join(', ')}.`);
    }
    if (Array.isArray(guidance.allowedDiaries) && guidance.allowedDiaries.length > 0) {
        lines.push(`Allowed diaries: ${guidance.allowedDiaries.join(', ')}.`);
    }
    return lines.join('\n');
}

const SECRET_STORE_GUIDANCE = [
    '## Credential (never inline)',
    '',
    'The gateway credential is a bearer secret. Never write it into this skill,',
    'a repo file, or shell history. Load it from your client\'s secret store and',
    'reference it via environment variable (e.g. `AGENT_GATEWAY_TOKEN`).',
    'Ask your gateway operator for an agent-bound credential.'
].join('\n');

function renderClaudeSkill({ guidance, baseUrl }) {
    const skillMd = [
        '---',
        `name: vcp-agent-gateway-${guidance.agentId.toLowerCase()}`,
        `description: Use the VCP Agent Gateway MCP server as ${guidance.displayName}'s durable recall and memory layer. Use when the task depends on prior decisions, project history, or durable memory writes through gateway_recall_run, gateway_memory_search, and gateway_memory_write.`,
        '---',
        '',
        `# VCP Agent Gateway — ${guidance.displayName}`,
        '',
        `Agent id: \`${guidance.agentId}\` (bound credentials may omit \`agentId\` in tool calls).`,
        `Gateway endpoint: \`${baseUrl}/mcp\` (Streamable HTTP MCP).`,
        '',
        renderGuidanceSection(guidance),
        '',
        renderToolCheatsheet(),
        '',
        SECRET_STORE_GUIDANCE,
        '',
        '## MCP registration',
        '',
        'Add to your `.mcp.json` (or `claude mcp add --transport http`):',
        '',
        '```json',
        JSON.stringify({
            mcpServers: {
                'vcp-agent-gateway': {
                    type: 'http',
                    url: `${baseUrl}/mcp`,
                    headers: { Authorization: 'Bearer ${AGENT_GATEWAY_TOKEN}' }
                }
            }
        }, null, 2),
        '```',
        '',
        '`${AGENT_GATEWAY_TOKEN}` is expanded by Claude Code from your environment;',
        'the raw token never lives in this file.'
    ].join('\n');
    return [
        { path: 'SKILL.md', content: skillMd }
    ];
}

function renderCodexSkill({ guidance, baseUrl }) {
    const agentsMd = [
        `# VCP Agent Gateway — ${guidance.displayName}`,
        '',
        `Agent id: \`${guidance.agentId}\`. Gateway MCP endpoint: \`${baseUrl}/mcp\`.`,
        '',
        renderGuidanceSection(guidance),
        '',
        renderToolCheatsheet(),
        '',
        SECRET_STORE_GUIDANCE,
        '',
        '## MCP registration (config.toml)',
        '',
        '```toml',
        '[mcp_servers.vcp-agent-gateway]',
        `url = "${baseUrl}/mcp"`,
        'http_headers = { "Authorization" = "Bearer ${AGENT_GATEWAY_TOKEN}" }',
        '```',
        '',
        'Codex expands `${AGENT_GATEWAY_TOKEN}` from the launching shell environment.',
        'Do not paste the raw token into config.toml.'
    ].join('\n');
    return [
        { path: 'AGENTS.md', content: agentsMd }
    ];
}

function renderKimiSkill({ guidance, baseUrl }) {
    const skillMd = [
        `# VCP Agent Gateway — ${guidance.displayName}`,
        '',
        `Agent id: \`${guidance.agentId}\`. Gateway MCP endpoint: \`${baseUrl}/mcp\`.`,
        '',
        'Kimi consumes MCP tools only: instructions and resources are not surfaced.',
        'Call `gateway_agent_bootstrap` once per session to fetch the rendered prompt',
        'and `integrationGuidance` payload as text.',
        '',
        renderGuidanceSection(guidance),
        '',
        renderToolCheatsheet(),
        '',
        SECRET_STORE_GUIDANCE,
        '',
        '## MCP registration (.kimi-code/mcp.json)',
        '',
        '```json',
        JSON.stringify({
            mcpServers: {
                'vcp-agent-gateway': {
                    url: `${baseUrl}/mcp`,
                    bearerTokenEnvVar: 'AGENT_GATEWAY_TOKEN'
                }
            }
        }, null, 2),
        '```',
        '',
        '`bearerTokenEnvVar` makes Kimi read the token from the environment;',
        'the raw token never lives in mcp.json.'
    ].join('\n');
    return [
        { path: 'SKILL.md', content: skillMd }
    ];
}

const FORMAT_RENDERERS = Object.freeze({
    claude: renderClaudeSkill,
    codex: renderCodexSkill,
    kimi: renderKimiSkill
});

// 禁止出现在生成物中的 secret 形态（防回归 secret scan 的单源模式表）。
const SECRET_SCAN_PATTERNS = Object.freeze([
    /AGENT_GATEWAY_KEY\s*=\s*\S/,
    /Bearer\s+(?!\$\{)[A-Za-z0-9._~+/=-]{16,}/,
    /x-agent-gateway-key"?\s*[:=]\s*"?(?!\$\{)[A-Za-z0-9._~+/=-]{8,}/i,
    /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
    /hmac-sha256:[0-9a-f]{16,}/i
]);

function scanForSecrets(files) {
    const findings = [];
    for (const file of files) {
        for (const pattern of SECRET_SCAN_PATTERNS) {
            if (pattern.test(file.content)) {
                findings.push({ path: file.path, pattern: String(pattern) });
            }
        }
    }
    return findings;
}

/**
 * 生成单个 agent 单个 format 的 skill artifact：固定文件清单 + manifest
 *（内容哈希）。纯函数；guidance 与 baseUrl 由调用方提供。
 */
function generateSkillArtifact({ guidance, format, baseUrl }) {
    const normalizedFormat = normalizeString(format);
    if (!SKILL_FORMATS.includes(normalizedFormat)) {
        return { ok: false, code: 'AGW_INVALID_REQUEST', httpStatus: 400, reason: `format must be one of: ${SKILL_FORMATS.join(', ')}` };
    }
    if (!guidance || typeof guidance !== 'object' || !guidance.agentId) {
        return { ok: false, code: 'AGW_INVALID_REQUEST', httpStatus: 400, reason: 'guidance bundle is required' };
    }
    const files = FORMAT_RENDERERS[normalizedFormat]({ guidance, baseUrl });
    const secretFindings = scanForSecrets(files);
    if (secretFindings.length > 0) {
        // 模板层防线：生成物含 secret 形态一律拒绝输出
        return { ok: false, code: 'AGW_INTERNAL_ERROR', httpStatus: 500, reason: 'generated skill failed secret scan', secretFindings };
    }
    const manifestFiles = files.map((file) => ({
        path: file.path,
        bytes: Buffer.byteLength(file.content, 'utf8'),
        sha256: sha256Hex(file.content)
    }));
    const artifactId = `skill:${guidance.agentId}:${normalizedFormat}:${guidance.revision}`;
    const manifest = {
        artifactId,
        agentId: guidance.agentId,
        format: normalizedFormat,
        guidanceRevision: guidance.revision,
        generatedWith: 'agent-gateway-skill-generator/1',
        files: manifestFiles,
        contentHash: `sha256:${sha256Hex(JSON.stringify(manifestFiles))}`
    };
    return {
        ok: true,
        artifactId,
        manifest,
        files: [
            ...files,
            { path: 'manifest.json', content: `${JSON.stringify(manifest, null, 2)}\n` }
        ]
    };
}

/**
 * integration endpoint 的汇总 payload（不含文件内容）：可用 format、
 * 端点与 revision——供客户端选择 format 后再取 skill。
 */
function buildIntegrationSummary({ guidance, baseUrl }) {
    return {
        agentId: guidance.agentId,
        displayName: guidance.displayName,
        guidanceRevision: guidance.revision,
        mcpEndpoint: `${baseUrl}/mcp`,
        formats: SKILL_FORMATS.map((format) => ({
            format,
            skillPath: `/agent_gateway/agents/${encodeURIComponent(guidance.agentId)}/integration/skill?format=${format}`
        }))
    };
}

module.exports = {
    PUBLIC_BASE_URL_ENV,
    SECRET_SCAN_PATTERNS,
    SKILL_FORMATS,
    buildIntegrationSummary,
    generateSkillArtifact,
    scanForSecrets,
    validatePublicBaseUrl
};
