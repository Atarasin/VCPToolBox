const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const path = require('path');
const fs = require('fs/promises');

function loadSyncManagerWithSandbox(projectBasePath) {
    process.env.PROJECT_BASE_PATH = projectBasePath;
    const constantsPath = require.resolve('../../lib/constants');
    const managerPath = require.resolve('../../lib/managers/wikiDailynoteSyncManager');
    delete require.cache[constantsPath];
    delete require.cache[managerPath];
    const WikiDailynoteSyncManager = require('../../lib/managers/wikiDailynoteSyncManager');
    return WikiDailynoteSyncManager;
}

async function writeMappingsConfig(sandboxRoot, data) {
    const configDir = path.join(sandboxRoot, 'data', 'VCPCommunity', 'config');
    await fs.mkdir(configDir, { recursive: true });
    await fs.writeFile(
        path.join(configDir, 'wiki_dailynote_mappings.json'),
        JSON.stringify(data, null, 2),
        'utf8'
    );
}

test('syncWikiPage 命中映射后创建目录并写入扁平化文件', async () => {
    const sandboxRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'vcpcommunity-sync-unit-'));
    const WikiDailynoteSyncManager = loadSyncManagerWithSandbox(sandboxRoot);
    await writeMappingsConfig(sandboxRoot, {
        enabled: true,
        mappings: [
            {
                community_id: 'dev-core',
                wiki_prefix: '00_requirements',
                dailynote_dir: '小说创作需求'
            }
        ]
    });

    const manager = new WikiDailynoteSyncManager();
    const result = await manager.syncWikiPage({
        communityId: 'dev-core',
        pageName: '00_requirements/story/outline.md',
        content: '# content v1'
    });

    assert.equal(result.status, 'synced');
    const targetFile = path.join(sandboxRoot, 'dailynote', '小说创作需求', 'story_outline.md');
    const fileContent = await fs.readFile(targetFile, 'utf8');
    assert.equal(fileContent, '# content v1');
});

test('syncWikiPage 再次写入会覆盖同一目标文件', async () => {
    const sandboxRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'vcpcommunity-sync-unit-'));
    const WikiDailynoteSyncManager = loadSyncManagerWithSandbox(sandboxRoot);
    await writeMappingsConfig(sandboxRoot, {
        enabled: true,
        mappings: [
            {
                community_id: 'dev-core',
                wiki_prefix: '00_requirements',
                dailynote_dir: '小说创作需求'
            }
        ]
    });

    const manager = new WikiDailynoteSyncManager();
    await manager.syncWikiPage({
        communityId: 'dev-core',
        pageName: '00_requirements/story/outline.md',
        content: '# v1'
    });
    await manager.syncWikiPage({
        communityId: 'dev-core',
        pageName: '00_requirements/story/outline.md',
        content: '# v2'
    });

    const targetFile = path.join(sandboxRoot, 'dailynote', '小说创作需求', 'story_outline.md');
    const fileContent = await fs.readFile(targetFile, 'utf8');
    assert.equal(fileContent, '# v2');
});

test('syncWikiPage 支持前缀根页面 00_requirements.md 命中映射', async () => {
    const sandboxRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'vcpcommunity-sync-unit-'));
    const WikiDailynoteSyncManager = loadSyncManagerWithSandbox(sandboxRoot);
    await writeMappingsConfig(sandboxRoot, {
        enabled: true,
        mappings: [
            {
                community_id: 'dev-core',
                wiki_prefix: '00_requirements',
                dailynote_dir: '小说创作需求'
            }
        ]
    });

    const manager = new WikiDailynoteSyncManager();
    const result = await manager.syncWikiPage({
        communityId: 'dev-core',
        pageName: '00_requirements.md',
        content: '# root content'
    });

    assert.equal(result.status, 'synced');
    const targetFile = path.join(sandboxRoot, 'dailynote', '小说创作需求', '00_requirements.md');
    const fileContent = await fs.readFile(targetFile, 'utf8');
    assert.equal(fileContent, '# root content');
});

test('syncWikiPage wiki_prefix 为空时同步社区下所有 Wiki 文档', async () => {
    const sandboxRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'vcpcommunity-sync-unit-'));
    const WikiDailynoteSyncManager = loadSyncManagerWithSandbox(sandboxRoot);
    await writeMappingsConfig(sandboxRoot, {
        enabled: true,
        mappings: [
            {
                community_id: 'dev-core',
                wiki_prefix: '',
                dailynote_dir: '小说创作需求'
            }
        ]
    });

    const manager = new WikiDailynoteSyncManager();
    const result = await manager.syncWikiPage({
        communityId: 'dev-core',
        pageName: '01_outline/ch01.md',
        content: '# chapter 1'
    });

    assert.equal(result.status, 'synced');
    const targetFile = path.join(sandboxRoot, 'dailynote', '小说创作需求', '01_outline_ch01.md');
    const fileContent = await fs.readFile(targetFile, 'utf8');
    assert.equal(fileContent, '# chapter 1');
});

test('syncWikiPage 未命中映射时返回 skipped', async () => {
    const sandboxRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'vcpcommunity-sync-unit-'));
    const WikiDailynoteSyncManager = loadSyncManagerWithSandbox(sandboxRoot);
    await writeMappingsConfig(sandboxRoot, {
        enabled: true,
        mappings: [
            {
                community_id: 'dev-core',
                wiki_prefix: '00_requirements',
                dailynote_dir: '小说创作需求'
            }
        ]
    });

    const manager = new WikiDailynoteSyncManager();
    const result = await manager.syncWikiPage({
        communityId: 'dev-core',
        pageName: '01_outline/ch01.md',
        content: '# content'
    });
    assert.equal(result.status, 'skipped');
    assert.equal(result.reason, 'mapping_not_matched');
});

test('syncWikiPage 开关关闭时返回 skipped', async () => {
    const sandboxRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'vcpcommunity-sync-unit-'));
    const WikiDailynoteSyncManager = loadSyncManagerWithSandbox(sandboxRoot);
    await writeMappingsConfig(sandboxRoot, {
        enabled: false,
        mappings: [
            {
                community_id: 'dev-core',
                wiki_prefix: '00_requirements',
                dailynote_dir: '小说创作需求'
            }
        ]
    });

    const manager = new WikiDailynoteSyncManager();
    const result = await manager.syncWikiPage({
        communityId: 'dev-core',
        pageName: '00_requirements/a.md',
        content: '# content'
    });
    assert.equal(result.status, 'skipped');
    assert.equal(result.reason, 'mapping_disabled');
});

test('syncWikiPage 非法 dailynote_dir 返回 failed', async () => {
    const sandboxRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'vcpcommunity-sync-unit-'));
    const WikiDailynoteSyncManager = loadSyncManagerWithSandbox(sandboxRoot);
    await writeMappingsConfig(sandboxRoot, {
        enabled: true,
        mappings: [
            {
                community_id: 'dev-core',
                wiki_prefix: '00_requirements',
                dailynote_dir: '../escape'
            }
        ]
    });

    const manager = new WikiDailynoteSyncManager();
    const result = await manager.syncWikiPage({
        communityId: 'dev-core',
        pageName: '00_requirements/a.md',
        content: '# content'
    });
    assert.equal(result.status, 'failed');
});
