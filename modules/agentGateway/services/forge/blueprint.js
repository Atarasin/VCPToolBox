'use strict';

const fs = require('fs');
const fsp = require('fs').promises;
const path = require('path');

const { scanTextForSecrets } = require('./secretScan');

/**
 * 专家画像（blueprint）schema 与读写校验。
 * 设计：docs/design/2026-10-10_专家铸造炉.md §3.1。
 *
 * - name 即 agent 名 / agent_map 键，知识库名由其派生，按文件名安全字符约束；
 * - 与 agent_map 现有条目或 Agent/ 现有文件的冲突检测由调用方注入名单
 *   （util 保持纯函数，不直接读运行时状态）；
 * - budget.maxModelCostCny 缺省补默认值 10（Q2 已确认）。
 */

const BLUEPRINT_SCHEMA_VERSION = 1;
const DEFAULT_MAX_MODEL_COST_CNY = 10;
const DEFAULT_MIN_DOMAINS_PER_SUBSKILL = 3;
const EXPERT_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
const SUBSKILL_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;

function isNonEmptyString(value) {
    return typeof value === 'string' && value.trim().length > 0;
}

function isNonEmptyStringArray(value) {
    return Array.isArray(value) && value.length > 0 && value.every(isNonEmptyString);
}

function isStringArray(value) {
    return Array.isArray(value) && value.every(isNonEmptyString);
}

function validateBlueprint(blueprint, options = {}) {
    const errors = [];
    const fail = (field, message) => errors.push({ field, message });

    if (!blueprint || typeof blueprint !== 'object' || Array.isArray(blueprint)) {
        return { valid: false, errors: [{ field: '$', message: 'blueprint 必须是 JSON 对象' }] };
    }

    if (!isNonEmptyString(blueprint.name)) {
        fail('name', 'name 不能为空');
    } else if (!EXPERT_NAME_PATTERN.test(blueprint.name)) {
        fail('name', 'name 只能以字母开头，含字母/数字/下划线/连字符，长度 ≤64（专家名 = agent 名 = agent_map 键）');
    }

    if (!isNonEmptyString(blueprint.displayName)) {
        fail('displayName', 'displayName 不能为空');
    }

    const scope = blueprint.scope && typeof blueprint.scope === 'object' && !Array.isArray(blueprint.scope)
        ? blueprint.scope
        : null;
    if (!scope) {
        fail('scope', 'scope 必须是对象，含 responsibilities / boundaries');
    } else {
        if (!isNonEmptyStringArray(scope.responsibilities)) {
            fail('scope.responsibilities', 'responsibilities 必须是非空字符串数组');
        }
        if (scope.boundaries !== undefined && !isStringArray(scope.boundaries)) {
            fail('scope.boundaries', 'boundaries 必须是字符串数组（可为空数组）');
        }
    }

    const subskills = blueprint.subskills;
    if (!Array.isArray(subskills) || subskills.length === 0) {
        fail('subskills', 'subskills 必须是非空数组');
    } else {
        const seenIds = new Set();
        subskills.forEach((subskill, index) => {
            const prefix = `subskills[${index}]`;
            if (!subskill || typeof subskill !== 'object' || Array.isArray(subskill)) {
                fail(prefix, 'subskill 必须是对象');
                return;
            }
            if (!isNonEmptyString(subskill.id)) {
                fail(`${prefix}.id`, 'id 不能为空');
            } else if (!SUBSKILL_ID_PATTERN.test(subskill.id)) {
                fail(`${prefix}.id`, 'id 须为小写 slug（小写字母/数字/连字符）');
            } else if (seenIds.has(subskill.id)) {
                fail(`${prefix}.id`, `id 重复：${subskill.id}`);
            } else {
                seenIds.add(subskill.id);
            }
            if (!isNonEmptyString(subskill.title)) {
                fail(`${prefix}.title`, 'title 不能为空');
            }
            if (!isNonEmptyStringArray(subskill.searchQueries)) {
                fail(`${prefix}.searchQueries`, 'searchQueries 必须是非空字符串数组');
            }
            if (subskill.sourceHints !== undefined && !isStringArray(subskill.sourceHints)) {
                fail(`${prefix}.sourceHints`, 'sourceHints 必须是字符串数组');
            }
        });
    }

    const sourcePolicy = blueprint.sourcePolicy;
    if (sourcePolicy !== undefined) {
        if (!sourcePolicy || typeof sourcePolicy !== 'object' || Array.isArray(sourcePolicy)) {
            fail('sourcePolicy', 'sourcePolicy 必须是对象');
        } else {
            if (sourcePolicy.preferOfficialDocs !== undefined && typeof sourcePolicy.preferOfficialDocs !== 'boolean') {
                fail('sourcePolicy.preferOfficialDocs', 'preferOfficialDocs 必须是布尔值');
            }
            if (sourcePolicy.minDomainsPerSubskill !== undefined &&
                (!Number.isFinite(sourcePolicy.minDomainsPerSubskill) || sourcePolicy.minDomainsPerSubskill < 1)) {
                fail('sourcePolicy.minDomainsPerSubskill', 'minDomainsPerSubskill 必须是 ≥1 的数字');
            }
            if (sourcePolicy.qualityFilter !== undefined && !isNonEmptyString(sourcePolicy.qualityFilter)) {
                fail('sourcePolicy.qualityFilter', 'qualityFilter 必须是非空字符串');
            }
        }
    }

    const examOutline = blueprint.examOutline;
    if (!Array.isArray(examOutline) || examOutline.length === 0) {
        fail('examOutline', 'examOutline 必须是非空数组且覆盖全部 subskills');
    } else if (Array.isArray(subskills) && subskills.length > 0) {
        const covered = new Set();
        examOutline.forEach((entry, index) => {
            const prefix = `examOutline[${index}]`;
            if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
                fail(prefix, '考纲条目必须是对象');
                return;
            }
            if (!isNonEmptyString(entry.subskillId)) {
                fail(`${prefix}.subskillId`, 'subskillId 不能为空');
                return;
            }
            if (covered.has(entry.subskillId)) {
                fail(`${prefix}.subskillId`, `subskillId 重复：${entry.subskillId}`);
            }
            covered.add(entry.subskillId);
            const concept = Number(entry.conceptQuestions);
            const applied = Number(entry.appliedQuestions);
            if (!Number.isInteger(concept) || concept < 1) {
                fail(`${prefix}.conceptQuestions`, 'conceptQuestions 必须是 ≥1 的整数');
            }
            if (!Number.isInteger(applied) || applied < 1) {
                fail(`${prefix}.appliedQuestions`, 'appliedQuestions 必须是 ≥1 的整数');
            }
        });
        for (const subskill of subskills) {
            if (subskill && isNonEmptyString(subskill.id) && !covered.has(subskill.id)) {
                fail('examOutline', `examOutline 未覆盖 subskill：${subskill.id}`);
            }
        }
        for (const id of covered) {
            if (!subskills.some((s) => s && s.id === id)) {
                fail('examOutline', `examOutline 含未知 subskillId：${id}`);
            }
        }
    }

    const practicalExam = blueprint.practicalExam;
    if (!practicalExam || typeof practicalExam !== 'object' || Array.isArray(practicalExam)) {
        fail('practicalExam', 'practicalExam 必须是对象，含 prompt 与 gradingDimensions');
    } else {
        if (!isNonEmptyString(practicalExam.prompt)) {
            fail('practicalExam.prompt', 'prompt 不能为空');
        }
        if (!isNonEmptyStringArray(practicalExam.gradingDimensions)) {
            fail('practicalExam.gradingDimensions', 'gradingDimensions 必须是非空字符串数组');
        }
    }

    if (!isNonEmptyString(blueprint.acceptanceSample)) {
        fail('acceptanceSample', 'acceptanceSample 不能为空');
    }

    const budget = blueprint.budget;
    if (budget !== undefined) {
        if (!budget || typeof budget !== 'object' || Array.isArray(budget)) {
            fail('budget', 'budget 必须是对象');
        } else if (!Number.isFinite(budget.maxModelCostCny) || budget.maxModelCostCny <= 0) {
            fail('budget.maxModelCostCny', 'maxModelCostCny 必须是正数');
        }
    }

    // 红线 3 前置检查：与既有 agent / 既有文件的重名冲突即视为待人工确认。
    const existingAgentNames = Array.isArray(options.existingAgentNames) ? options.existingAgentNames : [];
    if (isNonEmptyString(blueprint.name)) {
        const conflict = existingAgentNames.find((name) => name === blueprint.name);
        if (conflict) {
            fail('name', `与既有 agent 冲突：${conflict}（须人工确认改名或明确覆盖）`);
        }
    }
    const existingAgentFiles = Array.isArray(options.existingAgentFiles) ? options.existingAgentFiles : [];
    if (isNonEmptyString(blueprint.name)) {
        const fileConflict = existingAgentFiles.find((file) => file === `${blueprint.name}.txt`);
        if (fileConflict) {
            fail('name', `Agent/ 下已有同名文件：${fileConflict}（须人工确认改名或明确覆盖）`);
        }
    }

    return { valid: errors.length === 0, errors };
}

function normalizeBlueprint(blueprint) {
    const normalized = {
        schemaVersion: BLUEPRINT_SCHEMA_VERSION,
        ...blueprint
    };
    normalized.budget = {
        maxModelCostCny: DEFAULT_MAX_MODEL_COST_CNY,
        ...(blueprint.budget && typeof blueprint.budget === 'object' ? blueprint.budget : {})
    };
    if (normalized.sourcePolicy && typeof normalized.sourcePolicy === 'object') {
        normalized.sourcePolicy = {
            preferOfficialDocs: true,
            minDomainsPerSubskill: DEFAULT_MIN_DOMAINS_PER_SUBSKILL,
            ...normalized.sourcePolicy
        };
    }
    return normalized;
}

function createBlueprintInvalidError(blueprintPath, errors) {
    const error = new Error(`画像校验失败：${path.basename(String(blueprintPath))}`);
    error.code = 'FORGE_BLUEPRINT_INVALID';
    error.status = 400;
    error.details = { errors };
    return error;
}

async function readBlueprint(blueprintPath, options = {}) {
    const raw = await fsp.readFile(blueprintPath, 'utf8');
    const secretHits = scanTextForSecrets(raw);
    if (secretHits.length > 0) {
        const error = new Error(`画像文件疑似包含密钥，拒绝读取入库流程：${path.basename(String(blueprintPath))}`);
        error.code = 'FORGE_SECRET_DETECTED';
        error.status = 400;
        error.details = { hits: secretHits };
        throw error;
    }
    let blueprint;
    try {
        blueprint = JSON.parse(raw);
    } catch (parseError) {
        const error = new Error(`画像 JSON 解析失败：${path.basename(String(blueprintPath))}`);
        error.code = 'FORGE_BLUEPRINT_INVALID';
        error.status = 400;
        error.details = { reason: parseError.message };
        throw error;
    }
    const verdict = validateBlueprint(blueprint, options);
    if (!verdict.valid) {
        throw createBlueprintInvalidError(blueprintPath, verdict.errors);
    }
    return blueprint;
}

async function writeBlueprint(blueprintPath, blueprint, options = {}) {
    const verdict = validateBlueprint(blueprint, options);
    if (!verdict.valid) {
        throw createBlueprintInvalidError(blueprintPath, verdict.errors);
    }
    const normalized = normalizeBlueprint(blueprint);
    const serialized = `${JSON.stringify(normalized, null, 2)}\n`;
    const secretHits = scanTextForSecrets(serialized);
    if (secretHits.length > 0) {
        const error = new Error(`画像内容疑似包含密钥，阻断落盘：${path.basename(String(blueprintPath))}`);
        error.code = 'FORGE_SECRET_DETECTED';
        error.status = 400;
        error.details = { hits: secretHits };
        throw error;
    }
    await fsp.mkdir(path.dirname(blueprintPath), { recursive: true });
    const tmpPath = `${blueprintPath}.tmp-${process.pid}-${Date.now()}`;
    await fsp.writeFile(tmpPath, serialized, 'utf8');
    await fsp.rename(tmpPath, blueprintPath);
    return normalized;
}

function blueprintLibraryName(blueprintName) {
    return `${blueprintName}知识库`;
}

function listBlueprintNames(blueprintsDir) {
    if (!fs.existsSync(blueprintsDir)) {
        return [];
    }
    return fs.readdirSync(blueprintsDir)
        .filter((name) => name.endsWith('.json'))
        .map((name) => name.slice(0, -'.json'.length))
        .sort();
}

module.exports = {
    BLUEPRINT_SCHEMA_VERSION,
    DEFAULT_MAX_MODEL_COST_CNY,
    DEFAULT_MIN_DOMAINS_PER_SUBSKILL,
    EXPERT_NAME_PATTERN,
    SUBSKILL_ID_PATTERN,
    validateBlueprint,
    normalizeBlueprint,
    readBlueprint,
    writeBlueprint,
    blueprintLibraryName,
    listBlueprintNames
};
