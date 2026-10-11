'use strict';

const fs = require('fs');
const path = require('path');
const { AGW_ERROR_CODES } = require('../../contracts/errorCodes');

/**
 * forge 工具的访问边界（用户决策 2026-10-11）：
 * - 编排四件套（create/confirm/learn/retrial）仅铸造师 ForgeMaster 可见可调；
 * - gateway_gap_report 仅对「已铸造专家 + ForgeMaster」可见：专家自报自己
 *   的缺口（目标缺省即调用者本人），ForgeMaster 可经 expertName 代任何
 *   已铸造专家登记；非铸造 agent 不可见（调用也必被服务端画像校验 404 拒）。
 */

const FORGE_MASTER_AGENT = 'ForgeMaster';
const FORGE_ORCHESTRATION_TOOLS = Object.freeze([
    'gateway_forge_create',
    'gateway_forge_confirm',
    'gateway_forge_learn',
    'gateway_forge_retrial'
]);
const FORGE_GAP_REPORT_TOOL = 'gateway_gap_report';

function createForgeAccessError(toolName, message, details) {
    const error = new Error(message);
    error.name = 'ForgeAccessError';
    error.status = 403;
    error.code = AGW_ERROR_CODES.FORBIDDEN;
    error.details = { tool: toolName, ...(details || {}) };
    return error;
}

// 已铸造专家判定：Agent/forge/blueprints/<agentId>.json 存在（动态——铸造
// 完成画像落盘后，下次 tools/list 即可见；isForgedExpert/baseDir 可注入供测试）。
function defaultIsForgedExpert(baseDir) {
    const root = baseDir
        || (process.env.FORGE_BASE_DIR || '').trim()
        || path.join(__dirname, '..', '..', '..', '..', 'Agent', 'forge');
    return (agentId) => {
        const name = String(agentId || '').trim();
        return Boolean(name) && fs.existsSync(path.join(root, 'blueprints', `${name}.json`));
    };
}

// tools/list 可见性：编排三件套仅 ForgeMaster；gap_report 仅已铸造专家 + ForgeMaster。
function filterGatewayToolsForAgent(toolDescriptors, agentId, options = {}) {
    const isForgedExpert = typeof options.isForgedExpert === 'function'
        ? options.isForgedExpert
        : defaultIsForgedExpert(options.baseDir);
    if (agentId === FORGE_MASTER_AGENT) {
        return toolDescriptors;
    }
    return toolDescriptors.filter((tool) => {
        if (FORGE_ORCHESTRATION_TOOLS.includes(tool.name)) {
            return false;
        }
        if (tool.name === FORGE_GAP_REPORT_TOOL) {
            return isForgedExpert(agentId);
        }
        return true;
    });
}

// 调用守卫：编排工具仅 ForgeMaster；gap_report 自报或 ForgeMaster 代报。
function assertForgeToolAccess({ toolName, requesterAgentId, targetAgentId }) {
    if (FORGE_ORCHESTRATION_TOOLS.includes(toolName)) {
        if (requesterAgentId !== FORGE_MASTER_AGENT) {
            throw createForgeAccessError(
                toolName,
                `${toolName} 仅铸造师 ${FORGE_MASTER_AGENT} 可调用`,
                { requesterAgentId: requesterAgentId || null }
            );
        }
        return;
    }
    if (toolName === FORGE_GAP_REPORT_TOOL) {
        if (requesterAgentId !== FORGE_MASTER_AGENT && targetAgentId && targetAgentId !== requesterAgentId) {
            throw createForgeAccessError(
                toolName,
                `${toolName} 仅可登记本人的知识缺口（代报须以 ${FORGE_MASTER_AGENT} 身份并指定 expertName）`,
                { requesterAgentId: requesterAgentId || null, targetAgentId }
            );
        }
    }
}

// REST-only 编排入口（如 forge.retrial 补试岗）无对应 MCP 工具名——复用
// 编排口径：仅 ForgeMaster 可触发。
function assertForgeOrchestrationAccess({ requesterAgentId, action }) {
    const label = action || 'forge orchestration';
    if (requesterAgentId !== FORGE_MASTER_AGENT) {
        throw createForgeAccessError(
            label,
            `${label} 仅铸造师 ${FORGE_MASTER_AGENT} 可触发`,
            { requesterAgentId: requesterAgentId || null }
        );
    }
}

// ── MCP/REST 共用的参数映射（gateway_forge_* 的入参 → service 调用）──────

// gateway_forge_create → startExpertCreateJob
function buildForgeCreateRequest(body = {}) {
    return {
        requirement: body.requirement,
        ...(Number.isFinite(Number(body.budgetCny)) && Number(body.budgetCny) > 0
            ? { budgetCny: Number(body.budgetCny) }
            : {}),
        ...(body.blueprintJson && typeof body.blueprintJson === 'object'
            ? { blueprintOverride: body.blueprintJson }
            : {})
    };
}

// gateway_forge_confirm → confirmBlueprint（缺省字段不注入；非布尔 true 一律视为拒绝）
function buildForgeConfirmRequest(body = {}) {
    return {
        approved: body.approved === true,
        ...(body.feedback ? { feedback: body.feedback } : {}),
        ...(body.renameTo ? { renameTo: body.renameTo } : {}),
        ...(body.overwrite === true ? { overwrite: true } : {})
    };
}

// gateway_forge_learn → startExpertLearnJob（subskillIds/topic 组装 scope）
function buildForgeLearnRequest(body = {}) {
    const scope = (Array.isArray(body.subskillIds) && body.subskillIds.length > 0) || body.topic
        ? {
            ...(Array.isArray(body.subskillIds) && body.subskillIds.length > 0 ? { subskillIds: body.subskillIds } : {}),
            ...(body.topic ? { topic: body.topic } : {}),
            reason: 'manual'
        }
        : undefined;
    return {
        expertName: body.expertName,
        ...(body.since ? { since: body.since } : {}),
        ...(scope ? { scope } : {})
    };
}

// gateway_forge_retrial → startExpertRetrialJob（已注册专家仅重跑 trial）
// reuseExamFromJobId/expectExamHash：固定考卷重考（复用源任务考卷，消除重新
// 出卷噪声）；subskillIds：抽考范围（冒烟试岗/定向验证）。
function buildForgeRetrialRequest(body = {}) {
    return {
        expertName: body.expertName,
        ...(Number.isFinite(Number(body.budgetCny)) && Number(body.budgetCny) > 0
            ? { budgetCny: Number(body.budgetCny) }
            : {}),
        ...(body.reuseExamFromJobId ? { reuseExamFromJobId: String(body.reuseExamFromJobId) } : {}),
        ...(body.expectExamHash ? { expectExamHash: String(body.expectExamHash) } : {}),
        ...(Array.isArray(body.subskillIds) && body.subskillIds.length > 0 ? { subskillIds: body.subskillIds } : {})
    };
}

module.exports = {
    buildForgeCreateRequest,
    buildForgeConfirmRequest,
    buildForgeLearnRequest,
    buildForgeRetrialRequest,
    FORGE_MASTER_AGENT,
    defaultIsForgedExpert,
    FORGE_ORCHESTRATION_TOOLS,
    FORGE_GAP_REPORT_TOOL,
    filterGatewayToolsForAgent,
    assertForgeToolAccess,
    assertForgeOrchestrationAccess
};
