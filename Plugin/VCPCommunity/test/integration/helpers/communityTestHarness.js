const os = require('os');
const path = require('path');
const fs = require('fs/promises');
const { execFile } = require('child_process');
const util = require('util');

const execFileAsync = util.promisify(execFile);
const PLUGIN_SCRIPT = path.resolve(__dirname, '../../../VCPCommunity.js');
const ASSISTANT_SCRIPT = path.resolve(__dirname, '../../../../VCPCommunityAssistant/vcp-community-assistant.js');

function buildSandboxPaths(sandboxRoot) {
    const dataDir = path.join(sandboxRoot, 'data', 'VCPCommunity');
    const configDir = path.join(dataDir, 'config');
    return {
        sandboxRoot,
        dataDir,
        configDir,
        communitiesFile: path.join(configDir, 'communities.json'),
        proposalsFile: path.join(configDir, 'proposals.json'),
        maintainerInvitesFile: path.join(configDir, 'maintainer_invites.json'),
        postsDir: path.join(dataDir, 'posts'),
        wikiDir: path.join(dataDir, 'wiki')
    };
}

async function runPlugin(payload, sandboxRoot) {
    try {
        const { stdout } = await execFileAsync('node', [PLUGIN_SCRIPT, JSON.stringify(payload)], {
            env: {
                ...process.env,
                PROJECT_BASE_PATH: sandboxRoot,
                SKIP_ASSISTANT_BOOTSTRAP: 'true'
            }
        });
        return JSON.parse(stdout);
    } catch (error) {
        if (error && typeof error.stdout === 'string') {
            return JSON.parse(error.stdout);
        }
        throw error;
    }
}

function loadAssistantWithSandbox(sandboxRoot) {
    process.env.PROJECT_BASE_PATH = sandboxRoot;
    process.env.SKIP_ASSISTANT_BOOTSTRAP = 'true';
    delete require.cache[ASSISTANT_SCRIPT];
    return require(ASSISTANT_SCRIPT);
}

async function createSandboxContext(prefix = 'vcpcommunity-integration-') {
    const sandboxRoot = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
    const paths = buildSandboxPaths(sandboxRoot);
    await runPlugin({ command: 'InitCommunity' }, sandboxRoot);
    return {
        ...paths,
        runCommand(command, args = {}) {
            return runPlugin({ command, ...args }, sandboxRoot);
        },
        async readJson(filePath) {
            const content = await fs.readFile(filePath, 'utf-8');
            return JSON.parse(content);
        },
        async writeJson(filePath, data) {
            await fs.mkdir(path.dirname(filePath), { recursive: true });
            await fs.writeFile(filePath, JSON.stringify(data, null, 2), 'utf-8');
        },
        async findPostFilenameByUid(uid) {
            const files = await fs.readdir(paths.postsDir);
            return files.find((file) => file.includes(`[${uid}]`) && file.endsWith('.md')) || null;
        },
        async checkReviewTimeouts(now = Date.now()) {
            const { checkReviewTimeouts } = loadAssistantWithSandbox(sandboxRoot);
            return checkReviewTimeouts(now);
        }
    };
}

module.exports = {
    createSandboxContext
};
