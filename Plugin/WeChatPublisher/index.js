const fs = require('fs');
const path = require('path');
const dotenv = require('dotenv');
const { fetchGithubCorpus } = require('./modules/github-fetcher');
const { generateDrafts, buildDraft } = require('./modules/content-generator');
const { pushReviewMessage } = require('./modules/reviewer');
const { bootstrapSchedules } = require('./modules/scheduler');

const PLUGIN_ROOT = __dirname;

/**
 * 加载环境变量配置
 * 优先加载插件目录下的 config.env，其次加载项目根目录下的 config.env
 */
function loadEnv() {
    const localEnv = path.join(PLUGIN_ROOT, 'config.env');
    if (fs.existsSync(localEnv)) {
        dotenv.config({ path: localEnv });
    }
    const projectBasePath = process.env.PROJECT_BASE_PATH;
    if (projectBasePath) {
        const rootEnv = path.join(projectBasePath, 'config.env');
        if (fs.existsSync(rootEnv)) {
            dotenv.config({ path: rootEnv });
        }
    }
}

/**
 * 读取标准输入流中的数据
 * @returns {Promise<string>} 返回读取到的完整字符串
 */
async function readStdin() {
    let input = '';
    process.stdin.setEncoding('utf8');
    for await (const chunk of process.stdin) {
        input += chunk;
    }
    return input.trim();
}

/**
 * 解析输入字符串为 JSON 对象
 * @param {string} raw - 原始输入字符串
 * @returns {Object} 解析后的 JSON 对象
 * @throws {Error} 如果解析失败或结果不是对象/数组
 */
function parseInput(raw) {
    if (!raw) return {};
    let parsed;
    try {
        parsed = JSON.parse(raw);
    } catch (error) {
        throw new Error(`输入数据不是合法 JSON: ${error.message}`);
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error('输入必须是 JSON 对象');
    }
    return parsed;
}

/**
 * 将各种类型的值转换为布尔值
 * @param {any} value - 需要转换的值
 * @param {boolean} [defaultValue=false] - 默认值
 * @returns {boolean} 转换后的布尔值
 */
function toBoolean(value, defaultValue = false) {
    if (value === undefined || value === null || value === '') return defaultValue;
    if (typeof value === 'boolean') return value;
    const normalized = String(value).trim().toLowerCase();
    return normalized === 'true' || normalized === '1' || normalized === 'yes';
}

/**
 * 收集并整理配置信息
 * @returns {Object} 包含关键配置项的对象
 */
function collectConfig() {
    return {
        PORT: process.env.PORT,
        Key: process.env.Key || process.env.KEY,
        AdminUsername: process.env.AdminUsername || process.env.ADMIN_USERNAME,
        AdminPassword: process.env.AdminPassword || process.env.ADMIN_PASSWORD,
        WECHAT_PUBLISHER_SCHEDULE_HOURS: process.env.WECHAT_PUBLISHER_SCHEDULE_HOURS,
        WECHAT_PUBLISHER_MAX_ITEMS: process.env.WECHAT_PUBLISHER_MAX_ITEMS,
        WECHAT_PUBLISHER_SEARCH_TEMPLATE_IDS: process.env.WECHAT_PUBLISHER_SEARCH_TEMPLATE_IDS,
        WECHAT_PUBLISHER_SEARCH_TEMPLATES_JSON: process.env.WECHAT_PUBLISHER_SEARCH_TEMPLATES_JSON,
        WECHAT_PUBLISHER_TEMPLATE_LIMITS_JSON: process.env.WECHAT_PUBLISHER_TEMPLATE_LIMITS_JSON,
        WECHAT_PUBLISHER_TEMPLATE_WEIGHTS_JSON: process.env.WECHAT_PUBLISHER_TEMPLATE_WEIGHTS_JSON,
        WECHAT_PUBLISHER_DRAFT_AGENT_NAME: process.env.WECHAT_PUBLISHER_DRAFT_AGENT_NAME,
        WECHAT_PUBLISHER_DRAFT_TIMEOUT_MS: process.env.WECHAT_PUBLISHER_DRAFT_TIMEOUT_MS,
        WECHAT_PUBLISHER_DRAFT_RETRY_TIMES: process.env.WECHAT_PUBLISHER_DRAFT_RETRY_TIMES,
        WECHAT_PUBLISHER_REVIEW_RECEIVE_ID_TYPE: process.env.WECHAT_PUBLISHER_REVIEW_RECEIVE_ID_TYPE,
        WECHAT_PUBLISHER_REVIEW_RECEIVE_ID: process.env.WECHAT_PUBLISHER_REVIEW_RECEIVE_ID,
        WECHAT_PUBLISHER_REVIEW_RETRY_TIMES: process.env.WECHAT_PUBLISHER_REVIEW_RETRY_TIMES,
        WECHAT_PUBLISHER_REVIEW_RETRY_DELAY_MS: process.env.WECHAT_PUBLISHER_REVIEW_RETRY_DELAY_MS
    };
}

function normalizeTemplateIds(value) {
    if (Array.isArray(value)) {
        return value.map(item => String(item).trim()).filter(Boolean);
    }
    return String(value || '')
        .split(',')
        .map(item => item.trim())
        .filter(Boolean);
}

/**
 * 标准化工作流输入参数
 * @param {Object} args - 原始输入参数
 * @returns {Object} 标准化后的参数对象 (force, dryRun, limit)
 */
function normalizeWorkflowInput(args) {
    const limitValue = Number.parseInt(
        args.max_items || args.maxItems || process.env.WECHAT_PUBLISHER_MAX_ITEMS || '20',
        10
    );
    const limit = Number.isFinite(limitValue) && limitValue > 0 ? limitValue : 20;
    const templateIds = normalizeTemplateIds(
        args.template_ids || args.templateIds || process.env.WECHAT_PUBLISHER_SEARCH_TEMPLATE_IDS
    );
    const searchTemplatesJson =
        args.search_templates_json ||
        args.searchTemplatesJson ||
        process.env.WECHAT_PUBLISHER_SEARCH_TEMPLATES_JSON ||
        '';
    const templateLimitsJson =
        args.template_limits_json ||
        args.templateLimitsJson ||
        process.env.WECHAT_PUBLISHER_TEMPLATE_LIMITS_JSON ||
        '';
    const templateWeightsJson =
        args.template_weights_json ||
        args.templateWeightsJson ||
        process.env.WECHAT_PUBLISHER_TEMPLATE_WEIGHTS_JSON ||
        '';
    const draftAgentName =
        args.draft_agent_name ||
        args.draftAgentName ||
        process.env.WECHAT_PUBLISHER_DRAFT_AGENT_NAME ||
        '';
    return {
        force: toBoolean(args.force, false),
        dryRun: toBoolean(args.dry_run, false),
        limit,
        templateIds,
        searchTemplatesJson,
        templateLimitsJson,
        templateWeightsJson,
        draftAgentName
    };
}

/**
 * 执行完整的工作流
 * 步骤描述:
 * 1. 抓取 GitHub 语料 (Stage 1)
 * 2. 生成内容草稿 (Stage 2)
 * 3. 推送审核消息 (Stage 3)
 * 
 * @param {Object} args - 输入参数
 * @param {Object} config - 配置对象
 * @returns {Promise<Object>} 工作流执行结果
 */
async function runWorkflow(args, config, dependencies = {}) {
    const fetchCorpus = dependencies.fetchGithubCorpus || fetchGithubCorpus;
    const generate = dependencies.generateDrafts || generateDrafts;
    const pushReview = dependencies.pushReviewMessage || pushReviewMessage;
    const workflow = normalizeWorkflowInput(args);
    // Stage 1: 抓取 GitHub 语料
    const stage1 = await fetchCorpus({
        pluginRoot: PLUGIN_ROOT,
        force: workflow.force,
        limit: workflow.limit,
        templateIds: workflow.templateIds,
        searchTemplatesJson: workflow.searchTemplatesJson,
        templateLimitsJson: workflow.templateLimitsJson,
        templateWeightsJson: workflow.templateWeightsJson
    });
    // 如果没有抓取到仓库，提前返回
    if (!Array.isArray(stage1.repos) || stage1.repos.length === 0) {
        return {
            stage1,
            stage2: { generatedAt: new Date().toISOString(), total: 0, drafts: [] },
            stage3: { totalPushed: 0, details: [] }
        };
    }
    // Stage 2: 生成草稿
    const stage2 = await generate(stage1.repos, {
        pluginRoot: PLUGIN_ROOT,
        config,
        templateIds: stage1.templateIds,
        agentName: workflow.draftAgentName
    });
    const reviewResults = [];
    // Stage 3: 推送审核
    for (const draft of stage2.drafts) {
        try {
            const pushed = await pushReview(draft, {
                pluginRoot: PLUGIN_ROOT,
                config,
                dryRun: workflow.dryRun
            });
            reviewResults.push({
                draft_id: draft.draft_id,
                success: pushed.success,
                dryRun: pushed.dryRun
            });
        } catch (error) {
            reviewResults.push({
                draft_id: draft.draft_id,
                success: false,
                dryRun: workflow.dryRun,
                error: error.message
            });
        }
    }
    const totalSucceeded = reviewResults.filter(item => item.success).length;
    return {
        stage1,
        stage2,
        stage3: {
            totalPushed: totalSucceeded,
            totalAttempted: reviewResults.length,
            details: reviewResults
        }
    };
}

/**
 * 根据命令分发执行逻辑
 * @param {Object} args - 输入参数
 * @param {Object} config - 配置对象
 * @returns {Promise<Object>} 执行结果
 * @throws {Error} 如果命令未知或参数缺失
 */
async function executeCommand(args, config) {
    const command = args.command || 'RunWorkflow';
    if (command === 'RunWorkflow') {
        const result = await runWorkflow(args, config);
        return { status: 'success', result };
    }
    if (command === 'BootstrapSchedule') {
        const result = await bootstrapSchedules({
            config,
            days: args.days
        });
        return { status: 'success', result };
    }
    if (command === 'FetchCorpus') {
        const templateIds = normalizeTemplateIds(
            args.template_ids || args.templateIds || process.env.WECHAT_PUBLISHER_SEARCH_TEMPLATE_IDS
        );
        const result = await fetchGithubCorpus({
            pluginRoot: PLUGIN_ROOT,
            force: toBoolean(args.force, false),
            limit: Number.parseInt(args.max_items || args.maxItems || process.env.WECHAT_PUBLISHER_MAX_ITEMS || '20', 10),
            templateIds,
            searchTemplatesJson:
                args.search_templates_json ||
                args.searchTemplatesJson ||
                process.env.WECHAT_PUBLISHER_SEARCH_TEMPLATES_JSON ||
                '',
            templateLimitsJson:
                args.template_limits_json ||
                args.templateLimitsJson ||
                process.env.WECHAT_PUBLISHER_TEMPLATE_LIMITS_JSON ||
                '',
            templateWeightsJson:
                args.template_weights_json ||
                args.templateWeightsJson ||
                process.env.WECHAT_PUBLISHER_TEMPLATE_WEIGHTS_JSON ||
                ''
        });
        return { status: 'success', result };
    }
    if (command === 'GenerateDraft') {
        if (!args.source || typeof args.source !== 'object') {
            throw new Error("GenerateDraft 缺少 source 参数");
        }
        const stage2 = await generateDrafts([args.source], {
            pluginRoot: PLUGIN_ROOT,
            config,
            templateIds: normalizeTemplateIds(args.template_ids || args.templateIds),
            agentName:
                args.draft_agent_name ||
                args.draftAgentName ||
                process.env.WECHAT_PUBLISHER_DRAFT_AGENT_NAME ||
                ''
        });
        const draft = stage2.drafts[0];
        return { status: 'success', result: draft };
    }
    if (command === 'PushReview') {
        if (!args.draft || typeof args.draft !== 'object') {
            throw new Error("PushReview 缺少 draft 参数");
        }
        const pushed = await pushReviewMessage(args.draft, {
            pluginRoot: PLUGIN_ROOT,
            config,
            dryRun: toBoolean(args.dry_run, false)
        });
        return { status: 'success', result: pushed };
    }
    throw new Error(`未知命令: ${command}`);
}

/**
 * 主函数，处理输入输出及错误捕获
 */
async function main() {
    loadEnv();
    const config = collectConfig();
    try {
        const rawInput = await readStdin();
        const args = parseInput(rawInput);
        const response = await executeCommand(args, config);
        process.stdout.write(`${JSON.stringify(response)}\n`);
    } catch (error) {
        process.stdout.write(`${JSON.stringify({ status: 'error', error: error.message })}\n`);
        process.exitCode = 1;
    }
}

if (require.main === module) {
    main();
}

module.exports = {
    executeCommand,
    runWorkflow,
    normalizeWorkflowInput,
    parseInput
};
