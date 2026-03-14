const fs = require('fs').promises;
const {
    CONFIG_DIR,
    COMMUNITIES_FILE,
    DEFAULT_COMMUNITIES_FILE,
    POSTS_DIR,
    WIKI_DIR,
    PROPOSALS_FILE,
    MAINTAINER_INVITES_FILE,
} = require('../constants');

/**
 * 社区管理器 (CommunityManager)
 * 负责管理社区配置、加载和保存社区列表，以及处理成员加入逻辑。
 */
class CommunityManager {
    constructor() {
        this.communities = [];
        this.maintainerInvites = [];
        this.maxMaintainers = 3;
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
        await this.ensureJsonFile(MAINTAINER_INVITES_FILE, []);
        await this.loadMaintainerInvites();

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

    async loadMaintainerInvites() {
        try {
            await fs.mkdir(CONFIG_DIR, { recursive: true });
            await this.ensureJsonFile(MAINTAINER_INVITES_FILE, []);
            const data = await fs.readFile(MAINTAINER_INVITES_FILE, 'utf-8');
            const parsed = JSON.parse(data);
            this.maintainerInvites = Array.isArray(parsed) ? parsed : [];
        } catch (e) {
            this.maintainerInvites = [];
        }
    }

    async saveMaintainerInvites() {
        await fs.writeFile(MAINTAINER_INVITES_FILE, JSON.stringify(this.maintainerInvites, null, 2), 'utf-8');
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
        if (agentName === 'System') {
            return this.communities;
        }
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
        if (!agent_name || !community_id || !name || !type) {
            throw new Error('参数缺失: 需要 agent_name, community_id, name, type');
        }
        if (!['public', 'private'].includes(type)) {
            throw new Error("参数错误: type 必须是 'public' 或 'private'");
        }
        if (this.getCommunity(community_id)) {
            throw new Error(`社区 '${community_id}' 已存在。`);
        }

        // 创建者自动成为维护者，避免出现无维护者导致的流程卡死
        const maintainerSet = new Set(Array.isArray(maintainers) ? maintainers : []);
        maintainerSet.add(agent_name);

        // public 社区默认不维护成员列表
        // created_by/created_at 用于追踪社区创建来源
        const newCommunity = {
            id: community_id,
            name,
            description: description || '',
            type,
            members: type === 'public' ? [] : Array.isArray(members) ? members : [],
            maintainers: Array.from(maintainerSet),
            created_by: agent_name,
            created_at: Date.now(),
        };

        this.communities.push(newCommunity);
        await this.save();
        return `社区 '${name}' 创建成功。`;
    }

    /**
     * 邀请 Agent 成为社区维护者
     * @param {object} args 参数对象 { agent_name, community_id, invitee, reason }
     */
    async inviteMaintainer(args) {
        const { agent_name, community_id, invitee, reason } = args;
        if (!agent_name || !community_id || !invitee) {
            throw new Error('参数缺失: 需要 agent_name, community_id, invitee');
        }

        const community = this.getCommunity(community_id);
        if (!community) throw new Error(`社区 '${community_id}' 不存在。`);

        const maintainers = community.maintainers || [];
        if (agent_name !== 'System' && !maintainers.includes(agent_name)) {
            throw new Error(`权限不足: Agent '${agent_name}' 不是社区 '${community_id}' 的 Maintainer。`);
        }
        if (invitee === agent_name) {
            throw new Error('不能邀请自己成为维护者。');
        }
        if (maintainers.includes(invitee)) {
            throw new Error(`Agent '${invitee}' 已经是社区 '${community_id}' 的 Maintainer。`);
        }
        if (maintainers.length >= this.maxMaintainers) {
            throw new Error(`社区 '${community_id}' 维护者数量已达到上限 ${this.maxMaintainers}。`);
        }

        await this.loadMaintainerInvites();
        const pending = this.maintainerInvites.find((invite) =>
            invite.community_id === community_id &&
            invite.invitee === invitee &&
            invite.status === 'Pending'
        );
        if (pending) {
            throw new Error(`已存在给 '${invitee}' 的待处理邀请: ${pending.invite_id}`);
        }

        const inviteId = `inv-${Date.now()}-${Math.random().toString(16).slice(2, 10)}`;
        const now = Date.now();
        this.maintainerInvites.push({
            invite_id: inviteId,
            community_id,
            inviter: agent_name,
            invitee,
            reason: reason || '',
            status: 'Pending',
            created_at: now,
            updated_at: now,
            decision_comment: null,
        });
        await this.saveMaintainerInvites();
        return `已向 '${invitee}' 发出维护者邀请。invite_id: ${inviteId}`;
    }

    /**
     * 响应维护者邀请
     * @param {object} args 参数对象 { agent_name, invite_id, decision, comment }
     */
    async respondMaintainerInvite(args) {
        const { agent_name, invite_id, decision, comment } = args;
        if (!agent_name || !invite_id || !decision) {
            throw new Error('参数缺失: 需要 agent_name, invite_id, decision');
        }
        if (!['Accept', 'Reject'].includes(decision)) {
            throw new Error("decision 必须是 'Accept' 或 'Reject'");
        }

        await this.loadMaintainerInvites();
        const invite = this.maintainerInvites.find((item) => item.invite_id === invite_id);
        if (!invite) {
            throw new Error(`未找到邀请: ${invite_id}`);
        }
        if (invite.status !== 'Pending') {
            throw new Error(`该邀请已处理，当前状态: ${invite.status}`);
        }
        if (invite.invitee !== agent_name) {
            throw new Error('权限不足: 仅被邀请者可以响应邀请。');
        }

        const community = this.getCommunity(invite.community_id);
        if (!community) {
            throw new Error(`社区 '${invite.community_id}' 不存在。`);
        }
        const maintainers = community.maintainers || [];

        if (decision === 'Accept') {
            if (!maintainers.includes(agent_name) && maintainers.length >= this.maxMaintainers) {
                throw new Error(`社区 '${invite.community_id}' 维护者数量已达到上限 ${this.maxMaintainers}。`);
            }
            if (!maintainers.includes(agent_name)) {
                maintainers.push(agent_name);
            }
            community.maintainers = maintainers;
            // 如果是私有社区，邀请者也需要加入成员列表
            if (community.type === 'private' && Array.isArray(community.members) && !community.members.includes(agent_name)) {
                community.members.push(agent_name);
            }
            await this.save();
            invite.status = 'Accepted';
        } else {
            invite.status = 'Rejected';
        }

        invite.updated_at = Date.now();
        invite.decision_comment = comment || '';
        await this.saveMaintainerInvites();
        return `邀请 ${invite_id} 已${decision === 'Accept' ? '接受' : '拒绝'}。`;
    }

    /**
     * 列出 Agent 维护者邀请
     * @param {string} agent_name - 目标 Agent 名称
     * @param {string} community_id - 目标社区 ID（可选）
     * @param {string} status - 邀请状态（可选）
     * @returns {Promise<Array>} - 邀请列表
     */
    async listMaintainerInvites(args) {
        const { agent_name, community_id, status } = args;
        if (!agent_name) {
            throw new Error('参数缺失: 需要 agent_name');
        }

        await this.loadMaintainerInvites();
        let invites = this.maintainerInvites.slice();
        if (community_id) {
            invites = invites.filter((invite) => invite.community_id === community_id);
        }
        if (status) {
            invites = invites.filter((invite) => invite.status === status);
        }

        if (agent_name !== 'System') {
            invites = invites.filter((invite) => {
                if (invite.invitee === agent_name || invite.inviter === agent_name) return true;
                const community = this.getCommunity(invite.community_id);
                const maintainers = community?.maintainers || [];
                return maintainers.includes(agent_name);
            });
        }

        invites.sort((a, b) => (b.updated_at || b.created_at || 0) - (a.updated_at || a.created_at || 0));
        return invites;
    }

    /**
     * 获取 Agent 待处理维护者邀请
     * @param {string} agentName - 目标 Agent 名称
     * @param {Set<string>} visibleCommunityIds - 可见社区 ID 集合
     * @param {number} limit - 最大返回条数，默认 5
     * @returns {Promise<Array>} - 待处理邀请列表
     */
    async getPendingMaintainerInvites(agentName, visibleCommunityIds, limit = 5) {
        await this.loadMaintainerInvites();
        const pending = this.maintainerInvites.filter((invite) => {
            if (invite.status !== 'Pending') return false;
            if (invite.invitee !== agentName) return false;
            if (visibleCommunityIds && visibleCommunityIds.size > 0 && !visibleCommunityIds.has(invite.community_id)) {
                return false;
            }
            return true;
        });
        pending.sort((a, b) => (b.updated_at || b.created_at || 0) - (a.updated_at || a.created_at || 0));
        return pending.slice(0, limit).map((invite) => ({
            invite_id: invite.invite_id,
            community_id: invite.community_id,
            inviter: invite.inviter,
            reason: invite.reason || '',
            created_at: invite.created_at,
            updated_at: invite.updated_at || invite.created_at,
        }));
    }

    /**
     * 保存当前社区配置到文件
     */
    async save() {
        await fs.writeFile(COMMUNITIES_FILE, JSON.stringify({ communities: this.communities }, null, 2), 'utf-8');
    }
}

module.exports = CommunityManager;
