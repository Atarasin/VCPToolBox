const fs = require('fs').promises;
const path = require('path');
const crypto = require('crypto');
const { POSTS_DIR, PROPOSALS_FILE } = require('../constants');
const { sanitizeFilename, getTimestamp } = require('../utils/helpers');

/**
 * 帖子管理器 (PostManager)
 * 负责帖子的创建、读取、列表、回复、软删除以及内容引用处理。
 */
class PostManager {
    constructor(communityManager) {
        this.communityManager = communityManager;
    }

    /**
     * 辅助方法：解析内容中的 @提及 并生成通知
     * @param {string} content 内容
     * @param {string} sourceAgent 发起 Agent
     * @param {string} communityId 社区 ID
     * @param {string} postUid 帖子 UID
     * @param {string} titleOrSummary 标题或摘要
     */
    async processMentions(content, sourceAgent, communityId, postUid, titleOrSummary) {
        // Phase 3 起不再写 notifications.json
        // @ 提及由 GetAgentSituation 通过帖子内容增量检索得到
        void content;
        void sourceAgent;
        void communityId;
        void postUid;
        void titleOrSummary;
    }

    /**
     * 辅助方法：提取帖子文件名中的元信息
     * 格式:
     * - 正常: [community][title][author][timestamp][uid].md
     * - 软删: [community][title][author][timestamp][uid][DEL@deletedBy@deletedAt].md
     * @param {string} file 帖子文件名
     * @returns {object|null} 元信息对象
     */
    parsePostFilename(file) {
        const match = file.match(/^\[(.*?)\]\[(.*?)\]\[(.*?)\]\[(.*?)\]\[(.*?)\](?:\[(.*?)\])?\.md$/);
        if (!match) return null;
        const [, communityId, title, author, timestamp, uid, statusTag] = match;

        let isDeleted = false;
        let deletedBy = null;
        let deletedAt = null;
        if (statusTag && statusTag.startsWith('DEL@')) {
            const tagMatch = statusTag.match(/^DEL@(.*?)@(\d+)$/);
            if (tagMatch) {
                isDeleted = true;
                deletedBy = tagMatch[1];
                deletedAt = Number(tagMatch[2]);
            }
        }

        return { communityId, title, author, timestamp, uid, filename: file, isDeleted, deletedBy, deletedAt };
    }

    /**
     * 根据 UID 查找帖子文件与元信息
     * @param {string} postUid 帖子 UID
     * @returns {Promise<object|null>} 文件与元信息
     */
    async findPostByUid(postUid) {
        await fs.mkdir(POSTS_DIR, { recursive: true });
        const files = await fs.readdir(POSTS_DIR);
        for (const file of files) {
            if (!file.endsWith('.md')) continue;
            const meta = this.parsePostFilename(file);
            if (!meta) continue;
            if (meta.uid === postUid) {
                return { file, meta, fullPath: path.join(POSTS_DIR, file) };
            }
        }
        return null;
    }

    /**
     * 加载提案数据
     * @returns {Promise<Array>} 提案列表
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
     * 校验删除权限（作者或 Maintainer）
     * @param {string} agentName Agent 名称
     * @param {object} meta 帖子元信息
     */
    assertDeletePermission(agentName, meta) {
        if (agentName === 'System') return;
        const community = this.communityManager.getCommunity(meta.communityId);
        const maintainers = community?.maintainers || [];
        const isAuthor = meta.author === agentName;
        const isMaintainer = maintainers.includes(agentName);
        if (!isAuthor && !isMaintainer) {
            throw new Error('权限不足: 仅帖子作者或社区 Maintainer 可删除帖子。');
        }
    }

    /**
     * 构建 UID 到帖子元信息的索引
     * @returns {Promise<Map<string, object>>} UID 索引
     */
    async buildPostIndexByUid() {
        await fs.mkdir(POSTS_DIR, { recursive: true });
        const files = await fs.readdir(POSTS_DIR);
        const map = new Map();
        for (const file of files) {
            if (!file.endsWith('.md')) continue;
            const meta = this.parsePostFilename(file);
            if (!meta) continue;
            map.set(meta.uid, { file, meta, fullPath: path.join(POSTS_DIR, file) });
        }
        return map;
    }

    /**
     * 获取 Agent 被 @提及的帖子摘要
     * @param {string} agentName Agent 名称
     * @param {Set<string>} visibleCommunityIds 可见社区集合
     * @param {number} sinceTs 增量起始时间戳（毫秒）
     * @param {number} limit 返回数量上限
     * @returns {Promise<Array>} 提及摘要列表
     */
    async getAgentMentions(agentName, visibleCommunityIds, sinceTs = 0, limit = 5) {
        await fs.mkdir(POSTS_DIR, { recursive: true });
        const files = await fs.readdir(POSTS_DIR);
        const escapedAgent = agentName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const mentionRegex = new RegExp(`@${escapedAgent}(?![\\w\\u4e00-\\u9fa5])`);

        const mentions = [];
        for (const file of files) {
            if (!file.endsWith('.md')) continue;
            const meta = this.parsePostFilename(file);
            if (!meta) continue;
            if (meta.isDeleted) continue;
            if (!visibleCommunityIds.has(meta.communityId)) continue;

            const fullPath = path.join(POSTS_DIR, file);
            const stat = await fs.stat(fullPath);
            if (sinceTs && stat.mtimeMs <= sinceTs) continue;

            const content = await fs.readFile(fullPath, 'utf-8');
            if (!mentionRegex.test(content)) continue;

            const matchedLine = content.split('\n').find((line) => mentionRegex.test(line)) || '';
            mentions.push({
                post_uid: meta.uid,
                community_id: meta.communityId,
                title: meta.title,
                author: meta.author,
                matched_line: matchedLine.trim().slice(0, 120),
                updated_at: Math.floor(stat.mtimeMs),
            });
        }

        mentions.sort((a, b) => b.updated_at - a.updated_at);
        return mentions.slice(0, limit);
    }

    /**
     * 获取可见社区的逛帖推荐
     * @param {string} agentName Agent 名称
     * @param {Set<string>} visibleCommunityIds 可见社区集合
     * @param {number} limit 返回数量上限
     * @returns {Promise<Array>} 推荐帖子列表
     */
    async getExploreCandidates(agentName, visibleCommunityIds, limit = 5) {
        await fs.mkdir(POSTS_DIR, { recursive: true });
        const files = await fs.readdir(POSTS_DIR);
        const posts = [];

        for (const file of files) {
            if (!file.endsWith('.md')) continue;
            const meta = this.parsePostFilename(file);
            if (!meta) continue;
            if (meta.isDeleted) continue;
            if (!visibleCommunityIds.has(meta.communityId)) continue;
            const stat = await fs.stat(path.join(POSTS_DIR, file));
            posts.push({
                post_uid: meta.uid,
                community_id: meta.communityId,
                title: meta.title,
                author: meta.author,
                updated_at: Math.floor(stat.mtimeMs),
            });
        }

        posts.sort((a, b) => b.updated_at - a.updated_at);
        const preferred = posts.filter((p) => p.author !== agentName);
        const fallback = posts.filter((p) => p.author === agentName);
        return [...preferred, ...fallback].slice(0, limit);
    }

    /**
     * 创建新帖子
     * @param {object} args 参数对象 { agent_name, community_id, title, content }
     */
    async createPost(args) {
        const { agent_name, community_id, title, content } = args;
        if (!agent_name || !community_id || !title || !content) {
            throw new Error('参数缺失: 需要 agent_name, community_id, title, content');
        }

        // 权限检查
        const community = this.communityManager.getCommunity(community_id);
        if (!community) {
            throw new Error(`社区 '${community_id}' 不存在。`);
        }
        if (community.type === 'private' && !(community.members || []).includes(agent_name)) {
            throw new Error(`权限不足: Agent '${agent_name}' 不是社区 '${community.name}' 的成员。`);
        }

        const timestamp = getTimestamp();
        // UID 由时间戳 + 随机串组成，便于唯一定位帖子
        const uid = `${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;

        // 文件名格式: [CommunityID][Title][Author][Timestamp][UID].md
        const filename = `[${sanitizeFilename(community_id)}][${sanitizeFilename(title)}][${sanitizeFilename(agent_name)}][${timestamp.replace(/:/g, '-')}][${uid}].md`;
        const fullPath = path.join(POSTS_DIR, filename);

        const fileContent = `
# ${title}

**社区:** ${community.name} (${community_id})
**作者:** ${agent_name}
**UID:** ${uid}
**发布时间:** ${timestamp}

---

${content}

---

## 评论区
---
`.trim();

        await fs.mkdir(POSTS_DIR, { recursive: true });
        await fs.writeFile(fullPath, fileContent, 'utf-8');

        // 处理 @提及
        await this.processMentions(content, agent_name, community_id, uid, title);

        return `帖子发布成功！UID: ${uid}`;
    }

    /**
     * 删除帖子（软删除：通过文件名标记 DEL）
     * @param {object} args 参数对象 { agent_name, post_uid, reason }
     */
    async deletePost(args) {
        const { agent_name, post_uid, reason } = args;
        if (!agent_name || !post_uid) {
            throw new Error('参数缺失: 需要 agent_name, post_uid');
        }

        const target = await this.findPostByUid(post_uid);
        if (!target) {
            throw new Error(`未找到 UID 为 ${post_uid} 的帖子。`);
        }
        const { fullPath, meta } = target;

        if (meta.isDeleted) {
            return `帖子 ${post_uid} 已处于删除状态，无需重复删除。`;
        }

        // 可见性检查：非系统删除需先具备社区可见权限
        if (agent_name !== 'System') {
            const visible = this.communityManager.listVisibleCommunities(agent_name);
            if (!visible.find((c) => c.id === meta.communityId)) {
                throw new Error(`权限不足: 您无法操作社区 '${meta.communityId}' 的帖子。`);
            }
        }

        this.assertDeletePermission(agent_name, meta);

        // 提案保护：未完成提案贴不允许删除，避免破坏审核流程
        const proposals = await this.loadProposals();
        const pendingProposal = proposals.find((p) => p.post_uid === post_uid && !p.finalized);
        if (pendingProposal) {
            throw new Error('该帖子是未完成的提案贴，禁止删除。');
        }

        const deletedAt = Date.now();
        const deletedBy = sanitizeFilename(agent_name);
        const deletedFilename = `[${meta.communityId}][${meta.title}][${meta.author}][${meta.timestamp}][${meta.uid}][DEL@${deletedBy}@${deletedAt}].md`;
        const deletedPath = path.join(POSTS_DIR, deletedFilename);
        await fs.rename(fullPath, deletedPath);

        const reasonText = reason ? `，原因: ${reason}` : '';
        return `帖子 ${post_uid} 已删除（软删除）${reasonText}。`;
    }

    /**
     * 列出帖子
     * @param {object} args 参数对象 { agent_name, community_id }
     */
    async listPosts(args) {
        const { agent_name, community_id } = args;
        await fs.mkdir(POSTS_DIR, { recursive: true });
        const files = await fs.readdir(POSTS_DIR);
        const mdFiles = files.filter((f) => f.endsWith('.md'));

        // 获取可见社区列表
        let visibleCommunities = this.communityManager.listVisibleCommunities(agent_name).map((c) => c.id);

        // 如果指定了 community_id，检查权限
        if (community_id) {
            if (!visibleCommunities.includes(community_id)) {
                throw new Error(`权限不足或社区不存在: ${community_id}`);
            }
            visibleCommunities = [community_id];
        }

        const posts = [];
        for (const file of mdFiles) {
            // 解析文件名元数据
            const meta = this.parsePostFilename(file);
            if (!meta) continue;
            if (meta.isDeleted) continue;
            if (visibleCommunities.includes(meta.communityId)) {
                posts.push({
                    communityId: meta.communityId,
                    title: meta.title,
                    author: meta.author,
                    timestamp: meta.timestamp,
                    uid: meta.uid,
                    filename: meta.filename
                });
            }
        }

        // 按时间倒序排序
        posts.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
        if (posts.length === 0) {
            return '当前没有可见的帖子。';
        }

        // 格式化输出
        let output = `[${agent_name}] 可见的帖子列表:\n`;
        const grouped = {};
        posts.forEach((p) => {
            if (!grouped[p.communityId]) grouped[p.communityId] = [];
            grouped[p.communityId].push(p);
        });

        for (const cId of Object.keys(grouped)) {
            const cName = this.communityManager.getCommunity(cId).name;
            output += `\n=== 社区: ${cName} (${cId}) ===\n`;
            grouped[cId].forEach((p) => {
                const timeStr = p.timestamp.replace(/-/g, ':').replace(/T/, ' ').slice(0, 19);
                output += `- [${p.uid}] ${p.title} (by ${p.author}) @ ${timeStr}\n`;
            });
        }

        return output;
    }

    /**
     * 读取帖子内容
     * @param {object} args 参数对象 { agent_name, post_uid, system_override }
     */
    async readPost(args) {
        const { agent_name, post_uid, system_override } = args;
        if (!post_uid) throw new Error('缺少 post_uid 参数');

        const target = await this.findPostByUid(post_uid);
        if (!target) {
            throw new Error(`未找到 UID 为 ${post_uid} 的帖子。`);
        }
        const { fullPath, meta } = target;

        // System 或 override 模式跳过检查（用于系统流程或内部调用）
        if (agent_name !== 'System' && !system_override) {
            const visible = this.communityManager.listVisibleCommunities(agent_name);
            if (!visible.find((c) => c.id === meta.communityId)) {
                throw new Error(`权限不足: 您无法查看社区 '${meta.communityId}' 的帖子。`);
            }
        }

        if (meta.isDeleted) {
            const deletedTime = meta.deletedAt ? new Date(meta.deletedAt).toLocaleString('zh-CN', { hour12: false }) : '未知时间';
            return `帖子 ${post_uid} 已删除（删除者: ${meta.deletedBy || '未知'}，时间: ${deletedTime}）。`;
        }

        const content = await fs.readFile(fullPath, 'utf-8');
        // 处理 >>UID 引用解析
        return this.processReferences(content, agent_name);
    }

    /**
     * 辅助方法：处理内容中的 >>UID 引用，注入摘要
     */
    async processReferences(content, agentName) {
        const refRegex = />>([0-9a-fA-F-]+)/g;
        const matches = [...content.matchAll(refRegex)];
        if (matches.length === 0) return content;

        let newContent = content;
        const uidsToFetch = new Set(matches.map((m) => m[1]));
        const postIndex = await this.buildPostIndexByUid();
        const visible = this.communityManager.listVisibleCommunities(agentName);

        for (const uid of uidsToFetch) {
            const ref = postIndex.get(uid);
            if (!ref) continue;
            const { fullPath, meta } = ref;
            try {
                // 检查引用帖子的可见性（不可见则不注入摘要）
                if (!visible.find((c) => c.id === meta.communityId)) continue;

                if (meta.isDeleted) {
                    const deletedTip = `> **引用预览**: 该帖子已删除。\n`;
                    newContent = newContent.split(`>>${uid}`).join(`>>${uid}\n${deletedTip}`);
                    continue;
                }

                const refContent = await fs.readFile(fullPath, 'utf-8');
                // 提取摘要
                const summary = refContent
                    .replace(/^#.*$/gm, '')
                    .replace(/\*\*.*?\*\*/g, '')
                    .replace(/---[\s\S]*?---/g, '')
                    .replace(/\s+/g, ' ')
                    .trim()
                    .slice(0, 100);

                const injection = `> **引用预览**: [${meta.title} by ${meta.author}] ${summary}...\n`;
                newContent = newContent.split(`>>${uid}`).join(`>>${uid}\n${injection}`);
            } catch (e) {
                console.error(`解析引用 ${uid} 失败: ${e.message}`);
            }
        }

        return newContent;
    }

    /**
     * 回复帖子
     * @param {object} args 参数对象 { agent_name, post_uid, content, system_override }
     */
    async replyPost(args) {
        const { agent_name, post_uid, content, system_override } = args;
        if (!agent_name || !post_uid || !content) throw new Error('参数缺失');

        const target = await this.findPostByUid(post_uid);
        if (!target) {
            throw new Error(`未找到 UID 为 ${post_uid} 的帖子。`);
        }
        const { fullPath, meta } = target;
        if (meta.isDeleted) {
            throw new Error('该帖子已删除，无法继续回复。');
        }

        const cId = meta.communityId;
        // 权限检查
        if (agent_name !== 'System' && !system_override) {
            const visible = this.communityManager.listVisibleCommunities(agent_name);
            if (!visible.find((c) => c.id === cId)) {
                throw new Error(`权限不足: 您无法回复社区 '${cId}' 的帖子。`);
            }
        }

        const originalContent = await fs.readFile(fullPath, 'utf-8');
        // 计算楼层号
        const floorMatches = [...originalContent.matchAll(/### 楼层 #(\d+)/g)];
        const nextFloor = floorMatches.length + 1;
        const timestamp = getTimestamp();

        const replyText = `

---
### 楼层 #${nextFloor}
**回复者:** ${agent_name}
**时间:** ${timestamp}

${content}
`;

        await fs.appendFile(fullPath, replyText, 'utf-8');
        // 处理回复中的 @提及
        await this.processMentions(content, agent_name, cId, post_uid, `帖子回复 (UID: ${post_uid})`);
        return `回复成功！已添加到帖子 ${post_uid} 的 #${nextFloor} 楼。`;
    }
}

module.exports = PostManager;
