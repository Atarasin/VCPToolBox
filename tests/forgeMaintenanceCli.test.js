'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

const CLI = path.join(__dirname, '..', 'scripts', 'forge_maintenance.js');

function runCli(args) {
    const result = spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf-8' });
    let json = null;
    try {
        json = JSON.parse(result.stdout);
    } catch { /* 非 JSON 输出按 null 处理 */ }
    return { status: result.status, stdout: result.stdout, stderr: result.stderr, json };
}

async function makeFakeRoot() {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'forge-backup-root-'));
    await fsp.mkdir(path.join(root, 'knowledge', '库A'), { recursive: true });
    await fsp.mkdir(path.join(root, 'VectorStoreTDB'), { recursive: true });
    await fsp.mkdir(path.join(root, 'Agent', 'forge', 'e1'), { recursive: true });
    await fsp.writeFile(path.join(root, 'knowledge', '库A', 'a.md'), '# A\n内容A\n', 'utf-8');
    await fsp.writeFile(path.join(root, 'knowledge', '库A', 'b.md'), '# B\n内容B\n', 'utf-8');
    await fsp.writeFile(path.join(root, 'VectorStoreTDB', 'store.tdb'), 'binary-ish', 'utf-8');
    await fsp.writeFile(path.join(root, 'VectorStoreTDB', 'embedding-manifest.json'), JSON.stringify({ schemaVersion: 1, marker: 'fake' }), 'utf-8');
    await fsp.writeFile(path.join(root, 'Agent', 'forge', 'e1', 'gaps.json'), '[]', 'utf-8');
    await fsp.writeFile(path.join(root, 'config.env'), 'FAKE_KEY=for-test\n', 'utf-8');
    return root;
}

async function snapshotTree(root, rel) {
    const target = path.join(root, rel);
    const acc = {};
    const walk = async (dir) => {
        for (const entry of await fsp.readdir(dir, { withFileTypes: true })) {
            const abs = path.join(dir, entry.name);
            if (entry.isDirectory()) await walk(abs);
            else {
                acc[path.relative(root, abs)] = crypto
                    .createHash('sha256')
                    .update(await fsp.readFile(abs))
                    .digest('hex');
            }
        }
    };
    if (fs.existsSync(target)) await walk(target);
    return acc;
}

test('forge_maintenance backup：清单/哈希/回滚配对完整，源目录零改动', async () => {
    const root = await makeFakeRoot();
    const dest = await fsp.mkdtemp(path.join(os.tmpdir(), 'forge-backup-dest-'));
    const before = {
        knowledge: await snapshotTree(root, 'knowledge'),
        store: await snapshotTree(root, 'VectorStoreTDB'),
        forge: await snapshotTree(root, 'Agent/forge')
    };

    const result = runCli(['backup', '--root', root, '--dest', dest, '--json']);
    assert.equal(result.status, 0, `backup 应成功：${result.stderr}`);
    assert.equal(result.json.ok, true);
    assert.equal(result.json.files, 6); // 2 knowledge + 2 store（含 embedding-manifest）+ 1 forge + config.env
    assert.ok(fs.existsSync(path.join(dest, 'COMPLETE')));
    assert.ok(fs.existsSync(path.join(dest, 'rollback-pairing.json')));

    const manifest = JSON.parse(await fsp.readFile(path.join(dest, 'backup-manifest.json'), 'utf-8'));
    assert.equal(manifest.schemaVersion, 1);
    assert.deepEqual(manifest.sources, ['knowledge', 'VectorStoreTDB', 'Agent/forge', 'config.env']);
    assert.equal(manifest.embeddingManifest.marker, 'fake');
    const paths = manifest.items.map((item) => item.path);
    assert.ok(paths.includes(path.join('knowledge', '库A', 'a.md')));
    assert.ok(paths.includes(path.join('VectorStoreTDB', 'store.tdb')));
    assert.ok(paths.includes(path.join('Agent', 'forge', 'e1', 'gaps.json')));
    assert.ok(paths.includes('config.env'));
    for (const item of manifest.items) {
        assert.match(item.sha256, /^sha256:[0-9a-f]{64}$/);
    }

    const pairing = JSON.parse(await fsp.readFile(path.join(dest, 'rollback-pairing.json'), 'utf-8'));
    assert.equal(pairing.backupDir, dest);
    assert.equal(pairing.backupManifestSha256, result.json.backupManifestSha256);
    assert.ok(Array.isArray(pairing.restore.steps) && pairing.restore.steps.length >= 3);

    // 源目录零改动（DoD：原目录未发生变化）。
    assert.deepEqual(await snapshotTree(root, 'knowledge'), before.knowledge);
    assert.deepEqual(await snapshotTree(root, 'VectorStoreTDB'), before.store);
    assert.deepEqual(await snapshotTree(root, 'Agent/forge'), before.forge);
});

test('forge_maintenance verify-backup：全量通过；篡改/缺 COMPLETE 时非零退出', async () => {
    const root = await makeFakeRoot();
    const dest = await fsp.mkdtemp(path.join(os.tmpdir(), 'forge-backup-dest-'));
    assert.equal(runCli(['backup', '--root', root, '--dest', dest, '--json']).status, 0);

    const ok = runCli(['verify-backup', '--backup', dest, '--json']);
    assert.equal(ok.status, 0);
    assert.equal(ok.json.ok, true);
    assert.equal(ok.json.verifiedFiles, 6);

    const sampled = runCli(['verify-backup', '--backup', dest, '--sample', '3', '--json']);
    assert.equal(sampled.status, 0);
    assert.equal(sampled.json.sampled, true);
    assert.equal(sampled.json.verifiedFiles, 3);

    // 篡改备份内文件 → 哈希不一致，非零退出。
    await fsp.appendFile(path.join(dest, 'knowledge', '库A', 'a.md'), 'tampered', 'utf-8');
    const tampered = runCli(['verify-backup', '--backup', dest, '--json']);
    assert.equal(tampered.status, 1);
    assert.equal(tampered.json.ok, false);
    assert.equal(tampered.json.issues.length, 1);

    // 删除 COMPLETE → 视为中断备份，拒绝。
    await fsp.rm(path.join(dest, 'COMPLETE'));
    const incomplete = runCli(['verify-backup', '--backup', dest, '--json']);
    assert.equal(incomplete.status, 1);
    assert.match(incomplete.json.error, /不完整/);
});

test('forge_maintenance lock/unlock/lease-status：跨进程文件协议可用', async () => {
    const forgeDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'forge-lease-cli-'));
    const expert = 'zz-test-lease-cli';
    const leaseFile = path.join(forgeDir, expert, 'maintenance-lease.json');
    const dirArgs = ['--forge-dir', forgeDir];
    try {
        const locked = runCli(['lock', ...dirArgs, '--expert', expert, '--mode', 'rebuild', '--owner', 'cli_test_owner', '--json']);
        assert.equal(locked.status, 0);
        assert.equal(locked.json.mode, 'rebuild');

        const status = runCli(['lease-status', ...dirArgs, '--expert', expert, '--json']);
        assert.equal(status.status, 0);
        assert.equal(status.json.entries[0].active, true);

        const blocked = runCli(['lock', ...dirArgs, '--expert', expert, '--mode', 'learn', '--owner', 'other', '--json']);
        assert.equal(blocked.status, 1);
        assert.equal(blocked.json.code, 'FORGE_EXPERT_WRITE_PAUSED');

        const unlocked = runCli(['unlock', ...dirArgs, '--expert', expert, '--owner', 'cli_test_owner', '--json']);
        assert.equal(unlocked.status, 0);
        assert.equal(fs.existsSync(leaseFile), false);
    } finally {
        fs.rmSync(forgeDir, { recursive: true, force: true });
    }
});
