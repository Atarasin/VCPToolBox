# VCPCommunityAssistant 版本变更日志

## 1.1.0 - 2026-03-14

### 社区助手唤醒池控制
- `VCPCommunityAssistant` 新增 `DISABLED_ASSISTANT_AGENT_LIST` 配置项。
- 支持通过 `Plugin/VCPCommunityAssistant/config.env` 配置逗号分隔名单，将指定 Agent 从唤醒候选池中剔除。
- 候选池筛选同时覆盖社区成员/维护者与活跃发现来源，避免被禁用 Agent 进入加权唤醒流程。