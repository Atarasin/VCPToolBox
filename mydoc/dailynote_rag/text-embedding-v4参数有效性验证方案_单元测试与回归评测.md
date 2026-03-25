# text-embedding-v4 参数有效性验证方案（单元测试 + 回归评测）

本文目标：在 VCP 从 Gemini embedding01 迁移到阿里云百炼 `text-embedding-v4` 后，用可重复、可量化的方式验证 `rag_params.json` 参数调优是否有效。

---

## 一、验证范围与核心问题

### 1.1 验证对象

- 参数文件：`/home/zh/projects/VCP/VCPToolBox/rag_params.json`
- 主要模块：
  - [RAGDiaryPlugin.js](file:///home/zh/projects/VCP/VCPToolBox/Plugin/RAGDiaryPlugin/RAGDiaryPlugin.js)
  - [KnowledgeBaseManager.js](file:///home/zh/projects/VCP/VCPToolBox/KnowledgeBaseManager.js)
  - [MetaThinkingManager.js](file:///home/zh/projects/VCP/VCPToolBox/Plugin/RAGDiaryPlugin/MetaThinkingManager.js)
  - [EmbeddingUtils.js](file:///home/zh/projects/VCP/VCPToolBox/EmbeddingUtils.js)

### 1.2 要回答的三个问题

- 参数在代码里是否真实生效（不是“死参数”）？
- 参数变化方向是否符合预期（调大/调小后行为是否一致）？
- 新模型下整体检索质量是否提升（而不是仅日志看起来正常）？

---

## 二、测试总架构

采用“两层验证”：

- 第一层：单元测试（逻辑正确性）
  - 目标：验证参数被读取并改变计算结果。
  - 特征：快、稳定、不依赖外部 API。
- 第二层：回归评测（效果正确性）
  - 目标：验证参数在真实样本上的召回质量变化。
  - 特征：离线数据集 + 指标对比 + A/B 判定。

---

## 三、单元测试设计

## 3.1 目录与运行方式建议

建议新增：

- `VCPToolBox/test/rag-params/`

推荐使用 Node 原生测试框架 `node:test` + `assert/strict`，避免新增依赖。

在 `package.json` 增加脚本：

```json
{
  "scripts": {
    "test:rag-params": "node --test test/rag-params/*.test.js"
  }
}
```

## 3.2 单元测试分组

### A 组：RAGDiaryPlugin 动态参数计算

目标函数：`_calculateDynamicParams`

关联参数：

- `noise_penalty`
- `tagWeightRange`
- `tagTruncationBase`
- `tagTruncationRange`

测试要点：

- `noise_penalty` 增大时，`tagWeight` 应下降或不升。
- `tagWeightRange` 改变时，`tagWeight` 必须落在新区间内。
- `tagTruncationBase` 上调时，截断比例整体上移。
- `tagTruncationRange` 生效时，比例必须被 clamp 在 `[min,max]`。

代码定位：

- [RAGDiaryPlugin.js:L474-L527](file:///home/zh/projects/VCP/VCPToolBox/Plugin/RAGDiaryPlugin/RAGDiaryPlugin.js#L474-L527)

### B 组：TimeDecay 参数生效

目标函数：`_applyTimeDecay`

关联参数：

- `timeDecay.halfLifeDays`
- `timeDecay.minScore`

测试要点：

- 在相同样本下，`halfLifeDays` 更小应导致旧记录分数更低。
- 提高 `minScore` 应减少输出条数。
- `source === "time"` 的结果应跳过衰减逻辑。

代码定位：

- [RAGDiaryPlugin.js:L2761-L2875](file:///home/zh/projects/VCP/VCPToolBox/Plugin/RAGDiaryPlugin/RAGDiaryPlugin.js#L2761-L2875)

### C 组：TagMemo V6 强度与去重

目标函数：`_applyTagBoostV6`

关联参数：

- `activationMultiplier`
- `dynamicBoostRange`
- `coreBoostRange`
- `deduplicationThreshold`
- `techTagThreshold`
- `normalTagThreshold`
- `languageCompensator.penaltyUnknown`
- `languageCompensator.penaltyCrossDomain`

测试要点：

- `dynamicBoostRange` 下调上限后，`boostFactor` 不可超过新上限。
- `deduplicationThreshold` 降低后，去重更激进，`matchedTags` 数量应减少或不增。
- `techTagThreshold` 提高后，英文技术标签输出应减少。
- 语言惩罚增大后，跨域技术词权重应下降。

代码定位：

- [KnowledgeBaseManager.js:L508-L520](file:///home/zh/projects/VCP/VCPToolBox/KnowledgeBaseManager.js#L508-L520)
- [KnowledgeBaseManager.js:L816-L892](file:///home/zh/projects/VCP/VCPToolBox/KnowledgeBaseManager.js#L816-L892)

### D 组：向量融合权重生效

目标函数：

- 主搜索融合：`mainSearchWeights`
- 刷新融合：`refreshWeights`
- 元思考融合：`metaThinkingWeights`

测试要点：

- 权重变化后，融合向量应按预期偏向对应输入向量。
- 权重数组长度错误时，应触发回退或失败保护。

代码定位：

- [RAGDiaryPlugin.js:L1120-L1129](file:///home/zh/projects/VCP/VCPToolBox/Plugin/RAGDiaryPlugin/RAGDiaryPlugin.js#L1120-L1129)
- [RAGDiaryPlugin.js:L2146-L2150](file:///home/zh/projects/VCP/VCPToolBox/Plugin/RAGDiaryPlugin/RAGDiaryPlugin.js#L2146-L2150)
- [MetaThinkingManager.js:L273-L279](file:///home/zh/projects/VCP/VCPToolBox/Plugin/RAGDiaryPlugin/MetaThinkingManager.js#L273-L279)

## 3.3 单元测试的 Mock 策略

原则：避免真实外部依赖，全部固定输入、固定输出。

- Mock `vectorDBManager.getEPAAnalysis`，返回稳定 `L/R/entropy`。
- Mock `contextVectorManager.computeSemanticWidth`，返回固定 `S`。
- Mock `dayjs()` 当前时间，固定时间基准，保证 TimeDecay 可重复。
- Mock `epa.project`、`residualPyramid.analyze`、`tagCooccurrenceMatrix`，只保留参数相关分支。

## 3.4 单元测试通过门槛

- 参数影响方向断言通过率 100%。
- 关键边界断言 100%：
  - 区间 clamp
  - 下限/上限
  - 空输入回退
- 不允许随机失败（重复运行 10 次结果一致）。

---

## 四、回归评测设计

## 4.1 评测集构建

建议构建 `eval/rag_param_eval_set.jsonl`，每行一个样本：

```json
{
  "id": "case_001",
  "query": "我们上周讨论过VCP更新计划吗？",
  "mode": "[[VCP开发进度日记本::Time::Rerank]]",
  "expected_diaries": ["VCP开发进度"],
  "expected_tags": ["更新计划", "版本"],
  "gold_snippets": ["2026-03-10 ... 版本路线图", "2026-03-12 ... 发布窗口"],
  "hard_negative": ["小说世界观设定"]
}
```

样本结构建议至少覆盖：

- 时间回溯类（`::Time`）
- 主题增强类（`::TagMemo`、`::Group`）
- 精排类（`::Rerank`）
- 混合复杂类（`::Time + ::TagMemo + ::Rerank`）

规模建议：

- 快速集：30 条
- 标准集：100 条
- 发布前全量集：300 条

## 4.2 对比实验设计

做两组参数：

- Baseline：Gemini 时代参数
- Candidate：text-embedding-v4 适配参数

评测流程：

- 同一评测集、同一知识库快照、同一随机种子。
- 分别运行 A/B，导出 TopK 结果和分数。
- 用统一脚本计算指标并输出差值。

## 4.3 核心指标

必须指标：

- Recall@K：期望片段是否进入 TopK
- Precision@K：TopK 里有多少是相关
- MRR：首个正确结果排名质量
- 门控通过率：`<<>>/《《》》` 场景是否“该过则过，该挡则挡”
- 噪声率：硬负例被召回占比

建议附加指标：

- TimeDecay 后“近时内容占比”
- `matchedTags` 数量分布
- 去重后候选保留率

## 4.4 通过门槛（建议）

Candidate 相对 Baseline：

- Recall@5 不下降超过 1%
- Precision@5 提升 >= 3%
- MRR 提升 >= 3%
- 噪声率下降 >= 5%
- 门控误触发率下降 >= 10%

若未达标，按“症状 -> 参数簇”回调，不做全表重调。

---

## 五、自动化执行方案

## 5.1 命令分层

- `test:rag-params`：单元测试
- `eval:rag-params`：离线回归评测
- `eval:rag-compare`：A/B 对比报告

## 5.2 报告产物

建议输出：

- `reports/rag_eval_baseline.json`
- `reports/rag_eval_candidate.json`
- `reports/rag_eval_diff.md`

`rag_eval_diff.md` 至少包含：

- 总体指标差值表
- 失败样本 Top10
- 参数建议回调方向

---

## 六、参数调优闭环（推荐执行顺序）

每轮调参顺序：

- 第 1 步：只调门控与去重
  - `threshold`（在 `rag_tags.json`）
  - `deduplicationThreshold`
- 第 2 步：调增强强度
  - `tagWeightRange`
  - `dynamicBoostRange`
  - `coreBoostRange`
- 第 3 步：调纯净度与跨域惩罚
  - `techTagThreshold`
  - `normalTagThreshold`
  - `languageCompensator`
- 第 4 步：跑单元测试 + 回归评测，达标后固化参数

---

## 七、迁移到 text-embedding-v4 的前置检查

在开始评测前，先确保：

- `WhitelistEmbeddingModel=text-embedding-v4`
- `VECTORDB_DIMENSION` 与请求 `dimensions` 一致
- 全量重建向量库，避免新旧模型向量混用

相关代码与配置：

- [config.env.example:L157-L162](file:///home/zh/projects/VCP/VCPToolBox/config.env.example#L157-L162)
- [EmbeddingUtils.js:L13-L30](file:///home/zh/projects/VCP/VCPToolBox/EmbeddingUtils.js#L13-L30)

---

## 八、结论

参数有效性验证必须同时包含：

- 单元测试：证明参数在代码中“真的生效”
- 回归评测：证明参数在业务上“真的变好”

只有两层都通过，才能确认 text-embedding-v4 适配参数是可上线参数。

---

## 九、可直接落地的测试模板

## 9.1 单元测试样例（node:test）

建议文件：`test/rag-params/dynamic-params.test.js`

```js
const test = require('node:test');
const assert = require('node:assert/strict');
const RAGDiaryPlugin = require('../../Plugin/RAGDiaryPlugin/RAGDiaryPlugin');

function createPluginWithMock(configOverrides = {}) {
  const plugin = new RAGDiaryPlugin();
  plugin.ragParams = {
    RAGDiaryPlugin: {
      noise_penalty: 0.05,
      tagWeightRange: [0.05, 0.45],
      tagTruncationBase: 0.6,
      tagTruncationRange: [0.5, 0.9],
      ...configOverrides
    }
  };
  plugin.vectorDBManager = {
    getEPAAnalysis: async () => ({ logicDepth: 0.7, resonance: 0.6 })
  };
  plugin.contextVectorManager = {
    computeSemanticWidth: () => 0.4
  };
  return plugin;
}

test('noise_penalty 增大后，tagWeight 应下降或不升', async () => {
  const q = new Array(8).fill(0.1);

  const p1 = createPluginWithMock({ noise_penalty: 0.03 });
  const r1 = await p1._calculateDynamicParams(q, '测试问题', '测试回答');

  const p2 = createPluginWithMock({ noise_penalty: 0.12 });
  const r2 = await p2._calculateDynamicParams(q, '测试问题', '测试回答');

  assert.ok(r2.tagWeight <= r1.tagWeight);
});

test('tagWeight 必须落在 tagWeightRange 内', async () => {
  const q = new Array(8).fill(0.1);
  const p = createPluginWithMock({ tagWeightRange: [0.08, 0.30] });
  const r = await p._calculateDynamicParams(q, '测试问题', '测试回答');
  assert.ok(r.tagWeight >= 0.08 && r.tagWeight <= 0.30);
});
```

建议文件：`test/rag-params/time-decay.test.js`

```js
const test = require('node:test');
const assert = require('node:assert/strict');
const RAGDiaryPlugin = require('../../Plugin/RAGDiaryPlugin/RAGDiaryPlugin');

test('halfLifeDays 越小，旧记录衰减越大', () => {
  const plugin = new RAGDiaryPlugin();
  const rows = [
    { text: '[2025-01-01] 历史记录A', score: 1.0, source: 'rag' },
    { text: '[2026-03-20] 最近记录B', score: 1.0, source: 'rag' }
  ];

  const r30 = plugin._applyTimeDecay(rows, [null, '30', '0', ''], { halfLifeDays: 30, minScore: 0 });
  const r10 = plugin._applyTimeDecay(rows, [null, '10', '0', ''], { halfLifeDays: 30, minScore: 0 });

  const old30 = r30.find(x => x.text.includes('历史记录A')).score;
  const old10 = r10.find(x => x.text.includes('历史记录A')).score;
  assert.ok(old10 <= old30);
});
```

## 9.2 回归评测数据模板

建议文件：`eval/rag_param_eval_set.jsonl`

```json
{"id":"case_001","query":"我们上周讨论过VCP更新计划吗？","mode":"[[VCP开发进度日记本::Time::Rerank]]","expected_diaries":["VCP开发进度"],"gold_snippets":["版本路线图","发布窗口"],"hard_negative":["小说世界观设定"]}
{"id":"case_002","query":"把最近修复的核心bug整理一下","mode":"[[VCP开发进度日记本::TagMemo::Rerank]]","expected_diaries":["VCP开发进度"],"gold_snippets":["修复","回归测试"],"hard_negative":["小说世界观设定"]}
```

## 9.3 A/B 结果对比脚本模板

建议文件：`eval/compare-rag-eval.js`

```js
const fs = require('fs');

function loadJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf-8'));
}

function ratio(n, d) {
  return d === 0 ? 0 : n / d;
}

function summarize(rows) {
  const total = rows.length;
  const recall5 = rows.filter(r => r.hitAt5).length;
  const precision5 = rows.reduce((s, r) => s + (r.precisionAt5 || 0), 0);
  const mrr = rows.reduce((s, r) => s + (r.mrr || 0), 0);
  const noise = rows.filter(r => r.hardNegativeHit).length;
  return {
    total,
    recallAt5: ratio(recall5, total),
    precisionAt5: ratio(precision5, total),
    mrr: ratio(mrr, total),
    noiseRate: ratio(noise, total)
  };
}

const base = summarize(loadJson(process.argv[2]));
const cand = summarize(loadJson(process.argv[3]));

console.log(JSON.stringify({ baseline: base, candidate: cand }, null, 2));
```

---

## 十、执行清单（可直接照做）

- 第 1 步：准备固定评测集（至少 30 条）。
- 第 2 步：先跑单元测试，确保参数逻辑生效且方向正确。
- 第 3 步：执行 Baseline 参数评测，保存基线报告。
- 第 4 步：切换 Candidate 参数评测，输出对比报告。
- 第 5 步：按指标门槛做上线判定，不达标只回调对应参数簇。
