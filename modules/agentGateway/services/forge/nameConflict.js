'use strict';

const fs = require('fs');
const path = require('path');

/**
 * 专家重名检测（红线 3 的共享工具，独立成模块避免 steps↔synthesize 循环依赖）。
 */

// 红线 3：重名冲突不直接失败，而是交回编排层转 pending_confirm 暂停待人工确认。
class ForgeNameConflictError extends Error {
    constructor(draft, conflicts) {
        super(`专家名与既有 agent/文件冲突：${conflicts.map((c) => c.kind === 'agent' ? c.name : c.file).join('、')}`);
        this.name = 'ForgeNameConflictError';
        this.code = 'FORGE_NAME_CONFLICT';
        this.status = 409;
        this.details = { conflicts, draft };
    }
}

async function listExistingAgentNames(agentDirectoryPort) {
    if (!agentDirectoryPort || typeof agentDirectoryPort.listAgents !== 'function') {
        return [];
    }
    try {
        if (typeof agentDirectoryPort.ensureLoaded === 'function') {
            await agentDirectoryPort.ensureLoaded();
        }
        return agentDirectoryPort.listAgents().map((agent) => agent?.alias).filter(Boolean);
    } catch {
        return [];
    }
}

// §3.1 / 红线 3：与 agent_map 现有条目或现有 Agent/ 文件的重名冲突。
// baseDir = Agent/forge，其父目录即 Agent/ 根；同名 .txt 视为冲突。
function detectNameConflicts(name, { baseDir, existingAgentNames }) {
    const conflicts = [];
    if (existingAgentNames.includes(name)) {
        conflicts.push({ kind: 'agent', name });
    }
    const agentRoot = path.join(baseDir, '..');
    const candidates = [path.join(agentRoot, `${name}.txt`), path.join(baseDir, `${name}.txt`)];
    for (const candidate of candidates) {
        if (fs.existsSync(candidate)) {
            conflicts.push({ kind: 'file', file: path.relative(agentRoot, candidate) });
        }
    }
    return conflicts;
}

module.exports = {
    ForgeNameConflictError,
    detectNameConflicts,
    listExistingAgentNames
};
