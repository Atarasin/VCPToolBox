const crypto = require('crypto');
const {
    normalizeRequestContext
} = require('../contracts/requestContext');
const {
    OPENCLAW_ERROR_CODES
} = require('../contracts/errorCodes');
const {
    mapOpenClawMemoryWriteError
} = require('../infra/errorMapper');
const {
    resolveConfiguredAgentMemoryPolicy
} = require('../policy/mcpAgentMemoryPolicy');

function normalizeMemoryString(value) {
    return typeof value === 'string' ? value.trim() : '';
}

function normalizeMemoryStringArray(value) {
    if (Array.isArray(value)) {
        return value
            .map((item) => normalizeMemoryString(item))
            .filter(Boolean);
    }
    if (typeof value === 'string') {
        return value
            .split(',')
            .map((item) => item.trim())
            .filter(Boolean);
    }
    return [];
}

function normalizeMemoryContentText(content) {
    if (typeof content === 'string') {
        return content.trim();
    }
    if (Array.isArray(content)) {
        return content
            .map((entry) => {
                if (typeof entry === 'string') {
                    return entry.trim();
                }
                if (entry && typeof entry === 'object') {
                    return normalizeMemoryString(entry.text || entry.content || entry.value);
                }
                return '';
            })
            .filter(Boolean)
            .join('\n');
    }
    if (content && typeof content === 'object') {
        return normalizeMemoryString(content.text || content.content || content.value);
    }
    return '';
}

function parseMemoryBoolean(value, defaultValue = false) {
    if (value === undefined) {
        return defaultValue;
    }
    if (typeof value === 'boolean') {
        return value;
    }
    if (typeof value === 'string') {
        const normalizedValue = value.trim().toLowerCase();
        if (normalizedValue === 'true') {
            return true;
        }
        if (normalizedValue === 'false') {
            return false;
        }
    }
    return defaultValue;
}

function parseMemoryJsonObject(value, fallbackValue = {}) {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
        return value;
    }
    if (typeof value !== 'string' || !value.trim()) {
        return fallbackValue;
    }
    try {
        const parsedValue = JSON.parse(value);
        return parsedValue && typeof parsedValue === 'object' && !Array.isArray(parsedValue)
            ? parsedValue
            : fallbackValue;
    } catch (error) {
        return fallbackValue;
    }
}

function normalizeMemoryRequestContext(input, defaultSource) {
    return normalizeRequestContext(input, {
        defaultSource,
        defaultRuntime: 'openclaw',
        requestIdPrefix: 'ocw'
    });
}

function createMemoryAgentGatewayContext(requestContext, extra = {}) {
    return {
        runtime: requestContext.runtime,
        source: requestContext.source,
        agentId: requestContext.agentId,
        sessionId: requestContext.sessionId,
        requestId: requestContext.requestId,
        ...extra
    };
}

function buildAgentAliases(agentId) {
    const aliases = new Set();
    const addAlias = (value) => {
        const normalizedValue = normalizeMemoryString(value);
        if (!normalizedValue) {
            return;
        }
        aliases.add(normalizedValue);
        normalizedValue
            .split(/[./:\\]/)
            .map((segment) => segment.trim())
            .filter(Boolean)
            .forEach((segment) => aliases.add(segment));
    };

    addAlias(agentId);
    return aliases;
}

function collectConfiguredDiaries(agentId, ragConfig) {
    const agentAliases = buildAgentAliases(agentId);
    const configuredDiaries = new Set();

    for (const alias of agentAliases) {
        normalizeMemoryStringArray(ragConfig.agentDiaryMap?.[alias])
            .forEach((diaryName) => configuredDiaries.add(diaryName));
    }
    normalizeMemoryStringArray(ragConfig.agentDiaryMap?.['*'])
        .forEach((diaryName) => configuredDiaries.add(diaryName));
    normalizeMemoryStringArray(ragConfig.defaultDiaries)
        .forEach((diaryName) => configuredDiaries.add(diaryName));

    return {
        agentAliases,
        configuredDiaries
    };
}

function isDiaryAllowed({ diaryName, agentId, ragConfig }) {
    const normalizedDiaryName = normalizeMemoryString(diaryName);
    if (!normalizedDiaryName) {
        return false;
    }
    if (ragConfig.allowCrossRoleAccess) {
        return true;
    }

    const { agentAliases, configuredDiaries } = collectConfiguredDiaries(agentId, ragConfig);
    if (configuredDiaries.size > 0) {
        return configuredDiaries.has(normalizedDiaryName);
    }
    if (ragConfig.hasExplicitPolicy) {
        return agentAliases.has(normalizedDiaryName);
    }
    return true;
}

function normalizeMemoryTags(tags) {
    const normalizedTags = [...new Set(normalizeMemoryStringArray(tags))];
    return normalizedTags.slice(0, 16);
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

function resolveMemoryDateParts(timestampValue) {
    const normalizedTimestamp = normalizeTimestampValue(timestampValue);
    const resolvedDate = normalizedTimestamp ? new Date(normalizedTimestamp) : new Date();
    const pad = (value) => value.toString().padStart(2, '0');
    return {
        timestamp: resolvedDate.toISOString(),
        dateString: `${resolvedDate.getFullYear()}-${pad(resolvedDate.getMonth() + 1)}-${pad(resolvedDate.getDate())}`,
        timeLabel: `${pad(resolvedDate.getHours())}:${pad(resolvedDate.getMinutes())}`
    };
}

function buildMemoryWriteMaid({ diaryName, agentId }) {
    const configuredPolicy = resolveConfiguredAgentMemoryPolicy({ agentId });
    const configuredMaid = normalizeMemoryString(configuredPolicy.maid);
    if (!configuredMaid) {
        return '';
    }
    const requestedAuthor = normalizeMemoryString(
        configuredMaid
    );
    return `[${diaryName}]${requestedAuthor}`;
}

function normalizeMemoryMetadata(metadata) {
    if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {
        return {};
    }

    const normalizedMetadata = {};
    for (const [rawKey, rawValue] of Object.entries(metadata)) {
        const key = normalizeMemoryString(rawKey);
        if (!key || rawValue === undefined || rawValue === null) {
            continue;
        }
        if (typeof rawValue === 'string') {
            const value = normalizeMemoryString(rawValue);
            if (value) {
                normalizedMetadata[key] = value.slice(0, 500);
            }
            continue;
        }
        if (typeof rawValue === 'number' || typeof rawValue === 'boolean') {
            normalizedMetadata[key] = rawValue;
            continue;
        }
        try {
            const serializedValue = JSON.stringify(rawValue);
            if (serializedValue) {
                normalizedMetadata[key] = serializedValue.slice(0, 500);
            }
        } catch (error) {
        }
    }

    return normalizedMetadata;
}

function buildMemoryWriteContent({ text, timeLabel, metadata }) {
    const normalizedText = normalizeMemoryContentText(text);
    if (!normalizedText) {
        return '';
    }

    const lines = [];
    const textWithTime = /^\[\d{2}:\d{2}(?::\d{2})?\]/.test(normalizedText)
        ? normalizedText
        : `[${timeLabel}] ${normalizedText}`;
    lines.push(textWithTime);

    const normalizedMetadata = normalizeMemoryMetadata(metadata);
    for (const [key, value] of Object.entries(normalizedMetadata)) {
        const renderedValue = typeof value === 'string' ? value : JSON.stringify(value);
        lines.push(`Meta-${key}: ${renderedValue}`);
    }

    return lines.join('\n');
}

function createMemoryFingerprint({ diaryName, text, tags, agentId, source, metadata }) {
    const fingerprintPayload = JSON.stringify({
        diaryName: normalizeMemoryString(diaryName),
        text: normalizeMemoryContentText(text),
        tags: normalizeMemoryTags(tags),
        agentId: normalizeMemoryString(agentId),
        source: normalizeMemoryString(source),
        metadata: normalizeMemoryMetadata(metadata)
    });
    return crypto.createHash('sha256').update(fingerprintPayload).digest('hex');
}

function resolveMemoryDuplicate(memoryStore, { idempotencyKey, fingerprint, deduplicate }) {
    if (idempotencyKey && memoryStore.entriesByIdempotencyKey.has(idempotencyKey)) {
        return memoryStore.entriesByIdempotencyKey.get(idempotencyKey);
    }
    if (deduplicate && memoryStore.entriesByFingerprint.has(fingerprint)) {
        return memoryStore.entriesByFingerprint.get(fingerprint);
    }
    return null;
}

function rememberMemoryWrite(memoryStore, record) {
    if (record.idempotencyKey) {
        memoryStore.entriesByIdempotencyKey.set(record.idempotencyKey, record);
    }
    memoryStore.entriesByFingerprint.set(record.fingerprint, record);
}

function extractMemoryWritePath(result) {
    const candidates = [
        result?.filePath,
        result?.path,
        result?.savedPath,
        result?.output?.filePath,
        result?.output?.path,
        result?.data?.filePath
    ];
    for (const candidate of candidates) {
        const normalizedCandidate = normalizeMemoryString(candidate);
        if (normalizedCandidate) {
            return normalizedCandidate;
        }
    }

    const rawMessage = normalizeMemoryString(
        result?.message ||
        result?.result ||
        result?.output?.message ||
        result?.data?.message
    );
    if (!rawMessage) {
        return '';
    }

    const pathMatches = rawMessage.match(/(?:saved to|file(?:\s+path)?[:=])\s+([^\s]+(?:\/[^\s]+)*)/i);
    if (!pathMatches) {
        return '';
    }
    return normalizeMemoryString(pathMatches[1]);
}

function createMemoryEntryId({ diaryName, filePath, fingerprint, timestamp }) {
    return crypto.createHash('sha256')
        .update([
            normalizeMemoryString(diaryName),
            normalizeMemoryString(filePath),
            normalizeMemoryString(fingerprint),
            normalizeMemoryString(timestamp)
        ].join('::'))
        .digest('hex')
        .slice(0, 24);
}

/**
 * MemoryRuntimeService 统一接管 durable memory 写回与幂等逻辑。
 */
function memoryFailure(ctx, status, code, error, field) {
    return { success: false, requestId: ctx.requestId, status, code, error, details: { field } };
}

function normalizeWriteRequest(state, { body, startedAt, clientIp, defaultSource }) {
    const requestContext = normalizeMemoryRequestContext(body?.requestContext, defaultSource);
    const authContext = state.authContextResolver
        ? state.authContextResolver({ authContext: body?.authContext, requestContext, adapter: requestContext.runtime })
        : requestContext;
    const target = body?.target && typeof body.target === 'object' ? body.target : {};
    const memory = body?.memory && typeof body.memory === 'object' ? body.memory : {};
    const options = body?.options && typeof body.options === 'object' ? body.options : {};
    const ctx = {
        body, startedAt, clientIp, requestContext, authContext, options,
        requestId: requestContext.requestId, agentId: requestContext.agentId,
        sessionId: requestContext.sessionId, source: requestContext.source,
        targetDiary: normalizeMemoryString(target.diary || body?.diary),
        memoryText: normalizeMemoryContentText(memory.text || body?.text || body?.memoryText),
        deduplicate: parseMemoryBoolean(options.deduplicate, true),
        idempotencyKey: normalizeMemoryString(options.idempotencyKey || body?.idempotencyKey),
        tags: normalizeMemoryTags(memory.tags || body?.tags),
        metadata: memory.metadata || body?.metadata || body?.sourceMetadata,
        timestampInput: memory.timestamp || body?.timestamp
    };
    if (!ctx.agentId || !ctx.sessionId) return { failure: memoryFailure(ctx, 400, OPENCLAW_ERROR_CODES.INVALID_REQUEST, 'requestContext.agentId and requestContext.sessionId are required', 'requestContext') };
    if (!ctx.targetDiary) return { failure: memoryFailure(ctx, 400, OPENCLAW_ERROR_CODES.MEMORY_INVALID_PAYLOAD, 'target.diary is required', 'target.diary') };
    if (!ctx.memoryText) return { failure: memoryFailure(ctx, 400, OPENCLAW_ERROR_CODES.MEMORY_INVALID_PAYLOAD, 'memory.text is required', 'memory.text') };
    if (!ctx.tags.length) return { failure: memoryFailure(ctx, 400, OPENCLAW_ERROR_CODES.MEMORY_INVALID_PAYLOAD, 'memory.tags is required', 'memory.tags') };
    return { ctx };
}

async function authorizeWrite(state, ctx) {
    try {
        if (state.agentPolicyResolver && state.diaryScopeGuard) {
            const policy = await state.agentPolicyResolver.resolvePolicy({
                authContext: ctx.authContext, availableDiaries: [ctx.targetDiary]
            });
            state.diaryScopeGuard({ policy, diaryName: ctx.targetDiary, authContext: ctx.authContext });
        } else if (!isDiaryAllowed({
            diaryName: ctx.targetDiary, agentId: ctx.agentId, ragConfig: state.ragConfig
        })) {
            throw new Error('Requested diary target is not allowed for this agent');
        }
        return null;
    } catch (error) {
        return {
            success: false, requestId: ctx.requestId, status: 403,
            code: OPENCLAW_ERROR_CODES.MEMORY_TARGET_FORBIDDEN,
            error: 'Requested diary target is not allowed for this agent',
            details: { diary: ctx.targetDiary, agentId: ctx.agentId, canonicalCode: error.code || '' }
        };
    }
}

function prepareWrite(state, ctx) {
    const memoryWriter = state.diaryStorePort.available ? state.diaryStorePort.getWriter() : null;
    if (!memoryWriter) {
        return { failure: {
            success: false, requestId: ctx.requestId, status: 500,
            code: OPENCLAW_ERROR_CODES.MEMORY_WRITE_ERROR,
            error: 'DailyNote is required for diary memory write', details: { supportedPlugins: ['DailyNote'] }
        } };
    }
    const date = resolveMemoryDateParts(ctx.timestampInput);
    const fingerprint = createMemoryFingerprint({
        diaryName: ctx.targetDiary, text: ctx.memoryText, tags: ctx.tags,
        agentId: ctx.agentId, source: ctx.source, metadata: ctx.metadata
    });
    const memoryStore = state.memoryStore;
    const duplicate = resolveMemoryDuplicate(memoryStore, {
        idempotencyKey: ctx.idempotencyKey, fingerprint, deduplicate: ctx.deduplicate
    });
    return { prepared: { ...ctx, ...date, fingerprint, memoryStore, memoryWriter, duplicate } };
}

function buildDuplicateResult(state, ctx) {
    state.auditLogger.logMemory('write.duplicate', {
        requestId: ctx.requestId, source: ctx.source, agentId: ctx.agentId,
        sessionId: ctx.sessionId, diary: ctx.targetDiary, entryId: ctx.duplicate.entryId
    }, ctx.startedAt);
    return {
        success: true, requestId: ctx.requestId,
        data: {
            writeStatus: 'skipped_duplicate', diary: ctx.duplicate.diary,
            entryId: ctx.duplicate.entryId, deduplicated: true,
            filePath: ctx.duplicate.filePath || '', timestamp: ctx.duplicate.timestamp || ctx.timestamp
        },
        audit: { writer: ctx.memoryWriter.name, source: ctx.source, agentId: ctx.agentId, sessionId: ctx.sessionId }
    };
}

async function persistWrite(state, ctx) {
    const maid = buildMemoryWriteMaid({ diaryName: ctx.targetDiary, agentId: ctx.agentId });
    if (!maid) {
        return {
            success: false, requestId: ctx.requestId, status: 500,
            code: OPENCLAW_ERROR_CODES.MEMORY_WRITE_ERROR,
            error: 'Configured memory write maid is required for this agent',
            details: { agentId: ctx.agentId, policySource: 'mcp_agent_memory_policy' }
        };
    }
    const bridgeToolName = normalizeMemoryString(ctx.options?.bridgeToolName);
    const writeArgs = {
        command: 'create', maid, Date: ctx.dateString,
        Content: buildMemoryWriteContent({ text: ctx.memoryText, timeLabel: ctx.timeLabel, metadata: ctx.metadata }),
        Tag: 'Tag: ' + ctx.tags.join(', '),
        __agentGatewayContext: createMemoryAgentGatewayContext(ctx.requestContext, {
            toolName: 'DailyNote', ...(bridgeToolName ? { bridgeToolName } : {})
        }),
        __openclawContext: {
            source: ctx.source, agentId: ctx.agentId, sessionId: ctx.sessionId, requestId: ctx.requestId
        }
    };
    const writeResult = await state.diaryStorePort.invoke(writeArgs, ctx.clientIp);
    const filePath = extractMemoryWritePath(writeResult);
    const entryId = createMemoryEntryId({
        diaryName: ctx.targetDiary, filePath, fingerprint: ctx.fingerprint, timestamp: ctx.timestamp
    });
    rememberMemoryWrite(ctx.memoryStore, {
        idempotencyKey: ctx.idempotencyKey, fingerprint: ctx.fingerprint,
        diary: ctx.targetDiary, entryId, filePath, timestamp: ctx.timestamp
    });
    state.auditLogger.logMemory('write.completed', {
        requestId: ctx.requestId, source: ctx.source, agentId: ctx.agentId,
        sessionId: ctx.sessionId, diary: ctx.targetDiary, entryId, writer: ctx.memoryWriter.name
    }, ctx.startedAt);
    return {
        success: true, requestId: ctx.requestId,
        data: { writeStatus: 'created', diary: ctx.targetDiary, entryId, deduplicated: false, filePath, timestamp: ctx.timestamp },
        audit: { writer: ctx.memoryWriter.name, source: ctx.source, agentId: ctx.agentId, sessionId: ctx.sessionId }
    };
}

async function writeMemory(state, input) {
    const normalized = normalizeWriteRequest(state, input);
    if (normalized.failure) return normalized.failure;
    const denied = await authorizeWrite(state, normalized.ctx);
    if (denied) return denied;
    const prepared = prepareWrite(state, normalized.ctx);
    if (prepared.failure) return prepared.failure;
    const ctx = prepared.prepared;
    state.auditLogger.logMemory('write.started', {
        requestId: ctx.requestId, source: ctx.source, agentId: ctx.agentId, sessionId: ctx.sessionId,
        diary: ctx.targetDiary, deduplicate: ctx.deduplicate, hasIdempotencyKey: Boolean(ctx.idempotencyKey)
    });
    if (ctx.duplicate) return buildDuplicateResult(state, ctx);
    try {
        return await persistWrite(state, ctx);
    } catch (error) {
        console.error('[AgentGatewayMemoryRuntime] Error writing gateway memory:', error);
        const mapped = state.mapWriteError(error);
        state.auditLogger.logMemory('write.failed', {
            requestId: ctx.requestId, source: ctx.source, agentId: ctx.agentId,
            sessionId: ctx.sessionId, diary: ctx.targetDiary, code: mapped.code
        }, ctx.startedAt);
        return { success: false, requestId: ctx.requestId, status: mapped.status, code: mapped.code, error: mapped.error, details: mapped.details };
    }
}

function createMemoryRuntimeService(deps = {}) {
    if (!deps.diaryStorePort || typeof deps.diaryStorePort.available !== 'boolean') {
        throw new Error('[MemoryRuntimeService] diaryStorePort is required');
    }
    const state = {
        diaryStorePort: deps.diaryStorePort,
        ragConfig: deps.ragConfig || {},
        memoryStore: {
            entriesByIdempotencyKey: new Map(),
            entriesByFingerprint: new Map()
        },
        auditLogger: deps.auditLogger || { logMemory() {} },
        mapWriteError: deps.mapMemoryWriteError || mapOpenClawMemoryWriteError,
        authContextResolver: typeof deps.authContextResolver === 'function' ? deps.authContextResolver : null,
        agentPolicyResolver: deps.agentPolicyResolver?.resolvePolicy ? deps.agentPolicyResolver : null,
        diaryScopeGuard: typeof deps.diaryScopeGuard === 'function' ? deps.diaryScopeGuard : null
    };
    return { writeMemory: (input) => writeMemory(state, input) };
}

module.exports = {
    createMemoryRuntimeService
};
