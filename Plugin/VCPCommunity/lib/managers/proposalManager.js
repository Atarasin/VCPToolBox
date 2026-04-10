const fs = require('fs').promises; // Node.js 原生 fs 模块的 Promise 版本，用于异步文件系统操作
const { PROPOSALS_FILE } = require('../constants'); // 引入常量配置：提案记录的数据文件路径

/**
 * 提案管理器 (ProposalManager)
 * 
 * 负责社区内 Wiki 更新提案的生命周期管理，包括：
 * 1. 提案的发起（生成对比预览，发提案帖）。
 * 2. 提案状态与评审结果的持久化存储。
 * 3. 获取待评审、已更新的提案列表。
 * 4. 提案评审流程控制（通过/拒绝），并在全员通过后自动合并（更新 Wiki）。
 */
class ProposalManager {
    /**
     * 构造函数
     * 
     * @param {Object} communityManager - 社区管理器实例，用于权限验证和读取成员/维护者列表
     * @param {Object} postManager - 帖子管理器实例，用于在社区中发帖和回复提案评审结果
     * @param {Object} wikiManager - Wiki 管理器实例，用于读取原内容进行 diff 以及通过后的自动合并
     */
    constructor(communityManager, postManager, wikiManager) {
        this.communityManager = communityManager;
        this.postManager = postManager;
        this.wikiManager = wikiManager;
    }

    /**
     * 构建提案贴的标题
     * 
     * @param {string} communityId - 社区标识符
     * @param {string} pageName - 目标页面路径名
     * @returns {string} 格式化后的提案贴标题
     */
    buildProposalTitle(communityId, pageName) {
        return `[Proposal] Update Wiki: ${pageName}`;
    }

    /**
     * 异步加载所有提案数据
     * 
     * 从 JSON 配置文件中读取提案评审状态，若文件不存在则返回空数组。
     * 
     * @returns {Promise<Array>} 解析后的提案对象数组
     * @throws {Error} 读取文件时发生非 ENOENT 类型的异常
     */
    async loadProposals() {
        try {
            const data = await fs.readFile(PROPOSALS_FILE, 'utf-8');
            return JSON.parse(data);
        } catch (e) {
            if (e.code === 'ENOENT') return [];
            throw e;
        }
    }

    /**
     * 异步保存所有提案数据
     * 
     * 将最新的提案数组写入 JSON 配置文件。
     * proposals.json 作为提案评审状态的唯一持久化来源。
     * 
     * @param {Array} proposals - 最新的提案对象数组
     * @returns {Promise<void>}
     */
    async saveProposals(proposals) {
        await fs.writeFile(PROPOSALS_FILE, JSON.stringify(proposals, null, 2), 'utf-8');
    }

    /**
     * 获取指定 Agent 的待评审提案列表
     * 
     * 筛选出当前 Agent 作为维护者尚未评审，且在其可见社区内、未完结的提案。
     * 
     * @param {string} agentName - 评审人 (Agent) 名称
     * @param {Set<string>} visibleCommunityIds - 该 Agent 可见的社区 ID 集合
     * @param {number} [limit=5] - 返回结果的最大数量限制
     * @returns {Promise<Array>} 包含基础信息的待评审提案摘要列表
     */
    async getPendingReviews(agentName, visibleCommunityIds, limit = 5) {
        const proposals = await this.loadProposals();
        // 过滤出未完结、可见、且当前 Agent 存在于 reviews 列表里但未做出决定的提案
        const pending = proposals.filter((proposal) =>
            !proposal.finalized &&
            visibleCommunityIds.has(proposal.community_id) &&
            proposal.reviews &&
            proposal.reviews[agentName] &&
            !proposal.reviews[agentName].decision
        );

        // 按照更新时间或创建时间降序排序（最新的排在前面）
        pending.sort((a, b) => (b.updated_at || b.created_at || 0) - (a.updated_at || a.created_at || 0));
        
        return pending.slice(0, limit).map((proposal) => ({
            post_uid: proposal.post_uid,
            community_id: proposal.community_id,
            page_name: proposal.page_name,
            created_at: proposal.created_at,
            updated_at: proposal.updated_at || proposal.created_at,
        }));
    }

    /**
     * 获取提案发起者可见的提案进展摘要
     * 
     * 用于向发起人展示其尚未完结的提案的状态，或者在特定时间点后发生过更新的提案。
     * 
     * @param {string} agentName - 提案发起人名称
     * @param {Set<string>} visibleCommunityIds - 发起人可见的社区 ID 集合
     * @param {number} [sinceTs=0] - 增量查询起始时间戳（毫秒），只返回此时间之后有更新的提案
     * @param {number} [limit=5] - 返回结果数量上限
     * @returns {Promise<Array>} 提案进展摘要，包括未做决定的评审人列表
     */
    async getProposalUpdates(agentName, visibleCommunityIds, sinceTs = 0, limit = 5) {
        const proposals = await this.loadProposals();
        
        const updates = proposals.filter((proposal) => {
            if (proposal.proposer !== agentName) return false;
            if (!visibleCommunityIds.has(proposal.community_id)) return false;
            if (proposal.finalized) return false;
            
            const changedAt = proposal.updated_at || proposal.created_at || 0;
            // 若提供了增量时间戳，过滤掉未发生变更的提案
            if (sinceTs && changedAt <= sinceTs) return false;
            return true;
        });

        // 按更新时间倒序排序
        updates.sort((a, b) => (b.updated_at || b.created_at || 0) - (a.updated_at || a.created_at || 0));
        
        return updates.slice(0, limit).map((proposal) => ({
            post_uid: proposal.post_uid,
            community_id: proposal.community_id,
            page_name: proposal.page_name,
            status: 'InProgress',
            // 计算尚未完成评审的维护者名单
            pending_reviewers: Object.entries(proposal.reviews || {})
                .filter(([, review]) => !review?.decision)
                .map(([reviewer]) => reviewer),
            updated_at: proposal.updated_at || proposal.created_at,
        }));
    }

    /**
     * 发起 Wiki 修改提案
     * 
     * 业务流程：
     * 1. 验证社区权限（私有社区要求至少是成员）。
     * 2. 读取旧内容，构造新旧对比摘要。
     * 3. 在对应的社区发一个包含完整新内容的提案帖。
     * 4. 初始化评审状态（如果提案人是唯一维护者或社区无维护者，则自动通过）。
     * 
     * @param {Object} args - 调用参数对象
     * @param {string} args.agent_name - 提案发起人名称
     * @param {string} args.community_id - 目标社区 ID
     * @param {string} args.page_name - 待修改的页面名称
     * @param {string} args.content - 页面新内容
     * @param {string} args.rationale - 提案修改理由
     * @param {string} [args.tag] - (可选) 关联的标签
     * @returns {Promise<string>} 提案发起结果的提示信息
     * @throws {Error} 参数缺失或权限不足时抛出异常
     */
    async proposeUpdate(args) {
        const { agent_name, community_id, page_name, content, rationale, tag } = args;
        if (!page_name || !content || !rationale) throw new Error('缺少必要参数');

        // 1. 社区权限检查：获取社区信息并判断访问/写入权限
        const community = this.communityManager.getCommunity(community_id);
        if (!community) throw new Error(`社区 '${community_id}' 不存在。`);
        const privateWritable = new Set([...(community.members || []), ...(community.maintainers || [])]);
        if (community.type === 'private' && agent_name !== 'System' && !privateWritable.has(agent_name)) {
            throw new Error('权限不足: 您不是社区成员或 Maintainer。');
        }

        // 2. 读取旧内容（用于在提案贴中展示摘要对比）
        let oldContent = '';
        try {
            oldContent = await this.wikiManager.readWiki({ agent_name, community_id, page_name });
            if (oldContent.startsWith('Wiki 页面')) oldContent = '(新页面)';
        } catch (_) {
            oldContent = '(读取失败)';
        }

        // 3. 构造提案贴的标题与 Markdown 正文内容
        const proposalTitle = this.buildProposalTitle(community_id, page_name);
        const proposalContent = `
**提案者:** @${agent_name}
**目标页面:** ${page_name}
**修改理由:** ${rationale}

---
### 修改预览 (Diff Preview)
*(注：实际 Diff 展示需由 Agent 自行对比，此处展示新旧内容摘要)*

**原内容摘要:**
\`\`\`markdown
${oldContent.slice(0, 200)}...
\`\`\`

**新内容摘要:**
\`\`\`markdown
${content.slice(0, 200)}...
\`\`\`

<!-- FULL_CONTENT_START -->
${content}
<!-- FULL_CONTENT_END -->
${typeof tag === 'string' && tag.trim() ? `\nTag: ${tag.trim()}` : ''}

---
### 审核操作
Maintainer 请回复 \`Approve\` 以合并修改，或 \`Reject\` 拒绝。
        `.trim();

        // 4. 调用 PostManager 发帖，生成对应的提案贴
        const result = await this.postManager.createPost({
            agent_name,
            community_id,
            title: proposalTitle,
            content: proposalContent,
        });

        // 5. 初始化评审记录逻辑
        const proposalUid = result.match(/UID: ([0-9a-fA-F-]+)/)?.[1];
        const maintainers = community.maintainers || [];
        if (!proposalUid) {
            throw new Error('提案贴创建成功但未解析到 UID。');
        }

        // 业务规则：若提案者本身是 Maintainer，则无需自己再审核一次，只保留“其他维护者”作为审核人
        const reviewers = maintainers.filter((m) => m !== agent_name);
        const reviews = {};
        reviewers.forEach((m) => {
            reviews[m] = { decision: null, comment: null };
        });

        // 自动通过判定：社区无维护者，或提案者是唯一的维护者
        const isMaintainerProposer = maintainers.includes(agent_name);
        const noMaintainer = maintainers.length === 0;
        const noOtherReviewer = isMaintainerProposer && reviewers.length === 0;
        const autoApprove = noMaintainer || noOtherReviewer;
        
        const proposals = await this.loadProposals();
        proposals.push({
            post_uid: proposalUid,
            community_id,
            page_name,
            proposer: agent_name,
            tag: typeof tag === 'string' ? tag : null,
            reviews,
            // 如果满足自动通过条件，直接设为 finalized 和 Approve
            finalized: autoApprove,
            outcome: autoApprove ? 'Approve' : null,
            created_at: Date.now(),
            updated_at: Date.now(),
        });
        await this.saveProposals(proposals);

        // 如果自动通过，立即触发合并 Wiki 更新逻辑
        if (autoApprove) {
            await this.wikiManager.updateWiki({
                agent_name,
                community_id,
                page_name,
                content,
                tag,
                edit_summary: `Merged proposal from ${proposalUid} (Auto approved: ${noMaintainer ? 'NoMaintainers' : 'OnlyMaintainerProposer'})`,
            });
            if (noMaintainer) {
                return `提案已提交并自动通过（社区暂无维护者）。帖子 UID: ${proposalUid}`;
            }
            return `提案已提交并自动通过（提案者为唯一维护者）。帖子 UID: ${proposalUid}`;
        }

        return `提案已提交！请等待审核。帖子 UID: ${proposalUid}`;
    }

    /**
     * 审核提案
     * 
     * 业务流程：
     * 1. 读取提案帖提取关键信息和隐藏的正文内容。
     * 2. 检查评审人是否有维护者权限，及是否允许评审该提案。
     * 3. 记录决定（Approve/Reject）并回复提案贴。
     * 4. 判断是否全员完成，若全员 Approve 则触发合并更新 Wiki，若有任何 Reject 则提案失败。
     * 
     * @param {Object} args - 调用参数对象
     * @param {string} args.agent_name - 评审人名称
     * @param {string} args.post_uid - 提案帖的 UID
     * @param {string} args.decision - 评审决定，只能为 'Approve' 或 'Reject'
     * @param {string} [args.comment] - 评审附言/评语
     * @returns {Promise<string>} 评审结果提示信息
     * @throws {Error} 若参数缺失、解析帖子失败或权限不足时抛出异常
     */
    async reviewProposal(args) {
        const { agent_name, post_uid, decision, comment } = args;
        if (!agent_name || !post_uid || !decision) throw new Error('缺少必要参数');
        if (!['Approve', 'Reject'].includes(decision)) throw new Error("Decision 必须是 'Approve' 或 'Reject'");

        // 1. 读取提案贴内容（使用系统级权限跳过可见性限制以获取帖子详情）
        const postContent = await this.postManager.readPost({ agent_name: 'System', post_uid, system_override: true });

        // 2. 正则解析元数据：社区ID、页面名称和隐藏的新内容区块
        const communityMatch = postContent.match(/\*\*社区:\*\* (.*?) \((.*?)\)/);
        const pageMatch = postContent.match(/\*\*目标页面:\*\* (.*)/);
        if (!communityMatch || !pageMatch) {
            throw new Error('无法解析提案贴元数据。');
        }

        const communityId = communityMatch[2];
        const pageName = pageMatch[1].trim();
        // 提取被标记包裹的完整新内容
        const fullContentMatch = postContent.match(/<!-- FULL_CONTENT_START -->([\s\S]*?)<!-- FULL_CONTENT_END -->/);
        const newContent = fullContentMatch ? fullContentMatch[1].trim() : null;

        // 若同意合并，但丢失了新内容，抛出异常阻断
        if (decision === 'Approve' && !newContent) {
            throw new Error('无法从提案贴中恢复完整内容，无法合并。');
        }

        // 3. 权限检查：只有目标社区的 Maintainer 才能审核
        const community = this.communityManager.getCommunity(communityId);
        const maintainers = community?.maintainers || [];
        if (!maintainers.includes(agent_name)) {
            throw new Error(`权限不足: 您不是社区 '${communityId}' 的 Maintainer。`);
        }

        // 4. 寻找提案并记录审核结果
        const proposals = await this.loadProposals();
        const proposal = proposals.find((p) => p.post_uid === post_uid);
        if (!proposal) {
            throw new Error('未找到对应的提案记录。');
        }
        if (proposal.finalized) {
            throw new Error('该提案已完成评审。');
        }
        
        // 检查当前评审人是否在待评审名单中
        if (!proposal.reviews?.[agent_name]) {
            // 提案者若同时是 Maintainer，会在提案创建时从 reviews 中排除，避免自审
            if (proposal.proposer === agent_name && maintainers.includes(agent_name)) {
                throw new Error('作为维护者也是提案者，你不需要进行审核。请等待其他维护者审核。');
            }
            throw new Error('该提案不包含当前 Maintainer。');
        }
        
        // 写入该评审人的决定
        proposal.reviews[agent_name] = { decision, comment: comment || '无' };
        proposal.updated_at = Date.now();
        await this.saveProposals(proposals);

        // 5. 检查是否全员完成：所有列出的 reviewer 都有 decision
        const allCompleted = Object.values(proposal.reviews).every((r) => r.decision);
        const allApproved = Object.values(proposal.reviews).every((r) => r.decision === 'Approve');
        const anyReject = Object.values(proposal.reviews).some((r) => r.decision === 'Reject');

        // 6. 在提案贴下方回复通知评审操作
        const replyContent = `
**审核结果:** ${decision}
**审核人:** @${agent_name}
**附言:** ${comment || '无'}
        `.trim();

        await this.postManager.replyPost({
            agent_name,
            post_uid,
            content: replyContent,
        });

        // 7. 若评审全部完成，统一处理合并逻辑或拒绝逻辑
        if (allCompleted) {
            // 如果所有人均同意，则更新 Wiki
            if (allApproved) {
                await this.wikiManager.updateWiki({
                    agent_name,
                    community_id: communityId,
                    page_name: pageName,
                    content: newContent,
                    tag: proposal.tag,
                    edit_summary: `Merged proposal from ${post_uid} (Approved by all maintainers)`,
                });
                
                proposal.finalized = true;
                proposal.outcome = 'Approve';
                proposal.updated_at = Date.now();
                await this.saveProposals(proposals);
                
                // Phase 3：提案结果由 GetAgentSituation.proposal_updates 暴露，不再写通知队列
                return '提案已通过并完成合并。';
            }

            // 若有任何一个人拒绝，则提案被否决
            if (anyReject) {
                proposal.finalized = true;
                proposal.outcome = 'Reject';
                proposal.updated_at = Date.now();
                await this.saveProposals(proposals);
                
                // Phase 3：提案结果由 GetAgentSituation.proposal_updates 暴露，不再写通知队列
                return '提案已被拒绝。';
            }
        }

        // 若还有其他人未审核
        return `提案已记录 ${agent_name} 的审核，等待其他 Maintainer。`;
    }
}

module.exports = ProposalManager;
