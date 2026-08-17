'use strict';

/**
 * Agent Gateway 凭据管理领域服务。
 * 设计：docs/agent-integration/08-adminpanel-agent-credential-manager.md §4.2。
 *
 * 与 scripts/agent-gateway-credential-cli.js 语义逐条对齐：
 * - CSPRNG 32B base64url token，只随 create/rotate 结果出现一次；
 * - 文件只保存 HMAC-SHA256(pepper, token) digest；
 * - rotate = 旧记录转 rotating（必须显式 expiresAt）+ 新 credentialId 新 token；
 * - revoke = status -> revoked（幂等）。
 *
 * 超出 CLI 的保证：写前 .bak 备份、写后重读校验失败自动回滚（credentialResolver
 * 对坏文件 fail-closed，等价全局 401，必须自动恢复）、进程内写互斥、审计事件。
 * 审计只含 credentialId / 动作 / 绑定 agent；token 字段由 auditLogger 脱敏兜底。
 *
 * tombstone 约束（policy/credentialResolver.js）：同 credentialId 换 digest 会让
 * 本进程快照 fail-closed，因此本服务拒绝任何形式的 credentialId 复用（含已吊销）。
 */

const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');

const {
    parseCredentialFileConfig,
    parsePepperKeyringConfig
} = require('../policy/credentialConfigSchema');
const {
    computeTokenDigest,
    computeCredentialRecordRevision
} = require('../policy/credentialResolver');
const { createAuditLogger } = require('../infra/auditLogger');

const CREDENTIAL_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;
const BOUND_SCOPES = Object.freeze(['gateway:read', 'gateway:execute']);
const TOKEN_BYTES = 32; // 256 bit
const DIGEST_PREFIX = 'hmac-sha256:';

function adminError(code, status, message, details = undefined) {
    const error = new Error(message);
    error.code = code;
    error.status = status;
    if (details !== undefined) {
        error.details = details;
    }
    return error;
}

function toCredentialView(record) {
    const view = {
        credentialId: record.credentialId,
        pepperKid: record.pepperKid,
        boundAgentId: record.boundAgentId || null,
        scopes: [...record.scopes],
        status: record.status,
        expiresAt: record.expiresAt || null,
        credentialRevision: computeCredentialRecordRevision(record)
    };
    if (Array.isArray(record.allowedAgents)) {
        view.allowedAgents = [...record.allowedAgents];
    }
    return view;
}

function suggestCredentialId(boundAgentId) {
    const date = new Date();
    const month = `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
    const base = String(boundAgentId || 'agent')
        .toLowerCase()
        .replace(/[^a-z0-9-]+/g, '-')
        .replace(/-+/g, '-')
        .slice(0, 40)
        .replace(/^-+|-+$/g, '') || 'agent';
    return `${base}-ext-${month}`;
}

function createCredentialAdminService({
    credentialsPath = '',
    pepperKeyringPath = '',
    activePepperKid = '',
    listAgentIds = null,
    logger = console,
    auditLogger = createAuditLogger({ prefix: '[AgentGatewayCredentialAdmin]' })
} = {}) {
    const resolvedCredentialsPath = typeof credentialsPath === 'string' ? credentialsPath.trim() : '';
    const resolvedPepperPath = typeof pepperKeyringPath === 'string' ? pepperKeyringPath.trim() : '';
    const resolvedActiveKid = typeof activePepperKid === 'string' ? activePepperKid.trim() : '';

    let writeChain = Promise.resolve();

    // 串行化全部写操作：管理员双开页面 / 连点不会交错读-改-写
    function withWriteLock(task) {
        const run = writeChain.then(task, task);
        writeChain = run.then(() => undefined, () => undefined);
        return run;
    }

    async function readRawFile(filePath) {
        try {
            return await fs.readFile(filePath, 'utf8');
        } catch (error) {
            if (error && error.code === 'ENOENT') {
                return null;
            }
            throw adminError('FILE_UNREADABLE', 500, `无法读取 ${path.basename(filePath)}：${error.message}`);
        }
    }

    async function loadCredentialFile() {
        if (!resolvedCredentialsPath) {
            throw adminError('NOT_CONFIGURED', 503,
                'AGENT_GATEWAY_CREDENTIALS_PATH 未配置；请先在 config.env 中设置后再执行凭据管理操作');
        }
        const raw = await readRawFile(resolvedCredentialsPath);
        if (raw === null) {
            return { version: 1, credentials: [] };
        }
        const parsed = parseCredentialFileConfig(raw);
        if (!parsed.valid) {
            throw adminError('FILE_INVALID', 503,
                '现有凭据文件校验失败，拒绝写入以避免破坏 fail-closed 快照', { errors: parsed.errors });
        }
        return { version: 1, credentials: parsed.config.credentials.map((record) => ({ ...record })) };
    }

    async function loadKeyring() {
        if (!resolvedPepperPath) {
            throw adminError('NOT_CONFIGURED', 503, 'AGENT_GATEWAY_CREDENTIAL_PEPPERS_PATH 未配置');
        }
        const raw = await readRawFile(resolvedPepperPath);
        if (raw === null) {
            throw adminError('KEYRING_MISSING', 503, 'pepper keyring 文件不存在；请先按上线手册生成（本服务与 CLI 均不代建）');
        }
        const parsed = parsePepperKeyringConfig(raw);
        if (!parsed.valid) {
            throw adminError('KEYRING_INVALID', 503, 'pepper keyring 校验失败', { errors: parsed.errors });
        }
        return parsed.config;
    }

    function resolveKid(keyring) {
        if (resolvedActiveKid && keyring.keys[resolvedActiveKid]) {
            return resolvedActiveKid;
        }
        const availableKids = Object.keys(keyring.keys).sort();
        if (!resolvedActiveKid) {
            throw adminError('KID_UNRESOLVED', 503,
                '未设置活跃 pepper kid（AGENT_GATEWAY_CREDENTIAL_ACTIVE_PEPPER_KID）', { availableKids });
        }
        throw adminError('KID_UNKNOWN', 503,
            `活跃 pepper kid "${resolvedActiveKid}" 不在 keyring 中`, { availableKids });
    }

    /**
     * 原子持久化 + 写后重读校验 + 失败回滚。
     * 成功路径不残留 .tmp / .bak。
     */
    async function persist(nextFile) {
        await fs.mkdir(path.dirname(resolvedCredentialsPath), { recursive: true });
        const backupPath = `${resolvedCredentialsPath}.bak`;
        const tmpPath = `${resolvedCredentialsPath}.tmp-${process.pid}`;
        const rawCurrent = await readRawFile(resolvedCredentialsPath);
        if (rawCurrent !== null) {
            await fs.writeFile(backupPath, rawCurrent, { encoding: 'utf8', mode: 0o600 });
        }
        const body = `${JSON.stringify(nextFile, null, 2)}\n`;
        const handle = await fs.open(tmpPath, 'w', 0o600);
        try {
            await fs.writeFile(handle, body, 'utf8');
            await handle.sync();
        } finally {
            await handle.close();
        }
        await fs.rename(tmpPath, resolvedCredentialsPath);

        const verifyRaw = await readRawFile(resolvedCredentialsPath);
        const verified = verifyRaw === null ? null : parseCredentialFileConfig(verifyRaw);
        if (!verified || !verified.valid) {
            logger.error('[credentialAdminService] 写后校验失败，回滚凭据文件');
            if (rawCurrent !== null) {
                await fs.rename(backupPath, resolvedCredentialsPath);
            } else {
                await fs.unlink(resolvedCredentialsPath).catch(() => undefined);
            }
            throw adminError('PERSIST_VERIFY_FAILED', 500,
                '凭据文件写后校验失败，已回滚到写入前状态', {
                    errors: verified ? verified.errors : ['file missing after write']
                });
        }
        await fs.unlink(backupPath).catch(() => undefined);
        return verified.config.credentials;
    }

    function assertCredentialId(credentialId) {
        if (typeof credentialId !== 'string' || !CREDENTIAL_ID_PATTERN.test(credentialId)) {
            throw adminError('INVALID_CREDENTIAL_ID', 400,
                `credentialId "${credentialId}" 必须匹配 ^[a-z0-9][a-z0-9-]{0,63}$`);
        }
    }

    function normalizeExpiry(rawValue, field) {
        if (rawValue === undefined || rawValue === null || rawValue === '') {
            return null;
        }
        if (typeof rawValue !== 'string' || Number.isNaN(Date.parse(rawValue))) {
            throw adminError('INVALID_EXPIRY', 400, `${field} 必须是合法的 ISO-8601 时间字符串`);
        }
        return new Date(Date.parse(rawValue)).toISOString();
    }

    function assertFutureExpiry(expiresAt, field) {
        if (Date.parse(expiresAt) <= Date.now()) {
            throw adminError('INVALID_EXPIRY', 400, `${field} 必须晚于当前时间`);
        }
    }

    function normalizeBoundScopes(rawScopes) {
        if (!Array.isArray(rawScopes) || rawScopes.length === 0) {
            throw adminError('INVALID_SCOPES', 400, 'scopes 必须是非空数组');
        }
        const scopes = [];
        for (const item of rawScopes) {
            if (typeof item !== 'string' || !BOUND_SCOPES.includes(item)) {
                throw adminError('INVALID_SCOPES', 400,
                    `scope 仅支持 ${BOUND_SCOPES.join(' / ')}；admin 级凭据请使用 CLI 通道（§3.2）`);
            }
            if (!scopes.includes(item)) {
                scopes.push(item);
            }
        }
        return scopes;
    }

    async function assertKnownAgent(boundAgentId) {
        if (typeof listAgentIds !== 'function') {
            return;
        }
        let agentIds;
        try {
            agentIds = await listAgentIds();
        } catch (error) {
            throw adminError('AGENT_REGISTRY_UNAVAILABLE', 500, `无法读取 agent 清单：${error.message}`);
        }
        if (!Array.isArray(agentIds) || !agentIds.includes(boundAgentId)) {
            throw adminError('UNKNOWN_AGENT', 400, `boundAgentId "${boundAgentId}" 不在 agent 清单中`);
        }
    }

    function mintRecord({ kid, keyring, credentialId, boundAgentId, scopes, expiresAt, allowedAgents }) {
        const token = crypto.randomBytes(TOKEN_BYTES).toString('base64url');
        const digest = computeTokenDigest(keyring.keys[kid], token);
        const record = {
            credentialId,
            pepperKid: kid,
            tokenDigest: `${DIGEST_PREFIX}${digest}`,
            boundAgentId,
            scopes,
            status: 'active',
            expiresAt
        };
        if (!boundAgentId && Array.isArray(allowedAgents) && allowedAgents.length > 0) {
            record.allowedAgents = [...allowedAgents];
        }
        return { record, token };
    }

    /**
     * 解析写入用的 credentialId：用户显式指定的原样返回（由调用方做 409 冲突检查）；
     * 自动命名撞名时追加 -r2/-r3… 序号（同月内多次轮换的常见场景）。
     */
    function resolveAutoCredentialId(file, baseAgentId) {
        const base = suggestCredentialId(baseAgentId);
        const exists = (candidate) => file.credentials.some((item) => item.credentialId === candidate);
        if (!exists(base)) {
            return base;
        }
        for (let index = 2; index < 100; index += 1) {
            const candidate = `${base}-r${index}`;
            if (candidate.length <= 64 && !exists(candidate)) {
                return candidate;
            }
        }
        throw adminError('CREDENTIAL_ID_CONFLICT', 409,
            `无法为 "${baseAgentId}" 自动生成不冲突的 credentialId，请手工指定`);
    }

    async function getStatus() {
        const status = {
            configured: Boolean(resolvedCredentialsPath),
            credentialsPath: resolvedCredentialsPath || null,
            pepperKeyringPath: resolvedPepperPath || null,
            activeKid: resolvedActiveKid || null,
            activeKidMissing: false,
            pepperKids: [],
            snapshotAvailable: true,
            snapshotReasons: [],
            total: 0,
            statusCounts: {}
        };

        if (resolvedPepperPath) {
            try {
                const raw = await readRawFile(resolvedPepperPath);
                if (raw === null) {
                    status.snapshotAvailable = false;
                    status.snapshotReasons.push({ field: 'pepperKeyring', reason: 'keyring file not found' });
                } else {
                    const parsed = parsePepperKeyringConfig(raw);
                    if (!parsed.valid) {
                        status.snapshotAvailable = false;
                        status.snapshotReasons.push({ field: 'pepperKeyring', reason: 'validation failed', errors: parsed.errors });
                    } else {
                        status.pepperKids = Object.keys(parsed.config.keys).sort();
                    }
                }
            } catch (error) {
                status.snapshotAvailable = false;
                status.snapshotReasons.push({ field: 'pepperKeyring', reason: error.message });
            }
        } else {
            status.snapshotReasons.push({ field: 'pepperKeyring', reason: 'AGENT_GATEWAY_CREDENTIAL_PEPPERS_PATH not set' });
        }
        status.activeKidMissing = status.pepperKids.length > 0 && !status.pepperKids.includes(resolvedActiveKid);

        if (resolvedCredentialsPath) {
            try {
                const raw = await readRawFile(resolvedCredentialsPath);
                if (raw !== null) {
                    const parsed = parseCredentialFileConfig(raw);
                    if (!parsed.valid) {
                        status.snapshotAvailable = false;
                        status.snapshotReasons.push({ field: 'credentialFile', reason: 'validation failed', errors: parsed.errors });
                    } else {
                        status.total = parsed.config.credentials.length;
                        for (const record of parsed.config.credentials) {
                            status.statusCounts[record.status] = (status.statusCounts[record.status] || 0) + 1;
                        }
                    }
                }
            } catch (error) {
                status.snapshotAvailable = false;
                status.snapshotReasons.push({ field: 'credentialFile', reason: error.message });
            }
        }
        return status;
    }

    async function listCredentials({ status: statusFilter, boundAgentId: agentFilter } = {}) {
        if (!resolvedCredentialsPath) {
            return [];
        }
        const file = await loadCredentialFile().catch((error) => {
            if (error.code === 'NOT_CONFIGURED') {
                return { version: 1, credentials: [] };
            }
            throw error;
        });
        return file.credentials
            .filter((record) => (statusFilter ? record.status === statusFilter : true))
            .filter((record) => (agentFilter ? record.boundAgentId === agentFilter : true))
            .map(toCredentialView);
    }

    async function createCredential(input) {
        const boundAgentId = typeof input?.boundAgentId === 'string' ? input.boundAgentId.trim() : '';
        if (!boundAgentId) {
            throw adminError('INVALID_AGENT', 400, 'boundAgentId 必填（本管理面仅铸造绑定 agent 的凭据）');
        }
        await assertKnownAgent(boundAgentId);
        const scopes = normalizeBoundScopes(input?.scopes);
        const expiresAt = normalizeExpiry(input?.expiresAt, 'expiresAt');
        if (expiresAt) {
            assertFutureExpiry(expiresAt, 'expiresAt');
        }
        const requestedId = typeof input?.credentialId === 'string' ? input.credentialId.trim() : '';
        if (requestedId) {
            assertCredentialId(requestedId);
        }

        return withWriteLock(async () => {
            const [file, keyring] = await Promise.all([loadCredentialFile(), loadKeyring()]);
            const credentialId = requestedId
                ? requestedId
                : resolveAutoCredentialId(file, boundAgentId);
            if (requestedId && file.credentials.some((record) => record.credentialId === credentialId)) {
                throw adminError('CREDENTIAL_ID_CONFLICT', 409,
                    `credentialId "${credentialId}" 已存在；轮换语义要求新凭据使用新的 credentialId`,
                    { credentialId });
            }
            const kid = resolveKid(keyring);
            const { record, token } = mintRecord({ kid, keyring, credentialId, boundAgentId, scopes, expiresAt });
            file.credentials.push(record);
            const saved = await persist(file);
            const savedRecord = saved.find((item) => item.credentialId === credentialId) || record;
            auditLogger.log('credential.create', {
                credentialId, boundAgentId, scopes, expiresAt, pepperKid: kid
            });
            return { credential: toCredentialView(savedRecord), token };
        });
    }

    async function rotateCredential({ credentialId, newCredentialId, oldExpiresAt, expiresAt }) {
        const normalizedOldId = typeof credentialId === 'string' ? credentialId.trim() : '';
        if (!normalizedOldId) {
            throw adminError('INVALID_CREDENTIAL_ID', 400, 'credentialId 必填');
        }
        const oldExpiry = normalizeExpiry(oldExpiresAt, 'oldExpiresAt');
        if (!oldExpiry) {
            throw adminError('INVALID_EXPIRY', 400, 'rotate 必须提供 oldExpiresAt（旧凭据的明确到期时间）');
        }
        assertFutureExpiry(oldExpiry, 'oldExpiresAt');
        const newExpiry = normalizeExpiry(expiresAt, 'expiresAt');
        if (newExpiry) {
            assertFutureExpiry(newExpiry, 'expiresAt');
        }
        const requestedNewId = typeof newCredentialId === 'string' ? newCredentialId.trim() : '';
        if (requestedNewId) {
            assertCredentialId(requestedNewId);
        }

        return withWriteLock(async () => {
            const [file, keyring] = await Promise.all([loadCredentialFile(), loadKeyring()]);
            const oldRecord = file.credentials.find((item) => item.credentialId === normalizedOldId);
            if (!oldRecord) {
                throw adminError('NOT_FOUND', 404, `credentialId "${normalizedOldId}" 不存在`);
            }
            if (oldRecord.status === 'revoked') {
                throw adminError('INVALID_STATE', 409,
                    `凭据 "${normalizedOldId}" 已吊销，不能轮换；请直接铸造新凭据`);
            }
            const newId = requestedNewId
                ? requestedNewId
                : resolveAutoCredentialId(file, oldRecord.boundAgentId);
            if (newId === normalizedOldId
                || (requestedNewId && file.credentials.some((item) => item.credentialId === newId))) {
                throw adminError('CREDENTIAL_ID_CONFLICT', 409, `credentialId "${newId}" 已存在`);
            }

            const previous = toCredentialView(oldRecord);
            oldRecord.status = 'rotating';
            oldRecord.expiresAt = oldExpiry;
            const kid = resolveKid(keyring);
            const { record, token } = mintRecord({
                kid,
                keyring,
                credentialId: newId,
                boundAgentId: oldRecord.boundAgentId,
                scopes: oldRecord.scopes,
                expiresAt: newExpiry,
                allowedAgents: oldRecord.allowedAgents
            });
            file.credentials.push(record);
            const saved = await persist(file);
            auditLogger.log('credential.rotate', {
                credentialId: newId,
                previousCredentialId: normalizedOldId,
                boundAgentId: oldRecord.boundAgentId,
                rotatingUntil: oldExpiry
            });
            return {
                previous: { ...previous, status: 'rotating', expiresAt: oldExpiry },
                credential: toCredentialView(saved.find((item) => item.credentialId === newId) || record),
                token
            };
        });
    }

    async function revokeCredential({ credentialId }) {
        const normalizedId = typeof credentialId === 'string' ? credentialId.trim() : '';
        if (!normalizedId) {
            throw adminError('INVALID_CREDENTIAL_ID', 400, 'credentialId 必填');
        }
        return withWriteLock(async () => {
            const file = await loadCredentialFile();
            const record = file.credentials.find((item) => item.credentialId === normalizedId);
            if (!record) {
                throw adminError('NOT_FOUND', 404, `credentialId "${normalizedId}" 不存在`);
            }
            if (record.status !== 'revoked') {
                record.status = 'revoked';
                await persist(file);
                auditLogger.log('credential.revoke', {
                    credentialId: normalizedId, boundAgentId: record.boundAgentId
                });
            }
            return { credential: toCredentialView(record) };
        });
    }

    return Object.freeze({
        getStatus,
        listCredentials,
        createCredential,
        rotateCredential,
        revokeCredential
    });
}

module.exports = {
    BOUND_SCOPES,
    CREDENTIAL_ID_PATTERN,
    createCredentialAdminService,
    suggestCredentialId
};
