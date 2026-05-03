const fs = require('fs').promises;
const path = require('path');
const crypto = require('crypto');

const ARTIFACT_DIR = path.join(__dirname, '..', 'state', 'artifacts');

class ArtifactManager {
  constructor(repository) {
    this.initialized = false;
    this.repository = repository || null;
  }

  async initialize() {
    if (this.initialized) return;
    await fs.mkdir(ARTIFACT_DIR, { recursive: true });
    this.initialized = true;
  }

  _buildArtifactProjectionRecord(storyId, artifactType, filePath, contentHash, sizeBytes, artifactId) {
    return {
      artifact_id: artifactId,
      story_id: storyId,
      artifact_type: artifactType,
      file_path: filePath,
      content_hash: contentHash,
      size_bytes: sizeBytes
    };
  }

  _recordArtifactProjection(record) {
    if (!this.repository) {
      return;
    }

    try {
      this.repository.recordArtifact(record);
    } catch (indexError) {
      console.warn('[ArtifactManager] Failed to index artifact in SQLite:', indexError.message);
    }
  }

  async saveArtifact(storyId, artifactType, content, extension = 'txt') {
    await this.initialize();

    const timestamp = Date.now();
    const artifactId = `art-${storyId}-${artifactType}-${timestamp}-${Math.random().toString(36).substring(2, 8)}`;
    const fileName = `${artifactId}.${extension}`;
    const filePath = path.join(ARTIFACT_DIR, fileName);

    const buffer = Buffer.from(content, 'utf8');
    const contentHash = crypto.createHash('sha256').update(buffer).digest('hex');

    await fs.writeFile(filePath, buffer);

    // Artifact persistence remains a plugin-facing projection concern. We index
    // artifacts for lookup, but do not treat this layer as workflow runtime
    // truth.
    this._recordArtifactProjection(
      this._buildArtifactProjectionRecord(storyId, artifactType, filePath, contentHash, buffer.length, artifactId)
    );

    return {
      artifactId,
      filePath,
      contentHash,
      sizeBytes: buffer.length
    };
  }

  async readArtifact(filePath) {
    try {
      const content = await fs.readFile(filePath, 'utf8');
      return content;
    } catch (error) {
      console.error('[ArtifactManager] Failed to read artifact:', error.message);
      return null;
    }
  }

  /**
   * List plugin artifact projection records without claiming those rows are the
   * canonical workflow state. Consumers that need runtime truth must ask the
   * kernel, not the artifact index.
   */
  listArtifacts(storyId, artifactType) {
    if (!this.repository) {
      return [];
    }

    if (typeof this.repository.getArtifactIndex === 'function') {
      return this.repository.getArtifactIndex(storyId, artifactType) || [];
    }

    if (typeof this.repository.getArtifacts === 'function') {
      return this.repository.getArtifacts(storyId, artifactType) || [];
    }

    return [];
  }

  async deleteStoryArtifacts(storyId) {
    try {
      const files = await fs.readdir(ARTIFACT_DIR);
      const toDelete = files.filter(f => f.includes(storyId));
      for (const file of toDelete) {
        await fs.unlink(path.join(ARTIFACT_DIR, file)).catch(() => {});
      }
    } catch (error) {
    }
  }
}

module.exports = {
  ArtifactManager,
  ARTIFACT_DIR
};
