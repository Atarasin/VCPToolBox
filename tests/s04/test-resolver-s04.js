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
    });
});
