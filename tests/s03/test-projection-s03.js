const { describe, it } = require('node:test');
const assert = require('node:assert');

const {
    projectSearchItems,
    projectContextBlocks
} = require('../../modules/agentGateway/services/recallProjectionService');

describe('RecallProjectionService S03 extensions', () => {
    describe('projectSearchItems', () => {
        it('returns empty array for null input', () => {
            assert.deepStrictEqual(projectSearchItems(null), []);
        });

        it('returns empty array for undefined input', () => {
            assert.deepStrictEqual(projectSearchItems(undefined), []);
        });

        it('returns empty array for non-array input', () => {
            assert.deepStrictEqual(projectSearchItems('not-array'), []);
        });

        it('normalizes raw items to search projection shape', () => {
            const rawItems = [
                { text: '  Hello World  ', score: 0.95, sourceDiary: 'DiaryA', sourceFile: 'a.md', timestamp: '2024-01-15T00:00:00Z', tags: ['t1', 't2'] },
                { text: 'Another entry', score: 0.82, sourceDiary: 'DiaryB', sourceFile: 'b.md', timestamp: null, tags: [] }
            ];
            const result = projectSearchItems(rawItems);
            assert.strictEqual(result.length, 2);
            assert.strictEqual(result[0].text, 'Hello World');
            assert.strictEqual(result[0].score, 0.95);
            assert.strictEqual(result[0].sourceDiary, 'DiaryA');
            assert.strictEqual(result[0].sourceFile, 'a.md');
            assert.strictEqual(result[0].timestamp, '2024-01-15T00:00:00Z');
            assert.deepStrictEqual(result[0].tags, ['t1', 't2']);
            assert.strictEqual(result[1].text, 'Another entry');
            assert.strictEqual(result[1].score, 0.82);
            assert.deepStrictEqual(result[1].tags, []);
        });

        it('handles missing fields gracefully', () => {
            const rawItems = [
                { text: 'Minimal' }
            ];
            const result = projectSearchItems(rawItems);
            assert.strictEqual(result[0].text, 'Minimal');
            assert.strictEqual(result[0].score, 0);
            assert.strictEqual(result[0].sourceDiary, '');
            assert.strictEqual(result[0].sourceFile, '');
            assert.strictEqual(result[0].timestamp, null);
            assert.deepStrictEqual(result[0].tags, []);
        });

        it('filters out invalid scores', () => {
            const rawItems = [
                { text: 'Valid', score: 0.5 },
                { text: 'NaN', score: NaN },
                { text: 'Infinity', score: Infinity },
                { text: 'String', score: 'high' }
            ];
            const result = projectSearchItems(rawItems);
            assert.strictEqual(result[0].score, 0.5);
            assert.strictEqual(result[1].score, 0);
            assert.strictEqual(result[2].score, 0);
            assert.strictEqual(result[3].score, 0);
        });

        it('normalizes tags as string array', () => {
            const rawItems = [
                { text: 'Tags', tags: ['  a  ', '', 'b', null, 123] }
            ];
            const result = projectSearchItems(rawItems);
            assert.deepStrictEqual(result[0].tags, ['a', 'b']);
        });
    });

    describe('projectContextBlocks', () => {
        it('returns empty array for null input', () => {
            assert.deepStrictEqual(projectContextBlocks(null), []);
        });

        it('returns empty array for undefined input', () => {
            assert.deepStrictEqual(projectContextBlocks(undefined), []);
        });

        it('normalizes raw items to context block shape with metadata', () => {
            const rawItems = [
                { text: 'Hello World', score: 0.95, sourceDiary: 'DiaryA', sourceFile: 'a.md', timestamp: '2024-01-15T00:00:00Z', tags: ['t1'] }
            ];
            const result = projectContextBlocks(rawItems);
            assert.strictEqual(result.length, 1);
            assert.strictEqual(result[0].text, 'Hello World');
            assert.strictEqual(result[0].metadata.score, 0.95);
            assert.strictEqual(result[0].metadata.sourceDiary, 'DiaryA');
            assert.strictEqual(result[0].metadata.sourceFile, 'a.md');
            assert.strictEqual(result[0].metadata.timestamp, '2024-01-15T00:00:00Z');
            assert.deepStrictEqual(result[0].metadata.tags, ['t1']);
            assert.strictEqual(typeof result[0].metadata.estimatedTokens, 'number');
            assert.ok(result[0].metadata.estimatedTokens > 0);
        });

        it('estimates tokens for CJK text', () => {
            const rawItems = [
                { text: '你好世界' }
            ];
            const result = projectContextBlocks(rawItems);
            assert.strictEqual(result[0].metadata.estimatedTokens, 4);
        });

        it('estimates tokens for mixed text', () => {
            const rawItems = [
                { text: 'Hello 你好' }
            ];
            const result = projectContextBlocks(rawItems);
            // 2 CJK chars + ceil(6 non-CJK / 4) = 2 + 2 = 4
            assert.strictEqual(result[0].metadata.estimatedTokens, 4);
        });

        it('handles empty text with zero tokens', () => {
            const rawItems = [
                { text: '   ' }
            ];
            const result = projectContextBlocks(rawItems);
            assert.strictEqual(result[0].text, '');
            assert.strictEqual(result[0].metadata.estimatedTokens, 0);
        });

        it('handles multiple items preserving order', () => {
            const rawItems = [
                { text: 'First', score: 0.9 },
                { text: 'Second', score: 0.8 },
                { text: 'Third', score: 0.7 }
            ];
            const result = projectContextBlocks(rawItems);
            assert.strictEqual(result.length, 3);
            assert.strictEqual(result[0].text, 'First');
            assert.strictEqual(result[1].text, 'Second');
            assert.strictEqual(result[2].text, 'Third');
        });
    });
});
