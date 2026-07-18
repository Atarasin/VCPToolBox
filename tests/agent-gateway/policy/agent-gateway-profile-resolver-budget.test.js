const assert = require('node:assert');
const { describe, it } = require('node:test');

const { RecallProfileResolver } = require('../../../modules/agentGateway/policy/recallProfileResolver');
const fixturePath = require('path').join(
    __dirname, '..', '..', 'fixtures', 'agent-gateway', 'recall_profiles.json'
);

describe('RecallProfileResolver budget fields', () => {
    const resolver = new RecallProfileResolver({
        configPath: fixturePath
    });

    it('resolves nexus-default with tokenBudget, maxTokenRatio, minScore', () => {
        const result = resolver.resolveForAgent('Nexus', 'nexus-default');
        assert.strictEqual(result.resolved, true);
        assert.strictEqual(result.tokenBudget, 1600);
        assert.strictEqual(result.maxTokenRatio, 0.7);
        assert.strictEqual(result.minScore, 0.2);
    });

    it('resolves aemeath-gated with tokenBudget, maxTokenRatio, minScore', () => {
        const result = resolver.resolveForAgent('Aemeath', 'aemeath-gated');
        assert.strictEqual(result.resolved, true);
        assert.strictEqual(result.tokenBudget, 1200);
        assert.strictEqual(result.maxTokenRatio, 0.6);
        assert.strictEqual(result.minScore, 0.35);
    });

    it('resolves aemeath-fulltext with tokenBudget, maxTokenRatio, minScore', () => {
        const result = resolver.resolveForAgent('Aemeath', 'aemeath-fulltext');
        assert.strictEqual(result.resolved, true);
        assert.strictEqual(result.tokenBudget, 2000);
        assert.strictEqual(result.maxTokenRatio, 0.8);
        assert.strictEqual(result.minScore, 0.1);
    });

    it('resolves aemeath-gated-fulltext with tokenBudget, maxTokenRatio, minScore', () => {
        const result = resolver.resolveForAgent('Aemeath', 'aemeath-gated-fulltext');
        assert.strictEqual(result.resolved, true);
        assert.strictEqual(result.tokenBudget, 1500);
        assert.strictEqual(result.maxTokenRatio, 0.7);
        assert.strictEqual(result.minScore, 0.35);
    });

    it('does not include budget fields when absent from profile', () => {
        // Create a resolver with an inline profile missing budget fields
        const fs = require('fs');
        const path = require('path');
        const tmpDir = require('os').tmpdir();
        const tmpPath = path.join(tmpDir, `test-no-budget-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`);
        fs.writeFileSync(tmpPath, JSON.stringify({
            agents: {
                TestAgent: { defaultProfile: 'no-budget' }
            },
            profiles: {
                'no-budget': {
                    rules: [{ type: 'rag', diaries: ['TestDiary'] }]
                }
            }
        }));
        try {
            const testResolver = new RecallProfileResolver({ configPath: tmpPath });
            const result = testResolver.resolveForAgent('TestAgent', 'no-budget');
            assert.strictEqual(result.resolved, true);
            assert.ok(!('tokenBudget' in result));
            assert.ok(!('maxTokenRatio' in result));
            assert.ok(!('minScore' in result));
        } finally {
            fs.unlinkSync(tmpPath);
        }
    });

    it('clamps maxTokenRatio to [0.1, 1.0]', () => {
        const fs = require('fs');
        const path = require('path');
        const tmpDir = require('os').tmpdir();
        const tmpPath = path.join(tmpDir, `test-clamp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`);
        fs.writeFileSync(tmpPath, JSON.stringify({
            agents: { TestAgent: { defaultProfile: 'clamp-test' } },
            profiles: {
                'clamp-test': {
                    maxTokenRatio: 2.0,
                    minScore: -0.5,
                    tokenBudget: 100.7,
                    rules: [{ type: 'rag', diaries: ['D'] }]
                }
            }
        }));
        try {
            const testResolver = new RecallProfileResolver({ configPath: tmpPath });
            const result = testResolver.resolveForAgent('TestAgent', 'clamp-test');
            assert.strictEqual(result.maxTokenRatio, 1.0);
            assert.strictEqual(result.minScore, 0);
            assert.strictEqual(result.tokenBudget, 100);
        } finally {
            fs.unlinkSync(tmpPath);
        }
    });
});

describe('RecallProfileResolver published example', () => {
    const exampleResolver = new RecallProfileResolver({
        configPath: require('path').join(
            __dirname, '..', '..', '..', 'modules', 'agentGateway', 'config', 'recall_profiles.json.example'
        )
    });

    for (const profileName of ['profile-name', 'gated-profile', 'full-text-profile']) {
        it(`keeps ${profileName} valid and selectable`, () => {
            const result = exampleResolver.resolveForAgent('AgentName', profileName);
            assert.strictEqual(result.resolved, true);
            assert.strictEqual(result.profileName, profileName);
            assert.ok(result.rules.length > 0);
        });
    }
});
