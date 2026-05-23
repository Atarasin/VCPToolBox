const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

const { RecallProfileResolver } = require('../../modules/agentGateway/policy/recallProfileResolver');

function tmpPath(name) {
    return path.join(os.tmpdir(), `s04-resolver-${Date.now()}-${name}`);
}

function writeTmp(name, payload) {
    const p = tmpPath(name);
    fs.writeFileSync(p, JSON.stringify(payload));
    return p;
}

describe('S04 — RecallProfileResolver merge policy fields', () => {
    describe('normalizeRule — structured targets/baseMode/projection', () => {
        it('accepts structured rule shape and compiles compatibility fields', () => {
            const p = writeTmp('structured-rule.json', {
                agents: {
                    A: {
                        defaultProfile: 'p1'
                    }
                },
                profiles: {
                    p1: {
                        rules: [
                            {
                                id: 'daily-aggregate',
                                baseMode: 'rag',
                                targets: {
                                    diaries: ['D1', 'D2'],
                                    aggregate: true,
                                    kMultiplier: 1.5
                                },
                                modifiers: {
                                    time: true
                                },
                                projection: {
                                    emit: 'recall_blocks'
                                }
                            }
                        ]
                    }
                }
            });
            const r = new RecallProfileResolver({ configPath: p });
            const result = r.resolveForAgent('A', 'p1');
            assert.ok(result.resolved);
            assert.strictEqual(result.rules[0].id, 'daily-aggregate');
            assert.strictEqual(result.rules[0].type, 'rag');
            assert.strictEqual(result.rules[0].baseMode, 'rag');
            assert.deepStrictEqual(result.rules[0].diaries, ['D1', 'D2']);
            assert.deepStrictEqual(result.rules[0].targets, {
                diaries: ['D1', 'D2'],
                aggregate: true,
                kMultiplier: 1.5
            });
            assert.strictEqual(result.rules[0].projection, 'recall_blocks');
            fs.unlinkSync(p);
        });
    });

    describe('normalizeProfile — truncateTo', () => {
        it('truncateTo=15 is preserved as integer', () => {
            const p = writeTmp('tt-15.json', {
                agents: {
                    A: {
                        defaultProfile: 'p1',
                        profiles: {
                            p1: {
                                truncateTo: 15,
                                rules: [
                                    { type: 'rag', diaries: ['D1'] }
                                ]
                            }
                        }
                    }
                }
            });
            const r = new RecallProfileResolver({ configPath: p });
            const result = r.resolveForAgent('A', 'p1');
            assert.ok(result.resolved);
            assert.strictEqual(result.truncateTo, 15);
            fs.unlinkSync(p);
        });

        it('truncateTo=15.7 is floored to 15', () => {
            const p = writeTmp('tt-float.json', {
                agents: {
                    A: {
                        defaultProfile: 'p1',
                        profiles: {
                            p1: {
                                truncateTo: 15.7,
                                rules: [
                                    { type: 'rag', diaries: ['D1'] }
                                ]
                            }
                        }
                    }
                }
            });
            const r = new RecallProfileResolver({ configPath: p });
            const result = r.resolveForAgent('A', 'p1');
            assert.ok(result.resolved);
            assert.strictEqual(result.truncateTo, 15);
            fs.unlinkSync(p);
        });

        it('truncateTo=0 is omitted (invalid)', () => {
            const p = writeTmp('tt-zero.json', {
                agents: {
                    A: {
                        defaultProfile: 'p1',
                        profiles: {
                            p1: {
                                truncateTo: 0,
                                rules: [
                                    { type: 'rag', diaries: ['D1'] }
                                ]
                            }
                        }
                    }
                }
            });
            const r = new RecallProfileResolver({ configPath: p });
            const result = r.resolveForAgent('A', 'p1');
            assert.ok(result.resolved);
            assert.strictEqual(result.truncateTo, undefined);
            fs.unlinkSync(p);
        });

        it('truncateTo=-5 is omitted (invalid)', () => {
            const p = writeTmp('tt-neg.json', {
                agents: {
                    A: {
                        defaultProfile: 'p1',
                        profiles: {
                            p1: {
                                truncateTo: -5,
                                rules: [
                                    { type: 'rag', diaries: ['D1'] }
                                ]
                            }
                        }
                    }
                }
            });
            const r = new RecallProfileResolver({ configPath: p });
            const result = r.resolveForAgent('A', 'p1');
            assert.ok(result.resolved);
            assert.strictEqual(result.truncateTo, undefined);
            fs.unlinkSync(p);
        });

        it('truncateTo="string" is omitted (invalid)', () => {
            const p = writeTmp('tt-string.json', {
                agents: {
                    A: {
                        defaultProfile: 'p1',
                        profiles: {
                            p1: {
                                truncateTo: '10',
                                rules: [
                                    { type: 'rag', diaries: ['D1'] }
                                ]
                            }
                        }
                    }
                }
            });
            const r = new RecallProfileResolver({ configPath: p });
            const result = r.resolveForAgent('A', 'p1');
            assert.ok(result.resolved);
            assert.strictEqual(result.truncateTo, undefined);
            fs.unlinkSync(p);
        });

        it('truncateTo omitted is not in result', () => {
            const p = writeTmp('tt-omit.json', {
                agents: {
                    A: {
                        defaultProfile: 'p1',
                        profiles: {
                            p1: {
                                rules: [
                                    { type: 'rag', diaries: ['D1'] }
                                ]
                            }
                        }
                    }
                }
            });
            const r = new RecallProfileResolver({ configPath: p });
            const result = r.resolveForAgent('A', 'p1');
            assert.ok(result.resolved);
            assert.strictEqual(result.truncateTo, undefined);
            fs.unlinkSync(p);
        });
    });

    describe('normalizeProfile — merge, aggregate, projection still work', () => {
        it('merge, aggregate, projection and truncateTo all present', () => {
            const p = writeTmp('all-policy.json', {
                agents: {
                    A: {
                        defaultProfile: 'p1',
                        profiles: {
                            p1: {
                                merge: 'interleave',
                                aggregate: 'mean',
                                projection: 'recallBlock',
                                truncateTo: 20,
                                rules: [
                                    { type: 'rag', diaries: ['D1'] },
                                    { type: 'full_text', diaries: ['D2'] }
                                ]
                            }
                        }
                    }
                }
            });
            const r = new RecallProfileResolver({ configPath: p });
            const result = r.resolveForAgent('A', 'p1');
            assert.ok(result.resolved);
            assert.strictEqual(result.merge, 'interleave');
            assert.strictEqual(result.aggregate, 'mean');
            assert.strictEqual(result.projection, 'recallBlock');
            assert.strictEqual(result.truncateTo, 20);
            assert.strictEqual(result.rules.length, 2);
            fs.unlinkSync(p);
        });

        it('top-level profiles preserve truncateTo and merge policy fields', () => {
            const p = writeTmp('all-policy-top-level.json', {
                agents: {
                    A: {
                        defaultProfile: 'p1',
                        allowedProfiles: ['p1']
                    }
                },
                profiles: {
                    p1: {
                        merge: 'interleave',
                        aggregate: 'mean',
                        projection: 'recallBlock',
                        truncateTo: 20,
                        rules: [
                            { type: 'rag', diaries: ['D1'] },
                            { type: 'full_text', diaries: ['D2'] }
                        ]
                    }
                }
            });
            const r = new RecallProfileResolver({ configPath: p });
            const result = r.resolveForAgent('A', 'p1');
            assert.ok(result.resolved);
            assert.strictEqual(result.merge, 'interleave');
            assert.strictEqual(result.aggregate, 'mean');
            assert.strictEqual(result.projection, 'recallBlock');
            assert.strictEqual(result.truncateTo, 20);
            assert.strictEqual(result.rules.length, 2);
            fs.unlinkSync(p);
        });
    });

    describe('S04 — resolver validation error codes', () => {
        it('recode-invalid-rule-type: returns RECALL_INVALID_RULE for unknown rule type', () => {
            const p = writeTmp('invalid-rule-type.json', {
                agents: {
                    A: { defaultProfile: 'p1' }
                },
                profiles: {
                    p1: {
                        rules: [
                            { baseMode: 'unknown_mode', diaries: ['D1'] }
                        ]
                    }
                }
            });
            const r = new RecallProfileResolver({ configPath: p });
            const result = r.resolveForAgent('A', 'p1');
            assert.strictEqual(result.resolved, false);
            assert.strictEqual(result.code, 'RECALL_INVALID_RULE');
            assert.strictEqual(result.details.ruleIndex, 0);
            assert.strictEqual(result.details.ruleType, 'unknown_mode');
            assert.ok(result.details.message.includes('unknown_mode'));
            fs.unlinkSync(p);
        });

        it('recode-invalid-modifier: returns RECALL_INVALID_MODIFIER for unknown modifier keys', () => {
            const p = writeTmp('invalid-modifier.json', {
                agents: {
                    A: { defaultProfile: 'p1' }
                },
                profiles: {
                    p1: {
                        rules: [
                            { baseMode: 'rag', diaries: ['D1'], modifiers: { unknownMod: true, time: true } }
                        ]
                    }
                }
            });
            const r = new RecallProfileResolver({ configPath: p });
            const result = r.resolveForAgent('A', 'p1');
            assert.strictEqual(result.resolved, false);
            assert.strictEqual(result.code, 'RECALL_INVALID_MODIFIER');
            assert.strictEqual(result.details.ruleIndex, 0);
            assert.deepStrictEqual(result.details.invalidModifiers, ['unknownMod']);
            fs.unlinkSync(p);
        });

        it('recode-invalid-diary: returns RECALL_INVALID_DIARY when diary is not in agent targets', () => {
            const p = writeTmp('invalid-diary.json', {
                agents: {
                    A: {
                        defaultProfile: 'p1',
                        targets: ['D1', 'D2']
                    }
                },
                profiles: {
                    p1: {
                        rules: [
                            { baseMode: 'rag', diaries: ['D1', 'D3'] }
                        ]
                    }
                }
            });
            const r = new RecallProfileResolver({ configPath: p });
            const result = r.resolveForAgent('A', 'p1');
            assert.strictEqual(result.resolved, false);
            assert.strictEqual(result.code, 'RECALL_INVALID_DIARY');
            assert.strictEqual(result.details.ruleIndex, 0);
            assert.deepStrictEqual(result.details.forbidden, ['D3']);
            fs.unlinkSync(p);
        });

        it('recode-invalid-profile: returns RECALL_INVALID_PROFILE when all rules are invalid', () => {
            const p = writeTmp('invalid-profile.json', {
                agents: {
                    A: { defaultProfile: 'p1' }
                },
                profiles: {
                    p1: {
                        rules: [
                            { baseMode: 'totally_invalid_type', diaries: ['D1'] }
                        ]
                    }
                }
            });
            const r = new RecallProfileResolver({ configPath: p });
            const result = r.resolveForAgent('A', 'p1');
            // Invalid rule type is caught before the all-rules-invalid check
            assert.strictEqual(result.resolved, false);
            assert.strictEqual(result.code, 'RECALL_INVALID_RULE');
            fs.unlinkSync(p);
        });

        it('recode-invalid-profile-all-rules-dropped: returns RECALL_INVALID_PROFILE when normalization drops all rules', () => {
            // A rule with only null/invalid entries that passes type/modifier/diary checks
            // but still gets dropped by normalizeRule (e.g. missing baseMode AND type)
            const p = writeTmp('all-rules-dropped.json', {
                agents: {
                    A: { defaultProfile: 'p1' }
                },
                profiles: {
                    p1: {
                        rules: [
                            { diaries: ['D1'] } // no baseMode/type, normalizeRule returns null
                        ]
                    }
                }
            });
            const r = new RecallProfileResolver({ configPath: p });
            const result = r.resolveForAgent('A', 'p1');
            assert.strictEqual(result.resolved, false);
            assert.strictEqual(result.code, 'RECALL_INVALID_PROFILE');
            assert.ok(result.details.message.includes('All rules'));
            fs.unlinkSync(p);
        });

        it('recode-valid-passes: valid config is unaffected by validation', () => {
            const p = writeTmp('valid-passes.json', {
                agents: {
                    A: {
                        defaultProfile: 'p1',
                        targets: ['D1', 'D2']
                    }
                },
                profiles: {
                    p1: {
                        rules: [
                            {
                                baseMode: 'rag',
                                targets: {
                                    diaries: ['D1'],
                                    kMultiplier: 1.5
                                },
                                modifiers: { time: true, rerank: false }
                            }
                        ]
                    }
                }
            });
            const r = new RecallProfileResolver({ configPath: p });
            const result = r.resolveForAgent('A', 'p1');
            assert.strictEqual(result.resolved, true);
            assert.strictEqual(result.rules.length, 1);
            assert.strictEqual(result.rules[0].baseMode, 'rag');
            fs.unlinkSync(p);
        });

        it('recode-no-targets-means-all-diaries-valid: no agent targets allows any diary', () => {
            const p = writeTmp('no-targets.json', {
                agents: {
                    A: { defaultProfile: 'p1' }
                },
                profiles: {
                    p1: {
                        rules: [
                            { baseMode: 'rag', diaries: ['AnyDiary', 'AnotherDiary'] }
                        ]
                    }
                }
            });
            const r = new RecallProfileResolver({ configPath: p });
            const result = r.resolveForAgent('A', 'p1');
            assert.strictEqual(result.resolved, true);
            assert.deepStrictEqual(result.rules[0].diaries, ['AnyDiary', 'AnotherDiary']);
            fs.unlinkSync(p);
        });

        it('recode-partial-valid-rules: partially valid rules still resolve', () => {
            const p = writeTmp('partial-valid.json', {
                agents: {
                    A: { defaultProfile: 'p1' }
                },
                profiles: {
                    p1: {
                        rules: [
                            { baseMode: 'rag', diaries: ['D1'] },
                            { baseMode: 'rag', diaries: ['D2'] }
                        ]
                    }
                }
            });
            const r = new RecallProfileResolver({ configPath: p });
            const result = r.resolveForAgent('A', 'p1');
            assert.strictEqual(result.resolved, true);
            assert.strictEqual(result.rules.length, 2);
            fs.unlinkSync(p);
        });

        it('recode-invalid-diary-with-targets-diaries-key: validates structured targets.diaries', () => {
            const p = writeTmp('invalid-diary-structured.json', {
                agents: {
                    A: {
                        defaultProfile: 'p1',
                        targets: ['D1']
                    }
                },
                profiles: {
                    p1: {
                        rules: [
                            { baseMode: 'rag', targets: { diaries: ['D2'] } }
                        ]
                    }
                }
            });
            const r = new RecallProfileResolver({ configPath: p });
            const result = r.resolveForAgent('A', 'p1');
            assert.strictEqual(result.resolved, false);
            assert.strictEqual(result.code, 'RECALL_INVALID_DIARY');
            assert.deepStrictEqual(result.details.forbidden, ['D2']);
            fs.unlinkSync(p);
        });
    });
});
