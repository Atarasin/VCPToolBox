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
    createAuditLogger
} = require('../infra/auditLogger');

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

function getBridgeConfig(pluginManager) {
    return pluginManager?.openClawBridgeConfig ||
        pluginManager?.openClawBridge?.config ||
        pluginManager?.openClawBridge ||
        {};
}

function getRagConfig(pluginManager) {
    const bridgeConfig = getBridgeConfig(pluginManager);
    const ragConfig = parseMemoryJsonObject(bridgeConfig.rag, bridgeConfig.rag || {});
    const configuredAgentDiaryMap = parseMemoryJsonObject(ragConfig.agentDiaryMap, {});
    const envAgentDiaryMap = parseMemoryJsonObject(process.env.OPENCLAW_RAG_AGENT_DIARY_MAP, {});
    const rawAllowCrossRoleAccess = ragConfig.allowCrossRoleAccess !== undefined
        ? ragConfig.allowCrossRoleAccess
        : process.env.OPENCLAW_RAG_ALLOW_CROSS_ROLE_ACCESS;
    const defaultDiaries = normalizeMemoryStringArray(
        ragConfig.defaultDiaries !== undefined
            ? ragConfig.defaultDiaries
            : process.env.OPENCLAW_RAG_DEFAULT_DIARIES
    );
    const agentDiaryMap = Object.keys(configuredAgentDiaryMap).length > 0
        ? configuredAgentDiaryMap
        : envAgentDiaryMap;

    return {
        agentDiaryMap,
        defaultDiaries,
        allowCrossRoleAccess: parseMemoryBoolean(rawAllowCrossRoleAccess, false),
        hasExplicitPolicy: (
            Object.keys(agentDiaryMap).length > 0 ||
            defaultDiaries.length > 0 ||
            rawAllowCrossRoleAccess !== undefined
        )
    };
}

function buildAgentAliases(agentId, maid) {
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
    addAlias(maid);
    return aliases;
}

function collectConfiguredDiaries(agentId, maid, ragConfig) {
    const agentAliases = buildAgentAliases(agentId, maid);
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

function isDiaryAllowed({ diaryName, agentId, maid, ragConfig }) {
    const normalizedDiaryName = normalizeMemoryString(diaryName);
    if (!normalizedDiaryName) {
        return false;
    }
    if (ragConfig.allowCrossRoleAccess) {
        return true;
    }

    const { agentAliases, configuredDiaries } = collectConfiguredDiaries(agentId, maid, ragConfig);
    if (configuredDiaries.size > 0) {
        return configuredDiaries.has(normalizedDiaryName);
    }
    if (ragConfig.hasExplicitPolicy) {
        return agentAliases.has(normalizedDiaryName);
    }
    return true;
}

function getMemoryWritePluginInfo(pluginManager) {
    const resolvePlugin = (pluginName) =>
        pluginManager?.getPlugin?.(pluginName) || pluginManager?.plugins?.get?.(pluginName) || null;
    const dailyNotePlugin = resolvePlugin('DailyNote');
    if (dailyNotePlugin) {
        return {
            name: 'DailyNote',
            executionMode: 'tool'
        };
    }
    return null;
}

function getMemoryWriteStore(pluginManager) {
    if (!pluginManager.__openClawMemoryWriteStore) {
        pluginManager.__openClawMemoryWriteStore = {
            entriesByIdempotencyKey: new Map(),
            entriesByFingerprint: new Map()
        };
    }
    return pluginManager.__openClawMemoryWriteStore;
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

function buildMemoryWriteMaid({ diaryName, target, requestContext }) {
    const requestedAuthor = normalizeMemoryString(
        target?.maid ||
        target?.author ||
        target?.agent ||
        requestContext?.agentId ||
        requestContext?.source
    ) || 'OpenClaw';
    const normalizedAuthor = requestedAuthor.replace(/^\[[^\]]*\]/, '').trim() || 'OpenClaw';
    return `[${diaryName}]${normalizedAuthor}`;
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
function createMemoryRuntimeService(deps = {}) {
    const pluginManager = deps.pluginManager;
    if (!pluginManager) {
        throw new Error('[MemoryRuntimeService] pluginManager is required');
    }

    const auditLogger = deps.auditLogger || createAuditLogger();
    const mapWriteError = deps.mapMemoryWriteError || mapOpenClawMemoryWriteError;
    const authContextResolver = typeof deps.authContextResolver === 'function'
        ? deps.authContextResolver
        : null;
    const agentPolicyResolver = deps.agentPolicyResolver &&
        typeof deps.agentPolicyResolver.resolvePolicy === 'function'
        ? deps.agentPolicyResolver
        : null;
    const diaryScopeGuard = typeof deps.diaryScopeGuard === 'function'
        ? deps.diaryScopeGuard
        : null;

    return {
        async writeMemory({ body, startedAt, clientIp, defaultSource }) {
            const requestContext = normalizeMemoryRequestContext(body?.requestContext, defaultSource);
            const authContext = authContextResolver
                ? authContextResolver({
                    authContext: body?.authContext,
                    requestContext,
                    maid: body?.target?.maid,
                    adapter: requestContext.runtime
                })
                : requestContext;
            const requestId = requestContext.requestId;
            const agentId = requestContext.agentId;
            const sessionId = requestContext.sessionId;
            const source = requestContext.source;
            const target = body?.target && typeof body.target === 'object' ? body.target : {};
            const memory = body?.memory && typeof body.memory === 'object' ? body.memory : {};
            const options = body?.options && typeof body.options === 'object' ? body.options : {};
            const targetDiary = normalizeMemoryString(target.diary || body?.diary);
            const memoryText = normalizeMemoryContentText(memory.text || body?.text || body?.memoryText);
            const deduplicate = parseMemoryBoolean(options.deduplicate, true);
            const idempotencyKey = normalizeMemoryString(options.idempotencyKey || body?.idempotencyKey);
            const tags = normalizeMemoryTags(memory.tags || body?.tags);
            const metadata = memory.metadata || body?.metadata || body?.sourceMetadata;

            if (!agentId || !sessionId) {
                return {
                    success: false,
                    requestId,
                    status: 400,
                    code: OPENCLAW_ERROR_CODES.INVALID_REQUEST,
                    error: 'requestContext.agentId and requestContext.sessionId are required',
                    details: { field: 'requestContext' }
                };
            }
            if (!targetDiary) {
                return {
                    success: false,
                    requestId,
                    status: 400,
                    code: OPENCLAW_ERROR_CODES.MEMORY_INVALID_PAYLOAD,
                    error: 'target.diary is required',
                    details: { field: 'target.diary' }
                };
            }
            if (!memoryText) {
                return {
                    success: false,
                    requestId,
                    status: 400,
                    code: OPENCLAW_ERROR_CODES.MEMORY_INVALID_PAYLOAD,
                    error: 'memory.text is required',
                    details: { field: 'memory.text' }
                };
            }
            if (tags.length === 0) {
                return {
                    success: false,
                    requestId,
                    status: 400,
                    code: OPENCLAW_ERROR_CODES.MEMORY_INVALID_PAYLOAD,
                    error: 'memory.tags is required',
                    details: { field: 'memory.tags' }
                };
            }

            try {
                if (agentPolicyResolver && diaryScopeGuard) {
                    const policy = await agentPolicyResolver.resolvePolicy({
                        authContext,
                        availableDiaries: [targetDiary]
                    });
                    diaryScopeGuard({
                        policy,
                        diaryName: targetDiary,
                        authContext
                    });
                } else {
                    const ragConfig = getRagConfig(pluginManager);
                    if (!isDiaryAllowed({ diaryName: targetDiary, agentId, maid: target.maid, ragConfig })) {
                        throw new Error('Requested diary target is not allowed for this agent');
                    }
                }
            } catch (error) {
                return {
                    success: false,
                    requestId,
                    status: 403,
                    code: OPENCLAW_ERROR_CODES.MEMORY_TARGET_FORBIDDEN,
                    error: 'Requested diary target is not allowed for this agent',
                    details: {
                        diary: targetDiary,
                        agentId,
                        canonicalCode: error.code || ''
                    }
                };
            }

            const memoryWriter = getMemoryWritePluginInfo(pluginManager);
            if (!memoryWriter) {
                return {
                    success: false,
                    requestId,
                    status: 500,
                    code: OPENCLAW_ERROR_CODES.MEMORY_WRITE_ERROR,
                    error: 'DailyNote is required for diary memory write',
                    details: { supportedPlugins: ['DailyNote'] }
                };
            }

            const { timestamp, dateString, timeLabel } = resolveMemoryDateParts(memory.timestamp || body?.timestamp);
            const fingerprint = createMemoryFingerprint({
                diaryName: targetDiary,
                text: memoryText,
                tags,
                agentId,
                source,
                metadata
            });
            const memoryStore = getMemoryWriteStore(pluginManager);
            const duplicateRecord = resolveMemoryDuplicate(memoryStore, {
                idempotencyKey,
                fingerprint,
                deduplicate
            });

            auditLogger.logMemory('write.started', {
                requestId,
                source,
                agentId,
                sessionId,
                diary: targetDiary,
                deduplicate,
                hasIdempotencyKey: Boolean(idempotencyKey)
            });

            if (duplicateRecord) {
                auditLogger.logMemory('write.duplicate', {
                    requestId,
                    source,
                    agentId,
                    sessionId,
                    diary: targetDiary,
                    entryId: duplicateRecord.entryId
                }, startedAt);
                return {
                    success: true,
                    requestId,
                    data: {
                        writeStatus: 'skipped_duplicate',
                        diary: duplicateRecord.diary,
                        entryId: duplicateRecord.entryId,
                        deduplicated: true,
                        filePath: duplicateRecord.filePath || '',
                        timestamp: duplicateRecord.timestamp || timestamp
                    },
                    audit: {
                        writer: memoryWriter.name,
                        source,
                        agentId,
                        sessionId
                    }
                };
            }

            try {
                const maid = buildMemoryWriteMaid({
                    diaryName: targetDiary,
                    target,
                    requestContext
                });
                const content = buildMemoryWriteContent({
                    text: memoryText,
                    timeLabel,
                    metadata
                });
                const tagLine = `Tag: ${tags.join(', ')}`;
                const bridgeToolName = normalizeMemoryString(options?.bridgeToolName);
                const writeResult = await pluginManager.processToolCall('DailyNote', {
                    command: 'create',
                    maid,
                    Date: dateString,
                    Content: content,
                    Tag: tagLine,
                    __agentGatewayContext: createMemoryAgentGatewayContext(requestContext, {
                        toolName: 'DailyNote',
                        ...(bridgeToolName ? { bridgeToolName } : {})
                    }),
                    __openclawContext: {
                        source,
                        agentId,
                        sessionId,
                        requestId
                    }
                }, clientIp);
                const filePath = extractMemoryWritePath(writeResult);
                const entryId = createMemoryEntryId({
                    diaryName: targetDiary,
                    filePath,
                    fingerprint,
                    timestamp
                });
                const persistedRecord = {
                    idempotencyKey,
                    fingerprint,
                    diary: targetDiary,
                    entryId,
                    filePath,
                    timestamp
                };
                rememberMemoryWrite(memoryStore, persistedRecord);

                auditLogger.logMemory('write.completed', {
                    requestId,
                    source,
                    agentId,
                    sessionId,
                    diary: targetDiary,
                    entryId,
                    writer: memoryWriter.name
                }, startedAt);

                return {
                    success: true,
                    requestId,
                    data: {
                        writeStatus: 'created',
                        diary: targetDiary,
                        entryId,
                        deduplicated: false,
                        filePath,
                        timestamp
                    },
                    audit: {
                        writer: memoryWriter.name,
                        source,
                        agentId,
                        sessionId
                    }
                };
            } catch (error) {
                console.error('[AgentGatewayMemoryRuntime] Error writing gateway memory:', error);
                const mappedError = mapWriteError(error);
                auditLogger.logMemory('write.failed', {
                    requestId,
                    source,
                    agentId,
                    sessionId,
                    diary: targetDiary,
                    code: mappedError.code
                }, startedAt);
                return {
                    success: false,
                    requestId,
                    status: mappedError.status,
                    code: mappedError.code,
                    error: mappedError.error,
                    details: mappedError.details
                };
            }
        }
    };
}

module.exports = {
    createMemoryRuntimeService
};
