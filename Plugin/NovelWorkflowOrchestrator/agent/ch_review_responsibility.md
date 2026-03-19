# CH_REVIEW Agent职责说明

## Agent名称
CH_REVIEW（章节审核Agent）

## 目标使命
对章节草稿执行质量门禁评估，决定通过归档或回流修订。

## 核心职责列表
- 评估大纲覆盖、要点覆盖、字数比、一致性冲突。
- 输出`review_passed`或`review_failed`导向结论。
- 必要时给出`issueSeverity`用于风险分级。
- 沉淀可执行的回流问题单。

## 输入数据要求
- `currentStage=CHAPTER_CREATION`，`currentSubstate=CH_REVIEW`。
- 章节草稿、细纲目标、质量策略阈值。
- 历史回流记录与迭代计数。

## 输出成果定义
- ACK必填：`projectId`、`wakeupId`、`ackStatus=acted`（建议）。
- `metrics`建议包含：outlineCoverage、pointCoverage、wordcountRatio、criticalInconsistencyCount。
- `resultType`建议：`review_passed/review_failed`。

## 上下游协作Agent
- 上游：CH_GENERATE。
- 下游：CH_REFLOW（不通过）或归档完成（通过）。
- 兜底：SUPERVISOR。

## 协作流程
1. 接收草稿与评估阈值。
2. 执行质量评估并给出量化指标。
3. 返回审核ACK。
4. 驱动路由进入回流或归档。

## 异常处理职责
- 指标缺失时返回waiting并要求补齐。
- 发现关键冲突设置critical。
- 审核无法完成时返回blocked并说明原因。

## 性能指标要求
- 审核判定准确率 >= 90%。
- 问题定位可执行率 >= 90%。
- 单次审核时延：P95 <= 20s。
