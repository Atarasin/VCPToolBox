'use strict';

const fsp = require('fs').promises;
const fs = require('fs');
const path = require('path');

const { scanTextForSecrets } = require('./secretScan');

/**
 * 知识文件写入器：蒸馏产物 → knowledge/<库名>/（§3.4，D2 混合分流）。
 *
 * - methodology / 体系性内容 → 系列长文档 NN_<主题>.md；
 * - concept / checklist / case / pitfall → 知识卡 K_<subskillId>_<slug>.md，
 *   文件头带出处（红线 4：title/oneLiner/type/subskill/sources[{url,fetchedAt}]/tags）；
 * - 去重合并：同义单元经 LLM mergeInto 指回既有卡，来源取并集
 *   （红线 3：只新增/合并，不删除、不修改既有旧卡正文）；
 * - 全部落盘前过零密钥扫描（红线 2）。
 */

const CARD_PATTERN = /^K_(.+?)_(.+)\.md$/;
const LONGDOC_PATTERN = /^(\d{2})_(.+)\.md$/;

function slugify(text, maxLength = 40) {
    return String(text || '')
        .trim()
        .toLowerCase()
        .replace(/[^\p{L}\p{N}]+/gu, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, maxLength) || 'untitled';
}

function yamlEscape(value) {
    return String(value ?? '').replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function serializeFrontmatter(fields) {
    const lines = ['---'];
    for (const [key, value] of Object.entries(fields)) {
        if (value === null || value === undefined) {
            continue;
        }
        if (Array.isArray(value)) {
            if (value.length === 0) {
                continue;
            }
            if (typeof value[0] === 'object') {
                lines.push(`${key}:`);
                for (const item of value) {
                    const inner = Object.entries(item)
                        .map(([k, v]) => `${k}: ${yamlEscape(v)}`)
                        .join(', ');
                    lines.push(`  - { ${inner} }`);
                }
            } else {
                lines.push(`${key}: [${value.map((item) => yamlEscape(item)).join(', ')}]`);
            }
        } else {
            lines.push(`${key}: ${yamlEscape(value)}`);
        }
    }
    lines.push('---');
    return lines.join('\n');
}

async function assertNoSecrets(text, targetPath) {
    const hits = scanTextForSecrets(text);
    if (hits.length > 0) {
        const error = new Error(`知识文件疑似包含密钥，阻断落盘：${path.basename(String(targetPath))}`);
        error.code = 'FORGE_SECRET_DETECTED';
        error.status = 400;
        error.details = { hits };
        throw error;
    }
}

async function writeAtomic(filePath, content) {
    await fsp.mkdir(path.dirname(filePath), { recursive: true });
    const tmpPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
    await fsp.writeFile(tmpPath, content, 'utf8');
    await fsp.rename(tmpPath, filePath);
}

function listLibraryFiles(libDir) {
    const names = fs.existsSync(libDir) ? fs.readdirSync(libDir) : [];
    const cards = [];
    const longDocs = [];
    for (const name of names) {
        const cardMatch = name.match(CARD_PATTERN);
        if (cardMatch) {
            cards.push({ file: name, subskillId: cardMatch[1], slug: cardMatch[2] });
            continue;
        }
        const docMatch = name.match(LONGDOC_PATTERN);
        if (docMatch) {
            longDocs.push({ file: name, seq: Number(docMatch[1]), slug: docMatch[2] });
        }
    }
    return { cards, longDocs, allNames: names };
}

// 既有卡标题清单（供 LLM mergeInto 判定）。
function readCardTitles(libDir, cards) {
    const titles = [];
    for (const card of cards) {
        try {
            const raw = fs.readFileSync(path.join(libDir, card.file), 'utf8');
            const match = raw.match(/^---\n([\s\S]*?)\n---/);
            const titleField = match ? match[1].match(/^title:\s*(.+)$/m) : null;
            titles.push(titleField ? titleField[1].trim().replace(/^"|"$/g, '') : card.slug);
        } catch {
            // 读取失败按 slug 兜底，不阻断蒸馏。
        }
    }
    return titles;
}

function nextLongDocSequence(longDocs) {
    return (longDocs.reduce((max, doc) => Math.max(max, doc.seq), 0) || 0) + 1;
}

function uniqueFileName(dir, baseName, ext, existingNames) {
    let candidate = `${baseName}${ext}`;
    let counter = 2;
    const taken = new Set(existingNames);
    while (taken.has(candidate)) {
        candidate = `${baseName}-${counter}${ext}`;
        counter += 1;
    }
    return candidate;
}

function createKnowledgeWriter({ libraryDir }) {
    const libDir = libraryDir;

    return {
        libraryDir: libDir,
        listCards() {
            const { cards } = listLibraryFiles(libDir);
            return readCardTitles(libDir, cards).map((title, index) => ({
                title,
                file: cards[index].file
            }));
        },
        writeCard(unit, { subskillId, fetchedAtByUrl = null, defaultFetchedAt = null }) {
            return (async () => {
                const { allNames } = listLibraryFiles(libDir);
                const baseName = `K_${subskillId}_${slugify(unit.title)}`;
                const fileName = uniqueFileName(libDir, baseName, '.md', allNames);
                const filePath = path.join(libDir, fileName);
                const resolveFetchedAt = (url) => fetchedAtByUrl?.get(url) || defaultFetchedAt || new Date().toISOString();
                const frontmatter = serializeFrontmatter({
                    title: unit.title,
                    oneLiner: unit.oneLiner,
                    type: unit.type,
                    subskill: subskillId,
                    sources: (unit.sourceUrls || []).map((url) => ({ url, fetchedAt: resolveFetchedAt(url) })),
                    tags: unit.tags || []
                });
                const body = `${frontmatter}\n\n${String(unit.content || '').trim()}\n`;
                await assertNoSecrets(body, filePath);
                await writeAtomic(filePath, body);
                return { fileName, kind: 'card' };
            })();
        },
        writeLongDoc(unit, { fetchedAtByUrl = null } = {}) {
            return (async () => {
                const { longDocs, allNames } = listLibraryFiles(libDir);
                const seq = nextLongDocSequence(longDocs);
                const fileName = `${String(seq).padStart(2, '0')}_${slugify(unit.title, 24)}.md`;
                const unique = uniqueFileName(libDir, fileName.replace(/\.md$/, ''), '.md', allNames);
                const filePath = path.join(libDir, unique);
                const fetchedTimes = (unit.sourceUrls || []).map((url) => fetchedAtByUrl?.get(url) || new Date().toISOString());
                const header = `# ${unit.title}\n\n> ${unit.oneLiner}\n> 来源：${(unit.sourceUrls || []).join(' ; ')}\n> 抓取时间：${[...new Set(fetchedTimes)].join(' ; ')}\n\n`;
                const body = `${header}${String(unit.content || '').trim()}\n`;
                await assertNoSecrets(body, filePath);
                await writeAtomic(filePath, body);
                return { fileName: unique, kind: 'longdoc', seq };
            })();
        },
        // 红线 3：合并 = 仅向既有卡 frontmatter.sources 追加并集来源，正文不动。
        mergeSources(cardFile, urls, { fetchedAtByUrl = null, defaultFetchedAt = null }) {
            return (async () => {
                const filePath = path.join(libDir, cardFile);
                const raw = await fsp.readFile(filePath, 'utf8');
                const match = raw.match(/^---\n([\s\S]*?)\n---\n?/);
                if (!match) {
                    const error = new Error(`知识卡缺少 frontmatter，无法合并来源：${cardFile}`);
                    error.code = 'FORGE_CARD_MERGE_FAILED';
                    error.status = 500;
                    throw error;
                }
                const sourcesBlock = match[1].match(/^sources:\n((?:  - .*\n?)+)/m);
                // 保留既有来源的原始 fetchedAt（红线 3：合并不改写旧卡的溯源时间）。
                const existing = new Map();
                if (sourcesBlock) {
                    for (const line of sourcesBlock[1].split('\n')) {
                        const pair = line.match(/url:\s*"?(.+?)"?\s*,\s*fetchedAt:\s*"?(.+?)"?\s*(?:,|$)/);
                        if (pair) {
                            existing.set(pair[1].trim(), pair[2].trim());
                        } else {
                            const url = line.match(/url:\s*"?(.+?)"?\s*(?:,|$)/);
                            if (url) {
                                existing.set(url[1].trim(), defaultFetchedAt || new Date().toISOString());
                            }
                        }
                    }
                }
                const added = [];
                for (const url of urls) {
                    if (!existing.has(url)) {
                        const fetchedAt = fetchedAtByUrl?.get(url) || defaultFetchedAt || new Date().toISOString();
                        added.push({ url, fetchedAt });
                        existing.set(url, fetchedAt);
                    }
                }
                if (added.length === 0) {
                    return { cardFile, addedCount: 0 };
                }
                const sourcesLines = Array.from(existing.entries())
                    .map(([url, fetchedAt]) => `  - { url: ${yamlEscape(url)}, fetchedAt: ${yamlEscape(fetchedAt)} }`)
                    .join('\n');
                let nextFrontmatter = match[1];
                if (sourcesBlock) {
                    nextFrontmatter = nextFrontmatter.replace(sourcesBlock[0], `sources:\n${sourcesLines}\n`);
                } else {
                    nextFrontmatter = `${nextFrontmatter}\nsources:\n${sourcesLines}`;
                }
                const next = `---\n${nextFrontmatter}\n---\n${raw.slice(match[0].length)}`;
                await assertNoSecrets(next, filePath);
                await writeAtomic(filePath, next);
                return { cardFile, addedCount: added.length };
            })();
        }
    };
}

module.exports = {
    CARD_PATTERN,
    LONGDOC_PATTERN,
    slugify,
    serializeFrontmatter,
    createKnowledgeWriter,
    listLibraryFiles
};
