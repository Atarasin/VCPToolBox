const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const path = require('path');
const fs = require('fs/promises');
const { execFile } = require('child_process');
const util = require('util');

const execFileAsync = util.promisify(execFile);
const PLUGIN_SCRIPT = path.resolve(__dirname, '../../VCPCommunity.js');

async function runPlugin(payload, projectBasePath) {
    const { stdout } = await execFileAsync('node', [PLUGIN_SCRIPT, JSON.stringify(payload)], {
        env: {
            ...process.env,
            PROJECT_BASE_PATH: projectBasePath
        }
    });
    return JSON.parse(stdout);
}

test('ListWikiPages 返回的 page_name 可直接 ReadWiki 与 UpdateWiki', async () => {
    const sandboxRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'vcpcommunity-wiki-integration-'));

    const createCommunity = await runPlugin(
        {
            command: 'CreateCommunity',
            agent_name: 'DevAgent',
            community_id: 'wiki-path-consistency',
            name: 'Wiki Path Consistency',
            description: 'path consistency check',
            type: 'public',
            members: [],
            maintainers: []
        },
        sandboxRoot
    );
    assert.equal(createCommunity.status, 'success');

    const firstUpdate = await runPlugin(
        {
            command: 'UpdateWiki',
            agent_name: 'DevAgent',
            community_id: 'wiki-path-consistency',
            page_name: 'chapter/outline.md',
            content: '# outline v1',
            edit_summary: 'first write'
        },
        sandboxRoot
    );
    assert.equal(firstUpdate.status, 'success');

    const listed = await runPlugin(
        {
            command: 'ListWikiPages',
            agent_name: 'DevAgent',
            community_id: 'wiki-path-consistency'
        },
        sandboxRoot
    );
    assert.equal(listed.status, 'success');
    assert.equal(typeof listed.result, 'string');
    const pageName = listed.result.split('\n').find((name) => name === 'chapter/outline.md');
    assert.ok(pageName);
    assert.equal(pageName.endsWith('.md.md'), false);

    const readByListedName = await runPlugin(
        {
            command: 'ReadWiki',
            agent_name: 'DevAgent',
            community_id: 'wiki-path-consistency',
            page_name: pageName
        },
        sandboxRoot
    );
    assert.equal(readByListedName.status, 'success');
    assert.equal(readByListedName.result.includes('# outline v1'), true);

    const updateByListedName = await runPlugin(
        {
            command: 'UpdateWiki',
            agent_name: 'DevAgent',
            community_id: 'wiki-path-consistency',
            page_name: pageName,
            content: '# outline v2',
            edit_summary: 'second write'
        },
        sandboxRoot
    );
    assert.equal(updateByListedName.status, 'success');

    const readAfterSecondUpdate = await runPlugin(
        {
            command: 'ReadWiki',
            agent_name: 'DevAgent',
            community_id: 'wiki-path-consistency',
            page_name: pageName
        },
        sandboxRoot
    );
    assert.equal(readAfterSecondUpdate.status, 'success');
    assert.equal(readAfterSecondUpdate.result.includes('# outline v2'), true);

    const storedFilePath = path.join(
        sandboxRoot,
        'data',
        'VCPCommunity',
        'wiki',
        'wiki-path-consistency',
        'chapter',
        'outline.md'
    );
    const stats = await fs.stat(storedFilePath);
    assert.equal(stats.isFile(), true);
});
