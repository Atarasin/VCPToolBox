# Agent Gateway MCP Readiness

## 目标

M6 只冻结 MCP 第一版的最小接入边界，不在当前里程碑内实现 MCP adapter/server。MCP 后续必须复用 Gateway Core 的规范能力模型，而不是直接绕过到低层插件或 OpenClaw 兼容层。

## 第一版建议接入范围

- `tools`
  - 直接映射 Gateway Core 的 tool invoke 语义
  - 必须复用共享 `authContext`、`agentPolicyResolver`、`toolScopeGuard`
- `resources`
  - 优先考虑 agent registry detail/render 的只读视图
  - 优先考虑 memory target 列表与受 policy 限制的只读上下文资源
- `prompts`
  - 仅考虑 registry render 的结构化输出
  - 不引入脱离 Gateway Core 的第二套 prompt 展开模型

## 第一版暂不接入

- 独立 MCP auth 模式
- 绕过 Gateway Core 的低层插件直连
- 未定型的 jobs 执行器实现
- Native / OpenClaw 之外的第三套私有权限模型
- 脱离 canonical job state 的 MCP 专属异步状态机

## 冻结边界

- MCP 必须消费 canonical `authContext`
- MCP 必须消费 canonical policy 结果，不能跳过 scope guard
- MCP 必须消费 canonical job/runtime state，不能自行发明 `accepted` / `waiting_approval` 语义
- MCP 的工具、资源、提示词暴露范围都以 Gateway Core capability 命名为准

## 后续落点

- 若进入 M7+ 的 MCP adapter 实现阶段，应优先基于：
  - `agent-gateway-auth-policy`
  - `agent-gateway-job-runtime`
  - `agent-gateway-agent-registry`
  - `agent-gateway-native-gateway`
