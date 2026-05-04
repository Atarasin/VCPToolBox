'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert');

const { StoryOrchestratorKernelAdapter } = require('../adapters/StoryOrchestratorKernelAdapter');

function createAdapter() {
  return new StoryOrchestratorKernelAdapter({
    stateManager: {
      repository: {
        getStory: () => null,
        updateStory: () => null,
        createSnapshot: () => 'snap-1',
        getLatestApprovedSnapshot: () => null
      }
    },
    agentDispatcher: { delegate: async () => ({ content: '{}', markers: [], raw: {} }) },
    chapterOperations: {},
    contentValidator: {},
    config: { USE_WORKFLOW_KERNEL: 'true' }
  });
}

describe('StoryOrchestratorKernelAdapter seam inventory', () => {
  it('reports long-term bridge seams and transitional residue explicitly after initialization', async () => {
    const adapter = createAdapter();
    await adapter.initialize();

    const report = adapter.getAdapterSeamReport();
    const controlPlane = adapter.getAdapterSeam('kernel-control-plane');
    const compatibilityBridge = adapter.getAdapterSeam('compatibility-event-bridge');
    const projectionBridge = adapter.getAdapterSeam('business-projection-bridge');

    assert.ok(Array.isArray(report));
    assert.strictEqual(report.length, 6);
    assert.ok(controlPlane);
    assert.strictEqual(controlPlane.state, 'long-term-bridge');
    assert.strictEqual(controlPlane.installed, true);
    assert.strictEqual(compatibilityBridge.state, 'transitional-residue');
    assert.strictEqual(compatibilityBridge.installed, true);
    assert.strictEqual(projectionBridge.state, 'transitional-residue');
    assert.match(projectionBridge.rationale, /snapshot|recovery/i);
  });

  it('keeps initialization order explicit so bridge seams do not collapse back into one setup blob', async () => {
    const adapter = createAdapter();
    await adapter.initialize();

    const installedIds = adapter.getAdapterSeamReport()
      .sort((left, right) => left.installationOrder - right.installationOrder)
      .map((seam) => seam.id);

    assert.deepStrictEqual(installedIds, [
      'kernel-control-plane',
      'kernel-primitive-bridge',
      'story-step-glue',
      'compatibility-event-bridge',
      'kernel-runtime-delegation',
      'business-projection-bridge'
    ]);

    assert.strictEqual(typeof adapter.kernel.config.shouldContinue, 'function');
    assert.ok(Array.isArray(adapter.kernel.lifecycleHooks.beforeStep));
    assert.ok(Array.isArray(adapter.kernel.lifecycleHooks.afterCheckpoint));
    assert.ok(Array.isArray(adapter.kernel.lifecycleHooks.onRecovery));
    assert.ok(adapter.kernel.stepRegistry.handlers.has('parseAgentJson'));
    assert.ok(adapter.kernel.stepRegistry.handlers.has('generateOutline'));
  });
});
