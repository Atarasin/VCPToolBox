const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { createKnowledgeWriter } = require('../../../modules/agentGateway/services/forge/knowledgeWriter');

function createTempDir() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'forge-kw-'));
}

// 回归（M2 二轮评审 S2）：合并来源必须保留旧 fetchedAt 原值，且多轮合并不产生
// 复合污染（早期内联格式的解析缺陷）；序列化对齐设计 §3.4 的多行 YAML 格式。
test('mergeSources：writeCard 产出的多行格式可无损往返，多轮合并时间戳不污染', async () => {
    const libDir = createTempDir();
    const writer = createKnowledgeWriter({ libraryDir: libDir });

    const T1 = '2026-09-01T08:00:00.000Z';
    const T2 = '2026-10-01T09:00:00.000Z';
    const T3 = '2026-10-11T10:00:00.000Z';
    const urlA = 'https://a.example.com/page';
    const urlB = 'https://b.example.com/doc';
    const urlC = 'https://c.example.com/post';

    const { fileName } = await writer.writeCard({
        type: 'concept',
        title: '测试卡',
        oneLiner: 'x',
        content: '正文',
        tags: [],
        sourceUrls: [urlA]
    }, {
        subskillId: 'color-theory',
        fetchedAtByUrl: new Map([[urlA, T1]]),
        defaultFetchedAt: T1
    });

    // 第一次合并：加入 B（材料时刻 T2）
    const first = await writer.mergeSources(fileName, [urlB], {
        fetchedAtByUrl: new Map([[urlA, T1], [urlB, T2]]),
        defaultFetchedAt: T2
    });
    assert.equal(first.addedCount, 1);

    let raw = fs.readFileSync(path.join(libDir, fileName), 'utf8');
    let parsed = parseSources(raw);
    assert.deepEqual(parsed, [
        { url: urlA, fetchedAt: T1 },
        { url: urlB, fetchedAt: T2 }
    ], '第一次合并后：旧值保留、新值精确');

    // 第二次合并：加入 C（材料时刻 T3）——不得出现复合污染
    await writer.mergeSources(fileName, [urlC], {
        fetchedAtByUrl: new Map([[urlA, T1], [urlB, T2], [urlC, T3]]),
        defaultFetchedAt: T3
    });
    raw = fs.readFileSync(path.join(libDir, fileName), 'utf8');
    parsed = parseSources(raw);
    assert.deepEqual(parsed, [
        { url: urlA, fetchedAt: T1 },
        { url: urlB, fetchedAt: T2 },
        { url: urlC, fetchedAt: T3 }
    ], '第二次合并后：三轮时间戳各自精确，无后缀增长');

    // 重复合并已存在来源：幂等，addedCount=0
    const idempotent = await writer.mergeSources(fileName, [urlA], {
        fetchedAtByUrl: new Map([[urlA, T1]]),
        defaultFetchedAt: T3
    });
    assert.equal(idempotent.addedCount, 0);
    assert.deepEqual(parseSources(fs.readFileSync(path.join(libDir, fileName), 'utf8')), parsed, '幂等不改变任何值');

    // 序列化格式：多行 YAML（设计 §3.4）
    assert.match(raw, /sources:\n  - url: https:\/\/a\.example\.com\/page\n    fetchedAt: 2026-09-01T08:00:00\.000Z/);
});

test('mergeSources：兼容早期内联 flow map 格式的旧卡', async () => {
    const libDir = createTempDir();
    fs.mkdirSync(libDir, { recursive: true });
    fs.writeFileSync(path.join(libDir, 'K_color-theory_old.md'), `---
title: "旧格式卡"
type: concept
subskill: color-theory
sources:
  - { url: "https://old.example.com/a", fetchedAt: "2026-08-01T00:00:00.000Z" }
tags: [旧]
---

正文。
`);
    const writer = createKnowledgeWriter({ libraryDir: libDir });
    const result = await writer.mergeSources('K_color-theory_old.md', ['https://new.example.com/b'], {
        fetchedAtByUrl: new Map([['https://new.example.com/b', '2026-10-11T11:00:00.000Z']]),
        defaultFetchedAt: '2026-10-11T11:00:00.000Z'
    });
    assert.equal(result.addedCount, 1);
    const raw = fs.readFileSync(path.join(libDir, 'K_color-theory_old.md'), 'utf8');
    assert.deepEqual(parseSources(raw), [
        { url: 'https://old.example.com/a', fetchedAt: '2026-08-01T00:00:00.000Z' },
        { url: 'https://new.example.com/b', fetchedAt: '2026-10-11T11:00:00.000Z' }
    ], '内联旧格式解析为精确值并重写为多行格式');
    assert.match(raw, /正文。/, '正文不动');
});

// 与实现解耦的独立解析器（防止用实现自身验证实现）。
function parseSources(raw) {
    const match = raw.match(/^---\n([\s\S]*?)\n---/);
    assert.ok(match, 'frontmatter 存在');
    const lines = match[1].split('\n');
    const result = [];
    let inSources = false;
    let pendingUrl = null;
    for (const line of lines) {
        if (/^sources:/.test(line)) {
            inSources = true;
            continue;
        }
        if (!inSources) {
            continue;
        }
        if (/^\S/.test(line)) {
            break; // 离开 sources 块
        }
        const item = line.match(/^\s+- url: (.+)$/);
        if (item) {
            pendingUrl = item[1].trim();
            continue;
        }
        const ts = line.match(/^\s+fetchedAt: (.+)$/);
        if (ts && pendingUrl) {
            result.push({ url: pendingUrl, fetchedAt: ts[1].trim() });
            pendingUrl = null;
        }
    }
    return result;
}
