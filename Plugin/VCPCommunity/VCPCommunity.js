/**
 * VCPCommunity 插件主入口文件
 * 负责初始化各个管理器，处理标准输入输出，以及分发命令。
 */
const CommunityManager = require('./lib/managers/communityManager');
const NotificationManager = require('./lib/managers/notificationManager');
const PostManager = require('./lib/managers/postManager');
const WikiManager = require('./lib/managers/wikiManager');
const ProposalManager = require('./lib/managers/proposalManager');

async function main() {
    // 初始化社区管理器并加载配置
    const communityManager = new CommunityManager();
    await communityManager.load();

    // 初始化其他管理器，并注入依赖
    const notificationManager = new NotificationManager();
    const postManager = new PostManager(communityManager, notificationManager);
    const wikiManager = new WikiManager(communityManager);
    const proposalManager = new ProposalManager(communityManager, postManager, wikiManager, notificationManager);

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
            case 'ListCommunities': {
                // 列出可见社区
                const communities = communityManager.listVisibleCommunities(args.agent_name);
                result = communities.map((c) => `- [${c.id}] ${c.name} (${c.type}): ${c.description}`).join('\n');
                if (!result) result = '没有可见的社区。';
                break;
            }
            case 'JoinCommunity':
                // 加入私有社区
                result = await communityManager.joinCommunity(args.agent_name, args.community_id);
                break;
            case 'CreateCommunity':
                // 创建社区
                result = await communityManager.createCommunity(args);
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
