const path = require('path');

const {
    buildAgentAliases
} = require('./authContextResolver');
const { createHotJsonConfigLoader } = require('./shared/hotJsonConfigLoader');
const { normalizeString, normalizeStringArray } = require('./shared/normalize');

const DEFAULT_POLICY_PATH = path.join(__dirname, '..', 'config', 'mcp_agent_memory_policy.json');

// Trailing-wildcard diary patterns (e.g. "Nexus项目-*") are only honored for
// these prefixes; a wildcard entry with any other prefix matches nothing.
const ALLOWED_WILDCARD_PREFIXES = ['Nexus项目-'];

const normalizePolicyString = normalizeString;
const normalizePolicyStringArray = normalizeStringArray;
const loadPolicyFile = createHotJsonConfigLoader({
    fallback: { agents: {} },
    normalize(parsed) {
        const agents = parsed?.agents && typeof parsed.agents === 'object' && !Array.isArray(parsed.agents)
            ? parsed.agents : {};
        return { agents };
    }
});

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

function isWildcardDiaryPattern(value) {
    return normalizePolicyString(value).endsWith('*');
}

function resolveAllowedWildcardPrefix(value) {
    const prefix = normalizePolicyString(value).slice(0, -1).trim();
    return ALLOWED_WILDCARD_PREFIXES.includes(prefix) ? prefix : '';
}

function matchesDiaryWildcardPrefix(prefix, diaryName) {
    const canonicalName = normalizeDiaryCanonicalName(diaryName);
    return Boolean(canonicalName) && canonicalName.startsWith(prefix);
}

function areDiaryNamesEquivalent(left, right) {
    // Callers pass (allowed, requested) or (requested, allowed), so wildcard
    // handling must be symmetric in which side carries the pattern.
    const leftIsWildcard = isWildcardDiaryPattern(left);
    const rightIsWildcard = isWildcardDiaryPattern(right);
    if (leftIsWildcard || rightIsWildcard) {
        if ((leftIsWildcard && !resolveAllowedWildcardPrefix(left))
            || (rightIsWildcard && !resolveAllowedWildcardPrefix(right))) {
            return false;
        }
        if (leftIsWildcard && rightIsWildcard) {
            return resolveAllowedWildcardPrefix(left) === resolveAllowedWildcardPrefix(right);
        }
        return leftIsWildcard
            ? matchesDiaryWildcardPrefix(resolveAllowedWildcardPrefix(left), right)
            : matchesDiaryWildcardPrefix(resolveAllowedWildcardPrefix(right), left);
    }

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
            defaultDiaries: [],
            maid: ''
        };
    }
    const allowedDiaries = normalizePolicyStringArray(entry.allowedDiaries || entry.allowedDiaryNames);
    const defaultDiaries = normalizePolicyStringArray(entry.defaultDiaries || entry.defaultDiaryNames);
    const maid = normalizePolicyString(entry.maid || entry.memoryWriteMaid || entry.author);
    return {
        allowedDiaries,
        defaultDiaries: defaultDiaries.length > 0 ? defaultDiaries : allowedDiaries,
        maid
    };
}

function getPolicyFilePath() {
    const overridePath = normalizePolicyString(process.env.MCP_AGENT_MEMORY_POLICY_PATH);
    return overridePath || DEFAULT_POLICY_PATH;
}

function loadAgentMemoryPolicyConfig() {
    return loadPolicyFile(getPolicyFilePath());
}

function resolveConfiguredAgentMemoryPolicy({ agentId } = {}) {
    const config = loadAgentMemoryPolicyConfig();
    const agentAliases = buildAgentAliases(agentId);

    for (const alias of agentAliases) {
        const matched = normalizeAgentMemoryPolicyEntry(config.agents?.[alias]);
        if (matched.allowedDiaries.length > 0 || matched.defaultDiaries.length > 0) {
            return {
                matchedAlias: alias,
                allowedDiaryNames: matched.allowedDiaries,
                defaultDiaryNames: matched.defaultDiaries,
                maid: matched.maid
            };
        }
    }

    const wildcardEntry = normalizeAgentMemoryPolicyEntry(config.agents?.['*']);
    if (wildcardEntry.allowedDiaries.length > 0 || wildcardEntry.defaultDiaries.length > 0) {
        return {
            matchedAlias: '*',
            allowedDiaryNames: wildcardEntry.allowedDiaries,
            defaultDiaryNames: wildcardEntry.defaultDiaries,
            maid: wildcardEntry.maid
        };
    }

    return {
        matchedAlias: '',
        allowedDiaryNames: [],
        defaultDiaryNames: [],
        maid: ''
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
