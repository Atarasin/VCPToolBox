# NovelWorkflowOrchestrator 单项目串行化改造方案

## 1. 背景与目标

基于《完整两阶段长篇小说创作工作流》，当前业务语义本质是严格串行：

1. 第一阶段：设计者与挑刺者按回合迭代，不是并行协作；
2. 第二阶段：预检 -> 创作 -> 审核 -> 回流，天然串行；
3. 单项目每一步依赖上一步输出，无法在同一 Tick 内并行推进多个 Agent 的有效状态变更。

本方案目标：

- 将 **单项目执行语义** 收敛为“每 Tick 最多一个有效执行者”；
- 保留 **多项目并发** 能力（不同项目之间可并行）；
- 建立“辩论回合”显式模型，消除“多任务并发 + 单 ACK 合并”语义错位。

---

## 2. 现状问题

### 2.1 语义偏差

- 当前阶段映射支持逗号分隔多个 Agent，可能导致单项目同 Tick 下发多个任务；
- 当前 ACK 是项目级优先级合并（`acted > blocked > waiting`），不是任务级顺序消费；
- 导致“并行任务执行，但只消费单条 ACK 推进状态”的错配。

### 2.2 风险

- 回执顺序不可控，可能误用非当前回合回执；
- 迭代轮次与实际辩论轮次不严格对齐；
- 运维层面难以解释“当前到底在执行哪一位角色”。

---

## 3. 改造原则

1. **单项目强串行**：同一项目、同一 Tick，仅允许一个活跃唤醒任务；
2. **回合显式建模**：设定阶段“设计者/挑刺者”作为回合状态而不是并行角色；
3. **ACK 精确绑定**：只消费当前活跃 `wakeupId` 的 ACK；
4. **直接切换新语义**：不保留旧配置兼容逻辑；
5. **多项目吞吐不降级**：`tickMaxProjects` 继续发挥跨项目并发作用。

---

## 4. 目标架构（改造后）

### 4.1 单项目执行模型

- 设定阶段：
  - `DESIGNER` 回合产出方案；
  - `CRITIC` 回合给出评分/问题；
  - 控制器判定 `通过 / 继续迭代 / 人工介入`；
- 章节阶段：
  - 维持 `CH_PRECHECK -> CH_GENERATE -> CH_REVIEW -> (CH_REFLOW -> CH_GENERATE)* -> CH_ARCHIVE` 串行链路；
- 任意阶段都满足：**单项目单 Tick 最多一个 wakeup**。

### 4.2 预算语义

- `NWO_TICK_MAX_WAKEUPS` 调整为“全局 Tick 总预算”；
- 单项目配额固定为 1；
- 多项目时预算在项目之间分配。

---

## 5. 详细改造项

## 5.1 配置层改造

新增设定阶段回合角色配置（建议）：

- `NWO_STAGE_SETUP_WORLD_DESIGNER`
- `NWO_STAGE_SETUP_WORLD_CRITIC`
- `NWO_STAGE_SETUP_CHARACTER_DESIGNER`
- `NWO_STAGE_SETUP_CHARACTER_CRITIC`
- `NWO_STAGE_SETUP_VOLUME_DESIGNER`
- `NWO_STAGE_SETUP_VOLUME_CRITIC`
- `NWO_STAGE_SETUP_CHAPTER_DESIGNER`
- `NWO_STAGE_SETUP_CHAPTER_CRITIC`

强约束：

- 移除旧式逗号并行配置语义（如 `NWO_STAGE_SETUP_WORLD=a,b`）；
- 阶段角色按 `DESIGNER/CRITIC` 分拆字段读取；
- 配置缺失即阻塞或升级 `SUPERVISOR`，不做自动迁移推断。

## 5.2 状态模型改造

在 `projectState` 增加回合结构：

```json
{
  "debate": {
    "role": "designer",
    "round": 0,
    "maxRounds": 3,
    "lastDesignerWakeupId": null,
    "lastCriticWakeupId": null
  },
  "activeWakeupId": null
}
```

说明：

- `activeWakeupId` 用于 ACK 精确匹配；
- `debate.role` 表示当前应唤醒的角色；
- `round` 在“critic 给出未通过结论后”递增；
- 达到上限后触发人工介入流程。

## 5.3 Agent 解析改造

- 解析逻辑从“阶段 -> Agent 列表”改为“阶段 + 回合角色 -> 单 Agent”；
- `resolveAgentsForProject` 返回长度最多为 1 的数组；
- 如当前回合角色缺失，优先升级 `SUPERVISOR`，否则阻塞。

## 5.4 派发器改造

- 强制 `selectedAgents.length <= 1`；
- 派发后写入 `project.activeWakeupId`；
- 新任务下发前若存在未完成活跃任务，可按策略：
  - 保守：不重复派发，返回 `waiting_active_wakeup_ack`；
  - 激进：超时后允许替换（本期建议保守）。

## 5.5 ACK 消费改造

- 仅消费满足 `ack.wakeupId === project.activeWakeupId` 的回执；
- 非活跃回执记为 `stale_or_out_of_turn_ack`，写审计但不推进状态；
- 取消“项目级多 ACK 优先级合并”的主路径语义。

## 5.6 状态机改造

设定阶段增加回合内转换：

1. designer acted -> 切到 critic；
2. critic acted + score >= 阈值 -> 进入下一设定层；
3. critic acted + score < 阈值 + round < max -> 回到 designer；
4. critic acted + score < 阈值 + round >= max -> 人工介入。

章节阶段保持现有串行链路，仅强化 ACK 绑定与单任务约束。

---

## 6. 实施步骤

## 第 1 步：配置与数据模型扩展

- 增加新角色字段并删除并行语义配置解析；
- 扩展默认项目状态与序列化模型；
- 删除旧字段兼容分支与迁移告警逻辑。

## 第 2 步：调度与回执链路改造

- 改造 Agent 解析为单角色输出；
- 改造派发器为单项目单任务；
- 改造 ACK 消费为活跃任务精确匹配。

## 第 3 步：状态机回合化

- 设定阶段引入 designer/critic 回合转换；
- 接入评分阈值与轮次控制；
- 与人工介入模块打通。

## 第 4 步：文档与配置模板更新

- 更新 `README.md` 参数语义；
- 更新 `config.env.example`；
- 更新 `plugin-manifest.json` 的 `configSchema`；
- 在 `CHANGELOG.md` 记录本次行为语义升级。

---

## 7. 测试与验收标准

## 7.1 必增测试用例

1. 单项目设置多个 Agent 时，每 Tick 只派发 1 条 wakeup；
2. 非 `activeWakeupId` 的 ACK 不推进状态；
3. 设定阶段 designer -> critic -> pass 的正常推进；
4. 设定阶段低分多轮后触发人工介入；
5. 旧式逗号并行配置输入会被明确拒绝或视为无效；
6. 多项目场景下总派发受 `NWO_TICK_MAX_WAKEUPS` 约束，单项目仍串行。

## 7.2 验收标准

- 单项目每 Tick `targetAgents.length` 恒为 `0|1`；
- 状态推进顺序与两阶段工作流一致；
- 审计日志可明确还原“当前活跃回合角色与活跃任务”；
- 全量单元/集成测试通过。

---

## 8. 发布策略

## 8.1 版本策略

- 建议作为小版本升级（如 `0.5.0`）发布，属于调度语义变更。

## 8.2 发布说明

1. 本次为“直接切换”方案，发布后按新字段生效；
2. 不提供旧配置兼容与自动迁移；
3. 升级前需同步更新 `config.env.example`、`README.md`、`plugin-manifest.json`；
4. 若发现配置不完整，按阻塞策略处理并输出明确错误信息。

---

## 9. 预期收益

1. 行为语义与业务流程一致，可解释性显著提升；
2. 回执消费更可控，减少乱序/并发导致的推进异常；
3. 辩论轮次与质量门禁统计更真实；
4. 为后续“严格回合制控制器”与“可视化流程追踪”打基础。
