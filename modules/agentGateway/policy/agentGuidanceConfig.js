const path = require('path');

const { normalizeString, normalizeStringArray } = require('./shared/normalize');

const DEFAULT_GUIDANCE_CONFIG_PATH = path.join(__dirname, '..', 'config', 'agent_guidance.json');

const SUPPORTED_GUIDANCE_VERSION = 1;

function invalidField(fieldPath, message) {
    return { path: fieldPath, message };
}

function isPlainObject(value) {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function validateStringArrayField(value, fieldPath, errors, { required = false } = {}) {
    if (value === undefined) {
        if (required) {
            errors.push(invalidField(fieldPath, 'is required'));
        }
        return [];
    }
    if (!Array.isArray(value)) {
        errors.push(invalidField(fieldPath, 'must be an array of non-empty strings'));
        return [];
    }
    const normalized = [];
    value.forEach((item, index) => {
        const normalizedItem = normalizeString(item);
        if (!normalizedItem) {
            errors.push(invalidField(`${fieldPath}[${index}]`, 'must be a non-empty string'));
            return;
        }
        normalized.push(normalizedItem);
    });
    return normalized;
}

function validateMemoryWritePolicy(value, fieldPath, errors) {
    if (value === undefined) {
        errors.push(invalidField(fieldPath, 'is required'));
        return { write: [], skip: [] };
    }
    if (!isPlainObject(value)) {
        errors.push(invalidField(fieldPath, 'must be an object with write/skip arrays'));
        return { write: [], skip: [] };
    }
    return {
        write: validateStringArrayField(value.write, `${fieldPath}.write`, errors, { required: true }),
        skip: validateStringArrayField(value.skip, `${fieldPath}.skip`, errors, { required: true })
    };
}

function validateMemoryDefaults(value, fieldPath, errors) {
    if (value === undefined) {
        return undefined;
    }
    if (!isPlainObject(value)) {
        errors.push(invalidField(fieldPath, 'must be an object'));
        return undefined;
    }
    const normalized = {};
    if (value.tags !== undefined) {
        normalized.tags = validateStringArrayField(value.tags, `${fieldPath}.tags`, errors);
    }
    if (value.metadata !== undefined) {
        if (!isPlainObject(value.metadata)) {
            errors.push(invalidField(`${fieldPath}.metadata`, 'must be an object'));
        } else {
            normalized.metadata = { ...value.metadata };
        }
    }
    return normalized;
}

function validateAgentEntry(entry, fieldPath, errors) {
    if (!isPlainObject(entry)) {
        errors.push(invalidField(fieldPath, 'must be an object'));
        return null;
    }
    const normalized = {};
    if (entry.displayName !== undefined) {
        const displayName = normalizeString(entry.displayName);
        if (!displayName) {
            errors.push(invalidField(`${fieldPath}.displayName`, 'must be a non-empty string'));
        } else {
            normalized.displayName = displayName;
        }
    }
    const memoryDefaults = validateMemoryDefaults(entry.memoryDefaults, `${fieldPath}.memoryDefaults`, errors);
    if (memoryDefaults !== undefined) {
        normalized.memoryDefaults = memoryDefaults;
    }
    if (entry.workflow !== undefined) {
        normalized.workflow = validateStringArrayField(entry.workflow, `${fieldPath}.workflow`, errors);
    }
    return normalized;
}

/**
 * 校验 agent_guidance.json 的候选内容（§4.2）。
 * 只做结构校验；agent 存在性等交叉引用由 agentGuidanceResolver / 协调器执行。
 * @returns {{ valid: boolean, errors: Array<{path, message}>, config: object|null }}
 */
function validateAgentGuidanceConfig(parsed) {
    const errors = [];
    if (!isPlainObject(parsed)) {
        return { valid: false, errors: [invalidField('$', 'config root must be a JSON object')], config: null };
    }
    if (parsed.version !== SUPPORTED_GUIDANCE_VERSION) {
        errors.push(invalidField('$.version', `must equal ${SUPPORTED_GUIDANCE_VERSION}`));
    }

    let shared = { workflow: [], memoryWritePolicy: { write: [], skip: [] } };
    if (!isPlainObject(parsed.shared)) {
        errors.push(invalidField('$.shared', 'is required and must be an object'));
    } else {
        shared = {
            workflow: validateStringArrayField(parsed.shared.workflow, '$.shared.workflow', errors, { required: true }),
            memoryWritePolicy: validateMemoryWritePolicy(parsed.shared.memoryWritePolicy, '$.shared.memoryWritePolicy', errors)
        };
    }

    const agents = {};
    if (parsed.agents !== undefined) {
        if (!isPlainObject(parsed.agents)) {
            errors.push(invalidField('$.agents', 'must be an object keyed by agentId'));
        } else {
            for (const [agentKey, entry] of Object.entries(parsed.agents)) {
                const normalizedKey = normalizeString(agentKey);
                if (!normalizedKey) {
                    errors.push(invalidField('$.agents', 'agent keys must be non-empty strings'));
                    continue;
                }
                const normalizedEntry = validateAgentEntry(entry, `$.agents.${normalizedKey}`, errors);
                if (normalizedEntry) {
                    agents[normalizedKey] = normalizedEntry;
                }
            }
        }
    }

    if (errors.length > 0) {
        return { valid: false, errors, config: null };
    }
    return {
        valid: true,
        errors: [],
        config: Object.freeze({ version: SUPPORTED_GUIDANCE_VERSION, shared, agents })
    };
}

/**
 * 解析原始文本为 guidance 配置候选。损坏 JSON 返回结构化错误而不是抛异常，
 * 供协调器按内容/调优配置的 last-known-good 语义处置（§4.3）。
 */
function parseAgentGuidanceConfig(rawText) {
    let parsed;
    try {
        parsed = JSON.parse(rawText);
    } catch (error) {
        return {
            valid: false,
            errors: [invalidField('$', `invalid JSON: ${error.message}`)],
            config: null
        };
    }
    return validateAgentGuidanceConfig(parsed);
}

module.exports = {
    DEFAULT_GUIDANCE_CONFIG_PATH,
    SUPPORTED_GUIDANCE_VERSION,
    parseAgentGuidanceConfig,
    validateAgentGuidanceConfig
};
