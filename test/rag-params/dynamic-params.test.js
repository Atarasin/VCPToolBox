const test = require('node:test');
const assert = require('node:assert/strict');
const ragPlugin = require('../../Plugin/RAGDiaryPlugin/RAGDiaryPlugin');

function setupPlugin(ragConfig) {
    ragPlugin.ragParams = { RAGDiaryPlugin: ragConfig };
    ragPlugin.vectorDBManager = {
        getEPAAnalysis: async () => ({ logicDepth: 0.7, resonance: 0.6 })
    };
    ragPlugin.contextVectorManager = {
        computeSemanticWidth: () => 0.4
    };
}

test('noise_penalty 调大后 tagWeight 应下降或不升', async () => {
    const queryVector = new Array(8).fill(0.1);

    setupPlugin({
        noise_penalty: 0.03,
        tagWeightRange: [0.05, 0.45],
        tagTruncationBase: 0.6,
        tagTruncationRange: [0.5, 0.9]
    });
    const lowPenalty = await ragPlugin._calculateDynamicParams(queryVector, '问题', '回答');

    setupPlugin({
        noise_penalty: 0.12,
        tagWeightRange: [0.05, 0.45],
        tagTruncationBase: 0.6,
        tagTruncationRange: [0.5, 0.9]
    });
    const highPenalty = await ragPlugin._calculateDynamicParams(queryVector, '问题', '回答');

    assert.ok(highPenalty.tagWeight <= lowPenalty.tagWeight);
});

test('tagWeight 必须落在 tagWeightRange 内', async () => {
    const queryVector = new Array(8).fill(0.1);
    setupPlugin({
        noise_penalty: 0.05,
        tagWeightRange: [0.08, 0.3],
        tagTruncationBase: 0.6,
        tagTruncationRange: [0.5, 0.9]
    });
    const result = await ragPlugin._calculateDynamicParams(queryVector, '问题', '回答');
    assert.ok(result.tagWeight >= 0.08);
    assert.ok(result.tagWeight <= 0.3);
});

test('tagTruncationRatio 必须被限制在 tagTruncationRange', async () => {
    const queryVector = new Array(8).fill(0.1);
    setupPlugin({
        noise_penalty: 0.05,
        tagWeightRange: [0.05, 0.45],
        tagTruncationBase: 0.95,
        tagTruncationRange: [0.45, 0.8]
    });
    const result = await ragPlugin._calculateDynamicParams(queryVector, '问题', '回答');
    assert.ok(result.tagTruncationRatio >= 0.45);
    assert.ok(result.tagTruncationRatio <= 0.8);
});
