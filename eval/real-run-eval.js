const fs = require('fs');
const path = require('path');

/**
 * ============================================================================
 * RAG 真实评测运行说明
 * ============================================================================
 *
 * 本脚本执行真实的 RAG 检索评测，输出用于计算 5 项核心指标的原始数据：
 *
 * 评测指标说明：
 *
 * 1. Recall@5（召回率@5）
 *    - 计算方式：统计 Top5 结果中至少包含一个金标的样本比例
 *    - 本脚本输出：gatePassed + topk 数组（供 score-rag-eval.js 计算）
 *    - 关键逻辑：isGatePassed() 检查 + resolveTopKFromEventsOrContent() 结果解析
 *
 * 2. Precision@5（精确率@5）
 *    - 计算方式：统计 Top5 结果中命中金标的数量 / 5，取平均值
 *    - 本脚本输出：完整的 topk 数组（供后续计算命中比例）
 *
 * 3. MRR（平均倒数排名）
 *    - 计算方式：首个金标命中位置的倒数（第 1 位=1，第 2 位=0.5，...）
 *    - 本脚本输出：带分数的 topk 数组，用于确定排名
 *
 * 4. NoiseRate（噪声率）
 *    - 计算方式：Top5 结果中命中硬负例的样本占比
 *    - 本脚本角色：执行真实检索，硬负例是否混入取决于检索质量
 *
 * 5. GateErrorRate（门控错误率）
 *    - 计算方式：系统判断是否需要回答的错误率
 *    - 本脚本角色：调用 ragPlugin.processMessages() 获取 gatePassed 结果
 *                 与评测集中的 gate_expect 对比判定
 *
 * 变体支持：
 * - baseline：基线方案，用于对比参照
 * - candidate：候选方案，通常包含参数调整或算法改进
 *
 * 输出格式：
 * - 输出到 eval/results/<variant>.json
 * - 每项包含：id, gatePassed, topk[{text, score}, ...]
 * ============================================================================
 */

// 运行时全局实例引用，用于最终的资源清理
let runtimeKnowledgeBaseManager = null;  // 知识库管理器实例
let runtimeRagPlugin = null;             // RAG 插件实例

/**
 * 读取 JSONL 文件（每行一个 JSON 对象）
 * @param {string} filePath - 文件路径
 * @returns {Array} 解析后的对象数组
 */
function readJsonl(filePath) {
    const text = fs.readFileSync(filePath, 'utf-8').trim();
    if (!text) return [];
    // 按行分割并逐行解析 JSON
    return text.split('\n').map(line => JSON.parse(line));
}

/**
 * 读取 JSON 文件
 * @param {string} filePath - 文件路径
 * @returns {Object} 解析后的 JSON 对象
 */
function readJson(filePath) {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
}

/**
 * 解析命令行参数
 * 支持格式：node script.js <variant> [--rag-params <path>] [--variant-config <path>]
 * @param {string[]} argv - 命令行参数数组
 * @returns {Object} 解析后的参数对象 { variant, ragParamsPath, variantConfigPath }
 */
function parseArgs(argv) {
    const args = { variant: null, ragParamsPath: null, variantConfigPath: null };
    // 第一个参数是变体名称（baseline 或 candidate）
    if (argv.length > 0) args.variant = argv[0];
    // 解析可选参数
    for (let i = 1; i < argv.length; i++) {
        if (argv[i] === '--rag-params' && argv[i + 1]) {
            args.ragParamsPath = argv[i + 1];
            i++;
        } else if (argv[i] === '--variant-config' && argv[i + 1]) {
            args.variantConfigPath = argv[i + 1];
            i++;
        }
    }
    return args;
}

/**
 * 加载指定变体的配置
 * @param {string} variantName - 变体名称（如 'baseline' 或 'candidate'）
 * @param {string} variantConfigPath - 变体配置文件路径
 * @returns {Object} 该变体的配置对象
 */
function loadVariantConfig(variantName, variantConfigPath) {
    if (!variantConfigPath) return {};
    const config = readJson(path.resolve(variantConfigPath));
    return config?.[variantName] || {};
}

/**
 * 应用变体环境变量配置
 * 将变体配置中的环境变量设置到 process.env
 * @param {Object} variantConfig - 变体配置对象
 */
function applyVariantEnv(variantConfig) {
    // 设置默认值为 false，避免启动时全量扫描知识库
    if (!process.env.KNOWLEDGEBASE_FULL_SCAN_ON_STARTUP) {
        process.env.KNOWLEDGEBASE_FULL_SCAN_ON_STARTUP = 'false';
    }
    // 应用变体配置中的环境变量覆盖
    const envPatch = variantConfig?.env || {};
    Object.entries(envPatch).forEach(([key, value]) => {
        if (value === null || value === undefined) return;
        process.env[key] = String(value);
    });
}

/**
 * 解析 RAG 参数文件路径
 * 优先级：命令行参数 > 变体配置 > 默认路径
 * @param {Object} args - 命令行参数对象
 * @param {Object} variantConfig - 变体配置对象
 * @returns {string} RAG 参数文件的绝对路径
 */
function resolveRagParamsPath(args, variantConfig) {
    if (args.ragParamsPath) {
        return path.resolve(args.ragParamsPath);
    }
    if (variantConfig?.ragParamsPath) {
        return path.resolve(variantConfig.ragParamsPath);
    }
    // 默认路径：上级目录下的 rag_params.json
    return path.join(__dirname, '..', 'rag_params.json');
}

/**
 * 从文本内容中提取列表项（以 * 开头的行）作为 Top-K 结果
 * @param {string} content - 文本内容
 * @param {number} maxItems - 最大提取数量
 * @returns {Array} 提取的列表项数组，每项包含 text 和 score
 */
function extractBulletTopK(content, maxItems = 10) {
    const lines = String(content || '').split('\n');
    const bullets = lines
        .map(line => line.trim())
        .filter(line => line.startsWith('* '))  // 筛选以 "* " 开头的行
        .map(line => line.replace(/^\*\s+/, '').trim())  // 去除 "* " 前缀
        .filter(Boolean)
        .slice(0, maxItems);
    // 为每个结果分配递减的分数（排名越靠前分数越高）
    return bullets.map((text, index) => ({
        text,
        score: Math.max(0.01, 1 - index * 0.05)
    }));
}

/**
 * 清理 Top-K 结果项，确保数据格式正确
 * @param {Object} item - 原始结果项
 * @returns {Object} 清理后的结果项 { text, score }
 */
function sanitizeTopKItem(item) {
    // 限制文本长度不超过 2000 字符
    const text = String(item?.text || '').trim().slice(0, 2000);
    // 确保分数是有限数值，否则默认为 0
    const score = Number.isFinite(item?.score) ? item.score : 0;
    return { text, score };
}

/**
 * 从事件或内容中解析 Top-K 检索结果
 * 优先从 RAG_RETRIEVAL_DETAILS 类型事件中获取，其次从内容文本中提取
 * @param {Array} events - 事件数组
 * @param {string} content - 备选文本内容
 * @returns {Array} Top-K 结果数组
 */
function resolveTopKFromEventsOrContent(events, content) {
    // 首先尝试从 RAG 检索详情事件中获取结果
    const detailEvents = events.filter(e => e && e.type === 'RAG_RETRIEVAL_DETAILS' && Array.isArray(e.results));
    if (detailEvents.length > 0) {
        // 使用最后一个检索详情事件的结果
        const last = detailEvents[detailEvents.length - 1];
        const topk = last.results.slice(0, 10).map(sanitizeTopKItem).filter(x => x.text.length > 0);
        if (topk.length > 0) return topk;
    }
    // 其次尝试从内容中提取列表项
    const bullets = extractBulletTopK(content, 10);
    if (bullets.length > 0) return bullets;
    // 最后将整个内容作为 fallback 返回
    const fallback = String(content || '').trim();
    if (!fallback) return [];
    return [{ text: fallback.slice(0, 2000), score: 0.1 }];
}

/**
 * 检查门控是否通过（内容是否非空）
 * @param {string} content - 待检查的内容
 * @returns {boolean} 是否通过
 */
function isGatePassed(content) {
    return String(content || '').trim().length > 0;
}

/**
 * 运行单个评测用例
 * @param {Object} item - 评测用例对象 { id, mode, query }
 * @param {Array} pushEvents - 用于收集事件的数组
 * @param {Object} ragPlugin - RAG 插件实例
 * @returns {Object} 评测结果 { id, gatePassed, topk }
 */
async function runSingleCase(item, pushEvents, ragPlugin) {
    // 构造消息：system 角色为 mode，user 角色为 query
    const systemContent = item.mode || '';
    const userContent = item.query || '';
    const messages = [
        { role: 'system', content: systemContent },
        { role: 'user', content: userContent }
    ];

    // 调用 RAG 插件处理消息
    const processed = await ragPlugin.processMessages(messages, {});
    // 提取处理后的 system 内容作为输出
    const outputSystem = (processed.find(m => m.role === 'system') || {}).content || '';
    // 解析 Top-K 结果
    const topk = resolveTopKFromEventsOrContent(pushEvents, outputSystem);
    // 检查门控是否通过
    const gatePassed = isGatePassed(outputSystem);

    return {
        id: item.id,
        gatePassed,
        topk
    };
}

/**
 * 主运行函数
 * 协调整个评测流程：加载配置、初始化组件、运行评测、输出结果
 */
async function run() {
    // 解析命令行参数
    const args = parseArgs(process.argv.slice(2));
    // 验证变体参数
    if (!args.variant || !['baseline', 'candidate'].includes(args.variant)) {
        process.stderr.write('usage: node eval/real-run-eval.js <baseline|candidate> [--rag-params <path>] [--variant-config <path>]\n');
        process.exit(1);
    }

    // 设置评测集和输出目录路径
    const evalSetPath = path.join(__dirname, 'rag_param_eval_set.jsonl');
    const outputDir = path.join(__dirname, 'results');
    fs.mkdirSync(outputDir, { recursive: true });  // 确保输出目录存在

    // 加载变体配置并应用环境变量
    const variantConfig = loadVariantConfig(args.variant, args.variantConfigPath);
    applyVariantEnv(variantConfig);

    // 加载知识库管理器和 RAG 插件
    const knowledgeBaseManager = require('../KnowledgeBaseManager');
    const ragPlugin = require('../Plugin/RAGDiaryPlugin/RAGDiaryPlugin');
    runtimeKnowledgeBaseManager = knowledgeBaseManager;
    runtimeRagPlugin = ragPlugin;

    // 定义 RAG 参数覆盖函数
    const applyRagParamsOverride = ragParams => {
        knowledgeBaseManager.ragParams = ragParams;
        ragPlugin.ragParams = ragParams;
    };

    // 解析并加载 RAG 参数
    const ragParamsPath = resolveRagParamsPath(args, variantConfig);
    const runtimeRagParams = readJson(ragParamsPath);

    // 加载评测数据集
    const evalSet = readJsonl(evalSetPath);
    const results = [];
    let currentEvents = [];

    // 定义事件推送回调函数，用于收集 RAG 检索过程中的事件
    const pushVcpInfo = payload => {
        try {
            // 深拷贝避免引用问题
            currentEvents.push(JSON.parse(JSON.stringify(payload)));
        } catch (_) {
            currentEvents.push(payload);
        }
    };

    // 应用 RAG 参数并初始化组件
    applyRagParamsOverride(runtimeRagParams);
    await knowledgeBaseManager.initialize();
    await ragPlugin.initialize({}, {
        vectorDBManager: knowledgeBaseManager,
        vcpLogFunctions: { pushVcpInfo }
    });
    // 再次应用参数（确保初始化后参数正确设置）
    applyRagParamsOverride(runtimeRagParams);

    // 遍历评测集，逐个运行评测用例
    for (const item of evalSet) {
        currentEvents = [];  // 重置当前事件收集器
        try {
            const row = await runSingleCase(item, currentEvents, ragPlugin);
            results.push(row);
        } catch (e) {
            // 记录错误信息作为评测结果
            results.push({
                id: item.id,
                gatePassed: false,
                topk: [{ text: `[EVAL_ERROR] ${e.message || e}`, score: 0 }]
            });
        }
    }

    // 将评测结果写入输出文件
    const outPath = path.join(outputDir, `${args.variant}.json`);
    fs.writeFileSync(outPath, JSON.stringify(results, null, 2), 'utf-8');
    process.stdout.write(`${outPath}\n`);
}

// 执行主函数并处理异常和资源清理
run()
    .catch(err => {
        console.error('[real-run-eval] failed:', err);
        process.exitCode = 1;
    })
    .finally(async () => {
        // 优雅关闭：确保资源被释放
        try {
            runtimeRagPlugin?.shutdown();
        } catch (_) {}
        try {
            await runtimeKnowledgeBaseManager?.shutdown();
        } catch (_) {}
    });
