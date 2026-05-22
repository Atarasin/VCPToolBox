const { describe, it } = require('node:test');
const assert = require('node:assert');

const {
    createRecallProjectionService,
    projectFullResult,
    projectFullTextSections
} = require('../../modules/agentGateway/services/recallProjectionService');

describe('RecallProjectionService S02 extensions', () => {
    describe('projectFullResult attachments', () => {
        it('includes empty attachments array when diagnostics has no attachments', () => {
            const recallResult = {
                items: [{ text: 'x', score: 0.5, sourceDiary: 'D' }],
                diagnostics: { totalDurationMs: 100, rules: [] }
            };
            const result = projectFullResult(recallResult, 'r1');
            assert.deepStrictEqual(result.attachments, []);
        });

        it('surfaces attachments from diagnostics.attachments', () => {
            const attachments = [
                { sourceDiary: 'DiaryA', sourceFile: 'img.png', content: 'data:image/png;base64,abc123' },
                { sourceDiary: 'DiaryB', sourceFile: 'doc.pdf', content: 'data:application/pdf;base64,xyz789' }
            ];
            const recallResult = {
                items: [{ text: 'x', score: 0.5, sourceDiary: 'D' }],
                diagnostics: {
                    totalDurationMs: 100,
                    rules: [],
                    attachments
                }
            };
            const result = projectFullResult(recallResult, 'r2');
            assert.strictEqual(result.attachments.length, 2);
            assert.strictEqual(result.attachments[0].sourceDiary, 'DiaryA');
            assert.strictEqual(result.attachments[1].content, 'data:application/pdf;base64,xyz789');
        });

        it('defaults attachments to empty array for null input', () => {
            const result = projectFullResult(null, 'r3');
            assert.deepStrictEqual(result.attachments, []);
        });

        it('defaults attachments to empty array for undefined input', () => {
            const result = projectFullResult(undefined, 'r4');
            assert.deepStrictEqual(result.attachments, []);
        });
    });

    describe('projectFullTextSections', () => {
        it('returns empty array for null input', () => {
            const result = projectFullTextSections(null);
            assert.deepStrictEqual(result, []);
        });

        it('returns empty array for undefined input', () => {
            const result = projectFullTextSections(undefined);
            assert.deepStrictEqual(result, []);
        });

        it('returns empty array when items is missing', () => {
            const result = projectFullTextSections({ success: true });
            assert.deepStrictEqual(result, []);
        });

        it('groups items by sourceDiary into sections', () => {
            const recallResult = {
                items: [
                    { text: 'Entry A1', score: 0.9, sourceDiary: 'DiaryA', sourceFile: 'a1.md', timestamp: '2024-01-01T00:00:00Z', tags: ['t1'] },
                    { text: 'Entry B1', score: 0.8, sourceDiary: 'DiaryB', sourceFile: 'b1.md' },
                    { text: 'Entry A2', score: 0.7, sourceDiary: 'DiaryA', sourceFile: 'a2.md' }
                ]
            };
            const result = projectFullTextSections(recallResult);
            assert.strictEqual(result.length, 2);

            const sectionA = result.find((s) => s.diaryName === 'DiaryA');
            const sectionB = result.find((s) => s.diaryName === 'DiaryB');
            assert.ok(sectionA);
            assert.ok(sectionB);
            assert.strictEqual(sectionA.entryCount, 2);
            assert.strictEqual(sectionB.entryCount, 1);
            assert.strictEqual(sectionA.entries[0].content, 'Entry A1');
            assert.strictEqual(sectionA.entries[1].content, 'Entry A2');
        });

        it('sorts entries within each section by score descending', () => {
            const recallResult = {
                items: [
                    { text: 'Low', score: 0.3, sourceDiary: 'DiaryA' },
                    { text: 'High', score: 0.9, sourceDiary: 'DiaryA' },
                    { text: 'Mid', score: 0.6, sourceDiary: 'DiaryA' }
                ]
            };
            const result = projectFullTextSections(recallResult);
            assert.strictEqual(result.length, 1);
            assert.deepStrictEqual(
                result[0].entries.map((e) => e.content),
                ['High', 'Mid', 'Low']
            );
        });

        it('sorts sections by combinedScore descending', () => {
            const recallResult = {
                items: [
                    { text: 'A1', score: 0.5, sourceDiary: 'DiaryA' },
                    { text: 'B1', score: 0.9, sourceDiary: 'DiaryB' },
                    { text: 'B2', score: 0.8, sourceDiary: 'DiaryB' }
                ]
            };
            const result = projectFullTextSections(recallResult);
            // DiaryB combinedScore = 1.7, DiaryA combinedScore = 0.5
            assert.strictEqual(result[0].diaryName, 'DiaryB');
            assert.strictEqual(result[1].diaryName, 'DiaryA');
            assert.ok(result[0].combinedScore > result[1].combinedScore);
        });

        it('assigns sequential sectionIds after sorting', () => {
            const recallResult = {
                items: [
                    { text: 'A1', score: 0.5, sourceDiary: 'DiaryA' },
                    { text: 'B1', score: 0.9, sourceDiary: 'DiaryB' }
                ]
            };
            const result = projectFullTextSections(recallResult);
            assert.strictEqual(result[0].sectionId, 'fts-0');
            assert.strictEqual(result[1].sectionId, 'fts-1');
        });

        it('uses "unknown" for items with missing sourceDiary', () => {
            const recallResult = {
                items: [
                    { text: 'No diary', score: 0.5 },
                    { text: 'Empty diary', score: 0.6, sourceDiary: '' },
                    { text: 'Has diary', score: 0.7, sourceDiary: 'DiaryA' }
                ]
            };
            const result = projectFullTextSections(recallResult);
            const unknownSection = result.find((s) => s.diaryName === 'unknown');
            assert.ok(unknownSection);
            assert.strictEqual(unknownSection.entryCount, 2);
        });

        it('normalizes malformed fields to safe defaults', () => {
            const recallResult = {
                items: [
                    { text: 12345, score: 'bad', sourceDiary: null, sourceFile: undefined, tags: 'not-array' }
                ]
            };
            const result = projectFullTextSections(recallResult);
            assert.strictEqual(result.length, 1);
            const entry = result[0].entries[0];
            assert.strictEqual(entry.content, '');
            assert.strictEqual(entry.score, 0);
            assert.strictEqual(entry.sourceFile, '');
            assert.strictEqual(entry.timestamp, null);
            assert.deepStrictEqual(entry.tags, []);
        });

        it('computes combinedScore as sum of entry scores', () => {
            const recallResult = {
                items: [
                    { text: 'E1', score: 0.8, sourceDiary: 'DiaryA' },
                    { text: 'E2', score: 0.6, sourceDiary: 'DiaryA' },
                    { text: 'E3', score: 0.3, sourceDiary: 'DiaryA' }
                ]
            };
            const result = projectFullTextSections(recallResult);
            assert.strictEqual(result[0].combinedScore, 1.7);
        });

        it('handles empty items array', () => {
            const result = projectFullTextSections({ items: [] });
            assert.deepStrictEqual(result, []);
        });

        it('handles items with only whitespace sourceDiary', () => {
            const recallResult = {
                items: [
                    { text: 'x', score: 0.5, sourceDiary: '   ' }
                ]
            };
            const result = projectFullTextSections(recallResult);
            assert.strictEqual(result[0].diaryName, 'unknown');
        });
    });

    describe('createRecallProjectionService factory S02', () => {
        it('includes projectFullTextSections in factory output', () => {
            const service = createRecallProjectionService();
            assert.strictEqual(typeof service.projectFullTextSections, 'function');
        });

        it('factory projectFullTextSections works end-to-end', () => {
            const service = createRecallProjectionService();
            const recallResult = {
                items: [
                    { text: 'A', score: 0.9, sourceDiary: 'D1' },
                    { text: 'B', score: 0.8, sourceDiary: 'D2' }
                ]
            };
            const sections = service.projectFullTextSections(recallResult);
            assert.strictEqual(sections.length, 2);
            assert.strictEqual(sections[0].sectionId, 'fts-0');
        });
    });
});
