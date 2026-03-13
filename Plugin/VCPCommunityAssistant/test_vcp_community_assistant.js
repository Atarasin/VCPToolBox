const fs = require('fs').promises;
const path = require('path');
const assert = require('assert');

process.env.SKIP_ASSISTANT_BOOTSTRAP = 'true';

// 统一测试沙箱根目录命名，避免误写真实运行数据
const TEST_SANDBOX_ROOT = path.join(__dirname, '.assistant-test-root');
process.env.PROJECT_BASE_PATH = TEST_SANDBOX_ROOT;

const DATA_DIR = path.join(TEST_SANDBOX_ROOT, 'data', 'VCPCommunity');
const CONFIG_DIR = path.join(DATA_DIR, 'config');
const POSTS_DIR = path.join(DATA_DIR, 'posts');
const PROPOSALS_FILE = path.join(CONFIG_DIR, 'proposals.json');
const COMMUNITIES_FILE = path.join(CONFIG_DIR, 'communities.json');
const ASSISTANT_STATE_FILE = path.join(CONFIG_DIR, 'assistant_state.json');

const { randomBrowse, checkReviewTimeouts } = require('./vcp-community-assistant');

async function writeJson(filePath, data) {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, JSON.stringify(data, null, 2), 'utf-8');
}

async function readJson(filePath) {
    const data = await fs.readFile(filePath, 'utf-8');
    return JSON.parse(data);
}

async function resetFiles() {
    await fs.rm(DATA_DIR, { recursive: true, force: true });
    await fs.mkdir(CONFIG_DIR, { recursive: true });
    await fs.mkdir(POSTS_DIR, { recursive: true });
    await writeJson(PROPOSALS_FILE, []);
    await writeJson(COMMUNITIES_FILE, { communities: [] });
}

async function testRandomBrowseActionBoard() {
    await resetFiles();
    await writeJson(COMMUNITIES_FILE, {
        communities: [
            {
                id: 'dev-core',
                type: 'private',
                members: ['ArchitectAgent'],
                maintainers: ['ArchitectAgent', 'CodeReviewer'],
            },
            {
                id: 'general',
                type: 'public',
                members: [],
                maintainers: [],
            }
        ]
    });

    const calls = [];
    const communityCalls = [];
    const situationMap = {
        ArchitectAgent: {
            agent_name: 'ArchitectAgent',
            mentions: [
                { post_uid: 'm-1', community_id: 'dev-core', title: '架构评审', author: 'DevAgent' },
            ],
            pending_reviews: [
                { post_uid: 'proposal-1', community_id: 'dev-core', page_name: 'core.rules' },
            ],
            proposal_updates: [
                { post_uid: 'proposal-x', page_name: 'old.rules', outcome: 'Approve' },
            ],
            explore_candidates: [
                { post_uid: 'post-1', title: '架构评审', author: 'DevAgent', community_id: 'dev-core' },
            ],
            generated_at: 123456789,
        },
        CodeReviewer: {
            agent_name: 'CodeReviewer',
            mentions: [],
            pending_reviews: [],
            proposal_updates: [],
            explore_candidates: [],
            generated_at: 123456789,
        }
    };
    const originalRandom = Math.random;
    Math.random = () => 0;
    try {
        const invoked = await randomBrowse({
            invokeAgent: async (agentName, prompt) => {
                calls.push({ agentName, prompt });
                // 模拟 Agent 返回工具动作，用于验证反馈回流
                return 'TOOL_REQUEST: ReviewProposal';
            },
            invokeCommunity: async (command, args) => {
                communityCalls.push({ command, args });
                assert.strictEqual(command, 'GetAgentSituation');
                return situationMap[args.agent_name];
            },
            nowProvider: () => 123456789,
        });
        assert.strictEqual(invoked, true);
    } finally {
        Math.random = originalRandom;
    }

    assert.strictEqual(communityCalls.length, 2);
    assert.strictEqual(calls.length, 1);
    assert.strictEqual(calls[0].agentName, 'ArchitectAgent');
    assert.ok(calls[0].prompt.includes('[社区行动看板]'));
    assert.ok(calls[0].prompt.includes('本轮建议优先级'));
    assert.ok(calls[0].prompt.includes('@你提醒（1条）'));
    assert.ok(calls[0].prompt.includes('待你评审（1条）'));
    assert.ok(calls[0].prompt.includes('proposal-1'));
    assert.ok(calls[0].prompt.includes('提案进展（1条）'));
    assert.ok(calls[0].prompt.includes('可逛帖推荐'));
    assert.ok(calls[0].prompt.includes('ListPosts(agent_name="ArchitectAgent")'));

    const state = await readJson(ASSISTANT_STATE_FILE);
    assert.strictEqual(state.agents.ArchitectAgent.last_tick_at, 123456789);
    assert.ok(state.agents.ArchitectAgent.last_digest_hash);
    assert.ok(state.agents.ArchitectAgent.feedback.total_actions >= 1);
    assert.ok(Array.isArray(state.agents.ArchitectAgent.last_priorities));
}

async function testRandomBrowseNoAgents() {
    await resetFiles();
    await writeJson(COMMUNITIES_FILE, { communities: [] });
    const calls = [];
    const invoked = await randomBrowse({
        invokeAgent: async (agentName, prompt) => {
            calls.push({ agentName, prompt });
        }
    });
    assert.strictEqual(invoked, false);
    assert.strictEqual(calls.length, 0);
}

async function testRandomBrowseDiscoverFromPublicActivity() {
    await resetFiles();
    await writeJson(COMMUNITIES_FILE, {
        communities: [
            {
                id: 'general',
                type: 'public',
                members: [],
                maintainers: [],
            }
        ]
    });

    // public 社区成员为空，依赖 L3 活跃发现（帖子作者）
    const publicPostFile = '[general][公共讨论][PublicAgent][2026-03-14T10-00-00][public-post-1].md';
    const publicPostContent = `
# 公共讨论
**社区:** 通用社区 (general)
**作者:** PublicAgent
**UID:** public-post-1
**发布时间:** 2026-03-14T10:00:00
---
hello world
`.trim();
    await fs.writeFile(path.join(POSTS_DIR, publicPostFile), publicPostContent, 'utf-8');

    const calls = [];
    const communityCalls = [];
    const originalRandom = Math.random;
    Math.random = () => 0;
    try {
        const invoked = await randomBrowse({
            invokeAgent: async (agentName, prompt) => {
                calls.push({ agentName, prompt });
                return '';
            },
            invokeCommunity: async (command, args) => {
                communityCalls.push({ command, args });
                assert.strictEqual(command, 'GetAgentSituation');
                assert.strictEqual(args.agent_name, 'PublicAgent');
                return {
                    agent_name: 'PublicAgent',
                    mentions: [],
                    pending_reviews: [],
                    proposal_updates: [],
                    explore_candidates: [{ post_uid: 'public-post-1' }],
                    generated_at: 7000,
                };
            },
            nowProvider: () => 7000,
        });
        assert.strictEqual(invoked, true);
    } finally {
        Math.random = originalRandom;
    }

    assert.strictEqual(calls.length, 1);
    assert.strictEqual(calls[0].agentName, 'PublicAgent');
    assert.strictEqual(communityCalls.length, 1);
}

async function testRandomBrowseDigestDedup() {
    await resetFiles();
    await writeJson(COMMUNITIES_FILE, {
        communities: [
            {
                id: 'dev-core',
                type: 'private',
                members: ['ArchitectAgent'],
                maintainers: ['ArchitectAgent'],
            }
        ]
    });

    const situationPayload = {
        agent_name: 'ArchitectAgent',
        mentions: [{ post_uid: 'm-1' }],
        pending_reviews: [],
        proposal_updates: [],
        explore_candidates: [],
        generated_at: 2000,
    };

    const calls = [];
    const originalRandom = Math.random;
    Math.random = () => 0;
    try {
        const first = await randomBrowse({
            invokeAgent: async (agentName, prompt) => calls.push({ agentName, prompt }),
            invokeCommunity: async () => situationPayload,
            nowProvider: () => 2000,
        });
        const second = await randomBrowse({
            invokeAgent: async (agentName, prompt) => calls.push({ agentName, prompt }),
            invokeCommunity: async () => situationPayload,
            nowProvider: () => 3000,
        });
        assert.strictEqual(first, true);
        assert.strictEqual(second, false);
    } finally {
        Math.random = originalRandom;
    }

    assert.strictEqual(calls.length, 1);
    const state = await readJson(ASSISTANT_STATE_FILE);
    assert.strictEqual(state.agents.ArchitectAgent.last_tick_at, 3000);
}

async function testWeightedSelectionByBacklog() {
    await resetFiles();
    await writeJson(COMMUNITIES_FILE, {
        communities: [
            {
                id: 'dev-core',
                type: 'private',
                members: ['ArchitectAgent', 'CodeReviewer'],
                maintainers: [],
            }
        ]
    });

    const calls = [];
    const originalRandom = Math.random;
    Math.random = () => 0.9;
    try {
        const invoked = await randomBrowse({
            invokeAgent: async (agentName, prompt) => {
                calls.push({ agentName, prompt });
                return 'TOOL_REQUEST: ReplyPost';
            },
            invokeCommunity: async (command, args) => {
                if (args.agent_name === 'ArchitectAgent') {
                    return {
                        agent_name: 'ArchitectAgent',
                        mentions: [],
                        pending_reviews: [],
                        proposal_updates: [],
                        explore_candidates: [],
                        generated_at: 6000,
                    };
                }
                return {
                    agent_name: 'CodeReviewer',
                    mentions: [{ post_uid: 'm-2' }, { post_uid: 'm-3' }],
                    pending_reviews: [{ post_uid: 'p-1' }, { post_uid: 'p-2' }],
                    proposal_updates: [{ post_uid: 'u-1', outcome: 'Reject' }],
                    explore_candidates: [{ post_uid: 'e-1' }],
                    generated_at: 6000,
                };
            },
            nowProvider: () => 6000,
        });
        assert.strictEqual(invoked, true);
    } finally {
        Math.random = originalRandom;
    }

    assert.strictEqual(calls.length, 1);
    assert.strictEqual(calls[0].agentName, 'CodeReviewer');
}

async function testCheckReviewTimeouts() {
    await resetFiles();
    const now = Date.now();
    await writeJson(PROPOSALS_FILE, [
        {
            post_uid: 'uid-timeout',
            community_id: 'dev-core',
            page_name: 'core.rules',
            proposer: 'DevAgent',
            reviews: {
                ArchitectAgent: { decision: 'Approve', comment: 'ok' },
                CodeReviewer: { decision: null, comment: null },
            },
            finalized: false,
            outcome: null,
            created_at: now - 25 * 60 * 60 * 1000,
        }
    ]);

    const handled = await checkReviewTimeouts(now);
    assert.strictEqual(handled, true);

    const proposals = await readJson(PROPOSALS_FILE);
    assert.strictEqual(proposals[0].finalized, true);
    assert.strictEqual(proposals[0].outcome, 'TimeoutReject');
    assert.strictEqual(proposals[0].reviews.CodeReviewer.decision, 'Timeout');
}

async function run() {
    console.log('=== VCPCommunityAssistant 测试开始 ===');
    await testRandomBrowseActionBoard();
    console.log('✓ 状态看板唤醒逻辑');
    await testRandomBrowseNoAgents();
    console.log('✓ 无 Agent 场景处理');
    await testRandomBrowseDiscoverFromPublicActivity();
    console.log('✓ public 社区活跃发现对象池');
    await testRandomBrowseDigestDedup();
    console.log('✓ 状态摘要去重逻辑');
    await testWeightedSelectionByBacklog();
    console.log('✓ 加权随机选择逻辑');
    await testCheckReviewTimeouts();
    console.log('✓ 超时拒绝处理');
    console.log('=== 所有测试通过 ===');
}

run().catch((err) => {
    console.error(err);
    process.exit(1);
});
