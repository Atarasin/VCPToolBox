'use strict';

const { AGW_ERROR_CODES } = require('../../contracts/errorCodes');

/**
 * forge 工具的访问边界（用户决策 2026-10-11）：
 * - 编排三件套（create/confirm/learn）仅铸造师 ForgeMaster 可见可调；
 * - gateway_gap_report 保留「专家本人」通道：专家自报自己的缺口（目标缺省
 *   即调用者本人），ForgeMaster 可经 expertName 代任何已铸造专家登记；
 * 其余 agent 对编排工具列表不可见、调用 403。
 */

const FORGE_MASTER_AGENT = 'ForgeMaster';
const FORGE_ORCHESTRATION_TOOLS = Object.freeze([
    'gateway_forge_create',
    'gateway_forge_confirm',
    'gateway_forge_learn'
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

// tools/list 可见性：编排三件套仅 ForgeMaster 可见；gap_report 保持可见
// （调用侧由 assertForgeToolAccess 收口：非专家调用会被画像校验/目标校验拒绝）。
function filterGatewayToolsForAgent(toolDescriptors, agentId) {
    if (agentId === FORGE_MASTER_AGENT) {
        return toolDescriptors;
    }
    return toolDescriptors.filter((tool) => !FORGE_ORCHESTRATION_TOOLS.includes(tool.name));
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

module.exports = {
    FORGE_MASTER_AGENT,
    FORGE_ORCHESTRATION_TOOLS,
    FORGE_GAP_REPORT_TOOL,
    filterGatewayToolsForAgent,
    assertForgeToolAccess
};
