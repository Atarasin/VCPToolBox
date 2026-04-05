# NovelWorkflowOrchestrator 单项目串行化具体实施方案

> 基于《NovelWorkflowOrchestrator单项目串行化改造方案》的可执行落地版本。  
> 目标是“直接切换到单项目强串行语义”，不保留旧并行配置兼容逻辑。

---

## 1. 实施范围与边界

## 1.1 实施范围

本次改造覆盖以下目录与文件：

- 插件入口与配置解析
  - `Plugin/NovelWorkflowOrchestrator/NovelWorkflowOrchestrator.js`
  - `Plugin/NovelWorkflowOrchestrator/plugin-manifest.json`
  - `Plugin/NovelWorkflowOrchestrator/config.env.example`
- 调度与状态核心
  - `Plugin/NovelWorkflowOrchestrator/lib/core/tickRunner.js`
  - `Plugin/NovelWorkflowOrchestrator/lib/core/workflowStateMachine.js`
  - `Plugin/NovelWorkflowOrchestrator/lib/core/stateRouter.js`（仅按需）
- 管理器
  - `Plugin/NovelWorkflowOrchestrator/lib/managers/agentMappingResolver.js`
  - `Plugin/NovelWorkflowOrchestrator/lib/managers/wakeupDispatcher.js`
  - `Plugin/NovelWorkflowOrchestrator/lib/managers/contextAssembler.js`（补充回合信息）
  - `Plugin/NovelWorkflowOrchestrator/lib/managers/qualityGateManager.js`（按需接入评分字段）
- 存储
  - `Plugin/NovelWorkflowOrchestrator/lib/storage/stateStore.js`
- 测试
  - `Plugin/NovelWorkflowOrchestrator/test/unit/*.test.js`
  - `Plugin/NovelWorkflowOrchestrator/test/integration/tickRunner.test.js`
- 文档与发布记录
  - `Plugin/NovelWorkflowOrchestrator/README.md`
  - `Plugin/NovelWorkflowOrchestrator/CHANGELOG.md`

## 1.2 非目标

- 不实现旧字段自动迁移；
- 不实现“单项目并行”可开关能力；
- 不保留逗号多 Agent 语义。

---

## 2. 新语义定义（实施基线）

## 2.1 单项目调度基线

1. 同一项目单 Tick 最多下发 1 条 wakeup；
2. 项目状态推进只消费当前 `activeWakeupId` 对应 ACK；
3. 非活跃 ACK 仅审计，不参与迁移；
4. 设定阶段按 `DESIGNER -> CRITIC -> 判定` 回合执行；
5. 章节阶段维持既有串行链路（预检-生成-评审-回流）。

## 2.2 配置基线

设定阶段角色字段必须显式配置：

- `NWO_STAGE_SETUP_WORLD_DESIGNER`
- `NWO_STAGE_SETUP_WORLD_CRITIC`
- `NWO_STAGE_SETUP_CHARACTER_DESIGNER`
- `NWO_STAGE_SETUP_CHARACTER_CRITIC`
- `NWO_STAGE_SETUP_VOLUME_DESIGNER`
- `NWO_STAGE_SETUP_VOLUME_CRITIC`
- `NWO_STAGE_SETUP_CHAPTER_DESIGNER`
- `NWO_STAGE_SETUP_CHAPTER_CRITIC`

若配置缺失：

- 优先升级 `NWO_STAGE_SUPERVISOR`；
- 无 `SUPERVISOR` 时阻塞并记录原因。

---

## 3. 分步实施计划（按提交批次）

## 批次 A：数据模型与配置模型落地

### A1. `stateStore.js` / 默认项目状态扩展

在 `createDefaultProjectState` 中新增：

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

并保证写盘/读盘路径无额外兼容分支。

### A2. `NovelWorkflowOrchestrator.js` 配置解析改造

1. 删除旧 `NWO_STAGE_SETUP_*`（逗号列表）作为设定阶段主解析来源；
2. 增加 `*_DESIGNER/*_CRITIC` 字段解析；
3. 保留章节阶段键：
   - `CH_PRECHECK/CH_GENERATE/CH_REVIEW/CH_REFLOW`
4. 保留 `SUPERVISOR` 兜底字段。

### A3. `plugin-manifest.json` 与 `config.env.example` 同步

1. 新增 `*_DESIGNER/*_CRITIC` 配置项；
2. 移除旧设定阶段并行字符串配置项；
3. 更新示例值，体现串行回合角色。

---

## 批次 B：调度链路强串行化

### B1. `agentMappingResolver.js` 语义重写

目标：

- 输入 `project + debate.role + stageAgents`；
- 输出单元素数组或空数组；
- 禁止返回多角色结果。

建议新增函数：

- `resolveSetupRoleAgent(project, stageAgents)`
- `resolveChapterAgent(project, stageAgents)`

最终统一返回结构：

```json
{
  "key": "SETUP_WORLD_DESIGNER",
  "agents": ["agent_x"],
  "blocked": false,
  "escalatedToSupervisor": false,
  "reason": "resolved"
}
```

### B2. `wakeupDispatcher.js` 单任务约束

在派发前强制：

- `selectedAgents = agents.slice(0, 1)`

并保持 `remainingBudget` 语义为全局预算扣减。

### B3. `tickRunner.js` 活跃任务绑定

改造点：

1. 派发成功后写入 `project.activeWakeupId`；
2. 仅消费 `ack.wakeupId === project.activeWakeupId` 的 ACK；
3. 非匹配 ACK：
   - `transitionReason='stale_or_out_of_turn_ack'`
   - 不触发状态推进；
4. 完成有效 ACK 消费后清理或更新 `activeWakeupId`（按下一任务写入）。

---

## 批次 C：设定阶段回合状态机

### C1. `workflowStateMachine.js` 增加设定回合内迁移

在 `SETUP_*` 阶段新增规则：

1. `debate.role=designer` + `ackStatus=acted` -> `debate.role=critic`；
2. `debate.role=critic` + `ackStatus=acted`：
   - `score>=setupPassThreshold` -> 进入下一个顶层设定状态，`role` 重置 `designer`，`round` 清零；
   - `score<setupPassThreshold` 且 `round+1<maxRounds` -> `role=designer`，`round+1`；
   - `score<setupPassThreshold` 且 `round+1>=maxRounds` -> 人工介入触发路径。

### C2. `qualityGateManager.js` 接口对齐

确保能从 ACK 提取设定评分（优先级）：

- `ack.metrics.setupScore`
- `ack.metrics.passScore`
- `ack.score`

并与状态机判定阈值保持一致。

### C3. `contextAssembler.js` 增强上下文

在上下文中增加：

- `debateRole`
- `debateRound`
- `activeWakeupId`

用于 Agent 明确当前回合职责。

---

## 批次 D：文档、测试、发布收敛

### D1. 文档更新

- `README.md`：
  - 删除单项目并行描述；
  - 明确单项目单 Tick 单任务；
  - 更新配置表字段。

### D2. 变更记录

- `CHANGELOG.md` 增加版本条目，记录：
  - 串行语义切换；
  - 配置字段变更；
  - ACK 绑定策略变化；
  - 不兼容项说明。

### D3. 测试收敛

新增/改造以下测试：

1. 单项目多角色配置时只派发 1 条任务；
2. 非 `activeWakeupId` ACK 不推进；
3. 设定阶段完整回合流转：
   - designer acted -> critic
   - critic 低分 -> designer（round+1）
   - critic 达标 -> 下一设定层
4. 达到最大轮次触发人工介入；
5. 章节链路回归测试保持通过；
6. 多项目预算分配回归测试。

---

## 4. 关键实现清单（可直接分配开发）

## 4.1 任务拆分

1. **配置模型改造**
   - 修改入口配置解析、manifest、env 示例
2. **状态模型改造**
   - 扩展 projectState 默认结构、检查点快照字段
3. **调度器改造**
   - Agent 解析器单角色化
   - 派发器单任务化
   - Tick 主循环 activeWakeupId 绑定
4. **状态机改造**
   - 设定阶段回合迁移
5. **质量与人工介入接线**
   - 评分阈值判定与轮次超限触发人工
6. **测试与文档**
   - 单元/集成测试、README、CHANGELOG

## 4.2 建议执行顺序

按以下顺序落地可减少返工：

1. 配置 + 数据模型
2. 派发链路
3. 状态机回合化
4. 测试
5. 文档与发布元数据

---

## 5. 风险与控制

## 5.1 风险点

1. 回合字段未初始化导致旧测试数据异常；
2. ACK 绑定后历史测试用例中缺失 `wakeupId`；
3. 设定阶段评分字段命名不统一导致判定偏差；
4. 单任务约束后部分统计指标（派发数）预期变化。

## 5.2 控制措施

1. 测试构造统一补齐 `activeWakeupId/wakeupId`；
2. 状态机与门禁模块统一评分字段读取顺序；
3. 对关键决策增加 `transitionReason` 可观测性；
4. 提前更新 README 与测试断言，避免“旧语义断言”误报。

---

## 6. 验收口径（最终DoD）

满足以下全部条件即视为实施完成：

1. 单项目任一 Tick 派发任务数 `<=1`；
2. ACK 必须匹配 `activeWakeupId` 才能推进状态；
3. 第一阶段完整实现设计者/挑刺者回合制；
4. 第二阶段链路行为不回退；
5. 全量单元与集成测试通过；
6. README、manifest、env、changelog 与新语义一致。

---

## 7. 建议执行命令（开发完成后）

```bash
cd /home/zh/projects/VCP/VCPToolBox/Plugin/NovelWorkflowOrchestrator
node --test test/unit/*.test.js test/integration/tickRunner.test.js
find lib -name '*.js' -print0 | xargs -0 -n1 node --check
```

