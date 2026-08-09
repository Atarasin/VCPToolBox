// EmbeddingUtils.js
const { get_encoding } = require("@dqbd/tiktoken");
const encoding = get_encoding("cl100k_base");

// 配置
const embeddingMaxToken = parseInt(process.env.WhitelistEmbeddingModelMaxToken, 10) || 8000;
const safeMaxTokens = Math.floor(embeddingMaxToken * 0.85);
const RAW_MAX_BATCH_ITEMS = process.env.EMBEDDING_MAX_BATCH_ITEMS;
const MAX_BATCH_ITEMS = RAW_MAX_BATCH_ITEMS ? parseInt(RAW_MAX_BATCH_ITEMS, 10) : NaN;
const DEFAULT_MAX_BATCH_ITEMS = 10;
const DEFAULT_CONCURRENCY = parseInt(process.env.TAG_VECTORIZE_CONCURRENCY) || 5; // 🌟 读取并发配置
const DISABLE_BATCHING = (process.env.EMBEDDING_DISABLE_BATCHING || 'false').toLowerCase() === 'true';
const RAW_EMBEDDING_DIMENSIONS = process.env.EMBEDDING_DIMENSIONS || process.env.VECTORDB_DIMENSION;
const EMBEDDING_DIMENSIONS = RAW_EMBEDDING_DIMENSIONS ? parseInt(RAW_EMBEDDING_DIMENSIONS, 10) : NaN;

function _envInteger(name, fallback, min, max = Number.MAX_SAFE_INTEGER) {
    const parsed = Number.parseInt(process.env[name], 10);
    return Math.max(min, Math.min(max, Number.isFinite(parsed) ? parsed : fallback));
}

const REQUEST_TIMEOUT_MS = _envInteger('EMBEDDING_REQUEST_TIMEOUT_MS', 60000, 1000);
const RATE_LIMIT_RETRIES = _envInteger('EMBEDDING_RATE_LIMIT_RETRIES', 4, 0, 10);
const RATE_LIMIT_BASE_MS = _envInteger('EMBEDDING_RATE_LIMIT_BASE_MS', 5000, 100);
const RATE_LIMIT_MAX_MS = _envInteger('EMBEDDING_RATE_LIMIT_MAX_MS', 120000, RATE_LIMIT_BASE_MS);
const GLOBAL_CONCURRENCY = _envInteger('EMBEDDING_GLOBAL_CONCURRENCY', 0, 0);
const MIN_REQUEST_INTERVAL_MS = _envInteger('EMBEDDING_MIN_REQUEST_INTERVAL_MS', 0, 0);

function _createRequestScheduler(maxConcurrency = 0, minIntervalMs = 0) {
    const limit = Math.max(0, Number(maxConcurrency) || 0);
    const interval = Math.max(0, Number(minIntervalMs) || 0);
    if (limit === 0 && interval === 0) return task => task();

    const queue = [];
    let active = 0;
    let nextStartAt = 0;
    let timer = null;

    const drain = () => {
        if (timer || queue.length === 0 || (limit > 0 && active >= limit)) return;
        const waitMs = Math.max(0, nextStartAt - Date.now());
        if (waitMs > 0) {
            timer = setTimeout(() => {
                timer = null;
                drain();
            }, waitMs);
            return;
        }

        const { task, resolve, reject } = queue.shift();
        active++;
        nextStartAt = Date.now() + interval;
        Promise.resolve()
            .then(task)
            .then(resolve, reject)
            .finally(() => {
                active--;
                drain();
            });
        drain();
    };

    return task => new Promise((resolve, reject) => {
        queue.push({ task, resolve, reject });
        drain();
    });
}

const scheduleRequest = _createRequestScheduler(GLOBAL_CONCURRENCY, MIN_REQUEST_INTERVAL_MS);

function _parseRetryAfterMs(value, now = Date.now()) {
    if (value === undefined || value === null || String(value).trim() === '') return null;
    const normalized = String(value).trim();
    const seconds = Number(normalized);
    if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds * 1000);
    const retryAt = Date.parse(normalized);
    if (!Number.isFinite(retryAt)) return null;
    return Math.max(0, retryAt - now);
}

function _splitModelList(value) {
    return String(value || '')
        .split(/[,，]/)
        .map(model => model.trim())
        .filter(Boolean);
}

function _getEmbeddingModelCandidates(config = {}) {
    const candidates = [];

    const addModel = (model) => {
        const normalized = String(model || '').trim();
        if (normalized && !candidates.includes(normalized)) {
            candidates.push(normalized);
        }
    };

    addModel(config.model || process.env.WhitelistEmbeddingModel);

    // 严格评测模式下，备用模型会让“标记为模型 A”的向量实际来自模型 B，破坏整个
    // provenance 契约。主模型不可用应显式失败，由 preflight/run 归因，不能透明降级。
    if ((process.env.EVAL_STRICT_PROVENANCE || 'false').toLowerCase() === 'true') {
        return candidates;
    }

    if (Array.isArray(config.modelBackups)) {
        config.modelBackups.forEach(addModel);
    } else if (config.modelBackups) {
        _splitModelList(config.modelBackups).forEach(addModel);
    }

    _splitModelList(process.env.EmbeddingModelBackups).forEach(addModel);

    for (let i = 1; i <= 9; i++) {
        addModel(process.env[`EmbeddingModelBackup${i}`]);
    }

    // 兼容用户误把多个备援写进单个变量的情况。
    _splitModelList(process.env.EmbeddingModelBackup).forEach(addModel);

    return candidates.length > 0 ? candidates : ['google/gemini-embedding-001'];
}

/**
 * 内部函数：发送单个批次
 */
async function _sendBatch(batchTexts, config, batchNumber, disableBatching, dimensions) {
    const fetchImpl = config.fetchImpl || (await import('node-fetch')).default;
    const sleep = config.sleep || (ms => new Promise(resolve => setTimeout(resolve, ms)));
    const random = config.random || Math.random;
    const modelCandidates = _getEmbeddingModelCandidates(config);
    const baseDelay = 1000;
    const requestTimeoutMs = Number.isFinite(config.requestTimeoutMs) ? config.requestTimeoutMs : REQUEST_TIMEOUT_MS;
    const rateLimitRetries = Number.isFinite(config.rateLimitRetries) ? config.rateLimitRetries : RATE_LIMIT_RETRIES;
    const rateLimitBaseMs = Number.isFinite(config.rateLimitBaseMs) ? config.rateLimitBaseMs : RATE_LIMIT_BASE_MS;
    const rateLimitMaxMs = Number.isFinite(config.rateLimitMaxMs) ? config.rateLimitMaxMs : RATE_LIMIT_MAX_MS;
    let lastError = null;

    for (let attempt = 1; attempt <= modelCandidates.length; attempt++) {
        const model = modelCandidates[attempt - 1];
        for (let rateLimitAttempt = 0; rateLimitAttempt <= rateLimitRetries; rateLimitAttempt++) {
          try {
            const requestUrl = `${config.apiUrl}/v1/embeddings`;
            const requestBody = { model, input: disableBatching ? batchTexts[0] : batchTexts };
            if (Number.isFinite(dimensions)) {
                requestBody.dimensions = dimensions;
            }
            const requestHeaders = { 'Content-Type': 'application/json', 'Authorization': `Bearer ${config.apiKey}` };

            const response = await scheduleRequest(() => fetchImpl(requestUrl, {
                    method: 'POST',
                    headers: requestHeaders,
                    body: JSON.stringify(requestBody),
                    // 排队时间不应消耗 HTTP 超时预算，signal 必须在拿到全局请求槽后创建。
                    signal: AbortSignal.timeout(Math.max(1, requestTimeoutMs))
                }));

            const responseBodyText = await response.text();

            if (!response.ok) {
                if (response.status === 429) {
                    const retryAfterMs = _parseRetryAfterMs(response.headers?.get?.('retry-after'));
                    const exponentialMs = rateLimitBaseMs * (2 ** rateLimitAttempt);
                    const jitterMs = Math.floor(Math.min(1000, exponentialMs * 0.1) * random());
                    const waitTime = Math.min(rateLimitMaxMs, Math.max(retryAfterMs || 0, exponentialMs + jitterMs));
                    const error = new Error(`Embedding API rate limited model "${model}" (429)`);
                    error.code = 'EMBEDDING_RATE_LIMITED';
                    error.retryAfterMs = retryAfterMs;
                    lastError = error;
                    if (rateLimitAttempt >= rateLimitRetries) throw error;
                    console.warn(
                        `[Embedding] Batch ${batchNumber} model "${model}" rate limited (429). ` +
                        `Retrying same model in ${waitTime}ms (${rateLimitAttempt + 1}/${rateLimitRetries}).`
                    );
                    await sleep(waitTime);
                    continue;
                }
                throw new Error(`API Error ${response.status}: ${responseBodyText.substring(0, 500)}`);
            }

            let data;
            try {
                data = JSON.parse(responseBodyText);
            } catch (parseError) {
                console.error(`[Embedding] JSON Parse Error for Batch ${batchNumber}:`);
                console.error(`Response (first 500 chars): ${responseBodyText.substring(0, 500)}`);
                throw new Error(`Failed to parse API response as JSON: ${parseError.message}`);
            }

            // 增强的响应结构验证和详细错误信息
            if (!data) {
                throw new Error(`API returned empty/null response`);
            }

            // 检查是否是错误响应
            if (data.error) {
                const errorMsg = data.error.message || JSON.stringify(data.error);
                const errorCode = data.error.code || response.status;
                console.error(`[Embedding] API Error for Batch ${batchNumber}:`);
                console.error(`  Error Code: ${errorCode}`);
                console.error(`  Error Message: ${errorMsg}`);
                console.error(`  Hint: Check if embedding model "${model}" is available on your API server`);
                throw new Error(`API Error ${errorCode}: ${errorMsg}`);
            }

            if (!data.data) {
                console.error(`[Embedding] Missing 'data' field in response for Batch ${batchNumber}`);
                console.error(`Response keys: ${Object.keys(data).join(', ')}`);
                console.error(`Response preview: ${JSON.stringify(data).substring(0, 500)}`);
                throw new Error(`Invalid API response structure: missing 'data' field`);
            }

            if (!Array.isArray(data.data)) {
                console.error(`[Embedding] 'data' field is not an array for Batch ${batchNumber}`);
                console.error(`data type: ${typeof data.data}`);
                console.error(`data value: ${JSON.stringify(data.data).substring(0, 200)}`);
                throw new Error(`Invalid API response structure: 'data' is not an array`);
            }

            if (data.data.length === 0) {
                console.warn(`[Embedding] Warning: Batch ${batchNumber} returned empty embeddings array`);
            }

            // 简单的 Log，证明并发正在跑
            // console.log(`[Embedding] ✅ Batch ${batchNumber} completed (${batchTexts.length} items) via ${model}.`);

            return data.data.sort((a, b) => a.index - b.index).map(item => item.embedding);

          } catch (e) {
            if (e?.name === 'AbortError' || e?.name === 'TimeoutError') {
                const timeoutError = new Error(`Embedding request timed out after ${requestTimeoutMs}ms`);
                timeoutError.code = 'EMBEDDING_REQUEST_TIMEOUT';
                lastError = timeoutError;
                console.warn(`[Embedding] Batch ${batchNumber}, Model "${model}" timed out after ${requestTimeoutMs}ms.`);
                if (attempt === modelCandidates.length) throw timeoutError;
                break;
            }
            lastError = e;
            console.warn(`[Embedding] Batch ${batchNumber}, Model "${model}" failed (${attempt}/${modelCandidates.length}): ${e.message}`);
            if (attempt === modelCandidates.length) throw e;
            await sleep(baseDelay * attempt);
            break;
          }
        }
    }
    throw lastError || new Error('No embedding model candidates available');
}

/**
 * 🚀 终极版：并发批量获取 Embeddings
 * 🛡️ 核心保证：返回数组长度 === 输入 texts 长度，跳过/失败的位置填 null
 */
async function getEmbeddingsBatch(texts, config) {
    if (!texts || texts.length === 0) return [];
    const disableBatching = DISABLE_BATCHING;
    const dimensions = Number.isFinite(EMBEDDING_DIMENSIONS) ? EMBEDDING_DIMENSIONS : NaN;
    const maxBatchItems = disableBatching ? 1 : (Number.isFinite(MAX_BATCH_ITEMS) ? MAX_BATCH_ITEMS : DEFAULT_MAX_BATCH_ITEMS);
    const concurrency = disableBatching ? 1 : DEFAULT_CONCURRENCY;

    // 1. ⚡️ 第一步：纯 CPU 操作，先把所有文本切分成 Batches
    //    同时记录每个文本在原始数组中的索引，以便后续对齐
    const batches = [];         // 每个元素: { texts: string[], originalIndices: number[] }
    let currentBatchTexts = [];
    let currentBatchIndices = [];
    let currentBatchTokens = 0;
    const oversizeIndices = new Set(); // 记录被跳过的超长文本位置

    for (let i = 0; i < texts.length; i++) {
        const text = texts[i];
        const textTokens = encoding.encode(text).length;
        if (textTokens > safeMaxTokens) {
            console.warn(`[Embedding] ⚠️ Text at index ${i} exceeds token limit (${textTokens} > ${safeMaxTokens}), skipping.`);
            oversizeIndices.add(i);
            continue; // Skip oversize，但记录位置
        }

        const isTokenFull = currentBatchTexts.length > 0 && (currentBatchTokens + textTokens > safeMaxTokens);
        const isItemFull = currentBatchTexts.length >= maxBatchItems;

        if (isTokenFull || isItemFull) {
            batches.push({ texts: currentBatchTexts, originalIndices: currentBatchIndices });
            currentBatchTexts = [text];
            currentBatchIndices = [i];
            currentBatchTokens = textTokens;
        } else {
            currentBatchTexts.push(text);
            currentBatchIndices.push(i);
            currentBatchTokens += textTokens;
        }
    }
    if (currentBatchTexts.length > 0) {
        batches.push({ texts: currentBatchTexts, originalIndices: currentBatchIndices });
    }

    if (oversizeIndices.size > 0) {
        console.warn(`[Embedding] ⚠️ ${oversizeIndices.size} texts skipped due to token limit.`);
    }
    console.log(`[Embedding] Prepared ${batches.length} batches. Executing with concurrency: ${concurrency}...`);

    // 2. 🌊 第二步：并发执行器
    const batchResults = new Array(batches.length); // 预分配结果数组，保证顺序
    let cursor = 0; // 当前处理到的批次索引

    // 定义 Worker：只要队列里还有任务，就不断抢任务做
    const worker = async (workerId) => {
        while (true) {
            // 🔒 获取任务索引 (原子操作模拟)
            const batchIndex = cursor++;
            if (batchIndex >= batches.length) break; // 没任务了，下班

            const batch = batches[batchIndex];
            try {
                // 执行请求 (Batch ID 从 1 开始显示)
                batchResults[batchIndex] = {
                    vectors: await _sendBatch(batch.texts, config, batchIndex + 1, disableBatching, dimensions),
                    originalIndices: batch.originalIndices
                };
            } catch (e) {
                // 🛡️ 不再让单个 batch 失败导致整个 Promise.all 崩溃
                // 而是记录失败，对应位置将填 null
                console.error(`[Embedding] ❌ Batch ${batchIndex + 1} failed permanently: ${e.message}`);
                batchResults[batchIndex] = {
                    vectors: null, // 标记为失败
                    originalIndices: batch.originalIndices,
                    error: e.message
                };
            }
        }
    };

    // 启动 N 个 Worker
    const workers = [];
    for (let i = 0; i < concurrency; i++) {
        workers.push(worker(i));
    }

    // 等待所有 Worker 下班
    await Promise.all(workers);

    // 3. 📦 第三步：按原始索引回填结果，保证 output.length === input.length
    const finalResults = new Array(texts.length).fill(null); // 默认全部为 null
    let successCount = 0;
    let failCount = 0;

    for (const result of batchResults) {
        if (!result || !result.vectors) {
            // 整个 batch 失败，对应位置保持 null
            if (result) failCount += result.originalIndices.length;
            continue;
        }
        result.originalIndices.forEach((origIdx, vecIdx) => {
            finalResults[origIdx] = result.vectors[vecIdx] || null;
            if (result.vectors[vecIdx]) successCount++;
            else failCount++;
        });
    }

    failCount += oversizeIndices.size; // 超长文本也算失败

    if (failCount > 0) {
        console.warn(`[Embedding] ⚠️ Results: ${successCount} succeeded, ${failCount} failed/skipped out of ${texts.length} total.`);
    }

    return finalResults; // 🛡️ 长度严格等于 texts.length，失败位置为 null
}

/**
 * 余弦相似度计算（公共版本）
 * 供 toolExecutor / messageProcessor / 其他模块复用
 */
function cosineSimilarity(a, b) {
    if (!a || !b || a.length !== b.length) return 0;
    let dot = 0, normA = 0, normB = 0;
    for (let i = 0; i < a.length; i++) {
        dot += a[i] * b[i];
        normA += a[i] * a[i];
        normB += b[i] * b[i];
    }
    return dot / (Math.sqrt(normA) * Math.sqrt(normB) + 1e-8);
}

module.exports = {
    getEmbeddingsBatch,
    cosineSimilarity,
    _getEmbeddingModelCandidates,
    _sendBatch,
    _parseRetryAfterMs,
    _createRequestScheduler
};
