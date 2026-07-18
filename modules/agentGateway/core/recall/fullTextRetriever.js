const { AGW_ERROR_CODES } = require('../../contracts/errorCodes');
const { normalizeString } = require('../../policy/shared/normalize');
const { resolveDiaryAccess } = require('./diaryAccess');
const support = require('./runtimeSupport');

function buildFullTextItem({ diaryName, content, rank }) {
    return {
        text: normalizeString(content),
        score: typeof rank === 'number' && Number.isFinite(rank) ? rank : 1,
        sourceDiary: normalizeString(diaryName),
        sourceFile: '',
        timestamp: null,
        tags: []
    };
}

async function defaultFullTextRetriever({
    ragRetrieverPort,
    ragConfig,
    requestedDiaries,
    agentId,
    authContext,
    agentPolicyResolver,
    adapterAppliedDefaultDiaryPolicy
}) {
    const availableDiaries = support.normalizeStringArray(
        await Promise.resolve(ragRetrieverPort?.listDiaries?.() || [])
    );
    const policyAuthContext = support.resolvePolicyAuthContext(authContext, agentId);
    const access = await resolveDiaryAccess({
        requestedDiaries,
        availableDiaries,
        agentId,
        authContext: policyAuthContext,
        policyResolver: agentPolicyResolver,
        fallbackAllowedDiaries: support.resolveAllowedDiaries({ agentId, availableDiaries, ragConfig }),
        appliedDefaultPolicy: adapterAppliedDefaultDiaryPolicy,
        forbiddenCode: AGW_ERROR_CODES.RECALL_FORBIDDEN
    });
    if (!access.success) return access;
    if (!ragRetrieverPort?.available || typeof ragRetrieverPort.getDiaryContent !== 'function') {
        return {
            success: false,
            status: 500,
            code: AGW_ERROR_CODES.RECALL_EXECUTION_ERROR,
            error: 'Full text retrieval is not available'
        };
    }

    const items = [];
    for (let index = 0; index < access.targetDiaries.length; index += 1) {
        const diaryName = access.targetDiaries[index];
        const content = await ragRetrieverPort.getDiaryContent(diaryName);
        if (normalizeString(content)) {
            items.push(buildFullTextItem({ diaryName, content, rank: Math.max(0.1, 1 - (index * 0.01)) }));
        }
    }
    return { success: true, targetDiaries: access.targetDiaries, items };
}

module.exports = { buildFullTextItem, defaultFullTextRetriever };
