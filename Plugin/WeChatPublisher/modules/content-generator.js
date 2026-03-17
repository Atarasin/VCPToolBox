const fs = require('fs').promises;
const path = require('path');
const crypto = require('crypto');
const http = require('http');

/**
 * 估算文本字数（去除空白字符后）
 * @param {string} text - 待统计的文本
 * @returns {number} 字符数
 */
function estimateLength(text) {
    return String(text || '').replace(/\s+/g, '').length;
}

/**
 * 生成文章标题
 * @param {Object} repo - 仓库信息
 * @returns {string} 标题字符串
 */
function buildTitle(repo) {
    return `${repo.name}：值得关注的 AI 开源项目`;
}

/**
 * 生成文章正文
 * 根据仓库的名称、描述、Stars、Forks 等信息，使用预设模板生成介绍文案
 * @param {Object} repo - 仓库信息
 * @returns {string} 完整的文章正文
 */
function buildBody(repo) {
    const paragraphA = `今天推荐一个在 GitHub 上热度持续上升的项目：${repo.full_name}。该项目目前累计 ${repo.stars} 个 Stars、${repo.forks} 个 Forks，最近仍保持活跃更新，说明社区关注度与维护状态都比较稳健。`;
    const paragraphB = `从定位上看，${repo.name} 聚焦于 ${repo.description || 'AI 相关能力建设'}，适合用于快速验证想法、构建原型，或直接集成到现有工作流中。对技术团队来说，它的价值不止在“能跑起来”，还在于可以作为可复用模块缩短开发周期。`;
    const paragraphC = `在应用场景上，${repo.name} 可以用于研发团队的效率增强、业务侧的智能化能力补齐，以及教学和研究中的案例复现。对于想快速构建 MVP 的团队，它通常能显著降低从“概念验证”到“可演示版本”的时间成本。`;
    const paragraphD = `建议从三个角度评估该项目：第一，功能边界是否与当前业务痛点匹配；第二，社区活跃度与版本节奏是否可持续；第三，二次开发成本是否可控。完成这三步后，再决定是直接接入、二次封装还是仅作为技术参考。`;
    const paragraphE = `如果你正在持续跟踪 AI 工具链和开源生态，${repo.name} 值得加入本周重点观察列表，优先阅读 README、Issue 区和近期提交记录，并结合实际业务目标制定试用计划。`;
    return [paragraphA, paragraphB, paragraphC, paragraphD, paragraphE].join('\n\n');
}

function buildAgentAssistantToolPayload({ agentName, prompt, temporaryContact = true }) {
    return `<<<[TOOL_REQUEST]>>>
maid:「始」VCP系统「末」,
tool_name:「始」AgentAssistant「末」,
agent_name:「始」${agentName}「末」,
prompt:「始」${prompt}「末」,
temporary_contact:「始」${temporaryContact ? 'true' : 'false'}「末」,
<<<[END_TOOL_REQUEST]>>>`;
}

function callHumanToolApi(toolPayload, timeoutMs = 65000) {
    const port = process.env.PORT || '6005';
    const apiKey = process.env.Key || process.env.KEY;
    if (!apiKey) {
        throw new Error('缺少 Key，无法调用 /v1/human/tool');
    }

    const options = {
        hostname: '127.0.0.1',
        port,
        path: '/v1/human/tool',
        method: 'POST',
        headers: {
            'Content-Type': 'text/plain;charset=UTF-8',
            Authorization: `Bearer ${apiKey}`,
            'Content-Length': Buffer.byteLength(toolPayload)
        },
        timeout: timeoutMs
    };

    return new Promise((resolve, reject) => {
        const req = http.request(options, res => {
            let data = '';
            res.on('data', chunk => {
                data += chunk;
            });
            res.on('end', () => {
                let body = data;
                try {
                    body = JSON.parse(data);
                } catch (error) {}
                resolve({
                    statusCode: res.statusCode,
                    body
                });
            });
        });

        req.on('timeout', () => {
            req.destroy(new Error(`请求超时（${timeoutMs}ms）`));
        });
        req.on('error', error => {
            reject(error);
        });

        req.write(toolPayload);
        req.end();
    });
}

function parseAgentTextFromResponse(apiResponse) {
    const body = apiResponse && apiResponse.body !== undefined ? apiResponse.body : apiResponse;
    if (typeof body === 'string') {
        try {
            const parsed = JSON.parse(body);
            return parseAgentTextFromResponse({ body: parsed });
        } catch (error) {
            return body;
        }
    }
    const text =
        body && body.result && Array.isArray(body.result.content) && body.result.content[0]
            ? body.result.content[0].text
            : '';
    return typeof text === 'string' ? text : '';
}

function buildAgentPrompt(repo, options = {}) {
    const templateIds = Array.isArray(repo.template_ids) ? repo.template_ids.join(', ') : '';
    const queryContext = Array.isArray(options.templateIds) ? options.templateIds.join(', ') : templateIds;
    return `你是微信公众号技术编辑。请根据给定仓库信息，生成一段可直接发布的“项目推荐前言”文案。

要求：
1. 中文输出，300-500字；
2. 信息准确，避免虚构仓库不存在的功能；
3. 结构自然，包含“项目价值 + 适用场景 + 建议行动”；
4. 语气专业、克制，不要营销夸张；
5. 必须附带 GitHub 链接与作者信息；
6. 输出必须是 JSON 对象，格式为 {"title":"...","body":"..."}，不得输出其它内容。

搜索角度（模板ID）：${queryContext || '未指定'}

仓库信息：
- 名称：${repo.full_name}
- 描述：${repo.description || '无'}
- Stars：${repo.stars}
- Forks：${repo.forks}
- 语言：${repo.language || '未知'}
- 作者：${repo.owner || '未知'}
- 链接：${repo.url}`;
}

function parseDraftFromAgentText(agentText, repo) {
    const fallback = {
        title: buildTitle(repo),
        body: buildBody(repo)
    };
    if (!agentText || typeof agentText !== 'string') {
        return fallback;
    }

    const compact = agentText.trim();
    const candidates = [compact];
    const fenced = compact.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
    if (fenced && fenced[1]) {
        candidates.push(fenced[1].trim());
    }
    const bracket = compact.match(/\{[\s\S]*\}/);
    if (bracket && bracket[0]) {
        candidates.push(bracket[0].trim());
    }

    for (const item of candidates) {
        try {
            const parsed = JSON.parse(item);
            const title =
                parsed && typeof parsed.title === 'string' && parsed.title.trim()
                    ? parsed.title.trim()
                    : fallback.title;
            const body =
                parsed && typeof parsed.body === 'string' && parsed.body.trim()
                    ? parsed.body.trim()
                    : fallback.body;
            return { title, body };
        } catch (error) {}
    }
    return fallback;
}

async function generateDraftByAgent(repo, options = {}) {
    const config = options.config || {};
    const agentName =
        options.agentName ||
        config.WECHAT_PUBLISHER_DRAFT_AGENT_NAME ||
        process.env.WECHAT_PUBLISHER_DRAFT_AGENT_NAME ||
        '';
    if (!agentName) {
        const body = buildBody(repo);
        return {
            title: buildTitle(repo),
            body,
            generationSource: 'template',
            generationError: ''
        };
    }

    const timeoutMs = Number.parseInt(
        options.timeoutMs ||
            config.WECHAT_PUBLISHER_DRAFT_TIMEOUT_MS ||
            process.env.WECHAT_PUBLISHER_DRAFT_TIMEOUT_MS ||
            '65000',
        10
    );
    const maxRetry = Number.parseInt(
        options.maxRetry ||
            config.WECHAT_PUBLISHER_DRAFT_RETRY_TIMES ||
            process.env.WECHAT_PUBLISHER_DRAFT_RETRY_TIMES ||
            '3',
        10
    );
    const callApi = options.callHumanToolApi || callHumanToolApi;
    const prompt = buildAgentPrompt(repo, options);
    const toolPayload = buildAgentAssistantToolPayload({
        agentName,
        prompt,
        temporaryContact: true
    });
    const attempts = Number.isFinite(maxRetry) && maxRetry > 0 ? maxRetry : 3;

    let lastError = null;
    for (let i = 0; i < attempts; i += 1) {
        try {
            const apiResponse = await callApi(toolPayload, timeoutMs);
            if (!apiResponse || (apiResponse.statusCode && apiResponse.statusCode >= 400)) {
                throw new Error(`Agent 请求失败: ${apiResponse ? apiResponse.statusCode : '未知状态码'}`);
            }
            const text = parseAgentTextFromResponse(apiResponse);
            const parsed = parseDraftFromAgentText(text, repo);
            return {
                title: parsed.title,
                body: parsed.body,
                generationSource: 'agent',
                generationError: ''
            };
        } catch (error) {
            lastError = error;
        }
    }

    return {
        title: buildTitle(repo),
        body: buildBody(repo),
        generationSource: 'template_fallback',
        generationError: lastError ? lastError.message : '未知错误'
    };
}

/**
 * 构建单个草稿对象
 * @param {Object} repo - 仓库信息
 * @param {Date} [now=new Date()] - 当前时间
 * @returns {Object} 草稿对象，包含 ID、标题、正文、字数等
 */
function buildDraft(repo, now = new Date(), overrides = {}) {
    const title = overrides.title || buildTitle(repo);
    const body = overrides.body || buildBody(repo);
    return {
        draft_id: `draft_${now.getTime()}_${crypto.randomBytes(4).toString('hex')}`,
        created_at: now.toISOString(),
        source: repo,
        title,
        body,
        word_count: estimateLength(body),
        generation_source: overrides.generationSource || 'template',
        generation_error: overrides.generationError || '',
        references: [
            {
                type: 'github',
                name: repo.full_name,
                url: repo.url,
                owner: repo.owner
            }
        ]
    };
}

/**
 * 确保目录存在
 * @param {string} dirPath - 目录路径
 */
async function ensureDir(dirPath) {
    await fs.mkdir(dirPath, { recursive: true });
}

/**
 * 批量生成内容草稿
 * 步骤:
 * 1. 验证输入
 * 2. 准备输出目录
 * 3. 遍历 corpus 生成草稿
 * 4. 保存草稿快照
 * @param {Array} corpus - 仓库语料数组
 * @param {Object} options - 配置选项
 * @returns {Promise<Object>} 生成结果
 */
async function generateDrafts(corpus, options = {}) {
    if (!Array.isArray(corpus)) {
        throw new Error('阶段2输入必须是项目数组');
    }
    const now = options.now || new Date();
    const pluginRoot = options.pluginRoot || path.join(__dirname, '..');
    const outputDir = path.join(pluginRoot, 'data', 'output');
    await ensureDir(outputDir);

    const drafts = [];
    for (const repo of corpus) {
        const generated = await generateDraftByAgent(repo, options);
        drafts.push(
            buildDraft(repo, now, {
                title: generated.title,
                body: generated.body,
                generationSource: generated.generationSource,
                generationError: generated.generationError
            })
        );
    }
    const timestamp = now.toISOString().replace(/[:.]/g, '-');
    const filePath = path.join(outputDir, `stage2-drafts-${timestamp}.json`);
    await fs.writeFile(
        filePath,
        JSON.stringify(
            {
                generated_at: now.toISOString(),
                total: drafts.length,
                drafts
            },
            null,
            2
        ),
        'utf-8'
    );
    return {
        generatedAt: now.toISOString(),
        total: drafts.length,
        drafts,
        snapshotPath: filePath
    };
}

module.exports = {
    generateDrafts,
    buildDraft,
    estimateLength,
    buildAgentPrompt,
    parseDraftFromAgentText
};
