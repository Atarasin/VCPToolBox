const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const {
    parseAgentGuidanceConfig,
    validateAgentGuidanceConfig
} = require('../../../modules/agentGateway/policy/agentGuidanceConfig');
const {
    parseCredentialFileConfig,
    parsePepperKeyringConfig,
    validateCredentialFileConfig,
    validatePepperKeyringConfig
} = require('../../../modules/agentGateway/policy/credentialConfigSchema');
const {
    crossValidateCredentialAgents,
    crossValidateCredentialPepperKids,
    crossValidateGuidanceAgents,
    crossValidateMemoryPolicyDiaries
} = require('../../../modules/agentGateway/policy/integrationCrossChecks');
const {
    buildGuidanceBundle,
    createAgentGuidanceResolver
} = require('../../../modules/agentGateway/policy/agentGuidanceResolver');

const CONFIG_DIR = path.join(__dirname, '..', '..', '..', 'modules', 'agentGateway', 'config');

function validGuidanceConfig() {
    return {
        version: 1,
        shared: {
            workflow: ['先 recall 后作答'],
            memoryWritePolicy: { write: ['已验证结论'], skip: ['密钥'] }
        },
        agents: {
            MCPMidas: {
                displayName: 'Midas',
                memoryDefaults: { tags: ['codex'], metadata: { project: 'quant' } }
            }
        }
    };
}

function validCredentialConfig() {
    return {
        version: 1,
        credentials: [
            {
                credentialId: 'midas-prod-2026-07',
                pepperKid: 'kid-a',
                tokenDigest: `hmac-sha256:${'a'.repeat(64)}`,
                boundAgentId: 'MCPMidas',
                scopes: ['gateway:read', 'gateway:execute'],
                status: 'active',
                expiresAt: '2026-10-01T00:00:00.000Z'
            }
        ]
    };
}

function validKeyring() {
    return { keys: { 'kid-a': Buffer.alloc(32, 7).toString('base64') } };
}

test('guidance schema accepts the checked-in example config', () => {
    const raw = fs.readFileSync(path.join(CONFIG_DIR, 'agent_guidance.json'), 'utf8');
    const result = parseAgentGuidanceConfig(raw);
    assert.equal(result.valid, true, JSON.stringify(result.errors));
    assert.equal(result.config.agents.MCPMidas.displayName, 'Midas');
    assert.equal(result.config.shared.workflow.length, 3);
});

test('guidance schema accepts a valid config and freezes the result', () => {
    const result = validateAgentGuidanceConfig(validGuidanceConfig());
    assert.equal(result.valid, true);
    assert.ok(Object.isFrozen(result.config));
    assert.deepEqual(result.config.shared.memoryWritePolicy.skip, ['密钥']);
});

test('guidance schema rejects corrupted JSON with a structured error', () => {
    const result = parseAgentGuidanceConfig('{ "version": 1, ');
    assert.equal(result.valid, false);
    assert.equal(result.config, null);
    assert.match(result.errors[0].message, /invalid JSON/);
});

test('guidance schema rejects wrong version and missing shared block', () => {
    const result = validateAgentGuidanceConfig({ version: 2 });
    assert.equal(result.valid, false);
    const paths = result.errors.map((error) => error.path);
    assert.ok(paths.includes('$.version'));
    assert.ok(paths.includes('$.shared'));
});

test('guidance schema rejects non-string workflow entries and bad displayName', () => {
    const config = validGuidanceConfig();
    config.shared.workflow = ['ok', 42];
    config.agents.MCPMidas.displayName = '   ';
    const result = validateAgentGuidanceConfig(config);
    assert.equal(result.valid, false);
    const paths = result.errors.map((error) => error.path);
    assert.ok(paths.includes('$.shared.workflow[1]'));
    assert.ok(paths.includes('$.agents.MCPMidas.displayName'));
});

test('guidance schema accepts an optional per-agent workflow override', () => {
    const config = validGuidanceConfig();
    config.agents.MCPMidas.workflow = ['先查回测记录', '再下结论'];
    const result = validateAgentGuidanceConfig(config);
    assert.equal(result.valid, true, JSON.stringify(result.errors));
    assert.deepEqual(result.config.agents.MCPMidas.workflow, ['先查回测记录', '再下结论']);
});

test('guidance schema rejects an empty or non-string per-agent workflow', () => {
    const emptyConfig = validGuidanceConfig();
    emptyConfig.agents.MCPMidas.workflow = [];
    const emptyResult = validateAgentGuidanceConfig(emptyConfig);
    assert.equal(emptyResult.valid, false);
    assert.ok(emptyResult.errors.map((error) => error.path).includes('$.agents.MCPMidas.workflow'));

    const badConfig = validGuidanceConfig();
    badConfig.agents.MCPMidas.workflow = ['ok', 7];
    const badResult = validateAgentGuidanceConfig(badConfig);
    assert.equal(badResult.valid, false);
    assert.ok(badResult.errors.map((error) => error.path).includes('$.agents.MCPMidas.workflow[1]'));
});

test('guidance bundle prefers the per-agent workflow and falls back to shared', () => {
    const snapshot = {
        revision: 'sha256:test',
        publishedAt: '2026-08-02T00:00:00.000Z',
        shared: {
            workflow: ['shared 口径'],
            memoryWritePolicy: { write: ['已验证结论'], skip: ['密钥'] }
        },
        agents: {
            Overridden: { displayName: '覆盖', workflow: ['agent 专属口径'] },
            Inherited: { displayName: '继承' }
        }
    };

    const overridden = buildGuidanceBundle({ snapshot, agentId: 'Overridden' });
    assert.deepEqual(overridden.workflow, ['agent 专属口径']);
    // 写入红线是全局单源，不随 agent 覆盖。
    assert.deepEqual(overridden.memoryWritePolicy.write, ['已验证结论']);

    const inherited = buildGuidanceBundle({ snapshot, agentId: 'Inherited' });
    assert.deepEqual(inherited.workflow, ['shared 口径']);
});

test('guidance schema accepts an optional per-agent skill block', () => {
    const config = validGuidanceConfig();
    config.agents.MCPMidas.skill = {
        name: 'midas-quant',
        domain: '量化选股',
        triggers: ['用户在量化仓库里做因子或回测'],
        notFor: ['无关的通用编码任务'],
        writeTargets: [{ diary: '迈达斯日记本', when: '得出因子结论后' }]
    };
    const result = validateAgentGuidanceConfig(config);
    assert.equal(result.valid, true, JSON.stringify(result.errors));
    assert.equal(result.config.agents.MCPMidas.skill.name, 'midas-quant');
    assert.deepEqual(result.config.agents.MCPMidas.skill.triggers, ['用户在量化仓库里做因子或回测']);
    assert.deepEqual(
        result.config.agents.MCPMidas.skill.writeTargets,
        [{ diary: '迈达斯日记本', when: '得出因子结论后' }]
    );
});

test('guidance schema rejects malformed skill blocks', () => {
    const emptyTriggers = validGuidanceConfig();
    emptyTriggers.agents.MCPMidas.skill = { triggers: [] };
    const emptyResult = validateAgentGuidanceConfig(emptyTriggers);
    assert.equal(emptyResult.valid, false);
    assert.ok(emptyResult.errors.map((error) => error.path).includes('$.agents.MCPMidas.skill.triggers'));

    const badName = validGuidanceConfig();
    badName.agents.MCPMidas.skill = { name: 'Not A Slug' };
    const badNameResult = validateAgentGuidanceConfig(badName);
    assert.equal(badNameResult.valid, false);
    assert.ok(badNameResult.errors.map((error) => error.path).includes('$.agents.MCPMidas.skill.name'));

    const badTarget = validGuidanceConfig();
    badTarget.agents.MCPMidas.skill = { writeTargets: [{ diary: '迈达斯日记本' }] };
    const badTargetResult = validateAgentGuidanceConfig(badTarget);
    assert.equal(badTargetResult.valid, false);
    assert.ok(badTargetResult.errors.map((error) => error.path).includes('$.agents.MCPMidas.skill.writeTargets[0].when'));
});

test('guidance bundle carries the skill block only when configured', () => {
    const snapshot = {
        revision: 'sha256:test',
        publishedAt: '2026-08-04T00:00:00.000Z',
        shared: {
            workflow: ['shared 口径'],
            memoryWritePolicy: { write: ['已验证结论'], skip: ['密钥'] }
        },
        agents: {
            WithSkill: { displayName: '有', skill: { domain: '宏观', triggers: ['问宏观时'] } },
            WithoutSkill: { displayName: '无' }
        }
    };

    assert.deepEqual(
        buildGuidanceBundle({ snapshot, agentId: 'WithSkill' }).skill,
        { domain: '宏观', triggers: ['问宏观时'] }
    );
    // 未配置时字段不出现，消费面（instructions/resource/bootstrap）形状不变
    assert.equal('skill' in buildGuidanceBundle({ snapshot, agentId: 'WithoutSkill' }), false);
});

test('credential schema accepts the checked-in example file shape', () => {
    const raw = fs.readFileSync(path.join(CONFIG_DIR, 'agent_gateway_credentials.json.example'), 'utf8');
    const result = parseCredentialFileConfig(raw);
    assert.equal(result.valid, true, JSON.stringify(result.errors));
    assert.equal(result.config.credentials.length, 2);
    assert.equal(result.config.credentials[1].boundAgentId, null);
});

test('credential schema rejects corrupted JSON', () => {
    const result = parseCredentialFileConfig('not json at all');
    assert.equal(result.valid, false);
    assert.match(result.errors[0].message, /invalid JSON/);
});

test('credential schema enforces admin-on-unbound-only rule', () => {
    const config = validCredentialConfig();
    config.credentials[0].scopes = ['admin'];
    const result = validateCredentialFileConfig(config);
    assert.equal(result.valid, false);
    assert.ok(result.errors.some((error) => /admin.*boundAgentId: null/.test(error.message)));
});

test('credential schema rejects duplicate credentialId and same-kid duplicate digest', () => {
    const config = validCredentialConfig();
    config.credentials.push({ ...config.credentials[0] });
    const result = validateCredentialFileConfig(config);
    assert.equal(result.valid, false);
    assert.ok(result.errors.some((error) => /duplicate credentialId/.test(error.message)));
    assert.ok(result.errors.some((error) => /duplicate tokenDigest/.test(error.message)));
});

test('credential schema requires expiresAt for rotating records and known statuses', () => {
    const config = validCredentialConfig();
    config.credentials[0].status = 'rotating';
    config.credentials[0].expiresAt = undefined;
    const result = validateCredentialFileConfig(config);
    assert.equal(result.valid, false);
    assert.ok(result.errors.some((error) => /required when status is "rotating"/.test(error.message)));

    const badStatus = validCredentialConfig();
    badStatus.credentials[0].status = 'paused';
    assert.equal(validateCredentialFileConfig(badStatus).valid, false);
});

test('credential schema maps legacy scope names with warnings, rejects when disabled', () => {
    const config = validCredentialConfig();
    config.credentials[0].scopes = ['mcp:read'];
    const mapped = validateCredentialFileConfig(config, { allowLegacyScopeNames: true });
    assert.equal(mapped.valid, true);
    assert.deepEqual(mapped.config.credentials[0].scopes, ['gateway:read']);
    assert.equal(mapped.warnings.length, 1);

    const rejected = validateCredentialFileConfig(config, { allowLegacyScopeNames: false });
    assert.equal(rejected.valid, false);
});

test('credential schema rejects allowedAgents on bound credentials and unknown scopes', () => {
    const config = validCredentialConfig();
    config.credentials[0].allowedAgents = ['Nexus'];
    config.credentials[0].scopes = ['gateway:write'];
    const result = validateCredentialFileConfig(config);
    assert.equal(result.valid, false);
    const messages = result.errors.map((error) => error.message);
    assert.ok(messages.some((message) => /only meaningful when boundAgentId is null/.test(message)));
    assert.ok(messages.some((message) => /unknown scope/.test(message)));
});

test('pepper keyring schema enforces 256-bit minimum entropy and base64 validity', () => {
    assert.equal(validatePepperKeyringConfig(validKeyring()).valid, true);

    const shortKey = { keys: { 'kid-a': Buffer.alloc(16, 1).toString('base64') } };
    const shortResult = validatePepperKeyringConfig(shortKey);
    assert.equal(shortResult.valid, false);
    assert.match(shortResult.errors[0].message, /at least 32 bytes/);

    const badBase64 = { keys: { 'kid-a': '!!!not-base64!!!' } };
    assert.equal(validatePepperKeyringConfig(badBase64).valid, false);

    const corrupted = parsePepperKeyringConfig('{');
    assert.equal(corrupted.valid, false);
    assert.match(corrupted.errors[0].message, /invalid JSON/);
});

test('cross check flags credentials referencing unknown pepperKid', () => {
    const errors = crossValidateCredentialPepperKids(
        validCredentialConfig(),
        { keys: { 'kid-other': Buffer.alloc(32) } }
    );
    assert.equal(errors.length, 1);
    assert.match(errors[0].message, /unknown pepperKid "kid-a"/);

    assert.deepEqual(
        crossValidateCredentialPepperKids(validCredentialConfig(), validKeyring()),
        []
    );
});

test('cross check flags guidance entries for unknown agents', () => {
    const guidance = validateAgentGuidanceConfig(validGuidanceConfig()).config;
    assert.deepEqual(crossValidateGuidanceAgents(guidance, ['MCPMidas']), []);
    const errors = crossValidateGuidanceAgents(guidance, ['SomeoneElse']);
    assert.equal(errors.length, 1);
    assert.match(errors[0].message, /unknown agent "MCPMidas"/);
});

test('cross check flags credentials referencing unknown agents', () => {
    assert.deepEqual(
        crossValidateCredentialAgents(validCredentialConfig(), ['MCPMidas']),
        []
    );
    const boundErrors = crossValidateCredentialAgents(validCredentialConfig(), ['SomeoneElse']);
    assert.equal(boundErrors.length, 1);
    assert.match(boundErrors[0].message, /unknown agent "MCPMidas"/);

    const unboundConfig = validCredentialConfig();
    unboundConfig.credentials[0].boundAgentId = null;
    unboundConfig.credentials[0].allowedAgents = ['Nexus', 'Ghost'];
    const allowedErrors = crossValidateCredentialAgents(unboundConfig, ['Nexus']);
    assert.equal(allowedErrors.length, 1);
    assert.match(allowedErrors[0].message, /unknown agent "Ghost"/);
});

test('cross check flags default diaries outside allowed diaries', () => {
    assert.deepEqual(crossValidateMemoryPolicyDiaries({
        agentId: 'MCPMidas',
        allowedDiaries: ['Midas'],
        defaultDiaries: ['Midas']
    }), []);
    const errors = crossValidateMemoryPolicyDiaries({
        agentId: 'MCPMidas',
        allowedDiaries: ['Midas'],
        defaultDiaries: ['Nexus']
    });
    assert.equal(errors.length, 1);
    assert.match(errors[0].message, /default diary "Nexus" is not in allowedDiaries/);
});

test('agentGuidanceResolver synthesizes integration snapshot from directory + guidance', () => {
    const resolver = createAgentGuidanceResolver({
        listAgents: () => [
            { alias: 'MCPMidas', sourceFile: 'MCPMidas.txt' },
            { alias: 'Nexus', sourceFile: 'Nexus.txt' }
        ],
        getGuidanceConfig: () => validateAgentGuidanceConfig(validGuidanceConfig()).config
    });

    const snapshot = resolver.buildIntegrationSnapshot();
    assert.equal(snapshot.agents.length, 1);
    const entry = snapshot.agents[0];
    assert.equal(entry.agentId, 'MCPMidas');
    assert.equal(entry.alias, 'MCPMidas');
    assert.equal(entry.displayName, 'Midas');
    assert.equal(entry.guidanceRef, 'MCPMidas');
    assert.equal(entry.memoryPolicyRef, 'MCPMidas');
    assert.equal(entry.recallProfileRef, 'MCPMidas');
    assert.ok(Object.isFrozen(snapshot));
    assert.ok(Object.isFrozen(entry));
    assert.deepEqual(snapshot.unknownAgents, []);

    assert.equal(resolver.resolveIntegrationEntry('MCPMidas').displayName, 'Midas');
    assert.equal(resolver.resolveIntegrationEntry('Nexus'), null);
    assert.equal(resolver.resolveIntegrationEntry(''), null);
});

test('agentGuidanceResolver reports guidance entries for unknown directory agents', () => {
    const resolver = createAgentGuidanceResolver({
        listAgents: () => [{ alias: 'Nexus', sourceFile: 'Nexus.txt' }],
        getGuidanceConfig: () => validateAgentGuidanceConfig(validGuidanceConfig()).config
    });
    const snapshot = resolver.buildIntegrationSnapshot();
    assert.deepEqual(snapshot.agents, []);
    assert.deepEqual(snapshot.unknownAgents, ['MCPMidas']);
});
