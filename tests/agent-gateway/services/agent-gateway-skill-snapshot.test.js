'use strict';

/**
 * M4.S3 三格式验证（§6 / 05-testing-gates.md 第 10 条）。
 *
 * 三 agent × 三 format 的 snapshot、manifest 校验、secret scan。
 * 每个 artifact 必须：
 *   - 通过 secret scan（零 findings）
 *   - manifest.contentHash 与 files 内容一致（可重现）
 *   - 固定文件清单（三 format 均为 SKILL.md + manifest.json）
 *   - artifactId 绑定 agentId + format + revision
 *   - 生成物包含 MCP endpoint 与工具说明，不含明文 token
 */

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const test = require('node:test');

const {
    SKILL_FORMATS,
    generateSkillArtifact,
    scanForSecrets
} = require('../../../modules/agentGateway/services/skillGeneratorService');

const BASE_URL = 'https://gw.example.com';

function makeGuidance(agentId, displayName, extra = {}) {
    return Object.freeze({
        agentId,
        displayName,
        workflow: [`先调用 gateway_recall_run（${agentId}）。`, '召回为空时继续本地上下文。'],
        memoryWritePolicy: { write: ['已验证结论'], skip: ['密钥'] },
        allowedDiaries: [`${agentId}Diary`],
        defaultDiaries: [`${agentId}Diary`],
        memoryDefaults: { tags: ['vcp'], metadata: { project: 'vcp-toolbox' } },
        revision: `sha256:${crypto.createHash('sha256').update(agentId, 'utf8').digest('hex').padEnd(64, '0')}`,
        updatedAt: '2026-07-20T00:00:00.000Z',
        ...extra
    });
}

const AGENTS = [
    makeGuidance('Ariadne', '阿里阿德涅'),
    makeGuidance('MCPMidas', 'Midas', {
        memoryDefaults: { tags: ['codex', 'select-stock-pro'], metadata: { project: 'quant-select-stock-pro', source: 'codex' } }
    }),
    makeGuidance('TestAgent', 'Test Agent', { workflow: [], allowedDiaries: [], defaultDiaries: [] })
];

const EXPECTED_FILES = Object.freeze({
    claude: ['SKILL.md', 'manifest.json'],
    codex: ['SKILL.md', 'manifest.json'],
    kimi: ['SKILL.md', 'manifest.json']
});

function sha256Hex(value) {
    return crypto.createHash('sha256').update(value, 'utf8').digest('hex');
}

test('three agents × three formats: all artifacts generate successfully', () => {
    for (const guidance of AGENTS) {
        for (const format of SKILL_FORMATS) {
            const artifact = generateSkillArtifact({ guidance, format, baseUrl: BASE_URL });
            assert.equal(artifact.ok, true, `${guidance.agentId}/${format} should generate`);
        }
    }
});

test('three agents × three formats: fixed file list matches expected', () => {
    for (const guidance of AGENTS) {
        for (const format of SKILL_FORMATS) {
            const artifact = generateSkillArtifact({ guidance, format, baseUrl: BASE_URL });
            const paths = artifact.files.map((f) => f.path);
            assert.deepEqual(paths, EXPECTED_FILES[format], `${guidance.agentId}/${format} file list`);
        }
    }
});

test('three agents × three formats: manifest content hashes are reproducible', () => {
    for (const guidance of AGENTS) {
        for (const format of SKILL_FORMATS) {
            const a1 = generateSkillArtifact({ guidance, format, baseUrl: BASE_URL });
            const a2 = generateSkillArtifact({ guidance, format, baseUrl: BASE_URL });
            assert.equal(a1.manifest.contentHash, a2.manifest.contentHash, `${guidance.agentId}/${format} contentHash reproducible`);
            // manifest.files の sha256 entries match actual file content
            for (const entry of a1.manifest.files) {
                const file = a1.files.find((f) => f.path === entry.path);
                assert.ok(file, `manifest entry ${entry.path} has matching file`);
                assert.equal(entry.sha256, sha256Hex(file.content), `${guidance.agentId}/${format}/${entry.path} sha256 matches`);
                assert.equal(entry.bytes, Buffer.byteLength(file.content, 'utf8'), `${guidance.agentId}/${format}/${entry.path} bytes match`);
            }
        }
    }
});

test('three agents × three formats: secret scan passes (zero findings)', () => {
    for (const guidance of AGENTS) {
        for (const format of SKILL_FORMATS) {
            const artifact = generateSkillArtifact({ guidance, format, baseUrl: BASE_URL });
            const findings = scanForSecrets(artifact.files);
            assert.equal(findings.length, 0, `${guidance.agentId}/${format} secret scan: ${JSON.stringify(findings)}`);
        }
    }
});

test('three agents × three formats: artifactId binds agentId + format + revision', () => {
    for (const guidance of AGENTS) {
        for (const format of SKILL_FORMATS) {
            const artifact = generateSkillArtifact({ guidance, format, baseUrl: BASE_URL });
            assert.equal(artifact.artifactId, `skill:${guidance.agentId}:${format}:${guidance.revision}`);
            assert.equal(artifact.manifest.agentId, guidance.agentId);
            assert.equal(artifact.manifest.format, format);
            assert.equal(artifact.manifest.guidanceRevision, guidance.revision);
        }
    }
});

test('three agents × three formats: generated content embeds endpoint and tool guidance', () => {
    for (const guidance of AGENTS) {
        for (const format of SKILL_FORMATS) {
            const artifact = generateSkillArtifact({ guidance, format, baseUrl: BASE_URL });
            const combined = artifact.files.map((f) => f.content).join('\n');
            assert.ok(combined.includes(`${BASE_URL}/mcp`), `${guidance.agentId}/${format} embeds MCP endpoint`);
            assert.ok(combined.includes('gateway_recall_run'), `${guidance.agentId}/${format} embeds tool guidance`);
            assert.ok(combined.includes(guidance.agentId), `${guidance.agentId}/${format} embeds agentId`);
            assert.ok(combined.includes('AGENT_GATEWAY_TOKEN'), `${guidance.agentId}/${format} references secret store env`);
        }
    }
});

test('format allowlist rejects path traversal and unknown formats', () => {
    const guidance = AGENTS[0];
    for (const bad of ['../evil', '../../etc/passwd', 'unknown', '', ' ']) {
        const result = generateSkillArtifact({ guidance, format: bad, baseUrl: BASE_URL });
        assert.equal(result.ok, false, `format "${bad}" should be rejected`);
        assert.equal(result.httpStatus, 400);
    }
});

test('public URL validation rejects Host-header-derived or insecure URLs', () => {
    const { validatePublicBaseUrl } = require('../../../modules/agentGateway/services/skillGeneratorService');
    // 生产禁 HTTP（非 loopback）
    assert.equal(validatePublicBaseUrl('http://gw.example.com').ok, false);
    // userinfo 禁止
    assert.equal(validatePublicBaseUrl('https://user:pass@gw.example.com').ok, false);
    // query/fragment 禁止
    assert.equal(validatePublicBaseUrl('https://gw.example.com/?x=1').ok, false);
    assert.equal(validatePublicBaseUrl('https://gw.example.com/#frag').ok, false);
    // loopback/私网 HTTP 仅显式 opt-in 后允许（§6）；公网 HTTP 无豁免
    assert.equal(validatePublicBaseUrl('http://localhost:6005').ok, false);
    assert.equal(validatePublicBaseUrl('http://localhost:6005', { allowInsecure: true }).ok, true);
    assert.equal(validatePublicBaseUrl('http://127.0.0.1:6005', { allowInsecure: true }).ok, true);
    assert.equal(validatePublicBaseUrl('http://10.126.126.2:6005', { allowInsecure: true }).ok, true);
    assert.equal(validatePublicBaseUrl('http://8.8.8.8:6005', { allowInsecure: true }).ok, false);
    // 有效 HTTPS
    const valid = validatePublicBaseUrl('https://gw.example.com/vcp/');
    assert.equal(valid.ok, true);
    assert.equal(valid.baseUrl, 'https://gw.example.com/vcp');
});
