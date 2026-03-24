const fs = require('fs').promises; // 引入 fs 的 promise 版本，用于异步文件读写
const {
    CONFIG_DIR,
    COMMUNITIES_FILE,
    DEFAULT_COMMUNITIES_FILE,
    POSTS_DIR,
    WIKI_DIR,
    PROPOSALS_FILE,
    MAINTAINER_INVITES_FILE,
    WIKI_DAILYNOTE_MAPPINGS_FILE,
} = require('../constants'); // 引入常量配置：包括各类目录及文件路径

/**
 * 社区管理器 (CommunityManager)
 * 
 * 核心管理类，主要负责：
 * 1. 社区全局配置（communities.json）的加载与保存。
 * 2. 运行时所需各种基础目录及状态文件（如提案、邀请等）的初始化。
 * 3. 社区本身的创建、信息查询与可见性控制。
 * 4. 社区成员加入、维护者邀请的发起及响应逻辑。
 */
class CommunityManager {
    /**
     * 构造函数
     * 
     * 初始化类内部使用的状态容器及常量设置。
     */
    constructor() {
        this.communities = []; // 在内存中缓存当前所有的社区配置数据
        this.maintainerInvites = []; // 在内存中缓存维护者邀请记录
        this.maxMaintainers = 3; // 业务常量：限制每个社区最多允许拥有的维护者数量
    }

    /**
     * 初始化社区运行目录与基础文件
     * 
     * 确保系统所需的各类基础目录和状态文件存在。
     * 若首次启动，将自动创建这些文件和目录以保证后续流程不报错。
     * 
     * @returns {Promise<string>} 初始化完成的提示信息
     */
    async initStorage() {
        // 确保核心目录存在（递归创建）
        await fs.mkdir(CONFIG_DIR, { recursive: true });
        await fs.mkdir(POSTS_DIR, { recursive: true });
        await fs.mkdir(WIKI_DIR, { recursive: true });

        // 初始化 communities.json 配置文件并加载到内存中
        await this.load();

        // 确保周边依赖的基础 JSON 文件也一并被创建和初始化为默认结构
        await this.ensureJsonFile(PROPOSALS_FILE, []);
        await this.ensureJsonFile(MAINTAINER_INVITES_FILE, []);
        await this.ensureJsonFile(WIKI_DAILYNOTE_MAPPINGS_FILE, { enabled: false, mappings: [] });
        
        // 加载邀请记录到内存
        await this.loadMaintainerInvites();

        return '社区初始化完成。';
    }

    /**
     * 初始化 JSON 文件（若不存在则创建）
     * 
     * @param {string} filePath - 目标文件路径
     * @param {Object|Array} defaultValue - 文件不存在时写入的默认内容结构
     * @returns {Promise<void>}
     * @throws {Error} 文件存在但访问出错时抛出异常
     */
    async ensureJsonFile(filePath, defaultValue) {
        try {
            await fs.access(filePath); // 检查文件是否存在
        } catch (e) {
            // ENOENT 表示文件或目录不存在，执行创建并写入默认内容
            if (e.code === 'ENOENT') {
                await fs.writeFile(filePath, JSON.stringify(defaultValue, null, 2), 'utf-8');
                return;
            }
            throw e;
        }
    }

    /**
     * 加载社区配置
     * 
     * 读取 communities.json；如果文件不存在，则尝试从默认模板拷贝初始化。
     * 如果拷贝也失败（例如模板丢失），则静默创建一个空的社区列表配置。
     * 
     * @returns {Promise<void>}
     */
    async load() {
        try {
            // 确保配置目录存在
            await fs.mkdir(CONFIG_DIR, { recursive: true });

            // 检查配置文件是否存在，不存在则进入初始化流程
            try {
                await fs.access(COMMUNITIES_FILE);
            } catch (e) {
                try {
                    // 从默认配置模板中拷贝内容
                    const defaultConfig = await fs.readFile(DEFAULT_COMMUNITIES_FILE, 'utf-8');
                    await fs.writeFile(COMMUNITIES_FILE, defaultConfig, 'utf-8');
                } catch (copyError) {
                    console.warn(`[VCPCommunity] 无法初始化默认配置: ${copyError.message}`);
                    // 如果拷贝失败，作为兜底创建一个空的默认配置
                    if (e.code === 'ENOENT') {
                        await fs.writeFile(COMMUNITIES_FILE, JSON.stringify({ communities: [] }, null, 2), 'utf-8');
                    }
                }
            }

            // 读取并解析最终的配置文件
            const data = await fs.readFile(COMMUNITIES_FILE, 'utf-8');
            const config = JSON.parse(data);
            this.communities = config.communities || []; // 同步到内存中
        } catch (e) {
            console.error(`[VCPCommunity] 加载社区配置失败: ${e.message}`);
            this.communities = [];
        }
    }

    /**
     * 异步加载维护者邀请记录
     * 
     * 从 JSON 文件中读取并反序列化，若解析失败则初始化为空数组。
     * 
     * @returns {Promise<void>}
     */
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

    /**
     * 异步保存维护者邀请记录
     * 
     * 将内存中的邀请数据覆盖写入对应的 JSON 配置文件中。
     * 
     * @returns {Promise<void>}
     */
    async saveMaintainerInvites() {
        await fs.writeFile(MAINTAINER_INVITES_FILE, JSON.stringify(this.maintainerInvites, null, 2), 'utf-8');
    }

    /**
     * 根据 ID 获取社区对象
     * 
     * @param {string} id - 待查找的社区 ID
     * @returns {Object|undefined} 查找到的社区对象；若未找到则返回 undefined
     */
    getCommunity(id) {
        return this.communities.find((c) => c.id === id);
    }

    /**
     * 规范化 Agent 列表（例如成员或维护者名单）
     * 
     * 处理传入参数可能是数组，也可能是被错误转义过的 JSON 字符串情况，
     * 并执行去重、去空格及去除空值的操作。
     * 
     * @param {Array|string} input - 原始的 Agent 列表输入
     * @returns {Array} 规范化后的字符串数组
     */
    normalizeAgentList(input) {
        // 内部辅助函数：对数组进行过滤、去空格和去重
        const normalizeArray = (value) => Array.from(new Set(
            value
                .filter((item) => typeof item === 'string')
                .map((item) => item.trim())
                .filter(Boolean)
        ));

        if (Array.isArray(input)) {
            return normalizeArray(input);
        }
        
        if (typeof input === 'string') {
            // 处理可能的 HTML 实体转义字符
            const decoded = input.replace(/&quot;/g, '"').trim();
            if (!decoded) return [];
            try {
                const parsed = JSON.parse(decoded);
                if (Array.isArray(parsed)) {
                    return normalizeArray(parsed);
                }
            } catch (_) {
                // 如果解析异常，直接忽略并返回空数组
                return [];
            }
        }
        return [];
    }

    /**
     * 获取指定 Wiki 页面的元数据
     * 
     * @param {string} communityId - 社区 ID
     * @param {string} pageName - 页面名称
     * @returns {Object|null} 存在则返回元数据对象（如 protected, created_by 等），否则返回 null
     */
    getWikiPageMeta(communityId, pageName) {
        const community = this.getCommunity(communityId);
        if (!community) return null;
        return community.wiki_pages?.[pageName] || null;
    }

    /**
     * 初始化或更新 Wiki 页面的元数据
     * 
     * 会将传入的 meta 数据合并/覆盖到社区配置中，并持久化保存。
     * 
     * @param {string} communityId - 社区 ID
     * @param {string} pageName - 页面名称
     * @param {Object} meta - 待设置的元数据对象
     * @returns {Promise<void>}
     * @throws {Error} 若指定的社区不存在时抛出异常
     */
    async setWikiPageMeta(communityId, pageName, meta) {
        const community = this.getCommunity(communityId);
        if (!community) throw new Error(`社区 '${communityId}' 不存在。`);
        
        // 如果该社区还没初始化 wiki_pages 字典，则先创建
        if (!community.wiki_pages) community.wiki_pages = {};
        community.wiki_pages[pageName] = { ...meta };
        
        await this.save();
    }

    /**
     * 列出指定 Agent 可见的社区列表
     * 
     * 根据社区的公开性 (public/private) 及 Agent 是否为成员或维护者来判断可见性。
     * System 账户享有上帝视角，可见所有社区。
     * 
     * @param {string} agentName - 目标 Agent 名称
     * @returns {Array} 该 Agent 拥有权限查看的社区对象数组
     */
    listVisibleCommunities(agentName) {
        if (agentName === 'System') {
            return this.communities; // System 用户具有最高权限，直接返回所有
        }
        return this.communities.filter((c) => {
            // 公开社区对所有人可见
            if (c.type === 'public') return true;
            // 私有社区对成员和维护者可见
            return (c.members || []).includes(agentName) || (c.maintainers || []).includes(agentName);
        });
    }

    /**
     * JoinCommunity 命令兼容处理
     * 
     * 用于处理用户或 Agent 主动请求加入社区的操作。
     * 当前业务逻辑：public 社区无需加入即可操作，private 社区需通过邀请加入，不支持自助加入。
     * 
     * @param {string} agentName - 申请加入的 Agent 名称
     * @param {string} communityId - 目标社区 ID
     * @returns {Promise<string>} 处理结果的提示信息
     * @throws {Error} 若社区不存在或为私有社区时抛出异常
     */
    async joinCommunity(agentName, communityId) {
        const community = this.getCommunity(communityId);
        if (!community) {
            throw new Error(`社区 '${communityId}' 不存在。`);
        }
        if (community.type === 'public') {
            return `社区 '${community.name}' 是公开社区，无需加入。`;
        }
        // 拒绝自助加入私有社区的请求
        throw new Error(`私有社区不支持自助加入。请联系社区 Maintainer 通过邀请机制处理。`);
    }

    /**
     * 创建新社区
     * 
     * 业务流程：
     * 1. 检查必要参数和社区类型是否合法。
     * 2. 校验 ID 是否已存在以防止冲突。
     * 3. 规范化传入的成员和维护者列表。
     * 4. 构造新的社区对象推入内存并保存至文件。
     * 
     * @param {Object} args - 调用参数对象
     * @param {string} args.agent_name - 触发创建动作的 Agent 名称
     * @param {string} args.community_id - 新社区的唯一 ID
     * @param {string} args.name - 新社区展示名称
     * @param {string} [args.description] - 新社区描述
     * @param {string} args.type - 社区类型 ('public' 或 'private')
     * @param {Array|string} [args.members] - 初始成员列表
     * @param {Array|string} [args.maintainers] - 初始维护者列表
     * @returns {Promise<string>} 创建成功提示信息
     * @throws {Error} 参数缺失、类型错误或 ID 冲突时抛出异常
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

        const normalizedMembers = this.normalizeAgentList(members);
        const normalizedMaintainers = this.normalizeAgentList(maintainers);

        // 构造新社区对象。public 社区默认不维护成员列表（任何人可见）
        // created_by 和 created_at 用于追踪审计记录
        const newCommunity = {
            id: community_id,
            name,
            description: description || '',
            type,
            members: type === 'public' ? [] : normalizedMembers,
            maintainers: normalizedMaintainers,
            created_by: agent_name,
            created_at: Date.now(),
        };

        this.communities.push(newCommunity);
        await this.save();
        
        return `社区 '${name}' 创建成功。`;
    }

    /**
     * 邀请 Agent 成为社区维护者
     * 
     * 业务流程：
     * 1. 验证发起邀请者必须是该社区现有的 Maintainer (System 除外)。
     * 2. 检查被邀请人是否已经是维护者，或是否超过维护者数量上限。
     * 3. 拦截重复邀请。
     * 4. 生成唯一邀请 ID 并落库。
     * 
     * @param {Object} args - 调用参数对象
     * @param {string} args.agent_name - 邀请发起人
     * @param {string} args.community_id - 目标社区 ID
     * @param {string} args.invitee - 被邀请的 Agent 名称
     * @param {string} [args.reason] - 邀请理由
     * @returns {Promise<string>} 成功提示及邀请 ID
     * @throws {Error} 权限不足、数量超限或邀请冲突等问题时抛出异常
     */
    async inviteMaintainer(args) {
        const { agent_name, community_id, invitee, reason } = args;
        if (!agent_name || !community_id || !invitee) {
            throw new Error('参数缺失: 需要 agent_name, community_id, invitee');
        }

        const community = this.getCommunity(community_id);
        if (!community) throw new Error(`社区 '${community_id}' 不存在。`);

        const maintainers = community.maintainers || [];
        // 权限校验：只允许 System 或是当前社区的 Maintainer 发出邀请
        if (agent_name !== 'System' && !maintainers.includes(agent_name)) {
            throw new Error(`权限不足: Agent '${agent_name}' 不是社区 '${community_id}' 的 Maintainer。`);
        }
        if (invitee === agent_name) {
            throw new Error('不能邀请自己成为维护者。');
        }
        if (maintainers.includes(invitee)) {
            throw new Error(`Agent '${invitee}' 已经是社区 '${community_id}' 的 Maintainer。`);
        }
        // 限制最大维护者人数
        if (maintainers.length >= this.maxMaintainers) {
            throw new Error(`社区 '${community_id}' 维护者数量已达到上限 ${this.maxMaintainers}。`);
        }

        await this.loadMaintainerInvites();
        
        // 检查是否存在相同被邀请者尚未处理的邀请记录
        const pending = this.maintainerInvites.find((invite) =>
            invite.community_id === community_id &&
            invite.invitee === invitee &&
            invite.status === 'Pending'
        );
        if (pending) {
            throw new Error(`已存在给 '${invitee}' 的待处理邀请: ${pending.invite_id}`);
        }

        // 构造邀请对象
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
     * 响应维护者邀请 (Accept 或 Reject)
     * 
     * 业务流程：
     * 1. 验证被邀请人的身份，确保不能代为响应。
     * 2. 如果决定为 Accept，需再次校验维护者人数是否超限。
     * 3. 同意后将其加入 maintainers 列表（如果是私有社区，同步加入 members 列表）。
     * 4. 更新邀请记录状态并落库保存。
     * 
     * @param {Object} args - 调用参数对象
     * @param {string} args.agent_name - 响应该邀请的 Agent（被邀请人）
     * @param {string} args.invite_id - 目标邀请 ID
     * @param {string} args.decision - 决定，'Accept' 或 'Reject'
     * @param {string} [args.comment] - 响应附言
     * @returns {Promise<string>} 处理结果提示信息
     * @throws {Error} 若权限不足、找不到邀请或状态不合法时抛出异常
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
        // 安全拦截：只有被邀请人可以操作自己的邀请
        if (invite.invitee !== agent_name) {
            throw new Error('权限不足: 仅被邀请者可以响应邀请。');
        }

        const community = this.getCommunity(invite.community_id);
        if (!community) {
            throw new Error(`社区 '${invite.community_id}' 不存在。`);
        }
        
        const maintainers = community.maintainers || [];

        if (decision === 'Accept') {
            // 在实际加入前做最后的并发限制校验
            if (!maintainers.includes(agent_name) && maintainers.length >= this.maxMaintainers) {
                throw new Error(`社区 '${invite.community_id}' 维护者数量已达到上限 ${this.maxMaintainers}。`);
            }
            if (!maintainers.includes(agent_name)) {
                maintainers.push(agent_name);
            }
            community.maintainers = maintainers;
            
            // 如果是私有社区，成为维护者后也应自动视为成员，补充加入成员列表
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
     * 列出与特定 Agent 相关的维护者邀请
     * 
     * 包含自己发出的邀请、自己收到的邀请，以及如果是某社区维护者，能看到发往该社区的邀请。
     * 
     * @param {Object} args - 调用参数对象
     * @param {string} args.agent_name - 目标 Agent 名称
     * @param {string} [args.community_id] - 过滤指定的社区 ID（可选）
     * @param {string} [args.status] - 过滤指定的邀请状态（可选）
     * @returns {Promise<Array>} 符合权限及过滤条件的邀请列表
     * @throws {Error} 若未传入 agent_name 则抛出异常
     */
    async listMaintainerInvites(args) {
        const { agent_name, community_id, status } = args;
        if (!agent_name) {
            throw new Error('参数缺失: 需要 agent_name');
        }

        await this.loadMaintainerInvites();
        let invites = this.maintainerInvites.slice();
        
        // 可选：按社区筛选
        if (community_id) {
            invites = invites.filter((invite) => invite.community_id === community_id);
        }
        // 可选：按状态筛选
        if (status) {
            invites = invites.filter((invite) => invite.status === status);
        }

        // 权限过滤：非系统级用户只能看与自己相关的邀请
        if (agent_name !== 'System') {
            invites = invites.filter((invite) => {
                // 自己是接收人或发出人
                if (invite.invitee === agent_name || invite.inviter === agent_name) return true;
                
                // 自己是该社区的维护者，也能查看该社区产生的邀请
                const community = this.getCommunity(invite.community_id);
                const maintainers = community?.maintainers || [];
                return maintainers.includes(agent_name);
            });
        }

        // 按照更新时间倒序排序
        invites.sort((a, b) => (b.updated_at || b.created_at || 0) - (a.updated_at || a.created_at || 0));
        return invites;
    }

    /**
     * 获取 Agent 当前待处理（Pending）的维护者邀请摘要
     * 
     * 主要用于日常 Agent 获取自身状态时提醒。
     * 
     * @param {string} agentName - 目标被邀请的 Agent 名称
     * @param {Set<string>} visibleCommunityIds - Agent 可见社区 ID 集合（用于过滤已失效/无权访问的社区邀请）
     * @param {number} [limit=5] - 最大返回条数
     * @returns {Promise<Array>} 待处理邀请的精简摘要列表
     */
    async getPendingMaintainerInvites(agentName, visibleCommunityIds, limit = 5) {
        await this.loadMaintainerInvites();
        
        const pending = this.maintainerInvites.filter((invite) => {
            if (invite.status !== 'Pending') return false;
            if (invite.invitee !== agentName) return false;
            // 确保邀请对应的社区对该 Agent 来说仍然存在或可见
            if (visibleCommunityIds && visibleCommunityIds.size > 0 && !visibleCommunityIds.has(invite.community_id)) {
                return false;
            }
            return true;
        });
        
        // 倒序排列
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
     * 
     * 将内存中的 communities 数组以 JSON 格式覆盖写入 communities.json。
     * 
     * @returns {Promise<void>}
     */
    async save() {
        await fs.writeFile(COMMUNITIES_FILE, JSON.stringify({ communities: this.communities }, null, 2), 'utf-8');
    }
}

module.exports = CommunityManager;
