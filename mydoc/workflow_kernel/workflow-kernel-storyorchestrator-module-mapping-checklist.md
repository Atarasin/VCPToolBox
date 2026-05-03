# StoryOrchestrator 模块映射版保留 / 迁移 / 退出清单

## 文档目标

本文是《StoryOrchestrator 保留 / 迁移 / 退出清单》的模块映射版补充文档。

前一份清单按职责域回答“什么该保留、什么该迁移、什么该退出”。本文进一步回答：

- 现有 `StoryOrchestrator` 代码中的具体模块，大致应该落到哪一类动作
- 哪些模块是目标态下的长期保留对象
- 哪些模块应被拆分后迁移到 `WorkflowKernel`
- 哪些模块应被提炼到插件 SDK
- 哪些模块只应作为兼容壳存在，最终退出主路径

本文面向内部工程师，读完后应能直接做一件事：

- 在后续 OpenSpec change、代码重构和模块审查中，对现有模块做初步归类，并据此安排迁移顺序

## 使用说明

本文不是“逐文件必然结论”，而是“基于当前代码形态的目标动作建议”。

阅读时要注意三点：

1. 一个模块可能同时承担多个职责，此时应优先拆分职责，而不是整块搬迁
2. “迁移到内核”不等于原文件整体搬到内核目录，通常意味着提炼通用语义后重写到更合适的抽象层
3. “退出/降级”不等于立刻删除，而是退出主路径，只保留兼容或迁移期壳层

## 判定标签

本文使用四类标签：

- **保留**：目标态下仍然属于 `StoryOrchestrator`
- **迁移到内核**：应收敛为 `WorkflowKernel` 的通用 runtime 能力
- **迁移到 SDK**：应提炼为未来插件可复用的 authoring 模式或 helper
- **退出/降级**：只应保留为兼容壳或过渡层，不再作为主路径能力

## 当前结构收敛落点（2026-05-04）

当前实现批次完成后，这份模块映射还应补充下面这些现实判断：

- `core/WorkflowEngine.js`、`core/Phase1_WorldBuilding.js`、`core/Phase2_OutlineDrafting.js`、`core/Phase3_Refinement.js`、`config/workflow-phase1.js` 已经进入“冻结边界”的 compatibility 状态，后续不应再吸收新的主控制逻辑
- `adapters/StoryOrchestratorKernelAdapter.js` 仍然是结构债集中区，但其内部职责已经开始分区，后续应沿着 kernel bridge / projector / compatibility / helper 四类边界继续收缩
- `core/ContentValidator.js`、`core/ChapterOperations.js`、`steps/index.js`、`utils/SchemaValidator.js` 当前更适合被理解为“故事规则 + 可复用骨架混合模块”，而不是简单贴上“全部迁 SDK”或“全部留插件”标签
- `core/StateManager.js`、`core/StoryStateRepository.js`、`core/ArtifactManager.js` 已明确了业务投影优先口径，但仍需要持续压制 runtime compatibility bookkeeping 的扩张

## 当前状态投影边界落点（2026-05-04）

`workflow-kernel-storyorchestrator-state-projection-boundaries` 的首批实现完成后，这份模块映射还应补充下面这些现实判断：

- `core/StateManager.js` 已不再用一段内联大装配逻辑同时解释所有 phase snapshot、checkpoint 和 workflow 字段，而是显式拆成 story projection helper 与 compatibility workflow helper
- `core/StoryStateRepository.js` 中的 artifact rows 已适合被理解为 plugin-facing artifact index，而不是 workflow runtime truth 的旁路持久化
- `core/ArtifactManager.js` 已更明确地表现为 artifact projection / lookup 辅助层；即使 SQLite index 失败，artifact 落盘仍不应被解释成 runtime failure
- 状态层后续的主要风险不再是“边界完全不可见”，而是维护者重新把 compatibility residue 扩张回 story-facing projection 或 runtime truth 判断路径

## 模块总览表

| 模块 | 当前主要职责 | 建议动作 | 最终去向 | 说明 |
|---|---|---|---|---|
| `core/StoryOrchestrator.js` | 插件入口、工具分发、双路径路由 | 保留并压薄 | StoryOrchestrator | 保留为入口与装配层，不再承担重控制逻辑 |
| `core/WorkflowEngine.js` | phase 控制、checkpoint 推进、恢复协调 | 迁移到内核 + 退出主路径 | Kernel / compatibility | 其中通用 runtime 语义应上收，剩余外壳降级 |
| `adapters/StoryOrchestratorKernelAdapter.js` | kernel 接入、旧事件兼容、快照桥接、自定义 step 注册 | 拆分后部分迁移、部分压薄 | Kernel / SDK / thin adapter | 当前最典型的厚 adapter，需要重点收敛 |
| `config/workflow-definition.js` | 完整声明式 workflow | 保留 | StoryOrchestrator | 目标态下的核心资产 |
| `config/workflow-phase1.js` | phase 级过渡定义 | 退出/降级 | compatibility only | 若 phase 级入口废弃，应退役；若保留，仅作兼容 |
| `steps/index.js` | 自定义 step 实现集合 | 拆分后保留一部分、迁移一部分 | StoryOrchestrator / SDK | 通用模式应抽出，领域 step 保留 |
| `core/StateManager.js` | 业务状态聚合、workflow 状态混存、artifact 管理调度 | 保留并收口职责 | StoryOrchestrator | 保留业务状态面，去掉 runtime 真相职责 |
| `core/StoryStateRepository.js` | 业务持久化、checkpoint/snapshot/event 落库 | 保留并分层 | StoryOrchestrator | 业务仓储保留，但通用 runtime 持久化应避免继续私有化扩张 |
| `core/ArtifactManager.js` | artifact 存储与索引 | 保留，接口向 SDK contract 对齐 | StoryOrchestrator | 业务 artifact 可保留，contract 应标准化 |
| `core/Phase1_WorldBuilding.js` | Phase 1 手写编排 | 退出/降级 | compatibility only | 目标态下不应再是主路径 |
| `core/Phase2_OutlineDrafting.js` | Phase 2 手写编排 | 退出/降级 | compatibility only | 同上 |
| `core/Phase3_Refinement.js` | Phase 3 手写编排 | 退出/降级 | compatibility only | 同上 |
| `core/ChapterOperations.js` | 章节领域操作 | 保留或部分下沉 SDK | StoryOrchestrator / SDK | 看是否存在跨插件可复用模式 |
| `core/ContentValidator.js` | 故事内容校验 | 拆分后保留一部分、迁移一部分 | StoryOrchestrator / SDK | 通用校验骨架可进 SDK，故事规则保留 |
| `utils/PromptBuilder.js` | prompt 组装 | 保留并模板化 | StoryOrchestrator | 领域 prompt 仍应属于插件 |
| `config/extraction-schemas.js` | 提取 schema 定义 | 保留 | StoryOrchestrator | 领域 schema 保留，抽取机制不应私有化 |
| `utils/SchemaValidator.js` | schema 校验工具 | 迁移到 SDK | Plugin SDK | 明显具备复用价值 |
| `utils/ValidationSchemas.js` | 工具入参校验 | 保留 | StoryOrchestrator | 插件接口边界的一部分 |
| `agents/AgentDispatcher.js` / `agents/AgentDefinitions.js` | agent 组织与类型定义 | 保留 | StoryOrchestrator | 故事领域 agent 配置应保留 |
| `core/StoryOrchestratorDatabase.js` | 插件数据库底座 | 保留 | StoryOrchestrator | 属于业务存储基础设施 |
| `docs/*legacy*` / rollback / backup 文档 | 过渡流程说明 | 降级保留 | compatibility docs | 在旧路径退出后应同步收口 |

## 核心模块映射

### 1. `core/StoryOrchestrator.js`

**当前观察**

- 它是插件总入口
- 负责初始化 `StateManager`、`AgentDispatcher`、`WorkflowEngine`
- 同时根据 feature flag 决定走 kernel 还是 legacy path
- 对外暴露工具调用入口，例如 `StartStoryProject`、`QueryStoryStatus`、`RecoverStoryWorkflow`

**建议动作**

- 保留
- 同时持续压薄

**目标态去向**

- `StoryOrchestrator`

**原因**

- 插件总入口本来就应该保留
- 但它现在仍承担了明显的双路径路由和控制协调责任
- 目标态下它应更像“插件装配层”，而不是“主控制器”

**后续处理建议**

- 保留工具入口、初始化和装配
- 减少 runtime 路由分叉
- 将状态推进、恢复和 checkpoint 主逻辑彻底下沉

### 2. `core/WorkflowEngine.js`

**当前观察**

- 直接声明职责包括 phase 转换、检查点等待和恢复、集中重试、WebSocket 通知
- 内部持有 `Phase1/2/3` 实例
- 同时还负责检查点过期扫描和自动批准推进
- 在 feature flag 开启时再委托给 kernel adapter

**建议动作**

- 迁移其中的通用 runtime 语义到内核
- 原模块最终退出主路径或降级为兼容壳

**目标态去向**

- 通用语义进入 `WorkflowKernel`
- 剩余兼容外壳保留在 compatibility surface

**原因**

- 它是当前双控制面的核心载体
- 如果这个模块继续主导 phase、checkpoint、recovery，就无法实现目标态

**优先级**

- 第二波重点收敛对象

### 3. `adapters/StoryOrchestratorKernelAdapter.js`

**当前观察**

- 负责把 `StoryOrchestrator` 状态桥接到 `WorkflowKernel`
- 注册内置 step 和 StoryOrchestrator custom steps
- 维护旧事件兼容
- 包含业务状态快照、生命周期 hook、恢复辅助、提取指标等多种职责

**建议动作**

- 拆分后分别处理

**推荐拆分方向**

- 通用 runtime 适配与恢复语义：迁移到内核
- 通用 step 模式和 helper：迁移到 SDK
- 最小宿主接入映射：保留为 thin adapter
- 历史补洞逻辑：退出主路径

**原因**

- 这是当前最“重”的过渡模块
- 它既说明 kernel 已经能承载一部分能力，也说明插件复杂度还没有真正被平台吸收

**优先级**

- 第二波和第三波的共同重点

### 4. `config/workflow-definition.js`

**当前观察**

- 已有完整的 phase/step 声明式定义
- 使用 `checkpoint`、`guard`、`parallelGroup` 等原语
- 定义了 `onCheckpointReject: 'retry'` 等行为意图

**建议动作**

- 保留
- 进一步强化为主流程真相来源

**目标态去向**

- `StoryOrchestrator`

**原因**

- 这是未来参考插件最重要的资产之一
- 新插件作者最应该学习的就是这部分结构

**优先级**

- 三波全程持续强化

### 5. `config/workflow-phase1.js`

**当前观察**

- 这是 phase 级定义
- 当前只看到 phase1，且与完整 definition 并存

**建议动作**

- 降级或退出

**目标态去向**

- compatibility only

**原因**

- 如果最终不再主推 phase 级入口，这类文件就不应继续扩展
- 如果暂时保留，也只能作为过渡定义，不应成为未来插件样板的一部分

**优先级**

- 第一波明确其命运

### 6. `steps/index.js`

**当前观察**

- 聚合了大量自定义 step
- 同时包含提取、outline 解析、validation 结果解析等明显可复用模式
- 也包含故事领域明确专属的生产逻辑

**建议动作**

- 拆分处理

**目标态去向**

- 故事领域 step 保留在 `StoryOrchestrator`
- 通用 step 模板与 helper 迁移到 SDK

**判断原则**

- 如果它是“故事内容本身”的逻辑，保留
- 如果它是“其他工作流也会遇到的编排模板”，迁到 SDK

**优先级**

- 第三波重点收敛对象

**当前阶段判断**

- 已把 extraction / parse / validate 这类骨架与 outline/chapter 领域规则的边界写得更清楚
- 但仍属于混合模块，后续应继续按 helper pattern 逐步拆分，而不是一次性整块迁移

## 状态与存储模块映射

### 7. `core/StateManager.js`

**当前观察**

- 既管理故事业务状态
- 又维护 workflow 字段
- 同时串联 repository 与 artifact manager
- 当前业务状态和执行状态混在同一聚合对象里

**建议动作**

- 保留
- 但必须重新收口边界

**目标态去向**

- `StoryOrchestrator`

**原因**

- 插件需要自己的业务状态聚合层
- 但它不应继续承担 runtime 真相来源职责

**改造方向**

- 保留业务摘要和聚合
- 让执行状态查询尽量来自 kernel
- 避免继续把恢复和控制逻辑塞回 `workflow` 字段

### 8. `core/StoryStateRepository.js`

**当前观察**

- 除了故事主表，还承载 checkpoint、snapshot、events、phase_attempts 等模型
- 当前既服务业务，也在承接不少 runtime 相关持久化

**建议动作**

- 保留业务仓储部分
- 避免继续把通用 runtime 模型无限扩张为插件私有实现

**目标态去向**

- `StoryOrchestrator`

**原因**

- 业务快照、业务产物、故事级索引是插件自己的资产
- 但通用 workflow runtime 的核心 contract 最终应由 kernel 面统一定义

**优先级**

- 第二波、第三波联动收口

### 9. `core/ArtifactManager.js`

**当前观察**

- 负责 artifact 落盘、哈希、索引
- 和 repository 紧密配合

**建议动作**

- 保留
- 同时向标准 artifact contract 对齐

**目标态去向**

- `StoryOrchestrator`

**原因**

- artifact 内容本身是故事业务资产
- 但 artifact 管理接口应尽量向未来 SDK contract 靠拢，避免形成私有孤岛

## 手写 Phase 模块映射

### 10. `core/Phase1_WorldBuilding.js`

**建议动作**

- 退出主路径
- 必要时保留为兼容壳

**原因**

- 这是典型的 hand-written phase 编排实现
- 目标态下不应再成为主要执行面

### 11. `core/Phase2_OutlineDrafting.js`

**建议动作**

- 退出主路径

**原因**

- 同属 phase class 编排层
- 尤其大纲回流和章节生产逻辑，目标态应改为 definition + kernel runtime + 少量领域 step 的组合

### 12. `core/Phase3_Refinement.js`

**建议动作**

- 退出主路径

**原因**

- 同属 phase class 编排层
- 最终应被收敛为 phase definition 与领域 step 组合

## 领域逻辑与工具模块映射

### 13. `core/ChapterOperations.js`

**建议动作**

- 主体保留
- 识别可复用的章节生产模式后，部分下沉到 SDK

**原因**

- 章节生产是故事领域核心能力
- 但其中若包含可复用的“生成 -> 校验 -> 修订”套路，应逐步抽象

**当前阶段判断**

- 当前更适合作为“story-domain operation built on reusable orchestration skeleton”的模块理解
- 不应再把其中的章节长度策略、扩写阈值、修订约束误表述成通用平台规则

### 14. `core/ContentValidator.js`

**建议动作**

- 拆分后处理

**推荐拆分方向**

- 通用校验工作流骨架：迁移到 SDK
- 故事领域校验规则：保留在 `StoryOrchestrator`

**原因**

- 校验动作本身常见
- 但具体判定规则有明显故事领域特征

**当前阶段判断**

- 已显式把 delegate -> parse -> aggregate 看作可复用骨架
- 世界观、人物、情节这三类 prompt 和 verdict 规则仍然属于 StoryOrchestrator 私有领域语义

### 15. `utils/PromptBuilder.js`

**建议动作**

- 保留
- 支持模板化和更清晰的组织方式

**原因**

- prompt 是故事领域知识的重要体现
- 不适合迁移到内核

### 16. `config/extraction-schemas.js`

**建议动作**

- 保留

**原因**

- schema 本身属于领域数据定义
- 但“怎么做 extraction”不应继续耦合在 StoryOrchestrator 私有运行时里

### 17. `utils/SchemaValidator.js`

**建议动作**

- 迁移到 SDK

**原因**

- schema 校验明显是跨插件复用模式
- 不应长期作为故事插件私有能力存在

**当前阶段判断**

- 当前文件仍承载 StoryOrchestrator 的字段级 schema 规则
- 更准确的后续动作应是“先拆通用校验骨架，再评估哪些字段规则值得标准化”，而不是直接把现有故事 schema 逐字上收

### 18. `utils/ValidationSchemas.js`

**建议动作**

- 保留

**原因**

- 这是插件工具接口的输入校验边界
- 仍然属于插件对外 contract 的一部分

### 19. `agents/AgentDispatcher.js` 与 `agents/AgentDefinitions.js`

**建议动作**

- 保留

**原因**

- agent 类型和编排依赖于故事领域的组织方式
- 这类配置更像插件自身能力装配，而不是通用 workflow runtime

## 推荐的模块动作分组

### A. 应优先判定为“长期保留”的模块

- `core/StoryOrchestrator.js`
- `config/workflow-definition.js`
- `core/StateManager.js`
- `core/StoryStateRepository.js`
- `core/ArtifactManager.js`
- `core/ChapterOperations.js`
- `core/ContentValidator.js` 中的故事规则部分
- `utils/PromptBuilder.js`
- `config/extraction-schemas.js`
- `utils/ValidationSchemas.js`
- `agents/AgentDispatcher.js`
- `agents/AgentDefinitions.js`

### B. 应优先判定为“迁移到内核”的模块或职责

- `core/WorkflowEngine.js` 中的通用控制面
- `adapters/StoryOrchestratorKernelAdapter.js` 中的通用运行时桥接语义
- 各类 checkpoint / timeout / recovery / rollback / retry 执行逻辑

### C. 应优先判定为“迁移到 SDK”的模块或职责

- `steps/index.js` 中的通用 step 模板
- `utils/SchemaValidator.js`
- `adapters/StoryOrchestratorKernelAdapter.js` 中可复用的 step helper、snapshot/projector contract、编排模板
- `core/ContentValidator.js` 中的通用校验骨架

### D. 应优先判定为“退出或降级”的模块

- `core/Phase1_WorldBuilding.js`
- `core/Phase2_OutlineDrafting.js`
- `core/Phase3_Refinement.js`
- `config/workflow-phase1.js`
- `core/WorkflowEngine.js` 的 legacy 主路径形态
- 厚 `KernelAdapter` 中只为过渡存在的桥接补丁

## 按三波推进时的落地建议

### 第一波

先处理最危险的“运行时语义仍在插件里”的部分：

- `core/WorkflowEngine.js` 中的 checkpoint timeout、phase 入口、部分 retry 逻辑
- `adapters/StoryOrchestratorKernelAdapter.js` 中补语义的桥接段
- `config/workflow-phase1.js` 的命运确认

### 第二波

重点上收控制面：

- `core/WorkflowEngine.js`
- `adapters/StoryOrchestratorKernelAdapter.js`
- phase class 主路径退出

### 第三波

重点抽出复用模式：

- `steps/index.js`
- `utils/SchemaValidator.js`
- `core/ContentValidator.js` 中的可复用骨架
- artifact / snapshot / projector 相关 contract

## 评审时的快速检查表

看到某个现有模块时，可以直接问：

- 它现在是在表达故事领域知识，还是在补内核缺口
- 如果第二个插件要用它，复制过去是否合理
- 如果合理复用，为什么它还没被抽到 SDK
- 如果它决定通用执行行为，为什么它不在 `WorkflowKernel`
- 如果它只服务旧路径，为什么它仍然在主路径里

## 最终结论

模块映射版清单的意义，在于把“目标态”变成可执行的收敛动作。

它希望帮助团队形成一个统一判断：

- 不是所有现有模块都要删除
- 也不是所有现有模块都应该继续保留原位
- 真正要做的是把现有模块按职责拆开，分别收口到：
  - `StoryOrchestrator`
  - `WorkflowKernel`
  - Plugin SDK
  - compatibility surface

如果这份映射被正确执行，最终的 `StoryOrchestrator` 将不再是“历史厚插件”，而会变成一个更接近目标态的参考实现。

结合当前实现进度，更准确的阶段性口径是：

**模块映射已经可以清楚区分哪些是 compatibility residue、哪些是长期保留的领域资产、哪些是 helper-pattern 候选，但 `StoryOrchestratorKernelAdapter` 和状态层的最终收薄仍是达到 thin reference plugin 的剩余阻塞。**
