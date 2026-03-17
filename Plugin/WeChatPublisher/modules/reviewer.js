const fs = require('fs').promises;
const path = require('path');
const axios = require('axios');

/**
 * 将各种类型的值转换为布尔值
 * @param {any} value - 需要转换的值
 * @param {boolean} [defaultValue=false] - 默认值
 * @returns {boolean} 转换后的布尔值
 */
function toBoolean(value, defaultValue = false) {
    if (value === undefined || value === null || value === '') return defaultValue;
    if (typeof value === 'boolean') return value;
    const normalized = String(value).trim().toLowerCase();
    return normalized === 'true' || normalized === '1' || normalized === 'yes';
}

/**
 * 解析管理员凭证
 * 尝试从 config 对象或环境变量中获取 AdminUsername 和 AdminPassword
 * @param {Object} config - 配置对象
 * @returns {Object|null} 包含 username 和 password 的对象，如果缺失则返回 null
 */
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

/**
 * 构建审核消息的 Markdown 内容
 * 包含草稿信息、项目信息、正文预览及审核操作按钮提示
 * @param {Object} draft - 草稿对象
 * @returns {string} Markdown 格式的字符串
 */
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

/**
 * 确保目录存在
 * @param {string} dirPath - 目录路径
 */
async function ensureDir(dirPath) {
    await fs.mkdir(dirPath, { recursive: true });
}

/**
 * 追加审计日志
 * 记录每一次推送审核的结果（无论成功失败或 DryRun）
 * @param {string} pluginRoot - 插件根目录
 * @param {Object} item - 日志项
 */
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

async function postReviewWithRetry(url, payload, requestOptions = {}, options = {}) {
    const httpClient = options.httpClient || axios;
    const attemptsValue = Number.parseInt(options.retryTimes, 10);
    const attempts = Number.isFinite(attemptsValue) && attemptsValue > 0 ? attemptsValue : 3;
    const delayValue = Number.parseInt(options.retryDelayMs, 10);
    const retryDelayMs = Number.isFinite(delayValue) && delayValue >= 0 ? delayValue : 500;
    let lastError = null;
    for (let i = 0; i < attempts; i += 1) {
        try {
            return await httpClient.post(url, payload, requestOptions);
        } catch (error) {
            lastError = error;
            const statusCode = error && error.response ? Number(error.response.status) : 0;
            const retryableStatus = statusCode >= 500 || statusCode === 429;
            const networkRetryable =
                !statusCode &&
                error &&
                (error.code === 'ECONNABORTED' ||
                    error.code === 'ECONNRESET' ||
                    error.code === 'ECONNREFUSED' ||
                    error.code === 'ETIMEDOUT');
            if (i === attempts - 1 || (!retryableStatus && !networkRetryable)) {
                throw lastError;
            }
            if (retryDelayMs > 0) {
                await new Promise(resolve => setTimeout(resolve, retryDelayMs));
            }
        }
    }
    throw lastError;
}

/**
 * 推送审核消息到 FeishuBridge
 * 步骤:
 * 1. 验证参数
 * 2. 构建消息体
 * 3. 记录日志 (如果是 dryRun 则直接返回)
 * 4. 解析凭证并调用 API
 * 5. 记录调用结果
 * @param {Object} draft - 草稿对象
 * @param {Object} options - 配置选项 (pluginRoot, config, dryRun, receiveId)
 * @returns {Promise<Object>} 推送结果
 * @throws {Error} 如果缺少必要参数或 API 调用失败
 */
async function pushReviewMessage(draft, options = {}) {
    if (!draft || typeof draft !== 'object') {
        throw new Error('阶段3需要有效的草稿对象');
    }
    const pluginRoot = options.pluginRoot || path.join(__dirname, '..');
    const config = options.config || {};
    const port = config.PORT || process.env.PORT || '6005';
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
    const response = await postReviewWithRetry(
        url,
        payload,
        {
            headers: {
                Authorization: `Basic ${basic}`,
                'Content-Type': 'application/json'
            },
            timeout: 15000
        },
        {
            httpClient: options.httpClient,
            retryTimes:
                options.retryTimes ||
                config.WECHAT_PUBLISHER_REVIEW_RETRY_TIMES ||
                process.env.WECHAT_PUBLISHER_REVIEW_RETRY_TIMES ||
                '3',
            retryDelayMs:
                options.retryDelayMs ||
                config.WECHAT_PUBLISHER_REVIEW_RETRY_DELAY_MS ||
                process.env.WECHAT_PUBLISHER_REVIEW_RETRY_DELAY_MS ||
                '500'
        }
    );
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
    resolveAdminCredential,
    postReviewWithRetry
};
