const path = require('path');
const {
    normalizeRequestContext
} = require('../contracts/requestContext');
const {
    AGW_ERROR_CODES
} = require('../contracts/errorCodes');
const {
    createAuditLogger
} = require('../infra/auditLogger');

const DEFAULT_SOURCE = 'agent-gateway-coding-recall';
const GENERIC_SCOPE_TERMS = new Set(['repo', 'repository', 'workspace', 'project']);

function normalizeCodingString(value, maxLength = 512) {
    return typeof value === 'string'
        ? value.trim().slice(0, maxLength)
        : '';
}

function normalizeCodingStringArray(value, mapper) {
    if (!Array.isArray(value)) {
        return [];
    }

    return value
        .map((entry) => {
            if (typeof mapper === 'function') {
                return normalizeCodingString(mapper(entry));
            }
            return normalizeCodingString(entry);
        })
        .filter(Boolean);
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
            tags: [],
            diaries: []
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
        ),
        diaries: normalizeCodingStringArray(
            normalizedRepository.diaries || normalizedRepository.allowedDiaries
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

function normalizeRecentMessages(messages) {
    if (!Array.isArray(messages)) {
        return [];
    }

    return messages
        .map((message) => {
            if (!message || typeof message !== 'object') {
                return null;
            }
            const role = normalizeCodingString(message.role || message.author || message.type || 'user', 32) || 'user';
            const content = normalizeCodingString(
                typeof message.content === 'string'
                    ? message.content
                    : (message.text || message.message || ''),
                2000
            );
            if (!content) {
                return null;
            }
            return {
                role,
                content
            };
        })
        .filter(Boolean)
        .slice(-12);
}

function uniqueStrings(values) {
    return Array.from(new Set(values.filter(Boolean)));
}

function deriveRepositoryTerms(repository) {
    const terms = new Set();
    const addTerm = (value, options = {}) => {
        const normalizedValue = normalizeCodingString(value, 256).toLowerCase();
        if (!normalizedValue) {
            return;
        }
        terms.add(normalizedValue);
        if (options.split !== false) {
            normalizedValue
                .split(/[\\/:._-]/)
                .map((segment) => segment.trim())
                .filter((segment) => segment.length >= 4 && !GENERIC_SCOPE_TERMS.has(segment))
                .forEach((segment) => terms.add(segment));
        }
    };

    addTerm(repository.repositoryId);
    addTerm(repository.workspaceRoot ? path.basename(repository.workspaceRoot) : '');
    repository.tags.forEach((tag) => addTerm(tag, { split: false }));

    return Array.from(terms);
}

function buildScopeDescriptor(body, repository) {
    const requestedDiaries = uniqueStrings([
        normalizeCodingString(body?.diary, 128),
        ...normalizeCodingStringArray(body?.diaries),
        ...repository.diaries
    ]);
    const requested = Boolean(
        repository.repositoryId ||
        repository.workspaceRoot ||
        repository.tags.length > 0 ||
        repository.diaries.length > 0
    );
    const terms = deriveRepositoryTerms(repository);

    if (requestedDiaries.length > 0) {
        return {
            requested,
            applied: true,
            widened: false,
            mode: 'repository_diaries',
            repositoryId: repository.repositoryId,
            workspaceRoot: repository.workspaceRoot,
            diaries: requestedDiaries,
            terms,
            matchCount: null
        };
    }

    if (requested) {
        return {
            requested,
            applied: false,
            widened: false,
            mode: 'repository_terms',
            repositoryId: repository.repositoryId,
            workspaceRoot: repository.workspaceRoot,
            diaries: [],
            terms,
            matchCount: null
        };
    }

    return {
        requested: false,
        applied: false,
        widened: false,
        mode: 'agent',
        repositoryId: '',
        workspaceRoot: '',
        diaries: [],
        terms: [],
        matchCount: null
    };
}

function buildDerivedQuery({
    task,
    repository,
    files,
    symbols,
    recentMessages
}) {
    const parts = [];

    if (task.description) {
        parts.push(`Task: ${task.description}`);
    }
    if (repository.repositoryId) {
        parts.push(`Repository: ${repository.repositoryId}`);
    }
    if (repository.workspaceRoot) {
        parts.push(`Workspace: ${repository.workspaceRoot}`);
    }
    if (files.length > 0) {
        parts.push(`Files: ${files.join(', ')}`);
    }
    if (symbols.length > 0) {
        parts.push(`Symbols: ${symbols.join(', ')}`);
    }
    if (recentMessages.length > 0) {
        parts.push(`Recent: ${recentMessages.map((message) => message.content).join(' | ')}`);
    }

    return parts.join('\n').trim();
}

function hasAdditionalCodingSignals({
    files,
    symbols,
    recentMessages
}) {
    return Boolean(
        files.length > 0 ||
        symbols.length > 0 ||
        recentMessages.length > 0
    );
}

function hasRequiredCodingRecallSignals({
    task,
    files,
    symbols,
    recentMessages
}) {
    return Boolean(
        task.description &&
        hasAdditionalCodingSignals({
            files,
            symbols,
            recentMessages
        })
    );
}

function blockMatchesRepositoryTerms(block, terms) {
    if (!Array.isArray(terms) || terms.length === 0) {
        return false;
    }

    const haystacks = [
        normalizeCodingString(block?.text, 4000),
        normalizeCodingString(block?.metadata?.sourceDiary, 256),
        normalizeCodingString(block?.metadata?.sourceFile, 512),
        ...normalizeCodingStringArray(block?.metadata?.tags)
    ].map((value) => value.toLowerCase());

    return terms.some((term) => haystacks.some((value) => value.includes(term)));
}

function applyRepositoryScopeToBlocks(blocks, scope) {
    if (scope.mode !== 'repository_terms') {
        return {
            recallBlocks: blocks,
            scope: {
                ...scope,
                matchCount: Array.isArray(blocks) ? blocks.length : 0
            }
        };
    }

    const filteredBlocks = scope.terms.length > 0
        ? blocks.filter((block) => blockMatchesRepositoryTerms(block, scope.terms))
        : [];

    if (filteredBlocks.length > 0) {
        return {
            recallBlocks: filteredBlocks,
            scope: {
                ...scope,
                applied: true,
                matchCount: filteredBlocks.length
            }
        };
    }

    return {
        recallBlocks: [],
        scope: {
            ...scope,
            applied: true,
            mode: 'repository_terms_no_match',
            matchCount: 0
        }
    };
}

function buildCodingContext({
    task,
    repository,
    files,
    symbols,
    recallBlocks,
    scope
}) {
    const lines = [];

    if (task.description) {
        lines.push(`Task: ${task.description}`);
    }
    if (repository.repositoryId) {
        lines.push(`Repository: ${repository.repositoryId}`);
    }
    if (repository.workspaceRoot) {
        lines.push(`Workspace: ${repository.workspaceRoot}`);
    }
    if (files.length > 0) {
        lines.push(`Files: ${files.join(', ')}`);
    }
    if (symbols.length > 0) {
        lines.push(`Symbols: ${symbols.join(', ')}`);
    }

    if (scope.mode === 'repository_terms_no_match') {
        lines.push('No repository-scoped memory matched the provided coding context.');
        return lines.join('\n');
    }

    if (!Array.isArray(recallBlocks) || recallBlocks.length === 0) {
        lines.push('No relevant memory was recalled for the provided coding context.');
        return lines.join('\n');
    }

    lines.push('Relevant memory:');
    recallBlocks.forEach((block, index) => {
        const sourceParts = [
            normalizeCodingString(block?.metadata?.sourceDiary, 128),
            normalizeCodingString(block?.metadata?.sourceFile, 256)
        ].filter(Boolean);
        const sourceLabel = sourceParts.length > 0 ? ` [${sourceParts.join('/')}]` : '';
        lines.push(`${index + 1}. ${normalizeCodingString(block?.text, 4000)}${sourceLabel}`);
    });

    return lines.join('\n');
}

function countEstimatedTokens(blocks) {
    return (Array.isArray(blocks) ? blocks : []).reduce((total, block) => {
        const estimatedTokens = block?.metadata?.estimatedTokens;
        return total + (typeof estimatedTokens === 'number' && Number.isFinite(estimatedTokens) ? estimatedTokens : 0);
    }, 0);
}

function createCodingRecallService({
    contextRuntimeService,
    auditLogger
} = {}) {
    if (!contextRuntimeService || typeof contextRuntimeService.buildRecallContext !== 'function') {
        throw new Error('[CodingRecallService] contextRuntimeService is required');
    }

    const logger = auditLogger || createAuditLogger({
        prefix: '[AgentGatewayCodingRecall]'
    });

    return {
        async recallForCoding({
            body = {},
            startedAt = Date.now(),
            defaultSource = DEFAULT_SOURCE
        } = {}) {
            const requestContext = normalizeRequestContext(body.requestContext, {
                defaultSource,
                defaultRuntime: body?.requestContext?.runtime || 'gateway',
                requestIdPrefix: 'agw'
            });
            const task = normalizeTaskInput(body.task);
            const repository = normalizeRepositoryInput(body.repository, body.workspaceRoot);
            const files = normalizeFileSignals(body.files);
            const symbols = normalizeSymbolSignals(body.symbols);
            const recentMessages = normalizeRecentMessages(body.recentMessages);
            const derivedQuery = buildDerivedQuery({
                task,
                repository,
                files,
                symbols,
                recentMessages
            });
            const scope = buildScopeDescriptor(body, repository);

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

            if (!hasRequiredCodingRecallSignals({
                task,
                files,
                symbols,
                recentMessages
            })) {
                return {
                    success: false,
                    requestId: requestContext.requestId,
                    status: 400,
                    code: AGW_ERROR_CODES.VALIDATION_ERROR,
                    error: 'coding recall requires task plus files, symbols, or recentMessages',
                    details: {
                        field: 'task+(files|symbols|recentMessages)'
                    }
                };
            }

            logger.logContext('started', {
                requestId: requestContext.requestId,
                source: requestContext.source,
                agentId: requestContext.agentId,
                sessionId: requestContext.sessionId,
                scopeMode: scope.mode,
                repositoryId: repository.repositoryId,
                workspaceRoot: repository.workspaceRoot
            });

            try {
                const result = await contextRuntimeService.buildRecallContext({
                    body: {
                        ...body,
                        diary: scope.diaries[0] || body.diary,
                        diaries: scope.diaries.length > 0 ? scope.diaries : body.diaries,
                        query: body.query || derivedQuery,
                        recentMessages,
                        requestContext,
                        authContext: body.authContext
                    },
                    startedAt,
                    defaultSource
                });

                if (!result?.success) {
                    return {
                        ...result,
                        requestId: requestContext.requestId
                    };
                }

                const scopedRecall = applyRepositoryScopeToBlocks(result.data?.recallBlocks || [], scope);
                const codingContext = buildCodingContext({
                    task,
                    repository,
                    files,
                    symbols,
                    recallBlocks: scopedRecall.recallBlocks,
                    scope: scopedRecall.scope
                });

                logger.logContext('completed', {
                    requestId: requestContext.requestId,
                    source: requestContext.source,
                    agentId: requestContext.agentId,
                    sessionId: requestContext.sessionId,
                    scopeMode: scopedRecall.scope.mode,
                    recallCount: scopedRecall.recallBlocks.length
                }, startedAt);

                return {
                    success: true,
                    requestId: requestContext.requestId,
                    data: {
                        codingContext,
                        query: body.query || derivedQuery,
                        recallBlocks: scopedRecall.recallBlocks,
                        estimatedTokens: countEstimatedTokens(scopedRecall.recallBlocks),
                        appliedPolicy: result.data?.appliedPolicy || {},
                        diagnostics: {
                            querySignals: {
                                task: Boolean(task.description),
                                files: files.length,
                                symbols: symbols.length,
                                recentMessages: recentMessages.length
                            },
                            query: body.query || derivedQuery,
                            resultCount: scopedRecall.recallBlocks.length,
                            repositoryTerms: scopedRecall.scope.terms,
                            baseResultCount: Array.isArray(result.data?.recallBlocks) ? result.data.recallBlocks.length : 0,
                            scopeRequested: scopedRecall.scope.requested
                        },
                        scope: scopedRecall.scope
                    },
                    audit: {
                        runtime: requestContext.runtime,
                        source: requestContext.source
                    }
                };
            } catch (error) {
                logger.logContext('failed', {
                    requestId: requestContext.requestId,
                    source: requestContext.source,
                    agentId: requestContext.agentId,
                    sessionId: requestContext.sessionId,
                    error: error?.message || 'Unknown coding recall failure'
                }, startedAt);

                return {
                    success: false,
                    requestId: requestContext.requestId,
                    status: 500,
                    code: AGW_ERROR_CODES.INTERNAL_ERROR,
                    error: 'Failed to build coding recall context',
                    details: {
                        message: error?.message || 'Unknown coding recall failure'
                    }
                };
            }
        }
    };
}

module.exports = {
    createCodingRecallService
};
