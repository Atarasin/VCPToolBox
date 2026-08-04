const crypto = require('crypto');
const fs = require('fs').promises;

const {
    collectKnowledgePlaceholders,
    collectRetrievalPlaceholders
} = require('../policy/shared/promptPlaceholders');
const { RETRIEVAL_QUERY_SOURCES, resolveRetrievalQuery } = require('../policy/shared/retrievalQuery');

const DEFAULT_SUMMARY_LENGTH = 160;
const DEFAULT_RENDER_MAX_LENGTH = 12000;

/**
 * 检索 query 退化时的 canonical warning 文案。调用方（含 MCP 宿主模型）
 * 读到它就应带上 `query` 重新渲染一次，而不是拿着退化结果继续。
 */
const RETRIEVAL_FALLBACK_WARNING = 'knowledge retrieval used a generic fallback query; '
    + 're-call with "query" set to the user\'s current question to retrieve relevant knowledge-base and diary fragments';

function normalizeRegistryString(value) {
    return typeof value === 'string' ? value.trim() : '';
}

function truncateRegistryText(text, maxLength) {
    if (typeof text !== 'string') {
        return '';
    }
    if (!Number.isFinite(maxLength) || maxLength <= 0 || text.length <= maxLength) {
        return text;
    }
    return `${text.slice(0, Math.max(0, maxLength - 3))}...`;
}

function createSha256(text) {
    return crypto
        .createHash('sha256')
        .update(String(text || ''), 'utf8')
        .digest('hex');
}

function toIsoStringOrNull(value) {
    if (!Number.isFinite(value)) {
        return null;
    }
    return new Date(value).toISOString();
}

function normalizeRenderVariables(variables) {
    if (!variables || typeof variables !== 'object' || Array.isArray(variables)) {
        return {};
    }
    return Object.entries(variables).reduce((accumulator, [key, value]) => {
        const normalizedKey = normalizeRegistryString(key);
        if (!normalizedKey) {
            return accumulator;
        }
        accumulator[normalizedKey] = value == null ? '' : String(value);
        return accumulator;
    }, {});
}

function collectPlaceholderMatches(text, pattern) {
    return [...String(text || '').matchAll(pattern)];
}

function buildPlaceholderSummary(text, agentDirectoryPort) {
    const genericPlaceholders = collectPlaceholderMatches(text, /\{\{([^{}]+)\}\}/g)
        .map((match) => normalizeRegistryString(match[1]))
        .filter(Boolean);
    const agentRefs = new Set();
    const toolboxRefs = new Set();
    const variableRefs = new Set();

    genericPlaceholders.forEach((value) => {
        if (value.startsWith('toolbox:')) {
            toolboxRefs.add(normalizeRegistryString(value.slice('toolbox:'.length)));
            return;
        }

        const normalizedAgentName = value.startsWith('agent:')
            ? normalizeRegistryString(value.slice('agent:'.length))
            : value;
        if (normalizedAgentName && agentDirectoryPort.isAgent(normalizedAgentName)) {
            agentRefs.add(normalizedAgentName);
            return;
        }

        if (
            value.startsWith('Var') ||
            value.startsWith('Tar') ||
            value.startsWith('Sar') ||
            value === 'Date' ||
            value === 'Time' ||
            value === 'Today' ||
            value === 'Festival'
        ) {
            variableRefs.add(value);
        }
    });

    return {
        total: genericPlaceholders.length,
        agents: Array.from(agentRefs).sort(),
        toolboxes: Array.from(toolboxRefs).sort(),
        variables: Array.from(variableRefs).sort(),
        // 日记本 ∪ 冷知识库：与 RAG 渲染闸门同一判定，缺一半会让知识库注入无从观测。
        ragBlocks: collectRetrievalPlaceholders(text).length,
        knowledgeBlocks: collectKnowledgePlaceholders(text).length,
        metaThinkingBlocks: collectPlaceholderMatches(text, /\[\[VCP元思考(.*?)\]\]/g).length,
        asyncResults: collectPlaceholderMatches(text, /\{\{VCP_ASYNC_RESULT::([a-zA-Z0-9_.-]+)::([a-zA-Z0-9_-]+)\}\}/g).length
    };
}

function collectPromptDependencies(text, agentDirectoryPort) {
    const placeholderSummary = buildPlaceholderSummary(text, agentDirectoryPort);
    return {
        agents: placeholderSummary.agents,
        toolboxes: placeholderSummary.toolboxes,
        variables: placeholderSummary.variables,
        ragBlocks: collectRetrievalPlaceholders(text),
        knowledgeBlocks: collectKnowledgePlaceholders(text),
        metaThinkingBlocks: collectPlaceholderMatches(text, /\[\[VCP元思考(.*?)\]\]/g)
            .map((match) => match[0]),
        asyncResults: collectPlaceholderMatches(text, /\{\{VCP_ASYNC_RESULT::([a-zA-Z0-9_.-]+)::([a-zA-Z0-9_-]+)\}\}/g)
            .map((match) => ({
                pluginName: match[1],
                requestId: match[2]
            }))
    };
}

function countBlocks(dependencies, key) {
    return Array.isArray(dependencies?.[key]) ? dependencies[key].length : 0;
}

function createRenderMeta({
    dependencies,
    renderedDependencies,
    unresolved,
    truncated,
    renderVariables,
    knowledgeQuerySource
}) {
    const sourceRagBlockCount = countBlocks(dependencies, 'ragBlocks');
    const renderedRagBlockCount = countBlocks(renderedDependencies, 'ragBlocks');
    const memoryRecallApplied = sourceRagBlockCount > 0 && renderedRagBlockCount < sourceRagBlockCount;
    // 冷知识库单独统计：日记本占位符被替换不代表语料进来了，
    // 两者混在一个指标里会让「知识库整段没注入」看起来一切正常。
    const sourceKnowledgeBlockCount = countBlocks(dependencies, 'knowledgeBlocks');
    const renderedKnowledgeBlockCount = countBlocks(renderedDependencies, 'knowledgeBlocks');
    const knowledgeInjected = sourceKnowledgeBlockCount > 0
        && renderedKnowledgeBlockCount < sourceKnowledgeBlockCount;

    return {
        memoryRecallApplied,
        recallSources: memoryRecallApplied
            ? ['tagmemo']
            : [],
        knowledgeInjected,
        knowledgeQuerySource: knowledgeQuerySource || RETRIEVAL_QUERY_SOURCES.FALLBACK,
        truncated: Boolean(truncated),
        filteredByPolicy: false,
        unresolvedCount: Array.isArray(unresolved) ? unresolved.length : 0,
        variableKeys: Object.keys(renderVariables || {})
    };
}

function collectUnresolvedConstructs(text) {
    return [
        ...collectPlaceholderMatches(text, /\{\{[^{}]+\}\}/g).map((match) => match[0]),
        ...collectPlaceholderMatches(text, /\[\[[^\]]+\]\]/g).map((match) => match[0]),
        ...collectPlaceholderMatches(text, /<<[^>]+>>/g).map((match) => match[0]),
        ...collectPlaceholderMatches(text, /《《[^》]+》》/g).map((match) => match[0])
    ];
}

function buildSummary(rawPrompt) {
    const firstLine = String(rawPrompt || '')
        .split(/\r?\n/)
        .map((line) => line.trim())
        .find(Boolean) || '';
    return truncateRegistryText(firstLine.replace(/\s+/g, ' '), DEFAULT_SUMMARY_LENGTH);
}

function createNotFoundError(agentId) {
    const error = new Error(`Agent '${agentId}' not found`);
    error.code = 'AGENT_NOT_FOUND';
    error.details = { agentId };
    return error;
}

async function getFileStatOrNull(filePath) {
    try {
        return await fs.stat(filePath);
    } catch (error) {
        if (error.code === 'ENOENT') {
            return null;
        }
        throw error;
    }
}

function buildAgentProfile(detail) {
    return {
        agentId: detail.agentId,
        alias: detail.alias,
        summary: detail.summary,
        sourceFile: detail.sourceFile,
        exists: detail.exists,
        mtime: detail.mtime,
        hash: detail.hash,
        defaultPolicies: detail.defaultPolicies,
        capabilityHints: detail.capabilityHints,
        accessibleTools: Array.isArray(detail.accessibleTools)
            ? detail.accessibleTools.map((tool) => ({
                name: normalizeRegistryString(tool?.name),
                approvalRequired: Boolean(tool?.approvalRequired)
            }))
            : [],
        accessibleMemoryTargets: Array.isArray(detail.accessibleMemoryTargets)
            ? detail.accessibleMemoryTargets.map((target) => ({
                id: normalizeRegistryString(target?.id),
                name: normalizeRegistryString(target?.name),
                writable: Boolean(target?.writable)
            }))
            : []
    };
}

function buildPromptTemplatePreview(detail) {
    return {
        agentId: detail.agentId,
        alias: detail.alias,
        sourceFile: detail.sourceFile,
        exists: detail.exists,
        mtime: detail.mtime,
        hash: detail.hash,
        summary: detail.summary,
        prompt: {
            raw: detail.prompt?.raw || '',
            size: Number.isFinite(detail.prompt?.size) ? detail.prompt.size : 0,
            placeholderSummary: detail.prompt?.placeholderSummary || {},
            dependencies: detail.prompt?.dependencies || {}
        }
    };
}

function createAgentRegistryContext({ agentDirectoryPort, capabilityService }) {
    async function ensureAgentState() {
        await agentDirectoryPort.ensureLoaded();
    }

    function getAgentEntries() {
        return agentDirectoryPort.listAgents()
            .map(({ alias, sourceFile }) => ({ alias: normalizeRegistryString(alias), sourceFile: normalizeRegistryString(sourceFile) }))
            .filter((entry) => entry.alias && entry.sourceFile)
            .sort((left, right) => left.alias.localeCompare(right.alias));
    }

    async function loadAgentSource(agentId) {
        await ensureAgentState();
        const normalizedAgentId = normalizeRegistryString(agentId);
        if (!normalizedAgentId || !agentDirectoryPort.isAgent(normalizedAgentId)) {
            throw createNotFoundError(normalizedAgentId || agentId);
        }
        const source = agentDirectoryPort.getAgentSourcePath(normalizedAgentId);
        const sourceFile = normalizeRegistryString(source.sourceFile);
        const absoluteSourcePath = normalizeRegistryString(source.absoluteSourcePath);
        const stat = await getFileStatOrNull(absoluteSourcePath);
        const rawPrompt = await agentDirectoryPort.getAgentPrompt(normalizedAgentId);
        return {
            agentId: normalizedAgentId, alias: normalizedAgentId, sourceFile, absoluteSourcePath,
            exists: Boolean(stat), stat, rawPrompt: typeof rawPrompt === 'string' ? rawPrompt : String(rawPrompt || '')
        };
    }

    async function buildCapabilityMetadata(agentId, options = {}) {
        const [capabilities, memoryTargets] = await Promise.all([
            capabilityService.getCapabilities({ agentId, includeMemoryTargets: false, authContext: options.authContext }),
            capabilityService.getMemoryTargets({ agentId, authContext: options.authContext })
        ]);
        const toolNames = (capabilities.tools || []).map((tool) => tool.name);
        const memoryTargetIds = (memoryTargets || []).map((target) => target.id);
        return {
            accessibleTools: capabilities.tools || [], accessibleMemoryTargets: memoryTargets || [],
            defaultPolicies: { toolNames, memoryTargetIds },
            capabilityHints: {
                toolNames, memoryTargetIds, contextSupported: Boolean(capabilities.context),
                memoryWriteSupported: Boolean(capabilities.memory?.features?.writeBack),
                jobsSupported: Boolean(capabilities.jobs?.supported), eventsSupported: Boolean(capabilities.events?.supported)
            }
        };
    }

    async function buildListRecord(agentId, options = {}) {
        const source = await loadAgentSource(agentId);
        const metadata = await buildCapabilityMetadata(agentId, options);
        return {
            agentId: source.agentId, alias: source.alias, sourceFile: source.sourceFile, exists: source.exists,
            mtime: toIsoStringOrNull(source.stat?.mtimeMs), hash: createSha256(source.rawPrompt),
            summary: buildSummary(source.rawPrompt), defaultPolicies: metadata.defaultPolicies,
            capabilityHints: metadata.capabilityHints
        };
    }

    return { agentDirectoryPort, buildCapabilityMetadata, buildListRecord, ensureAgentState, getAgentEntries, loadAgentSource };
}

function createAgentRegistryApi(context, renderPrompt) {
    const { agentDirectoryPort, buildCapabilityMetadata, buildListRecord, ensureAgentState, getAgentEntries, loadAgentSource } = context;
    const api = {
        async listAgents(options = {}) {
            await ensureAgentState();
            return Promise.all(getAgentEntries().map((entry) => buildListRecord(entry.alias, options)));
        },
        async getAgentDetail(agentId, options = {}) {
            const [source, metadata] = await Promise.all([loadAgentSource(agentId), buildCapabilityMetadata(agentId, options)]);
            return {
                agentId: source.agentId, alias: source.alias, sourceFile: source.sourceFile, exists: source.exists,
                mtime: toIsoStringOrNull(source.stat?.mtimeMs), hash: createSha256(source.rawPrompt), summary: buildSummary(source.rawPrompt),
                defaultPolicies: metadata.defaultPolicies, capabilityHints: metadata.capabilityHints,
                prompt: {
                    raw: source.rawPrompt, size: source.rawPrompt.length,
                    placeholderSummary: buildPlaceholderSummary(source.rawPrompt, agentDirectoryPort),
                    dependencies: collectPromptDependencies(source.rawPrompt, agentDirectoryPort)
                },
                accessibleTools: metadata.accessibleTools, accessibleMemoryTargets: metadata.accessibleMemoryTargets
            };
        },
        async getAgentProfile(agentId, options = {}) { return buildAgentProfile(await api.getAgentDetail(agentId, options)); },
        async getPromptTemplatePreview(agentId, options = {}) {
            return buildPromptTemplatePreview(await api.getAgentDetail(agentId, options));
        },
        async renderAgent(agentId, options = {}) {
            const source = await loadAgentSource(agentId);
            const renderVariables = normalizeRenderVariables(options.variables);
            const model = normalizeRegistryString(options.model);
            const maxLength = Number.isFinite(options.maxLength) ? options.maxLength : DEFAULT_RENDER_MAX_LENGTH;
            const retrievalQuery = resolveRetrievalQuery({ query: options.query, messages: options.messages });
            const rendered = await renderPrompt({
                agentId: source.agentId, alias: source.alias, sourceFile: source.sourceFile,
                rawPrompt: source.rawPrompt, renderVariables, model,
                renderOptions: { ...options.context, messages: options.messages, query: options.query }
            });
            const normalized = typeof rendered === 'string' ? rendered : String(rendered || '');
            const unresolved = collectUnresolvedConstructs(normalized);
            const renderedPrompt = truncateRegistryText(normalized, maxLength);
            const truncated = renderedPrompt.length !== normalized.length;
            const warnings = [];
            const dependencies = collectPromptDependencies(source.rawPrompt, agentDirectoryPort);
            const renderedDependencies = collectPromptDependencies(normalized, agentDirectoryPort);
            if (unresolved.length) warnings.push('render output still contains unresolved prompt constructs');
            if (truncated) warnings.push('render output was truncated to the requested maxLength');
            // 检索 query 退化是静默失败：占位符照样被替换，只是替换成了与用户
            // 问题无关的片段。只有把它抬成 warning，调用方才有机会带 query 重试。
            if (retrievalQuery.source === RETRIEVAL_QUERY_SOURCES.FALLBACK
                && Array.isArray(dependencies.ragBlocks) && dependencies.ragBlocks.length > 0) {
                warnings.push(RETRIEVAL_FALLBACK_WARNING);
            }
            return {
                agentId: source.agentId, alias: source.alias, sourceFile: source.sourceFile, renderedPrompt,
                dependencies, unresolved, warnings, truncated,
                renderMeta: createRenderMeta({
                    dependencies, renderedDependencies, unresolved, truncated, renderVariables,
                    knowledgeQuerySource: retrievalQuery.source
                }),
                meta: { model, rawSize: source.rawPrompt.length, renderedSize: normalized.length, variableKeys: Object.keys(renderVariables) }
            };
        }
    };
    return api;
}

/**
 * AgentRegistryService 以 agent-first 视角导出定义信息，不暴露后台目录管理语义。
 */
function createAgentRegistryService(deps = {}) {
    const agentDirectoryPort = deps.agentDirectoryPort;
    const capabilityService = deps.capabilityService;
    if (!agentDirectoryPort?.available) {
        throw new Error('[AgentRegistryService] available agentDirectoryPort is required');
    }
    if (!capabilityService || typeof capabilityService.getCapabilities !== 'function') {
        throw new Error('[AgentRegistryService] capabilityService is required');
    }

    const renderPrompt = typeof deps.renderPrompt === 'function'
        ? deps.renderPrompt
        : agentDirectoryPort.renderPrompt;

    const context = createAgentRegistryContext({ agentDirectoryPort, capabilityService });
    return createAgentRegistryApi(context, renderPrompt);
}

module.exports = {
    RETRIEVAL_FALLBACK_WARNING,
    createAgentRegistryService
};
