'use strict';

const fsp = require('fs').promises;
const fs = require('fs');
const path = require('path');

/**
 * 铸造运行产物存档（断点续跑的事实源）。
 * 设计：docs/design/2026-10-10_专家铸造炉.md §2.5、§3.2。
 *
 * Agent/forge/runs/<jobId>/
 * ├── run.json              # job 上下文（需求、预算、专家名）
 * └── steps/<stepId>.json   # 步骤完成标记（产物落盘即视为完成）
 *
 * 其余子目录（raw/<subskillId>/、exams/）由各步骤实现自行创建，
 * 本模块只管完成标记与 job 上下文的读写。
 */

async function writeJsonAtomic(filePath, payload) {
    await fsp.mkdir(path.dirname(filePath), { recursive: true });
    const tmpPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
    await fsp.writeFile(tmpPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
    await fsp.rename(tmpPath, filePath);
}

async function readJsonOrNull(filePath) {
    try {
        return JSON.parse(await fsp.readFile(filePath, 'utf8'));
    } catch (error) {
        if (error.code === 'ENOENT') {
            return null;
        }
        throw error;
    }
}

function createRunStore({ baseDir }) {
    if (!baseDir || typeof baseDir !== 'string') {
        throw new Error('[ForgeRunStore] baseDir 必须是非空字符串');
    }
    const runsRoot = path.join(baseDir, 'runs');

    const runDir = (jobId) => path.join(runsRoot, jobId);
    const runFile = (jobId) => path.join(runDir(jobId), 'run.json');
    const stepsDir = (jobId) => path.join(runDir(jobId), 'steps');
    const stepFile = (jobId, stepId) => path.join(stepsDir(jobId), `${stepId}.json`);

    return {
        runsRoot,
        runDir,
        async initRun(record) {
            const existing = await readJsonOrNull(runFile(record.jobId));
            if (existing) {
                const error = new Error(`[ForgeRunStore] run 已存在：${record.jobId}`);
                error.code = 'FORGE_RUN_EXISTS';
                error.status = 409;
                throw error;
            }
            const now = new Date().toISOString();
            const payload = { ...record, createdAt: now, updatedAt: now };
            await writeJsonAtomic(runFile(record.jobId), payload);
            return payload;
        },
        async readRun(jobId) {
            return readJsonOrNull(runFile(jobId));
        },
        async updateRun(jobId, patch) {
            const existing = await readJsonOrNull(runFile(jobId));
            if (!existing) {
                return null;
            }
            const next = { ...existing, ...patch, updatedAt: new Date().toISOString() };
            await writeJsonAtomic(runFile(jobId), next);
            return next;
        },
        async markStepComplete(jobId, stepId, marker) {
            const now = new Date().toISOString();
            const payload = { stepId, completedAt: now, ...marker };
            await writeJsonAtomic(stepFile(jobId, stepId), payload);
            return payload;
        },
        async readStepMarker(jobId, stepId) {
            return readJsonOrNull(stepFile(jobId, stepId));
        },
        async scanCompletedSteps(jobId) {
            try {
                const names = await fsp.readdir(stepsDir(jobId));
                return new Set(names.filter((name) => name.endsWith('.json')).map((name) => name.slice(0, -'.json'.length)));
            } catch (error) {
                if (error.code === 'ENOENT') {
                    return new Set();
                }
                throw error;
            }
        },
        async listRunFiles(jobId) {
            const collected = [];
            async function walk(dir, rel) {
                let entries;
                try {
                    entries = await fsp.readdir(dir, { withFileTypes: true });
                } catch (error) {
                    if (error.code === 'ENOENT') {
                        return;
                    }
                    throw error;
                }
                for (const entry of entries) {
                    const relPath = rel ? `${rel}/${entry.name}` : entry.name;
                    if (entry.isDirectory()) {
                        await walk(path.join(dir, entry.name), relPath);
                    } else {
                        const stat = await fsp.stat(path.join(dir, entry.name));
                        collected.push({ path: relPath, bytes: stat.size });
                    }
                }
            }
            await walk(runDir(jobId), '');
            return collected;
        },
        runExists(jobId) {
            return fs.existsSync(runFile(jobId));
        }
    };
}

module.exports = {
    createRunStore
};
