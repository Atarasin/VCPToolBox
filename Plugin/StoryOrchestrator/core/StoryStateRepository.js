const { getDatabase } = require('./StoryOrchestratorDatabase');
const { v4: uuidv4 } = require('uuid');

class StoryStateRepository {
  constructor() {
    this.db = null;
  }

  initialize() {
    const dbInstance = getDatabase();
    this.db = dbInstance.initialize();
    console.log('[StoryStateRepository] Initialized');
  }

  createStory(storyId, config, now = new Date().toISOString()) {
    const stmt = this.db.prepare(`
      INSERT INTO stories (story_id, status, current_phase, config_json, version, created_at, updated_at)
      VALUES (?, 'phase1_running', 'phase1', ?, 1, ?, ?)
    `);
    stmt.run(storyId, JSON.stringify(config || {}), now, now);
    return this.getStory(storyId);
  }

  getStoryWithFields(storyId) {
    const stmt = this.db.prepare(`
      SELECT story_id, status, current_phase, current_step, config_json,
             active_checkpoint_id, current_phase1_snapshot_id, current_phase2_snapshot_id,
             current_phase3_snapshot_id, final_output_json, retry_context_json, workflow_state,
             version, created_at, updated_at
      FROM stories WHERE story_id = ?
    `);
    return stmt.get(storyId) || null;
  }

  getStory(storyId) {
    const stmt = this.db.prepare(`SELECT * FROM stories WHERE story_id = ?`);
    return stmt.get(storyId) || null;
  }

  updateStory(storyId, updates, expectedVersion) {
    const allowed = ['status', 'current_phase', 'current_step', 'config_json', 'active_checkpoint_id',
      'current_phase1_snapshot_id', 'current_phase2_snapshot_id', 'current_phase3_snapshot_id',
      'final_output_json', 'retry_context_json', 'workflow_state'];
    const fields = [];
    const values = [];

    for (const key of allowed) {
      if (updates[key] !== undefined) {
        fields.push(`${key} = ?`);
        values.push(updates[key]);
      }
    }

    if (fields.length === 0) return this.getStory(storyId);

    fields.push('version = version + 1');
    fields.push('updated_at = ?');
    values.push(new Date().toISOString());
    values.push(storyId);

    let whereClause = 'story_id = ?';
    if (expectedVersion !== undefined && expectedVersion !== null) {
      whereClause += ' AND version = ?';
      values.push(expectedVersion);
    }

    const stmt = this.db.prepare(`UPDATE stories SET ${fields.join(', ')} WHERE ${whereClause}`);
    const result = stmt.run(...values);

    if (result.changes === 0) {
      throw new Error(`Optimistic lock conflict for story ${storyId}. Expected version ${expectedVersion}.`);
    }

    return this.getStory(storyId);
  }

  listStories() {
    const stmt = this.db.prepare(`SELECT story_id, status, current_phase, updated_at FROM stories ORDER BY updated_at DESC`);
    return stmt.all();
  }

  deleteStory(storyId) {
    const stmt = this.db.prepare(`DELETE FROM stories WHERE story_id = ?`);
    const result = stmt.run(storyId);
    return result.changes > 0;
  }

  createPhaseAttempt(input) {
    const attemptId = input.attempt_id || `att-${uuidv4().replace(/-/g, '').substring(0, 16)}`;
    const now = input.created_at || new Date().toISOString();
    const stmt = this.db.prepare(`
      INSERT INTO phase_attempts (
        attempt_id, story_id, phase_name, attempt_kind, trigger_source, source_checkpoint_id,
        raw_prompt_path, raw_response_path, parse_status, repair_used, schema_valid,
        business_valid, candidate_snapshot_id, error_message, created_at, completed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.run(
      attemptId,
      input.story_id,
      input.phase_name,
      input.attempt_kind || 'initial_generation',
      input.trigger_source || 'agent',
      input.source_checkpoint_id || null,
      input.raw_prompt_path || null,
      input.raw_response_path || null,
      input.parse_status || 'raw_only',
      input.repair_used ? 1 : 0,
      input.schema_valid ? 1 : 0,
      input.business_valid ? 1 : 0,
      input.candidate_snapshot_id || null,
      input.error_message || null,
      now,
      input.completed_at || null
    );
    return attemptId;
  }

  getPhaseAttempts(storyId, phaseName) {
    const stmt = this.db.prepare(`
      SELECT * FROM phase_attempts WHERE story_id = ? AND phase_name = ? ORDER BY created_at DESC
    `);
    return stmt.all(storyId, phaseName);
  }

  getLatestPhaseAttempt(storyId, phaseName) {
    const stmt = this.db.prepare(`
      SELECT * FROM phase_attempts WHERE story_id = ? AND phase_name = ? ORDER BY created_at DESC LIMIT 1
    `);
    return stmt.get(storyId, phaseName) || null;
  }

  updatePhaseAttempt(attemptId, updates) {
    const allowed = ['parse_status', 'repair_used', 'schema_valid', 'business_valid', 'candidate_snapshot_id', 'error_message', 'completed_at'];
    const fields = [];
    const values = [];
    for (const key of allowed) {
      if (updates[key] !== undefined) {
        fields.push(`${key} = ?`);
        let value = updates[key];
        if (key === 'repair_used' || key === 'schema_valid' || key === 'business_valid') {
          value = value ? 1 : 0;
        }
        values.push(value);
      }
    }
    if (fields.length === 0) return;
    values.push(attemptId);
    const stmt = this.db.prepare(`UPDATE phase_attempts SET ${fields.join(', ')} WHERE attempt_id = ?`);
    stmt.run(...values);
  }

  createSnapshot(input) {
    const snapshotId = input.snapshot_id || `snap-${uuidv4().replace(/-/g, '').substring(0, 16)}`;
    const now = input.created_at || new Date().toISOString();
    const payloadJson = typeof input.payload_json === 'string' ? input.payload_json : JSON.stringify(input.payload_json || {});
    const stmt = this.db.prepare(`
      INSERT INTO snapshots (
        snapshot_id, story_id, phase_name, snapshot_type, payload_json, payload_hash,
        schema_version, schema_valid, completeness_score, created_from_attempt_id, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.run(
      snapshotId,
      input.story_id,
      input.phase_name,
      input.snapshot_type || 'candidate',
      payloadJson,
      input.payload_hash || '',
      input.schema_version || 'v1',
      input.schema_valid ? 1 : 0,
      input.completeness_score ?? null,
      input.created_from_attempt_id || null,
      now
    );
    return snapshotId;
  }

  getSnapshot(snapshotId) {
    const stmt = this.db.prepare(`SELECT * FROM snapshots WHERE snapshot_id = ?`);
    return stmt.get(snapshotId) || null;
  }

  getSnapshotsByStory(storyId, phaseName, snapshotType) {
    let sql = `SELECT * FROM snapshots WHERE story_id = ?`;
    const params = [storyId];
    if (phaseName) {
      sql += ` AND phase_name = ?`;
      params.push(phaseName);
    }
    if (snapshotType) {
      sql += ` AND snapshot_type = ?`;
      params.push(snapshotType);
    }
    sql += ` ORDER BY created_at DESC`;
    const stmt = this.db.prepare(sql);
    return stmt.all(...params);
  }

  getLatestApprovedSnapshot(storyId, phaseName) {
    const stmt = this.db.prepare(`
      SELECT * FROM snapshots
      WHERE story_id = ? AND phase_name = ? AND snapshot_type = 'approved'
      ORDER BY created_at DESC LIMIT 1
    `);
    return stmt.get(storyId, phaseName) || null;
  }

  createCheckpoint(input) {
    const checkpointId = input.checkpoint_id || `cp-${uuidv4().replace(/-/g, '').substring(0, 12)}`;
    const now = input.created_at || new Date().toISOString();
    const stmt = this.db.prepare(`
      INSERT INTO checkpoints (
        checkpoint_id, story_id, phase_name, checkpoint_type, status, snapshot_id, feedback, created_at, expires_at, resolved_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.run(
      checkpointId,
      input.story_id,
      input.phase_name,
      input.checkpoint_type || 'general',
      input.status || 'pending',
      input.snapshot_id,
      input.feedback || null,
      now,
      input.expires_at || null,
      input.resolved_at || null
    );
    return checkpointId;
  }

  getCheckpoint(checkpointId) {
    const stmt = this.db.prepare(`SELECT * FROM checkpoints WHERE checkpoint_id = ?`);
    return stmt.get(checkpointId) || null;
  }

  getActiveCheckpoint(storyId) {
    const stmt = this.db.prepare(`
      SELECT * FROM checkpoints WHERE story_id = ? AND status = 'pending' ORDER BY created_at DESC LIMIT 1
    `);
    return stmt.get(storyId) || null;
  }

  getApprovedCheckpoints(storyId, limit = 10) {
    const stmt = this.db.prepare(`
      SELECT * FROM checkpoints WHERE story_id = ? AND status = 'approved' ORDER BY created_at DESC LIMIT ?
    `);
    return stmt.all(storyId, limit);
  }

  updateCheckpoint(checkpointId, updates) {
    const allowed = ['status', 'feedback', 'snapshot_id', 'expires_at', 'resolved_at'];
    const fields = [];
    const values = [];
    for (const key of allowed) {
      if (updates[key] !== undefined) {
        fields.push(`${key} = ?`);
        values.push(updates[key]);
      }
    }
    if (fields.length === 0) return;
    values.push(checkpointId);
    const stmt = this.db.prepare(`UPDATE checkpoints SET ${fields.join(', ')} WHERE checkpoint_id = ?`);
    stmt.run(...values);
  }

  appendEvent(input) {
    const eventId = input.event_id || `evt-${uuidv4().replace(/-/g, '').substring(0, 16)}`;
    const now = input.created_at || new Date().toISOString();
    const detailJson = typeof input.event_detail_json === 'string'
      ? input.event_detail_json
      : JSON.stringify(input.event_detail_json || {});
    const stmt = this.db.prepare(`
      INSERT INTO workflow_events (
        event_id, story_id, phase_name, event_type, event_detail_json,
        related_attempt_id, related_snapshot_id, related_checkpoint_id, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.run(
      eventId,
      input.story_id,
      input.phase_name || null,
      input.event_type,
      detailJson,
      input.related_attempt_id || null,
      input.related_snapshot_id || null,
      input.related_checkpoint_id || null,
      now
    );
    return eventId;
  }

  getEvents(storyId, options = {}) {
    let sql = `SELECT * FROM workflow_events WHERE story_id = ?`;
    const params = [storyId];
    if (options.eventType) {
      sql += ` AND event_type = ?`;
      params.push(options.eventType);
    }
    if (options.phaseName) {
      sql += ` AND phase_name = ?`;
      params.push(options.phaseName);
    }
    sql += ` ORDER BY created_at DESC`;
    if (options.limit) {
      sql += ` LIMIT ?`;
      params.push(options.limit);
    }
    const stmt = this.db.prepare(sql);
    return stmt.all(...params);
  }

  recordArtifact(input) {
    const artifactId = input.artifact_id || `art-${uuidv4().replace(/-/g, '').substring(0, 16)}`;
    const now = input.created_at || new Date().toISOString();
    const stmt = this.db.prepare(`
      INSERT INTO artifacts (artifact_id, story_id, artifact_type, file_path, content_hash, size_bytes, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.run(artifactId, input.story_id, input.artifact_type, input.file_path, input.content_hash, input.size_bytes, now);
    return artifactId;
  }

  getArtifacts(storyId, artifactType) {
    let sql = `SELECT * FROM artifacts WHERE story_id = ?`;
    const params = [storyId];
    if (artifactType) {
      sql += ` AND artifact_type = ?`;
      params.push(artifactType);
    }
    sql += ` ORDER BY created_at DESC`;
    const stmt = this.db.prepare(sql);
    return stmt.all(...params);
  }

  runInTransaction(fn) {
    this.db.transaction(fn)();
  }
}

module.exports = { StoryStateRepository };
