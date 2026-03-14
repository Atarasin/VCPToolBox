const fs = require('fs').promises;
const path = require('path');
const { WIKI_DIR } = require('../constants');
const { sanitizeFilename, getTimestamp } = require('../utils/helpers');

/**
 * Wiki 管理器 (WikiManager)
 * 负责社区文档的读取、更新、版本控制以及权限检查。
 */
class WikiManager {
    constructor(communityManager) {
        this.communityManager = communityManager;
    }

    /**
     * 获取 Wiki 页面文件路径
     * @param {string} communityId 社区 ID
     * @param {string} pageName 页面名称
     * @returns {string} 文件绝对路径
     */
    getWikiPath(communityId, pageName) {
        return path.join(WIKI_DIR, sanitizeFilename(communityId), `${sanitizeFilename(pageName)}.md`);
    }

    /**
     * 获取页面保护状态
     * @param {object} community 社区对象
     * @param {string} pageName 页面名称
     * @returns {boolean|null} 保护状态 (null 表示尚未确定)
     */
    getProtectionStatus(community, pageName) {
        return community.wiki_pages?.[pageName]?.protected ?? null;
    }

    /**
     * 读取 Wiki 页面内容
     * @param {object} args 参数对象 { agent_name, community_id, page_name }
     */
    async readWiki(args) {
        const { agent_name, community_id, page_name = 'README' } = args;
        
        // 权限检查
        const community = this.communityManager.getCommunity(community_id);
        if (!community) throw new Error(`社区 '${community_id}' 不存在。`);
        
        // 检查可见性 (即使是 private 社区，成员也应该能读)
        const visible = this.communityManager.listVisibleCommunities(agent_name);
        if (agent_name !== 'System' && !visible.find((c) => c.id === community_id)) {
            throw new Error(`权限不足: 您无法查看社区 '${community_id}' 的 Wiki。`);
        }

        const filePath = this.getWikiPath(community_id, page_name);
        try {
            return await fs.readFile(filePath, 'utf-8');
        } catch (e) {
            if (e.code === 'ENOENT') {
                return `Wiki 页面 '${page_name}' 不存在。`;
            }
            throw e;
        }
    }

    /**
     * 更新 Wiki 页面
     * @param {object} args 参数对象 { agent_name, community_id, page_name, content, edit_summary }
     */
    async updateWiki(args) {
        const { agent_name, community_id, page_name, content, edit_summary } = args;
        if (!page_name || !content || !edit_summary) throw new Error('缺少必要参数');

        // 1. 社区权限检查
        const community = this.communityManager.getCommunity(community_id);
        if (!community) throw new Error(`社区 '${community_id}' 不存在。`);

        // 2. 基础权限检查 (私有社区必须是成员)
        if (community.type === 'private' && agent_name !== 'System' && !community.members.includes(agent_name)) {
            throw new Error('权限不足: 您不是社区成员。');
        }

        // 3. 角色权限检查与保护状态判定
        const maintainers = community.maintainers || [];
        let isProtected = this.getProtectionStatus(community, page_name);

        // 第一次创建页面时确定保护状态，并写入 communities.json
        if (isProtected === null) {
            // 规则：由 Maintainer 首次创建的页面默认为受保护页面
            isProtected = maintainers.includes(agent_name);
            await this.communityManager.setWikiPageMeta(community_id, page_name, {
                protected: isProtected,
                created_by: agent_name,
                created_at: Date.now(),
            });
        }

        if (isProtected) {
            if (agent_name !== 'System' && !maintainers.includes(agent_name)) {
                throw new Error(`权限不足: 页面 '${page_name}' 受保护，请使用 ProposeWikiUpdate 发起提案。`);
            }
        }

        const filePath = this.getWikiPath(community_id, page_name);
        const dirPath = path.dirname(filePath);
        await fs.mkdir(dirPath, { recursive: true });

        // 4. 版本备份 (保存旧版本到 _history)
        try {
            const oldContent = await fs.readFile(filePath, 'utf-8');
            const historyDir = path.join(dirPath, '_history');
            await fs.mkdir(historyDir, { recursive: true });
            const backupName = `${sanitizeFilename(page_name)}.${Date.now()}.md`;
            await fs.writeFile(path.join(historyDir, backupName), oldContent, 'utf-8');
        } catch (_) {
            // 文件不存在，是新建，无需备份
        }

        // 5. 写入新内容并追加更新时间与摘要
        const fullContent = `${content}\n\n---\n*Last updated by ${agent_name} at ${getTimestamp()}: ${edit_summary}*`;
        await fs.writeFile(filePath, fullContent, 'utf-8');
        return `Wiki 页面 '${page_name}' 更新成功！`;
    }

    /**
     * 列出社区内的 Wiki 页面
     * @param {object} args 参数对象 { agent_name, community_id }
     */
    async listWikiPages(args) {
        const { agent_name, community_id } = args;
        
        // 权限检查
        const visible = this.communityManager.listVisibleCommunities(agent_name);
        if (agent_name !== 'System' && !visible.find((c) => c.id === community_id)) {
            throw new Error('权限不足或社区不存在。');
        }

        const dirPath = path.join(WIKI_DIR, sanitizeFilename(community_id));
        try {
            const files = await fs.readdir(dirPath);
            // 过滤掉隐藏文件 (以 _ 开头)
            const pages = files.filter((f) => f.endsWith('.md') && !f.startsWith('_'));
            return pages.length > 0 ? pages.join('\n') : '该社区暂无 Wiki 页面。';
        } catch (e) {
            if (e.code === 'ENOENT') return '该社区暂无 Wiki 页面。';
            throw e;
        }
    }
}

module.exports = WikiManager;
