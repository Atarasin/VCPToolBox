# VCP 日记四种调用模式与 `::Time/::Group/::Rerank/::TagMemo/::AIMemo` 联合使用说明（基于当前代码）

本文基于当前仓库代码实现，不依赖旧版口径。重点解释四种调用模式：

- `{{角色日记本}}`
- `[[角色日记本]]`
- `<<角色日记本>>`
- `《《角色日记本》》`

以及与 `::Time/::Group/::Rerank/::TagMemo/::AIMemo` 的组合关系。

---

## 1. 总体执行入口与解析顺序

### 1.1 插件入口

- 插件类型：`hybridservice`
- 主入口：`Plugin/RAGDiaryPlugin/RAGDiaryPlugin.js`
- 消息预处理入口：`processMessages(messages, pluginConfig)`

代码依据：
- `Plugin/RAGDiaryPlugin/plugin-manifest.json`（`pluginType: hybridservice`）
- `Plugin/RAGDiaryPlugin/RAGDiaryPlugin.js` 第 856 行附近（`processMessages`）

### 1.2 只处理 system 消息中的占位符

`processMessages` 会扫描所有 `role === "system"` 的消息，识别并处理：

- `[[...日记本...]]`
- `<<...日记本>>`
- `《《...日记本...》》`
- `{{...日记本}}`
- `[[VCP元思考...]]`
- `[[AIMemo=True]]`

代码依据：
- `RAGDiaryPlugin.js` 第 862-878 行附近（system 消息筛选 + 正则判定）
- `RAGDiaryPlugin.js` 第 1046-1050 行（五类日记占位符正则）

### 1.3 当前版本的一个关键事实

`modules/messageProcessor.js` 中“日记本处理”已经标注迁移到 `RAGDiaryPlugin`：

- 注释显示：`// --- 日记本处理 (迁移到 RAGDiaryPlugin) --- // (逻辑已移除)`

这意味着当前代码语义下，四种日记占位符由 `RAGDiaryPlugin` 统一处理。

代码依据：
- `modules/messageProcessor.js` 第 362-366 行附近

---

## 2. 四种调用模式：行为对照表

| 语法 | 触发逻辑 | 是否先做阈值门控 | 注入内容 |
|---|---|---|---|
| `{{角色日记本}}` | 直接读取日记本目录文本 | 否 | 全文 |
| `[[角色日记本...]]` | 直接 RAG 检索 | 否 | 片段（Top-K） |
| `<<角色日记本>>` | 先计算相似度再决策 | 是 | 达标后全文 |
| `《《角色日记本...》》` | 先计算相似度再决策 | 是 | 达标后片段（RAG）或 AIMemo |

代码依据：
- `RAGDiaryPlugin.js` 第 1215-1285 行（`<<>>`）
- `RAGDiaryPlugin.js` 第 1494-1532 行（`{{}}`）
- `RAGDiaryPlugin.js` 第 1130-1213 行（`[[]]`）
- `RAGDiaryPlugin.js` 第 1287-1443 行（`《《》》`）

---

## 3. 五个 `::` 修饰符的真实生效方式

在 `_processRAGPlaceholder` 中会解析：

- `::Time`：时间路 + 语义路平衡检索
- `::Group`：语义组增强向量
- `::Rerank`：先多召回再重排
- `::TagMemo` 或 `::TagMemo0.25`：启用 TagMemo 增强
- `::AIMemo`：不走这里的标准 RAG，由上层逻辑改走 `AIMemoHandler`

代码依据：
- `RAGDiaryPlugin.js` 第 1888-1896 行（Time/Group/Rerank/TagMemo 解析）
- `RAGDiaryPlugin.js` 第 1187-1193、1405-1413 行（AIMemo 接管逻辑）
- `RAGDiaryPlugin.js` 第 1445-1492 行（AIMemo 聚合处理）

---

## 4. 你关心的四个问题（逐条回答）

## 4.1 日记本中的 tag 在什么情况下会比较相似性来检索？

先区分两类“Tag”：

1) **日记文件内 `Tag:` 行标签**（内容标签）  
2) **`rag_tags.json` 给“日记本”配置的主题标签**（日记本级主题标签）

它们作用不同：

### A. 日记文件内 `Tag:` 的作用

- 入库时会从文本中抽取 `Tag:`，写入 `tags` 与 `file_tags` 表，并维护 `tagIndex`
- 检索时**只有启用 `::TagMemo`**（或 `::TagMemo权重`）才会显著参与“标签相似性增强”
- 启用后通过 `applyTagBoostV3` 对查询向量做标签增强，再进向量检索

代码依据：
- `KnowledgeBaseManager.js` 第 1276-1300 行（`_extractTags`）
- `KnowledgeBaseManager.js` 第 1013-1018、1035、1138-1141 行（文件标签入库与关联）
- `RAGDiaryPlugin.js` 第 1893-1896 行（TagMemo 开关/权重）
- `RAGDiaryPlugin.js` 第 1934-1947 行（调用 `applyTagBoost` 感应核心 tag）
- `KnowledgeBaseManager.js` 第 315-346、443-743 行（TagBoost 在检索中的应用）

### B. `rag_tags.json` 里的“预设标签”作用

- 主要用于 `<<>>`/`《《》》` 的阈值门控相似度增强
- 插件会把“日记本名 + 配置标签（按权重重复）”拼成文本，向量化后缓存到 `enhancedVectorCache`
- 门控相似度取 `max(名字向量相似度, 增强向量相似度)`

代码依据：
- `RAGDiaryPlugin.js` 第 212-262 行（构建增强向量缓存）
- `RAGDiaryPlugin.js` 第 1243-1257、1390-1403 行（门控相似度计算）

---

## 4.2 `{{角色日记本}}` 全文注入是否注入所有文件？

结论：**不是“全仓所有文件”，而是该角色日记目录下的 `.txt/.md` 文件（当前层级）**。

细节：

- 目录：`KNOWLEDGEBASE_ROOT_PATH/<角色名>`（默认是项目 `dailynote/<角色名>`）
- 只读后缀为 `.txt` / `.md` 的文件
- 文件名排序后全部读取，按 `\n\n---\n\n` 拼接
- 当前实现不是递归读取子目录

补充说明（命名与语法关系）：

- 占位符中的“日记本”是语法标记，不是实际目录名后缀
- 解析时会把 `{{novelA.core.rules日记本}}` 中的 `novelA.core.rules` 作为 `dbName`
- 实际读取路径是 `dailynote/<dbName>`，例如 `dailynote/novelA.core.rules`
- 如果写成 `{{novelA.core.rules}}`（不带“日记本”），按当前正则不会命中日记占位符

代码依据：
- `RAGDiaryPlugin.js` 第 24-27 行（日记根目录计算）
- `RAGDiaryPlugin.js` 第 391-420 行（`getDiaryContent` 全文读取逻辑）
- `RAGDiaryPlugin.js` 第 1056-1060 行（`[[]]`/`<<>>`/`《《》》`/`{{}}` 对 `日记本` 后缀的解析正则）

---

## 4.3 `<<角色日记本>>` 如何计算“对话上下文 vs 日记本主题”相似度？“预设标签”是什么？

计算流程：

1. 先取最近用户消息 + 最近 AI 消息，清洗 HTML/emoji/工具噪声后组合成文本  
2. 对组合文本向量化得到 `queryVector`  
3. 取日记本“名字向量” `dbNameVector`（由 `getDiaryNameVector` 获取/缓存）  
4. 取日记本“增强主题向量” `enhancedVector`（来源 `rag_tags.json`）  
5. 计算：
   - `baseSimilarity = cosine(queryVector, dbNameVector)`
   - `enhancedSimilarity = cosine(queryVector, enhancedVector)`
   - `finalSimilarity = max(baseSimilarity, enhancedSimilarity)`
6. 与阈值比较：
   - 本库阈值：`ragConfig[dbName].threshold`
   - 否则全局默认 `0.6`
7. 达标才注入全文，不达标返回空串

代码依据：
- `RAGDiaryPlugin.js` 第 941-949 行（上下文组合与向量化）
- `RAGDiaryPlugin.js` 第 1243-1259 行（`<<>>` 单库阈值判断）
- `RAGDiaryPlugin.js` 第 28 行（全局阈值 0.6）
- `KnowledgeBaseManager.js` 第 779-835 行（`getDiaryNameVector`）
- `RAGDiaryPlugin.js` 第 212-262 行（增强向量缓存）

### “预设标签”定义

“预设标签”指的是 `rag_tags.json` 某个日记本配置中的 `tags` 字段，例如：

- `"tags": ["VCP:2", "RAG", "向量检索:1.5"]`

这些标签不是从当前查询临时抽取，而是日记本管理员预先配置的“主题锚点”。

---

## 4.4 `[[角色日记本]]` 是按什么检索？与全文注入区别是什么？

`[[...]]` 是**直接片段检索（RAG）**，不会先做阈值门控。

检索基础：

- 查询向量：由“最近用户+最近 AI”上下文向量化得到
- 检索目标：对应日记本向量索引中的 chunk
- 返回形式：Top-K 片段文本，包装成 `VCP_RAG_BLOCK`

可叠加能力：

- `::Time`：时间路 + 语义路平衡召回
- `::Group`：语义组增强向量
- `::Rerank`：重排
- `::TagMemo`：标签增强（需 tag 体系质量）
- `::AIMemo`：被接管为 AI 推理召回（需 `[[AIMemo=True]]` 许可证）

代码依据：
- `RAGDiaryPlugin.js` 第 1195-1205 行（`[[]]` 走 `_processRAGPlaceholder`）
- `RAGDiaryPlugin.js` 第 1840-2174 行（RAG 主逻辑）
- `RAGDiaryPlugin.js` 第 2274-2285 行（标准片段格式化输出）
- `RAGDiaryPlugin.js` 第 1044 行、871 行（AIMemo 许可证机制）

与全文注入区别（最本质）：

- 全文注入（`{{}}` / 达标后的 `<<>>`）是“把整本内容喂进去”
- `[[ ]]` 是“按语义取最相关片段再注入”

---

## 5. 联合使用实战：推荐写法与语义

## 5.1 常用组合

1) `[[项目复盘日记本::Time::Rerank]]`  
时间范围回忆 + 精排，适合“某段时期的关键结论”。

2) `[[研发日志日记本::TagMemo0.25::Rerank]]`  
标签增强 + 精排，适合主题明确、语料多的技术库。

3) `《《产品|运营日记本:1.2::Group::TagMemo::Rerank》》`  
多库聚合 + 阈值门控 + 语义组 + 标签增强 + 精排。

4) `《《全年总结日记本::AIMemo》》` + `[[AIMemo=True]]`  
通过阈值后转 AI 推理式聚合总结。

## 5.2 组合注意点

- `::AIMemo` 在 `[[...]]` 中会覆盖常规 RAG 路径（有许可证时）
- `::AIMemo` 在 `《《...》》` 中是“先过阈值，再走 AIMemo”
- 未达阈值时，`《《...::AIMemo》》` 不会触发 AIMemo

代码依据：
- `RAGDiaryPlugin.js` 第 1187-1193 行（`[[ ]]` 中 AIMemo 覆盖）
- `RAGDiaryPlugin.js` 第 1404-1413、1430-1434 行（`《《》》` 中 AIMemo 门控）

---

## 6. 快速结论（可直接记）

1. **tag 何时做相似性检索？**  
   - `::TagMemo` 时，日记内容标签体系会介入查询向量增强。  
   - `<<>>/《《》》` 门控时，`rag_tags` 的预设标签用于增强“日记本主题向量”。

2. **`{{角色日记本}}` 是不是注入所有文件？**  
   - 仅该角色目录下 `.txt/.md` 文件（当前层级），不是全仓所有文件。

3. **`<<角色日记本>>` 相似度怎么算？预设标签是什么？**  
   - `max(查询 vs 名字向量, 查询 vs 预设标签增强向量)`，与阈值比较。  
   - 预设标签就是 `rag_tags.json` 里该日记本配置的 `tags`。

4. **`[[角色日记本]]` 按什么检索？与全文注入差异？**  
   - 按上下文向量直接检索 chunk，返回 Top-K 片段。  
   - 与全文注入相比，它是“片段增强”而非“整库注入”。
