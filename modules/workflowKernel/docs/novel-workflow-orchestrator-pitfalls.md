# NovelWorkflowOrchestrator 已识别问题清单

**分析日期：** 2026-04-30
**分析范围：** `lib/core/workflowStateMachine.js`, `lib/core/tickRunner.js`
**结论：** 整体未跑通，仅作为问题样本参考，不作为 M002 实现基线。

---

## 1. ACK 驱动状态机：执行态与外部输入紧耦合

**问题：** 状态迁移直接依赖外部 ACK 的 `ackStatus`（acted/blocked/waiting）。
```javascript
// workflowStateMachine.js
if (ackStatus === 'blocked') { return { advanced: false, blocked: true }; }
if (ackStatus === 'waiting') { return { advanced: false, blocked: false }; }
if (ackStatus !== 'acted') { return { advanced: false, blocked: false }; }
```
**风险：** 状态机无法独立测试，必须构造完整的 ACK 对象才能验证状态迁移。

---

## 2. 业务语义硬编码在执行态中

**问题：** `designer`/`critic` 角色轮转直接写在状态机里。
```javascript
if (debate.role === 'designer') {
  nextProject.debate = { ...debate, role: 'critic' };
  return { reason: 'setup_designer_to_critic' };
}
```
**风险：** 状态机变成了业务规则的容器，无法复用于无辩论模式的工作流。

---

## 3. TickRunner 职责过重（单体反模式）

**问题：** `runTick()` 单函数超过 400 行，同时处理：
- ACK 归一化与去重
- 状态迁移
- 质量门禁应用
- 人工介入检测
- 任务派发（wakeup dispatch）
- 审计落盘
- 计数器更新
- 停滞检测

**风险：** 任何一处修改都需要理解整个 tick 流程，单元测试无法拆分。

---

## 4. 质量门禁与状态机紧耦合

**问题：** `applyQualityGateToAck()` 直接修改 ACK 后传入状态机。
```javascript
const qualityApplied = applyQualityGateToAck(project, ack, policy);
gatedAck = qualityApplied.ack;
transition = applyStateTransition(project, gatedAck, now);
```
**风险：** 质量门禁变成了状态机的前置过滤器，无法独立演化。

---

## 5. 人工介入逻辑分散

**问题：** 人工介入检测（stagnation、limit、severity）散布在 tickRunner 的多个条件分支中，而非集中管理。

---

## 6. 存储抽象层级混乱

**问题：** `stateStore` 直接操作文件系统（JSON 文件 + 自定义 serializers），没有清晰的 repository 接口。
**风险：** 无法在不重写存储层的情况下切换到 SQLite 或其他持久化方案。

---

## 7. 唤醒预算机制引入不必要的调度复杂度

**问题：** `tickMaxWakeups` 限制每轮 tick 的唤醒数量。
**风险：** 这是调度策略而非工作流编排 concern，不应由编排内核管理。

---

## 8. 缺乏清晰的执行态/业务态分层

**问题：** 顶层状态（SETUP_WORLD, SETUP_CHARACTER）与业务阶段强绑定，没有抽象的"执行态"（running/waiting/completed）概念。
**风险：** 新增工作流必须重新定义一套状态常量，无法复用。
