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

// 2026-08 起统一命名：skill 目录名一律 vcp-<agent>（agentId slug），
// 显式覆盖也必须带 vcp- 前缀，防止导出命名再次发散
const SKILL_NAME_PATTERN = /^vcp-[a-z0-9][a-z0-9-]{0,59}$/;

/**
 * 可选的 per-agent skill 表达配置（§6）。
 *
 * 生成的 SKILL.md 里，frontmatter `description` 是宿主唯一常驻的触发面——
 * 只有它足够具体，宿主才知道什么时候该加载这个 skill。这里的
 * `domain`/`triggers`/`notFor` 就是那句话的素材来源；缺省时生成器按
 * displayName 与日记本路由派生一句通用兜底。
 *
 * `writeTargets` 描述「哪个日记本在什么时机写」，供正文渲染成可照抄的
 * gateway_memory_write 调用；越权 diary 由生成器按 allowedDiaries 过滤。
 *
 * 数组字段显式给空数组一律视为配置错误（意图不明确，应删除该字段），
 * 与 workflow 覆盖同一语义。
 */
function validateSkillArrayField(value, fieldPath, errors, normalized, key) {
    if (value === undefined) {
        return;
    }
    const items = validateStringArrayField(value, fieldPath, errors);
    if (Array.isArray(value) && value.length === 0) {
        errors.push(invalidField(fieldPath, 'must not be empty; omit the field instead'));
        return;
    }
    if (items.length > 0) {
        normalized[key] = items;
    }
}

function validateSkillWriteTargets(value, fieldPath, errors) {
    if (!Array.isArray(value)) {
        errors.push(invalidField(fieldPath, 'must be an array of { diary, when } objects'));
        return [];
    }
    if (value.length === 0) {
        errors.push(invalidField(fieldPath, 'must not be empty; omit the field instead'));
        return [];
    }
    const normalized = [];
    value.forEach((item, index) => {
        const itemPath = `${fieldPath}[${index}]`;
        if (!isPlainObject(item)) {
            errors.push(invalidField(itemPath, 'must be an object with diary and when'));
            return;
        }
        const diary = normalizeString(item.diary);
        const when = normalizeString(item.when);
        if (!diary) {
            errors.push(invalidField(`${itemPath}.diary`, 'must be a non-empty string'));
        }
        if (!when) {
            errors.push(invalidField(`${itemPath}.when`, 'must be a non-empty string'));
        }
        if (diary && when) {
            normalized.push({ diary, when });
        }
    });
    return normalized;
}

function validateSkillBlock(value, fieldPath, errors) {
    if (value === undefined) {
        return undefined;
    }
    if (!isPlainObject(value)) {
        errors.push(invalidField(fieldPath, 'must be an object'));
        return undefined;
    }
    const normalized = {};
    if (value.name !== undefined) {
        const name = normalizeString(value.name);
        if (!SKILL_NAME_PATTERN.test(name)) {
            errors.push(invalidField(`${fieldPath}.name`, 'must match ^vcp-[a-z0-9][a-z0-9-]{0,59}$ (skill directory names are uniformly vcp-<agent>)'));
        } else {
            normalized.name = name;
        }
    }
    if (value.domain !== undefined) {
        const domain = normalizeString(value.domain);
        if (!domain) {
            errors.push(invalidField(`${fieldPath}.domain`, 'must be a non-empty string'));
        } else {
            normalized.domain = domain;
        }
    }
    validateSkillArrayField(value.triggers, `${fieldPath}.triggers`, errors, normalized, 'triggers');
    validateSkillArrayField(value.notFor, `${fieldPath}.notFor`, errors, normalized, 'notFor');
    if (value.writeTargets !== undefined) {
        const writeTargets = validateSkillWriteTargets(value.writeTargets, `${fieldPath}.writeTargets`, errors);
        if (writeTargets.length > 0) {
            normalized.writeTargets = writeTargets;
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
    // §4.2：可选的 per-agent workflow 覆盖。缺省时 guidance bundle 回落到
    // shared.workflow；显式给出空数组视为配置错误（意图不明确，应删除该字段）。
    if (entry.workflow !== undefined) {
        const workflow = validateStringArrayField(entry.workflow, `${fieldPath}.workflow`, errors);
        if (Array.isArray(entry.workflow) && entry.workflow.length === 0) {
            errors.push(invalidField(`${fieldPath}.workflow`, 'must not be empty; omit the field to inherit shared.workflow'));
        } else if (workflow.length > 0) {
            normalized.workflow = workflow;
        }
    }
    const skill = validateSkillBlock(entry.skill, `${fieldPath}.skill`, errors);
    if (skill !== undefined && Object.keys(skill).length > 0) {
        normalized.skill = skill;
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
