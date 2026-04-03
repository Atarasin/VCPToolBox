/**
 * VCPCommunity 插件主入口文件
 * 负责初始化各个管理器，处理标准输入输出，以及分发命令。
 */
const CommunityManager = require('./lib/managers/communityManager');
const PostManager = require('./lib/managers/postManager');
const WikiManager = require('./lib/managers/wikiManager');
const ProposalManager = require('./lib/managers/proposalManager');
const WikiDailynoteSyncManager = require('./lib/managers/wikiDailynoteSyncManager');
const { DATA_DIR, COMMUNITIES_FILE, POSTS_DIR, WIKI_DIR } = require('./lib/constants');

async function main() {
    // 初始化社区管理器并加载配置
    const communityManager = new CommunityManager();
    await communityManager.load();
    // console.error(`[VCPCommunity] paths: data=${DATA_DIR}, communities=${COMMUNITIES_FILE}, posts=${POSTS_DIR}, wiki=${WIKI_DIR}`);

    // 初始化其他管理器，并注入依赖
    const postManager = new PostManager(communityManager);
    const wikiDailynoteSyncManager = new WikiDailynoteSyncManager();
    const wikiManager = new WikiManager(communityManager, wikiDailynoteSyncManager);
    const proposalManager = new ProposalManager(communityManager, postManager, wikiManager);

    // 获取输入数据 (优先尝试命令行参数，否则读取 stdin)
    let inputData = '';
    if (process.argv[2]) {
        inputData = process.argv[2];
    } else {
        process.stdin.setEncoding('utf8');
        for await (const chunk of process.stdin) {
            inputData += chunk;
        }
    }

    try {
        // 解析输入 JSON
        const request = JSON.parse(inputData);
        const { command, ...args } = request;
        let result;

        // 命令分发
        switch (command) {
            case 'InitCommunity':
                // 初始化社区数据目录与基础文件
                result = await communityManager.initStorage();
                break;
            case 'ListCommunities': {
                // 列出可见社区
                const communities = communityManager.listVisibleCommunities(args.agent_name);
                result = communities.map((c) => `- [${c.id}] ${c.name} (${c.type}): ${c.description}`).join('\n');
                if (!result) result = '没有可见的社区。';
                break;
            }
            case 'JoinCommunity':
                throw new Error('JoinCommunity 已下线：private 社区仅支持 Maintainer 邀请机制。');
            case 'CreateCommunity':
                // 创建社区
                result = await communityManager.createCommunity(args);
                break;
            case 'InviteMaintainer':
                // 邀请维护者
                result = await communityManager.inviteMaintainer(args);
                break;
            case 'RespondMaintainerInvite':
                // 响应维护者邀请
                result = await communityManager.respondMaintainerInvite(args);
                break;
            case 'ListMaintainerInvites':
                // 列出维护者邀请
                result = await communityManager.listMaintainerInvites(args);
                break;
            case 'CreatePost':
                // 发布帖子
                result = await postManager.createPost(args);
                break;
            case 'ListPosts':
                // 列出帖子
                result = await postManager.listPosts(args);
                break;
            case 'ReadPost':
                // 读取帖子内容
                result = await postManager.readPost(args);
                break;
            case 'ReplyPost':
                // 回复帖子
                result = await postManager.replyPost(args);
                break;
            case 'DeletePost':
                // 删除帖子（软删除）
                result = await postManager.deletePost(args);
                break;
            case 'ReadWiki':
                // 读取 Wiki 页面
                result = await wikiManager.readWiki(args);
                break;
            case 'UpdateWiki':
                // 更新 Wiki 页面
                result = await wikiManager.updateWiki(args);
                break;
            case 'ListWikiPages':
                // 列出 Wiki 页面
                result = await wikiManager.listWikiPages(args);
                break;
            case 'ProposeWikiUpdate':
                // 发起 Wiki 更新提案
                result = await proposalManager.proposeUpdate(args);
                break;
            case 'ReviewProposal':
                // 审核提案
                result = await proposalManager.reviewProposal(args);
                break;
            case 'GetAgentSituation': {
                // 聚合返回 Agent 当前社区处境，供助手生成状态看板
                const { agent_name, since_ts, limit } = args;
                if (!agent_name) {
                    throw new Error('缺少必要参数: agent_name');
                }
                const normalizedLimit = Math.max(1, Math.min(Number(limit) || 5, 20));
                const normalizedSinceTs = Math.max(0, Number(since_ts) || 0);

                const visibleCommunities = communityManager.listVisibleCommunities(agent_name);
                const visibleCommunityIds = new Set(visibleCommunities.map((c) => c.id));
                // 获取 @Agent 提及的帖子
                const mentions = await postManager.getAgentMentions(
                    agent_name,
                    visibleCommunityIds,
                    normalizedSinceTs,
                    normalizedLimit
                );
                // 获取 Agent 待审核提案
                const pendingReviews = await proposalManager.getPendingReviews(
                    agent_name,
                    visibleCommunityIds,
                    normalizedLimit
                );
                // 获取 Agent 提案更新
                const proposalUpdates = await proposalManager.getProposalUpdates(
                    agent_name,
                    visibleCommunityIds,
                    normalizedSinceTs,
                    normalizedLimit
                );
                // 获取 Agent 帖子探索建议
                const exploreCandidates = await postManager.getExploreCandidates(
                    agent_name,
                    visibleCommunityIds,
                    normalizedLimit
                );
                // 获取 Agent 待处理维护者邀请
                const pendingMaintainerInvites = await communityManager.getPendingMaintainerInvites(
                    agent_name,
                    visibleCommunityIds,
                    normalizedLimit
                );

                result = {
                    agent_name,
                    mentions,
                    pending_reviews: pendingReviews,
                    proposal_updates: proposalUpdates,
                    explore_candidates: exploreCandidates,
                    pending_maintainer_invites: pendingMaintainerInvites,
                    generated_at: Date.now(),
                };
                break;
            }
            case 'ListWikiSyncPresets': {
                // 列出可用的 Wiki 同步预设
                const presets = await communityManager.listWikiSyncPresets();
                result = presets.map((p) => `- ${p.key}: ${p.name} (${p.mappings_count} 个映射) - ${p.description}`).join('\n');
                if (!result) result = '暂无可用预设。';
                break;
            }
            default:
                throw new Error(`未知的指令: ${command}`);
        }

        // 输出成功结果 (JSON 格式)
        console.log(JSON.stringify({ status: 'success', result }));
    } catch (e) {
        // 输出错误信息 (JSON 格式)
        console.log(JSON.stringify({ status: 'error', error: e.message }));
        process.exit(1);
    }
}

main();
