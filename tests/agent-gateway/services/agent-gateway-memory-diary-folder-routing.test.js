const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const fsSync = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

// DailyNote 在 require 时就固化 KNOWLEDGEBASE_ROOT_PATH，因此必须先切到临时日记根目录再加载插件。
const DIARY_ROOT = fsSync.mkdtempSync(path.join(os.tmpdir(), 'agw-diary-routing-'));
process.env.KNOWLEDGEBASE_ROOT_PATH = DIARY_ROOT;

const dailyNote = require('../../../Plugin/DailyNote/dailynote.js');
const { createMemoryRuntimeService } = require('../../../modules/agentGateway/services/memoryRuntimeService');
const { bindVcpPorts } = require('../../../modules/agentGateway/composition/vcpPortBindings');
const { createPluginManager } = require('../helpers/agent-gateway-test-helpers');

function createDailyNotePlugin() {
    return {
        name: 'DailyNote',
        displayName: '日记系统',
        description: '支持创建和更新日记。',
        pluginType: 'synchronous',
        communication: {
            protocol: 'stdio',
            timeout: 30000
        },
        capabilities: {
            invocationCommands: [
                {
                    commandIdentifier: 'create',
                    description: '创建日记。'
                }
            ]
        }
    };
}

// 直接把网关的 diaryStore 端口接到真实的 DailyNote 插件上，覆盖“网关拼 maid → 插件解析目录”的完整链路。
function createMemoryServiceBackedByRealDailyNote() {
    const plugins = new Map(createPluginManager().plugins);
    plugins.set('DailyNote', createDailyNotePlugin());
    const pluginManager = createPluginManager({
        plugins,
        async processToolCall(toolName, args) {
            assert.equal(toolName, 'DailyNote');
            return dailyNote.dispatchCommand(args);
        }
    });
    const ports = bindVcpPorts(pluginManager);
    return createMemoryRuntimeService({
        diaryStorePort: ports.diaryStore,
        ragConfig: ports.configuration.rag
    });
}

async function withTempMemoryPolicy(policy, callback) {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agw-memory-policy-'));
    const policyPath = path.join(tempDir, 'mcp_agent_memory_policy.json');
    const previousPolicyPath = process.env.MCP_AGENT_MEMORY_POLICY_PATH;
    await fs.writeFile(policyPath, JSON.stringify(policy, null, 2), 'utf8');
    process.env.MCP_AGENT_MEMORY_POLICY_PATH = policyPath;
    try {
        return await callback();
    } finally {
        if (previousPolicyPath === undefined) {
            delete process.env.MCP_AGENT_MEMORY_POLICY_PATH;
        } else {
            process.env.MCP_AGENT_MEMORY_POLICY_PATH = previousPolicyPath;
        }
        await fs.rm(tempDir, { recursive: true, force: true });
    }
}

async function makeDiaryFolders(...folderNames) {
    for (const folderName of folderNames) {
        await fs.mkdir(path.join(DIARY_ROOT, folderName), { recursive: true });
    }
}

async function listDiaryFiles(folderName) {
    try {
        return (await fs.readdir(path.join(DIARY_ROOT, folderName))).sort();
    } catch (error) {
        if (error.code === 'ENOENT') {
            return null;
        }
        throw error;
    }
}

async function createNote({ maid, content, tag = 'Tag: 回归测试' }) {
    const result = await dailyNote.dispatchCommand({
        command: 'create',
        maid,
        Date: '2026-08-05',
        Content: content,
        Tag: tag
    });
    assert.equal(result.status, 'success', `create failed: ${result.error}`);
    return result.result.folder;
}

test.after(async () => {
    await fs.rm(DIARY_ROOT, { recursive: true, force: true });
});

test('memory.write 落到请求的专题日记本，而不是 owner 自己的日记本', async () => {
    await withTempMemoryPolicy({
        agents: {
            MCPFuPeng: {
                maid: '付鹏',
                allowedDiaries: ['付鹏日记本', '付鹏市场判断日记本'],
                defaultDiaries: ['付鹏日记本']
            }
        }
    }, async () => {
        await makeDiaryFolders('付鹏', '付鹏市场判断');
        const ownerFilesBefore = await listDiaryFiles('付鹏');
        const service = createMemoryServiceBackedByRealDailyNote();

        const result = await service.writeMemory({
            body: {
                target: { diary: '付鹏市场判断' },
                memory: {
                    text: '专题日记本的写入必须留在专题目录内。',
                    tags: ['市场判断'],
                    timestamp: '2026-08-05T00:01:01.000Z'
                },
                requestContext: {
                    source: 'agent-gateway-mcp-http',
                    agentId: 'MCPFuPeng',
                    sessionId: 'sess-diary-routing-001',
                    requestId: 'req-diary-routing-001'
                }
            },
            startedAt: Date.now(),
            clientIp: '127.0.0.1',
            defaultSource: 'agent-gateway-mcp-http'
        });

        assert.equal(result.success, true);
        assert.equal(result.data.writeStatus, 'created');
        assert.equal(result.data.diary, '付鹏市场判断');
        assert.equal((await listDiaryFiles('付鹏市场判断')).length, 1);
        assert.deepEqual(await listDiaryFiles('付鹏'), ownerFilesBefore);
    });
});

test('专题目录尚未创建时新建同名目录，而不是并入 owner 目录', async () => {
    await makeDiaryFolders('迈达斯');

    const folder = await createNote({
        maid: '[迈达斯量化工程]迈达斯',
        content: '首次写入专题日记本时不应被 owner 目录吸走。'
    });

    assert.equal(folder, '迈达斯量化工程');
    assert.equal((await listDiaryFiles('迈达斯量化工程')).length, 1);
    assert.deepEqual(await listDiaryFiles('迈达斯'), []);
});

test('主日记本署名仍解析到 owner 目录（日记本后缀可省略）', async () => {
    await makeDiaryFolders('Nexus', 'Nexus架构设计');

    const folder = await createNote({
        maid: '[Nexus日记本]Nexus',
        content: '主日记本写入保持原有行为。'
    });

    assert.equal(folder, 'Nexus');
    assert.equal((await listDiaryFiles('Nexus')).length, 1);
    assert.deepEqual(await listDiaryFiles('Nexus架构设计'), []);
});

test('归属守卫仍拦截跨 agent 的模糊匹配', async () => {
    await makeDiaryFolders('Nova');

    const folder = await createNote({
        maid: '[Nov]付鹏',
        content: '别人的目录不能被模糊匹配命中。'
    });

    assert.notEqual(folder, 'Nova');
    assert.deepEqual(await listDiaryFiles('Nova'), []);
});
