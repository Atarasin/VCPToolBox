const fs = require('fs');
const path = require('path');
const dotenv = require('dotenv');
const { fetchGithubCorpus } = require('./modules/github-fetcher');
const { generateDrafts, buildDraft } = require('./modules/content-generator');
const { pushReviewMessage } = require('./modules/reviewer');
const { bootstrapSchedules } = require('./modules/scheduler');

const PLUGIN_ROOT = __dirname;

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

async function readStdin() {
    let input = '';
    process.stdin.setEncoding('utf8');
    for await (const chunk of process.stdin) {
        input += chunk;
    }
    return input.trim();
}

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

function toBoolean(value, defaultValue = false) {
    if (value === undefined || value === null || value === '') return defaultValue;
    if (typeof value === 'boolean') return value;
    const normalized = String(value).trim().toLowerCase();
    return normalized === 'true' || normalized === '1' || normalized === 'yes';
}

function collectConfig() {
    return {
        PORT: process.env.PORT,
        Key: process.env.Key || process.env.KEY,
        AdminUsername: process.env.AdminUsername || process.env.ADMIN_USERNAME,
        AdminPassword: process.env.AdminPassword || process.env.ADMIN_PASSWORD,
        WECHAT_PUBLISHER_SCHEDULE_HOURS: process.env.WECHAT_PUBLISHER_SCHEDULE_HOURS,
        WECHAT_PUBLISHER_MAX_ITEMS: process.env.WECHAT_PUBLISHER_MAX_ITEMS,
        WECHAT_PUBLISHER_REVIEW_RECEIVE_ID_TYPE: process.env.WECHAT_PUBLISHER_REVIEW_RECEIVE_ID_TYPE,
        WECHAT_PUBLISHER_REVIEW_RECEIVE_ID: process.env.WECHAT_PUBLISHER_REVIEW_RECEIVE_ID
    };
}

function normalizeWorkflowInput(args) {
    const limitValue = Number.parseInt(
        args.max_items || args.maxItems || process.env.WECHAT_PUBLISHER_MAX_ITEMS || '20',
        10
    );
    const limit = Number.isFinite(limitValue) && limitValue > 0 ? limitValue : 20;
    return {
        force: toBoolean(args.force, false),
        dryRun: toBoolean(args.dry_run, false),
        limit
    };
}

async function runWorkflow(args, config) {
    const workflow = normalizeWorkflowInput(args);
    const stage1 = await fetchGithubCorpus({
        pluginRoot: PLUGIN_ROOT,
        force: workflow.force,
        limit: workflow.limit
    });
    if (!Array.isArray(stage1.repos) || stage1.repos.length === 0) {
        return {
            stage1,
            stage2: { generatedAt: new Date().toISOString(), total: 0, drafts: [] },
            stage3: { totalPushed: 0, details: [] }
        };
    }
    const stage2 = await generateDrafts(stage1.repos, { pluginRoot: PLUGIN_ROOT });
    const reviewResults = [];
    for (const draft of stage2.drafts) {
        const pushed = await pushReviewMessage(draft, {
            pluginRoot: PLUGIN_ROOT,
            config,
            dryRun: workflow.dryRun
        });
        reviewResults.push({
            draft_id: draft.draft_id,
            success: pushed.success,
            dryRun: pushed.dryRun
        });
    }
    return {
        stage1,
        stage2,
        stage3: {
            totalPushed: reviewResults.length,
            details: reviewResults
        }
    };
}

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
        const result = await fetchGithubCorpus({
            pluginRoot: PLUGIN_ROOT,
            force: toBoolean(args.force, false),
            limit: Number.parseInt(args.max_items || args.maxItems || process.env.WECHAT_PUBLISHER_MAX_ITEMS || '20', 10)
        });
        return { status: 'success', result };
    }
    if (command === 'GenerateDraft') {
        if (!args.source || typeof args.source !== 'object') {
            throw new Error("GenerateDraft 缺少 source 参数");
        }
        const draft = buildDraft(args.source, new Date());
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
