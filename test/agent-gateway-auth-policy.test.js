const assert = require('node:assert/strict');
const test = require('node:test');

const {
    resolveAuthContext
} = require('../modules/agentGateway/policy/authContextResolver');
const {
    createAgentPolicyResolver
} = require('../modules/agentGateway/policy/agentPolicyResolver');
const {
    ensureToolAllowed
} = require('../modules/agentGateway/policy/toolScopeGuard');
const {
    ensureDiaryAllowed
} = require('../modules/agentGateway/policy/diaryScopeGuard');
const {
    createPluginManager
} = require('./helpers/agent-gateway-test-helpers');

test('authContextResolver builds canonical transitional auth context', () => {
    const authContext = resolveAuthContext({
        requestContext: {
            requestId: 'req-auth-001',
            sessionId: 'sess-auth-001',
            agentId: 'agent.nova',
            source: 'agent-gateway-tool',
            runtime: 'native'
        },
        maid: 'Nova',
        adapter: 'native'
    });

    assert.equal(authContext.requestId, 'req-auth-001');
    assert.equal(authContext.sessionId, 'sess-auth-001');
    assert.equal(authContext.agentId, 'agent.nova');
    assert.equal(authContext.maid, 'Nova');
    assert.equal(authContext.authMode, 'admin_transition');
    assert.equal(authContext.isTransitionalAuth, true);
    assert.deepEqual(authContext.agentIdentity.aliases.includes('Nova'), true);
    assert.equal(authContext.gatewayIdentity.adapter, 'native');
});

test('authContextResolver builds canonical dedicated gateway auth context', () => {
    const authContext = resolveAuthContext({
        requestContext: {
            requestId: 'req-auth-001b',
            sessionId: 'sess-auth-001b',
            agentId: 'agent.nova',
            source: 'agent-gateway-tool',
            runtime: 'native'
        },
        authContext: {
            authMode: 'gateway_key',
            authSource: 'x-agent-gateway-key',
            gatewayId: 'gw-nova',
            roles: ['gateway_client']
        },
        maid: 'Nova',
        adapter: 'native'
    });

    assert.equal(authContext.authMode, 'gateway_key');
    assert.equal(authContext.authSource, 'x-agent-gateway-key');
    assert.equal(authContext.gatewayId, 'gw-nova');
    assert.equal(authContext.isTransitionalAuth, false);
    assert.equal(authContext.isDedicatedGatewayAuth, true);
    assert.deepEqual(authContext.roles, ['gateway_client']);
});

test('agentPolicyResolver returns shared tool and diary scopes with guards', async () => {
    const pluginManager = createPluginManager({
        openClawBridgeConfig: {
            rag: {
                agentDiaryMap: {
                    'agent.nova': ['Nova', 'SharedMemory']
                },
                allowCrossRoleAccess: false
            },
            policy: {
                agentPolicyMap: {
                    'agent.nova': {
                        toolScopes: ['SciCalculator', 'ChromeBridge']
                    }
                }
            }
        }
    });
    const resolver = createAgentPolicyResolver({ pluginManager });
    const authContext = resolveAuthContext({
        requestContext: {
            requestId: 'req-auth-002',
            sessionId: 'sess-auth-002',
            agentId: 'agent.nova',
            source: 'openclaw',
            runtime: 'openclaw'
        }
    });

    const policy = await resolver.resolvePolicy({
        authContext,
        availableDiaries: ['Nova', 'ProjectAlpha', 'SharedMemory']
    });

    assert.deepEqual(policy.allowedToolNames, ['SciCalculator', 'ChromeBridge']);
    assert.deepEqual(policy.allowedDiaryNames, ['Nova', 'SharedMemory']);

    assert.equal(ensureToolAllowed({
        policy,
        toolName: 'SciCalculator',
        authContext
    }), true);
    assert.equal(ensureDiaryAllowed({
        policy,
        diaryName: 'Nova',
        authContext
    }), true);

    assert.throws(
        () => ensureToolAllowed({ policy, toolName: 'RemoteSearch', authContext }),
        (error) => error && error.code === 'AGW_FORBIDDEN'
    );
    assert.throws(
        () => ensureDiaryAllowed({ policy, diaryName: 'ProjectAlpha', authContext }),
        (error) => error && error.code === 'AGW_FORBIDDEN'
    );
});
