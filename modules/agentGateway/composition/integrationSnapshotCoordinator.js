const crypto = require('crypto');
const fs = require('fs/promises');

const { parseAgentGuidanceConfig } = require('../policy/agentGuidanceConfig');
const {
    parseCredentialFileConfig,
    parsePepperKeyringConfig
} = require('../policy/credentialConfigSchema');
const {
    crossValidateCredentialAgents,
    crossValidateCredentialPepperKids,
    crossValidateGuidanceAgents,
    crossValidateMemoryPolicyDiaries
} = require('../policy/integrationCrossChecks');
const { buildAuthPolicyCatalog } = require('../contracts/authPolicyCatalog');
const { normalizeString } = require('../policy/shared/normalize');

/**
 * integrationSnapshotCoordinator（§4.3 / M0.S3）。
 *
 * 两类配置、两种失败语义：
 * 1. 内容/调优配置（guidance）：初始失败 health degraded + AGW_CONFIG_UNAVAILABLE；
 *    热加载失败保留 last-known-good，记录失败 content hash 与当前有效 revision。
 * 2. 身份/授权配置（credential 文件、pepper keyring、auth policy catalog）：
 *    初始或热加载失败一律 fail-closed，绝不保留旧 security snapshot 继续认证。
 *
 * 候选变化时读取关联配置全集，交叉校验通过后一次性发布
 * `{ revision, contentHashes, agents }` 冻结快照；不允许各 resolver 独立替换。
 */

function sha256Hex(buffer) {
    return crypto.createHash('sha256').update(buffer).digest('hex');
}

function computeSnapshotRevision(contentHashes) {
    const canonical = JSON.stringify(
        Object.keys(contentHashes).sort().map((key) => [key, contentHashes[key]])
    );
    return `sha256:${sha256Hex(Buffer.from(canonical, 'utf8'))}`;
}

function createIntegrationSnapshotCoordinator({
    guidanceConfigPath,
    credentialsPath,
    pepperKeyringPath,
    listAgents,
    getMemoryPolicy,
    legacyCredentialEnabled = true,
    allowLegacyScopeNames = true,
    buildCatalog = buildAuthPolicyCatalog,
    detectLegacyTokenCollision = null,
    logger = console
} = {}) {
    if (typeof listAgents !== 'function') {
        throw new TypeError('createIntegrationSnapshotCoordinator requires a listAgents() port');
    }

    const state = {
        // 内容/调优域
        integrationSnapshot: null,
        integrationFailure: null,
        lastGoodIntegrationRevision: null,
        // 身份/授权域（分域记录，某一域失败不影响无关域）
        securitySnapshot: null,
        securityFailure: null,
        // 发布历史
        recoveryEvents: []
    };

    async function readFileCandidate(filePath) {
        const normalizedPath = normalizeString(filePath);
        if (!normalizedPath) {
            return { present: false, path: '', bytes: null, contentHash: null, error: null };
        }
        try {
            const bytes = await fs.readFile(normalizedPath);
            return { present: true, path: normalizedPath, bytes, contentHash: `sha256:${sha256Hex(bytes)}`, error: null };
        } catch (error) {
            return { present: true, path: normalizedPath, bytes: null, contentHash: null, error };
        }
    }

    function recordRecovery(domain, fromFailure, revision) {
        if (!fromFailure) {
            return;
        }
        const event = {
            domain,
            failedContentHash: fromFailure.contentHash || null,
            recoveredRevision: revision,
            at: new Date().toISOString()
        };
        state.recoveryEvents.push(event);
        logger.info?.(`[integrationSnapshotCoordinator] ${domain} recovered to ${revision}`);
    }

    /**
     * 内容/调优域：guidance 配置。失败保留 last-known-good（若有）。
     */
    async function refreshIntegrationSnapshot() {
        const candidate = await readFileCandidate(guidanceConfigPath);
        const failure = {
            domain: 'guidance',
            at: new Date().toISOString(),
            currentRevision: state.lastGoodIntegrationRevision
        };

        if (!candidate.present || candidate.error || candidate.bytes === null) {
            failure.reason = candidate.present ? `unreadable: ${candidate.error?.message}` : 'path not configured';
            failure.contentHash = null;
            state.integrationFailure = failure;
            return buildIntegrationStatus();
        }

        const parsed = parseAgentGuidanceConfig(candidate.bytes.toString('utf8'));
        if (!parsed.valid) {
            failure.reason = 'validation failed';
            failure.errors = parsed.errors;
            failure.contentHash = candidate.contentHash;
            state.integrationFailure = failure;
            return buildIntegrationStatus();
        }

        const directoryEntries = listAgents() || [];
        const directoryAgentIds = directoryEntries.map((entry) => normalizeString(entry?.alias)).filter(Boolean);
        const crossErrors = crossValidateGuidanceAgents(parsed.config, directoryAgentIds);
        if (typeof getMemoryPolicy === 'function') {
            for (const agentId of Object.keys(parsed.config.agents)) {
                const memoryPolicy = getMemoryPolicy(agentId);
                if (memoryPolicy) {
                    crossErrors.push(...crossValidateMemoryPolicyDiaries({ agentId, ...memoryPolicy }));
                }
            }
        }
        if (crossErrors.length > 0) {
            failure.reason = 'cross-reference validation failed';
            failure.errors = crossErrors;
            failure.contentHash = candidate.contentHash;
            state.integrationFailure = failure;
            return buildIntegrationStatus();
        }

        const contentHashes = { guidance: candidate.contentHash };
        const revision = computeSnapshotRevision(contentHashes);
        const previousFailure = state.integrationFailure;
        const agents = Object.fromEntries(
            Object.entries(parsed.config.agents).map(([agentId, entry]) => {
                const directoryEntry = directoryEntries.find((item) => normalizeString(item?.alias) === agentId);
                return [agentId, Object.freeze({
                    agentId,
                    alias: normalizeString(directoryEntry?.alias) || agentId,
                    displayName: entry.displayName || agentId,
                    guidanceRef: agentId,
                    memoryPolicyRef: agentId,
                    recallProfileRef: agentId
                })];
            })
        );

        state.integrationSnapshot = Object.freeze({
            revision,
            contentHashes: Object.freeze(contentHashes),
            agents: Object.freeze(agents),
            shared: parsed.config.shared,
            publishedAt: new Date().toISOString()
        });
        state.integrationFailure = null;
        state.lastGoodIntegrationRevision = revision;
        recordRecovery('guidance', previousFailure, revision);
        return buildIntegrationStatus();
    }

    /**
     * 身份/授权域：credential 文件 + pepper keyring + auth policy catalog。
     * 任何失败 fail-closed：清空 security snapshot，不保留旧授权。
     */
    async function refreshSecuritySnapshot() {
        const failure = { domain: 'security', at: new Date().toISOString(), fields: {} };
        const previousFailure = state.securityFailure;

        const catalogResult = buildCatalog();
        if (!catalogResult.valid) {
            failure.fields.authorizationPolicy = { reason: 'catalog validation failed', errors: catalogResult.errors };
            state.securitySnapshot = null;
            state.securityFailure = failure;
            return buildSecurityStatus();
        }

        const credentialCandidate = await readFileCandidate(credentialsPath);
        const keyringCandidate = await readFileCandidate(pepperKeyringPath);

        const catalogHash = `sha256:${sha256Hex(Buffer.from(JSON.stringify(catalogResult.catalog.entries), 'utf8'))}`;

        // 阶段 A 特例（§4.4）：legacy 启用且未设置 path → 有效空 snapshot + migration warning。
        if (!credentialCandidate.present) {
            if (!legacyCredentialEnabled) {
                failure.fields.credentialFile = { reason: 'AGENT_GATEWAY_CREDENTIALS_PATH is required once legacy credentials are disabled' };
                state.securitySnapshot = null;
                state.securityFailure = failure;
                return buildSecurityStatus();
            }
            logger.warn?.('[integrationSnapshotCoordinator] AGENT_GATEWAY_CREDENTIALS_PATH not set; publishing empty credential snapshot (migration phase A)');
            const contentHashes = { credentials: null, pepperKeyring: null };
            const revision = computeSnapshotRevision({ ...contentHashes, catalog: catalogHash });
            state.securitySnapshot = Object.freeze({
                revision,
                contentHashes: Object.freeze(contentHashes),
                credentials: Object.freeze([]),
                pepperKeys: Object.freeze({}),
                authPolicyCatalog: catalogResult.catalog,
                migrationWarning: 'no credential file configured',
                publishedAt: new Date().toISOString()
            });
            state.securityFailure = null;
            recordRecovery('security', previousFailure, revision);
            return buildSecurityStatus();
        }

        // 已设置但不可读 → fail-closed，不退回空 snapshot。
        if (credentialCandidate.error || credentialCandidate.bytes === null) {
            failure.fields.credentialFile = { reason: `unreadable: ${credentialCandidate.error?.message}` };
        }
        let credentialParsed = null;
        if (credentialCandidate.bytes !== null) {
            credentialParsed = parseCredentialFileConfig(credentialCandidate.bytes.toString('utf8'), { allowLegacyScopeNames });
            if (!credentialParsed.valid) {
                failure.fields.credentialFile = {
                    reason: 'validation failed',
                    errors: credentialParsed.errors,
                    contentHash: credentialCandidate.contentHash
                };
            }
        }

        const hasCredentialRecords = credentialParsed?.valid && credentialParsed.config.credentials.length > 0;
        let keyringParsed = null;
        if (!keyringCandidate.present) {
            if (hasCredentialRecords) {
                failure.fields.pepperKeyring = { reason: 'AGENT_GATEWAY_CREDENTIAL_PEPPERS_PATH is required when credential records exist' };
            }
        } else if (keyringCandidate.error || keyringCandidate.bytes === null) {
            failure.fields.pepperKeyring = { reason: `unreadable: ${keyringCandidate.error?.message}` };
        } else {
            keyringParsed = parsePepperKeyringConfig(keyringCandidate.bytes.toString('utf8'));
            if (!keyringParsed.valid) {
                failure.fields.pepperKeyring = {
                    reason: 'validation failed',
                    errors: keyringParsed.errors,
                    contentHash: keyringCandidate.contentHash
                };
            }
        }

        if (credentialParsed?.valid) {
            const crossErrors = [];
            if (keyringParsed?.valid) {
                crossErrors.push(...crossValidateCredentialPepperKids(credentialParsed.config, keyringParsed.config));
            }
            // §4.3 第 3-4 条：credential 引用未知/未发布 agent 时对应安全域不可用。
            const directoryAgentIds = (listAgents() || [])
                .map((entry) => normalizeString(entry?.alias))
                .filter(Boolean);
            crossErrors.push(...crossValidateCredentialAgents(credentialParsed.config, directoryAgentIds));
            if (crossErrors.length > 0) {
                failure.fields.credentialFile = { reason: 'cross-reference validation failed', errors: crossErrors };
            }
            // §3.3：内置 legacy token 与文件 credential token 冲突属配置错误，拒绝发布。
            if (typeof detectLegacyTokenCollision === 'function' && keyringParsed?.valid) {
                const collision = detectLegacyTokenCollision({
                    available: true,
                    records: credentialParsed.config.credentials,
                    pepperKeys: keyringParsed.config.keys
                });
                if (collision?.collision) {
                    failure.fields.credentialFile = {
                        reason: 'legacy gateway key collides with file credential token',
                        credentialId: collision.credentialId
                    };
                }
            }
        }

        if (Object.keys(failure.fields).length > 0) {
            state.securitySnapshot = null;
            state.securityFailure = failure;
            return buildSecurityStatus();
        }

        const contentHashes = {
            credentials: credentialCandidate.contentHash,
            pepperKeyring: keyringCandidate.present ? keyringCandidate.contentHash : null
        };
        const revision = computeSnapshotRevision({ ...contentHashes, catalog: catalogHash });
        state.securitySnapshot = Object.freeze({
            revision,
            contentHashes: Object.freeze(contentHashes),
            credentials: Object.freeze(credentialParsed.config.credentials),
            pepperKeys: keyringParsed ? keyringParsed.config.keys : Object.freeze({}),
            authPolicyCatalog: catalogResult.catalog,
            warnings: credentialParsed.warnings,
            publishedAt: new Date().toISOString()
        });
        state.securityFailure = null;
        recordRecovery('security', previousFailure, revision);
        return buildSecurityStatus();
    }

    function buildIntegrationStatus() {
        if (state.integrationSnapshot && !state.integrationFailure) {
            return { available: true, snapshot: state.integrationSnapshot, failure: null };
        }
        // 热加载失败保留 last-known-good；初始失败没有可保留的快照。
        return {
            available: Boolean(state.integrationSnapshot),
            snapshot: state.integrationSnapshot,
            failure: state.integrationFailure,
            code: state.integrationSnapshot ? null : 'AGW_CONFIG_UNAVAILABLE'
        };
    }

    function buildSecurityStatus() {
        if (state.securitySnapshot && !state.securityFailure) {
            return { available: true, snapshot: state.securitySnapshot, failure: null };
        }
        return { available: false, snapshot: null, failure: state.securityFailure, code: 'AGW_CONFIG_UNAVAILABLE' };
    }

    /**
     * health 分域暴露（M0.S3.T4）。
     */
    function getHealthDomains() {
        const securityFields = state.securityFailure?.fields || {};
        return Object.freeze({
            guidance: state.integrationSnapshot && !state.integrationFailure
                ? 'ok'
                : (state.integrationSnapshot ? 'degraded' : 'unavailable'),
            credentialFile: state.securitySnapshot
                ? 'ok'
                : (securityFields.credentialFile ? 'unavailable' : (state.securityFailure ? 'blocked' : 'unavailable')),
            pepperKeyring: state.securitySnapshot
                ? 'ok'
                : (securityFields.pepperKeyring ? 'unavailable' : (state.securityFailure ? 'blocked' : 'unavailable')),
            authorizationPolicy: state.securitySnapshot
                ? 'ok'
                : (securityFields.authorizationPolicy ? 'unavailable' : (state.securityFailure ? 'blocked' : 'unavailable'))
        });
    }

    async function refreshAll() {
        await refreshIntegrationSnapshot();
        await refreshSecuritySnapshot();
        return {
            integration: buildIntegrationStatus(),
            security: buildSecurityStatus(),
            health: getHealthDomains()
        };
    }

    return Object.freeze({
        refreshAll,
        refreshIntegrationSnapshot,
        refreshSecuritySnapshot,
        getIntegrationStatus: buildIntegrationStatus,
        getSecurityStatus: buildSecurityStatus,
        getHealthDomains,
        getRecoveryEvents: () => [...state.recoveryEvents]
    });
}

module.exports = { computeSnapshotRevision, createIntegrationSnapshotCoordinator };
