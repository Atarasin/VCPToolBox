const fs = require('fs');
const path = require('path');

// 读取评测汇总 JSON（由 score-rag-eval.js 输出）
function readJson(filePath) {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
}

// 将 0~1 比例格式化为百分比字符串，统一报告展示格式
function pct(v) {
    return `${(v * 100).toFixed(2)}%`;
}

// 计算 Candidate - Baseline 的增量值
function delta(a, b) {
    return b - a;
}

// 生成 Markdown 对比报告
// 输入：
// - base: 基线评测结果对象
// - cand: 候选评测结果对象
// 输出：
// - Markdown 文本（包含指标表 + 失败样本）
function renderMarkdown(base, cand) {
    const b = base.summary;
    const c = cand.summary;
    const lines = [];
    lines.push('# RAG 参数评测对比报告');
    lines.push('');
    lines.push('| 指标 | Baseline | Candidate | Delta |');
    lines.push('|---|---:|---:|---:|');
    lines.push(`| Recall@5 | ${pct(b.recallAt5)} | ${pct(c.recallAt5)} | ${pct(delta(b.recallAt5, c.recallAt5))} |`);
    lines.push(`| Precision@5 | ${pct(b.precisionAt5)} | ${pct(c.precisionAt5)} | ${pct(delta(b.precisionAt5, c.precisionAt5))} |`);
    lines.push(`| MRR | ${pct(b.mrr)} | ${pct(c.mrr)} | ${pct(delta(b.mrr, c.mrr))} |`);
    lines.push(`| NoiseRate | ${pct(b.noiseRate)} | ${pct(c.noiseRate)} | ${pct(delta(b.noiseRate, c.noiseRate))} |`);
    lines.push(`| GateErrorRate | ${pct(b.gateErrorRate)} | ${pct(c.gateErrorRate)} | ${pct(delta(b.gateErrorRate, c.gateErrorRate))} |`);
    lines.push('');
    // 失败样本定义：
    // - Top5 未命中
    // - 命中硬负例
    // - 门控预期与实际不一致
    const failed = cand.perCase.filter(x => !x.hitAt5 || x.hardNegativeHit || x.gateMismatch).slice(0, 10);
    lines.push('## Top10 失败样本');
    lines.push('');
    if (failed.length === 0) {
        lines.push('- 无失败样本');
    } else {
        for (const item of failed) {
            lines.push(`- ${item.id} | hitAt5=${item.hitAt5} | hardNegative=${item.hardNegativeHit} | gateMismatch=${item.gateMismatch}`);
        }
    }
    lines.push('');
    return lines.join('\n');
}

const baselinePath = process.argv[2];
const candidatePath = process.argv[3];
const outPath = process.argv[4];

// 命令行用法：
// node eval/compare-rag-eval.js <baseline.json> <candidate.json> <out.md>
if (!baselinePath || !candidatePath || !outPath) {
    process.stderr.write('usage: node eval/compare-rag-eval.js <baseline.json> <candidate.json> <out.md>\n');
    process.exit(1);
}

// 读取两组评测结果
const baseline = readJson(path.resolve(baselinePath));
const candidate = readJson(path.resolve(candidatePath));
// 渲染 Markdown 报告
const markdown = renderMarkdown(baseline, candidate);
// 确保输出目录存在
fs.mkdirSync(path.dirname(path.resolve(outPath)), { recursive: true });
// 写入报告并输出路径，便于脚本链路消费
fs.writeFileSync(path.resolve(outPath), markdown, 'utf-8');
process.stdout.write(`${outPath}\n`);
