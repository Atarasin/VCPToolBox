# rag_params 参数详解与调优手册

本文档对应配置文件：

- `/home/zh/projects/VCP/VCPToolBox/rag_params.json`

目标：解释每个参数在当前代码中的真实作用、生效位置、调优方法与风险。

---

## 1. 总体机制与优先级

### 1.1 谁在读取这个文件

`rag_params.json` 目前由两个核心模块读取并热更新：

- `RAGDiaryPlugin`：负责日记检索链路中的动态 K、TagMemo 权重、截断比例、TimeDecay 默认值、向量融合权重。
- `KnowledgeBaseManager`：负责 TagMemo V6 增强算法中的动态增益、语言补偿、语义去重阈值、标签输出过滤阈值。

两个模块都通过文件监听自动重载，修改后无需重启进程。

### 1.2 调参时的基本原则

- 先改小步：每次只动 1~2 个参数，幅度控制在 5%~15%。
- 先改范围，再改公式项：优先改 `Range` 参数来约束行为边界。
- 先看症状再下药：召回不足、噪声过高、结果过旧、英文实体被压制，分别对应不同参数簇。
- 避免同时调互相耦合参数：例如 `noise_penalty` 与 `tagWeightRange` 同时大改，会让定位问题困难。

---

## 2. RAGDiaryPlugin 参数详解

配置段：

```json
"RAGDiaryPlugin": {
  "noise_penalty": 0.05,
  "tagWeightRange": [0.05, 0.45],
  "tagTruncationBase": 0.6,
  "tagTruncationRange": [0.5, 0.9],
  "timeDecay": {
    "halfLifeDays": 30,
    "minScore": 0.5
  },
  "mainSearchWeights": [0.7, 0.3],
  "refreshWeights": [0.5, 0.35, 0.15],
  "metaThinkingWeights": [0.8, 0.2]
}
```

### 2.1 noise_penalty

- 作用：参与动态 Tag 权重计算公式，抑制“语义宽度大、话题发散”时的标签增强强度。
- 生效逻辑：
  - `betaInput = L * log(1 + R + 1) - S * noise_penalty`
  - `beta = sigmoid(betaInput)`
  - 再把 `beta` 映射到 `tagWeightRange`
- 直观理解：它是“抗噪阻尼器”。
- 调大后：
  - 优点：减少宽泛问题下的误召回。
  - 风险：本该触发的相关标签可能被压得太低。
- 调小后：
  - 优点：标签增强更积极，召回更广。
  - 风险：噪音和跨主题污染增加。
- 建议区间：`0.03 ~ 0.12`。
- 适合调大场景：你发现结果经常“沾边但不精准”。
- 适合调小场景：你发现结果经常“太保守、召回不全”。

### 2.2 tagWeightRange

- 作用：限制动态 `TagWeight` 的最小值与最大值，控制 TagMemo 对查询向量的影响上限。
- 生效逻辑：`finalTagWeight = min + beta * (max - min)`。
- 直观理解：这是“标签增强音量旋钮”的护栏。
- 左值（最小值）高：
  - 即使低置信场景也会有较强标签介入。
- 右值（最大值）高：
  - 高置信场景会更激进地偏向标签空间。
- 建议区间：
  - 最小值：`0.03 ~ 0.12`
  - 最大值：`0.30 ~ 0.60`
- 常见稳妥组合：`[0.05, 0.45]`、`[0.06, 0.40]`。

### 2.3 tagTruncationBase

- 作用：动态标签截断比例的基准值。
- 生效逻辑：
  - `ratio = base + L*0.3 - S*0.2 + min(R,1)*0.1`
  - 再被 `tagTruncationRange` 裁剪。
- 直观理解：初始“保留标签比例”。
- 调大后：保留更多标签，覆盖更广但噪音风险上升。
- 调小后：保留更少标签，结果更纯但可能漏召回。
- 建议区间：`0.45 ~ 0.75`。

### 2.4 tagTruncationRange

- 作用：给最终截断比例加上下限和上限，防止极端场景过度放大或过度收缩。
- 直观理解：标签保留比例的“保险丝”。
- 调参建议：
  - 下限过低会导致标签链断裂。
  - 上限过高会把长尾噪音标签带入检索。
- 建议区间：
  - 下限：`0.4 ~ 0.6`
  - 上限：`0.75 ~ 0.95`

### 2.5 timeDecay.halfLifeDays

- 作用：`::TimeDecay` 开启时，分数半衰期默认值（可被语法内局部参数覆盖）。
- 生效逻辑：`decayFactor = 0.5^(diffDays / halfLifeDays)`。
- 直观理解：记录“过时变旧”的速度。
- 调小后：旧内容衰减更快，更偏向新近记录。
- 调大后：旧内容保留更久，适合世界观类稳定知识。
- 建议区间：`14 ~ 90` 天。

### 2.6 timeDecay.minScore

- 作用：`::TimeDecay` 后置过滤阈值，低于该分数的候选直接丢弃。
- 直观理解：时间衰减后的“最低录取线”。
- 调大后：结果更干净但可能数量偏少。
- 调小后：覆盖更广但混入弱相关内容。
- 建议区间：`0.30 ~ 0.70`。

### 2.7 mainSearchWeights

- 作用：主搜索时 user/assistant 向量融合权重。
- 当前语义：`[userWeight, aiWeight]`。
- 直观理解：决定“更相信用户当前提问”还是“更相信上一轮 AI 上下文”。
- 调参建议：
  - 对话经常被 AI 历史带偏：提高 user 权重，如 `[0.8, 0.2]`。
  - 任务依赖连续推理上下文：略增 ai 权重，如 `[0.65, 0.35]`。
- 推荐范围：user `0.6 ~ 0.85`，ai `0.15 ~ 0.4`，且总和建议接近 1。

### 2.8 refreshWeights

- 作用：刷新 RAG 区块时融合 user/ai/tool 三路向量。
- 当前语义：`[user, ai, tool]`。
- 直观理解：决定刷新时“更看重最新用户问题、对话脉络还是工具输出”。
- 调参建议：
  - 工具输出经常很关键：提升 tool 权重（第 3 位）。
  - 工具输出噪声大：降低 tool 权重并加强 user。
- 推荐起点：`[0.5, 0.35, 0.15]`。

### 2.9 metaThinkingWeights

- 作用：元思考链路中，融合“原查询向量 + 上一阶段结果均值向量”。
- 当前语义：`[query, stageResult]`。
- 直观理解：阶段推进时是“守住原题”还是“跟随中间结果发散”。
- 调参建议：
  - 发散过头：提高 query 权重，如 `[0.85, 0.15]`。
  - 联想不足：提高 stageResult 权重，如 `[0.7, 0.3]`。

---

## 3. KnowledgeBaseManager 参数详解

配置段：

```json
"KnowledgeBaseManager": {
  "activationMultiplier": [0.5, 1.5],
  "dynamicBoostRange": [0.3, 2.0],
  "coreBoostRange": [1.20, 1.40],
  "deduplicationThreshold": 0.88,
  "techTagThreshold": 0.08,
  "normalTagThreshold": 0.015,
  "languageCompensator": {
    "penaltyUnknown": 0.05,
    "penaltyCrossDomain": 0.1
  }
}
```

### 3.1 activationMultiplier

- 作用：根据 `features.tagMemoActivation` 映射动态乘子，参与 `dynamicBoostFactor`。
- 直观理解：对“当前激活状态”进行二次放大/收缩。
- 调大范围上限：高激活场景更容易大幅增强。
- 调低范围下限：低激活场景更保守，减少误触发。
- 推荐范围：`[0.4~0.7, 1.2~1.8]`。

### 3.2 dynamicBoostRange

- 作用：对动态增强因子做 clamp，再乘到 `baseTagBoost`。
- 直观理解：TagMemo 总增益的“硬边界”。
- 调大上限：高质量标签可更强拉动检索方向，但风险是过拟合。
- 调高下限：弱场景也会被增强，可能抬升噪音。
- 推荐区间：`[0.2~0.5, 1.6~2.5]`。

### 3.3 coreBoostRange

- 作用：核心标签（Core Tag）的动态额外加权区间。
- 直观理解：给“你明确指定的锚点标签”加聚光灯。
- 调大后：
  - 优点：主题对齐更强。
  - 风险：可能压制非核心但有价值的新信息。
- 推荐区间：`[1.1~1.3, 1.3~1.6]`。

### 3.4 deduplicationThreshold

- 作用：标签语义去重阈值，余弦相似度高于此值视为冗余。
- 直观理解：控制“相近标签是合并还是并存”。
- 调高后：更宽松，保留更多相似标签。
- 调低后：更严格，去重更激进。
- 推荐区间：`0.82 ~ 0.93`。

### 3.5 techTagThreshold

- 作用：技术类英文标签输出过滤阈值（相对最大权重比例）。
- 直观理解：技术词保留门槛。
- 调高后：只保留更强技术标签，结果更干净。
- 调低后：技术实体更容易保留，覆盖更广。
- 推荐区间：`0.05 ~ 0.20`。

### 3.6 normalTagThreshold

- 作用：普通标签输出过滤阈值（相对最大权重比例）。
- 直观理解：非技术标签保留门槛。
- 调高后：普通背景词会被更多过滤。
- 调低后：上下文背景词保留更多。
- 推荐区间：`0.01 ~ 0.06`。

### 3.7 languageCompensator.penaltyUnknown

- 作用：在 `queryWorld = Unknown` 且疑似英文技术噪声时施加语言惩罚。
- 直观理解：当系统“不确定你在哪个语义世界”时，对可疑跨语种技术词降权。
- 调大后：更强抑制英文噪声。
- 调小后：更包容英文实体。
- 推荐区间：`0.03 ~ 0.20`。

### 3.8 languageCompensator.penaltyCrossDomain

- 作用：在“已识别世界观但标签跨域”时施加惩罚。
- 直观理解：防止跨领域词把检索带偏。
- 调大后：跨域更难进入结果。
- 调小后：跨域探索性更强。
- 推荐区间：`0.05 ~ 0.25`。

---

## 4. 快速调参对照表（按症状）

### 症状 A：结果太散、噪声高

- 优先调：
  - `noise_penalty` ↑
  - `tagWeightRange` 上限 ↓
  - `tagTruncationBase` ↓ 或 `tagTruncationRange` 上限 ↓
  - `normalTagThreshold` ↑

### 症状 B：召回不够、答复偏“想不起来”

- 优先调：
  - `noise_penalty` ↓
  - `tagWeightRange` 上限 ↑
  - `tagTruncationBase` ↑
  - `dynamicBoostRange` 上限 ↑

### 症状 C：总是被旧记录抢到前面

- 优先调：
  - `timeDecay.halfLifeDays` ↓
  - `timeDecay.minScore` ↑

### 症状 D：英文技术词经常误命中

- 优先调：
  - `languageCompensator.penaltyUnknown` ↑
  - `languageCompensator.penaltyCrossDomain` ↑
  - `techTagThreshold` ↑

### 症状 E：核心锚点标签不够“硬”

- 优先调：
  - `coreBoostRange` 上下限整体 ↑
  - `activationMultiplier` 上限 ↑

---

## 5. 调参流程建议

### 5.1 推荐步骤

- 步骤 1：锁定一个固定测试问题集（10~20 条真实问题）。
- 步骤 2：每次只改一个参数簇，记录前后命中质量。
- 步骤 3：观察日志中的关键指标（L/R/S、TagWeight、K、TimeDecay 过滤数量）。
- 步骤 4：稳定后再做第二轮小幅微调。

### 5.2 变更安全建议

- 不要一次改全表参数。
- `Range` 下限不要大于上限。
- 权重数组长度保持与代码语义一致：
  - `mainSearchWeights` 必须是 2 项。
  - `refreshWeights` 必须是 3 项。
  - `metaThinkingWeights` 必须是 2 项。

---

## 6. 当前文件参数是否都已生效

就当前仓库代码看，`rag_params.json` 中你列出的参数都能在对应逻辑中找到实际读取点并参与计算，不是“死参数”。

额外提示：

- `KnowledgeBaseManager` 里还预留了 `nodeResidualGain` 的读取位点，但你当前配置中未提供该字段，系统会走默认值。

