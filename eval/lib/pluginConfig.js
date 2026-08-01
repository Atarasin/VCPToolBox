'use strict';

/**
 * 把评测需要的插件侧配置装进 Plugin/RAGDiaryPlugin/。
 *
 * 为什么必须动这两个文件：
 *
 *   rag_tags.json        —— 仅安装影响库名向量的 tags/description 基础定义；模型相关阈值
 *                           由当前 profile 的 RAG_GATE_CONFIG_PATH 只读覆盖。
 *   semantic_groups.json —— ::Group 的组词表。文件里没有对应组时，
 *                           detectAndActivateGroups 返回空 Map，查询向量原样返回，
 *                           ::Group 静默变成 no-op —— 不报错、不告警。
 *
 * 两个路径都硬编码在 `path.join(__dirname, ...)`（SemanticGroupManager.js:14、
 * RAGDiaryPlugin.js:162），没有环境变量可以改指向，所以只能就地合并。
 *
 * 安全约束（这是用户的真实配置文件，不是评测的私产）：
 *   1. **只增不改**：只写入评测自己的命名空间键，绝不修改或删除已有条目
 *   2. 首次写入前留一份备份
 *   3. 提供 uninstall 反向操作，只移除评测键
 */

const fs = require('fs');
const path = require('path');

const { PROJECT_ROOT } = require('./profile');
const { loadSpec } = require('./corpusBuild');

const PLUGIN_DIR = path.join(PROJECT_ROOT, 'Plugin', 'RAGDiaryPlugin');
const RAG_TAGS = path.join(PLUGIN_DIR, 'rag_tags.json');
const TDB_TAGS = path.join(PLUGIN_DIR, 'tdb_tags.json');
const SEMANTIC_GROUPS = path.join(PLUGIN_DIR, 'semantic_groups.json');
// SemanticGroupManager.initialize() 第一步就是 synchronizeFromEditFile()：
// 只要 .edit.json 存在，它就用 edit 的**组集合**覆盖主文件（只保留主文件里的 vector_id 等元数据）。
// 也就是说只写主文件的话，评测组会在下一次初始化时被静默抹掉 —— 已经踩过一次。
// 因此两个文件都要写。
const SEMANTIC_GROUPS_EDIT = path.join(PLUGIN_DIR, 'semantic_groups.edit.json');

function readJsonSafe(filePath, fallback) {
    try {
        const text = fs.readFileSync(filePath, 'utf-8').trim();
        return text ? JSON.parse(text) : fallback;
    } catch (_) {
        return fallback;
    }
}

function backupOnce(filePath) {
    if (!fs.existsSync(filePath)) return null;
    const backup = `${filePath}.eval-backup`;
    if (fs.existsSync(backup)) return backup;   // 只备份一次，保住最原始的那份
    fs.copyFileSync(filePath, backup);
    return backup;
}

/** 评测拥有的键 —— uninstall 时只动这些。 */
function evalOwnedKeys() {
    const { books } = loadSpec();
    return {
        ragTags: Object.values(books.books).map(b => b.folder),
        tdbTags: ['VCP知识'],
        groups: Object.keys(books.semanticGroups || {})
    };
}

/**
 * 装入评测配置。
 * @returns {{added:string[], updated:string[], unchanged:string[], backups:string[]}}
 */
function install() {
    const { books } = loadSpec();
    const report = { added: [], updated: [], unchanged: [], backups: [] };

    // ── rag_tags.json ───────────────────────────────────────────
    const ragTags = readJsonSafe(RAG_TAGS, {});
    let ragTagsChanged = false;
    for (const book of Object.values(books.books)) {
        const desired = {
            tags: book.ragTags || [],
            description: book.description || ''
        };
        const existing = ragTags[book.folder];
        const same = existing
            && JSON.stringify(existing.tags || []) === JSON.stringify(desired.tags)
            && (existing.description || '') === desired.description;
        if (same) {
            report.unchanged.push(`rag_tags:${book.folder}`);
            continue;
        }
        if (existing) report.updated.push(`rag_tags:${book.folder}`);
        else report.added.push(`rag_tags:${book.folder}`);
        ragTags[book.folder] = { ...existing, ...desired };
        ragTagsChanged = true;
    }
    if (ragTagsChanged) {
        const b = backupOnce(RAG_TAGS);
        if (b) report.backups.push(path.relative(PROJECT_ROOT, b));
        fs.writeFileSync(RAG_TAGS, JSON.stringify(ragTags, null, 2), 'utf-8');
    }

    // ── tdb_tags.json：只安装冷库向量定义，不携带模型阈值 ───────
    const tdbTags = readJsonSafe(TDB_TAGS, {});
    const coldDesired = {
        tags: ['VCP系统', '插件开发', '知识库'],
        description: 'VCP 系统、插件生态与技术文档冷知识库'
    };
    const coldExisting = tdbTags['VCP知识'];
    if (!coldExisting
        || JSON.stringify(coldExisting.tags || []) !== JSON.stringify(coldDesired.tags)
        || (coldExisting.description || '') !== coldDesired.description) {
        if (coldExisting) report.updated.push('tdb_tags:VCP知识');
        else report.added.push('tdb_tags:VCP知识');
        tdbTags['VCP知识'] = { ...coldExisting, ...coldDesired };
        const b = backupOnce(TDB_TAGS);
        if (b) report.backups.push(path.relative(PROJECT_ROOT, b));
        fs.writeFileSync(TDB_TAGS, JSON.stringify(tdbTags, null, 2), 'utf-8');
    } else {
        report.unchanged.push('tdb_tags:VCP知识');
    }

    // ── semantic_groups.json（主文件 + .edit.json）────────────────
    const desiredGroup = group => ({
        words: group.words,
        auto_learned: [],
        weight: group.weight ?? 1,
        last_activated: null,
        activation_count: 0,
        // 不预置 vector_id / words_hash：让 SemanticGroupManager 在初始化时自己算 embedding
        // 并落盘。预置一个对不上的 hash 反而会让它删掉向量文件重来。
        vector_id: null,
        words_hash: null
    });

    const writeGroupsInto = (filePath, label) => {
        // .edit.json 不存在就不要凭空造一个 —— 它一旦存在就会成为组集合的唯一真相，
        // 平白引入一个用户没有的文件是过度侵入。
        if (filePath === SEMANTIC_GROUPS_EDIT && !fs.existsSync(filePath)) return;

        const file = readJsonSafe(filePath, { config: {}, groups: {} });
        if (!file.groups) file.groups = {};
        let changed = false;

        for (const [name, group] of Object.entries(books.semanticGroups || {})) {
            const existing = file.groups[name];
            // 词表一致就不动：改词会让 words_hash 变化，SemanticGroupManager 会删掉旧向量
            // 文件并重新调 embedding API，没必要每次 build 都折腾一遍
            const sameWords = existing
                && JSON.stringify(existing.words || []) === JSON.stringify(group.words)
                && existing.weight === (group.weight ?? 1);
            if (sameWords) {
                report.unchanged.push(`${label}:${name}`);
                continue;
            }
            if (existing) report.updated.push(`${label}:${name}`);
            else report.added.push(`${label}:${name}`);
            // 主文件里若已有 vector_id 就保留，避免无谓地重算向量
            file.groups[name] = existing?.vector_id
                ? { ...desiredGroup(group), vector_id: existing.vector_id, words_hash: existing.words_hash }
                : desiredGroup(group);
            changed = true;
        }

        if (changed) {
            const b = backupOnce(filePath);
            if (b) report.backups.push(path.relative(PROJECT_ROOT, b));
            fs.writeFileSync(filePath, JSON.stringify(file, null, 2), 'utf-8');
        }
    };

    writeGroupsInto(SEMANTIC_GROUPS, 'group');
    writeGroupsInto(SEMANTIC_GROUPS_EDIT, 'group.edit');

    return report;
}

/** 只移除评测自己的键，保留用户原有条目。 */
function uninstall() {
    const owned = evalOwnedKeys();
    const removed = [];

    const ragTags = readJsonSafe(RAG_TAGS, {});
    let ragChanged = false;
    for (const key of owned.ragTags) {
        if (ragTags[key]) { delete ragTags[key]; removed.push(`rag_tags:${key}`); ragChanged = true; }
    }
    if (ragChanged) fs.writeFileSync(RAG_TAGS, JSON.stringify(ragTags, null, 2), 'utf-8');

    const tdbTags = readJsonSafe(TDB_TAGS, {});
    let tdbChanged = false;
    for (const key of owned.tdbTags) {
        if (tdbTags[key]) { delete tdbTags[key]; removed.push(`tdb_tags:${key}`); tdbChanged = true; }
    }
    if (tdbChanged) fs.writeFileSync(TDB_TAGS, JSON.stringify(tdbTags, null, 2), 'utf-8');

    for (const [filePath, label] of [[SEMANTIC_GROUPS, 'group'], [SEMANTIC_GROUPS_EDIT, 'group.edit']]) {
        if (!fs.existsSync(filePath)) continue;
        const file = readJsonSafe(filePath, { config: {}, groups: {} });
        let changed = false;
        for (const key of owned.groups) {
            if (file.groups?.[key]) { delete file.groups[key]; removed.push(`${label}:${key}`); changed = true; }
        }
        if (changed) fs.writeFileSync(filePath, JSON.stringify(file, null, 2), 'utf-8');
    }

    return { removed };
}

/**
 * 检查评测配置是否已就位。
 * run 之前调用 —— 不然 ::Group 与门控用例会静默失效并给出误导性的失败。
 */
function status() {
    const { books } = loadSpec();
    const ragTags = readJsonSafe(RAG_TAGS, {});
    const groupsFile = readJsonSafe(SEMANTIC_GROUPS, { groups: {} });
    const tdbTags = readJsonSafe(TDB_TAGS, {});
    const editExists = fs.existsSync(SEMANTIC_GROUPS_EDIT);
    const editFile = editExists ? readJsonSafe(SEMANTIC_GROUPS_EDIT, { groups: {} }) : null;

    const missingBooks = Object.values(books.books)
        .filter(b => !ragTags[b.folder])
        .map(b => b.folder);
    // .edit.json 存在时它才是组集合的真相 —— 主文件里有而 edit 里没有的组，
    // 会在下一次 initialize 的同步里被抹掉，等于没装。
    const missingGroups = Object.keys(books.semanticGroups || {})
        .filter(name => !groupsFile.groups?.[name] || (editExists && !editFile.groups?.[name]));

    return {
        ok: missingBooks.length === 0 && missingGroups.length === 0 && Boolean(tdbTags['VCP知识']),
        missingBooks,
        missingGroups,
        missingColdLibraries: tdbTags['VCP知识'] ? [] : ['VCP知识'],
        ragTagsPath: path.relative(PROJECT_ROOT, RAG_TAGS),
        semanticGroupsPath: path.relative(PROJECT_ROOT, SEMANTIC_GROUPS)
    };
}

module.exports = {
    install,
    uninstall,
    status,
    RAG_TAGS,
    TDB_TAGS,
    SEMANTIC_GROUPS,
    SEMANTIC_GROUPS_EDIT
};
