const crypto = require('crypto');
const fs = require('fs').promises;
const path = require('path');
const agentManagerSingleton = require('../../agentManager');
const messageProcessor = require('../../messageProcessor');
const { createCapabilityService } = require('./capabilityService');

const DEFAULT_SUMMARY_LENGTH = 160;
const DEFAULT_RENDER_MAX_LENGTH = 12000;

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

function applyRenderVariables(text, variables) {
    let renderedText = String(text || '');
    for (const [key, value] of Object.entries(variables)) {
        const placeholder = `{{${key}}}`;
        renderedText = renderedText.replaceAll(placeholder, value);
    }
    return renderedText;
}

function collectPlaceholderMatches(text, pattern) {
    return [...String(text || '').matchAll(pattern)];
}

function buildPlaceholderSummary(text, agentManager) {
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
        if (normalizedAgentName && typeof agentManager?.isAgent === 'function' && agentManager.isAgent(normalizedAgentName)) {
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
        ragBlocks: collectPlaceholderMatches(text, /\[\[(.*?)日记本(.*?)\]\]/g).length +
            collectPlaceholderMatches(text, /<<(.*?)日记本(.*?)>>/g).length +
            collectPlaceholderMatches(text, /《《(.*?)日记本(.*?)》》/g).length +
            collectPlaceholderMatches(text, /\{\{(.*?)日记本(.*?)\}\}/g).length,
        metaThinkingBlocks: collectPlaceholderMatches(text, /\[\[VCP元思考(.*?)\]\]/g).length,
        asyncResults: collectPlaceholderMatches(text, /\{\{VCP_ASYNC_RESULT::([a-zA-Z0-9_.-]+)::([a-zA-Z0-9_-]+)\}\}/g).length
    };
}

function collectPromptDependencies(text, agentManager) {
    const placeholderSummary = buildPlaceholderSummary(text, agentManager);
    return {
        agents: placeholderSummary.agents,
        toolboxes: placeholderSummary.toolboxes,
        variables: placeholderSummary.variables,
        ragBlocks: collectPlaceholderMatches(text, /(\[\[(.*?)日记本(.*?)\]\]|<<(.*?)日记本(.*?)>>|《《(.*?)日记本(.*?)》》|\{\{(.*?)日记本(.*?)\}\})/g)
            .map((match) => match[0]),
        metaThinkingBlocks: collectPlaceholderMatches(text, /\[\[VCP元思考(.*?)\]\]/g)
            .map((match) => match[0]),
        asyncResults: collectPlaceholderMatches(text, /\{\{VCP_ASYNC_RESULT::([a-zA-Z0-9_.-]+)::([a-zA-Z0-9_-]+)\}\}/g)
            .map((match) => ({
                pluginName: match[1],
                requestId: match[2]
            }))
    };
}

function createRenderMeta({ dependencies, renderedDependencies, unresolved, truncated, renderVariables }) {
    const sourceRagBlockCount = Array.isArray(dependencies?.ragBlocks) ? dependencies.ragBlocks.length : 0;
    const renderedRagBlockCount = Array.isArray(renderedDependencies?.ragBlocks) ? renderedDependencies.ragBlocks.length : 0;
    const memoryRecallApplied = sourceRagBlockCount > 0 && renderedRagBlockCount < sourceRagBlockCount;

    return {
        memoryRecallApplied,
        recallSources: memoryRecallApplied
            ? ['tagmemo']
            : [],
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

function createDefaultRenderContext(pluginManager, overrides = {}) {
    return {
        pluginManager,
        cachedEmojiLists: overrides.cachedEmojiLists || new Map(),
        detectors: overrides.detectors || [],
        superDetectors: overrides.superDetectors || [],
        DEBUG_MODE: Boolean(overrides.DEBUG_MODE),
        messages: Array.isArray(overrides.messages) ? overrides.messages : [],
        expandedAgentName: null,
        expandedToolboxes: new Set()
    };
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

/**
 * AgentRegistryService 以 agent-first 视角导出定义信息，不暴露后台目录管理语义。
 */
function createAgentRegistryService(deps = {}) {
    const agentManager = deps.agentManager || agentManagerSingleton;
    const pluginManager = deps.pluginManager;
    const capabilityService = deps.capabilityService || (
        pluginManager ? createCapabilityService({
            pluginManager,
            schemaRegistry: deps.schemaRegistry
        }) : null
    );
    if (!capabilityService || typeof capabilityService.getCapabilities !== 'function') {
        throw new Error('[AgentRegistryService] capabilityService is required');
    }

    const renderPrompt = typeof deps.renderPrompt === 'function'
        ? deps.renderPrompt
        : async ({ rawPrompt, model, renderVariables, renderContext }) => {
            const promptWithVariables = applyRenderVariables(rawPrompt, renderVariables);
            return messageProcessor.replaceAgentVariables(promptWithVariables, model, 'system', renderContext);
        };

    async function ensureAgentState() {
        if (
            agentManager?.agentMap instanceof Map &&
            agentManager.agentMap.size === 0 &&
            typeof agentManager.loadMap === 'function'
        ) {
            await agentManager.loadMap();
        }
        if (typeof agentManager.getAllAgentFiles === 'function') {
            await agentManager.getAllAgentFiles();
        } else if (
            Array.isArray(agentManager?.agentFiles) &&
            agentManager.agentFiles.length === 0 &&
            typeof agentManager.scanAgentFiles === 'function'
        ) {
            await agentManager.scanAgentFiles();
        }
    }

    function getAgentEntries() {
        if (!(agentManager?.agentMap instanceof Map)) {
            return [];
        }
        return Array.from(agentManager.agentMap.entries())
            .map(([alias, sourceFile]) => ({
                alias: normalizeRegistryString(alias),
                sourceFile: normalizeRegistryString(sourceFile)
            }))
            .filter((entry) => entry.alias && entry.sourceFile)
            .sort((left, right) => left.alias.localeCompare(right.alias));
    }

    function resolveAbsoluteSourcePath(sourceFile) {
        const normalizedAgentDir = normalizeRegistryString(agentManager?.agentDir) || path.join(__dirname, '..', '..', '..', 'Agent');
        return path.join(normalizedAgentDir, sourceFile.replace(/\//g, path.sep));
    }

    async function loadAgentSource(agentId) {
        await ensureAgentState();
        const normalizedAgentId = normalizeRegistryString(agentId);
        if (!normalizedAgentId || typeof agentManager?.isAgent !== 'function' || !agentManager.isAgent(normalizedAgentId)) {
            throw createNotFoundError(normalizedAgentId || agentId);
        }

        const sourceFile = normalizeRegistryString(agentManager.agentMap.get(normalizedAgentId));
        const absoluteSourcePath = resolveAbsoluteSourcePath(sourceFile);
        const stat = await getFileStatOrNull(absoluteSourcePath);
        const rawPrompt = await agentManager.getAgentPrompt(normalizedAgentId);

        return {
            agentId: normalizedAgentId,
            alias: normalizedAgentId,
            sourceFile,
            absoluteSourcePath,
            exists: Boolean(stat),
            stat,
            rawPrompt: typeof rawPrompt === 'string' ? rawPrompt : String(rawPrompt || '')
        };
    }

    async function buildCapabilityMetadata(agentId, options = {}) {
        const [capabilities, memoryTargets] = await Promise.all([
            capabilityService.getCapabilities({
                agentId,
                maid: options.maid || agentId,
                includeMemoryTargets: false,
                authContext: options.authContext
            }),
            capabilityService.getMemoryTargets({
                agentId,
                maid: options.maid || agentId,
                authContext: options.authContext
            })
        ]);

        return {
            accessibleTools: capabilities.tools || [],
            accessibleMemoryTargets: memoryTargets || [],
            defaultPolicies: {
                toolNames: (capabilities.tools || []).map((tool) => tool.name),
                memoryTargetIds: (memoryTargets || []).map((target) => target.id)
            },
            capabilityHints: {
                toolNames: (capabilities.tools || []).map((tool) => tool.name),
                memoryTargetIds: (memoryTargets || []).map((target) => target.id),
                contextSupported: Boolean(capabilities.context),
                memoryWriteSupported: Boolean(capabilities.memory?.features?.writeBack),
                jobsSupported: Boolean(capabilities.jobs?.supported),
                eventsSupported: Boolean(capabilities.events?.supported)
            }
        };
    }

    async function buildListRecord(agentId, options = {}) {
        const source = await loadAgentSource(agentId);
        const capabilityMetadata = await buildCapabilityMetadata(agentId, options);

        return {
            agentId: source.agentId,
            alias: source.alias,
            sourceFile: source.sourceFile,
            exists: source.exists,
            mtime: toIsoStringOrNull(source.stat?.mtimeMs),
            hash: createSha256(source.rawPrompt),
            summary: buildSummary(source.rawPrompt),
            defaultPolicies: capabilityMetadata.defaultPolicies,
            capabilityHints: capabilityMetadata.capabilityHints
        };
    }

    return {
        async listAgents(options = {}) {
            await ensureAgentState();
            const entries = getAgentEntries();
            return Promise.all(entries.map((entry) => buildListRecord(entry.alias, options)));
        },

        async getAgentDetail(agentId, options = {}) {
            const [source, capabilityMetadata] = await Promise.all([
                loadAgentSource(agentId),
                buildCapabilityMetadata(agentId, options)
            ]);
            const dependencies = collectPromptDependencies(source.rawPrompt, agentManager);
            const placeholderSummary = buildPlaceholderSummary(source.rawPrompt, agentManager);

            return {
                agentId: source.agentId,
                alias: source.alias,
                sourceFile: source.sourceFile,
                exists: source.exists,
                mtime: toIsoStringOrNull(source.stat?.mtimeMs),
                hash: createSha256(source.rawPrompt),
                summary: buildSummary(source.rawPrompt),
                defaultPolicies: capabilityMetadata.defaultPolicies,
                capabilityHints: capabilityMetadata.capabilityHints,
                prompt: {
                    raw: source.rawPrompt,
                    size: source.rawPrompt.length,
                    placeholderSummary,
                    dependencies
                },
                accessibleTools: capabilityMetadata.accessibleTools,
                accessibleMemoryTargets: capabilityMetadata.accessibleMemoryTargets
            };
        },

        async getAgentProfile(agentId, options = {}) {
            const detail = await this.getAgentDetail(agentId, options);
            return buildAgentProfile(detail);
        },

        async getPromptTemplatePreview(agentId, options = {}) {
            const detail = await this.getAgentDetail(agentId, options);
            return buildPromptTemplatePreview(detail);
        },

        async renderAgent(agentId, options = {}) {
            const source = await loadAgentSource(agentId);
            const renderVariables = normalizeRenderVariables(options.variables);
            const model = normalizeRegistryString(options.model);
            const maxLength = Number.isFinite(options.maxLength)
                ? options.maxLength
                : DEFAULT_RENDER_MAX_LENGTH;
            const renderContext = createDefaultRenderContext(pluginManager, {
                ...options.context,
                messages: options.messages
            });

            const renderedText = await renderPrompt({
                agentId: source.agentId,
                alias: source.alias,
                sourceFile: source.sourceFile,
                rawPrompt: source.rawPrompt,
                renderVariables,
                model,
                renderContext
            });

            const normalizedRenderedText = typeof renderedText === 'string'
                ? renderedText
                : String(renderedText || '');
            const unresolved = collectUnresolvedConstructs(normalizedRenderedText);
            const truncatedPrompt = truncateRegistryText(normalizedRenderedText, maxLength);
            const truncated = truncatedPrompt.length !== normalizedRenderedText.length;
            const warnings = [];
            const dependencies = collectPromptDependencies(source.rawPrompt, agentManager);
            const renderedDependencies = collectPromptDependencies(normalizedRenderedText, agentManager);

            if (unresolved.length > 0) {
                warnings.push('render output still contains unresolved prompt constructs');
            }
            if (truncated) {
                warnings.push('render output was truncated to the requested maxLength');
            }

            return {
                agentId: source.agentId,
                alias: source.alias,
                sourceFile: source.sourceFile,
                renderedPrompt: truncatedPrompt,
                dependencies,
                unresolved,
                warnings,
                truncated,
                renderMeta: createRenderMeta({
                    dependencies,
                    renderedDependencies,
                    unresolved,
                    truncated,
                    renderVariables
                }),
                meta: {
                    model,
                    rawSize: source.rawPrompt.length,
                    renderedSize: normalizedRenderedText.length,
                    variableKeys: Object.keys(renderVariables)
                }
            };
        }
    };
}

module.exports = {
    createAgentRegistryService
};
