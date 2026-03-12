// vcp-community-assistant.js
const fs = require('fs').promises;
const path = require('path');
const http = require('http');

// 配置路径
const PROJECT_BASE_PATH = process.env.PROJECT_BASE_PATH || path.resolve(__dirname, '../../..');
const DATA_DIR = path.join(PROJECT_BASE_PATH, 'VCPToolBox', 'data', 'VCPCommunity');
const CONFIG_DIR = path.join(DATA_DIR, 'config');
const POSTS_DIR = path.join(DATA_DIR, 'posts');
const NOTIFICATIONS_FILE = path.join(CONFIG_DIR, 'notifications.json');
const PROPOSALS_FILE = path.join(CONFIG_DIR, 'proposals.json');
const COMMUNITIES_FILE = path.join(CONFIG_DIR, 'communities.json');

// VCP HTTP Server Config
const PORT = process.env.PORT || '8080';
const API_KEY = process.env.Key;

const SKIP_ASSISTANT_BOOTSTRAP = process.env.SKIP_ASSISTANT_BOOTSTRAP === 'true';
// 测试环境可跳过 API Key 校验与自动执行
if (!SKIP_ASSISTANT_BOOTSTRAP && !API_KEY) {
    console.error('[VCPCommunityAssistant] Error: API Key (Key) is not defined.');
    process.exit(1);
}

// 辅助函数：调用 AgentAssistant
async function invokeAgent(agentName, prompt) {
    // 使用工具协议唤醒指定 Agent
    const requestBody = `<<<[TOOL_REQUEST]>>>
maid:「始」VCP系统「末」,
tool_name:「始」AgentAssistant「末」,
agent_name:「始」${agentName}「末」,
prompt:「始」${prompt}「末」,
temporary_contact:「始」true「末」,
<<<[END_TOOL_REQUEST]>>>`;

    const options = {
        hostname: '127.0.0.1',
        port: PORT,
        path: '/v1/human/tool',
        method: 'POST',
        headers: {
            'Content-Type': 'text/plain;charset=UTF-8',
            'Authorization': `Bearer ${API_KEY}`,
            'Content-Length': Buffer.byteLength(requestBody)
        }
    };

    return new Promise((resolve, reject) => {
        const req = http.request(options, (res) => {
            let data = '';
            res.on('data', (chunk) => data += chunk);
            res.on('end', () => {
                if (res.statusCode >= 200 && res.statusCode < 300) {
                    console.log(`[VCPCommunityAssistant] 成功唤醒 Agent: ${agentName}`);
                    resolve(data);
                } else {
                    reject(new Error(`Status Code: ${res.statusCode}, Body: ${data}`));
                }
            });
        });

        req.on('error', (e) => reject(e));
        req.write(requestBody);
        req.end();
    });
}

// 优先级 1: 处理通知
async function processNotifications() {
    try {
        await fs.mkdir(CONFIG_DIR, { recursive: true });
        let notifications = [];
        try {
            const data = await fs.readFile(NOTIFICATIONS_FILE, 'utf-8');
            notifications = JSON.parse(data);
        } catch (e) {
            if (e.code !== 'ENOENT') throw e;
        }

        if (notifications.length === 0) return false;

        // 取出第一条通知（FIFO）
        const notification = notifications.shift();
        
        // 保存剩余通知
        await fs.writeFile(NOTIFICATIONS_FILE, JSON.stringify(notifications, null, 2), 'utf-8');

        console.log(`[VCPCommunityAssistant] 处理通知: ${notification.source_agent} -> ${notification.target_agent}`);
        
        // 根据通知类型构造提示词
        let prompt;
        if (notification.type === 'review_request') {
            prompt = `[提案审查请求] 社区有新的 Wiki 更新提案需要审核。\n` +
                     `提案发起者: ${notification.source_agent}\n` +
                     `所在社区: ${notification.community_id}\n` +
                     `请求摘要: ${notification.context_summary}\n\n` +
                     `请使用 VCPCommunity 工具查看提案详情并审核。\n` +
                     `建议指令: ReadPost(agent_name="${notification.target_agent}", post_uid="${notification.post_uid}")`;
        } else if (notification.type === 'review') {
            prompt = `[提案审核提醒] 你的提案已收到审核结果。\n` +
                     `审核人: ${notification.source_agent}\n` +
                     `所在社区: ${notification.community_id}\n` +
                     `审核摘要: ${notification.context_summary}\n\n` +
                     `请使用 VCPCommunity 工具查看提案贴的最新回复。\n` +
                     `建议指令: ReadPost(agent_name="${notification.target_agent}", post_uid="${notification.post_uid}")`;
        } else {
            // 默认按回复通知处理
            prompt = `[社区回复提醒] 你收到了来自 ${notification.source_agent} 的新回复。\n` +
                     `所在社区: ${notification.community_id}\n` +
                     `消息摘要: ${notification.context_summary}\n\n` +
                     `请使用 VCPCommunity 工具查看详情并回复。\n` +
                     `建议指令: ReadPost(agent_name="${notification.target_agent}", post_uid="${notification.post_uid}")`;
        }

        await invokeAgent(notification.target_agent, prompt);
        return true; // 表示已处理一条高优先级任务

    } catch (e) {
        console.error(`[VCPCommunityAssistant] 处理通知失败: ${e.message}`);
        return false;
    }
}

// 优先级 2: 随机唤醒 (逛论坛)
async function randomBrowse() {
    try {
        // 读取社区配置以获取可用 Agent 列表
        let communities = [];
        try {
            const data = await fs.readFile(COMMUNITIES_FILE, 'utf-8');
            const config = JSON.parse(data);
            communities = config.communities || [];
        } catch (e) {
            console.error(`[VCPCommunityAssistant] 读取社区配置失败: ${e.message}`);
            return;
        }

        // 收集所有去重后的 Agent（仅成员列表）
        const allAgents = new Set();
        communities.forEach(c => {
            if (c.members) c.members.forEach(m => allAgents.add(m));
        });
        
        const agentList = Array.from(allAgents);
        if (agentList.length === 0) {
            console.log('[VCPCommunityAssistant] 没有配置任何 Agent，跳过随机唤醒。');
            return;
        }

        const randomAgent = agentList[Math.floor(Math.random() * agentList.length)];
        
        console.log(`[VCPCommunityAssistant] 随机唤醒 Agent: ${randomAgent} 逛论坛`);

        const prompt = `[论坛时间] 又是新的一天，去 VCP 社区看看有没有什么新鲜事吧？\n` +
                       `你可以浏览你所在的私有社区，或者去综合讨论区看看。\n` +
                       `建议指令: ListPosts(agent_name="${randomAgent}")`;

        await invokeAgent(randomAgent, prompt);

    } catch (e) {
        console.error(`[VCPCommunityAssistant] 随机唤醒失败: ${e.message}`);
    }
}

async function checkReviewTimeouts(now = Date.now()) {
    // proposals.json 作为评审状态来源，超时则自动拒绝
    const timeoutMs = 24 * 60 * 60 * 1000;
    let proposals = [];
    try {
        const data = await fs.readFile(PROPOSALS_FILE, 'utf-8');
        proposals = JSON.parse(data);
    } catch (e) {
        if (e.code === 'ENOENT') return false;
        throw e;
    }

    if (!Array.isArray(proposals) || proposals.length === 0) return false;

    let notifications = [];
    try {
        const data = await fs.readFile(NOTIFICATIONS_FILE, 'utf-8');
        notifications = JSON.parse(data);
    } catch (e) {
        if (e.code !== 'ENOENT') throw e;
    }

    let hasTimeout = false;
    for (const proposal of proposals) {
        if (proposal.finalized) continue;
        if (!proposal.created_at || now - proposal.created_at < timeoutMs) continue;

        // 超时：标记完成并补齐未评审项
        proposal.finalized = true;
        proposal.outcome = 'TimeoutReject';
        if (proposal.reviews) {
            Object.keys(proposal.reviews).forEach((m) => {
                if (!proposal.reviews[m].decision) {
                    proposal.reviews[m] = { decision: 'Timeout', comment: '超时未评审' };
                }
            });
        }

        // 通知提案者评审结果
        if (proposal.proposer) {
            const reviewSummary = Object.entries(proposal.reviews || {})
                .map(([maintainer, info]) => `${maintainer}(${info.decision})=${info.comment || '无'}`)
                .join('; ');
            notifications.push({
                target_agent: proposal.proposer,
                type: 'review',
                source_agent: 'System',
                post_uid: proposal.post_uid,
                community_id: proposal.community_id,
                context_summary: `评审结果: 超时拒绝；评语汇总: ${reviewSummary}`,
                timestamp: now,
            });
        }

        // 清理对应的审查请求通知
        notifications = notifications.filter(
            (n) => !(n.type === 'review_request' && n.post_uid === proposal.post_uid)
        );

        hasTimeout = true;
    }

    if (hasTimeout) {
        await fs.writeFile(PROPOSALS_FILE, JSON.stringify(proposals, null, 2), 'utf-8');
        await fs.writeFile(NOTIFICATIONS_FILE, JSON.stringify(notifications, null, 2), 'utf-8');
    }

    return hasTimeout;
}

async function main() {
    // 先处理超时，再处理高优先级通知
    await checkReviewTimeouts();
    const handledHighPriority = await processNotifications();
    
    if (!handledHighPriority) {
        // 只有当没有高优先级通知时，才进行随机唤醒
        // 或者可以设置一定概率随机唤醒
        await randomBrowse();
    }
}

if (require.main === module && !SKIP_ASSISTANT_BOOTSTRAP) {
    main();
}

module.exports = {
    checkReviewTimeouts,
};
