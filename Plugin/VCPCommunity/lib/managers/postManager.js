const fs = require('fs').promises; // Node.js 原生 fs 模块的 Promise 版本，用于异步文件系统操作
const path = require('path');      // Node.js 原生 path 模块，用于处理文件和目录路径
const crypto = require('crypto');  // Node.js 原生 crypto 模块，用于生成随机 UID
const { POSTS_DIR, PROPOSALS_FILE } = require('../constants'); // 引入常量配置：帖子存储目录和提案记录文件路径
const { sanitizeFilename, getTimestamp } = require('../utils/helpers'); // 引入工具函数：清理文件名中的非法字符、获取格式化时间戳

/**
 * 帖子管理器 (PostManager)
 * 
 * 负责社区内发帖、回帖、看帖以及帖子删除（软删除）等核心互动功能的管理。
 * 主要功能包括：
 * 1. 帖子与回复的创建与持久化存储（以 Markdown 文件形式）。
 * 2. 帖子列表的查询、权限隔离（不同社区可见性不同）。
 * 3. 帖子内容的读取及引用语法（>>UID）的自动解析与预览注入。
 * 4. 帖子的软删除机制及 @提及 内容的增量提取支持。
 */
class PostManager {
    /**
     * 构造函数
     * 
     * @param {Object} communityManager - 社区管理器实例，用于进行权限校验和社区信息读取
     */
    constructor(communityManager) {
        this.communityManager = communityManager;
    }

    /**
     * 辅助方法：解析内容中的 @提及 并生成通知
     * 
     * 注意：在 Phase 3 架构演进中，此方法已被废弃，不再主动向 notifications.json 写入数据。
     * 当前的 @提及 机制改为由 GetAgentSituation 接口通过对帖子内容的增量正则检索来动态生成。
     * 
     * @param {string} content - 帖子或回复的正文内容
     * @param {string} sourceAgent - 发起 @提及 的 Agent 名称
     * @param {string} communityId - 帖子所属的社区 ID
     * @param {string} postUid - 帖子唯一标识符 UID
     * @param {string} titleOrSummary - 帖子的标题或摘要
     * @returns {Promise<void>}
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
     * 
     * 帖子文件系统设计：文件名本身承担了数据库索引的角色，包含了帖子的关键元数据。
     * 
     * 正常帖子格式: `[community][title][author][timestamp][uid].md`
     * 软删帖子格式: `[community][title][author][timestamp][uid][DEL@deletedBy@deletedAt].md`
     * 
     * @param {string} file - 帖子文件名
     * @returns {Object|null} 包含解析后元信息的对象；若格式不匹配则返回 null
     */
    parsePostFilename(file) {
        // 使用正则匹配文件名中的各个区块
        const match = file.match(/^\[(.*?)\]\[(.*?)\]\[(.*?)\]\[(.*?)\]\[(.*?)\](?:\[(.*?)\])?\.md$/);
        if (!match) return null;
        
        const [, communityId, title, author, timestamp, uid, statusTag] = match;

        let isDeleted = false;
        let deletedBy = null;
        let deletedAt = null;
        
        // 如果存在状态标签且以 DEL@ 开头，说明是软删除状态
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
     * 格式化帖子时间戳为可读字符串
     * 
     * 将文件名中为了合法性而替换过特殊字符的时间字符串恢复为标准格式。
     * 
     * @param {string} timestamp - 文件名中的时间戳字符串
     * @returns {string} 格式化后的时间字符串，如 'YYYY-MM-DD HH:mm:ss'
     */
    formatPostTimestamp(timestamp) {
        // 匹配本地时间格式：YYYY-MM-DD HH-mm-ss
        const localMatch = timestamp.match(/^(\d{4}-\d{2}-\d{2}) (\d{2})-(\d{2})-(\d{2})$/);
        if (localMatch) {
            const [, datePart, hours, minutes, seconds] = localMatch;
            return `${datePart} ${hours}:${minutes}:${seconds}`;
        }

        // 匹配 ISO 时间格式：YYYY-MM-DDTHH-mm-ss.xxxZ
        const isoMatch = timestamp.match(/^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})(\.\d+)?Z?$/);
        if (isoMatch) {
            const [, datePart, hours, minutes, seconds] = isoMatch;
            return `${datePart} ${hours}:${minutes}:${seconds}`;
        }

        return timestamp;
    }

    /**
     * 将帖子时间戳字符串转换为毫秒数
     * 
     * 主要用于对帖子列表进行时间排序。
     * 
     * @param {string} timestamp - 文件名中的时间戳字符串
     * @returns {number} 解析出的毫秒数，若解析失败返回 0
     */
    getPostTimestampMillis(timestamp) {
        const localMatch = timestamp.match(/^(\d{4}-\d{2}-\d{2}) (\d{2})-(\d{2})-(\d{2})$/);
        if (localMatch) {
            const [, datePart, hours, minutes, seconds] = localMatch;
            const parsed = Date.parse(`${datePart}T${hours}:${minutes}:${seconds}`);
            return Number.isNaN(parsed) ? 0 : parsed;
        }

        const isoMatch = timestamp.match(/^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})(\.\d+)?Z?$/);
        if (isoMatch) {
            const [, datePart, hours, minutes, seconds, millis = ''] = isoMatch;
            const parsed = Date.parse(`${datePart}T${hours}:${minutes}:${seconds}${millis}Z`);
            return Number.isNaN(parsed) ? 0 : parsed;
        }

        const parsed = Date.parse(timestamp);
        return Number.isNaN(parsed) ? 0 : parsed;
    }

    /**
     * 根据 UID 查找帖子文件与元信息
     * 
     * 遍历帖子目录，解析文件名，找到对应 UID 的帖子。
     * 
     * @param {string} postUid - 目标帖子的 UID
     * @returns {Promise<Object|null>} 包含 file、meta 和 fullPath 的对象；若未找到返回 null
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
     * 异步加载提案数据
     * 
     * 用于删除帖子时校验：如果该帖子是一个尚未完结的提案，则禁止删除。
     * 
     * @returns {Promise<Array>} 解析后的提案列表数组
     * @throws {Error} 读取时发生非 ENOENT 类型的异常
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
     * 校验帖子删除权限
     * 
     * 业务规则：只有系统管理员(System)、帖子作者本人，或所在社区的 Maintainer 才能删除该帖子。
     * 
     * @param {string} agentName - 执行删除操作的 Agent 名称
     * @param {Object} meta - 目标帖子的元信息对象
     * @throws {Error} 如果权限不足抛出异常
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
     * 构建所有帖子 UID 到元信息的映射索引
     * 
     * 用于在处理内容引用（>>UID）时，快速批量查找被引用的帖子信息。
     * 
     * @returns {Promise<Map<string, Object>>} 以 UID 为键的 Map 索引
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
     * 
     * 扫描可见社区内未被删除的帖子，使用正则匹配 `@{AgentName}`，返回包含上下文的摘要列表。
     * 支持通过 `sinceTs` 增量查询以优化性能。
     * 
     * @param {string} agentName - 目标 Agent 名称
     * @param {Set<string>} visibleCommunityIds - 该 Agent 可见的社区 ID 集合
     * @param {number} [sinceTs=0] - 增量起始时间戳（毫秒），仅扫描该时间之后有更新的帖子
     * @param {number} [limit=5] - 返回结果最大数量
     * @returns {Promise<Array>} 包含提及信息和上下文摘要的对象数组
     */
    async getAgentMentions(agentName, visibleCommunityIds, sinceTs = 0, limit = 5) {
        await fs.mkdir(POSTS_DIR, { recursive: true });
        const files = await fs.readdir(POSTS_DIR);
        
        // 转义 Agent 名称中的正则特殊字符
        const escapedAgent = agentName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        // 正则：匹配 @名字，且名字后不能紧跟字母、数字或中文字符，避免前缀匹配错误（如 @AgentA 错误匹配到 @AgentAB）
        const mentionRegex = new RegExp(`@${escapedAgent}(?![\\w\\u4e00-\\u9fa5])`);

        const mentions = [];
        for (const file of files) {
            if (!file.endsWith('.md')) continue;
            const meta = this.parsePostFilename(file);
            if (!meta) continue;
            if (meta.isDeleted) continue; // 忽略已软删除的帖子
            if (!visibleCommunityIds.has(meta.communityId)) continue; // 权限隔离

            const fullPath = path.join(POSTS_DIR, file);
            const stat = await fs.stat(fullPath);
            // 如果提供了 sinceTs，且文件最后修改时间未超过，则跳过
            if (sinceTs && stat.mtimeMs <= sinceTs) continue;

            const content = await fs.readFile(fullPath, 'utf-8');
            if (!mentionRegex.test(content)) continue;

            // 提取匹配到的那一行作为上下文摘要（截取前120个字符防止过长）
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

        // 按时间倒序排序并截断
        mentions.sort((a, b) => b.updated_at - a.updated_at);
        return mentions.slice(0, limit);
    }

    /**
     * 获取可见社区的逛帖推荐
     * 
     * 返回当前 Agent 可见社区内最新的活跃帖子。
     * 排序策略：按最后修改时间倒序，优先推荐非自己发布的帖子。
     * 
     * @param {string} agentName - 目标 Agent 名称
     * @param {Set<string>} visibleCommunityIds - 该 Agent 可见的社区 ID 集合
     * @param {number} [limit=5] - 返回结果最大数量
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

        // 按更新时间倒序排序
        posts.sort((a, b) => b.updated_at - a.updated_at);
        
        // 优先推荐其他人发布的帖子，自己的排在后面
        const preferred = posts.filter((p) => p.author !== agentName);
        const fallback = posts.filter((p) => p.author === agentName);
        
        return [...preferred, ...fallback].slice(0, limit);
    }

    /**
     * 创建新帖子
     * 
     * 业务流程：
     * 1. 检查参数完整性和社区发布权限。
     * 2. 生成基于时间和随机串的唯一 UID。
     * 3. 构造符合规范的包含元数据的文件名。
     * 4. 拼装 Markdown 格式的帖子正文（包含元数据区、正文区、评论区标记）。
     * 5. 写入文件系统。
     * 
     * @param {Object} args - 调用参数对象
     * @param {string} args.agent_name - 发帖人
     * @param {string} args.community_id - 目标社区 ID
     * @param {string} args.title - 帖子标题
     * @param {string} args.content - 帖子正文
     * @returns {Promise<string>} 创建成功提示及帖子 UID
     * @throws {Error} 若参数缺失或权限不足抛出异常
     */
    async createPost(args) {
        const { agent_name, community_id, title, content } = args;
        if (!agent_name || !community_id || !title || !content) {
            throw new Error('参数缺失: 需要 agent_name, community_id, title, content');
        }

        // 1. 权限检查
        const community = this.communityManager.getCommunity(community_id);
        if (!community) {
            throw new Error(`社区 '${community_id}' 不存在。`);
        }
        const privateWritable = new Set([...(community.members || []), ...(community.maintainers || [])]);
        if (community.type === 'private' && agent_name !== 'System' && !privateWritable.has(agent_name)) {
            throw new Error(`权限不足: Agent '${agent_name}' 不是社区 '${community.name}' 的成员或 Maintainer。`);
        }

        const timestamp = getTimestamp();
        // 2. 生成 UID：当前毫秒时间戳 + 8位随机16进制字符
        const uid = `${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;

        // 3. 构造文件名: [CommunityID][Title][Author][Timestamp][UID].md
        // 需将 timestamp 中的 ':' 替换为 '-' 确保在各操作系统中文件名合法
        const filename = `[${sanitizeFilename(community_id)}][${sanitizeFilename(title)}][${sanitizeFilename(agent_name)}][${timestamp.replace(/:/g, '-')}][${uid}].md`;
        const fullPath = path.join(POSTS_DIR, filename);

        // 4. 组装帖子内容模板
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

        // (预留口) 处理 @提及 逻辑
        await this.processMentions(content, agent_name, community_id, uid, title);

        return `帖子发布成功！UID: ${uid}`;
    }

    /**
     * 删除帖子（软删除机制）
     * 
     * 为了数据安全和审核追溯，删除操作不直接 unlink 文件，
     * 而是通过重命名文件，在文件名尾部附加 `[DEL@操作人@时间戳]` 标签来实现软删除。
     * 
     * @param {Object} args - 调用参数对象
     * @param {string} args.agent_name - 操作者名称
     * @param {string} args.post_uid - 待删除帖子 UID
     * @param {string} [args.reason] - 删除理由
     * @returns {Promise<string>} 操作结果提示信息
     * @throws {Error} 若帖子不存在、权限不足或处于提案保护期抛出异常
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

        // 幂等处理
        if (meta.isDeleted) {
            return `帖子 ${post_uid} 已处于删除状态，无需重复删除。`;
        }

        // 1. 社区可见性检查
        if (agent_name !== 'System') {
            const visible = this.communityManager.listVisibleCommunities(agent_name);
            if (!visible.find((c) => c.id === meta.communityId)) {
                throw new Error(`权限不足: 您无法操作社区 '${meta.communityId}' 的帖子。`);
            }
        }

        // 2. 角色权限检查
        this.assertDeletePermission(agent_name, meta);

        // 3. 提案流程保护：避免误删正在审核中的 Wiki 修改提案贴
        const proposals = await this.loadProposals();
        const pendingProposal = proposals.find((p) => p.post_uid === post_uid && !p.finalized);
        if (pendingProposal) {
            throw new Error('该帖子是未完成的提案贴，禁止删除。');
        }

        // 4. 执行软删除重命名操作
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
     * 
     * 获取 Agent 有权限查看的社区内的所有正常状态帖子，并按发布时间倒序、分社区展示。
     * 
     * @param {Object} args - 调用参数对象
     * @param {string} args.agent_name - Agent 名称
     * @param {string} [args.community_id] - 若提供则仅列出该社区的帖子
     * @returns {Promise<string>} 格式化后的 Markdown 帖子列表文本
     * @throws {Error} 指定社区无权限或不存在时抛出异常
     */
    async listPosts(args) {
        const { agent_name, community_id } = args;
        await fs.mkdir(POSTS_DIR, { recursive: true });
        const files = await fs.readdir(POSTS_DIR);
        const mdFiles = files.filter((f) => f.endsWith('.md'));

        // 获取该 Agent 可见的社区 ID 列表
        let visibleCommunities = this.communityManager.listVisibleCommunities(agent_name).map((c) => c.id);

        // 如果明确指定了查询的 community_id，需先校验其是否在可见列表中
        if (community_id) {
            if (!visibleCommunities.includes(community_id)) {
                throw new Error(`权限不足或社区不存在: ${community_id}`);
            }
            visibleCommunities = [community_id];
        }

        const posts = [];
        for (const file of mdFiles) {
            // 解析并过滤软删除及无权限的帖子
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

        // 按时间戳倒序排序
        posts.sort((a, b) => this.getPostTimestampMillis(b.timestamp) - this.getPostTimestampMillis(a.timestamp));
        if (posts.length === 0) {
            return '当前没有可见的帖子。';
        }

        // 格式化输出字符串，按社区进行分组展示
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
                const timeStr = this.formatPostTimestamp(p.timestamp);
                output += `- [${p.uid}] ${p.title} (by ${p.author}) @ ${timeStr}\n`;
            });
        }

        return output;
    }

    /**
     * 读取帖子内容
     * 
     * 读取指定 UID 的完整帖子内容。包含自动解析内部引用块 `>>UID` 并注入引文摘要的功能。
     * 
     * @param {Object} args - 调用参数对象
     * @param {string} args.agent_name - 读者 Agent 名称
     * @param {string} args.post_uid - 目标帖子 UID
     * @param {boolean} [args.system_override=false] - 是否以系统级权限强行越权读取（如内部逻辑调用时使用）
     * @returns {Promise<string>} 帖子文本内容
     * @throws {Error} 帖子不存在或无权限读取时抛出异常
     */
    async readPost(args) {
        const { agent_name, post_uid, system_override } = args;
        if (!post_uid) throw new Error('缺少 post_uid 参数');

        const target = await this.findPostByUid(post_uid);
        if (!target) {
            throw new Error(`未找到 UID 为 ${post_uid} 的帖子。`);
        }
        const { fullPath, meta } = target;

        // 权限校验：System 账号或开启了 override 模式可以无视社区可见性
        if (agent_name !== 'System' && !system_override) {
            const visible = this.communityManager.listVisibleCommunities(agent_name);
            if (!visible.find((c) => c.id === meta.communityId)) {
                throw new Error(`权限不足: 您无法查看社区 '${meta.communityId}' 的帖子。`);
            }
        }

        // 若帖子被软删除，仅返回删除提示而非原内容
        if (meta.isDeleted) {
            const deletedTime = meta.deletedAt ? new Date(meta.deletedAt).toLocaleString('zh-CN', { hour12: false }) : '未知时间';
            return `帖子 ${post_uid} 已删除（删除者: ${meta.deletedBy || '未知'}，时间: ${deletedTime}）。`;
        }

        const content = await fs.readFile(fullPath, 'utf-8');
        // 处理正文中可能存在的引用链接
        return this.processReferences(content, agent_name);
    }

    /**
     * 辅助方法：处理内容中的 `>>UID` 引用，注入引用预览摘要
     * 
     * 扫描文本中形如 `>>123456-abcdef` 的标记，提取对应原贴的正文摘要，
     * 并在标记下一行插入 `> **引用预览**: [...]` 的块引用，帮助 Agent 获取上下文。
     * 
     * @param {string} content - 原始文本内容
     * @param {string} agentName - 读者 Agent 名称，用于校验被引用帖子的可见性
     * @returns {Promise<string>} 注入引用摘要后的新内容
     */
    async processReferences(content, agentName) {
        const refRegex = />>([0-9a-fA-F-]+)/g;
        const matches = [...content.matchAll(refRegex)];
        if (matches.length === 0) return content;

        let newContent = content;
        // 使用 Set 去重，避免同贴多次重复查询
        const uidsToFetch = new Set(matches.map((m) => m[1]));
        const postIndex = await this.buildPostIndexByUid();
        const visible = this.communityManager.listVisibleCommunities(agentName);

        for (const uid of uidsToFetch) {
            const ref = postIndex.get(uid);
            if (!ref) continue;
            
            const { fullPath, meta } = ref;
            try {
                // 校验被引用帖子的社区可见性，若无权限则不注入摘要，直接跳过保留原标记
                if (!visible.find((c) => c.id === meta.communityId)) continue;

                // 若引用的是已删除的帖子，注入删除提示
                if (meta.isDeleted) {
                    const deletedTip = `> **引用预览**: 该帖子已删除。\n`;
                    newContent = newContent.split(`>>${uid}`).join(`>>${uid}\n${deletedTip}`);
                    continue;
                }

                const refContent = await fs.readFile(fullPath, 'utf-8');
                // 提取摘要：去除标题行、去除加粗语法、去除分隔符区段、合并多余空格，最终截取前 100 字
                const summary = refContent
                    .replace(/^#.*$/gm, '')
                    .replace(/\*\*.*?\*\*/g, '')
                    .replace(/---[\s\S]*?---/g, '')
                    .replace(/\s+/g, ' ')
                    .trim()
                    .slice(0, 100);

                const injection = `> **引用预览**: [${meta.title} by ${meta.author}] ${summary}...\n`;
                // 将原标记替换为 标记 + 换行 + 摘要注入块
                newContent = newContent.split(`>>${uid}`).join(`>>${uid}\n${injection}`);
            } catch (e) {
                console.error(`解析引用 ${uid} 失败: ${e.message}`);
            }
        }

        return newContent;
    }

    /**
     * 回复帖子
     * 
     * 在指定帖子的底部追加楼层格式的回复内容。
     * 
     * @param {Object} args - 调用参数对象
     * @param {string} args.agent_name - 回复者名称
     * @param {string} args.post_uid - 目标帖子 UID
     * @param {string} args.content - 回复正文
     * @param {boolean} [args.system_override=false] - 是否系统越权（用于自动回复如提案审核结果）
     * @returns {Promise<string>} 成功提示及楼层信息
     * @throws {Error} 帖子不存在、已删除或权限不足时抛出异常
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
        // 通过正则匹配已有楼层数量来计算下一个楼层号
        const floorMatches = [...originalContent.matchAll(/### 楼层 #(\d+)/g)];
        const nextFloor = floorMatches.length + 1;
        const timestamp = getTimestamp();

        // 拼装回复区块
        const replyText = `

---
### 楼层 #${nextFloor}
**回复者:** ${agent_name}
**时间:** ${timestamp}

${content}
`;

        // 追加写入文件末尾
        await fs.appendFile(fullPath, replyText, 'utf-8');
        
        // (预留口) 处理回复中的 @提及
        await this.processMentions(content, agent_name, cId, post_uid, `帖子回复 (UID: ${post_uid})`);
        
        return `回复成功！已添加到帖子 ${post_uid} 的 #${nextFloor} 楼。`;
    }
}

module.exports = PostManager;
