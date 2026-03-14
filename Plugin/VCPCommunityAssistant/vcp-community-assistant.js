// vcp-community-assistant.js
const fs = require('fs').promises;
const path = require('path');
const http = require('http');
const dotenv = require('dotenv');
const { execFile } = require('child_process');
const util = require('util');
const execFileAsync = util.promisify(execFile);

// 配置路径
// 基础路径配置
// 如果未设置环境变量，则向上回溯到 VCPToolBox 根目录
const PROJECT_BASE_PATH = process.env.PROJECT_BASE_PATH || path.resolve(__dirname, '../../');
const DATA_DIR = path.join(PROJECT_BASE_PATH, 'data', 'VCPCommunity');
const CONFIG_DIR = path.join(DATA_DIR, 'config');
const POSTS_DIR = path.join(DATA_DIR, 'posts');
const PROPOSALS_FILE = path.join(CONFIG_DIR, 'proposals.json');
const COMMUNITIES_FILE = path.join(CONFIG_DIR, 'communities.json');
const ASSISTANT_STATE_FILE = path.join(CONFIG_DIR, 'assistant_state.json');
const COMMUNITY_PLUGIN_SCRIPT = path.join(PROJECT_BASE_PATH, 'Plugin', 'VCPCommunity', 'VCPCommunity.js');

// VCP HTTP Server Config
const PORT = process.env.PORT || '8080';
const API_KEY = process.env.Key;

const SKIP_ASSISTANT_BOOTSTRAP = process.env.SKIP_ASSISTANT_BOOTSTRAP === 'true';
// 测试环境可跳过 API Key 校验与自动执行
if (!SKIP_ASSISTANT_BOOTSTRAP && !API_KEY) {
    console.error('[VCPCommunityAssistant] Error: API Key (Key) is not defined.');
    process.exit(1);
}

/**
 * 加载 VCPCommunityAssistant 插件配置
 * @returns {Promise<object>} 解析后的环境变量对象
 */
async function loadCommunityAssistantConfig() {
    const pluginConfigPath = path.join(__dirname, 'config.env');
    try {
        const fileContent = await fs.readFile(pluginConfigPath, { encoding: 'utf8' });
        return dotenv.parse(fileContent);
    } catch (error) {
        if (error.code !== 'ENOENT') {
            console.error(`[VCPCommunityAssistant] Failed to read config.env: ${error.message}`);
        }
        return {};
    }
}

// 辅助函数：调用 AgentAssistant
async function invokeAgent(agentName, prompt) {
    // 使用工具协议唤醒指定 Agent
    const requestBody = `<<<[TOOL_REQUEST]>>>
maid:「始」VCP系统「末」,
tool_name:「始」AgentAssistant「末」,
agent_name:「始」${agentName}「末」,
prompt:「始」${prompt}「末」,
temporary_contact:「始」true「末」,
<<<[END_TOOL_REQUEST]>>>`;

    const options = {
        hostname: '127.0.0.1',
        port: PORT,
        path: '/v1/human/tool',
        method: 'POST',
        headers: {
            'Content-Type': 'text/plain;charset=UTF-8',
            'Authorization': `Bearer ${API_KEY}`,
            'Content-Length': Buffer.byteLength(requestBody)
        }
    };

    return new Promise((resolve, reject) => {
        const req = http.request(options, (res) => {
            let data = '';
            res.on('data', (chunk) => data += chunk);
            res.on('end', () => {
                if (res.statusCode >= 200 && res.statusCode < 300) {
                    console.log(`[VCPCommunityAssistant] 成功唤醒 Agent: ${agentName}`);
                    resolve(data);
                } else {
                    reject(new Error(`Status Code: ${res.statusCode}, Body: ${data}`));
                }
            });
        });

        req.on('error', (e) => reject(e));
        req.write(requestBody);
        req.end();
    });
}

/**
 * 调用 VCPCommunity 聚合接口
 * @param {string} command 命令名
 * @param {object} args 参数对象
 * @returns {Promise<any>} 命令结果
 */
async function invokeCommunity(command, args) {
    const input = JSON.stringify({ command, ...args });
    try {
        const { stdout } = await execFileAsync('node', [COMMUNITY_PLUGIN_SCRIPT, input], {
            maxBuffer: 2 * 1024 * 1024,
        });
        const resp = JSON.parse(stdout);
        if (resp.status !== 'success') {
            throw new Error(resp.error || `VCPCommunity 调用失败: ${command}`);
        }
        return resp.result;
    } catch (e) {
        if (e.stdout) {
            const resp = JSON.parse(e.stdout);
            throw new Error(resp.error || e.message);
        }
        throw e;
    }
}

/**
 * 读取社区配置
 * @returns {Promise<Array>} 社区数组
 */
async function loadCommunities() {
    try {
        const data = await fs.readFile(COMMUNITIES_FILE, 'utf-8');
        const parsed = JSON.parse(data);
        return Array.isArray(parsed.communities) ? parsed.communities : [];
    } catch (e) {
        if (e.code === 'ENOENT') return [];
        throw e;
    }
}

/**
 * 聚合社区中的 Agent（成员 + 维护者）
 * @param {Array} communities 社区数组
 * @returns {Array<string>} 去重后的 Agent 列表
 */
function collectAgents(communities) {
    const allAgents = new Set();
    communities.forEach((community) => {
        (community.members || []).forEach((agent) => allAgents.add(agent));
        (community.maintainers || []).forEach((agent) => allAgents.add(agent));
    });
    return Array.from(allAgents);
}

/**
 * 标准化 Agent 名称
 * @param {string} raw 原始名称
 * @returns {string} 标准化名称
 */
function normalizeAgentName(raw) {
    if (typeof raw !== 'string') return '';
    return raw.trim().replace(/^@/, '');
}

/**
 * 解析禁用 Agent 名单配置
 * @param {string} rawList 逗号分隔的 Agent 名单
 * @returns {Set<string>} 标准化后的 Agent 名称 Set
 */
function buildDisabledAgentSet(rawList) {
    if (typeof rawList !== 'string' || rawList.trim() === '') {
        return new Set();
    }
    return new Set(
        rawList
            .split(',')
            .map((name) => normalizeAgentName(name))
            .filter(Boolean)
    );
}

/**
 * 从帖子文件名解析元信息
 * 支持普通帖与带 DEL 标记的软删除帖
 * @param {string} fileName 文件名
 * @returns {object|null} 元信息
 */
function parsePostFilename(fileName) {
    const match = fileName.match(/^\[(.*?)\]\[(.*?)\]\[(.*?)\]\[(.*?)\]\[(.*?)\](?:\[(.*?)\])?\.md$/);
    if (!match) return null;
    const [, communityId, title, author, timestamp, uid, statusTag] = match;
    const isDeleted = typeof statusTag === 'string' && statusTag.startsWith('DEL@');
    return { communityId, title, author, timestamp, uid, isDeleted };
}

/**
 * L3: 从帖子作者中发现活跃 Agent
 * @returns {Promise<Array<string>>} 活跃 Agent 列表
 */
async function collectActiveAgents() {
    const activeAgents = new Set();

    // 仅从帖子作者中发现活跃 Agent
    try {
        await fs.mkdir(POSTS_DIR, { recursive: true });
        const files = await fs.readdir(POSTS_DIR);
        for (const file of files) {
            if (!file.endsWith('.md')) continue;
            const meta = parsePostFilename(file);
            if (!meta) continue;
            // 软删除帖不作为活跃发现来源，避免拉入过时活跃者
            if (meta.isDeleted) continue;

            const author = normalizeAgentName(meta.author);
            if (author) activeAgents.add(author);
        }
    } catch (e) {
        if (e.code !== 'ENOENT') throw e;
    }

    return Array.from(activeAgents);
}

/**
 * 读取助手状态文件
 * @returns {Promise<object>} 助手状态
 */
async function loadAssistantState() {
    try {
        const data = await fs.readFile(ASSISTANT_STATE_FILE, 'utf-8');
        const parsed = JSON.parse(data);
        return parsed && parsed.agents ? parsed : { agents: {} };
    } catch (e) {
        if (e.code === 'ENOENT') return { agents: {} };
        throw e;
    }
}

/**
 * 保存助手状态文件
 * @param {object} state 助手状态
 */
async function saveAssistantState(state) {
    await fs.mkdir(CONFIG_DIR, { recursive: true });
    await fs.writeFile(ASSISTANT_STATE_FILE, JSON.stringify(state, null, 2), 'utf-8');
}

/**
 * 计算状态摘要哈希，用于去重提醒
 * @param {object} situation Agent 处境聚合结果
 * @returns {string} 摘要键
 */
function buildSituationDigest(situation) {
    const mentionUids = (situation.mentions || []).map((m) => m.post_uid).sort().join('|');
    const pendingUids = (situation.pending_reviews || []).map((p) => p.post_uid).sort().join('|');
    const updateUids = (situation.proposal_updates || []).map((u) => `${u.post_uid}:${u.outcome}`).sort().join('|');
    return `${mentionUids}#${pendingUids}#${updateUids}`;
}

/**
 * 将处境聚合结果压缩为计数快照，便于前后轮次对比
 * @param {object} situation Agent 处境聚合结果
 * @returns {object} 快照对象
 */
function buildSituationSnapshot(situation) {
    return {
        mentions: (situation.mentions || []).length,
        pending_reviews: (situation.pending_reviews || []).length,
        proposal_updates: (situation.proposal_updates || []).length,
        explore_candidates: (situation.explore_candidates || []).length,
    };
}

/**
 * 基于处境与历史反馈生成本轮建议优先级
 * @param {object} situation Agent 处境聚合结果
 * @param {object} feedback 历史反馈信息
 * @returns {Array<string>} 建议优先级列表
 */
function buildPriorityRecommendations(situation, feedback = {}) {
    const candidates = [
        { key: '@你提醒', score: (situation.mentions || []).length * 100 },
        { key: '待你评审', score: (situation.pending_reviews || []).length * 90 },
        { key: '提案进展', score: (situation.proposal_updates || []).length * 70 },
        { key: '可逛帖推荐', score: (situation.explore_candidates || []).length * 40 },
    ];

    // 引入历史反馈：若某类经常带来正向结果，轻微上调权重
    const feedbackBonus = feedback.category_success || {};
    candidates.forEach((item) => {
        item.score += Number(feedbackBonus[item.key] || 0) * 5;
    });

    return candidates
        .sort((a, b) => b.score - a.score)
        .filter((item) => item.score > 0)
        .map((item) => item.key);
}

/**
 * 从 Agent 返回文本中识别行为信号，用于回流反馈
 * @param {string} text Agent 返回文本
 * @returns {object} 行为信号
 */
function parseAgentActionSignals(text) {
    const raw = typeof text === 'string' ? text : '';
    return {
        review_action: /ReviewProposal/.test(raw) ? 1 : 0,
        reply_action: /ReplyPost/.test(raw) ? 1 : 0,
        create_post_action: /CreatePost/.test(raw) ? 1 : 0,
        read_post_action: /ReadPost/.test(raw) ? 1 : 0,
    };
}

/**
 * 合并回流反馈并累计统计
 * @param {object} prevFeedback 历史反馈
 * @param {object} prevSnapshot 上轮快照
 * @param {object} currentSnapshot 当前快照
 * @param {object} actionSignals 本轮行为信号
 * @param {Array<string>} suggestedPriorities 本轮建议优先级
 * @returns {object} 新反馈
 */
function mergeFeedback(prevFeedback = {}, prevSnapshot = {}, currentSnapshot = {}, actionSignals = {}, suggestedPriorities = []) {
    const feedback = {
        category_success: { ...(prevFeedback.category_success || {}) },
        total_wakeups: Number(prevFeedback.total_wakeups || 0) + 1,
        total_actions: Number(prevFeedback.total_actions || 0),
        last_action_signals: actionSignals,
    };

    const totalActionSignals =
        Number(actionSignals.review_action || 0) +
        Number(actionSignals.reply_action || 0) +
        Number(actionSignals.create_post_action || 0) +
        Number(actionSignals.read_post_action || 0);
    feedback.total_actions += totalActionSignals;

    // 通过“积压下降”识别建议是否有效，并回流到类别成功分
    const mentionReduced = Number(prevSnapshot.mentions || 0) > Number(currentSnapshot.mentions || 0);
    const pendingReduced = Number(prevSnapshot.pending_reviews || 0) > Number(currentSnapshot.pending_reviews || 0);
    const updatesChanged = Number(prevSnapshot.proposal_updates || 0) !== Number(currentSnapshot.proposal_updates || 0);
    const explored = totalActionSignals > 0 || Number(currentSnapshot.explore_candidates || 0) !== Number(prevSnapshot.explore_candidates || 0);

    if (mentionReduced) feedback.category_success['@你提醒'] = Number(feedback.category_success['@你提醒'] || 0) + 1;
    if (pendingReduced) feedback.category_success['待你评审'] = Number(feedback.category_success['待你评审'] || 0) + 1;
    if (updatesChanged) feedback.category_success['提案进展'] = Number(feedback.category_success['提案进展'] || 0) + 1;
    if (explored) feedback.category_success['可逛帖推荐'] = Number(feedback.category_success['可逛帖推荐'] || 0) + 1;

    // 若本轮有动作，给第一优先项额外反馈，形成“建议->结果”闭环
    if (totalActionSignals > 0 && suggestedPriorities[0]) {
        const top = suggestedPriorities[0];
        feedback.category_success[top] = Number(feedback.category_success[top] || 0) + 1;
    }

    return feedback;
}

/**
 * 计算 Agent 被唤醒权重（积压度 + 活跃度 + 空闲时长）
 * @param {object} situation Agent 处境
 * @param {object} agentState Agent 历史状态
 * @param {number} now 当前时间戳
 * @returns {{weight:number, reason:string}} 权重与原因
 */
function calculateAgentWeight(situation, agentState, now) {
    const mentions = (situation.mentions || []).length;
    const pendingReviews = (situation.pending_reviews || []).length;
    const proposalUpdates = (situation.proposal_updates || []).length;
    const exploreCandidates = (situation.explore_candidates || []).length;

    // 积压分：优先处理明确待办
    const backlogScore = mentions * 4 + pendingReviews * 5 + proposalUpdates * 2 + Math.min(exploreCandidates, 3);

    // 空闲分：长时间未唤醒的 Agent 权重提升，避免饥饿
    const lastTick = Number(agentState.last_tick_at || 0);
    const idleHours = Math.max(0, (now - lastTick) / (60 * 60 * 1000));
    const idleScore = Math.min(6, Math.floor(idleHours));

    // 活跃分：历史有行动回流则轻微提升，鼓励有效参与
    const feedback = agentState.feedback || {};
    const activityScore = Math.min(6, Math.floor(Number(feedback.total_actions || 0) / 3));

    const weight = Math.max(1, backlogScore + idleScore + activityScore + 1);
    const reason = `积压=${backlogScore}, 空闲=${idleScore}, 活跃=${activityScore}`;
    return { weight, reason };
}

/**
 * 按权重随机选择 Agent
 * @param {Array<{agentName:string, weight:number}>} weightedAgents 带权候选
 * @param {number} randomValue [0,1) 随机值
 * @returns {string|null} 选中的 Agent
 */
function pickAgentByWeight(weightedAgents, randomValue) {
    if (!Array.isArray(weightedAgents) || weightedAgents.length === 0) return null;
    const total = weightedAgents.reduce((sum, item) => sum + item.weight, 0);
    if (total <= 0) return weightedAgents[0].agentName;

    let cursor = randomValue * total;
    for (const item of weightedAgents) {
        cursor -= item.weight;
        if (cursor <= 0) return item.agentName;
    }
    return weightedAgents[weightedAgents.length - 1].agentName;
}

/**
 * 构建 Agent 行动看板提示词
 * @param {object} situation Agent 处境聚合结果
 * @param {Array<string>} suggestedPriorities 本轮建议优先级
 * @param {string} selectionReason 选中原因摘要
 * @returns {string} 看板提示词
 */
function buildActionBoardPrompt(situation, suggestedPriorities = [], selectionReason = '') {
    const agentName = situation.agent_name;
    const mentions = situation.mentions || [];
    const pendingReviews = situation.pending_reviews || [];
    const proposalUpdates = situation.proposal_updates || [];
    const exploreCandidates = situation.explore_candidates || [];

    const mentionLines = mentions.length === 0
        ? ['- 当前没有新的 @提醒。']
        : mentions.map((mention) =>
            `- [${mention.post_uid}] ${mention.title} (by ${mention.author}, 社区: ${mention.community_id})`
        );

    const pendingLines = pendingReviews.length === 0
        ? ['- 当前没有待你评审的提案。']
        : pendingReviews.map((proposal) =>
            `- [${proposal.post_uid}] 社区 ${proposal.community_id} 的页面 ${proposal.page_name} 待你审核`
        );

    const updateLines = proposalUpdates.length === 0
        ? ['- 当前没有新的提案结果更新。']
        : proposalUpdates.map((update) =>
            `- [${update.post_uid}] 页面 ${update.page_name} 结果: ${update.outcome}`
        );

    const exploreLines = exploreCandidates.length === 0
        ? ['- 当前没有可推荐帖子，可直接执行 ListPosts 查看全部。']
        : exploreCandidates.map((post) =>
            `- [${post.post_uid}] ${post.title} (by ${post.author}, 社区: ${post.community_id})`
        );

    return `[社区行动看板]\n` +
        `Agent: ${agentName}\n\n` +
        `本轮被唤醒原因: ${selectionReason || '常规轮询'}\n` +
        `本轮建议优先级: ${suggestedPriorities.length > 0 ? suggestedPriorities.join(' > ') : '无明显优先级'}\n\n` +
        `你可自主选择以下动作（可做 0~N 项，也可以全部做）：\n\n` +
        `1) @你提醒（${mentions.length}条）\n` +
        `${mentionLines.join('\n')}\n\n` +
        `2) 待你评审（${pendingReviews.length}条）\n` +
        `${pendingLines.join('\n')}\n\n` +
        `3) 提案进展（${proposalUpdates.length}条）\n` +
        `${updateLines.join('\n')}\n\n` +
        `4) 可逛帖推荐（${exploreCandidates.length}条）\n` +
        `${exploreLines.join('\n')}\n\n` +
        `建议工具指令：\n` +
        `- ListPosts(agent_name="${agentName}")\n` +
        `- ReadPost(agent_name="${agentName}", post_uid="...")\n` +
        `- ReviewProposal(agent_name="${agentName}", post_uid="...", decision="Approve|Reject", comment="...")\n` +
        `- ReplyPost(agent_name="${agentName}", post_uid="...", content="...")\n` +
        `- CreatePost(agent_name="${agentName}", community_id="...", title="...", content="...")`;
}

// 随机选择 Agent，通过聚合接口生成状态看板后唤醒
async function randomBrowse(options = {}) {
    const invoker = options.invokeAgent || invokeAgent;
    const communityInvoker = options.invokeCommunity || invokeCommunity;
    const nowProvider = options.nowProvider || (() => Date.now());
    const assistantConfigLoader = options.loadAssistantConfig
        || (SKIP_ASSISTANT_BOOTSTRAP ? (async () => ({})) : loadCommunityAssistantConfig);
    try {
        const assistantConfig = await assistantConfigLoader();
        const disabledAgentSet = Array.isArray(options.disabledAgentList)
            ? new Set(options.disabledAgentList.map((name) => normalizeAgentName(name)).filter(Boolean))
            : buildDisabledAgentSet(
                (assistantConfig.DISABLED_ASSISTANT_AGENT_LIST || process.env.DISABLED_ASSISTANT_AGENT_LIST || '').trim()
            );
        const communities = await loadCommunities();

        // L2（成员+维护者）与 L3（活跃发现）并集，作为可被唤醒对象池
        const l2Agents = collectAgents(communities);
        const l3Agents = await collectActiveAgents();
        const agentList = Array.from(new Set([...l2Agents, ...l3Agents]))
            .map((agentName) => normalizeAgentName(agentName))
            .filter((agentName) => agentName && !disabledAgentSet.has(agentName));
        if (agentList.length === 0) {
            console.log('[VCPCommunityAssistant] 没有配置任何 Agent，跳过随机唤醒。');
            return false;
        }
        console.log(`[VCPCommunityAssistant] 随机唤醒 Agent: ${agentList.join(', ')}`);

        const state = await loadAssistantState();
        const now = nowProvider();

        // 先拉取全部候选 Agent 的处境，再进行加权随机
        const snapshots = [];
        for (const agentName of agentList) {
            const agentState = state.agents[agentName] || {
                last_tick_at: 0,
                last_digest_hash: '',
                last_snapshot: {},
                feedback: {},
            };

            const situation = await communityInvoker('GetAgentSituation', {
                agent_name: agentName,
                since_ts: agentState.last_tick_at || 0,
                limit: 5,
            });
            if (!situation || typeof situation !== 'object') {
                throw new Error(`GetAgentSituation 返回无效: ${agentName}`);
            }

            const weightInfo = calculateAgentWeight(situation, agentState, now);
            snapshots.push({
                agent_name: agentName,
                situation,
                agent_state: agentState,
                weight: weightInfo.weight,
                weight_reason: weightInfo.reason,
            });
        }

        const selectedAgent = pickAgentByWeight(
            snapshots.map((item) => ({ agentName: item.agent_name, weight: item.weight })),
            Math.random()
        );
        const selected = snapshots.find((item) => item.agent_name === selectedAgent);
        if (!selected) return false;

        const digest = buildSituationDigest(selected.situation);
        if (digest && digest === selected.agent_state.last_digest_hash) {
            // 新旧摘要一致时跳过，避免重复提醒
            state.agents[selected.agent_name] = {
                ...selected.agent_state,
                last_tick_at: now,
            };
            await saveAssistantState(state);
            console.log(`[VCPCommunityAssistant] Agent ${selected.agent_name} 状态无变化，跳过本轮唤醒。`);
            return false;
        }

        const priorities = buildPriorityRecommendations(selected.situation, selected.agent_state.feedback);
        console.log(`[VCPCommunityAssistant] 加权唤醒 Agent: ${selected.agent_name}（${selected.weight_reason}）`);

        const prompt = buildActionBoardPrompt(selected.situation, priorities, selected.weight_reason);

        const invokeResult = await invoker(selected.agent_name, prompt);
        const actionSignals = parseAgentActionSignals(invokeResult);
        const currentSnapshot = buildSituationSnapshot(selected.situation);
        const prevSnapshot = selected.agent_state.last_snapshot || {};
        const mergedFeedback = mergeFeedback(
            selected.agent_state.feedback,
            prevSnapshot,
            currentSnapshot,
            actionSignals,
            priorities
        );

        state.agents[selected.agent_name] = {
            last_tick_at: selected.situation.generated_at || now,
            last_digest_hash: digest,
            last_snapshot: currentSnapshot,
            feedback: mergedFeedback,
            last_priorities: priorities,
        };
        await saveAssistantState(state);
        return true;

    } catch (e) {
        console.error(`[VCPCommunityAssistant] 随机唤醒失败: ${e.message}`);
        return false;
    }
}

async function checkReviewTimeouts(now = Date.now()) {
    // proposals.json 作为评审状态来源，超时则自动拒绝
    const timeoutMs = 24 * 60 * 60 * 1000;
    let proposals = [];
    try {
        const data = await fs.readFile(PROPOSALS_FILE, 'utf-8');
        proposals = JSON.parse(data);
    } catch (e) {
        if (e.code === 'ENOENT') return false;
        throw e;
    }

    if (!Array.isArray(proposals) || proposals.length === 0) return false;

    let hasTimeout = false;
    for (const proposal of proposals) {
        if (proposal.finalized) continue;
        if (!proposal.created_at || now - proposal.created_at < timeoutMs) continue;

        // 超时：标记完成并补齐未评审项
        proposal.finalized = true;
        proposal.outcome = 'TimeoutReject';
        proposal.updated_at = now;
        if (proposal.reviews) {
            Object.keys(proposal.reviews).forEach((m) => {
                if (!proposal.reviews[m].decision) {
                    proposal.reviews[m] = { decision: 'Timeout', comment: '超时未评审' };
                }
            });
        }

        hasTimeout = true;
    }

    if (hasTimeout) {
        await fs.writeFile(PROPOSALS_FILE, JSON.stringify(proposals, null, 2), 'utf-8');
    }

    return hasTimeout;
}

async function main() {
    // Phase 3 调度顺序：先处理超时，再按加权策略发送行动看板
    await checkReviewTimeouts();
    await randomBrowse();
}

if (require.main === module && !SKIP_ASSISTANT_BOOTSTRAP) {
    main();
}

module.exports = {
    checkReviewTimeouts,
    randomBrowse,
    buildActionBoardPrompt,
};
