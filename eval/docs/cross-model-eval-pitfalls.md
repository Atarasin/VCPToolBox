# 跨模型评测的两个陷阱

> 来源：2026-08-01 用 `gemini3072`（jy-gemini-embedding-001 @ 3072）与 `qwen8b4096`
> （Qwen/Qwen3-Embedding-8B @ 4096）跑同一套 96 条用例的对比。
> gemini 臂 86/96、qwen 臂 96/96 —— 10 条失败**没有一条**源自"3072 维检索能力更弱"。
> 拆开看是两个与模型能力无关（或只是部分相关）的陷阱。本文记录根因、证据与修复方向。

相关：[../README.md](../README.md) ｜ 复现所用的两个 profile 在 `eval/profiles/`

---

## 摘要

| 簇 | 用例数 | 表面现象 | 真实根因 | 是否模型能力差异 |
| --- | --- | --- | --- | --- |
| A | 7（全部 `t4_*`） | 冷知识库检索恒返回 0 条 | 热/冷两条链路的 embedding 配置**裂脑**，3072 维查询向量打 4096 维存储 | ❌ 完全无关 |
| B | 3（门控拦截） | 该拦的没拦住 | 阈值按 Qwen 的余弦尺度标定，gemini 余弦整体高 ~0.12 | ⚠️ 主因是标定；次因是真实的分离度差异 |

**刨掉这 10 条后，gemini 的纯检索指标并不差、局部更好**：
precision@1 59.0% vs 51.3%，噪声率@5 **14.3% vs 42.9%**，recall@5 打平。
所以"gemini 86/96 < qwen 96/96"这个结论如果不拆开看，是会误导决策的。

---

## 簇 A：冷知识库配置裂脑（7 条）

### 现象

`t4_coldkb_basic` / `_k` / `_k_float_ignored` / `_aggregate` / `_rerank` / `_lightmemo`
全部 `minResults: 期望 ≥1，实际 0`；`t4_coldkb_gate_pass` 因输出为空被判 `blocked`。
运行日志里**没有任何错误**——TDB 正常初始化、255 个文件正常入库。

### 根因链（每一步均已实测复现）

1. **冷知识库的模型/维度被 `config.env` 钉死**，且优先级高于 profile：

   ```
   config.env:383  TDB_KNOWLEDGE_DIMENSION=4096
   config.env:386  TDB_KNOWLEDGE_MODEL=Qwen/Qwen3-Embedding-8B
   ```

   `TDBKnowledge.js:57` 的取值顺序是
   `config.dimension || TDB_KNOWLEDGE_DIMENSION || VECTORDB_DIMENSION || 3072` ——
   `TDB_KNOWLEDGE_DIMENSION` **压过** profile 设置的 `VECTORDB_DIMENSION`。

   实测：
   ```bash
   $ VECTORDB_DIMENSION=3072 node -e "console.log(require('./TDBKnowledge').config.dimension)"
   4096          # profile 说 3072，冷知识库仍然是 4096
   ```

   （`TDBKnowledge` 的 require 链里 `TextChunker.js:2` 会 `dotenv.config({path:'./config.env'})`，
   所以即便运行时 env 只传 3072，config.env 的 `TDB_KNOWLEDGE_*` 依然会被读进来。）

2. **占位符链路复用热路径的查询向量**。为省一次嵌入，
   `TDBPlaceholderProcessor.js:307` 调的是 `searchWithVector(queryVector, …)` 而不是
   `TDBKnowledge.search()`——传进去的是 RAGDiaryPlugin 已经算好的向量，
   在 gemini run 里那是 **3072 维**。

3. **维度不符 → 静默返回空数组**。`searchWithVector` 的首行守卫是
   `if (!this.initialized || !TriviumDB || !queryVector) return [];`，
   下游 `TDBPlaceholderProcessor.js:316` 又是 `if (!hits || hits.length === 0) return [];`
   ——两层都不报错、不告警，最终表现为"检索不到"。

### 结论

热路径跟随 profile 的模型、冷路径被 config.env 钉死，**两者共享的那个查询向量在中间断裂**。
换成任何非 4096 维的模型都会这样失败，与 gemini 本身的检索质量无关。

### 修复方向

1. **doctor 增加"冷知识库模型一致性"检查**（推荐）：profile 的 model/dimension 与
   `TDB_KNOWLEDGE_MODEL`/`TDB_KNOWLEDGE_DIMENSION` 不一致时，把 tier4 标记
   **SKIP** 而非放它跑出误导性失败。这与本套件既有的
   「依赖缺失 ≠ 通过」原则一致（见 README 第 7 节）。
2. 让 profile 能显式覆盖 `TDB_KNOWLEDGE_*`，并在切换时**用新模型重建 `.tdb` 存储**
   （冷库是按维度绑定的，不重建就只能 SKIP）。
3. 更根本的修法在 VCP 侧：`searchWithVector` 应当校验
   `queryVector.length === this.config.dimension`，不符时抛错或记警告，
   而不是静默返回 `[]`。

---

## 簇 B：门控阈值的跨模型标定问题（3 条）

### 现象

`t2_gate_fulltext_block` / `_block_distractor` / `t2_gate_hybrid_block`
—— 三条"应当被拦截"的用例在 gemini 臂全部放行。

### 证据一：同样的查询，两个模型的门控相似度

`<<>>` / `《《》》` 的门控算的是 `max(cos(查询, 日记本名向量), cos(查询, 增强向量))`。

| 查询（**应被拦截**） | 目标库(阈值) | gemini | Qwen |
| --- | --- | --- | --- |
| 小说查询打技术库 | 技术库(0.44) | **0.5261 放行 ✘** | 0.3866 拦截 ✔ |
| 历法查询打技术库 | 技术库(0.44) | **0.4895 放行 ✘** | 0.3571 拦截 ✔ |
| 技术查询打幻想库 | 幻想库(0.50) | **0.5627 放行 ✘** | 0.4317 拦截 ✔ |
| *（对照，应放行）* | 技术库(0.44) | 0.5758 ✔ | 0.4911 ✔ |
| *（对照，应放行）* | 幻想库(0.50) | 0.6484 ✔ | 0.5690 ✔ |

### 证据二：余弦尺度整体偏移

取 6 句**彼此无关**的句子两两算余弦，衡量各模型的"基线余弦"：

| 模型 | 无关句对余弦 均值 | 最小 | 最大 |
| --- | --- | --- | --- |
| jy-gemini-embedding-001 | **0.5295** | 0.4901 | 0.5892 |
| Qwen/Qwen3-Embedding-8B | **0.4091** | 0.2536 | 0.5903 |

**gemini 连完全无关的句子都有 0.53 的余弦，已经高于 0.44/0.50 两条阈值。**
阈值是按 Qwen 的尺度标定的，直接套到 gemini 上，负样本必然全部越线。

### 拆解：多少是标定、多少是真实差异

- **主因（标定）**：整体偏移 ~0.12。给 gemini 单独标定（约 0.55 / 0.60）这三条即可拦住。
- **次因（真实能力差异）**：gemini 的正负样本**分离度**只有 ~0.05
  （0.5758 vs 0.5261），约为 Qwen 的一半（0.4911 vs 0.3866 ≈ 0.10）。
  也就是说在门控判别这个任务上 gemini **确实更弱**——弱在"分离窄"，而不是"分不开"。
  即便重新标定，它的阈值容错空间也更小。

### 结论

「门控准确率 60% vs 100%」这个数字**大部分是标定偏差，不能直接当作模型优劣的证据**。
余弦绝对值在跨模型比较中没有可比性，只有**分离度**才有。

### 修复方向

1. **阈值支持按 profile 覆盖**：`rag_tags.json` 的 threshold 目前是全局的
   （由 `corpus build` 从 `corpus-spec/books.json` 装入）。跨模型评测时应允许
   profile 提供自己的一套阈值，各自标定后再比。
2. **compare 报告标注不可比**：两次 run 的 embedding 模型不同时，
   把 `gate.accuracy` 显式标为"跨模型不可直接比较"，避免读者误读。
3. **补一个尺度无关的门控指标**：例如"正负样本相似度分离度"或按分位数标定后的
   准确率——这类指标跨模型才有意义。

---

## 给后续跨模型评测的检查清单

1. **先跑 `doctor --profile <名称>`**，确认 embedding 端点与维度真实匹配
   （doctor 会真发探针请求核对）。
2. **确认冷知识库配置是否跟随 profile**——不跟随就应当 SKIP tier4，而不是让它失败。
3. **门控/阈值类指标跨模型不可直接比**。先看各模型的基线余弦（无关句对均值），
   再决定阈值是否需要重新标定。
4. **失败要先分簇再下结论**。本次 10 条失败若不拆开，会得出"3072 维不如 4096 维"
   的错误结论——而实际上刨掉基建与标定问题后，gemini 的噪声率还明显更低
   （14.3% vs 42.9%）。
5. **看效应而非绝对值**。本套件的 `effect.*` 指标（金标排名位移、Top-K 重合、
   Kendall τ）是同臂内比较，不受跨模型尺度差影响，比 recall/nDCG 绝对值更可靠。
