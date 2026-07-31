const fs = require('fs');
const path = require('path');

/**
 * ============================================================================
 * RAG 上线门禁（Gate Check）说明
 * ============================================================================
 *
 * 本脚本执行上线前的门禁判定，基于 5 项核心指标的对比分析：
 *
 * 1. Recall@5（召回率@5）- 门禁规则：recall_guard
 *    - 基准确则：召回率允许轻微波动，但不能明显退化
 *    - 阈值：Delta ≥ -1%（即降幅不超过 1 个百分点）
 *    - 原因：新方案可以召回率持平或略降，但不能牺牲用户找得到答案的能力
 *
 * 2. Precision@5（精确率@5）- 门禁规则：precision_gain
 *    - 基准确则：新方案需要有实质提升
 *    - 阈值：Delta ≥ +3%（即提升至少 3 个百分点）
 *    - 原因：仅替换方案而无精度提升，上线价值不足
 *
 * 3. MRR（平均倒数排名）- 门禁规则：mrr_gain
 *    - 基准确则：正确答案的排序位置需要有实质改善
 *    - 阈值：Delta ≥ +3%（即提升至少 3 个百分点）
 *    - 原因：MRR 反映用户体验（好答案是否排在前面），需显著提升
 *
 * 4. NoiseRate（噪声率）- 门禁规则：noise_drop
 *    - 基准确则：检索到的干扰项需要明显减少
 *    - 阈值：Delta ≤ -5%（即下降至少 5 个百分点）
 *    - 原因：高噪声会导致用户被错误答案误导，必须有效控制
 *
 * 5. GateErrorRate（门控错误率）- 门禁规则：gate_error_drop
 *    - 基准确则：系统判断是否需要回答的准确率需要显著提升
 *    - 阈值：Delta ≤ -10%（即下降至少 10 个百分点）
 *    - 原因：门控错误直接影响用户体验（该答不答令人沮丧，不该答却答传播错误）
 *
 * 门禁判定逻辑：
 * - 所有 5 项检查都必须通过（checks 全部为 true），门禁才算通过
 * - 任一检查失败，门禁判定为不通过（pass = false）
 * - 不通过的方案需要调优后重新评测
 *
 * 增量计算（Delta）：
 * - Delta = Candidate 值 - Baseline 值
 * - 正 Delta：对于 Recall/Precision/MRR 是好现象，对于 Noise/GateError 是坏现象
 * - 负 Delta：对于 Recall/Precision/MRR 是坏现象，对于 Noise/GateError 是好现象
 * ============================================================================
 *
 *
 * 读取标准 JSON 文件
 * @param {string} filePath - 文件路径
 * @returns {Object} 解析后的 JSON 对象
 */
function readJson(filePath) {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
}

/**
 * 执行上线门禁判定（Gate Check）
 *
 * 输入：
 *   - base: 基线汇总指标（baseline.summary）
 *   - cand: 候选汇总指标（candidate.summary）
 *
 * 输出：
 *   - pass: 是否通过门禁（所有检查项都通过）
 *   - checks: 每条门禁规则的检查结果
 *   - delta: 关键指标的增量值（candidate - baseline）
 *
 * 门禁规则说明：
 *   - recall_guard: 召回率允许轻微波动（≥-1%），但不能明显退化
 *   - precision_gain: 精确率需要实质提升（≥+3%）
 *   - mrr_gain: MRR 需要实质提升（≥+3%）
 *   - noise_drop: 噪声率需要下降（≤-5%）
 *   - gate_error_drop: 门控错误率需要显著下降（≤-10%）
 *
 * @param {Object} base - 基线汇总指标
 * @param {Object} cand - 候选汇总指标
 * @returns {Object} 门禁判定结果 { pass, checks, delta }
 */
function decide(base, cand) {
    // 计算各项指标增量（候选值 - 基线值）
    const dRecall = cand.recallAt5 - base.recallAt5;
    const dPrecision = cand.precisionAt5 - base.precisionAt5;
    const dMrr = cand.mrr - base.mrr;
    const dNoise = cand.noiseRate - base.noiseRate;
    const dGateErr = cand.gateErrorRate - base.gateErrorRate;

    // 定义门禁检查规则
    const checks = {
        recall_guard: dRecall >= -0.01,      // 召回率降幅不超过 1%
        precision_gain: dPrecision >= 0.03,  // 精确率提升至少 3%
        mrr_gain: dMrr >= 0.03,              // MRR 提升至少 3%
        noise_drop: dNoise <= -0.05,         // 噪声率下降至少 5%
        gate_error_drop: dGateErr <= -0.1    // 门控错误率下降至少 10%
    };

    // 只有当所有检查项都通过时，门禁才算通过
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

// 从命令行参数获取输入输出路径
const baselinePath = process.argv[2];
const candidatePath = process.argv[3];
const outPath = process.argv[4];

/**
 * 命令行用法：
 *   node eval/gate-rag-eval.js <baseline.json> <candidate.json> <out.json>
 *
 * 参数说明：
 *   - baseline.json: 基线评分结果（由 score-rag-eval.js 生成）
 *   - candidate.json: 候选评分结果（由 score-rag-eval.js 生成）
 *   - out.json: 输出的门禁判定结果路径
 */
if (!baselinePath || !candidatePath || !outPath) {
    process.stderr.write(
        'usage: node eval/gate-rag-eval.js <baseline.json> <candidate.json> <out.json>\n'
    );
    process.exit(1);
}

// 读取基线和候选的汇总指标（仅使用 summary 层做门禁判断）
const baseline = readJson(path.resolve(baselinePath)).summary;
const candidate = readJson(path.resolve(candidatePath)).summary;

// 执行门禁判定
const result = decide(baseline, candidate);

// 确保输出目录存在
fs.mkdirSync(path.dirname(path.resolve(outPath)), { recursive: true });

// 输出门禁判定结果（JSON 格式），供 CI 或人工复核使用
fs.writeFileSync(path.resolve(outPath), JSON.stringify(result, null, 2), 'utf-8');
process.stdout.write(`${outPath}\n`);
