'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const TagMemoEngine = require('../../TagMemoEngine');

test('shutdown waits for a direct matrix rebuild before database teardown may continue', async () => {
    const engine = new TagMemoEngine({}, {}, {}, {}, null);
    engine._isMatrixRebuilding = true;
    const release = setTimeout(() => { engine._isMatrixRebuilding = false; }, 25);
    const startedAt = Date.now();
    await engine.shutdown({ timeoutMs: 1000 });
    clearTimeout(release);
    assert.equal(engine._isMatrixRebuilding, false);
    assert.ok(Date.now() - startedAt >= 20);
});
