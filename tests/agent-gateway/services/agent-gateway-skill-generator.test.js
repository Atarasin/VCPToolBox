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
    // §6：HTTP 仅限 loopback 与私网/CGNAT 字面 IP 且必须显式允许；
    // 公网地址与主机名 HTTP 无任何豁免
    assert.equal(validatePublicBaseUrl('http://gw.example.com').ok, false);
    assert.equal(validatePublicBaseUrl('http://gw.example.com', { allowInsecure: true }).ok, false);
    assert.equal(validatePublicBaseUrl('http://8.8.8.8:6005', { allowInsecure: true }).ok, false);
    assert.equal(validatePublicBaseUrl('http://127.0.0.1:6005').ok, false);
    assert.equal(validatePublicBaseUrl('http://127.0.0.1:6005', { allowInsecure: true }).ok, true);
    assert.equal(validatePublicBaseUrl('http://localhost:6005', { allowInsecure: true }).ok, true);
    // 私网/CGNAT：显式豁免后允许，未豁免拒绝
    assert.equal(validatePublicBaseUrl('http://10.126.126.2:6005').ok, false);
    assert.equal(validatePublicBaseUrl('http://10.126.126.2:6005', { allowInsecure: true }).ok, true);
    assert.equal(validatePublicBaseUrl('http://192.168.3.10:6005', { allowInsecure: true }).ok, true);
    assert.equal(validatePublicBaseUrl('http://172.16.0.1:6005', { allowInsecure: true }).ok, true);
    assert.equal(validatePublicBaseUrl('http://172.32.0.1:6005', { allowInsecure: true }).ok, false);
    assert.equal(validatePublicBaseUrl('http://100.64.0.1:6005', { allowInsecure: true }).ok, true);
    assert.equal(validatePublicBaseUrl('http://100.128.0.1:6005', { allowInsecure: true }).ok, false);
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
    const expectations = {
        claude: ['SKILL.md', 'INSTALL.md'],
        codex: ['SKILL.md', 'INSTALL.md'],
        kimi: ['SKILL.md', 'INSTALL.md']
    };
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

function fileByPath(artifact, path) {
    return artifact.files.find((file) => file.path === path)?.content || '';
}

test('SKILL.md is model-facing only: procedure and call shapes, no install or registration', () => {
    const artifact = generateSkillArtifact({
        guidance: GUIDANCE_FIXTURE, format: 'claude', baseUrl: 'https://gw.example.com'
    });
    const skillMd = fileByPath(artifact, 'SKILL.md');

    // 人格入口必须是可被模型调用的 tool，且排在召回之前
    assert.ok(skillMd.includes('gateway_agent_bootstrap'), 'bootstrap is the persona entry point');
    assert.ok(
        skillMd.indexOf('gateway_agent_bootstrap') < skillMd.indexOf('gateway_recall_run'),
        'bootstrap step must precede the recall step'
    );
    assert.ok(skillMd.includes('"query"'), 'the bootstrap call shape carries an explicit query');
    // 写回三个必填字段必须以可照抄的成品出现
    assert.ok(skillMd.includes('"diary": "Nova"'), 'write example uses the default diary');
    assert.ok(skillMd.includes('"tags"'), 'write example carries memory.tags');
    assert.ok(skillMd.includes('"vcp"'), 'write example seeds tags from memoryDefaults');

    // 模型读到这个文件时早已装好连上，安装/注册内容只会稀释指令
    assert.ok(!skillMd.includes('mcpServers'), 'no MCP registration snippet in SKILL.md');
    assert.ok(!skillMd.includes('ln -s'), 'no install path instructions in SKILL.md');
});

test('INSTALL.md carries the human-facing setup that SKILL.md dropped', () => {
    const artifact = generateSkillArtifact({
        guidance: GUIDANCE_FIXTURE, format: 'claude', baseUrl: 'https://gw.example.com'
    });
    const installMd = fileByPath(artifact, 'INSTALL.md');

    assert.ok(installMd.includes('https://gw.example.com/mcp'), 'endpoint for registration');
    assert.ok(installMd.includes('AGENT_GATEWAY_TOKEN'), 'credential is referenced by env var only');
    assert.ok(installMd.includes('mcpServers'), 'registration snippets live here');
    assert.ok(installMd.includes('ln -s'), 'install path lives here');
    assert.equal(scanForSecrets(artifact.files).length, 0, 'still零 secret');
});

test('the skill description is built from the configured trigger surface', () => {
    const guidance = {
        ...GUIDANCE_FIXTURE,
        skill: {
            name: 'ariadne-thread',
            domain: '迷宫导航',
            triggers: ['用户要在既有架构里找一条路径', '需要阿里阿德涅的历史判断'],
            notFor: ['与该 agent 记忆无关的一次性任务'],
            writeTargets: [
                { diary: 'Nova', when: '得出结构性结论后' },
                { diary: '未授权日记本', when: '永远不该出现' }
            ]
        }
    };
    const artifact = generateSkillArtifact({ guidance, format: 'claude', baseUrl: 'https://gw.example.com' });
    const skillMd = fileByPath(artifact, 'SKILL.md');

    assert.ok(skillMd.includes('name: ariadne-thread'), 'skill.name overrides the derived name');
    assert.ok(skillMd.includes('迷宫导航'), 'domain reaches the description');
    assert.ok(skillMd.includes('用户要在既有架构里找一条路径'), 'triggers reach the description');
    assert.ok(skillMd.includes('不适用：与该 agent 记忆无关的一次性任务'), 'notFor reaches the description');
    assert.ok(skillMd.includes('得出结构性结论后'), 'allowed writeTarget reaches the routing table');
    // 配置漂移不应产出一条注定 403 的指令
    assert.ok(!skillMd.includes('未授权日记本'), 'writeTargets outside allowedDiaries are dropped');
});

test('writeTargets match allowed diaries by the same equivalence the write path uses', () => {
    // 配置里写「X日记本」，bundle 里是策略解析后的「X」——按字面比对会把合法
    // 条目误丢，而写入授权本身用的是等价规则。
    const guidance = {
        ...GUIDANCE_FIXTURE,
        allowedDiaries: ['付鹏', '付鹏市场判断'],
        defaultDiaries: ['付鹏'],
        skill: {
            writeTargets: [{ diary: '付鹏市场判断日记本', when: '给出结构性判断后' }]
        }
    };
    const skillMd = fileByPath(
        generateSkillArtifact({ guidance, format: 'claude', baseUrl: 'https://gw.example.com' }),
        'SKILL.md'
    );
    assert.ok(
        skillMd.includes('| 付鹏市场判断 |  | 给出结构性判断后 |'),
        'suffix-form writeTarget resolves onto the bundle diary name'
    );
});

test('a guidance bundle without a skill block still renders a usable skill', () => {
    const bare = {
        agentId: 'Bare Agent',
        displayName: 'Bare Agent',
        workflow: [],
        memoryWritePolicy: { write: [], skip: [] },
        allowedDiaries: [],
        defaultDiaries: [],
        memoryDefaults: {},
        revision: `sha256:${'c'.repeat(64)}`,
        updatedAt: '2026-08-04T00:00:00.000Z'
    };
    const artifact = generateSkillArtifact({ guidance: bare, format: 'claude', baseUrl: 'https://gw.example.com' });
    assert.equal(artifact.ok, true);
    const skillMd = fileByPath(artifact, 'SKILL.md');

    // agentId 允许空格，skill 目录名不允许
    assert.ok(skillMd.includes('name: vcp-agent-gateway-bare-agent'), 'derived skill name is slugified');
    assert.ok(skillMd.includes('gateway_agent_bootstrap'), 'fallback still leads with the persona step');
    assert.ok(!/\n\n\n/.test(skillMd), 'empty guidance sections are omitted, not left blank');
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
