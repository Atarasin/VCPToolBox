const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

/**
 * 评测语料的契约测试。
 *
 * 与上一版的关键差异：校验对象从**生成的语料**换成了**语料源头 corpus-spec/**。
 *
 * 原因：eval/dailynote_eval/ 现在是生成物且已 gitignore —— 它的日期按运行日锚定，
 * 每次 `corpus build` 都不同。真正需要长期守住的契约在 corpus-spec/ 里，那才是提交进
 * git 的部分。
 *
 * 这里的每条断言都对应一个**静默失效**模式：违反它不会报错，只会让某个 RAG 能力
 * 悄悄变成 no-op，然后评测照样跑出一份看起来正常的报告。详见 eval/README.md。
 */

const repoRoot = path.resolve(__dirname, '..', '..');
const evalRoot = path.join(repoRoot, 'eval');
const corpusVerify = require(path.join(evalRoot, 'lib', 'corpusVerify'));
const corpusBuild = require(path.join(evalRoot, 'lib', 'corpusBuild'));

test('corpus-spec 通过全部语料不变量校验', () => {
    const result = corpusVerify.verifySpec();
    const errors = result.findings.filter(f => f.level === 'error');
    assert.deepEqual(
        errors.map(e => `${e.code}: ${e.message}`),
        [],
        'corpus-spec 存在会导致 RAG 能力静默失效的问题'
    );
    assert.ok(result.ok, 'corpus-spec 校验未通过');
});

test('语料规模足以让各项能力脱离低置信兜底', () => {
    const { stats } = corpusVerify.verifySpec();

    // 语料太小时 top-k 等于整库返回，Precision/MRR 会被钉死在常数上
    assert.ok(stats.docs >= 40, `文档数 ${stats.docs} 不足 40`);

    // EPA 建基需 ≥8 个带向量的 tag；maxFieldNodes 48、sparseAssociationMinContacts 3、
    // topologyV2MinimumPeers 3 等下限都需要足够的 tag 词汇量
    assert.ok(stats.uniqueTags >= 40, `唯一 tag ${stats.uniqueTags} 不足 40`);

    // 共现图要有边：tag 必须跨多篇复现，否则场熵过不了 minFieldEntropy 0.12 的门，
    // geodesicRerank 会直接放弃重排并退回原始 KNN 顺序
    assert.ok(stats.recurringTags >= 8, `跨 ≥3 篇复现的 tag 只有 ${stats.recurringTags} 个`);

    // hub 惩罚 (1 - sqrt(inbound/maxInbound)) 需要入度落差才可测
    assert.ok(stats.maxTagOccurrence >= 12, `最高频 tag 只覆盖 ${stats.maxTagOccurrence} 篇`);

    // RiverMemo 的稀有直锚通道（上限 0.10，位移最大）需要只出现一次的 tag
    assert.ok(stats.rareTags >= 1, '没有任何只出现一次的 tag');
});

test('对抗族的角色齐全', () => {
    const { docs } = corpusBuild.loadSpec();
    const roles = new Map();
    for (const doc of docs) {
        if (!doc.family) continue;
        if (!roles.has(doc.family)) roles.set(doc.family, new Set());
        roles.get(doc.family).add(doc.role);
    }

    // 缺任何一个角色，对应能力的断言就无法成立
    const required = {
        tagmemo_tagonly: ['gold', 'bridge', 'hardneg'],
        tagmemo_position: ['position_first', 'position_last'],
        rivermemo_order: ['gold_forward', 'distractor_reverse'],
        rivermemo_corroboration: ['corroborated', 'uncorroborated'],
        dedup: ['exact_a', 'exact_b', 'fullwidth', 'paraphrase_a', 'paraphrase_b'],
        bm25_lexical: ['lexical_decoy', 'semantic_only'],
        timedecay: ['fresh', 'mid', 'stale']
    };

    for (const [family, needed] of Object.entries(required)) {
        const present = roles.get(family);
        assert.ok(present, `缺少对抗族 ${family}`);
        for (const role of needed) {
            assert.ok(present.has(role), `对抗族 ${family} 缺少角色 ${role}`);
        }
    }
});

test('精确去重对在渲染后逐字节相同', () => {
    const { docs } = corpusBuild.loadSpec();
    const pair = docs.filter(d => d.family === 'dedup' && (d.role === 'exact_a' || d.role === 'exact_b'));
    assert.equal(pair.length, 2, 'dedup 族应恰好有一对 exact_a / exact_b');

    // chunk 文本包含首行日期、[HH:MM] 前缀和 Tag 行 —— 任何一项不同都不是逐字节相同，
    // ResultDeduplicator 的 text 身份就不会命中，精确去重永远不触发
    const anchor = new Date(2026, 0, 15, 12, 0, 0, 0);
    const rendered = pair.map(d => corpusBuild.renderDoc(
        d, corpusBuild.formatDate(corpusBuild.resolveDate(d, anchor))
    ));
    assert.equal(rendered[0], rendered[1], '精确去重对渲染后不是逐字节相同');
});

test('全角变体经 NFKC 归一化后与精确对折叠为同一条', () => {
    const { docs } = corpusBuild.loadSpec();
    const base = docs.find(d => d.family === 'dedup' && d.role === 'exact_a');
    const fw = docs.find(d => d.family === 'dedup' && d.role === 'fullwidth');
    assert.ok(base && fw, 'dedup 族缺少 exact_a 或 fullwidth');

    // 复刻 ResultDeduplicator._normalizeText 的实现
    const normalize = s => String(s || '')
        .normalize('NFKC')
        .replace(/\r\n?/g, '\n')
        .replace(/[ \t]+/g, ' ')
        .replace(/\n{3,}/g, '\n\n')
        .trim()
        .toLowerCase();

    // 注意：单纯在 CJK 标点旁加空格**不会**被折叠（NFKC 不动 CJK 标点，
    // 空白折叠只把连续空白并成一个）。必须用全角字母数字或 U+3000 这类 NFKC 真会折的字符。
    assert.equal(
        normalize(base.body), normalize(fw.body),
        '全角变体归一化后与基准不同：这条去重用例测不到任何东西'
    );
    assert.notEqual(base.body, fw.body, '全角变体与基准正文完全相同，失去了测试意义');
});

test('用例集的真值引用都能解析到实际文档', () => {
    const corpusRoot = path.join(evalRoot, 'dailynote_eval');
    const manifest = corpusBuild.loadManifest(corpusRoot);
    if (!manifest) {
        // 语料尚未生成时跳过 —— 它是生成物，CI 里应先跑 `vcp-eval corpus build`
        return;
    }

    const metrics = require(path.join(evalRoot, 'lib', 'metrics'));
    const runner = require(path.join(evalRoot, 'lib', 'runner'));
    const matcher = metrics.makeDocMatcher(manifest);
    const { cases } = runner.loadSuites(evalRoot, []);

    const broken = [];
    for (const c of cases) {
        for (const ref of [...(c.relevant || []), ...(c.irrelevant || [])]) {
            if (!matcher.resolve(ref)) broken.push(`${c.id} -> ${ref}`);
        }
    }
    // 解析不到的真值会让用例**永远算 miss**，而且不报错 —— 这正是最危险的一类问题
    assert.deepEqual(broken, [], '以下用例的真值引用在语料中不存在');
});
