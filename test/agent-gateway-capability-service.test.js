const assert = require('node:assert/strict');
const test = require('node:test');

const { createCapabilityService } = require('../modules/agentGateway/services/capabilityService');
const { createSchemaRegistry } = require('../modules/agentGateway/infra/schemaRegistry');
const {
    createKnowledgeBaseManager,
    createPluginManager
} = require('./helpers/agent-gateway-test-helpers');

test('CapabilityService builds compatible capabilities and scope-filtered targets', async () => {
    const pluginManager = createPluginManager({
        openClawBridgeConfig: {
            rag: {
                agentDiaryMap: {
                    'agent.default': ['Nova', 'SharedMemory']
                },
                allowCrossRoleAccess: false
            }
        }
    });
    const schemaRegistry = createSchemaRegistry();
    const service = createCapabilityService({
        pluginManager,
        bridgeVersion: 'v1',
        schemaRegistry
    });

    const capabilities = await service.getCapabilities({
        agentId: 'agent.default',
        includeMemoryTargets: true
    });

    assert.equal(capabilities.server.name, 'VCPToolBox');
    assert.equal(capabilities.server.version, '7.1.2');
    assert.equal(capabilities.server.bridgeVersion, 'v1');
    assert.deepEqual(capabilities.tools.map((tool) => tool.name), ['ChromeBridge', 'RemoteSearch', 'SciCalculator']);
    assert.deepEqual(capabilities.memory.targets.map((target) => target.id), ['Nova', 'SharedMemory']);
    assert.equal(capabilities.context.features.queryFromMessages, true);
    assert.equal(capabilities.context.features.truncation, true);
    assert.deepEqual(capabilities.jobs, {
        supported: true,
        states: ['accepted', 'running', 'waiting_approval', 'completed', 'failed', 'cancelled'],
        actions: ['poll', 'cancel']
    });
    assert.deepEqual(capabilities.events, {
        supported: true,
        transports: ['sse'],
        filters: ['jobId', 'agentId', 'sessionId']
    });

    const chromeBridge = capabilities.tools.find((tool) => tool.name === 'ChromeBridge');
    assert.equal(Array.isArray(chromeBridge.inputSchema.oneOf), true);
    assert.equal(chromeBridge.inputSchema.oneOf.length, 2);
    assert.equal(chromeBridge.invocationCommands.length, 2);
});

test('CapabilityService derives memory targets from maid aliases when explicit policy exists', async () => {
    const pluginManager = createPluginManager({
        openClawBridgeConfig: {
            rag: {
                agentDiaryMap: {
                    Nova: ['Nova']
                },
                allowCrossRoleAccess: false
            }
        }
    });
    const service = createCapabilityService({ pluginManager });

    const targets = await service.getMemoryTargets({
        agentId: 'agent.unknown',
        maid: 'Nova'
    });

    assert.deepEqual(targets.map((target) => target.id), ['Nova']);
});

test('CapabilityService exposes policy-allowed memory targets even before they exist on disk', async () => {
    const pluginManager = createPluginManager({
        vectorDBManager: createKnowledgeBaseManager({
            diaries: []
        })
    });
    const service = createCapabilityService({
        pluginManager,
        agentPolicyResolver: {
            async resolvePolicy() {
                return {
                    allowedDiaryNames: ['Nexus', 'Nexus架构设计']
                };
            }
        }
    });

    const targets = await service.getMemoryTargets({
        agentId: 'Nexus'
    });

    assert.deepEqual(targets.map((target) => target.id), ['Nexus', 'Nexus架构设计']);
    assert.deepEqual(targets.map((target) => target.displayName), ['Nexus日记本', 'Nexus架构设计日记本']);
});

test('schemaRegistry supports derived oneOf schema and explicit overrides', () => {
    const pluginManager = createPluginManager();
    const schemaRegistry = createSchemaRegistry();
    const plugin = pluginManager.getPlugin('ChromeBridge');

    const derivedSchema = schemaRegistry.getToolInputSchema(plugin);
    assert.equal(Array.isArray(derivedSchema.oneOf), true);
    assert.equal(derivedSchema.oneOf.length, 2);

    const explicitSchema = {
        type: 'object',
        additionalProperties: false,
        properties: {
            forced: { type: 'boolean' }
        },
        required: ['forced']
    };
    assert.equal(schemaRegistry.registerToolSchema('ChromeBridge', explicitSchema), true);
    assert.deepEqual(schemaRegistry.getToolInputSchema(plugin), explicitSchema);
});

test('CapabilityService filters tools with shared agent policy when configured', async () => {
    const pluginManager = createPluginManager({
        openClawBridgeConfig: {
            rag: {
                agentDiaryMap: {
                    'agent.nova': ['Nova']
                },
                allowCrossRoleAccess: false
            },
            policy: {
                agentPolicyMap: {
                    'agent.nova': {
                        toolScopes: ['SciCalculator']
                    }
                }
            }
        }
    });
    const bundle = require('../modules/agentGateway/createGatewayServiceBundle').getGatewayServiceBundle(pluginManager);

    const capabilities = await bundle.capabilityService.getCapabilities({
        agentId: 'agent.nova',
        includeMemoryTargets: true
    });

    assert.deepEqual(capabilities.tools.map((tool) => tool.name), ['SciCalculator']);
    assert.deepEqual(capabilities.memory.targets.map((target) => target.id), ['Nova']);
});
