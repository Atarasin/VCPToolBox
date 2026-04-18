const express = require('express');
const crypto = require('crypto');
const path = require('path');
const {
    normalizeRequestContext
} = require('./agentGateway/contracts/requestContext');
const {
    sendSuccessResponse,
    sendErrorResponse
} = require('./agentGateway/contracts/responseEnvelope');
const {
    OPENCLAW_ERROR_CODES
} = require('./agentGateway/contracts/errorCodes');
const {
    mapOpenClawMemoryWriteError: mapMemoryWriteError
} = require('./agentGateway/infra/errorMapper');
const {
    reuseRequestId
} = require('./agentGateway/infra/trace');
const {
    createAuditLogger
} = require('./agentGateway/infra/auditLogger');
const {
    getGatewayServiceBundle
} = require('./agentGateway/createGatewayServiceBundle');

// =============================================================================
// Agent Gateway Core
// 当前阶段先完整承接 OpenClaw bridge 的实现，后续再逐步剥离 vendor-specific 语义，
// 让 OpenClaw / MCP / Native Gateway 等 adapter 共享同一套核心能力。
// =============================================================================

/** OpenClaw 桥接版本号 */
const OPENCLAW_BRIDGE_VERSION = 'v1';
/** 审计日志前缀 */
const OPENCLAW_AUDIT_LOG_PREFIX = '[OpenClawBridgeAudit]';
/** RAG 默认返回结果数量 */
const OPENCLAW_DEFAULT_RAG_K = 5;
/** RAG 最大返回结果数量 */
const OPENCLAW_MAX_RAG_K = 20;
/** 标签权重提升系数 */
const OPENCLAW_TAG_BOOST = 0.15;
/** 上下文构建默认最大块数 */
const OPENCLAW_DEFAULT_CONTEXT_MAX_BLOCKS = 4;
/** 上下文构建默认 Token 预算 */
const OPENCLAW_DEFAULT_CONTEXT_TOKEN_BUDGET = 1200;
/** 上下文构建最大 Token 预算 */
const OPENCLAW_MAX_CONTEXT_TOKEN_BUDGET = 4000;
/** 上下文构建默认最低相似度分数 */
const OPENCLAW_DEFAULT_CONTEXT_MIN_SCORE = 0.3;
/** 上下文构建默认 Token 比例上限 */
const OPENCLAW_DEFAULT_CONTEXT_MAX_TOKEN_RATIO = 0.6;
/** 最大上下文消息数量 */
const OPENCLAW_MAX_CONTEXT_MESSAGES = 12;
/** OpenClaw durable memory 内部桥接工具名 */
const OPENCLAW_MEMORY_WRITE_TOOL_NAME = 'vcp_memory_write';
/** OpenClaw 兼容响应配置 */
const OPENCLAW_RESPONSE_OPTIONS = Object.freeze({
    versionHeader: 'x-openclaw-bridge-version',
    versionValue: OPENCLAW_BRIDGE_VERSION,
    versionKey: 'bridgeVersion'
});
/** OpenClaw 审计日志实例 */
const openClawAuditLogger = createAuditLogger({
    prefix: OPENCLAW_AUDIT_LOG_PREFIX
});

// =============================================================================
// 缓存实例（延迟加载，避免循环依赖）
// =============================================================================

/** 知识库管理器缓存 */
let cachedOpenClawKnowledgeBaseManager = null;
/** RAG 插件缓存 */
let cachedOpenClawRagPlugin = null;
/** 嵌入向量工具缓存 */
let cachedOpenClawEmbeddingUtils = null;

// =============================================================================
// 输入规范化工具函数
// =============================================================================

/**
 * 规范化字符串值
 * @param {any} value - 输入值
 * @returns {string} 去除首尾空格的字符串，非字符串输入返回空字符串
 */
function normalizeOpenClawString(value) {
    return typeof value === 'string' ? value.trim() : '';
}

/**
 * 规范化字符串数组
 * 支持数组输入或逗号分隔的字符串输入
 * @param {any} value - 输入值（数组或逗号分隔字符串）
 * @returns {string[]} 过滤后的字符串数组
 */
function normalizeOpenClawStringArray(value) {
    if (Array.isArray(value)) {
        return value
            .map((item) => normalizeOpenClawString(item))
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

/**
 * 规范化请求中的 diary 约束
 * 同时兼容单个 diary 与 diaries 数组两种输入形式
 * @param {any} body - 请求体
 * @returns {{diary: string, diaries: string[]}} 规范化后的单日记本与多日记本约束
 */
function resolveOpenClawDiarySelection(body) {
    const diary = normalizeOpenClawString(body?.diary);
    const diaries = normalizeOpenClawStringArray(body?.diaries);
    if (diary && !diaries.includes(diary)) {
        diaries.unshift(diary);
    }
    return {
        diary,
        diaries
    };
}

/**
 * 解析 JSON 对象，失败时返回默认值
 * @param {any} value - 输入值
 * @param {object} fallbackValue - 解析失败时的默认值
 * @returns {object} 解析后的对象或默认值
 */
function parseOpenClawJsonObject(value, fallbackValue = {}) {
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

// =============================================================================
// 请求 ID 与响应工具函数
// =============================================================================

/**
 * 创建 OpenClaw 请求 ID
 * 优先使用提供的 ID，否则生成新的 UUID
 * @param {string} providedRequestId - 外部提供的请求 ID
 * @returns {string} 规范化后的请求 ID
 */
function createOpenClawRequestId(providedRequestId) {
    return reuseRequestId(providedRequestId, { prefix: 'ocw' });
}

/**
 * 规范化 OpenClaw requestContext，同时保留兼容默认值。
 * @param {object} input - 外部 requestContext
 * @param {string} defaultSource - 默认来源
 * @returns {{requestId: string, sessionId: string, agentId: string, source: string, runtime: string}}
 */
function normalizeOpenClawRequestContext(input, defaultSource) {
    return normalizeRequestContext(input, {
        defaultSource,
        defaultRuntime: 'openclaw',
        requestIdPrefix: 'ocw'
    });
}

/**
 * 发送 OpenClaw 成功响应
 * @param {Response} res - Express 响应对象
 * @param {object} params - 响应参数
 * @param {number} params.status - HTTP 状态码
 * @param {string} params.requestId - 请求 ID
 * @param {number} params.startedAt - 开始时间戳
 * @param {any} params.data - 响应数据
 */
function sendOpenClawSuccess(res, { status = 200, requestId, startedAt, data }) {
    return sendSuccessResponse(res, {
        status,
        requestId,
        startedAt,
        data,
        ...OPENCLAW_RESPONSE_OPTIONS
    });
}

/**
 * 发送 OpenClaw 错误响应
 * @param {Response} res - Express 响应对象
 * @param {object} params - 错误参数
 * @param {number} params.status - HTTP 状态码
 * @param {string} params.requestId - 请求 ID
 * @param {number} params.startedAt - 开始时间戳
 * @param {string} params.code - 错误代码
 * @param {string} params.error - 错误信息
 * @param {object} params.details - 错误详情
 */
function sendOpenClawError(res, { status, requestId, startedAt, code, error, details }) {
    return sendErrorResponse(res, {
        status,
        requestId,
        startedAt,
        code,
        error,
        details,
        ...OPENCLAW_RESPONSE_OPTIONS
    });
}

// =============================================================================
// 参数解析工具函数
// =============================================================================

/**
 * 解析布尔查询参数
 * 支持布尔值和字符串形式的 "true"/"false"
 * @param {any} value - 输入值
 * @param {boolean} defaultValue - 默认值
 * @returns {boolean} 解析后的布尔值
 */
function parseOpenClawBooleanQuery(value, defaultValue = false) {
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

/**
 * 解析整数参数，并进行范围限制
 * @param {any} value - 输入值
 * @param {number} defaultValue - 默认值
 * @param {number} minValue - 最小值（默认1）
 * @param {number} maxValue - 最大值（默认 Number.MAX_SAFE_INTEGER）
 * @returns {number} 解析后的整数值
 */
function parseOpenClawInteger(value, defaultValue, minValue = 1, maxValue = Number.MAX_SAFE_INTEGER) {
    const parsedValue = Number.parseInt(value, 10);
    if (!Number.isFinite(parsedValue)) {
        return defaultValue;
    }
    return Math.min(maxValue, Math.max(minValue, parsedValue));
}

// =============================================================================
// 插件桥接能力检测
// =============================================================================

/**
 * 检查插件是否支持 OpenClaw 桥接
 * 支持的插件类型：分布式插件、hybridservice 直连插件、stdio 协议的同步/异步插件
 * @param {object} plugin - 插件对象
 * @returns {boolean} 是否支持桥接
 */
function isOpenClawBridgeablePlugin(plugin) {
    if (!plugin || typeof plugin !== 'object') {
        return false;
    }
    if (plugin.isDistributed) {
        return true;
    }
    if (plugin.pluginType === 'hybridservice' && plugin.communication?.protocol === 'direct') {
        return true;
    }
    return (
        (plugin.pluginType === 'synchronous' || plugin.pluginType === 'asynchronous') &&
        plugin.communication?.protocol === 'stdio'
    );
}

/**
 * 获取工具执行超时时间（毫秒）
 * @param {object} plugin - 插件对象
 * @returns {number} 超时时间毫秒数，0表示无超时
 */
function getOpenClawToolTimeoutMs(plugin) {
    const timeoutMs = plugin?.communication?.timeout ?? plugin?.entryPoint?.timeout ?? 0;
    return Number.isFinite(timeoutMs) && timeoutMs >= 0 ? timeoutMs : 0;
}

// =============================================================================
// 工具输入模式（Schema）构建
// 从 invocationCommand 描述和示例中提取参数定义
// =============================================================================

/**
 * 从调用命令示例文本中提取参数名
 * 匹配格式：参数名: 「始」值「末」
 * @param {string} text - 示例文本
 * @returns {string[]} 提取的参数名数组
 */
function parseInvocationCommandExample(text) {
    if (typeof text !== 'string' || !text.trim()) {
        return [];
    }
    const params = new Set();
    const paramRegex = /([\w_]+)\s*:\s*「始」([\s\S]*?)「末」/g;
    let match;
    while ((match = paramRegex.exec(text)) !== null) {
        const key = normalizeOpenClawString(match[1]);
        if (key && key !== 'tool_name') {
            params.add(key);
        }
    }
    return Array.from(params);
}

/**
 * 从参数描述文本中提取参数提示信息
 * 解析参数类型、是否必需、固定值等元数据
 * @param {string} text - 参数描述文本
 * @returns {Map<string, object>} 参数名到提示信息的映射
 */
function extractInvocationParameterHints(text) {
    if (typeof text !== 'string' || !text.trim()) {
        return new Map();
    }
    const hints = new Map();
    const parameterRegex = /-\s*`([\w_]+)`\s*:\s*([^\n]+)/g;
    let match;
    while ((match = parameterRegex.exec(text)) !== null) {
        const key = normalizeOpenClawString(match[1]);
        const descriptor = normalizeOpenClawString(match[2]);
        if (!key) {
            continue;
        }
        const hint = hints.get(key) || { type: 'string', required: false };
        if (/固定为|必需|必须|required/i.test(descriptor)) {
            hint.required = true;
        }
        const fixedValueMatch = descriptor.match(/固定为\s*`([^`]+)`/);
        if (fixedValueMatch) {
            hint.const = fixedValueMatch[1];
        }
        if (/布尔|boolean/i.test(descriptor)) {
            hint.type = 'boolean';
        } else if (/数组|array/i.test(descriptor)) {
            hint.type = 'array';
        } else if (/整数|number|数值|float|int/i.test(descriptor)) {
            hint.type = 'number';
        }
        hints.set(key, hint);
    }
    return hints;
}

function applyOpenClawInvocationParameters(parameterHints, invocationCommand) {
    if (!Array.isArray(invocationCommand?.parameters)) {
        return parameterHints;
    }
    for (const parameter of invocationCommand.parameters) {
        const parameterName = normalizeOpenClawString(parameter?.name);
        if (!parameterName) {
            continue;
        }
        const hint = parameterHints.get(parameterName) || { type: 'string', required: false };
        const parameterType = normalizeOpenClawString(parameter?.type).toLowerCase();
        if (parameterType === 'boolean') {
            hint.type = 'boolean';
        } else if (parameterType === 'array') {
            hint.type = 'array';
        } else if (parameterType === 'number' || parameterType === 'integer' || parameterType === 'float' || parameterType === 'int') {
            hint.type = 'number';
        } else if (parameterType) {
            hint.type = parameterType;
        }
        if (parameter?.required === true) {
            hint.required = true;
        }
        parameterHints.set(parameterName, hint);
    }
    return parameterHints;
}

/**
 * 从调用命令构建 JSON Schema 变体
 * 支持多命令变体（oneOf），每个变体有不同的必需参数
 * @param {object} invocationCommand - 调用命令定义
 * @returns {object|null} JSON Schema 对象或 null
 */
function buildOpenClawInvocationVariantSchema(invocationCommand) {
    if (!invocationCommand || typeof invocationCommand !== 'object') {
        return null;
    }
    const combinedText = [invocationCommand.description, invocationCommand.example].filter(Boolean).join('\n');
    const exampleParams = parseInvocationCommandExample(combinedText);
    const parameterHints = applyOpenClawInvocationParameters(extractInvocationParameterHints(combinedText), invocationCommand);
    const properties = {};
    const required = new Set();

    for (const parameterName of exampleParams) {
        properties[parameterName] = { type: 'string' };
        required.add(parameterName);
    }

    for (const [parameterName, hint] of parameterHints.entries()) {
        const property = properties[parameterName] || {};
        property.type = hint.type || property.type || 'string';
        if (hint.const !== undefined) {
            property.const = hint.const;
        }
        properties[parameterName] = property;
        if (hint.required) {
            required.add(parameterName);
        }
    }

    if (typeof invocationCommand.command === 'string' && invocationCommand.command.trim()) {
        properties.command = {
            type: 'string',
            const: invocationCommand.command.trim()
        };
        required.add('command');
    }

    if (Object.keys(properties).length === 0) {
        return null;
    }

    const schema = {
        type: 'object',
        additionalProperties: true,
        properties
    };
    if (required.size > 0) {
        schema.required = Array.from(required);
    }
    return schema;
}

/**
 * 获取工具的完整输入 Schema
 * 如果有多个 invocationCommand，返回 oneOf 结构
 * @param {object} plugin - 插件对象
 * @returns {object} JSON Schema 对象
 */
function getOpenClawToolInputSchema(plugin) {
    const invocationCommands = Array.isArray(plugin?.capabilities?.invocationCommands)
        ? plugin.capabilities.invocationCommands
        : [];
    const variantSchemas = invocationCommands
        .map((command) => buildOpenClawInvocationVariantSchema(command))
        .filter(Boolean);

    if (variantSchemas.length > 1) {
        return {
            oneOf: variantSchemas
        };
    }
    if (variantSchemas.length === 1) {
        return variantSchemas[0];
    }
    return {
        type: 'object',
        additionalProperties: true
    };
}

/**
 * 汇总工具描述信息
 * 优先使用插件描述，其次使用第一个 invocationCommand 的第一行
 * @param {object} plugin - 插件对象
 * @returns {string} 工具描述
 */
function summarizeOpenClawToolDescription(plugin) {
    const description = normalizeOpenClawString(plugin?.description);
    if (description) {
        return description;
    }
    const invocationCommands = Array.isArray(plugin?.capabilities?.invocationCommands)
        ? plugin.capabilities.invocationCommands
        : [];
    for (const invocationCommand of invocationCommands) {
        const invocationDescription = normalizeOpenClawString(invocationCommand?.description);
        if (invocationDescription) {
            return invocationDescription.split('\n')[0];
        }
    }
    return `${plugin?.displayName || plugin?.name || 'Unknown tool'} bridge`;
}

/**
 * 提取并规范化 invocationCommands
 * 保留供 OpenClaw skill 生成使用的描述、参数与示例信息
 * @param {object} plugin - 插件对象
 * @returns {object[]} 规范化后的 invocationCommands 数组
 */
function getOpenClawInvocationCommands(plugin) {
    const invocationCommands = Array.isArray(plugin?.capabilities?.invocationCommands)
        ? plugin.capabilities.invocationCommands
        : [];
    return invocationCommands
        .map((invocationCommand) => {
            const parameters = Array.isArray(invocationCommand?.parameters)
                ? invocationCommand.parameters
                    .map((parameter) => {
                        const parameterName = normalizeOpenClawString(parameter?.name);
                        if (!parameterName) {
                            return null;
                        }
                        return {
                            name: parameterName,
                            description: normalizeOpenClawString(parameter?.description),
                            required: parameter?.required === true,
                            type: normalizeOpenClawString(parameter?.type) || 'string'
                        };
                    })
                    .filter(Boolean)
                : [];
            const normalizedCommand = {
                commandIdentifier: normalizeOpenClawString(invocationCommand?.commandIdentifier),
                command: normalizeOpenClawString(invocationCommand?.command),
                description: normalizeOpenClawString(invocationCommand?.description),
                example: normalizeOpenClawString(invocationCommand?.example),
                parameters
            };
            if (!normalizedCommand.commandIdentifier &&
                !normalizedCommand.command &&
                !normalizedCommand.description &&
                !normalizedCommand.example &&
                normalizedCommand.parameters.length === 0) {
                return null;
            }
            return normalizedCommand;
        })
        .filter(Boolean);
}

/**
 * 创建 OpenClaw 工具描述符
 * 包含工具的基本信息、类型、超时、描述和输入模式
 * @param {object} plugin - 插件对象
 * @param {object} pluginManager - 插件管理器
 * @returns {object} 工具描述符对象
 */
function createOpenClawToolDescriptor(plugin, pluginManager) {
    return {
        name: plugin.name,
        displayName: plugin.displayName || plugin.name,
        pluginType: plugin.pluginType || (plugin.isDistributed ? 'distributed' : 'unknown'),
        distributed: Boolean(plugin.isDistributed),
        approvalRequired: Boolean(pluginManager?.toolApprovalManager?.shouldApprove?.(plugin.name)),
        timeoutMs: getOpenClawToolTimeoutMs(plugin),
        description: summarizeOpenClawToolDescription(plugin),
        inputSchema: getOpenClawToolInputSchema(plugin),
        invocationCommands: getOpenClawInvocationCommands(plugin)
    };
}

// =============================================================================
// 配置与组件获取
// =============================================================================

function getOpenClawBridgeConfig(pluginManager) {
    return pluginManager?.openClawBridgeConfig ||
        pluginManager?.openClawBridge?.config ||
        pluginManager?.openClawBridge ||
        {};
}

function getOpenClawRagConfig(pluginManager) {
    const bridgeConfig = getOpenClawBridgeConfig(pluginManager);
    const ragConfig = parseOpenClawJsonObject(bridgeConfig.rag, bridgeConfig.rag || {});
    const configuredAgentDiaryMap = parseOpenClawJsonObject(ragConfig.agentDiaryMap, {});
    const envAgentDiaryMap = parseOpenClawJsonObject(process.env.OPENCLAW_RAG_AGENT_DIARY_MAP, {});
    const rawAllowCrossRoleAccess = ragConfig.allowCrossRoleAccess !== undefined
        ? ragConfig.allowCrossRoleAccess
        : process.env.OPENCLAW_RAG_ALLOW_CROSS_ROLE_ACCESS;
    const defaultDiaries = normalizeOpenClawStringArray(
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
        allowCrossRoleAccess: parseOpenClawBooleanQuery(rawAllowCrossRoleAccess, false),
        hasExplicitPolicy: (
            Object.keys(agentDiaryMap).length > 0 ||
            defaultDiaries.length > 0 ||
            rawAllowCrossRoleAccess !== undefined
        )
    };
}

function getOpenClawKnowledgeBaseManager(pluginManager) {
    if (pluginManager?.vectorDBManager) {
        return pluginManager.vectorDBManager;
    }
    if (pluginManager?.knowledgeBaseManager) {
        return pluginManager.knowledgeBaseManager;
    }
    if (pluginManager?.openClawBridge?.knowledgeBaseManager) {
        return pluginManager.openClawBridge.knowledgeBaseManager;
    }
    if (!cachedOpenClawKnowledgeBaseManager) {
        cachedOpenClawKnowledgeBaseManager = require('../KnowledgeBaseManager');
    }
    return cachedOpenClawKnowledgeBaseManager;
}

function getOpenClawRagPlugin(pluginManager) {
    const pluginManagerRagPlugin = pluginManager?.messagePreprocessors?.get?.('RAGDiaryPlugin');
    if (pluginManagerRagPlugin) {
        return pluginManagerRagPlugin;
    }
    if (pluginManager?.openClawBridge?.ragPlugin) {
        return pluginManager.openClawBridge.ragPlugin;
    }
    if (!cachedOpenClawRagPlugin) {
        try {
            cachedOpenClawRagPlugin = require('../Plugin/RAGDiaryPlugin/RAGDiaryPlugin');
        } catch (error) {
            cachedOpenClawRagPlugin = null;
        }
    }
    return cachedOpenClawRagPlugin;
}

function getOpenClawEmbeddingUtils() {
    if (!cachedOpenClawEmbeddingUtils) {
        cachedOpenClawEmbeddingUtils = require('../EmbeddingUtils');
    }
    return cachedOpenClawEmbeddingUtils;
}

// =============================================================================
// RAG 目标解析与管理
// =============================================================================

function buildOpenClawAgentAliases(agentId, maid) {
    const aliases = new Set();
    const addAlias = (value) => {
        const normalizedValue = normalizeOpenClawString(value);
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

async function listOpenClawDiaryTargets(knowledgeBaseManager) {
    if (typeof knowledgeBaseManager?.listDiaryNames === 'function') {
        const diaryNames = await Promise.resolve(knowledgeBaseManager.listDiaryNames());
        return normalizeOpenClawStringArray(diaryNames);
    }
    if (!knowledgeBaseManager?.db?.prepare) {
        return [];
    }
    const rows = knowledgeBaseManager.db
        .prepare('SELECT DISTINCT diary_name FROM files ORDER BY diary_name COLLATE NOCASE')
        .all();

    return rows
        .map((row) => normalizeOpenClawString(row.diary_name))
        .filter(Boolean);
}

function collectOpenClawConfiguredDiaries(agentId, maid, ragConfig) {
    const agentAliases = buildOpenClawAgentAliases(agentId, maid);
    const configuredDiaries = new Set();

    for (const alias of agentAliases) {
        normalizeOpenClawStringArray(ragConfig.agentDiaryMap?.[alias]).forEach((diaryName) => configuredDiaries.add(diaryName));
    }
    normalizeOpenClawStringArray(ragConfig.agentDiaryMap?.['*']).forEach((diaryName) => configuredDiaries.add(diaryName));
    normalizeOpenClawStringArray(ragConfig.defaultDiaries).forEach((diaryName) => configuredDiaries.add(diaryName));

    return {
        agentAliases,
        configuredDiaries
    };
}

function resolveOpenClawAllowedDiaries({ agentId, maid, availableDiaries, ragConfig }) {
    const normalizedDiaries = normalizeOpenClawStringArray(availableDiaries);
    if (normalizedDiaries.length === 0) {
        return [];
    }
    if (ragConfig.allowCrossRoleAccess) {
        return normalizedDiaries;
    }

    const { agentAliases, configuredDiaries } = collectOpenClawConfiguredDiaries(agentId, maid, ragConfig);

    if (configuredDiaries.size > 0) {
        return normalizedDiaries.filter((diaryName) => configuredDiaries.has(diaryName));
    }

    const aliasMatchedDiaries = normalizedDiaries.filter((diaryName) => agentAliases.has(diaryName));
    if (ragConfig.hasExplicitPolicy) {
        return aliasMatchedDiaries;
    }

    return normalizedDiaries;
}

function isOpenClawDiaryAllowed({ diaryName, agentId, maid, ragConfig }) {
    const normalizedDiaryName = normalizeOpenClawString(diaryName);
    if (!normalizedDiaryName) {
        return false;
    }
    if (ragConfig.allowCrossRoleAccess) {
        return true;
    }

    const { agentAliases, configuredDiaries } = collectOpenClawConfiguredDiaries(agentId, maid, ragConfig);
    if (configuredDiaries.size > 0) {
        return configuredDiaries.has(normalizedDiaryName);
    }
    if (ragConfig.hasExplicitPolicy) {
        return agentAliases.has(normalizedDiaryName);
    }
    return true;
}

function createOpenClawRagTargetDescriptor(diaryName) {
    return {
        id: diaryName,
        displayName: `${diaryName}日记本`,
        type: 'diary',
        allowed: true
    };
}

async function resolveOpenClawMemoryTargets(pluginManager, agentId, maid) {
    const knowledgeBaseManager = getOpenClawKnowledgeBaseManager(pluginManager);
    const availableDiaries = await listOpenClawDiaryTargets(knowledgeBaseManager);
    const ragConfig = getOpenClawRagConfig(pluginManager);
    const allowedDiaries = resolveOpenClawAllowedDiaries({
        agentId,
        maid,
        availableDiaries,
        ragConfig
    });

    return allowedDiaries
        .slice()
        .sort((left, right) => left.localeCompare(right))
        .map((diaryName) => createOpenClawRagTargetDescriptor(diaryName));
}

// =============================================================================
// RAG 查询与记忆写回
// =============================================================================

function getOpenClawMemoryWritePluginInfo(pluginManager) {
    const resolvePlugin = (pluginName) => pluginManager?.getPlugin?.(pluginName) || pluginManager?.plugins?.get?.(pluginName) || null;

    const dailyNotePlugin = resolvePlugin('DailyNote');
    if (dailyNotePlugin) {
        return {
            name: 'DailyNote',
            executionMode: 'tool'
        };
    }

    return null;
}

function getOpenClawMemoryWriteStore(pluginManager) {
    if (!pluginManager.__openClawMemoryWriteStore) {
        pluginManager.__openClawMemoryWriteStore = {
            entriesByIdempotencyKey: new Map(),
            entriesByFingerprint: new Map()
        };
    }
    return pluginManager.__openClawMemoryWriteStore;
}

function normalizeOpenClawMemoryTags(tags) {
    const normalizedTags = [...new Set(normalizeOpenClawStringArray(tags))];
    return normalizedTags.slice(0, 16);
}

function resolveOpenClawMemoryDateParts(timestampValue) {
    const normalizedTimestamp = normalizeOpenClawTimestampValue(timestampValue);
    const resolvedDate = normalizedTimestamp ? new Date(normalizedTimestamp) : new Date();
    const pad = (value) => value.toString().padStart(2, '0');
    return {
        timestamp: resolvedDate.toISOString(),
        dateString: `${resolvedDate.getFullYear()}-${pad(resolvedDate.getMonth() + 1)}-${pad(resolvedDate.getDate())}`,
        timeLabel: `${pad(resolvedDate.getHours())}:${pad(resolvedDate.getMinutes())}`
    };
}

function buildOpenClawMemoryWriteMaid({ diaryName, target, requestContext }) {
    const requestedAuthor = normalizeOpenClawString(
        target?.maid ||
        target?.author ||
        target?.agent ||
        requestContext?.agentId ||
        requestContext?.source
    ) || 'OpenClaw';
    const normalizedAuthor = requestedAuthor.replace(/^\[[^\]]*\]/, '').trim() || 'OpenClaw';
    return `[${diaryName}]${normalizedAuthor}`;
}

function normalizeOpenClawMemoryMetadata(metadata) {
    if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {
        return {};
    }
    const normalizedMetadata = {};
    for (const [rawKey, rawValue] of Object.entries(metadata)) {
        const key = normalizeOpenClawString(rawKey);
        if (!key || rawValue === undefined || rawValue === null) {
            continue;
        }
        if (typeof rawValue === 'string') {
            const value = normalizeOpenClawString(rawValue);
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

function buildOpenClawMemoryWriteContent({ text, timeLabel, metadata }) {
    const normalizedText = normalizeOpenClawContentText(text);
    if (!normalizedText) {
        return '';
    }

    const lines = [];
    const textWithTime = /^\[\d{2}:\d{2}(?::\d{2})?\]/.test(normalizedText)
        ? normalizedText
        : `[${timeLabel}] ${normalizedText}`;
    lines.push(textWithTime);

    const normalizedMetadata = normalizeOpenClawMemoryMetadata(metadata);
    for (const [key, value] of Object.entries(normalizedMetadata)) {
        const renderedValue = typeof value === 'string' ? value : JSON.stringify(value);
        lines.push(`Meta-${key}: ${renderedValue}`);
    }

    return lines.join('\n');
}

function createOpenClawMemoryFingerprint({ diaryName, text, tags, agentId, source, metadata }) {
    const fingerprintPayload = JSON.stringify({
        diaryName: normalizeOpenClawString(diaryName),
        text: normalizeOpenClawContentText(text),
        tags: normalizeOpenClawMemoryTags(tags),
        agentId: normalizeOpenClawString(agentId),
        source: normalizeOpenClawString(source),
        metadata: normalizeOpenClawMemoryMetadata(metadata)
    });
    return crypto.createHash('sha256').update(fingerprintPayload).digest('hex');
}

function resolveOpenClawMemoryDuplicate(store, { idempotencyKey, fingerprint, deduplicate }) {
    const normalizedIdempotencyKey = normalizeOpenClawString(idempotencyKey);
    if (normalizedIdempotencyKey && store.entriesByIdempotencyKey.has(normalizedIdempotencyKey)) {
        return store.entriesByIdempotencyKey.get(normalizedIdempotencyKey);
    }
    if (deduplicate && fingerprint && store.entriesByFingerprint.has(fingerprint)) {
        return store.entriesByFingerprint.get(fingerprint);
    }
    return null;
}

function rememberOpenClawMemoryWrite(store, record) {
    if (record?.idempotencyKey) {
        store.entriesByIdempotencyKey.set(record.idempotencyKey, record);
    }
    if (record?.fingerprint) {
        store.entriesByFingerprint.set(record.fingerprint, record);
    }
}

function extractOpenClawMemoryWritePath(result) {
    const pathCandidates = [
        result?.filePath,
        result?.path,
        result?.result?.filePath,
        result?.result?.path,
        result?.message
    ];
    for (const candidate of pathCandidates) {
        const normalizedCandidate = normalizeOpenClawString(candidate);
        if (!normalizedCandidate) {
            continue;
        }
        const savedPathMatch = normalizedCandidate.match(/Diary saved to\s+(.+)$/i);
        if (savedPathMatch?.[1]) {
            return savedPathMatch[1].trim();
        }
        if (normalizedCandidate.includes(path.sep) || /\.[A-Za-z0-9]+$/.test(normalizedCandidate)) {
            return normalizedCandidate;
        }
    }
    return '';
}

function createOpenClawMemoryEntryId({ diaryName, filePath, fingerprint, timestamp }) {
    return crypto.createHash('sha256')
        .update([
            normalizeOpenClawString(diaryName),
            normalizeOpenClawString(filePath),
            normalizeOpenClawString(fingerprint),
            normalizeOpenClawString(timestamp)
        ].join('::'))
        .digest('hex')
        .slice(0, 24);
}

function mapOpenClawMemoryWriteError(error) {
    return mapMemoryWriteError(error);
}

async function performOpenClawMemoryWrite(pluginManager, { body, startedAt, clientIp, defaultSource }) {
    const requestContext = normalizeOpenClawRequestContext(body?.requestContext, defaultSource);
    const requestId = requestContext.requestId;
    const agentId = requestContext.agentId;
    const sessionId = requestContext.sessionId;
    const source = requestContext.source;
    const target = body?.target && typeof body.target === 'object' ? body.target : {};
    const memory = body?.memory && typeof body.memory === 'object' ? body.memory : {};
    const options = body?.options && typeof body.options === 'object' ? body.options : {};
    const targetDiary = normalizeOpenClawString(target.diary || body?.diary);
    const memoryText = normalizeOpenClawContentText(memory.text || body?.text || body?.memoryText);
    const deduplicate = parseOpenClawBooleanQuery(options.deduplicate, true);
    const idempotencyKey = normalizeOpenClawString(options.idempotencyKey || body?.idempotencyKey);
    const tags = normalizeOpenClawMemoryTags(memory.tags || body?.tags);
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

    const ragConfig = getOpenClawRagConfig(pluginManager);
    if (!isOpenClawDiaryAllowed({ diaryName: targetDiary, agentId, maid: target.maid, ragConfig })) {
        return {
            success: false,
            requestId,
            status: 403,
            code: OPENCLAW_ERROR_CODES.MEMORY_TARGET_FORBIDDEN,
            error: 'Requested diary target is not allowed for this agent',
            details: {
                diary: targetDiary,
                agentId
            }
        };
    }

    const memoryWriter = getOpenClawMemoryWritePluginInfo(pluginManager);
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

    const { timestamp, dateString, timeLabel } = resolveOpenClawMemoryDateParts(memory.timestamp || body?.timestamp);
    const fingerprint = createOpenClawMemoryFingerprint({
        diaryName: targetDiary,
        text: memoryText,
        tags,
        agentId,
        source,
        metadata
    });
    const memoryStore = getOpenClawMemoryWriteStore(pluginManager);
    const duplicateRecord = resolveOpenClawMemoryDuplicate(memoryStore, {
        idempotencyKey,
        fingerprint,
        deduplicate
    });

    logOpenClawAudit('memory.write.started', {
        requestId,
        source,
        agentId,
        sessionId,
        diary: targetDiary,
        deduplicate,
        hasIdempotencyKey: Boolean(idempotencyKey)
    });

    if (duplicateRecord) {
        logOpenClawAudit('memory.write.duplicate', {
            requestId,
            source,
            agentId,
            sessionId,
            diary: targetDiary,
            entryId: duplicateRecord.entryId,
            durationMs: Math.max(0, Date.now() - startedAt)
        });
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
        const maid = buildOpenClawMemoryWriteMaid({
            diaryName: targetDiary,
            target,
            requestContext
        });
        const content = buildOpenClawMemoryWriteContent({
            text: memoryText,
            timeLabel,
            metadata
        });
        const tagLine = `Tag: ${tags.join(', ')}`;
        const writeResult = await pluginManager.processToolCall('DailyNote', {
            command: 'create',
            maid,
            Date: dateString,
            Content: content,
            Tag: tagLine,
            __openclawContext: {
                source,
                agentId,
                sessionId,
                requestId
            }
        }, clientIp);
        const filePath = extractOpenClawMemoryWritePath(writeResult);
        const entryId = createOpenClawMemoryEntryId({
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
        rememberOpenClawMemoryWrite(memoryStore, persistedRecord);

        logOpenClawAudit('memory.write.completed', {
            requestId,
            source,
            agentId,
            sessionId,
            diary: targetDiary,
            entryId,
            writer: memoryWriter.name,
            durationMs: Math.max(0, Date.now() - startedAt)
        });

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
        console.error('[OpenClawBridgeRoutes] Error writing OpenClaw memory:', error);
        const mappedError = mapOpenClawMemoryWriteError(error);
        logOpenClawAudit('memory.write.failed', {
            requestId,
            source,
            agentId,
            sessionId,
            diary: targetDiary,
            durationMs: Math.max(0, Date.now() - startedAt),
            code: mappedError.code
        });
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

function createOpenClawMemoryDescriptor({ includeTargets, targets, ragPlugin, knowledgeBaseManager, pluginManager }) {
    return {
        targets: includeTargets ? targets : [],
        features: {
            timeAware: Boolean(ragPlugin?.timeParser?.parse),
            groupAware: Boolean(ragPlugin?.semanticGroups?.getEnhancedVector),
            rerank: Boolean(ragPlugin?._rerankDocuments),
            tagMemo: Boolean(knowledgeBaseManager?.applyTagBoost),
            writeBack: Boolean(getOpenClawMemoryWritePluginInfo(pluginManager))
        }
    };
}

function normalizeOpenClawRagMode(mode) {
    const normalizedMode = normalizeOpenClawString(mode).toLowerCase();
    if (!normalizedMode) {
        return 'rag';
    }
    if (['rag', 'hybrid', 'auto'].includes(normalizedMode)) {
        return normalizedMode;
    }
    return null;
}

function extractOpenClawRagOptions(body) {
    const mode = normalizeOpenClawRagMode(body?.mode);
    const bodyOptions = body?.options && typeof body.options === 'object' && !Array.isArray(body.options)
        ? body.options
        : {};
    const defaults = mode === 'hybrid'
        ? { timeAware: true, groupAware: true, rerank: false, tagMemo: true }
        : { timeAware: false, groupAware: false, rerank: false, tagMemo: false };

    return {
        mode,
        k: parseOpenClawInteger(body?.k, OPENCLAW_DEFAULT_RAG_K, 1, OPENCLAW_MAX_RAG_K),
        timeAware: parseOpenClawBooleanQuery(body?.timeAware ?? bodyOptions.timeAware, defaults.timeAware),
        groupAware: parseOpenClawBooleanQuery(body?.groupAware ?? bodyOptions.groupAware, defaults.groupAware),
        rerank: parseOpenClawBooleanQuery(body?.rerank ?? bodyOptions.rerank, defaults.rerank),
        tagMemo: parseOpenClawBooleanQuery(body?.tagMemo ?? bodyOptions.tagMemo, defaults.tagMemo)
    };
}

function computeOpenClawCosineSimilarity(vectorA, vectorB) {
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

async function getOpenClawQueryVector(query, ragPlugin, knowledgeBaseManager) {
    if (ragPlugin?.getSingleEmbeddingCached) {
        return await ragPlugin.getSingleEmbeddingCached(query);
    }
    const { getEmbeddingsBatch } = getOpenClawEmbeddingUtils();
    const [vector] = await getEmbeddingsBatch([query], {
        apiKey: knowledgeBaseManager?.config?.apiKey,
        apiUrl: knowledgeBaseManager?.config?.apiUrl,
        model: knowledgeBaseManager?.config?.model
    });
    return vector || null;
}

// =============================================================================
// 元数据提取与结果处理
// =============================================================================

function extractOpenClawCoreTags(boostInfo) {
    const matchedTags = Array.isArray(boostInfo?.matchedTags) ? boostInfo.matchedTags : [];
    return matchedTags
        .map((tag) => {
            if (typeof tag === 'string') {
                return tag;
            }
            if (tag && typeof tag === 'object') {
                return normalizeOpenClawString(tag.name);
            }
            return '';
        })
        .filter(Boolean);
}

function normalizeOpenClawTimestampValue(value) {
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

function deriveOpenClawTimestampFromPath(sourcePath) {
    const normalizedPath = normalizeOpenClawString(sourcePath);
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

async function getOpenClawFileMetadata(knowledgeBaseManager, sourcePath) {
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
        sourceDiary: normalizeOpenClawString(row.sourceDiary),
        sourcePath: normalizeOpenClawString(row.sourcePath),
        updatedAt: row.updatedAt,
        tags: row.tags ? row.tags.split('||').filter(Boolean) : []
    };
}

async function getCachedOpenClawFileMetadata(metadataCache, knowledgeBaseManager, sourcePath) {
    const cacheKey = normalizeOpenClawString(sourcePath);
    if (!cacheKey) {
        return null;
    }
    if (metadataCache.has(cacheKey)) {
        return metadataCache.get(cacheKey);
    }
    const metadata = await getOpenClawFileMetadata(knowledgeBaseManager, cacheKey);
    metadataCache.set(cacheKey, metadata);
    return metadata;
}

async function normalizeOpenClawRagItem(result, fallbackDiary, knowledgeBaseManager, metadataCache) {
    const sourcePath = normalizeOpenClawString(
        result?.fullPath ||
        result?.sourcePath ||
        result?.source_file ||
        result?.sourceFile
    );
    const metadata = sourcePath
        ? await getCachedOpenClawFileMetadata(metadataCache, knowledgeBaseManager, sourcePath)
        : null;
    const timestamp = normalizeOpenClawTimestampValue(
        result?.timestamp ||
        result?.updatedAt ||
        result?.updated_at ||
        metadata?.timestamp ||
        metadata?.updatedAt
    ) || deriveOpenClawTimestampFromPath(sourcePath);

    return {
        text: normalizeOpenClawString(result?.text),
        score: typeof result?.score === 'number' && Number.isFinite(result.score) ? result.score : 0,
        sourceDiary: normalizeOpenClawString(result?.sourceDiary || metadata?.sourceDiary || fallbackDiary),
        sourceFile: normalizeOpenClawString(result?.sourceFile ? path.basename(result.sourceFile) : (sourcePath ? path.basename(sourcePath) : '')),
        timestamp,
        tags: normalizeOpenClawStringArray(result?.tags || result?.matchedTags || metadata?.tags)
    };
}

function deduplicateOpenClawRagCandidates(candidates) {
    const deduplicatedCandidates = new Map();
    for (const candidate of candidates) {
        const key = [
            normalizeOpenClawString(candidate?.sourceDiary),
            normalizeOpenClawString(candidate?.fullPath || candidate?.sourcePath || candidate?.sourceFile),
            normalizeOpenClawString(candidate?.text)
        ].join('::');
        const existingCandidate = deduplicatedCandidates.get(key);
        if (!existingCandidate || (candidate?.score || 0) > (existingCandidate?.score || 0)) {
            deduplicatedCandidates.set(key, candidate);
        }
    }
    return Array.from(deduplicatedCandidates.values());
}

// =============================================================================
// 查询构建与 Token 估算
// =============================================================================

function normalizeOpenClawContentText(content) {
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
                    return normalizeOpenClawString(entry.text || entry.content || entry.value);
                }
                return '';
            })
            .filter(Boolean)
            .join('\n');
    }
    if (content && typeof content === 'object') {
        return normalizeOpenClawString(content.text || content.content || content.value);
    }
    return '';
}

function normalizeOpenClawConversationMessages(messages) {
    if (!Array.isArray(messages)) {
        return [];
    }
    return messages
        .map((message) => {
            if (!message || typeof message !== 'object') {
                return null;
            }
            const role = normalizeOpenClawString(message.role || message.author || message.type || 'user') || 'user';
            const text = normalizeOpenClawContentText(message.content || message.text || message.message);
            if (!text) {
                return null;
            }
            return { role, text };
        })
        .filter(Boolean)
        .slice(-OPENCLAW_MAX_CONTEXT_MESSAGES);
}

function buildOpenClawRecallQuery(body) {
    const explicitQuery = normalizeOpenClawString(body?.query);
    if (explicitQuery) {
        return explicitQuery;
    }

    const messages = normalizeOpenClawConversationMessages(
        body?.recentMessages ||
        body?.messages ||
        body?.conversation ||
        body?.conversationMessages
    );

    if (messages.length === 0) {
        return '';
    }

    return messages
        .map((message) => `${message.role}: ${message.text}`)
        .join('\n')
        .slice(0, 4000);
}

function estimateOpenClawTokenCount(text) {
    const normalizedText = normalizeOpenClawString(text);
    if (!normalizedText) {
        return 0;
    }
    const cjkCount = (normalizedText.match(/[\u3400-\u9fff]/g) || []).length;
    const nonCjkCount = normalizedText.length - cjkCount;
    return Math.max(1, cjkCount + Math.ceil(nonCjkCount / 4));
}

function truncateOpenClawTextByTokens(text, maxTokens) {
    const normalizedText = normalizeOpenClawString(text);
    if (!normalizedText || maxTokens <= 0) {
        return '';
    }
    let candidate = normalizedText;
    while (candidate && estimateOpenClawTokenCount(candidate) > maxTokens) {
        candidate = candidate.slice(0, -1).trimEnd();
    }
    return candidate;
}

// =============================================================================
// 上下文块构建与去重
// =============================================================================

function createOpenClawRecallBlock(item) {
    const text = normalizeOpenClawString(item?.text);
    const sourceDiary = normalizeOpenClawString(item?.sourceDiary);
    const sourceFile = normalizeOpenClawString(item?.sourceFile);
    const tags = normalizeOpenClawStringArray(item?.tags);
    const estimatedTokens = estimateOpenClawTokenCount(text);

    return {
        text,
        metadata: {
            score: typeof item?.score === 'number' && Number.isFinite(item.score) ? item.score : 0,
            sourceDiary,
            sourceFile,
            timestamp: item?.timestamp || null,
            tags,
            estimatedTokens
        }
    };
}

function deduplicateOpenClawRecallBlocks(blocks) {
    const deduplicatedBlocks = new Map();
    for (const block of blocks) {
        const key = [
            normalizeOpenClawString(block?.metadata?.sourceDiary),
            normalizeOpenClawString(block?.metadata?.sourceFile),
            normalizeOpenClawString(block?.text)
        ].join('::');
        const existingBlock = deduplicatedBlocks.get(key);
        if (!existingBlock || (block?.metadata?.score || 0) > (existingBlock?.metadata?.score || 0)) {
            deduplicatedBlocks.set(key, block);
        }
    }
    return Array.from(deduplicatedBlocks.values());
}

function logOpenClawAudit(event, payload) {
    openClawAuditLogger.log(event, payload);
}

function summarizeOpenClawScoreStats(values) {
    const scores = Array.isArray(values)
        ? values.filter((value) => typeof value === 'number' && Number.isFinite(value))
        : [];
    if (scores.length === 0) {
        return {
            count: 0,
            max: null,
            min: null,
            avg: null
        };
    }
    const total = scores.reduce((sum, score) => sum + score, 0);
    return {
        count: scores.length,
        max: Math.max(...scores),
        min: Math.min(...scores),
        avg: total / scores.length
    };
}

// =============================================================================
// Gateway Core 路由定义
// =============================================================================

/**
 * 当前先导出与 OpenClaw 桥兼容的路由集合，保证现有外部行为稳定。
 * 后续引入 native gateway / MCP adapter 时，将继续复用本模块中的核心能力。
 * @param {object} pluginManager - 插件管理器实例
 * @returns {Router} Express 路由实例
 */
module.exports = function createAgentGatewayCore(pluginManager) {
    if (!pluginManager) {
        throw new Error('[AgentGatewayCore] pluginManager is required');
    }

    const router = express.Router();
    const {
        capabilityService,
        memoryRuntimeService,
        contextRuntimeService,
        toolRuntimeService
    } = getGatewayServiceBundle(pluginManager, {
        auditPrefix: OPENCLAW_AUDIT_LOG_PREFIX,
        gatewayVersion: OPENCLAW_BRIDGE_VERSION,
        memoryBridgeToolName: OPENCLAW_MEMORY_WRITE_TOOL_NAME
    });

    router.get('/openclaw/capabilities', async (req, res) => {
        const startedAt = Date.now();
        const agentId = normalizeOpenClawString(req.query.agentId);
        const maid = normalizeOpenClawString(req.query.maid);
        const requestId = createOpenClawRequestId(req.query.requestId);
        const includeMemoryTargets = parseOpenClawBooleanQuery(req.query.includeMemoryTargets, true);

        if (!agentId) {
            return sendOpenClawError(res, {
                status: 400,
                requestId,
                startedAt,
                code: OPENCLAW_ERROR_CODES.INVALID_REQUEST,
                error: 'agentId is required',
                details: { field: 'agentId' }
            });
        }

        try {
            const capabilities = await capabilityService.getCapabilities({
                agentId,
                maid,
                includeMemoryTargets
            });

            return sendOpenClawSuccess(res, {
                requestId,
                startedAt,
                data: {
                    server: capabilities.server,
                    tools: capabilities.tools,
                    memory: capabilities.memory
                }
            });
        } catch (error) {
            console.error('[OpenClawBridgeRoutes] Error building OpenClaw capabilities:', error);
            return sendOpenClawError(res, {
                status: 500,
                requestId,
                startedAt,
                code: OPENCLAW_ERROR_CODES.INTERNAL_ERROR,
                error: 'Failed to build bridge capabilities',
                details: { message: error.message }
            });
        }
    });

    router.get('/openclaw/rag/targets', async (req, res) => {
        const startedAt = Date.now();
        const agentId = normalizeOpenClawString(req.query.agentId);
        const maid = normalizeOpenClawString(req.query.maid);
        const requestId = createOpenClawRequestId(req.query.requestId);

        if (!agentId) {
            return sendOpenClawError(res, {
                status: 400,
                requestId,
                startedAt,
                code: OPENCLAW_ERROR_CODES.INVALID_REQUEST,
                error: 'agentId is required',
                details: { field: 'agentId' }
            });
        }

        try {
            const targets = await capabilityService.getMemoryTargets({ agentId, maid });
            return sendOpenClawSuccess(res, {
                requestId,
                startedAt,
                data: {
                    targets
                }
            });
        } catch (error) {
            console.error('[OpenClawBridgeRoutes] Error resolving OpenClaw RAG targets:', error);
            return sendOpenClawError(res, {
                status: 500,
                requestId,
                startedAt,
                code: OPENCLAW_ERROR_CODES.INTERNAL_ERROR,
                error: 'Failed to load RAG targets',
                details: { message: error.message }
            });
        }
    });

    router.post('/openclaw/rag/search', async (req, res) => {
        const startedAt = Date.now();
        const result = await contextRuntimeService.search({
            body: req.body,
            startedAt,
            defaultSource: 'openclaw'
        });

        if (!result.success) {
            return sendOpenClawError(res, {
                status: result.status,
                requestId: result.requestId,
                startedAt,
                code: result.code,
                error: result.error,
                details: result.details
            });
        }

        return sendOpenClawSuccess(res, {
            requestId: result.requestId,
            startedAt,
            data: result.data
        });
    });

    router.post('/openclaw/rag/context', async (req, res) => {
        const startedAt = Date.now();
        const result = await contextRuntimeService.buildRecallContext({
            body: req.body,
            startedAt,
            defaultSource: 'openclaw-context'
        });

        if (!result.success) {
            return sendOpenClawError(res, {
                status: result.status,
                requestId: result.requestId,
                startedAt,
                code: result.code,
                error: result.error,
                details: result.details
            });
        }

        return sendOpenClawSuccess(res, {
            requestId: result.requestId,
            startedAt,
            data: result.data
        });
    });

    router.post('/openclaw/memory/write', async (req, res) => {
        const startedAt = Date.now();
        const clientIp = req.ip && req.ip.startsWith('::ffff:') ? req.ip.slice(7) : req.ip;
        const result = await memoryRuntimeService.writeMemory({
            body: req.body,
            startedAt,
            clientIp,
            defaultSource: 'openclaw-memory'
        });

        if (!result.success) {
            return sendOpenClawError(res, {
                status: result.status,
                requestId: result.requestId,
                startedAt,
                code: result.code,
                error: result.error,
                details: result.details
            });
        }

        return sendOpenClawSuccess(res, {
            requestId: result.requestId,
            startedAt,
            data: result.data
        });
    });

    router.post('/openclaw/tools/:toolName', async (req, res) => {
        const startedAt = Date.now();
        const clientIp = req.ip && req.ip.startsWith('::ffff:') ? req.ip.slice(7) : req.ip;
        try {
            const result = await toolRuntimeService.invokeTool({
                toolName: req.params.toolName,
                body: req.body,
                startedAt,
                clientIp,
                defaultSource: 'openclaw'
            });

            if (result.status === 'completed' || result.status === 'accepted') {
                return sendOpenClawSuccess(res, {
                    status: result.httpStatus || (result.status === 'accepted' ? 202 : 200),
                    requestId: result.requestId,
                    startedAt,
                    data: result.data
                });
            }

            return sendOpenClawError(res, {
                status: result.httpStatus,
                requestId: result.requestId,
                startedAt,
                code: result.code,
                error: result.error,
                details: result.details
            });
        } catch (error) {
            const requestContext = normalizeOpenClawRequestContext(req.body?.requestContext, 'openclaw');
            console.error('[OpenClawBridgeRoutes] Error invoking OpenClaw tool:', error);
            return sendOpenClawError(res, {
                status: 500,
                requestId: requestContext.requestId,
                startedAt,
                code: OPENCLAW_ERROR_CODES.INTERNAL_ERROR,
                error: 'Failed to invoke tool',
                details: {
                    toolName: normalizeOpenClawString(req.params.toolName)
                }
            });
        }
    });

    return router;
};
