const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs/promises');
const { createSandboxContext } = require('./helpers/communityTestHarness');

test('帖子生命周期：发帖、提及、回复、引用、软删除', async () => {
    const ctx = await createSandboxContext('vcpcommunity-posts-');

    const createResp = await ctx.runCommand('CreatePost', {
        agent_name: 'DevAgent',
        community_id: 'dev-core',
        title: 'Integration Test Post',
        content: 'Hello @CodeReviewer, this is a test.'
    });
    assert.equal(createResp.status, 'success');
    const postUid = createResp.result.match(/UID: ([0-9a-fA-F-]+)/)[1];

    const listResp = await ctx.runCommand('ListPosts', {
        agent_name: 'DevAgent',
        community_id: 'dev-core'
    });
    assert.equal(listResp.status, 'success');
    assert.equal(/@ \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/.test(listResp.result), true);

    const mentionSituation = await ctx.runCommand('GetAgentSituation', {
        agent_name: 'CodeReviewer',
        since_ts: 0,
        limit: 5
    });
    assert.equal(mentionSituation.status, 'success');
    assert.equal(mentionSituation.result.mentions.some((m) => m.post_uid === postUid), true);

    const replyResp = await ctx.runCommand('ReplyPost', {
        agent_name: 'CodeReviewer',
        post_uid: postUid,
        content: `Received @DevAgent. Checking >>${postUid}`
    });
    assert.equal(replyResp.status, 'success');

    const readResp = await ctx.runCommand('ReadPost', {
        agent_name: 'DevAgent',
        post_uid: postUid
    });
    assert.equal(readResp.status, 'success');
    assert.equal(readResp.result.includes('> **引用预览**:'), true);
    assert.equal(/\*\*发布时间:\*\* \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/.test(readResp.result), true);
    assert.equal(/\*\*发布时间:\*\* .*T/.test(readResp.result), false);
    assert.equal(/\*\*时间:\*\* \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/.test(readResp.result), true);

    const deleteDeniedResp = await ctx.runCommand('DeletePost', {
        agent_name: 'WriterAgent',
        post_uid: postUid,
        reason: 'not allowed'
    });
    assert.equal(deleteDeniedResp.status, 'error');
    assert.equal(deleteDeniedResp.error.includes('权限不足'), true);

    const deleteResp = await ctx.runCommand('DeletePost', {
        agent_name: 'DevAgent',
        post_uid: postUid,
        reason: '测试删除'
    });
    assert.equal(deleteResp.status, 'success');
    assert.equal(deleteResp.result.includes('软删除'), true);

    const files = await fs.readdir(ctx.postsDir);
    assert.equal(files.some((f) => f.includes(`[${postUid}]`) && f.includes('[DEL@DevAgent@')), true);

    const listAfterDeleteResp = await ctx.runCommand('ListPosts', { agent_name: 'DevAgent' });
    assert.equal(listAfterDeleteResp.status, 'success');
    assert.equal(listAfterDeleteResp.result.includes(postUid), false);

    const readDeletedResp = await ctx.runCommand('ReadPost', {
        agent_name: 'DevAgent',
        post_uid: postUid
    });
    assert.equal(readDeletedResp.status, 'success');
    assert.equal(readDeletedResp.result.includes('已删除'), true);

    const replyDeletedResp = await ctx.runCommand('ReplyPost', {
        agent_name: 'CodeReviewer',
        post_uid: postUid,
        content: 'reply deleted post'
    });
    assert.equal(replyDeletedResp.status, 'error');
    assert.equal(replyDeletedResp.error.includes('已删除'), true);

    const mentionAfterDeleteResp = await ctx.runCommand('GetAgentSituation', {
        agent_name: 'CodeReviewer',
        since_ts: 0,
        limit: 10
    });
    assert.equal(mentionAfterDeleteResp.status, 'success');
    assert.equal(mentionAfterDeleteResp.result.mentions.some((m) => m.post_uid === postUid), false);

    const createRefPostResp = await ctx.runCommand('CreatePost', {
        agent_name: 'DevAgent',
        community_id: 'dev-core',
        title: '引用已删除帖子测试',
        content: `尝试引用 >>${postUid}`
    });
    assert.equal(createRefPostResp.status, 'success');
    const refPostUid = createRefPostResp.result.match(/UID: ([0-9a-fA-F-]+)/)[1];

    const readRefPostResp = await ctx.runCommand('ReadPost', {
        agent_name: 'DevAgent',
        post_uid: refPostUid
    });
    assert.equal(readRefPostResp.status, 'success');
    assert.equal(readRefPostResp.result.includes('该帖子已删除'), true);
});
