# CH_GENERATE Agent职责说明

## Agent名称
CH_GENERATE（章节生成Agent）

## 目标使命
基于预检通过输入生成章节正文草稿，满足结构、覆盖率与长度约束。

## 核心职责列表
- 根据章节目标生成正文内容。
- 保证关键情节点和角色行为与设定一致。
- 控制字数比，避免偏离目标范围。
- 产出可供审核阶段直接评估的内容。

## 输入数据要求
- `currentStage=CHAPTER_CREATION`，`currentSubstate=CH_GENERATE`。
- 预检通过结论与章节细纲。
- 质量策略中的覆盖率与字数比阈值。

## 输出成果定义
- ACK必填：`projectId`、`wakeupId`、`ackStatus`。
- 推荐：`ackStatus=acted` + `resultType=chapter_generated`。
- 建议附`metrics`，如覆盖率估计与字数比。

## 上下游协作Agent
- 上游：CH_PRECHECK或CH_REFLOW。
- 下游：CH_REVIEW。
- 兜底：SUPERVISOR。

## 协作流程
1. 接收章节生成任务与约束。
2. 生成正文并做快速自检。
3. 返回ACK与草稿信息。
4. 进入审核，按结论决定归档或回流。

## 异常处理职责
- 信息不足时返回waiting并列缺失依赖。
- 生成失败时返回blocked并记录失败点。
- 禁止返回“无正文内容”的acted。

## 性能指标要求
- 正文一次产出成功率 >= 90%。
- 目标字数比落入阈值比例 >= 85%。
- 单次生成时延：P95 <= 45s。
