'use strict';

/**
 * 生成物零密钥扫描（红线 2）：人设 txt / 知识卡 / 验收报告 / 画像等
 * 铸造产物落盘前的模式检查，命中即阻断。
 * 设计：docs/design/2026-10-10_专家铸造炉.md §3.9、§5 红线 2。
 */

const SECRET_PATTERNS = Object.freeze([
    { id: 'api-key', pattern: /\bsk-[A-Za-z0-9]{20,}/g },
    { id: 'bearer-token', pattern: /\bBearer\s+[A-Za-z0-9._~+/=-]{16,}/g },
    { id: 'token-assignment', pattern: /\btoken\s*=\s*['"]?[A-Za-z0-9._~+/=-]{16,}/gi },
    { id: 'api-key-assignment', pattern: /\b(api[_-]?key|secret|password)\s*[:=]\s*['"][^'"\s]{12,}['"]/gi },
    { id: 'private-env', pattern: /^-{3,}\s*env\b[^\n]*|BEGIN\s+(RSA\s+)?PRIVATE\s+KEY\b/gim }
]);

// 扫描命中样本本身可能就是密钥，报告只回传前缀 + 长度，避免审计日志二次泄漏。
function maskSample(sample) {
    const trimmed = sample.trim();
    const head = trimmed.slice(0, 8);
    return `${head}…(len=${trimmed.length})`;
}

function scanTextForSecrets(text) {
    if (typeof text !== 'string' || text.length === 0) {
        return [];
    }
    const hits = [];
    for (const { id, pattern } of SECRET_PATTERNS) {
        const regex = new RegExp(pattern.source, pattern.flags);
        let match;
        while ((match = regex.exec(text)) !== null) {
            hits.push({
                patternId: id,
                sample: maskSample(match[0]),
                offset: match.index
            });
            if (hits.length >= 20) {
                return hits;
            }
        }
    }
    return hits;
}

module.exports = {
    scanTextForSecrets
};
