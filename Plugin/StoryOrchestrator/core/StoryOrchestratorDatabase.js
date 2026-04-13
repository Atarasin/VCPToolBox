const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const DB_DIR = path.join(__dirname, '..', 'state');
const DB_PATH = path.join(DB_DIR, 'story_orchestrator.sqlite');

class StoryOrchestratorDatabase {
  constructor() {
    this.db = null;
  }

  initialize() {
    if (this.db) {
      return this.db;
    }

    fs.mkdirSync(DB_DIR, { recursive: true });
    this.db = new Database(DB_PATH);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');

    this._createTables();
    console.log('[StoryOrchestratorDatabase] Initialized at', DB_PATH);
    return this.db;
  }

  getDb() {
    if (!this.db) {
      return this.initialize();
    }
    return this.db;
  }

  close() {
    if (this.db) {
      this.db.close();
      this.db = null;
    }
  }

  _createTables() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS stories (
        story_id TEXT PRIMARY KEY,
        status TEXT NOT NULL DEFAULT 'idle',
        current_phase TEXT NOT NULL DEFAULT 'phase1',
        current_step TEXT,
        config_json TEXT NOT NULL DEFAULT '{}',
        active_checkpoint_id TEXT,
        current_phase1_snapshot_id TEXT,
        current_phase2_snapshot_id TEXT,
        current_phase3_snapshot_id TEXT,
        final_output_json TEXT,
        retry_context_json TEXT,
        workflow_state TEXT,
        version INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_stories_status ON stories(status);
      CREATE INDEX IF NOT EXISTS idx_stories_updated_at ON stories(updated_at);
    `);



    this.db.exec(`
      CREATE TABLE IF NOT EXISTS phase_attempts (
        attempt_id TEXT PRIMARY KEY,
        story_id TEXT NOT NULL,
        phase_name TEXT NOT NULL,
        attempt_kind TEXT NOT NULL,
        trigger_source TEXT NOT NULL,
        source_checkpoint_id TEXT,
        raw_prompt_path TEXT,
        raw_response_path TEXT,
        parse_status TEXT NOT NULL,
        repair_used INTEGER NOT NULL DEFAULT 0,
        schema_valid INTEGER NOT NULL DEFAULT 0,
        business_valid INTEGER NOT NULL DEFAULT 0,
        candidate_snapshot_id TEXT,
        error_message TEXT,
        created_at TEXT NOT NULL,
        completed_at TEXT,
        FOREIGN KEY (story_id) REFERENCES stories(story_id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_attempts_story_phase ON phase_attempts(story_id, phase_name);
      CREATE INDEX IF NOT EXISTS idx_attempts_created_at ON phase_attempts(created_at);
    `);

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS snapshots (
        snapshot_id TEXT PRIMARY KEY,
        story_id TEXT NOT NULL,
        phase_name TEXT NOT NULL,
        snapshot_type TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        payload_hash TEXT NOT NULL,
        schema_version TEXT NOT NULL,
        schema_valid INTEGER NOT NULL,
        completeness_score REAL,
        created_from_attempt_id TEXT,
        created_at TEXT NOT NULL,
        FOREIGN KEY (story_id) REFERENCES stories(story_id) ON DELETE CASCADE,
        FOREIGN KEY (created_from_attempt_id) REFERENCES phase_attempts(attempt_id) ON DELETE SET NULL
      );
      CREATE INDEX IF NOT EXISTS idx_snapshots_story_phase ON snapshots(story_id, phase_name);
      CREATE INDEX IF NOT EXISTS idx_snapshots_type ON snapshots(snapshot_type);
    `);

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS checkpoints (
        checkpoint_id TEXT PRIMARY KEY,
        story_id TEXT NOT NULL,
        phase_name TEXT NOT NULL,
        checkpoint_type TEXT NOT NULL,
        status TEXT NOT NULL,
        snapshot_id TEXT NOT NULL,
        feedback TEXT,
        created_at TEXT NOT NULL,
        expires_at TEXT,
        resolved_at TEXT,
        FOREIGN KEY (story_id) REFERENCES stories(story_id) ON DELETE CASCADE,
        FOREIGN KEY (snapshot_id) REFERENCES snapshots(snapshot_id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_checkpoints_story ON checkpoints(story_id);
      CREATE INDEX IF NOT EXISTS idx_checkpoints_status ON checkpoints(status);
    `);

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS workflow_events (
        event_id TEXT PRIMARY KEY,
        story_id TEXT NOT NULL,
        phase_name TEXT,
        event_type TEXT NOT NULL,
        event_detail_json TEXT,
        related_attempt_id TEXT,
        related_snapshot_id TEXT,
        related_checkpoint_id TEXT,
        created_at TEXT NOT NULL,
        FOREIGN KEY (story_id) REFERENCES stories(story_id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_events_story ON workflow_events(story_id);
      CREATE INDEX IF NOT EXISTS idx_events_type ON workflow_events(event_type);
      CREATE INDEX IF NOT EXISTS idx_events_created_at ON workflow_events(created_at);
    `);

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS artifacts (
        artifact_id TEXT PRIMARY KEY,
        story_id TEXT NOT NULL,
        artifact_type TEXT NOT NULL,
        file_path TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        size_bytes INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        FOREIGN KEY (story_id) REFERENCES stories(story_id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_artifacts_story ON artifacts(story_id);
      CREATE INDEX IF NOT EXISTS idx_artifacts_type ON artifacts(artifact_type);
    `);
  }

  runInTransaction(fn) {
    const db = this.getDb();
    db.transaction(fn)();
  }
}

const instance = new StoryOrchestratorDatabase();

module.exports = {
  StoryOrchestratorDatabase,
  getDatabase: () => instance
};
