const assert = require('node:assert/strict');
const test = require('node:test');

const {
    SECRET_SCAN_PATTERNS,
    SKILL_FORMATS,
    buildIntegrationSummary,
    generateSkillArtifact,
    scanForSecrets,
    validatePublicBaseUrl
} = require('../../../modules/agentGateway/services/skillGeneratorService');

const GUIDANCE_FIXTURE = Object.freeze({
    agentId: 'Ariadne',
    displayName: '阿里阿德涅',
    workflow: ['先调用 gateway_recall_run。', '召回为空时继续本地上下文。'],
    memoryWritePolicy: { write: ['已验证结论'], skip: ['密钥和敏感数据'] },
    allowedDiaries: ['Nova', 'SharedMemory'],
    defaultDiaries: ['Nova'],
    memoryDefaults: { tags: ['vcp'], metadata: { project: 'vcp-toolbox' } },
    revision: `sha256:${'a'.repeat(64)}`,
    updatedAt: '2026-07-20T00:00:00.000Z'
});

test('validatePublicBaseUrl enforces §6 constraints', () => {
    assert.equal(validatePublicBaseUrl('').ok, false);
    assert.equal(validatePublicBaseUrl('not-a-url').ok, false);
    assert.equal(validatePublicBaseUrl('https://user:pass@gw.example.com').ok, false);
    assert.equal(validatePublicBaseUrl('https://gw.example.com/?q=1').ok, false);
    assert.equal(validatePublicBaseUrl('https://gw.example.com/#frag').ok, false);
    assert.equal(validatePublicBaseUrl('ftp://gw.example.com').ok, false);
    // 生产禁 HTTP（loopback 例外）
    // §6：HTTP 仅限 loopback 且必须显式允许；非 loopback HTTP 无任何豁免
    assert.equal(validatePublicBaseUrl('http://gw.example.com').ok, false);
    assert.equal(validatePublicBaseUrl('http://gw.example.com', { allowInsecure: true }).ok, false);
    assert.equal(validatePublicBaseUrl('http://127.0.0.1:6005').ok, false);
    assert.equal(validatePublicBaseUrl('http://127.0.0.1:6005', { allowInsecure: true }).ok, true);
    assert.equal(validatePublicBaseUrl('http://localhost:6005', { allowInsecure: true }).ok, true);
    const valid = validatePublicBaseUrl('https://gw.example.com/vcp/');
    assert.equal(valid.ok, true);
    assert.equal(valid.baseUrl, 'https://gw.example.com/vcp');
});

test('generateSkillArtifact enforces the format allowlist', () => {
    for (const format of SKILL_FORMATS) {
        const artifact = generateSkillArtifact({
            guidance: GUIDANCE_FIXTURE, format, baseUrl: 'https://gw.example.com'
        });
        assert.equal(artifact.ok, true, `${format} should generate`);
    }
    const rejected = generateSkillArtifact({
        guidance: GUIDANCE_FIXTURE, format: '../evil', baseUrl: 'https://gw.example.com'
    });
    assert.equal(rejected.ok, false);
    assert.equal(rejected.httpStatus, 400);
});

test('each format produces a fixed file list with manifest content hashes', () => {
    const expectations = { claude: ['SKILL.md'], codex: ['AGENTS.md'], kimi: ['SKILL.md'] };
    for (const format of SKILL_FORMATS) {
        const artifact = generateSkillArtifact({
            guidance: GUIDANCE_FIXTURE, format, baseUrl: 'https://gw.example.com'
        });
        const paths = artifact.files.map((file) => file.path);
        assert.deepEqual(paths, [...expectations[format], 'manifest.json'], `${format} file list`);
        assert.equal(artifact.manifest.agentId, 'Ariadne');
        assert.equal(artifact.manifest.format, format);
        assert.equal(artifact.manifest.guidanceRevision, GUIDANCE_FIXTURE.revision);
        assert.match(artifact.manifest.contentHash, /^sha256:[0-9a-f]{64}$/);
        for (const entry of artifact.manifest.files) {
            assert.match(entry.sha256, /^[0-9a-f]{64}$/);
            assert.ok(entry.bytes > 0);
        }
        // artifactId 绑定 agent + format + revision
        assert.equal(artifact.artifactId, `skill:Ariadne:${format}:${GUIDANCE_FIXTURE.revision}`);
    }
});

test('generated content embeds guidance and endpoints but never secret-shaped values', () => {
    for (const format of SKILL_FORMATS) {
        const artifact = generateSkillArtifact({
            guidance: GUIDANCE_FIXTURE, format, baseUrl: 'https://gw.example.com'
        });
        const combined = artifact.files.map((file) => file.content).join('\n');
        assert.ok(combined.includes('https://gw.example.com/mcp'), `${format} embeds endpoint`);
        assert.ok(combined.includes('gateway_recall_run'), `${format} embeds tool guidance`);
        assert.ok(combined.includes('Ariadne'), `${format} embeds agent id`);
        assert.ok(combined.includes('AGENT_GATEWAY_TOKEN'), `${format} references secret store env`);
        // 环境变量引用形态，不是内联 token
        assert.equal(scanForSecrets(artifact.files).length, 0, `${format} passes secret scan`);
    }
});

test('secret scan patterns catch inline token shapes', () => {
    const findings = scanForSecrets([
        { path: 'bad.md', content: 'headers: { Authorization: "Bearer sk-live-0123456789abcdef" }' },
        { path: 'bad2.md', content: 'x-agent-gateway-key: gw-super-secret-key-value' },
        { path: 'bad3.md', content: '-----BEGIN RSA PRIVATE KEY-----' },
        { path: 'ok.md', content: 'Authorization: Bearer ${AGENT_GATEWAY_TOKEN}' }
    ]);
    const flaggedPaths = new Set(findings.map((finding) => finding.path));
    assert.ok(flaggedPaths.has('bad.md'));
    assert.ok(flaggedPaths.has('bad2.md'));
    assert.ok(flaggedPaths.has('bad3.md'));
    assert.ok(!flaggedPaths.has('ok.md'), 'env-var reference form is allowed');
    assert.ok(SECRET_SCAN_PATTERNS.length >= 4);
});

test('buildIntegrationSummary lists all formats with encoded skill paths', () => {
    const summary = buildIntegrationSummary({
        guidance: { ...GUIDANCE_FIXTURE, agentId: 'Agent With Space' },
        baseUrl: 'https://gw.example.com'
    });
    assert.equal(summary.mcpEndpoint, 'https://gw.example.com/mcp');
    assert.equal(summary.formats.length, SKILL_FORMATS.length);
    for (const entry of summary.formats) {
        assert.ok(entry.skillPath.includes('Agent%20With%20Space'), 'agentId is URL-encoded');
        assert.ok(entry.skillPath.endsWith(`format=${entry.format}`));
    }
});
