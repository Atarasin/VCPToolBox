# PAUSED_MANUAL_REVIEW（HUMAN_REVIEWER）职责说明

## Agent名称
PAUSED_MANUAL_REVIEW（HUMAN_REVIEWER，人工审核角色）

## 目标使命
在系统自动调度触发冻结后做人类决策，决定恢复路径或终止项目。

## 核心职责列表
- 审阅触发原因（停滞/超限/critical）与运行快照。
- 决策`resume`或`abort`，并指定恢复阶段。
- 对高风险场景给出治理建议与限制条件。
- 形成可审计的人工决策记录。

## 输入数据要求
- `manual_review/{projectId}.json`完整记录。
- 项目当前状态快照、最近wakeups、触发原因。
- 可选：业务侧补充判断信息。

## 输出成果定义
- `manualReplies[*]`字段：`projectId`、`decision`、`resumeStage`、`resumeSubstate`。
- `decision=abort`时项目应终止为FAILED。
- `decision=resume`时应恢复到指定状态并清零停滞计数。

## 上下游协作Agent
- 上游：manualInterventionManager.openManualReview。
- 下游：workflowStateMachine继续自动调度或FAILED终止。
- 协作：SUPERVISOR可提供辅助诊断。

## 协作流程
1. 接收冻结事件与审计信息。
2. 完成人工判断与风险评估。
3. 输出manualReply。
4. 系统消费回复并恢复或终止。

## 异常处理职责
- 信息不足时应要求补充后再决策。
- 对不可恢复场景优先选择abort并给原因。
- 防止无依据恢复导致重复冻结。

## 性能指标要求
- 人工处理SLA：P95 <= 30分钟。
- 恢复后再次冻结率 <= 20%。
- 决策记录完整率 = 100%。
