'use strict';

const { REST_OPERATIONS } = require('../contracts/operations');

/**
 * REST surface 的 credentialAction 决议（§3.5 / M1.S2.T3）。
 *
 * 从 restOperations.json（canonical catalog 单源）构建 method+path 匹配表，
 * 供单一认证注入点在 route dispatch 前查出该请求的 credentialAction 并调用
 * `authorizeTarget()`。带 `authExclusion: "adminAuth"` 的 operation（health/
 * metrics）与 adminAuthBridge 不参与 credential scope 检查。
 */

const MOUNT_PREFIX = '/agent_gateway';

function compileOperationMatchers(operations = REST_OPERATIONS) {
    const matchers = [];
    for (const operation of operations) {
        if (!operation?.path || !operation?.method) continue;
        const relativePath = operation.path.startsWith(MOUNT_PREFIX)
            ? operation.path.slice(MOUNT_PREFIX.length) || '/'
            : operation.path;
        const pattern = relativePath
            .split('/')
            .map((segment) => (/^\{[^}]+\}$/.test(segment) ? '[^/]+' : segment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
            .join('/');
        matchers.push({
            operationId: operation.operationId,
            method: String(operation.method).toUpperCase(),
            regex: new RegExp(`^${pattern}/?$`),
            credentialAction: operation.credentialAction || null,
            authMechanism: operation.authMechanism || null,
            authExclusion: operation.authExclusion || null
        });
    }
    return matchers;
}

const OPERATION_MATCHERS = Object.freeze(compileOperationMatchers());

/**
 * @returns {{ matched: boolean, operationId?: string, credentialAction?: string|null,
 *             authExclusion?: string|null, authMechanism?: string|null }}
 */
function resolveRestCredentialAction(method, routerPath, matchers = OPERATION_MATCHERS) {
    const normalizedMethod = String(method || '').toUpperCase();
    for (const matcher of matchers) {
        if (matcher.method === normalizedMethod && matcher.regex.test(routerPath)) {
            return {
                matched: true,
                operationId: matcher.operationId,
                credentialAction: matcher.credentialAction,
                authMechanism: matcher.authMechanism,
                authExclusion: matcher.authExclusion
            };
        }
    }
    return { matched: false };
}

module.exports = {
    OPERATION_MATCHERS,
    compileOperationMatchers,
    resolveRestCredentialAction
};
