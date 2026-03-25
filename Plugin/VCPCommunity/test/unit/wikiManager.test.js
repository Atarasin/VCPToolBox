const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const path = require('path');
const fs = require('fs/promises');

function loadWikiManagerWithSandbox(projectBasePath) {
    process.env.PROJECT_BASE_PATH = projectBasePath;
    const constantsPath = require.resolve('../../lib/constants');
    const wikiManagerPath = require.resolve('../../lib/managers/wikiManager');
    const syncManagerPath = require.resolve('../../lib/managers/wikiDailynoteSyncManager');
    delete require.cache[constantsPath];
    delete require.cache[wikiManagerPath];
    delete require.cache[syncManagerPath];
    const WikiManager = require('../../lib/managers/wikiManager');
    const WikiDailynoteSyncManager = require('../../lib/managers/wikiDailynoteSyncManager');
    return { WikiManager, WikiDailynoteSyncManager };
}

test('ListWikiPages 返回可直接用于 ReadWiki/UpdateWiki 的分层 page_name', async () => {
    const sandboxRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'vcpcommunity-wiki-unit-'));
    const { WikiManager } = loadWikiManagerWithSandbox(sandboxRoot);
    const wikiDir = path.join(sandboxRoot, 'data', 'VCPCommunity', 'wiki', 'dev-core');
    await fs.mkdir(path.join(wikiDir, '01_worldbuilding'), { recursive: true });
    await fs.mkdir(path.join(wikiDir, '_system'), { recursive: true });
    await fs.writeFile(path.join(wikiDir, 'rules.md'), '# rules', 'utf8');
    await fs.writeFile(path.join(wikiDir, '01_worldbuilding', 'world_basic.md'), '# outline', 'utf8');
    await fs.writeFile(path.join(wikiDir, '_history.md'), '# hidden', 'utf8');
    await fs.writeFile(path.join(wikiDir, '_system', 'internal.md'), '# hidden', 'utf8');

    const communityManager = {
        listVisibleCommunities(agentName) {
            if (agentName === 'System') return [{ id: 'dev-core' }];
            return [{ id: 'dev-core' }];
        }
    };

    const wikiManager = new WikiManager(communityManager);
    const result = await wikiManager.listWikiPages({
        agent_name: 'DevAgent',
        community_id: 'dev-core'
    });

    const pages = result.split('\n');
    assert.equal(pages.includes('rules.md'), true);
    assert.equal(pages.includes('01_worldbuilding/world_basic.md'), true);
    assert.equal(pages.some((page) => page.endsWith('.md.md')), false);
    assert.equal(pages.includes('_history'), false);
    assert.equal(pages.some((page) => page.startsWith('_system/')), false);
});

test('UpdateWiki 使用分层路径时按目录创建文件且 ReadWiki 可直接读取', async () => {
    const sandboxRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'vcpcommunity-wiki-unit-'));
    const { WikiManager } = loadWikiManagerWithSandbox(sandboxRoot);
    const setMetaCalls = [];

    const communityManager = {
        getCommunity() {
            return {
                id: 'dev-core',
                type: 'public',
                members: ['DevAgent'],
                maintainers: [],
                wiki_pages: {}
            };
        },
        listVisibleCommunities() {
            return [{ id: 'dev-core' }];
        },
        async setWikiPageMeta(communityId, pageName, meta) {
            setMetaCalls.push({ communityId, pageName, meta });
        }
    };

    const wikiManager = new WikiManager(communityManager);
    const updateResult = await wikiManager.updateWiki({
        agent_name: 'DevAgent',
        community_id: 'dev-core',
        page_name: '01_worldbuilding/world_basic.md',
        content: '# world basic',
        edit_summary: 'init',
        tag: '世界观,修仙体系'
    });

    assert.equal(updateResult.includes("01_worldbuilding/world_basic.md"), true);
    assert.equal(setMetaCalls[0].pageName, '01_worldbuilding/world_basic.md');

    const filePath = path.join(
        sandboxRoot,
        'data',
        'VCPCommunity',
        'wiki',
        'dev-core',
        '01_worldbuilding',
        'world_basic.md'
    );
    const fileContent = await fs.readFile(filePath, 'utf8');
    assert.equal(fileContent.includes('# world basic'), true);
    assert.equal(fileContent.trimEnd().endsWith('Tag: 世界观, 修仙体系'), true);

    const readResult = await wikiManager.readWiki({
        agent_name: 'DevAgent',
        community_id: 'dev-core',
        page_name: '01_worldbuilding/world_basic.md'
    });
    assert.equal(readResult.includes('# world basic'), true);
});

test('UpdateWiki 在 tag 参数为空时可从 content 提取并规范化加粗 Tag 行', async () => {
    const sandboxRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'vcpcommunity-wiki-unit-'));
    const { WikiManager } = loadWikiManagerWithSandbox(sandboxRoot);
    const communityManager = {
        getCommunity() {
            return {
                id: 'dev-core',
                type: 'public',
                members: ['DevAgent'],
                maintainers: [],
                wiki_pages: {}
            };
        },
        listVisibleCommunities() {
            return [{ id: 'dev-core' }];
        },
        async setWikiPageMeta() {}
    };

    const wikiManager = new WikiManager(communityManager);
    await wikiManager.updateWiki({
        agent_name: 'DevAgent',
        community_id: 'dev-core',
        page_name: '01_worldbuilding/factions/faction_xuanyin.md',
        content: '# 玄阴宗\n\n势力设定正文\n\n**Tag**: 绝迹仙途，世界观设定, 玄阴宗',
        edit_summary: 'add faction'
    });

    const filePath = path.join(
        sandboxRoot,
        'data',
        'VCPCommunity',
        'wiki',
        'dev-core',
        '01_worldbuilding',
        'factions',
        'faction_xuanyin.md'
    );
    const fileContent = await fs.readFile(filePath, 'utf8');
    assert.equal(fileContent.includes('**Tag**:'), false);
    assert.equal(fileContent.trimEnd().endsWith('Tag: 绝迹仙途, 世界观设定, 玄阴宗'), true);
});

test('UpdateWiki 触发独立同步管理器并输出扁平化日记文件', async () => {
    const sandboxRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'vcpcommunity-wiki-unit-'));
    const { WikiManager, WikiDailynoteSyncManager } = loadWikiManagerWithSandbox(sandboxRoot);
    const configDir = path.join(sandboxRoot, 'data', 'VCPCommunity', 'config');
    await fs.mkdir(configDir, { recursive: true });
    await fs.writeFile(
        path.join(configDir, 'wiki_dailynote_mappings.json'),
        JSON.stringify({
            enabled: true,
            mappings: [
                {
                    community_id: 'dev-core',
                    wiki_prefix: '00_requirements',
                    dailynote_dir: '小说创作需求'
                }
            ]
        }, null, 2),
        'utf8'
    );

    const communityManager = {
        getCommunity() {
            return {
                id: 'dev-core',
                type: 'public',
                members: ['DevAgent'],
                maintainers: [],
                wiki_pages: {}
            };
        },
        listVisibleCommunities() {
            return [{ id: 'dev-core' }];
        },
        async setWikiPageMeta() {}
    };

    const syncManager = new WikiDailynoteSyncManager();
    const wikiManager = new WikiManager(communityManager, syncManager);
    await wikiManager.updateWiki({
        agent_name: 'DevAgent',
        community_id: 'dev-core',
        page_name: '00_requirements/story/outline.md',
        content: '# outline',
        edit_summary: 'init outline'
    });

    const syncedPath = path.join(sandboxRoot, 'dailynote', '小说创作需求', 'story_outline.md');
    const syncedContent = await fs.readFile(syncedPath, 'utf8');
    assert.equal(syncedContent.includes('# outline'), true);
    assert.equal(syncedContent.includes('agent name: DevAgent'), true);
    const syncResultsPath = path.join(sandboxRoot, 'data', 'VCPCommunity', 'config', 'wiki_dailynote_sync_results.json');
    const syncResults = JSON.parse(await fs.readFile(syncResultsPath, 'utf8'));
    assert.equal(syncResults[syncResults.length - 1].status, 'synced');
    assert.equal(syncResults[syncResults.length - 1].agent_name, 'DevAgent');
});

test('UpdateWiki 在 wiki_prefix 为空时同步社区任意 Wiki 页面', async () => {
    const sandboxRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'vcpcommunity-wiki-unit-'));
    const { WikiManager, WikiDailynoteSyncManager } = loadWikiManagerWithSandbox(sandboxRoot);
    const configDir = path.join(sandboxRoot, 'data', 'VCPCommunity', 'config');
    await fs.mkdir(configDir, { recursive: true });
    await fs.writeFile(
        path.join(configDir, 'wiki_dailynote_mappings.json'),
        JSON.stringify({
            enabled: true,
            mappings: [
                {
                    community_id: 'dev-core',
                    wiki_prefix: '',
                    dailynote_dir: '小说创作需求'
                }
            ]
        }, null, 2),
        'utf8'
    );

    const communityManager = {
        getCommunity() {
            return {
                id: 'dev-core',
                type: 'public',
                members: ['DevAgent'],
                maintainers: [],
                wiki_pages: {}
            };
        },
        listVisibleCommunities() {
            return [{ id: 'dev-core' }];
        },
        async setWikiPageMeta() {}
    };

    const syncManager = new WikiDailynoteSyncManager();
    const wikiManager = new WikiManager(communityManager, syncManager);
    await wikiManager.updateWiki({
        agent_name: 'DevAgent',
        community_id: 'dev-core',
        page_name: '99_misc/notes/idea.md',
        content: '# idea',
        edit_summary: 'sync all'
    });

    const syncedPath = path.join(sandboxRoot, 'dailynote', '小说创作需求', '99_misc_notes_idea.md');
    const syncedContent = await fs.readFile(syncedPath, 'utf8');
    assert.equal(syncedContent.includes('# idea'), true);
});
