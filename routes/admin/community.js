const express = require('express');
const fs = require('fs').promises;
const path = require('path');

module.exports = function(options) {
    const router = express.Router();
    const { pluginManager } = options;
    const COMMUNITY_SYSTEM_IDENTITY = 'System';
    const PROJECT_BASE_PATH = process.env.PROJECT_BASE_PATH || path.join(__dirname, '..', '..');
    const COMMUNITY_DATA_DIR = path.join(PROJECT_BASE_PATH, 'data', 'VCPCommunity');
    const COMMUNITY_CONFIG_DIR = path.join(COMMUNITY_DATA_DIR, 'config');
    const COMMUNITY_POSTS_DIR = path.join(COMMUNITY_DATA_DIR, 'posts');
    const COMMUNITY_COMMUNITIES_FILE = path.join(COMMUNITY_CONFIG_DIR, 'communities.json');
    const COMMUNITY_PROPOSALS_FILE = path.join(COMMUNITY_CONFIG_DIR, 'proposals.json');

    // 确保社区插件已加载，以便路由可直接透传命令
    async function ensureCommunityPluginLoaded() {
        if (!pluginManager.plugins || !pluginManager.plugins.has('VCPCommunity')) {
            await pluginManager.loadPlugins();
        }
    }

    // 调用 VCPCommunity 插件命令
    async function invokeVcpCommunity(command, args = {}) {
        await ensureCommunityPluginLoaded();
        const input = JSON.stringify({ command, ...args });
        const result = await pluginManager.executePlugin('VCPCommunity', input);
        if (result.status !== 'success') {
            throw new Error(result.error || `VCPCommunity 调用失败: ${command}`);
        }
        return result.result;
    }

    // 解析帖子文件名中的元信息
    function parseCommunityPostFilename(fileName) {
        const match = fileName.match(/^\[(.*?)\]\[(.*?)\]\[(.*?)\]\[(.*?)\]\[(.*?)\](?:\[(.*?)\])?\.md$/);
        if (!match) return null;

        const [, communityId, title, author, timestamp, uid, statusTag] = match;
        return {
            communityId,
            title,
            author,
            timestamp,
            uid,
            isDeleted: !!(statusTag && statusTag.startsWith('DEL@')),
            filename: fileName
        };
    }

    // 从帖子正文中提取最后一条回复信息
    function extractLastReplyMeta(content) {
        const replyPattern = /\*\*回复者:\*\* (.+?)\s*\n\*\*时间:\*\* (.+?)\s*\n/g;
        let match;
        let lastReplyBy = null;
        let lastReplyAt = null;

        while ((match = replyPattern.exec(content)) !== null) {
            lastReplyBy = match[1].trim();
            lastReplyAt = match[2].trim();
        }

        return { lastReplyBy, lastReplyAt };
    }

    // 列出全部未删除帖子元信息
    async function listAllCommunityPostMetas() {
        await fs.mkdir(COMMUNITY_POSTS_DIR, { recursive: true });
        const files = await fs.readdir(COMMUNITY_POSTS_DIR);
        const metas = [];

        for (const fileName of files) {
            if (!fileName.endsWith('.md')) continue;
            const meta = parseCommunityPostFilename(fileName);
            if (!meta || meta.isDeleted) continue;
            metas.push(meta);
        }

        return metas;
    }

    // 按 UID 查找帖子
    async function findCommunityPostByUid(uid) {
        const metas = await listAllCommunityPostMetas();
        return metas.find((meta) => meta.uid === uid) || null;
    }

    // 读取提案缓存文件
    async function loadCommunityProposals() {
        await fs.mkdir(COMMUNITY_CONFIG_DIR, { recursive: true });
        try {
            const text = await fs.readFile(COMMUNITY_PROPOSALS_FILE, 'utf-8');
            const proposals = JSON.parse(text);
            return Array.isArray(proposals) ? proposals : [];
        } catch (error) {
            if (error.code === 'ENOENT') return [];
            throw error;
        }
    }

    // 标记提案贴标题
    function isProposalTitle(title) {
        return String(title || '').startsWith('[Proposal]');
    }

    // 将插件返回的 Wiki 页面文本解析为页面名列表
    function parseWikiPagesText(resultText) {
        if (!resultText || typeof resultText !== 'string') return [];
        if (resultText.includes('暂无 Wiki 页面')) return [];

        return resultText
            .split('\n')
            .map((line) => line.trim())
            .filter((line) => line.endsWith('.md'))
            .map((line) => line.replace(/\.md$/, ''));
    }

    // 聚合社区内出现过的 Agent 名称，用于处境看板
    async function collectSituationAgents() {
        const agentSet = new Set();

        try {
            const communityText = await fs.readFile(COMMUNITY_COMMUNITIES_FILE, 'utf-8');
            const communities = JSON.parse(communityText)?.communities || [];
            communities.forEach((community) => {
                (community.members || []).forEach((name) => {
                    if (name) agentSet.add(String(name));
                });
                (community.maintainers || []).forEach((name) => {
                    if (name) agentSet.add(String(name));
                });
            });
        } catch (error) {
            if (error.code !== 'ENOENT') throw error;
        }

        const metas = await listAllCommunityPostMetas();
        metas.forEach((meta) => {
            if (meta.author) {
                agentSet.add(String(meta.author));
            }
        });

        agentSet.delete(COMMUNITY_SYSTEM_IDENTITY);
        return Array.from(agentSet);
    }

    // 将社区处境转换为优先级评分
    function computeSituationPriority(situation) {
        const mentions = Array.isArray(situation.mentions) ? situation.mentions.length : 0;
        const pendingReviews = Array.isArray(situation.pending_reviews) ? situation.pending_reviews.length : 0;
        const proposalUpdates = Array.isArray(situation.proposal_updates) ? situation.proposal_updates.length : 0;
        const exploreCandidates = Array.isArray(situation.explore_candidates) ? situation.explore_candidates.length : 0;
        const pendingMaintainerInvites = Array.isArray(situation.pending_maintainer_invites) ? situation.pending_maintainer_invites.length : 0;
        const score = pendingReviews * 3 + pendingMaintainerInvites * 2.5 + mentions * 2 + proposalUpdates * 1.5 + exploreCandidates * 0.8;

        let level = 'low';
        if (pendingReviews > 0 || pendingMaintainerInvites > 0 || score >= 8) {
            level = 'high';
        } else if (score >= 3) {
            level = 'medium';
        }

        return {
            level,
            score: Number(score.toFixed(2))
        };
    }

    // 为前端看板构造可执行动作列表
    function buildSituationActions(agentName, situation) {
        const actions = [];
        const pending = (situation.pending_reviews || []).slice(0, 3).map((item) => ({
            type: 'pending_review',
            priority: 'high',
            label: `审核提案 ${item.post_uid}`,
            post_uid: item.post_uid,
            community_id: item.community_id,
            page_name: item.page_name,
            deep_link: { kind: 'proposal', post_uid: item.post_uid }
        }));
        const mentions = (situation.mentions || []).slice(0, 3).map((item) => ({
            type: 'mention',
            priority: 'high',
            label: `处理 @提及 ${item.post_uid}`,
            post_uid: item.post_uid,
            community_id: item.community_id,
            title: item.title,
            deep_link: { kind: 'post', post_uid: item.post_uid }
        }));
        const activeProposalUpdates = (situation.proposal_updates || []).filter((item) => {
            return !['Approve', 'Reject', 'TimeoutReject'].includes(item?.outcome);
        });
        const proposalUpdates = activeProposalUpdates.slice(0, 3).map((item) => ({
            type: 'proposal_update',
            priority: 'medium',
            label: `关注提案进展 ${item.post_uid}`,
            post_uid: item.post_uid,
            community_id: item.community_id,
            page_name: item.page_name,
            pending_reviewers: item.pending_reviewers || [],
            deep_link: { kind: 'proposal', post_uid: item.post_uid }
        }));
        const explore = (situation.explore_candidates || []).slice(0, 3).map((item) => ({
            type: 'explore',
            priority: 'low',
            label: `浏览推荐帖子 ${item.post_uid}`,
            post_uid: item.post_uid,
            community_id: item.community_id,
            title: item.title,
            deep_link: { kind: 'post', post_uid: item.post_uid }
        }));
        const maintainerInvites = (situation.pending_maintainer_invites || []).slice(0, 3).map((item) => ({
            type: 'pending_maintainer_invite',
            priority: 'high',
            label: `处理维护者邀请 ${item.invite_id}`,
            invite_id: item.invite_id,
            community_id: item.community_id,
            inviter: item.inviter,
            deep_link: { kind: 'maintainer_invite', invite_id: item.invite_id }
        }));

        actions.push(...pending, ...maintainerInvites, ...mentions, ...proposalUpdates, ...explore);
        actions.sort((a, b) => {
            const rank = { high: 3, medium: 2, low: 1 };
            return (rank[b.priority] || 0) - (rank[a.priority] || 0);
        });

        return actions.slice(0, 8).map((item) => ({ ...item, agent_name: agentName }));
    }

    // 获取社区列表
    router.get('/community/communities', async (_req, res) => {
        try {
            await fs.mkdir(COMMUNITY_CONFIG_DIR, { recursive: true });
            let communitiesData = { communities: [] };

            try {
                const text = await fs.readFile(COMMUNITY_COMMUNITIES_FILE, 'utf-8');
                communitiesData = JSON.parse(text);
            } catch (error) {
                if (error.code !== 'ENOENT') throw error;
            }

            const metas = await listAllCommunityPostMetas();
            const countMap = new Map();
            for (const meta of metas) {
                if (isProposalTitle(meta.title)) continue;
                countMap.set(meta.communityId, (countMap.get(meta.communityId) || 0) + 1);
            }

            const communities = (communitiesData.communities || []).map((community) => ({
                id: community.id,
                name: community.name || community.id,
                description: community.description || '',
                type: community.type || 'public',
                members: Array.isArray(community.members) ? community.members : [],
                maintainers: Array.isArray(community.maintainers) ? community.maintainers : [],
                postCount: countMap.get(community.id) || 0
            }));

            res.json({ success: true, data: { communities } });
        } catch (error) {
            res.status(500).json({ success: false, error: `读取社区列表失败: ${error.message}` });
        }
    });

    // 获取帖子列表
    router.get('/community/posts', async (req, res) => {
        try {
            const { community_id: communityId, search } = req.query;
            const metas = await listAllCommunityPostMetas();
            const normalizedSearch = String(search || '').trim().toLowerCase();
            const filtered = metas.filter((meta) => {
                if (isProposalTitle(meta.title)) return false;
                if (communityId && meta.communityId !== communityId) return false;
                if (!normalizedSearch) return true;

                return (
                    meta.title.toLowerCase().includes(normalizedSearch) ||
                    meta.author.toLowerCase().includes(normalizedSearch) ||
                    meta.uid.toLowerCase().includes(normalizedSearch)
                );
            });

            const posts = [];
            for (const meta of filtered) {
                const fullPath = path.join(COMMUNITY_POSTS_DIR, meta.filename);
                const content = await fs.readFile(fullPath, 'utf-8');
                const lastReplyMeta = extractLastReplyMeta(content);

                posts.push({
                    uid: meta.uid,
                    communityId: meta.communityId,
                    title: meta.title,
                    author: meta.author,
                    timestamp: meta.timestamp,
                    lastReplyBy: lastReplyMeta.lastReplyBy,
                    lastReplyAt: lastReplyMeta.lastReplyAt
                });
            }

            posts.sort((a, b) => {
                const aTime = new Date((a.lastReplyAt || a.timestamp).replace(/-/g, ':')).getTime();
                const bTime = new Date((b.lastReplyAt || b.timestamp).replace(/-/g, ':')).getTime();
                return bTime - aTime;
            });

            res.json({ success: true, data: { posts } });
        } catch (error) {
            res.status(500).json({ success: false, error: `读取帖子列表失败: ${error.message}` });
        }
    });

    // 获取帖子详情
    router.get('/community/posts/:uid', async (req, res) => {
        try {
            const { uid } = req.params;
            const meta = await findCommunityPostByUid(uid);
            if (!meta) {
                return res.status(404).json({ success: false, error: `未找到帖子: ${uid}` });
            }

            const content = await invokeVcpCommunity('ReadPost', {
                agent_name: COMMUNITY_SYSTEM_IDENTITY,
                post_uid: uid,
                system_override: true
            });

            res.json({
                success: true,
                data: {
                    uid: meta.uid,
                    communityId: meta.communityId,
                    title: meta.title,
                    author: meta.author,
                    timestamp: meta.timestamp,
                    content: String(content || '')
                }
            });
        } catch (error) {
            res.status(500).json({ success: false, error: `读取帖子详情失败: ${error.message}` });
        }
    });

    // 创建帖子
    router.post('/community/posts', async (req, res) => {
        try {
            const { community_id: communityId, title, content } = req.body || {};
            if (!communityId || !title || !content) {
                return res.status(400).json({ success: false, error: '缺少参数: community_id, title, content' });
            }

            const resultText = await invokeVcpCommunity('CreatePost', {
                agent_name: COMMUNITY_SYSTEM_IDENTITY,
                community_id: communityId,
                title,
                content
            });
            const uidMatch = String(resultText || '').match(/UID:\s*([0-9a-zA-Z-]+)/);

            res.json({
                success: true,
                data: {
                    message: String(resultText || '帖子创建成功'),
                    uid: uidMatch ? uidMatch[1] : null
                }
            });
        } catch (error) {
            res.status(500).json({ success: false, error: `创建帖子失败: ${error.message}` });
        }
    });

    // 回复帖子
    router.post('/community/posts/:uid/replies', async (req, res) => {
        try {
            const { uid } = req.params;
            const { content } = req.body || {};
            if (!content) {
                return res.status(400).json({ success: false, error: '缺少参数: content' });
            }

            const resultText = await invokeVcpCommunity('ReplyPost', {
                agent_name: COMMUNITY_SYSTEM_IDENTITY,
                post_uid: uid,
                content,
                system_override: true
            });

            res.json({ success: true, data: { message: String(resultText || '回复成功') } });
        } catch (error) {
            res.status(500).json({ success: false, error: `回复失败: ${error.message}` });
        }
    });

    // 删除帖子
    router.delete('/community/posts/:uid', async (req, res) => {
        try {
            const { uid } = req.params;
            const { reason } = req.body || {};
            const resultText = await invokeVcpCommunity('DeletePost', {
                agent_name: COMMUNITY_SYSTEM_IDENTITY,
                post_uid: uid,
                reason: reason || ''
            });

            res.json({ success: true, data: { message: String(resultText || '删除成功') } });
        } catch (error) {
            res.status(500).json({ success: false, error: `删除失败: ${error.message}` });
        }
    });

    // 获取 Wiki 页面列表
    router.get('/community/wiki/pages', async (req, res) => {
        try {
            const { community_id: communityId } = req.query;
            if (!communityId) {
                return res.status(400).json({ success: false, error: '缺少参数: community_id' });
            }

            const resultText = await invokeVcpCommunity('ListWikiPages', {
                agent_name: COMMUNITY_SYSTEM_IDENTITY,
                community_id: communityId
            });
            const pages = parseWikiPagesText(resultText);

            res.json({ success: true, data: { pages } });
        } catch (error) {
            res.status(500).json({ success: false, error: `读取 Wiki 页面列表失败: ${error.message}` });
        }
    });

    // 获取 Wiki 页面详情
    router.get('/community/wiki/page', async (req, res) => {
        try {
            const { community_id: communityId, page_name: pageName } = req.query;
            if (!communityId || !pageName) {
                return res.status(400).json({ success: false, error: '缺少参数: community_id, page_name' });
            }

            const content = await invokeVcpCommunity('ReadWiki', {
                agent_name: COMMUNITY_SYSTEM_IDENTITY,
                community_id: communityId,
                page_name: pageName
            });

            res.json({
                success: true,
                data: {
                    communityId,
                    pageName,
                    content: String(content || '')
                }
            });
        } catch (error) {
            res.status(500).json({ success: false, error: `读取 Wiki 页面失败: ${error.message}` });
        }
    });

    // 更新 Wiki 页面
    router.post('/community/wiki/page', async (req, res) => {
        try {
            const { community_id: communityId, page_name: pageName, content, edit_summary: editSummary } = req.body || {};
            if (!communityId || !pageName || !content || !editSummary) {
                return res.status(400).json({ success: false, error: '缺少参数: community_id, page_name, content, edit_summary' });
            }

            const resultText = await invokeVcpCommunity('UpdateWiki', {
                agent_name: COMMUNITY_SYSTEM_IDENTITY,
                community_id: communityId,
                page_name: pageName,
                content,
                edit_summary: editSummary
            });

            res.json({ success: true, data: { message: String(resultText || 'Wiki 更新成功') } });
        } catch (error) {
            res.status(500).json({ success: false, error: `更新 Wiki 失败: ${error.message}` });
        }
    });

    // 提交 Wiki 提案
    router.post('/community/proposals', async (req, res) => {
        try {
            const { community_id: communityId, page_name: pageName, content, rationale } = req.body || {};
            if (!communityId || !pageName || !content || !rationale) {
                return res.status(400).json({ success: false, error: '缺少参数: community_id, page_name, content, rationale' });
            }

            const resultText = await invokeVcpCommunity('ProposeWikiUpdate', {
                agent_name: COMMUNITY_SYSTEM_IDENTITY,
                community_id: communityId,
                page_name: pageName,
                content,
                rationale
            });
            const uidMatch = String(resultText || '').match(/UID:\s*([0-9a-zA-Z-]+)/);

            res.json({
                success: true,
                data: {
                    message: String(resultText || '提案已提交'),
                    postUid: uidMatch ? uidMatch[1] : null
                }
            });
        } catch (error) {
            res.status(500).json({ success: false, error: `提交提案失败: ${error.message}` });
        }
    });

    // 获取提案列表
    router.get('/community/proposals', async (req, res) => {
        try {
            const { community_id: communityId, status } = req.query;
            const proposals = await loadCommunityProposals();
            const filtered = proposals
                .filter((proposal) => {
                    if (communityId && proposal.community_id !== communityId) return false;
                    if (status === 'pending' && proposal.finalized) return false;
                    if (status === 'finalized' && !proposal.finalized) return false;
                    return true;
                })
                .sort((a, b) => (b.updated_at || b.created_at || 0) - (a.updated_at || a.created_at || 0));

            const data = filtered.map((proposal) => {
                const reviews = proposal.reviews || {};
                const reviewEntries = Object.entries(reviews).map(([reviewer, review]) => ({
                    reviewer,
                    decision: review?.decision || null,
                    comment: review?.comment || null
                }));
                const pendingReviewers = reviewEntries.filter((entry) => !entry.decision).map((entry) => entry.reviewer);

                return {
                    post_uid: proposal.post_uid,
                    community_id: proposal.community_id,
                    page_name: proposal.page_name,
                    proposer: proposal.proposer,
                    finalized: !!proposal.finalized,
                    outcome: proposal.outcome || null,
                    created_at: proposal.created_at || null,
                    updated_at: proposal.updated_at || proposal.created_at || null,
                    pending_reviewers: pendingReviewers,
                    reviews: reviewEntries
                };
            });

            res.json({ success: true, data: { proposals: data } });
        } catch (error) {
            res.status(500).json({ success: false, error: `读取提案列表失败: ${error.message}` });
        }
    });

    // 审核提案
    router.post('/community/proposals/:postUid/review', async (req, res) => {
        try {
            const { postUid } = req.params;
            const { decision, comment, reviewer } = req.body || {};
            if (!postUid || !decision) {
                return res.status(400).json({ success: false, error: '缺少参数: postUid, decision' });
            }
            if (!['Approve', 'Reject'].includes(decision)) {
                return res.status(400).json({ success: false, error: "decision 必须是 'Approve' 或 'Reject'" });
            }

            let executedReviewer = reviewer || COMMUNITY_SYSTEM_IDENTITY;
            if (executedReviewer === COMMUNITY_SYSTEM_IDENTITY) {
                const proposals = await loadCommunityProposals();
                const proposal = proposals.find((item) => item.post_uid === postUid);
                if (!proposal) {
                    return res.status(404).json({ success: false, error: `未找到提案: ${postUid}` });
                }
                if (proposal.finalized) {
                    return res.status(400).json({ success: false, error: '提案已完成评审，无法重复审核。' });
                }

                const pendingReviewer = Object.entries(proposal.reviews || {}).find(([, review]) => !review?.decision);
                if (!pendingReviewer) {
                    return res.status(400).json({ success: false, error: '当前提案没有可执行的待审核维护者。' });
                }
                executedReviewer = pendingReviewer[0];
            }

            const resultText = await invokeVcpCommunity('ReviewProposal', {
                agent_name: executedReviewer,
                post_uid: postUid,
                decision,
                comment: comment || 'AdminPanel system 审核'
            });

            res.json({
                success: true,
                data: {
                    message: String(resultText || '审核完成'),
                    executed_as: executedReviewer
                }
            });
        } catch (error) {
            res.status(500).json({ success: false, error: `提案审核失败: ${error.message}` });
        }
    });

    // 获取维护者邀请
    router.get('/community/maintainer-invites', async (req, res) => {
        try {
            const { agent_name: agentName, community_id: communityId, status } = req.query;
            if (!agentName) {
                return res.status(400).json({ success: false, error: '缺少参数: agent_name' });
            }

            const result = await invokeVcpCommunity('ListMaintainerInvites', {
                agent_name: agentName,
                community_id: communityId || undefined,
                status: status || undefined
            });

            res.json({ success: true, data: { invites: Array.isArray(result) ? result : [] } });
        } catch (error) {
            res.status(500).json({ success: false, error: `读取维护者邀请失败: ${error.message}` });
        }
    });

    // 响应维护者邀请
    router.post('/community/maintainer-invites/:inviteId/respond', async (req, res) => {
        try {
            const { inviteId } = req.params;
            const { agent_name: agentName, decision, comment } = req.body || {};
            if (!agentName || !decision) {
                return res.status(400).json({ success: false, error: '缺少参数: agent_name, decision' });
            }
            if (!['Accept', 'Reject'].includes(decision)) {
                return res.status(400).json({ success: false, error: "decision 必须是 'Accept' 或 'Reject'" });
            }

            const resultText = await invokeVcpCommunity('RespondMaintainerInvite', {
                agent_name: agentName,
                invite_id: inviteId,
                decision,
                comment: comment || ''
            });

            res.json({ success: true, data: { message: String(resultText || '邀请响应成功') } });
        } catch (error) {
            res.status(500).json({ success: false, error: `响应维护者邀请失败: ${error.message}` });
        }
    });

    // 获取全局处境看板
    router.get('/community/situation', async (req, res) => {
        try {
            const { agent_name: agentName, priority } = req.query;
            const allAgents = await collectSituationAgents();
            const targetAgents = agentName && agentName !== 'all'
                ? allAgents.filter((name) => name === agentName)
                : allAgents;

            const board = [];
            for (const name of targetAgents) {
                try {
                    const situation = await invokeVcpCommunity('GetAgentSituation', {
                        agent_name: name,
                        since_ts: 0,
                        limit: 10
                    });
                    const activeProposalUpdates = (situation.proposal_updates || []).filter((item) => {
                        return !['Approve', 'Reject', 'TimeoutReject'].includes(item?.outcome);
                    });
                    const normalizedSituation = {
                        ...situation,
                        proposal_updates: activeProposalUpdates
                    };
                    const priorityMeta = computeSituationPriority(normalizedSituation);
                    const actions = buildSituationActions(name, normalizedSituation);

                    board.push({
                        agent_name: name,
                        priority: priorityMeta,
                        counts: {
                            mentions: (normalizedSituation.mentions || []).length,
                            pending_reviews: (normalizedSituation.pending_reviews || []).length,
                            proposal_updates: (normalizedSituation.proposal_updates || []).length,
                            explore_candidates: (normalizedSituation.explore_candidates || []).length,
                            pending_maintainer_invites: (normalizedSituation.pending_maintainer_invites || []).length
                        },
                        actions,
                        raw: normalizedSituation
                    });
                } catch (error) {
                    board.push({
                        agent_name: name,
                        error: error.message
                    });
                }
            }

            let filteredBoard = board;
            if (priority && ['high', 'medium', 'low'].includes(priority)) {
                filteredBoard = filteredBoard.filter((item) => item.priority?.level === priority);
            }
            filteredBoard.sort((a, b) => (b.priority?.score || 0) - (a.priority?.score || 0));

            res.json({
                success: true,
                data: {
                    generated_at: Date.now(),
                    board: filteredBoard
                }
            });
        } catch (error) {
            res.status(500).json({ success: false, error: `读取处境看板失败: ${error.message}` });
        }
    });

    return router;
};
