const fs = require('fs').promises;
const { PROPOSALS_FILE } = require('../constants');

/**
 * 提案管理器 (ProposalManager)
 * 负责生成提案贴和处理提案审核（Approve/Reject）。
 */
class ProposalManager {
    constructor(communityManager, postManager, wikiManager, notificationManager) {
        this.communityManager = communityManager;
        this.postManager = postManager;
        this.wikiManager = wikiManager;
        this.notificationManager = notificationManager;
    }

    async loadProposals() {
        try {
            const data = await fs.readFile(PROPOSALS_FILE, 'utf-8');
            return JSON.parse(data);
        } catch (e) {
            if (e.code === 'ENOENT') return [];
            throw e;
        }
    }

    async saveProposals(proposals) {
        // proposals.json 作为提案评审状态的唯一来源
        await fs.writeFile(PROPOSALS_FILE, JSON.stringify(proposals, null, 2), 'utf-8');
    }

    /**
     * 提交 Wiki 修改提案
     * @param {object} args 参数对象 { agent_name, community_id, page_name, content, rationale }
     */
    async proposeUpdate(args) {
        const { agent_name, community_id, page_name, content, rationale } = args;
        if (!page_name || !content || !rationale) throw new Error('缺少必要参数');

        // 1. 社区权限检查
        const community = this.communityManager.getCommunity(community_id);
        if (!community) throw new Error(`社区 '${community_id}' 不存在。`);
        if (community.type === 'private' && !community.members.includes(agent_name)) {
            throw new Error('权限不足: 您不是社区成员。');
        }

        // 2. 读取旧内容（用于对比 Diff）
        let oldContent = '';
        try {
            oldContent = await this.wikiManager.readWiki({ agent_name, community_id, page_name });
            if (oldContent.startsWith('Wiki 页面')) oldContent = '(新页面)';
        } catch (_) {
            oldContent = '(读取失败)';
        }

        // 3. 生成提案贴内容
        const proposalTitle = `[Proposal] Update Wiki: ${page_name}`;
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

---
### 审核操作
Maintainer 请回复 \`Approve\` 以合并修改，或 \`Reject\` 拒绝。
        `.trim();

        // 4. 调用 PostManager 发帖
        const result = await this.postManager.createPost({
            agent_name,
            community_id,
            title: proposalTitle,
            content: proposalContent,
        });

        // 5. 自动通知 Maintainer，并初始化评审记录
        const proposalUid = result.match(/UID: ([0-9a-fA-F-]+)/)?.[1];
        const maintainers = community.maintainers || [];
        if (maintainers.length > 0 && proposalUid) {
            const reviews = {};
            maintainers.forEach((m) => {
                reviews[m] = { decision: null, comment: null };
            });

            const proposals = await this.loadProposals();
            proposals.push({
                post_uid: proposalUid,
                community_id,
                page_name,
                proposer: agent_name,
                reviews,
                finalized: false,
                outcome: null,
                created_at: Date.now(),
            });
            await this.saveProposals(proposals);

            const maintainerMentions = maintainers.map((m) => `@${m}`).join(' ');
            await this.postManager.replyPost({
                agent_name: 'System',
                post_uid: proposalUid,
                content: `请 ${maintainerMentions} 审核此提案。`,
                system_override: true,
            });

            const reviewSummary = `社区 ${community_id} 收到新的 Wiki 更新提案，请进行审核。`;
            for (const maintainer of maintainers) {
                await this.notificationManager.addReviewRequest(agent_name, maintainer, proposalUid, community_id, reviewSummary);
            }
        }

        return `提案已提交！请等待审核。帖子 UID: ${proposalUid}`;
    }

    /**
     * 审核提案
     * @param {object} args 参数对象 { agent_name, post_uid, decision, comment }
     */
    async reviewProposal(args) {
        const { agent_name, post_uid, decision, comment } = args;
        if (!agent_name || !post_uid || !decision) throw new Error('缺少必要参数');
        if (!['Approve', 'Reject'].includes(decision)) throw new Error("Decision 必须是 'Approve' 或 'Reject'");

        // 1. 读取提案贴内容
        const postContent = await this.postManager.readPost({ agent_name: 'System', post_uid, system_override: true });

        // 2. 解析元数据
        const communityMatch = postContent.match(/\*\*社区:\*\* (.*?) \((.*?)\)/);
        const pageMatch = postContent.match(/\*\*目标页面:\*\* (.*)/);
        const proposerMatch = postContent.match(/\*\*提案者:\*\*\s*@([^\s]+)/);
        if (!communityMatch || !pageMatch) {
            throw new Error('无法解析提案贴元数据。');
        }

        const communityId = communityMatch[2];
        const pageName = pageMatch[1].trim();
        const proposer = proposerMatch?.[1];
        // 提取完整内容（从提案贴中的标记段落读取）
        const fullContentMatch = postContent.match(/<!-- FULL_CONTENT_START -->([\s\S]*?)<!-- FULL_CONTENT_END -->/);
        const newContent = fullContentMatch ? fullContentMatch[1].trim() : null;

        if (decision === 'Approve' && !newContent) {
            throw new Error('无法从提案贴中恢复完整内容，无法合并。');
        }

        // 3. 权限检查 (Maintainer)
        const community = this.communityManager.getCommunity(communityId);
        const maintainers = community?.maintainers || [];
        if (!maintainers.includes(agent_name)) {
            throw new Error(`权限不足: 您不是社区 '${communityId}' 的 Maintainer。`);
        }

        // 4. 记录审核结果
        const proposals = await this.loadProposals();
        const proposal = proposals.find((p) => p.post_uid === post_uid);
        if (!proposal) {
            throw new Error('未找到对应的提案记录。');
        }
        if (proposal.finalized) {
            throw new Error('该提案已完成评审。');
        }
        if (!proposal.reviews?.[agent_name]) {
            throw new Error('该提案不包含当前 Maintainer。');
        }
        proposal.reviews[agent_name] = { decision, comment: comment || '无' };
        await this.saveProposals(proposals);

        // 5. 检查是否全员完成
        const allCompleted = Object.values(proposal.reviews).every((r) => r.decision);
        const allApproved = Object.values(proposal.reviews).every((r) => r.decision === 'Approve');
        const anyReject = Object.values(proposal.reviews).some((r) => r.decision === 'Reject');

        // 6. 回复通知
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

        // 7. 全员完成后统一处理结果并汇总评语
        if (allCompleted) {
            const reviewSummary = Object.entries(proposal.reviews)
                .map(([maintainer, info]) => `${maintainer}(${info.decision})=${info.comment || '无'}`)
                .join('; ');

            if (allApproved) {
                await this.wikiManager.updateWiki({
                    agent_name,
                    community_id: communityId,
                    page_name: pageName,
                    content: newContent,
                    edit_summary: `Merged proposal from ${post_uid} (Approved by all maintainers)`,
                });
                proposal.finalized = true;
                proposal.outcome = 'Approve';
                await this.saveProposals(proposals);

                if (proposer) {
                    const summary = `评审结果: 通过；评语汇总: ${reviewSummary}`;
                    await this.notificationManager.addReview(agent_name, proposer, post_uid, communityId, summary);
                }
                return '提案已通过并完成合并。';
            }

            if (anyReject) {
                proposal.finalized = true;
                proposal.outcome = 'Reject';
                await this.saveProposals(proposals);

                if (proposer) {
                    const summary = `评审结果: 拒绝；评语汇总: ${reviewSummary}`;
                    await this.notificationManager.addReview(agent_name, proposer, post_uid, communityId, summary);
                }
                return '提案已被拒绝。';
            }
        }

        return `提案已记录 ${agent_name} 的审核，等待其他 Maintainer。`;
    }
}

module.exports = ProposalManager;
