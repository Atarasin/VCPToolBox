'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { cmdInventory } = require('../scripts/forge_quality');

async function makeFixture() {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'forge-inv-'));
    const lib = path.join(root, 'knowledge', 'yanchi_ui知识库');
    await fsp.mkdir(lib, { recursive: true });

    await fsp.writeFile(path.join(lib, 'K_color-type-tokens_对比度要求.md'), [
        '---',
        'title: WCAG 文本对比度要求',
        'oneLiner: 普通文本 4.5:1，大文本 3:1。',
        'type: definition',
        'subskill: color-type-tokens',
        'sources:',
        '  - url: https://www.w3.org/WAI/WCAG22/Understanding/contrast-minimum.html',
        '    fetchedAt: 2026-11-01T00:00:00.000Z',
        'tags: [WCAG, 对比度]',
        '---',
        '',
        '## 定义',
        '普通文本对比度至少 4.5:1。',
        '',
        '## 边界',
        '大文本（≥18pt 或 14pt 粗体）为 3:1。'
    ].join('\n'), 'utf-8');

    // 纯重复：同正文不同文件名。
    await fsp.writeFile(path.join(lib, 'K_color-type-tokens_对比度要求的重复.md'), [
        '---',
        'title: WCAG 文本对比度要求',
        'type: definition',
        'subskill: color-type-tokens',
        'sources:',
        '  - url: https://www.w3.org/WAI/WCAG22/Understanding/contrast-minimum.html',
        '    fetchedAt: 2026-11-01T00:00:00.000Z',
        '---',
        '',
        '## 定义',
        '普通文本对比度至少 4.5:1。',
        '',
        '## 边界',
        '大文本（≥18pt 或 14pt 粗体）为 3:1。'
    ].join('\n'), 'utf-8');

    // 同标题不同正文（内容型合并候选）。
    await fsp.writeFile(path.join(lib, 'K_layout-grid_八项栅格原则.md'), [
        '---',
        'title: 八项栅格原则',
        'type: checklist',
        'subskill: layout-grid-typography',
        'sources:',
        '  - url: https://example.com/grid',
        '---',
        '',
        '1. 列数用 12',
        '2. 槽宽 8 的倍数'
    ].join('\n'), 'utf-8');
    await fsp.writeFile(path.join(lib, 'K_layout-grid_八项栅格原则v2.md'), [
        '---',
        'title: 八项栅格原则',
        'type: checklist',
        'subskill: layout-grid-typography',
        'sources:',
        '  - url: https://example.com/grid-v2',
        '---',
        '',
        '1. 列数用 12',
        '2. 槽宽 8 的倍数',
        '3. 基线对齐 4pt',
        '4. 断点与列数联动',
        '5. 内容优先定列宽',
        '6. 嵌套栅格降维',
        '7. 密度可调',
        '8. 例外可破格'
    ].join('\n'), 'utf-8');

    // 编号长文档（来源头在正文，frontmatter 无）+ 偏题信号示例。
    await fsp.writeFile(path.join(lib, '51_医疗器械法规概述.md'), [
        '# 医疗器械法规概述',
        '',
        '> 来源：https://example.gov/mdr',
        '> 抓取时间：2026-11-01T00:00:00.000Z',
        '',
        '医疗器械分类管理规则……'
    ].join('\n'), 'utf-8');

    // 无 sources 的 K 卡。
    await fsp.writeFile(path.join(lib, 'K_ui-review_评审分级.md'), [
        '---',
        'title: 评审 P0/P1/P2 分级',
        'type: rule',
        'subskill: ui-review-priority',
        '---',
        '',
        'P0 阻断发布。'
    ].join('\n'), 'utf-8');

    return root;
}

test('forge_quality inventory：盘点报告覆盖来源/主题/完整性/重复候选，零写入', async () => {
    const root = await makeFixture();
    const snapshotBefore = await snapshot(root);
    try {
        const { exitCode, report } = await cmdInventory({ root, json: true });
        assert.equal(exitCode, 0);
        const lib = report.libraries['yanchi_ui知识库'];
        assert.equal(lib.files, 6);
        assert.equal(lib.byKind.K_card, 5);
        assert.equal(lib.byKind.numbered, 1);
        assert.equal(lib.filesWithoutSources, 1);

        const contrast = lib.entries.find((e) => e.path.endsWith('对比度要求.md'));
        assert.equal(contrast.sources.count, 1);
        assert.deepEqual(contrast.sources.sourceTypes, ['official-standard']);
        assert.equal(contrast.subskill, 'color-type-tokens');

        // 重复候选：identical-body + same-title-divergent-body（或 same-title）+ shared-url。
        const kinds = lib.duplicateCandidates.map((c) => c.kind);
        assert.ok(kinds.includes('identical-body'), `应检出纯重复：${JSON.stringify(kinds)}`);
        assert.ok(kinds.includes('same-title-divergent-body') || kinds.includes('same-title'), '应检出同题异文合并候选');
        assert.ok(kinds.includes('shared-url'), '应检出同源 URL 聚类');
        const divergent = lib.duplicateCandidates.find((c) => c.kind === 'same-title-divergent-body' || c.kind === 'same-title');
        assert.match(divergent.autoMergeHint, /mergeProposal|复核/, '内容型候选必须指向复核，不得自动覆盖');

        // 完整性信号：标题承诺 8 项但清单只有 2 项。
        const eight = lib.entries.find((e) => e.path.includes('八项栅格原则.md'));
        assert.ok(eight.completenessSignals.some((s) => /8 项.*仅 2 项/.test(s)), eight.completenessSignals.join(';'));

        // 盘点零写入。
        assert.deepEqual(await snapshot(root), snapshotBefore);
    } finally {
        await fsp.rm(root, { recursive: true, force: true });
    }
});

async function snapshot(root) {
    const acc = {};
    const walk = async (dir) => {
        for (const entry of await fsp.readdir(dir, { withFileTypes: true })) {
            const abs = path.join(dir, entry.name);
            if (entry.isDirectory()) await walk(abs);
            else acc[path.relative(root, abs)] = (await fsp.readFile(abs)).length;
        }
    };
    await walk(root);
    return acc;
}

void fs;
