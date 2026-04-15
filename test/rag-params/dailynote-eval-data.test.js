const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const repoRoot = path.resolve(__dirname, '..', '..');
const evalRoot = path.join(repoRoot, 'eval');
const diaryRoot = path.join(evalRoot, 'dailynote_eval');
const evalSetPath = path.join(evalRoot, 'rag_param_eval_set.jsonl');

function getDiaryNotebookPaths() {
    return fs.readdirSync(diaryRoot, { withFileTypes: true })
        .filter(entry => entry.isDirectory())
        .map(entry => path.join(diaryRoot, entry.name));
}

function getDiaryFiles(notebookPath) {
    return fs.readdirSync(notebookPath, { withFileTypes: true })
        .filter(entry => entry.isFile() && entry.name.endsWith('.txt'))
        .map(entry => path.join(notebookPath, entry.name));
}

function parseDiaryFile(filePath) {
    const rawText = fs.readFileSync(filePath, 'utf-8').trim();
    const lines = rawText.split(/\r?\n/);
    const lastLine = lines.at(-1) || '';

    assert.match(
        lastLine,
        /^Tag: .+/,
        `${filePath} 最后一行必须是标准 Tag 行`
    );

    const tags = lastLine.replace(/^Tag:\s*/, '')
        .split(', ')
        .map(tag => tag.trim())
        .filter(Boolean);

    return {
        filePath,
        rawText,
        tags,
        tagLine: lastLine
    };
}

function readEvalSet() {
    return fs.readFileSync(evalSetPath, 'utf-8')
        .trim()
        .split(/\r?\n/)
        .filter(Boolean)
        .map(line => JSON.parse(line));
}

function resolveTagTargets(item) {
    return Array.isArray(item.tag_targets) ? item.tag_targets.filter(Boolean) : [];
}

function buildNotebookIndex() {
    const index = new Map();

    for (const notebookPath of getDiaryNotebookPaths()) {
        const notebookName = path.basename(notebookPath);
        const entries = getDiaryFiles(notebookPath).map(parseDiaryFile);
        index.set(notebookName, entries);
    }

    return index;
}

test('评测日记必须全部带有标准 Tag 行', () => {
    const notebookPaths = getDiaryNotebookPaths();
    assert.ok(notebookPaths.length > 0, '评测日记目录不能为空');

    for (const notebookPath of notebookPaths) {
        const diaryFiles = getDiaryFiles(notebookPath);
        assert.ok(diaryFiles.length > 0, `${notebookPath} 目录下至少应有一篇日记`);

        for (const diaryFile of diaryFiles) {
            const { tags } = parseDiaryFile(diaryFile);

            // Tag 是日记精华，评测数据也应保持少而精，避免把正文直接摊平成标签。
            assert.ok(tags.length >= 4, `${diaryFile} 的标签数量过少，无法支撑 TagMemo 测试`);
            assert.ok(tags.length <= 6, `${diaryFile} 的标签数量过多，不符合精简 Tag 设计`);
            assert.equal(new Set(tags).size, tags.length, `${diaryFile} 的标签不应重复`);
            assert.ok(
                tags.every(tag => tag.length <= 12),
                `${diaryFile} 存在过长标签，不符合微言大义的 Tag 风格`
            );
        }
    }
});

test('TagMemo 相关样本必须显式声明标签锚点，并能在目标日记标签中命中', () => {
    const evalItems = readEvalSet().filter(item => item.mode.includes('TagMemo'));
    const notebookIndex = buildNotebookIndex();

    assert.ok(evalItems.length > 0, '评测集中至少应包含一个 TagMemo 样本');

    for (const item of evalItems) {
        const tagTargets = resolveTagTargets(item);
        assert.ok(tagTargets.length > 0, `${item.id} 必须提供 tag_targets，避免用正文长句替代标签锚点`);

        for (const notebookName of item.expected_diaries) {
            const entries = notebookIndex.get(notebookName) || [];
            assert.ok(entries.length > 0, `${item.id} 期望知识库 ${notebookName} 必须存在`);

            const matchedEntry = entries.find(entry =>
                tagTargets.every(target => entry.tagLine.includes(target))
            );

            assert.ok(
                matchedEntry,
                `${item.id} 的 tag_targets 必须完整落在 ${notebookName} 的单篇日记标签中`
            );

            for (const negative of item.hard_negative || []) {
                assert.ok(
                    !matchedEntry.tagLine.includes(negative),
                    `${item.id} 命中的标签中不应混入硬负例 ${negative}`
                );
            }
        }
    }
});

test('门控负样本的错误主题不应泄漏到对应知识库标签中', () => {
    const evalItems = readEvalSet().filter(item => item.gate_expect === false);
    const notebookIndex = buildNotebookIndex();

    assert.ok(evalItems.length > 0, '评测集中至少应包含一个门控负样本');

    for (const item of evalItems) {
        for (const notebookName of item.expected_diaries) {
            const entries = notebookIndex.get(notebookName) || [];
            const combinedTags = entries.map(entry => entry.tagLine).join('\n');

            for (const negative of item.hard_negative || []) {
                assert.ok(
                    !combinedTags.includes(negative),
                    `${item.id} 对应知识库 ${notebookName} 不应包含误放行主题 ${negative}`
                );
            }
        }
    }
});
