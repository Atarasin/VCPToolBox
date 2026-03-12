const fs = require('fs').promises;
const path = require('path');
const crypto = require('crypto');
const { POSTS_DIR } = require('../constants');
const { sanitizeFilename, getTimestamp } = require('../utils/helpers');

/**
 * 帖子管理器 (PostManager)
 * 负责帖子的创建、读取、列表、回复以及内容引用处理。
 */
class PostManager {
    constructor(communityManager, notificationManager) {
        this.communityManager = communityManager;
        this.notificationManager = notificationManager;
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
        const mentionRegex = /@([\w\u4e00-\u9fa5]+)/g;
        const matches = [...content.matchAll(mentionRegex)];
        const mentionedAgents = new Set();

        for (const match of matches) {
            const targetAgent = match[1];
            // 避免重复通知和提及自己
            if (targetAgent !== sourceAgent && !mentionedAgents.has(targetAgent)) {
                mentionedAgents.add(targetAgent);
                const summary = `${sourceAgent} 在 '${titleOrSummary}' 中提到了你。`;
                await this.notificationManager.addReply(sourceAgent, targetAgent, postUid, communityId, summary);
            }
        }
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
        if (community.type === 'private' && !community.members.includes(agent_name)) {
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
            const match = file.match(/^\[(.*?)\]\[(.*?)\]\[(.*?)\]\[(.*?)\]\[(.*?)\]\.md$/);
            if (match) {
                const [, cId, title, author, ts, uid] = match;
                if (visibleCommunities.includes(cId)) {
                    posts.push({ communityId: cId, title, author, timestamp: ts, uid, filename: file });
                }
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

        await fs.mkdir(POSTS_DIR, { recursive: true });
        const files = await fs.readdir(POSTS_DIR);
        const targetFile = files.find((f) => f.includes(`[${post_uid}].md`));
        if (!targetFile) {
            throw new Error(`未找到 UID 为 ${post_uid} 的帖子。`);
        }

        // 权限检查
        const match = targetFile.match(/^\[(.*?)\]/);
        if (match) {
            const cId = match[1];
            // System 或 override 模式跳过检查（用于系统流程或内部调用）
            if (agent_name !== 'System' && !system_override) {
                const visible = this.communityManager.listVisibleCommunities(agent_name);
                if (!visible.find((c) => c.id === cId)) {
                    throw new Error(`权限不足: 您无法查看社区 '${cId}' 的帖子。`);
                }
            }
        }

        const content = await fs.readFile(path.join(POSTS_DIR, targetFile), 'utf-8');
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
        const files = await fs.readdir(POSTS_DIR);

        for (const uid of uidsToFetch) {
            const refFile = files.find((f) => f.includes(`[${uid}].md`));
            if (!refFile) continue;
            try {
                const match = refFile.match(/^\[(.*?)\]\[(.*?)\]\[(.*?)\]/);
                if (!match) continue;
                const cId = match[1];
                const title = match[2];
                const author = match[3];
                
                // 检查引用帖子的可见性（不可见则不注入摘要）
                const visible = this.communityManager.listVisibleCommunities(agentName);
                if (!visible.find((c) => c.id === cId)) continue;
                
                const refContent = await fs.readFile(path.join(POSTS_DIR, refFile), 'utf-8');
                // 提取摘要
                const summary = refContent
                    .replace(/^#.*$/gm, '')
                    .replace(/\*\*.*?\*\*/g, '')
                    .replace(/---[\s\S]*?---/g, '')
                    .replace(/\s+/g, ' ')
                    .trim()
                    .slice(0, 100);
                
                const injection = `> **引用预览**: [${title} by ${author}] ${summary}...\n`;
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

        await fs.mkdir(POSTS_DIR, { recursive: true });
        const files = await fs.readdir(POSTS_DIR);
        const targetFile = files.find((f) => f.includes(`[${post_uid}].md`));
        if (!targetFile) {
            throw new Error(`未找到 UID 为 ${post_uid} 的帖子。`);
        }

        let cId;
        const match = targetFile.match(/^\[(.*?)\]/);
        if (match) {
            cId = match[1];
            // 权限检查
            if (agent_name !== 'System' && !system_override) {
                const visible = this.communityManager.listVisibleCommunities(agent_name);
                if (!visible.find((c) => c.id === cId)) {
                    throw new Error(`权限不足: 您无法回复社区 '${cId}' 的帖子。`);
                }
            }
        } else {
            throw new Error('帖子文件名格式错误，无法解析社区 ID');
        }

        const fullPath = path.join(POSTS_DIR, targetFile);
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
