# WorkflowKernel 三波完善后 StoryOrchestrator 目标态说明

## 当前状态更新（2026-05-03）

`workflow-kernel-replacement-certification` 完成第一轮认证后，当前仓库已经具备下面这些已验证事实：

- `WorkflowEngine` 在 kernel 模式下已被验证为 compatibility shell，`start()`、`resume()`、`retryPhase()`、`recover()` 的主控制权由 `WorkflowKernel` 持有
- 真实 `StoryOrchestratorKernelAdapter` 已被测试验证可基于共享 `workflow-definition.js` 跑通
  `phase1 -> phase2 -> phase3 -> completed` 的公共主流程
- `phase2` 大纲与正文输出，以及 `phase3` 润色与终编输出，已被验证为可在 kernel-led 路径下连续消费
- 第二个 minimal reference consumer 已复用 shared `pluginSdk`、checkpoint contract 与 macro pattern，说明 SDK 通用性已得到最小证明

但这还不等于 `StoryOrchestrator` 已经完全达到“薄型参考插件”终态。当前更准确的口径是：

- replacement certification 的运行时证据已经成立
- `StoryOrchestrator` 的结构收敛方向已经明确
- 最终是否可直接宣称为“薄型参考插件”，仍需继续结合模块映射和保留/迁移/退出清单做结构审查

## 当前结构收敛更新（2026-05-04）

`workflow-kernel-storyorchestrator-structural-convergence` 进入实现后，当前仓库已经进一步把“reference consumer 候选态”和“薄型参考插件终态”之间的差距写实为下面几类事实：

- `WorkflowEngine`、`Phase1/2/3` 和 `workflow-phase1` 已被明确标注为 compatibility shell / compatibility artifact，不再作为未来新增主控制逻辑的承接点
- `StoryOrchestratorKernelAdapter` 已完成第一轮职责切片，至少能区分 kernel bridge、business snapshot projector、legacy event compatibility 与 helper glue
- `StateManager`、`StoryStateRepository`、`ArtifactManager` 已把业务投影与 runtime compatibility state 的边界写得更清楚，但仍未完全摆脱同层共存
- `ContentValidator`、`ChapterOperations`、`steps/index`、`SchemaValidator` 已开始显式区分“可复用编排骨架”和“故事领域规则”，避免继续用“整块迁移到 SDK”这种过度泛化口径描述它们

## 当前状态投影边界更新（2026-05-04）

`workflow-kernel-storyorchestrator-state-projection-boundaries` 的首批实现完成后，当前仓库又进一步把“业务投影”和“兼容性残留状态”之间的边界写实为下面几类事实：

- `StateManager` 已把初始故事投影、phase projection 默认值、snapshot rehydrate、checkpoint compatibility view 与 workflow compatibility patch 拆成显式 helper
- `StoryStateRepository` 已把 artifact rows 明确命名为 projection/index lookup，而不是默认被理解为 workflow runtime source
- `ArtifactManager` 已把 artifact indexing 写实为 best-effort projection record，而不是第二套 workflow state persistence
- 针对 malformed snapshot fallback、workflow compatibility patch、artifact index failure、artifact list lookup 的聚焦测试已经落地，说明这轮边界不只停留在注释层

这意味着当前更准确的判断进一步变成：

- `StoryOrchestrator` 的状态层已经不只是“口头上区分投影与真相”，而是开始通过 helper 结构、注释和测试一起压制误读
- 但它仍然没有完全摆脱“业务投影 + compatibility residue”在同一插件状态层中的并存现实，因此还不能宣称 thin reference plugin 已完全闭合

这意味着当前更准确的判断是：

- `StoryOrchestrator` 已经不是“继续长大的厚插件”
- 但它也还没有完全达到“可直接作为薄型参考插件宣称完成”的状态

当前剩余的主要阻塞项仍然包括：

- `StoryOrchestratorKernelAdapter` 虽已切职责，但仍未收缩到真正的 thin adapter 形态
- `StateManager` / `StoryStateRepository` 中仍保留 runtime compatibility state，需要继续防止这些字段被误读为 kernel runtime truth
- validator / step / chapter helper 的可复用骨架虽然已被显式标注，但尚未真正沉淀为独立 SDK surface

## 文档目标

本文用于定义在 `WorkflowKernel` 完成三波完善之后，`StoryOrchestrator` 应处于什么状态。

它回答的不是“内核还缺什么”，而是更具体的问题：

- 三波完成后，`StoryOrchestrator` 还应该保留哪些职责
- 哪些职责必须迁移到 `WorkflowKernel` 或插件 SDK
- 什么样的 `StoryOrchestrator` 才能被称为“未来工作流插件的样板”
- 如何判断它已经从“重型业务插件”演进为“薄插件参考实现”

读完本文后，负责工作流平台、插件架构和 StoryOrchestrator 演进的工程师应能够：

- 对三波改造后的目标状态形成统一理解
- 在后续 OpenSpec change 中判断哪些代码应该保留，哪些应该下沉，哪些应该删除或降级
- 用一致的标准评估 `StoryOrchestrator` 是否已经具备“参考插件”资格

若需要把本目标态进一步落到当前代码结构上，应配合阅读《`workflow-kernel-storyorchestrator-retain-migrate-retire-checklist.md`》与《`workflow-kernel-storyorchestrator-module-mapping-checklist.md`》。

## 一句话目标

三波完善完成后，`StoryOrchestrator` 应不再是一个“自带半套工作流引擎的业务系统”，而应成为：

**一个基于 `WorkflowKernel` 运行的薄型领域插件，同时也是未来工作流插件接入的参考实现。**

更具体地说，它应满足两个条件：

1. 它不再拥有独立工作流控制面。
2. 它保留下来的代码大部分都是故事生成领域语义，而不是通用编排补洞逻辑。

## 为什么必须先写目标态

如果没有明确目标态，三波改造很容易退化成“持续修补当前集成方案”，最终结果可能是：

- 内核能力增强了，但 `StoryOrchestrator` 仍然很重
- adapter 和旧引擎仍然承担大量关键语义，只是写法变了一点
- 未来插件作者依旧需要复制一套大 adapter、大量 custom step 和业务状态桥接

这会让“内核替代”和“未来插件更简单”两个目标都停留在口号层。

所以，后续所有 change 的判断基线都应该是：

- 这项改动是否让 `WorkflowKernel` 更接近唯一控制面
- 这项改动是否让 `StoryOrchestrator` 更接近薄插件
- 这项改动是否让第二个插件更容易复用现有模式

## 目标态总览

在理想目标态下，系统职责应被重新切分为下面的结构：

```text
WorkflowKernel
├── phase / step 执行控制
├── checkpoint 语义
├── retry / failure policy
├── recovery / rollback / restart phase
├── 统一事件与状态模型
└── 插件 authoring SDK 与标准 contract

StoryOrchestrator
├── workflow definition
├── story-specific custom steps
├── prompt / schema / artifact 领域配置
├── 业务状态投影
└── 插件入口与注册
```

这意味着最终的 `StoryOrchestrator` 不应该继续承担：

- phase 迁移控制
- checkpoint 状态机
- timeout 自动推进
- retry / rollback / recovery 主逻辑
- 旧引擎补洞
- 大量为了对接 kernel 缺口而存在的厚 adapter

## 三波完成后的 StoryOrchestrator 应是什么状态

### 第一波完成后：从“能跑”进入“关键语义可信”

第一波的重点是正确性闭环，不是直接把插件变薄。

这一阶段完成后，`StoryOrchestrator` 的状态应是：

- kernel 路径的 phase 入口和主要执行路径可用
- checkpoint 的 `approve / reject / skip / modify / timeout` 语义可信
- step 失败后的重试或失败策略不再停留在配置层
- 业务主流程不再依赖明显错误的运行时语义勉强跑通

此时它仍然可能保留一定的适配层复杂度，但至少已经从“happy path 迁移”进入“关键路径行为基本可靠”。

### 第二波完成后：从“双控制面”进入“内核主导”

第二波是决定 `StoryOrchestrator` 是否真正脱离手写工作流形态的关键阶段。

这一阶段完成后，它应进入以下状态：

- `WorkflowKernel` 成为主要执行控制面
- `WorkflowEngine` 只剩兼容壳、门面，或退出主路径
- 恢复、回滚、phase 重启、auto-approve 推进都由内核统一主导
- workflow definition 开始成为行为的主要来源，而不是“内核 + adapter + 旧引擎”的混合产物

如果第二波完成后仍然需要 `StoryOrchestrator` 私有代码来推进关键状态，那么它仍然不是目标态。

当前实现落点应至少满足：

- `WorkflowEngine.start()` 在 kernel 模式下委托 full workflow definition，而不是再以 phase class 串联主流程
- `WorkflowEngine.resume()`、`recover()`、`retryPhase()` 在 kernel 模式下委托 kernel-owned `resume / recover / restart_phase`
- checkpoint timeout continuation 由 kernel checkpoint runtime 自行轮询和推进，`WorkflowEngine` 不再并行维护超时推进主逻辑
- `StoryOrchestratorKernelAdapter` 负责运行态投影、legacy 事件兼容与 snapshot bridge，但不再补一套独立恢复或回滚控制面

### 第三波完成后：从“重型插件”进入“参考插件”

第三波完成后，`StoryOrchestrator` 才应该真正成为未来插件的样板。

这一阶段完成后，它应进入以下状态：

- 插件主要通过 workflow definition 表达流程
- 通用模式已经沉淀为 SDK、标准 step 或 macro
- 业务状态、artifact、checkpoint payload 具备统一 contract
- 插件只保留少量真正无法通用化的领域 step
- 第二个插件可以低成本复用它的模式，而不是复制它的历史包袱

只有到这一步，才可以说“StoryOrchestrator 不只是迁移完成，而且已经被平台化收敛成参考实现”。

## 目标态下 StoryOrchestrator 应保留的职责

### 1. Workflow 定义职责

这是最终最核心、最应该保留的一类代码。

它负责表达：

- phase 划分
- step 顺序
- 并行/循环/guard/checkpoint 布局
- 失败策略的声明式选择
- 各阶段输入输出依赖关系

理想状态下，未来插件作者主要参考的就是这部分结构，而不是过去的 phase class 写法。

### 2. 故事领域专属步骤

`StoryOrchestrator` 应保留少量真正属于“故事生成领域”的 custom step，例如：

- 大纲生成或解析中的故事领域规则
- 章节生成、修订、润色中的领域语义
- 最终质量评估中与故事成品直接相关的判断逻辑

这里的判断原则是：

- 如果一个步骤对多个插件都可能通用，应进入 SDK
- 如果一个步骤只对故事生产领域有意义，应保留在 `StoryOrchestrator`

### 3. 业务状态投影

插件仍然需要把内核的技术运行状态，投影成产品可理解的业务状态。

例如：

- 当前故事处于哪个业务阶段
- 哪些产物已经生成
- 哪些产物已经审批
- 当前用户可看到哪些草稿、章节、终稿状态

这部分是合理保留的，但它应是“投影层”，而不是“另一套隐藏执行引擎”。

### 4. Prompt、Schema 和 Artifact 领域配置

与故事领域直接相关的 prompt 模板、schema、artifact 组织方式仍然应该由插件拥有。

但这些内容应更多表现为：

- 领域配置
- 结构化定义
- 对标准 SDK 能力的组合使用

而不是在 adapter 里把控制逻辑和领域逻辑搅在一起。

### 5. 插件入口与装配

最终插件仍然需要负责：

- 注册 workflow
- 注册少量 story-specific step
- 注入必要的 policy、artifact projector 或 snapshot projector
- 对外暴露宿主需要的插件入口

这部分是插件形态本身不可避免的职责，应保留。

## 目标态下 StoryOrchestrator 不应再保留的职责

### 1. 独立工作流控制面

这是最重要的一条。

目标态下，`StoryOrchestrator` 不应再通过私有 `WorkflowEngine` 或等价层掌握以下权力：

- phase 迁移
- checkpoint 恢复与拒绝语义
- timeout 自动推进
- rollback、restart phase、continue recovery
- 统一事件与状态推进主入口

如果这些语义仍主要由插件控制，那么内核就还没有真正完成替代。

### 2. 通用 checkpoint 语义补洞

`approve / reject / skip / modify / timeout` 的语义必须由内核原生提供。

插件只应该声明：

- 这个 checkpoint 是什么业务审批点
- 它的 payload 长什么样
- 在业务上如何展示其结果

插件不应再自己实现“reject 后如何推进”“timeout 后如何继续”等通用 runtime 行为。

### 3. 通用 retry / rollback / recovery 逻辑

这些都属于 workflow runtime 的核心，而不是故事插件的核心。

目标态下，插件只应声明策略和边界，例如：

- 哪一步可重试
- 哪些步骤是非幂等的
- 失败后建议的回退点是什么

而真正的执行与状态推进逻辑应由内核承担。

### 4. 为兼容旧路径而存在的厚 adapter

现在很多 adapter 复杂度来自于：

- 旧事件兼容
- 旧状态文件兼容
- 旧引擎状态推进补洞
- kernel 语义缺失时的桥接逻辑

目标态下，这类 adapter 应被持续压薄，只保留：

- 轻量业务映射
- 合法的宿主接入边界

而不是继续成为“真实行为的第二来源”。

### 5. 不可复用的编排样板代码

如果某类逻辑在未来插件中也大概率会重复出现，它就不应长期停留在 `StoryOrchestrator` 私有实现里。

例如：

- 标准 schema validation
- 标准 human review/checkpoint
- prompt -> parse -> validate -> revise 模式
- phase artifact 管理
- 通用 snapshot / projector 接口

这些都应在第三波中被抽到 SDK。

## 参考插件应满足的结构特征

目标态下，`StoryOrchestrator` 应更接近下面这种结构，而不是继续堆积历史控制逻辑：

```text
StoryOrchestrator
├── workflow/
│   ├── story-workflow
│   ├── phase-1
│   ├── phase-2
│   └── phase-3
├── steps/
│   ├── generate-outline
│   ├── generate-chapter
│   ├── revise-chapter
│   └── final-review
├── projection/
│   ├── business-snapshot
│   └── artifact-projection
├── prompts/
├── schemas/
└── plugin entry
```

也就是说，插件的主要可见资产应是：

- workflow definition
- 领域 step
- 业务投影
- 配置与入口

而不是：

- 大量 phase class
- 私有 engine
- 大型状态推进器
- 与内核并存的一套恢复/回滚实现

## 作为未来插件样板的验收标准

我建议把“成为样板”定义为一组硬标准，而不是一个模糊判断。

### 标准 1：插件主要写 definition，不主要写 engine

新插件作者看到 `StoryOrchestrator` 时，应主要学习：

- 如何组织 workflow definition
- 如何组合标准 step 与少量自定义 step
- 如何声明 artifact 和 checkpoint contract

而不是学习如何再造一套工作流控制器。

### 标准 2：插件只保留少量领域 step

一个新插件接入时，不应需要复制一整套 `StoryOrchestrator` 厚 adapter。

理想状态是：

- 主要复用标准 runtime
- 只实现少量业务专属 step

### 标准 3：业务状态是投影，不是隐藏执行轨迹

`StoryOrchestrator` 的业务状态文件、业务查询接口、artifact 视图，应只承担业务摘要职责。

它们不应再被误用成：

- 执行恢复依据
- 真实当前 step 的唯一来源
- rollback 决策依据

这些应由 kernel runtime 自身提供。

### 标准 4：关闭 legacy path 后仍然成立

如果一旦关闭旧路径，`StoryOrchestrator` 就不能完整运行，那么说明它仍然依赖历史控制面。

所以目标态必须要求：

- legacy path 退出后主流程仍可跑通
- 关键恢复路径仍然成立
- 业务视图不因 legacy 退出而崩塌

### 标准 5：第二个插件可以低成本复用

最终最关键的证明不是文档，而是复用成本。

至少应满足：

- 第二个插件可以直接复用标准 step/macro/contract
- 第二个插件不必复制 `StoryOrchestrator` 的历史兼容层
- `StoryOrchestrator` 提供的是“模式参考”，不是“历史包袱参考”

## 当前阶段性判断

截至 `workflow-kernel-storyorchestrator-state-projection-boundaries` 的当前实现批次，可以给出下面这个阶段性结论：

- `StoryOrchestrator` 已达到“runtime replacement 成立且结构收敛路径明确、状态投影边界开始显式收口”的 reference consumer 状态
- 它已经具备“未来薄型参考插件”的大部分判断前提
- 但它尚未满足“厚 adapter 已压薄、业务投影与 runtime 适配状态彻底分层、helper 可复用边界已经稳定”的最终标准

因此，当前推荐的统一表述应是：

**`StoryOrchestrator` 已完成运行时替代认证，并进入结构收敛后的参考插件候选态；它距离薄型参考插件终态只剩少量明确的 adapter、状态分层和 helper 沉淀工作，而不是仍停留在运行时正确性不确定阶段。当前状态层已经开始以 business projection、artifact projection 和 compatibility residue 三类边界组织实现，但尚未完全结束后续收口。**

## 目标态对现有三波改造的约束

这份目标态文档会反向约束三波 change 的设计边界。

### 对第一波的约束

第一波不仅要修 P0 正确性问题，还要避免继续加重插件私有补丁层。

也就是说：

- 正确性语义应优先下沉到内核
- 不应再把 `reject / timeout / retry` 临时补在插件里

### 对第二波的约束

第二波的成功标准不只是“系统能跑”，而是“控制权真正上收”。

如果第二波结束后，`WorkflowEngine` 仍然掌握关键推进逻辑，那么第二波并没有达到目标态要求。

### 对第三波的约束

第三波不能只做“文档化 SDK”，而必须真正让 `StoryOrchestrator` 变薄。

这意味着第三波至少要同时完成：

- 通用模式提炼
- 插件私有厚逻辑迁移或删除
- reference implementation 收口

否则就只是多了一份 SDK 文档，而没有形成真正的参考插件。

## 建议采用的最终判断口径

当未来有人问“`StoryOrchestrator` 在三波后是什么状态”时，建议统一使用下面的表述：

- 它仍然是一个重要业务插件，但已经不再承担独立工作流引擎职责。
- 它的主要职责是故事生成领域语义、workflow definition、少量领域 step 和业务状态投影。
- 通用控制语义已经上收进 `WorkflowKernel` 与插件 SDK。
- 它已经从“历史迁移对象”演进为“未来插件参考实现”。

## 最终结论

三波完善后的理想目标，不是把 `StoryOrchestrator` 删除掉，也不是把它继续保留成一个大型特例插件。

真正合理的目标是：

**让 `StoryOrchestrator` 成为一个足够薄、足够清晰、足够可复制的参考插件。**

只有达到这个状态，下面三件事才会同时成立：

- `WorkflowKernel` 真正完成了对手写工作流的替代
- `StoryOrchestrator` 自身复杂度被平台化收敛
- 未来工作流插件作者可以在较低成本下复用现有模式，而不是重复制造一套新的厚插件
