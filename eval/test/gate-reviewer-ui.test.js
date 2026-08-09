'use strict';

const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const test = require('node:test');

const reviewer = require('../gate-data/reviewer');

function template() {
    return [
        {
            recordType: 'review-meta', schemaVersion: 1, datasetId: 'gate-v1', datasetHash: 'sha256:test',
            scope: 'all', batch: { index: 0, count: 1 }, reviewerId: null, reviewedAt: null,
            attestation: null, requiredAttestation: reviewer.ATTESTATION
        },
        {
            recordType: 'gate-review', caseId: 'case-1', targetType: 'diary', library: 'EvalDiary',
            query: 'question', sourceRefs: ['doc'], difficulty: 'easy', candidateLabel: 'positive', label: null, notes: null
        }
    ];
}

test('offline reviewer requires an explicit label and exact human attestation', () => {
    const records = template();
    const parsed = reviewer.parseJsonl(`${records.map(record => JSON.stringify(record)).join('\n')}\n`);
    assert.deepEqual(reviewer.validateForExport(parsed.meta, parsed.rows, {}, 'human-a', reviewer.ATTESTATION), [
        'case-1: final label is required'
    ]);
    assert.throws(
        () => reviewer.buildJsonl(parsed.meta, parsed.rows, { 'case-1': { label: 'positive' } }, 'human-a', ''),
        /exact human attestation/u
    );
    const output = reviewer.buildJsonl(
        parsed.meta, parsed.rows, { 'case-1': { label: 'negative', notes: 'checked source' } },
        'human-a', reviewer.ATTESTATION, '2026-08-01T00:00:00.000Z'
    );
    const completed = reviewer.parseJsonl(output);
    assert.equal(completed.meta.attestation, reviewer.ATTESTATION);
    assert.equal(completed.rows[0].label, 'negative');
    assert.equal(completed.rows[0].notes, 'checked source');
});

test('reviewer page is self-contained and declares a no-network content policy', () => {
    const html = fs.readFileSync(path.resolve(__dirname, '../gate-data/reviewer.html'), 'utf8');
    assert.match(html, /default-src 'none'/u);
    assert.match(html, /connect-src 'none'/u);
    assert.doesNotMatch(html, /https?:\/\//u);
    assert.doesNotMatch(html, /value="I personally reviewed/u);
});
