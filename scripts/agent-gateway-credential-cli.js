#!/usr/bin/env node

'use strict';

/**
 * Agent Gateway credential 生成/轮换 CLI（§4.4 / M1.S1.T4）。
 *
 * - CSPRNG 生成 ≥256 bit token，只打印一次，文件中仅保存 HMAC digest。
 * - `AGENT_GATEWAY_CREDENTIAL_ACTIVE_PEPPER_KID` 仅供本 CLI 选择当前 kid；
 *   运行时验证以记录自身的 pepperKid 为准。
 * - 轮换 = 旧记录转 rotating（要求明确 expiresAt）+ 新 credentialId 新 token。
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const {
    computeTokenDigest
} = require('../modules/agentGateway/policy/credentialResolver');
const {
    parseCredentialFileConfig,
    parsePepperKeyringConfig
} = require('../modules/agentGateway/policy/credentialConfigSchema');

function printUsage() {
    process.stdout.write(`Agent Gateway credential CLI

Usage:
  node scripts/agent-gateway-credential-cli.js create --credentials <path> --peppers <path> \\
      --credential-id <id> [--bound-agent <agentId>] [--allowed-agents a,b] \\
      [--scopes gateway:read,gateway:execute] [--expires-at <iso>] [--kid <kid>]
  node scripts/agent-gateway-credential-cli.js rotate --credentials <path> --peppers <path> \\
      --credential-id <oldId> --new-credential-id <newId> --old-expires-at <iso> [--kid <kid>]
  node scripts/agent-gateway-credential-cli.js revoke --credentials <path> --credential-id <id>

Environment:
  AGENT_GATEWAY_CREDENTIAL_ACTIVE_PEPPER_KID  Default kid when --kid is omitted
`);
}

function parseArgs(argv) {
    const args = { _: [] };
    for (let index = 0; index < argv.length; index += 1) {
        const arg = argv[index];
        if (arg.startsWith('--')) {
            const key = arg.slice(2);
            const next = argv[index + 1];
            if (next === undefined || next.startsWith('--')) {
                args[key] = true;
            } else {
                args[key] = next;
                index += 1;
            }
        } else {
            args._.push(arg);
        }
    }
    return args;
}

function fail(message) {
    process.stderr.write(`[credential-cli] ${message}\n`);
    process.exit(1);
}

function loadCredentialFile(filePath) {
    if (!fs.existsSync(filePath)) {
        return { version: 1, credentials: [] };
    }
    const parsed = parseCredentialFileConfig(fs.readFileSync(filePath, 'utf8'));
    if (!parsed.valid) {
        fail(`existing credential file is invalid: ${JSON.stringify(parsed.errors)}`);
    }
    // 保留原始记录（parse 会规范化 expiresAt；对 CLI 写回可接受）
    return { version: 1, credentials: parsed.config.credentials.map((record) => ({ ...record })) };
}

function loadKeyring(filePath) {
    if (!fs.existsSync(filePath)) {
        fail(`pepper keyring not found at ${filePath}`);
    }
    const parsed = parsePepperKeyringConfig(fs.readFileSync(filePath, 'utf8'));
    if (!parsed.valid) {
        fail(`pepper keyring is invalid: ${JSON.stringify(parsed.errors)}`);
    }
    return parsed.config;
}

function resolveKid(args, keyring) {
    const kid = args.kid || process.env.AGENT_GATEWAY_CREDENTIAL_ACTIVE_PEPPER_KID || '';
    if (!kid) {
        fail('no pepper kid: pass --kid or set AGENT_GATEWAY_CREDENTIAL_ACTIVE_PEPPER_KID');
    }
    if (!keyring.keys[kid]) {
        fail(`kid "${kid}" not present in pepper keyring`);
    }
    return kid;
}

function generateToken() {
    // 32 bytes = 256 bit，base64url 无填充
    return crypto.randomBytes(32).toString('base64url');
}

function writeCredentialFile(filePath, payload) {
    const tmpPath = `${filePath}.tmp-${process.pid}`;
    const body = `${JSON.stringify(payload, null, 2)}\n`;
    const handle = fs.openSync(tmpPath, 'w', 0o600);
    try {
        fs.writeFileSync(handle, body);
        fs.fsyncSync(handle);
    } finally {
        fs.closeSync(handle);
    }
    fs.renameSync(tmpPath, filePath);
}

function buildRecord({ args, kid, keyring, credentialId }) {
    const token = generateToken();
    const digest = computeTokenDigest(keyring.keys[kid], token);
    const scopes = String(args.scopes || 'gateway:read,gateway:execute').split(',').map((scope) => scope.trim()).filter(Boolean);
    const boundAgentId = args['bound-agent'] || null;
    if (scopes.includes('admin') && boundAgentId) {
        fail('"admin" scope is only allowed on unbound credentials (§3.2)');
    }
    const record = {
        credentialId,
        pepperKid: kid,
        tokenDigest: `hmac-sha256:${digest}`,
        boundAgentId,
        scopes,
        status: 'active',
        expiresAt: args['expires-at'] || null
    };
    if (!boundAgentId && args['allowed-agents']) {
        record.allowedAgents = String(args['allowed-agents']).split(',').map((agent) => agent.trim()).filter(Boolean);
    }
    return { record, token };
}

function main() {
    const [command, ...rest] = process.argv.slice(2);
    if (!command || command === '--help' || command === 'help') {
        printUsage();
        process.exit(command ? 0 : 1);
    }
    const args = parseArgs(rest);
    const credentialsPath = args.credentials && path.resolve(String(args.credentials));
    if (!credentialsPath) {
        fail('--credentials <path> is required');
    }

    if (command === 'create') {
        const keyring = loadKeyring(path.resolve(String(args.peppers || '')));
        const kid = resolveKid(args, keyring);
        const credentialId = String(args['credential-id'] || '');
        if (!credentialId) {
            fail('--credential-id is required');
        }
        const file = loadCredentialFile(credentialsPath);
        if (file.credentials.some((record) => record.credentialId === credentialId)) {
            fail(`credentialId "${credentialId}" already exists; rotation requires a new credentialId`);
        }
        const { record, token } = buildRecord({ args, kid, keyring, credentialId });
        file.credentials.push(record);
        writeCredentialFile(credentialsPath, file);
        process.stdout.write(`credentialId: ${credentialId}\ntoken: ${token}\n`);
        process.stdout.write('Store this token in a secure secret store now; it cannot be recovered.\n');
        return;
    }

    if (command === 'rotate') {
        const keyring = loadKeyring(path.resolve(String(args.peppers || '')));
        const kid = resolveKid(args, keyring);
        const oldId = String(args['credential-id'] || '');
        const newId = String(args['new-credential-id'] || '');
        const oldExpiresAt = String(args['old-expires-at'] || '');
        if (!oldId || !newId || !oldExpiresAt) {
            fail('rotate requires --credential-id, --new-credential-id and --old-expires-at');
        }
        const file = loadCredentialFile(credentialsPath);
        const oldRecord = file.credentials.find((record) => record.credentialId === oldId);
        if (!oldRecord) {
            fail(`credentialId "${oldId}" not found`);
        }
        if (file.credentials.some((record) => record.credentialId === newId)) {
            fail(`credentialId "${newId}" already exists`);
        }
        oldRecord.status = 'rotating';
        oldRecord.expiresAt = oldExpiresAt;
        const { record, token } = buildRecord({
            args: {
                ...args,
                'bound-agent': oldRecord.boundAgentId,
                'allowed-agents': oldRecord.allowedAgents ? oldRecord.allowedAgents.join(',') : undefined,
                scopes: oldRecord.scopes.join(',')
            },
            kid,
            keyring,
            credentialId: newId
        });
        file.credentials.push(record);
        writeCredentialFile(credentialsPath, file);
        process.stdout.write(`rotated: ${oldId} -> ${newId} (old record rotating until ${oldExpiresAt})\ntoken: ${token}\n`);
        return;
    }

    if (command === 'revoke') {
        const credentialId = String(args['credential-id'] || '');
        if (!credentialId) {
            fail('--credential-id is required');
        }
        const file = loadCredentialFile(credentialsPath);
        const record = file.credentials.find((item) => item.credentialId === credentialId);
        if (!record) {
            fail(`credentialId "${credentialId}" not found`);
        }
        record.status = 'revoked';
        writeCredentialFile(credentialsPath, file);
        process.stdout.write(`revoked: ${credentialId}\n`);
        return;
    }

    printUsage();
    process.exit(1);
}

main();
