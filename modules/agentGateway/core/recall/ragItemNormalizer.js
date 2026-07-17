const path = require('path');

function normalizeContextString(value) {
    return typeof value === 'string' ? value.trim() : '';
}
function normalizeContextStringArray(value) {
    return Array.isArray(value) ? value.map(normalizeContextString).filter(Boolean) : [];
}

function computeCosineSimilarity(vectorA, vectorB) {
    if (!Array.isArray(vectorA) || !Array.isArray(vectorB) || vectorA.length !== vectorB.length || vectorA.length === 0) {
        return 0;
    }
    let dotProduct = 0;
    let normA = 0;
    let normB = 0;
    for (let index = 0; index < vectorA.length; index += 1) {
        dotProduct += vectorA[index] * vectorB[index];
        normA += vectorA[index] * vectorA[index];
        normB += vectorB[index] * vectorB[index];
    }
    if (normA === 0 || normB === 0) {
        return 0;
    }
    return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
}

async function getQueryVector(query, ragPlugin, knowledgeBaseManager, embeddingUtilsLoader) {
    if (ragPlugin?.getSingleEmbeddingCached) {
        return await ragPlugin.getSingleEmbeddingCached(query);
    }
    const { getEmbeddingsBatch } = embeddingUtilsLoader();
    const [vector] = await getEmbeddingsBatch([query], {
        apiKey: knowledgeBaseManager?.config?.apiKey,
        apiUrl: knowledgeBaseManager?.config?.apiUrl,
        model: knowledgeBaseManager?.config?.model
    });
    return vector || null;
}

function extractCoreTags(boostInfo) {
    const matchedTags = Array.isArray(boostInfo?.matchedTags) ? boostInfo.matchedTags : [];
    return matchedTags
        .map((tag) => {
            if (typeof tag === 'string') {
                return tag;
            }
            if (tag && typeof tag === 'object') {
                return normalizeContextString(tag.name);
            }
            return '';
        })
        .filter(Boolean);
}

function normalizeTimestampValue(value) {
    if (typeof value === 'string' && value.trim()) {
        const timestamp = Date.parse(value);
        if (!Number.isNaN(timestamp)) {
            return new Date(timestamp).toISOString();
        }
    }
    if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
        return new Date(value).toISOString();
    }
    return null;
}

function deriveTimestampFromPath(sourcePath) {
    const normalizedPath = normalizeContextString(sourcePath);
    if (!normalizedPath) {
        return null;
    }
    const match = path.basename(normalizedPath).match(/(\d{4}[-.]\d{2}[-.]\d{2})/);
    if (!match) {
        return null;
    }
    const normalizedDate = match[1].replace(/\./g, '-');
    const timestamp = Date.parse(`${normalizedDate}T00:00:00.000Z`);
    return Number.isNaN(timestamp) ? null : new Date(timestamp).toISOString();
}

async function getFileMetadata(knowledgeBaseManager, sourcePath) {
    if (!sourcePath) {
        return null;
    }
    if (typeof knowledgeBaseManager?.getOpenClawFileMetadata === 'function') {
        return await Promise.resolve(knowledgeBaseManager.getOpenClawFileMetadata(sourcePath));
    }
    if (!knowledgeBaseManager?.db?.prepare) {
        return null;
    }
    const row = knowledgeBaseManager.db.prepare(`
        SELECT
            f.diary_name AS sourceDiary,
            f.path AS sourcePath,
            f.updated_at AS updatedAt,
            GROUP_CONCAT(t.name, '||') AS tags
        FROM files f
        LEFT JOIN file_tags ft ON ft.file_id = f.id
        LEFT JOIN tags t ON t.id = ft.tag_id
        WHERE f.path = ?
        GROUP BY f.id
    `).get(sourcePath);

    if (!row) {
        return null;
    }

    return {
        sourceDiary: normalizeContextString(row.sourceDiary),
        sourcePath: normalizeContextString(row.sourcePath),
        updatedAt: row.updatedAt,
        tags: row.tags ? row.tags.split('||').filter(Boolean) : []
    };
}

async function getCachedFileMetadata(metadataCache, knowledgeBaseManager, sourcePath) {
    const cacheKey = normalizeContextString(sourcePath);
    if (!cacheKey) {
        return null;
    }
    if (metadataCache.has(cacheKey)) {
        return metadataCache.get(cacheKey);
    }
    const metadata = await getFileMetadata(knowledgeBaseManager, cacheKey);
    metadataCache.set(cacheKey, metadata);
    return metadata;
}

async function normalizeRagItem(result, fallbackDiary, knowledgeBaseManager, metadataCache) {
    const sourcePath = normalizeContextString(
        result?.fullPath ||
        result?.sourcePath ||
        result?.source_file ||
        result?.sourceFile
    );
    const metadata = sourcePath
        ? await getCachedFileMetadata(metadataCache, knowledgeBaseManager, sourcePath)
        : null;
    const timestamp = normalizeTimestampValue(
        result?.timestamp ||
        result?.updatedAt ||
        result?.updated_at ||
        metadata?.timestamp ||
        metadata?.updatedAt
    ) || deriveTimestampFromPath(sourcePath);

    return {
        text: normalizeContextString(result?.text),
        score: typeof result?.score === 'number' && Number.isFinite(result.score) ? result.score : 0,
        sourceDiary: normalizeContextString(result?.sourceDiary || metadata?.sourceDiary || fallbackDiary),
        sourceFile: normalizeContextString(
            result?.sourceFile ? path.basename(result.sourceFile) : (sourcePath ? path.basename(sourcePath) : '')
        ),
        timestamp,
        tags: normalizeContextStringArray(result?.tags || result?.matchedTags || metadata?.tags)
    };
}

function deduplicateRagCandidates(candidates) {
    const deduplicatedCandidates = new Map();
    for (const candidate of candidates) {
        const key = [
            normalizeContextString(candidate?.sourceDiary),
            normalizeContextString(candidate?.fullPath || candidate?.sourcePath || candidate?.sourceFile),
            normalizeContextString(candidate?.text)
        ].join('::');
        const existingCandidate = deduplicatedCandidates.get(key);
        if (!existingCandidate || (candidate?.score || 0) > (existingCandidate?.score || 0)) {
            deduplicatedCandidates.set(key, candidate);
        }
    }
    return Array.from(deduplicatedCandidates.values());
}

module.exports = {
    computeCosineSimilarity,
    deduplicateRagCandidates,
    deriveTimestampFromPath,
    extractCoreTags,
    getCachedFileMetadata,
    getFileMetadata,
    getQueryVector,
    normalizeRagItem,
    normalizeTimestampValue
};

