const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const {
    createMcpServerHarness
} = require('../../../modules/agentGateway/adapters/mcpAdapter');
const {
    createPluginManager
} = require('./agent-gateway-test-helpers');

let tempAgentDir = '';

function createAgentManager(agentDir) {
    const mapping = new Map([
        ['Ariadne', 'Ariadne.txt']
    ]);

    return {
        agentDir,
        agentMap: mapping,
        isAgent(alias) {
            return mapping.has(alias);
        },
        async getAgentPrompt(alias) {
            const relativePath = mapping.get(alias);
            return fs.readFile(path.join(agentDir, relativePath), 'utf8');
        },
        async getAllAgentFiles() {
            return {
                files: Array.from(mapping.values()),
                folderStructure: {}
            };
        }
    };
}

async function initializeRuntime() {
    if (process.env.VCP_MCP_FIXTURE_FAIL_BOOTSTRAP === '1') {
        throw new Error('Fixture bootstrap failed intentionally.');
    }

    if (process.env.VCP_MCP_FIXTURE_LOG_STDOUT === '1') {
        console.log('[FixtureTransport] boot log');
    }

    tempAgentDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agw-mcp-transport-'));
    await fs.writeFile(
        path.join(tempAgentDir, 'Ariadne.txt'),
        'You are Ariadne. Hello {{VarUserName}}.',
        'utf8'
    );

    const pluginManager = createPluginManager({
        agentManager: createAgentManager(tempAgentDir)
    });

    return {
        pluginManager,
        harness: createMcpServerHarness(pluginManager)
    };
}

async function shutdownRuntime() {
    if (!tempAgentDir) {
        return;
    }
    await fs.rm(tempAgentDir, { recursive: true, force: true });
    tempAgentDir = '';
}

module.exports = {
    initializeRuntime,
    shutdownRuntime
};
