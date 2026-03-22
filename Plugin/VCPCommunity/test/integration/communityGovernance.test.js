const test = require('node:test');
const assert = require('node:assert/strict');
const { createSandboxContext } = require('./helpers/communityTestHarness');

test('社区治理能力：创建、可见性、自助加入下线、维护者邀请、private 写并集', async () => {
    const ctx = await createSandboxContext('vcpcommunity-governance-');

    const communityId = `test-community-${Date.now()}`;
    const resp1 = await ctx.runCommand('CreateCommunity', {
        agent_name: 'DevAgent',
        community_id: communityId,
        name: '测试社区',
        description: '自动化测试用社区',
        type: 'public',
        members: ['DevAgent'],
        maintainers: ['DevAgent']
    });
    assert.equal(resp1.status, 'success');

    const resp2 = await ctx.runCommand('ListCommunities', { agent_name: 'DevAgent' });
    assert.equal(resp2.status, 'success');
    assert.equal(resp2.result.includes('dev-core'), true);
    assert.equal(resp2.result.includes(communityId), true);

    const configDataPublic = await ctx.readJson(ctx.communitiesFile);
    const createdCommunity = configDataPublic.communities.find((c) => c.id === communityId);
    assert.equal(createdCommunity.type, 'public');
    assert.equal(createdCommunity.members.length, 0);
    assert.equal(createdCommunity.maintainers.includes('DevAgent'), true);
    assert.equal(createdCommunity.created_by, 'DevAgent');

    const joinPrivateResp = await ctx.runCommand('JoinCommunity', {
        agent_name: 'WriterAgent',
        community_id: 'dev-core'
    });
    assert.equal(joinPrivateResp.status, 'error');
    assert.equal(joinPrivateResp.error.includes('JoinCommunity 已下线'), true);

    const stringArrayCommunityId = `string-array-${Date.now()}`;
    const createByStringArrayResp = await ctx.runCommand('CreateCommunity', {
        agent_name: '阿卡夏',
        community_id: stringArrayCommunityId,
        name: '字符串数组解析测试',
        description: 'test string array parse',
        type: 'private',
        members: '[&quot;忒伊亚&quot;,&quot;阿卡夏&quot;,&quot;皮格马利翁&quot;,&quot;摩伊赖&quot;,&quot;塔罗&quot;,&quot;阿努比斯&quot;]',
        maintainers: '[]'
    });
    assert.equal(createByStringArrayResp.status, 'success');
    const stringArrayConfig = await ctx.readJson(ctx.communitiesFile);
    const stringArrayCommunity = stringArrayConfig.communities.find((c) => c.id === stringArrayCommunityId);
    const expectedMembers = ['忒伊亚', '阿卡夏', '皮格马利翁', '摩伊赖', '塔罗', '阿努比斯'];
    assert.ok(stringArrayCommunity);
    expectedMembers.forEach((name) => assert.equal(stringArrayCommunity.members.includes(name), true));

    const inviteResp = await ctx.runCommand('InviteMaintainer', {
        agent_name: 'ArchitectAgent',
        community_id: 'dev-core',
        invitee: 'DevAgent',
        reason: 'invite for maintainer'
    });
    assert.equal(inviteResp.status, 'success');
    const inviteIdMatch = inviteResp.result.match(/invite_id:\s*(inv-[0-9a-z-]+)/i);
    const inviteId = inviteIdMatch?.[1];
    assert.ok(inviteId);

    const duplicateInvite = await ctx.runCommand('InviteMaintainer', {
        agent_name: 'ArchitectAgent',
        community_id: 'dev-core',
        invitee: 'DevAgent'
    });
    assert.equal(duplicateInvite.status, 'error');
    assert.equal(duplicateInvite.error.includes('待处理邀请'), true);

    const unauthorizedInvite = await ctx.runCommand('InviteMaintainer', {
        agent_name: 'WriterAgent',
        community_id: 'dev-core',
        invitee: 'NarratorAgent'
    });
    assert.equal(unauthorizedInvite.status, 'error');
    assert.equal(unauthorizedInvite.error.includes('权限不足'), true);

    const inviteList = await ctx.runCommand('ListMaintainerInvites', {
        agent_name: 'DevAgent',
        status: 'Pending'
    });
    assert.equal(inviteList.status, 'success');
    assert.equal(Array.isArray(inviteList.result), true);
    assert.equal(inviteList.result.some((x) => x.invite_id === inviteId), true);

    const pendingInviteSituation = await ctx.runCommand('GetAgentSituation', {
        agent_name: 'DevAgent',
        since_ts: 0,
        limit: 10
    });
    assert.equal(pendingInviteSituation.status, 'success');
    assert.equal(pendingInviteSituation.result.pending_maintainer_invites.some((item) => item.invite_id === inviteId), true);

    const wrongResponder = await ctx.runCommand('RespondMaintainerInvite', {
        agent_name: 'CodeReviewer',
        invite_id: inviteId,
        decision: 'Accept'
    });
    assert.equal(wrongResponder.status, 'error');
    assert.equal(wrongResponder.error.includes('仅被邀请者'), true);

    const acceptInvite = await ctx.runCommand('RespondMaintainerInvite', {
        agent_name: 'DevAgent',
        invite_id: inviteId,
        decision: 'Accept',
        comment: 'accept invite'
    });
    assert.equal(acceptInvite.status, 'success');

    const communitiesAfterInvite = await ctx.readJson(ctx.communitiesFile);
    const devCoreAfterInvite = communitiesAfterInvite.communities.find((c) => c.id === 'dev-core');
    assert.equal(devCoreAfterInvite.maintainers.includes('DevAgent'), true);
    assert.equal(devCoreAfterInvite.members.includes('DevAgent'), true);

    const invitesData = await ctx.readJson(ctx.maintainerInvitesFile);
    const acceptedInvite = invitesData.find((x) => x.invite_id === inviteId);
    assert.equal(acceptedInvite.status, 'Accepted');

    const pendingInviteSituationAfterAccept = await ctx.runCommand('GetAgentSituation', {
        agent_name: 'DevAgent',
        since_ts: 0,
        limit: 10
    });
    assert.equal(pendingInviteSituationAfterAccept.status, 'success');
    assert.equal(pendingInviteSituationAfterAccept.result.pending_maintainer_invites.some((item) => item.invite_id === inviteId), false);

    const limitCommunityId = `maintainer-limit-${Date.now()}`;
    const limitCreateResp = await ctx.runCommand('CreateCommunity', {
        agent_name: 'OwnerAgent',
        community_id: limitCommunityId,
        name: '维护者上限测试社区',
        description: 'test max maintainers',
        type: 'private',
        members: ['OwnerAgent', 'M2', 'M3', 'M4', 'M5'],
        maintainers: ['OwnerAgent', 'M2', 'M3', 'M4']
    });
    assert.equal(limitCreateResp.status, 'success');

    const limitInviteResp = await ctx.runCommand('InviteMaintainer', {
        agent_name: 'OwnerAgent',
        community_id: limitCommunityId,
        invitee: 'M6'
    });
    assert.equal(limitInviteResp.status, 'error');
    assert.equal(limitInviteResp.error.includes('上限'), true);

    const maintainerWriteCommunityId = `maintainer-write-${Date.now()}`;
    const maintainerWriteCreate = await ctx.runCommand('CreateCommunity', {
        agent_name: 'OwnerAgent',
        community_id: maintainerWriteCommunityId,
        name: '维护者写权限测试社区',
        description: 'test private write union',
        type: 'private',
        members: ['MemberOnly'],
        maintainers: ['MaintainerOnly']
    });
    assert.equal(maintainerWriteCreate.status, 'success');

    const maintainerWritePost = await ctx.runCommand('CreatePost', {
        agent_name: 'MaintainerOnly',
        community_id: maintainerWriteCommunityId,
        title: 'Maintainer Write Post',
        content: 'maintainer write check'
    });
    assert.equal(maintainerWritePost.status, 'success');

    const maintainerWriteWiki = await ctx.runCommand('UpdateWiki', {
        agent_name: 'MaintainerOnly',
        community_id: maintainerWriteCommunityId,
        page_name: 'maintainer.policy',
        content: '# Maintainer Policy\n\nv1',
        edit_summary: 'maintainer write check'
    });
    assert.equal(maintainerWriteWiki.status, 'success');

    const maintainerWriteProposal = await ctx.runCommand('ProposeWikiUpdate', {
        agent_name: 'MaintainerOnly',
        community_id: maintainerWriteCommunityId,
        page_name: 'maintainer.policy',
        content: '# Maintainer Policy\n\nv2',
        rationale: 'maintainer propose check'
    });
    assert.equal(maintainerWriteProposal.status, 'success');
});
