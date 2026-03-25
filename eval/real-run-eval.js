const fs = require('fs');
const path = require('path');
const knowledgeBaseManager = require('../KnowledgeBaseManager');
const ragPlugin = require('../Plugin/RAGDiaryPlugin/RAGDiaryPlugin');

function readJsonl(filePath) {
    const text = fs.readFileSync(filePath, 'utf-8').trim();
    if (!text) return [];
    return text.split('\n').map(line => JSON.parse(line));
}

function readJson(filePath) {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
}

function parseArgs(argv) {
    const args = { variant: null, ragParamsPath: null };
    if (argv.length > 0) args.variant = argv[0];
    for (let i = 1; i < argv.length; i++) {
        if (argv[i] === '--rag-params' && argv[i + 1]) {
            args.ragParamsPath = argv[i + 1];
            i++;
        }
    }
    return args;
}

function applyRagParamsOverride(ragParams) {
    knowledgeBaseManager.ragParams = ragParams;
    ragPlugin.ragParams = ragParams;
}

function extractBulletTopK(content, maxItems = 10) {
    const lines = String(content || '').split('\n');
    const bullets = lines
        .map(line => line.trim())
        .filter(line => line.startsWith('* '))
        .map(line => line.replace(/^\*\s+/, '').trim())
        .filter(Boolean)
        .slice(0, maxItems);
    return bullets.map((text, index) => ({
        text,
        score: Math.max(0.01, 1 - index * 0.05)
    }));
}

function sanitizeTopKItem(item) {
    const text = String(item?.text || '').trim().slice(0, 2000);
    const score = Number.isFinite(item?.score) ? item.score : 0;
    return { text, score };
}

function resolveTopKFromEventsOrContent(events, content) {
    const detailEvents = events.filter(e => e && e.type === 'RAG_RETRIEVAL_DETAILS' && Array.isArray(e.results));
    if (detailEvents.length > 0) {
        const last = detailEvents[detailEvents.length - 1];
        const topk = last.results.slice(0, 10).map(sanitizeTopKItem).filter(x => x.text.length > 0);
        if (topk.length > 0) return topk;
    }
    const bullets = extractBulletTopK(content, 10);
    if (bullets.length > 0) return bullets;
    const fallback = String(content || '').trim();
    if (!fallback) return [];
    return [{ text: fallback.slice(0, 2000), score: 0.1 }];
}

function isGatePassed(content) {
    return String(content || '').trim().length > 0;
}

async function runSingleCase(item, pushEvents) {
    const systemContent = item.mode || '';
    const userContent = item.query || '';
    const messages = [
        { role: 'system', content: systemContent },
        { role: 'user', content: userContent }
    ];

    const processed = await ragPlugin.processMessages(messages, {});
    const outputSystem = (processed.find(m => m.role === 'system') || {}).content || '';
    const topk = resolveTopKFromEventsOrContent(pushEvents, outputSystem);
    const gatePassed = isGatePassed(outputSystem);

    return {
        id: item.id,
        gatePassed,
        topk
    };
}

async function run() {
    const args = parseArgs(process.argv.slice(2));
    if (!args.variant || !['baseline', 'candidate'].includes(args.variant)) {
        process.stderr.write('usage: node eval/real-run-eval.js <baseline|candidate> [--rag-params <path>]\n');
        process.exit(1);
    }

    const evalSetPath = path.join(__dirname, 'rag_param_eval_set.jsonl');
    const outputDir = path.join(__dirname, 'results');
    fs.mkdirSync(outputDir, { recursive: true });

    let runtimeRagParams;
    if (args.ragParamsPath) {
        runtimeRagParams = readJson(path.resolve(args.ragParamsPath));
    } else {
        const defaultParamsPath = path.join(__dirname, '..', 'rag_params.json');
        runtimeRagParams = readJson(defaultParamsPath);
    }

    const evalSet = readJsonl(evalSetPath);
    const results = [];
    let currentEvents = [];

    const pushVcpInfo = payload => {
        try {
            currentEvents.push(JSON.parse(JSON.stringify(payload)));
        } catch (_) {
            currentEvents.push(payload);
        }
    };

    applyRagParamsOverride(runtimeRagParams);
    await knowledgeBaseManager.initialize();
    await ragPlugin.initialize({}, {
        vectorDBManager: knowledgeBaseManager,
        vcpLogFunctions: { pushVcpInfo }
    });
    applyRagParamsOverride(runtimeRagParams);

    for (const item of evalSet) {
        currentEvents = [];
        try {
            const row = await runSingleCase(item, currentEvents);
            results.push(row);
        } catch (e) {
            results.push({
                id: item.id,
                gatePassed: false,
                topk: [{ text: `[EVAL_ERROR] ${e.message || e}`, score: 0 }]
            });
        }
    }

    const outPath = path.join(outputDir, `${args.variant}.json`);
    fs.writeFileSync(outPath, JSON.stringify(results, null, 2), 'utf-8');
    process.stdout.write(`${outPath}\n`);
}

run()
    .catch(err => {
        console.error('[real-run-eval] failed:', err);
        process.exitCode = 1;
    })
    .finally(async () => {
        try {
            ragPlugin.shutdown();
        } catch (_) {}
        try {
            await knowledgeBaseManager.shutdown();
        } catch (_) {}
    });
