# WorkflowKernel 替代 StoryOrchestrator OpenSpec Change 拆分建议

## 文档目标

本文基于《`workflow-kernel-storyorchestrator-replacement-review.md`》中的评审结论，将后续改造拆分为一组适合按 OpenSpec 推进的 changes，便于团队：

- 逐个收口稳定 contract，而不是一次性发起一个过大的替代 change
- 按依赖关系安排实现顺序，降低 `WorkflowKernel` 与 `WorkflowEngine` 双控制面的耦合风险
- 让每个 change 都有明确的验收标准、测试落点和归档边界

读完本文后，维护者应能够直接按推荐顺序创建 `openspec/changes/<change-id>/`，并为每个 change 准备对应的 `proposal.md`、`design.md`、`tasks.md` 与 delta specs。

## 拆分原则

本次拆分遵循当前仓库中的 OpenSpec 规则，尤其强调以下几点：

- `specs` 只记录稳定 contract，不把临时实现细节写成长期 requirement
- 优先收口共享语义到内核或共享 contract，不把复杂度继续散落到 adapter 和旧引擎
- 每个 change 必须可单独验收，并附带聚焦测试
- 对 `WorkflowKernel` 的替代性声明，必须建立在真实行为闭环和回归验证之上，而不是建立在“有配置接口”之上

## 总体判断

不建议把本次改造作为一个单一大 change 来推进。

原因很明确：

- 评审报告中的缺口横跨 phase 入口、checkpoint 语义、retry、recovery、控制面收敛、插件 SDK 和最终替代验收
- 这些问题的重要性不同、依赖关系不同、稳定性边界也不同
- 如果混在一个 change 里，后续会很难判断哪些 requirement 已经稳定，哪些还只是中间态

更合适的做法是拆成 `7` 个 changes，分三波推进：

1. 第一波先补正确性闭环
2. 第二波再收敛控制面与恢复语义
3. 第三波再抽象插件 SDK，并做最终替代性验收

## 目标态约束

这组 change 的最终目标，不只是让 `workflowKernel` 能覆盖 `StoryOrchestrator` 当前流程，更是让 `StoryOrchestrator` 最终收敛成一个薄型参考插件。

因此，后续拆分和验收应始终围绕下面的目标态：

- `WorkflowKernel` 成为唯一主执行控制面。
- `StoryOrchestrator` 不再保留通用 checkpoint、retry、rollback、recovery 主逻辑。
- `StoryOrchestrator` 主要保留 workflow definition、少量故事领域 step、业务状态投影和插件装配。
- 第三个阶段结束后，`StoryOrchestrator` 应可作为未来工作流插件的样板，而不是继续作为历史兼容特例存在。

如果某个 change 虽然补了一部分功能，但最终让 `StoryOrchestrator` 更重、让 adapter 更厚、让旧引擎更难退出，那么它就不符合本拆分文档的目标。

为便于在执行阶段把“目标态”落到现有代码结构，建议将以下两份文档作为本拆分文档的配套输入：

- `workflow-kernel-storyorchestrator-retain-migrate-retire-checklist.md`
- `workflow-kernel-storyorchestrator-module-mapping-checklist.md`

在第三波完成后，建议再配合阅读《`workflow-kernel-third-wave-status-summary.md`》，用于区分：

- 第三波已经完成的稳定交付
- 已经成立的替代认证结论
- 仍需继续审查的薄型参考插件结构收敛项

若要继续把这部分结构收敛工作转成新的 OpenSpec follow-up，建议再阅读《`workflow-kernel-storyorchestrator-structural-convergence-change-plan.md`》。

若要理解这个 follow-up change 在归档后已经完成了哪些结构收敛动作、当前阶段结论如何表述，以及后续还剩哪些集中结构债，建议继续阅读《`workflow-kernel-storyorchestrator-structural-convergence-post-archive-summary.md`》。

## 推荐依赖图

```text
workflow-kernel-phase-execution-parity                ─┐
workflow-kernel-checkpoint-lifecycle                 ──┼──> workflow-kernel-recovery-rollback-runtime ──┐
workflow-kernel-failure-policy-runtime               <─┘                                                │
                                                                                                          ├──> workflow-kernel-single-control-plane
workflow-kernel-plugin-authoring-sdk                 <────────────────────────────────────────────────────┘
workflow-kernel-replacement-certification            <────────────────────────────────────────────── depends on single-control-plane + plugin-authoring-sdk
```

更线性的建议顺序如下：

1. `workflow-kernel-phase-execution-parity`
2. `workflow-kernel-checkpoint-lifecycle`
3. `workflow-kernel-failure-policy-runtime`
4. `workflow-kernel-recovery-rollback-runtime`
5. `workflow-kernel-single-control-plane`
6. `workflow-kernel-plugin-authoring-sdk`
7. `workflow-kernel-replacement-certification`

## Change 1：`workflow-kernel-phase-execution-parity`

### 目标

先修复和澄清 phase 级 kernel 执行入口，使系统至少具备“按 phase 进入 kernel 路径时不会直接失效”的基础能力。

### 为什么单独成 change

这是最小可验证的正确性 change，也是后续所有 phase 迁移、恢复和自动推进的入口前提。报告中已经明确证明：

- `WorkflowEngine._loadPhaseDefinition()` 当前会因为缺少依赖而失败
- phase2 和 phase3 definition 目前并不齐备
- phase 级入口如果不先收口，后面的恢复、重试和控制面收敛都无法建立在稳定前提上

### 建议范围

- 修复 `WorkflowEngine` 装载 phase definition 的基础问题
- 明确 `phase1 / phase2 / phase3` 的 kernel definition 来源
- 如果不再支持 phase 级入口，则在 contract 上明确废弃，并收口到完整 workflow 入口
- 统一 `executeWorkflow` 与 `executePhase` 的最小状态模型差异

### 建议 capability

- `workflow-kernel-phase-runtime`

### 建议 spec 主题

- phase definition loading contract
- phase execution entry contract
- phase execution state contract

### 验收标准

- phase 级 kernel definition 能被稳定装载，或 phase 入口被显式下线且文档同步
- `phase1 / phase2 / phase3` 至少有明确的一致性策略，不再处于“只有部分文件存在”的状态
- phase 级执行失败时，错误会落在可诊断的统一行为上，而不是静默回退或返回 `null`

### 测试重点

- `WorkflowEngine._loadPhaseDefinition('phase1' | 'phase2' | 'phase3')`
- phase definition 缺失或损坏时的错误路径
- `executeWorkflow` 与 `executePhase` 的最小状态一致性检查

### 依赖

- `depends: []`

## Change 2：`workflow-kernel-checkpoint-lifecycle`

### 目标

把 checkpoint 从“部分能跑的挂起点”升级为真正的内核原生生命周期语义，补齐 `approve / reject / skip / modify / timeout` 的一致行为。

### 为什么单独成 change

checkpoint 是评审报告里最明显的 P0 缺口：

- `reject` 语义当前是错误的
- timeout auto-approve 不会自动继续 workflow
- 事件、状态推进和 manager 内部状态目前没有形成同一个闭环

这类能力是生产级编排的基础，不应继续依赖旧引擎补洞。

### 建议范围

- 明确定义 checkpoint action 状态机
- 让 `resume()` 对不同 action 走不同分支
- 让 timeout 真正触发 workflow 继续，而不是只改 manager 内部状态
- 统一 checkpoint 事件、持久化状态、运行状态推进

### 建议 capability

- `workflow-kernel-checkpoint-runtime`

### 建议 spec 主题

- checkpoint action contract
- checkpoint timeout continuation contract
- checkpoint event and persistence contract

### 验收标准

- `approve / reject / skip / modify` 的行为可区分且经过测试验证
- checkpoint timeout 后 workflow 会继续执行或进入明确的下一状态
- 事件名称、payload、持久化状态与最终行为一致，不再出现“事件叫 approved 但 action 是 reject”的情况

### 测试重点

- `WorkflowKernel.resume(... action: 'reject')` 回流路径
- timeout auto-approve 后自动继续执行
- checkpoint 事件与最终 workflow 状态一致性
- checkpoint 解析结果的持久化与恢复

### 依赖

- `depends: []`

## Change 3：`workflow-kernel-failure-policy-runtime`

### 目标

把当前只停留在接口层的 `RetryPolicy`、step 失败策略和反馈驱动再执行语义真正接入主执行链。

### 为什么单独成 change

报告已经指出：当前 `RetryPolicy` 更像“能力接口已铺好”，还不是实际生效的 runtime。把这部分独立成 change，能够避免它继续被埋在 recovery 或控制面收敛里，导致边界模糊。

### 建议范围

- 将 `globalRetryPolicy` 与 step 级 `retryPolicy` 接入 step 执行链
- 定义失败后的标准行为模型，例如 `fail / retry / checkpoint / rollbackToSnapshot / restartPhase`
- 支持 checkpoint rejection 驱动的重试或再执行入口
- 明确 loop、parallel、自定义 step 的重试边界

### 建议 capability

- `workflow-kernel-failure-policy`

### 建议 spec 主题

- retry policy execution contract
- step failure policy contract
- feedback driven re-execution contract

### 验收标准

- step 失败后会按策略决定重试、失败或转入其他动作，而不是统一结束 workflow
- retry 次数、延迟和最终结果可预测且可验证
- checkpoint rejection 能与失败策略衔接，而不是只停留在 action 解析层

### 测试重点

- step 失败后的 retry 次数与 delay 行为
- 全局策略与 step 局部策略的优先级
- loop、parallel、自定义 step 的代表性失败路径
- checkpoint rejection 触发 retry 或回退的路径

### 依赖

- `depends: [workflow-kernel-checkpoint-lifecycle]`

## Change 4：`workflow-kernel-recovery-rollback-runtime`

### 目标

把 `RecoveryManager`、rollback 安全边界、restart phase 和 crash recovery 收口为真正可依赖的运行时能力。

### 为什么单独成 change

恢复语义是另一块生产级闭环，不适合和 retry 或控制面 change 混写。当前问题集中在：

- `current_step` 反推与对象顺序依赖不稳
- rollback 边界缺乏 phase 精度
- `parallelGroup`、`loop`、自定义步骤恢复语义缺失
- 非幂等步骤识别过于粗糙

这部分应作为单独 change 做完整设计。

### 建议范围

- 统一恢复游标、phase 精度与 step 精度模型
- 定义 restart phase、continue recovery、rollback 的输入输出 contract
- 为 `parallelGroup`、`loop`、自定义 step 建立最小恢复语义
- 建立非幂等步骤和安全回滚边界的正式规则

### 建议 capability

- `workflow-kernel-recovery-runtime`

### 建议 spec 主题

- recovery cursor contract
- rollback safety contract
- restart phase contract
- non-idempotent step recovery contract

### 验收标准

- crash recovery 能稳定恢复到正确的 phase/step 边界
- `restart_phase`、rollback、continue recovery 的行为在 kernel 路径下可独立验证
- `parallelGroup`、`loop` 和至少一类自定义 step 有被明确建模的恢复行为

### 测试重点

- crash 后 continue recovery
- rollback 到业务安全点
- restart phase 后重新执行
- `parallelGroup`、`loop` 的恢复与幂等判断

### 依赖

- `depends: [workflow-kernel-phase-execution-parity, workflow-kernel-checkpoint-lifecycle, workflow-kernel-failure-policy-runtime]`

## Change 5：`workflow-kernel-single-control-plane`

### 目标

消除 `WorkflowKernel + StoryOrchestratorKernelAdapter + WorkflowEngine` 三层并行控制，让 kernel 成为唯一主执行控制面，或至少把 legacy engine 明确降级为兼容壳。

### 为什么单独成 change

这是“是否真正替代手写工作流”的核心 change，但它不应该先于正确性语义。只有 phase、checkpoint、retry、recovery 都具备稳定 contract 后，才能把控制权真正上收。

### 建议范围

- 明确 kernel 对 phase 迁移、resume、recover、rollback、auto-approve 的主导权
- 下沉旧引擎中仍残留的关键状态推进逻辑
- 统一事件流和状态推进入口
- 明确 `WorkflowEngine` 的最终角色：兼容壳、门面、或逐步退出主路径

### 建议 capability

- `workflow-kernel-control-plane`

### 建议 spec 主题

- workflow control plane ownership contract
- legacy engine compatibility contract
- unified execution entry contract

### 验收标准

- 关键状态推进不再依赖旧引擎补逻辑
- workflow definition 成为行为的主要来源，而不是“内核 + adapter + 旧引擎”的混合结果
- 关闭 legacy path 后，主流程仍可跑通

### 测试重点

- auto-approve、resume、recover、rollback 的统一入口测试
- 关闭 legacy path 的完整主流程回归
- kernel 路径和 legacy path 的状态对齐或兼容退出测试

### 依赖

- `depends: [workflow-kernel-phase-execution-parity, workflow-kernel-checkpoint-lifecycle, workflow-kernel-failure-policy-runtime, workflow-kernel-recovery-rollback-runtime]`

## Change 6：`workflow-kernel-plugin-authoring-sdk`

### 目标

把当前 StoryOrchestrator adapter 中可复用的模式抽成通用工作流 SDK，使未来插件作者主要写 workflow definition 和少量业务 step，而不是复制一套重型 adapter。

### 为什么单独成 change

“未来工作流插件更简单”不是替代性正确性的自然副产品，而是一层额外的产品化抽象。把它独立成 change，才能避免在前几轮正确性修复期间过早冻结不成熟的插件 API。

### 建议范围

- 提炼标准 schema validation step、human review step、prompt/validation/revision 模式
- 定义 phase outputs、checkpoint payload、business snapshot、artifact store 的正式 contract
- 提供 step factory、phase macro 或等价 authoring helper
- 输出最小 authoring guide 和 reference implementation
- 以 `StoryOrchestrator` 为收敛对象，明确哪些现有私有逻辑应迁移进 SDK，哪些应保留为故事领域专属能力

### 建议 capability

- `workflow-kernel-plugin-sdk`
- `workflow-kernel-business-contracts`

### 建议 spec 主题

- plugin workflow authoring contract
- business snapshot contract
- artifact projection contract
- reusable step macro contract

### 验收标准

- 新插件不必复制 StoryOrchestrator 级别的 adapter 才能接入 kernel
- phase 产物、审批 payload、业务快照具备统一 contract
- 至少一套标准 step/macro 可被多个工作流复用
- `StoryOrchestrator` 本身明显变薄，其保留代码以 definition、领域 step 和业务投影为主

### 测试重点

- 通用 step factory 的单元测试
- snapshot/artifact contract 的契约测试
- reference workflow 的集成测试

### 依赖

- `depends: [workflow-kernel-checkpoint-lifecycle, workflow-kernel-recovery-rollback-runtime]`

## Change 7：`workflow-kernel-replacement-certification`

### 实施结果更新（2026-05-03）

该 change 的 artifacts 与第一轮实现已完成，当前已确认的结果如下：

- 已补齐 replacement certification 的证据文档与任务面板
- 已新增 compatibility shell 认证测试，验证 `WorkflowEngine` 在 kernel 模式下只保留委托职责
- 已新增真实 `StoryOrchestratorKernelAdapter` 驱动的 kernel-led 三阶段绿色路径，验证
  `phase1 -> phase2 -> phase3 -> completed`
- 已补齐 `modify / timeout / restart_phase / rollback / 跨阶段恢复` 的替代性回归证据
- 已通过第二个 minimal reference consumer 证明 shared `pluginSdk` 与 business contract 不只服务于 `StoryOrchestrator`

当前尚未最终关闭的事项不是运行时替代证据，而是 `StoryOrchestrator` 作为“薄型参考插件”的结构收敛结论；这部分需要继续结合目标态文档与模块映射清单审查。

### 目标

以最终替代标准为导向，验证前述 changes 组合后，`WorkflowKernel` 是否已经具备“全面替代 StoryOrchestrator 手写工作流”的资格，并验证其抽象是否对第二个插件成立。

### 为什么单独成 change

这是验收性 change，不建议提前混入功能性 change。原因是：

- 它的核心产出是“替代声明成立的证据”
- 它需要跨多个前置 change 的联合验证
- 它应当尽量只在核心 contract 稳定后执行

### 建议范围

- 关闭或旁路 legacy path，验证全流程仅由 kernel 控制面完成
- 补齐替代性回归测试矩阵
- 以至少一个非 StoryOrchestrator 插件或最小参考插件验证 SDK 通用性
- 形成对外可引用的替代验收结论
- 明确验证 `StoryOrchestrator` 是否已经达到“薄插件样板”目标，而不是只验证原流程可跑

### 建议 capability

- `workflow-kernel-replacement-certification`

### 建议 spec 主题

- replacement acceptance contract
- legacy-off execution contract
- secondary plugin proof contract

### 验收标准

- StoryOrchestrator 全流程只走 kernel 控制面即可完成
- checkpoint `approve / reject / timeout / modify` 语义全部正确
- `restart_phase`、rollback、continue recovery 全部可用
- RetryPolicy 在真实执行链中生效
- phase2 / phase3 与跨阶段输出恢复可通过测试
- 至少一个非 StoryOrchestrator 插件以较低成本接入
- `StoryOrchestrator` 不再保留独立工作流控制面，且可被视为未来插件的参考实现

### 测试重点

- legacy-off 端到端全流程验证
- 替代性回归矩阵
- 第二插件或参考插件接入验证
- 关键契约的文档化验收

### 依赖

- `depends: [workflow-kernel-single-control-plane, workflow-kernel-plugin-authoring-sdk]`

## 每个 change 建议包含的 OpenSpec 产物

为了便于团队直接起 change，建议所有 change 都采用相同骨架：

- `proposal.md`
  - 说明为什么现在做
  - 说明要解决的用户/平台问题
  - 说明为什么不和其他 changes 混做
- `design.md`
  - 只描述本 change 内部的核心设计
  - 不提前冻结下游 change 的具体实现
- `tasks.md`
  - 明确代码任务、测试任务、文档任务
  - 每条任务都必须能独立核销
- `specs/<capability>/spec.md`
  - 只写本 change 需要新增或修改的 requirement
  - 避免在 spec 中写临时迁移脚本、调试手段或过渡性细节

## 推荐分三波起 change

### 第一波：正确性闭环

优先发起：

1. `workflow-kernel-phase-execution-parity`
2. `workflow-kernel-checkpoint-lifecycle`
3. `workflow-kernel-failure-policy-runtime`

这一波的目标不是宣布“已替代”，而是先让内核关键运行语义成立。

### 第二波：生产级运行时闭环

在第一波稳定后发起：

1. `workflow-kernel-recovery-rollback-runtime`
2. `workflow-kernel-single-control-plane`

这一波完成后，才可以开始认真评估 legacy engine 是否还能退出主路径。

### 第三波：平台化与替代验收

最后发起：

1. `workflow-kernel-plugin-authoring-sdk`
2. `workflow-kernel-replacement-certification`

这一波的目标是回答两个最终问题：

- 未来插件是否真的更简单
- `WorkflowKernel` 是否真的足以对外宣称替代 StoryOrchestrator 手写工作流
- `StoryOrchestrator` 是否已经被收敛成薄型参考插件

这一波执行时，建议直接以模块映射版清单作为裁剪依据，逐项判断当前 `StoryOrchestrator` 模块应保留、迁入内核、迁入 SDK 还是退出主路径。

## 不建议的拆法

以下拆法不建议采用：

- 把所有问题合成一个 `workflow-kernel-replace-story-orchestrator` 大 change
- 单独起一个“补测试”的 change，而不把测试跟着行为 change 一起落地
- 先起插件 SDK change，再反过来补 checkpoint/recovery 正确性
- 继续把关键语义留在 `WorkflowEngine` 或 adapter 中，却在 OpenSpec 里宣称 kernel 已替代

## 建议结论

基于当前评审报告，最合适的 OpenSpec 拆分方式不是按代码目录拆，而是按“稳定行为语义”拆。

推荐最终采用以下 7 个 change：

1. `workflow-kernel-phase-execution-parity`
2. `workflow-kernel-checkpoint-lifecycle`
3. `workflow-kernel-failure-policy-runtime`
4. `workflow-kernel-recovery-rollback-runtime`
5. `workflow-kernel-single-control-plane`
6. `workflow-kernel-plugin-authoring-sdk`
7. `workflow-kernel-replacement-certification`

这组拆分的好处是：

- 每个 change 都有明确的 OpenSpec 归属边界
- 依赖顺序与评审报告中的风险优先级基本一致
- 测试和验收可以跟 change 同步推进
- 最终既能支撑内核替代目标，也能支撑“未来插件更简单”的平台化目标
- 最终能把 `StoryOrchestrator` 从历史迁移对象收敛为未来插件样板
