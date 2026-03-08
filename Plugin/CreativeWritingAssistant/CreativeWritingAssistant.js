const http = require('http');
const path = require('path');
const fs = require('fs');
const dotenv = require('dotenv');

const COUNT_MODE_CN = 'cn_chars';
const COUNT_MODE_NON_WHITESPACE = 'non_whitespace_chars';
const LENGTH_POLICY_RANGE = 'range';
const LENGTH_POLICY_MIN_ONLY = 'min_only';
const COMMANDS = {
    COUNT_CHAPTER_LENGTH: 'CountChapterLength',
    REQUEST_EXTERNAL_REVIEW: 'RequestExternalReview',
    REQUEST_CHAPTER_DRAFT: 'RequestChapterDraft',
    EDIT_CHAPTER_CONTENT: 'EditChapterContent'
};
const FULL_CHAPTER_TEXT_REQUIRED_COMMANDS = new Set([
    COMMANDS.COUNT_CHAPTER_LENGTH,
    COMMANDS.REQUEST_EXTERNAL_REVIEW,
    COMMANDS.EDIT_CHAPTER_CONTENT
]);
const TRUTHY_VALUES = new Set(['true', '1', 'yes', 'y']);
const FALSY_VALUES = new Set(['false', '0', 'no', 'n']);
const HAN_CHAR_REGEX = /\p{Script=Han}/u;
const WHITESPACE_CHAR_REGEX = /\s/u;
const DEFAULT_EXTERNAL_REVIEW_AGENT = 'NovelStage4ExternalReviewAgent';
const DEFAULT_CHAPTER_DRAFT_AGENT = 'NovelStage4ChapterCreationAgent';
const DEFAULT_CHAPTER_EDIT_AGENT = 'NovelStage4ChapterRevisionAgent';
const DEFAULT_IDENTITY = '我是阶段4正文连载Agent';

function loadRootConfigEnv() {
    const projectBasePath = process.env.PROJECT_BASE_PATH;
    if (!projectBasePath) {
        return;
    }
    const rootEnvPath = path.join(projectBasePath, 'config.env');
    if (fs.existsSync(rootEnvPath)) {
        dotenv.config({ path: rootEnvPath });
    }
}

loadRootConfigEnv();

function normalizeCountMode(mode) {
    return mode === COUNT_MODE_NON_WHITESPACE ? COUNT_MODE_NON_WHITESPACE : COUNT_MODE_CN;
}

function normalizeLengthPolicy(policy) {
    return policy === LENGTH_POLICY_MIN_ONLY ? LENGTH_POLICY_MIN_ONLY : LENGTH_POLICY_RANGE;
}

function normalizeTargetInt(value, keyName) {
    if (value === undefined || value === null || value === '') {
        return undefined;
    }
    const parsed = Number.parseInt(value, 10);
    if (!Number.isFinite(parsed) || parsed < 0) {
        throw new Error(`${keyName} 必须是大于等于 0 的整数`);
    }
    return parsed;
}

function normalizeBoolean(value, defaultValue = false) {
    if (value === undefined || value === null || value === '') {
        return defaultValue;
    }
    if (typeof value === 'boolean') {
        return value;
    }
    const normalized = String(value).trim().toLowerCase();
    if (TRUTHY_VALUES.has(normalized)) {
        return true;
    }
    if (FALSY_VALUES.has(normalized)) {
        return false;
    }
    return defaultValue;
}

function normalizeTrimmedString(value) {
    if (value === undefined || value === null) {
        return '';
    }
    return String(value).trim();
}

function splitNonEmptyList(value) {
    return normalizeTrimmedString(value)
        .split(',')
        .map(item => item.trim())
        .filter(Boolean);
}

function parseRequest(inputData) {
    if (!normalizeTrimmedString(inputData)) {
        throw new Error('无输入数据');
    }
    let parsed;
    try {
        parsed = JSON.parse(inputData);
    } catch (error) {
        throw new Error('输入数据不是合法 JSON');
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error('输入必须是 JSON 对象');
    }
    return parsed;
}

function normalizeRatio(value, keyName, defaultValue = 0.35) {
    if (value === undefined || value === null || value === '') {
        return defaultValue;
    }
    const parsed = Number.parseFloat(value);
    if (!Number.isFinite(parsed) || parsed <= 0 || parsed > 1) {
        throw new Error(`${keyName} 必须是 0 到 1 之间的数字`);
    }
    return parsed;
}

function normalizeStringList(value, keyName) {
    if (value === undefined || value === null || value === '') {
        return [];
    }
    if (Array.isArray(value)) {
        return value
            .map(item => normalizeTrimmedString(item))
            .filter(Boolean);
    }
    if (typeof value === 'string') {
        return value
            .split(/\r?\n|,/)
            .map(item => item.trim())
            .filter(Boolean);
    }
    throw new Error(`${keyName} 必须是字符串或字符串数组`);
}

function normalizeIssueList(value, keyName) {
    if (value === undefined || value === null || value === '') {
        return [];
    }
    if (!Array.isArray(value)) {
        if (typeof value === 'string') {
            return value
                .split(/\r?\n/)
                .map(item => item.trim())
                .filter(Boolean);
        }
        throw new Error(`${keyName} 必须是字符串或数组`);
    }
    return value
        .map(item => {
            if (typeof item === 'string') {
                return item.trim();
            }
            if (item && typeof item === 'object') {
                return JSON.stringify(item);
            }
            return '';
        })
        .filter(Boolean);
}

function normalizeParagraphTargets(value, keyName) {
    if (value === undefined || value === null || value === '') {
        return [];
    }
    const rawList = Array.isArray(value)
        ? value
        : String(value)
            .split(',')
            .map(item => item.trim())
            .filter(Boolean);
    const parsed = rawList.map(item => Number.parseInt(item, 10));
    if (parsed.some(item => !Number.isFinite(item) || item <= 0)) {
        throw new Error(`${keyName} 必须是由正整数组成的列表`);
    }
    return [...new Set(parsed)].sort((a, b) => a - b);
}

function extractParagraphs(text) {
    return text
        .split(/\r?\n/)
        .map(line => line.trim())
        .filter(Boolean);
}

function countChineseChars(text) {
    let total = 0;
    for (const char of text) {
        if (HAN_CHAR_REGEX.test(char)) {
            total += 1;
        }
    }
    return total;
}

function countNonWhitespaceChars(text) {
    let total = 0;
    for (const char of text) {
        if (!WHITESPACE_CHAR_REGEX.test(char)) {
            total += 1;
        }
    }
    return total;
}

function analyzeTextMetrics(text) {
    const paragraphs = extractParagraphs(text);
    const chineseChars = countChineseChars(text);
    const nonWhitespaceChars = countNonWhitespaceChars(text);
    return {
        paragraphs,
        counts: {
            chineseChars,
            nonWhitespaceChars,
            rawChars: text.length,
            paragraphCount: paragraphs.length
        }
    };
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

function callHumanToolApi(toolPayload, timeoutMs = 60000) {
    const port = process.env.PORT || '8080';
    const apiKey = process.env.Key || process.env.KEY;
    if (!apiKey) {
        throw new Error('缺少 API Key（Key），无法调用 /v1/human/tool');
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
                let parsedResponse = data;
                try {
                    parsedResponse = JSON.parse(data);
                } catch (error) {}
                resolve({
                    statusCode: res.statusCode,
                    body: parsedResponse
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

function buildExternalReviewPrompt({ identity, reviewFocus, text }) {
    const focus = reviewFocus || '节奏、可读性、人设一致性、逻辑漏洞、局部限定内容越界风险、内容合规';
    return `${identity}。请对以下小说章节正文进行结构化审查，输出：
1）核心问题清单（按严重程度排序）；
2）节奏与可读性问题；
3）人设一致性与逻辑漏洞；
4）局部限定内容越界风险；
5）合规风险点；
6）可执行修订建议（高/中/低优先级）。
重点关注：${focus}

输出格式要求：
- 审查结论：通过/有条件通过/不通过
- 核心问题清单（按严重度排序）
- 节奏与可读性问题
- 人设一致性与逻辑漏洞
- 局部限定内容越界风险
- 合规风险点
- 修订建议（高/中/低优先级）
- 高优先级修订清单（修订动作/目标位置/验收标准）

【章节正文开始】
${text}
【章节正文结束】`;
}

function buildChapterDraftPrompt({ identity, draftingFocus, text, targetLength }) {
    const focus = draftingFocus || '锁死项一致性、大纲任务完成度、局部限定内容边界、叙事节奏与结尾钩子';
    const targetLengthLine = targetLength ? `目标字数区间：${targetLength}` : '目标字数区间：未指定（请按输入上下文合理控制）';
    return `${identity}。请根据以下创作上下文生成单章正文草稿，并附带创作自检单。

创作要求：
1）严格遵循锁死项与本章大纲，不得越界改写主线；
2）局部限定内容仅在指定边界内使用；
3）必须承接上一章结尾并在本章结尾设置可执行钩子；
4）若字数不足目标下限，继续扩写后再输出。

重点关注：${focus}
${targetLengthLine}

输出格式要求：
- 【本章正文草稿】
- 【创作自检单】（锁死项一致性/大纲完成度/局部边界/目标字数区间/正文字数统计/结尾钩子说明）

【创作上下文开始】
${text}
【创作上下文结束】`;
}

function renderPromptList(items, emptyText = '未提供') {
    if (!items.length) {
        return `- ${emptyText}`;
    }
    return items.map(item => `- ${item}`).join('\n');
}

function buildChapterEditPrompt({
    identity,
    text,
    editInstructions,
    editTargets,
    issues,
    mustKeep,
    outlineConstraints,
    styleConstraints,
    maxRewriteRatio
}) {
    const normalizedInstructions = normalizeTrimmedString(editInstructions) || '根据问题清单进行最小必要修订，保持原章节结构稳定。';
    return `${identity}。请对以下章节进行定向修订，仅修改必要内容，不重写整章。

修订原则：
1）优先修复质量问题（逻辑、人设、文风、一致性、越界风险）；
2）严格遵守锁死项、主线与本章大纲边界；
3）未命中的段落尽量保持不变；
4）最大改写比例不超过：${maxRewriteRatio}。

【修订指令】
${normalizedInstructions}

【修订目标段落】
${renderPromptList(editTargets.map(item => `第${item}段`))}

【问题清单】
${renderPromptList(issues)}

【必须保留约束】
${renderPromptList(mustKeep)}

【大纲边界约束】
${renderPromptList(outlineConstraints)}

【文风约束】
${renderPromptList(styleConstraints)}

输出格式要求：
- 【修订后章节正文】
- 【变更摘要】（逐项说明改动点与原因）
- 【变更段落索引】（仅列出改动段落编号）
- 【修订自检】（锁死项/大纲边界/人物一致性/文风一致性）

【原章节正文开始】
${text}
【原章节正文结束】`;
}

function resolveAgentName(request, { listEnvKey, defaultEnvKey, fallbackAgent }) {
    const configuredAgents = splitNonEmptyList(process.env[listEnvKey]);
    const configuredDefaultAgent = normalizeTrimmedString(process.env[defaultEnvKey]);
    const envFallbackAgent = configuredAgents[0] || configuredDefaultAgent || fallbackAgent;
    const requestedAgent = normalizeTrimmedString(request.agentName || request.agent_name);
    const finalAgentName = requestedAgent || envFallbackAgent;
    if (!finalAgentName) {
        throw new Error('agentName 不能为空');
    }
    return finalAgentName;
}

function isLikelyTitleOrSummaryText(text) {
    const compact = normalizeTrimmedString(text).replace(/\s+/g, '');
    if (!compact) {
        return false;
    }
    const isSingleLine = !/\r?\n/.test(text);
    if (!isSingleLine) {
        return false;
    }
    const pureBracketTitle = /^【[^】]{1,120}】(?:（\d{1,6}字）)?$/.test(compact);
    const chapterTitle = /^第.{1,30}[章节回][^。！？!?]*$/.test(compact);
    const revisionTitle = /^【[^】]*修订后章节正文[^】]*】(?:（\d{1,6}字）)?$/.test(compact);
    return pureBracketTitle || chapterTitle || revisionTitle;
}

function ensureText(request, command) {
    const text = typeof request.text === 'string' ? request.text : '';
    const trimmed = text.trim();
    if (!trimmed) {
        throw new Error('参数 text 不能为空');
    }
    if (FULL_CHAPTER_TEXT_REQUIRED_COMMANDS.has(command)) {
        const nonWhitespaceChars = countNonWhitespaceChars(trimmed);
        const hasNarrativePunctuation = /[。！？!?；;，,]/.test(trimmed);
        const isTooShortSingleLine = !/\r?\n/.test(trimmed) && nonWhitespaceChars < 80 && !hasNarrativePunctuation;
        if (isLikelyTitleOrSummaryText(trimmed) || isTooShortSingleLine) {
            throw new Error('参数 text 必须是完整章节正文全文，不能只传标题或摘要');
        }
    }
    return text;
}

async function runAgentRequest({
    request,
    text,
    command,
    defaultTimeoutMs,
    defaultAgent,
    listEnvKey,
    defaultEnvKey,
    focusFieldName,
    targetFieldName,
    buildPrompt,
    buildPromptInput,
    responseAgentField,
    callApi = callHumanToolApi
}) {
    const agentName = resolveAgentName(request, {
        listEnvKey,
        defaultEnvKey,
        fallbackAgent: defaultAgent
    });
    const identity = request.identity || DEFAULT_IDENTITY;
    const temporaryContact = normalizeBoolean(request.temporaryContact, true);
    const timeoutMs = normalizeTargetInt(request.timeoutMs, 'timeoutMs') ?? defaultTimeoutMs;
    const dryRun = normalizeBoolean(request.dryRun, false);
    const promptInput = buildPromptInput
        ? buildPromptInput({ request, text, identity })
        : {
            identity,
            [focusFieldName]: request[focusFieldName],
            text,
            [targetFieldName]: request[targetFieldName]
        };
    const prompt = buildPrompt(promptInput);
    const payload = buildAgentAssistantToolPayload({
        agentName,
        prompt,
        temporaryContact
    });

    if (dryRun) {
        return {
            status: 'success',
            result: {
                command,
                dryRun: true,
                request: {
                    agentName,
                    temporaryContact,
                    timeoutMs
                },
                payload
            }
        };
    }

    const apiResponse = await callApi(payload, timeoutMs);
    return {
        status: 'success',
        result: {
            command,
            [responseAgentField]: agentName,
            request: {
                temporaryContact,
                timeoutMs
            },
            apiResponse
        }
    };
}

async function handleChapterDraft(request, text, dependencies = {}) {
    return runAgentRequest({
        request,
        text,
        command: COMMANDS.REQUEST_CHAPTER_DRAFT,
        defaultTimeoutMs: 65000,
        defaultAgent: DEFAULT_CHAPTER_DRAFT_AGENT,
        listEnvKey: 'DRAFT_AGENT_LIST',
        defaultEnvKey: 'DEFAULT_DRAFT_AGENT',
        focusFieldName: 'draftingFocus',
        targetFieldName: 'targetLength',
        buildPrompt: buildChapterDraftPrompt,
        responseAgentField: 'draftAgent',
        callApi: dependencies.callHumanToolApi || callHumanToolApi
    });
}

async function handleExternalReview(request, text, dependencies = {}) {
    return runAgentRequest({
        request,
        text,
        command: COMMANDS.REQUEST_EXTERNAL_REVIEW,
        defaultTimeoutMs: 60000,
        defaultAgent: DEFAULT_EXTERNAL_REVIEW_AGENT,
        listEnvKey: 'REVIEW_AGENT_LIST',
        defaultEnvKey: 'DEFAULT_REVIEW_AGENT',
        focusFieldName: 'reviewFocus',
        targetFieldName: 'targetLength',
        buildPrompt: buildExternalReviewPrompt,
        responseAgentField: 'reviewAgent',
        callApi: dependencies.callHumanToolApi || callHumanToolApi
    });
}

function buildEditPromptInput({ request, text, identity }) {
    const editTargets = normalizeParagraphTargets(request.editTargets || request.targetParagraphs, 'editTargets');
    const issues = normalizeIssueList(request.issues, 'issues');
    const mustKeep = normalizeStringList(request.mustKeep, 'mustKeep');
    const outlineConstraints = normalizeStringList(request.outlineConstraints, 'outlineConstraints');
    const styleConstraints = normalizeStringList(request.styleConstraints, 'styleConstraints');
    const maxRewriteRatio = normalizeRatio(request.maxRewriteRatio, 'maxRewriteRatio', 0.35);
    return {
        identity,
        text,
        editInstructions: request.editInstructions,
        editTargets,
        issues,
        mustKeep,
        outlineConstraints,
        styleConstraints,
        maxRewriteRatio
    };
}

async function handleChapterEdit(request, text, dependencies = {}) {
    const editPromptInput = buildEditPromptInput({ request, text, identity: request.identity || DEFAULT_IDENTITY });
    const response = await runAgentRequest({
        request,
        text,
        command: COMMANDS.EDIT_CHAPTER_CONTENT,
        defaultTimeoutMs: 70000,
        defaultAgent: DEFAULT_CHAPTER_EDIT_AGENT,
        listEnvKey: 'EDIT_AGENT_LIST',
        defaultEnvKey: 'DEFAULT_EDIT_AGENT',
        buildPrompt: buildChapterEditPrompt,
        buildPromptInput: () => editPromptInput,
        responseAgentField: 'editAgent',
        callApi: dependencies.callHumanToolApi || callHumanToolApi
    });

    if (response?.status === 'success' && response.result?.request) {
        response.result.request.editTargets = editPromptInput.editTargets;
        response.result.request.issuesCount = editPromptInput.issues.length;
        response.result.request.maxRewriteRatio = editPromptInput.maxRewriteRatio;
    }
    return response;
}

function buildCountChapterLengthResult(text, request) {
    const countMode = normalizeCountMode(request.countMode);
    const lengthPolicy = normalizeLengthPolicy(request.lengthPolicy || request.validationPolicy);
    const targetMin = normalizeTargetInt(request.targetMin, 'targetMin');
    const targetMax = normalizeTargetInt(request.targetMax, 'targetMax');
    if (lengthPolicy === LENGTH_POLICY_RANGE && targetMin !== undefined && targetMax !== undefined && targetMin > targetMax) {
        throw new Error('targetMin 不能大于 targetMax');
    }

    const metrics = analyzeTextMetrics(text);
    const { chineseChars, nonWhitespaceChars, rawChars, paragraphCount } = metrics.counts;
    const actualCount = countMode === COUNT_MODE_CN ? chineseChars : nonWhitespaceChars;

    let rangeStatus = 'not_configured';
    let isQualified = null;
    let suggestion = '未配置目标字数区间，仅返回统计结果。';

    if (lengthPolicy === LENGTH_POLICY_MIN_ONLY) {
        if (targetMin !== undefined) {
            const min = targetMin;
            if (actualCount < min) {
                rangeStatus = 'below_min';
                isQualified = false;
                suggestion = `当前字数低于下限，建议至少补充 ${min - actualCount} 字。`;
            } else if (targetMax !== undefined && actualCount > targetMax) {
                rangeStatus = 'above_max_ignored';
                isQualified = true;
                suggestion = '当前字数高于参考上限，但按 min_only 策略不触发回炉。';
            } else {
                rangeStatus = 'within_range';
                isQualified = true;
                suggestion = '字数达到下限要求，可进入下一步质量校验。';
            }
        }
    } else if (targetMin !== undefined || targetMax !== undefined) {
        const min = targetMin ?? 0;
        const max = targetMax ?? Number.MAX_SAFE_INTEGER;
        if (actualCount < min) {
            rangeStatus = 'below_min';
            isQualified = false;
            suggestion = `当前字数低于下限，建议至少补充 ${min - actualCount} 字。`;
        } else if (actualCount > max) {
            rangeStatus = 'above_max';
            isQualified = false;
            suggestion = `当前字数高于上限，建议精简约 ${actualCount - max} 字。`;
        } else {
            rangeStatus = 'within_range';
            isQualified = true;
            suggestion = '字数已达标，可进入下一步质量校验。';
        }
    }

    return {
        status: 'success',
        result: {
            command: COMMANDS.COUNT_CHAPTER_LENGTH,
            countMode,
            lengthPolicy,
            targetRange: {
                min: targetMin ?? null,
                max: targetMax ?? null
            },
            counts: {
                actualCount,
                chineseChars,
                nonWhitespaceChars,
                rawChars,
                paragraphCount
            },
            validation: {
                rangeStatus,
                isQualified,
                suggestion
            }
        }
    };
}

async function executeCommand(request, dependencies = {}) {
    const text = ensureText(request, request.command);
    switch (request.command) {
    case COMMANDS.COUNT_CHAPTER_LENGTH:
        return buildCountChapterLengthResult(text, request);
    case COMMANDS.REQUEST_CHAPTER_DRAFT:
        return handleChapterDraft(request, text, dependencies);
    case COMMANDS.REQUEST_EXTERNAL_REVIEW:
        return handleExternalReview(request, text, dependencies);
    case COMMANDS.EDIT_CHAPTER_CONTENT:
        return handleChapterEdit(request, text, dependencies);
    default:
        return { status: 'error', error: `未知命令: ${request.command}` };
    }
}

async function processInputData(inputData, dependencies = {}) {
    try {
        const request = parseRequest(inputData);
        return await executeCommand(request, dependencies);
    } catch (error) {
        return { status: 'error', error: error.message };
    }
}

async function main() {
    let inputData = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', chunk => {
        inputData += chunk;
    });
    process.stdin.on('end', async () => {
        const response = await processInputData(inputData);
        process.stdout.write(JSON.stringify(response));
        process.exit(0);
    });
}

if (require.main === module) {
    main();
}

module.exports = {
    COMMANDS,
    buildAgentAssistantToolPayload,
    buildChapterDraftPrompt,
    buildChapterEditPrompt,
    buildCountChapterLengthResult,
    buildEditPromptInput,
    buildExternalReviewPrompt,
    callHumanToolApi,
    countChineseChars,
    countNonWhitespaceChars,
    executeCommand,
    extractParagraphs,
    handleChapterEdit,
    handleChapterDraft,
    handleExternalReview,
    normalizeBoolean,
    normalizeCountMode,
    normalizeLengthPolicy,
    normalizeIssueList,
    normalizeParagraphTargets,
    normalizeRatio,
    normalizeStringList,
    normalizeTargetInt,
    parseRequest,
    processInputData,
    resolveAgentName,
    runAgentRequest
};
