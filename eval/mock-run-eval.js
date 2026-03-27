const fs = require('fs');
const path = require('path');

/**
 * ============================================================================
 * RAG 评测模拟运行说明
 * ============================================================================
 *
 * 本脚本用于生成模拟的评测结果，配合评测流水线进行联调测试。
 *
 * 模拟的评测指标包括：
 *
 * 1. Recall@5（召回率@5）
 *    - 模拟策略：candidate 比 baseline 更容易命中金标
 *    - baseline：每 4 个样本中有 1 个命中（25% 命中率）
 *    - candidate：每 6 个样本中只有 1 个未命中（约 83% 命中率）
 *
 * 2. Precision@5（精确率@5）
 *    - 由命中策略间接决定，命中越多，精确率越高
 *
 * 3. MRR（平均倒数排名）
 *    - 命中样本中，金标默认排在第 1 位（MRR 贡献 1.0）
 *
 * 4. NoiseRate（噪声率）
 *    - 未命中样本会加入硬负例，用于模拟噪声
 *
 * 5. GateErrorRate（门控错误率）
 *    - 模拟策略：candidate 门控更宽松，baseline 更保守
 *    - candidate：gate_expect=true 时默认放行，仅 10% 概率拦截
 *    - baseline：gate_expect=true 时有 20% 概率拦截（故意制造更多误差）
 *
 * 设计意图：
 * - 通过让 candidate 表现更好，便于验证评测流水线和对比报告的正确性
 * - 实际使用时，应替换为真实的检索系统调用
 * ============================================================================
 */

/**
 * 读取 JSONL 评测集文件（每行一个 JSON 对象）
 * @param {string} filePath - 文件路径
 * @returns {Array} 解析后的样本对象数组
 */
function readJsonl(filePath) {
    const text = fs.readFileSync(filePath, 'utf-8').trim();
    if (!text) return [];
    return text.split('\n').map(line => JSON.parse(line));
}

/**
 * 生成模拟的 Top-K 检索结果
 *
 * 说明：
 *   - baseline 与 candidate 故意设置不同的命中概率，用于演示 A/B 测试时的指标变化
 *   - 该脚本不做真实检索，仅用于联调评测流水线
 *
 * @param {Object} item - 评测样本对象，包含 gold_snippets 和 hard_negative
 * @param {number} index - 样本索引，用于控制命中策略
 * @param {string} variant - 变体名称（'baseline' 或 'candidate'）
 * @returns {Array} 模拟的 Top-K 结果数组，每项包含 text 和 score
 */
function makeTopK(item, index, variant) {
    const k = 5;  // Top-K 的数量
    const topk = [];

    // 获取金标片段（正确答案）和硬负例（错误但相似的答案）
    const goldA = item.gold_snippets[0] || 'gold_a';
    const goldB = item.gold_snippets[1] || goldA;
    const negative = item.hard_negative[0] || 'negative';

    // candidate 故意比 baseline 更容易命中金标，便于演示"调参有效"的报告效果
    // baseline: 每 4 个样本中有 1 个命中（25% 命中率）
    // candidate: 每 6 个样本中只有 1 个未命中（约 83% 命中率）
    const goodCase = variant === 'candidate'
        ? index % 6 !== 0
        : index % 4 === 0;

    if (goodCase) {
        // 命中场景：将金标内容加入 Top-K
        topk.push({ text: `${goldA} 命中记录`, score: 0.92 });
        topk.push({ text: `${goldB} 扩展记录`, score: 0.83 });
    } else {
        // 未命中场景：加入硬负例或无关内容
        topk.push({ text: `${negative} 无关记录`, score: 0.81 });
        topk.push({ text: `泛化内容_${index}`, score: 0.78 });
    }

    // 填充剩余的 Top-K 位置，确保返回 5 个结果
    while (topk.length < k) {
        topk.push({
            text: `候选片段_${variant}_${index}_${topk.length}`,
            score: 0.6 - topk.length * 0.05  // 分数递减
        });
    }

    return topk;
}

/**
 * 主流程：读取评测集，生成指定变体的模拟检索结果
 *
 * @param {string} variant - 变体名称（'baseline' 或 'candidate'）
 */
function run(variant) {
    // 评测集路径：当前目录下的 rag_param_eval_set.jsonl
    const evalSetPath = path.join(__dirname, 'rag_param_eval_set.jsonl');
    // 输出目录：当前目录下的 results 文件夹
    const outDir = path.join(__dirname, 'results');
    fs.mkdirSync(outDir, { recursive: true });

    // 读取评测集
    const evalItems = readJsonl(evalSetPath);

    // 为每个样本生成模拟结果
    const results = evalItems.map((item, index) => {
        // 模拟门控（Gate）行为：
        // - candidate 对 gate_expect=true 的样本默认放行，只有 10% 概率拦截
        // - baseline 放行策略更保守，对 gate_expect=true 有 20% 概率拦截
        //   故意制造更多门控误差，用于对比演示
        const gatePassed = variant === 'candidate'
            ? (item.gate_expect ? true : index % 10 === 0)
            : (item.gate_expect ? index % 5 !== 0 : index % 3 === 0);

        return {
            id: item.id,
            gatePassed,           // 门控是否放行
            topk: makeTopK(item, index, variant)  // 模拟的 Top-K 结果
        };
    });

    // 将结果写入 JSON 文件
    const outPath = path.join(outDir, `${variant}.json`);
    fs.writeFileSync(outPath, JSON.stringify(results, null, 2), 'utf-8');
    process.stdout.write(`${outPath}\n`);
}

// 从命令行参数获取变体名称
const variant = process.argv[2];

/**
 * 命令行用法：
 *   node eval/mock-run-eval.js <baseline|candidate>
 *
 * 参数说明：
 *   - baseline: 生成基线版本的模拟结果
 *   - candidate: 生成候选版本的模拟结果（表现更好，用于对比）
 */
if (!variant || !['baseline', 'candidate'].includes(variant)) {
    process.stderr.write('usage: node eval/mock-run-eval.js <baseline|candidate>\n');
    process.exit(1);
}

// 执行主流程
run(variant);
