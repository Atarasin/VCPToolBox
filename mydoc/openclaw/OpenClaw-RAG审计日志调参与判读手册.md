# OpenClaw RAG 审计日志调参与判读手册

## 1. 目的

本文用于指导在 OpenClaw 接入 VCPToolBox 后，如何通过审计日志中的分数统计来调优：

- 显式记忆检索链路 `rag/search`
- 自动上下文召回链路 `rag/context`
- `minScore`
- `maxBlocks`
- `tokenBudget`
- `maxTokenRatio`

核心原则只有一句：

- 显式检索质量看 `rag.search.completed`
- 自动回忆阈值看 `rag.context.completed`

---

## 2. 日志字段总览

### 2.1 `rag.search.completed`

当前日志中会包含：

- `resultCount`
- `filteredByResultWindow`
- `scoreStats.candidates`
- `scoreStats.returned`

含义：

- `candidates`
  - 去重后的候选结果分布
  - 还没有经过最终返回窗口裁剪
- `returned`
  - 最终返回给 OpenClaw 的显式检索结果
- `filteredByResultWindow`
  - 因 top-k 或 rerank 后窗口裁剪掉的候选数量

### 2.2 `rag.context.completed`

当前日志中会包含：

- `resultCount`
- `filteredByMinScore`
- `scoreStats.candidates`
- `scoreStats.eligible`
- `scoreStats.recalled`

含义：

- `candidates`
  - 参与自动召回判定的候选集合
- `eligible`
  - 通过 `minScore` 的候选集合
- `recalled`
  - 最终真正注入上下文的召回块
- `filteredByMinScore`
  - 因 `minScore` 被挡掉的候选数量

---

## 3. 如何看 `rag.search.completed`

### 3.1 理想情况

示例：

```json
"scoreStats": {
  "candidates": { "count": 6, "max": 0.91, "min": 0.62, "avg": 0.77 },
  "returned":   { "count": 4, "max": 0.91, "min": 0.74, "avg": 0.83 }
}
```

解读：

- 候选整体质量较高
- 最终返回结果更集中在高分区间
- 排序和窗口裁剪工作正常

建议：

- 一般无需调 `minScore`
- 检索链路质量健康

### 3.2 候选中有命中，但噪声较多

示例：

```json
"scoreStats": {
  "candidates": { "count": 10, "max": 0.88, "min": 0.21, "avg": 0.43 },
  "returned":   { "count": 4,  "max": 0.88, "min": 0.64, "avg": 0.73 }
},
"filteredByResultWindow": 6
```

解读：

- 有强命中
- 但弱候选噪声不少
- rerank 或返回窗口已经在发挥清洗作用

建议：

- 优先优化 query 表达
- 不一定需要修改系统参数

### 3.3 整体分数偏低

示例：

```json
"scoreStats": {
  "candidates": { "count": 8, "max": 0.49, "min": 0.22, "avg": 0.35 },
  "returned":   { "count": 4, "max": 0.49, "min": 0.36, "avg": 0.42 }
}
```

解读：

- 检索本身没找到强匹配
- 不是返回窗口的问题
- 更可能是 query 不够准，或者 diary 范围太宽

建议：

- 优先改 query
- 优先缩小 diary 范围
- 不要先把问题归因到 `minScore`

---

## 4. 如何看 `rag.context.completed`

### 4.1 典型的 `minScore` 过高

示例：

```json
"filteredByMinScore": 4,
"scoreStats": {
  "candidates": { "count": 4, "max": 0.58, "min": 0.44, "avg": 0.51 },
  "eligible":   { "count": 0, "max": null, "min": null, "avg": null },
  "recalled":   { "count": 0, "max": null, "min": null, "avg": null }
}
```

解读：

- 候选存在
- 但全部被 `minScore` 挡掉
- 这是最典型的阈值过高场景

建议：

- 下调 `minScore`
- 优先调整到略低于有效候选主分布的下边界
- 例如这里可以先试 `0.5` 或 `0.48`

### 4.2 阈值没问题，但注入预算偏紧

示例：

```json
"filteredByMinScore": 0,
"scoreStats": {
  "candidates": { "count": 5, "max": 0.91, "min": 0.74, "avg": 0.82 },
  "eligible":   { "count": 5, "max": 0.91, "min": 0.74, "avg": 0.82 },
  "recalled":   { "count": 1, "max": 0.91, "min": 0.91, "avg": 0.91 }
},
"resultCount": 1
```

解读：

- 候选质量很好
- `minScore` 没有挡掉结果
- 真正限制注入数量的是预算或块数

建议：

- 优先调：
  - `maxBlocks`
  - `tokenBudget`
  - `maxTokenRatio`
- 不要误判成 `minScore` 问题

### 4.3 候选整体质量本身偏低

示例：

```json
"filteredByMinScore": 1,
"scoreStats": {
  "candidates": { "count": 6, "max": 0.46, "min": 0.21, "avg": 0.31 },
  "eligible":   { "count": 0, "max": null, "min": null, "avg": null },
  "recalled":   { "count": 0, "max": null, "min": null, "avg": null }
}
```

解读：

- 即使把 `minScore` 调低，也未必能得到高质量自动召回
- 更可能是 query 质量不足或资料表达方式不利于命中

建议：

- 优先优化 query
- 优先检查记忆内容质量
- 不要只靠降低阈值强行放行弱匹配

---

## 5. 常见调参决策表

### 情况 A

```json
eligible.count = 0
candidates.count > 0
```

结论：

- `minScore` 太高

动作：

- 降低 `minScore`

### 情况 B

```json
eligible.count > 0
recalled.count 很少
```

结论：

- 预算控制导致召回块未被全部注入

动作：

- 调大 `maxBlocks`
- 调大 `tokenBudget`
- 调大 `maxTokenRatio`

### 情况 C

```json
candidates.max 低
candidates.avg 也低
```

结论：

- query 或数据本身匹配度不够

动作：

- 优先改 query
- 缩小 diary 范围
- 检查记忆文本是否包含足够锚点

### 情况 D

```json
rag.search.completed 分数高
rag.context.completed eligible 少或为 0
```

结论：

- 显式检索链路能搜到
- 自动召回阈值过严

动作：

- 优先降低 `minScore`

---

## 6. 推荐调参方法

建议连续观察 5 到 10 条真实请求日志，重点记录：

- `rag.search.completed.scoreStats.candidates`
- `rag.search.completed.scoreStats.returned`
- `rag.context.completed.scoreStats.candidates`
- `rag.context.completed.scoreStats.eligible`
- `rag.context.completed.scoreStats.recalled`
- `rag.context.completed.filteredByMinScore`

然后判断：

- 如果多数“有用问题”的 `rag.context.completed.candidates.max` 都在 `0.5 ~ 0.6`
  - 则 `minScore = 0.7` 通常过高
- 如果有效候选主要集中在 `0.45 ~ 0.55`
  - 则 `minScore` 更适合从 `0.45` 或 `0.5` 开始试

经验建议：

- `0.45`
  - 召回较积极
- `0.5`
  - 较稳妥，适合作为默认尝试值
- `0.6+`
  - 偏严格，只适合高质量、强锚点数据集

---

## 7. 实际分析顺序

每看到一条 `rag.context.completed`，建议按这个顺序看：

1. `filteredByMinScore`
2. `scoreStats.candidates.max`
3. `scoreStats.eligible.count`
4. `scoreStats.recalled.count`

快速判断：

- `eligible = 0`
  - 先降 `minScore`
- `eligible > 0` 但 `recalled` 很少
  - 优先调预算
- `candidates.max` 很低
  - 优先改 query / 缩小范围

---

## 8. 最后的实战原则

不要只看模型最终回答效果，而要同时对照两类日志：

- `rag.search.completed`
- `rag.context.completed`

因为这两者一起看，才能区分：

- 是根本搜不到
- 还是搜到了但被 `minScore` 挡掉
- 还是过了 `minScore` 但被预算限制

如果后续继续迭代调参，建议把真实问题对应的两类日志一起保存，形成一个小样本集用于回看。
