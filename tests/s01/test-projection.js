const { describe, it } = require('node:test');
const assert = require('node:assert');

const {
    createRecallProjectionService,
    projectItems,
    projectRecallBlocks,
    projectFullResult
} = require('../../modules/agentGateway/services/recallProjectionService');

describe('RecallProjectionService', () => {
    describe('projectItems', () => {
        it('returns empty array for null input', () => {
            const result = projectItems(null);
            assert.deepStrictEqual(result, []);
        });

        it('returns empty array for undefined input', () => {
            const result = projectItems(undefined);
            assert.deepStrictEqual(result, []);
        });

        it('returns empty array when items is missing', () => {
            const result = projectItems({ success: true });
            assert.deepStrictEqual(result, []);
        });

        it('projects complete items with all fields', () => {
            const recallResult = {
                items: [
                    {
                        text: 'Hello world',
                        score: 0.95,
                        sourceDiary: 'DiaryA',
                        sourceFile: 'file1.txt',
                        timestamp: '2024-01-01T00:00:00Z',
                        tags: ['tag1', 'tag2']
                    },
                    {
                        text: 'Second item',
                        score: 0.87,
                        sourceDiary: 'DiaryB',
                        sourceFile: 'file2.txt',
                        timestamp: null,
                        tags: []
                    }
                ]
            };
            const result = projectItems(recallResult);
            assert.strictEqual(result.length, 2);
            assert.strictEqual(result[0].content, 'Hello world');
            assert.strictEqual(result[0].score, 0.95);
            assert.strictEqual(result[0].sourceDiary, 'DiaryA');
            assert.strictEqual(result[0].sourceFile, 'file1.txt');
            assert.strictEqual(result[0].timestamp, '2024-01-01T00:00:00Z');
            assert.deepStrictEqual(result[0].tags, ['tag1', 'tag2']);

            assert.strictEqual(result[1].content, 'Second item');
            assert.strictEqual(result[1].score, 0.87);
            assert.strictEqual(result[1].sourceDiary, 'DiaryB');
            assert.strictEqual(result[1].timestamp, null);
            assert.deepStrictEqual(result[1].tags, []);
        });

        it('normalizes missing or malformed fields to safe defaults', () => {
            const recallResult = {
                items: [
                    {
                        text: 12345,
                        score: 'not-a-number',
                        sourceDiary: null,
                        sourceFile: undefined,
                        tags: 'not-an-array'
                    },
                    {}
                ]
            };
            const result = projectItems(recallResult);
            assert.strictEqual(result.length, 2);
            assert.strictEqual(result[0].content, '');
            assert.strictEqual(result[0].score, 0);
            assert.strictEqual(result[0].sourceDiary, '');
            assert.strictEqual(result[0].sourceFile, '');
            assert.strictEqual(result[0].timestamp, null);
            assert.deepStrictEqual(result[0].tags, []);

            assert.strictEqual(result[1].content, '');
            assert.strictEqual(result[1].score, 0);
        });

        it('trims whitespace from string fields', () => {
            const recallResult = {
                items: [
                    {
                        text: '  spaced  ',
                        sourceDiary: '  DiaryA  ',
                        sourceFile: '  file.txt  ',
                        score: 0.5,
                        tags: ['  a  ', '  b  ']
                    }
                ]
            };
            const result = projectItems(recallResult);
            assert.strictEqual(result[0].content, 'spaced');
            assert.strictEqual(result[0].sourceDiary, 'DiaryA');
            assert.strictEqual(result[0].sourceFile, 'file.txt');
            assert.deepStrictEqual(result[0].tags, ['a', 'b']);
        });

        it('filters out empty tags', () => {
            const recallResult = {
                items: [
                    {
                        text: 'x',
                        score: 0.5,
                        tags: ['a', '', '  ', 'b']
                    }
                ]
            };
            const result = projectItems(recallResult);
            assert.deepStrictEqual(result[0].tags, ['a', 'b']);
        });
    });

    describe('projectRecallBlocks', () => {
        it('returns empty array for null input', () => {
            const result = projectRecallBlocks(null);
            assert.deepStrictEqual(result, []);
        });

        it('returns empty array for undefined input', () => {
            const result = projectRecallBlocks(undefined);
            assert.deepStrictEqual(result, []);
        });

        it('returns empty array when items is missing', () => {
            const result = projectRecallBlocks({ success: true });
            assert.deepStrictEqual(result, []);
        });

        it('projects recallBlocks with correct structure', () => {
            const recallResult = {
                items: [
                    { text: 'Block one', score: 0.99, sourceDiary: 'DiaryA' },
                    { text: 'Block two', score: 0.88, sourceDiary: 'DiaryB' }
                ]
            };
            const result = projectRecallBlocks(recallResult);
            assert.strictEqual(result.length, 2);
            assert.strictEqual(result[0].blockId, 'rb-0');
            assert.strictEqual(result[0].content, 'Block one');
            assert.strictEqual(result[0].score, 0.99);
            assert.strictEqual(result[0].sourceDiary, 'DiaryA');

            assert.strictEqual(result[1].blockId, 'rb-1');
            assert.strictEqual(result[1].content, 'Block two');
            assert.strictEqual(result[1].score, 0.88);
            assert.strictEqual(result[1].sourceDiary, 'DiaryB');
        });

        it('handles missing or malformed fields with safe defaults', () => {
            const recallResult = {
                items: [
                    { text: null, score: NaN, sourceDiary: undefined },
                    {}
                ]
            };
            const result = projectRecallBlocks(recallResult);
            assert.strictEqual(result[0].blockId, 'rb-0');
            assert.strictEqual(result[0].content, '');
            assert.strictEqual(result[0].score, 0);
            assert.strictEqual(result[0].sourceDiary, '');

            assert.strictEqual(result[1].blockId, 'rb-1');
            assert.strictEqual(result[1].content, '');
            assert.strictEqual(result[1].score, 0);
            assert.strictEqual(result[1].sourceDiary, '');
        });

        it('assigns sequential blockIds', () => {
            const recallResult = {
                items: [
                    { text: 'a', score: 0.1, sourceDiary: 'D1' },
                    { text: 'b', score: 0.2, sourceDiary: 'D2' },
                    { text: 'c', score: 0.3, sourceDiary: 'D3' }
                ]
            };
            const result = projectRecallBlocks(recallResult);
            assert.deepStrictEqual(
                result.map((b) => b.blockId),
                ['rb-0', 'rb-1', 'rb-2']
            );
        });
    });

    describe('projectFullResult', () => {
        it('returns safe defaults for null input', () => {
            const result = projectFullResult(null);
            assert.strictEqual(result.success, true);
            assert.strictEqual(result.agentId, null);
            assert.strictEqual(result.profileName, null);
            assert.strictEqual(result.items.length, 0);
            assert.strictEqual(result.recallBlocks.length, 0);
            assert.deepStrictEqual(result.diagnostics, { totalDurationMs: 0, rules: [] });
            assert.strictEqual(result.error, null);
            assert.strictEqual(result.code, null);
            assert.strictEqual(result.status, 200);
            assert.ok(typeof result.requestId === 'string' && result.requestId.startsWith('req-'));
            assert.ok(typeof result.projectedAt === 'number' && result.projectedAt > 0);
        });

        it('returns safe defaults for undefined input', () => {
            const result = projectFullResult(undefined);
            assert.strictEqual(result.success, true);
            assert.deepStrictEqual(result.diagnostics, { totalDurationMs: 0, rules: [] });
            assert.strictEqual(result.status, 200);
        });

        it('preserves success=false and maps status correctly', () => {
            const recallResult = {
                success: false,
                agentId: 'agent-1',
                profileName: 'p1',
                items: [],
                diagnostics: { totalDurationMs: 100, rules: [] },
                error: 'Something failed',
                code: 'ERR_TEST',
                status: 500
            };
            const result = projectFullResult(recallResult, 'req-abc');
            assert.strictEqual(result.success, false);
            assert.strictEqual(result.agentId, 'agent-1');
            assert.strictEqual(result.profileName, 'p1');
            assert.strictEqual(result.error, 'Something failed');
            assert.strictEqual(result.code, 'ERR_TEST');
            assert.strictEqual(result.status, 500);
        });

        it('includes diagnostics from recallResult', () => {
            const diagnostics = {
                totalDurationMs: 250,
                rules: [
                    { ruleIndex: 0, type: 'rag', status: 'ok', durationMs: 120, itemCount: 3 }
                ],
                vectorPrecomputed: true
            };
            const recallResult = {
                items: [{ text: 'x', score: 0.5, sourceDiary: 'D' }],
                diagnostics
            };
            const result = projectFullResult(recallResult, 'req-xyz');
            assert.deepStrictEqual(result.diagnostics, diagnostics);
        });

        it('uses provided requestId', () => {
            const recallResult = { items: [] };
            const result = projectFullResult(recallResult, 'my-request-123');
            assert.strictEqual(result.requestId, 'my-request-123');
        });

        it('generates requestId when not provided', () => {
            const recallResult = { items: [] };
            const result = projectFullResult(recallResult);
            assert.ok(typeof result.requestId === 'string' && result.requestId.length > 0);
        });

        it('includes projectedAt timestamp', () => {
            const before = Date.now();
            const result = projectFullResult({ items: [] }, 'r1');
            const after = Date.now();
            assert.ok(result.projectedAt >= before && result.projectedAt <= after);
        });

        it('includes both items and recallBlocks arrays', () => {
            const recallResult = {
                items: [
                    { text: 'First', score: 0.9, sourceDiary: 'D1', sourceFile: 'f1.txt', timestamp: '2024-01-01T00:00:00Z', tags: ['t1'] },
                    { text: 'Second', score: 0.8, sourceDiary: 'D2', sourceFile: 'f2.txt', timestamp: null, tags: [] }
                ]
            };
            const result = projectFullResult(recallResult, 'r2');
            assert.strictEqual(result.items.length, 2);
            assert.strictEqual(result.recallBlocks.length, 2);
            assert.strictEqual(result.items[0].content, 'First');
            assert.strictEqual(result.recallBlocks[0].content, 'First');
            assert.strictEqual(result.recallBlocks[0].blockId, 'rb-0');
            assert.strictEqual(result.recallBlocks[1].blockId, 'rb-1');
        });

        it('handles empty items gracefully', () => {
            const recallResult = {
                success: true,
                agentId: 'agent-x',
                items: [],
                diagnostics: { totalDurationMs: 50, rules: [] }
            };
            const result = projectFullResult(recallResult, 'r3');
            assert.strictEqual(result.items.length, 0);
            assert.strictEqual(result.recallBlocks.length, 0);
            assert.strictEqual(result.success, true);
            assert.strictEqual(result.agentId, 'agent-x');
            assert.deepStrictEqual(result.diagnostics, { totalDurationMs: 50, rules: [] });
        });
    });

    describe('createRecallProjectionService factory', () => {
        it('returns an object with all three projection methods', () => {
            const service = createRecallProjectionService();
            assert.strictEqual(typeof service.projectItems, 'function');
            assert.strictEqual(typeof service.projectRecallBlocks, 'function');
            assert.strictEqual(typeof service.projectFullResult, 'function');
        });

        it('methods work correctly through the factory', () => {
            const service = createRecallProjectionService();
            const recallResult = {
                items: [
                    { text: 'Factory test', score: 0.77, sourceDiary: 'D' }
                ]
            };
            assert.strictEqual(service.projectItems(recallResult)[0].content, 'Factory test');
            assert.strictEqual(service.projectRecallBlocks(recallResult)[0].blockId, 'rb-0');
            assert.strictEqual(service.projectFullResult(recallResult, 'r').requestId, 'r');
        });
    });
});
