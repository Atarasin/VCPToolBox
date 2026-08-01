# 跨模型评测可信化最终实施方案

> 状态：可进入实施  
> 范围：VCP RAG 评测框架、TDB 冷知识库查询边界、门控配置与跨模型报告  
> 上游问题分析：[跨模型评测的两个陷阱](./cross-model-eval-pitfalls.md)  
> 评测总览：[VCP RAG / 记忆能力评估](../README.md)

---

## 1. 摘要

本方案解决跨 embedding 模型评测中的两个系统性误判来源：

1. 冷知识库与热路径使用不同 embedding 模型或维度，但占位符链路复用热路径查询向量，
   导致维度不匹配或向量空间不一致，最终以“零结果”形式静默失败。
2. 门控阈值、库名向量缓存和比较规则未绑定 embedding 模型身份，导致一个模型标定的
   余弦阈值被直接用于另一个余弦尺度不同的模型，并被错误解释为模型能力差异。

最终目标不是让某个模型“跑满分”，而是保证每个失败都能被归因，并且报告只比较真正
可比的指标。实施完成后，系统必须满足以下核心不变量：

- 查询向量、目标索引和库名/增强向量必须处于同一 embedding 空间；
- embedding 模型、维度、端点指纹、索引指纹和门控校准版本必须进入 run provenance；
- 模型或维度不一致必须显式报错或将相关能力标记为 `SKIPPED`，不得返回伪装正常的空结果；
- 原始余弦、模型内门控准确率和校准后指标必须在报告中分开表达；
- 不同模型使用同一份带标签数据，但分别计算分数和阈值；
- 标定数据与最终 holdout 数据必须隔离，禁止用最终用例反向调阈值。

---

## 2. 背景与现状事实

### 2.1 冷知识库链路

当前评测 profile 只显式设置热路径的 `WhitelistEmbeddingModel`、`VECTORDB_DIMENSION` 和
`EMBEDDING_DIMENSIONS`。冷知识库管理器则优先读取 `TDB_KNOWLEDGE_MODEL` 与
`TDB_KNOWLEDGE_DIMENSION`。当根 `config.env` 固定为 Qwen 4096 维、profile 切换到
Gemini 3072 维时，两个配置源同时生效。

占位符链路为避免重复 embedding，会把 RAGDiaryPlugin 已经生成的查询向量直接传给
`TDBKnowledge.searchWithVector()`。当前该入口只检查管理器是否初始化和向量是否存在，
没有验证维度、模型身份和数值合法性。下游原生检索异常又可能被折叠为空数组，最终看起来
只是“没有召回”。

### 2.2 门控链路

日记本门控阈值来自 `Plugin/RAGDiaryPlugin/rag_tags.json`，评测语料构建会把
`eval/corpus-spec/books.json` 中的全局阈值装入该文件。不同 embedding 模型仍使用同一组
阈值。

门控依赖的库名/增强向量存放于共享的 `vector_cache.json`。当前缓存命中只校验配置内容
哈希，不校验 embedding 模型、维度或端点。即使阈值按 profile 覆盖，仍可能发生“查询向量
来自模型 A，库名向量来自模型 B”的跨空间余弦计算。

当前 compare 仅以 `corpusHash` 与 `suiteHash` 判断两次 run 是否可比，随后统一比较
`gate.accuracy` 并把门控用例纳入 regression/fix 分类。该规则无法表达“检索指标可比、原始
门控余弦不可比”这种按指标轴区分的情况。

---

## 3. 目标、非目标与约束

### 3.1 功能目标

| ID | 目标 | 可验收结果 |
| --- | --- | --- |
| FR-001 | profile 成为评测期 embedding 配置的唯一真相源 | resolved 配置同时包含热路径、冷路径和门控配置，根 `config.env` 不再覆盖 profile 已声明值 |
| FR-002 | 冷知识库索引与 run 隔离 | 每个含 Tier4 的 run 使用自己的 `ColdVectorStore/`，切换模型不会复用旧 `.tdb` |
| FR-003 | 向量空间不一致显式失败 | 维度或模型身份不匹配产生稳定错误码，相关用例为 error/skip，不产生普通空结果 |
| FR-004 | 门控阈值按 profile 和目标库标定 | Gemini、Qwen 分别拥有带数据哈希的校准产物，运行时加载本 profile 对应阈值 |
| FR-005 | 模型相关缓存具备 provenance | 缓存命中同时校验有效配置、模型、维度、端点指纹与评分公式版本 |
| FR-006 | 评测能采集原始门控分数 | 每个带门控标签的样本留下结构化 score、threshold、decision 和 calibrationId |
| FR-007 | compare 按指标轴判定可比性 | 检索、原始门控、校准门控分别给出 comparable 状态和原因 |
| FR-008 | 门控标定无测试集泄漏 | calibration 与 holdout 按意图组隔离，阈值只在 calibration 上拟合 |
| FR-009 | 旧结果不会混入新结论 | 缺少新 provenance/calibration 字段的 run 被标记为 legacy，门控 delta 不参与新门禁 |

### 3.2 非功能目标

| ID | 目标 | 可验收结果 |
| --- | --- | --- |
| NFR-001 | 可复现 | 相同 profile、语料、用例、校准产物和代码版本得到相同 configHash 输入 |
| NFR-002 | 可诊断 | doctor 和 run 日志能区分依赖缺失、索引未建、维度不符、模型不符、校准缺失和检索零命中 |
| NFR-003 | 默认安全 | 任何 provenance 不明的缓存或索引在严格评测模式下视为 cache miss 或 rebuild-required |
| NFR-004 | 向后兼容 | 非评测运行在未配置覆盖路径时继续读取现有默认文件；旧缓存只会失效重建，不要求手工转换 |
| NFR-005 | 不泄露敏感信息 | 配置快照只保存 API 地址的规范化指纹和凭据指纹，不落盘真实密钥 |

### 3.3 非目标

- 本方案不改变 embedding 模型本身的质量，也不试图让不同模型的原始余弦绝对值统一。
- 本方案不把 3072/4096 维度当作能力标签，维度只作为向量兼容性元数据。
- 第一阶段不支持“热路径与冷路径使用不同 embedding 模型但仍共享查询向量”。
- 本方案不自动删除生产 `VectorStoreTDB`；任何生产索引重建必须显式触发。
- 本方案不使用当前 3 条门控失败用例直接拟合正式阈值。
- 本方案不把 LLM 自动生成结果直接视为人工金标。

### 3.4 实施约束

- profile 必须在 require `KnowledgeBaseManager`、`RAGDiaryPlugin` 和 `TDBKnowledge` 前应用；
- 评测仍保持单 run 互斥，避免固定端口和历史共享资源产生竞态；
- 根项目没有有效的通用 `npm test`，新增验证应使用可单独运行的 `node:test` 或 eval CLI；
- 现有 `config.env` 与用户插件配置属于用户资产，评测不得覆盖或删除其中的真实值；
- 运行产物必须继续对密钥做不可逆指纹化。

---

## 4. 关键决策

### 4.1 冷知识库采用 aligned 模式

首期只允许：

```text
cold model     = profile embedding model
cold dimension = profile embedding dimension
```

原因是当前占位符路径复用热路径查询向量。只覆盖维度而不覆盖模型仍可能在相同维度下跨
语义空间检索，因此兼容判定必须同时包含模型与维度。

未来若要支持独立冷库模型，必须引入显式 `independent` 模式，由冷库根据 queryText 自己
生成查询向量，并使用同一冷库模型生成门控向量。该模式不属于本期交付。

### 4.2 评测 run 使用独立冷索引和模型相关缓存

run 目录扩展为：

```text
eval/runs/<runId>/
├── VectorStore/
├── ColdVectorStore/
├── ModelCache/
│   ├── rag-vector-cache.json
│   └── semantic-vectors/
├── config/
│   ├── resolved.json
│   ├── gate-calibration.json
│   ├── gate-dataset.manifest.json
│   ├── rag_params.json
│   └── corpus.manifest.json
├── metrics/
├── results/
└── logs/
```

即使两个模型维度相同，也不得共享上述模型相关资产。

### 4.3 门控阈值按 profile、目标类型和目标库保存

阈值产物区分日记本门控与冷知识库门控：

```json
{
  "thresholds": {
    "diary": {
      "评测运维技术库": 0.553,
      "评测幻想设定库": 0.601
    },
    "cold": {
      "VCP知识": 0.412
    }
  }
}
```

若某个目标没有足够标定数据，严格评测模式下该目标的门控用例应 `SKIPPED`，不得退回
全局默认阈值并继续生成跨模型结论。

### 4.4 跨模型比较以判别能力为主

原始余弦和使用不同阈值后的简单 accuracy 仅作为诊断信息。跨模型门控结论优先使用：

- ROC-AUC；
- PR-AUC；
- 正负样本均值分离度；
- 标准化分离度；
- 固定标定协议下的 holdout TPR、FPR、FNR 与 balanced accuracy。

---

## 5. 目标配置模型

### 5.1 profile schema

现有 profile 增加 `coldKnowledge` 与 `gateCalibrationPath`：

```json
{
  "description": "jy-gemini-embedding-001 @ 3072 维",
  "corpusRoot": "dailynote_eval",
  "ragParamsPath": "rag_params.json",
  "embedding": {
    "model": "jy-gemini-embedding-001",
    "dimension": 3072,
    "maxToken": 512
  },
  "coldKnowledge": {
    "mode": "aligned",
    "storePolicy": "per-run",
    "strictVectorMetadata": true
  },
  "gateCalibrationPath": "gate-calibration/gemini3072.json",
  "env": {}
}
```

路径相对 `eval/` 解析。`coldKnowledge.mode` 仅接受 `aligned`；未知值由 profile loader
直接拒绝。

### 5.2 resolved 配置

`loadProfile()` 返回值增加：

```json
{
  "coldKnowledge": {
    "mode": "aligned",
    "model": "jy-gemini-embedding-001",
    "dimension": 3072,
    "rootPath": "/abs/project/knowledge",
    "storePath": null,
    "strictVectorMetadata": true
  },
  "gateCalibration": {
    "path": "/abs/project/eval/gate-calibration/gemini3072.json",
    "artifact": {},
    "artifactHash": "sha256:..."
  }
}
```

解析顺序固定如下：

1. 读取 profile 的热路径模型、维度与端点；
2. 应用 profile/CLI 对热路径允许的显式覆盖；
3. 得到 effective embedding；
4. 从 effective embedding 派生 aligned 冷路径模型与维度；
5. 校验 `profile.env` 中不存在与 aligned 结果冲突的 `TDB_KNOWLEDGE_MODEL/DIMENSION`；
6. 加载并校验 gate calibration artifact；
7. 创建 run 后注入热库、冷库和模型缓存的 per-run 绝对路径；
8. 在所有相关单例 require 前调用 `applyEnv()`。

aligned 模式下，冲突配置必须报 `PROFILE_COLD_EMBEDDING_CONFLICT`，不能依赖对象 spread
顺序暗中决定胜负。

### 5.3 环境变量映射

| resolved 字段 | 运行时环境变量 | 说明 |
| --- | --- | --- |
| `embedding.model` | `WhitelistEmbeddingModel` | 热路径模型 |
| `embedding.dimension` | `VECTORDB_DIMENSION`、`EMBEDDING_DIMENSIONS` | 热路径维度 |
| `coldKnowledge.model` | `TDB_KNOWLEDGE_MODEL` | aligned 模式下由 profile 派生 |
| `coldKnowledge.dimension` | `TDB_KNOWLEDGE_DIMENSION` | aligned 模式下由 profile 派生 |
| `coldKnowledge.storePath` | `TDB_KNOWLEDGE_STORE_PATH` | 当前 run 的 `ColdVectorStore/` |
| effective gate config | `RAG_GATE_CONFIG_PATH` | 当前 run 的门控覆盖配置 |
| RAG vector cache | `RAG_VECTOR_CACHE_PATH` | 当前 run 的模型缓存 |
| semantic vector dir | `SEMANTIC_VECTOR_CACHE_DIR` | 当前 run 的语义组向量目录 |
| strict mode | `EVAL_STRICT_PROVENANCE` | 评测固定为 `true` |

新增环境变量只作为路径和严格性开关，不携带阈值 JSON 或大段配置内容。

### 5.4 configHash 与 manifest

run 的 `configHash` 新增以下输入：

```text
coldKnowledge.mode
coldKnowledge.model
coldKnowledge.dimension
cold corpus fingerprint
gate calibration artifact hash
gate dataset manifest hash
gate scoring formula version
gate definition hash（库名、tags、description，不含 threshold）
effective gate config hash（definition + 本次 threshold）
```

manifest 增加 `schemaVersion` 和分轴 provenance。任何旧 manifest 缺失这些字段时，loader
将其标记为 `legacy: true`，允许读取历史检索报告，但禁止进行新格式的门控 delta 判定。

`cmdRunLocked` 的现有顺序是“preflight 后创建 run”。因此冷语料 fingerprint 由 preflight
只读计算并通过返回值传给 `createRun()`；per-run store 在创建 run 后必为空，不要求 doctor
预先验证一个尚不存在的 manifest。runtime 初始化时再写入并复核新 store manifest。没有
Tier4 用例时 fingerprint、ColdVectorStore 和相关成本均可省略。

---

## 6. 冷知识库修复设计

### 6.1 索引身份文件

每个 `ColdVectorStore/` 根目录写入 `embedding-manifest.json`：

```json
{
  "schemaVersion": 1,
  "createdAt": "2026-08-01T00:00:00.000Z",
  "embedding": {
    "model": "jy-gemini-embedding-001",
    "dimension": 3072,
    "endpointFingerprint": "sha256:..."
  },
  "source": {
    "root": "knowledge",
    "corpusFingerprint": "sha256:..."
  },
  "chunker": {
    "version": "sha256:..."
  }
}
```

endpoint fingerprint 使用规范化 API base URL、模型名和路由版本计算，不包含 API key。
`corpusFingerprint` 对经过 TDB include/exclude 规则后的文件集合计算：相对路径、内容哈希和
排序后列表共同进入 sha256。mtime 不作为唯一依据。

### 6.2 初始化状态

冷知识库初始化具有以下状态：

| 状态 | 条件 | 行为 |
| --- | --- | --- |
| `disabled` | 功能关闭或 triviumdb 不存在 | capability=false，Tier4 skip |
| `empty` | store 为空 | 写入 manifest，开始全量摄取 |
| `compatible` | manifest 与 effective config 完全匹配 | 允许增量摄取与查询 |
| `rebuild_required` | 模型、维度、端点或语料指纹不匹配 | 不开放查询；eval 使用新目录，生产要求显式 rebuild |
| `legacy_unknown` | store 有数据但无 manifest | eval 拒绝；生产仅在显式迁移开关下临时兼容并持续告警 |
| `failed` | manifest 损坏、摄取失败或原生模块异常 | capability=false，并记录稳定原因码 |

系统不得自动删除非 run 目录中的旧索引。

### 6.3 查询向量契约

`searchWithVector(queryVector, queryText, options)` 增加可选 metadata：

```json
{
  "vectorMeta": {
    "model": "jy-gemini-embedding-001",
    "dimension": 3072,
    "endpointFingerprint": "sha256:..."
  }
}
```

评测严格模式要求 `vectorMeta` 必填。兼容性校验顺序：

1. `queryVector` 必须为非空 Array 或 Float32Array；
2. 所有元素必须是有限数；
3. `queryVector.length` 必须等于 `this.config.dimension`；
4. `vectorMeta.dimension` 必须与实际长度和 store manifest 一致；
5. `vectorMeta.model` 与 endpoint fingerprint 必须与 store manifest 一致。

稳定错误码：

| 错误码 | 含义 | eval 行为 |
| --- | --- | --- |
| `TDB_QUERY_VECTOR_INVALID` | 类型、空值或非有限数错误 | case error |
| `TDB_QUERY_VECTOR_DIMENSION_MISMATCH` | 实际维度与配置/manifest 不同 | case error，integrity=false |
| `TDB_QUERY_VECTOR_MODEL_MISMATCH` | 模型或端点指纹不同 | case error，integrity=false |
| `TDB_STORE_REBUILD_REQUIRED` | store provenance 不兼容 | coldKB capability=false，Tier4 skip |
| `TDB_INGEST_NOT_READY` | 摄取未完成或超时 | Tier4 skip，不算检索失败 |

`TDBPlaceholderProcessor` 捕获这些错误后必须推送结构化 retrieval error。不得把错误转换成
普通空结果或普通“未找到知识片段”文本。

### 6.4 doctor 冷库检查

`checkColdKB(resolved)` 依次检查：

1. triviumdb 包可加载；
2. knowledge 根存在并至少有一个可索引文件；
3. effective 冷模型、维度与 aligned 热模型、维度一致；
4. embedding 端点对模型返回的实际维度匹配；
5. 当前 store 若存在，其 manifest 与 effective 配置匹配；
6. 严格模式下所有必要 provenance 字段存在。

doctor 返回结构：

```json
{
  "ok": false,
  "level": "warn",
  "reasonCode": "COLD_EMBEDDING_MISMATCH",
  "detail": "query=3072, store=4096",
  "expected": {},
  "actual": {},
  "action": "Tier4 cases will be skipped"
}
```

在 `storePolicy=per-run` 下，独立 doctor 只验证 effective 配置、端点和源语料 fingerprint，
并报告“运行时将创建新 store”；它不把项目根的历史 `VectorStoreTDB` 当作本次 run 的目标。
只有显式选择复用型 store policy 时才检查已有 store manifest。

冷库不可用不阻止 Tier1/Tier2，但 `run --tier 4` 若最终没有任何 scored case，命令必须非零
退出，防止全量 skip 被 CI 视为绿色通过。

---

## 7. 门控配置与缓存设计

### 7.1 有效门控配置

RAGDiaryPlugin 保留现有 `rag_tags.json` 作为生产基础配置，新增可选覆盖路径：

```text
base rag_tags.json
        ↓ merge threshold-only override
RAG_GATE_CONFIG_PATH
        ↓
effective rag config
```

覆盖文件只能修改已存在目标的 `threshold`；tags、description 等影响库向量语义的字段仍由
基础配置提供。评测配置不得创建或修改非 eval 命名空间目标。冷知识库 `tdb_tags.json` 使用
同样的命名空间结构，但阈值放在 artifact 的 `cold` 节点下。

### 7.2 模型相关缓存身份

RAG 库名/增强向量缓存格式升级为：

```json
{
  "schemaVersion": 2,
  "vectorSourceHash": "sha256:library-name-tags-description",
  "gateDefinitionHash": "sha256:vector-source-and-scoring-formula",
  "embedding": {
    "model": "jy-gemini-embedding-001",
    "dimension": 3072,
    "endpointFingerprint": "sha256:..."
  },
  "scoringFormulaVersion": "gate-score-v1",
  "createdAt": "2026-08-01T00:00:00.000Z",
  "vectors": {}
}
```

`vectorSourceHash` 只包含真正影响库名/增强向量的字段，不包含 threshold；单独改阈值不应
重复请求 embedding。`gateDefinitionHash` 在此基础上加入评分公式版本，用于证明两次分数
具有相同定义。threshold 与 calibration artifact 另行组成 `effectiveGateConfigHash`，用于
查询缓存和 run provenance。

任何模型相关字段缺失或不一致都按 cache miss 处理并重建。旧缓存不做原地转换。

`SemanticGroupManager` 的向量文件也必须使用相同 embedding fingerprint 隔离，防止
`::Group` 用例在跨模型 run 中使用另一模型生成的组向量。

### 7.3 查询缓存失效

虽然 eval profile 固定关闭查询缓存，运行时仍需把以下字段纳入查询缓存 key 或在变化时
主动清空：

- effective threshold；
- gate calibration artifact hash；
- embedding fingerprint；
- effective RAG config hash；
- scoring formula version。

阈值热更新后不得重放旧的门控 decision。

---

## 8. 标定数据设计

### 8.1 数据单元

标定数据描述“查询面对某个目标知识库是否应放行”，不是单独一条查询：

```json
{
  "id": "gate_diary_ops_pos_001",
  "targetType": "diary",
  "library": "评测运维技术库",
  "query": "数据库连接池耗尽后应该先检查哪些指标",
  "label": "positive",
  "difficulty": "normal",
  "source": "corpus-derived",
  "sourceRefs": ["评测运维技术库/数据库连接池调优"],
  "intentGroup": "database-pool",
  "split": "calibration",
  "annotation": {
    "status": "verified",
    "reviewCount": 2
  }
}
```

字段约束：

| 字段 | 约束 |
| --- | --- |
| `id` | 全数据集唯一且稳定 |
| `targetType` | `diary` 或 `cold` |
| `library` | 必须对应当前 corpus/knowledge 中存在的目标 |
| `query` | 去首尾空白后非空；不得包含密钥或个人敏感信息 |
| `label` | `positive`、`negative` 或 `ambiguous`；后者不参与拟合 |
| `difficulty` | `easy`、`near-domain`、`hard` |
| `source` | `corpus-derived`、`cross-library`、`mined`、`production-sanitized` |
| `sourceRefs` | 可追溯到语料文档或脱敏来源批次，不存原始隐私数据 |
| `intentGroup` | 同一语义意图及其改写使用同一个 group |
| `split` | `calibration` 或 `holdout` |

### 8.2 标签定义

- `positive`：注入该知识库能够为回答当前查询提供有效证据；
- `negative`：该知识库不应注入，即使查询与库名、标签或描述共享词汇；
- `ambiguous`：是否应注入依赖额外上下文或标注者无法稳定判断。

一个查询可对多个库分别标为 positive。数据模型不假设单标签分类。

### 8.3 数据来源

每个目标库混合四类来源：

1. `corpus-derived positive`：从库内文档生成自然问题，不直接复制标题、Tag 或库名；
2. `cross-library negative`：把其他库的真实主题查询配给当前目标；
3. `mined hard negative`：从模型高分但人工判负的样本中挖掘；
4. `production-sanitized`：可选的脱敏真实查询，主要覆盖口语、省略、错别字和多意图。

LLM 可用于生成候选问题和改写，但标签必须经人工确认。生产查询只有完成脱敏、来源批次
记录和授权检查后才能进入数据集。

### 8.4 数量与分布

决策级首版每个目标库至少包含：

```text
positive: 100
negative: 200
negative difficulty:
  easy        约 1/3
  near-domain 约 1/3
  hard        约 1/3
```

按 `intentGroup` 分组后约 70% 进入 calibration、30% 进入 holdout。同一意图的改写和同一
源文档派生的问题不得跨 split。

开发期可以使用每库 40 positive + 60 negative 验证管线，但产物必须标记
`qualityLevel: development`，不得生成“模型优劣”结论。

数量要求只适用于进入跨模型门控结论的目标库。没有门控用例、没有比较诉求的生产库不要求
为本方案补齐标定数据；它们继续使用生产基础配置，但不会出现在 calibrated compare 中。

### 8.5 标注质量

- 所有 hard negative 和 ambiguous 候选必须双人复核；
- 其他样本至少随机抽查 20%；
- 冲突样本经讨论仍无结论则标记 ambiguous；
- 数据 manifest 记录样本量、标签分布、难度分布、split 规则和标注版本；
- 每次变更数据集后生成新的 dataset hash，不覆盖历史版本。

现有 `t2_gate_*` 用例保留在 holdout 或回归套件中，不进入阈值拟合。

---

## 9. 分数采集与阈值拟合

### 9.1 score-only 接口

新增不执行检索注入、只计算真实门控分数的内部接口：

```text
scoreGate({ targetType, library, query, profile })
  -> { score, scoreComponents, embeddingFingerprint, scoringFormulaVersion }
```

该接口必须复用生产门控计算函数，不得在 eval 中复制一套近似公式。对于当前实现，输出至少
包含：

```json
{
  "score": 0.5261,
  "scoreComponents": {
    "libraryNameCosine": 0.5012,
    "enhancedVectorCosine": 0.5261,
    "aggregation": "max"
  }
}
```

分数采集不依赖当前 threshold，也不通过把 threshold 设置为 0 来旁路门控。

### 9.2 CLI

新增命令：

```bash
node eval/vcp-eval.js gate collect \
  --profile gemini3072 \
  --dataset eval/gate-data/gate-v1.jsonl

node eval/vcp-eval.js gate calibrate \
  --profile gemini3072 \
  --scores eval/gate-scores/gemini3072-gate-v1-calibration.jsonl \
  --target-fpr 0.05

node eval/vcp-eval.js gate validate \
  --profile gemini3072 \
  --calibration eval/gate-calibration/gemini3072.draft.json \
  --scores eval/gate-scores/gemini3072-gate-v1-holdout.jsonl \
  --out eval/gate-calibration/gemini3072.json
```

`collect` 按 split 写出两个独立 score 文件；`calibrate` 的参数类型只接受 calibration
manifest；`validate` 只接受 holdout manifest，并生成新的 finalized artifact，不覆盖 draft，
也不修改已经选定的阈值。

### 9.3 原始分数记录

```json
{
  "datasetId": "gate-v1",
  "datasetHash": "sha256:...",
  "caseId": "gate_diary_ops_neg_hard_001",
  "targetType": "diary",
  "library": "评测运维技术库",
  "label": "negative",
  "split": "holdout",
  "score": 0.5261,
  "profile": "gemini3072",
  "embedding": {
    "model": "jy-gemini-embedding-001",
    "dimension": 3072,
    "endpointFingerprint": "sha256:..."
  },
  "scoringFormulaVersion": "gate-score-v1"
}
```

### 9.4 阈值选择算法

默认策略为“约束误放率后最大化召回”：

1. 针对每个 targetType/library 独立处理；
2. 枚举由 calibration 分数产生的所有候选阈值；
3. 保留 `FPR <= targetFpr` 的阈值，profile 默认 `targetFpr=0.05`；
4. 在可行阈值中依次选择 TPR 更高、balanced accuracy 更高、阈值更高者；
5. 若正负样本量低于决策级要求，产物标记为 development，不允许进入正式 compare；
6. 使用 bootstrap 输出阈值和主要指标的 95% 置信区间；采样次数与随机种子进入 protocol，
   默认种子由 profile hash 与 calibration split hash 派生，保证重复运行可复现。

如果业务未来选择不同的 FPR 目标，只需生成新的 calibration artifact；算法和原始数据无需
改变。`targetFpr` 必须进入 protocol 和 artifact hash。

### 9.5 校准产物

```json
{
  "schemaVersion": 1,
  "status": "validated",
  "calibrationId": "gemini3072-gate-v1-fpr005",
  "qualityLevel": "decision",
  "protocol": {
    "name": "gate-v1",
    "targetFpr": 0.05,
    "algorithm": "max-tpr-under-fpr",
    "scoringFormulaVersion": "gate-score-v1"
  },
  "embedding": {
    "model": "jy-gemini-embedding-001",
    "dimension": 3072,
    "endpointFingerprint": "sha256:..."
  },
  "dataset": {
    "id": "gate-v1",
    "hash": "sha256:...",
    "calibrationSplitHash": "sha256:...",
    "holdoutSplitHash": "sha256:..."
  },
  "gateDefinitionHash": "sha256:...",
  "thresholds": {
    "diary": {
      "评测运维技术库": 0.553,
      "评测幻想设定库": 0.601
    },
    "cold": {}
  },
  "calibrationMetrics": {},
  "holdoutMetrics": {},
  "createdAt": "2026-08-01T00:00:00.000Z"
}
```

artifact 中的模型、数据、gate definition 或 scoring formula 任一不匹配时，doctor 将该
校准标记为不可用。`calibrate` 先生成 `status=draft` 且不含 holdoutMetrics 的产物；
`validate` 固定读取 draft 阈值并生成新的 `status=validated` 产物。profile 的正式 run 只接受
validated artifact，开发调试 profile 可显式允许 development/draft，但报告必须标为
`not_evaluable`。

---

## 10. 运行期门控事件与指标

### 10.1 结构化事件

热库和冷库门控统一推送：

```json
{
  "type": "RAG_GATE_DECISION",
  "targetType": "diary",
  "library": "评测运维技术库",
  "score": 0.5261,
  "threshold": 0.553,
  "decision": "blocked",
  "scoreComponents": {},
  "embeddingFingerprint": "sha256:...",
  "calibrationId": "gemini3072-gate-v1-fpr005",
  "scoringFormulaVersion": "gate-score-v1"
}
```

通过和拦截都必须发事件。评测不再依赖只在“低于阈值”日志中出现的正则解析。

### 10.2 指标结构

```json
{
  "gate": {
    "suite": {
      "total": 5,
      "accuracy": 0.8,
      "purpose": "operational-regression"
    },
    "validation": {
      "operatingPoint": {
        "accuracy": 0.95,
        "balancedAccuracy": 0.94,
        "tpr": 0.92,
        "fpr": 0.04,
        "fnr": 0.08
      },
      "discrimination": {
        "rocAuc": 0.91,
        "prAuc": 0.89,
        "separation": 0.052,
        "standardizedSeparation": 1.18
      }
    },
    "provenance": {
      "calibrationId": "...",
      "datasetHash": "...",
      "scoringFormulaVersion": "gate-score-v1"
    }
  }
}
```

`gate.suite` 来自现有少量 Tier2/Tier4 门控用例，只承担运行链路回归，不作为决策级模型
能力结论。`gate.validation` 来自 finalized calibration artifact 的完整 holdout，是跨模型门控
结论和正式 gate rule 的数据源。这样无需把每库数百条 score-only 样本扩张成完整检索用例。

定义：

```text
separation = mean(positiveScore) - mean(negativeScore)
standardizedSeparation = separation / pooledStandardDeviation
```

所有指标同时按 overall、targetType 和 library 分桶。样本不足时输出 null 和原因，不用 0
代替不可用指标。

---

## 11. compare 与 gate 语义

### 11.1 分轴可比性

`compare()` 输出：

```json
{
  "comparability": {
    "retrieval": {
      "ok": true,
      "reasons": []
    },
    "gateRaw": {
      "ok": false,
      "reasons": ["embedding fingerprint differs"]
    },
    "gateCalibrated": {
      "ok": true,
      "reasons": []
    }
  }
}
```

判定规则：

| 指标轴 | 必须相同的 provenance |
| --- | --- |
| retrieval | corpusHash、suiteHash、指标 schema |
| gateRaw | dataset hash、gate definition hash、scoring formula、embedding fingerprint |
| gateCalibrated | finalized artifact、dataset/holdout hash、protocol、gate definition、scoring formula、qualityLevel=decision；模型可以不同 |
| effect | corpusHash、suiteHash、用例定义和 treatment/control 语义 |

### 11.2 用例分类

每条用例增加 comparison class：

```text
retrieval
gate_raw
gate_calibrated
infrastructure
```

跨模型且 `gateRaw.ok=false` 时，原始门控用例进入 `incomparableCases`，不进入 regressions、
fixes 或 persistentFailures。否则即便跳过了汇总 `gate.accuracy`，逐例 regression 仍会使门禁
错误失败。

### 11.3 默认门禁规则

- 检索类规则保持原方向和阈值；
- `gate.validation.operatingPoint.*` 只在 `gateCalibrated.ok=true` 时参与跨模型门禁；
- `gate.suite.accuracy` 只作为操作回归信号，不作为跨模型能力门禁；
- raw gate accuracy 仅在相同 embedding fingerprint 下比较；
- 不可比规则输出 `pass:null`、`skipped` 和明确原因；
- `不得出现回退用例` 只统计其 comparison class 可比的用例；
- 当所有选定规则都不可判定时，gate 命令非零退出并返回 `abort=true`。

### 11.4 Markdown 报告

报告顶部必须出现“可比性矩阵”，并明确写出：

```text
原始门控余弦：跨模型不可直接比较
校准门控：使用相同 gate-v1 holdout，可比较
检索指标：语料与 suite 相同，可比较
```

不得再以单个总分或通过数概括两个模型。

---

## 12. doctor、run 与状态传播

### 12.1 doctor 新增检查

| 检查名 | 失败级别 | capability 影响 |
| --- | --- | --- |
| `coldEmbeddingAlignment` | warn | `coldKB=false` |
| `coldStoreProvenance` | warn | `coldKB=false` |
| `ragVectorCacheProvenance` | info/warn | 可重建则继续，不可重建则 embedding=false |
| `semanticVectorProvenance` | info/warn | 相关 ::Group 用例 skip |
| `gateCalibration` | warn | 对应 gate target skip |
| `gateDataset` | warn | 正式 calibrated gate 不可用 |

### 12.2 skip 原因码

统一使用稳定原因码：

```text
cold-kb-unavailable
cold-embedding-mismatch
cold-store-rebuild-required
cold-ingest-not-ready
gate-calibration-missing
gate-calibration-stale
gate-dataset-insufficient
model-cache-rebuild-failed
metric-axis-incomparable
```

报告聚合按原因码统计，不依赖中文文本。

### 12.3 run 状态

run manifest 的最终状态支持：

```text
completed
completed_with_skips
not_evaluable
failed
```

若用户显式选择的 tier/family 最终 scored case 为 0，状态必须为 `not_evaluable` 且 CLI 非零
退出。

---

## 13. 实施任务分解

### 阶段 A：配置与 provenance 基础

| 任务 | 修改位置 | 内容 | 完成标志 |
| --- | --- | --- | --- |
| T-001 | `eval/lib/profile.js` | 解析 coldKnowledge 与 gateCalibration；实现 aligned 冲突校验 | resolved/snapshot 包含新字段，冲突有稳定错误码 |
| T-002 | `eval/lib/runstore.js` | 创建 ColdVectorStore/ModelCache；扩展 configHash 与 manifest schema | 两个 profile 的 run 目录完全隔离 |
| T-003 | `eval/lib/cli.js` | 创建 run 后注入全部 per-run 路径；输出 effective cold/gate 配置 | 所有相关模块 require 前 env 已就位 |
| T-004 | profiles | 为 default、gemini3072、qwen8b4096 增加显式 schema | doctor 能打印三者 resolved 配置 |

依赖：无。阶段 A 完成后才能开始后续运行时改造。

### 阶段 B：冷知识库 fail-closed

| 任务 | 修改位置 | 内容 | 完成标志 |
| --- | --- | --- | --- |
| T-005 | `TDBKnowledge.js` | 写入/校验 embedding manifest；增加初始化状态 | provenance 不匹配不开放查询 |
| T-006 | `TDBKnowledge.js` | 增加 query vector 类型、有限数、维度、模型校验 | mismatch 抛稳定错误，不返回 [] |
| T-007 | `Plugin/RAGDiaryPlugin/TDBPlaceholderProcessor.js` | 传 vectorMeta；推送结构化错误/门控事件 | eval 能区分空结果与配置错误 |
| T-008 | `eval/lib/preflight.js` | 扩展 checkColdKB 与端点探针 | doctor 在执行 Tier4 前发现裂脑 |
| T-009 | `eval/lib/runtime.js` | warmup 返回可传播原因码；摄取未就绪不执行用例 | ingest timeout 变为 skip 而非 miss |

依赖：T-001 至 T-003。

### 阶段 C：门控覆盖与模型缓存

| 任务 | 修改位置 | 内容 | 完成标志 |
| --- | --- | --- | --- |
| T-010 | `Plugin/RAGDiaryPlugin/RAGDiaryPlugin.js` | 加载 threshold-only override；统一有效配置哈希 | profile 阈值不修改全局 rag_tags.json |
| T-011 | 同上 | 缓存 schema v2，校验 embedding fingerprint | 跨模型运行不会命中另一模型缓存 |
| T-012 | `Plugin/RAGDiaryPlugin/SemanticGroupManager.js` | 模型相关语义向量目录或 fingerprint | ::Group 不跨模型污染 |
| T-013 | `Plugin/RAGDiaryPlugin/TDBPlaceholderProcessor.js` | 冷门控读取 cold threshold override | diary/cold 阈值命名空间一致 |
| T-014 | `eval/lib/pluginConfig.js` | install 只保证基础 tags/groups；不再写模型特定阈值 | corpus build 与模型标定解耦 |

依赖：阶段 A。

### 阶段 D：标定数据与 CLI

| 任务 | 修改位置 | 内容 | 完成标志 |
| --- | --- | --- | --- |
| T-015 | `eval/gate-data/` | 建立 JSONL schema、manifest 和 gate-v1 数据 | 每库达到 decision 数量且 split 无 intent 泄漏 |
| T-016 | RAG/TDB gate 组件 | 抽取可复用 scoreGate 接口 | collect 与运行期调用同一评分函数 |
| T-017 | `eval/lib/` 新模块 | collect 分 split 输出、calibrate 生成 draft、validate 生成 finalized artifact | 同一输入重复运行得到相同 artifact hash |
| T-018 | `eval/lib/cli.js` | 注册 gate collect/calibrate/validate 命令 | `--json` 输出稳定机器格式 |
| T-019 | `eval/gate-calibration/` | 生成 Gemini/Qwen finalized artifact | doctor 对两个 profile 均校验通过 |

依赖：阶段 C。T-015 可与阶段 B/C 并行准备，但正式分数必须在模型缓存修复后采集。

### 阶段 E：事件、指标与 compare

| 任务 | 修改位置 | 内容 | 完成标志 |
| --- | --- | --- | --- |
| T-020 | RAG/TDB gate 组件 | 推送 RAG_GATE_DECISION | pass/block 均有结构化事件 |
| T-021 | `eval/lib/probes.js`、`runner.js` | 采集事件并写入 raw/per-case | 不再依赖门控日志正则 |
| T-022 | `eval/lib/metrics.js` | 分开计算 suite 回归指标与 validation operating point、AUC、分离度 | 样本不足返回 null+reason |
| T-023 | `eval/lib/compare.js` | 分轴 comparability；隔离 incomparableCases | 跨模型 raw gate 不产生 regression |
| T-024 | `eval/lib/report.js`、`cli.js` | 输出可比性矩阵和 calibration provenance | 报告无法误读 raw cosine delta |

依赖：T-019、T-020。

### 阶段 F：迁移、验证与文档

| 任务 | 修改位置 | 内容 | 完成标志 |
| --- | --- | --- | --- |
| T-025 | eval 测试 | 增加 profile、manifest、dimension mismatch、threshold fitting、comparability 测试 | 全部独立测试通过 |
| T-026 | `eval/README.md` | 更新 profile、Tier4、gate calibration 和 compare 使用说明 | 新用户只读 README 可完成一次可信对比 |
| T-027 | 历史 run loader | 标记 legacy 并禁止新门控判定 | 旧 run 可展示但不会混入正式 gate |
| T-028 | 真实双模型运行 | 重建两个 profile 的热/冷索引并生成报告 | 不再出现基础设施导致的普通失败 |

依赖：阶段 B 至 E。

---

## 14. 验证方案

### 14.1 配置解析测试

| ID | 场景 | 期望 |
| --- | --- | --- |
| VT-001 | Gemini profile + 根 config.env 的 Qwen TDB 配置 | resolved 冷模型/维度仍为 Gemini/3072 |
| VT-002 | aligned profile.env 显式写 Qwen TDB 模型 | 抛 `PROFILE_COLD_EMBEDDING_CONFLICT` |
| VT-003 | calibration artifact 模型与 profile 不同 | doctor `gate-calibration-stale` |
| VT-004 | 旧 cache 无 embedding metadata | cache miss 并重建，不加载 vectors |

### 14.2 冷知识库测试

| ID | 场景 | 期望 |
| --- | --- | --- |
| VT-005 | 4096 manager 收到 3072 queryVector | 抛 `TDB_QUERY_VECTOR_DIMENSION_MISMATCH` |
| VT-006 | 同为 3072 但 model fingerprint 不同 | 抛 `TDB_QUERY_VECTOR_MODEL_MISMATCH` |
| VT-007 | store manifest 与 profile 匹配 | 初始化 compatible，Tier4 可运行 |
| VT-008 | store 有数据但 manifest 缺失 | eval 状态 legacy_unknown，Tier4 skip |
| VT-009 | 摄取超时 | `cold-ingest-not-ready`，不计 minResults 失败 |

### 14.3 标定算法测试

| ID | 场景 | 期望 |
| --- | --- | --- |
| VT-010 | 人工可完全分离的正负分数 | 找到 FPR=0、TPR=1 的阈值 |
| VT-011 | 所有分数相同 | 输出低分离度与置信区间，不伪造高准确率 |
| VT-012 | 数据量低于 decision 门槛 | qualityLevel=development |
| VT-013 | holdout 样本被传入 calibrate | 命令拒绝读取该 split |
| VT-014 | 样本改写跨 split 但 intentGroup 相同 | dataset verify 失败 |

### 14.4 compare 测试

| ID | 场景 | 期望 |
| --- | --- | --- |
| VT-015 | 同 corpus/suite、不同 embedding | retrieval 可比，gateRaw 不可比 |
| VT-016 | 不同 embedding、同 decision 级 protocol/holdout | gateCalibrated 可比 |
| VT-017 | 不同 holdout hash | gateCalibrated 不可比 |
| VT-018 | raw gate 用例一边通过一边失败 | 进入 incomparableCases，不进入 regressions |
| VT-019 | 所有规则不可比 | gate abort=true，CLI 非零退出 |

### 14.5 端到端验收

| ID | 验收标准 |
| --- | --- |
| AC-001 | `doctor --profile gemini3072` 明确输出热/冷模型均为 Gemini 3072，或将 coldKB 标为不可用并给出原因码 |
| AC-002 | Gemini Tier4 不再因 3072 查询向量打 4096 索引而产生普通 0 结果 |
| AC-003 | Gemini 与 Qwen 的 ColdVectorStore、RAG cache、semantic vectors 路径互不相同 |
| AC-004 | 任意 query/store 维度或模型 mismatch 都产生结构化错误，`integrity.clean=false` |
| AC-005 | 两个 profile 均生成绑定 model/dataset/protocol 的 calibration artifact |
| AC-006 | calibration 数据与 holdout 按 intentGroup 无交叉，现有最终 gate 用例未用于拟合 |
| AC-007 | compare 明确标记 raw gate 跨模型不可比，且不把相关用例列为 regression |
| AC-008 | 报告同时给出 ROC-AUC、PR-AUC、分离度、FPR、FNR 和 calibration provenance |
| AC-009 | 旧 run 被标为 legacy，无法触发新格式门控通过结论 |
| AC-010 | 双模型重跑后，所有基础设施/校准问题表现为预检失败、skip 或显式 error，不混入模型质量失败 |

---

## 15. 迁移与回滚

### 15.1 迁移步骤

1. 合入 profile/runstore schema，但暂不启用严格门禁；
2. 合入冷库 manifest 与查询向量硬校验；
3. 合入模型相关 cache schema，新版本首次运行自动 cache miss 重建；
4. 建立 gate-v1 数据，完成标注与 split 校验；
5. 为 Gemini/Qwen 重新采集分数并生成 calibration artifact；
6. 启用 strict provenance 和分轴 compare；
7. 用全新 run 目录执行双模型评测；
8. 验收后把旧 run 标为 legacy，只保留历史查看能力。

### 15.2 生产索引处理

生产 `VectorStoreTDB` 不由 eval 自动删除。首次检测到 legacy_unknown 或 mismatch 时：

- 停止开放该冷库查询；
- 输出 store 路径、当前/期望 fingerprint 和 rebuild 指令；
- 由操作者备份后显式重建；
- 重建成功后原子切换目录；
- 旧目录保留到验证窗口结束，再由操作者决定清理。

### 15.3 回滚

- profile/runstore 变更可通过关闭 `EVAL_STRICT_PROVENANCE` 临时回退，但正式报告必须标记
  `not_evaluable`；
- cache schema 回滚只影响性能，旧版本无法理解新 cache 时应自行重建；
- calibration artifact 是新增只读资产，回滚代码不会修改它；
- compare 回滚后不得对新旧两种门控 schema 混合执行门禁；
- 任何回滚都不删除已有 run 产物。

---

## 16. 可观测性、隐私与成本

### 16.1 必须记录的日志与指标

- resolved 热/冷 embedding model、dimension 和脱敏 endpoint fingerprint；
- cold store state、manifest hash、待摄取数量和 warmup 耗时；
- model cache hit/miss 及 miss 原因；
- gate calibrationId、dataset hash 和 scoring formula version；
- 每个目标的 score 分布摘要、TPR/FPR/FNR；
- skip/error reason code 计数；
- embedding 请求数、耗时和重试数。

日志不得输出 API key、原始生产敏感查询或完整用户身份信息。

### 16.2 成本控制

- 冷库 per-run 重建会产生大量 embedding 调用，只有包含 Tier4 时才创建和摄取；
- 标定分数按 dataset/profile hash 缓存，数据和模型不变时无需重复调用端点；
- score collection 与正式 run 串行执行，继续复用全局 run lock；
- bootstrap 只使用已落盘分数，不重复请求 embedding；
- report 必须列出本次 embedding 调用量和冷库重建耗时，便于评估运行成本。

---

## 17. 风险登记

| ID | 风险 | 可能性 | 影响 | 缓解措施 | 发现信号 |
| --- | --- | --- | --- | --- | --- |
| R-001 | 标定数据过少导致阈值过拟合 | 中 | 高 | decision 数量门槛、intent 分组切分、bootstrap CI | 阈值 CI 宽、holdout 指标骤降 |
| R-002 | LLM 生成问题复制标题/标签，形成虚假易题 | 高 | 中 | 人工审核、词面重叠检查、sourceRef 追踪 | calibration 近满分但生产误放高 |
| R-003 | 模型缓存仍有遗漏路径 | 中 | 高 | run 级目录隔离、统一 embedding fingerprint helper | 不同 profile 出现相同向量文件哈希 |
| R-004 | 冷库重建时间和 API 成本过高 | 高 | 中 | 仅 Tier4 重建、分数缓存、成本报告 | warmup 超时、调用量异常 |
| R-005 | 同维度不同模型绕过纯长度检查 | 中 | 高 | vectorMeta + store manifest 同时校验模型/端点 | model mismatch reason code |
| R-006 | compare 跳过汇总指标但逐例仍报 regression | 高 | 高 | comparison class 与 incomparableCases | raw gate 用例仍出现在 regressions |
| R-007 | 生产查询进入数据集造成隐私泄露 | 低至中 | 高 | 脱敏、授权、批次追踪、禁止原始身份字段 | dataset verify 敏感模式命中 |
| R-008 | 阈值热更新重放旧查询缓存 | 中 | 中 | calibration/config hash 进入 cache key并清空旧缓存 | decision threshold 与 artifact 不一致 |
| R-009 | 旧 run 被误当成新 schema | 中 | 高 | manifest schemaVersion、legacy 强制标记 | 缺 provenance 却出现 calibrated delta |

---

## 18. 交付物与完成定义

最终交付物包括：

1. profile/cold/gate 配置 schema 与 resolved snapshot；
2. run 级 ColdVectorStore 和 ModelCache；
3. TDB store embedding manifest 与 fail-closed 查询契约；
4. profile 级 diary/cold gate calibration artifact；
5. gate-v1 数据集、manifest、标注说明和 split 校验；
6. gate collect/calibrate/validate CLI；
7. 结构化 RAG_GATE_DECISION 事件；
8. 新门控指标与分轴 compare/report；
9. legacy run 兼容策略；
10. 独立验证脚本、更新后的 eval README 和一份 Gemini/Qwen 双模型报告。

只有满足全部 `AC-001` 至 `AC-010`，并且新双模型报告不含未归因的静默降级，方案才算完成。
