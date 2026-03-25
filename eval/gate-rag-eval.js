const fs = require('fs');
const path = require('path');

// 读取评分结果 JSON
function readJson(filePath) {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
}

// 执行上线门禁判定
// 输入：
// - base: baseline.summary
// - cand: candidate.summary
// 输出：
// - pass: 是否通过
// - checks: 每条门禁规则是否满足
// - delta: 关键指标增量（candidate - baseline）
function decide(base, cand) {
    const dRecall = cand.recallAt5 - base.recallAt5;
    const dPrecision = cand.precisionAt5 - base.precisionAt5;
    const dMrr = cand.mrr - base.mrr;
    const dNoise = cand.noiseRate - base.noiseRate;
    const dGateErr = cand.gateErrorRate - base.gateErrorRate;
    // 门禁规则含义：
    // recall_guard: 召回率允许轻微波动，但不能明显退化
    // precision_gain/mrr_gain: 需要实质提升
    // noise_drop/gate_error_drop: 噪声与门控错误需要下降
    const checks = {
        recall_guard: dRecall >= -0.01,
        precision_gain: dPrecision >= 0.03,
        mrr_gain: dMrr >= 0.03,
        noise_drop: dNoise <= -0.05,
        gate_error_drop: dGateErr <= -0.1
    };
    const pass = Object.values(checks).every(Boolean);
    return {
        pass,
        checks,
        delta: {
            recallAt5: dRecall,
            precisionAt5: dPrecision,
            mrr: dMrr,
            noiseRate: dNoise,
            gateErrorRate: dGateErr
        }
    };
}

const baselinePath = process.argv[2];
const candidatePath = process.argv[3];
const outPath = process.argv[4];

// 命令行用法：
// node eval/gate-rag-eval.js <baseline.json> <candidate.json> <out.json>
if (!baselinePath || !candidatePath || !outPath) {
    process.stderr.write('usage: node eval/gate-rag-eval.js <baseline.json> <candidate.json> <out.json>\n');
    process.exit(1);
}

// 仅使用 summary 层做门禁判断
const baseline = readJson(path.resolve(baselinePath)).summary;
const candidate = readJson(path.resolve(candidatePath)).summary;
const result = decide(baseline, candidate);
// 输出门禁判定结果，供 CI 或人工复核使用
fs.mkdirSync(path.dirname(path.resolve(outPath)), { recursive: true });
fs.writeFileSync(path.resolve(outPath), JSON.stringify(result, null, 2), 'utf-8');
process.stdout.write(`${outPath}\n`);
