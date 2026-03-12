const fs = require('fs').promises;
const { CONFIG_DIR, NOTIFICATIONS_FILE } = require('../constants');

/**
 * 通知管理器 (NotificationManager)
 * 负责管理通知队列，将提及事件等通知写入 JSON 文件供助手读取。
 */
class NotificationManager {
    constructor() {
        this.notifications = [];
    }

    /**
     * 加载通知队列
     */
    async load() {
        try {
            await fs.mkdir(CONFIG_DIR, { recursive: true });
            const data = await fs.readFile(NOTIFICATIONS_FILE, 'utf-8');
            this.notifications = JSON.parse(data);
        } catch (e) {
            // 如果文件不存在，初始化为空数组
            if (e.code === 'ENOENT') {
                this.notifications = [];
            } else {
                console.error(`[VCPCommunity] 加载通知失败: ${e.message}`);
                this.notifications = [];
            }
        }
    }

    /**
     * 保存通知队列到文件
     */
    async save() {
        await fs.writeFile(NOTIFICATIONS_FILE, JSON.stringify(this.notifications, null, 2), 'utf-8');
    }

    /**
     * 添加一条通知
     * @param {string} type 通知类型 (reply / review / review_request)
     * @param {string} sourceAgent 发起通知的 Agent
     * @param {string} targetAgent 被通知的 Agent
     * @param {string} postUid 相关帖子 UID
     * @param {string} communityId 相关社区 ID
     * @param {string} summary 通知摘要
     */
    async addNotification(type, sourceAgent, targetAgent, postUid, communityId, summary) {
        await this.load();
        // 通知队列按先入先出处理
        const notification = {
            target_agent: targetAgent,
            type,
            source_agent: sourceAgent,
            post_uid: postUid,
            community_id: communityId,
            context_summary: summary,
            timestamp: Date.now(),
        };
        this.notifications.push(notification);
        await this.save();
    }

    /**
     * 添加回复通知
     */
    async addReply(sourceAgent, targetAgent, postUid, communityId, summary) {
        await this.addNotification('reply', sourceAgent, targetAgent, postUid, communityId, summary);
    }

    /**
     * 添加审查通知
     */
    async addReview(sourceAgent, targetAgent, postUid, communityId, summary) {
        await this.addNotification('review', sourceAgent, targetAgent, postUid, communityId, summary);
    }

    /**
     * 添加审查请求通知
     */
    async addReviewRequest(sourceAgent, targetAgent, postUid, communityId, summary) {
        await this.addNotification('review_request', sourceAgent, targetAgent, postUid, communityId, summary);
    }
}

module.exports = NotificationManager;
