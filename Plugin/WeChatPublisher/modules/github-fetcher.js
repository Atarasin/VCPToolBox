const fs = require('fs').promises;
const path = require('path');
const { execFile } = require('child_process');
const util = require('util');

const execFileAsync = util.promisify(execFile);

function toIsoDate(inputDate) {
    return inputDate.toISOString().slice(0, 10);
}

function buildSearchQueries(now = new Date()) {
    const dayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    const date = toIsoDate(dayAgo);
    return [
        {
            label: 'created',
            sort: 'stars',
            query: `topic:ai OR topic:machine-learning OR topic:llm created:>${date} stars:>50`
        },
        {
            label: 'updated',
            sort: 'updated',
            query: `topic:ai pushed:>${date} stars:>500`
        }
    ];
}

async function runGhSearch(query, sort, limit) {
    const args = [
        'search',
        'repos',
        query,
        '--sort',
        sort,
        '--order',
        'desc',
        '--limit',
        String(limit),
        '--json',
        'fullName,name,description,url,stargazersCount,forksCount,pushedAt,createdAt,language,owner'
    ];
    const { stdout } = await execFileAsync('gh', args, { maxBuffer: 1024 * 1024 * 8 });
    let parsed;
    try {
        parsed = JSON.parse(stdout || '[]');
    } catch (error) {
        throw new Error(`gh 输出 JSON 解析失败: ${error.message}`);
    }
    if (!Array.isArray(parsed)) {
        throw new Error('gh 输出格式异常，期望数组');
    }
    return parsed;
}

function normalizeRepo(repo) {
    const ownerValue = repo.owner && typeof repo.owner === 'object' ? repo.owner.login : repo.owner;
    return {
        full_name: repo.fullName || repo.nameWithOwner || '',
        name: repo.name || '',
        description: repo.description || '',
        url: repo.url || '',
        stars: Number(repo.stargazersCount || repo.stargazerCount || 0),
        forks: Number(repo.forksCount || repo.forkCount || 0),
        created_at: repo.createdAt || '',
        pushed_at: repo.pushedAt || '',
        language: repo.language || (repo.primaryLanguage && repo.primaryLanguage.name ? repo.primaryLanguage.name : ''),
        owner: ownerValue || ''
    };
}

function mergeAndDeduplicate(repoGroups) {
    const map = new Map();
    for (const repos of repoGroups) {
        for (const repo of repos) {
            if (!repo.full_name) continue;
            const existing = map.get(repo.full_name);
            if (!existing || repo.stars > existing.stars) {
                map.set(repo.full_name, repo);
            }
        }
    }
    return Array.from(map.values()).sort((a, b) => b.stars - a.stars);
}

async function readJsonOrDefault(filePath, fallbackValue) {
    try {
        const raw = await fs.readFile(filePath, 'utf-8');
        const parsed = JSON.parse(raw);
        return parsed;
    } catch {
        return fallbackValue;
    }
}

function filterByDeduplicateWindow(repos, dedupeMap, now, force) {
    const nowTs = now.getTime();
    const windowMs = 7 * 24 * 60 * 60 * 1000;
    const accepted = [];
    for (const repo of repos) {
        const lastSeen = Number(dedupeMap[repo.full_name] || 0);
        const inWindow = Number.isFinite(lastSeen) && nowTs - lastSeen < windowMs;
        if (force || !inWindow) {
            accepted.push(repo);
            dedupeMap[repo.full_name] = nowTs;
        }
    }
    return accepted;
}

async function ensureDir(dirPath) {
    await fs.mkdir(dirPath, { recursive: true });
}

async function fetchGithubCorpus(options = {}) {
    const now = options.now || new Date();
    const force = Boolean(options.force);
    const limit = Number.isFinite(options.limit) ? options.limit : 20;
    const pluginRoot = options.pluginRoot || path.join(__dirname, '..');
    const logDir = path.join(pluginRoot, 'data', 'logs');
    const outputDir = path.join(pluginRoot, 'data', 'output');
    await ensureDir(logDir);
    await ensureDir(outputDir);

    const queries = buildSearchQueries(now);
    const rawGroups = [];
    for (const query of queries) {
        const rows = await runGhSearch(query.query, query.sort, limit);
        rawGroups.push(rows.map(normalizeRepo));
    }

    const merged = mergeAndDeduplicate(rawGroups);
    const dedupePath = path.join(logDir, 'dedupe.json');
    const dedupeMap = await readJsonOrDefault(dedupePath, {});
    const filtered = filterByDeduplicateWindow(merged, dedupeMap, now, force);
    await fs.writeFile(dedupePath, JSON.stringify(dedupeMap, null, 2), 'utf-8');

    const timestamp = now.toISOString().replace(/[:.]/g, '-');
    const snapshotPath = path.join(outputDir, `stage1-corpus-${timestamp}.json`);
    await fs.writeFile(
        snapshotPath,
        JSON.stringify(
            {
                fetched_at: now.toISOString(),
                total_raw: merged.length,
                total_selected: filtered.length,
                repos: filtered
            },
            null,
            2
        ),
        'utf-8'
    );

    return {
        fetchedAt: now.toISOString(),
        totalRaw: merged.length,
        totalSelected: filtered.length,
        repos: filtered,
        snapshotPath
    };
}

module.exports = {
    fetchGithubCorpus,
    buildSearchQueries,
    normalizeRepo,
    mergeAndDeduplicate,
    filterByDeduplicateWindow
};
