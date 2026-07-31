# `rag_param_eval_set.jsonl` 字段说明与评估方法

本文说明 `eval/rag_param_eval_set.jsonl` 中每个字段的含义，以及如何使用这套评测数据集评估：

- embedding 模型
- RAG 检索参数
- 门控与排序策略

如果你想看命令怎么执行，请配合阅读 `eval/EVAL_COMMANDS_USAGE.md`。

## 1. 这份评测集是什么

`eval/rag_param_eval_set.jsonl` 是一份 **JSONL 格式** 的评测集：

- 每一行是一个独立的 JSON 对象
- 每一行表示一个评测样本
- 一个样本对应一次真实或模拟检索请求

这份数据集的设计目标不是单纯测“能不能搜到”，而是同时覆盖：

- 时间召回能力
- TagMemo 标签召回能力
- 重排能力
- 混合模式表现
- 门控放行/拦截准确性
- 抗干扰能力

评测数据主要配套以下目录与脚本使用：

- 评测集：`eval/rag_param_eval_set.jsonl`
- 评测知识库：`eval/dailynote_eval/`
- 真实运行脚本：`eval/real-run-eval.js`
- 评分脚本：`eval/score-rag-eval.js`
- 命令说明：`eval/EVAL_COMMANDS_USAGE.md`

## 2. 单条样本结构

一条典型样本如下：

```json
{
  "id": "case_002",
  "category": "tagmemo_rerank",
  "note": "命中 429 处理记录",
  "query": "错误码429当时如何处理，是否用了指数退避重试？",
  "mode": "[[RAG评测主库日记本::TagMemo::Rerank]]",
  "expected_diaries": ["RAG评测主库"],
  "gold_snippets": ["错误码429", "指数退避重试"],
  "tag_targets": ["429限流", "退避重试"],
  "hard_negative": ["世界观核心法则"],
  "gate_expect": true
}
```

## 3. 各字段含义

### `id`

- 样本唯一 ID
- 用于把评测集与检索结果一一对应
- 评分脚本会按 `id` 将 `eval/results/*.json` 中的结果映射回评测样本

建议：

- 全局唯一
- 不要重复
- 新增样本时按顺序递增，便于报告排查

### `category`

- 样本类别标签
- 用于表达该样本想测什么能力
- 主要服务人工分析、失败归因、分桶统计

当前常见类别包括：

- `time_only`
- `time_rerank`
- `tagmemo_only`
- `tagmemo_rerank`
- `time_tagmemo`
- `time_tagmemo_rerank`
- `group_only`
- `group_rerank`
- `hybrid_rerank`
- `threshold_gate_positive`
- `threshold_gate_negative`
- `hybrid_gate_negative`

它本身 **不会直接被 `score-rag-eval.js` 用来算分**，但对分析“哪类能力退化了”非常有用。

### `note`

- 对样本设计意图的人工注释
- 主要给人看，便于维护数据集
- 常用于记录“这条样本理论上应该命中哪篇日记”

它也 **不直接参与评分**，但非常适合在调试失败样本时快速理解上下文。

### `query`

- 用户查询文本
- 是真实评测时发给 RAG 插件的核心输入
- 在 `real-run-eval.js` 中会作为 `user` 消息送入 `ragPlugin.processMessages(...)`

这个字段决定了：

- embedding 查询向量长什么样
- 召回阶段会搜到什么
- TagMemo 是否能命中标签语义
- rerank 是否能把正确片段排到前面
- 门控是否应该放行

### `mode`

- 系统模式字符串
- 在真实评测时会作为 `system` 消息送入 RAG 插件
- 本质上用于控制“这次查询走哪种检索路径”

例如：

- `[[RAG评测主库日记本::Time]]`
- `[[RAG评测主库日记本::TagMemo::Rerank]]`
- `[[RAG评测主库日记本::Time::TagMemo::Rerank]]`
- `<<RAG评测主库日记本>>`
- `《《RAG评测主库日记本::Rerank》》`

可把它理解为“评测路由配置”。

它决定了样本是在测试：

- 时间路径
- TagMemo 路径
- Group 路径
- Rerank 路径
- Hybrid 路径
- 全文门控路径

### `expected_diaries`

- 期望命中的知识库目录
- 当前通常是：
  - `RAG评测主库`
  - `RAG评测干扰库`

这个字段主要用于：

- 数据集语义校验
- 维护时确认样本意图
- 区分主库/干扰库测试目标

注意：

- 评分脚本当前 **不会直接使用 `expected_diaries` 计算指标**
- 但它是数据质量的重要约束

### `gold_snippets`

- 金标正文片段
- 表示“正确答案应当在返回结果中出现哪些文本证据”
- `score-rag-eval.js` 会直接用它来计算：
  - `Recall@5`
  - `Precision@5`
  - `MRR`

评分逻辑是“返回的 `topk[].text` 里是否包含这些片段”。

因此它的设计原则是：

- 应写成 **正文中实际存在** 的关键证据
- 应足够稳定，不要太泛
- 应能区分目标日记与干扰日记

它是当前评分体系里最核心的字段之一。

### `tag_targets`

- TagMemo 专用标签锚点
- 表示“如果这条样本走 TagMemo，理论上应该命中哪些标签语义”
- 例如：
  - `["429限流", "退避重试"]`
  - `["发布窗口", "回滚预案"]`
  - `["需求追踪", "验收项"]`

这个字段的定位很重要：

- 它是 **标签层金标**
- 不是正文层金标
- 它主要用于校验评测数据本身是否真的能测到 TagMemo

当前 `score-rag-eval.js` **不会直接使用 `tag_targets` 算分**；它主要由测试文件 `test/rag-params/dailynote-eval-data.test.js` 使用，用来确保：

- TagMemo 样本必须显式声明标签锚点
- 这些锚点确实存在于目标日记的 Tag 行中
- 不会为了过测试而把整句正文抄进 tag

你可以把它理解成：

- `gold_snippets` = “正文命中证据”
- `tag_targets` = “标签命中证据”

### `hard_negative`

- 硬负例片段
- 表示“看起来可能相关，但其实是错误答案或干扰答案”的文本
- `score-rag-eval.js` 会用它计算 `NoiseRate`

例如：

- 技术查询的硬负例放到小说设定词上
- 主库查询的硬负例放到干扰库的点歌词上
- 干扰库查询的硬负例放到主库技术词上

设计原则：

- 必须有迷惑性
- 必须容易误召回
- 但语义上必须是错误答案

如果 candidate 比 baseline 更容易打到 `hard_negative`，说明它的召回或排序在退化。

### `gate_expect`

- 门控期望值
- 表示系统面对该查询时，理论上是否应该放行
- `true` 表示应该回答
- `false` 表示应该拦截或拒答

真实评测时，`real-run-eval.js` 会根据输出内容是否为空生成 `gatePassed`，然后 `score-rag-eval.js` 用 `gate_expect` 对比 `gatePassed`，计算 `GateErrorRate`。

因此它主要用于测试：

- 主库是否误放行非技术查询
- 干扰库是否误放行技术查询
- 混合模式下是否知道“什么时候不该答”

## 4. 哪些字段真正参与评分

当前评分脚本 `eval/score-rag-eval.js` 直接消费的字段只有这几个：

- `id`
- `gold_snippets`
- `hard_negative`
- `gate_expect`

其中：

- `id` 用来匹配结果
- `gold_snippets` 用来算命中、排名、精确率
- `hard_negative` 用来算噪声率
- `gate_expect` 用来算门控错误率

而下面这些字段更多用于“运行控制”或“数据质量约束”：

- `query`
- `mode`
- `expected_diaries`
- `tag_targets`
- `category`
- `note`

## 5. 真实评测链路里这些字段怎么流动

真实链路大致如下：

1. `real-run-eval.js` 读取 `rag_param_eval_set.jsonl`
2. 对每一条样本：
   - `mode` 作为 `system`
   - `query` 作为 `user`
3. 调用 `ragPlugin.processMessages(...)`
4. 从事件或输出中抽取 `topk`
5. 根据输出是否为空得到 `gatePassed`
6. `score-rag-eval.js` 用：
   - `gold_snippets` 计算 `Recall@5 / Precision@5 / MRR`
   - `hard_negative` 计算 `NoiseRate`
   - `gate_expect` 计算 `GateErrorRate`

所以从职责上看：

- `real-run-eval.js` 负责“跑系统”
- `score-rag-eval.js` 负责“算指标”
- `compare-rag-eval.js` 负责“做对比”
- `gate-rag-eval.js` 负责“做门禁”

## 6. 如何用这套数据集评估 embedding 模型

评 embedding 模型时，核心思路是：

- **尽量只换 embedding 变量**
- **尽量不改 RAG 参数**
- 看指标变化是否来自向量表达能力，而不是检索策略变化

本项目里推荐用 variant 配置做 A/B：

文件：

- `eval/embedding_variant_config.json`

其中可分别给 `baseline` / `candidate` 指定：

- `WhitelistEmbeddingModel`
- `VECTORDB_DIMENSION`
- `EMBEDDING_DIMENSIONS`
- `KNOWLEDGEBASE_STORE_PATH`
- `KNOWLEDGEBASE_ROOT_PATH`

### 评 embedding 时建议控制不变的部分

- 同一份 `rag_param_eval_set.jsonl`
- 同一份 `dailynote_eval/`
- 同一份 `rag_params.json`
- 相同的门控逻辑
- 相同的 rerank 逻辑

### 评 embedding 时主要观察什么

#### `Recall@5`

- 看模型能不能把正确主题召回上来
- 尤其关注：
  - 近义表达
  - 口语表达
  - 低表面重合表达
  - 技术语义与干扰语义的分离能力

#### `MRR`

- 看正确结果是不是更靠前
- embedding 更好时，正确结果通常不仅“能召回”，而且更容易排在前几位

#### `NoiseRate`

- 看是否更容易被干扰库词汇误导
- 例如技术查询是否误打到：
  - `梦境潮汐`
  - `古城祭典`
  - `点歌偏好`

### 哪些样本更适合测 embedding

优先看这些：

- `tagmemo_rerank`
- `time_tagmemo_rerank`
- `hybrid_rerank`
- 干扰库与主库强混淆样本
- 新增的高混淆样本 `case_033` ~ `case_040`

因为这些样本更依赖：

- 语义相似度
- 标签表示能力
- 细粒度主题区分能力

### 推荐命令

```bash
npm run eval:all:real:variant
```

如果 baseline / candidate 只切换 embedding，而 `ragParamsPath` 保持一致，那么结果差异就更接近“embedding 差异”。

## 7. 如何用这套数据集评估 RAG 参数

评 RAG 参数时，核心思路是：

- **固定 embedding 模型**
- **只改 `rag_params.json` 或候选参数文件**
- 看召回、排序、门控、降噪是否更优

适合测试的参数包括但不限于：

- TopK 大小
- 时间衰减参数
- rerank 开关与权重
- TagMemo 权重
- 截断比例
- 噪声惩罚
- 门控阈值
- group 聚合策略

### 评 RAG 参数时重点看什么

#### `Recall@5`

- 参数变动后有没有漏召回
- 特别是 recall 不能大幅掉

#### `Precision@5`

- 返回结果是否更干净
- 是否减少了“召回一堆边缘相关内容”

#### `MRR`

- rerank、TagMemo 加权、时间权重是否让正确结果更前

#### `NoiseRate`

- 参数是否降低了误召回干扰项的概率

#### `GateErrorRate`

- 门控阈值是否更合理
- 是否减少误放行和误拦截

### 哪些样本更适合测 RAG 参数

优先看这些：

- `time_only` / `time_rerank`
- `tagmemo_only` / `tagmemo_rerank`
- `group_only` / `group_rerank`
- `threshold_gate_positive` / `threshold_gate_negative`
- `hybrid_gate_negative`

因为这些样本更直接反映某个具体路径的参数效果。

### 推荐做法

#### 只改参数，不改 embedding

- baseline 与 candidate 使用同一个 embedding 模型
- 只让 `ragParamsPath` 不同

#### 重点分析分桶结果

- 如果 `tagmemo_*` 变好，但 `time_*` 变差，说明 TagMemo 权重可能过高
- 如果 `NoiseRate` 下降但 `Recall@5` 也掉很多，说明参数过于保守
- 如果 `GateErrorRate` 下降，说明门控更稳

## 8. 如何区分“embedding 退化”还是“RAG 参数退化”

这是实际实验里最重要的问题之一。

### 更像 embedding 问题的信号

- 多个模式下都召不回来
- 近义表达整体退化
- 主库/干扰库语义边界变模糊
- `Recall@5` 与 `MRR` 普遍下降
- 高混淆样本退化明显

### 更像 RAG 参数问题的信号

- 某一条路径明显退化，例如只在 `TagMemo` 或只在 `Time` 退化
- `Recall@5` 还行，但 `MRR`、`Precision@5` 变差
- `NoiseRate` 明显升高
- `GateErrorRate` 波动大
- 同一个 embedding 下改参数就能复现问题

### 最佳实践

做两组实验：

#### 实验 A：只换 embedding

- baseline / candidate 参数一致
- 只改 embedding 模型与维度

#### 实验 B：只换 RAG 参数

- baseline / candidate embedding 一致
- 只改 `rag_params.json`

这样才能把变量拆开看。

## 9. 如何写出高质量评测样本

### 好样本应该满足

- 查询自然，像真实用户说的话
- `gold_snippets` 是正文真实证据
- `tag_targets` 是短小、精炼、可区分的标签锚点
- `hard_negative` 有迷惑性但确实错误
- `gate_expect` 语义明确
- 最好能指出到底想测哪条链路

### 当前这套数据集的设计重点

- 主库/干扰库双库对抗
- 技术语义/非技术语义分离
- 时间、标签、分组、重排联合覆盖
- 精简 Tag 设计，避免“标签等于正文摘要”
- 加入高混淆自然语言样本，放大 embedding 与参数差异

## 10. 推荐评估流程

### 场景 A：评估 embedding 模型

1. 固定 `rag_params.json`
2. 在 `embedding_variant_config.json` 中给 baseline / candidate 配不同 embedding
3. 执行：

```bash
npm run eval:all:real:variant
```

4. 重点看：

- `Recall@5`
- `MRR`
- `NoiseRate`
- 高混淆 TagMemo 样本表现

### 场景 B：评估 RAG 参数

1. 固定 embedding 模型
2. baseline / candidate 指向不同 `ragParamsPath`
3. 执行真实评测
4. 重点看：

- `Precision@5`
- `MRR`
- `NoiseRate`
- `GateErrorRate`

### 场景 C：同时评 embedding + RAG

不建议直接一步混合改，因为很难归因。

如果必须混合改，建议：

- 先做单变量实验
- 再做组合实验
- 最后对比差异报告与失败样本

## 11. 读报告时怎么解读

评测产物主要看：

- `eval/results/*.json`
- `eval/reports/rag_eval_baseline.json`
- `eval/reports/rag_eval_candidate.json`
- `eval/reports/rag_eval_diff.md`
- `eval/reports/rag_eval_gate.json`

建议阅读顺序：

1. 先看 `rag_eval_diff.md`
2. 再看 `rag_eval_gate.json`
3. 最后回到失败样本对应的 `query / gold_snippets / hard_negative / tag_targets`

这样最容易判断：

- 是 embedding 召回不行
- 还是 rerank 排序不行
- 还是门控阈值不对
- 还是 TagMemo 标签设计有问题

## 12. 当前这份评测集的一个重要约定

当前版本中：

- `gold_snippets` 是 **评分金标**
- `tag_targets` 是 **TagMemo 数据校验金标**

也就是说：

- 报告分数的高低，主要看 `gold_snippets`
- Tag 是否设计合理，主要看 `tag_targets`

这是为了兼顾两件事：

- 正文评分仍然稳定
- tag 可以保持“短、少、精”

而不会为了评分把 tag 写成长句。

## 13. 一句话总结

这份 `rag_param_eval_set.jsonl` 可以理解为一张“多维标注表”：

- `query` 和 `mode` 决定怎么测
- `gold_snippets` 决定答对没答对
- `hard_negative` 决定有没有被干扰
- `gate_expect` 决定该不该答
- `tag_targets` 决定 TagMemo 是不是真的被测到了

如果你想评 embedding，就尽量只换向量模型；
如果你想评 RAG 参数，就尽量只换检索参数；
如果你想让结论可靠，就一定要做单变量对比。

## 附录 A：样本设计 Checklist

下面这份 checklist 适合在你新增或修改 `rag_param_eval_set.jsonl` 样本时逐条自检。

### A.1 基础结构检查

- 是否有唯一 `id`
- `category` 是否和样本想测的能力一致
- `note` 是否能一句话说明样本意图
- `query` 是否是自然语言，而不是关键词堆砌
- `mode` 是否与目标测试路径一致
- `expected_diaries` 是否指向正确知识库
- `gold_snippets`、`hard_negative`、`gate_expect` 是否齐全

### A.2 查询质量检查

- 查询是否像真实用户会说的话
- 查询是否避免直接照抄日记原文标题
- 查询是否保留了适度模糊性，而不是机械关键字匹配
- 查询是否能明确区分“想找什么”和“不要什么”
- 如果是高难样本，是否存在口语化、近义表达、缩略表达或反向限定

### A.3 `gold_snippets` 检查

- 是否真的存在于目标日记正文中
- 是否是回答问题所必需的关键证据
- 是否足够具体，能和其他日记区分开
- 是否避免使用过于泛化的短词，例如“计划”“问题”“记录”
- 如果写了两个片段，它们是否共同指向同一目标日记

### A.4 `tag_targets` 检查

- 如果样本涉及 `TagMemo`，是否显式提供了 `tag_targets`
- `tag_targets` 是否真的存在于目标日记的 Tag 行中
- `tag_targets` 是否足够短小，而不是整句正文
- `tag_targets` 是否体现“主题词 + 判别词”
- `tag_targets` 是否能和相邻主题区分开

### A.5 `hard_negative` 检查

- 是否真的容易和正确答案混淆
- 是否来自错误知识库或错误主题
- 是否会诱发 embedding 误召回或 rerank 误排序
- 是否不是纯随机噪声
- 是否不会意外出现在目标日记的 Tag 行里

### A.6 `gate_expect` 检查

- 这条请求理论上是否应该回答，语义是否明确
- 如果是 `false`，是否确实属于误放行风险场景
- 如果是 `true`，是否确实有足够证据支持放行
- 是否覆盖了主库误放行、干扰库误放行、混合模式误放行等典型场景

### A.7 评估目标检查

- 这条样本主要是在测 embedding，还是测 RAG 参数
- 如果是测 embedding，是否减少了参数变量干扰
- 如果是测参数，是否尽量固定了 embedding
- 这条样本更偏向召回、排序、TagMemo、时间衰减、门控中的哪一类能力
- `category` 是否能帮助后续按能力分桶复盘

### A.8 难度设计检查

- 是否有足够多的简单样本，保证基本链路可验证
- 是否有足够多的中等难度样本，检测常规优化收益
- 是否加入了高混淆样本，放大 embedding 与参数差异
- 高难样本是否避免变成“只有人工知道答案”的谜题
- 难度提升是否来自语义混淆，而不是信息缺失

### A.9 主库/干扰库对抗检查

- 技术查询是否可能误召回到干扰库
- 小说/点歌查询是否可能误召回到主库
- 主库与干扰库是否都覆盖了正样本
- 主库与干扰库是否都覆盖了负样本
- 是否存在跨库近义词、同词根、同场景误导

### A.10 修改后自测检查

- 是否运行过数据校验测试：

```bash
node --test test/rag-params/*.test.js
```

- TagMemo 样本是否全部具备 `tag_targets`
- 所有目标日记是否仍然满足精简 Tag 约束
- 新样本是否没有破坏已有门控负样本
- 如果新增的是高难样本，是否值得加入真实评测链路

### A.11 快速判断标准

如果一条样本同时满足下面几点，通常就算质量不错：

- 查询自然
- 正确答案明确
- 干扰项真实存在且有迷惑性
- TagMemo 样本的标签锚点清晰
- 放行/拦截预期明确
- 能帮助区分 embedding 差异或参数差异

如果一条样本出现下面情况，建议重写：

- 查询像搜索关键词拼接
- `gold_snippets` 太泛或正文里不存在
- `hard_negative` 没有迷惑性
- `tag_targets` 太长、太散、像正文摘要
- `gate_expect` 含糊不清
- 无法说明这条样本到底在测什么
