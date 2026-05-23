const { describe, it } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');

const {
    ALLOWED_MODIFIERS_S01,
    ALLOWED_MODIFIERS,
    ALLOWED_RULE_TYPES,
    RecallProfileResolver
} = require('../../modules/agentGateway/policy/recallProfileResolver');

describe('S02 — RecallProfileResolver extensions', () => {
    describe('ALLOWED_RULE_TYPES', () => {
        it('includes full_text and gated_full_text', () => {
            assert.ok(ALLOWED_RULE_TYPES.has('rag'));
            assert.ok(ALLOWED_RULE_TYPES.has('gated_rag'));
            assert.ok(ALLOWED_RULE_TYPES.has('full_text'));
            assert.ok(ALLOWED_RULE_TYPES.has('gated_full_text'));
            assert.strictEqual(ALLOWED_RULE_TYPES.size, 4);
        });
    });

    describe('ALLOWED_MODIFIERS', () => {
        it('includes S01 modifiers', () => {
            for (const mod of ALLOWED_MODIFIERS_S01) {
                assert.ok(ALLOWED_MODIFIERS.has(mod), `should have ${mod}`);
            }
        });

        it('includes S02 modifiers', () => {
            assert.ok(ALLOWED_MODIFIERS.has('timeDecay'));
            assert.ok(ALLOWED_MODIFIERS.has('roleValve'));
            assert.ok(ALLOWED_MODIFIERS.has('base64Memo'));
        });

        it('has exactly 9 modifiers (S01 5 + S02 4)', () => {
            assert.strictEqual(ALLOWED_MODIFIERS.size, 9);
        });
    });

    describe('normalizeRule — full_text / gated_full_text', () => {
        it('accepts full_text rule', () => {
            const tmpPath = path.join(__dirname, 'tmp-profiles-fulltext.json');
            fs.writeFileSync(tmpPath, JSON.stringify({
                agents: {
                    TestAgent: {
                        defaultProfile: 'p1',
                        profiles: {
                            p1: {
                                rules: [
                                    { type: 'full_text', diaries: ['DiaryA'], modifiers: { timeDecay: { halfLifeDays: 7 } } }
                                ]
                            }
                        }
                    }
                }
            }));
            const r = new RecallProfileResolver({ configPath: tmpPath });
            const result = r.resolveForAgent('TestAgent', 'p1');
            assert.ok(result.resolved);
            assert.strictEqual(result.rules.length, 1);
            assert.strictEqual(result.rules[0].type, 'full_text');
            assert.deepStrictEqual(result.rules[0].diaries, ['DiaryA']);
            assert.deepStrictEqual(result.rules[0].modifiers, { timeDecay: { halfLifeDays: 7 } });
            fs.unlinkSync(tmpPath);
        });

        it('accepts gated_full_text rule with gateThreshold', () => {
            const tmpPath = path.join(__dirname, 'tmp-profiles-gatedft.json');
            fs.writeFileSync(tmpPath, JSON.stringify({
                agents: {
                    TestAgent: {
                        defaultProfile: 'p1',
                        profiles: {
                            p1: {
                                rules: [
                                    { type: 'gated_full_text', diaries: ['DiaryB'], gateThreshold: 0.4, modifiers: { roleValve: ['user', 'assistant'] } }
                                ]
                            }
                        }
                    }
                }
            }));
            const r = new RecallProfileResolver({ configPath: tmpPath });
            const result = r.resolveForAgent('TestAgent', 'p1');
            assert.ok(result.resolved);
            assert.strictEqual(result.rules[0].type, 'gated_full_text');
            assert.strictEqual(result.rules[0].gateThreshold, 0.4);
            assert.deepStrictEqual(result.rules[0].modifiers, { roleValve: ['user', 'assistant'] });
            fs.unlinkSync(tmpPath);
        });

        it('rejects unknown rule type', () => {
            const tmpPath = path.join(__dirname, 'tmp-profiles-bad.json');
            fs.writeFileSync(tmpPath, JSON.stringify({
                agents: {
                    TestAgent: {
                        defaultProfile: 'p1',
                        profiles: {
                            p1: {
                                rules: [
                                    { type: 'unknown_type', diaries: ['DiaryA'] }
                                ]
                            }
                        }
                    }
                }
            }));
            const r = new RecallProfileResolver({ configPath: tmpPath });
            const result = r.resolveForAgent('TestAgent', 'p1');
            assert.ok(!result.resolved); // no valid rules => profile invalid
            fs.unlinkSync(tmpPath);
        });

        it('accepts top-level full_text and gated_full_text profiles', () => {
            const tmpPath = path.join(__dirname, 'tmp-profiles-top-level.json');
            fs.writeFileSync(tmpPath, JSON.stringify({
                agents: {
                    TestAgent: {
                        defaultProfile: 'p1',
                        allowedProfiles: ['p1', 'p2']
                    }
                },
                profiles: {
                    p1: {
                        rules: [
                            { type: 'full_text', diaries: ['DiaryTop'], modifiers: { timeDecay: true } }
                        ]
                    },
                    p2: {
                        rules: [
                            { type: 'gated_full_text', diaries: ['DiaryGate'], gateThreshold: 0.4, modifiers: { roleValve: { expression: '@User>=1' } } }
                        ]
                    }
                }
            }));
            const r = new RecallProfileResolver({ configPath: tmpPath });
            const fullTextResult = r.resolveForAgent('TestAgent', 'p1');
            const gatedResult = r.resolveForAgent('TestAgent', 'p2');
            assert.ok(fullTextResult.resolved);
            assert.strictEqual(fullTextResult.rules[0].type, 'full_text');
            assert.deepStrictEqual(fullTextResult.rules[0].diaries, ['DiaryTop']);
            assert.ok(gatedResult.resolved);
            assert.strictEqual(gatedResult.rules[0].type, 'gated_full_text');
            assert.strictEqual(gatedResult.rules[0].gateThreshold, 0.4);
            fs.unlinkSync(tmpPath);
        });
    });

    describe('normalizeModifierEntry — filtering', () => {
        it('returns RECALL_INVALID_MODIFIER for unknown modifier keys', () => {
            const tmpPath = path.join(__dirname, 'tmp-profiles-filter.json');
            fs.writeFileSync(tmpPath, JSON.stringify({
                agents: {
                    TestAgent: {
                        defaultProfile: 'p1',
                        profiles: {
                            p1: {
                                rules: [
                                    {
                                        type: 'rag',
                                        diaries: ['DiaryA'],
                                        modifiers: {
                                            time: true,
                                            unknownMod: 'foo',
                                            timeDecay: { halfLifeDays: 3 },
                                            base64Memo: true
                                        }
                                    }
                                ]
                            }
                        }
                    }
                }
            }));
            const r = new RecallProfileResolver({ configPath: tmpPath });
            const result = r.resolveForAgent('TestAgent', 'p1');
            try {
                assert.strictEqual(result.resolved, false);
                assert.strictEqual(result.code, 'RECALL_INVALID_MODIFIER');
                assert.deepStrictEqual(result.details.invalidModifiers, ['unknownMod']);
                assert.strictEqual(result.details.ruleIndex, 0);
            } finally {
                fs.unlinkSync(tmpPath);
            }
        });
    });

    describe('validateModifiers — S02 awareness', () => {
        it('accepts all S02 modifiers', () => {
            const r = new RecallProfileResolver();
            const v = r.validateModifiers({
                time: true,
                group: false,
                rerank: true,
                tagMemo: false,
                truncate: 10,
                timeDecay: { halfLifeDays: 7 },
                roleValve: ['user'],
                base64Memo: true
            });
            assert.ok(v.valid);
            assert.deepStrictEqual(v.invalid, []);
        });

        it('reports invalid modifiers', () => {
            const r = new RecallProfileResolver();
            const v = r.validateModifiers({
                time: true,
                badModifier: 123
            });
            assert.ok(!v.valid);
            assert.deepStrictEqual(v.invalid, ['badModifier']);
        });
    });
});
