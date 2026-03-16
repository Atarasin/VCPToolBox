const axios = require('axios');
const crypto = require('crypto');

function parseScheduleHours(value) {
    const raw = String(value || '8,14,20')
        .split(',')
        .map(item => Number.parseInt(item.trim(), 10))
        .filter(item => Number.isFinite(item) && item >= 0 && item <= 23);
    const unique = [...new Set(raw)];
    if (unique.length === 0) return [8, 14, 20];
    return unique.sort((a, b) => a - b);
}

function computeUpcomingRuns(now, hours, days = 1) {
    const result = [];
    const targetDays = Math.max(1, Math.min(7, Number.parseInt(days, 10) || 1));
    for (let d = 0; d < targetDays; d += 1) {
        for (const hour of hours) {
            const time = new Date(now);
            time.setSeconds(0, 0);
            time.setHours(hour, 0, 0, 0);
            time.setDate(time.getDate() + d);
            if (time.getTime() <= now.getTime()) continue;
            result.push(time);
        }
    }
    return result.sort((a, b) => a.getTime() - b.getTime());
}

async function bootstrapSchedules(options = {}) {
    const config = options.config || {};
    const port = config.PORT || process.env.PORT || '8080';
    const key = config.Key || process.env.Key || process.env.KEY;
    if (!key) {
        throw new Error('缺少 Key，无法调用 /v1/schedule_task');
    }
    const hours = parseScheduleHours(
        config.WECHAT_PUBLISHER_SCHEDULE_HOURS || process.env.WECHAT_PUBLISHER_SCHEDULE_HOURS || '8,14,20'
    );
    const now = options.now || new Date();
    const runs = computeUpcomingRuns(now, hours, options.days);
    const url = `http://127.0.0.1:${port}/v1/schedule_task`;
    const created = [];
    for (const runTime of runs) {
        const taskId = `wechat_publisher_${runTime.getTime()}_${crypto.randomBytes(3).toString('hex')}`;
        const payload = {
            schedule_time: runTime.toISOString(),
            task_id: taskId,
            tool_call: {
                tool_name: 'WeChatPublisher',
                arguments: {
                    command: 'RunWorkflow'
                }
            }
        };
        const response = await axios.post(url, payload, {
            headers: {
                Authorization: `Bearer ${key}`,
                'Content-Type': 'application/json'
            },
            timeout: 15000
        });
        const data = response && response.data ? response.data : {};
        if (data.status !== 'success') {
            throw new Error(data.error || '创建调度失败');
        }
        created.push({
            task_id: taskId,
            schedule_time: runTime.toISOString()
        });
    }
    return {
        total: created.length,
        runs: created,
        hours
    };
}

module.exports = {
    parseScheduleHours,
    computeUpcomingRuns,
    bootstrapSchedules
};
