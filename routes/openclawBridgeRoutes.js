const express = require('express');
const crypto = require('crypto');
const path = require('path');
const packageJson = require('../package.json');

// =============================================================================
// OpenClaw 桥接常量配置
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
const OPENCLAW_DEFAULT_CONTEXT_MIN_SCORE = 0.7;
/** 上下文构建默认 Token 比例上限 */
const OPENCLAW_DEFAULT_CONTEXT_MAX_TOKEN_RATIO = 0.6;
/** 最大上下文消息数量 */
const OPENCLAW_MAX_CONTEXT_MESSAGES = 12;
/** OpenClaw durable memory 内部桥接工具名 */
const OPENCLAW_MEMORY_WRITE_TOOL_NAME = 'vcp_memory_write';

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
    const normalizedRequestId = normalizeOpenClawString(providedRequestId);
    if (normalizedRequestId) {
        return normalizedRequestId.slice(0, 128);
    }
    if (typeof crypto.randomUUID === 'function') {
        return `ocw_${crypto.randomUUID()}`;
    }
    return `ocw_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * 设置 OpenClaw 桥接响应头
 * @param {Response} res - Express 响应对象
 * @param {string} requestId - 请求 ID
 */
function setOpenClawBridgeHeaders(res, requestId) {
    res.set('x-request-id', requestId);
    res.set('x-openclaw-bridge-version', OPENCLAW_BRIDGE_VERSION);
}

/**
 * 创建响应元数据对象
 * @param {string} requestId - 请求 ID
 * @param {number} startedAt - 开始时间戳
 * @returns {object} 包含请求 ID、桥接版本和执行时长的元数据对象
 */
function createOpenClawMeta(requestId, startedAt) {
    return {
        requestId,
        bridgeVersion: OPENCLAW_BRIDGE_VERSION,
        durationMs: Math.max(0, Date.now() - startedAt)
    };
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
    setOpenClawBridgeHeaders(res, requestId);
    return res.status(status).json({
        success: true,
        data,
        meta: createOpenClawMeta(requestId, startedAt)
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
    setOpenClawBridgeHeaders(res, requestId);
    return res.status(status).json({
        success: false,
        error,
        code,
        details,
        meta: createOpenClawMeta(requestId, startedAt)
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
        // 检测是否必需
        if (/固定为|必需|必须|required/i.test(descriptor)) {
            hint.required = true;
        }
        // 提取固定值
        const fixedValueMatch = descriptor.match(/固定为\s*`([^`]+)`/);
        if (fixedValueMatch) {
            hint.const = fixedValueMatch[1];
        }
        // 检测参数类型
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

    // 从示例中提取参数
    for (const parameterName of exampleParams) {
        properties[parameterName] = { type: 'string' };
        required.add(parameterName);
    }

    // 应用参数提示信息（类型、固定值、必需性）
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

    // 添加固定的 command 参数
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
// 支持多种配置来源和延迟加载
// =============================================================================

/**
 * 获取 OpenClaw 桥接配置
 * 按优先级从 pluginManager 中查找配置对象
 * @param {object} pluginManager - 插件管理器
 * @returns {object} 桥接配置对象
 */
function getOpenClawBridgeConfig(pluginManager) {
    return pluginManager?.openClawBridgeConfig ||
        pluginManager?.openClawBridge?.config ||
        pluginManager?.openClawBridge ||
        {};
}

/**
 * 获取 RAG 配置
 * 合并配置对象和环境变量中的 RAG 设置
 * @param {object} pluginManager - 插件管理器
 * @returns {object} RAG 配置对象
 */
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

/**
 * 获取知识库管理器实例
 * 支持从 pluginManager 获取或延迟加载默认实例
 * @param {object} pluginManager - 插件管理器
 * @returns {object} 知识库管理器实例
 */
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

/**
 * 获取 RAG 插件实例
 * 支持从 pluginManager 获取或延迟加载默认实例
 * @param {object} pluginManager - 插件管理器
 * @returns {object|null} RAG 插件实例或 null
 */
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

/**
 * 获取嵌入向量工具实例（延迟加载）
 * @returns {object} 嵌入向量工具模块
 */
function getOpenClawEmbeddingUtils() {
    if (!cachedOpenClawEmbeddingUtils) {
        cachedOpenClawEmbeddingUtils = require('../EmbeddingUtils');
    }
    return cachedOpenClawEmbeddingUtils;
}

// =============================================================================
// RAG 目标（日记本）解析与管理
// =============================================================================

/**
 * 构建 Agent 别名集合
 * 从 agentId 和 maid 中提取所有可能的别名（包括分段形式）
 * @param {string} agentId - Agent ID
 * @param {string} maid - MAID 标识
 * @returns {Set<string>} 别名集合
 */
function buildOpenClawAgentAliases(agentId, maid) {
    const aliases = new Set();
    const addAlias = (value) => {
        const normalizedValue = normalizeOpenClawString(value);
        if (!normalizedValue) {
            return;
        }
        aliases.add(normalizedValue);
        // 按路径分隔符分割，添加每个分段作为别名
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

/**
 * 列出所有可用的日记本目标
 * @param {object} knowledgeBaseManager - 知识库管理器
 * @returns {Promise<string[]>} 日记本名称数组
 */
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

/**
 * 解析 Agent 允许访问的日记本列表
 * 根据 agentDiaryMap 配置和跨角色访问策略进行过滤
 * @param {object} params - 参数对象
 * @param {string} params.agentId - Agent ID
 * @param {string} params.maid - MAID 标识
 * @param {string[]} params.availableDiaries - 可用的日记本列表
 * @param {object} params.ragConfig - RAG 配置
 * @returns {string[]} 允许的日记本名称数组
 */
/**
 * 收集 Agent 配置的日记本列表
 * 根据 agentDiaryMap 中的别名映射和默认日记本配置，汇总所有允许的日记本
 * @param {string} agentId - Agent ID
 * @param {string} maid - MAID 标识
 * @param {object} ragConfig - RAG 配置对象
 * @returns {object} 包含 agentAliases（别名集合）和 configuredDiaries（配置日记本集合）的对象
 */
function collectOpenClawConfiguredDiaries(agentId, maid, ragConfig) {
    const agentAliases = buildOpenClawAgentAliases(agentId, maid);
    const configuredDiaries = new Set();

    // 遍历所有别名，从 agentDiaryMap 中查找对应的日记本
    for (const alias of agentAliases) {
        normalizeOpenClawStringArray(ragConfig.agentDiaryMap?.[alias]).forEach((diaryName) => configuredDiaries.add(diaryName));
    }
    // 添加通配符 '*' 配置的默认日记本（适用于所有 Agent）
    normalizeOpenClawStringArray(ragConfig.agentDiaryMap?.['*']).forEach((diaryName) => configuredDiaries.add(diaryName));
    // 添加全局默认日记本
    normalizeOpenClawStringArray(ragConfig.defaultDiaries).forEach((diaryName) => configuredDiaries.add(diaryName));

    return {
        agentAliases,
        configuredDiaries
    };
}

/**
 * 解析 Agent 允许访问的日记本列表
 * 根据 agentDiaryMap 配置和跨角色访问策略进行过滤
 * @param {object} params - 参数对象
 * @param {string} params.agentId - Agent ID
 * @param {string} params.maid - MAID 标识
 * @param {string[]} params.availableDiaries - 可用的日记本列表
 * @param {object} params.ragConfig - RAG 配置
 * @returns {string[]} 允许的日记本名称数组
 */
function resolveOpenClawAllowedDiaries({ agentId, maid, availableDiaries, ragConfig }) {
    const normalizedDiaries = normalizeOpenClawStringArray(availableDiaries);
    if (normalizedDiaries.length === 0) {
        return [];
    }
    // 如果允许跨角色访问，直接返回所有可用日记本
    if (ragConfig.allowCrossRoleAccess) {
        return normalizedDiaries;
    }

    const { agentAliases, configuredDiaries } = collectOpenClawConfiguredDiaries(agentId, maid, ragConfig);

    // 如果配置了明确的日记本映射，使用配置中的日记本
    if (configuredDiaries.size > 0) {
        return normalizedDiaries.filter((diaryName) => configuredDiaries.has(diaryName));
    }

    // 如果没有配置但存在显式策略，返回与别名匹配的日记本
    const aliasMatchedDiaries = normalizedDiaries.filter((diaryName) => agentAliases.has(diaryName));
    if (ragConfig.hasExplicitPolicy) {
        return aliasMatchedDiaries;
    }

    // 默认情况下返回所有可用日记本
    return normalizedDiaries;
}

/**
 * 检查指定日记本是否允许 Agent 访问
 * 根据跨角色访问策略和日记本配置进行权限检查
 * @param {object} params - 参数对象
 * @param {string} params.diaryName - 日记本名称
 * @param {string} params.agentId - Agent ID
 * @param {string} params.maid - MAID 标识
 * @param {object} params.ragConfig - RAG 配置
 * @returns {boolean} 是否允许访问
 */
function isOpenClawDiaryAllowed({ diaryName, agentId, maid, ragConfig }) {
    const normalizedDiaryName = normalizeOpenClawString(diaryName);
    if (!normalizedDiaryName) {
        return false;
    }
    // 如果允许跨角色访问，直接放行
    if (ragConfig.allowCrossRoleAccess) {
        return true;
    }

    const { agentAliases, configuredDiaries } = collectOpenClawConfiguredDiaries(agentId, maid, ragConfig);
    // 如果配置了明确的日记本映射，检查是否在配置中
    if (configuredDiaries.size > 0) {
        return configuredDiaries.has(normalizedDiaryName);
    }
    // 如果存在显式策略，检查是否匹配别名
    if (ragConfig.hasExplicitPolicy) {
        return agentAliases.has(normalizedDiaryName);
    }
    // 默认情况下允许访问
    return true;
}

/**
 * 创建 RAG 目标描述符
 * @param {string} diaryName - 日记本名称
 * @returns {object} 目标描述符对象
 */
function createOpenClawRagTargetDescriptor(diaryName) {
    return {
        id: diaryName,
        displayName: `${diaryName}日记本`,
        type: 'diary',
        allowed: true
    };
}

/**
 * 解析记忆目标列表
 * @param {object} pluginManager - 插件管理器
 * @param {string} agentId - Agent ID
 * @param {string} maid - MAID 标识
 * @returns {Promise<object[]>} 记忆目标描述符数组
 */
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
// RAG 查询与检索处理
// =============================================================================

/**
 * 创建记忆能力描述符
 * 描述 RAG 系统支持的特性（时间感知、分组感知、重排序等）
 * @param {object} params - 参数对象
 * @param {boolean} params.includeTargets - 是否包含目标列表
 * @param {object[]} params.targets - 记忆目标数组
 * @param {object} params.ragPlugin - RAG 插件实例
 * @param {object} params.knowledgeBaseManager - 知识库管理器
 * @returns {object} 记忆能力描述符
 */
/**
 * 获取记忆写入插件信息
 * 检查是否存在可用的 DailyNote 写入工具
 * @param {object} pluginManager - 插件管理器
 * @returns {object|null} 插件信息对象（包含 name 和 executionMode）或 null
 */
function getOpenClawMemoryWritePluginInfo(pluginManager) {
    // 辅助函数：按名称查找插件
    const resolvePlugin = (pluginName) => pluginManager?.getPlugin?.(pluginName) || pluginManager?.plugins?.get?.(pluginName) || null;

    // 优先使用 DailyNote 工具（推荐方式）
    const dailyNotePlugin = resolvePlugin('DailyNote');
    if (dailyNotePlugin) {
        return {
            name: 'DailyNote',
            executionMode: 'tool'
        };
    }

    return null;
}

/**
 * 获取记忆写入存储
 * 用于幂等键和内容指纹去重的内存存储
 * @param {object} pluginManager - 插件管理器
 * @returns {object} 存储对象（包含 entriesByIdempotencyKey 和 entriesByFingerprint 两个 Map）
 */
function getOpenClawMemoryWriteStore(pluginManager) {
    // 延迟初始化存储，避免在模块加载时创建
    if (!pluginManager.__openClawMemoryWriteStore) {
        pluginManager.__openClawMemoryWriteStore = {
            entriesByIdempotencyKey: new Map(),  // 按幂等键索引
            entriesByFingerprint: new Map()      // 按内容指纹索引
        };
    }
    return pluginManager.__openClawMemoryWriteStore;
}

/**
 * 规范化记忆标签
 * 去重并截断，供必填 tags 校验与写回使用
 * @param {string[]} tags - 原始标签数组
 * @returns {string[]} 规范化后的标签数组，最多 16 个
 */
function normalizeOpenClawMemoryTags(tags) {
    const normalizedTags = [...new Set(normalizeOpenClawStringArray(tags))];
    return normalizedTags.slice(0, 16);
}

/**
 * 解析记忆时间戳，生成日期字符串和时间标签
 * @param {any} timestampValue - 时间戳值（支持 ISO 字符串或 Unix 时间戳）
 * @returns {object} 包含 timestamp（ISO 格式）、dateString（YYYY-MM-DD）和 timeLabel（HH:mm）的对象
 */
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

/**
 * 构建记忆写入的 MAID（作者标识）
 * 格式：[日记本名]作者名，移除作者名中已有的方括号前缀
 * @param {object} params - 参数对象
 * @param {string} params.diaryName - 日记本名称
 * @param {object} params.target - 目标对象（包含 maid/author/agent）
 * @param {object} params.requestContext - 请求上下文
 * @returns {string} MAID 字符串
 */
function buildOpenClawMemoryWriteMaid({ diaryName, target, requestContext }) {
    // 按优先级获取作者：target.maid > target.author > target.agent > requestContext.agentId > requestContext.source > 'OpenClaw'
    const requestedAuthor = normalizeOpenClawString(
        target?.maid ||
        target?.author ||
        target?.agent ||
        requestContext?.agentId ||
        requestContext?.source
    ) || 'OpenClaw';
    // 移除已有的方括号前缀（如 [其他日记本]作者名）
    const normalizedAuthor = requestedAuthor.replace(/^\[[^\]]*\]/, '').trim() || 'OpenClaw';
    return `[${diaryName}]${normalizedAuthor}`;
}

/**
 * 规范化记忆元数据
 * 过滤无效键值，序列化复杂类型，截断长字符串（最多 500 字符）
 * @param {object} metadata - 原始元数据对象
 * @returns {object} 规范化后的元数据对象
 */
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
        // 字符串类型：规范化并截断
        if (typeof rawValue === 'string') {
            const value = normalizeOpenClawString(rawValue);
            if (value) {
                normalizedMetadata[key] = value.slice(0, 500);
            }
            continue;
        }
        // 数字和布尔类型：直接使用
        if (typeof rawValue === 'number' || typeof rawValue === 'boolean') {
            normalizedMetadata[key] = rawValue;
            continue;
        }
        // 其他类型：尝试 JSON 序列化并截断
        try {
            const serializedValue = JSON.stringify(rawValue);
            if (serializedValue) {
                normalizedMetadata[key] = serializedValue.slice(0, 500);
            }
        } catch (error) {
            // 序列化失败，跳过该键
        }
    }
    return normalizedMetadata;
}

/**
 * 构建记忆写入内容
 * 添加时间标签前缀，并将元数据追加为 Meta- 开头的行
 * @param {object} params - 参数对象
 * @param {string} params.text - 记忆文本内容
 * @param {string} params.timeLabel - 时间标签（HH:mm 格式）
 * @param {object} params.metadata - 元数据对象
 * @returns {string} 格式化后的内容字符串
 */
function buildOpenClawMemoryWriteContent({ text, timeLabel, metadata }) {
    const normalizedText = normalizeOpenClawContentText(text);
    if (!normalizedText) {
        return '';
    }

    const lines = [];
    // 如果文本已有时间标签前缀，直接使用；否则添加当前时间标签
    const textWithTime = /^\[\d{2}:\d{2}(?::\d{2})?\]/.test(normalizedText)
        ? normalizedText
        : `[${timeLabel}] ${normalizedText}`;
    lines.push(textWithTime);

    // 追加元数据行（格式：Meta-键名: 值）
    const normalizedMetadata = normalizeOpenClawMemoryMetadata(metadata);
    for (const [key, value] of Object.entries(normalizedMetadata)) {
        const renderedValue = typeof value === 'string' ? value : JSON.stringify(value);
        lines.push(`Meta-${key}: ${renderedValue}`);
    }

    return lines.join('\n');
}

/**
 * 创建记忆内容指纹（SHA256 哈希）
 * 用于去重检测，相同内容会生成相同的指纹
 * @param {object} params - 参数对象
 * @param {string} params.diaryName - 日记本名称
 * @param {string} params.text - 记忆文本
 * @param {string[]} params.tags - 标签数组
 * @param {string} params.agentId - Agent ID
 * @param {string} params.source - 来源标识
 * @param {object} params.metadata - 元数据对象
 * @returns {string} SHA256 指纹字符串
 */
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

/**
 * 检查是否存在重复的记忆写入记录
 * 优先检查幂等键，其次检查内容指纹
 * @param {object} store - 记忆写入存储对象
 * @param {object} params - 参数对象
 * @param {string} params.idempotencyKey - 幂等键
 * @param {string} params.fingerprint - 内容指纹
 * @param {boolean} params.deduplicate - 是否启用内容去重
 * @returns {object|null} 重复的记录对象或 null
 */
function resolveOpenClawMemoryDuplicate(store, { idempotencyKey, fingerprint, deduplicate }) {
    const normalizedIdempotencyKey = normalizeOpenClawString(idempotencyKey);
    // 优先检查幂等键（外部提供的业务唯一标识）
    if (normalizedIdempotencyKey && store.entriesByIdempotencyKey.has(normalizedIdempotencyKey)) {
        return store.entriesByIdempotencyKey.get(normalizedIdempotencyKey);
    }
    // 其次检查内容指纹（基于内容哈希的去重）
    if (deduplicate && fingerprint && store.entriesByFingerprint.has(fingerprint)) {
        return store.entriesByFingerprint.get(fingerprint);
    }
    return null;
}

/**
 * 记录已写入的记忆
 * 将记录同时存入幂等键索引和指纹索引
 * @param {object} store - 记忆写入存储对象
 * @param {object} record - 记忆记录对象
 */
function rememberOpenClawMemoryWrite(store, record) {
    // 按幂等键索引
    if (record?.idempotencyKey) {
        store.entriesByIdempotencyKey.set(record.idempotencyKey, record);
    }
    // 按内容指纹索引
    if (record?.fingerprint) {
        store.entriesByFingerprint.set(record.fingerprint, record);
    }
}

/**
 * 从写入结果中提取文件路径
 * 支持多种结果格式：直接返回的 path/filePath、嵌套在 result 中的路径、消息文本中的路径
 * @param {object} result - 写入操作返回的结果对象
 * @returns {string} 提取的文件路径，未找到时返回空字符串
 */
function extractOpenClawMemoryWritePath(result) {
    // 按优先级尝试多个可能的路径来源
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
        // 匹配 "Diary saved to /path/to/file" 格式的消息
        const savedPathMatch = normalizedCandidate.match(/Diary saved to\s+(.+)$/i);
        if (savedPathMatch?.[1]) {
            return savedPathMatch[1].trim();
        }
        // 包含路径分隔符或有文件扩展名的视为有效路径
        if (normalizedCandidate.includes(path.sep) || /\.[A-Za-z0-9]+$/.test(normalizedCandidate)) {
            return normalizedCandidate;
        }
    }
    return '';
}

/**
 * 创建记忆条目唯一 ID（SHA256 哈希，取前 24 位）
 * 基于日记本名称、文件路径、内容指纹和时间戳生成
 * @param {object} params - 参数对象
 * @param {string} params.diaryName - 日记本名称
 * @param {string} params.filePath - 文件路径
 * @param {string} params.fingerprint - 内容指纹
 * @param {string} params.timestamp - 时间戳
 * @returns {string} 24 字符的条目 ID
 */
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

/**
 * 将记忆写入错误映射为 HTTP 错误响应
 * 根据错误内容识别特定错误类型：无效载荷（400）或写入失败（500）
 * @param {Error} error - 错误对象
 * @returns {object} HTTP 错误信息对象（包含 status、code、error、details）
 */
function mapOpenClawMemoryWriteError(error) {
    const parsedError = parseOpenClawPluginError(error);
    const pluginError = normalizeOpenClawString(
        parsedError.plugin_error ||
        parsedError.plugin_execution_error ||
        parsedError.error ||
        error?.message ||
        'Unknown memory write error'
    );
    // 识别参数缺失、必填项、格式无效等客户端错误
    if (/missing|required|invalid|must be|security/i.test(pluginError)) {
        return {
            status: 400,
            code: 'OCW_MEMORY_INVALID_PAYLOAD',
            error: 'Memory payload is invalid',
            details: { pluginError }
        };
    }
    // 其他视为服务端错误
    return {
        status: 500,
        code: 'OCW_MEMORY_WRITE_ERROR',
        error: 'Failed to persist memory',
        details: { pluginError }
    };
}

/**
 * 执行 OpenClaw durable memory 写回
 * 同时供专用 memory/write 路由与内部工具桥接复用
 * @param {object} pluginManager - 插件管理器
 * @param {object} params - 写回参数
 * @param {object} params.body - 请求体
 * @param {number} params.startedAt - 请求开始时间
 * @param {string} params.clientIp - 客户端 IP
 * @param {string} params.defaultSource - 默认来源标识
 * @returns {Promise<object>} 统一结果对象
 */
async function performOpenClawMemoryWrite(pluginManager, { body, startedAt, clientIp, defaultSource }) {
    const requestContext = body?.requestContext;
    const requestId = createOpenClawRequestId(requestContext?.requestId);
    const agentId = normalizeOpenClawString(requestContext?.agentId);
    const sessionId = normalizeOpenClawString(requestContext?.sessionId);
    const source = normalizeOpenClawString(requestContext?.source) || normalizeOpenClawString(defaultSource) || 'openclaw-memory';
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
            code: 'OCW_INVALID_REQUEST',
            error: 'requestContext.agentId and requestContext.sessionId are required',
            details: { field: 'requestContext' }
        };
    }
    if (!targetDiary) {
        return {
            success: false,
            requestId,
            status: 400,
            code: 'OCW_MEMORY_INVALID_PAYLOAD',
            error: 'target.diary is required',
            details: { field: 'target.diary' }
        };
    }
    if (!memoryText) {
        return {
            success: false,
            requestId,
            status: 400,
            code: 'OCW_MEMORY_INVALID_PAYLOAD',
            error: 'memory.text is required',
            details: { field: 'memory.text' }
        };
    }
    if (tags.length === 0) {
        return {
            success: false,
            requestId,
            status: 400,
            code: 'OCW_MEMORY_INVALID_PAYLOAD',
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
            code: 'OCW_MEMORY_TARGET_FORBIDDEN',
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
            code: 'OCW_MEMORY_WRITE_ERROR',
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

/**
 * 创建 OpenClaw 记忆能力描述符
 * 描述 RAG 系统支持的特性（时间感知、分组感知、重排序、标签增强、回写等）
 * @param {object} params - 参数对象
 * @param {boolean} params.includeTargets - 是否包含目标列表
 * @param {object[]} params.targets - 记忆目标数组
 * @param {object} params.ragPlugin - RAG 插件实例
 * @param {object} params.knowledgeBaseManager - 知识库管理器
 * @param {object} params.pluginManager - 插件管理器
 * @returns {object} 记忆能力描述符对象
 */
function createOpenClawMemoryDescriptor({ includeTargets, targets, ragPlugin, knowledgeBaseManager, pluginManager }) {
    return {
        targets: includeTargets ? targets : [],
        features: {
            timeAware: Boolean(ragPlugin?.timeParser?.parse),              // 是否支持时间范围解析
            groupAware: Boolean(ragPlugin?.semanticGroups?.getEnhancedVector), // 是否支持语义分组增强
            rerank: Boolean(ragPlugin?._rerankDocuments),                   // 是否支持重排序
            tagMemo: Boolean(knowledgeBaseManager?.applyTagBoost),         // 是否支持标签增强
            writeBack: Boolean(getOpenClawMemoryWritePluginInfo(pluginManager)) // 是否支持记忆回写
        }
    };
}

/**
 * 规范化 RAG 模式参数
 * 支持：rag（纯向量检索）、hybrid（混合检索）、auto（自动选择）
 * @param {string} mode - 模式字符串
 * @returns {string|null} 规范化的模式名或 null
 */
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

/**
 * 提取 RAG 查询选项
 * 合并请求参数和默认值，hybrid 模式默认启用更多特性
 * @param {object} body - 请求体
 * @returns {object} RAG 选项对象
 */
function extractOpenClawRagOptions(body) {
    const mode = normalizeOpenClawRagMode(body?.mode);
    const bodyOptions = body?.options && typeof body.options === 'object' && !Array.isArray(body.options)
        ? body.options
        : {};
    // hybrid 模式默认启用更多特性
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

/**
 * 计算两个向量间的余弦相似度
 * @param {number[]} vectorA - 向量 A
 * @param {number[]} vectorB - 向量 B
 * @returns {number} 余弦相似度（-1 到 1）
 */
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

/**
 * 获取查询文本的嵌入向量
 * 优先使用 RAG 插件的缓存方法，否则使用 EmbeddingUtils
 * @param {string} query - 查询文本
 * @param {object} ragPlugin - RAG 插件实例
 * @param {object} knowledgeBaseManager - 知识库管理器
 * @returns {Promise<number[]|null>} 嵌入向量或 null
 */
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

/**
 * 从标签提升信息中提取核心标签
 * @param {object} boostInfo - 标签提升信息
 * @returns {string[]} 核心标签数组
 */
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

/**
 * 规范化时间戳值
 * 支持 ISO 字符串和 Unix 时间戳
 * @param {any} value - 输入值
 * @returns {string|null} ISO 格式时间戳或 null
 */
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

/**
 * 从文件路径中提取日期时间戳
 * 匹配文件名中的 YYYY-MM-DD 或 YYYY.MM.DD 格式
 * @param {string} sourcePath - 文件路径
 * @returns {string|null} ISO 格式时间戳或 null
 */
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

/**
 * 获取文件的元数据信息
 * @param {object} knowledgeBaseManager - 知识库管理器
 * @param {string} sourcePath - 文件路径
 * @returns {Promise<object|null>} 文件元数据或 null
 */
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

/**
 * 获取缓存的文件元数据
 * 使用 Map 缓存避免重复查询
 * @param {Map} metadataCache - 元数据缓存 Map
 * @param {object} knowledgeBaseManager - 知识库管理器
 * @param {string} sourcePath - 文件路径
 * @returns {Promise<object|null>} 文件元数据或 null
 */
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

/**
 * 规范化 RAG 检索结果项
 * 统一字段名、提取元数据、格式化时间戳
 * @param {object} result - 原始检索结果
 * @param {string} fallbackDiary - 默认日记本名称
 * @param {object} knowledgeBaseManager - 知识库管理器
 * @param {Map} metadataCache - 元数据缓存
 * @returns {Promise<object>} 规范化的 RAG 项目
 */
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

/**
 * 对 RAG 候选结果进行去重
 * 基于 sourceDiary、sourcePath 和 text 的组合键去重，保留最高分
 * @param {object[]} candidates - 候选结果数组
 * @returns {object[]} 去重后的候选结果
 */
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

/**
 * 规范化内容文本
 * 支持字符串、数组和对象形式的输入
 * @param {any} content - 内容值
 * @returns {string} 规范化后的文本
 */
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

/**
 * 规范化对话消息数组
 * 提取最近的消息，限制数量并格式化
 * @param {any[]} messages - 消息数组
 * @returns {object[]} 规范化的消息对象数组（包含 role 和 text）
 */
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

/**
 * 构建回忆查询文本
 * 优先使用显式查询，否则从对话消息中构建
 * @param {object} body - 请求体
 * @returns {string} 查询文本
 */
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

/**
 * 估算文本的 Token 数量
 * 使用简单启发式：CJK 字符计为 1 个 Token，其他字符每 4 个计为 1 个 Token
 * @param {string} text - 输入文本
 * @returns {number} 估算的 Token 数量
 */
function estimateOpenClawTokenCount(text) {
    const normalizedText = normalizeOpenClawString(text);
    if (!normalizedText) {
        return 0;
    }
    const cjkCount = (normalizedText.match(/[\u3400-\u9fff]/g) || []).length;
    const nonCjkCount = normalizedText.length - cjkCount;
    return Math.max(1, cjkCount + Math.ceil(nonCjkCount / 4));
}

/**
 * 按 Token 数量截断文本
 * @param {string} text - 输入文本
 * @param {number} maxTokens - 最大 Token 数
 * @returns {string} 截断后的文本
 */
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

/**
 * 创建回忆上下文块
 * 包含文本内容和元数据（分数、来源、时间戳、标签、Token 估算）
 * @param {object} item - RAG 结果项
 * @returns {object} 上下文块对象
 */
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

/**
 * 对回忆上下文块进行去重
 * 基于 sourceDiary、sourceFile 和 text 的组合键去重，保留最高分
 * @param {object[]} blocks - 上下文块数组
 * @returns {object[]} 去重后的上下文块数组
 */
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

// =============================================================================
// Schema 验证与错误处理
// =============================================================================

/**
 * 验证值是否符合 JSON Schema
 * 支持 oneOf、const、object、string、number、boolean、array 类型
 * @param {object} schema - JSON Schema 对象
 * @param {any} value - 待验证的值
 * @param {string} pathName - 当前路径名（用于错误信息）
 * @returns {string[]} 错误信息数组，空数组表示验证通过
 */
function validateOpenClawSchemaValue(schema, value, pathName = 'args') {
    if (!schema || typeof schema !== 'object') {
        return [];
    }
    // 处理 oneOf（多选一）
    if (Array.isArray(schema.oneOf)) {
        const variantErrors = schema.oneOf
            .map((candidate) => validateOpenClawSchemaValue(candidate, value, pathName));
        if (variantErrors.some((errors) => errors.length === 0)) {
            return [];
        }
        return variantErrors[0] || [`${pathName} does not match any supported input shape`];
    }
    // 处理常量值
    if (schema.const !== undefined && value !== schema.const) {
        return [`${pathName} must equal ${JSON.stringify(schema.const)}`];
    }
    // 处理对象类型
    if (schema.type === 'object') {
        if (!value || typeof value !== 'object' || Array.isArray(value)) {
            return [`${pathName} must be an object`];
        }
        const errors = [];
        const required = Array.isArray(schema.required) ? schema.required : [];
        for (const key of required) {
            if (!(key in value)) {
                errors.push(`${pathName}.${key} is required`);
            }
        }
        const properties = schema.properties && typeof schema.properties === 'object' ? schema.properties : {};
        for (const [key, propertySchema] of Object.entries(properties)) {
            if (key in value) {
                errors.push(...validateOpenClawSchemaValue(propertySchema, value[key], `${pathName}.${key}`));
            }
        }
        return errors;
    }
    // 处理基本类型
    if (schema.type === 'string' && typeof value !== 'string') {
        return [`${pathName} must be a string`];
    }
    if (schema.type === 'number' && (typeof value !== 'number' || Number.isNaN(value))) {
        return [`${pathName} must be a number`];
    }
    if (schema.type === 'boolean' && typeof value !== 'boolean') {
        return [`${pathName} must be a boolean`];
    }
    if (schema.type === 'array' && !Array.isArray(value)) {
        return [`${pathName} must be an array`];
    }
    return [];
}

/**
 * 解析插件错误信息
 * 尝试将错误消息解析为 JSON 对象
 * @param {Error} error - 错误对象
 * @returns {object} 解析后的错误对象
 */
function parseOpenClawPluginError(error) {
    const rawMessage = error?.message || 'Unknown tool execution error';
    try {
        const parsed = JSON.parse(rawMessage);
        if (parsed && typeof parsed === 'object') {
            return parsed;
        }
    } catch (parseError) {
    }
    return {
        plugin_error: rawMessage
    };
}

/**
 * 将工具执行错误映射为 HTTP 错误响应
 * 根据错误内容识别特定错误类型：工具不存在、需要审批、超时等
 * @param {string} toolName - 工具名称
 * @param {Error} error - 错误对象
 * @returns {object} HTTP 错误信息对象
 */
function mapOpenClawToolExecutionError(toolName, error) {
    const parsedError = parseOpenClawPluginError(error);
    const pluginError = normalizeOpenClawString(
        parsedError.plugin_error ||
        parsedError.plugin_execution_error ||
        parsedError.error ||
        error?.message ||
        'Unknown tool execution error'
    );
    // 工具不存在
    if (/not found/i.test(pluginError)) {
        return {
            status: 404,
            code: 'OCW_TOOL_NOT_FOUND',
            error: 'Tool not found',
            details: { toolName, pluginError }
        };
    }
    // 需要审批
    if (/approval/i.test(pluginError) && /reject|required|cannot/i.test(pluginError)) {
        return {
            status: 403,
            code: 'OCW_TOOL_APPROVAL_REQUIRED',
            error: 'Tool approval required',
            details: { toolName, pluginError }
        };
    }
    // 执行超时
    if (/timed out|timeout/i.test(pluginError)) {
        return {
            status: 504,
            code: 'OCW_TOOL_TIMEOUT',
            error: 'Tool execution timed out',
            details: { toolName, pluginError }
        };
    }
    // 通用执行错误
    return {
        status: 500,
        code: 'OCW_TOOL_EXECUTION_ERROR',
        error: 'Tool execution failed',
        details: { toolName, pluginError }
    };
}

/**
 * 记录 OpenClaw 审计日志
 * @param {string} event - 事件名称
 * @param {object} payload - 事件载荷
 */
function logOpenClawAudit(event, payload) {
    console.log(`${OPENCLAW_AUDIT_LOG_PREFIX} ${JSON.stringify({ event, ...payload })}`);
}

/**
 * 汇总分数统计信息
 * 计算分数数组的计数、最大值、最小值和平均值
 * @param {number[]} values - 分数数组
 * @returns {object} 统计结果对象，包含 count、max、min、avg；无有效分数时返回 null 值
 */
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
// OpenClaw 桥接路由定义
// =============================================================================

/**
 * 创建 OpenClaw 桥接路由
 * @param {object} pluginManager - 插件管理器实例
 * @returns {Router} Express 路由实例
 */
module.exports = function createOpenClawBridgeRoutes(pluginManager) {
    if (!pluginManager) {
        throw new Error('[OpenClawBridgeRoutes] pluginManager is required');
    }

    const router = express.Router();

    // -------------------------------------------------------------------------
    // GET /openclaw/capabilities
    // 获取 OpenClaw 能力清单：可用工具列表和记忆系统特性
    // -------------------------------------------------------------------------
    router.get('/openclaw/capabilities', async (req, res) => {
        const startedAt = Date.now();
        const agentId = normalizeOpenClawString(req.query.agentId);
        const maid = normalizeOpenClawString(req.query.maid);
        const requestId = createOpenClawRequestId(req.query.requestId);
        const includeMemoryTargets = parseOpenClawBooleanQuery(req.query.includeMemoryTargets, true);

        // 验证必需参数
        if (!agentId) {
            return sendOpenClawError(res, {
                status: 400,
                requestId,
                startedAt,
                code: 'OCW_INVALID_REQUEST',
                error: 'agentId is required',
                details: { field: 'agentId' }
            });
        }

        try {
            // 收集可桥接的工具列表
            const tools = Array.from(pluginManager.plugins.values())
                .filter((plugin) => isOpenClawBridgeablePlugin(plugin))
                .sort((left, right) => left.name.localeCompare(right.name))
                .map((plugin) => createOpenClawToolDescriptor(plugin, pluginManager));
            const ragPlugin = getOpenClawRagPlugin(pluginManager);
            const knowledgeBaseManager = getOpenClawKnowledgeBaseManager(pluginManager);
            const memoryTargets = includeMemoryTargets
                ? await resolveOpenClawMemoryTargets(pluginManager, agentId, maid)
                : [];

            return sendOpenClawSuccess(res, {
                requestId,
                startedAt,
                data: {
                    server: {
                        name: 'VCPToolBox',
                        version: packageJson.version,
                        bridgeVersion: OPENCLAW_BRIDGE_VERSION
                    },
                    tools,
                    memory: createOpenClawMemoryDescriptor({
                        includeTargets: includeMemoryTargets,
                        targets: memoryTargets,
                        ragPlugin,
                        knowledgeBaseManager,
                        pluginManager
                    })
                }
            });
        } catch (error) {
            console.error('[OpenClawBridgeRoutes] Error building OpenClaw capabilities:', error);
            return sendOpenClawError(res, {
                status: 500,
                requestId,
                startedAt,
                code: 'OCW_INTERNAL_ERROR',
                error: 'Failed to build bridge capabilities',
                details: { message: error.message }
            });
        }
    });

    // -------------------------------------------------------------------------
    // GET /openclaw/rag/targets
    // 获取当前 Agent 可访问的 RAG 目标（日记本）列表
    // -------------------------------------------------------------------------
    router.get('/openclaw/rag/targets', async (req, res) => {
        const startedAt = Date.now();
        const agentId = normalizeOpenClawString(req.query.agentId);
        const maid = normalizeOpenClawString(req.query.maid);
        const requestId = createOpenClawRequestId(req.query.requestId);

        // 验证必需参数
        if (!agentId) {
            return sendOpenClawError(res, {
                status: 400,
                requestId,
                startedAt,
                code: 'OCW_INVALID_REQUEST',
                error: 'agentId is required',
                details: { field: 'agentId' }
            });
        }

        try {
            const targets = await resolveOpenClawMemoryTargets(pluginManager, agentId, maid);
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
                code: 'OCW_INTERNAL_ERROR',
                error: 'Failed to load RAG targets',
                details: { message: error.message }
            });
        }
    });

    // -------------------------------------------------------------------------
    // POST /openclaw/rag/search
    // 执行 RAG 语义检索，支持多种检索模式（rag/hybrid/auto）
    // 可选特性：时间感知、分组感知、标签增强、重排序
    // -------------------------------------------------------------------------
    router.post('/openclaw/rag/search', async (req, res) => {
        const startedAt = Date.now();
        const query = normalizeOpenClawString(req.body?.query);
        const { diary, diaries: requestedDiaries } = resolveOpenClawDiarySelection(req.body);
        const maid = normalizeOpenClawString(req.body?.maid);
        const requestContext = req.body?.requestContext;
        const requestId = createOpenClawRequestId(requestContext?.requestId);
        const agentId = normalizeOpenClawString(requestContext?.agentId);
        const sessionId = normalizeOpenClawString(requestContext?.sessionId);
        const source = normalizeOpenClawString(requestContext?.source) || 'openclaw';
        const ragOptions = extractOpenClawRagOptions(req.body);

        // 验证必需参数
        if (!query) {
            return sendOpenClawError(res, {
                status: 400,
                requestId,
                startedAt,
                code: 'OCW_RAG_INVALID_QUERY',
                error: 'query is required',
                details: { field: 'query' }
            });
        }
        if (!agentId || !sessionId) {
            return sendOpenClawError(res, {
                status: 400,
                requestId,
                startedAt,
                code: 'OCW_INVALID_REQUEST',
                error: 'requestContext.agentId and requestContext.sessionId are required',
                details: { field: 'requestContext' }
            });
        }
        if (!ragOptions.mode) {
            return sendOpenClawError(res, {
                status: 400,
                requestId,
                startedAt,
                code: 'OCW_RAG_INVALID_QUERY',
                error: 'mode must be one of rag, hybrid, auto',
                details: { field: 'mode' }
            });
        }

        // 记录审计日志
        logOpenClawAudit('rag.search.started', {
            requestId,
            source,
            agentId,
            sessionId,
            diary,
            diaries: requestedDiaries,
            mode: ragOptions.mode
        });

        try {
            const knowledgeBaseManager = getOpenClawKnowledgeBaseManager(pluginManager);
            const ragPlugin = getOpenClawRagPlugin(pluginManager);
            const availableDiaries = await listOpenClawDiaryTargets(knowledgeBaseManager);
            const allowedDiaries = resolveOpenClawAllowedDiaries({
                agentId,
                maid,
                availableDiaries,
                ragConfig: getOpenClawRagConfig(pluginManager)
            });

            // 验证日记本访问权限
            const missingDiaries = requestedDiaries.filter((requestedDiary) => !availableDiaries.includes(requestedDiary));
            if (missingDiaries.length > 0) {
                return sendOpenClawError(res, {
                    status: 404,
                    requestId,
                    startedAt,
                    code: 'OCW_RAG_TARGET_NOT_FOUND',
                    error: 'Requested diary target was not found',
                    details: {
                        diary: missingDiaries[0],
                        diaries: missingDiaries
                    }
                });
            }
            const forbiddenDiaries = requestedDiaries.filter((requestedDiary) => !allowedDiaries.includes(requestedDiary));
            if (forbiddenDiaries.length > 0) {
                return sendOpenClawError(res, {
                    status: 403,
                    requestId,
                    startedAt,
                    code: 'OCW_RAG_TARGET_FORBIDDEN',
                    error: 'Requested diary target is not allowed for this agent',
                    details: {
                        diary: forbiddenDiaries[0],
                        diaries: forbiddenDiaries,
                        agentId
                    }
                });
            }

            const targetDiaries = requestedDiaries.length > 0 ? requestedDiaries : allowedDiaries;
            if (targetDiaries.length === 0) {
                return sendOpenClawError(res, {
                    status: 403,
                    requestId,
                    startedAt,
                    code: 'OCW_RAG_TARGET_FORBIDDEN',
                    error: 'No accessible diary targets are configured for this agent',
                    details: { agentId }
                });
            }

            // 生成查询嵌入向量
            const queryVector = await getOpenClawQueryVector(query, ragPlugin, knowledgeBaseManager);
            if (!Array.isArray(queryVector) || queryVector.length === 0) {
                throw new Error('Failed to build query embedding');
            }

            // 分组感知增强（可选）
            let finalQueryVector = queryVector;
            let activatedGroups = new Map();
            if (
                ragOptions.groupAware &&
                ragPlugin?.semanticGroups?.detectAndActivateGroups &&
                ragPlugin?.semanticGroups?.getEnhancedVector
            ) {
                activatedGroups = ragPlugin.semanticGroups.detectAndActivateGroups(query);
                const enhancedVector = await ragPlugin.semanticGroups.getEnhancedVector(query, activatedGroups, queryVector);
                if (Array.isArray(enhancedVector) && enhancedVector.length > 0) {
                    finalQueryVector = enhancedVector;
                }
            }

            // 标签增强（可选）
            let scoringVector = finalQueryVector;
            let coreTags = [];
            if (ragOptions.tagMemo && typeof knowledgeBaseManager?.applyTagBoost === 'function') {
                const boostResult = knowledgeBaseManager.applyTagBoost(new Float32Array(finalQueryVector), OPENCLAW_TAG_BOOST);
                if (boostResult?.vector) {
                    scoringVector = Array.from(boostResult.vector);
                }
                coreTags = extractOpenClawCoreTags(boostResult?.info);
            }

            // 语义检索（向量搜索）
            const semanticSearchK = ragOptions.rerank
                ? Math.max(ragOptions.k * 2, 10)
                : Math.max(ragOptions.k, OPENCLAW_DEFAULT_RAG_K);
            const semanticResults = await Promise.all(
                targetDiaries.map(async (targetDiary) => {
                    const results = await Promise.resolve(
                        knowledgeBaseManager.search(
                            targetDiary,
                            finalQueryVector,
                            semanticSearchK,
                            ragOptions.tagMemo ? OPENCLAW_TAG_BOOST : 0,
                            coreTags
                        )
                    );
                    return Array.isArray(results)
                        ? results.map((result) => ({
                            ...result,
                            sourceDiary: normalizeOpenClawString(result.sourceDiary || targetDiary),
                            source: 'rag'
                        }))
                        : [];
                })
            );

            // 时间范围解析（可选）
            let timeRanges = [];
            if (ragOptions.timeAware && ragPlugin?.timeParser?.parse) {
                timeRanges = ragPlugin.timeParser.parse(query);
            }

            // 时间范围检索（可选）
            let timeResults = [];
            if (
                timeRanges.length > 0 &&
                ragPlugin?._getTimeRangeFilePaths &&
                typeof knowledgeBaseManager?.getChunksByFilePaths === 'function'
            ) {
                const targetFilePathGroups = await Promise.all(
                    targetDiaries.map(async (targetDiary) => {
                        const filePaths = await Promise.all(
                            timeRanges.map((timeRange) => Promise.resolve(ragPlugin._getTimeRangeFilePaths(targetDiary, timeRange)))
                        );
                        return filePaths.flat();
                    })
                );
                const timeFilePaths = [...new Set(targetFilePathGroups.flat())];
                const timeChunks = timeFilePaths.length > 0
                    ? await Promise.resolve(knowledgeBaseManager.getChunksByFilePaths(timeFilePaths))
                    : [];
                timeResults = Array.isArray(timeChunks)
                    ? timeChunks.map((chunk) => ({
                        ...chunk,
                        score: ragPlugin?.cosineSimilarity
                            ? ragPlugin.cosineSimilarity(scoringVector, Array.from(chunk.vector || []))
                            : computeOpenClawCosineSimilarity(scoringVector, Array.from(chunk.vector || [])),
                        sourceDiary: normalizeOpenClawString(chunk.sourceDiary || normalizeOpenClawString(chunk.sourceFile).split('/')[0]),
                        source: 'time'
                    }))
                    : [];
            }

            // 合并并去重结果
            let candidates = deduplicateOpenClawRagCandidates([...semanticResults.flat(), ...timeResults]);
            if (typeof knowledgeBaseManager?.deduplicateResults === 'function' && candidates.length > 1) {
                candidates = await Promise.resolve(knowledgeBaseManager.deduplicateResults(candidates, finalQueryVector));
            }
            const scoredCandidates = candidates.filter((candidate) => typeof candidate?.score === 'number' && Number.isFinite(candidate.score));

            // 重排序（可选）
            let rerankApplied = false;
            if (ragOptions.rerank && candidates.length > 0 && ragPlugin?._rerankDocuments) {
                candidates = await Promise.resolve(ragPlugin._rerankDocuments(query, candidates, ragOptions.k));
                rerankApplied = true;
            } else {
                candidates.sort((left, right) => (right.score || 0) - (left.score || 0));
                candidates = candidates.slice(0, ragOptions.k);
            }

            // 规范化结果项
            const metadataCache = new Map();
            const items = await Promise.all(
                candidates
                    .filter((candidate) => normalizeOpenClawString(candidate?.text))
                    .slice(0, ragOptions.k)
                    .map((candidate) => normalizeOpenClawRagItem(
                        candidate,
                        normalizeOpenClawString(candidate?.sourceDiary),
                        knowledgeBaseManager,
                        metadataCache
                    ))
            );
            const scoredItems = items.filter((item) => typeof item.score === 'number' && Number.isFinite(item.score));

            // 记录成功审计日志
            logOpenClawAudit('rag.search.completed', {
                requestId,
                source,
                agentId,
                sessionId,
                diary,
                diaries: requestedDiaries,
                resultCount: items.length,
                filteredByResultWindow: Math.max(0, scoredCandidates.length - scoredItems.length),
                scoreStats: {
                    candidates: summarizeOpenClawScoreStats(scoredCandidates.map((candidate) => candidate.score)),
                    returned: summarizeOpenClawScoreStats(scoredItems.map((item) => item.score))
                },
                durationMs: Math.max(0, Date.now() - startedAt)
            });

            return sendOpenClawSuccess(res, {
                requestId,
                startedAt,
                data: {
                    items,
                    diagnostics: {
                        mode: ragOptions.mode,
                        targetDiaries,
                        resultCount: items.length,
                        timeAwareApplied: ragOptions.timeAware && timeRanges.length > 0,
                        groupAwareApplied: ragOptions.groupAware && activatedGroups.size > 0,
                        rerankApplied,
                        tagMemoApplied: ragOptions.tagMemo && coreTags.length > 0,
                        coreTags,
                        durationMs: Math.max(0, Date.now() - startedAt)
                    }
                }
            });
        } catch (error) {
            console.error('[OpenClawBridgeRoutes] Error searching OpenClaw RAG:', error);
            logOpenClawAudit('rag.search.failed', {
                requestId,
                source,
                agentId,
                sessionId,
                diary,
                diaries: requestedDiaries,
                durationMs: Math.max(0, Date.now() - startedAt),
                code: 'OCW_RAG_SEARCH_ERROR'
            });
            return sendOpenClawError(res, {
                status: 500,
                requestId,
                startedAt,
                code: 'OCW_RAG_SEARCH_ERROR',
                error: 'Failed to execute RAG search',
                details: { message: error.message }
            });
        }
    });

    // -------------------------------------------------------------------------
    // POST /openclaw/rag/context
    // 构建 RAG 回忆上下文，返回结构化的上下文块供 LLM 使用
    // 支持 Token 预算控制、块数限制、分数阈值等策略
    // -------------------------------------------------------------------------
    router.post('/openclaw/rag/context', async (req, res) => {
        const startedAt = Date.now();
        const requestContext = req.body?.requestContext;
        const requestId = createOpenClawRequestId(requestContext?.requestId);
        const agentId = normalizeOpenClawString(req.body?.agentId || requestContext?.agentId);
        const sessionId = normalizeOpenClawString(req.body?.sessionId || requestContext?.sessionId);
        const source = normalizeOpenClawString(requestContext?.source) || 'openclaw-context';
        const maid = normalizeOpenClawString(req.body?.maid);
        const { diary, diaries: requestedDiaries } = resolveOpenClawDiarySelection(req.body);
        const query = buildOpenClawRecallQuery(req.body);
        // 解析上下文构建参数
        const maxBlocks = parseOpenClawInteger(
            req.body?.maxBlocks,
            OPENCLAW_DEFAULT_CONTEXT_MAX_BLOCKS,
            1,
            OPENCLAW_MAX_RAG_K
        );
        const tokenBudget = parseOpenClawInteger(
            req.body?.tokenBudget,
            OPENCLAW_DEFAULT_CONTEXT_TOKEN_BUDGET,
            1,
            OPENCLAW_MAX_CONTEXT_TOKEN_BUDGET
        );
        const maxTokenRatio = Math.min(
            1,
            Math.max(
                0.1,
                typeof req.body?.maxTokenRatio === 'number' && Number.isFinite(req.body.maxTokenRatio)
                    ? req.body.maxTokenRatio
                    : OPENCLAW_DEFAULT_CONTEXT_MAX_TOKEN_RATIO
            )
        );
        const minScore = typeof req.body?.minScore === 'number' && Number.isFinite(req.body.minScore)
            ? req.body.minScore
            : OPENCLAW_DEFAULT_CONTEXT_MIN_SCORE;
        const ragOptions = {
            ...extractOpenClawRagOptions({
                ...req.body,
                k: Math.max(maxBlocks * 2, OPENCLAW_DEFAULT_RAG_K),
                mode: req.body?.mode || 'hybrid'
            }),
            timeAware: parseOpenClawBooleanQuery(req.body?.timeAware, true),
            groupAware: parseOpenClawBooleanQuery(req.body?.groupAware, true),
            rerank: parseOpenClawBooleanQuery(req.body?.rerank, true),
            tagMemo: parseOpenClawBooleanQuery(req.body?.tagMemo, true)
        };

        // 验证必需参数
        if (!agentId || !sessionId) {
            return sendOpenClawError(res, {
                status: 400,
                requestId,
                startedAt,
                code: 'OCW_INVALID_REQUEST',
                error: 'agentId and sessionId are required',
                details: { field: 'agentId/sessionId' }
            });
        }
        if (!query) {
            return sendOpenClawError(res, {
                status: 400,
                requestId,
                startedAt,
                code: 'OCW_RAG_INVALID_QUERY',
                error: 'query or recentMessages is required',
                details: { field: 'query/recentMessages' }
            });
        }

        // 记录审计日志
        logOpenClawAudit('rag.context.started', {
            requestId,
            source,
            agentId,
            sessionId,
            diary,
            diaries: requestedDiaries
        });

        try {
            const knowledgeBaseManager = getOpenClawKnowledgeBaseManager(pluginManager);
            const ragPlugin = getOpenClawRagPlugin(pluginManager);
            const availableDiaries = await listOpenClawDiaryTargets(knowledgeBaseManager);
            const allowedDiaries = resolveOpenClawAllowedDiaries({
                agentId,
                maid,
                availableDiaries,
                ragConfig: getOpenClawRagConfig(pluginManager)
            });

            // 验证日记本访问权限
            const missingDiaries = requestedDiaries.filter((requestedDiary) => !availableDiaries.includes(requestedDiary));
            if (missingDiaries.length > 0) {
                return sendOpenClawError(res, {
                    status: 404,
                    requestId,
                    startedAt,
                    code: 'OCW_RAG_TARGET_NOT_FOUND',
                    error: 'Requested diary target was not found',
                    details: {
                        diary: missingDiaries[0],
                        diaries: missingDiaries
                    }
                });
            }
            const forbiddenDiaries = requestedDiaries.filter((requestedDiary) => !allowedDiaries.includes(requestedDiary));
            if (forbiddenDiaries.length > 0) {
                return sendOpenClawError(res, {
                    status: 403,
                    requestId,
                    startedAt,
                    code: 'OCW_RAG_TARGET_FORBIDDEN',
                    error: 'Requested diary target is not allowed for this agent',
                    details: {
                        diary: forbiddenDiaries[0],
                        diaries: forbiddenDiaries,
                        agentId
                    }
                });
            }

            const targetDiaries = requestedDiaries.length > 0 ? requestedDiaries : allowedDiaries;
            if (targetDiaries.length === 0) {
                return sendOpenClawError(res, {
                    status: 403,
                    requestId,
                    startedAt,
                    code: 'OCW_RAG_TARGET_FORBIDDEN',
                    error: 'No accessible diary targets are configured for this agent',
                    details: { agentId }
                });
            }

            // 生成查询嵌入向量
            const queryVector = await getOpenClawQueryVector(query, ragPlugin, knowledgeBaseManager);
            if (!Array.isArray(queryVector) || queryVector.length === 0) {
                throw new Error('Failed to build query embedding');
            }

            // 分组感知增强（可选）
            let finalQueryVector = queryVector;
            let activatedGroups = new Map();
            if (
                ragOptions.groupAware &&
                ragPlugin?.semanticGroups?.detectAndActivateGroups &&
                ragPlugin?.semanticGroups?.getEnhancedVector
            ) {
                activatedGroups = ragPlugin.semanticGroups.detectAndActivateGroups(query);
                const enhancedVector = await ragPlugin.semanticGroups.getEnhancedVector(query, activatedGroups, queryVector);
                if (Array.isArray(enhancedVector) && enhancedVector.length > 0) {
                    finalQueryVector = enhancedVector;
                }
            }

            // 标签增强（可选）
            let scoringVector = finalQueryVector;
            let coreTags = [];
            if (ragOptions.tagMemo && typeof knowledgeBaseManager?.applyTagBoost === 'function') {
                const boostResult = knowledgeBaseManager.applyTagBoost(new Float32Array(finalQueryVector), OPENCLAW_TAG_BOOST);
                if (boostResult?.vector) {
                    scoringVector = Array.from(boostResult.vector);
                }
                coreTags = extractOpenClawCoreTags(boostResult?.info);
            }

            // 语义检索
            const semanticResults = await Promise.all(
                targetDiaries.map(async (targetDiary) => {
                    const results = await Promise.resolve(
                        knowledgeBaseManager.search(
                            targetDiary,
                            finalQueryVector,
                            ragOptions.k,
                            ragOptions.tagMemo ? OPENCLAW_TAG_BOOST : 0,
                            coreTags
                        )
                    );
                    return Array.isArray(results)
                        ? results.map((result) => ({
                            ...result,
                            sourceDiary: normalizeOpenClawString(result.sourceDiary || targetDiary),
                            source: 'rag'
                        }))
                        : [];
                })
            );

            // 时间范围解析（可选）
            let timeRanges = [];
            if (ragOptions.timeAware && ragPlugin?.timeParser?.parse) {
                timeRanges = ragPlugin.timeParser.parse(query);
            }

            // 时间范围检索（可选）
            let timeResults = [];
            if (
                timeRanges.length > 0 &&
                ragPlugin?._getTimeRangeFilePaths &&
                typeof knowledgeBaseManager?.getChunksByFilePaths === 'function'
            ) {
                const targetFilePathGroups = await Promise.all(
                    targetDiaries.map(async (targetDiary) => {
                        const filePaths = await Promise.all(
                            timeRanges.map((timeRange) => Promise.resolve(ragPlugin._getTimeRangeFilePaths(targetDiary, timeRange)))
                        );
                        return filePaths.flat();
                    })
                );
                const timeFilePaths = [...new Set(targetFilePathGroups.flat())];
                const timeChunks = timeFilePaths.length > 0
                    ? await Promise.resolve(knowledgeBaseManager.getChunksByFilePaths(timeFilePaths))
                    : [];
                timeResults = Array.isArray(timeChunks)
                    ? timeChunks.map((chunk) => ({
                        ...chunk,
                        score: ragPlugin?.cosineSimilarity
                            ? ragPlugin.cosineSimilarity(scoringVector, Array.from(chunk.vector || []))
                            : computeOpenClawCosineSimilarity(scoringVector, Array.from(chunk.vector || [])),
                        sourceDiary: normalizeOpenClawString(chunk.sourceDiary || normalizeOpenClawString(chunk.sourceFile).split('/')[0]),
                        source: 'time'
                    }))
                    : [];
            }

            // 合并、去重、排序结果
            let candidates = deduplicateOpenClawRagCandidates([...semanticResults.flat(), ...timeResults]);
            if (typeof knowledgeBaseManager?.deduplicateResults === 'function' && candidates.length > 1) {
                candidates = await Promise.resolve(knowledgeBaseManager.deduplicateResults(candidates, finalQueryVector));
            }

            // 重排序（可选）
            if (ragOptions.rerank && candidates.length > 0 && ragPlugin?._rerankDocuments) {
                candidates = await Promise.resolve(ragPlugin._rerankDocuments(query, candidates, ragOptions.k));
            } else {
                candidates.sort((left, right) => (right.score || 0) - (left.score || 0));
                candidates = candidates.slice(0, ragOptions.k);
            }

            // 规范化结果项
            const metadataCache = new Map();
            const items = await Promise.all(
                candidates
                    .filter((candidate) => normalizeOpenClawString(candidate?.text))
                    .slice(0, ragOptions.k)
                    .map((candidate) => normalizeOpenClawRagItem(
                        candidate,
                        normalizeOpenClawString(candidate?.sourceDiary),
                        knowledgeBaseManager,
                        metadataCache
                    ))
            );

            // 构建上下文块，应用 Token 预算和块数限制
            const maxInjectedTokens = Math.max(1, Math.floor(tokenBudget * maxTokenRatio));
            const recallBlocks = [];
            let consumedTokens = 0;
            const scoredItems = items.filter((item) => typeof item.score === 'number' && Number.isFinite(item.score));
            const eligibleItems = scoredItems.filter((item) => item.score >= minScore);
            const deduplicatedBlocks = deduplicateOpenClawRecallBlocks(
                eligibleItems
                    .map((item) => createOpenClawRecallBlock(item))
            );

            // 按策略选择上下文块
            for (const block of deduplicatedBlocks) {
                if (recallBlocks.length >= maxBlocks) {
                    break;
                }
                const blockTokens = block.metadata.estimatedTokens || estimateOpenClawTokenCount(block.text);
                if (consumedTokens > 0 && consumedTokens + blockTokens > maxInjectedTokens) {
                    continue;
                }
                // 超大块截断处理
                if (blockTokens > maxInjectedTokens) {
                    const truncatedText = truncateOpenClawTextByTokens(
                        block.text,
                        Math.max(1, maxInjectedTokens - consumedTokens)
                    );
                    if (!truncatedText) {
                        continue;
                    }
                    const truncatedTokens = estimateOpenClawTokenCount(truncatedText);
                    recallBlocks.push({
                        text: truncatedText,
                        metadata: {
                            ...block.metadata,
                            estimatedTokens: truncatedTokens,
                            truncated: true
                        }
                    });
                    consumedTokens += truncatedTokens;
                    break;
                }
                recallBlocks.push(block);
                consumedTokens += blockTokens;
            }

            // 记录成功审计日志
            logOpenClawAudit('rag.context.completed', {
                requestId,
                source,
                agentId,
                sessionId,
                diary,
                diaries: requestedDiaries,
                resultCount: recallBlocks.length,
                filteredByMinScore: Math.max(0, scoredItems.length - eligibleItems.length),
                scoreStats: {
                    candidates: summarizeOpenClawScoreStats(scoredItems.map((item) => item.score)),
                    eligible: summarizeOpenClawScoreStats(eligibleItems.map((item) => item.score)),
                    recalled: summarizeOpenClawScoreStats(
                        recallBlocks.map((block) => block?.metadata?.score)
                    )
                },
                durationMs: Math.max(0, Date.now() - startedAt)
            });

            return sendOpenClawSuccess(res, {
                requestId,
                startedAt,
                data: {
                    recallBlocks,
                    estimatedTokens: consumedTokens,
                    appliedPolicy: {
                        tokenBudget,
                        maxTokenRatio,
                        maxInjectedTokens,
                        maxBlocks,
                        minScore,
                        mode: ragOptions.mode,
                        timeAware: ragOptions.timeAware,
                        groupAware: ragOptions.groupAware,
                        rerank: ragOptions.rerank,
                        tagMemo: ragOptions.tagMemo,
                        targetDiaries
                    }
                }
            });
        } catch (error) {
            console.error('[OpenClawBridgeRoutes] Error building OpenClaw recall context:', error);
            logOpenClawAudit('rag.context.failed', {
                requestId,
                source,
                agentId,
                sessionId,
                diary,
                diaries: requestedDiaries,
                durationMs: Math.max(0, Date.now() - startedAt),
                code: 'OCW_RAG_CONTEXT_ERROR'
            });
            return sendOpenClawError(res, {
                status: 500,
                requestId,
                startedAt,
                code: 'OCW_RAG_CONTEXT_ERROR',
                error: 'Failed to build recall context',
                details: { message: error.message }
            });
        }
    });

    // -------------------------------------------------------------------------
    // POST /openclaw/memory/write
    // 将 OpenClaw durable memory 写回 VCP 日记体系
    // 支持幂等键与内容指纹去重，默认优先复用 DailyNote 创建链路
    // -------------------------------------------------------------------------
    router.post('/openclaw/memory/write', async (req, res) => {
        const startedAt = Date.now();
        const clientIp = req.ip && req.ip.startsWith('::ffff:') ? req.ip.slice(7) : req.ip;
        const result = await performOpenClawMemoryWrite(pluginManager, {
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

    // -------------------------------------------------------------------------
    // POST /openclaw/tools/:toolName
    // 调用指定工具，执行插件功能
    // 支持参数验证、审批检查、审计日志记录
    // -------------------------------------------------------------------------
    router.post('/openclaw/tools/:toolName', async (req, res) => {
        const startedAt = Date.now();
        const toolName = normalizeOpenClawString(req.params.toolName);
        const args = req.body?.args;
        const requestContext = req.body?.requestContext;
        const requestId = createOpenClawRequestId(requestContext?.requestId);
        const agentId = normalizeOpenClawString(requestContext?.agentId);
        const sessionId = normalizeOpenClawString(requestContext?.sessionId);
        const source = normalizeOpenClawString(requestContext?.source) || 'openclaw';
        const clientIp = req.ip && req.ip.startsWith('::ffff:') ? req.ip.slice(7) : req.ip;

        // 验证必需参数
        if (!toolName) {
            return sendOpenClawError(res, {
                status: 400,
                requestId,
                startedAt,
                code: 'OCW_INVALID_REQUEST',
                error: 'toolName is required',
                details: { field: 'toolName' }
            });
        }
        if (!args || typeof args !== 'object' || Array.isArray(args)) {
            return sendOpenClawError(res, {
                status: 400,
                requestId,
                startedAt,
                code: 'OCW_TOOL_INVALID_ARGS',
                error: 'args must be an object',
                details: { toolName }
            });
        }
        if (!agentId || !sessionId) {
            return sendOpenClawError(res, {
                status: 400,
                requestId,
                startedAt,
                code: 'OCW_INVALID_REQUEST',
                error: 'requestContext.agentId and requestContext.sessionId are required',
                details: { toolName }
            });
        }

        if (toolName === OPENCLAW_MEMORY_WRITE_TOOL_NAME) {
            const result = await performOpenClawMemoryWrite(pluginManager, {
                body: {
                    target: {
                        diary: args.diary,
                        maid: args.maid
                    },
                    memory: {
                        text: args.text,
                        tags: args.tags,
                        timestamp: args.timestamp,
                        metadata: args.metadata
                    },
                    options: {
                        idempotencyKey: args.idempotencyKey,
                        deduplicate: args.deduplicate
                    },
                    requestContext
                },
                startedAt,
                clientIp,
                defaultSource: 'openclaw-memory-write'
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
                data: {
                    toolName,
                    result: result.data,
                    audit: {
                        approvalUsed: false,
                        distributed: false
                    }
                }
            });
        }

        // 查找并验证工具
        const plugin = pluginManager.getPlugin(toolName);
        if (!plugin || !isOpenClawBridgeablePlugin(plugin)) {
            return sendOpenClawError(res, {
                status: 404,
                requestId,
                startedAt,
                code: 'OCW_TOOL_NOT_FOUND',
                error: 'Tool not found',
                details: { toolName }
            });
        }

        // 检查是否需要审批
        if (pluginManager.toolApprovalManager?.shouldApprove?.(toolName)) {
            logOpenClawAudit('tool.approval_required', {
                requestId,
                toolName,
                source,
                agentId,
                sessionId
            });
            return sendOpenClawError(res, {
                status: 403,
                requestId,
                startedAt,
                code: 'OCW_TOOL_APPROVAL_REQUIRED',
                error: 'Tool approval required',
                details: { toolName }
            });
        }

        // 验证参数符合输入模式
        const inputSchema = getOpenClawToolInputSchema(plugin);
        const validationErrors = validateOpenClawSchemaValue(inputSchema, args);
        if (validationErrors.length > 0) {
            return sendOpenClawError(res, {
                status: 400,
                requestId,
                startedAt,
                code: 'OCW_TOOL_INVALID_ARGS',
                error: 'Tool arguments do not match input schema',
                details: {
                    toolName,
                    issues: validationErrors
                }
            });
        }

        // 记录调用开始审计日志
        logOpenClawAudit('tool.invoke.started', {
            requestId,
            toolName,
            source,
            agentId,
            sessionId,
            distributed: Boolean(plugin.isDistributed)
        });

        try {
            // 执行工具调用
            const result = await pluginManager.processToolCall(toolName, {
                ...args,
                __openclawContext: {
                    source,
                    agentId,
                    sessionId,
                    requestId
                }
            }, clientIp);

            // 记录成功审计日志
            logOpenClawAudit('tool.invoke.completed', {
                requestId,
                toolName,
                source,
                agentId,
                sessionId,
                distributed: Boolean(plugin.isDistributed),
                durationMs: Math.max(0, Date.now() - startedAt)
            });

            return sendOpenClawSuccess(res, {
                requestId,
                startedAt,
                data: {
                    toolName,
                    result,
                    audit: {
                        approvalUsed: false,
                        distributed: Boolean(plugin.isDistributed)
                    }
                }
            });
        } catch (error) {
            // 映射错误并记录失败审计日志
            const mappedError = mapOpenClawToolExecutionError(toolName, error);
            logOpenClawAudit('tool.invoke.failed', {
                requestId,
                toolName,
                source,
                agentId,
                sessionId,
                distributed: Boolean(plugin.isDistributed),
                durationMs: Math.max(0, Date.now() - startedAt),
                code: mappedError.code
            });
            return sendOpenClawError(res, {
                status: mappedError.status,
                requestId,
                startedAt,
                code: mappedError.code,
                error: mappedError.error,
                details: mappedError.details
            });
        }
    });

    return router;
};
