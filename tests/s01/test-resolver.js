const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

const {
    RecallProfileResolver,
    ALLOWED_MODIFIERS_S01,
    ALLOWED_RULE_TYPES
} = require('../../modules/agentGateway/policy/recallProfileResolver');

function createTempConfig(payload) {
    const tmpFile = path.join(os.tmpdir(), `recall-profiles-test-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
    fs.writeFileSync(tmpFile, JSON.stringify(payload, null, 2), 'utf8');
    return tmpFile;
}

function cleanupTempConfig(tmpFile) {
    try {
        fs.unlinkSync(tmpFile);
    } catch {
        // ignore
    }
}

describe('RecallProfileResolver', () => {
    it('loads config and resolves default profile for Nexus', () => {
        const resolver = new RecallProfileResolver({
            configPath: path.join(__dirname, '../../modules/agentGateway/config/recall_profiles.json')
        });
        const result = resolver.resolveForAgent('Nexus');
        assert.strictEqual(result.resolved, true);
        assert.strictEqual(result.profileName, 'nexus-default');
        assert.strictEqual(result.rules.length, 1);
        assert.strictEqual(result.rules[0].type, 'rag');
        assert.deepStrictEqual(result.rules[0].diaries, ['Nexus日记本']);
        assert.strictEqual(result.rules[0].modifiers.time, true);
        assert.strictEqual(result.rules[0].modifiers.group, true);
        assert.strictEqual(result.rules[0].modifiers.rerank, true);
        assert.strictEqual(result.rules[0].modifiers.tagMemo, true);
        assert.strictEqual(result.rules[0].modifiers.truncate, true);
    });

    it('resolves explicit profile for Aemeath', () => {
        const resolver = new RecallProfileResolver({
            configPath: path.join(__dirname, '../../modules/agentGateway/config/recall_profiles.json')
        });
        const result = resolver.resolveForAgent('Aemeath', 'aemeath-gated');
        assert.strictEqual(result.resolved, true);
        assert.strictEqual(result.profileName, 'aemeath-gated');
        assert.strictEqual(result.rules.length, 1);
        assert.strictEqual(result.rules[0].type, 'gated_rag');
        assert.strictEqual(result.rules[0].gateThreshold, 0.35);
        assert.deepStrictEqual(result.rules[0].diaries, ['Aemeath日记本']);
    });

    it('rejects unknown profile name', () => {
        const tmpFile = createTempConfig({
            agents: {
                TestAgent: {
                    defaultProfile: 'default',
                    profiles: {
                        default: {
                            rules: [{ type: 'rag', diaries: ['Test'], modifiers: {} }]
                        }
                    }
                }
            }
        });
        try {
            const resolver = new RecallProfileResolver({ configPath: tmpFile });
            const result = resolver.resolveForAgent('TestAgent', 'nonexistent');
            assert.strictEqual(result.resolved, false);
            assert.strictEqual(result.code, 'RECALL_NO_PROFILE');
            assert.deepStrictEqual(result.availableProfiles, ['default']);
        } finally {
            cleanupTempConfig(tmpFile);
        }
    });

    it('rejects profile outside allowedProfiles with RECALL_FORBIDDEN', () => {
        const tmpFile = createTempConfig({
            agents: {
                TestAgent: {
                    defaultProfile: 'default',
                    allowedProfiles: ['default'],
                    profiles: {
                        default: {
                            rules: [{ type: 'rag', diaries: ['Test'], modifiers: {} }]
                        },
                        admin: {
                            rules: [{ type: 'rag', diaries: ['Secret'], modifiers: {} }]
                        }
                    }
                }
            }
        });
        try {
            const resolver = new RecallProfileResolver({ configPath: tmpFile });
            const result = resolver.resolveForAgent('TestAgent', 'admin');
            assert.strictEqual(result.resolved, false);
            assert.strictEqual(result.code, 'RECALL_FORBIDDEN');
            assert.deepStrictEqual(result.availableProfiles, ['default']);
        } finally {
            cleanupTempConfig(tmpFile);
        }
    });

    it('resolves profiles from top-level config map', () => {
        const tmpFile = createTempConfig({
            agents: {
                TestAgent: {
                    defaultProfile: 'default',
                    allowedProfiles: ['default'],
                    targets: ['SharedDiary']
                }
            },
            profiles: {
                default: {
                    merge: 'concat',
                    rules: [{ type: 'rag', diaries: ['SharedDiary'], modifiers: { time: true } }]
                }
            }
        });
        try {
            const resolver = new RecallProfileResolver({ configPath: tmpFile });
            const result = resolver.resolveForAgent('TestAgent');
            assert.strictEqual(result.resolved, true);
            assert.strictEqual(result.profileName, 'default');
            assert.strictEqual(result.merge, 'concat');
            assert.deepStrictEqual(result.targets, ['SharedDiary']);
            assert.deepStrictEqual(result.rules[0].diaries, ['SharedDiary']);
        } finally {
            cleanupTempConfig(tmpFile);
        }
    });

    it('prefers agent-local profiles over top-level profiles with the same name', () => {
        const tmpFile = createTempConfig({
            agents: {
                TestAgent: {
                    defaultProfile: 'shared',
                    profiles: {
                        shared: {
                            rules: [{ type: 'rag', diaries: ['AgentDiary'], modifiers: {} }]
                        }
                    }
                }
            },
            profiles: {
                shared: {
                    rules: [{ type: 'rag', diaries: ['GlobalDiary'], modifiers: {} }]
                }
            }
        });
        try {
            const resolver = new RecallProfileResolver({ configPath: tmpFile });
            const result = resolver.resolveForAgent('TestAgent');
            assert.strictEqual(result.resolved, true);
            assert.deepStrictEqual(result.rules[0].diaries, ['AgentDiary']);
        } finally {
            cleanupTempConfig(tmpFile);
        }
    });

    it('rejects unknown agent with RECALL_NO_PROFILE', () => {
        const tmpFile = createTempConfig({ agents: {} });
        try {
            const resolver = new RecallProfileResolver({ configPath: tmpFile });
            const result = resolver.resolveForAgent('GhostAgent');
            assert.strictEqual(result.resolved, false);
            assert.strictEqual(result.code, 'RECALL_NO_PROFILE');
            assert.deepStrictEqual(result.rules, []);
        } finally {
            cleanupTempConfig(tmpFile);
        }
    });

    it('validateDiaryAccess accepts allowed diaries', () => {
        const resolver = new RecallProfileResolver({});
        const result = resolver.validateDiaryAccess(['Nexus日记本', 'Aemeath日记本'], ['Nexus日记本', 'Aemeath日记本', 'Common']);
        assert.strictEqual(result.valid, true);
        assert.deepStrictEqual(result.forbidden, []);
    });

    it('validateDiaryAccess rejects unavailable diaries', () => {
        const resolver = new RecallProfileResolver({});
        const result = resolver.validateDiaryAccess(['Nexus日记本', 'Forbidden'], ['Nexus日记本', 'Aemeath日记本']);
        assert.strictEqual(result.valid, false);
        assert.deepStrictEqual(result.forbidden, ['Forbidden']);
    });

    it('validateDiaryAccess passes when no available diaries provided', () => {
        const resolver = new RecallProfileResolver({});
        const result = resolver.validateDiaryAccess(['AnyDiary'], []);
        assert.strictEqual(result.valid, true);
        assert.deepStrictEqual(result.forbidden, []);
    });

    it('validateModifiers accepts allowed S01 modifiers', () => {
        const resolver = new RecallProfileResolver({});
        const result = resolver.validateModifiers({
            time: true,
            group: true,
            rerank: false,
            tagMemo: true,
            truncate: true
        });
        assert.strictEqual(result.valid, true);
        assert.deepStrictEqual(result.invalid, []);
    });

    it('validateModifiers rejects unknown modifiers', () => {
        const resolver = new RecallProfileResolver({});
        const result = resolver.validateModifiers({
            time: true,
            unknownMod: true,
            anotherBad: false
        });
        assert.strictEqual(result.valid, false);
        assert.deepStrictEqual(result.invalid.sort(), ['anotherBad', 'unknownMod']);
    });

    it('falls back to wildcard agent entry', () => {
        const tmpFile = createTempConfig({
            agents: {
                '*': {
                    defaultProfile: 'fallback',
                    profiles: {
                        fallback: {
                            rules: [{ type: 'rag', diaries: ['Common'], modifiers: {} }]
                        }
                    }
                }
            }
        });
        try {
            const resolver = new RecallProfileResolver({ configPath: tmpFile });
            const result = resolver.resolveForAgent('AnyAgent');
            assert.strictEqual(result.resolved, true);
            assert.strictEqual(result.profileName, 'fallback');
            assert.strictEqual(result.rules[0].type, 'rag');
        } finally {
            cleanupTempConfig(tmpFile);
        }
    });

    it('resolves agent alias match', () => {
        const tmpFile = createTempConfig({
            agents: {
                core: {
                    defaultProfile: 'core',
                    profiles: {
                        core: {
                            rules: [{ type: 'rag', diaries: ['Core'], modifiers: {} }]
                        }
                    }
                }
            }
        });
        try {
            const resolver = new RecallProfileResolver({ configPath: tmpFile });
            // Exact match
            const result = resolver.resolveForAgent('core');
            assert.strictEqual(result.resolved, true);
            assert.strictEqual(result.profileName, 'core');

            // Alias from segmented agentId matching config key
            const aliasResult = resolver.resolveForAgent('nexus/core/alpha');
            assert.strictEqual(aliasResult.resolved, true);
            assert.strictEqual(aliasResult.profileName, 'core');
        } finally {
            cleanupTempConfig(tmpFile);
        }
    });

    it('defaultProfile falls back to first profile when omitted', () => {
        const tmpFile = createTempConfig({
            agents: {
                AgentX: {
                    profiles: {
                        alpha: {
                            rules: [{ type: 'rag', diaries: ['Alpha'], modifiers: {} }]
                        }
                    }
                }
            }
        });
        try {
            const resolver = new RecallProfileResolver({ configPath: tmpFile });
            const result = resolver.resolveForAgent('AgentX');
            assert.strictEqual(result.resolved, true);
            assert.strictEqual(result.profileName, 'alpha');
        } finally {
            cleanupTempConfig(tmpFile);
        }
    });

    it('returns RECALL_INVALID_RULE when any rule type is invalid', () => {
        const tmpFile = createTempConfig({
            agents: {
                AgentY: {
                    profiles: {
                        mixed: {
                            rules: [
                                { type: 'invalid_type', diaries: ['X'], modifiers: {} },
                                { type: 'rag', diaries: ['Y'], modifiers: {} }
                            ]
                        }
                    }
                }
            }
        });
        try {
            const resolver = new RecallProfileResolver({ configPath: tmpFile });
            const result = resolver.resolveForAgent('AgentY');
            assert.strictEqual(result.resolved, false);
            assert.strictEqual(result.code, 'RECALL_INVALID_RULE');
            assert.strictEqual(result.details.ruleIndex, 0);
            assert.strictEqual(result.details.ruleType, 'invalid_type');
        } finally {
            cleanupTempConfig(tmpFile);
        }
    });

    it('returns RECALL_INVALID_RULE when the only rule type is invalid', () => {
        const tmpFile = createTempConfig({
            agents: {
                AgentZ: {
                    defaultProfile: 'bad',
                    profiles: {
                        bad: {
                            rules: [
                                { type: 'invalid_type', diaries: ['X'], modifiers: {} }
                            ]
                        }
                    }
                }
            }
        });
        try {
            const resolver = new RecallProfileResolver({ configPath: tmpFile });
            const result = resolver.resolveForAgent('AgentZ');
            assert.strictEqual(result.resolved, false);
            assert.strictEqual(result.code, 'RECALL_INVALID_RULE');
            assert.strictEqual(result.details.ruleIndex, 0);
            assert.strictEqual(result.details.ruleType, 'invalid_type');
        } finally {
            cleanupTempConfig(tmpFile);
        }
    });

    it('exports expected constants', () => {
        assert.ok(ALLOWED_MODIFIERS_S01 instanceof Set);
        assert.ok(ALLOWED_MODIFIERS_S01.has('time'));
        assert.ok(ALLOWED_MODIFIERS_S01.has('truncate'));
        assert.ok(ALLOWED_RULE_TYPES instanceof Set);
        assert.ok(ALLOWED_RULE_TYPES.has('rag'));
        assert.ok(ALLOWED_RULE_TYPES.has('gated_rag'));
    });
});
