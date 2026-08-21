const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
    areDiaryNamesEquivalent,
    resolveDiaryAliasToAvailable
} = require('../../../modules/agentGateway/policy/mcpAgentMemoryPolicy');
const {
    ensureDiaryAllowed
} = require('../../../modules/agentGateway/policy/diaryScopeGuard');
const {
    applyDiaryPolicyGate
} = require('../../../modules/agentGateway/protocols/mcp/diaryPolicyGate');
const { MCP_GATEWAY_TOOL_NAMES } = require('../../../modules/agentGateway/contracts/operations');

const NEXUS_POLICY_DIARIES = [
    'Nexus工程经验日记本',
    'Nexus架构设计日记本',
    'Nexus项目-*'
];

test('exact diary equivalence keeps suffix-alias behavior', () => {
    assert.equal(areDiaryNamesEquivalent('Nexus工程经验日记本', 'Nexus工程经验'), true);
    assert.equal(areDiaryNamesEquivalent('Nexus工程经验', 'Nexus工程经验日记本'), true);
    assert.equal(areDiaryNamesEquivalent('Nexus工程经验日记本', 'Nexus架构设计日记本'), false);
    assert.equal(areDiaryNamesEquivalent('', 'Nexus工程经验日记本'), false);
    assert.equal(areDiaryNamesEquivalent('Nexus工程经验日记本', ''), false);
});

test('Nexus项目-* wildcard matches project diaries in both argument orders', () => {
    assert.equal(areDiaryNamesEquivalent('Nexus项目-*', 'Nexus项目-VCPToolBox日记本'), true);
    assert.equal(areDiaryNamesEquivalent('Nexus项目-VCPToolBox日记本', 'Nexus项目-*'), true);
    assert.equal(areDiaryNamesEquivalent('Nexus项目-*', 'Nexus项目-VCPToolBox'), true);
    assert.equal(areDiaryNamesEquivalent('Nexus项目-VCPToolBox', 'Nexus项目-*'), true);
});

test('wildcard pattern is equivalent only to the identical allowed pattern', () => {
    assert.equal(areDiaryNamesEquivalent('Nexus项目-*', 'Nexus项目-*'), true);
});

test('Nexus项目-* wildcard rejects diaries outside the prefix', () => {
    assert.equal(areDiaryNamesEquivalent('Nexus项目-*', 'Nexus项目X-Foo日记本'), false);
    assert.equal(areDiaryNamesEquivalent('Nexus项目X-Foo日记本', 'Nexus项目-*'), false);
    assert.equal(areDiaryNamesEquivalent('Nexus项目-*', 'Nexus工程经验日记本'), false);
});

test('non-whitelisted wildcard prefixes match nothing', () => {
    assert.equal(areDiaryNamesEquivalent('Nexus-*', 'Nexus工程经验日记本'), false);
    assert.equal(areDiaryNamesEquivalent('Nexus-*', 'Nexus项目-VCPToolBox日记本'), false);
    assert.equal(areDiaryNamesEquivalent('*', 'Nexus项目-VCPToolBox日记本'), false);
    assert.equal(areDiaryNamesEquivalent('迈达斯-*', '迈达斯日记本'), false);
    assert.equal(areDiaryNamesEquivalent('Nexus-*', 'Nexus-*'), false);
});

test('ensureDiaryAllowed keeps allowed-diary list in the 403 self-healing payload', () => {
    assert.throws(
        () => ensureDiaryAllowed({
            policy: { allowedDiaryNames: NEXUS_POLICY_DIARIES },
            diaryName: 'Nexus项目X-Foo日记本',
            authContext: { agentId: 'Nexus' }
        }),
        (error) => {
            assert.equal(error.code, 'AGW_FORBIDDEN');
            assert.deepEqual(error.details.allowedDiaries, NEXUS_POLICY_DIARIES);
            assert.match(error.message, /Allowed diaries: Nexus工程经验日记本, Nexus架构设计日记本, Nexus项目-\*\./);
            return true;
        }
    );

    ensureDiaryAllowed({
        policy: { allowedDiaryNames: NEXUS_POLICY_DIARIES },
        diaryName: 'Nexus项目-VCPToolBox日记本',
        authContext: { agentId: 'Nexus' }
    });
});

test('resolveDiaryAliasToAvailable keeps wildcard patterns verbatim', () => {
    // 通配条目是匹配模式而非别名：即使已有匹配的具体日记也原样保留——否则
    // guidance bundle / skill 导出物会被写死成当前恰好存在的项目名，白名单
    // 对新项目的覆盖能力也随之塌缩。
    assert.equal(
        resolveDiaryAliasToAvailable('Nexus项目-*', ['Nexus项目-VCPToolBox日记本']),
        'Nexus项目-*'
    );
    assert.equal(resolveDiaryAliasToAvailable('Nexus项目-*', []), 'Nexus项目-*');
    // 具体日记名的解析行为不变
    assert.equal(
        resolveDiaryAliasToAvailable('Nexus项目-VCPToolBox日记本', ['Nexus项目-VCPToolBox日记本']),
        'Nexus项目-VCPToolBox日记本'
    );
});

test('applyDiaryPolicyGate honors the wildcard policy for memory search', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agw-memory-policy-'));
    const policyPath = path.join(tempDir, 'mcp_agent_memory_policy.json');
    fs.writeFileSync(policyPath, JSON.stringify({
        agents: {
            Nexus: {
                maid: 'Nexus',
                allowedDiaries: NEXUS_POLICY_DIARIES,
                defaultDiaries: ['Nexus工程经验日记本', 'Nexus架构设计日记本']
            }
        }
    }), 'utf8');

    const previousPolicyPath = process.env.MCP_AGENT_MEMORY_POLICY_PATH;
    process.env.MCP_AGENT_MEMORY_POLICY_PATH = policyPath;
    try {
        const wildcardResult = applyDiaryPolicyGate({
            toolName: MCP_GATEWAY_TOOL_NAMES.MEMORY_SEARCH,
            payload: {
                agentId: 'Nexus',
                diaries: ['Nexus项目-VCPToolBox日记本']
            }
        });
        assert.equal(wildcardResult.rejection, null);
        // The gate canonicalizes diary names (strips the 日记本 suffix) before
        // forwarding the payload, mirroring pre-wildcard behavior.
        assert.deepEqual(wildcardResult.payload.diaries, ['Nexus项目-VCPToolBox']);

        const forbiddenResult = applyDiaryPolicyGate({
            toolName: MCP_GATEWAY_TOOL_NAMES.MEMORY_SEARCH,
            payload: {
                agentId: 'Nexus',
                diaries: ['Nexus日记本']
            }
        });
        assert.equal(forbiddenResult.rejection.status, 403);
        assert.deepEqual(forbiddenResult.rejection.details.allowedDiaries, NEXUS_POLICY_DIARIES);

        const defaultResult = applyDiaryPolicyGate({
            toolName: MCP_GATEWAY_TOOL_NAMES.CONTEXT_ASSEMBLE,
            payload: { agentId: 'Nexus' }
        });
        assert.equal(defaultResult.rejection, null);
        assert.equal(defaultResult.diaryPolicy.appliedDefault, true);
        // The default branch forwards configured names verbatim (with the
        // 日记本 suffix), while explicit selections are canonicalized above.
        assert.deepEqual(
            defaultResult.payload.diaries,
            ['Nexus工程经验日记本', 'Nexus架构设计日记本']
        );
    } finally {
        if (previousPolicyPath === undefined) {
            delete process.env.MCP_AGENT_MEMORY_POLICY_PATH;
        } else {
            process.env.MCP_AGENT_MEMORY_POLICY_PATH = previousPolicyPath;
        }
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
});


test('resolvePolicy keeps the wildcard entry instead of collapsing it to existing project diaries', async () => {
    const { createAgentPolicyResolver } = require('../../../modules/agentGateway/policy/agentPolicyResolver');
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agw-memory-policy-'));
    const policyPath = path.join(tempDir, 'mcp_agent_memory_policy.json');
    fs.writeFileSync(policyPath, JSON.stringify({
        agents: {
            Nexus: {
                maid: 'Nexus',
                allowedDiaries: NEXUS_POLICY_DIARIES,
                defaultDiaries: ['Nexus工程经验日记本', 'Nexus架构设计日记本']
            }
        }
    }), 'utf8');

    const previousPolicyPath = process.env.MCP_AGENT_MEMORY_POLICY_PATH;
    process.env.MCP_AGENT_MEMORY_POLICY_PATH = policyPath;
    try {
        const resolver = createAgentPolicyResolver({ ragConfig: {}, policyConfig: {} });
        const policy = await resolver.resolvePolicy({
            authContext: { agentId: 'Nexus' },
            // 生产形态：日记目录里已存在一个具体项目日记
            availableDiaries: ['Nexus工程经验', 'Nexus架构设计', 'Nexus项目-VCPToolBox']
        });
        assert.ok(policy.allowedDiaryNames.includes('Nexus项目-*'), 'wildcard pattern survives verbatim');
        assert.ok(
            !policy.allowedDiaryNames.includes('Nexus项目-VCPToolBox'),
            'no concrete project name is baked into the resolved list'
        );
        assert.deepEqual(policy.defaultDiaryNames, ['Nexus工程经验', 'Nexus架构设计']);
    } finally {
        if (previousPolicyPath === undefined) {
            delete process.env.MCP_AGENT_MEMORY_POLICY_PATH;
        } else {
            process.env.MCP_AGENT_MEMORY_POLICY_PATH = previousPolicyPath;
        }
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
});

test('resolveDiaryAccess admits project diaries under a wildcard policy', async () => {
    const { resolveDiaryAccess } = require('../../../modules/agentGateway/core/recall/diaryAccess');
    const policyResolver = {
        async resolvePolicy() {
            return {
                allowedDiaryNames: ['Nexus工程经验', 'Nexus架构设计', 'Nexus项目-*'],
                defaultDiaryNames: ['Nexus工程经验', 'Nexus架构设计']
            };
        }
    };
    const availableDiaries = ['Nexus工程经验', 'Nexus架构设计', 'Nexus项目-VCPToolBox'];

    const allowed = await resolveDiaryAccess({
        requestedDiaries: ['Nexus项目-VCPToolBox日记本'],
        availableDiaries,
        agentId: 'Nexus',
        authContext: { agentId: 'Nexus' },
        policyResolver,
        forbiddenCode: 'AGW_FORBIDDEN'
    });
    assert.equal(allowed.success, true);
    assert.deepEqual(allowed.targetDiaries, ['Nexus项目-VCPToolBox']);

    const forbidden = await resolveDiaryAccess({
        requestedDiaries: ['Nexus日记本'],
        availableDiaries,
        agentId: 'Nexus',
        authContext: { agentId: 'Nexus' },
        policyResolver,
        forbiddenCode: 'AGW_FORBIDDEN'
    });
    assert.equal(forbidden.success, false);
    assert.equal(forbidden.status, 403);
    // 403 自述清单保留通配模式原样，而不是塌缩成的具体项目名
    assert.deepEqual(forbidden.details.allowedDiaries, ['Nexus工程经验', 'Nexus架构设计', 'Nexus项目-*']);
});
