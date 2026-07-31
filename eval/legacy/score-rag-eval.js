const fs = require('fs');
const path = require('path');

/**
 * ============================================================================
 * RAG 评测指标体系说明
 * ============================================================================
 *
 * 本评测系统针对 RAG（检索增强生成）系统的效果评估，设计了 5 项核心指标：
 *
 * 1. Recall@5（召回率@5）
 *    - 定义：在 Top-5 检索结果中，至少命中一个金标（正确答案）的样本占比
 *    - 计算公式：Recall@5 = (Top5 至少命中 1 个金标的样本数) / (总样本数)
 *    - 意义：衡量系统能否在有限的结果中找到相关答案
 *    - 目标值：越高越好，理想值为 1.0（100%）
 *    - 示例：若 100 个样本中有 80 个在 Top5 中命中金标，则 Recall@5 = 0.80
 *
 * 2. Precision@5（精确率@5）
 *    - 定义：在 Top-5 检索结果中，相关结果（命中金标）所占比例的平均值
 *    - 计算公式：Precision@5 = Σ(单个样本的 Top5 命中数 / 5) / (总样本数)
 *    - 意义：衡量检索结果的"纯度"，即返回的结果中有多少是真正相关的
 *    - 目标值：越高越好，理想值为 1.0（每个 Top5 结果都相关）
 *    - 区别：与 Recall 不同，Precision 关注返回结果的质量，而非是否找到答案
 *
 * 3. MRR（Mean Reciprocal Rank，平均倒数排名）
 *    - 定义：首个相关结果排名的倒数之平均值
 *    - 计算公式：MRR = Σ(1 / rank_i) / (总样本数)，其中 rank_i 是第 i 个样本中
 *              首个金标命中的位置（1-based），未命中则计为 0
 *    - 意义：衡量相关结果的排序位置，越靠前越好
 *    - 目标值：越高越好，理想值为 1.0（所有首个结果都排在第 1 位）
 *    - 特点：对排名靠前的命中给予更高权重，排名第 1 得 1 分，第 2 得 0.5 分，以此类推
 *
 * 4. NoiseRate（噪声率）
 *    - 定义：检索结果中包含硬负例（Hard Negative）的样本占比
 *    - 计算公式：NoiseRate = (Top5 命中硬负例的样本数) / (总样本数)
 *    - 硬负例说明：指那些与查询表面相关但实际错误的答案，是评测集中标注的"陷阱"选项
 *    - 意义：衡量系统对错误干扰项的鲁棒性，反映抗干扰能力
 *    - 目标值：越低越好，理想值为 0（完全不命中硬负例）
 *    - 重要性：高 NoiseRate 意味着系统容易被误导，输出错误答案
 *
 * 5. GateErrorRate（门控错误率）
 *    - 定义：门控判断结果与预期不一致的样本占比
 *    - 计算公式：GateErrorRate = (gate_expect ≠ gatePassed 的样本数) / (总样本数)
 *    - 门控机制：系统决定是否放行请求（如当检索结果质量不足时拒绝回答）
 *    - 意义：衡量系统"知道什么时候不知道"的能力，即自我认知准确性
 *    - 目标值：越低越好，理想值为 0
 *    - 两种错误类型：
 *      * 假阳性（误放行）：应该拦截却放行，可能导致输出错误答案
 *      * 假阴性（误拦截）：应该放行却拦截，导致漏答可回答的问题
 *
 * 指标间的关系：
 * - Recall 与 Precision 通常存在权衡（trade-off）：提高召回可能导致精确下降
 * - MRR 同时受命中率和排序位置影响，是综合排序质量的指标
 * - NoiseRate 与 Precision 负相关：噪声越多，精确率越低
 * - GateErrorRate 独立于其他指标，反映系统的元认知能力
 *
 * 评测流程：
 * 1. 准备评测集（包含 query、gold_snippets、hard_negative、gate_expect）
 * 2. 运行检索系统，获取 Top-K 结果
 * 3. 计算各项指标（本脚本的核心功能）
 * 4. 对比 baseline 和 candidate，生成报告
 * ============================================================================
 */

/**
 * 读取标准 JSON 文件
 * @param {string} filePath - 文件路径
 * @returns {Object} 解析后的 JSON 对象
 */
function readJson(filePath) {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
}

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
 * 计算首个相关结果的排名（MRR 计算辅助函数）
 *
 * 遍历 Top-K 结果，查找第一个包含金标文本的结果
 * 返回其在 Top-K 中的位置（1-based，即第 1 个位置返回 1）
 *
 * @param {Array} topk - Top-K 结果数组，每项包含 text 字段
 * @param {string[]} goldSnippets - 金标文本片段数组（正确答案）
 * @returns {number|null} 首个相关结果的排名，未命中返回 null
 */
function firstRelevantRank(topk, goldSnippets) {
    for (let i = 0; i < topk.length; i++) {
        const text = String(topk[i].text || '');
        // 检查当前结果是否包含任意一个金标文本
        if (goldSnippets.some(g => text.includes(g))) return i + 1;
    }
    return null;
}

/**
 * 计算 Precision@K（前 K 个结果的精确率）
 *
 * Precision = 相关结果数 / K
 * 其中"相关结果"指包含金标文本的结果
 *
 * @param {Array} topk - Top-K 结果数组
 * @param {string[]} goldSnippets - 金标文本片段数组
 * @param {number} k - 计算精确率的前 K 个位置，默认为 5
 * @returns {number} Precision@K 值（0~1 之间）
 */
function precisionAtK(topk, goldSnippets, k = 5) {
    const sliced = topk.slice(0, k);
    // 统计命中金标的结果数量
    const hit = sliced.filter(
        x => goldSnippets.some(g => String(x.text || '').includes(g))
    ).length;
    return hit / k;
}

/**
 * 判断是否命中硬负例（Hard Negative）
 *
 * 硬负例是指那些与查询相关但不正确的结果，
 * 命中硬负例意味着系统误将错误答案当作正确答案
 *
 * @param {Array} topk - Top-K 结果数组
 * @param {string[]} negatives - 硬负例文本片段数组
 * @returns {boolean} 是否命中硬负例
 */
function hardNegativeHit(topk, negatives) {
    return topk.some(
        x => negatives.some(n => String(x.text || '').includes(n))
    );
}

/**
 * 评分主函数：计算评测结果的多项指标
 *
 * 输入：
 *   - evalSet: 标注数据集，每项包含 id, gold_snippets, hard_negative, gate_expect
 *   - results: 检索结果，每项包含 id, topk, gatePassed
 *
 * 输出：
 *   - summary: 聚合指标（各指标的平均值）
 *   - perCase: 单样本指标详情数组
 *
 * 计算的指标：
 *   - Recall@5: Top5 中至少命中一个金标的样本比例
 *   - Precision@5: Top5 中命中金标的结果比例的平均值
 *   - MRR: 首个相关结果倒数排名的平均值（Mean Reciprocal Rank）
 *   - NoiseRate: 命中硬负例的样本占比
 *   - GateErrorRate: 门控预期与实际不一致的样本占比
 *
 * @param {Array} evalSet - 标注数据集
 * @param {Array} results - 检索结果
 * @returns {Object} 评分结果 { summary, perCase }
 */
function score(evalSet, results) {
    // 将结果数组转换为 Map，便于按 ID 快速查找
    const byId = new Map(results.map(r => [r.id, r]));
    const perCase = [];  // 存储每个样本的详细指标

    // 累加器：用于计算各类指标的总和
    let recallHits = 0;      // Recall@5 命中计数
    let precisionSum = 0;    // Precision@5 累加和
    let mrrSum = 0;          // MRR 累加和
    let noiseHits = 0;       // 命中硬负例计数
    let gateTotal = 0;       // 门控判断总样本数
    let gateError = 0;       // 门控判断错误计数

    // 遍历每个评测样本，计算其指标
    for (const item of evalSet) {
        // 获取当前样本的检索结果，若不存在则使用默认值
        const r = byId.get(item.id) || { topk: [], gatePassed: false };

        // 计算首个相关结果的排名
        const rank = firstRelevantRank(r.topk || [], item.gold_snippets || []);

        // 判断是否命中：排名不为 null 且在 Top5 内
        const hitAt5 = rank !== null && rank <= 5;

        // 计算 Precision@5
        const p5 = precisionAtK(r.topk || [], item.gold_snippets || [], 5);

        // 计算 MRR：命中则取倒数，未命中则为 0
        const mrr = rank ? 1 / rank : 0;

        // 判断是否命中硬负例（噪声）
        const noise = hardNegativeHit(r.topk || [], item.hard_negative || []);

        // 判断门控是否一致：期望门控结果与实际门控结果是否匹配
        const gateMismatch = Boolean(item.gate_expect) !== Boolean(r.gatePassed);

        // 累加各项指标
        if (hitAt5) recallHits++;
        precisionSum += p5;
        mrrSum += mrr;
        if (noise) noiseHits++;
        gateTotal++;
        if (gateMismatch) gateError++;

        // 保存当前样本的详细指标
        perCase.push({
            id: item.id,
            hitAt5,           // Top5 是否命中金标
            precisionAt5: p5, // Top5 精确率
            mrr,              // 当前样本的 MRR
            hardNegativeHit: noise,  // 是否命中硬负例
            gateMismatch      // 门控是否不一致
        });
    }

    // 计算最终聚合指标（使用样本总数作为分母）
    const total = evalSet.length || 1;
    return {
        summary: {
            totalCases: evalSet.length,                    // 评测样本总数
            recallAt5: recallHits / total,                 // Top5 至少命中一个金标的比例
            precisionAt5: precisionSum / total,            // Top5 命中比例的平均值
            mrr: mrrSum / total,                           // 首命中倒数排名的平均值
            noiseRate: noiseHits / total,                  // 命中硬负例的样本占比
            gateErrorRate: gateError / gateTotal           // 门控预期与实际不一致的占比
        },
        perCase  // 每个样本的详细指标
    };
}

// 从命令行参数获取输入输出路径
const evalSetPath = process.argv[2];
const resultPath = process.argv[3];
const outPath = process.argv[4];

/**
 * 命令行用法：
 *   node eval/score-rag-eval.js <eval_set.jsonl> <result.json> <out.json>
 *
 * 参数说明：
 *   - eval_set.jsonl: 评测集标注文件（JSONL 格式）
 *   - result.json: 检索结果文件（由 mock-run-eval.js 或 real-run-eval.js 生成）
 *   - out.json: 输出的评分报告路径
 */
if (!evalSetPath || !resultPath || !outPath) {
    process.stderr.write(
        'usage: node eval/score-rag-eval.js <eval_set.jsonl> <result.json> <out.json>\n'
    );
    process.exit(1);
}

// 读取输入数据
const evalSet = readJsonl(path.resolve(evalSetPath));
const results = readJson(path.resolve(resultPath));

// 执行评分计算
const scored = score(evalSet, results);

// 确保输出目录存在后写入报告
fs.mkdirSync(path.dirname(path.resolve(outPath)), { recursive: true });
fs.writeFileSync(path.resolve(outPath), JSON.stringify(scored, null, 2), 'utf-8');
process.stdout.write(`${outPath}\n`);
