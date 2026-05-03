/**
 * HotReloadManager — watches workflow definition files for changes in dev mode.
 *
 * Only active when WORKFLOW_HOT_RELOAD=true in config.env.
 * Uses chokidar for file watching (same pattern as agentManager.js).
 */

const fs = require('fs');
const path = require('path');

class HotReloadManager {
  /**
   * Creates a new HotReloadManager instance.
   * @param {Object} config
   * @param {boolean} [config.hotReload=false] - Enable hot reload
   * @param {Array<string>} [config.watchPaths=[]] - Paths to watch for changes
   * @param {WorkflowValidator} [config.validator=null] - Validator for reloaded files
   */
  constructor(config = {}) {
    this.enabled = config.hotReload === true;
    this.watchPaths = config.watchPaths || [];
    this.validator = config.validator || null;
    this.watcher = null;
    this.callbacks = [];
  }

  /**
   * Starts file watchers. Only effective if hotReload is enabled.
   * Uses fs.watch as a lightweight alternative to chokidar.
   */
  start() {
    if (!this.enabled) {
      console.log('[HotReloadManager] Hot reload is disabled');
      return;
    }

    if (this.watcher) {
      console.log('[HotReloadManager] Already watching');
      return;
    }

    // Use fs.watch as lightweight alternative if chokidar not available
    this.watchPaths.forEach(watchPath => {
      if (!fs.existsSync(watchPath)) {
        console.warn(`[HotReloadManager] Watch path does not exist: ${watchPath}`);
        return;
      }

      try {
        const watcher = fs.watch(watchPath, { recursive: true }, (eventType, filename) => {
          if (!filename || !filename.endsWith('.js')) return;

          const fullPath = path.join(watchPath, filename);
          console.log(`[HotReloadManager] File changed: ${fullPath}`);

          this._reloadFile(fullPath);
        });

        if (!this.watcher) this.watcher = [];
        this.watcher.push(watcher);
      } catch (err) {
        console.error(`[HotReloadManager] Failed to watch ${watchPath}:`, err.message);
      }
    });

    console.log('[HotReloadManager] Started watching:', this.watchPaths);
  }

  /**
   * Stops all file watchers.
   */
  stop() {
    if (this.watcher) {
      this.watcher.forEach(w => w.close());
      this.watcher = null;
      console.log('[HotReloadManager] Stopped watching');
    }
  }

  /**
   * Registers a callback for reload events.
   * @param {function} callback - `(filePath, definition) => void`
   */
  onReload(callback) {
    this.callbacks.push(callback);
  }

  _reloadFile(filePath) {
    try {
      // Clear require cache to force re-evaluation
      delete require.cache[require.resolve(filePath)];

      // Load and validate
      const definition = require(filePath);

      if (this.validator) {
        const validation = this.validator.validate(definition);
        if (!validation.valid) {
          console.error(`[HotReloadManager] Validation failed for ${filePath}:`, validation.errors);
          return;
        }
      }

      console.log(`[HotReloadManager] Reloaded: ${filePath}`);

      // Notify listeners
      this.callbacks.forEach(cb => {
        try {
          cb(filePath, definition);
        } catch (err) {
          console.error('[HotReloadManager] Callback error:', err.message);
        }
      });
    } catch (err) {
      console.error(`[HotReloadManager] Failed to reload ${filePath}:`, err.message);
    }
  }
}

module.exports = { HotReloadManager };
