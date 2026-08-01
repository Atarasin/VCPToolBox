'use strict';

const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');

const terminal = require('../gate-data/reviewer-terminal');

test('terminal reviewer parses explicit paths and never overwrites its input by default', () => {
    const flags = terminal.parseArgs(['--input', '/tmp/a.jsonl', '--reviewer', 'human-a']);
    assert.equal(flags.input, '/tmp/a.jsonl');
    assert.equal(flags.reviewer, 'human-a');
    assert.equal(terminal.defaultOutput(flags.input), '/tmp/a.reviewed.jsonl');
    assert.equal(terminal.defaultProgress(flags.input), '/tmp/a.jsonl.progress.json');
});

test('terminal reviewer progress is dataset-bound and keeps only valid case decisions', t => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vcp-terminal-review-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const progressPath = path.join(dir, 'progress.json');
    const meta = { datasetHash: 'sha256:dataset-a' };
    const rows = [{ caseId: 'a' }, { caseId: 'b' }];
    terminal.saveProgress(progressPath, meta, {
        a: { label: 'positive', notes: 'checked' },
        b: { label: 'invalid' },
        unknown: { label: 'negative' }
    }, 99);
    const restored = terminal.loadProgress(progressPath, meta, rows);
    assert.deepEqual(restored.decisions, { a: { label: 'positive', notes: 'checked' } });
    assert.equal(restored.index, 1);
    assert.throws(
        () => terminal.loadProgress(progressPath, { datasetHash: 'sha256:dataset-b' }, rows),
        /another dataset/u
    );
});
