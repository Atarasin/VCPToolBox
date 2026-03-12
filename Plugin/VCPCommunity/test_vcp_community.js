const { exec } = require('child_process');
const util = require('util');
const execPromise = util.promisify(exec);
const fs = require('fs').promises;
const path = require('path');

process.env.SKIP_ASSISTANT_BOOTSTRAP = 'true';
const { checkReviewTimeouts } = require('../VCPCommunityAssistant/vcp-community-assistant.js');

const PLUGIN_DIR = __dirname;
const PLUGIN_SCRIPT = path.join(PLUGIN_DIR, 'VCPCommunity.js');
const NOTIFICATIONS_FILE = path.resolve(__dirname, '../../data/VCPCommunity/config/notifications.json');
const COMMUNITIES_FILE = path.resolve(__dirname, '../../data/VCPCommunity/config/communities.json');
const PROPOSALS_FILE = path.resolve(__dirname, '../../data/VCPCommunity/config/proposals.json');

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
    // 转义单引号，避免 shell 解析错误
    const escapedInput = input.replace(/'/g, "'\\''");
    const cmd = `node "${PLUGIN_SCRIPT}" '${escapedInput}'`;
    
    try {
        const { stdout, stderr } = await execPromise(cmd);
        // 如果 stderr 有内容，并不一定代表失败，但我们要捕获 JSON 解析错误
        try {
            const response = JSON.parse(stdout);
            return response; // 返回整个 response 以便检查 status
        } catch (parseError) {
             throw new Error(`JSON Parse Error: ${stdout}. Stderr: ${stderr}`);
        }
    } catch (e) {
        // 如果是 execPromise 抛出的错误，说明命令 exit code 非 0
        // 但 VCPCommunity.js 即使报错也是通过 console.log 输出 JSON，所以通常 exit code 应该是 0
        // 除非 process.exit(1) 被调用
        // 检查 VCPCommunity.js 发现：catch (e) { ... process.exit(1); }
        // 所以我们需要解析 e.stdout 来获取错误信息
        if (e.stdout) {
             try {
                const response = JSON.parse(e.stdout);
                return response;
            } catch (parseError) {
                 throw new Error(`Command failed with exit code ${e.code}. Stdout: ${e.stdout}`);
            }
        }
        throw new Error(`Node execution failed: ${e.message}`);
    }
}

async function checkNotification(targetAgent, expectedSummarySnippet, expectedType) {
    try {
        const data = await fs.readFile(NOTIFICATIONS_FILE, 'utf-8');
        const notifications = JSON.parse(data);
        const found = notifications.find(n =>
            n.target_agent === targetAgent &&
            n.type === expectedType &&
            n.context_summary.includes(expectedSummarySnippet)
        );
        return found;
    } catch (e) {
        return null;
    }
}

async function checkNotificationByPostUid(targetAgent, postUid, expectedType) {
    try {
        const data = await fs.readFile(NOTIFICATIONS_FILE, 'utf-8');
        const notifications = JSON.parse(data);
        return notifications.find(n =>
            n.target_agent === targetAgent &&
            n.type === expectedType &&
            n.post_uid === postUid
        ) || null;
    } catch (e) {
        return null;
    }
}

async function checkNotificationContainsAll(targetAgent, expectedType, snippets) {
    try {
        const data = await fs.readFile(NOTIFICATIONS_FILE, 'utf-8');
        const notifications = JSON.parse(data);
        return notifications.find(n =>
            n.target_agent === targetAgent &&
            n.type === expectedType &&
            snippets.every(s => n.context_summary.includes(s))
        ) || null;
    } catch (e) {
        return null;
    }
}

async function runTests() {
    log(colors.blue, '=== 开始 VCPCommunity 全链路测试 ===\n');

    try {
        // 清理通知和提案文件，确保测试环境干净
        await fs.mkdir(path.dirname(NOTIFICATIONS_FILE), { recursive: true });
        await fs.writeFile(NOTIFICATIONS_FILE, '[]', 'utf-8');
        await fs.writeFile(PROPOSALS_FILE, '[]', 'utf-8');

        // Test 1: 创建社区 (CreateCommunity)
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
        if (resp1.status === 'success') {
            log(colors.green, '✓ Agent 成功创建社区');
        } else {
            throw new Error(`创建社区失败: ${JSON.stringify(resp1)}`);
        }

        // Test 2: 列出社区 (ListCommunities)
        log(colors.yellow, '\nTest 2: 列出社区 (ListCommunities)');
        const resp2 = await runCommand('ListCommunities', { agent_name: 'DevAgent' });
        if (resp2.status === 'success' && resp2.result.includes('dev-core') && resp2.result.includes(communityId)) {
            log(colors.green, '✓ 成功列出社区');
        } else {
            throw new Error(`未列出预期社区: ${JSON.stringify(resp2)}`);
        }

        // 验证 public 社区成员与维护者为空
        const configDataPublic = JSON.parse(await fs.readFile(COMMUNITIES_FILE, 'utf-8'));
        const createdCommunity = configDataPublic.communities.find(c => c.id === communityId);
        if (createdCommunity && createdCommunity.type === 'public' && createdCommunity.members.length === 0 && createdCommunity.maintainers.length === 0) {
            log(colors.green, '✓ public 社区 members/maintainers 为空');
        } else {
            throw new Error('public 社区 members/maintainers 应为空');
        }
        if (createdCommunity?.created_by === 'DevAgent') {
            log(colors.green, '✓ communities.json 记录创建者');
        } else {
            throw new Error('未记录社区创建者');
        }

        // Test 3: 发帖与提及 (CreatePost + @Mention)
        log(colors.yellow, '\nTest 3: 发帖与提及 (CreatePost)');
        const resp3 = await runCommand('CreatePost', {
            agent_name: 'DevAgent',
            community_id: 'dev-core',
            title: 'Integration Test Post',
            content: 'Hello @CodeReviewer, this is a test.'
        });
        if (resp3.status !== 'success') throw new Error(resp3.error);
        const postUid = resp3.result.match(/UID: ([0-9a-fA-F-]+)/)[1];
        log(colors.green, `✓ 帖子创建成功，UID: ${postUid}`);

        // 验证通知 (回复类型)
        const notification = await checkNotification('CodeReviewer', 'DevAgent 在 \'Integration Test Post\' 中提到了你', 'reply');
        if (notification) {
            log(colors.green, '✓ 回复通知生成成功');
        } else {
            throw new Error('未找到回复通知');
        }

        // Test 4: 回复与引用 (ReplyPost + >>UID)
        log(colors.yellow, '\nTest 4: 回复与引用 (ReplyPost)');
        const resp4 = await runCommand('ReplyPost', {
            agent_name: 'CodeReviewer',
            post_uid: postUid,
            content: `Received @DevAgent. Checking >>${postUid}`
        });
        if (resp4.status !== 'success') throw new Error(resp4.error);
        log(colors.green, '✓ 回复成功');

        // 验证回复通知 (给 DevAgent)
        const replyNotification = await checkNotification('DevAgent', '帖子回复', 'reply');
        if (replyNotification) {
            log(colors.green, '✓ 回复通知发送给 DevAgent');
        } else {
            throw new Error('未找到 DevAgent 的回复通知');
        }

        // Test 5: 读取帖子与引用解析 (ReadPost)
        log(colors.yellow, '\nTest 5: 读取帖子 (ReadPost)');
        const resp5 = await runCommand('ReadPost', {
            agent_name: 'DevAgent',
            post_uid: postUid
        });
        if (resp5.status === 'success' && resp5.result.includes('> **引用预览**:')) {
            log(colors.green, '✓ 引用解析成功 (摘要已注入)');
        } else {
            throw new Error('引用解析失败，未发现摘要注入');
        }

        // Test 6: 创建 Wiki 页面并记录保护状态 (UpdateWiki - Maintainer)
        log(colors.yellow, '\nTest 6: 创建 Wiki 页面并记录保护状态 (UpdateWiki - Maintainer)');
        const resp6 = await runCommand('UpdateWiki', {
            agent_name: 'CodeReviewer',
            community_id: 'dev-core',
            page_name: 'core.rules',
            content: '# Core Rules\n\n1. Rule A\n2. Rule B',
            edit_summary: 'Initial create'
        });
        if (resp6.status !== 'success') throw new Error(resp6.error);
        log(colors.green, '✓ Wiki 页面创建成功');

        // 验证 communities.json 中记录了保护状态
        const configData = JSON.parse(await fs.readFile(COMMUNITIES_FILE, 'utf-8'));
        const devCore = configData.communities.find(c => c.id === 'dev-core');
        if (devCore?.wiki_pages?.['core.rules']?.protected === true) {
            log(colors.green, '✓ Wiki 保护状态已写入 communities.json');
        } else {
            throw new Error('未在 communities.json 中找到 Wiki 保护状态');
        }

        // Test 7: Wiki 权限控制 (UpdateWiki - Fail)
        log(colors.yellow, '\nTest 7: Wiki 权限控制 (UpdateWiki - Fail)');
        const resp7 = await runCommand('UpdateWiki', {
            agent_name: 'DevAgent', // 非 Maintainer
            community_id: 'dev-core',
            page_name: 'core.rules',
            content: 'Hacked',
            edit_summary: 'Hack'
        });
        if (resp7.status === 'error' && resp7.error.includes('权限不足')) {
            log(colors.green, '✓ 权限控制生效 (正确拦截)');
        } else {
            throw new Error(`权限控制失效或预期外的错误: ${JSON.stringify(resp7)}`);
        }

        // Test 8: 发起提案 (ProposeWikiUpdate)
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

        // 验证审查请求通知 (Maintainers)
        const reviewRequest1 = await checkNotification('CodeReviewer', '收到新的 Wiki 更新提案', 'review_request');
        const reviewRequest2 = await checkNotification('ArchitectAgent', '收到新的 Wiki 更新提案', 'review_request');
        if (reviewRequest1 && reviewRequest2) {
            log(colors.green, '✓ 审查请求通知发送给所有 Maintainer');
        } else {
            throw new Error('未找到 Maintainer 的审查请求通知');
        }

        // Test 9: 审核提案 (ReviewProposal - 部分通过)
        log(colors.yellow, '\nTest 9: 审核提案 (ReviewProposal - 部分通过)');
        const resp9 = await runCommand('ReviewProposal', {
            agent_name: 'CodeReviewer', // Maintainer
            post_uid: proposalUid,
            decision: 'Approve',
            comment: 'Looks good.'
        });
        if (resp9.status !== 'success') throw new Error(resp9.error);
        log(colors.green, '✓ CodeReviewer 审核通过');

        // 验证未全员通过时 Wiki 未更新
        const resp9b = await runCommand('ReadWiki', {
            agent_name: 'DevAgent',
            community_id: 'dev-core',
            page_name: 'core.rules'
        });
        if (resp9b.status === 'success' && !resp9b.result.includes('Rule C')) {
            log(colors.green, '✓ 未全员通过前 Wiki 未更新');
        } else {
            throw new Error(`Wiki 不应更新: ${JSON.stringify(resp9b)}`);
        }

        // 验证未全员通过前不通知提案者
        const reviewNotificationPartial = await checkNotification('DevAgent', '评审结果: 通过', 'review');
        if (!reviewNotificationPartial) {
            log(colors.green, '✓ 未全员通过前不通知提案者');
        } else {
            throw new Error('不应在部分通过时通知提案者');
        }

        // Test 10: 审核提案 (ReviewProposal - 全员通过)
        log(colors.yellow, '\nTest 10: 审核提案 (ReviewProposal - 全员通过)');
        const resp10 = await runCommand('ReviewProposal', {
            agent_name: 'ArchitectAgent',
            post_uid: proposalUid,
            decision: 'Approve',
            comment: 'OK'
        });
        if (resp10.status !== 'success') throw new Error(resp10.error);
        log(colors.green, '✓ ArchitectAgent 审核通过');

        // 验证审查通知 (全员通过后)
        const reviewNotification = await checkNotificationContainsAll('DevAgent', 'review', ['评审结果: 通过', 'CodeReviewer(Approve)=Looks good.', 'ArchitectAgent(Approve)=OK']);
        if (reviewNotification) {
            log(colors.green, '✓ 审查通知发送给提案者（含评语汇总）');
        } else {
            throw new Error('未找到审查通知');
        }

        // Test 11: 验证 Wiki 更新 (ReadWiki)
        log(colors.yellow, '\nTest 11: 验证 Wiki 更新 (ReadWiki)');
        const resp11 = await runCommand('ReadWiki', {
            agent_name: 'DevAgent',
            community_id: 'dev-core',
            page_name: 'core.rules'
        });
        if (resp11.status === 'success' && resp11.result.includes('Rule C')) {
            log(colors.green, '✓ Wiki 内容已成功合并更新');
        } else {
            throw new Error(`Wiki 内容未更新或错误: ${JSON.stringify(resp11)}`);
        }

        log(colors.yellow, '\nTest 12: 超时拒绝审核 (Assistant Timeout)');
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
        const timeoutProposal = proposalsAfterCreate.find(p => p.post_uid === timeoutProposalUid);
        if (!timeoutProposal) throw new Error('未找到超时提案记录');
        timeoutProposal.created_at = Date.now() - 25 * 60 * 60 * 1000;
        timeoutProposal.reviews['CodeReviewer'] = { decision: 'Approve', comment: 'OK' };
        await fs.writeFile(PROPOSALS_FILE, JSON.stringify(proposalsAfterCreate, null, 2), 'utf-8');

        await checkReviewTimeouts(Date.now());

        const proposalsAfterTimeout = JSON.parse(await fs.readFile(PROPOSALS_FILE, 'utf-8'));
        const timeoutResult = proposalsAfterTimeout.find(p => p.post_uid === timeoutProposalUid);
        if (timeoutResult?.finalized && timeoutResult?.outcome === 'TimeoutReject') {
            log(colors.green, '✓ 超时提案已自动拒绝');
        } else {
            throw new Error('超时提案未自动拒绝');
        }

        const timeoutNotification = await checkNotificationContainsAll('DevAgent', 'review', ['评审结果: 超时拒绝', 'CodeReviewer(Approve)=OK', 'ArchitectAgent(Timeout)=超时未评审']);
        if (timeoutNotification) {
            log(colors.green, '✓ 超时拒绝通知包含评语汇总');
        } else {
            throw new Error('未找到超时拒绝通知或评语不完整');
        }

        const reviewRequestAfterTimeout = await checkNotificationByPostUid('ArchitectAgent', timeoutProposalUid, 'review_request');
        if (!reviewRequestAfterTimeout) {
            log(colors.green, '✓ 超时后 review_request 已清理');
        } else {
            throw new Error('超时后 review_request 未清理');
        }

        // Test 13: 发起拒绝提案 (ProposeWikiUpdate)
        log(colors.yellow, '\nTest 13: 发起拒绝提案 (ProposeWikiUpdate)');
        const resp13 = await runCommand('ProposeWikiUpdate', {
            agent_name: 'DevAgent',
            community_id: 'dev-core',
            page_name: 'core.rules',
            content: '# New Rules\n\n1. Rule A\n2. Rule B\n3. Rule C\n4. Rule D',
            rationale: 'Add Rule D'
        });
        if (resp13.status !== 'success') throw new Error(resp13.error);
        const proposalUid2 = resp13.result.match(/UID: ([0-9a-fA-F-]+)/)[1];
        log(colors.green, `✓ 拒绝提案发起成功，UID: ${proposalUid2}`);

        // Test 14: 审核提案 (ReviewProposal - 含拒绝)
        log(colors.yellow, '\nTest 14: 审核提案 (ReviewProposal - 含拒绝)');
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

        // 验证拒绝后不合并
        const resp14c = await runCommand('ReadWiki', {
            agent_name: 'DevAgent',
            community_id: 'dev-core',
            page_name: 'core.rules'
        });
        if (resp14c.status === 'success' && !resp14c.result.includes('Rule D')) {
            log(colors.green, '✓ 拒绝后 Wiki 未更新');
        } else {
            throw new Error(`拒绝后不应更新: ${JSON.stringify(resp14c)}`);
        }

        // 验证拒绝通知包含所有评语
        const rejectNotification = await checkNotificationContainsAll('DevAgent', 'review', ['评审结果: 拒绝', 'CodeReviewer(Reject)=Not acceptable', 'ArchitectAgent(Approve)=OK']);
        if (rejectNotification) {
            log(colors.green, '✓ 拒绝通知包含全部评语');
        } else {
            throw new Error('未找到拒绝通知或评语不完整');
        }

        log(colors.blue, '\n=== 所有测试通过！ ===');

    } catch (e) {
        log(colors.red, `\nTest Failed: ${e.message}`);
        process.exit(1);
    }
}

runTests();
