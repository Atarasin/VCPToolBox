const fs = require('fs').promises; // Node.js 原生 fs 模块的 Promise 版本，用于异步文件系统操作
const path = require('path');      // Node.js 原生 path 模块，用于处理文件和目录路径
const { WIKI_DIR } = require('../constants'); // 引入常量配置：Wiki 根目录路径
const { sanitizeFilename, getTimestamp } = require('../utils/helpers'); // 引入工具函数：文件名清理和时间戳生成

/**
 * Wiki 管理器 (WikiManager)
 * 
 * 负责社区文档的核心操作，包括：
 * 1. Wiki 页面的读取、创建、更新与列表展示。
 * 2. 页面版本控制（自动保存旧版本至 _history 目录）。
 * 3. 页面访问和修改的权限检查。
 * 4. Wiki 内容与 DailyNote 的同步联动。
 */
class WikiManager {
    /**
     * 构造函数
     * 
     * @param {Object} communityManager - 社区管理器实例，用于读取社区元数据和验证成员权限
     * @param {Object} [wikiDailynoteSyncManager=null] - (可选) 负责 Wiki 到 DailyNote 的同步管理器实例
     */
    constructor(communityManager, wikiDailynoteSyncManager = null) {
        this.communityManager = communityManager;
        this.wikiDailynoteSyncManager = wikiDailynoteSyncManager;
    }

    /**
     * 获取指定社区的 Wiki 根目录绝对路径
     * 
     * @param {string} communityId - 社区的唯一标识符
     * @returns {string} 社区 Wiki 的根目录绝对路径
     */
    getCommunityWikiRoot(communityId) {
        return path.resolve(WIKI_DIR, sanitizeFilename(communityId));
    }

    /**
     * 规范化页面名称
     * 
     * 检查并清理输入的页面路径，防止路径穿越攻击，并确保路径以 .md 结尾。
     * 
     * @param {string} pageName - 原始页面路径名
     * @returns {string} 规范化并以 .md 结尾的安全页面路径
     * @throws {Error} 若参数缺失或路径包含非法字符（如 '../'）时抛出异常
     */
    normalizePageName(pageName) {
        if (typeof pageName !== 'string' || !pageName.trim()) {
            throw new Error('缺少必要参数');
        }

        // 将反斜杠统一替换为斜杠，去除首部斜杠，并进行 POSIX 规范化
        const normalized = path.posix.normalize(pageName.trim().replace(/\\/g, '/').replace(/^\/+/, ''));
        // 安全检查：拦截相对路径跨越操作
        if (!normalized || normalized === '.' || normalized.startsWith('..') || normalized.includes('/..')) {
            throw new Error('非法 page_name 路径。');
        }

        // 拆分路径，逐段进行安全过滤，再重新拼接
        const safePath = normalized
            .split('/')
            .map((segment) => sanitizeFilename(segment))
            .filter(Boolean)
            .join('/');
            
        if (!safePath) {
            throw new Error('非法 page_name 路径。');
        }
        
        // 确保文件具备 Markdown 扩展名
        return safePath.endsWith('.md') ? safePath : `${safePath}.md`;
    }

    /**
     * 获取指定页面在文件系统中的绝对路径
     * 
     * @param {string} communityId - 社区标识符
     * @param {string} pageName - 页面路径名
     * @returns {string} 页面的完整绝对路径
     * @throws {Error} 若拼接后路径超出社区根目录范畴，抛出安全异常
     */
    getWikiPath(communityId, pageName) {
        const communityRoot = this.getCommunityWikiRoot(communityId);
        const normalizedPageName = this.normalizePageName(pageName);
        
        // 展开多级目录路径，拼接为绝对路径
        const filePath = path.resolve(communityRoot, ...normalizedPageName.split('/'));
        
        // 双重安全检查：验证计算出的文件路径仍在社区根目录之下
        const relative = path.relative(communityRoot, filePath);
        if (relative.startsWith('..') || path.isAbsolute(relative)) {
            throw new Error('非法 page_name 路径。');
        }
        return filePath;
    }

    /**
     * 规范化 Tag 文本行
     * 
     * 对传入的 tag 字符串进行清洗和格式化，如统一标点、去重空格等，最终组装成标准的 `Tag: xxx` 格式。
     * 
     * @param {string} tag - 原始 tag 字符串
     * @returns {string} 规范化后的标签行，如果无内容则返回空字符串
     */
    normalizeTagLine(tag) {
        if (typeof tag !== 'string' || !tag.trim()) {
            return '';
        }

        // 剥离可能存在的 "tag:" 或 "tag：" 前缀（不区分大小写）
        let tagContent = tag.trim().replace(/^tag\s*[:：]?\s*/i, '').trim();
        if (!tagContent) {
            return '';
        }

        // 标准化：中文逗号/顿号转英文逗号，合并连续逗号，去除尾部句号等
        tagContent = tagContent
            .replace(/[\uff0c]/g, ', ')
            .replace(/[\u3001]/g, ', ')
            .replace(/,\s*/g, ', ')
            .replace(/,\s{2,}/g, ', ')
            .replace(/\s+,/g, ',')
            .replace(/\s{2,}/g, ' ')
            .replace(/[。.]+$/g, '')
            .trim();

        return tagContent ? `Tag: ${tagContent}` : '';
    }

    /**
     * 从页面正文内容中提取出包含的 Tag 信息
     * 
     * 遍历正文每一行，匹配 `Tag: xxx` 或 `**Tag**: xxx` 格式。
     * 将匹配到的行剔除出正文，并将提取到的 tag 值返回。
     * 
     * @param {string} content - 待处理的文档内容
     * @returns {Object} 包含 `contentWithoutTagLine` (剔除 Tag 行后的正文) 和 `extractedTag` (提取出的标签值)
     */
    extractTagFromContent(content) {
        if (typeof content !== 'string' || !content.length) {
            return { contentWithoutTagLine: content, extractedTag: '' };
        }
        
        const lines = content.split('\n');
        let extractedTag = '';
        const keptLines = [];
        
        // 正则：匹配 (可选加粗) 的 Tag 键值对，忽略大小写和前后空格
        const tagLinePattern = /^\s*(?:\*\*)?\s*tag\s*(?:\*\*)?\s*[:：]\s*(.+?)\s*$/i;
        
        for (const line of lines) {
            const matched = line.match(tagLinePattern);
            // 如果匹配到 Tag 行，将其提取并跳过（不加入 keptLines）
            if (matched && matched[1]) {
                extractedTag = matched[1].trim();
                continue;
            }
            keptLines.push(line);
        }
        
        return {
            contentWithoutTagLine: keptLines.join('\n'),
            extractedTag,
        };
    }

    /**
     * 获取页面的保护状态
     * 
     * 从社区的元数据中读取指定页面的保护标记。
     * 兼容带有或不带有 .md 后缀的页面名称。
     * 
     * @param {Object} community - 社区配置对象
     * @param {string} pageName - 页面路径名
     * @returns {boolean|null} 保护状态（true受保护，false未保护，null表示未曾初始化）
     */
    getProtectionStatus(community, pageName) {
        const legacyPageName = pageName.endsWith('.md') ? pageName.slice(0, -3) : pageName;
        return community.wiki_pages?.[pageName]?.protected ?? community.wiki_pages?.[legacyPageName]?.protected ?? null;
    }

    /**
     * 递归收集目录下的所有 Wiki 页面文件
     * 
     * 遍历目录内容，跳过以下划线 `_` 开头的隐藏/内部目录（如 _history）。
     * 
     * @param {string} dirPath - 当前正在遍历的目录绝对路径
     * @param {string} [relativeRoot=''] - 当前目录相对社区根目录的相对路径
     * @returns {Promise<string[]>} 所有合法的 .md 文件相对路径数组
     */
    async collectWikiPages(dirPath, relativeRoot = '') {
        const entries = await fs.readdir(dirPath, { withFileTypes: true });
        const pages = [];
        
        for (const entry of entries) {
            // 跳过历史备份目录等隐藏文件
            if (entry.name.startsWith('_')) continue;
            
            const relativePath = relativeRoot ? path.posix.join(relativeRoot, entry.name) : entry.name;
            const absolutePath = path.join(dirPath, entry.name);
            
            // 目录则递归深入
            if (entry.isDirectory()) {
                const nestedPages = await this.collectWikiPages(absolutePath, relativePath);
                pages.push(...nestedPages);
                continue;
            }
            // 文件则校验后缀并收集
            if (entry.isFile() && entry.name.endsWith('.md')) {
                pages.push(relativePath);
            }
        }
        return pages;
    }

    /**
     * 读取 Wiki 页面内容
     * 
     * 包含完整的访问权限控制：判断社区是否存在以及用户是否具有该社区的访问可见性。
     * 
     * @param {Object} args - 调用参数对象
     * @param {string} args.agent_name - 操作者名称（系统预留 'System' 具有最高权限）
     * @param {string} args.community_id - 社区标识符
     * @param {string} [args.page_name='README'] - 目标页面路径名，默认为 README
     * @returns {Promise<string>} 读取到的文档内容文本
     * @throws {Error} 若权限不足或社区不存在抛出异常
     */
    async readWiki(args) {
        const { agent_name, community_id, page_name = 'README' } = args;
        const normalizedPageName = this.normalizePageName(page_name);
        
        // 1. 社区是否存在检查
        const community = this.communityManager.getCommunity(community_id);
        if (!community) throw new Error(`社区 '${community_id}' 不存在。`);
        
        // 2. 检查可见性 (即使是 private 社区，成员也应该能读)
        const visible = this.communityManager.listVisibleCommunities(agent_name);
        if (agent_name !== 'System' && !visible.find((c) => c.id === community_id)) {
            throw new Error(`权限不足: 您无法查看社区 '${community_id}' 的 Wiki。`);
        }

        const filePath = this.getWikiPath(community_id, normalizedPageName);
        try {
            return await fs.readFile(filePath, 'utf-8');
        } catch (e) {
            // 文件不存在时，返回友好的提示信息而不是抛出严重异常
            if (e.code === 'ENOENT') {
                return `Wiki 页面 '${normalizedPageName}' 不存在。`;
            }
            throw e;
        }
    }

    /**
     * 更新或创建 Wiki 页面
     * 
     * 执行全流程的业务逻辑：
     * 1. 验证修改权限（根据社区可见性及页面级别的受保护状态）。
     * 2. 进行历史版本备份，确保页面改动可追溯。
     * 3. 拼装最新的元信息块 (frontmatter) 与内容正文、底部 Tag，并写入文件。
     * 4. 触发对 DailyNote 的级联同步。
     * 
     * @param {Object} args - 调用参数对象
     * @param {string} args.agent_name - 操作者名称
     * @param {string} args.community_id - 社区标识符
     * @param {string} args.page_name - 页面路径名
     * @param {string} args.content - 页面正文内容
     * @param {string} args.edit_summary - 编辑摘要或说明
     * @param {string} [args.tag] - (可选) 页面底部附加的标签内容
     * @returns {Promise<string>} 成功后的提示信息
     * @throws {Error} 若缺少参数、权限不足等情况则抛出异常
     */
    async updateWiki(args) {
        const { agent_name, community_id, page_name, content, edit_summary, tag } = args;
        if (!page_name || !content || !edit_summary) throw new Error('缺少必要参数');
        
        const normalizedPageName = this.normalizePageName(page_name);

        // 1. 社区可用性检查
        const community = this.communityManager.getCommunity(community_id);
        if (!community) throw new Error(`社区 '${community_id}' 不存在。`);

        // 2. 基础写入权限检查 (私有社区仅允许成员/维护者修改)
        const privateWritable = new Set([...(community.members || []), ...(community.maintainers || [])]);
        if (community.type === 'private' && agent_name !== 'System' && !privateWritable.has(agent_name)) {
            throw new Error('权限不足: 您不是社区成员或 Maintainer。');
        }

        // 3. 角色与页面级保护权限检查
        const maintainers = community.maintainers || [];
        let isProtected = this.getProtectionStatus(community, normalizedPageName);

        // 若页面是第一次创建，确定并记录其保护状态
        if (isProtected === null) {
            // 业务规则：由 Maintainer 首次创建的页面默认为受保护页面，普通成员创建的不受保护
            isProtected = maintainers.includes(agent_name);
            await this.communityManager.setWikiPageMeta(community_id, normalizedPageName, {
                protected: isProtected,
                created_by: agent_name,
                created_at: Date.now(),
            });
        }

        // 若页面已被保护，只有 Maintainer 或 System 可以直接修改
        // 其他人需走 ProposeWikiUpdate 发起提案审核链路
        if (isProtected) {
            if (agent_name !== 'System' && !maintainers.includes(agent_name)) {
                throw new Error(`权限不足: 页面 '${normalizedPageName}' 受保护，请使用 ProposeWikiUpdate 发起提案。`);
            }
        }

        const filePath = this.getWikiPath(community_id, normalizedPageName);
        const dirPath = path.dirname(filePath);
        
        // 确保目标路径涉及的中间目录都已存在
        await fs.mkdir(dirPath, { recursive: true });

        // 4. 版本备份策略：将现存的旧文件拷贝到 _history 目录下保存
        try {
            const oldContent = await fs.readFile(filePath, 'utf-8');
            const historyDir = path.join(dirPath, '_history');
            await fs.mkdir(historyDir, { recursive: true });
            
            // 备份文件名使用时间戳以防覆盖
            const backupName = `${sanitizeFilename(normalizedPageName)}.${Date.now()}.md`;
            await fs.writeFile(path.join(historyDir, backupName), oldContent, 'utf-8');
        } catch (_) {
            // 若原文件不存在，说明是全新创建，无需备份，静默处理
        }

        // 5. 组装并写入新内容
        // 从传入的正文中分离潜在的 Tag 标记
        const { contentWithoutTagLine, extractedTag } = this.extractTagFromContent(content);
        // 优先使用传入的 tag 参数，如果没有则使用提取出的 extractedTag 进行格式规范化
        const normalizedTagLine = this.normalizeTagLine(tag || extractedTag);
        
        const normalizedContent = contentWithoutTagLine.trimEnd();
        
        // 构造位于文档顶部的 Meta 元数据块 (类似 frontmatter 格式)
        const metaBlock = [
            '---',
            `last updated: ${getTimestamp()}`,
            `agent name: ${agent_name}`,
            `edit summary: ${edit_summary}`,
            '---',
        ].join('\n');
        
        // 最终拼接：顶部元信息 + 空行 + 核心正文内容 + 可选的尾部标签
        const fullContent = normalizedTagLine
            ? `${metaBlock}\n\n${normalizedContent}\n${normalizedTagLine}`
            : `${metaBlock}\n\n${normalizedContent}`;
            
        await fs.writeFile(filePath, fullContent, 'utf-8');
        
        // 6. 联动同步：若启用了 DailyNote 同步模块，则同步最新内容过去
        if (this.wikiDailynoteSyncManager) {
            const syncResult = await this.wikiDailynoteSyncManager.syncWikiPage({
                communityId: community_id,
                pageName: normalizedPageName,
                content: fullContent,
                agentName: agent_name,
            });
            // 根据同步返回结果记录对应日志，供开发者或运维排查
            if (syncResult?.status === 'failed') {
                console.warn(`[VCPCommunity] Wiki-DailyNote 同步失败: ${syncResult.reason || 'unknown'}`);
            }
            // 注意：此处使用 console.error 输出标准错误，避免污染插件向 stdout 写入的正常 JSON 协议返回
            if (syncResult?.status === 'synced') {
                console.error(`[VCPCommunity] Wiki-DailyNote 同步成功: ${syncResult.target_path}`);
            }
        }
        
        return `Wiki 页面 '${normalizedPageName}' 更新成功！`;
    }

    /**
     * 获取指定社区内所有存在的 Wiki 页面列表
     * 
     * @param {Object} args - 调用参数对象
     * @param {string} args.agent_name - 操作者名称
     * @param {string} args.community_id - 社区标识符
     * @returns {Promise<string>} 换行符拼接的 Wiki 页面相对路径列表；若无则返回相应提示
     * @throws {Error} 权限不足或社区不存在时抛出异常
     */
    async listWikiPages(args) {
        const { agent_name, community_id } = args;
        
        // 验证用户是否有查看此社区列表的权限
        const visible = this.communityManager.listVisibleCommunities(agent_name);
        if (agent_name !== 'System' && !visible.find((c) => c.id === community_id)) {
            throw new Error('权限不足或社区不存在。');
        }

        const dirPath = this.getCommunityWikiRoot(community_id);
        try {
            // 递归收集目录下的文件，并按照中文字符集顺序排序
            const pages = await this.collectWikiPages(dirPath);
            pages.sort((a, b) => a.localeCompare(b, 'zh-Hans-CN'));
            return pages.length > 0 ? pages.join('\n') : '该社区暂无 Wiki 页面。';
        } catch (e) {
            // 如果目录不存在，视作暂无页面
            if (e.code === 'ENOENT') return '该社区暂无 Wiki 页面。';
            throw e;
        }
    }
}

module.exports = WikiManager;
