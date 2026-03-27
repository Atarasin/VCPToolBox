const fs = require('fs');
const path = require('path');

/**
 * ============================================================================
 * RAG 评测指标对比报告说明
 * ============================================================================
 *
 * 本脚本生成 baseline（基线）与 candidate（候选）的对比报告，包含 5 项核心指标：
 *
 * 1. Recall@5（召回率@5）
 *    - 含义：Top-5 结果中至少命中一个正确答案的样本比例
 *    - Delta 解读：正值表示候选方案召回更多正确答案，负值表示召回能力下降
 *    - 关注阈值：Delta < -1% 需警惕（召回率显著下降）
 *
 * 2. Precision@5（精确率@5）
 *    - 含义：Top-5 结果中正确答案的平均占比
 *    - Delta 解读：正值表示返回结果更"纯净"，负值表示混入更多无关内容
 *    - 关注阈值：Delta ≥ +3% 视为有效提升
 *
 * 3. MRR（平均倒数排名）
 *    - 含义：首个正确答案排名的倒数均值，反映答案排序质量
 *    - 排名得分：第 1 位=1.0，第 2 位=0.5，第 3 位=0.33，以此类推
 *    - Delta 解读：正值表示正确答案更靠前，负值表示答案被排得更靠后
 *    - 关注阈值：Delta ≥ +3% 视为有效提升
 *
 * 4. NoiseRate（噪声率）
 *    - 含义：检索结果中混入硬负例（干扰项）的样本比例
 *    - Delta 解读：负值表示噪声减少（好），正值表示更多干扰项被召回（坏）
 *    - 关注阈值：Delta ≤ -5% 视为有效降低
 *
 * 5. GateErrorRate（门控错误率）
 *    - 含义：系统判断是否应答的错误率（该答不答，或不该答却答）
 *    - Delta 解读：负值表示门控更准，正值表示更多误判
 *    - 关注阈值：Delta ≤ -10% 视为显著提升
 *
 * 失败样本定义：
 * - Top5 未命中：正确答案不在前 5 个结果中
 * - 硬负例命中：错误答案（干扰项）被召回
 * - 门控不一致：系统实际判断与预期判断不符
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
 * 将 0~1 的比例值格式化为百分比字符串
 * 统一报告展示格式，保留两位小数
 * @param {number} v - 0~1 之间的比例值
 * @returns {string} 格式化后的百分比字符串，如 "85.50%"
 */
function pct(v) {
    return `${(v * 100).toFixed(2)}%`;
}

/**
 * 计算两个数值的增量（Candidate - Baseline）
 * @param {number} a - 基线值
 * @param {number} b - 候选值
 * @returns {number} 增量值
 */
function delta(a, b) {
    return b - a;
}

/**
 * 生成 Markdown 格式的对比报告
 *
 * 输入：
 *   - base: 基线评测结果对象（包含 summary 字段）
 *   - cand: 候选评测结果对象（包含 summary 和 perCase 字段）
 *
 * 输出：
 *   - Markdown 文本（包含指标对比表 + Top10 失败样本列表）
 *
 * @param {Object} base - 基线评测结果
 * @param {Object} cand - 候选评测结果
 * @returns {string} Markdown 格式的报告文本
 */
function renderMarkdown(base, cand) {
    // 提取汇总指标
    const b = base.summary;
    const c = cand.summary;
    const lines = [];

    // 报告标题
    lines.push('# RAG 参数评测对比报告');
    lines.push('');

    // 指标对比表头
    lines.push('| 指标 | Baseline | Candidate | Delta |');
    lines.push('|---|---:|---:|---:|');

    // 各项指标对比行
    lines.push(`| Recall@5 | ${pct(b.recallAt5)} | ${pct(c.recallAt5)} | ${pct(delta(b.recallAt5, c.recallAt5))} |`);
    lines.push(`| Precision@5 | ${pct(b.precisionAt5)} | ${pct(c.precisionAt5)} | ${pct(delta(b.precisionAt5, c.precisionAt5))} |`);
    lines.push(`| MRR | ${pct(b.mrr)} | ${pct(c.mrr)} | ${pct(delta(b.mrr, c.mrr))} |`);
    lines.push(`| NoiseRate | ${pct(b.noiseRate)} | ${pct(c.noiseRate)} | ${pct(delta(b.noiseRate, c.noiseRate))} |`);
    lines.push(`| GateErrorRate | ${pct(b.gateErrorRate)} | ${pct(c.gateErrorRate)} | ${pct(delta(b.gateErrorRate, c.gateErrorRate))} |`);
    lines.push('');

    // 失败样本定义：
    // - Top5 未命中（hitAt5=false）
    // - 命中硬负例（hardNegativeHit=true）
    // - 门控预期与实际不一致（gateMismatch=true）
    const failed = cand.perCase.filter(
        x => !x.hitAt5 || x.hardNegativeHit || x.gateMismatch
    ).slice(0, 10);

    lines.push('## Top10 失败样本');
    lines.push('');

    if (failed.length === 0) {
        lines.push('- 无失败样本');
    } else {
        for (const item of failed) {
            lines.push(
                `- ${item.id} | hitAt5=${item.hitAt5} | ` +
                `hardNegative=${item.hardNegativeHit} | ` +
                `gateMismatch=${item.gateMismatch}`
            );
        }
    }
    lines.push('');
    return lines.join('\n');
}

// 从命令行参数获取输入输出路径
const baselinePath = process.argv[2];
const candidatePath = process.argv[3];
const outPath = process.argv[4];

/**
 * 命令行用法：
 *   node eval/compare-rag-eval.js <baseline.json> <candidate.json> <out.md>
 *
 * 参数说明：
 *   - baseline.json: 基线评测结果（由 score-rag-eval.js 生成）
 *   - candidate.json: 候选评测结果（由 score-rag-eval.js 生成）
 *   - out.md: 输出的 Markdown 对比报告路径
 */
if (!baselinePath || !candidatePath || !outPath) {
    process.stderr.write(
        'usage: node eval/compare-rag-eval.js <baseline.json> <candidate.json> <out.md>\n'
    );
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
