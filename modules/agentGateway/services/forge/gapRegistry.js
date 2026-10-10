'use strict';

const fs = require('fs');
const fsp = require('fs').promises;
const path = require('path');

/**
 * 知识缺口登记与学习档案（§3.8）。
 *
 * - Agent/forge/<name>/gaps.json：缺口 {id, ts, status: open|closed, subskillId,
 *   question, whyInsufficient, closedAt?}——只追加/关闭，不删除（红线 3）；
 * - Agent/forge/<name>/learning-history.jsonl：学习档案逐行追加
 *   {ts, trigger, scope, sources, distilledFiles}——读过什么、学过什么、
 *   为什么学，全部可查；只追加。
 */

async function readJsonArray(filePath) {
    try {
        const parsed = JSON.parse(await fsp.readFile(filePath, 'utf8'));
        return Array.isArray(parsed) ? parsed : [];
    } catch (error) {
        if (error.code === 'ENOENT') {
            return [];
        }
        throw error;
    }
}

async function writeJsonAtomic(filePath, payload) {
    await fsp.mkdir(path.dirname(filePath), { recursive: true });
    const tmpPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
    await fsp.writeFile(tmpPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
    await fsp.rename(tmpPath, filePath);
}

function createGapRegistry({ baseDir }) {
    const gapsFile = (expertName) => path.join(baseDir, expertName, 'gaps.json');
    const historyFile = (expertName) => path.join(baseDir, expertName, 'learning-history.jsonl');

    return {
        async appendGap({ expertName, subskillId, question, whyInsufficient }) {
            const gaps = await readJsonArray(gapsFile(expertName));
            const gap = {
                id: `gap_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
                ts: new Date().toISOString(),
                status: 'open',
                subskillId,
                question,
                whyInsufficient
            };
            gaps.push(gap);
            await writeJsonAtomic(gapsFile(expertName), gaps);
            return gap;
        },
        async listOpenGaps(expertName) {
            const gaps = await readJsonArray(gapsFile(expertName));
            return gaps.filter((gap) => gap?.status === 'open');
        },
        // 进修完成后关闭相关 subskill 的 open 缺口（不删除历史条目）。
        async closeGaps(expertName, subskillIds) {
            const ids = new Set(subskillIds);
            const gaps = await readJsonArray(gapsFile(expertName));
            let closed = 0;
            for (const gap of gaps) {
                if (gap?.status === 'open' && (!ids.size || ids.has(gap.subskillId))) {
                    gap.status = 'closed';
                    gap.closedAt = new Date().toISOString();
                    closed += 1;
                }
            }
            if (closed > 0) {
                await writeJsonAtomic(gapsFile(expertName), gaps);
            }
            return closed;
        },
        async appendLearningHistory(expertName, entry) {
            await fsp.mkdir(path.dirname(historyFile(expertName)), { recursive: true });
            await fsp.appendFile(historyFile(expertName), `${JSON.stringify({ ts: new Date().toISOString(), ...entry })}\n`, 'utf8');
        },
        async lastLearningAt(expertName) {
            try {
                const raw = await fsp.readFile(historyFile(expertName), 'utf8');
                const lines = raw.trim().split('\n').filter(Boolean);
                if (lines.length === 0) {
                    return null;
                }
                const last = JSON.parse(lines[lines.length - 1]);
                return last.ts || null;
            } catch (error) {
                if (error.code === 'ENOENT') {
                    return null;
                }
                throw error;
            }
        }
    };
}

function listExpertNames({ baseDir }) {
    if (!fs.existsSync(baseDir)) {
        return [];
    }
    return fs.readdirSync(baseDir, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
        .filter((name) => fs.existsSync(path.join(baseDir, name, 'gaps.json')) ||
            fs.existsSync(path.join(baseDir, 'blueprints', `${name}.json`)))
        .sort();
}

module.exports = {
    createGapRegistry,
    listExpertNames
};
