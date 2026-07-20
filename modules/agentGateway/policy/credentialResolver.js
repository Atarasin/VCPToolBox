const crypto = require('crypto');
const fs = require('fs/promises');

const {
    parseCredentialFileConfig,
    parsePepperKeyringConfig
} = require('./credentialConfigSchema');
const { crossValidateCredentialPepperKids } = require('./integrationCrossChecks');
const { normalizeString } = require('./shared/normalize');

/**
 * Content-hash credential resolver（§3.6 / §4.4 / M1.S1）。
 *
 * - 每次授权读取都对 credential 文件与 pepper keyring 的原始字节计算
 *   SHA-256；两者 content hash 均相同才复用已解析安全快照。mtime/size 仅
 *   作诊断字段。
 * - 全异步 I/O（请求路径禁止同步文件读取阻塞事件循环）；并发请求共享同一次
 *   in-flight 读取（promise coalescing），不引入任何时间窗缓存。
 * - presented token 有长度上限，digest 恒时比较，命中且仅命中一条记录；
 *   跨 kid 重复 token 在认证时发现并拒绝（fail-closed）。
 * - 状态机 active/rotating/revoked/expired；进程内 tombstone 尽早发现
 *   credentialId 换 digest 重用（正式防继承由 owner revision 承担）。
 * - 阶段 A 特例：credentials path 未设置 → 有效空 snapshot + migration
 *   warning；已设置但不可读 → fail-closed。
 */

const MAX_PRESENTED_TOKEN_LENGTH = 512;

function sha256Hex(buffer) {
    return crypto.createHash('sha256').update(buffer).digest('hex');
}

function computeTokenDigest(pepperSecret, token) {
    return crypto.createHmac('sha256', pepperSecret).update(token, 'utf8').digest('hex');
}

/**
 * 单条 credential 记录的 canonical revision（§3.4 owner 语义单源）。
 * `statusOverride` 供 owner revision compatibility 使用：同 token digest 的
 * `active -> rotating` 过渡按 record 在 active 状态下的 revision 比较。
 */
function computeCredentialRecordRevision(record, statusOverride = null) {
    return `sha256:${sha256Hex(Buffer.from(JSON.stringify({
        credentialId: record.credentialId,
        tokenDigest: record.tokenDigest,
        boundAgentId: record.boundAgentId,
        allowedAgents: record.allowedAgents || null,
        scopes: record.scopes,
        status: statusOverride || record.status,
        expiresAt: record.expiresAt
    }), 'utf8'))}`;
}

function constantTimeEqualHex(leftHex, rightHex) {
    const left = Buffer.from(leftHex, 'hex');
    const right = Buffer.from(rightHex, 'hex');
    if (left.length !== right.length) {
        return false;
    }
    return crypto.timingSafeEqual(left, right);
}

function createCredentialResolver({
    credentialsPath,
    pepperKeyringPath,
    legacyCredentialEnabled = true,
    allowLegacyScopeNames = true,
    now = () => Date.now(),
    logger = console
} = {}) {
    const state = {
        // 解析快照缓存：仅当两个 content hash 均未变化时复用
        cache: null,
        // in-flight 读取合并
        inFlight: null,
        // credentialId -> tokenDigest tombstone（进程内尽早报错机制）
        tombstones: new Map(),
        migrationWarningLogged: false
    };

    async function readCandidate(filePath) {
        const normalizedPath = normalizeString(filePath);
        if (!normalizedPath) {
            return { configured: false, bytes: null, contentHash: null, error: null };
        }
        try {
            const bytes = await fs.readFile(normalizedPath);
            return { configured: true, bytes, contentHash: sha256Hex(bytes), error: null };
        } catch (error) {
            return { configured: true, bytes: null, contentHash: null, error };
        }
    }

    function unavailableSnapshot(reasons) {
        return Object.freeze({
            available: false,
            reasons,
            revision: null,
            records: Object.freeze([]),
            recordsByKid: new Map(),
            pepperKeys: Object.freeze({})
        });
    }

    function buildSnapshot(credentialCandidate, keyringCandidate) {
        // 阶段 A 特例：path 未配置。
        if (!credentialCandidate.configured) {
            if (!legacyCredentialEnabled) {
                return unavailableSnapshot([{
                    field: 'credentialFile',
                    reason: 'AGENT_GATEWAY_CREDENTIALS_PATH is required once legacy credentials are disabled'
                }]);
            }
            if (!state.migrationWarningLogged) {
                state.migrationWarningLogged = true;
                logger.warn?.('[credentialResolver] AGENT_GATEWAY_CREDENTIALS_PATH not set; using empty credential snapshot (migration phase A)');
            }
            return Object.freeze({
                available: true,
                migrationWarning: 'no credential file configured',
                revision: 'sha256:empty-credential-snapshot',
                records: Object.freeze([]),
                recordsByKid: new Map(),
                pepperKeys: Object.freeze({}),
                contentHashes: Object.freeze({ credentials: null, pepperKeyring: null })
            });
        }

        const reasons = [];
        if (credentialCandidate.error || credentialCandidate.bytes === null) {
            reasons.push({ field: 'credentialFile', reason: `unreadable: ${credentialCandidate.error?.message}` });
            return unavailableSnapshot(reasons);
        }

        const credentialParsed = parseCredentialFileConfig(
            credentialCandidate.bytes.toString('utf8'),
            { allowLegacyScopeNames }
        );
        if (!credentialParsed.valid) {
            reasons.push({ field: 'credentialFile', reason: 'validation failed', errors: credentialParsed.errors });
            return unavailableSnapshot(reasons);
        }

        const hasRecords = credentialParsed.config.credentials.length > 0;
        let keyringParsed = null;
        if (!keyringCandidate.configured) {
            if (hasRecords) {
                reasons.push({ field: 'pepperKeyring', reason: 'AGENT_GATEWAY_CREDENTIAL_PEPPERS_PATH is required when credential records exist' });
            }
        } else if (keyringCandidate.error || keyringCandidate.bytes === null) {
            reasons.push({ field: 'pepperKeyring', reason: `unreadable: ${keyringCandidate.error?.message}` });
        } else {
            keyringParsed = parsePepperKeyringConfig(keyringCandidate.bytes.toString('utf8'));
            if (!keyringParsed.valid) {
                reasons.push({ field: 'pepperKeyring', reason: 'validation failed', errors: keyringParsed.errors });
            }
        }

        if (reasons.length === 0 && hasRecords && keyringParsed?.valid) {
            const crossErrors = crossValidateCredentialPepperKids(credentialParsed.config, keyringParsed.config);
            if (crossErrors.length > 0) {
                reasons.push({ field: 'credentialFile', reason: 'cross-reference validation failed', errors: crossErrors });
            }
        }
        if (reasons.length > 0) {
            return unavailableSnapshot(reasons);
        }

        // tombstone 检查：同 credentialId 换 digest 属重用，进程内尽早拒绝。
        for (const record of credentialParsed.config.credentials) {
            const tombstoneDigest = state.tombstones.get(record.credentialId);
            if (tombstoneDigest && tombstoneDigest !== record.tokenDigest) {
                return unavailableSnapshot([{
                    field: 'credentialFile',
                    reason: `credentialId "${record.credentialId}" reused with a different tokenDigest (tombstoned in this process)`
                }]);
            }
        }
        for (const record of credentialParsed.config.credentials) {
            state.tombstones.set(record.credentialId, record.tokenDigest);
        }

        const recordsByKid = new Map();
        for (const record of credentialParsed.config.credentials) {
            if (!recordsByKid.has(record.pepperKid)) {
                recordsByKid.set(record.pepperKid, []);
            }
            recordsByKid.get(record.pepperKid).push(record);
        }

        return Object.freeze({
            available: true,
            revision: `sha256:${sha256Hex(Buffer.from(
                `${credentialCandidate.contentHash}|${keyringCandidate.contentHash || 'none'}`, 'utf8'
            ))}`,
            records: credentialParsed.config.credentials,
            recordsByKid,
            pepperKeys: keyringParsed ? keyringParsed.config.keys : Object.freeze({}),
            warnings: credentialParsed.warnings,
            contentHashes: Object.freeze({
                credentials: credentialCandidate.contentHash,
                pepperKeyring: keyringCandidate.contentHash || null
            })
        });
    }

    /**
     * 读取当前安全快照。每次调用都重读两个文件的内容 hash；
     * 并发调用共享同一次 in-flight 读取。
     */
    function getSnapshot() {
        if (state.inFlight) {
            return state.inFlight;
        }
        state.inFlight = (async () => {
            try {
                const [credentialCandidate, keyringCandidate] = await Promise.all([
                    readCandidate(credentialsPath),
                    readCandidate(pepperKeyringPath)
                ]);
                const cached = state.cache;
                if (
                    cached &&
                    cached.credentialHash === credentialCandidate.contentHash &&
                    cached.keyringHash === keyringCandidate.contentHash &&
                    cached.credentialConfigured === credentialCandidate.configured &&
                    cached.keyringConfigured === keyringCandidate.configured
                ) {
                    return cached.snapshot;
                }
                const snapshot = buildSnapshot(credentialCandidate, keyringCandidate);
                state.cache = {
                    credentialHash: credentialCandidate.contentHash,
                    keyringHash: keyringCandidate.contentHash,
                    credentialConfigured: credentialCandidate.configured,
                    keyringConfigured: keyringCandidate.configured,
                    snapshot
                };
                return snapshot;
            } finally {
                state.inFlight = null;
            }
        })();
        return state.inFlight;
    }

    function isRecordExpired(record, timestamp) {
        return Boolean(record.expiresAt) && Date.parse(record.expiresAt) <= timestamp;
    }

    /**
     * 认证 presented token。
     * @returns {{ ok: boolean, code?: string, reason?: string, record?, revision?, snapshot? }}
     */
    async function authenticate(presentedToken) {
        const snapshot = await getSnapshot();
        if (!snapshot.available) {
            return { ok: false, code: 'AGW_CONFIG_UNAVAILABLE', reason: 'security snapshot unavailable', reasons: snapshot.reasons };
        }

        const token = typeof presentedToken === 'string' ? presentedToken : '';
        if (!token) {
            return { ok: false, code: 'AGW_UNAUTHORIZED', reason: 'no token presented' };
        }
        if (token.length > MAX_PRESENTED_TOKEN_LENGTH) {
            return { ok: false, code: 'AGW_UNAUTHORIZED', reason: 'presented token exceeds length limit' };
        }

        const matches = [];
        for (const [kid, records] of snapshot.recordsByKid.entries()) {
            const pepperSecret = snapshot.pepperKeys[kid];
            if (!pepperSecret) {
                continue;
            }
            const digestHex = computeTokenDigest(pepperSecret, token);
            for (const record of records) {
                const recordDigestHex = record.tokenDigest.slice('hmac-sha256:'.length);
                if (constantTimeEqualHex(digestHex, recordDigestHex)) {
                    matches.push(record);
                }
            }
        }

        if (matches.length === 0) {
            return { ok: false, code: 'AGW_UNAUTHORIZED', reason: 'unknown token' };
        }
        if (matches.length > 1) {
            // 跨 kid 重复 token：只能在认证时发现，一律拒绝并要求审计。
            logger.error?.('[credentialResolver] presented token matches multiple credential records; rejecting (fail-closed)');
            return { ok: false, code: 'AGW_UNAUTHORIZED', reason: 'token matches multiple records', audit: 'token-collision' };
        }

        const record = matches[0];
        const timestamp = now();
        if (record.status === 'revoked') {
            return { ok: false, code: 'AGW_UNAUTHORIZED', reason: 'credential revoked', credentialId: record.credentialId };
        }
        if (record.status === 'expired' || isRecordExpired(record, timestamp)) {
            return { ok: false, code: 'AGW_UNAUTHORIZED', reason: 'credential expired', credentialId: record.credentialId };
        }
        if (record.status !== 'active' && record.status !== 'rotating') {
            return { ok: false, code: 'AGW_UNAUTHORIZED', reason: `credential status "${record.status}" not usable`, credentialId: record.credentialId };
        }

        return {
            ok: true,
            record,
            credentialId: record.credentialId,
            credentialSubject: record.credentialId,
            credentialRevision: computeCredentialRecordRevision(record),
            snapshotRevision: snapshot.revision,
            snapshot
        };
    }

    /**
     * 按 credentialId 查当前记录状态（WS/SSE 周期重校验用）。
     */
    async function checkCredentialStatus(credentialId) {
        const snapshot = await getSnapshot();
        if (!snapshot.available) {
            return { ok: false, code: 'AGW_CONFIG_UNAVAILABLE' };
        }
        const record = snapshot.records.find((item) => item.credentialId === credentialId);
        if (!record) {
            return { ok: false, code: 'AGW_UNAUTHORIZED', reason: 'credential no longer present' };
        }
        const timestamp = now();
        if (record.status === 'revoked' || record.status === 'expired' || isRecordExpired(record, timestamp)) {
            return { ok: false, code: 'AGW_UNAUTHORIZED', reason: `credential ${record.status}` };
        }
        return {
            ok: true,
            record,
            credentialRevision: computeCredentialRecordRevision(record),
            // §3.4 owner revision compatibility：仅同 token digest 的
            // active -> rotating 过渡可继承——rotating 记录以 active 状态
            // 重算的 revision 与旧 owner revision 相等即为该过渡。
            rotationCompatibleRevision: record.status === 'rotating'
                ? computeCredentialRecordRevision(record, 'active')
                : null
        };
    }

    return Object.freeze({
        MAX_PRESENTED_TOKEN_LENGTH,
        authenticate,
        checkCredentialStatus,
        getSnapshot
    });
}

module.exports = {
    MAX_PRESENTED_TOKEN_LENGTH,
    computeCredentialRecordRevision,
    computeTokenDigest,
    createCredentialResolver
};
