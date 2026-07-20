const { AGW_ERROR_CODES } = require('../contracts/errorCodes');
const { buildGuidanceBundle } = require('../policy/agentGuidanceResolver');
const { normalizeString } = require('../policy/shared/normalize');

/**
 * Canonical agent guidance service（§4.2、§5.1 / M2.S1）。
 *
 * guidance 单源产出：REST binding、MCP guidance resource、bootstrap 的
 * `integrationGuidance` 与 initialize.instructions 都只消费本服务的 bundle，
 * 不各自复述日记本路由或写入策略。allowed/defaultDiaries 由 memory policy
 * 模块经 agentPolicyResolver 注入；revision 与冻结 integration snapshot 一致。
 *
 * 失败语义（§4.3 内容/调优域）：integration snapshot 不可用（初始加载失败且
 * 无 last-known-good）→ AGW_CONFIG_UNAVAILABLE（REST 503 / MCP
 * MCP_SERVICE_UNAVAILABLE），不伪装成空配置。
 */

/**
 * 近似 token 计数的 canonical 单点实现（§5.2）：`ceil(chars/4)`，按 UTF-8
 * code point 计。两个 MCP adapter 的 instructions 裁剪必须复用此实现，
 * 保证同一 guidance revision 在两条路径裁剪结果一致。
 */
function estimateTokenCount(text) {
    if (typeof text !== 'string' || text.length === 0) {
        return 0;
    }
    let codePoints = 0;
    // Array.from/for-of 按 code point 迭代（代理对算 1）。
    for (const _char of text) {
        codePoints += 1;
    }
    return Math.ceil(codePoints / 4);
}

function createAgentGuidanceService({
    snapshotCoordinator,
    agentPolicyResolver,
    ragRetrieverPort
} = {}) {
    if (!snapshotCoordinator || typeof snapshotCoordinator.refreshIntegrationSnapshot !== 'function') {
        throw new TypeError('createAgentGuidanceService requires an integration snapshot coordinator');
    }

    // 内容/调优配置按需热加载：合并并发刷新（in-flight coalescing），
    // 失败时协调器内部保留 last-known-good（§4.3）。
    let inflightRefresh = null;

    async function refreshIntegrationStatus() {
        if (!inflightRefresh) {
            inflightRefresh = Promise.resolve(snapshotCoordinator.refreshIntegrationSnapshot())
                .finally(() => {
                    inflightRefresh = null;
                });
        }
        return inflightRefresh;
    }

    async function resolveDiaryScopes(agentId) {
        if (!agentPolicyResolver || typeof agentPolicyResolver.resolvePolicy !== 'function') {
            return { allowedDiaries: [], defaultDiaries: [] };
        }
        const availableDiaries = await Promise.resolve(ragRetrieverPort?.listDiaries?.() || []);
        const policy = await agentPolicyResolver.resolvePolicy({
            authContext: { agentId },
            availableDiaries
        });
        return {
            allowedDiaries: policy.allowedDiaryNames || [],
            defaultDiaries: policy.defaultDiaryNames || []
        };
    }

    /**
     * @returns {{ ok: true, guidance: object } |
     *           { ok: false, code: string, httpStatus: number, reason: string }}
     */
    async function getAgentGuidance(agentId) {
        const normalizedAgentId = normalizeString(agentId);
        if (!normalizedAgentId) {
            return {
                ok: false,
                code: AGW_ERROR_CODES.INVALID_REQUEST,
                httpStatus: 400,
                reason: 'agentId is required'
            };
        }

        const status = await refreshIntegrationStatus();
        if (!status.available || !status.snapshot) {
            return {
                ok: false,
                code: AGW_ERROR_CODES.CONFIG_UNAVAILABLE,
                httpStatus: 503,
                reason: 'integration guidance configuration is unavailable'
            };
        }

        const snapshot = status.snapshot;
        if (!snapshot.agents?.[normalizedAgentId]) {
            return {
                ok: false,
                code: AGW_ERROR_CODES.NOT_FOUND,
                httpStatus: 404,
                reason: `agent "${normalizedAgentId}" has no published integration guidance`
            };
        }

        const { allowedDiaries, defaultDiaries } = await resolveDiaryScopes(normalizedAgentId);
        const guidance = buildGuidanceBundle({
            snapshot,
            agentId: normalizedAgentId,
            allowedDiaries,
            defaultDiaries
        });
        return { ok: true, guidance };
    }

    /**
     * 当前冻结快照的 revision（诊断/一致性校验用途）。
     */
    function getIntegrationRevision() {
        const status = snapshotCoordinator.getIntegrationStatus?.();
        return status?.snapshot?.revision || null;
    }

    return Object.freeze({
        estimateTokenCount,
        getAgentGuidance,
        getIntegrationRevision
    });
}

module.exports = { createAgentGuidanceService, estimateTokenCount };
