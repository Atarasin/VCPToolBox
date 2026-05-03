const fs = require('fs/promises');
const path = require('path');
const { WorkflowTraceSink } = require('./WorkflowTraceSink');

/**
 * FileTraceSink stores native observability artifacts in a run-scoped directory.
 */
class FileTraceSink extends WorkflowTraceSink {
  constructor({ traceRoot }) {
    super();
    if (!traceRoot) {
      throw new Error('FileTraceSink requires traceRoot');
    }
    this.traceRoot = traceRoot;
  }

  async onRunStarted(event) {
    await this._appendEvent(event);
  }

  async onStepStarted(event) {
    await this._appendEvent(event);
  }

  async onStepCompleted(event) {
    await this._appendEvent(event);
  }

  async onStepFailed(event) {
    await this._appendEvent(event);
  }

  async onCheckpointPending(event) {
    await this._appendEvent(event);
  }

  async onCheckpointResolved(event) {
    await this._appendEvent(event);
  }

  async onRunRecovered(event) {
    await this._appendEvent(event);
  }

  async onRunCompleted(event) {
    await this._appendEvent(event);
  }

  async onRunFailed(event) {
    await this._appendEvent(event);
  }

  async updateRunStatus(statusView) {
    const statusPath = await this._ensureRunFile(statusView.workflowId, statusView.runToken, 'status.json');
    await fs.writeFile(statusPath, `${JSON.stringify(statusView, null, 2)}\n`, 'utf8');
  }

  async writeLastError(lastErrorView) {
    if (!lastErrorView) {
      return;
    }
    const errorPath = await this._ensureRunFile(lastErrorView.workflowId, lastErrorView.runToken, 'last-error.json');
    await fs.writeFile(errorPath, `${JSON.stringify(lastErrorView, null, 2)}\n`, 'utf8');
  }

  async upsertStepTrace(stepTraceRecord) {
    const stepsDir = await this._ensureRunDir(stepTraceRecord.workflowId, stepTraceRecord.runToken, 'steps');
    const filename = `${String(stepTraceRecord.sequence).padStart(4, '0')}-${this._sanitize(stepTraceRecord.stepId)}.json`;
    await fs.writeFile(
      path.join(stepsDir, filename),
      `${JSON.stringify(stepTraceRecord, null, 2)}\n`,
      'utf8'
    );
  }

  async getRunStatus(workflowId, runToken) {
    const statusPath = await this._findRunFile(workflowId, runToken, 'status.json');
    if (!statusPath) {
      return null;
    }
    return this._readJson(statusPath, null);
  }

  async listRecentEvents(workflowId, runToken, limit = 20) {
    const eventsPath = await this._findRunFile(workflowId, runToken, 'events.jsonl');
    if (!eventsPath) {
      return [];
    }

    const content = await fs.readFile(eventsPath, 'utf8');
    const events = content
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line));

    return events.slice(-limit).map((event) => ({
      type: event.type,
      timestamp: event.timestamp,
      phaseId: event.phaseId,
      stepId: event.stepId,
      stepType: event.stepType,
      status: event.status,
      sequence: event.sequence
    }));
  }

  async getLastError(workflowId, runToken) {
    const errorPath = await this._findRunFile(workflowId, runToken, 'last-error.json');
    if (!errorPath) {
      return null;
    }
    return this._readJson(errorPath, null);
  }

  async _appendEvent(event) {
    const eventsPath = await this._ensureRunFile(event.workflowId, event.runToken, 'events.jsonl');
    await fs.appendFile(eventsPath, `${JSON.stringify(event)}\n`, 'utf8');
  }

  async _ensureRunFile(workflowId, runToken, filename) {
    const runDir = await this._ensureRunDir(workflowId, runToken);
    return path.join(runDir, filename);
  }

  async _ensureRunDir(workflowId, runToken, childPath = '') {
    const runDir = path.join(this.traceRoot, 'runs', workflowId, runToken, childPath);
    await fs.mkdir(runDir, { recursive: true });
    return runDir;
  }

  async _findRunFile(workflowId, runToken, filename) {
    const effectiveRunToken = runToken || await this._findLatestRunToken(workflowId);
    if (!effectiveRunToken) {
      return null;
    }

    const candidate = path.join(this.traceRoot, 'runs', workflowId, effectiveRunToken, filename);
    try {
      await fs.access(candidate);
      return candidate;
    } catch {
      return null;
    }
  }

  async _findLatestRunToken(workflowId) {
    const workflowDir = path.join(this.traceRoot, 'runs', workflowId);
    try {
      const entries = await fs.readdir(workflowDir, { withFileTypes: true });
      const runs = await Promise.all(entries
        .filter((entry) => entry.isDirectory())
        .map(async (entry) => {
          const fullPath = path.join(workflowDir, entry.name);
          const stat = await fs.stat(fullPath);
          return { runToken: entry.name, mtimeMs: stat.mtimeMs };
        }));

      runs.sort((left, right) => right.mtimeMs - left.mtimeMs);
      return runs[0]?.runToken || null;
    } catch {
      return null;
    }
  }

  async _readJson(filePath, fallback) {
    try {
      const content = await fs.readFile(filePath, 'utf8');
      return JSON.parse(content);
    } catch {
      return fallback;
    }
  }

  _sanitize(value) {
    return String(value || 'step').replace(/[^a-zA-Z0-9._-]/g, '_');
  }
}

module.exports = { FileTraceSink };
