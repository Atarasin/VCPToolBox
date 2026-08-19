const crypto = require('crypto');

const { areDiaryNamesEquivalent } = require('../policy/mcpAgentMemoryPolicy');
const { normalizeString } = require('../policy/shared/normalize');

/**
 * L3 skill generator（§6 / M4.S1）。
 *
 * 固定文件清单三件，按读者分工：
 *   - `SKILL.md`     模型面：触发条件 + 标准动作与可原样照抄的调用体
 *   - `INSTALL.md`   人面：放置路径、MCP 注册片段、凭据来源
 *   - `manifest.json` 校验：per-file 哈希与 artifactId
 * 安装与注册说明刻意不进 `SKILL.md`——模型能读到该文件就说明早已装好并
 * 连上，此时那些内容零信息量，只会稀释指令。
 *
 * 模板变量全部来自 guidance bundle 与受信任部署配置。生成物零 secret：
 * 只含 endpoint、工具说明与「从客户端安全 secret store 读取 credential」
 * 的指引——绝不包含 API key、gateway key、token、`.env` 内容或下载签名。
 * `format` 走 allowlist；文件名与 archive path 不接受用户输入。三个 format
 * 产出同一份内容（差异只在安装位置，而那部分已下沉 INSTALL.md），format
 * 保留以兼容既有契约（artifactId/manifest 仍按 format 记录）。
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
    // §6：生产只允许 HTTPS；HTTP 仅限 loopback 与私网/CGNAT 地址（VPN/内网
    // 部署形态），且必须显式 allowInsecure。公网地址与无法判定的主机名
    // 一律拒绝 HTTP。
    const isPrivateAddress = isLoopback || isPrivateNetworkHostname(parsed.hostname);
    if (parsed.protocol === 'http:' && !(isPrivateAddress && allowInsecure)) {
        return {
            ok: false,
            reason: isPrivateAddress
                ? `${PUBLIC_BASE_URL_ENV} uses HTTP: loopback/private-network deployment requires explicit allowInsecure opt-in`
                : `${PUBLIC_BASE_URL_ENV} must use HTTPS outside loopback/private networks`
        };
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        return { ok: false, reason: `${PUBLIC_BASE_URL_ENV} must be http(s)` };
    }
    // 去掉尾斜杠，模板内统一拼接
    const baseUrl = `${parsed.origin}${parsed.pathname.replace(/\/+$/, '')}`;
    return { ok: true, baseUrl };
}

/**
 * RFC1918（10/8、172.16/12、192.168/16）、CGNAT（100.64/10）与 IPv6 ULA
 * （fc00::/7）视为私网。仅接受字面 IP——内网主机名无法离线判定，不豁免。
 */
function isPrivateNetworkHostname(hostname) {
    const ipv4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(hostname);
    if (ipv4) {
        const octets = ipv4.slice(1).map(Number);
        if (octets.some((value) => value > 255)) return false;
        const [a, b] = octets;
        return a === 10
            || (a === 172 && b >= 16 && b <= 31)
            || (a === 192 && b === 168)
            || (a === 100 && b >= 64 && b <= 127);
    }
    const ipv6 = hostname.startsWith('[') && hostname.endsWith(']')
        ? hostname.slice(1, -1).toLowerCase()
        : hostname.toLowerCase();
    return /^f[cd][0-9a-f]{2}:/.test(ipv6);
}

function sha256Hex(value) {
    return crypto.createHash('sha256').update(value, 'utf8').digest('hex');
}

function normalizeList(value) {
    return Array.isArray(value) ? value.filter((item) => normalizeString(item)) : [];
}

/**
 * skill 目录名：优先 `skill.name` 覆盖，否则从 agentId 派生。agentId 允许
 * 空格等字符，目录名不允许——统一压成 `[a-z0-9-]`。
 *
 * 命名约定（2026-08 起统一）：`vcp-<agent>`，`<agent>` 为 agentId 的 slug。
 * `skill.name` 覆盖同样受 `vcp-` 前缀约束（配置校验层强制），保证任何途径
 * 导出的 skill 目录名形态一致。
 */
const SKILL_NAME_PREFIX = 'vcp-';
// 目录名总长上限 64（与 skill.name 校验同限），预留前缀 4 字符
const SKILL_NAME_SLUG_MAX = 60;

function resolveSkillName(guidance) {
    const configured = normalizeString(guidance.skill?.name);
    if (configured) {
        return configured;
    }
    const slug = guidance.agentId.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '');
    const trimmed = (slug || 'agent').slice(0, SKILL_NAME_SLUG_MAX).replace(/-+$/g, '');
    return `${SKILL_NAME_PREFIX}${trimmed || 'agent'}`;
}

/**
 * frontmatter `description` 是宿主唯一常驻的触发面：宿主只凭这一句决定要不要
 * 加载本 skill。因此它必须写清「什么时候用」和「什么时候别用」，而不是复述
 * 这是个什么东西。素材来自 `skill` 配置块；未配置时按 displayName 与日记本
 * 路由派生一句仍然可判定的兜底。
 */
function buildSkillDescription(guidance) {
    const skill = guidance.skill || {};
    const displayName = guidance.displayName;
    const domain = normalizeString(skill.domain);
    const triggers = normalizeList(skill.triggers);
    const notFor = normalizeList(skill.notFor);
    const defaultDiary = normalizeList(guidance.defaultDiaries)[0]
        || normalizeList(guidance.allowedDiaries)[0];

    const subject = domain
        ? `${displayName}（VCP Agent Gateway agent ${guidance.agentId}）的${domain}人格与记忆层`
        : `${displayName}（VCP Agent Gateway agent ${guidance.agentId}）的人格与记忆层`;
    const mechanism = `先用 gateway_agent_bootstrap 取回${displayName}本人的角色设定与按当前问题检索到的语料，`
        + '再用 gateway_recall_run 召回历史结论，用 gateway_memory_write 存档新结论。';
    const trigger = triggers.length > 0
        ? `当${triggers.join('；')}时使用。`
        : `当任务依赖该 agent 的人格、历史决策、既往结论或用户偏好时使用${defaultDiary ? `，结论写回「${defaultDiary}」` : ''}。`;
    const exclusion = notFor.length > 0
        ? `不适用：${notFor.join('；')}。`
        : '不适用：与该 agent 的人格和记忆都无关的一次性任务。';

    return `${subject}：${mechanism}${trigger}${exclusion}`;
}

function renderBootstrapStep(guidance) {
    return [
        '### 第 1 步：取回人格与语料（回答前必做）',
        '',
        '```json',
        'gateway_agent_bootstrap { "query": "<用户当前问题原文>" }',
        '```',
        '',
        `- 返回的 \`renderedPrompt\` **就是你在本会话中的角色设定**：按它的口径、框架与边界行事。它与本文件冲突时以它为准（它是${guidance.displayName}的当前规范，本文件只是入口）。`,
        '- `query` 决定从冷知识库与日记本里检索哪些片段注入返回的提示词。**不传就检索不到相关语料**，等于拿到一份没有素材的空框架。',
        '- 新会话首次实质回答前调一次；**话题切换时重新调**（检索按问题重跑）。',
        '- 返回文本以 `GATEWAY NOTICE` 开头时表示本次渲染降级（通常是漏传 `query`）：按提示带上 `query` 立即重调一次，不要将就着用。',
        '- `gateway_agent_render` 是 MCP prompt 面，多数宿主只把它暴露成用户手打的斜杠命令，模型无法主动调用——不要尝试，用上面这个工具。'
    ].join('\n');
}

function renderRecallStep(guidance) {
    const defaultDiaries = normalizeList(guidance.defaultDiaries);
    const lines = [
        '### 第 2 步：召回历史结论',
        '',
        '```json',
        'gateway_recall_run { "query": "<用户当前问题原文>" }',
        '```',
        '',
        '- 走该 agent 预置的召回档案，不需要你知道结论存在哪个日记本。',
        '- 命中即视为既有结论：与你的即时判断冲突时以召回为准，并说明分歧。',
        '- **召回为空或失败不是错误**，继续回答即可，但要主动声明该结论缺少历史存档支撑。',
        '- 已经明确知道日记本或要找某个确切名称时，改用 `gateway_memory_search { "query": …, "diary": … }`。'
    ];
    if (defaultDiaries.length > 0) {
        lines.push(`- 该 agent 的默认召回落点：${defaultDiaries.join('、')}。`);
    }
    return lines.join('\n');
}

/**
 * 写回是最容易失败的一步：MCP inputSchema 把 `target`/`memory` 声明成自由
 * 对象，服务端却硬性要求 `target.diary`/`memory.text`/`memory.tags`，缺一
 * 即 400。所以这里直接渲染成可原样照抄的成品，而不是描述字段。
 */
function renderWriteStep(guidance) {
    const allowedDiaries = normalizeList(guidance.allowedDiaries);
    const defaultDiaries = normalizeList(guidance.defaultDiaries);
    const memoryDefaults = guidance.memoryDefaults || {};
    const defaultTags = normalizeList(memoryDefaults.tags);
    const exampleDiary = defaultDiaries[0] || allowedDiaries[0] || '<日记本名>';
    const exampleTags = defaultTags.length > 0 ? defaultTags : ['<至少一个标签>'];
    const memory = {
        text: '…一段自足的纯文本：结论 / 决策 / 根因，读者没有本次会话上下文也能看懂…',
        tags: exampleTags
    };
    if (memoryDefaults.metadata && typeof memoryDefaults.metadata === 'object') {
        memory.metadata = memoryDefaults.metadata;
    }
    const lines = [
        '### 第 3 步：写回结论',
        '',
        '```json',
        `gateway_memory_write ${JSON.stringify({ target: { diary: exampleDiary }, memory }, null, 2)}`,
        '```',
        '',
        '- `target.diary`、`memory.text`、`memory.tags` **三者缺一即 400**（`memory.tags` 最容易漏）。'
    ];
    if (defaultTags.length > 0) {
        lines.push(`- \`tags\` 缺省就用上面这组（${defaultTags.join('、')}），有更贴切的再追加。`);
    }
    const writePolicy = guidance.memoryWritePolicy || {};
    const write = normalizeList(writePolicy.write);
    const skip = normalizeList(writePolicy.skip);
    if (write.length > 0) {
        lines.push(`- 该写：${write.join('；')}。`);
    }
    if (skip.length > 0) {
        lines.push(`- 不该写：${skip.join('；')}。拿不准就不写。`);
    }
    return lines.join('\n');
}

/**
 * 日记本路由表。`skill.writeTargets` 里不在 `allowedDiaries` 内的条目直接
 * 丢弃——配置漂移不该产出一条注定 403 的指令。
 */
function renderDiaryRouting(guidance) {
    const allowedDiaries = normalizeList(guidance.allowedDiaries);
    if (allowedDiaries.length === 0) {
        return '';
    }
    const defaultDiaries = new Set(normalizeList(guidance.defaultDiaries));
    const writeTargets = Array.isArray(guidance.skill?.writeTargets) ? guidance.skill.writeTargets : [];
    const whenByDiary = new Map();
    for (const target of writeTargets) {
        const diary = normalizeString(target?.diary);
        const when = normalizeString(target?.when);
        if (!diary || !when) {
            continue;
        }
        // 用与写入授权同一条等价规则匹配（`付鹏日记本` ≡ `付鹏`）：配置里写全名、
        // bundle 里是策略解析后的规范名，按字面比对会把合法条目误丢。命中后按
        // bundle 的名字登记，与 AGW_FORBIDDEN 报错里列出的名字保持一致。
        const allowed = allowedDiaries.find((name) => areDiaryNamesEquivalent(name, diary));
        if (allowed) {
            whenByDiary.set(allowed, when);
        }
    }
    const lines = ['## 日记本路由', '', '| 日记本 | 默认 | 什么时候写 |', '| --- | --- | --- |'];
    for (const diary of allowedDiaries) {
        lines.push(`| ${diary} | ${defaultDiaries.has(diary) ? '✓' : ''} | ${whenByDiary.get(diary) || '—'} |`);
    }
    lines.push('');
    lines.push('写入表外的日记本会被拒（`AGW_FORBIDDEN`）；需要新增日记本请找网关运维方改策略，不要在调用里换名字重试。');
    return lines.join('\n');
}

function renderAgentWorkflow(guidance) {
    const workflow = normalizeList(guidance.workflow);
    if (workflow.length === 0) {
        return '';
    }
    const lines = [
        `## ${guidance.displayName}的专属工作流`,
        '',
        '与上面的标准动作叠加执行（同一件事说两遍不是冗余，是这个 agent 的具体口径）：',
        ''
    ];
    workflow.forEach((step, index) => {
        lines.push(`${index + 1}. ${step}`);
    });
    return lines.join('\n');
}

function renderToolCheatsheet() {
    return [
        '## 工具速查',
        '',
        '| 工具 | 什么时候用 | 必填 |',
        '| --- | --- | --- |',
        '| `gateway_agent_bootstrap` | 会话首次回答前、话题切换时取回人格与语料 | 建议传 `query` |',
        '| `gateway_recall_run` | 回答前召回历史结论，不必知道日记本 | `query` |',
        '| `gateway_memory_search` | 已知日记本或要找确切名称的窄问题 | `query` |',
        '| `gateway_context_assemble` | 起草长回答前要一整块预算内的上下文 | `query` 或 `recentMessages` |',
        '| `gateway_memory_write` | 会话收尾或得出确定结论时存档 | `target.diary` + `memory.text` + `memory.tags` |',
        '| `gateway_job_get` / `gateway_job_cancel` | 轮询或取消 deferred 任务 | `jobId` |'
    ].join('\n');
}

function renderFailureSemantics() {
    return [
        '## 出错了怎么办',
        '',
        '| 现象 | 含义 | 动作 |',
        '| --- | --- | --- |',
        '| 返回文本以 `GATEWAY NOTICE` 开头 | 本次渲染降级（多半漏传 `query`） | 带上 `query` 重调一次 |',
        '| `AGW_FORBIDDEN` | 传了不匹配的 `agentId`，或写了授权外的日记本 | 去掉 `agentId`；日记本换回路由表内的名字 |',
        '| HTTP 401 | 凭据失效或被吊销 | 停止重试，告知用户联系网关运维方 |',
        '| `AGW_CONFIG_UNAVAILABLE`（503） | 网关配置暂不可用 | 降级用本地上下文继续，并说明缺少网关支撑 |',
        '| 召回/检索返回空 | 合法状态，不是错误 | 继续回答，声明缺少历史存档支撑 |'
    ].join('\n');
}

function renderHardRules(guidance) {
    return [
        '## 红线',
        '',
        `- 不要跳过第 1 步就以${guidance.displayName}的身份回答——没取回人格时你只是个通用助手。`,
        '- 不要虚构召回内容，也不要虚构该 agent 的历史原话与既往判断；引用前先检索真实存档。',
        '- 不要把密钥、临时日志、git 可查的琐碎改动或未确认的推测写进记忆。',
        '- 不要为了绕过 `AGW_FORBIDDEN` 而改 `agentId` 或换日记本名重试。'
    ].join('\n');
}

function joinSections(sections) {
    return sections.filter((section) => normalizeString(section)).join('\n\n');
}

/**
 * SKILL.md：纯模型面。宿主先凭 frontmatter `description` 决定要不要加载，
 * 加载后读到的应当全部是「现在该做什么、参数长什么样」——安装与注册说明
 * 对此时的模型零信息量（能读到这个文件就说明早已装好连上），一律下沉到
 * INSTALL.md，不占正文。
 *
 * 三 format（claude / codex / kimi）产出同一份文件：guidance 内容与调用形状
 * 与客户端无关，差异只在安装位置，而那部分已经不在 SKILL.md 里。format
 * 参数保留以兼容既有契约（artifactId/manifest 仍按 format 记录）。
 */
function renderSkillMarkdown({ guidance, baseUrl }) {
    const skillName = resolveSkillName(guidance);
    const frontmatter = [
        '---',
        `name: ${skillName}`,
        `description: ${JSON.stringify(buildSkillDescription(guidance))}`,
        '---'
    ].join('\n');

    const identity = [
        `# ${guidance.displayName}｜VCP Agent Gateway`,
        '',
        `已连接的 MCP server \`vcp-agent-gateway\`（\`${baseUrl}/mcp\`）就是${guidance.displayName}，agent id \`${guidance.agentId}\`。`,
        '',
        `凭据已绑定该 agent：**所有 \`gateway_*\` 工具都不要传 \`agentId\`**。传了也必须与 \`${guidance.agentId}\` 逐字一致，否则 \`AGW_FORBIDDEN\`。`
    ].join('\n');

    const procedure = joinSections([
        '## 标准动作',
        renderBootstrapStep(guidance),
        renderRecallStep(guidance),
        renderWriteStep(guidance)
    ]);

    return joinSections([
        frontmatter,
        identity,
        procedure,
        renderAgentWorkflow(guidance),
        renderDiaryRouting(guidance),
        renderToolCheatsheet(),
        renderFailureSemantics(),
        renderHardRules(guidance)
    ]);
}

/**
 * INSTALL.md：纯人面。放置路径、注册片段、凭据来源——只有安装这份 skill
 * 的人需要，模型在运行时读它纯属噪声，因此与 SKILL.md 分离。
 * 同样零 secret：只出现环境变量引用形态。
 */
function renderInstallMarkdown({ guidance, baseUrl }) {
    const skillName = resolveSkillName(guidance);
    return [
        `# 安装：${guidance.displayName}（${guidance.agentId}）`,
        '',
        '给安装这份 skill 的人看；模型运行时只读 `SKILL.md`。',
        '',
        '## 1. 放置',
        '',
        `把 \`SKILL.md\` 放到 \`~/.agents/skills/${skillName}/SKILL.md\` —— Codex 与 Kimi 自动发现该目录。`,
        'Claude Code 读 `~/.claude/skills/`，链同一份即可：',
        '',
        '```bash',
        `ln -s ~/.agents/skills/${skillName} ~/.claude/skills/${skillName}`,
        '```',
        '',
        '项目级等价路径：`<project>/.agents/skills/…` 与 `<project>/.claude/skills/…`。',
        '',
        '## 2. 凭据（绝不内联）',
        '',
        '网关凭据是 bearer secret。不要写进这份 skill、仓库文件或 shell history——',
        '从客户端的 secret store 读取，并以环境变量 `AGENT_GATEWAY_TOKEN` 引用。',
        '向网关运维方申请**绑定该 agent** 的凭据（scope 取最小集 `gateway:read,gateway:execute`）。',
        '',
        '## 3. 注册 MCP server',
        '',
        '三种客户端选其一；token 一律从环境变量读，明文不进任何配置文件。',
        '',
        '### Claude Code（`.mcp.json` 或 `claude mcp add --transport http`）',
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
        '### Codex（`~/.codex/config.toml`）',
        '',
        '```toml',
        '[mcp_servers.vcp-agent-gateway]',
        `url = "${baseUrl}/mcp"`,
        'http_headers = { "Authorization" = "Bearer ${AGENT_GATEWAY_TOKEN}" }',
        '```',
        '',
        '### Kimi（`.kimi-code/mcp.json`）',
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
        '## 4. 验证',
        '',
        '```bash',
        `curl -s --noproxy '*' -H "Authorization: Bearer $AGENT_GATEWAY_TOKEN" \\`,
        '  -H "Content-Type: application/json" -H "Accept: application/json, text/event-stream" \\',
        `  -X POST "${baseUrl}/mcp" \\`,
        '  -d \'{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"smoke","version":"1.0"}}}\'',
        '```',
        '',
        `返回的 \`instructions\` 里应出现 \`${guidance.agentId}\`；出现的是通用文案说明凭据没有绑定该 agent。`,
        '',
        '## 出处',
        '',
        `- guidance revision：\`${guidance.revision}\``,
        `- 生成时间：\`${guidance.updatedAt}\``,
        '',
        '本文件与 `SKILL.md` 由网关按 guidance 渲染生成，不要手改——改配置后重新导出。'
    ].join('\n');
}

function renderUnifiedSkill({ guidance, baseUrl }) {
    return [
        { path: 'SKILL.md', content: renderSkillMarkdown({ guidance, baseUrl }) },
        { path: 'INSTALL.md', content: renderInstallMarkdown({ guidance, baseUrl }) }
    ];
}

const FORMAT_RENDERERS = Object.freeze({
    claude: renderUnifiedSkill,
    codex: renderUnifiedSkill,
    kimi: renderUnifiedSkill
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
    resolveSkillName,
    scanForSecrets,
    validatePublicBaseUrl
};
