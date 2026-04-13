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

  async saveArtifact(storyId, artifactType, content, extension = 'txt') {
    await this.initialize();

    const timestamp = Date.now();
    const artifactId = `art-${storyId}-${artifactType}-${timestamp}-${Math.random().toString(36).substring(2, 8)}`;
    const fileName = `${artifactId}.${extension}`;
    const filePath = path.join(ARTIFACT_DIR, fileName);

    const buffer = Buffer.from(content, 'utf8');
    const contentHash = crypto.createHash('sha256').update(buffer).digest('hex');

    await fs.writeFile(filePath, buffer);

    if (this.repository) {
      try {
        this.repository.recordArtifact({
          artifact_id: artifactId,
          story_id: storyId,
          artifact_type: artifactType,
          file_path: filePath,
          content_hash: contentHash,
          size_bytes: buffer.length
        });
      } catch (indexError) {
        console.warn('[ArtifactManager] Failed to index artifact in SQLite:', indexError.message);
      }
    }

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
