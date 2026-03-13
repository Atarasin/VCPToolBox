const fs = require('fs').promises;
const {
    CONFIG_DIR,
    COMMUNITIES_FILE,
    DEFAULT_COMMUNITIES_FILE,
    POSTS_DIR,
    WIKI_DIR,
    PROPOSALS_FILE,
} = require('../constants');

/**
 * 社区管理器 (CommunityManager)
 * 负责管理社区配置、加载和保存社区列表，以及处理成员加入逻辑。
 */
class CommunityManager {
    constructor() {
        this.communities = [];
    }

    /**
     * 初始化社区运行目录与基础文件
     */
    async initStorage() {
        // 确保核心目录存在
        await fs.mkdir(CONFIG_DIR, { recursive: true });
        await fs.mkdir(POSTS_DIR, { recursive: true });
        await fs.mkdir(WIKI_DIR, { recursive: true });

        // 初始化 communities.json 并加载到内存
        await this.load();

        // 初始化提案文件
        await this.ensureJsonFile(PROPOSALS_FILE, []);

        return '社区初始化完成。';
    }

    /**
     * 初始化 JSON 文件（若不存在则创建）
     * @param {string} filePath 文件路径
     * @param {object|array} defaultValue 默认内容
     */
    async ensureJsonFile(filePath, defaultValue) {
        try {
            await fs.access(filePath);
        } catch (e) {
            if (e.code === 'ENOENT') {
                await fs.writeFile(filePath, JSON.stringify(defaultValue, null, 2), 'utf-8');
                return;
            }
            throw e;
        }
    }

    /**
     * 加载社区配置
     * 如果配置文件不存在，则尝试从默认模板初始化。
     */
    async load() {
        try {
            // 确保配置目录存在
            await fs.mkdir(CONFIG_DIR, { recursive: true });

            // 检查配置文件是否存在，不存在则初始化
            try {
                await fs.access(COMMUNITIES_FILE);
            } catch (e) {
                try {
                    // 从默认配置拷贝
                    const defaultConfig = await fs.readFile(DEFAULT_COMMUNITIES_FILE, 'utf-8');
                    await fs.writeFile(COMMUNITIES_FILE, defaultConfig, 'utf-8');
                } catch (copyError) {
                    console.warn(`[VCPCommunity] 无法初始化默认配置: ${copyError.message}`);
                    // 如果拷贝失败，创建一个空的默认配置
                    if (e.code === 'ENOENT') {
                        await fs.writeFile(COMMUNITIES_FILE, JSON.stringify({ communities: [] }, null, 2), 'utf-8');
                    }
                }
            }

            // 读取并解析配置文件
            const data = await fs.readFile(COMMUNITIES_FILE, 'utf-8');
            const config = JSON.parse(data);
            this.communities = config.communities || [];
        } catch (e) {
            console.error(`[VCPCommunity] 加载社区配置失败: ${e.message}`);
            this.communities = [];
        }
    }

    /**
     * 根据 ID 获取社区对象
     * @param {string} id 社区ID
     * @returns {object|undefined} 社区对象
     */
    getCommunity(id) {
        return this.communities.find((c) => c.id === id);
    }

    /**
     * 获取指定 Wiki 页面的元数据
     * @param {string} communityId 社区ID
     * @param {string} pageName 页面名称
     */
    getWikiPageMeta(communityId, pageName) {
        const community = this.getCommunity(communityId);
        if (!community) return null;
        return community.wiki_pages?.[pageName] || null;
    }

    /**
     * 初始化或更新 Wiki 页面元数据
     * @param {string} communityId 社区ID
     * @param {string} pageName 页面名称
     * @param {object} meta 元数据
     */
    async setWikiPageMeta(communityId, pageName, meta) {
        const community = this.getCommunity(communityId);
        if (!community) throw new Error(`社区 '${communityId}' 不存在。`);
        if (!community.wiki_pages) community.wiki_pages = {};
        community.wiki_pages[pageName] = { ...meta };
        await this.save();
    }

    /**
     * 列出指定 Agent 可见的社区列表
     * @param {string} agentName Agent名称
     * @returns {Array} 可见社区列表
     */
    listVisibleCommunities(agentName) {
        return this.communities.filter((c) => {
            // 公开社区对所有人可见
            if (c.type === 'public') return true;
            // 私有社区对成员和维护者可见
            return (c.members || []).includes(agentName) || (c.maintainers || []).includes(agentName);
        });
    }

    /**
     * Agent 申请加入社区
     * @param {string} agentName Agent名称
     * @param {string} communityId 社区ID
     */
    async joinCommunity(agentName, communityId) {
        const community = this.getCommunity(communityId);
        if (!community) {
            throw new Error(`社区 '${communityId}' 不存在。`);
        }
        if (community.type === 'public') {
            return `社区 '${community.name}' 是公开社区，无需加入。`;
        }
        if (community.members.includes(agentName)) {
            return `Agent '${agentName}' 已经是 '${community.name}' 的成员。`;
        }

        // 添加成员并保存
        community.members.push(agentName);
        await this.save();
        return `Agent '${agentName}' 成功加入社区 '${community.name}'。`;
    }

    /**
     * 创建社区
     * @param {object} args 参数对象 { agent_name, community_id, name, description, type, members, maintainers }
     */
    async createCommunity(args) {
        const { agent_name, community_id, name, description, type, members, maintainers } = args;
        if (!community_id || !name || !type) {
            throw new Error('参数缺失: 需要 community_id, name, type');
        }
        if (!['public', 'private'].includes(type)) {
            throw new Error("参数错误: type 必须是 'public' 或 'private'");
        }
        if (this.getCommunity(community_id)) {
            throw new Error(`社区 '${community_id}' 已存在。`);
        }

        // public 社区默认不维护成员与管理者列表
        // created_by/created_at 用于追踪社区创建来源
        const newCommunity = {
            id: community_id,
            name,
            description: description || '',
            type,
            members: type === 'public' ? [] : Array.isArray(members) ? members : [],
            maintainers: type === 'public' ? [] : Array.isArray(maintainers) ? maintainers : [],
            created_by: agent_name,
            created_at: Date.now(),
        };

        this.communities.push(newCommunity);
        await this.save();
        return `社区 '${name}' 创建成功。`;
    }

    /**
     * 保存当前社区配置到文件
     */
    async save() {
        await fs.writeFile(COMMUNITIES_FILE, JSON.stringify({ communities: this.communities }, null, 2), 'utf-8');
    }
}

module.exports = CommunityManager;
