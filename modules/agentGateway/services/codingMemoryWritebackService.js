const {
    normalizeRequestContext
} = require('../contracts/requestContext');
const {
    AGW_ERROR_CODES
} = require('../contracts/errorCodes');
const {
    createAuditLogger
} = require('../infra/auditLogger');

const DEFAULT_SOURCE = 'agent-gateway-coding-memory-writeback';

function normalizeCodingString(value, maxLength = 512) {
    return typeof value === 'string'
        ? value.trim().slice(0, maxLength)
        : '';
}

function normalizeCodingText(value, maxLength = 4000) {
    if (typeof value === 'string') {
        return normalizeCodingString(value, maxLength);
    }
    if (value && typeof value === 'object' && !Array.isArray(value)) {
        return normalizeCodingString(
            value.text ||
            value.content ||
            value.value ||
            value.summary ||
            value.description,
            maxLength
        );
    }
    return '';
}

function normalizeCodingStringArray(value, mapper) {
    if (Array.isArray(value)) {
        return value
            .map((entry) => {
                if (typeof mapper === 'function') {
                    return normalizeCodingString(mapper(entry));
                }
                return normalizeCodingString(entry);
            })
            .filter(Boolean);
    }
    if (typeof value === 'string') {
        return value
            .split(/\r?\n|,/)
            .map((entry) => normalizeCodingString(entry))
            .filter(Boolean);
    }
    return [];
}

function uniqueStrings(values) {
    return Array.from(new Set(values.filter(Boolean)));
}

function normalizeTaskInput(task) {
    if (typeof task === 'string') {
        return {
            description: normalizeCodingString(task, 2000)
        };
    }
    if (!task || typeof task !== 'object' || Array.isArray(task)) {
        return {
            description: ''
        };
    }

    return {
        description: normalizeCodingString(
            task.description ||
            task.text ||
            task.summary ||
            task.goal ||
            task.title,
            2000
        )
    };
}

function normalizeRepositoryInput(repository, workspaceRoot) {
    if (typeof repository === 'string') {
        return {
            repositoryId: normalizeCodingString(repository, 256),
            workspaceRoot: normalizeCodingString(workspaceRoot, 512),
            tags: []
        };
    }

    const normalizedRepository = repository && typeof repository === 'object' && !Array.isArray(repository)
        ? repository
        : {};

    return {
        repositoryId: normalizeCodingString(
            normalizedRepository.repositoryId ||
            normalizedRepository.id ||
            normalizedRepository.name,
            256
        ),
        workspaceRoot: normalizeCodingString(
            normalizedRepository.workspaceRoot ||
            normalizedRepository.root ||
            normalizedRepository.path ||
            workspaceRoot,
            512
        ),
        tags: normalizeCodingStringArray(
            normalizedRepository.tags,
            (entry) => entry && typeof entry === 'object' ? (entry.name || entry.value) : entry
        )
    };
}

function normalizeFileSignals(files) {
    return normalizeCodingStringArray(files, (entry) => {
        if (typeof entry === 'string') {
            return entry;
        }
        if (entry && typeof entry === 'object') {
            return entry.path || entry.filePath || entry.file || entry.uri;
        }
        return '';
    });
}

function normalizeSymbolSignals(symbols) {
    return normalizeCodingStringArray(symbols, (entry) => {
        if (typeof entry === 'string') {
            return entry;
        }
        if (entry && typeof entry === 'object') {
            return entry.name || entry.symbol || entry.id;
        }
        return '';
    });
}

function normalizeTargetInput(target, diary, maid) {
    const normalizedTarget = target && typeof target === 'object' && !Array.isArray(target)
        ? target
        : {};

    return {
        diary: normalizeCodingString(normalizedTarget.diary || diary, 128),
        maid: normalizeCodingString(normalizedTarget.maid || normalizedTarget.author || maid, 128)
    };
}

function normalizeSummaryInput(body) {
    return normalizeCodingText(
        body.summary ||
        body.implementation ||
        body.outcome ||
        body.result ||
        body.notes,
        4000
    );
}

function normalizeMetadata(metadata) {
    if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {
        return {};
    }
    const normalizedMetadata = {};
    for (const [rawKey, rawValue] of Object.entries(metadata)) {
        const normalizedKey = normalizeCodingString(rawKey, 80);
        if (!normalizedKey || rawValue === undefined || rawValue === null) {
            continue;
        }
        normalizedMetadata[normalizedKey] = rawValue;
    }
    return normalizedMetadata;
}

function hasAdditionalWritebackSignals({
    summary,
    constraints,
    pitfalls,
    files,
    symbols
}) {
    return Boolean(
        summary ||
        constraints.length > 0 ||
        pitfalls.length > 0 ||
        files.length > 0 ||
        symbols.length > 0
    );
}

function hasRequiredCodingWritebackSignals({
    task,
    summary,
    constraints,
    pitfalls,
    files,
    symbols
}) {
    return Boolean(
        task.description &&
        hasAdditionalWritebackSignals({
            summary,
            constraints,
            pitfalls,
            files,
            symbols
        })
    );
}

function toRepositoryTag(repositoryId) {
    const normalizedRepositoryId = normalizeCodingString(repositoryId, 128).toLowerCase();
    if (!normalizedRepositoryId) {
        return '';
    }
    return `repo:${normalizedRepositoryId.replace(/[^a-z0-9._/-]+/g, '-')}`;
}

function buildDerivedTags(repository, recommendedTags) {
    return uniqueStrings([
        'coding',
        'implementation',
        toRepositoryTag(repository.repositoryId),
        ...repository.tags,
        ...recommendedTags
    ]).slice(0, 16);
}

function buildDerivedMetadata({
    task,
    summary,
    constraints,
    pitfalls,
    repository,
    files,
    symbols,
    recommendedTags,
    extraMetadata
}) {
    return {
        ...normalizeMetadata(extraMetadata),
        codingTask: task.description,
        codingSummary: summary,
        repositoryId: repository.repositoryId,
        workspaceRoot: repository.workspaceRoot,
        repositoryTags: repository.tags,
        relatedFiles: files,
        relatedSymbols: symbols,
        constraints,
        pitfalls,
        recommendedTags
    };
}

// Keep the durable note deterministic so clients do not need to invent VCP diary text themselves.
function buildDerivedMemoryText({
    task,
    summary,
    constraints,
    pitfalls,
    repository,
    files,
    symbols
}) {
    const lines = [];

    if (task.description) {
        lines.push(`Coding task: ${task.description}`);
    }
    if (summary) {
        lines.push(`Implementation summary: ${summary}`);
    }
    if (repository.repositoryId) {
        lines.push(`Repository: ${repository.repositoryId}`);
    }
    if (repository.workspaceRoot) {
        lines.push(`Workspace: ${repository.workspaceRoot}`);
    }
    if (constraints.length > 0) {
        lines.push('Constraints:');
        constraints.forEach((constraint) => lines.push(`- ${constraint}`));
    }
    if (pitfalls.length > 0) {
        lines.push('Pitfalls:');
        pitfalls.forEach((pitfall) => lines.push(`- ${pitfall}`));
    }
    if (files.length > 0) {
        lines.push(`Related files: ${files.join(', ')}`);
    }
    if (symbols.length > 0) {
        lines.push(`Related symbols: ${symbols.join(', ')}`);
    }

    return lines.join('\n').trim();
}

function buildScope(target, repository) {
    const hasRepositoryScope = Boolean(
        repository.repositoryId ||
        repository.workspaceRoot ||
        repository.tags.length > 0
    );

    return {
        mode: hasRepositoryScope ? 'repository_targeted' : 'explicit_diary',
        diary: target.diary,
        repositoryId: repository.repositoryId,
        workspaceRoot: repository.workspaceRoot,
        repositoryTags: repository.tags,
        explicitTarget: Boolean(target.diary)
    };
}

function buildCommittedMemory({
    task,
    repository,
    target,
    derivedTags,
    writeResult
}) {
    const lines = [];
    const verb = writeResult.writeStatus === 'skipped_duplicate'
        ? 'Skipped duplicate coding memory'
        : 'Committed coding memory';

    lines.push(`${verb} for task "${task.description}" to diary "${target.diary}".`);
    if (repository.repositoryId) {
        lines.push(`Repository: ${repository.repositoryId}`);
    }
    lines.push(`Write status: ${writeResult.writeStatus}`);
    if (writeResult.entryId) {
        lines.push(`Entry: ${writeResult.entryId}`);
    }
    if (derivedTags.length > 0) {
        lines.push(`Tags: ${derivedTags.join(', ')}`);
    }

    return lines.join('\n');
}

function createCodingMemoryWritebackService({
    memoryRuntimeService,
    auditLogger
} = {}) {
    if (!memoryRuntimeService || typeof memoryRuntimeService.writeMemory !== 'function') {
        throw new Error('[CodingMemoryWritebackService] memoryRuntimeService is required');
    }

    const logger = auditLogger || createAuditLogger({
        prefix: '[AgentGatewayCodingWriteback]'
    });

    return {
        async commitForCoding({
            body = {},
            startedAt = Date.now(),
            clientIp = '127.0.0.1',
            defaultSource = DEFAULT_SOURCE
        } = {}) {
            const requestContext = normalizeRequestContext(body.requestContext, {
                defaultSource,
                defaultRuntime: body?.requestContext?.runtime || 'gateway',
                requestIdPrefix: 'agw'
            });
            const task = normalizeTaskInput(body.task);
            const summary = normalizeSummaryInput(body);
            const constraints = normalizeCodingStringArray(body.constraints || body.constraint);
            const pitfalls = normalizeCodingStringArray(body.pitfalls || body.risks || body.followUps);
            const repository = normalizeRepositoryInput(body.repository, body.workspaceRoot);
            const files = normalizeFileSignals(body.files);
            const symbols = normalizeSymbolSignals(body.symbols);
            const recommendedTags = normalizeCodingStringArray(body.recommendedTags || body.tags);
            const target = normalizeTargetInput(body.target, body.diary, body.maid);
            const metadata = buildDerivedMetadata({
                task,
                summary,
                constraints,
                pitfalls,
                repository,
                files,
                symbols,
                recommendedTags,
                extraMetadata: body.metadata || body.sourceMetadata
            });
            const derivedTags = buildDerivedTags(repository, recommendedTags);
            const scope = buildScope(target, repository);
            const memoryText = buildDerivedMemoryText({
                task,
                summary,
                constraints,
                pitfalls,
                repository,
                files,
                symbols
            });

            if (!requestContext.agentId || !requestContext.sessionId) {
                return {
                    success: false,
                    requestId: requestContext.requestId,
                    status: 400,
                    code: AGW_ERROR_CODES.INVALID_REQUEST,
                    error: 'agentId and sessionId are required',
                    details: {
                        field: 'agentId/sessionId'
                    }
                };
            }

            if (!hasRequiredCodingWritebackSignals({
                task,
                summary,
                constraints,
                pitfalls,
                files,
                symbols
            })) {
                return {
                    success: false,
                    requestId: requestContext.requestId,
                    status: 400,
                    code: AGW_ERROR_CODES.VALIDATION_ERROR,
                    error: 'coding writeback requires task plus summary-like content, constraints, pitfalls, files, or symbols',
                    details: {
                        field: 'task+(summary|implementation|outcome|result|notes|constraints|pitfalls|files|symbols)'
                    }
                };
            }

            logger.logMemory('coding_writeback.started', {
                requestId: requestContext.requestId,
                source: requestContext.source,
                agentId: requestContext.agentId,
                sessionId: requestContext.sessionId,
                diary: target.diary,
                scopeMode: scope.mode,
                repositoryId: repository.repositoryId
            });

            try {
                const result = await memoryRuntimeService.writeMemory({
                    body: {
                        ...body,
                        diary: target.diary,
                        maid: target.maid || body.maid,
                        target: {
                            ...((body.target && typeof body.target === 'object') ? body.target : {}),
                            diary: target.diary,
                            ...(target.maid ? { maid: target.maid } : {})
                        },
                        memory: {
                            text: memoryText,
                            tags: derivedTags,
                            metadata
                        },
                        text: memoryText,
                        tags: derivedTags,
                        metadata,
                        requestContext,
                        authContext: body.authContext,
                        idempotencyKey: body.options?.idempotencyKey || body.idempotencyKey,
                        options: {
                            ...((body.options && typeof body.options === 'object') ? body.options : {}),
                            idempotencyKey: body.options?.idempotencyKey || body.idempotencyKey,
                            bridgeToolName: 'gateway_memory_commit_for_coding'
                        }
                    },
                    startedAt,
                    clientIp,
                    defaultSource
                });

                if (!result?.success) {
                    logger.logMemory('coding_writeback.failed', {
                        requestId: requestContext.requestId,
                        source: requestContext.source,
                        agentId: requestContext.agentId,
                        sessionId: requestContext.sessionId,
                        diary: target.diary,
                        code: result?.code || ''
                    }, startedAt);
                    return {
                        ...result,
                        requestId: requestContext.requestId
                    };
                }

                const committedMemory = buildCommittedMemory({
                    task,
                    repository,
                    target: {
                        diary: result.data?.diary || target.diary
                    },
                    derivedTags,
                    writeResult: result.data || {}
                });

                logger.logMemory('coding_writeback.completed', {
                    requestId: requestContext.requestId,
                    source: requestContext.source,
                    agentId: requestContext.agentId,
                    sessionId: requestContext.sessionId,
                    diary: result.data?.diary || target.diary,
                    writeStatus: result.data?.writeStatus || ''
                }, startedAt);

                return {
                    success: true,
                    requestId: requestContext.requestId,
                    data: {
                        committedMemory,
                        writeStatus: result.data?.writeStatus || '',
                        target: {
                            diary: result.data?.diary || target.diary,
                            ...(target.maid ? { maid: target.maid } : {}),
                            scopeMode: scope.mode,
                            repositoryId: repository.repositoryId,
                            workspaceRoot: repository.workspaceRoot
                        },
                        derivedTags,
                        metadata,
                        memoryText,
                        scope,
                        entryId: result.data?.entryId || '',
                        deduplicated: Boolean(result.data?.deduplicated),
                        filePath: result.data?.filePath || '',
                        timestamp: result.data?.timestamp || '',
                        diagnostics: {
                            signalSummary: {
                                hasSummary: Boolean(summary),
                                constraints: constraints.length,
                                pitfalls: pitfalls.length,
                                files: files.length,
                                symbols: symbols.length
                            },
                            targetExplicit: Boolean(target.diary)
                        }
                    },
                    audit: result.audit || {
                        runtime: requestContext.runtime,
                        source: requestContext.source
                    }
                };
            } catch (error) {
                logger.logMemory('coding_writeback.failed', {
                    requestId: requestContext.requestId,
                    source: requestContext.source,
                    agentId: requestContext.agentId,
                    sessionId: requestContext.sessionId,
                    diary: target.diary,
                    error: error?.message || 'Unknown coding writeback failure'
                }, startedAt);

                return {
                    success: false,
                    requestId: requestContext.requestId,
                    status: 500,
                    code: AGW_ERROR_CODES.INTERNAL_ERROR,
                    error: 'Failed to commit coding memory',
                    details: {
                        message: error?.message || 'Unknown coding writeback failure'
                    }
                };
            }
        }
    };
}

module.exports = {
    createCodingMemoryWritebackService
};
