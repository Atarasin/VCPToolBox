const test = require('node:test');
const assert = require('node:assert/strict');

const {
    warmupTagMemoArtifacts
// 上一版评测脚本已冻结到 eval/legacy/（原因见 eval/README.md）。
// 这个测试守的是 warmup / quiescence 逻辑本身，该逻辑已在 eval/lib/runtime.js 中复用，
// 保留对 legacy 实现的测试以确保迁移没有改变语义。
} = require('../../eval/legacy/real-run-eval');

test('TagMemo artifact 已就绪时直接通过 warmup', async () => {
    const knowledgeBaseManager = {
        getTagMemoV10ArtifactSnapshot() {
            return {
                bundle: {
                    artifactSig: 'artifact-ready',
                    nativeGeneration: 7
                }
            };
        },
        databaseCoordinator: {
            async waitForIdle() {}
        }
    };

    let probeCalls = 0;
    const ragPlugin = {
        async processMessages() {
            probeCalls++;
            return [];
        }
    };

    const result = await warmupTagMemoArtifacts({
        evalSet: [
            { id: 'case_tagmemo', mode: '[[Demo::TagMemo]]', query: 'warmup' }
        ],
        knowledgeBaseManager,
        ragPlugin,
        timeoutMs: 100,
        pollMs: 10
    });

    assert.equal(result.ready, true);
    assert.equal(result.warmupTriggered, false);
    assert.equal(result.artifactSig, 'artifact-ready');
    assert.equal(probeCalls, 0);
});

test('TagMemo artifact 缺失时会等待收敛并触发一次 warmup probe', async () => {
    const knowledgeBaseManager = {
        _artifact: null,
        pendingFiles: new Set(['bootstrap.txt']),
        pendingDeletes: new Set(),
        batchTimer: { active: true },
        deleteBatchTimer: null,
        isProcessing: false,
        isProcessingDeletes: false,
        externalMutationActive: false,
        rustWriteLease: null,
        indexRecoveryActive: false,
        dbHealthState: 'healthy',
        getTagMemoV10ArtifactSnapshot() {
            return { bundle: this._artifact };
        },
        databaseCoordinator: {
            async waitForIdle() {}
        }
    };

    setTimeout(() => {
        knowledgeBaseManager.pendingFiles.clear();
        knowledgeBaseManager.batchTimer = null;
    }, 20);

    let probeCalls = 0;
    const ragPlugin = {
        async processMessages() {
            probeCalls++;
            setTimeout(() => {
                knowledgeBaseManager._artifact = {
                    artifactSig: 'artifact-warmed',
                    nativeGeneration: 3
                };
            }, 10);
            return [];
        }
    };

    const result = await warmupTagMemoArtifacts({
        evalSet: [
            { id: 'case_tagmemo', mode: '[[Demo::TagMemo::Rerank]]', query: 'warmup' }
        ],
        knowledgeBaseManager,
        ragPlugin,
        timeoutMs: 300,
        pollMs: 10
    });

    assert.equal(result.ready, true);
    assert.equal(result.warmupTriggered, true);
    assert.equal(result.artifactSig, 'artifact-warmed');
    assert.equal(probeCalls, 1);
});
