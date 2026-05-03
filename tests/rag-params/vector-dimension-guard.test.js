const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const Database = require('better-sqlite3');
const knowledgeBaseManager = require('../../KnowledgeBaseManager');

function createTempDb() {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vcp-kbm-dim-'));
    const dbPath = path.join(tempDir, 'knowledge_base.sqlite');
    const db = new Database(dbPath);
    db.exec(`
        CREATE TABLE chunks (
            id INTEGER PRIMARY KEY,
            vector BLOB
        );
        CREATE TABLE tags (
            id INTEGER PRIMARY KEY,
            name TEXT,
            vector BLOB
        );
        CREATE TABLE kv_store (
            key TEXT PRIMARY KEY,
            value TEXT,
            vector BLOB
        );
    `);
    return { tempDir, db };
}

function makeVectorBlob(dimension) {
    return Buffer.from(new Float32Array(dimension).buffer);
}

test('SQLite 向量维度与当前配置一致时不报错', () => {
    const { tempDir, db } = createTempDb();
    const originalDb = knowledgeBaseManager.db;
    const originalConfig = knowledgeBaseManager.config;

    try {
        db.prepare('INSERT INTO chunks (id, vector) VALUES (?, ?)').run(1, makeVectorBlob(3072));
        db.prepare('INSERT INTO tags (id, name, vector) VALUES (?, ?, ?)').run(1, '发布计划', makeVectorBlob(3072));
        db.prepare('INSERT INTO kv_store (key, vector) VALUES (?, ?)').run('diary_name:RAG评测主库', makeVectorBlob(3072));

        knowledgeBaseManager.db = db;
        knowledgeBaseManager.config = {
            ...originalConfig,
            dimension: 3072,
            storePath: tempDir
        };

        assert.doesNotThrow(() => knowledgeBaseManager._assertStoredVectorDimensionsMatchConfig());
    } finally {
        if (knowledgeBaseManager.db) {
            knowledgeBaseManager.db.close();
        }
        knowledgeBaseManager.db = originalDb;
        knowledgeBaseManager.config = originalConfig;
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
});

test('SQLite 向量维度与 VECTORDB_DIMENSION 不一致时直接报错提醒', () => {
    const { tempDir, db } = createTempDb();
    const originalDb = knowledgeBaseManager.db;
    const originalConfig = knowledgeBaseManager.config;

    try {
        db.prepare('INSERT INTO chunks (id, vector) VALUES (?, ?)').run(1, makeVectorBlob(2048));
        db.prepare('INSERT INTO kv_store (key, vector) VALUES (?, ?)').run('diary_name:RAG评测主库', makeVectorBlob(3072));

        knowledgeBaseManager.db = db;
        knowledgeBaseManager.config = {
            ...originalConfig,
            dimension: 3072,
            storePath: tempDir
        };

        assert.throws(
            () => knowledgeBaseManager._assertStoredVectorDimensionsMatchConfig(),
            error => {
                assert.match(error.message, /Vector dimension mismatch detected/);
                assert.match(error.message, /chunks\.chunk_id=1 -> stored=2048, expected=3072/);
                assert.match(error.message, new RegExp(tempDir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
                return true;
            }
        );
        assert.equal(knowledgeBaseManager.db, null);
    } finally {
        if (knowledgeBaseManager.db) {
            knowledgeBaseManager.db.close();
        }
        knowledgeBaseManager.db = originalDb;
        knowledgeBaseManager.config = originalConfig;
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
});
