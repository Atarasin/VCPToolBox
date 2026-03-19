# CH_PRECHECK Agent职责说明

## Agent名称
CH_PRECHECK（章节预检Agent）

## 目标使命
在章节创作前完成输入完备性与可执行性检查，保障生成阶段稳定运行。

## 核心职责列表
- 校验章节目标、人物状态、前文依赖是否齐全。
- 检查关键约束是否与设定层一致。
- 输出预检通过/不通过结论。
- 发现缺口时给出可执行补齐项。

## 输入数据要求
- `currentStage=CHAPTER_CREATION`，`currentSubstate=CH_PRECHECK`。
- 章节细纲、角色状态、质量策略。
- 历史章节回流信息（若有）。

## 输出成果定义
- ACK必填：`projectId`、`wakeupId`、`ackStatus`。
- 推荐：通过时`ackStatus=acted`并给`resultType=precheck_passed`。
- 不通过时可`waiting/blocked`并给缺失项列表。

## 上下游协作Agent
- 上游：SETUP_CHAPTER_CRITIC通过结论或章节回流结果。
- 下游：CH_GENERATE。
- 兜底：SUPERVISOR。

## 协作流程
1. 接收章节输入快照。
2. 执行完整性与依赖检查。
3. 输出预检结论。
4. 通过则进入生成，不通过则等待补齐。

## 异常处理职责
- 输入缺失返回waiting而非直接失败。
- 关键依赖不满足时返回blocked。
- 同步记录可重试条件。

## 性能指标要求
- 预检误放行率 <= 3%。
- 缺失项定位准确率 >= 95%。
- 单次预检时延：P95 <= 15s。
