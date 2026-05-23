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

const _deprecationFlags = {
    type: false,
    diaries: false,
    kMultiplier: false
};

let cachedConfigPath = '';
let cachedConfigMtimeMs = -1;
let cachedConfigPayload = Object.freeze({ agents: {}, profiles: {} });

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

function normalizeBoolean(value) {
    if (typeof value === 'boolean') {
        return value;
    }
    if (typeof value === 'string') {
        const normalized = value.trim().toLowerCase();
        if (normalized === 'true' || normalized === '1') {
            return true;
        }
        if (normalized === 'false' || normalized === '0') {
            return false;
        }
    }
    return undefined;
}

function normalizeProjection(value) {
    if (typeof value === 'string') {
        return normalizeString(value) || undefined;
    }
    if (value && typeof value === 'object' && !Array.isArray(value)) {
        return normalizeString(value.emit) || undefined;
    }
    return undefined;
}

function loadRecallProfiles(configPath) {
    let stat;
    try {
        stat = fs.statSync(configPath);
    } catch (error) {
        cachedConfigPath = configPath;
        cachedConfigMtimeMs = -1;
        cachedConfigPayload = Object.freeze({ agents: {}, profiles: {} });
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
        const profiles = parsed?.profiles && typeof parsed.profiles === 'object' && !Array.isArray(parsed.profiles)
            ? parsed.profiles
            : {};

        cachedConfigPath = configPath;
        cachedConfigMtimeMs = stat.mtimeMs;
        cachedConfigPayload = Object.freeze({ agents, profiles });
        return cachedConfigPayload;
    } catch (error) {
        cachedConfigPath = configPath;
        cachedConfigMtimeMs = stat.mtimeMs;
        cachedConfigPayload = Object.freeze({ agents: {}, profiles: {} });
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
    const type = normalizeString(rule.baseMode || rule.type);
    if (!ALLOWED_RULE_TYPES.has(type)) {
        return null;
    }
    // Deprecation warnings for legacy flat fields (once per process)
    if (rule.type !== undefined && rule.baseMode === undefined && !_deprecationFlags.type) {
        _deprecationFlags.type = true;
        console.warn('[recallProfileResolver] Deprecated: rule.type → use rule.baseMode');
    }
    if (rule.diaries !== undefined && rule.targets?.diaries === undefined && !_deprecationFlags.diaries) {
        _deprecationFlags.diaries = true;
        console.warn('[recallProfileResolver] Deprecated: rule.diaries → use rule.targets.diaries');
    }
    if (rule.kMultiplier !== undefined && rule.targets?.kMultiplier === undefined && !_deprecationFlags.kMultiplier) {
        _deprecationFlags.kMultiplier = true;
        console.warn('[recallProfileResolver] Deprecated: rule.kMultiplier → use rule.targets.kMultiplier');
    }
    const rawTargets = rule.targets && typeof rule.targets === 'object' && !Array.isArray(rule.targets)
        ? rule.targets
        : null;
    const diaries = normalizeStringArray(rawTargets?.diaries !== undefined ? rawTargets.diaries : rule.diaries);
    const aggregate = normalizeBoolean(rawTargets?.aggregate);
    const projection = normalizeProjection(rule.projection);
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
    const rawKMultiplier = rawTargets?.kMultiplier !== undefined
        ? rawTargets.kMultiplier
        : rule.kMultiplier;
    const kMultiplier = typeof rawKMultiplier === 'number' && Number.isFinite(rawKMultiplier) && rawKMultiplier > 0
        ? rawKMultiplier
        : 1.0;
    const meta = rule.meta && typeof rule.meta === 'object' && !Array.isArray(rule.meta)
        ? { ...rule.meta }
        : undefined;
    const id = normalizeString(rule.id) || undefined;

    const result = {
        type,
        baseMode: type,
        diaries,
        targets: {
            diaries,
            ...(aggregate !== undefined ? { aggregate } : {}),
            kMultiplier
        },
        modifiers,
        gateThreshold,
        kMultiplier
    };
    if (id !== undefined) {
        result.id = id;
    }
    if (projection !== undefined) {
        result.projection = projection;
    }
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
    const projection = normalizeProjection(profile.projection);
    const truncateTo = typeof profile.truncateTo === 'number' && Number.isFinite(profile.truncateTo) && profile.truncateTo > 0
        ? Math.floor(profile.truncateTo)
        : undefined;
    const tokenBudget = typeof profile.tokenBudget === 'number' && Number.isFinite(profile.tokenBudget) && profile.tokenBudget > 0
        ? Math.floor(profile.tokenBudget)
        : undefined;
    const maxTokenRatio = typeof profile.maxTokenRatio === 'number' && Number.isFinite(profile.maxTokenRatio)
        ? Math.max(0.1, Math.min(1.0, profile.maxTokenRatio))
        : undefined;
    const minScore = typeof profile.minScore === 'number' && Number.isFinite(profile.minScore)
        ? Math.max(0, Math.min(1, profile.minScore))
        : undefined;
    const metadata = profile.metadata && typeof profile.metadata === 'object' && !Array.isArray(profile.metadata)
        ? { ...profile.metadata }
        : undefined;
    const aiMemo = profile.aiMemo !== undefined
        ? (typeof profile.aiMemo === 'boolean'
            ? profile.aiMemo
            : (profile.aiMemo && typeof profile.aiMemo === 'object' && !Array.isArray(profile.aiMemo)
                ? { ...profile.aiMemo }
                : undefined))
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
    if (tokenBudget !== undefined) {
        result.tokenBudget = tokenBudget;
    }
    if (maxTokenRatio !== undefined) {
        result.maxTokenRatio = maxTokenRatio;
    }
    if (minScore !== undefined) {
        result.minScore = minScore;
    }
    if (metadata !== undefined) {
        result.metadata = metadata;
    }
    if (aiMemo !== undefined) {
        result.aiMemo = aiMemo;
    }
    return result;
}

function normalizeProfilesMap(rawProfiles) {
    const source = rawProfiles && typeof rawProfiles === 'object' && !Array.isArray(rawProfiles)
        ? rawProfiles
        : {};
    const profiles = {};
    for (const [profileName, rawProfile] of Object.entries(source)) {
        const normalizedProfile = normalizeProfile(rawProfile);
        if (normalizedProfile) {
            profiles[profileName] = normalizedProfile;
        }
    }
    return profiles;
}

function normalizeAgentEntry(entry) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
        return null;
    }
    const defaultProfile = normalizeString(entry.defaultProfile);
    const profiles = normalizeProfilesMap(entry.profiles);
    const allowedProfiles = Array.isArray(entry.allowedProfiles)
        ? entry.allowedProfiles.map((item) => normalizeString(item)).filter(Boolean)
        : undefined;
    const targets = Array.isArray(entry.targets)
        ? entry.targets.map((item) => normalizeString(item)).filter(Boolean)
        : undefined;

    const result = {
        defaultProfile: defaultProfile || undefined
    };
    if (Object.keys(profiles).length > 0) {
        result.profiles = profiles;
    }
    if (allowedProfiles !== undefined && allowedProfiles.length > 0) {
        result.allowedProfiles = allowedProfiles;
    }
    if (targets !== undefined && targets.length > 0) {
        result.targets = targets;
    }
    if (!result.defaultProfile && !result.allowedProfiles && !result.targets && !result.profiles) {
        return null;
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

        const profiles = {
            ...normalizeProfilesMap(config.profiles),
            ...(agentEntry.profiles || {})
        };
        const configuredProfileNames = Object.keys(profiles);
        const availableProfiles = agentEntry.allowedProfiles?.length > 0
            ? [...agentEntry.allowedProfiles]
            : configuredProfileNames;
        const targetProfileName = normalizeString(profileName) ||
            agentEntry.defaultProfile ||
            availableProfiles[0] ||
            configuredProfileNames[0] ||
            '';
        if (agentEntry.allowedProfiles?.length > 0 && !agentEntry.allowedProfiles.includes(targetProfileName)) {
            return {
                resolved: false,
                code: 'RECALL_FORBIDDEN',
                agentId,
                profileName: targetProfileName,
                availableProfiles: [...agentEntry.allowedProfiles],
                rules: []
            };
        }

        // --- S04: raw-profile validation before normalization ---
        let rawProfile = (config.profiles && typeof config.profiles === 'object' && !Array.isArray(config.profiles))
            ? config.profiles[targetProfileName]
            : undefined;
        if (!rawProfile) {
            const aliases = buildAgentAliases(agentId);
            for (const alias of aliases) {
                const rawEntry = config.agents?.[alias];
                if (rawEntry && typeof rawEntry === 'object' && !Array.isArray(rawEntry) && rawEntry.profiles?.[targetProfileName]) {
                    rawProfile = rawEntry.profiles[targetProfileName];
                    break;
                }
            }
            if (!rawProfile) {
                const wildcardRaw = config.agents?.['*'];
                if (wildcardRaw && typeof wildcardRaw === 'object' && !Array.isArray(wildcardRaw) && wildcardRaw.profiles?.[targetProfileName]) {
                    rawProfile = wildcardRaw.profiles[targetProfileName];
                }
            }
        }

        if (rawProfile && typeof rawProfile === 'object' && !Array.isArray(rawProfile)) {
            const rawRules = Array.isArray(rawProfile.rules) ? rawProfile.rules : [];
            for (let ruleIndex = 0; ruleIndex < rawRules.length; ruleIndex += 1) {
                const rawRule = rawRules[ruleIndex];
                if (!rawRule || typeof rawRule !== 'object' || Array.isArray(rawRule)) {
                    continue;
                }
                const ruleType = normalizeString(rawRule.baseMode || rawRule.type);
                if (ruleType && !ALLOWED_RULE_TYPES.has(ruleType)) {
                    return {
                        resolved: false,
                        code: 'RECALL_INVALID_RULE',
                        agentId,
                        profileName: targetProfileName,
                        details: {
                            ruleIndex,
                            ruleType,
                            message: `Rule type "${ruleType}" is not allowed`
                        },
                        rules: []
                    };
                }

                const modifierValidation = this.validateModifiers(rawRule.modifiers);
                if (!modifierValidation.valid) {
                    return {
                        resolved: false,
                        code: 'RECALL_INVALID_MODIFIER',
                        agentId,
                        profileName: targetProfileName,
                        details: {
                            ruleIndex,
                            invalidModifiers: modifierValidation.invalid,
                            message: `Invalid modifiers: ${modifierValidation.invalid.join(', ')}`
                        },
                        rules: []
                    };
                }

                const ruleDiaries = normalizeStringArray(
                    rawRule.targets?.diaries !== undefined ? rawRule.targets.diaries : rawRule.diaries
                );
                const diaryValidation = this.validateDiaryAccess(ruleDiaries, agentEntry?.targets);
                if (!diaryValidation.valid) {
                    return {
                        resolved: false,
                        code: 'RECALL_INVALID_DIARY',
                        agentId,
                        profileName: targetProfileName,
                        details: {
                            ruleIndex,
                            forbidden: diaryValidation.forbidden,
                            message: `Forbidden diaries: ${diaryValidation.forbidden.join(', ')}`
                        },
                        rules: []
                    };
                }
            }

            if (rawRules.length > 0) {
                const normalizedTest = normalizeProfile({ ...rawProfile, rules: rawRules });
                if (!normalizedTest) {
                    return {
                        resolved: false,
                        code: 'RECALL_INVALID_PROFILE',
                        agentId,
                        profileName: targetProfileName,
                        details: {
                            message: 'All rules in profile are invalid'
                        },
                        rules: []
                    };
                }
            }
        }
        // --- end S04 validation ---

        const profile = profiles[targetProfileName];
        if (!profile) {
            return {
                resolved: false,
                code: 'RECALL_NO_PROFILE',
                agentId,
                profileName: targetProfileName,
                availableProfiles,
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
        if (profile.tokenBudget !== undefined) {
            result.tokenBudget = profile.tokenBudget;
        }
        if (profile.maxTokenRatio !== undefined) {
            result.maxTokenRatio = profile.maxTokenRatio;
        }
        if (profile.minScore !== undefined) {
            result.minScore = profile.minScore;
        }
        if (profile.metadata !== undefined) {
            result.metadata = profile.metadata;
        }
        if (profile.aiMemo !== undefined) {
            result.aiMemo = profile.aiMemo;
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
