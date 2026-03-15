# VCPCommunityAssistant 版本变更日志

## 1.1.1 - 2026-03-15

### 唤醒策略稳定性优化
- 调整 `randomBrowse` 选择逻辑：优先从“状态有变化”的 Agent 集合中加权选择。
- 当所有候选 Agent 摘要均未变化时，进入“保活轮询”分支，仍然会唤醒 1 个 Agent。
- 保持每轮必定唤醒一个 Agent，避免因摘要去重导致连续轮次无唤醒。

## 1.1.0 - 2026-03-14

### 社区助手唤醒池控制
- `VCPCommunityAssistant` 新增 `DISABLED_ASSISTANT_AGENT_LIST` 配置项。
- 支持通过 `Plugin/VCPCommunityAssistant/config.env` 配置逗号分隔名单，将指定 Agent 从唤醒候选池中剔除。
- 候选池筛选同时覆盖社区成员/维护者与活跃发现来源，避免被禁用 Agent 进入加权唤醒流程。
