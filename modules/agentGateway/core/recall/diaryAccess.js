const {
    normalizeDiaryCanonicalName,
    resolveDiaryAliasesToAvailable
} = require('../../policy/mcpAgentMemoryPolicy');
const {
    buildDiaryAccessDetails,
    buildDiaryDefaultsMissingMessage,
    buildDiaryForbiddenMessage
} = require('../../policy/diaryAccessError');
const { normalizeStringArray } = require('../../policy/shared/normalize');

function normalizeDiarySelection(diaries, availableDiaries) {
    return resolveDiaryAliasesToAvailable(diaries, availableDiaries)
        .map((diary) => normalizeDiaryCanonicalName(diary))
        .filter(Boolean);
}

function createDiaryAccessRejection({ code, error, agentId, allowedDiaries, defaultDiaries, forbiddenDiaries }) {
    return {
        success: false,
        status: 403,
        code,
        error,
        details: buildDiaryAccessDetails({
            agentId,
            allowedDiaries,
            defaultDiaries,
            forbiddenDiaries
        })
    };
}

async function resolveDiaryAccess({
    requestedDiaries,
    availableDiaries,
    agentId,
    authContext,
    policyResolver,
    fallbackAllowedDiaries,
    appliedDefaultPolicy = false,
    forbiddenCode,
    forbiddenError,
    emptyError
}) {
    const resolvedPolicy = policyResolver
        ? await policyResolver.resolvePolicy({ authContext, availableDiaries })
        : null;
    const allowedDiaries = normalizeStringArray(
        resolvedPolicy ? resolvedPolicy.allowedDiaryNames : fallbackAllowedDiaries
    );
    const defaultDiaries = normalizeStringArray(
        resolvedPolicy?.defaultDiaryNames?.length ? resolvedPolicy.defaultDiaryNames : allowedDiaries
    );
    let requested = normalizeDiarySelection(requestedDiaries, availableDiaries);
    const forbiddenDiaries = requested.filter((diary) => !allowedDiaries.includes(diary));

    if (forbiddenDiaries.length) {
        if (!appliedDefaultPolicy) {
            return createDiaryAccessRejection({
                code: forbiddenCode,
                error: forbiddenError || buildDiaryForbiddenMessage({ forbiddenDiaries, allowedDiaries }),
                agentId,
                allowedDiaries, defaultDiaries, forbiddenDiaries
            });
        }
        requested = requested.filter((diary) => allowedDiaries.includes(diary));
        if (!requested.length) {
            return createDiaryAccessRejection({
                code: forbiddenCode,
                error: emptyError || buildDiaryDefaultsMissingMessage({ allowedDiaries }),
                agentId,
                allowedDiaries,
                defaultDiaries
            });
        }
    }

    const targetDiaries = requested.length
        ? requested
        : normalizeDiarySelection(defaultDiaries, availableDiaries);
    if (!targetDiaries.length) {
        return createDiaryAccessRejection({
            code: forbiddenCode,
            error: emptyError || buildDiaryDefaultsMissingMessage({ allowedDiaries }),
            agentId,
            allowedDiaries,
            defaultDiaries
        });
    }
    return { success: true, targetDiaries, allowedDiaries, defaultDiaries };
}

module.exports = { normalizeDiarySelection, resolveDiaryAccess };
