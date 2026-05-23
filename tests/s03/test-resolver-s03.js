const { describe, it } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');
const os = require('os');

const { RecallProfileResolver } = require('../../modules/agentGateway/policy/recallProfileResolver');

function tmpPath(name) {
    return path.join(
        os.tmpdir(),
        `agent-gateway-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}-${name}`
    );
}

function writeTmp(name, payload) {
    const p = tmpPath(name);
    fs.writeFileSync(p, JSON.stringify(payload));
    return p;
}

describe('S03 — RecallProfileResolver new config fields', () => {
    describe('normalizeRule — deprecation warnings + dual field output', () => {
        it('legacy flat fields emit deprecation warnings and produce dual fields', () => {
            const warnings = [];
            const originalWarn = console.warn;
            console.warn = (...args) => warnings.push(args.join(' '));

            const p = writeTmp('tmp-deprecate-legacy.json', {
                agents: {
                    A: {
                        defaultProfile: 'p1',
                        profiles: {
                            p1: {
                                rules: [
                                    {
                                        type: 'rag',
                                        diaries: ['D1'],
                                        kMultiplier: 2.0,
                                        modifiers: { truncate: true }
                                    }
                                ]
                            }
                        }
                    }
                }
            });
            const r = new RecallProfileResolver({ configPath: p });
            const result = r.resolveForAgent('A', 'p1');

            console.warn = originalWarn;

            assert.ok(result.resolved);
            assert.strictEqual(result.rules[0].type, 'rag');
            assert.strictEqual(result.rules[0].baseMode, 'rag');
            assert.deepStrictEqual(result.rules[0].diaries, ['D1']);
            assert.deepStrictEqual(result.rules[0].targets.diaries, ['D1']);
            assert.strictEqual(result.rules[0].kMultiplier, 2.0);
            assert.strictEqual(result.rules[0].targets.kMultiplier, 2.0);

            assert.ok(warnings.some(w => w.includes('Deprecated: rule.type → use rule.baseMode')), 'type deprecation warning');
            assert.ok(warnings.some(w => w.includes('Deprecated: rule.diaries → use rule.targets.diaries')), 'diaries deprecation warning');
            assert.ok(warnings.some(w => w.includes('Deprecated: rule.kMultiplier → use rule.targets.kMultiplier')), 'kMultiplier deprecation warning');

            fs.unlinkSync(p);
        });

        it('structured config normalizes without emitting deprecation warnings', () => {
            const warnings = [];
            const originalWarn = console.warn;
            console.warn = (...args) => warnings.push(args.join(' '));

            const p = writeTmp('tmp-structured.json', {
                agents: {
                    A: {
                        defaultProfile: 'p1',
                        profiles: {
                            p1: {
                                rules: [
                                    {
                                        baseMode: 'rag',
                                        targets: { diaries: ['D1'], kMultiplier: 1.5 },
                                        modifiers: { truncate: true }
                                    }
                                ]
                            }
                        }
                    }
                }
            });
            const r = new RecallProfileResolver({ configPath: p });
            const result = r.resolveForAgent('A', 'p1');

            console.warn = originalWarn;

            assert.ok(result.resolved);
            assert.strictEqual(result.rules[0].type, 'rag');
            assert.strictEqual(result.rules[0].baseMode, 'rag');
            assert.deepStrictEqual(result.rules[0].diaries, ['D1']);
            assert.deepStrictEqual(result.rules[0].targets.diaries, ['D1']);
            assert.strictEqual(result.rules[0].kMultiplier, 1.5);
            assert.strictEqual(result.rules[0].targets.kMultiplier, 1.5);

            // Should have no new deprecation warnings from this test (flags already set from previous test)
            // But verify no *new* patterns appeared beyond the 3 already captured
            const structuredWarnings = warnings.filter(w =>
                w.includes('rule.baseMode') || w.includes('rule.targets.diaries') || w.includes('rule.targets.kMultiplier')
            );
            assert.strictEqual(structuredWarnings.length, 0, 'structured config should not trigger deprecation warnings');

            fs.unlinkSync(p);
        });
    });

    describe('normalizeRule — kMultiplier', () => {
        it('kMultiplier=2.0 is preserved', () => {
            const p = writeTmp('tmp-km-20.json', {
                agents: {
                    A: {
                        defaultProfile: 'p1',
                        profiles: {
                            p1: {
                                rules: [
                                    { type: 'rag', diaries: ['D1'], kMultiplier: 2.0 }
                                ]
                            }
                        }
                    }
                }
            });
            const r = new RecallProfileResolver({ configPath: p });
            const result = r.resolveForAgent('A', 'p1');
            assert.ok(result.resolved);
            assert.strictEqual(result.rules[0].kMultiplier, 2.0);
            fs.unlinkSync(p);
        });

        it('kMultiplier=0 (invalid, non-positive) defaults to 1.0', () => {
            const p = writeTmp('tmp-km-zero.json', {
                agents: {
                    A: {
                        defaultProfile: 'p1',
                        profiles: {
                            p1: {
                                rules: [
                                    { type: 'rag', diaries: ['D1'], kMultiplier: 0 }
                                ]
                            }
                        }
                    }
                }
            });
            const r = new RecallProfileResolver({ configPath: p });
            const result = r.resolveForAgent('A', 'p1');
            assert.ok(result.resolved);
            assert.strictEqual(result.rules[0].kMultiplier, 1.0);
            fs.unlinkSync(p);
        });

        it('kMultiplier="string" defaults to 1.0', () => {
            const p = writeTmp('tmp-km-string.json', {
                agents: {
                    A: {
                        defaultProfile: 'p1',
                        profiles: {
                            p1: {
                                rules: [
                                    { type: 'rag', diaries: ['D1'], kMultiplier: '2.0' }
                                ]
                            }
                        }
                    }
                }
            });
            const r = new RecallProfileResolver({ configPath: p });
            const result = r.resolveForAgent('A', 'p1');
            assert.ok(result.resolved);
            assert.strictEqual(result.rules[0].kMultiplier, 1.0);
            fs.unlinkSync(p);
        });

        it('kMultiplier=null defaults to 1.0', () => {
            const p = writeTmp('tmp-km-null.json', {
                agents: {
                    A: {
                        defaultProfile: 'p1',
                        profiles: {
                            p1: {
                                rules: [
                                    { type: 'rag', diaries: ['D1'], kMultiplier: null }
                                ]
                            }
                        }
                    }
                }
            });
            const r = new RecallProfileResolver({ configPath: p });
            const result = r.resolveForAgent('A', 'p1');
            assert.ok(result.resolved);
            assert.strictEqual(result.rules[0].kMultiplier, 1.0);
            fs.unlinkSync(p);
        });

        it('kMultiplier omitted defaults to 1.0', () => {
            const p = writeTmp('tmp-km-omit.json', {
                agents: {
                    A: {
                        defaultProfile: 'p1',
                        profiles: {
                            p1: {
                                rules: [
                                    { type: 'rag', diaries: ['t1'] }
                                ]
                            }
                        }
                    }
                }
            });
            const r = new RecallProfileResolver({ configPath: p });
            const result = r.resolveForAgent('A', 'p1');
            assert.ok(result.resolved);
            assert.strictEqual(result.rules[0].kMultiplier, 1.0);
            fs.unlinkSync(p);
        });
    });

    describe('normalizeRule — meta', () => {
        it('meta object is preserved', () => {
            const p = writeTmp('tmp-meta-obj.json', {
                agents: {
                    A: {
                        defaultProfile: 'p1',
                        profiles: {
                            p1: {
                                rules: [
                                    { type: 'rag', diaries: ['D1'], meta: { warnings: ['be careful'] } }
                                ]
                            }
                        }
                    }
                }
            });
            const r = new RecallProfileResolver({ configPath: p });
            const result = r.resolveForAgent('A', 'p1');
            assert.ok(result.resolved);
            assert.deepStrictEqual(result.rules[0].meta, { warnings: ['be careful'] });
            fs.unlinkSync(p);
        });

        it('meta="not-object" is omitted from rule', () => {
            const p = writeTmp('tmp-meta-bad.json', {
                agents: {
                    A: {
                        defaultProfile: 'p1',
                        profiles: {
                            p1: {
                                rules: [
                                    { type: 'rag', diaries: ['D1'], meta: 'not-object' }
                                ]
                            }
                        }
                    }
                }
            });
            const r = new RecallProfileResolver({ configPath: p });
            const result = r.resolveForAgent('A', 'p1');
            assert.ok(result.resolved);
            assert.strictEqual(result.rules[0].meta, undefined);
            fs.unlinkSync(p);
        });

        it('meta omitted is not in rule', () => {
            const p = writeTmp('tmp-meta-omit.json', {
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
            assert.strictEqual(result.rules[0].meta, undefined);
            fs.unlinkSync(p);
        });
    });

    describe('normalizeProfile — merge, aggregate, projection, metadata', () => {
        it('merge="deduplicate" is preserved', () => {
            const p = writeTmp('tmp-merge.json', {
                agents: {
                    A: {
                        defaultProfile: 'p1',
                        profiles: {
                            p1: {
                                merge: 'deduplicate',
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
            assert.strictEqual(result.merge, 'deduplicate');
            fs.unlinkSync(p);
        });

        it('merge omitted is not in profile result', () => {
            const p = writeTmp('tmp-merge-omit.json', {
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
            assert.strictEqual(result.merge, undefined);
            fs.unlinkSync(p);
        });

        it('aggregate="concat" is preserved', () => {
            const p = writeTmp('tmp-agg.json', {
                agents: {
                    A: {
                        defaultProfile: 'p1',
                        profiles: {
                            p1: {
                                aggregate: 'concat',
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
            assert.strictEqual(result.aggregate, 'concat');
            fs.unlinkSync(p);
        });

        it('aggregate omitted is not in profile result', () => {
            const p = writeTmp('tmp-agg-omit.json', {
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
            assert.strictEqual(result.aggregate, undefined);
            fs.unlinkSync(p);
        });

        it('projection="recallBlock" is preserved', () => {
            const p = writeTmp('tmp-proj.json', {
                agents: {
                    A: {
                        defaultProfile: 'p1',
                        profiles: {
                            p1: {
                                projection: 'recallBlock',
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
            assert.strictEqual(result.projection, 'recallBlock');
            fs.unlinkSync(p);
        });

        it('projection omitted is not in profile result', () => {
            const p = writeTmp('tmp-proj-omit.json', {
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
            assert.strictEqual(result.projection, undefined);
            fs.unlinkSync(p);
        });

        it('metadata object is preserved', () => {
            const p = writeTmp('tmp-metadata.json', {
                agents: {
                    A: {
                        defaultProfile: 'p1',
                        profiles: {
                            p1: {
                                metadata: { author: 'test', version: 1 },
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
            assert.deepStrictEqual(result.metadata, { author: 'test', version: 1 });
            fs.unlinkSync(p);
        });

        it('metadata omitted is not in profile result', () => {
            const p = writeTmp('tmp-metadata-omit.json', {
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
            assert.strictEqual(result.metadata, undefined);
            fs.unlinkSync(p);
        });

        it('aiMemo=true is preserved', () => {
            const p = writeTmp('tmp-aimemo-bool.json', {
                agents: {
                    A: {
                        defaultProfile: 'p1',
                        profiles: {
                            p1: {
                                aiMemo: true,
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
            assert.strictEqual(result.aiMemo, true);
            fs.unlinkSync(p);
        });

        it('aiMemo object with preset is preserved', () => {
            const p = writeTmp('tmp-aimemo-obj.json', {
                agents: {
                    A: {
                        defaultProfile: 'p1',
                        profiles: {
                            p1: {
                                aiMemo: { enabled: true, preset: 'concise' },
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
            assert.deepStrictEqual(result.aiMemo, { enabled: true, preset: 'concise' });
            fs.unlinkSync(p);
        });

        it('aiMemo omitted is not in profile result', () => {
            const p = writeTmp('tmp-aimemo-omit.json', {
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
            assert.strictEqual(result.aiMemo, undefined);
            fs.unlinkSync(p);
        });
    });

    describe('normalizeAgentEntry — allowedProfiles, targets', () => {
        it('allowedProfiles=["p1","p2"] is preserved', () => {
            const p = writeTmp('tmp-ap.json', {
                agents: {
                    A: {
                        defaultProfile: 'p1',
                        allowedProfiles: ['p1', 'p2'],
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
            assert.deepStrictEqual(result.allowedProfiles, ['p1', 'p2']);
            fs.unlinkSync(p);
        });

        it('allowedProfiles with empty strings is filtered out', () => {
            const p = writeTmp('tmp-ap-filter.json', {
                agents: {
                    A: {
                        defaultProfile: 'p1',
                        allowedProfiles: ['p1', '', '  ', 'p2'],
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
            assert.deepStrictEqual(result.allowedProfiles, ['p1', 'p2']);
            fs.unlinkSync(p);
        });

        it('allowedProfiles omitted is not in result', () => {
            const p = writeTmp('tmp-ap-omit.json', {
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
            assert.strictEqual(result.allowedProfiles, undefined);
            fs.unlinkSync(p);
        });

        it('targets=["t1"] is preserved', () => {
            const p = writeTmp('tmp-targets.json', {
                agents: {
                    A: {
                        defaultProfile: 'p1',
                        targets: ['t1'],
                        profiles: {
                            p1: {
                                rules: [
                                    { type: 'rag', diaries: ['t1'] }
                                ]
                            }
                        }
                    }
                }
            });
            const r = new RecallProfileResolver({ configPath: p });
            const result = r.resolveForAgent('A', 'p1');
            assert.ok(result.resolved);
            assert.deepStrictEqual(result.targets, ['t1']);
            fs.unlinkSync(p);
        });

        it('targets omitted is not in result', () => {
            const p = writeTmp('tmp-targets-omit.json', {
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
            assert.strictEqual(result.targets, undefined);
            fs.unlinkSync(p);
        });
    });

    describe('resolveForAgent — all new fields flow through', () => {
        it('all new fields appear in resolved result', () => {
            const p = writeTmp('tmp-all-fields.json', {
                agents: {
                    A: {
                        defaultProfile: 'p1',
                        allowedProfiles: ['p1', 'p2'],
                        targets: ['t1', 't2'],
                        profiles: {
                            p1: {
                                merge: 'deduplicate',
                                aggregate: 'concat',
                                projection: 'recallBlock',
                                metadata: { author: 'test' },
                                rules: [
                                    {
                                        type: 'rag',
                                        diaries: ['t1'],
                                        kMultiplier: 3.0,
                                        meta: { warnings: ['warn'] }
                                    }
                                ]
                            }
                        }
                    }
                }
            });
            const r = new RecallProfileResolver({ configPath: p });
            const result = r.resolveForAgent('A', 'p1');
            assert.ok(result.resolved);
            assert.strictEqual(result.merge, 'deduplicate');
            assert.strictEqual(result.aggregate, 'concat');
            assert.strictEqual(result.projection, 'recallBlock');
            assert.deepStrictEqual(result.metadata, { author: 'test' });
            assert.deepStrictEqual(result.allowedProfiles, ['p1', 'p2']);
            assert.deepStrictEqual(result.targets, ['t1', 't2']);
            assert.strictEqual(result.rules[0].kMultiplier, 3.0);
            assert.deepStrictEqual(result.rules[0].meta, { warnings: ['warn'] });
            fs.unlinkSync(p);
        });

        it('top-level profiles preserve S03 fields', () => {
            const p = writeTmp('tmp-top-level-fields.json', {
                agents: {
                    A: {
                        defaultProfile: 'p1',
                        allowedProfiles: ['p1'],
                        targets: ['t1']
                    }
                },
                profiles: {
                    p1: {
                        merge: 'deduplicate',
                        aggregate: 'concat',
                        projection: 'recallBlock',
                        metadata: { author: 'test' },
                        rules: [
                            {
                                type: 'rag',
                                diaries: ['t1'],
                                kMultiplier: 3.0,
                                meta: { warnings: ['warn'] }
                            }
                        ]
                    }
                }
            });
            const r = new RecallProfileResolver({ configPath: p });
            const result = r.resolveForAgent('A', 'p1');
            assert.ok(result.resolved);
            assert.strictEqual(result.merge, 'deduplicate');
            assert.strictEqual(result.aggregate, 'concat');
            assert.strictEqual(result.projection, 'recallBlock');
            assert.deepStrictEqual(result.metadata, { author: 'test' });
            assert.deepStrictEqual(result.allowedProfiles, ['p1']);
            assert.deepStrictEqual(result.targets, ['t1']);
            assert.strictEqual(result.rules[0].kMultiplier, 3.0);
            assert.deepStrictEqual(result.rules[0].meta, { warnings: ['warn'] });
            fs.unlinkSync(p);
        });

        it('missing fields do not appear in result', () => {
            const p = writeTmp('tmp-missing.json', {
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
            const keys = Object.keys(result);
            assert.deepStrictEqual(keys.sort(), ['agentId', 'profileName', 'resolved', 'rules']);
            const ruleKeys = Object.keys(result.rules[0]);
            assert.deepStrictEqual(ruleKeys.sort(), ['baseMode', 'diaries', 'gateThreshold', 'kMultiplier', 'modifiers', 'targets', 'type']);
            assert.deepStrictEqual(result.rules[0].targets, { diaries: ['D1'], kMultiplier: 1.0 });
            fs.unlinkSync(p);
        });

        it('unresolved:false result has no new fields', () => {
            const p = writeTmp('tmp-unresolved.json', {
                agents: {}
            });
            const r = new RecallProfileResolver({ configPath: p });
            const result = r.resolveForAgent('UnknownAgent', 'p1');
            assert.ok(!result.resolved);
            const keys = Object.keys(result);
            assert.deepStrictEqual(keys.sort(), ['agentId', 'code', 'profileName', 'resolved', 'rules']);
            fs.unlinkSync(p);
        });
    });

    describe('forward compatibility — config with no new fields', () => {
        it('result only has resolved, agentId, profileName, rules when no new fields present', () => {
            const p = writeTmp('tmp-fwd-compat.json', {
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
            const keys = Object.keys(result);
            assert.deepStrictEqual(keys.sort(), ['agentId', 'profileName', 'resolved', 'rules']);
            fs.unlinkSync(p);
        });
    });
});
