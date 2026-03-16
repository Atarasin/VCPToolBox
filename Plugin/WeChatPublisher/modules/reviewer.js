const fs = require('fs').promises;
const path = require('path');
const axios = require('axios');

function toBoolean(value, defaultValue = false) {
    if (value === undefined || value === null || value === '') return defaultValue;
    if (typeof value === 'boolean') return value;
    const normalized = String(value).trim().toLowerCase();
    return normalized === 'true' || normalized === '1' || normalized === 'yes';
}

function resolveAdminCredential(config = {}) {
    const username =
        config.AdminUsername ||
        config.ADMIN_USERNAME ||
        config.username ||
        process.env.AdminUsername ||
        process.env.ADMIN_USERNAME ||
        process.env.username;
    const password =
        config.AdminPassword ||
        config.ADMIN_PASSWORD ||
        config.password ||
        process.env.AdminPassword ||
        process.env.ADMIN_PASSWORD ||
        process.env.password;
    if (!username || !password) {
        return null;
    }
    return {
        username: String(username),
        password: String(password)
    };
}

function buildReviewMarkdown(draft) {
    const source = draft.source || {};
    const lines = [
        '# 微信发布待审核',
        '',
        '## 草稿信息',
        `- 标题：${draft.title || ''}`,
        `- 草稿ID：${draft.draft_id || ''}`,
        `- 字数：${draft.word_count || 0}`,
        '',
        '## 项目信息',
        `- 项目：${source.full_name || ''}`,
        `- 链接：${source.url || ''}`,
        `- Stars/Forks：${source.stars || 0}/${source.forks || 0}`,
        '',
        '## 正文',
        draft.body || '',
        '',
        '## 审核操作',
        '1. 通过并发布',
        '2. 编辑后发布',
        '3. 驳回重写'
    ];
    return lines.join('\n');
}

async function ensureDir(dirPath) {
    await fs.mkdir(dirPath, { recursive: true });
}

async function appendAuditLog(pluginRoot, item) {
    const logDir = path.join(pluginRoot, 'data', 'logs');
    await ensureDir(logDir);
    const filePath = path.join(logDir, 'review-audit.json');
    let rows = [];
    try {
        const raw = await fs.readFile(filePath, 'utf-8');
        rows = JSON.parse(raw);
        if (!Array.isArray(rows)) rows = [];
    } catch {
        rows = [];
    }
    rows.push(item);
    await fs.writeFile(filePath, JSON.stringify(rows, null, 2), 'utf-8');
}

async function pushReviewMessage(draft, options = {}) {
    if (!draft || typeof draft !== 'object') {
        throw new Error('阶段3需要有效的草稿对象');
    }
    const pluginRoot = options.pluginRoot || path.join(__dirname, '..');
    const config = options.config || {};
    const port = config.PORT || process.env.PORT || '8080';
    const receiveIdType =
        config.WECHAT_PUBLISHER_REVIEW_RECEIVE_ID_TYPE ||
        process.env.WECHAT_PUBLISHER_REVIEW_RECEIVE_ID_TYPE ||
        'chat_id';
    const receiveId =
        options.receiveId ||
        config.WECHAT_PUBLISHER_REVIEW_RECEIVE_ID ||
        process.env.WECHAT_PUBLISHER_REVIEW_RECEIVE_ID;
    if (!receiveId) {
        throw new Error('缺少 WECHAT_PUBLISHER_REVIEW_RECEIVE_ID，无法推送审核消息');
    }

    const dryRun = toBoolean(options.dryRun, false);
    const reviewText = buildReviewMarkdown(draft);
    const auditItem = {
        draft_id: draft.draft_id,
        pushed_at: new Date().toISOString(),
        receiveIdType,
        receiveId,
        dryRun
    };

    if (dryRun) {
        await appendAuditLog(pluginRoot, { ...auditItem, success: true, dry_run_payload: reviewText.slice(0, 2000) });
        return {
            success: true,
            dryRun: true,
            receiveIdType,
            receiveId
        };
    }

    const credential = resolveAdminCredential(config);
    const url = `http://127.0.0.1:${port}/admin_api/feishu-bridge/push`;
    const payload = {
        receiveIdType,
        receiveId,
        messageType: 'markdown',
        text: reviewText
    };
    if (!credential) {
        throw new Error('缺少 AdminUsername/AdminPassword，无法调用 FeishuBridge push 接口');
    }
    const basic = Buffer.from(`${credential.username}:${credential.password}`).toString('base64');
    const response = await axios.post(url, payload, {
        headers: {
            Authorization: `Basic ${basic}`,
            'Content-Type': 'application/json'
        },
        timeout: 15000
    });
    const data = response && response.data ? response.data : {};
    if (!data.success) {
        throw new Error(data.error || 'FeishuBridge 推送失败');
    }
    await appendAuditLog(pluginRoot, { ...auditItem, success: true, result: data });
    return {
        success: true,
        dryRun: false,
        receiveIdType,
        receiveId,
        result: data
    };
}

module.exports = {
    pushReviewMessage,
    buildReviewMarkdown,
    resolveAdminCredential
};
