const assert = require('node:assert');
const { describe, it } = require('node:test');

const {
    projectBudgetedContextBlocks,
    truncateTextByTokens,
    estimateTokenCount
} = require('../../../modules/agentGateway/services/recallProjectionService');

describe('truncateTextByTokens', () => {
    it('returns empty string for empty text', () => {
        assert.strictEqual(truncateTextByTokens('', 10), '');
        assert.strictEqual(truncateTextByTokens('   ', 10), '');
    });

    it('returns empty string for non-positive maxTokens', () => {
        assert.strictEqual(truncateTextByTokens('hello', 0), '');
        assert.strictEqual(truncateTextByTokens('hello', -1), '');
    });

    it('returns text unchanged when under token budget', () => {
        const text = 'hello world';
        assert.strictEqual(truncateTextByTokens(text, 100), text);
    });

    it('truncates ASCII text to fit token budget', () => {
        const text = 'hello world test';
        // 16 chars / 4 = 4 tokens
        // truncate to 2 tokens => 8 chars => 'hello wo'
        assert.strictEqual(truncateTextByTokens(text, 2), 'hello wo');
    });

    it('truncates CJK text correctly', () => {
        const text = '这是一个中文测试文本';
        // 10 CJK chars = 10 tokens
        const result = truncateTextByTokens(text, 5);
        assert.ok(result.length < text.length);
        assert.ok(estimateTokenCount(result) <= 5);
    });

    it('handles mixed CJK and ASCII', () => {
        const text = '中文abc中文def';
        // 4 CJK + 6 ASCII/4 = 4 + 2 = 6 tokens
        const result = truncateTextByTokens(text, 4);
        assert.ok(estimateTokenCount(result) <= 4);
    });
});

describe('projectBudgetedContextBlocks', () => {
    const makeItem = (text, score, sourceDiary = 'test', sourceFile = 'f.md') => ({
        text,
        score,
        sourceDiary,
        sourceFile,
        timestamp: Date.now(),
        tags: []
    });

    it('returns empty result for empty items', () => {
        const result = projectBudgetedContextBlocks([], { tokenBudget: 100, maxTokenRatio: 0.5, minScore: 0.2, maxBlocks: 10 });
        assert.deepStrictEqual(result.blocks, []);
        assert.strictEqual(result.consumedTokens, 0);
        assert.strictEqual(result.appliedPolicy.filteredByMinScore, 0);
        assert.strictEqual(result.appliedPolicy.truncatedCount, 0);
    });

    it('filters out items below minScore', () => {
        const items = [
            makeItem('high score item one', 0.9),
            makeItem('low score item', 0.1),
            makeItem('high score item two', 0.8)
        ];
        const result = projectBudgetedContextBlocks(items, {
            tokenBudget: 1000,
            maxTokenRatio: 1.0,
            minScore: 0.2,
            maxBlocks: 10
        });
        assert.strictEqual(result.blocks.length, 2);
        assert.strictEqual(result.appliedPolicy.filteredByMinScore, 1);
        assert.strictEqual(result.appliedPolicy.minScore, 0.2);
    });

    it('filters all items when all below minScore', () => {
        const items = [
            makeItem('one', 0.1),
            makeItem('two', 0.15)
        ];
        const result = projectBudgetedContextBlocks(items, {
            tokenBudget: 1000,
            maxTokenRatio: 1.0,
            minScore: 0.2,
            maxBlocks: 10
        });
        assert.strictEqual(result.blocks.length, 0);
        assert.strictEqual(result.appliedPolicy.filteredByMinScore, 2);
    });

    it('respects maxBlocks limit', () => {
        const items = [
            makeItem('item one', 0.9),
            makeItem('item two', 0.8),
            makeItem('item three', 0.7),
            makeItem('item four', 0.6)
        ];
        const result = projectBudgetedContextBlocks(items, {
            tokenBudget: 1000,
            maxTokenRatio: 1.0,
            minScore: 0.0,
            maxBlocks: 2
        });
        assert.strictEqual(result.blocks.length, 2);
        assert.strictEqual(result.appliedPolicy.maxBlocks, 2);
    });

    it('skips items that would exceed token budget', () => {
        const items = [
            makeItem('short', 0.9),
            makeItem('this is a much longer text that consumes more tokens than our tiny budget allows', 0.8)
        ];
        const result = projectBudgetedContextBlocks(items, {
            tokenBudget: 10,
            maxTokenRatio: 1.0,
            minScore: 0.0,
            maxBlocks: 10
        });
        // first item: 5 chars / 4 = 2 tokens, fits
        // second item: too many tokens, skipped (consumedTokens > 0 so skip condition applies)
        assert.strictEqual(result.blocks.length, 1);
        assert.strictEqual(result.blocks[0].text, 'short');
    });

    it('truncates a single oversized item and marks it truncated', () => {
        const longText = 'a'.repeat(200);
        const items = [makeItem(longText, 0.9)];
        const result = projectBudgetedContextBlocks(items, {
            tokenBudget: 10,
            maxTokenRatio: 1.0,
            minScore: 0.0,
            maxBlocks: 10
        });
        // maxInjectedTokens = 10, itemTokens = 200/4 = 50 > 10, so truncate to remainingTokens = 10
        assert.strictEqual(result.blocks.length, 1);
        assert.ok(result.blocks[0].metadata.truncated);
        assert.ok(result.blocks[0].text.length < longText.length);
        assert.strictEqual(result.appliedPolicy.truncatedCount, 1);
    });

    it('respects CJK token counting in budget', () => {
        const items = [
            makeItem('这是一个中文文本', 0.9),  // 8 CJK chars = 8 tokens
            makeItem('another', 0.8)            // 7 ASCII / 4 = 2 tokens
        ];
        const result = projectBudgetedContextBlocks(items, {
            tokenBudget: 8,
            maxTokenRatio: 1.0,
            minScore: 0.0,
            maxBlocks: 10
        });
        // First item: 8 tokens, fits exactly
        // Second item: consumedTokens=8, itemTokens=2, 8+2=10 > 8, skipped
        assert.strictEqual(result.blocks.length, 1);
        assert.strictEqual(result.blocks[0].text, '这是一个中文文本');
        assert.strictEqual(result.consumedTokens, 8);
    });

    it('returns appliedPolicy with all budget fields', () => {
        const items = [makeItem('test', 0.5)];
        const result = projectBudgetedContextBlocks(items, {
            tokenBudget: 100,
            maxTokenRatio: 0.7,
            minScore: 0.3,
            maxBlocks: 5
        });
        assert.strictEqual(result.appliedPolicy.tokenBudget, 100);
        assert.strictEqual(result.appliedPolicy.maxTokenRatio, 0.7);
        assert.strictEqual(result.appliedPolicy.maxInjectedTokens, 70);
        assert.strictEqual(result.appliedPolicy.maxBlocks, 5);
        assert.strictEqual(result.appliedPolicy.minScore, 0.3);
    });

    it('works with undefined options (pass-through)', () => {
        const items = [
            makeItem('one', 0.9),
            makeItem('two', 0.8)
        ];
        const result = projectBudgetedContextBlocks(items, {});
        assert.strictEqual(result.blocks.length, 2);
        assert.strictEqual(result.appliedPolicy.filteredByMinScore, 0);
        assert.strictEqual(result.appliedPolicy.truncatedCount, 0);
        assert.ok(!('tokenBudget' in result.appliedPolicy));
        assert.ok(!('maxTokenRatio' in result.appliedPolicy));
    });

    it('estimates tokens correctly for recall blocks', () => {
        const items = [makeItem('hello world', 0.9)];
        const result = projectBudgetedContextBlocks(items, {
            tokenBudget: 100,
            maxTokenRatio: 1.0,
            maxBlocks: 10
        });
        assert.strictEqual(result.blocks[0].metadata.estimatedTokens, 3); // 11 chars / 4 = 3
    });
});
