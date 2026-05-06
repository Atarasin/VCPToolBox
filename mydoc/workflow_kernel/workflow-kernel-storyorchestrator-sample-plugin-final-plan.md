# StoryOrchestrator 走向工作流内核样本插件的最终改造方案

## 文档目标

本文面向继续推进 `WorkflowKernel` 与 `StoryOrchestrator` 演进的内部工程师。

读完本文后，维护者应能直接做一件事：

- 按最终目标重新理解当前状态
- 判断为什么此前多轮 change 看起来推进缓慢
- 直接按本文拆出的 change 列表继续执行，而不是再开一轮大而泛的“继续收口”

## 面向的最终目标

这里的目标不再是“证明 StoryOrchestrator 已经能跑”，也不只是“证明它达到了 thin reference plugin readiness”。

真正的最终目标是：

**让 `StoryOrchestrator` 成为工作流内核的样本插件。**

这个“样本插件”至少要同时满足五个条件：

1. `WorkflowKernel` 是唯一真实控制面
2. `StoryOrchestrator` 的主体资产是 workflow definition、领域 step、业务投影和插件装配
3. 仓库不会继续把 legacy shell 当成默认教学材料
4. 第二个真实插件能够复用其模式，而不是复制其历史兼容层
5. 新维护者只看样本和文档，也能按同样模式接入新插件

## 当前真实状态

根据现有文档与最新代码，当前状态已经不是旧计划中的 `not-ready`，而是：

- replacement certification：已成立
- thin reference plugin readiness：`ready-with-notes`
- 当前阶段：已经完成 blocker-driven structural convergence，进入 note-driven maintenance

同时，当前代码现实比旧文档又前进了一步：

- `Phase1_WorldBuilding`、`Phase2_OutlineDrafting`、`Phase3_Refinement` 已不在当前代码中
- `workflow-phase1` 这类 degraded definition entry 已不在当前代码中
- `WorkflowEngine` 仍然存在，但其实现已经是显式的 compatibility facade，主执行通过 `WorkflowKernel` / `StoryOrchestratorKernelAdapter` delegation 完成
- `StoryOrchestrator` 与部分集成测试仍然直接实例化 `WorkflowEngine`，说明它还没有彻底退出“对外兼容入口”位置

这意味着必须再校正一个前提：

- 旧的“三步收口计划”大部分已经完成
- phase-class shell / degraded entry 退役已经不再是主要剩余工作
- 当前剩余矛盾不再是运行时替代是否成立
- 当前剩余矛盾是：如何把“可复用的参考插件”继续推进成“可被当样本教学、可被第二插件复用、并且不再依赖兼容 facade 作为默认认知入口”的样本插件

## 为什么进展会显得慢

体感变慢，不是因为方向错了，而是因为项目已经从“修主路径”进入“降低长期迁移成本”的阶段。

此前多轮 change 分别解决的是不同层级的问题：

- 第一层：运行时替代是否成立
- 第二层：控制面是否真正上收到内核
- 第三层：adapter、状态边界、helper promotion 是否从 blocker 下降为 note

这些 change 的价值很高，但它们大多是在消除未来会反复返工的结构风险，因此不一定会立刻表现为“插件看起来更轻了很多”。

现在如果继续沿用旧思路，再开“大而泛的继续收口 change”，只会重复已经完成的工作。因此，下一阶段必须切换目标函数：

- 不再以“再收口一点结构债”为目标
- 改为以“把 StoryOrchestrator 变成样本插件”来定义剩余 change

## 最终目标导向下，剩余工作到底是什么

从样本插件目标倒推，当前真正剩下的是四类工作：

### 1. 让 `WorkflowEngine` 从“仍被消费的兼容入口”继续收窄成真正的薄 façade

phase-class shell 和 degraded entry 的物理退役已经基本完成，这意味着“最显眼的历史壳”已经被移走。

但当前代码中仍然存在一个关键事实：

- `WorkflowEngine` 还在
- `StoryOrchestrator` 初始化时仍会创建它
- 集成测试仍大量直接实例化它
- 它虽然已经不再持有 phase-class runtime 依赖，但仍然是现实中的兼容入口

这会继续给未来插件作者造成一个认知偏差：

- 好像样本插件仍应先有一个 engine façade
- 好像 start / resume / recover / retry 的默认入口仍围绕 `WorkflowEngine`
- 好像插件接入的默认范式仍是“先包一层兼容控制壳，再委托 kernel”

如果目标是“样本插件”，这种认知必须继续收窄。

### 2. 把“最小第二 consumer 证明”升级为“真实多 consumer 证明”

当前仓库已经有最小第二 consumer 测试，这证明 SDK 不是 StoryOrchestrator 专用。

但对“样本插件”来说，这还不够。

还需要继续证明：

- 第二个真实 workflow plugin 能按同样 authoring pattern 成立
- 它不需要复制 StoryOrchestrator 的 compatibility shell
- 它复用的是 shared SDK、shared contracts 和 sample workflow pattern

只有这样，`StoryOrchestrator` 才不是“一个被特殊照顾过的成功迁移案例”，而是“真的可复制的样本”。

### 3. 把样本插件的消费方式产品化

当前仓库已经有 target-state、readiness review、SDK guide 和多份 change 文档，但对于“样本插件”这个角色，仍缺三样东西：

- 一个明确的 sample plugin 入口文档
- 一套“看这里就能仿写新插件”的最小路径
- 一组持续验证样本状态的认证标准

否则 `StoryOrchestrator` 只是“内部知道它是参考插件”，而不是“工程上可被消费的样本插件”。

### 4. 把 note-driven maintenance 变成小范围、可关闭的治理节奏

当前 residual notes 主要集中在：

- `WorkflowEngine` 仍是 compatibility facade，且仍被入口与测试广泛消费
- adapter 周边仍有少量 transitional seams
- 插件状态层仍有 compatibility residue
- helper promotion 的目标是稳定，而不是无限扩张

这些 note 如果没有 change 化的关闭机制，会再次把项目拖回“明明已经差不多了，但一直不算彻底完成”的状态。

## 新的边界前提

从现在开始，这份方案应采用一个比“继续压薄”更强的默认规则：

**除了 `WorkflowEngine` 这个显式 compatibility façade 之外，`StoryOrchestrator` 里的其它代码都不默认保留；它们必须先证明自己能落进理想样本插件的五类边界，否则就应被迁移、拆分、下沉或删除。**

这五类边界就是目标态文档中已经写明的样本插件形态：

- workflow definition
- story-specific custom steps
- prompt / schema / artifact 领域配置
- 业务状态投影
- 插件入口与注册

这意味着接下来不应再使用下面这种默认思路：

- “这个模块现在还在，所以先保留”
- “这个 helper 目前在插件里，所以先算插件资产”
- “只要不是 runtime 主控制面，就可以继续留在 StoryOrchestrator”

而要改成更严格的判断：

- 如果它不是 workflow definition，就问它是否真的是 story-specific custom step
- 如果它不是领域 step，就问它是否只是 prompt / schema / artifact 领域配置
- 如果它不是领域配置，就问它是否只是业务状态投影
- 如果它不是业务状态投影，就问它是否只是插件入口与注册
- 如果四个问题都答不出来，它就不该长期留在 `StoryOrchestrator`

## 除 `WorkflowEngine` 外的代码必要性判断

下面这份判断不再是“哪些模块看起来还能保留”，而是“哪些模块能否被五类理想边界合法吸收”。

### A. 目标态下明确应该保留的代码

这些模块天然落在你给出的五类理想边界中，属于可以继续存在的插件代码：

- `config/workflow-definition.js`
  - 对应 `workflow definition`
  - 这是样本插件最核心的主资产，应继续强化为唯一主流程表达

- `steps/index.js` 中真正的故事领域 step
  - 对应 `story-specific custom steps`
  - 但这里只能保留“故事生成语义”，不能顺带保留通用编排骨架

- `utils/PromptBuilder.js`
- `config/extraction-schemas.js`
- `config/workflow-contracts.js` 中仍属于故事领域 contract 的部分
- `utils/ValidationSchemas.js` 中属于插件对外工具入参的部分
  - 对应 `prompt / schema / artifact 领域配置`
  - 它们可以保留，但必须继续配置化，不能重新长成控制逻辑

- `core/StateManager.js`
- `core/StoryStateRepository.js`
- `core/ArtifactManager.js`
  - 仅在它们被严格限制为 `业务状态投影` 时才允许保留
  - 一旦它们继续承担 runtime truth、恢复依据或通用持久化契约，就应被继续拆分或迁出

- `core/StoryOrchestrator.js`
  - 仅在它被严格限制为 `插件入口与注册` 时才允许保留
  - 如果它继续承担双路径路由、兼容控制协调或主状态推进，就不符合目标态

### B. 不应默认保留，必须被重新证明的代码

这些模块当前还在 `StoryOrchestrator` 中，但它们并不天然落进五类理想边界，因此不能再默认视为插件长期资产：

- `adapters/StoryOrchestratorKernelAdapter.js`
  - 它不是 workflow definition
  - 也不是 story-specific custom step
  - 也不是领域配置
  - 也不纯粹是业务状态投影
  - 更不只是插件入口与注册
  - 因此它只能被视为过渡性桥接层，后续必须继续拆成：
  - kernel bridge
  - shared SDK helper consumption
  - 最小插件注册边界
  - 其余过渡 glue 应持续退出

- `steps/index.js` 中的 extraction / parse / validate skeleton
- `core/ContentValidator.js` 中的通用校验骨架
- `utils/SchemaValidator.js` 中的通用 schema validation 骨架
- `core/ChapterOperations.js` 中可复用的编排套路
- `utils/TextMetrics.js` 中若被多个插件复用的通用统计能力
  - 这些都不应再默认算作 StoryOrchestrator 私有资产
  - 凡是可复用 skeleton，都应优先讨论下沉到 SDK 或内核邻近层

### C. 只在“保留为故事领域语义”前提下才能存在的代码

这些模块通常是“混合模块”，不能整块保留，也不能整块迁移，必须拆语义：

- `steps/index.js`
  - outline normalization、chapter generation、polish、final edit 这类故事语义可保留
  - parse / validate / orchestration skeleton 不应继续留在插件里

- `core/ContentValidator.js`
  - 世界观、人物、情节等故事判断规则可保留
  - delegate、parse、aggregate 一类可复用流程骨架应迁移

- `core/ChapterOperations.js`
  - 章节生成策略、故事质量阈值、修订偏好可保留
  - 通用的“生成 -> 校验 -> 修订”套路不应默认保留

- `config/workflow-contracts.js`
  - 只要它描述的是故事产品语义和对外业务 contract，可保留
  - 只要它开始描述通用 runtime / checkpoint / projection contract，就应优先移动到 shared contract 层

### D. 当前最应该被挑战的保留假设

如果严格按理想边界来审，当前最值得继续挑战的不是 `WorkflowEngine`，而是下面几类“看起来像插件代码、但其实不一定应该长期留在插件里”的资产：

1. `StoryOrchestratorKernelAdapter`
   - 它是目前最不符合五类理想边界的模块
   - 如果最后样本插件还依赖一个重 adapter 才成立，样本价值会明显下降

2. 状态层三件套
   - `StateManager`
   - `StoryStateRepository`
   - `ArtifactManager`
   - 它们只有在严格退化为 `业务状态投影` 后才合理
   - 如果仍承载 runtime residue，它们就只是“被包装过的历史复杂度”

3. 混合型 helper 模块
   - `steps/index.js`
   - `ContentValidator.js`
   - `ChapterOperations.js`
   - `SchemaValidator.js`
   - 这些模块当前最大的风险不是“还不够稳定”，而是“大家默认接受它们继续留在插件里”

4. 入口总控模块
   - `StoryOrchestrator.js`
   - 它只能是装配层
   - 一旦它继续承接运行时路由、兼容协调和状态决策，就会重新长成第二控制边界

## 由此推导出的 Change 口径

基于上面的新前提，后续 change 不应再只围绕“兼容 façade 还剩多少”展开，而应显式回答：

- 这个模块是否真的属于五类理想边界之一
- 如果不是，它应该迁到哪里
- 如果它既不是内核，也不是 SDK，也不是样本插件五类边界，那它是不是就该被删

## 已建立的治理基线

`workflow-kernel-storyorchestrator-plugin-surface-necessity-review` 不再只是一个建议中的首个 change，而应被视为后续所有样本插件 follow-up change 的正式基线。

从这条 change 开始，后续涉及 `StoryOrchestrator` 的 change 都应先回答四个问题：

1. 它修改的模块在必要性审查中的结论是什么
2. 它是在执行 `保留`、`拆分后保留`、`迁移到 SDK`、`迁移到内核` 还是 `删除`
3. 它是否错误地把 `WorkflowEngine` 的兼容例外扩展到了其它模块
4. 它是否让插件重新长回五类理想边界之外的资产

如果某个后续 change 无法对齐这条基线，就不应继续以“样本插件收敛工作”的名义推进。

## 不建议再做的事

为了避免继续变慢，下面三类动作不建议再作为主线：

1. 再起一个“大而全”的结构收敛总 change
2. 重新打开 replacement certification 或已归档的 adapter/state/helper 收口 change
3. 在没有第二真实 consumer 与 sample packaging 证据前，直接宣布“样本插件已经彻底完成”

## 建议的剩余 Change 拆分

下面的拆分不是旧的 blocker 收口版，而是面向“样本插件终局”的新拆分。

### Change 1：StoryOrchestrator Plugin Surface Necessity Review

**建议 Change ID**

`workflow-kernel-storyorchestrator-plugin-surface-necessity-review`

**目标**

以“除 `WorkflowEngine` 外其它代码都必须证明必要性”为原则，对整个 `StoryOrchestrator` 插件表面重新分类。

**为什么必须先做**

如果不先做这轮必要性审查，后续所有 change 都会继续默认接受现有模块留在插件里，只是在局部压薄它们。这与理想目标相冲突，因为理想目标要求插件代码只剩五类资产。

**本 change 解决的问题**

- 除 `WorkflowEngine` 外，哪些模块可以被合法归入五类理想边界
- 哪些模块只能拆分后部分保留
- 哪些模块本质上应迁移到 SDK 或内核
- 哪些模块只是过渡 glue，应进入删除路径

**完成标准**

- 每个主要模块都有 `保留 / 拆分 / 迁移 / 删除` 结论
- “五类理想边界”被落实为模块级决策标准
- 后续 change 不再围绕模糊的“继续优化”，而围绕明确的去留结论展开

### Change 2：WorkflowEngine Facade Tightening

**建议 Change ID**

`workflow-kernel-storyorchestrator-engine-facade-tightening`

**目标**

把 `WorkflowEngine` 从“仍被广泛消费的兼容入口”继续收窄成真正的薄 façade。

**推荐首刀**

- 区分 `WorkflowEngine` 的长期 façade 职责与应迁出的控制语义
- 减少入口层对 engine-first 认知的依赖
- 明确哪些行为继续通过 façade 暴露，哪些应直接转向 canonical control plane

**为什么它是下一步**

在完成插件表面必要性审查后，下一步最自然的收口对象仍然是 `WorkflowEngine`，因为它是唯一被明确允许暂时存在的 compatibility façade。

**完成标准**

- `WorkflowEngine` 的 façade 职责被继续压缩
- 与主控制语义相关的职责不再停留在 engine 周边
- 后续测试和入口重排可以围绕更稳定的 façade 边界展开

### Change 3：Compatibility Test Asset Cleanup

**建议 Change ID**

`workflow-kernel-storyorchestrator-compatibility-test-asset-cleanup`

**目标**

把测试资产从“历史兼容面导向”切换到“canonical path / sample plugin 导向”。

**为什么这是样本插件的关键 change**

在表面必要性和 façade 边界都更明确之后，测试资产必须同步重排，否则自动化证据仍会继续强化旧形状。

**本 change 解决的问题**

- 清理仍把 `WorkflowEngine` 作为默认主入口对象的旧集成测试分层
- 区分 compatibility facade tests 与 canonical kernel-led certification tests
- 把样本插件长期证据切换到 definition + kernel path + plugin SDK consumption

**完成标准**

- 测试资产明确分层为 façade compatibility、canonical control plane、sample consumer certification
- 长期证据入口不再默认依赖 `WorkflowEngine` 直接实例化
- 新增或改写测试优先保护 definition + kernel path + shared SDK surface
- 旧的 façade-only 测试被收缩到必要最小范围

### Change 4：Reference Plugin Multi-Consumer Certification

**建议 Change ID**

`workflow-kernel-reference-plugin-multi-consumer-certification`

**目标**

把当前“最小第二 consumer 证明”升级为“真实多 consumer 认证”。

**为什么需要单独列出**

现在 phase-class shell 已经不再是主问题，真正的问题是：样本插件不能只证明“自己被改好了”，还要证明“别人也能按这个模式接”。

**本 change 解决的问题**

- 选一个真实但更简单的第二 workflow plugin 作为 consumer
- 复用 shared SDK、contracts、macro pattern 和 sample authoring guide
- 证明它不需要复制 StoryOrchestrator 的 compatibility façade
- 用第二 consumer 反向校验当前 shared surface 是否够稳定

**完成标准**

- 存在一个真实第二 workflow plugin 或等价真实 consumer
- 它的接入主要依赖 definition、shared SDK、少量领域 step
- 它不复制 StoryOrchestrator 的 compatibility 层
- 有 fresh passing evidence 证明 shared surface 足以支撑两个 consumer

### Change 5：StoryOrchestrator Entry Simplification

**建议 Change ID**

`workflow-kernel-storyorchestrator-entry-simplification`

**目标**

把 `StoryOrchestrator` 入口认知从“engine + adapter 双装配”继续切换到“definition + kernel-led control plane + thin compatibility boundary”。

**为什么需要单独列出**

即使 `WorkflowEngine` 已是 façade，只要 `StoryOrchestrator` 总入口仍默认围绕 engine 组织，新读者看到的第一印象就仍然是旧时代的接入形态。

**本 change 解决的问题**

- 插件初始化与工具调用路径是否能更明显地围绕 canonical control plane 组织
- 哪些入口必须继续保留 compatibility delegation
- 哪些状态查询、路由决策和 fallback 提示应从“legacy 视角”切到“sample plugin 视角”

**完成标准**

- `StoryOrchestrator` 入口主要表现为样本插件装配层
- compatibility delegation 仍保留时也被显式降到次要位置
- 新读者首先看到的是 definition、adapter、shared SDK consumption，而不是 engine 优先结构

### Change 6：Sample Plugin Packaging And Certification

**建议 Change ID**

`workflow-kernel-storyorchestrator-sample-plugin-packaging`

**目标**

正式把 `StoryOrchestrator` 从“内部 ready-with-notes 的参考插件”包装成“可被直接消费的样本插件”。

**本 change 解决的问题**

- 增加面向新维护者的 sample plugin 入口文档
- 给出“如何照着 StoryOrchestrator 写新插件”的最小路径
- 定义 sample plugin certification checklist
- 把 StoryOrchestrator 在文档体系中的角色从 reference consumer 升级为 sample plugin

**应输出的产物**

- sample plugin guide
- sample plugin certification checklist
- 从 SDK guide、workflow authoring guide 到 StoryOrchestrator 的清晰导航
- 一份“哪些东西应模仿，哪些东西不要模仿”的边界说明

**完成标准**

- 新读者不需要阅读历史 change 文档，也能知道如何仿写插件
- StoryOrchestrator 被正式标记为 sample plugin，而不是仅在评审文档里被口头引用
- 样本插件的准入条件、禁止事项和验证要求被固化

### Change 7：Reference Plugin Note Closure Review

**建议 Change ID**

`workflow-kernel-reference-plugin-note-closure-review`

**目标**

在 `WorkflowEngine` façade 收窄、测试资产去历史化、多 consumer 认证和样本化包装之后，重新审查当前 residual notes 是否仍然成立。

**为什么还需要这一项**

当前项目已经不是 blocker-driven 阶段，因此最后需要的不是再做一次大重构，而是一轮面向 note closure 的小型收官评审。

**本 change 解决的问题**

- `WorkflowEngine` 是否仍应作为长期 compatibility façade 保留
- adapter transitional seams 是否继续只是 note
- 插件状态层 compatibility residue 是否已下降到不会误导样本消费的程度
- 样本插件文档与真实代码是否一致

**完成标准**

- 每条 residual note 都有 keep / close / follow-up 的明确结论
- 如果仍保留 note，原因与边界被重新写实
- 如果已经满足条件，可把样本插件口径从 `ready-with-notes` 继续推进

## 推荐执行顺序

建议按下面顺序推进，而不是交叉乱开：

1. `workflow-kernel-storyorchestrator-plugin-surface-necessity-review`
2. `workflow-kernel-storyorchestrator-engine-facade-tightening`
3. `workflow-kernel-storyorchestrator-compatibility-test-asset-cleanup`
4. `workflow-kernel-reference-plugin-multi-consumer-certification`
5. `workflow-kernel-storyorchestrator-entry-simplification`
6. `workflow-kernel-storyorchestrator-sample-plugin-packaging`
7. `workflow-kernel-reference-plugin-note-closure-review`

这个顺序的含义是：

- 第一项 change 先决定除 `WorkflowEngine` 外其余插件代码是否还有资格继续存在
- 第二和第三项 change 收窄 façade 与测试层仍然残留的旧认知
- 第四项 change 证明样本不是一次性特例
- 第五和第六项 change 把入口与文档都切到样本插件视角
- 第七项 change 负责做 note closure 收官

## 可以并行的批次

如果希望压缩总时长，可以改成三批：

### 第一批：先做必要性总审查，再收窄 façade

- `workflow-kernel-storyorchestrator-plugin-surface-necessity-review`
- `workflow-kernel-storyorchestrator-engine-facade-tightening`

### 第二批：重排证据入口，并证明模式可复制

- `workflow-kernel-storyorchestrator-compatibility-test-asset-cleanup`
- `workflow-kernel-reference-plugin-multi-consumer-certification`

### 第三批：切换入口认知，正式样本化并收官

- `workflow-kernel-storyorchestrator-entry-simplification`

- `workflow-kernel-storyorchestrator-sample-plugin-packaging`

## 每个 Change 的验证逻辑

为了避免“又做了很多改造，但终局仍然不清楚”，后续每个 change 都应带上明确验证。

### 审计类验证

适用于 `plugin-surface-necessity-review`、`engine-facade-tightening`：

- 除 `WorkflowEngine` 外，每个主要模块都有明确去向
- `WorkflowEngine` 的 façade 职责 inventory 完整
- 调用点 inventory 完整
- compatibility 与 canonical path 的边界清晰
- 入口认知不再把 `WorkflowEngine` 当默认控制面

### 退役类验证

适用于 `compatibility-test-asset-cleanup`、`entry-simplification`：

- canonical definition path 可跑通
- kernel-only start / resume / recover / retry 路径可跑通
- 长期证据入口不再默认依赖 façade-only 测试
- 样本插件入口不再以历史兼容层为第一认知

### 多 consumer 验证

适用于 `reference-plugin-multi-consumer-certification`：

- 第二 consumer 不复制 StoryOrchestrator compatibility façade
- 第二 consumer 复用 shared SDK 与 shared contracts
- 两个 consumer 都通过 fresh passing certification
- 新发现的共享模式要么进入 SDK，要么被明确判定为插件私有

### 样本化验证

适用于 `sample-plugin-packaging`、`note-closure-review`：

- 新读者按样本文档可以完成一个最小插件骨架
- 文档明确区分“应模仿”和“不要模仿”的部分
- StoryOrchestrator 的 sample 身份在文档入口处可见
- sample certification checklist 可被持续复用
- residual notes 有明确 keep / close / follow-up 结论

## 最终验收标准

只有当下面六条同时成立时，才建议正式宣称“StoryOrchestrator 已彻底改造成工作流内核样本插件”：

1. phase-class shell 与 degraded entry 已从当前代码与教学主叙事中退出
2. 除 `WorkflowEngine` 外，其余插件代码都已被证明属于五类理想边界之一，或已迁移/删除
3. `WorkflowEngine` 已收窄为明确的薄 façade，或进一步退出默认入口位置
4. 自动化测试的长期证据入口以 canonical path 为主，而不是以 façade-only 形状为主
5. 至少有一个真实第二 consumer 证明当前模式可复制
6. StoryOrchestrator 拥有正式的 sample plugin 文档与认证清单
7. 新插件作者主要学习的是 definition、SDK、contracts 和领域 step，而不是历史兼容层

## 一句话结论

`StoryOrchestrator` 现在已经不是“还没收口好的厚插件”，而是“phase-class shell 与 degraded entry 已退出、并达到 `ready-with-notes` 的参考插件”；接下来真正该做的，不是只盯着 `WorkflowEngine`，而是先按 **除 `WorkflowEngine` 外其余代码一律先证明必要性** 的原则做插件表面总审查，再沿 **`WorkflowEngine` façade 收窄、测试资产去历史化、第二 consumer 认证、样本化包装** 四条主线拆成七个 change，把它彻底推进成工作流内核的样本插件。
