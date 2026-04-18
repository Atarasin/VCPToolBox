/**
 * OpenClaw adapter 兼容入口。
 * 当前路由文件仅保留协议命名与挂载位置，核心实现已下沉到 modules 层，
 * 便于后续让 Native Gateway / MCP adapter 共享同一套 Gateway Core。
 */
module.exports = require('../modules/agentGatewayCore');
