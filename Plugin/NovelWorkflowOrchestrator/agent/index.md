# NovelWorkflowOrchestrator Agent职责矩阵索引

## 1. 角色总览

| Agent角色 | 文件 | 主流程阶段 | 主要上游 | 主要下游 | 关键KPI |
|---|---|---|---|---|---|
| SETUP_WORLD_DESIGNER | [setup_world_designer_responsibility.md](./setup_world_designer_responsibility.md) | SETUP_WORLD | Orchestrator状态机 | SETUP_WORLD_CRITIC | 设定草案一次提交完整率 |
| SETUP_WORLD_CRITIC | [setup_world_critic_responsibility.md](./setup_world_critic_responsibility.md) | SETUP_WORLD | SETUP_WORLD_DESIGNER | SETUP_CHARACTER_DESIGNER/回退DESIGNER | 评审问题命中率 |
| SETUP_CHARACTER_DESIGNER | [setup_character_designer_responsibility.md](./setup_character_designer_responsibility.md) | SETUP_CHARACTER | 状态机推进 | SETUP_CHARACTER_CRITIC | 角色卡一致性通过率 |
| SETUP_CHARACTER_CRITIC | [setup_character_critic_responsibility.md](./setup_character_critic_responsibility.md) | SETUP_CHARACTER | SETUP_CHARACTER_DESIGNER | SETUP_VOLUME_DESIGNER/回退DESIGNER | 设定矛盾识别率 |
| SETUP_VOLUME_DESIGNER | [setup_volume_designer_responsibility.md](./setup_volume_designer_responsibility.md) | SETUP_VOLUME | 状态机推进 | SETUP_VOLUME_CRITIC | 分卷结构覆盖率 |
| SETUP_VOLUME_CRITIC | [setup_volume_critic_responsibility.md](./setup_volume_critic_responsibility.md) | SETUP_VOLUME | SETUP_VOLUME_DESIGNER | SETUP_CHAPTER_DESIGNER/回退DESIGNER | 节奏风险识别率 |
| SETUP_CHAPTER_DESIGNER | [setup_chapter_designer_responsibility.md](./setup_chapter_designer_responsibility.md) | SETUP_CHAPTER | 状态机推进 | SETUP_CHAPTER_CRITIC | 章节细纲可执行率 |
| SETUP_CHAPTER_CRITIC | [setup_chapter_critic_responsibility.md](./setup_chapter_critic_responsibility.md) | SETUP_CHAPTER | SETUP_CHAPTER_DESIGNER | CH_PRECHECK/回退DESIGNER | 进入创作前风险拦截率 |
| CH_PRECHECK | [ch_precheck_responsibility.md](./ch_precheck_responsibility.md) | CHAPTER_CREATION/CH_PRECHECK | 章节设定输出 | CH_GENERATE | 预检通过一次成功率 |
| CH_GENERATE | [ch_generate_responsibility.md](./ch_generate_responsibility.md) | CHAPTER_CREATION/CH_GENERATE | CH_PRECHECK/CH_REFLOW | CH_REVIEW | 章节产出时效与完稿率 |
| CH_REVIEW | [ch_review_responsibility.md](./ch_review_responsibility.md) | CHAPTER_CREATION/CH_REVIEW | CH_GENERATE | CH_REFLOW/CH_ARCHIVE | 审核准确率 |
| CH_REFLOW | [ch_reflow_responsibility.md](./ch_reflow_responsibility.md) | CHAPTER_CREATION/CH_REFLOW | CH_REVIEW | CH_GENERATE | 回流问题闭环率 |
| SUPERVISOR | [supervisor_responsibility.md](./supervisor_responsibility.md) | 全阶段兜底 | 任一缺失阶段映射 | 对应流程恢复节点 | 阻塞解除时效 |
| PAUSED_MANUAL_REVIEW（HUMAN_REVIEWER） | [paused_manual_review_responsibility.md](./paused_manual_review_responsibility.md) | 人工介入阶段 | 系统触发冻结 | 恢复原阶段/FAILED | 人工决策SLA |

## 2. 交互主链路

1. 设定阶段按回合串行：DESIGNER -> CRITIC -> 判定（通过推进 / 不通过回退）。
2. 章节阶段按子状态串行：CH_PRECHECK -> CH_GENERATE -> CH_REVIEW -> CH_REFLOW(可循环) -> CH_ARCHIVE。
3. 任意阶段角色缺失时优先升级到 SUPERVISOR。
4. 达到轮次/迭代上限、停滞超阈值或关键冲突时进入 PAUSED_MANUAL_REVIEW。

## 3. 契约统一说明

- 上下文输入统一来自 `assembleWakeupContext` 输出字段。
- ACK输出必须包含 `projectId + wakeupId + ackStatus`，建议附带 `metrics` 与 `resultType`。
- 仅 `wakeupId == activeWakeupId` 的ACK参与状态推进，其他ACK仅审计。
