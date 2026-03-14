const { exec } = require('child_process');
const util = require('util');
const execPromise = util.promisify(exec);
const fs = require('fs').promises;
const path = require('path');

const PLUGIN_DIR = __dirname;
// 使用插件目录下独立测试根目录，避免污染真实运行数据
const TEST_SANDBOX_ROOT = path.join(PLUGIN_DIR, '.community-test-root');
process.env.PROJECT_BASE_PATH = TEST_SANDBOX_ROOT;
process.env.SKIP_ASSISTANT_BOOTSTRAP = 'true';
const { checkReviewTimeouts } = require('../VCPCommunityAssistant/vcp-community-assistant.js');

const PLUGIN_SCRIPT = path.join(PLUGIN_DIR, 'VCPCommunity.js');
const DATA_DIR = path.join(TEST_SANDBOX_ROOT, 'data', 'VCPCommunity');
const COMMUNITIES_FILE = path.join(DATA_DIR, 'config', 'communities.json');
const PROPOSALS_FILE = path.join(DATA_DIR, 'config', 'proposals.json');
const MAINTAINER_INVITES_FILE = path.join(DATA_DIR, 'config', 'maintainer_invites.json');
const POSTS_DIR = path.join(DATA_DIR, 'posts');

// 颜色输出
const colors = {
    green: '\x1b[32m',
    red: '\x1b[31m',
    yellow: '\x1b[33m',
    blue: '\x1b[34m',
    reset: '\x1b[0m'
};

function log(color, message) {
    console.log(`${color}${message}${colors.reset}`);
}

async function runCommand(command, args) {
    const input = JSON.stringify({ command, ...args });
    const escapedInput = input.replace(/'/g, "'\\''");
    const cmd = `node "${PLUGIN_SCRIPT}" '${escapedInput}'`;

    try {
        const { stdout, stderr } = await execPromise(cmd);
        try {
            return JSON.parse(stdout);
        } catch (_) {
            throw new Error(`JSON Parse Error: ${stdout}. Stderr: ${stderr}`);
        }
    } catch (e) {
        if (e.stdout) {
            try {
                return JSON.parse(e.stdout);
            } catch (_) {
                throw new Error(`Command failed with exit code ${e.code}. Stdout: ${e.stdout}`);
            }
        }
        throw new Error(`Node execution failed: ${e.message}`);
    }
}

async function findPostFilenameByUid(uid) {
    const files = await fs.readdir(POSTS_DIR);
    return files.find((file) => file.includes(`[${uid}]`) && file.endsWith('.md')) || null;
}

async function runTests() {
    log(colors.blue, '=== 开始 VCPCommunity 全链路测试 ===\n');

    try {
        // 清理独立测试目录，确保测试环境干净且不影响真实数据
        await fs.rm(TEST_SANDBOX_ROOT, { recursive: true, force: true });
        await fs.mkdir(path.dirname(PROPOSALS_FILE), { recursive: true });

        // 初始化提案文件
        await fs.writeFile(PROPOSALS_FILE, '[]', 'utf-8');

        // Test 1: 创建社区
        log(colors.yellow, 'Test 1: 创建社区 (CreateCommunity)');
        const communityId = `test-community-${Date.now()}`;
        const resp1 = await runCommand('CreateCommunity', {
            agent_name: 'DevAgent',
            community_id: communityId,
            name: '测试社区',
            description: '自动化测试用社区',
            type: 'public',
            members: ['DevAgent'],
            maintainers: ['DevAgent']
        });
        if (resp1.status !== 'success') throw new Error(`创建社区失败: ${JSON.stringify(resp1)}`);
        log(colors.green, '✓ Agent 成功创建社区');

        // Test 2: 列出社区
        log(colors.yellow, '\nTest 2: 列出社区 (ListCommunities)');
        const resp2 = await runCommand('ListCommunities', { agent_name: 'DevAgent' });
        if (!(resp2.status === 'success' && resp2.result.includes('dev-core') && resp2.result.includes(communityId))) {
            throw new Error(`未列出预期社区: ${JSON.stringify(resp2)}`);
        }
        log(colors.green, '✓ 成功列出社区');

        // 验证 public 社区成员为空，且创建者自动成为维护者
        const configDataPublic = JSON.parse(await fs.readFile(COMMUNITIES_FILE, 'utf-8'));
        const createdCommunity = configDataPublic.communities.find((c) => c.id === communityId);
        if (!(createdCommunity && createdCommunity.type === 'public' && createdCommunity.members.length === 0)) {
            throw new Error('public 社区 members 应为空');
        }
        if (!createdCommunity.maintainers.includes('DevAgent')) {
            throw new Error('创建者未自动成为维护者');
        }
        log(colors.green, '✓ public 社区创建者自动成为维护者');
        if (createdCommunity?.created_by !== 'DevAgent') {
            throw new Error('未记录社区创建者');
        }
        log(colors.green, '✓ communities.json 记录创建者');

        log(colors.yellow, '\nTest 2.1: 维护者邀请机制');
        const inviteResp = await runCommand('InviteMaintainer', {
            agent_name: 'ArchitectAgent',
            community_id: 'dev-core',
            invitee: 'DevAgent',
            reason: 'invite for maintainer'
        });
        if (inviteResp.status !== 'success') throw new Error(inviteResp.error);
        const inviteIdMatch = inviteResp.result.match(/invite_id:\s*(inv-[0-9a-z-]+)/i);
        const inviteId = inviteIdMatch?.[1];
        if (!inviteId) throw new Error(`未解析邀请ID: ${inviteResp.result}`);

        const duplicateInvite = await runCommand('InviteMaintainer', {
            agent_name: 'ArchitectAgent',
            community_id: 'dev-core',
            invitee: 'DevAgent'
        });
        if (!(duplicateInvite.status === 'error' && duplicateInvite.error.includes('待处理邀请'))) {
            throw new Error('重复待处理邀请未被拦截');
        }

        const unauthorizedInvite = await runCommand('InviteMaintainer', {
            agent_name: 'WriterAgent',
            community_id: 'dev-core',
            invitee: 'NarratorAgent'
        });
        if (!(unauthorizedInvite.status === 'error' && unauthorizedInvite.error.includes('权限不足'))) {
            throw new Error('非维护者邀请未被拦截');
        }

        const inviteList = await runCommand('ListMaintainerInvites', {
            agent_name: 'DevAgent',
            status: 'Pending'
        });
        if (!(inviteList.status === 'success' && Array.isArray(inviteList.result) && inviteList.result.some((x) => x.invite_id === inviteId))) {
            throw new Error('被邀请者未看到待处理邀请');
        }

        const pendingInviteSituation = await runCommand('GetAgentSituation', {
            agent_name: 'DevAgent',
            since_ts: 0,
            limit: 10
        });
        if (pendingInviteSituation.status !== 'success') throw new Error(pendingInviteSituation.error);
        if (!pendingInviteSituation.result.pending_maintainer_invites?.some((item) => item.invite_id === inviteId)) {
            throw new Error('GetAgentSituation 未返回待处理维护者邀请');
        }

        const wrongResponder = await runCommand('RespondMaintainerInvite', {
            agent_name: 'CodeReviewer',
            invite_id: inviteId,
            decision: 'Accept'
        });
        if (!(wrongResponder.status === 'error' && wrongResponder.error.includes('仅被邀请者'))) {
            throw new Error('非被邀请者响应未被拦截');
        }

        const acceptInvite = await runCommand('RespondMaintainerInvite', {
            agent_name: 'DevAgent',
            invite_id: inviteId,
            decision: 'Accept',
            comment: 'accept invite'
        });
        if (acceptInvite.status !== 'success') throw new Error(acceptInvite.error);

        const communitiesAfterInvite = JSON.parse(await fs.readFile(COMMUNITIES_FILE, 'utf-8'));
        const devCoreAfterInvite = communitiesAfterInvite.communities.find((c) => c.id === 'dev-core');
        if (!devCoreAfterInvite?.maintainers?.includes('DevAgent')) {
            throw new Error('接受邀请后未写入 maintainers');
        }
        if (!devCoreAfterInvite?.members?.includes('DevAgent')) {
            throw new Error('接受邀请后未保证 private 社区成员身份');
        }

        const invitesData = JSON.parse(await fs.readFile(MAINTAINER_INVITES_FILE, 'utf-8'));
        const acceptedInvite = invitesData.find((x) => x.invite_id === inviteId);
        if (!acceptedInvite || acceptedInvite.status !== 'Accepted') {
            throw new Error('邀请状态未更新为 Accepted');
        }

        const pendingInviteSituationAfterAccept = await runCommand('GetAgentSituation', {
            agent_name: 'DevAgent',
            since_ts: 0,
            limit: 10
        });
        if (pendingInviteSituationAfterAccept.status !== 'success') throw new Error(pendingInviteSituationAfterAccept.error);
        if (pendingInviteSituationAfterAccept.result.pending_maintainer_invites?.some((item) => item.invite_id === inviteId)) {
            throw new Error('邀请已接受后仍出现在 pending_maintainer_invites');
        }
        log(colors.green, '✓ 维护者邀请流程通过');

        const limitCommunityId = `maintainer-limit-${Date.now()}`;
        const limitCreateResp = await runCommand('CreateCommunity', {
            agent_name: 'OwnerAgent',
            community_id: limitCommunityId,
            name: '维护者上限测试社区',
            description: 'test max maintainers',
            type: 'private',
            members: ['OwnerAgent', 'M2', 'M3', 'M4', 'M5'],
            maintainers: ['M2', 'M3', 'M4', 'M5']
        });
        if (limitCreateResp.status !== 'success') throw new Error(limitCreateResp.error);

        const limitInviteResp = await runCommand('InviteMaintainer', {
            agent_name: 'OwnerAgent',
            community_id: limitCommunityId,
            invitee: 'M6'
        });
        if (!(limitInviteResp.status === 'error' && limitInviteResp.error.includes('上限'))) {
            throw new Error('维护者数量上限未生效');
        }
        log(colors.green, '✓ 维护者数量上限生效');

        // Test 3: 发帖与 @提及
        log(colors.yellow, '\nTest 3: 发帖与 @提及 (CreatePost)');
        const resp3 = await runCommand('CreatePost', {
            agent_name: 'DevAgent',
            community_id: 'dev-core',
            title: 'Integration Test Post',
            content: 'Hello @CodeReviewer, this is a test.'
        });
        if (resp3.status !== 'success') throw new Error(resp3.error);
        const postUid = resp3.result.match(/UID: ([0-9a-fA-F-]+)/)[1];
        log(colors.green, `✓ 帖子创建成功，UID: ${postUid}`);

        // 通过聚合接口验证 @提醒（替代 notifications.json）
        const mentionSituation = await runCommand('GetAgentSituation', {
            agent_name: 'CodeReviewer',
            since_ts: 0,
            limit: 5
        });
        if (mentionSituation.status !== 'success') throw new Error(mentionSituation.error);
        if (!mentionSituation.result.mentions.some((m) => m.post_uid === postUid)) {
            throw new Error('GetAgentSituation 未返回预期 @提醒');
        }
        log(colors.green, '✓ 通过 GetAgentSituation 获取 @提醒');

        // Test 4: 回复与引用
        log(colors.yellow, '\nTest 4: 回复与引用 (ReplyPost)');
        const resp4 = await runCommand('ReplyPost', {
            agent_name: 'CodeReviewer',
            post_uid: postUid,
            content: `Received @DevAgent. Checking >>${postUid}`
        });
        if (resp4.status !== 'success') throw new Error(resp4.error);
        log(colors.green, '✓ 回复成功');

        // Test 5: 读取帖子与引用解析
        log(colors.yellow, '\nTest 5: 读取帖子 (ReadPost)');
        const resp5 = await runCommand('ReadPost', {
            agent_name: 'DevAgent',
            post_uid: postUid
        });
        if (!(resp5.status === 'success' && resp5.result.includes('> **引用预览**:'))) {
            throw new Error('引用解析失败，未发现摘要注入');
        }
        log(colors.green, '✓ 引用解析成功 (摘要已注入)');

        // Test 5.1: 删帖权限与软删除行为
        log(colors.yellow, '\nTest 5.1: 删帖权限与软删除行为');
        const resp5DeleteDenied = await runCommand('DeletePost', {
            agent_name: 'WriterAgent',
            post_uid: postUid,
            reason: 'not allowed'
        });
        if (!(resp5DeleteDenied.status === 'error' && resp5DeleteDenied.error.includes('权限不足'))) {
            throw new Error(`非作者非维护者删帖未被正确拦截: ${JSON.stringify(resp5DeleteDenied)}`);
        }
        log(colors.green, '✓ 非授权删帖被拦截');

        const resp5Delete = await runCommand('DeletePost', {
            agent_name: 'DevAgent',
            post_uid: postUid,
            reason: '测试删除'
        });
        if (!(resp5Delete.status === 'success' && resp5Delete.result.includes('软删除'))) {
            throw new Error(`作者删帖失败: ${JSON.stringify(resp5Delete)}`);
        }
        log(colors.green, '✓ 作者删帖成功（软删除）');

        const postFiles = await fs.readdir(POSTS_DIR);
        if (!postFiles.some((f) => f.includes(`[${postUid}]`) && f.includes('[DEL@DevAgent@'))) {
            throw new Error('软删除后文件名未包含 DEL 标记');
        }
        log(colors.green, '✓ 文件名已写入 DEL 软删除标记');

        const resp5ListAfterDelete = await runCommand('ListPosts', { agent_name: 'DevAgent' });
        if (!(resp5ListAfterDelete.status === 'success' && !resp5ListAfterDelete.result.includes(postUid))) {
            throw new Error('已删除帖子仍出现在列表中');
        }
        log(colors.green, '✓ 已删除帖子不再出现在列表');

        const resp5ReadDeleted = await runCommand('ReadPost', {
            agent_name: 'DevAgent',
            post_uid: postUid
        });
        if (!(resp5ReadDeleted.status === 'success' && resp5ReadDeleted.result.includes('已删除'))) {
            throw new Error('读取已删除帖子未返回删除提示');
        }
        log(colors.green, '✓ 读取已删除帖子返回删除提示');

        const resp5ReplyDeleted = await runCommand('ReplyPost', {
            agent_name: 'CodeReviewer',
            post_uid: postUid,
            content: 'reply deleted post'
        });
        if (!(resp5ReplyDeleted.status === 'error' && resp5ReplyDeleted.error.includes('已删除'))) {
            throw new Error('对已删除帖子回复未被拦截');
        }
        log(colors.green, '✓ 对已删除帖子回复被拦截');

        const resp5MentionAfterDelete = await runCommand('GetAgentSituation', {
            agent_name: 'CodeReviewer',
            since_ts: 0,
            limit: 10
        });
        if (resp5MentionAfterDelete.status !== 'success') throw new Error(resp5MentionAfterDelete.error);
        if (resp5MentionAfterDelete.result.mentions.some((m) => m.post_uid === postUid)) {
            throw new Error('已删除帖子仍出现在 @提醒中');
        }
        log(colors.green, '✓ 已删除帖子不会出现在 @提醒中');

        const resp5CreateRefPost = await runCommand('CreatePost', {
            agent_name: 'DevAgent',
            community_id: 'dev-core',
            title: '引用已删除帖子测试',
            content: `尝试引用 >>${postUid}`
        });
        if (resp5CreateRefPost.status !== 'success') throw new Error(resp5CreateRefPost.error);
        const refPostUid = resp5CreateRefPost.result.match(/UID: ([0-9a-fA-F-]+)/)[1];
        const resp5ReadRefPost = await runCommand('ReadPost', {
            agent_name: 'DevAgent',
            post_uid: refPostUid
        });
        if (!(resp5ReadRefPost.status === 'success' && resp5ReadRefPost.result.includes('该帖子已删除'))) {
            throw new Error('引用已删除帖子时未显示删除占位提示');
        }
        log(colors.green, '✓ 引用已删除帖子时返回删除占位提示');

        // Test 6: 创建 Wiki 页面并记录保护状态
        log(colors.yellow, '\nTest 6: 创建 Wiki 页面并记录保护状态');
        const resp6 = await runCommand('UpdateWiki', {
            agent_name: 'CodeReviewer',
            community_id: 'dev-core',
            page_name: 'core.rules',
            content: '# Core Rules\n\n1. Rule A\n2. Rule B',
            edit_summary: 'Initial create'
        });
        if (resp6.status !== 'success') throw new Error(resp6.error);
        log(colors.green, '✓ Wiki 页面创建成功');

        const configData = JSON.parse(await fs.readFile(COMMUNITIES_FILE, 'utf-8'));
        const devCore = configData.communities.find((c) => c.id === 'dev-core');
        if (devCore?.wiki_pages?.['core.rules']?.protected !== true) {
            throw new Error('未在 communities.json 中找到 Wiki 保护状态');
        }
        log(colors.green, '✓ Wiki 保护状态已写入 communities.json');

        // Test 7: Wiki 权限控制
        log(colors.yellow, '\nTest 7: Wiki 权限控制 (UpdateWiki - Fail)');
        const resp7 = await runCommand('UpdateWiki', {
            agent_name: 'WriterAgent',
            community_id: 'dev-core',
            page_name: 'core.rules',
            content: 'Hacked',
            edit_summary: 'Hack'
        });
        if (!(resp7.status === 'error' && resp7.error.includes('权限不足'))) {
            throw new Error(`权限控制失效或预期外错误: ${JSON.stringify(resp7)}`);
        }
        log(colors.green, '✓ 权限控制生效 (正确拦截)');

        // Test 7.1: System 视角权限（全量浏览 + 可参与）
        log(colors.yellow, '\nTest 7.1: System 视角权限');
        const resp71ListCommunities = await runCommand('ListCommunities', { agent_name: 'System' });
        if (!(resp71ListCommunities.status === 'success' && resp71ListCommunities.result.includes('dev-core'))) {
            throw new Error(`System 未获得全量社区可见权限: ${JSON.stringify(resp71ListCommunities)}`);
        }
        const resp71ReadWiki = await runCommand('ReadWiki', {
            agent_name: 'System',
            community_id: 'dev-core',
            page_name: 'core.rules'
        });
        if (!(resp71ReadWiki.status === 'success' && resp71ReadWiki.result.includes('Core Rules'))) {
            throw new Error(`System 读取私有社区 Wiki 失败: ${JSON.stringify(resp71ReadWiki)}`);
        }
        const resp71UpdateWiki = await runCommand('UpdateWiki', {
            agent_name: 'System',
            community_id: 'dev-core',
            page_name: 'core.rules',
            content: '# Core Rules\n\n1. Rule A\n2. Rule B\n3. SystemPatch',
            edit_summary: 'system direct update'
        });
        if (resp71UpdateWiki.status !== 'success') {
            throw new Error(`System 更新受保护 Wiki 失败: ${JSON.stringify(resp71UpdateWiki)}`);
        }
        const resp71Propose = await runCommand('ProposeWikiUpdate', {
            agent_name: 'System',
            community_id: 'dev-core',
            page_name: 'core.rules',
            content: '# Core Rules\n\n1. Rule A\n2. Rule B\n3. Rule C',
            rationale: 'system propose permission check'
        });
        if (resp71Propose.status !== 'success') {
            throw new Error(`System 发起提案失败: ${JSON.stringify(resp71Propose)}`);
        }
        log(colors.green, '✓ System 具备全量浏览与参与能力');

        // Test 8: 发起提案
        log(colors.yellow, '\nTest 8: 发起提案 (ProposeWikiUpdate)');
        const resp8 = await runCommand('ProposeWikiUpdate', {
            agent_name: 'DevAgent',
            community_id: 'dev-core',
            page_name: 'core.rules',
            content: '# New Rules\n\n1. Rule A\n2. Rule B\n3. Rule C',
            rationale: 'Update rules'
        });
        if (resp8.status !== 'success') throw new Error(resp8.error);
        const proposalUid = resp8.result.match(/UID: ([0-9a-fA-F-]+)/)[1];
        log(colors.green, `✓ 提案发起成功，UID: ${proposalUid}`);

        const proposalFilename = await findPostFilenameByUid(proposalUid);
        if (!proposalFilename || !proposalFilename.includes('[[Proposal] Update Wiki_ core.rules]')) {
            throw new Error(`提案贴命名未规范化: ${proposalFilename || 'not found'}`);
        }
        log(colors.green, '✓ 提案贴命名已规范化');

        const resp8DeleteProposal = await runCommand('DeletePost', {
            agent_name: 'DevAgent',
            post_uid: proposalUid,
            reason: 'try delete pending proposal'
        });
        if (!(resp8DeleteProposal.status === 'error' && resp8DeleteProposal.error.includes('未完成的提案贴'))) {
            throw new Error(`未完成提案贴删除保护失效: ${JSON.stringify(resp8DeleteProposal)}`);
        }
        log(colors.green, '✓ 未完成提案贴删除保护生效');

        // 验证待评审项由聚合接口提供
        const reviewSituation = await runCommand('GetAgentSituation', {
            agent_name: 'CodeReviewer',
            since_ts: 0,
            limit: 5
        });
        if (reviewSituation.status !== 'success') throw new Error(reviewSituation.error);
        if (!reviewSituation.result.pending_reviews.some((p) => p.post_uid === proposalUid)) {
            throw new Error('GetAgentSituation 未返回待评审提案');
        }
        log(colors.green, '✓ GetAgentSituation 包含待评审提案');

        // Test 9: 审核提案（部分通过）
        log(colors.yellow, '\nTest 9: 审核提案 (部分通过)');
        const resp9 = await runCommand('ReviewProposal', {
            agent_name: 'CodeReviewer',
            post_uid: proposalUid,
            decision: 'Approve',
            comment: 'Looks good.'
        });
        if (resp9.status !== 'success') throw new Error(resp9.error);
        log(colors.green, '✓ CodeReviewer 审核通过');

        const proposerSituationInProgress = await runCommand('GetAgentSituation', {
            agent_name: 'DevAgent',
            since_ts: 0,
            limit: 10
        });
        if (proposerSituationInProgress.status !== 'success') throw new Error(proposerSituationInProgress.error);
        const activeUpdate = proposerSituationInProgress.result.proposal_updates.find((u) => u.post_uid === proposalUid);
        if (!activeUpdate || activeUpdate.status !== 'InProgress') {
            throw new Error('进行中的提案未在 proposal_updates 中体现');
        }
        log(colors.green, '✓ proposal_updates 仅展示进行中的提案进展');

        const resp9b = await runCommand('ReadWiki', {
            agent_name: 'DevAgent',
            community_id: 'dev-core',
            page_name: 'core.rules'
        });
        if (!(resp9b.status === 'success' && !resp9b.result.includes('Rule C'))) {
            throw new Error(`Wiki 不应更新: ${JSON.stringify(resp9b)}`);
        }
        log(colors.green, '✓ 未全员通过前 Wiki 未更新');

        // Test 10: 审核提案（全员通过）
        log(colors.yellow, '\nTest 10: 审核提案 (全员通过)');
        const resp10 = await runCommand('ReviewProposal', {
            agent_name: 'ArchitectAgent',
            post_uid: proposalUid,
            decision: 'Approve',
            comment: 'OK'
        });
        if (resp10.status !== 'success') throw new Error(resp10.error);
        log(colors.green, '✓ ArchitectAgent 审核通过');

        const resp11 = await runCommand('ReadWiki', {
            agent_name: 'DevAgent',
            community_id: 'dev-core',
            page_name: 'core.rules'
        });
        if (!(resp11.status === 'success' && resp11.result.includes('Rule C'))) {
            throw new Error(`Wiki 内容未更新: ${JSON.stringify(resp11)}`);
        }
        log(colors.green, '✓ Wiki 内容已成功合并更新');

        // 验证提案结束后不再出现在 proposal_updates
        const proposerSituation = await runCommand('GetAgentSituation', {
            agent_name: 'DevAgent',
            since_ts: 0,
            limit: 5
        });
        if (proposerSituation.status !== 'success') throw new Error(proposerSituation.error);
        const approvedUpdate = proposerSituation.result.proposal_updates.find((u) => u.post_uid === proposalUid);
        if (approvedUpdate) {
            throw new Error('提案通过后仍出现在 proposal_updates，不符合仅进行中策略');
        }
        log(colors.green, '✓ proposal_updates 不包含已结束提案');

        // Test 11: 维护者发起提案时排除本人审核
        log(colors.yellow, '\nTest 11: 维护者发起提案时排除本人审核');
        const maintainerCommunityId = `maintainer-proposal-${Date.now()}`;
        const resp11CreateCommunity = await runCommand('CreateCommunity', {
            agent_name: 'DevAgent',
            community_id: maintainerCommunityId,
            name: '维护者提案测试社区',
            description: '验证提案者本人不需重复审核',
            type: 'private',
            members: ['DevAgent', 'CodeReviewer'],
            maintainers: ['DevAgent', 'CodeReviewer']
        });
        if (resp11CreateCommunity.status !== 'success') throw new Error(resp11CreateCommunity.error);

        const resp11InitWiki = await runCommand('UpdateWiki', {
            agent_name: 'CodeReviewer',
            community_id: maintainerCommunityId,
            page_name: 'policy',
            content: '# Policy\n\nv1',
            edit_summary: 'init'
        });
        if (resp11InitWiki.status !== 'success') throw new Error(resp11InitWiki.error);

        const resp11Proposal = await runCommand('ProposeWikiUpdate', {
            agent_name: 'DevAgent',
            community_id: maintainerCommunityId,
            page_name: 'policy',
            content: '# Policy\n\nv2',
            rationale: 'maintainer proposer test'
        });
        if (resp11Proposal.status !== 'success') throw new Error(resp11Proposal.error);
        const maintainerProposalUid = resp11Proposal.result.match(/UID: ([0-9a-fA-F-]+)/)[1];

        const proposalsData = JSON.parse(await fs.readFile(PROPOSALS_FILE, 'utf-8'));
        const maintainerProposal = proposalsData.find((p) => p.post_uid === maintainerProposalUid);
        if (!maintainerProposal) throw new Error('未找到维护者发起的提案记录');
        if (!maintainerProposal.reviews.CodeReviewer || maintainerProposal.reviews.DevAgent) {
            throw new Error('维护者发起提案时，审核人应排除提案者本人');
        }
        log(colors.green, '✓ 审核人列表已排除提案者本人');

        // 提案者尝试自审时，应返回更友好的提示
        const resp11SelfReview = await runCommand('ReviewProposal', {
            agent_name: 'DevAgent',
            post_uid: maintainerProposalUid,
            decision: 'Approve',
            comment: 'self review attempt'
        });
        if (!(resp11SelfReview.status === 'error' && resp11SelfReview.error.includes('你不需要进行审核'))) {
            throw new Error(`提案者自审提示不符合预期: ${JSON.stringify(resp11SelfReview)}`);
        }
        log(colors.green, '✓ 提案者自审时返回友好提示');

        const resp11Review = await runCommand('ReviewProposal', {
            agent_name: 'CodeReviewer',
            post_uid: maintainerProposalUid,
            decision: 'Approve',
            comment: 'only other maintainer approved'
        });
        if (resp11Review.status !== 'success') throw new Error(resp11Review.error);

        const resp11ReadWiki = await runCommand('ReadWiki', {
            agent_name: 'DevAgent',
            community_id: maintainerCommunityId,
            page_name: 'policy'
        });
        if (!(resp11ReadWiki.status === 'success' && resp11ReadWiki.result.includes('v2'))) {
            throw new Error('其余维护者审核通过后，Wiki 未按预期合并');
        }
        log(colors.green, '✓ 仅剩余维护者审核即可完成合并');

        // Test 12: 唯一维护者即提案者时自动通过
        log(colors.yellow, '\nTest 12: 唯一维护者即提案者时自动通过');
        const soloMaintainerCommunityId = `solo-maintainer-${Date.now()}`;
        const resp12CreateCommunity = await runCommand('CreateCommunity', {
            agent_name: 'DevAgent',
            community_id: soloMaintainerCommunityId,
            name: '唯一维护者提案测试社区',
            description: '验证唯一维护者提案自动通过',
            type: 'private',
            members: ['DevAgent'],
            maintainers: ['DevAgent']
        });
        if (resp12CreateCommunity.status !== 'success') throw new Error(resp12CreateCommunity.error);

        const resp12InitWiki = await runCommand('UpdateWiki', {
            agent_name: 'DevAgent',
            community_id: soloMaintainerCommunityId,
            page_name: 'solo-policy',
            content: '# Solo Policy\n\nv1',
            edit_summary: 'init'
        });
        if (resp12InitWiki.status !== 'success') throw new Error(resp12InitWiki.error);

        const resp12Proposal = await runCommand('ProposeWikiUpdate', {
            agent_name: 'DevAgent',
            community_id: soloMaintainerCommunityId,
            page_name: 'solo-policy',
            content: '# Solo Policy\n\nv2',
            rationale: 'only maintainer proposer auto approve test'
        });
        if (resp12Proposal.status !== 'success') throw new Error(resp12Proposal.error);
        if (!resp12Proposal.result.includes('自动通过')) {
            throw new Error(`返回信息未体现自动通过: ${resp12Proposal.result}`);
        }
        const soloProposalUid = resp12Proposal.result.match(/UID: ([0-9a-fA-F-]+)/)[1];

        const proposalsAfterSolo = JSON.parse(await fs.readFile(PROPOSALS_FILE, 'utf-8'));
        const soloProposal = proposalsAfterSolo.find((p) => p.post_uid === soloProposalUid);
        if (!soloProposal) throw new Error('未找到唯一维护者提案记录');
        if (!(soloProposal.finalized && soloProposal.outcome === 'Approve')) {
            throw new Error('唯一维护者提案未自动通过');
        }
        if (Object.keys(soloProposal.reviews || {}).length !== 0) {
            throw new Error('唯一维护者提案不应包含待审核人');
        }
        log(colors.green, '✓ 唯一维护者提案已自动通过且无待审核人');

        const resp12ReadWiki = await runCommand('ReadWiki', {
            agent_name: 'DevAgent',
            community_id: soloMaintainerCommunityId,
            page_name: 'solo-policy'
        });
        if (!(resp12ReadWiki.status === 'success' && resp12ReadWiki.result.includes('v2'))) {
            throw new Error('唯一维护者提案自动通过后，Wiki 未按预期合并');
        }
        log(colors.green, '✓ 自动通过后 Wiki 已即时合并');

        // Test 13: 历史空维护者社区提案自动通过
        log(colors.yellow, '\nTest 13: 历史空维护者社区提案自动通过');
        const noMaintainerCommunityId = `no-maintainer-${Date.now()}`;
        const resp13CreateCommunity = await runCommand('CreateCommunity', {
            agent_name: 'DevAgent',
            community_id: noMaintainerCommunityId,
            name: '空维护者兼容测试社区',
            description: '验证旧数据 maintainers 为空时提案不会卡死',
            type: 'private',
            members: ['DevAgent'],
            maintainers: ['DevAgent']
        });
        if (resp13CreateCommunity.status !== 'success') throw new Error(resp13CreateCommunity.error);

        const communitiesForLegacy = JSON.parse(await fs.readFile(COMMUNITIES_FILE, 'utf-8'));
        const legacyCommunity = communitiesForLegacy.communities.find((c) => c.id === noMaintainerCommunityId);
        if (!legacyCommunity) throw new Error('未找到空维护者测试社区');
        legacyCommunity.maintainers = [];
        await fs.writeFile(COMMUNITIES_FILE, JSON.stringify(communitiesForLegacy, null, 2), 'utf-8');

        const resp13InitWiki = await runCommand('UpdateWiki', {
            agent_name: 'DevAgent',
            community_id: noMaintainerCommunityId,
            page_name: 'legacy-policy',
            content: '# Legacy Policy\n\nv1',
            edit_summary: 'init'
        });
        if (resp13InitWiki.status !== 'success') throw new Error(resp13InitWiki.error);

        const resp13Proposal = await runCommand('ProposeWikiUpdate', {
            agent_name: 'DevAgent',
            community_id: noMaintainerCommunityId,
            page_name: 'legacy-policy',
            content: '# Legacy Policy\n\nv2',
            rationale: 'legacy no maintainers auto approve test'
        });
        if (resp13Proposal.status !== 'success') throw new Error(resp13Proposal.error);
        if (!resp13Proposal.result.includes('社区暂无维护者')) {
            throw new Error(`空维护者自动通过提示不符合预期: ${resp13Proposal.result}`);
        }
        const noMaintainerProposalUid = resp13Proposal.result.match(/UID: ([0-9a-fA-F-]+)/)[1];

        const proposalsAfterNoMaintainer = JSON.parse(await fs.readFile(PROPOSALS_FILE, 'utf-8'));
        const noMaintainerProposal = proposalsAfterNoMaintainer.find((p) => p.post_uid === noMaintainerProposalUid);
        if (!noMaintainerProposal) throw new Error('未找到空维护者提案记录');
        if (!(noMaintainerProposal.finalized && noMaintainerProposal.outcome === 'Approve')) {
            throw new Error('空维护者提案未自动通过');
        }
        if (Object.keys(noMaintainerProposal.reviews || {}).length !== 0) {
            throw new Error('空维护者提案不应存在待审核人');
        }

        const resp13ReadWiki = await runCommand('ReadWiki', {
            agent_name: 'DevAgent',
            community_id: noMaintainerCommunityId,
            page_name: 'legacy-policy'
        });
        if (!(resp13ReadWiki.status === 'success' && resp13ReadWiki.result.includes('v2'))) {
            throw new Error('空维护者提案自动通过后，Wiki 未按预期合并');
        }
        log(colors.green, '✓ 空维护者历史社区提案可自动通过并完成合并');

        // Test 14: 超时拒绝审核
        log(colors.yellow, '\nTest 14: 超时拒绝审核 (Assistant Timeout)');
        const resp12 = await runCommand('ProposeWikiUpdate', {
            agent_name: 'DevAgent',
            community_id: 'dev-core',
            page_name: 'core.rules',
            content: '# New Rules\n\n1. Rule A\n2. Rule B\n3. Rule C\n4. Rule D',
            rationale: 'Add Rule D'
        });
        if (resp12.status !== 'success') throw new Error(resp12.error);
        const timeoutProposalUid = resp12.result.match(/UID: ([0-9a-fA-F-]+)/)[1];

        const proposalsAfterCreate = JSON.parse(await fs.readFile(PROPOSALS_FILE, 'utf-8'));
        const timeoutProposal = proposalsAfterCreate.find((p) => p.post_uid === timeoutProposalUid);
        if (!timeoutProposal) throw new Error('未找到超时提案记录');
        timeoutProposal.created_at = Date.now() - 25 * 60 * 60 * 1000;
        timeoutProposal.reviews.CodeReviewer = { decision: 'Approve', comment: 'OK' };
        await fs.writeFile(PROPOSALS_FILE, JSON.stringify(proposalsAfterCreate, null, 2), 'utf-8');

        await checkReviewTimeouts(Date.now());
        const proposalsAfterTimeout = JSON.parse(await fs.readFile(PROPOSALS_FILE, 'utf-8'));
        const timeoutResult = proposalsAfterTimeout.find((p) => p.post_uid === timeoutProposalUid);
        if (!(timeoutResult?.finalized && timeoutResult?.outcome === 'TimeoutReject')) {
            throw new Error('超时提案未自动拒绝');
        }
        log(colors.green, '✓ 超时提案已自动拒绝');

        // Test 15: 拒绝流程
        log(colors.yellow, '\nTest 15: 拒绝流程');
        const resp14CreateReject = await runCommand('ProposeWikiUpdate', {
            agent_name: 'DevAgent',
            community_id: 'dev-core',
            page_name: 'core.rules',
            content: '# New Rules\n\n1. Rule A\n2. Rule B\n3. Rule C\n4. Rule D',
            rationale: 'Add Rule D'
        });
        if (resp14CreateReject.status !== 'success') throw new Error(resp14CreateReject.error);
        const proposalUid2 = resp14CreateReject.result.match(/UID: ([0-9a-fA-F-]+)/)[1];

        const resp14 = await runCommand('ReviewProposal', {
            agent_name: 'CodeReviewer',
            post_uid: proposalUid2,
            decision: 'Reject',
            comment: 'Not acceptable'
        });
        if (resp14.status !== 'success') throw new Error(resp14.error);
        const resp14b = await runCommand('ReviewProposal', {
            agent_name: 'ArchitectAgent',
            post_uid: proposalUid2,
            decision: 'Approve',
            comment: 'OK'
        });
        if (resp14b.status !== 'success') throw new Error(resp14b.error);
        log(colors.green, '✓ 拒绝流程完成所有审核');

        const resp14c = await runCommand('ReadWiki', {
            agent_name: 'DevAgent',
            community_id: 'dev-core',
            page_name: 'core.rules'
        });
        if (!(resp14c.status === 'success' && !resp14c.result.includes('Rule D'))) {
            throw new Error(`拒绝后不应更新: ${JSON.stringify(resp14c)}`);
        }
        log(colors.green, '✓ 拒绝后 Wiki 未更新');

        const proposerSituation2 = await runCommand('GetAgentSituation', {
            agent_name: 'DevAgent',
            since_ts: 0,
            limit: 10
        });
        if (proposerSituation2.status !== 'success') throw new Error(proposerSituation2.error);
        const rejectUpdate = proposerSituation2.result.proposal_updates.find((u) => u.post_uid === proposalUid2);
        if (rejectUpdate) {
            throw new Error('提案拒绝后仍出现在 proposal_updates，不符合仅进行中策略');
        }
        log(colors.green, '✓ proposal_updates 不包含已拒绝提案');

        log(colors.blue, '\n=== 所有测试通过！ ===');
    } catch (e) {
        log(colors.red, `\nTest Failed: ${e.message}`);
        process.exit(1);
    }
}

runTests();
