'use strict';

/**
 * Profile 解析层。
 *
 * 一次评估运行的"配置"由三部分合成：
 *   1. profile JSON（eval/profiles/<name>.json）——评估自己的选择：用哪个 embedding 模型、
 *      多少维、指向哪份 rag_params、要覆盖哪些环境变量。
 *   2. 仓库根的 config.env ——真实凭据（API_Key / API_URL）。评估从不把凭据写进任何产物。
 *   3. Plugin/RAGDiaryPlugin/config.env ——Rerank / AIMemo 凭据。这些变量插件自己不会
 *      提升到 process.env（direct 类插件不合并 config.env），所以必须由我们搬进去，
 *      否则 rerank 会静默降级成 slice(0, K) 而看起来"通过"。
 *
 * 关键点：KnowledgeBaseManager 是 require 时构造的单例，构造时就读 process.env。
 * 所以本模块必须在任何 require('../../KnowledgeBaseManager') 之前跑完。
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PROJECT_ROOT = path.resolve(__dirname, '..', '..');
const EVAL_ROOT = path.resolve(__dirname, '..');
const PROFILES_DIR = path.join(EVAL_ROOT, 'profiles');

/** 绝不写进任何产物的变量名片段（大小写不敏感）。 */
const SECRET_PATTERNS = [/key/i, /api(?!_url)/i, /token/i, /secret/i, /password/i, /passwd/i];

function isSecretName(name) {
    return SECRET_PATTERNS.some(re => re.test(name));
}

/** 把敏感值折叠成不可逆但可比对的指纹，用于"两次运行是不是同一把 key"。 */
function fingerprint(value) {
    if (value === undefined || value === null || value === '') return null;
    return `sha256:${crypto.createHash('sha256').update(String(value)).digest('hex').slice(0, 12)}`;
}

/**
 * 解析 KEY=VALUE 形式的 env 文件。
 * 刻意不用 dotenv：dotenv 会写 process.env，而我们需要先看清内容再决定搬哪些。
 */
function parseEnvFile(filePath) {
    const out = {};
    if (!fs.existsSync(filePath)) return out;
    const text = fs.readFileSync(filePath, 'utf-8');
    for (const rawLine of text.split(/\r?\n/)) {
        const line = rawLine.trim();
        if (!line || line.startsWith('#')) continue;
        const eq = line.indexOf('=');
        if (eq <= 0) continue;
        const key = line.slice(0, eq).trim();
        let value = line.slice(eq + 1).trim();
        // 去掉成对引号，保留内部内容
        if (value.length >= 2 && ((value[0] === '"' && value.endsWith('"')) || (value[0] === "'" && value.endsWith("'")))) {
            value = value.slice(1, -1);
        }
        out[key] = value;
    }
    return out;
}

function readJson(filePath) {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
}

function hashOf(value) {
    return crypto.createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
}

function listProfiles() {
    if (!fs.existsSync(PROFILES_DIR)) return [];
    return fs.readdirSync(PROFILES_DIR)
        .filter(f => f.endsWith('.json'))
        .map(f => f.replace(/\.json$/, ''))
        .sort();
}

function profilePath(name) {
    return path.join(PROFILES_DIR, `${name}.json`);
}

/**
 * 载入 profile 并把它解析成一份完整、自洽、可快照的运行配置。
 *
 * 不在这里改 process.env——那是 applyEnv() 的职责，调用方需要能先检查再决定是否应用。
 */
function loadProfile(name = 'default', overrides = {}) {
    const file = profilePath(name);
    if (!fs.existsSync(file)) {
        const available = listProfiles();
        throw new Error(
            `未找到 profile "${name}"（期望路径 ${path.relative(PROJECT_ROOT, file)}）。` +
            (available.length ? ` 可用：${available.join(', ')}` : ' profiles/ 目录为空。')
        );
    }

    const profile = readJson(file);
    const rootEnv = parseEnvFile(path.join(PROJECT_ROOT, 'config.env'));
    const ragEnv = parseEnvFile(path.join(PROJECT_ROOT, 'Plugin', 'RAGDiaryPlugin', 'config.env'));

    const corpusRoot = path.resolve(EVAL_ROOT, profile.corpusRoot || 'dailynote_eval');
    const ragParamsPath = path.resolve(PROJECT_ROOT, profile.ragParamsPath || 'rag_params.json');
    if (!fs.existsSync(ragParamsPath)) {
        throw new Error(`profile "${name}" 指向的 rag_params 不存在：${ragParamsPath}`);
    }
    const ragParams = readJson(ragParamsPath);

    // 凭据来源优先级：真实 process.env > 根 config.env > 插件 config.env。
    // profile 永远不携带凭据。
    const credential = key => process.env[key] || rootEnv[key] || ragEnv[key] || '';

    const embedding = {
        model: profile.embedding?.model || rootEnv.WhitelistEmbeddingModel || '',
        dimension: Number(profile.embedding?.dimension || rootEnv.VECTORDB_DIMENSION || 0),
        // 调低它是让文档分成多 chunk 的唯一实用手段——真写 2 万字语料没必要。
        maxToken: Number(profile.embedding?.maxToken || rootEnv.WhitelistEmbeddingModelMaxToken || 8000),
        apiUrl: credential('API_URL'),
        apiKey: credential('API_Key')
    };

    const rerank = {
        url: credential('RerankUrl'),
        api: credential('RerankApi'),
        model: credential('RerankModel')
    };

    // 这些默认值不是品味问题，是让评估能跑完的硬要求：
    //  - DERIVED_STARTUP_COOLDOWN_MS 默认 300000，不压低则首次 artifact 构建要干等 5 分钟，
    //    预热必然超时，TagMemo / RiverMemo 全部用例的结论都不可信
    //  - TAGMEMO_MATRIX_REBUILD_QUIET_MS 默认 300000，同上
    //  - RAG_QUERY_CACHE_ENABLED 默认开，会让冷启动时的空结果被缓存并在计分时重放
    //  - FULL_SCAN_ON_STARTUP 必须开，否则语料根本不进索引
    //
    // 注意 cooldown 用 '1' 而不是 '0'：KnowledgeBaseManager.js:90 写的是
    //   parseInt(process.env.KNOWLEDGEBASE_DERIVED_STARTUP_COOLDOWN_MS, 10) || 5 * 60 * 1000
    // 而 parseInt('0') === 0 是 falsy，会被 || 吞掉并落回 5 分钟默认值。
    // 传 '0' 的效果与不传完全一样 —— 这个坑已经害预热超时过一次。
    const env = {
        KNOWLEDGEBASE_ROOT_PATH: corpusRoot,
        KNOWLEDGEBASE_FULL_SCAN_ON_STARTUP: 'true',
        KNOWLEDGEBASE_DERIVED_STARTUP_COOLDOWN_MS: '1',
        TAGMEMO_MATRIX_REBUILD_QUIET_MS: '1000',
        RAG_QUERY_CACHE_ENABLED: 'false',
        WhitelistEmbeddingModel: embedding.model,
        WhitelistEmbeddingModelMaxToken: String(embedding.maxToken),
        VECTORDB_DIMENSION: String(embedding.dimension),
        EMBEDDING_DIMENSIONS: String(embedding.dimension),
        API_URL: embedding.apiUrl,
        API_Key: embedding.apiKey,
        PROJECT_BASE_PATH: PROJECT_ROOT,
        ...(rerank.url ? { RerankUrl: rerank.url, RerankApi: rerank.api, RerankModel: rerank.model } : {}),
        ...(profile.env || {}),
        ...(overrides.env || {})
    };

    return {
        name,
        profileFile: file,
        raw: profile,
        description: profile.description || '',
        projectRoot: PROJECT_ROOT,
        evalRoot: EVAL_ROOT,
        corpusRoot,
        ragParamsPath,
        ragParams,
        ragParamsHash: hashOf(ragParams),
        embedding,
        rerank,
        env,
        // storePath 每次运行都不同（落在 run 目录里），由 runstore 注入。
        storePath: null
    };
}

/**
 * 把解析结果写进 process.env。必须在 require KnowledgeBaseManager 之前调用。
 */
function applyEnv(resolved) {
    for (const [key, value] of Object.entries(resolved.env)) {
        if (value === undefined || value === null || value === '') continue;
        process.env[key] = String(value);
    }
    if (resolved.storePath) {
        process.env.KNOWLEDGEBASE_STORE_PATH = resolved.storePath;
    }
    return resolved;
}

/**
 * 生成可安全落盘的配置快照：结构完整，凭据只留指纹。
 * 这是需求"保存评估时的配置"的载体——看到快照就能知道这次用了哪个模型、哪些参数。
 */
function snapshotConfig(resolved) {
    const env = {};
    for (const [key, value] of Object.entries(resolved.env)) {
        env[key] = isSecretName(key) ? fingerprint(value) : value;
    }
    return {
        profile: resolved.name,
        description: resolved.description,
        corpusRoot: path.relative(resolved.projectRoot, resolved.corpusRoot),
        storePath: resolved.storePath ? path.relative(resolved.projectRoot, resolved.storePath) : null,
        ragParamsPath: path.relative(resolved.projectRoot, resolved.ragParamsPath),
        ragParamsHash: resolved.ragParamsHash,
        embedding: {
            model: resolved.embedding.model,
            dimension: resolved.embedding.dimension,
            maxToken: resolved.embedding.maxToken,
            apiUrl: resolved.embedding.apiUrl,
            apiKeyFingerprint: fingerprint(resolved.embedding.apiKey)
        },
        rerank: {
            url: resolved.rerank.url || null,
            model: resolved.rerank.model || null,
            apiFingerprint: fingerprint(resolved.rerank.api)
        },
        env
    };
}

module.exports = {
    PROJECT_ROOT,
    EVAL_ROOT,
    PROFILES_DIR,
    loadProfile,
    applyEnv,
    snapshotConfig,
    listProfiles,
    parseEnvFile,
    readJson,
    hashOf,
    fingerprint,
    isSecretName
};
