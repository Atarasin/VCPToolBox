# NovelWorkflowOrchestrator 插件落地计划

## 1. 计划目标

基于《NovelWorkflowOrchestrator插件详细设计文档》，在可控周期内完成插件从“文档设计”到“可运行 MVP”的落地，并具备：

1. 周期 tick 调度；
2. 阶段 Agent 唤醒与上下文分发；
3. 顶层状态机 + 章节子状态机路由；
4. 停滞触发人工介入并冻结唤醒；
5. 可审计、可恢复、可观测。

---

## 2. 范围与产物

### 2.1 本期范围（MVP）

- static 插件主流程；
- 文件存储模型（projects/wakeups/counters/manual_review/checkpoints/audit）；
- 配置加载与阶段映射；
- 回执处理与状态流转；
- 人工介入触发与恢复；
- 基础测试与联调验证。

### 2.2 交付产物

1. `Plugin/NovelWorkflowOrchestrator/` 代码目录；
2. `plugin-manifest.json`；
3. `NovelWorkflowOrchestrator.js`（主入口）；
4. `lib/` 结构化模块实现；
5. `config.env.example`；
6. 最小可运行测试集；
7. 联调说明文档与回归清单。

---

## 3. 目录落地蓝图

```text
Plugin/NovelWorkflowOrchestrator/
├── NovelWorkflowOrchestrator.js
├── plugin-manifest.json
├── config.env.example
├── README.md
├── lib/
│   ├── core/
│   │   ├── tickRunner.js
│   │   ├── workflowStateMachine.js
│   │   └── stateRouter.js
│   ├── managers/
│   │   ├── agentMappingResolver.js
│   │   ├── contextAssembler.js
│   │   ├── wakeupDispatcher.js
│   │   ├── manualInterventionManager.js
│   │   └── qualityGateManager.js
│   ├── storage/
│   │   ├── stateStore.js
│   │   ├── fileLock.js
│   │   └── serializers.js
│   ├── schemas/
│   │   ├── wakeupTask.schema.json
│   │   ├── ack.schema.json
│   │   └── projectState.schema.json
│   └── utils/
│       ├── logger.js
│       ├── idempotency.js
│       └── time.js
└── test/
    ├── unit/
    ├── integration/
    └── fixtures/
```

---

## 4. 分阶段实施（4 周）

## 第 1 周：骨架与存储

目标：跑通 tick 主循环与持久化框架。

任务包：

- 创建插件目录与 manifest；
- 实现 `NovelWorkflowOrchestrator.js` 的 stdin/stdout 框架；
- 实现 `stateStore.js`（读写、目录初始化、快照）；
- 实现项目状态基础结构与 checkpoint 写入；
- 打通 tick 执行“空跑”模式（不派发唤醒）。

验收标准：

- 插件可被 static 调度正常执行；
- 首次运行自动初始化 storage；
- `tick` 输出标准 JSON 成功。

---

## 第 2 周：状态机与唤醒链路

目标：完成状态机与 Agent 唤醒核心路径。

任务包：

- 实现 `workflowStateMachine.js`（顶层状态）；
- 实现 `stateRouter.js`（章节子状态）；
- 实现 `agentMappingResolver.js`（state + substate -> agents）；
- 实现 `contextAssembler.js`（上下文包）；
- 实现 `wakeupDispatcher.js`（幂等键、发送记录、重试元数据）。

验收标准：

- 能按不同状态唤醒正确 Agent；
- 回执为 `acted/waiting/blocked` 时行为正确；
- 角色缺失时触发 `SUPERVISOR` 升级分支。

---

## 第 3 周：质量路由与人工介入

目标：落地治理能力与冻结机制。

任务包：

- 实现 `qualityGateManager.js`（覆盖率/字数/一致性门禁）；
- 实现 `manualInterventionManager.js`（停滞计数、触发、冻结、恢复）；
- 接入双计数器更新（设定轮次、章节迭代）；
- 接入 `manual_review/*.json` 生命周期；
- 完成 `PAUSED_MANUAL_REVIEW` 恢复路径。

验收标准：

- 连续 N tick 无变化可自动触发人工介入；
- 人工回复前不再唤醒；
- 人工回复后可恢复并继续推进。

---

## 第 4 周：测试、联调与发布准备

目标：完成稳定性验证并达到可交付状态。

任务包：

- 单元测试（状态机、映射、路由、门禁、人工介入）；
- 集成测试（阶段推进、回流超限、停滞转人工）；
- 审计日志完整性检查；
- 性能与并发安全检查（文件锁）；
- README 与配置说明完善。

验收标准：

- 关键用例全通过；
- 回归清单通过率 100%；
- 满足上线前 DoD。

---

## 5. 任务拆解清单（可执行）

### 5.1 Core

- 实现 tick 生命周期控制；
- 实现状态推进与子状态路由；
- 实现单 tick 项目推进上限控制。

### 5.2 Storage

- 实现目录初始化；
- 实现原子写入与文件锁；
- 实现 checkpoint 与审计写入。

### 5.3 Protocol

- 定义 `wakeupTask` 与 `ack` schema；
- 实现 schema 校验与容错；
- 统一错误码与失败重试策略。

### 5.4 Governance

- 实现双计数器；
- 实现质量门禁；
- 实现人工介入冻结/恢复。

### 5.5 Observability

- 实现 tick 指标聚合；
- 实现结构化审计日志；
- 实现阻塞原因可视化字段。

---

## 6. 配置落地计划

首版 `config.env.example` 必须包含以下分组：

1. 调度与限流：
   - `NWO_ENABLE_AUTONOMOUS_TICK`
   - `NWO_TICK_MAX_PROJECTS`
   - `NWO_TICK_MAX_WAKEUPS`
2. 门禁与计数：
   - `NWO_SETUP_MAX_DEBATE_ROUNDS`
   - `NWO_CHAPTER_MAX_ITERATIONS`
   - `NWO_SETUP_PASS_THRESHOLD`
   - `NWO_CHAPTER_OUTLINE_COVERAGE_MIN`
   - `NWO_CHAPTER_POINT_COVERAGE_MIN`
   - `NWO_CHAPTER_WORDCOUNT_MIN_RATIO`
   - `NWO_CHAPTER_WORDCOUNT_MAX_RATIO`
3. 人工介入：
   - `NWO_STAGNANT_TICK_THRESHOLD`
   - `NWO_PAUSE_WAKEUP_WHEN_MANUAL_PENDING`
   - `NWO_HUMAN_REVIEWER`
4. 角色映射：
   - 所有 `NWO_STAGE_*` 角色。

---

## 7. 测试计划

### 7.1 单元测试（必须）

- 状态转移合法性；
- 子状态路由分支；
- 角色解析与缺省升级；
- 停滞计数触发；
- 门禁阈值判定；
- 幂等去重。

### 7.2 集成测试（必须）

1. `INIT -> ... -> COMPLETED` happy path；
2. `CH_REVIEW -> CH_REFLOW -> CH_GENERATE` 回流路径；
3. 连续 3 tick 停滞 -> 人工冻结；
4. 人工回复 -> 恢复推进；
5. 主角色缺失 -> `SUPERVISOR` 升级阻塞。

### 7.3 回归测试（上线前）

- 多项目并发下状态隔离；
- 重启恢复一致性；
- 审计日志可回放；
- 配置变更后行为符合预期。

---

## 8. 里程碑与验收点

| 里程碑 | 时间 | 验收产物 |
|---|---|---|
| M1 骨架可跑 | Week 1 末 | 可执行 tick + 存储初始化 |
| M2 路由可用 | Week 2 末 | 状态机 + 唤醒链路 |
| M3 治理可用 | Week 3 末 | 人工介入 + 门禁 + 计数器 |
| M4 可交付 | Week 4 末 | 测试通过 + 文档齐全 |

---

## 9. 风险与缓解

| 风险 | 影响 | 缓解措施 |
|---|---|---|
| Agent 回执不稳定 | 状态推进卡住 | 超时重试 + waiting 分支 + 人工兜底 |
| 文件并发写冲突 | 状态损坏 | 文件锁 + 原子写 + checkpoint |
| 配置缺失 | 关键阶段不可执行 | 启动校验 + `SUPERVISOR` 升级 |
| 阈值配置不合理 | 误触发人工/漏检 | 灰度调参 + 指标监控 |

---

## 10. 上线前 DoD

满足以下条件方可进入上线：

1. 所有 P0/P1 测试通过；
2. 人工介入冻结/恢复链路验收通过；
3. 关键配置均有默认值与说明；
4. 失败路径均有审计记录；
5. 可在空目录首次启动并自初始化；
6. 代码评审完成且无阻塞缺陷。

---

## 11. 建议的下一步

1. 先落地 `config.env.example` 与 `plugin-manifest.json`；
2. 并行推进 `Core + Storage`；
3. 第 2 周开始接入真实 Agent 通道联调；
4. 第 3 周提前拉通人工介入闭环；
5. 第 4 周锁功能只做稳定性与验收。

