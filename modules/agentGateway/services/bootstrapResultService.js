const { sanitizeRequestContextValue } = require('../contracts/requestContext');

/**
 * Canonical bootstrap 结果整形（§5.1、§5.3 / M2.S3.T1）。
 *
 * in-process 与 backend-proxy 两个 adapter 曾各持一份 `buildBootstrapResult`
 * 实现；本模块是唯一实现，两条路径必须复用，保证 `summary` 等"现有字段"
 * 承诺在所有分支（含 deferred `accepted`/`waiting_approval`）对两个 adapter
 * 一致成立。
 */

function normalizeBootstrapString(value, maxLength = 256) {
    return sanitizeRequestContextValue(value, maxLength);
}

function buildBootstrapSummary(renderResult, agentId) {
    const resolvedAgentId = normalizeBootstrapString(renderResult?.agentId || agentId) || 'unknown-agent';
    const renderedPrompt = typeof renderResult?.renderedPrompt === 'string' ? renderResult.renderedPrompt : '';
    const warnings = Array.isArray(renderResult?.warnings) ? renderResult.warnings : [];
    const fragments = [`Bootstrap prompt ready for ${resolvedAgentId}`];
    if (renderedPrompt) fragments.push(`length=${renderedPrompt.length}`);
    if (renderResult?.truncated) fragments.push('truncated=true');
    if (warnings.length > 0) fragments.push(`warnings=${warnings.length}`);
    return fragments.join('; ');
}

function buildBootstrapResult(renderResult, agentId) {
    return {
        ...renderResult,
        agentId: normalizeBootstrapString(renderResult?.agentId || agentId) || agentId,
        summary: buildBootstrapSummary(renderResult, agentId)
    };
}

/**
 * deferred 分支（`accepted`/`waiting_approval`）的 summary（§5.3）：
 * 此时尚无 renderedPrompt，摘要描述 deferred 状态与关联 job。
 */
function buildDeferredBootstrapSummary({ status, agentId, jobId } = {}) {
    const resolvedAgentId = normalizeBootstrapString(agentId) || 'unknown-agent';
    const fragments = [
        status === 'waiting_approval'
            ? `Bootstrap waiting for approval for ${resolvedAgentId}`
            : `Bootstrap accepted for deferred processing for ${resolvedAgentId}`
    ];
    const resolvedJobId = normalizeBootstrapString(jobId);
    if (resolvedJobId) fragments.push(`jobId=${resolvedJobId}`);
    return fragments.join('; ');
}

module.exports = {
    buildBootstrapResult,
    buildBootstrapSummary,
    buildDeferredBootstrapSummary
};
