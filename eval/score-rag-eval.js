const fs = require('fs');
const path = require('path');

// 读取标准 JSON 文件
function readJson(filePath) {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
}

// 读取 JSONL 评测集
function readJsonl(filePath) {
    const text = fs.readFileSync(filePath, 'utf-8').trim();
    if (!text) return [];
    return text.split('\n').map(line => JSON.parse(line));
}

// 计算首个相关结果排名（1-based）
// 若没有命中则返回 null
function firstRelevantRank(topk, goldSnippets) {
    for (let i = 0; i < topk.length; i++) {
        const text = String(topk[i].text || '');
        if (goldSnippets.some(g => text.includes(g))) return i + 1;
    }
    return null;
}

// 计算 Precision@K
function precisionAtK(topk, goldSnippets, k = 5) {
    const sliced = topk.slice(0, k);
    const hit = sliced.filter(x => goldSnippets.some(g => String(x.text || '').includes(g))).length;
    return hit / k;
}

// 判断是否命中硬负例（噪声）
function hardNegativeHit(topk, negatives) {
    return topk.some(x => negatives.some(n => String(x.text || '').includes(n)));
}

// 评分主函数
// 输入：
// - evalSet: 标注数据集
// - results: 检索结果（每条包含 id, topk, gatePassed）
// 输出：
// - summary: 聚合指标
// - perCase: 单样本指标详情
function score(evalSet, results) {
    const byId = new Map(results.map(r => [r.id, r]));
    const perCase = [];
    let recallHits = 0;
    let precisionSum = 0;
    let mrrSum = 0;
    let noiseHits = 0;
    let gateTotal = 0;
    let gateError = 0;

    for (const item of evalSet) {
        const r = byId.get(item.id) || { topk: [], gatePassed: false };
        const rank = firstRelevantRank(r.topk || [], item.gold_snippets || []);
        const hitAt5 = rank !== null && rank <= 5;
        const p5 = precisionAtK(r.topk || [], item.gold_snippets || [], 5);
        const mrr = rank ? 1 / rank : 0;
        const noise = hardNegativeHit(r.topk || [], item.hard_negative || []);
        const gateMismatch = Boolean(item.gate_expect) !== Boolean(r.gatePassed);
        if (hitAt5) recallHits++;
        precisionSum += p5;
        mrrSum += mrr;
        if (noise) noiseHits++;
        gateTotal++;
        if (gateMismatch) gateError++;
        perCase.push({
            id: item.id,
            hitAt5,
            precisionAt5: p5,
            mrr,
            hardNegativeHit: noise,
            gateMismatch
        });
    }

    const total = evalSet.length || 1;
    return {
        summary: {
            // totalCases: 评测样本总数
            totalCases: evalSet.length,
            // recallAt5: Top5 至少命中一个金标
            recallAt5: recallHits / total,
            // precisionAt5: Top5 命中比例平均值
            precisionAt5: precisionSum / total,
            // mrr: 首命中倒数排名平均值
            mrr: mrrSum / total,
            // noiseRate: 命中硬负例的样本占比
            noiseRate: noiseHits / total,
            // gateErrorRate: 门控预期与实际不一致的占比
            gateErrorRate: gateError / gateTotal
        },
        perCase
    };
}

const evalSetPath = process.argv[2];
const resultPath = process.argv[3];
const outPath = process.argv[4];

// 命令行用法：
// node eval/score-rag-eval.js <eval_set.jsonl> <result.json> <out.json>
if (!evalSetPath || !resultPath || !outPath) {
    process.stderr.write('usage: node eval/score-rag-eval.js <eval_set.jsonl> <result.json> <out.json>\n');
    process.exit(1);
}

// 读取输入并执行评分
const evalSet = readJsonl(path.resolve(evalSetPath));
const results = readJson(path.resolve(resultPath));
const scored = score(evalSet, results);
// 确保输出目录存在后写入报告
fs.mkdirSync(path.dirname(path.resolve(outPath)), { recursive: true });
fs.writeFileSync(path.resolve(outPath), JSON.stringify(scored, null, 2), 'utf-8');
process.stdout.write(`${outPath}\n`);
