(function gateReviewerModule(root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.GateReviewer = api;
}(typeof globalThis === 'object' ? globalThis : this, function createGateReviewer() {
    'use strict';

    const ATTESTATION = 'I personally reviewed these gate labels against their source references.';
    const LABELS = new Set(['positive', 'negative', 'ambiguous']);

    function parseJsonl(text) {
        const records = String(text).split(/\r?\n/u).map(line => line.trim()).filter(Boolean).map((line, index) => {
            try { return JSON.parse(line); } catch (error) {
                throw new Error(`line ${index + 1}: ${error.message}`);
            }
        });
        const meta = records[0];
        if (meta?.recordType !== 'review-meta' || meta.schemaVersion !== 1) {
            throw new Error('review-meta schemaVersion 1 header is required');
        }
        const rows = records.slice(1);
        const ids = new Set();
        for (const row of rows) {
            if (row?.recordType !== 'gate-review' || !row.caseId) throw new Error('invalid gate-review row');
            if (ids.has(row.caseId)) throw new Error(`duplicate caseId: ${row.caseId}`);
            ids.add(row.caseId);
        }
        return { meta, rows };
    }

    function stateKey(meta) {
        return `vcp-gate-review:${meta.datasetHash}:${meta.scope}:${meta.batch?.index || 0}:${meta.batch?.count || 1}`;
    }

    function validateForExport(meta, rows, decisions, reviewerId, attestation) {
        const errors = [];
        if (!reviewerId || !String(reviewerId).trim()) errors.push('reviewerId is required');
        if (attestation !== ATTESTATION) errors.push('exact human attestation is required');
        for (const row of rows) {
            const decision = decisions[row.caseId];
            if (!decision || !LABELS.has(decision.label)) errors.push(`${row.caseId}: final label is required`);
        }
        return errors;
    }

    function buildJsonl(meta, rows, decisions, reviewerId, attestation, reviewedAt = new Date().toISOString()) {
        const errors = validateForExport(meta, rows, decisions, reviewerId, attestation);
        if (errors.length) throw new Error(errors.join('\n'));
        if (!reviewedAt || !Number.isFinite(Date.parse(reviewedAt))) throw new Error('reviewedAt must be an ISO timestamp');
        const header = {
            ...meta,
            reviewerId: String(reviewerId).trim(),
            reviewedAt,
            attestation,
            requiredAttestation: ATTESTATION
        };
        const output = [header, ...rows.map(row => ({
            ...row,
            label: decisions[row.caseId].label,
            notes: decisions[row.caseId].notes?.trim() || null
        }))];
        return `${output.map(record => JSON.stringify(record)).join('\n')}\n`;
    }

    function outputName(fileName) {
        const name = String(fileName || 'gate-review.jsonl');
        return name.replace(/(?:\.reviewed)?\.jsonl$/iu, '.reviewed.jsonl');
    }

    return { ATTESTATION, LABELS, parseJsonl, stateKey, validateForExport, buildJsonl, outputName };
}));
