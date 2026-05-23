const fs = require('fs');
const path = require('path');

const { buildAgentAliases } = require('./authContextResolver');

const DEFAULT_CONFIG_PATH = path.join(__dirname, '..', 'config', 'recall_profiles.json');

const ALLOWED_MODIFIERS_S01 = Object.freeze(new Set([
    'time',
    'group',
    'rerank',
    'tagMemo',
    'truncate'
]));

const ALLOWED_MODIFIERS = Object.freeze(new Set([
    ...ALLOWED_MODIFIERS_S01,
    'timeDecay',
    'roleValve',
    'base64Memo',
    'aiMemo'
]));

const ALLOWED_RULE_TYPES = Object.freeze(new Set([
    'rag',
    'gated_rag',
    'full_text',
    'gated_full_text'
]));

let cachedConfigPath = '';
let cachedConfigMtimeMs = -1;
let cachedConfigPayload = Object.freeze({ agents: {} });

function normalizeString(value) {
    return typeof value === 'string' ? value.trim() : '';
}

function normalizeStringArray(value) {
    if (Array.isArray(value)) {
        return value.map((item) => normalizeString(item)).filter(Boolean);
    }
    if (typeof value === 'string') {
        return value.split(',').map((item) => item.trim()).filter(Boolean);
    }
    return [];
}

function loadRecallProfiles(configPath) {
    let stat;
    try {
        stat = fs.statSync(configPath);
    } catch (error) {
        cachedConfigPath = configPath;
        cachedConfigMtimeMs = -1;
        cachedConfigPayload = Object.freeze({ agents: {} });
        return cachedConfigPayload;
    }

    if (cachedConfigPath === configPath && cachedConfigMtimeMs === stat.mtimeMs) {
        return cachedConfigPayload;
    }

    try {
        const rawText = fs.readFileSync(configPath, 'utf8');
        const parsed = JSON.parse(rawText);
        const agents = parsed?.agents && typeof parsed.agents === 'object' && !Array.isArray(parsed.agents)
            ? parsed.agents
            : {};

        cachedConfigPath = configPath;
        cachedConfigMtimeMs = stat.mtimeMs;
        cachedConfigPayload = Object.freeze({ agents });
        return cachedConfigPayload;
    } catch (error) {
        cachedConfigPath = configPath;
        cachedConfigMtimeMs = stat.mtimeMs;
        cachedConfigPayload = Object.freeze({ agents: {} });
        return cachedConfigPayload;
    }
}

function normalizeModifierEntry(value) {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
        // Return a shallow clone preserving all keys;
        // filtering of unknown keys happens in normalizeRule if needed.
        return { ...value };
    }
    return {};
}

function normalizeRule(rule) {
    if (!rule || typeof rule !== 'object' || Array.isArray(rule)) {
        return null;
    }
    const type = normalizeString(rule.type);
    if (!ALLOWED_RULE_TYPES.has(type)) {
        return null;
    }
    const diaries = normalizeStringArray(rule.diaries);
    const rawModifiers = normalizeModifierEntry(rule.modifiers);
    // Filter modifiers to only allowed keys for runtime safety
    const modifiers = {};
    for (const key of Object.keys(rawModifiers)) {
        if (ALLOWED_MODIFIERS.has(key)) {
            modifiers[key] = rawModifiers[key];
        }
    }
    const gateThreshold = typeof rule.gateThreshold === 'number' && Number.isFinite(rule.gateThreshold)
        ? rule.gateThreshold
        : null;
    const kMultiplier = typeof rule.kMultiplier === 'number' && Number.isFinite(rule.kMultiplier) && rule.kMultiplier > 0
        ? rule.kMultiplier
        : 1.0;
    const meta = rule.meta && typeof rule.meta === 'object' && !Array.isArray(rule.meta)
        ? { ...rule.meta }
        : undefined;

    const result = {
        type,
        diaries,
        modifiers,
        gateThreshold,
        kMultiplier
    };
    if (meta !== undefined) {
        result.meta = meta;
    }
    return result;
}

function normalizeProfile(profile) {
    if (!profile || typeof profile !== 'object' || Array.isArray(profile)) {
        return null;
    }
    const rawRules = Array.isArray(profile.rules) ? profile.rules : [];
    const rules = rawRules.map(normalizeRule).filter(Boolean);
    if (rules.length === 0) {
        return null;
    }
    const merge = typeof profile.merge === 'string' ? profile.merge : undefined;
    const aggregate = typeof profile.aggregate === 'string' ? profile.aggregate : undefined;
    const projection = typeof profile.projection === 'string' ? profile.projection : undefined;
    const truncateTo = typeof profile.truncateTo === 'number' && Number.isFinite(profile.truncateTo) && profile.truncateTo > 0
        ? Math.floor(profile.truncateTo)
        : undefined;
    const metadata = profile.metadata && typeof profile.metadata === 'object' && !Array.isArray(profile.metadata)
        ? { ...profile.metadata }
        : undefined;

    const result = { rules };
    if (merge !== undefined) {
        result.merge = merge;
    }
    if (aggregate !== undefined) {
        result.aggregate = aggregate;
    }
    if (projection !== undefined) {
        result.projection = projection;
    }
    if (truncateTo !== undefined) {
        result.truncateTo = truncateTo;
    }
    if (metadata !== undefined) {
        result.metadata = metadata;
    }
    return result;
}

function normalizeAgentEntry(entry) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
        return null;
    }
    const defaultProfile = normalizeString(entry.defaultProfile);
    const rawProfiles = entry.profiles && typeof entry.profiles === 'object' && !Array.isArray(entry.profiles)
        ? entry.profiles
        : {};
    const profiles = {};
    for (const [profileName, rawProfile] of Object.entries(rawProfiles)) {
        const normalizedProfile = normalizeProfile(rawProfile);
        if (normalizedProfile) {
            profiles[profileName] = normalizedProfile;
        }
    }
    if (Object.keys(profiles).length === 0) {
        return null;
    }
    const allowedProfiles = Array.isArray(entry.allowedProfiles)
        ? entry.allowedProfiles.map((item) => normalizeString(item)).filter(Boolean)
        : undefined;
    const targets = Array.isArray(entry.targets)
        ? entry.targets.map((item) => normalizeString(item)).filter(Boolean)
        : undefined;

    const result = {
        defaultProfile: defaultProfile || Object.keys(profiles)[0],
        profiles
    };
    if (allowedProfiles !== undefined && allowedProfiles.length > 0) {
        result.allowedProfiles = allowedProfiles;
    }
    if (targets !== undefined && targets.length > 0) {
        result.targets = targets;
    }
    return result;
}

function resolveAgentEntry(agentId, config) {
    const aliases = buildAgentAliases(agentId);
    for (const alias of aliases) {
        const entry = normalizeAgentEntry(config.agents?.[alias]);
        if (entry) {
            return entry;
        }
    }
    const wildcardEntry = normalizeAgentEntry(config.agents?.['*']);
    if (wildcardEntry) {
        return wildcardEntry;
    }
    return null;
}

class RecallProfileResolver {
    constructor({ configPath } = {}) {
        this.configPath = normalizeString(configPath) || DEFAULT_CONFIG_PATH;
    }

    _loadConfig() {
        return loadRecallProfiles(this.configPath);
    }

    validateDiaryAccess(ruleDiaries, availableDiaries) {
        const normalizedAvailable = normalizeStringArray(availableDiaries);
        if (normalizedAvailable.length === 0) {
            return { valid: true, forbidden: [] };
        }
        const forbidden = normalizeStringArray(ruleDiaries).filter(
            (diary) => !normalizedAvailable.includes(diary)
        );
        return {
            valid: forbidden.length === 0,
            forbidden
        };
    }

    validateModifiers(modifiers) {
        const raw = modifiers && typeof modifiers === 'object' && !Array.isArray(modifiers)
            ? modifiers
            : {};
        const invalid = Object.keys(raw).filter(
            (key) => !ALLOWED_MODIFIERS.has(key)
        );
        return {
            valid: invalid.length === 0,
            invalid
        };
    }

    resolveForAgent(agentId, profileName) {
        const config = this._loadConfig();
        const agentEntry = resolveAgentEntry(agentId, config);
        if (!agentEntry) {
            return {
                resolved: false,
                code: 'RECALL_NO_PROFILE',
                agentId,
                profileName: profileName || null,
                rules: []
            };
        }

        const targetProfileName = normalizeString(profileName) || agentEntry.defaultProfile;
        const profile = agentEntry.profiles[targetProfileName];
        if (!profile) {
            return {
                resolved: false,
                code: 'RECALL_NO_PROFILE',
                agentId,
                profileName: targetProfileName,
                availableProfiles: Object.keys(agentEntry.profiles),
                rules: []
            };
        }

        const result = {
            resolved: true,
            agentId,
            profileName: targetProfileName,
            rules: profile.rules
        };
        if (profile.merge !== undefined) {
            result.merge = profile.merge;
        }
        if (profile.aggregate !== undefined) {
            result.aggregate = profile.aggregate;
        }
        if (profile.projection !== undefined) {
            result.projection = profile.projection;
        }
        if (profile.truncateTo !== undefined) {
            result.truncateTo = profile.truncateTo;
        }
        if (profile.metadata !== undefined) {
            result.metadata = profile.metadata;
        }
        if (agentEntry.allowedProfiles !== undefined) {
            result.allowedProfiles = agentEntry.allowedProfiles;
        }
        if (agentEntry.targets !== undefined) {
            result.targets = agentEntry.targets;
        }
        return result;
    }
}

module.exports = {
    ALLOWED_MODIFIERS_S01,
    ALLOWED_MODIFIERS,
    ALLOWED_RULE_TYPES,
    DEFAULT_CONFIG_PATH,
    RecallProfileResolver
};
