const fs = require('fs');
const path = require('path');

// 读取 JSONL 评测集，每行一个样本对象
function readJsonl(filePath) {
    const text = fs.readFileSync(filePath, 'utf-8').trim();
    if (!text) return [];
    return text.split('\n').map(line => JSON.parse(line));
}

// 生成模拟 TopK 结果
// 说明：
// - baseline 与 candidate 故意设置不同命中概率，用于演示 A/B 指标变化
// - 该脚本不做真实检索，只用于联调评测流水线
function makeTopK(item, index, variant) {
    const k = 5;
    const topk = [];
    const goldA = item.gold_snippets[0] || 'gold_a';
    const goldB = item.gold_snippets[1] || goldA;
    const negative = item.hard_negative[0] || 'negative';
    // candidate 故意比 baseline 更容易命中，便于演示“调参有效”报告
    const goodCase = variant === 'candidate'
        ? index % 6 !== 0
        : index % 4 === 0;
    if (goodCase) {
        topk.push({ text: `${goldA} 命中记录`, score: 0.92 });
        topk.push({ text: `${goldB} 扩展记录`, score: 0.83 });
    } else {
        topk.push({ text: `${negative} 无关记录`, score: 0.81 });
        topk.push({ text: `泛化内容_${index}`, score: 0.78 });
    }
    while (topk.length < k) {
        topk.push({ text: `候选片段_${variant}_${index}_${topk.length}`, score: 0.6 - topk.length * 0.05 });
    }
    return topk;
}

// 主流程：读取评测集，生成指定 variant 的模拟检索结果
function run(variant) {
    const evalSetPath = path.join(__dirname, 'rag_param_eval_set.jsonl');
    const outDir = path.join(__dirname, 'results');
    fs.mkdirSync(outDir, { recursive: true });
    const evalItems = readJsonl(evalSetPath);
    const results = evalItems.map((item, index) => {
        // 模拟门控行为：
        // - candidate 对 gate_expect=true 的样本默认放行
        // - baseline 放行策略更保守，故意制造更多门控误差
        const gatePassed = variant === 'candidate'
            ? (item.gate_expect ? true : index % 10 === 0)
            : (item.gate_expect ? index % 5 !== 0 : index % 3 === 0);
        return {
            id: item.id,
            gatePassed,
            topk: makeTopK(item, index, variant)
        };
    });
    const outPath = path.join(outDir, `${variant}.json`);
    fs.writeFileSync(outPath, JSON.stringify(results, null, 2), 'utf-8');
    process.stdout.write(`${outPath}\n`);
}

const variant = process.argv[2];
// 命令行用法：
// node eval/mock-run-eval.js <baseline|candidate>
if (!variant || !['baseline', 'candidate'].includes(variant)) {
    process.stderr.write('usage: node eval/mock-run-eval.js <baseline|candidate>\n');
    process.exit(1);
}
run(variant);
