const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
    RETRIEVAL_FALLBACK_WARNING,
    createAgentRegistryService
} = require('../../../modules/agentGateway/services/agentRegistryService');
const { createAgentDirectoryPort } = require('../../../modules/agentGateway/ports/agentDirectory');
const {
    createHostPromptRenderer,
    needsRagRender
} = require('../../../modules/agentGateway/composition/agentPromptRenderer');

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

function createAgentDirectory(agentManager, renderPrompt) {
    return createAgentDirectoryPort({
        ensureLoaded: () => agentManager.getAllAgentFiles(),
        listAgents: () => Array.from(agentManager.agentMap.entries()).map(([alias, sourceFile]) => ({ alias, sourceFile })),
        isAgent: (agentId) => agentManager.isAgent(agentId),
        getAgentPrompt: (agentId) => agentManager.getAgentPrompt(agentId),
        getAgentSourcePath: (agentId) => {
            const sourceFile = agentManager.agentMap.get(agentId) || '';
            return { sourceFile, absoluteSourcePath: path.join(agentManager.agentDir, sourceFile) };
        },
        renderPrompt
    });
}

function createRegistryService({ agentManager, capabilityService, renderPrompt }) {
    return createAgentRegistryService({
        agentDirectoryPort: createAgentDirectory(agentManager, renderPrompt),
        capabilityService
    });
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

    const service = createRegistryService({
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

    const service = createRegistryService({
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

    const service = createRegistryService({
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

    const service = createRegistryService({
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

    const service = createRegistryService({
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

test('AgentRegistryService default render resolves nested variables and passes prompt through RAG system rendering', async () => {
    const agentDir = await createTempAgentDir();
    await writeAgentFile(
        agentDir,
        'Nexus.md',
        [
            '天气：{{TarSysPrompt}}',
            '[[VCP元思考::Auto::Group]]',
            '个人记忆:[[Nexus日记本::Time::TagMemo]]'
        ].join('\n')
    );

    const ragPlugin = {
        async processMessages(messages) {
            const cloned = JSON.parse(JSON.stringify(messages));
            cloned[0].content = cloned[0].content
                .replace('[[VCP元思考::Auto::Group]]', '元思考结果：保持结构化推理。')
                .replace('[[Nexus日记本::Time::TagMemo]]', '记忆片段：沉淀了可复用的调试方法。');
            return cloned;
        }
    };
    const pluginManager = {
        messagePreprocessors: new Map([['RAGDiaryPlugin', ragPlugin]]),
        getAllPlaceholderValues() {
            return new Map([
                ['VCPWeatherInfo', { value: '⚠️天气预警\n晴 25C' }]
            ]);
        },
        getIndividualPluginDescriptions() {
            return new Map();
        },
        getResolvedPluginConfigValue() {
            return '';
        }
    };

    const agentManager = createAgentManager(agentDir, {
        Nexus: 'Nexus.md'
    });
    const renderPrompt = createHostPromptRenderer(pluginManager, {
        capabilities: () => ({ processMessages: true }),
        processMessages: (...args) => ragPlugin.processMessages(...args)
    });
    const service = createRegistryService({
        agentManager,
        capabilityService: createCapabilityServiceStub(),
        renderPrompt
    });
    const previousTarSysPrompt = process.env.TarSysPrompt;

    try {
        process.env.TarSysPrompt = '当前天气是{{VCPWeatherInfo}}。';
        const rendered = await service.renderAgent('Nexus');

        assert.equal(rendered.renderedPrompt.includes('天气：当前天气是⚠️天气预警\n晴 25C。'), true);
        assert.equal(rendered.renderedPrompt.includes('元思考结果：保持结构化推理。'), true);
        assert.equal(rendered.renderedPrompt.includes('记忆片段：沉淀了可复用的调试方法。'), true);
        assert.equal(rendered.renderedPrompt.includes('{{⚠️天气预警'), false);
        assert.equal(rendered.unresolved.length, 0);
        assert.equal(rendered.renderMeta.memoryRecallApplied, true);
        assert.deepEqual(rendered.renderMeta.recallSources, ['tagmemo']);
    } finally {
        if (typeof previousTarSysPrompt === 'string') {
            process.env.TarSysPrompt = previousTarSysPrompt;
        } else {
            delete process.env.TarSysPrompt;
        }
    }
});

test('host custom renderer receives the legacy renderContext shape', async () => {
    const pluginManager = { marker: 'host' };
    const renderPrompt = createHostPromptRenderer(pluginManager, null, async (input) => {
        assert.equal(input.renderContext.pluginManager, pluginManager);
        assert.deepEqual(input.renderContext.messages, [{ role: 'user', content: 'hello' }]);
        return input.rawPrompt;
    });
    const rendered = await renderPrompt({
        agentId: 'Ariadne',
        rawPrompt: 'prompt',
        renderOptions: { messages: [{ role: 'user', content: 'hello' }] }
    });
    assert.equal(rendered, 'prompt');
});

test('the RAG render gate covers cold knowledge bases, not just diaries', () => {
    // Gateway 侧闸门曾是 RAGDiaryPlugin 闸门的真子集，漏掉的正好是冷知识库：
    // 只有 [[X知识库]] 的提示词一次都不会走 processMessages，静默无痕。
    assert.equal(needsRagRender('付鹏观点库: [[付鹏观点库知识库:6::Rerank]]'), true, 'knowledge base only');
    assert.equal(needsRagRender('记忆: [[付鹏日记本::Time::TagMemo+]]'), true, 'diary only');
    assert.equal(needsRagRender('[[X知识库]] 与 [[Y日记本]]'), true, 'both');
    assert.equal(needsRagRender('《《某某知识库》》'), true, '《《》》 form');
    assert.equal(needsRagRender('[[VCP元思考::Auto::Group]]'), true, 'meta thinking');
    assert.equal(needsRagRender('普通提示词，{{VarUserName}} 没有检索占位符'), false, 'no retrieval placeholder');
});

async function renderWithRagSpy(promptBody, renderOptions) {
    const agentDir = await createTempAgentDir();
    await writeAgentFile(agentDir, 'Ariadne.md', promptBody);
    const calls = [];
    const ragPort = {
        capabilities: () => ({ processMessages: true }),
        async processMessages(messages) {
            calls.push(messages);
            const cloned = JSON.parse(JSON.stringify(messages));
            cloned[0].content = cloned[0].content
                .replace('[[付鹏观点库知识库:6::Rerank]]', '观点库片段：套息交易在缩圈。');
            return cloned;
        }
    };
    const pluginManager = {
        messagePreprocessors: new Map(),
        getAllPlaceholderValues: () => new Map(),
        getIndividualPluginDescriptions: () => new Map(),
        getResolvedPluginConfigValue: () => ''
    };
    const service = createRegistryService({
        agentManager: createAgentManager(agentDir, { Ariadne: 'Ariadne.md' }),
        capabilityService: createCapabilityServiceStub(),
        renderPrompt: createHostPromptRenderer(pluginManager, ragPort)
    });
    const rendered = await service.renderAgent('Ariadne', renderOptions);
    await fs.rm(agentDir, { recursive: true, force: true });
    return { rendered, calls };
}

test('a knowledge-base-only prompt reaches the RAG retriever and reports injection', async () => {
    const { rendered, calls } = await renderWithRagSpy(
        '付鹏观点库: [[付鹏观点库知识库:6::Rerank]]',
        { query: '美元走弱对港股的影响' }
    );

    assert.equal(calls.length, 1, 'processMessages must be called for a knowledge-base-only prompt');
    assert.equal(calls[0][1].content, '美元走弱对港股的影响', 'query drives the retrieval');
    assert.equal(rendered.renderedPrompt.includes('观点库片段'), true);
    assert.equal(rendered.renderMeta.knowledgeInjected, true);
    assert.equal(rendered.renderMeta.knowledgeQuerySource, 'query');
    assert.deepEqual(rendered.warnings, []);
});

test('retrieval query precedence is query > latest user message > fallback', async () => {
    const prompt = '付鹏观点库: [[付鹏观点库知识库:6::Rerank]]';

    const explicit = await renderWithRagSpy(prompt, {
        query: '显式检索式',
        messages: [{ role: 'user', content: '对话里的问题' }]
    });
    assert.equal(explicit.calls[0][1].content, '显式检索式');
    assert.equal(explicit.rendered.renderMeta.knowledgeQuerySource, 'query');

    const fromMessages = await renderWithRagSpy(prompt, {
        messages: [{ role: 'user', content: '对话里的问题' }]
    });
    assert.equal(fromMessages.calls[0][1].content, '对话里的问题');
    assert.equal(fromMessages.rendered.renderMeta.knowledgeQuerySource, 'messages');
    assert.deepEqual(fromMessages.rendered.warnings, []);

    const degraded = await renderWithRagSpy(prompt, {});
    assert.equal(degraded.rendered.renderMeta.knowledgeQuerySource, 'fallback');
    assert.notEqual(degraded.calls[0][1].content, '显式检索式');
    // 退化必须是响亮的：占位符照样被替换，只有 warning 能暴露命中的是无关片段
    assert.equal(degraded.rendered.warnings.includes(RETRIEVAL_FALLBACK_WARNING), true);
});

test('a prompt without retrieval placeholders never reports a degraded retrieval', async () => {
    const { rendered, calls } = await renderWithRagSpy('没有任何检索占位符的提示词', {});
    assert.equal(calls.length, 0);
    assert.equal(rendered.renderMeta.knowledgeInjected, false);
    assert.deepEqual(rendered.warnings, [], 'no retrieval placeholders means nothing degraded');
});

test('AgentRegistryService throws AGENT_NOT_FOUND for unknown aliases', async () => {
    const agentDir = await createTempAgentDir();
    const service = createRegistryService({
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
