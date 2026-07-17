const { AGW_ERROR_CODES } = require('../../contracts/errorCodes');
const {
    areDiaryNamesEquivalent,
    normalizeDiaryCanonicalName,
    resolveConfiguredAgentMemoryPolicy
} = require('../../policy/mcpAgentMemoryPolicy');
const { MCP_GATEWAY_TOOL_NAMES } = require('./descriptors');
const { normalizeMcpString } = require('./resultShapes');

const DIARY_POLICY_TOOL_NAMES = new Set([
    MCP_GATEWAY_TOOL_NAMES.MEMORY_SEARCH,
    MCP_GATEWAY_TOOL_NAMES.CONTEXT_ASSEMBLE
]);

function normalizeDiarySelection(payload = {}) {
    const diary = normalizeDiaryCanonicalName(normalizeMcpString(payload.diary, 256));
    const diaries = Array.isArray(payload.diaries)
        ? payload.diaries
            .map((value) => normalizeDiaryCanonicalName(normalizeMcpString(value, 256)))
            .filter(Boolean)
        : [];
    return {
        diary,
        diaries: diary && !diaries.includes(diary) ? [diary, ...diaries] : diaries
    };
}

function createDiaryPolicyRejection({ requestId, agentId, allowedDiaries, defaultDiaries, forbiddenDiaries }) {
    const hasForbiddenTarget = Array.isArray(forbiddenDiaries) && forbiddenDiaries.length > 0;
    return {
        success: false,
        requestId,
        status: 403,
        code: AGW_ERROR_CODES.FORBIDDEN,
        error: hasForbiddenTarget
            ? 'Requested diary target is not allowed for this agent'
            : 'No default diary targets are configured for this agent',
        details: {
            ...(hasForbiddenTarget ? {
                diary: forbiddenDiaries[0],
                diaries: forbiddenDiaries
            } : {}),
            agentId,
            allowedDiaries,
            ...(hasForbiddenTarget ? {} : { defaultDiaries })
        }
    };
}

function applyDiaryPolicyGate({ toolName, payload = {}, input = {}, defaultAgentId = '' } = {}) {
    const unchanged = {
        payload,
        rejection: null,
        diaryPolicy: { appliedDefault: false }
    };
    if (!DIARY_POLICY_TOOL_NAMES.has(toolName)) {
        return unchanged;
    }

    const agentId = normalizeMcpString(
        input.agentId ||
        payload.agentId ||
        payload.target?.agentId ||
        input.requestContext?.agentId ||
        payload.requestContext?.agentId ||
        defaultAgentId ||
        process.env.VCP_MCP_DEFAULT_AGENT_ID,
        256
    );
    const requestId = normalizeMcpString(
        input.requestContext?.requestId || payload.requestContext?.requestId,
        128
    );
    const policy = resolveConfiguredAgentMemoryPolicy({ agentId });
    const allowedDiaries = policy.allowedDiaryNames;
    const defaultDiaries = policy.defaultDiaryNames.length > 0
        ? policy.defaultDiaryNames
        : allowedDiaries;

    if (allowedDiaries.length === 0 && defaultDiaries.length === 0) {
        return unchanged;
    }

    const { diary, diaries: requestedDiaries } = normalizeDiarySelection(payload);
    if (requestedDiaries.length > 0) {
        const forbiddenDiaries = requestedDiaries.filter(
            (requestedDiary) => !allowedDiaries.some(
                (allowedDiary) => areDiaryNamesEquivalent(requestedDiary, allowedDiary)
            )
        );
        if (forbiddenDiaries.length > 0) {
            return {
                ...unchanged,
                rejection: createDiaryPolicyRejection({
                    requestId,
                    agentId,
                    allowedDiaries,
                    defaultDiaries,
                    forbiddenDiaries
                })
            };
        }
        return {
            payload: {
                ...payload,
                diary: diary || requestedDiaries[0] || '',
                diaries: requestedDiaries
            },
            rejection: null,
            diaryPolicy: { appliedDefault: false }
        };
    }

    if (defaultDiaries.length === 0) {
        return {
            ...unchanged,
            rejection: createDiaryPolicyRejection({
                requestId,
                agentId,
                allowedDiaries,
                defaultDiaries
            })
        };
    }

    return {
        payload: {
            ...payload,
            diary: defaultDiaries[0],
            diaries: defaultDiaries
        },
        rejection: null,
        diaryPolicy: { appliedDefault: true }
    };
}

module.exports = {
    applyDiaryPolicyGate,
    normalizeDiarySelection
};
