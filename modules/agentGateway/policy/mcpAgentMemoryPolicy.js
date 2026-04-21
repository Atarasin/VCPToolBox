const fs = require('fs');
const path = require('path');

const {
    buildAgentAliases
} = require('./authContextResolver');

const DEFAULT_POLICY_PATH = path.join(__dirname, '..', 'config', 'mcp_agent_memory_policy.json');

let cachedPolicyPath = '';
let cachedPolicyMtimeMs = -1;
let cachedPolicyPayload = Object.freeze({
    agents: {}
});

function normalizePolicyString(value) {
    return typeof value === 'string' ? value.trim() : '';
}

function normalizePolicyStringArray(value) {
    if (Array.isArray(value)) {
        return value.map((item) => normalizePolicyString(item)).filter(Boolean);
    }
    if (typeof value === 'string') {
        return value.split(',').map((item) => item.trim()).filter(Boolean);
    }
    return [];
}

function normalizeDiaryCanonicalName(value) {
    const normalizedValue = normalizePolicyString(value);
    if (!normalizedValue) {
        return '';
    }

    return normalizedValue.endsWith('日记本')
        ? normalizedValue.slice(0, -3).trim()
        : normalizedValue;
}

function buildDiaryAliasCandidates(value) {
    const normalizedValue = normalizePolicyString(value);
    if (!normalizedValue) {
        return [];
    }

    const candidates = new Set([normalizedValue]);
    if (normalizedValue.endsWith('日记本')) {
        candidates.add(normalizedValue.slice(0, -3));
    } else {
        candidates.add(`${normalizedValue}日记本`);
    }

    return Array.from(candidates);
}

function areDiaryNamesEquivalent(left, right) {
    const leftCandidates = new Set(buildDiaryAliasCandidates(left));
    if (leftCandidates.size === 0) {
        return false;
    }
    return buildDiaryAliasCandidates(right).some((candidate) => leftCandidates.has(candidate));
}

function resolveDiaryAliasToAvailable(value, availableDiaries = []) {
    const normalizedAvailableDiaries = normalizePolicyStringArray(availableDiaries);
    const exactValue = normalizePolicyString(value);
    if (!exactValue) {
        return '';
    }
    if (normalizedAvailableDiaries.length === 0) {
        return normalizeDiaryCanonicalName(exactValue);
    }

    const exactMatch = normalizedAvailableDiaries.find((diaryName) => diaryName === exactValue);
    if (exactMatch) {
        return exactMatch;
    }

    const equivalentMatch = normalizedAvailableDiaries.find((diaryName) => areDiaryNamesEquivalent(exactValue, diaryName));
    return equivalentMatch || normalizeDiaryCanonicalName(exactValue);
}

function resolveDiaryAliasesToAvailable(values, availableDiaries = []) {
    const resolved = [];
    normalizePolicyStringArray(values).forEach((value) => {
        const canonicalDiaryName = resolveDiaryAliasToAvailable(value, availableDiaries);
        if (canonicalDiaryName && !resolved.includes(canonicalDiaryName)) {
            resolved.push(canonicalDiaryName);
        }
    });
    return resolved;
}

function normalizeAgentMemoryPolicyEntry(entry) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
        return {
            allowedDiaries: [],
            defaultDiaries: []
        };
    }
    const allowedDiaries = normalizePolicyStringArray(entry.allowedDiaries || entry.allowedDiaryNames);
    const defaultDiaries = normalizePolicyStringArray(entry.defaultDiaries || entry.defaultDiaryNames);
    return {
        allowedDiaries,
        defaultDiaries: defaultDiaries.length > 0 ? defaultDiaries : allowedDiaries
    };
}

function getPolicyFilePath() {
    const overridePath = normalizePolicyString(process.env.MCP_AGENT_MEMORY_POLICY_PATH);
    return overridePath || DEFAULT_POLICY_PATH;
}

function loadAgentMemoryPolicyConfig() {
    const policyPath = getPolicyFilePath();
    let stat;
    try {
        stat = fs.statSync(policyPath);
    } catch (error) {
        cachedPolicyPath = policyPath;
        cachedPolicyMtimeMs = -1;
        cachedPolicyPayload = Object.freeze({ agents: {} });
        return cachedPolicyPayload;
    }

    if (cachedPolicyPath === policyPath && cachedPolicyMtimeMs === stat.mtimeMs) {
        return cachedPolicyPayload;
    }

    try {
        const rawText = fs.readFileSync(policyPath, 'utf8');
        const parsed = JSON.parse(rawText);
        const agents = parsed?.agents && typeof parsed.agents === 'object' && !Array.isArray(parsed.agents)
            ? parsed.agents
            : {};

        cachedPolicyPath = policyPath;
        cachedPolicyMtimeMs = stat.mtimeMs;
        cachedPolicyPayload = Object.freeze({ agents });
        return cachedPolicyPayload;
    } catch (error) {
        cachedPolicyPath = policyPath;
        cachedPolicyMtimeMs = stat.mtimeMs;
        cachedPolicyPayload = Object.freeze({ agents: {} });
        return cachedPolicyPayload;
    }
}

function resolveConfiguredAgentMemoryPolicy({ agentId, maid } = {}) {
    const config = loadAgentMemoryPolicyConfig();
    const agentAliases = buildAgentAliases(agentId, maid);

    for (const alias of agentAliases) {
        const matched = normalizeAgentMemoryPolicyEntry(config.agents?.[alias]);
        if (matched.allowedDiaries.length > 0 || matched.defaultDiaries.length > 0) {
            return {
                matchedAlias: alias,
                allowedDiaryNames: matched.allowedDiaries,
                defaultDiaryNames: matched.defaultDiaries
            };
        }
    }

    const wildcardEntry = normalizeAgentMemoryPolicyEntry(config.agents?.['*']);
    if (wildcardEntry.allowedDiaries.length > 0 || wildcardEntry.defaultDiaries.length > 0) {
        return {
            matchedAlias: '*',
            allowedDiaryNames: wildcardEntry.allowedDiaries,
            defaultDiaryNames: wildcardEntry.defaultDiaries
        };
    }

    return {
        matchedAlias: '',
        allowedDiaryNames: [],
        defaultDiaryNames: []
    };
}

module.exports = {
    areDiaryNamesEquivalent,
    DEFAULT_POLICY_PATH,
    loadAgentMemoryPolicyConfig,
    normalizeDiaryCanonicalName,
    resolveDiaryAliasToAvailable,
    resolveDiaryAliasesToAvailable,
    resolveConfiguredAgentMemoryPolicy
};
