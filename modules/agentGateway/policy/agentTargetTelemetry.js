const { normalizeString } = require('./shared/normalize');

/**
 * 显式 `agentId` 调用比例 telemetry（§5.4 / M3.S2.T2）。
 *
 * 只统计绑定 credential 的直接 agent-scoped MCP 调用：`explicit` 表示客户端
 * 仍显式传 agentId，`boundOmitted` 表示省略并由绑定身份决议。未绑定调用
 * agentId 必填，不计入比例。计数在两个 MCP executor 的 target 决议单点
 * 记录；stdio 独立进程的计数为进程本地。完成迁移后依据该比例评估显式
 * agentId 的废弃时间表。
 */
function createAgentTargetTelemetry() {
    const counters = new Map();

    function record({ surface, outcome }) {
        const normalizedSurface = normalizeString(surface) || 'unknown';
        const normalizedOutcome = outcome === 'explicit' ? 'explicit' : 'boundOmitted';
        const key = `${normalizedSurface}|${normalizedOutcome}`;
        counters.set(key, (counters.get(key) || 0) + 1);
    }

    function snapshot() {
        const totals = { explicit: 0, boundOmitted: 0 };
        const bySurface = {};
        for (const [key, count] of counters.entries()) {
            const [surface, outcome] = key.split('|');
            totals[outcome] += count;
            bySurface[surface] = bySurface[surface] || { explicit: 0, boundOmitted: 0 };
            bySurface[surface][outcome] += count;
        }
        const total = totals.explicit + totals.boundOmitted;
        return {
            totals: {
                ...totals,
                explicitRatio: total > 0 ? totals.explicit / total : null
            },
            bySurface
        };
    }

    function reset() {
        counters.clear();
    }

    return Object.freeze({ record, snapshot, reset });
}

// 进程级默认实例：executor 与 metrics 暴露共享同一份计数。
const defaultAgentTargetTelemetry = createAgentTargetTelemetry();

module.exports = {
    createAgentTargetTelemetry,
    defaultAgentTargetTelemetry
};
