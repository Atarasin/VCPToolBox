const fs = require('fs').promises;
const path = require('path');
const { execFile } = require('child_process');
const util = require('util');

const execFileAsync = util.promisify(execFile);

/**
 * 默认的搜索模板配置
 * 定义了常用的 GitHub 搜索场景，支持使用 ${DATE_XD} 变量动态替换日期
 * 
 * 模板说明:
 * - high_value_active_ai: 最近 7 天有代码提交且 Stars >= 1000 的 Python AI 项目 (TensorFlow/PyTorch/Transformers 等)
 * - latest_created_ai: 最近 30 天创建且 Stars >= 100 的 AI 新项目
 * - hot_recent_ai: 最近 7 天有更新且 Stars >= 500 的热门 AI 项目
 * - agent_framework_ai: 最近 14 天有更新的 Agent 框架类项目
 * - multimodal_ai: 最近 14 天有更新的多模态/视觉语言模型项目
 */
const DEFAULT_SEARCH_TEMPLATES = [
    {
        id: 'high_value_active_ai',
        label: '高价值活跃 AI 项目',
        sort: 'updated',
        weight: 3,
        limit: 3,
        queryTemplate:
            'topic:ai language:Python stars:>=1000 pushed:>=${DATE_7D} fork:false (tensorflow OR pytorch OR transformers OR langchain OR llamaindex)'
    },
    {
        id: 'latest_created_ai',
        label: '最新创建的 AI 项目',
        sort: 'updated',
        weight: 2,
        limit: 3,
        queryTemplate: 'topic:ai created:>=${DATE_30D} stars:>=100 fork:false'
    },
    {
        id: 'hot_recent_ai',
        label: '近期热门更新 AI 项目',
        sort: 'stars',
        weight: 2,
        limit: 3,
        queryTemplate: 'topic:ai pushed:>=${DATE_7D} stars:>=500 fork:false'
    },
    {
        id: 'agent_framework_ai',
        label: 'Agent 工具链项目',
        sort: 'updated',
        weight: 1,
        limit: 3,
        queryTemplate: 'topic:ai pushed:>=${DATE_14D} stars:>=200 fork:false (agent OR agents OR langgraph OR autogen)'
    },
    {
        id: 'multimodal_ai',
        label: '多模态 AI 项目',
        sort: 'updated',
        weight: 1,
        limit: 3,
        queryTemplate: 'topic:ai pushed:>=${DATE_14D} stars:>=200 fork:false (multimodal OR vision-language OR vlm)'
    }
];

/**
 * 将 Date 对象格式化为 YYYY-MM-DD 字符串
 * @param {Date} inputDate - 输入日期
 * @returns {string} 格式化后的日期字符串
 */
function toIsoDate(inputDate) {
    return inputDate.toISOString().slice(0, 10);
}

/**
 * 构建日期变量映射表
 * 用于在查询模板中动态替换时间范围
 * 
 * @param {Date} now - 当前时间基准
 * @returns {Object} 包含 DATE_1D, DATE_7D, DATE_14D, DATE_30D 等变量的对象
 */
function buildDateVariables(now) {
    const toDate = days => toIsoDate(new Date(now.getTime() - days * 24 * 60 * 60 * 1000));
    return {
        DATE_1D: toDate(1),
        DATE_7D: toDate(7),
        DATE_14D: toDate(14),
        DATE_30D: toDate(30)
    };
}

/**
 * 渲染查询模板
 * 将模板字符串中的 ${VARIABLE} 替换为实际值
 * 
 * @param {string} template - 包含变量占位符的模板字符串
 * @param {Object} variables - 变量映射表
 * @returns {string} 替换后的最终查询字符串
 */
function renderQueryTemplate(template, variables) {
    let output = String(template || '');
    for (const [key, value] of Object.entries(variables)) {
        output = output.replaceAll(`\${${key}}`, value);
    }
    return output;
}

/**
 * 解析模板 ID 列表
 * 支持逗号分隔字符串或数组形式
 * 
 * @param {string|Array} value - 输入的 ID 列表
 * @returns {Array<string>} 解析后的 ID 数组
 */
function parseTemplateIds(value) {
    if (Array.isArray(value)) {
        return value.map(item => String(item).trim()).filter(Boolean);
    }
    return String(value || '')
        .split(',')
        .map(item => item.trim())
        .filter(Boolean);
}

/**
 * 解析自定义模板 JSON 配置
 * 允许用户通过环境变量或参数传入额外的搜索模板
 * 
 * @param {string} rawValue - JSON 字符串
 * @param {Object} variables - 日期变量表，用于渲染自定义模板中的查询
 * @param {number} defaultLimit - 默认的搜索条数限制
 * @returns {Array<Object>} 解析并渲染后的模板配置数组
 * @throws {Error} 如果 JSON 格式错误或缺少必要字段
 */
function parseCustomTemplates(rawValue, variables, defaultLimit) {
    if (!rawValue) return [];
    let parsed;
    try {
        parsed = JSON.parse(rawValue);
    } catch (error) {
        throw new Error(`WECHAT_PUBLISHER_SEARCH_TEMPLATES_JSON 不是合法 JSON: ${error.message}`);
    }
    if (!Array.isArray(parsed)) {
        throw new Error('WECHAT_PUBLISHER_SEARCH_TEMPLATES_JSON 必须是数组');
    }
    return parsed
        .filter(item => item && typeof item === 'object')
        .map((item, index) => {
            const id = String(item.id || `custom_${index + 1}`).trim();
            const querySource = item.queryTemplate || item.query;
            const query = renderQueryTemplate(querySource, variables);
            if (!query) {
                throw new Error(`自定义模板 ${id} 缺少 query 或 queryTemplate`);
            }
            const sort = String(item.sort || 'updated').trim();
            const limitValue = Number.parseInt(item.limit, 10);
            const weightValue = Number.parseFloat(item.weight);
            return {
                id,
                label: String(item.label || id),
                sort,
                query,
                limit: Number.isFinite(limitValue) && limitValue > 0 ? limitValue : defaultLimit,
                weight: Number.isFinite(weightValue) && weightValue > 0 ? weightValue : 1
            };
        });
}

function parseTemplateNumericMap(rawValue, fieldName) {
    if (!rawValue) return {};
    let parsed;
    try {
        parsed = JSON.parse(rawValue);
    } catch (error) {
        throw new Error(`${fieldName} 不是合法 JSON: ${error.message}`);
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error(`${fieldName} 必须是对象，例如 {"template_id": 10}`);
    }
    const output = {};
    for (const [key, value] of Object.entries(parsed)) {
        const numeric = Number(value);
        if (Number.isFinite(numeric) && numeric > 0) {
            output[String(key).trim()] = numeric;
        }
    }
    return output;
}

/**
 * 构建最终的 GitHub 搜索配置列表
 * 流程：
 * 1. 生成日期变量
 * 2. 准备默认模板列表
 * 3. 解析自定义模板配置
 * 4. 合并所有模板（优先使用自定义覆盖默认）
 * 5. 根据指定的 templateIds 筛选最终使用的模板
 * 
 * @param {Date} [now=new Date()] - 当前时间
 * @param {Object} options - 配置项
 * @param {Array|string} [options.templateIds] - 指定启用的模板 ID 列表
 * @param {string} [options.customTemplatesJson] - 自定义模板 JSON 字符串
 * @param {number} [options.defaultLimit=20] - 默认搜索条数
 * @returns {Array<Object>} 筛选后的搜索配置数组
 */
function buildSearchQueries(now = new Date(), options = {}) {
    const defaultLimit = Number.isFinite(options.defaultLimit) ? options.defaultLimit : 20;
    const variables = buildDateVariables(now);
    const templateLimitMap = parseTemplateNumericMap(
        options.templateLimitsJson || process.env.WECHAT_PUBLISHER_TEMPLATE_LIMITS_JSON,
        'WECHAT_PUBLISHER_TEMPLATE_LIMITS_JSON'
    );
    const templateWeightMap = parseTemplateNumericMap(
        options.templateWeightsJson || process.env.WECHAT_PUBLISHER_TEMPLATE_WEIGHTS_JSON,
        'WECHAT_PUBLISHER_TEMPLATE_WEIGHTS_JSON'
    );
    const defaultTemplates = DEFAULT_SEARCH_TEMPLATES.map(item => ({
        id: item.id,
        label: item.label,
        sort: item.sort || 'updated',
        query: renderQueryTemplate(item.queryTemplate || item.query, variables),
        limit: Number.isFinite(item.limit) && item.limit > 0 ? item.limit : defaultLimit,
        weight: Number.isFinite(item.weight) && item.weight > 0 ? item.weight : 1
    }));
    const customTemplates = parseCustomTemplates(options.customTemplatesJson, variables, defaultLimit);
    const templateMap = new Map();
    for (const item of defaultTemplates) {
        templateMap.set(item.id, item);
    }
    for (const item of customTemplates) {
        templateMap.set(item.id, item);
    }
    const preferredIds = parseTemplateIds(options.templateIds || process.env.WECHAT_PUBLISHER_SEARCH_TEMPLATE_IDS);
    if (preferredIds.length === 0) {
        return Array.from(templateMap.values());
    }
    const selected = preferredIds
        .map(id => templateMap.get(id))
        .filter(Boolean);
    const finalTemplates = selected.length > 0 ? selected : Array.from(templateMap.values());
    return finalTemplates.map(item => ({
        ...item,
        limit: templateLimitMap[item.id] || item.limit || defaultLimit,
        weight: templateWeightMap[item.id] || item.weight || 1
    }));
}

/**
 * 调用 gh CLI 执行搜索
 * @param {string} query - 搜索语句
 * @param {string} sort - 排序字段
 * @param {number} limit - 限制返回条数
 * @returns {Promise<Array>} 搜索结果数组
 * @throws {Error} 如果 gh 命令执行失败或输出解析错误
 */
async function runGhSearch(query, sort, limit) {
    const args = [
        'search',
        'repos',
        query,
        '--sort',
        sort,
        '--order',
        'desc',
        '--limit',
        String(limit),
        '--json',
        'fullName,name,description,url,stargazersCount,forksCount,pushedAt,createdAt,language,owner'
    ];
    const { stdout } = await execFileAsync('gh', args, { maxBuffer: 1024 * 1024 * 8 });
    let parsed;
    try {
        parsed = JSON.parse(stdout || '[]');
    } catch (error) {
        throw new Error(`gh 输出 JSON 解析失败: ${error.message}`);
    }
    if (!Array.isArray(parsed)) {
        throw new Error('gh 输出格式异常，期望数组');
    }
    return parsed;
}

/**
 * 标准化仓库数据结构
 * @param {Object} repo - 原始仓库数据
 * @returns {Object} 标准化后的仓库对象
 */
function normalizeRepo(repo) {
    const ownerValue = repo.owner && typeof repo.owner === 'object' ? repo.owner.login : repo.owner;
    return {
        full_name: repo.fullName || repo.nameWithOwner || '',
        name: repo.name || '',
        description: repo.description || '',
        url: repo.url || '',
        stars: Number(repo.stargazersCount || repo.stargazerCount || 0),
        forks: Number(repo.forksCount || repo.forkCount || 0),
        created_at: repo.createdAt || '',
        pushed_at: repo.pushedAt || '',
        language: repo.language || (repo.primaryLanguage && repo.primaryLanguage.name ? repo.primaryLanguage.name : ''),
        owner: ownerValue || ''
    };
}

/**
 * 合并多个来源的仓库数据并按 Stars 去重
 * 如果同一个仓库在不同组中出现，保留 Stars 数较高的那个（理论上是一样的，但以防万一）
 * @param {Array<Array>} repoGroups - 仓库组列表
 * @returns {Array} 合并并按 Stars 降序排序后的数组
 */
function mergeAndDeduplicate(repoGroups) {
    const map = new Map();
    for (const group of repoGroups) {
        const repos = group.repos || [];
        const templateId = group.templateId || '';
        const templateWeight = Number(group.weight || 1);
        for (const repo of repos) {
            if (!repo.full_name) continue;
            const existing = map.get(repo.full_name);
            const nextTemplateIds = existing && Array.isArray(existing.template_ids) ? [...existing.template_ids] : [];
            if (templateId && !nextTemplateIds.includes(templateId)) {
                nextTemplateIds.push(templateId);
            }
            const nextWeightMax = Math.max(existing ? Number(existing.template_weight_max || 1) : 1, templateWeight);
            if (!existing || repo.stars > existing.stars) {
                map.set(repo.full_name, {
                    ...repo,
                    template_ids: nextTemplateIds,
                    template_weight_max: nextWeightMax
                });
            } else {
                map.set(repo.full_name, {
                    ...existing,
                    template_ids: nextTemplateIds,
                    template_weight_max: nextWeightMax
                });
            }
        }
    }
    return Array.from(map.values()).sort((a, b) => b.stars - a.stars);
}

function applyTemplateWeightRanking(repos) {
    return [...repos].sort((a, b) => {
        const aWeight = Number(a.template_weight_max || 1);
        const bWeight = Number(b.template_weight_max || 1);
        const aScore = Number(a.stars || 0) * aWeight;
        const bScore = Number(b.stars || 0) * bWeight;
        if (bScore !== aScore) return bScore - aScore;
        return Number(b.stars || 0) - Number(a.stars || 0);
    });
}

/**
 * 读取 JSON 文件，如果失败则返回默认值
 * @param {string} filePath - 文件路径
 * @param {any} fallbackValue - 默认值
 * @returns {Promise<any>} 解析后的 JSON 或默认值
 */
async function readJsonOrDefault(filePath, fallbackValue) {
    try {
        const raw = await fs.readFile(filePath, 'utf-8');
        const parsed = JSON.parse(raw);
        return parsed;
    } catch {
        return fallbackValue;
    }
}

/**
 * 根据时间窗口去重
 * 过滤掉最近 7 天内已经处理过的仓库
 * @param {Array} repos - 待过滤的仓库列表
 * @param {Object} dedupeMap - 去重记录映射表 { fullName: lastSeenTimestamp }
 * @param {Date} now - 当前时间
 * @param {boolean} force - 是否强制跳过去重
 * @returns {Array} 过滤后的仓库列表
 */
function filterByDeduplicateWindow(repos, dedupeMap, now, force) {
    const nowTs = now.getTime();
    const windowMs = 7 * 24 * 60 * 60 * 1000;
    const accepted = [];
    for (const repo of repos) {
        const lastSeen = Number(dedupeMap[repo.full_name] || 0);
        const inWindow = Number.isFinite(lastSeen) && nowTs - lastSeen < windowMs;
        if (force || !inWindow) {
            accepted.push(repo);
            dedupeMap[repo.full_name] = nowTs;
        }
    }
    return accepted;
}

/**
 * 确保目录存在
 * @param {string} dirPath - 目录路径
 */
async function ensureDir(dirPath) {
    await fs.mkdir(dirPath, { recursive: true });
}

/**
 * 抓取 GitHub 语料的主流程
 * 步骤:
 * 1. 准备目录
 * 2. 构建查询并并行执行
 * 3. 结果归一化、合并
 * 4. 基于历史记录去重 (7天窗口)
 * 5. 更新历史记录并保存快照
 * @param {Object} options - 配置选项
 * @returns {Promise<Object>} 抓取结果
 */
async function fetchGithubCorpus(options = {}) {
    const now = options.now || new Date();
    const force = Boolean(options.force);
    const limit = Number.isFinite(options.limit) ? options.limit : 20;
    const pluginRoot = options.pluginRoot || path.join(__dirname, '..');
    const logDir = path.join(pluginRoot, 'data', 'logs');
    const outputDir = path.join(pluginRoot, 'data', 'output');
    await ensureDir(logDir);
    await ensureDir(outputDir);

    const queries = buildSearchQueries(now, {
        templateIds: options.templateIds,
        customTemplatesJson: options.searchTemplatesJson,
        templateLimitsJson: options.templateLimitsJson,
        templateWeightsJson: options.templateWeightsJson,
        defaultLimit: limit
    });
    const rawGroups = [];
    for (const query of queries) {
        const rows = await runGhSearch(query.query, query.sort, query.limit || limit);
        rawGroups.push({
            templateId: query.id,
            weight: query.weight || 1,
            repos: rows.map(normalizeRepo)
        });
    }

    const merged = mergeAndDeduplicate(rawGroups);
    const dedupePath = path.join(logDir, 'dedupe.json');
    const dedupeMap = await readJsonOrDefault(dedupePath, {});
    const filtered = filterByDeduplicateWindow(merged, dedupeMap, now, force);
    const ranked = applyTemplateWeightRanking(filtered);
    await fs.writeFile(dedupePath, JSON.stringify(dedupeMap, null, 2), 'utf-8');

    const timestamp = now.toISOString().replace(/[:.]/g, '-');
    const snapshotPath = path.join(outputDir, `stage1-corpus-${timestamp}.json`);
    await fs.writeFile(
        snapshotPath,
        JSON.stringify(
            {
                fetched_at: now.toISOString(),
                query_templates: queries.map(item => ({
                    id: item.id,
                    label: item.label,
                    sort: item.sort,
                    limit: item.limit,
                    weight: item.weight
                })),
                total_raw: merged.length,
                total_selected: ranked.length,
                repos: ranked
            },
            null,
            2
        ),
        'utf-8'
    );

    return {
        fetchedAt: now.toISOString(),
        templateIds: queries.map(item => item.id),
        totalRaw: merged.length,
        totalSelected: ranked.length,
        repos: ranked,
        snapshotPath
    };
}

module.exports = {
    fetchGithubCorpus,
    buildSearchQueries,
    normalizeRepo,
    mergeAndDeduplicate,
    filterByDeduplicateWindow,
    applyTemplateWeightRanking
};
