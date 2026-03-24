const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs/promises');
const { createSandboxContext } = require('./helpers/communityTestHarness');

test('Wiki与提案流程：权限、审核、自动通过、超时拒绝与拒绝分支', async () => {
    const ctx = await createSandboxContext('vcpcommunity-wiki-proposal-');
    const respInitDevCore = await ctx.runCommand('CreateCommunity', {
        agent_name: 'ArchitectAgent',
        community_id: 'dev-core',
        name: '核心开发组',
        description: '测试初始化社区',
        type: 'private',
        members: ['DevAgent', 'CodeReviewer'],
        maintainers: ['ArchitectAgent', 'CodeReviewer']
    });
    assert.equal(respInitDevCore.status, 'success');

    const resp6 = await ctx.runCommand('UpdateWiki', {
        agent_name: 'CodeReviewer',
        community_id: 'dev-core',
        page_name: 'core.rules',
        content: '# Core Rules\n\n1. Rule A\n2. Rule B',
        edit_summary: 'Initial create'
    });
    assert.equal(resp6.status, 'success');

    const resp6ReadWiki = await ctx.runCommand('ReadWiki', {
        agent_name: 'CodeReviewer',
        community_id: 'dev-core',
        page_name: 'core.rules'
    });
    assert.equal(resp6ReadWiki.status, 'success');
    assert.equal(/^---\nlast updated: \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\nagent name: CodeReviewer\nedit summary: Initial create\n---/m.test(resp6ReadWiki.result), true);

    const configData = await ctx.readJson(ctx.communitiesFile);
    const devCore = configData.communities.find((c) => c.id === 'dev-core');
    assert.equal((devCore?.wiki_pages?.['core.rules.md']?.protected ?? devCore?.wiki_pages?.['core.rules']?.protected) === true, true);

    const resp7 = await ctx.runCommand('UpdateWiki', {
        agent_name: 'WriterAgent',
        community_id: 'dev-core',
        page_name: 'core.rules',
        content: 'Hacked',
        edit_summary: 'Hack'
    });
    assert.equal(resp7.status, 'error');
    assert.equal(resp7.error.includes('权限不足'), true);

    const resp71ListCommunities = await ctx.runCommand('ListCommunities', { agent_name: 'System' });
    assert.equal(resp71ListCommunities.status, 'success');
    assert.equal(resp71ListCommunities.result.includes('dev-core'), true);
    const resp71ReadWiki = await ctx.runCommand('ReadWiki', {
        agent_name: 'System',
        community_id: 'dev-core',
        page_name: 'core.rules'
    });
    assert.equal(resp71ReadWiki.status, 'success');
    assert.equal(resp71ReadWiki.result.includes('Core Rules'), true);
    const resp71UpdateWiki = await ctx.runCommand('UpdateWiki', {
        agent_name: 'System',
        community_id: 'dev-core',
        page_name: 'core.rules',
        content: '# Core Rules\n\n1. Rule A\n2. Rule B\n3. SystemPatch',
        edit_summary: 'system direct update'
    });
    assert.equal(resp71UpdateWiki.status, 'success');
    const resp71Propose = await ctx.runCommand('ProposeWikiUpdate', {
        agent_name: 'System',
        community_id: 'dev-core',
        page_name: 'core.rules',
        content: '# Core Rules\n\n1. Rule A\n2. Rule B\n3. Rule C',
        rationale: 'system propose permission check'
    });
    assert.equal(resp71Propose.status, 'success');

    const resp8 = await ctx.runCommand('ProposeWikiUpdate', {
        agent_name: 'DevAgent',
        community_id: 'dev-core',
        page_name: 'core.rules',
        content: '# New Rules\n\n1. Rule A\n2. Rule B\n3. Rule C',
        rationale: 'Update rules'
    });
    assert.equal(resp8.status, 'success');
    const proposalUid = resp8.result.match(/UID: ([0-9a-fA-F-]+)/)[1];

    const proposalFilename = await ctx.findPostFilenameByUid(proposalUid);
    assert.ok(proposalFilename);
    assert.equal(proposalFilename.includes('[[Proposal] Update Wiki_ core.rules]'), true);

    const resp8DeleteProposal = await ctx.runCommand('DeletePost', {
        agent_name: 'DevAgent',
        post_uid: proposalUid,
        reason: 'try delete pending proposal'
    });
    assert.equal(resp8DeleteProposal.status, 'error');
    assert.equal(resp8DeleteProposal.error.includes('未完成的提案贴'), true);

    const reviewSituation = await ctx.runCommand('GetAgentSituation', {
        agent_name: 'CodeReviewer',
        since_ts: 0,
        limit: 5
    });
    assert.equal(reviewSituation.status, 'success');
    assert.equal(reviewSituation.result.pending_reviews.some((p) => p.post_uid === proposalUid), true);

    const resp9 = await ctx.runCommand('ReviewProposal', {
        agent_name: 'CodeReviewer',
        post_uid: proposalUid,
        decision: 'Approve',
        comment: 'Looks good.'
    });
    assert.equal(resp9.status, 'success');

    const proposerSituationInProgress = await ctx.runCommand('GetAgentSituation', {
        agent_name: 'DevAgent',
        since_ts: 0,
        limit: 10
    });
    assert.equal(proposerSituationInProgress.status, 'success');
    const activeUpdate = proposerSituationInProgress.result.proposal_updates.find((u) => u.post_uid === proposalUid);
    assert.ok(activeUpdate);
    assert.equal(activeUpdate.status, 'InProgress');

    const resp9b = await ctx.runCommand('ReadWiki', {
        agent_name: 'DevAgent',
        community_id: 'dev-core',
        page_name: 'core.rules'
    });
    assert.equal(resp9b.status, 'success');
    assert.equal(resp9b.result.includes('Rule C'), false);

    const resp10 = await ctx.runCommand('ReviewProposal', {
        agent_name: 'ArchitectAgent',
        post_uid: proposalUid,
        decision: 'Approve',
        comment: 'OK'
    });
    assert.equal(resp10.status, 'success');

    const resp11 = await ctx.runCommand('ReadWiki', {
        agent_name: 'DevAgent',
        community_id: 'dev-core',
        page_name: 'core.rules'
    });
    assert.equal(resp11.status, 'success');
    assert.equal(resp11.result.includes('Rule C'), true);

    const proposerSituation = await ctx.runCommand('GetAgentSituation', {
        agent_name: 'DevAgent',
        since_ts: 0,
        limit: 5
    });
    assert.equal(proposerSituation.status, 'success');
    assert.equal(proposerSituation.result.proposal_updates.some((u) => u.post_uid === proposalUid), false);

    const respTagProposal = await ctx.runCommand('ProposeWikiUpdate', {
        agent_name: 'DevAgent',
        community_id: 'dev-core',
        page_name: 'core.rules',
        content: '# New Rules\n\n1. Rule A\n2. Rule B\n3. Rule C\n4. Rule E',
        rationale: 'Add Rule E with tag',
        tag: '核心规则，审判流程'
    });
    assert.equal(respTagProposal.status, 'success');
    const tagProposalUid = respTagProposal.result.match(/UID: ([0-9a-fA-F-]+)/)[1];

    const respTagReview1 = await ctx.runCommand('ReviewProposal', {
        agent_name: 'CodeReviewer',
        post_uid: tagProposalUid,
        decision: 'Approve',
        comment: 'tag ok'
    });
    assert.equal(respTagReview1.status, 'success');

    const respTagReview2 = await ctx.runCommand('ReviewProposal', {
        agent_name: 'ArchitectAgent',
        post_uid: tagProposalUid,
        decision: 'Approve',
        comment: 'merge tag'
    });
    assert.equal(respTagReview2.status, 'success');

    const respTagReadWiki = await ctx.runCommand('ReadWiki', {
        agent_name: 'DevAgent',
        community_id: 'dev-core',
        page_name: 'core.rules'
    });
    assert.equal(respTagReadWiki.status, 'success');
    assert.equal(respTagReadWiki.result.includes('Rule E'), true);
    assert.equal(respTagReadWiki.result.trimEnd().endsWith('Tag: 核心规则, 审判流程'), true);

    const respInlineTagProposal = await ctx.runCommand('ProposeWikiUpdate', {
        agent_name: 'DevAgent',
        community_id: 'dev-core',
        page_name: 'core.rules',
        content: '# New Rules\n\n1. Rule A\n2. Rule B\n3. Rule C\n4. Rule F\n\n**Tag**: 绝迹仙途, 世界观设定，玄阴宗',
        rationale: 'inline tag in content'
    });
    assert.equal(respInlineTagProposal.status, 'success');
    const inlineTagProposalUid = respInlineTagProposal.result.match(/UID: ([0-9a-fA-F-]+)/)[1];

    const respInlineTagReview1 = await ctx.runCommand('ReviewProposal', {
        agent_name: 'CodeReviewer',
        post_uid: inlineTagProposalUid,
        decision: 'Approve',
        comment: 'inline tag ok'
    });
    assert.equal(respInlineTagReview1.status, 'success');

    const respInlineTagReview2 = await ctx.runCommand('ReviewProposal', {
        agent_name: 'ArchitectAgent',
        post_uid: inlineTagProposalUid,
        decision: 'Approve',
        comment: 'merge inline tag'
    });
    assert.equal(respInlineTagReview2.status, 'success');

    const respInlineTagReadWiki = await ctx.runCommand('ReadWiki', {
        agent_name: 'DevAgent',
        community_id: 'dev-core',
        page_name: 'core.rules'
    });
    assert.equal(respInlineTagReadWiki.status, 'success');
    assert.equal(respInlineTagReadWiki.result.includes('**Tag**:'), false);
    assert.equal(respInlineTagReadWiki.result.trimEnd().endsWith('Tag: 绝迹仙途, 世界观设定, 玄阴宗'), true);

    await ctx.writeJson(path.join(ctx.configDir, 'wiki_dailynote_mappings.json'), {
        enabled: true,
        mappings: [
            {
                community_id: 'dev-core',
                wiki_prefix: '00_requirements',
                dailynote_dir: '小说创作需求'
            }
        ]
    });

    const respSyncByReviewProposal = await ctx.runCommand('ProposeWikiUpdate', {
        agent_name: 'DevAgent',
        community_id: 'dev-core',
        page_name: '00_requirements',
        content: '# Requirements\n\n- Core concept',
        rationale: '验证审核通过后同步日记'
    });
    assert.equal(respSyncByReviewProposal.status, 'success');
    const syncByReviewProposalUid = respSyncByReviewProposal.result.match(/UID: ([0-9a-fA-F-]+)/)[1];

    const respSyncByReviewApprove1 = await ctx.runCommand('ReviewProposal', {
        agent_name: 'CodeReviewer',
        post_uid: syncByReviewProposalUid,
        decision: 'Approve',
        comment: 'ok'
    });
    assert.equal(respSyncByReviewApprove1.status, 'success');

    const respSyncByReviewApprove2 = await ctx.runCommand('ReviewProposal', {
        agent_name: 'ArchitectAgent',
        post_uid: syncByReviewProposalUid,
        decision: 'Approve',
        comment: 'ok'
    });
    assert.equal(respSyncByReviewApprove2.status, 'success');

    const syncedByReviewPath = path.join(ctx.sandboxRoot, 'dailynote', '小说创作需求', '00_requirements.md');
    const syncedByReviewContent = await fs.readFile(syncedByReviewPath, 'utf8');
    assert.equal(syncedByReviewContent.includes('# Requirements'), true);
    assert.equal(syncedByReviewContent.includes('edit summary: Merged proposal from'), true);

    const maintainerCommunityId = `maintainer-proposal-${Date.now()}`;
    const resp11CreateCommunity = await ctx.runCommand('CreateCommunity', {
        agent_name: 'DevAgent',
        community_id: maintainerCommunityId,
        name: '维护者提案测试社区',
        description: '验证提案者本人不需重复审核',
        type: 'private',
        members: ['DevAgent', 'CodeReviewer'],
        maintainers: ['DevAgent', 'CodeReviewer']
    });
    assert.equal(resp11CreateCommunity.status, 'success');

    const resp11InitWiki = await ctx.runCommand('UpdateWiki', {
        agent_name: 'CodeReviewer',
        community_id: maintainerCommunityId,
        page_name: 'policy',
        content: '# Policy\n\nv1',
        edit_summary: 'init'
    });
    assert.equal(resp11InitWiki.status, 'success');

    const resp11Proposal = await ctx.runCommand('ProposeWikiUpdate', {
        agent_name: 'DevAgent',
        community_id: maintainerCommunityId,
        page_name: 'policy',
        content: '# Policy\n\nv2',
        rationale: 'maintainer proposer test'
    });
    assert.equal(resp11Proposal.status, 'success');
    const maintainerProposalUid = resp11Proposal.result.match(/UID: ([0-9a-fA-F-]+)/)[1];

    const proposalsData = await ctx.readJson(ctx.proposalsFile);
    const maintainerProposal = proposalsData.find((p) => p.post_uid === maintainerProposalUid);
    assert.ok(maintainerProposal);
    assert.ok(maintainerProposal.reviews.CodeReviewer);
    assert.equal(Boolean(maintainerProposal.reviews.DevAgent), false);

    const resp11SelfReview = await ctx.runCommand('ReviewProposal', {
        agent_name: 'DevAgent',
        post_uid: maintainerProposalUid,
        decision: 'Approve',
        comment: 'self review attempt'
    });
    assert.equal(resp11SelfReview.status, 'error');
    assert.equal(resp11SelfReview.error.includes('你不需要进行审核'), true);

    const resp11Review = await ctx.runCommand('ReviewProposal', {
        agent_name: 'CodeReviewer',
        post_uid: maintainerProposalUid,
        decision: 'Approve',
        comment: 'only other maintainer approved'
    });
    assert.equal(resp11Review.status, 'success');

    const resp11ReadWiki = await ctx.runCommand('ReadWiki', {
        agent_name: 'DevAgent',
        community_id: maintainerCommunityId,
        page_name: 'policy'
    });
    assert.equal(resp11ReadWiki.status, 'success');
    assert.equal(resp11ReadWiki.result.includes('v2'), true);

    const soloMaintainerCommunityId = `solo-maintainer-${Date.now()}`;
    const resp12CreateCommunity = await ctx.runCommand('CreateCommunity', {
        agent_name: 'DevAgent',
        community_id: soloMaintainerCommunityId,
        name: '唯一维护者提案测试社区',
        description: '验证唯一维护者提案自动通过',
        type: 'private',
        members: ['DevAgent'],
        maintainers: ['DevAgent']
    });
    assert.equal(resp12CreateCommunity.status, 'success');

    const resp12InitWiki = await ctx.runCommand('UpdateWiki', {
        agent_name: 'DevAgent',
        community_id: soloMaintainerCommunityId,
        page_name: 'solo-policy',
        content: '# Solo Policy\n\nv1',
        edit_summary: 'init'
    });
    assert.equal(resp12InitWiki.status, 'success');

    const resp12Proposal = await ctx.runCommand('ProposeWikiUpdate', {
        agent_name: 'DevAgent',
        community_id: soloMaintainerCommunityId,
        page_name: 'solo-policy',
        content: '# Solo Policy\n\nv2',
        rationale: 'only maintainer proposer auto approve test'
    });
    assert.equal(resp12Proposal.status, 'success');
    assert.equal(resp12Proposal.result.includes('自动通过'), true);
    const soloProposalUid = resp12Proposal.result.match(/UID: ([0-9a-fA-F-]+)/)[1];

    const proposalsAfterSolo = await ctx.readJson(ctx.proposalsFile);
    const soloProposal = proposalsAfterSolo.find((p) => p.post_uid === soloProposalUid);
    assert.ok(soloProposal);
    assert.equal(soloProposal.finalized, true);
    assert.equal(soloProposal.outcome, 'Approve');
    assert.equal(Object.keys(soloProposal.reviews || {}).length, 0);

    const resp12ReadWiki = await ctx.runCommand('ReadWiki', {
        agent_name: 'DevAgent',
        community_id: soloMaintainerCommunityId,
        page_name: 'solo-policy'
    });
    assert.equal(resp12ReadWiki.status, 'success');
    assert.equal(resp12ReadWiki.result.includes('v2'), true);

    const noMaintainerCommunityId = `no-maintainer-${Date.now()}`;
    const resp13CreateCommunity = await ctx.runCommand('CreateCommunity', {
        agent_name: 'DevAgent',
        community_id: noMaintainerCommunityId,
        name: '空维护者兼容测试社区',
        description: '验证旧数据 maintainers 为空时提案不会卡死',
        type: 'private',
        members: ['DevAgent'],
        maintainers: ['DevAgent']
    });
    assert.equal(resp13CreateCommunity.status, 'success');

    const communitiesForLegacy = await ctx.readJson(ctx.communitiesFile);
    const legacyCommunity = communitiesForLegacy.communities.find((c) => c.id === noMaintainerCommunityId);
    assert.ok(legacyCommunity);
    legacyCommunity.maintainers = [];
    await ctx.writeJson(ctx.communitiesFile, communitiesForLegacy);

    const resp13InitWiki = await ctx.runCommand('UpdateWiki', {
        agent_name: 'DevAgent',
        community_id: noMaintainerCommunityId,
        page_name: 'legacy-policy',
        content: '# Legacy Policy\n\nv1',
        edit_summary: 'init'
    });
    assert.equal(resp13InitWiki.status, 'success');

    const resp13Proposal = await ctx.runCommand('ProposeWikiUpdate', {
        agent_name: 'DevAgent',
        community_id: noMaintainerCommunityId,
        page_name: 'legacy-policy',
        content: '# Legacy Policy\n\nv2',
        rationale: 'legacy no maintainers auto approve test'
    });
    assert.equal(resp13Proposal.status, 'success');
    assert.equal(resp13Proposal.result.includes('社区暂无维护者'), true);
    const noMaintainerProposalUid = resp13Proposal.result.match(/UID: ([0-9a-fA-F-]+)/)[1];

    const proposalsAfterNoMaintainer = await ctx.readJson(ctx.proposalsFile);
    const noMaintainerProposal = proposalsAfterNoMaintainer.find((p) => p.post_uid === noMaintainerProposalUid);
    assert.ok(noMaintainerProposal);
    assert.equal(noMaintainerProposal.finalized, true);
    assert.equal(noMaintainerProposal.outcome, 'Approve');
    assert.equal(Object.keys(noMaintainerProposal.reviews || {}).length, 0);

    const resp13ReadWiki = await ctx.runCommand('ReadWiki', {
        agent_name: 'DevAgent',
        community_id: noMaintainerCommunityId,
        page_name: 'legacy-policy'
    });
    assert.equal(resp13ReadWiki.status, 'success');
    assert.equal(resp13ReadWiki.result.includes('v2'), true);

    const respTimeoutProposal = await ctx.runCommand('ProposeWikiUpdate', {
        agent_name: 'DevAgent',
        community_id: 'dev-core',
        page_name: 'core.rules',
        content: '# New Rules\n\n1. Rule A\n2. Rule B\n3. Rule C\n4. Rule D',
        rationale: 'Add Rule D'
    });
    assert.equal(respTimeoutProposal.status, 'success');
    const timeoutProposalUid = respTimeoutProposal.result.match(/UID: ([0-9a-fA-F-]+)/)[1];

    const proposalsAfterCreate = await ctx.readJson(ctx.proposalsFile);
    const timeoutProposal = proposalsAfterCreate.find((p) => p.post_uid === timeoutProposalUid);
    assert.ok(timeoutProposal);
    timeoutProposal.created_at = Date.now() - 25 * 60 * 60 * 1000;
    timeoutProposal.reviews.CodeReviewer = { decision: 'Approve', comment: 'OK' };
    await ctx.writeJson(ctx.proposalsFile, proposalsAfterCreate);

    await ctx.checkReviewTimeouts(Date.now());
    const proposalsAfterTimeout = await ctx.readJson(ctx.proposalsFile);
    const timeoutResult = proposalsAfterTimeout.find((p) => p.post_uid === timeoutProposalUid);
    assert.ok(timeoutResult);
    assert.equal(timeoutResult.finalized, true);
    assert.equal(timeoutResult.outcome, 'TimeoutReject');

    const respRejectProposal = await ctx.runCommand('ProposeWikiUpdate', {
        agent_name: 'DevAgent',
        community_id: 'dev-core',
        page_name: 'core.rules',
        content: '# New Rules\n\n1. Rule A\n2. Rule B\n3. Rule C\n4. Rule D',
        rationale: 'Add Rule D'
    });
    assert.equal(respRejectProposal.status, 'success');
    const proposalUid2 = respRejectProposal.result.match(/UID: ([0-9a-fA-F-]+)/)[1];

    const respReject1 = await ctx.runCommand('ReviewProposal', {
        agent_name: 'CodeReviewer',
        post_uid: proposalUid2,
        decision: 'Reject',
        comment: 'Not acceptable'
    });
    assert.equal(respReject1.status, 'success');
    const respReject2 = await ctx.runCommand('ReviewProposal', {
        agent_name: 'ArchitectAgent',
        post_uid: proposalUid2,
        decision: 'Approve',
        comment: 'OK'
    });
    assert.equal(respReject2.status, 'success');

    const resp14c = await ctx.runCommand('ReadWiki', {
        agent_name: 'DevAgent',
        community_id: 'dev-core',
        page_name: 'core.rules'
    });
    assert.equal(resp14c.status, 'success');
    assert.equal(resp14c.result.includes('Rule D'), false);

    const proposerSituation2 = await ctx.runCommand('GetAgentSituation', {
        agent_name: 'DevAgent',
        since_ts: 0,
        limit: 10
    });
    assert.equal(proposerSituation2.status, 'success');
    assert.equal(proposerSituation2.result.proposal_updates.some((u) => u.post_uid === proposalUid2), false);
});
