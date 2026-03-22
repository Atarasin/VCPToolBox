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

    getCommunityWikiRoot(communityId) {
        return path.resolve(WIKI_DIR, sanitizeFilename(communityId));
    }

    normalizePageName(pageName) {
        if (typeof pageName !== 'string' || !pageName.trim()) {
            throw new Error('缺少必要参数');
        }

        const normalized = path.posix.normalize(pageName.trim().replace(/\\/g, '/').replace(/^\/+/, ''));
        if (!normalized || normalized === '.' || normalized.startsWith('..') || normalized.includes('/..')) {
            throw new Error('非法 page_name 路径。');
        }

        const safePath = normalized
            .split('/')
            .map((segment) => sanitizeFilename(segment))
            .filter(Boolean)
            .join('/');
        if (!safePath) {
            throw new Error('非法 page_name 路径。');
        }
        return safePath.endsWith('.md') ? safePath : `${safePath}.md`;
    }

    getWikiPath(communityId, pageName) {
        const communityRoot = this.getCommunityWikiRoot(communityId);
        const normalizedPageName = this.normalizePageName(pageName);
        const filePath = path.resolve(communityRoot, ...normalizedPageName.split('/'));
        const relative = path.relative(communityRoot, filePath);
        if (relative.startsWith('..') || path.isAbsolute(relative)) {
            throw new Error('非法 page_name 路径。');
        }
        return filePath;
    }

    /**
     * 获取页面保护状态
     * @param {object} community 社区对象
     * @param {string} pageName 页面名称
     * @returns {boolean|null} 保护状态 (null 表示尚未确定)
     */
    getProtectionStatus(community, pageName) {
        const legacyPageName = pageName.endsWith('.md') ? pageName.slice(0, -3) : pageName;
        return community.wiki_pages?.[pageName]?.protected ?? community.wiki_pages?.[legacyPageName]?.protected ?? null;
    }

    async collectWikiPages(dirPath, relativeRoot = '') {
        const entries = await fs.readdir(dirPath, { withFileTypes: true });
        const pages = [];
        for (const entry of entries) {
            if (entry.name.startsWith('_')) continue;
            const relativePath = relativeRoot ? path.posix.join(relativeRoot, entry.name) : entry.name;
            const absolutePath = path.join(dirPath, entry.name);
            if (entry.isDirectory()) {
                const nestedPages = await this.collectWikiPages(absolutePath, relativePath);
                pages.push(...nestedPages);
                continue;
            }
            if (entry.isFile() && entry.name.endsWith('.md')) {
                pages.push(relativePath);
            }
        }
        return pages;
    }

    /**
     * 读取 Wiki 页面内容
     * @param {object} args 参数对象 { agent_name, community_id, page_name }
     */
    async readWiki(args) {
        const { agent_name, community_id, page_name = 'README' } = args;
        const normalizedPageName = this.normalizePageName(page_name);
        
        // 权限检查
        const community = this.communityManager.getCommunity(community_id);
        if (!community) throw new Error(`社区 '${community_id}' 不存在。`);
        
        // 检查可见性 (即使是 private 社区，成员也应该能读)
        const visible = this.communityManager.listVisibleCommunities(agent_name);
        if (agent_name !== 'System' && !visible.find((c) => c.id === community_id)) {
            throw new Error(`权限不足: 您无法查看社区 '${community_id}' 的 Wiki。`);
        }

        const filePath = this.getWikiPath(community_id, normalizedPageName);
        try {
            return await fs.readFile(filePath, 'utf-8');
        } catch (e) {
            if (e.code === 'ENOENT') {
                return `Wiki 页面 '${normalizedPageName}' 不存在。`;
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
        const normalizedPageName = this.normalizePageName(page_name);

        // 1. 社区权限检查
        const community = this.communityManager.getCommunity(community_id);
        if (!community) throw new Error(`社区 '${community_id}' 不存在。`);

        // 2. 基础权限检查 (私有社区必须是成员)
        const privateWritable = new Set([...(community.members || []), ...(community.maintainers || [])]);
        if (community.type === 'private' && agent_name !== 'System' && !privateWritable.has(agent_name)) {
            throw new Error('权限不足: 您不是社区成员或 Maintainer。');
        }

        // 3. 角色权限检查与保护状态判定
        const maintainers = community.maintainers || [];
        let isProtected = this.getProtectionStatus(community, normalizedPageName);

        // 第一次创建页面时确定保护状态，并写入 communities.json
        if (isProtected === null) {
            // 规则：由 Maintainer 首次创建的页面默认为受保护页面
            isProtected = maintainers.includes(agent_name);
            await this.communityManager.setWikiPageMeta(community_id, normalizedPageName, {
                protected: isProtected,
                created_by: agent_name,
                created_at: Date.now(),
            });
        }

        if (isProtected) {
            if (agent_name !== 'System' && !maintainers.includes(agent_name)) {
                throw new Error(`权限不足: 页面 '${normalizedPageName}' 受保护，请使用 ProposeWikiUpdate 发起提案。`);
            }
        }

        const filePath = this.getWikiPath(community_id, normalizedPageName);
        const dirPath = path.dirname(filePath);
        await fs.mkdir(dirPath, { recursive: true });

        // 4. 版本备份 (保存旧版本到 _history)
        try {
            const oldContent = await fs.readFile(filePath, 'utf-8');
            const historyDir = path.join(dirPath, '_history');
            await fs.mkdir(historyDir, { recursive: true });
            const backupName = `${sanitizeFilename(normalizedPageName)}.${Date.now()}.md`;
            await fs.writeFile(path.join(historyDir, backupName), oldContent, 'utf-8');
        } catch (_) {
            // 文件不存在，是新建，无需备份
        }

        // 5. 写入新内容并追加更新时间与摘要
        const fullContent = `${content}\n\n---\n*Last updated by ${agent_name} at ${getTimestamp()}: ${edit_summary}*`;
        await fs.writeFile(filePath, fullContent, 'utf-8');
        return `Wiki 页面 '${normalizedPageName}' 更新成功！`;
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

        const dirPath = this.getCommunityWikiRoot(community_id);
        try {
            const pages = await this.collectWikiPages(dirPath);
            pages.sort((a, b) => a.localeCompare(b, 'zh-Hans-CN'));
            return pages.length > 0 ? pages.join('\n') : '该社区暂无 Wiki 页面。';
        } catch (e) {
            if (e.code === 'ENOENT') return '该社区暂无 Wiki 页面。';
            throw e;
        }
    }
}

module.exports = WikiManager;
