const { describe, it, afterEach } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { WorkflowKernel } = require('../../../modules/workflowKernel/core/WorkflowKernel');
const { FileTraceSink } = require('../../../modules/workflowKernel/tracing/FileTraceSink');

describe('FileTraceSink', () => {
  let tempRoot = null;

  afterEach(() => {
    if (tempRoot) {
      fs.rmSync(tempRoot, { recursive: true, force: true });
      tempRoot = null;
    }
  });

  it('persists run status, last error, events, and step traces for a failed workflow', async () => {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'workflow-kernel-trace-'));

    const kernel = new WorkflowKernel({
      traceSink: new FileTraceSink({ traceRoot: tempRoot })
    });

    kernel.registerStepType('flaky', async () => ({
      status: 'failed',
      error: { message: 'trace failure' }
    }));

    const definition = {
      id: 'file-trace-failure',
      phases: [{ id: 'drafting', steps: [{ id: 'generateOutline', type: 'flaky' }] }]
    };

    const record = await kernel.execute('wf-file-trace', definition);
    assert.strictEqual(record.status, 'failed');

    const runDir = path.join(tempRoot, 'runs', 'wf-file-trace', record.runToken);
    const statusPath = path.join(runDir, 'status.json');
    const lastErrorPath = path.join(runDir, 'last-error.json');
    const eventsPath = path.join(runDir, 'events.jsonl');
    const stepsDir = path.join(runDir, 'steps');

    assert.ok(fs.existsSync(statusPath), 'status.json should be written');
    assert.ok(fs.existsSync(lastErrorPath), 'last-error.json should be written');
    assert.ok(fs.existsSync(eventsPath), 'events.jsonl should be written');
    assert.ok(fs.existsSync(stepsDir), 'steps directory should be created');

    const status = JSON.parse(fs.readFileSync(statusPath, 'utf8'));
    assert.strictEqual(status.workflowId, 'wf-file-trace');
    assert.strictEqual(status.state, 'failed');
    assert.strictEqual(status.currentPhaseId, 'drafting');
    assert.strictEqual(status.currentStepId, 'generateOutline');
    assert.ok(status.recentEvents.some(event => event.type === 'workflow.step_failed'));

    const lastError = JSON.parse(fs.readFileSync(lastErrorPath, 'utf8'));
    assert.strictEqual(lastError.workflowId, 'wf-file-trace');
    assert.strictEqual(lastError.stepId, 'generateOutline');
    assert.strictEqual(lastError.errorCode, 'STEP_EXECUTION_FAILED');
    assert.ok(lastError.errorMessage.includes('trace failure'));

    const eventLines = fs.readFileSync(eventsPath, 'utf8').trim().split('\n').filter(Boolean);
    assert.ok(eventLines.length >= 3, 'expected started/step_started/step_failed/failed events');
    const parsedEvents = eventLines.map(line => JSON.parse(line));
    const sequences = parsedEvents.map(event => event.sequence);
    assert.deepStrictEqual(sequences, [...sequences].sort((left, right) => left - right));
    assert.ok(parsedEvents.some(event => event.type === 'workflow.step_failed'));

    const stepFiles = fs.readdirSync(stepsDir);
    assert.strictEqual(stepFiles.length, 1);
    const stepTrace = JSON.parse(fs.readFileSync(path.join(stepsDir, stepFiles[0]), 'utf8'));
    assert.strictEqual(stepTrace.stepId, 'generateOutline');
    assert.strictEqual(stepTrace.phaseId, 'drafting');
    assert.strictEqual(stepTrace.status, 'failed');
    assert.ok(stepTrace.error);
    assert.strictEqual(stepTrace.error.errorCode, 'STEP_EXECUTION_FAILED');
  });
});
