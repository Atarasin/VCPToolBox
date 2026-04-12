# eval 目录命令使用说明

本文说明 `package.json` 中以下评测命令的用途、执行顺序、输入输出以及常见用法：

- `eval:mock:baseline`
- `eval:mock:candidate`
- `eval:real:baseline`
- `eval:real:candidate`
- `eval:real:baseline:variant`
- `eval:real:candidate:variant`
- `eval:rag-params`
- `eval:compare`
- `eval:gate`
- `eval:all`
- `eval:all:real`
- `eval:all:real:variant`

这些命令对应的实现源码都在当前目录：

- `mock-run-eval.js`
- `real-run-eval.js`
- `score-rag-eval.js`
- `compare-rag-eval.js`
- `gate-rag-eval.js`

## 1. 整体流程

整套评测链路可以分成 4 个阶段：

1. 生成原始检索结果
   - mock 流程由 `mock-run-eval.js` 生成模拟结果
   - real 流程由 `real-run-eval.js` 调真实 RAG 插件生成结果
2. 计算指标
   - `score-rag-eval.js` 根据评测集与结果文件计算 `Recall@5`、`Precision@5`、`MRR`、`NoiseRate`、`GateErrorRate`
3. 对比 baseline 与 candidate
   - `compare-rag-eval.js` 输出 Markdown 对比报告
4. 执行门禁判定
   - `gate-rag-eval.js` 根据阈值判断候选方案是否满足上线要求

对应的典型执行顺序如下：

```bash
npm run eval:mock:baseline
npm run eval:mock:candidate
npm run eval:rag-params
npm run eval:compare
npm run eval:gate
```

如果要一键跑完整 mock 流程，可以直接执行：

```bash
npm run eval:all
```

## 2. 目录中的关键输入与输出

### 输入文件

- `rag_param_eval_set.jsonl`
  - 评测集，每行一个 JSON
  - 字段包括 `id`、`query`、`mode`、`gold_snippets`、`hard_negative`、`gate_expect`
- `embedding_variant_config.json`
  - variant 评测配置
  - 为 `baseline` / `candidate` 分别指定 `ragParamsPath` 和环境变量
- `dailynote_eval/`
  - variant 示例中使用的知识库数据目录

### 输出目录

脚本会按需自动创建以下目录：

- `eval/results/`
  - 保存原始检索结果
  - 例如 `baseline.json`、`candidate.json`
- `eval/reports/`
  - 保存评分报告、对比报告、门禁结果
  - 例如 `rag_eval_baseline.json`、`rag_eval_candidate.json`、`rag_eval_diff.md`、`rag_eval_gate.json`

## 3. 每个命令如何使用

### 3.1 `eval:mock:baseline`

脚本定义：

```bash
node eval/mock-run-eval.js baseline
```

作用：

- 使用模拟数据生成 baseline 版本的检索结果
- 不调用真实知识库，也不依赖真实 RAG 检索链路
- 适合联调评测流水线本身

输入：

- 固定读取 `eval/rag_param_eval_set.jsonl`

输出：

- `eval/results/baseline.json`

适用场景：

- 想快速验证评分、对比、门禁脚本是否正常
- 不想启动真实知识库

运行方式：

```bash
npm run eval:mock:baseline
```

### 3.2 `eval:mock:candidate`

脚本定义：

```bash
node eval/mock-run-eval.js candidate
```

作用：

- 生成 candidate 版本的模拟检索结果
- 在实现里故意让 candidate 指标整体优于 baseline，便于验证对比与门禁逻辑

输入：

- 固定读取 `eval/rag_param_eval_set.jsonl`

输出：

- `eval/results/candidate.json`

运行方式：

```bash
npm run eval:mock:candidate
```

### 3.3 `eval:real:baseline`

脚本定义：

```bash
node eval/real-run-eval.js baseline
```

作用：

- 运行真实 baseline 检索评测
- 会初始化 `KnowledgeBaseManager` 和 `RAGDiaryPlugin`
- 对评测集逐条执行 `ragPlugin.processMessages(...)`
- 输出真实的 `gatePassed` 和 `topk`

输入：

- `eval/rag_param_eval_set.jsonl`
- 默认 RAG 参数文件：`rag_params.json`
- 当前运行环境中的知识库相关环境变量

输出：

- `eval/results/baseline.json`

运行方式：

```bash
npm run eval:real:baseline
```

使用前建议确认：

- 当前仓库依赖已安装
- 真实评测需要可用的知识库目录和向量库配置
- 默认会读取项目根目录下的 `rag_params.json`

### 3.4 `eval:real:candidate`

脚本定义：

```bash
node eval/real-run-eval.js candidate
```

作用：

- 运行真实 candidate 检索评测
- 与 baseline 使用同一套评测集，但候选参数和环境变量可以不同

输出：

- `eval/results/candidate.json`

运行方式：

```bash
npm run eval:real:candidate
```

### 3.5 `eval:real:baseline:variant`

脚本定义：

```bash
node eval/real-run-eval.js baseline --variant-config eval/embedding_variant_config.json
```

作用：

- 使用 variant 配置文件运行 baseline 真实评测
- 适合做带独立环境变量、独立知识库路径、独立向量库路径的实验

`embedding_variant_config.json` 中 baseline 目前包含：

- `ragParamsPath`
- `env.WhitelistEmbeddingModel`
- `env.VECTORDB_DIMENSION`
- `env.EMBEDDING_DIMENSIONS`
- `env.KNOWLEDGEBASE_ROOT_PATH`
- `env.KNOWLEDGEBASE_STORE_PATH`
- `env.KNOWLEDGEBASE_FULL_SCAN_ON_STARTUP`

运行方式：

```bash
npm run eval:real:baseline:variant
```

### 3.6 `eval:real:candidate:variant`

脚本定义：

```bash
node eval/real-run-eval.js candidate --variant-config eval/embedding_variant_config.json
```

作用：

- 使用 variant 配置文件运行 candidate 真实评测
- 常用于 embedding 模型切换、向量维度调整、不同向量库目录隔离

运行方式：

```bash
npm run eval:real:candidate:variant
```

### 3.7 `eval:rag-params`

脚本定义：

```bash
node eval/score-rag-eval.js eval/rag_param_eval_set.jsonl eval/results/baseline.json eval/reports/rag_eval_baseline.json && node eval/score-rag-eval.js eval/rag_param_eval_set.jsonl eval/results/candidate.json eval/reports/rag_eval_candidate.json
```

作用：

- 对 baseline 与 candidate 的原始结果分别做评分
- 计算 5 个核心指标并生成 JSON 报告

前置条件：

- `eval/results/baseline.json` 已存在
- `eval/results/candidate.json` 已存在

输出：

- `eval/reports/rag_eval_baseline.json`
- `eval/reports/rag_eval_candidate.json`

运行方式：

```bash
npm run eval:rag-params
```

### 3.8 `eval:compare`

脚本定义：

```bash
node eval/compare-rag-eval.js eval/reports/rag_eval_baseline.json eval/reports/rag_eval_candidate.json eval/reports/rag_eval_diff.md
```

作用：

- 比较 baseline 与 candidate 的评分结果
- 生成 Markdown 格式的对比报告
- 报告中包含指标对比表和 Top10 失败样本

前置条件：

- `eval/reports/rag_eval_baseline.json` 已存在
- `eval/reports/rag_eval_candidate.json` 已存在

输出：

- `eval/reports/rag_eval_diff.md`

运行方式：

```bash
npm run eval:compare
```

### 3.9 `eval:gate`

脚本定义：

```bash
node eval/gate-rag-eval.js eval/reports/rag_eval_baseline.json eval/reports/rag_eval_candidate.json eval/reports/rag_eval_gate.json
```

作用：

- 根据 baseline 与 candidate 的指标差值执行门禁判断
- 所有检查项都通过时，`pass` 才会是 `true`

当前门禁规则：

- `recall_guard`: `Recall@5` 降幅不能超过 1 个百分点
- `precision_gain`: `Precision@5` 至少提升 3 个百分点
- `mrr_gain`: `MRR` 至少提升 3 个百分点
- `noise_drop`: `NoiseRate` 至少下降 5 个百分点
- `gate_error_drop`: `GateErrorRate` 至少下降 10 个百分点

前置条件：

- `eval/reports/rag_eval_baseline.json` 已存在
- `eval/reports/rag_eval_candidate.json` 已存在

输出：

- `eval/reports/rag_eval_gate.json`

运行方式：

```bash
npm run eval:gate
```

### 3.10 `eval:all`

脚本定义：

```bash
npm run eval:mock:baseline && npm run eval:mock:candidate && npm run eval:rag-params && npm run eval:compare && npm run eval:gate
```

作用：

- 一次跑完 mock 评测全链路
- 最适合验证脚本流程与报告产物

输出结果包括：

- `eval/results/baseline.json`
- `eval/results/candidate.json`
- `eval/reports/rag_eval_baseline.json`
- `eval/reports/rag_eval_candidate.json`
- `eval/reports/rag_eval_diff.md`
- `eval/reports/rag_eval_gate.json`

运行方式：

```bash
npm run eval:all
```

### 3.11 `eval:all:real`

脚本定义：

```bash
npm run eval:real:baseline && npm run eval:real:candidate && npm run eval:rag-params && npm run eval:compare && npm run eval:gate
```

作用：

- 一次跑完真实评测全链路
- 适合在当前默认运行环境下比较 baseline 与 candidate

运行方式：

```bash
npm run eval:all:real
```

注意：

- 该命令依赖真实知识库与 RAG 插件初始化成功
- 如果默认环境变量未配置好，建议优先使用 variant 方式

### 3.12 `eval:all:real:variant`

脚本定义：

```bash
npm run eval:real:baseline:variant && npm run eval:real:candidate:variant && npm run eval:rag-params && npm run eval:compare && npm run eval:gate
```

作用：

- 一次跑完基于 variant 配置的真实评测全链路
- 适合做 embedding 模型切换、向量维度实验、独立向量库存储路径实验

运行方式：

```bash
npm run eval:all:real:variant
```

## 4. 推荐使用方式

### 只验证评测脚本是否工作

```bash
npm run eval:all
```

适合场景：

- 新接手这套评测脚本
- 先确认报告生成链路无误

### 跑真实 baseline/candidate 对比

```bash
npm run eval:all:real
```

适合场景：

- 当前环境变量与知识库配置已经稳定
- 想直接看真实检索效果

### 跑带实验配置的真实评测

```bash
npm run eval:all:real:variant
```

适合场景：

- 要比较不同 embedding 模型
- 要隔离 baseline/candidate 的向量库目录
- 要把参数与环境配置固化到一个 JSON 文件里

## 5. 直接执行底层脚本的写法

如果不想通过 `npm run`，也可以直接执行源码脚本。

### 生成 mock 结果

```bash
node eval/mock-run-eval.js baseline
node eval/mock-run-eval.js candidate
```

### 生成 real 结果

```bash
node eval/real-run-eval.js baseline
node eval/real-run-eval.js candidate
```

### 指定 variant 配置

```bash
node eval/real-run-eval.js baseline --variant-config eval/embedding_variant_config.json
node eval/real-run-eval.js candidate --variant-config eval/embedding_variant_config.json
```

### 指定自定义 RAG 参数文件

`real-run-eval.js` 还支持 `--rag-params`：

```bash
node eval/real-run-eval.js baseline --rag-params /absolute/path/to/rag_params.json
node eval/real-run-eval.js candidate --rag-params /absolute/path/to/rag_params.json
```

参数优先级如下：

1. 命令行 `--rag-params`
2. variant 配置中的 `ragParamsPath`
3. 默认 `rag_params.json`

## 6. 产物怎么解读

### `eval/results/*.json`

原始结果文件，每条记录大致包含：

```json
{
  "id": "case_001",
  "gatePassed": true,
  "topk": [
    {
      "text": "命中的检索片段",
      "score": 0.92
    }
  ]
}
```

含义：

- `id`：与评测集中的样本一一对应
- `gatePassed`：系统是否认为这个请求应该放行
- `topk`：检索返回的候选结果

### `eval/reports/rag_eval_baseline.json` 与 `rag_eval_candidate.json`

评分报告包含两层：

- `summary`
  - 汇总指标
- `perCase`
  - 每个样本的命中情况

核心指标含义：

- `recallAt5`：Top5 中是否至少命中一个金标
- `precisionAt5`：Top5 中命中金标的比例
- `mrr`：首个命中的排名倒数
- `noiseRate`：是否命中硬负例
- `gateErrorRate`：门控结果与 `gate_expect` 是否不一致

### `eval/reports/rag_eval_diff.md`

这是便于人工阅读的 Markdown 对比报告，适合：

- 在评审中直接查看 baseline/candidate 差异
- 快速定位 candidate 的失败样本

### `eval/reports/rag_eval_gate.json`

这是最终门禁结果，重点看：

- `pass`
  - 是否通过上线门禁
- `checks`
  - 每项规则是否通过
- `delta`
  - 各项指标相对 baseline 的变化量

## 7. 常见问题

### 为什么 `eval:rag-params` 执行失败

通常是因为前置结果文件不存在。要先执行以下任一组合：

```bash
npm run eval:mock:baseline
npm run eval:mock:candidate
```

或者：

```bash
npm run eval:real:baseline
npm run eval:real:candidate
```

### 为什么真实评测没有结果或结果为空

优先检查：

- 知识库路径是否正确
- 向量库存储目录是否可写
- `rag_params.json` 是否可用
- variant 配置中的环境变量是否生效
- 评测集中的 `mode` 是否能被插件正确处理

### 为什么 mock 和 real 的结果差异很大

这是正常现象：

- mock 用于验证流程，结果是脚本里人为构造的
- real 才反映真实知识库、召回、排序和门控表现

## 8. 最短上手路径

如果你第一次使用这套脚本，建议按下面顺序：

1. 先跑 mock 全链路

```bash
npm run eval:all
```

2. 确认输出文件都生成在 `eval/results` 与 `eval/reports`

3. 再跑真实 variant 全链路

```bash
npm run eval:all:real:variant
```

这样可以先确认脚本流程正确，再进入真实效果评估。
