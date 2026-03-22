const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const path = require('path');
const fs = require('fs/promises');

function loadWikiManagerWithSandbox(projectBasePath) {
    process.env.PROJECT_BASE_PATH = projectBasePath;
    const constantsPath = require.resolve('../../lib/constants');
    const wikiManagerPath = require.resolve('../../lib/managers/wikiManager');
    delete require.cache[constantsPath];
    delete require.cache[wikiManagerPath];
    const WikiManager = require('../../lib/managers/wikiManager');
    return WikiManager;
}

test('ListWikiPages 返回可直接用于 ReadWiki/UpdateWiki 的分层 page_name', async () => {
    const sandboxRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'vcpcommunity-wiki-unit-'));
    const WikiManager = loadWikiManagerWithSandbox(sandboxRoot);
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
    const WikiManager = loadWikiManagerWithSandbox(sandboxRoot);
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
        edit_summary: 'init'
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

    const readResult = await wikiManager.readWiki({
        agent_name: 'DevAgent',
        community_id: 'dev-core',
        page_name: '01_worldbuilding/world_basic.md'
    });
    assert.equal(readResult.includes('# world basic'), true);
});
