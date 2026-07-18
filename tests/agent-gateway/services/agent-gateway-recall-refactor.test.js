const assert = require('node:assert/strict');
const test = require('node:test');

const legacyRuntime = require('../../../modules/agentGateway/services/recallRuntimeService');
const canonicalRuntime = require('../../../modules/agentGateway/core/recall/recallRuntimeService');
const legacyProjection = require('../../../modules/agentGateway/services/recallProjectionService');
const canonicalProjection = require('../../../modules/agentGateway/core/recall/recallProjectionService');
const pipeline = require('../../../modules/agentGateway/core/recall/pipeline');
const resolveProfile = require('../../../modules/agentGateway/core/recall/stages/resolveProfile');
const precomputeVector = require('../../../modules/agentGateway/core/recall/stages/precomputeVector');
const executeRules = require('../../../modules/agentGateway/core/recall/stages/executeRules');
const mergeResults = require('../../../modules/agentGateway/core/recall/stages/mergeResults');
const applyBudget = require('../../../modules/agentGateway/core/recall/stages/applyBudget');
const applyAiMemo = require('../../../modules/agentGateway/core/recall/stages/applyAiMemo');

test('legacy recall entrypoints preserve canonical export identity', () => {
    assert.deepEqual(Object.keys(legacyRuntime).sort(), Object.keys(canonicalRuntime).sort());
    assert.equal(legacyRuntime.createRecallRuntimeService, canonicalRuntime.createRecallRuntimeService);
    assert.deepEqual(Object.keys(legacyProjection).sort(), Object.keys(canonicalProjection).sort());
    assert.equal(legacyProjection.createRecallProjectionService, canonicalProjection.createRecallProjectionService);
});

test('recall pipeline exports the physical stage function identities', () => {
    assert.equal(pipeline.resolveProfileStage, resolveProfile.resolveProfileStage);
    assert.equal(pipeline.precomputeVectorStage, precomputeVector.precomputeVectorStage);
    assert.equal(pipeline.executeRulesStage, executeRules.executeRulesStage);
    assert.equal(pipeline.mergeResultsStage, mergeResults.mergeResultsStage);
    assert.equal(pipeline.applyBudgetStage, applyBudget.applyBudgetStage);
    assert.equal(pipeline.applyAiMemoStage, applyAiMemo.applyAiMemoStage);
});

test('recall rules continue to execute serially against one shared backend', async () => {
    let active = 0;
    let maximumActive = 0;
    const calls = [];
    const service = canonicalRuntime.createRecallRuntimeService({
        pluginManager: {},
        recallProfileResolver: {
            resolveForAgent() {
                return {
                    resolved: true,
                    profileName: 'serial',
                    rules: [0, 1, 2].map((index) => ({ type: 'rag', diaries: [`Diary${index}`] }))
                };
            }
        },
        async collectRagItems({ requestedDiaries }) {
            active += 1;
            maximumActive = Math.max(maximumActive, active);
            calls.push(`start:${requestedDiaries[0]}`);
            await new Promise((resolve) => setImmediate(resolve));
            calls.push(`end:${requestedDiaries[0]}`);
            active -= 1;
            return { success: true, items: [] };
        }
    });

    const result = await service.executeRecall({ agentId: 'agent', query: 'query' });
    assert.equal(result.success, true);
    assert.equal(maximumActive, 1);
    assert.deepEqual(calls, [
        'start:Diary0', 'end:Diary0',
        'start:Diary1', 'end:Diary1',
        'start:Diary2', 'end:Diary2'
    ]);
});
