const test = require('node:test');
const assert = require('node:assert/strict');
const ragPlugin = require('../../Plugin/RAGDiaryPlugin/RAGDiaryPlugin');

test('halfLifeDays 越小，旧记录衰减越强', () => {
    const input = [
        { text: '[2024-01-01] 历史记录A', score: 1, source: 'rag' },
        { text: '[2026-03-20] 最近记录B', score: 1, source: 'rag' }
    ];

    const longHalfLife = ragPlugin._applyTimeDecay(input, [null, '90', '0', ''], { halfLifeDays: 90, minScore: 0 });
    const shortHalfLife = ragPlugin._applyTimeDecay(input, [null, '15', '0', ''], { halfLifeDays: 90, minScore: 0 });

    const oldLong = longHalfLife.find(r => r.text.includes('历史记录A')).score;
    const oldShort = shortHalfLife.find(r => r.text.includes('历史记录A')).score;

    assert.ok(oldShort <= oldLong);
});

test('minScore 提高后返回条数应减少或不变', () => {
    const input = [
        { text: '[2024-01-01] 历史记录A', score: 1, source: 'rag' },
        { text: '[2025-12-01] 中间记录B', score: 0.8, source: 'rag' },
        { text: '[2026-03-20] 最近记录C', score: 0.6, source: 'rag' }
    ];

    const lowMin = ragPlugin._applyTimeDecay(input, [null, '30', '0.1', ''], { halfLifeDays: 30, minScore: 0.1 });
    const highMin = ragPlugin._applyTimeDecay(input, [null, '30', '0.7', ''], { halfLifeDays: 30, minScore: 0.7 });

    assert.ok(highMin.length <= lowMin.length);
});

test('time 来源结果应跳过衰减', () => {
    const input = [
        { text: '[2024-01-01] 时间路记录', score: 0.77, source: 'time' }
    ];
    const result = ragPlugin._applyTimeDecay(input, [null, '15', '0', ''], { halfLifeDays: 15, minScore: 0 });
    assert.equal(result[0].score, 0.77);
});
