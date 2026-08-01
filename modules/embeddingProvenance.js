'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

function sha256(value) {
    return `sha256:${crypto.createHash('sha256').update(value).digest('hex')}`;
}

function stableValue(value) {
    if (Array.isArray(value)) return value.map(stableValue);
    if (!value || typeof value !== 'object') return value;
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, stableValue(value[key])]));
}

function normalizeApiUrl(value) {
    if (!value) return '';
    try {
        const url = new URL(String(value));
        url.hash = '';
        url.search = '';
        url.pathname = url.pathname.replace(/\/+$/, '');
        return url.toString().replace(/\/$/, '');
    } catch (_) {
        return String(value).trim().replace(/\/+$/, '');
    }
}

function endpointFingerprint({ apiUrl, model, routeVersion = 'openai-embeddings-v1' }) {
    return sha256(JSON.stringify(stableValue({
        apiBase: normalizeApiUrl(apiUrl),
        model: model || '',
        routeVersion
    })));
}

function splitList(value, fallback = []) {
    const raw = value == null || value === '' ? fallback.join(',') : String(value);
    return raw.split(/[,，]/).map(item => item.trim()).filter(Boolean);
}

function normalizeExt(value) {
    const ext = String(value || '').trim().toLowerCase();
    return ext && (ext.startsWith('.') ? ext : `.${ext}`);
}

function resolveColdRules(source = {}) {
    return {
        extensions: splitList(source.TDB_KNOWLEDGE_EXTENSIONS ?? source.extensions, ['.md', '.txt', '.json', '.html'])
            .map(normalizeExt).filter(Boolean),
        excludeFolders: splitList(source.TDB_KNOWLEDGE_EXCLUDE_FOLDERS ?? source.excludeFolders, ['TDBdocs']),
        ignorePrefixes: splitList(source.TDB_KNOWLEDGE_IGNORE_PREFIXES ?? source.ignorePrefixes),
        ignoreSuffixes: splitList(source.TDB_KNOWLEDGE_IGNORE_SUFFIXES ?? source.ignoreSuffixes)
    };
}

function isColdFileIndexable(rootPath, absolute, rules) {
    if (!rules.extensions.includes(normalizeExt(path.extname(absolute)))) return false;
    const relative = path.relative(rootPath, absolute);
    const parts = relative.split(path.sep).filter(Boolean);
    const library = parts.length > 1 ? parts[0] : 'Root';
    const fileName = path.basename(absolute);
    if (rules.excludeFolders.includes(library)) return false;
    if (rules.ignorePrefixes.some(prefix => library.startsWith(prefix) || fileName.startsWith(prefix))) return false;
    if (rules.ignoreSuffixes.some(suffix => library.endsWith(suffix) || fileName.endsWith(suffix))) return false;
    return true;
}

function coldCorpusFingerprint(rootPath, source = {}) {
    const absoluteRoot = path.resolve(rootPath);
    if (!fs.existsSync(absoluteRoot)) return { fingerprint: null, files: [] };
    const rules = resolveColdRules(source);
    const files = [];
    const walk = directory => {
        for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
            const absolute = path.join(directory, entry.name);
            if (entry.isDirectory()) {
                walk(absolute);
            } else if (entry.isFile() && isColdFileIndexable(absoluteRoot, absolute, rules)) {
                files.push({
                    path: path.relative(absoluteRoot, absolute).split(path.sep).join('/'),
                    sha256: sha256(fs.readFileSync(absolute))
                });
            }
        }
    };
    walk(absoluteRoot);
    files.sort((left, right) => left.path.localeCompare(right.path));
    return {
        fingerprint: files.length ? sha256(files.map(file => `${file.path}:${file.sha256}`).join('\n')) : null,
        files
    };
}

module.exports = {
    sha256,
    stableValue,
    normalizeApiUrl,
    endpointFingerprint,
    splitList,
    normalizeExt,
    resolveColdRules,
    isColdFileIndexable,
    coldCorpusFingerprint
};
