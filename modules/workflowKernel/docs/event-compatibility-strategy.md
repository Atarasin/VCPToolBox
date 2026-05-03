# 事件兼容策略文档

**日期：** 2026-04-30
**状态：** S01 契约裁决文档

---

## 一、分层策略

```
Kernel Layer (generic events)
    ↓
Compatibility Adapter (maps generic → legacy)
    ↓
StoryOrchestrator Frontend / State Consumers (legacy events)
```

**原则：**
- 内核只产生 generic 事件，不感知任何业务语义
- 适配层负责将 generic 事件映射到 StoryOrchestrator 的 12 种现有事件类型
- 迁移稳定后，适配层可以逐步收缩，最终前端直接消费 generic 事件

---

## 二、内核 Generic 事件 Schema

### 事件格式

```javascript
{
  type: 'workflow.state_changed',     // 事件类型命名空间
  workflowId: 'story-123',
  timestamp: '2026-04-30T10:00:00Z',
  payload: { ... }                    // 事件特定数据
}
```

### 内核事件类型全集

| 事件类型 | 触发时机 | Payload |
|---------|---------|---------|
| `workflow.started` | execute() 首次调用 | `{ definitionRef, initialContext }` |
| `workflow.state_changed` | 执行态发生跃迁 | `{ from, to, reason }` |
| `workflow.step_started` | 步骤开始执行 | `{ stepId, stepType, phaseId }` |
| `workflow.step_completed` | 步骤成功完成 | `{ stepId, stepType, outputKey }` |
| `workflow.step_failed` | 步骤失败（含重试前） | `{ stepId, stepType, error, attempt }` |
| `workflow.checkpoint_pending` | 检查点触发，等待人工干预 | `{ checkpointId, checkpointType, promptTemplate }` |
| `workflow.checkpoint_approved` | 检查点被批准 | `{ checkpointId, action, feedback }` |
| `workflow.checkpoint_rejected` | 检查点被拒绝 | `{ checkpointId, action, feedback }` |
| `workflow.checkpoint_auto_approved` | 检查点超时自动批准 | `{ checkpointId, expiredAt }` |
| `workflow.retrying` | 步骤进入重试 | `{ stepId, attempt, maxAttempts, delayMs }` |
| `workflow.completed` | 工作流成功完成 | `{ outputs, durationMs }` |
| `workflow.failed` | 工作流最终失败 | `{ error, failedStepId }` |
| `workflow.rollback` | 工作流回滚到先前检查点 | `{ targetCheckpointId, targetPhase }` |

---

## 三、StoryOrchestrator 现有事件映射表

StoryOrchestrator 当前通过 `WorkflowEngine._notify()` 推送 12 种业务事件：

| StoryOrchestrator 事件 | 内核 Generic 来源 | 适配层映射逻辑 |
|----------------------|------------------|---------------|
| `workflow_started` | `workflow.started` 或 `workflow.state_changed(to: 'running')` | 首次进入 running 时发送 |
| `workflow_resuming` | `workflow.state_changed(to: 'running')` | 从 waiting_checkpoint 恢复时发送 |
| `workflow_recovery_started` | `workflow.state_changed(to: 'recovering')` | 崩溃恢复开始时发送 |
| `phase_completed` | `workflow.step_completed` | 当 step 是阶段的最后一个 step 时发送 |
| `phase_failed` | `workflow.step_failed` | 当 step 失败且重试耗尽时发送 |
| `phase_restart` | `workflow.retrying` | 阶段重试时发送（attempt > 1） |
| `phase_retry` | `workflow.retrying` | 同 phase_restart |
| `checkpoint_created` | `workflow.checkpoint_pending` | 检查点创建时发送 |
| `checkpoint_pending` | `workflow.checkpoint_pending` | 同 checkpoint_created |
| `checkpoint_approved` | `workflow.checkpoint_approved` | 直接映射 |
| `checkpoint_rejected` | `workflow.checkpoint_rejected` | 直接映射 |
| `checkpoint_auto_approved` | `workflow.checkpoint_auto_approved` | 直接映射 |
| `chapter_checkpoint_rejected` | `workflow.checkpoint_rejected` | 当 checkpointType 包含 'chapter' 时映射为此 |
| `workflow_completed` | `workflow.completed` | 直接映射 |
| `final_acceptance` | `workflow.completed` | 当最后一个 step 是 final_acceptance 时映射为此 |
| `workflow_rollback` | `workflow.rollback` | 直接映射 |
| `rollback` | `workflow.rollback` | 同 workflow_rollback |

---

## 四、适配层实现草案

```javascript
class StoryEventAdapter {
  constructor(kernel) {
    this.kernel = kernel;
    this.phaseStepMap = new Map(); // 记录每个 phase 包含哪些 steps
  }

  onKernelEvent(event) {
    const legacyEvents = this._mapToLegacy(event);
    for (const legacy of legacyEvents) {
      this._notify(legacy);
    }
  }

  _mapToLegacy(event) {
    switch (event.type) {
      case 'workflow.started':
        return [{ eventType: 'workflow_started', payload: event.payload }];

      case 'workflow.state_changed':
        if (event.payload.to === 'running' && event.payload.from === 'waiting_checkpoint') {
          return [{ eventType: 'workflow_resuming', payload: event.payload }];
        }
        if (event.payload.to === 'recovering') {
          return [{ eventType: 'workflow_recovery_started', payload: event.payload }];
        }
        return [];

      case 'workflow.step_completed':
        const isLastStep = this._isLastStepInPhase(event.payload.stepId);
        if (isLastStep) {
          return [
            { eventType: 'phase_completed', payload: { phase: this._getPhaseForStep(event.payload.stepId), ...event.payload } }
          ];
        }
        return [];

      case 'workflow.step_failed':
        return [{ eventType: 'phase_failed', payload: event.payload }];

      case 'workflow.checkpoint_pending':
        return [
          { eventType: 'checkpoint_created', payload: event.payload },
          { eventType: 'checkpoint_pending', payload: event.payload }
        ];

      case 'workflow.checkpoint_rejected':
        if (event.payload.checkpointType?.includes('chapter')) {
          return [{ eventType: 'chapter_checkpoint_rejected', payload: event.payload }];
        }
        return [{ eventType: 'checkpoint_rejected', payload: event.payload }];

      // ... 其他映射
    }
  }
}
```

---

## 五、迁移退出标准

适配层可以逐步收缩，最终前端直接消费 generic 事件。退出条件：

1. **StoryOrchestrator 前端代码**不再依赖 `phase_completed`、`checkpoint_pending` 等业务事件名，改为监听 `workflow.step_completed`、`workflow.checkpoint_pending` 等 generic 事件
2. **状态查询 API**不再返回 `phase1.status`、`phase2.status` 等业务态字段，改为返回 `executionCursor` 和 `steps` 状态
3. **所有集成测试**直接验证 generic 事件序列，不再验证 legacy 事件映射

**预计时间：** 适配层至少保留到 StoryOrchestrator 新路径稳定运行 2-4 周后。
