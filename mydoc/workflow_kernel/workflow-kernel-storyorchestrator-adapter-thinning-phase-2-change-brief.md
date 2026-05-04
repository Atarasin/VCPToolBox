# Change Brief: workflow-kernel-storyorchestrator-adapter-thinning-phase-2

## 文档目标

本文用于定义下一轮 adapter 收口 change 的建议边界，供维护者直接据此创建新的 OpenSpec artifacts。

## 建议 Change ID

`workflow-kernel-storyorchestrator-adapter-thinning-phase-2`

## 为什么现在做

当前 readiness review 已明确指出，`StoryOrchestratorKernelAdapter` 仍是 `StoryOrchestrator` 距离薄型参考插件终态的首要 blocker。

问题不在于 adapter 仍然“很乱”，而在于它虽然已经完成第一轮职责写实，但仍同时承载：

- kernel bridge
- business snapshot / restore projection
- compatibility event adaptation
- StoryOrchestrator 私有 helper glue

只要这四类职责仍长期聚集在同一适配层，adapter 就仍然像“结构收敛中的协调中心”，而不是“薄桥接层”。

## 这个 Change 要解决什么

- 把 adapter 从“职责可见”推进到“职责真正收薄”
- 明确哪些职责必须继续留在插件适配层
- 明确哪些职责应进一步拆成独立 seam，或下沉到更稳定的宿主边界
- 避免后续新的平台语义继续默认落到 adapter

## In Scope

- 继续细化 `StoryOrchestratorKernelAdapter` 的职责边界
- 收紧 snapshot / restore projection 的挂载方式
- 收紧 compatibility event adaptation 的边界
- 收紧 adapter 内 helper glue 的存在范围
- 为后续 state boundary 与 helper promotion 留出更清晰的接缝

## Out Of Scope

- 不重新打开 replacement certification
- 不重写整个 adapter
- 不在本 change 中顺手做大范围状态层重构
- 不在本 change 中顺手扩大 shared SDK API 面

## 建议设计问题

创建 OpenSpec artifacts 时，建议优先回答下面四个设计问题：

1. adapter 中哪些职责是“长期保留的合法桥接职责”
2. 哪些逻辑仍然只是阶段性 glue，应继续收缩
3. 哪些 seam 可以先变清晰，而不必立刻物理拆文件
4. 怎样避免 adapter phase 2 演变成“彻底重写 adapter”

## 建议任务组

### 1. 适配层职责审计

- 列出当前 adapter 中仍然存在的 bridge / projection / compatibility / helper glue 分段
- 明确每一段的长期归属

### 2. 接缝继续收口

- 为仍保留在 adapter 的职责建立更清晰的 seam
- 收紧不应继续长在 adapter 内的 helper glue

### 3. 风险回归验证

- 增加或更新聚焦测试
- 验证 adapter 收口没有重新引入 runtime 语义漂移

## 完成标准

- 维护者看到 adapter 时，首先看到的是 bridge seam，而不是混合协调流
- 新的平台语义不再自然追加到 adapter 本体
- 后续 state boundary 和 helper promotion 工作能在更小联动面上进行

## 主要风险

- scope 失控，演变成 adapter 全量重写
- 一边拆职责，一边顺手修改 runtime 语义
- 把尚未稳定的过渡细节过早固化

## 风险控制

- 只做职责收口，不做 runtime 口径重定义
- 优先追求 seam 清晰，而不是物理文件数量变化
- 每次调整都用已有 kernel-led 路径与 recovery 路径做聚焦回归

## 推荐优先级

**P0**

## 推荐依赖关系

- 无前置 blocker
- 建议在 `workflow-kernel-storyorchestrator-state-projection-boundaries-phase-2` 之前启动

## 一句话建议

如果现在只起一个新的结构收口 change，优先起这个。
