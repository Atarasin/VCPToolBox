/**
 * WorkflowTraceSink defines the native observability contract for workflow runs.
 * Concrete sinks can persist trace data to files, databases, or remote systems.
 */
class WorkflowTraceSink {
  async onRunStarted(_event) {}

  async onStepStarted(_event) {}

  async onStepCompleted(_event) {}

  async onStepFailed(_event) {}

  async onCheckpointPending(_event) {}

  async onCheckpointResolved(_event) {}

  async onRunRecovered(_event) {}

  async onRunCompleted(_event) {}

  async onRunFailed(_event) {}

  async updateRunStatus(_statusView) {}

  async writeLastError(_lastErrorView) {}

  async upsertStepTrace(_stepTraceRecord) {}

  async getRunStatus(_workflowId, _runToken) {
    return null;
  }

  async listRecentEvents(_workflowId, _runToken, _limit) {
    return [];
  }

  async getLastError(_workflowId, _runToken) {
    return null;
  }
}

module.exports = { WorkflowTraceSink };
