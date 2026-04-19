const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
    createAgentRegistryService
} = require('../modules/agentGateway/services/agentRegistryService');

async function createTempAgentDir() {
    return fs.mkdtemp(path.join(os.tmpdir(), 'agw-agent-registry-'));
}

async function writeAgentFile(baseDir, relativePath, content) {
    const absolutePath = path.join(baseDir, relativePath);
    await fs.mkdir(path.dirname(absolutePath), { recursive: true });
    await fs.writeFile(absolutePath, content, 'utf8');
}

function createAgentManager(agentDir, mappings) {
    const agentMap = new Map(Object.entries(mappings));
    return {
        agentDir,
        agentMap,
        isAgent(alias) {
            return agentMap.has(alias);
        },
        async getAgentPrompt(alias) {
            const sourceFile = agentMap.get(alias);
            return fs.readFile(path.join(agentDir, sourceFile), 'utf8');
        },
        async getAllAgentFiles() {
            return {
                files: Array.from(agentMap.values()),
                folderStructure: {}
            };
        }
    };
}

function createCapabilityServiceStub() {
    return {
        async getCapabilities({ agentId }) {
            if (agentId === 'Ariadne') {
                return {
                    tools: [
                        { name: 'SciCalculator', approvalRequired: false },
                        { name: 'RemoteSearch', approvalRequired: false }
                    ],
                    memory: {
                        features: {
                            writeBack: true
                        }
                    },
                    context: { supported: true },
                    jobs: { supported: false },
                    events: { supported: false }
                };
            }

            return {
                tools: [
                    { name: 'ChromeBridge', approvalRequired: false }
                ],
                memory: {
                    features: {
                        writeBack: true
                    }
                },
                context: { supported: true },
                jobs: { supported: false },
                events: { supported: false }
            };
        },
        async getMemoryTargets({ agentId }) {
            return agentId === 'Ariadne'
                ? [{ id: 'Nova' }, { id: 'SharedMemory' }]
                : [{ id: 'ProjectAlpha' }];
        }
    };
}

test('AgentRegistryService lists agents with stable metadata and policy hints', async () => {
    const agentDir = await createTempAgentDir();
    await writeAgentFile(agentDir, 'Ariadne.md', 'Ariadne system prompt\nsecond line');
    await writeAgentFile(agentDir, 'roles/Bard.md', 'Bard prompt');

    const service = createAgentRegistryService({
        agentManager: createAgentManager(agentDir, {
            Bard: 'roles/Bard.md',
            Ariadne: 'Ariadne.md'
        }),
        capabilityService: createCapabilityServiceStub(),
        renderPrompt: async ({ rawPrompt }) => rawPrompt
    });

    const list = await service.listAgents();

    assert.deepEqual(list.map((entry) => entry.agentId), ['Ariadne', 'Bard']);
    assert.equal(list[0].sourceFile, 'Ariadne.md');
    assert.equal(list[0].exists, true);
    assert.equal(list[0].summary, 'Ariadne system prompt');
    assert.equal(typeof list[0].mtime, 'string');
    assert.equal(list[0].hash.length, 64);
    assert.deepEqual(list[0].defaultPolicies, {
        toolNames: ['SciCalculator', 'RemoteSearch'],
        memoryTargetIds: ['Nova', 'SharedMemory']
    });
    assert.deepEqual(list[0].capabilityHints, {
        toolNames: ['SciCalculator', 'RemoteSearch'],
        memoryTargetIds: ['Nova', 'SharedMemory'],
        contextSupported: true,
        memoryWriteSupported: true,
        jobsSupported: false,
        eventsSupported: false
    });
});

test('AgentRegistryService returns detail with prompt dependencies and accessible capabilities', async () => {
    const agentDir = await createTempAgentDir();
    await writeAgentFile(
        agentDir,
        'Ariadne.md',
        [
            'Ariadne system prompt',
            '{{agent:Bard}}',
            '{{VarUserName}}',
            '[[VCP元思考::Auto::Group]]'
        ].join('\n')
    );
    await writeAgentFile(agentDir, 'roles/Bard.md', 'Bard prompt');

    const service = createAgentRegistryService({
        agentManager: createAgentManager(agentDir, {
            Ariadne: 'Ariadne.md',
            Bard: 'roles/Bard.md'
        }),
        capabilityService: createCapabilityServiceStub(),
        renderPrompt: async ({ rawPrompt }) => rawPrompt
    });

    const detail = await service.getAgentDetail('Ariadne');

    assert.equal(detail.agentId, 'Ariadne');
    assert.equal(detail.prompt.raw.includes('{{agent:Bard}}'), true);
    assert.equal(detail.prompt.size > 0, true);
    assert.deepEqual(detail.prompt.placeholderSummary.agents, ['Bard']);
    assert.deepEqual(detail.prompt.placeholderSummary.variables, ['VarUserName']);
    assert.equal(detail.prompt.placeholderSummary.metaThinkingBlocks, 1);
    assert.deepEqual(detail.prompt.dependencies.agents, ['Bard']);
    assert.deepEqual(detail.accessibleTools.map((tool) => tool.name), ['SciCalculator', 'RemoteSearch']);
    assert.deepEqual(detail.accessibleMemoryTargets.map((target) => target.id), ['Nova', 'SharedMemory']);
});

test('AgentRegistryService derives governed profile and prompt-template preview shapes from shared detail', async () => {
    const agentDir = await createTempAgentDir();
    await writeAgentFile(
        agentDir,
        'Ariadne.md',
        [
            'Ariadne system prompt',
            '{{agent:Bard}}',
            '{{VarUserName}}'
        ].join('\n')
    );
    await writeAgentFile(agentDir, 'roles/Bard.md', 'Bard prompt');

    const service = createAgentRegistryService({
        agentManager: createAgentManager(agentDir, {
            Ariadne: 'Ariadne.md',
            Bard: 'roles/Bard.md'
        }),
        capabilityService: createCapabilityServiceStub(),
        renderPrompt: async ({ rawPrompt }) => rawPrompt
    });

    const profile = await service.getAgentProfile('Ariadne');
    const preview = await service.getPromptTemplatePreview('Ariadne');

    assert.equal(profile.agentId, 'Ariadne');
    assert.equal(profile.summary, 'Ariadne system prompt');
    assert.deepEqual(profile.accessibleTools.map((tool) => tool.name), ['SciCalculator', 'RemoteSearch']);
    assert.deepEqual(profile.accessibleMemoryTargets.map((target) => target.id), ['Nova', 'SharedMemory']);

    assert.equal(preview.agentId, 'Ariadne');
    assert.equal(preview.prompt.raw.includes('{{VarUserName}}'), true);
    assert.deepEqual(preview.prompt.dependencies.agents, ['Bard']);
    assert.deepEqual(preview.prompt.placeholderSummary.variables, ['VarUserName']);
});

test('AgentRegistryService renders agents with variables, unresolved warnings, and truncation metadata', async () => {
    const agentDir = await createTempAgentDir();
    await writeAgentFile(
        agentDir,
        'Ariadne.md',
        'Hello {{VarUserName}} and {{UnknownPlaceholder}} from Ariadne'
    );

    const service = createAgentRegistryService({
        agentManager: createAgentManager(agentDir, {
            Ariadne: 'Ariadne.md'
        }),
        capabilityService: createCapabilityServiceStub(),
        renderPrompt: async ({ rawPrompt, renderVariables }) =>
            rawPrompt.replaceAll('{{VarUserName}}', renderVariables.VarUserName || '')
    });

    const rendered = await service.renderAgent('Ariadne', {
        variables: {
            VarUserName: 'Nova'
        },
        maxLength: 24
    });

    assert.equal(rendered.agentId, 'Ariadne');
    assert.equal(rendered.truncated, true);
    assert.deepEqual(rendered.dependencies.variables, ['VarUserName']);
    assert.deepEqual(rendered.unresolved, ['{{UnknownPlaceholder}}']);
    assert.equal(rendered.warnings.includes('render output still contains unresolved prompt constructs'), true);
    assert.equal(rendered.warnings.includes('render output was truncated to the requested maxLength'), true);
    assert.deepEqual(rendered.meta.variableKeys, ['VarUserName']);
    assert.equal(rendered.renderMeta.memoryRecallApplied, false);
    assert.deepEqual(rendered.renderMeta.recallSources, []);
    assert.equal(rendered.renderMeta.truncated, true);
    assert.equal(rendered.renderMeta.filteredByPolicy, false);
    assert.equal(rendered.renderMeta.unresolvedCount, 1);
    assert.deepEqual(rendered.renderMeta.variableKeys, ['VarUserName']);
    assert.equal(rendered.renderedPrompt, 'Hello Nova and {{Unkn...');
});

test('AgentRegistryService marks memory recall applied only after render consumes memory syntax', async () => {
    const agentDir = await createTempAgentDir();
    await writeAgentFile(
        agentDir,
        'Ariadne.md',
        'Hello {{VarUserName}}\n[[阿里阿德涅日记本::Time::TagMemo]]'
    );

    const service = createAgentRegistryService({
        agentManager: createAgentManager(agentDir, {
            Ariadne: 'Ariadne.md'
        }),
        capabilityService: createCapabilityServiceStub(),
        renderPrompt: async ({ rawPrompt, renderVariables }) =>
            rawPrompt
                .replaceAll('{{VarUserName}}', renderVariables.VarUserName || '')
                .replace('[[阿里阿德涅日记本::Time::TagMemo]]', '记忆片段：上周完成了 gateway render contract 收口。')
    });

    const rendered = await service.renderAgent('Ariadne', {
        variables: {
            VarUserName: 'Nova'
        }
    });

    assert.equal(rendered.renderedPrompt.includes('记忆片段'), true);
    assert.equal(rendered.renderMeta.memoryRecallApplied, true);
    assert.deepEqual(rendered.renderMeta.recallSources, ['tagmemo']);
    assert.equal(rendered.renderMeta.unresolvedCount, 0);
});

test('AgentRegistryService throws AGENT_NOT_FOUND for unknown aliases', async () => {
    const agentDir = await createTempAgentDir();
    const service = createAgentRegistryService({
        agentManager: createAgentManager(agentDir, {
            Ariadne: 'Ariadne.md'
        }),
        capabilityService: createCapabilityServiceStub(),
        renderPrompt: async ({ rawPrompt }) => rawPrompt
    });

    await assert.rejects(
        service.getAgentDetail('MissingAgent'),
        (error) => error && error.code === 'AGENT_NOT_FOUND'
    );
});
