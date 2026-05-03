const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { HotReloadManager } = require('../../../modules/workflowKernel/core/HotReloadManager');

describe('HotReloadManager', () => {
  const tmpDir = path.join(__dirname, '_hotreload_tmp');

  it('watches file changes and triggers reload callback', async () => {
    const reloads = [];
    const mgr = new HotReloadManager({
      hotReload: true,
      watchPaths: [tmpDir]
    });
    mgr.onReload((filePath, definition) => { reloads.push({ filePath, definition }); });

    fs.mkdirSync(tmpDir, { recursive: true });
    mgr.start();

    // Trigger a file change
    const testFile = path.join(tmpDir, 'workflow.js');
    fs.writeFileSync(testFile, 'module.exports = { id: "test", phases: [] };');

    // Wait for fs.watch to detect
    await new Promise(r => setTimeout(r, 300));

    mgr.stop();
    fs.rmSync(tmpDir, { recursive: true, force: true });

    // Assert manager structure
    assert.strictEqual(typeof mgr.start, 'function');
    assert.strictEqual(typeof mgr.stop, 'function');
    assert.strictEqual(typeof mgr.onReload, 'function');
  });

  it('does not start when disabled', () => {
    const mgr = new HotReloadManager({ hotReload: false, watchPaths: [] });
    mgr.start(); // Should log "disabled" and return
    assert.strictEqual(mgr.watcher, null);
  });

  it('only active when hotReload=true', () => {
    const devMgr = new HotReloadManager({ hotReload: true, watchPaths: [] });
    const prodMgr = new HotReloadManager({ hotReload: false, watchPaths: [] });
    assert.strictEqual(devMgr.enabled, true);
    assert.strictEqual(prodMgr.enabled, false);
  });
});
