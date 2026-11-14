'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
    normalizeForIndex,
    normalizerIdentity
} = require('../IndexNormalizer');

const K_CARD = 'K_color-type-tokens_对比度.md';

test('normalizer：K 卡只摘除顶层 sources 块，title/tags/正文全保留', () => {
    const raw = [
        '---',
        'title: WCAG 对比度',
        'oneLiner: 普通文本 4.5:1。',
        'type: definition',
        'subskill: color-type-tokens',
        'sources:',
        '  - url: https://www.w3.org/WAI/WCAG22/Understanding/contrast-minimum.html',
        '    fetchedAt: 2026-11-01T00:00:00.000Z',
        '  - url: https://example.com/secondary',
        '    fetchedAt: 2026-11-02T00:00:00.000Z',
        'tags: [WCAG, 对比度]',
        '---',
        '',
        '## 定义',
        '普通文本对比度至少 4.5:1（参考 https://www.w3.org/WAI/WCAG22/ 正文）。'
    ].join('\n');
    const { text, removed, kind } = normalizeForIndex(raw, { fileName: K_CARD });
    assert.equal(kind, 'K_card');
    assert.equal(removed.frontmatterSourcesBlock, 5); // sources: + 4 缩进行
    assert.ok(text.includes('title: WCAG 对比度'));
    assert.ok(text.includes('tags: [WCAG, 对比度]'));
    assert.ok(text.includes('## 定义'));
    assert.ok(!text.includes('w3.org/WAI/WCAG22/Understanding/contrast-minimum'));
    assert.ok(!text.includes('fetchedAt'));
    assert.ok(text.includes('参考 https://www.w3.org/WAI/WCAG22/ 正文'), '正文 URL 必须保留');
});

test('normalizer：内联 sources（单行 flow 形式）整行摘除', () => {
    const raw = [
        '---',
        'title: 内联来源卡',
        'sources: [{url: "https://x.example/a", fetchedAt: "2026-11-01T00:00:00Z"}]',
        'tags: [a]',
        '---',
        '正文。'
    ].join('\n');
    const { text, removed } = normalizeForIndex(raw, { fileName: K_CARD });
    assert.equal(removed.frontmatterSourcesBlock, 1);
    assert.ok(!text.includes('x.example'));
    assert.ok(text.includes('title: 内联来源卡'));
    assert.ok(text.includes('正文。'));
});

test('normalizer：CRLF 与 BOM 全部归一，摘除逻辑不受影响', () => {
    const raw = '\uFEFF---\r\ntitle: CRLF 卡\r\nsources:\r\n  - url: https://x/y\r\ntags: [t]\r\n---\r\n\r\n正文内容。\r\n';
    const { text, removed } = normalizeForIndex(raw, { fileName: K_CARD });
    assert.equal(removed.frontmatterSourcesBlock, 2);
    assert.ok(!text.includes('\r'));
    assert.ok(!text.startsWith('\uFEFF'));
    assert.ok(text.includes('title: CRLF 卡'));
    assert.ok(text.includes('正文内容。'));
});

test('normalizer：无 frontmatter 的编号长文档，只摘头部 blockquote 来源/抓取时间行', () => {
    const raw = [
        '# 视觉层级原则',
        '',
        '> 先确定元素应被查看的顺序（这是内容，保留）。',
        '> 来源：https://wegic.ai/zh-cn/blog/visual-hierarchy ; https://zhuanlan.zhihu.com/p/131561269',
        '> 抓取时间：2026-10-11T16:02:40.779Z',
        '',
        '## 适用目标',
        '内容正文。',
        '',
        '后来出现的引用块：',
        '> 来源：https://mid-body.example/should-stay',
        '该行必须保留。'
    ].join('\n');
    const { text, removed, kind } = normalizeForIndex(raw, { fileName: '51_视觉层级原则.md' });
    assert.equal(kind, 'numbered');
    assert.equal(removed.sourceHeaderLines, 2);
    assert.ok(text.includes('> 先确定元素应被查看的顺序（这是内容，保留）。'));
    assert.ok(!text.includes('wegic.ai'));
    assert.ok(!text.includes('抓取时间'));
    assert.ok(text.includes('## 适用目标'));
    assert.ok(text.includes('> 来源：https://mid-body.example/should-stay'), '非头部引用块的来源行不得误删');
});

test('normalizer：代码块与非首个 --- 不受影响', () => {
    const raw = [
        '---',
        'title: 代码块卡',
        'tags: [t]',
        '---',
        '',
        '```yaml',
        'sources:',
        '  - url: https://in-codeblock/keep',
        '```',
        '',
        '分隔线：',
        '',
        '---',
        '',
        '正文。'
    ].join('\n');
    const { text, removed } = normalizeForIndex(raw, { fileName: K_CARD });
    assert.equal(removed.frontmatterSourcesBlock, 0); // 无顶层 sources 键
    assert.ok(text.includes('sources:'));
    assert.ok(text.includes('https://in-codeblock/keep'));
    assert.ok(text.match(/\n---\n/), '非首个 --- 必须保留');
});

test('normalizer：畸形 frontmatter（无闭合 ---）显式失败，不静默回退', () => {
    const raw = '---\ntitle: 畸形\ntags: [t]\n\n正文没有闭合标记';
    assert.throws(
        () => normalizeForIndex(raw, { fileName: K_CARD }),
        (error) => error.code === 'TDB_NORMALIZE_FRONTMATTER_UNPARSEABLE'
    );
    // 空 frontmatter（--- 紧跟 ---）同样失败。
    assert.throws(
        () => normalizeForIndex('---\n---\n正文', { fileName: K_CARD }),
        (error) => error.code === 'TDB_NORMALIZE_FRONTMATTER_UNPARSEABLE'
    );
});

test('normalizer：provenance 身份稳定且实现哈希随文件内容变化', () => {
    const identity = normalizerIdentity();
    assert.equal(identity.name, 'forge-markdown-normalizer');
    assert.match(identity.implementationHash, /^sha256:[0-9a-f]{64}$/);
    assert.match(identity.optionsHash, /^sha256:[0-9a-f]{64}$/);
    const again = normalizerIdentity();
    assert.equal(identity.implementationHash, again.implementationHash);
});
