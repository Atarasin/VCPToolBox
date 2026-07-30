# VCP 原生记忆能力地图

> 范围说明：本文只识别 **VCP 自身原生提供** 的记忆能力，**不包含 `agent-gateway`**。  
> 判定原则：**以当前代码实现为准，文档只作辅助佐证。**

## 1. 总览

当前 VCP 原生记忆系统不是单一模块，而是几层能力协同：

1. **长期记忆存储层**：`DailyNote` / `dailynote/`
2. **知识库与索引层**：`KnowledgeBaseManager`
3. **对话注入与召回层**：`RAGDiaryPlugin`
4. **轻量检索与工具直调层**：`LightMemo`、`DailyNoteSearcher`
5. **记忆整理与联想管理层**：`DailyNoteManager`
6. **工作记忆 / 上下文折叠层**：`FoldingStore`
7. **高阶增强层**：`TagMemo`、`RiverMemo`、`AIMemo`、`元思考链`

可以先把它理解成一张简图：

```text
AI/工具调用
   |
   +--> DailyNote ---------------------------> dailynote/*.txt|md
   |                                               |
   |                                               v
   |                                      KnowledgeBaseManager
   |                                (SQLite + diary index + tag index)
   |                                               |
   |                      +------------------------+----------------------+
   |                      |                        |                      |
   |                      v                        v                      v
   |                 RAGDiaryPlugin            LightMemo           DailyNoteManager
   |           (占位符注入/全文/聚合/AIMemo)   (工具检索/A/B)     (list/organize/associate)
   |                      |
   |                      v
   |              TagMemo / RiverMemo / Time / Group / RoleValve
   |
   +--> FoldingStore
       (上下文折叠用的工作记忆，不写入长期日记本)
```

## 2. 能力地图

| 能力层 | 具体能力 | 当前实现入口 | 是否属于长期记忆 | 说明 |
| --- | --- | --- | --- | --- |
| 存储层 | 日记写入 | `Plugin/DailyNote/dailynote.js` | 是 | 创建/更新日记，写入 `dailynote/`，并交给知识库后台索引 |
| 存储层 | AI 响应自动落记忆 | `server.js` | 是 | AI 输出 `<<<DailyNoteStart>>>...<<<DailyNoteEnd>>>` 后自动调用 `DailyNoteWrite` |
| 索引层 | 日记本独立向量索引 | `KnowledgeBaseManager.js` | 是 | 每个日记本独立索引，避免跨日记本干扰 |
| 索引层 | 全局 Tag 索引 | `KnowledgeBaseManager.js` | 是 | 支撑 TagMemo / Tag 检索增强 |
| 索引层 | 文件监听与增量摄取 | `KnowledgeBaseManager.js` | 是 | 日记文件变化后自动进入后台索引更新 |
| 召回层 | 日记本占位符注入 | `Plugin/RAGDiaryPlugin/RAGDiaryPlugin.js` | 是 | 通过 `[[...日记本...]]` / `<<...>>` / `《《...》》` / `{{...}}` 触发 |
| 召回层 | 直接文本读取 | `Plugin/RAGDiaryPlugin/DirectDiaryTextProcessor.js` | 是 | `{{...}}` 与 `<<...>>` 会走纯文本链路，避免每次都进向量管线 |
| 召回层 | 语义向量检索 | `KnowledgeBaseManager.search()` | 是 | RAGDiary 与 LightMemo 的主检索底座 |
| 召回层 | 全文/BM25 检索 | `DailyNoteSearcher`、`DirectDiaryTextProcessor` | 是 | 支持正文与 Tag 行 BM25 召回 |
| 增强层 | TagMemo 增强 | `KnowledgeBaseManager.applyTagBoostAsync()` | 是 | 当前生产线的核心记忆增强能力之一 |
| 增强层 | RiverMemo 重排 | `KnowledgeBaseManager.rerankWithRiverMemoAsync()` | 是 | 连续记忆拓扑重排，作为高阶排序内核存在 |
| 增强层 | Time 时间约束召回 | `RAGDiaryPlugin` + `TimeExpressionParser` | 是 | 根据用户输入时间范围过滤或补强记忆 |
| 增强层 | Group 语义组增强 | `SemanticGroupManager.js` | 是 | 对查询向量做语义组增强 |
| 增强层 | RoleValve 门控 | `RAGDiaryPlugin` | 是 | 按当前消息上下文决定某条记忆是否允许注入 |
| 增强层 | Base64Memo 多模态记忆 | `RAGDiaryPlugin` | 是 | 将命中的日记附件转为 base64 注入到首条用户消息 |
| 高阶总结层 | AIMemo / AIMemo+ | `AIMemoHandler.js` | 否（本身） | 基于已召回内容再做 AI 总结，属于“记忆提炼/摘要”，不是新的底层存储 |
| 管理层 | 日记列出 | `DailyNoteManager` | 是 | 按文件夹和日期范围读取日记 |
| 管理层 | 日记整理归档 | `DailyNoteManager` | 是 | 合并多篇日记，生成新日记并归档旧文件 |
| 管理层 | 联想关联发现 | `DailyNoteManager` + `associativeDiscovery` | 是 | 从一篇或多篇日记出发找关联记忆 |
| 工具层 | 轻量检索工具 | `Plugin/LightMemo/LightMemo.js` | 是 | 面向工具调用的轻量回忆入口，支持多内核 |
| 工具层 | 文本/正则/BM25 搜索器 | `Plugin/DailyNoteSearcher` | 是 | Rust 搜索器，供日记/知识库纯文本检索使用 |
| 工作记忆层 | FoldingStore 折叠记忆 | `Plugin/RAGDiaryPlugin/FoldingStore.js` | 否 | 保存上下文向量与摘要状态，用于折叠，不落到长期日记本 |
| 反思层 | 元思考链 | `MetaThinkingManager.js` | 间接 | 在多个“思维簇”之间递归检索，属于基于记忆库的反思型召回 |

## 3. 按系统分组理解

### 3.1 长期记忆写入

#### A. `DailyNote`：长期记忆主写入口

这是 VCP 原生长期记忆的主入口。

- 支持 `create` / `update`
- 写入目标是 `dailynote/<文件夹>/日期-时间.txt|md`
- 写入前有路径安全校验、文件名冲突处理、忽略目录限制
- 写入后通过 `KnowledgeBaseManager.runExternalFileMutation(...)` 把索引更新挂到后台队列

对应代码：

- `Plugin/DailyNote/dailynote.js`
- `KnowledgeBaseManager.js`

这意味着 VCP 的“记忆写入”并不是只写磁盘，而是：

```text
创建/修改日记 -> 文件落盘 -> KBD 协调 -> 后台增量索引 -> 后续可被召回
```

#### B. `server.js`：AI 输出自动落记忆

VCP 主流程会从 AI 回复里识别：

```text
<<<DailyNoteStart>>>
Maid: ...
Date: ...
Content: ...
<<<DailyNoteEnd>>>
```

命中后自动调用 `DailyNoteWrite`，把对话结果沉淀为长期记忆。

这说明 **VCP 原生支持“对话完成后自动写记忆”**，而不是只能靠人工调用工具。

## 4. 检索与注入能力

### 4.1 `RAGDiaryPlugin`：原生记忆召回主链

这是 VCP 对话前“把记忆放回上下文”的核心模块。

当前代码明确支持的占位符能力有：

| 语法 | 含义 |
| --- | --- |
| `[[...日记本...]]` | 标准语义召回 |
| `<<...日记本...>>` | 门控后的全文/纯文本读取 |
| `《《...日记本...》》` | 混合模式 |
| `{{...日记本...}}` | 直接文本引入 |
| `[[VCP元思考...]]` | 元思考链 |
| `[[AIMemo=True]]` | AIMemo 总开关 |

主链特点：

1. 先识别 system/user 中承载占位符的消息
2. 提取真实 user 与 assistant 意图
3. 分别向量化并做加权融合
4. 根据占位符类型进入不同记忆召回分支
5. 最终把结果替换回消息内容

### 4.2 直接文本记忆

`DirectDiaryTextProcessor` 提供了纯文本路径：

- `LastN`
- `RandomN`
- `BM25`
- `BM25+`
- `getDiaryContent`

这类能力适合“直接拿原文”“最近几条记忆”“按关键词精确扫”的场景，不必每次都走完整语义检索。

### 4.3 Time / Group / RoleValve / Base64Memo

这些不是独立存储系统，但都属于原生记忆能力的一部分：

- **Time**：从用户输入里解析时间范围，对记忆检索加时间约束
- **Group**：按语义组增强查询向量
- **RoleValve**：根据当前上下文门控，决定某段记忆该不该进入提示词
- **Base64Memo**：把命中的附件转换为 base64 图像注入多模态上下文

## 5. 底层知识库能力

### 5.1 `KnowledgeBaseManager`：原生记忆底座

这是 VCP 原生记忆系统的底层中枢。

当前代码可确认它提供：

1. **SQLite 主库存储**
2. **全局 Tag 索引**
3. **日记本独立向量索引**
4. **文件监听与自动增量索引**
5. **搜索统一入口 `search()`**
6. **TagMemo 增强入口 `applyTagBoostAsync()`**
7. **RiverMemo 重排入口 `rerankWithRiverMemoAsync()`**
8. **按路径取 chunks `getChunksByFilePaths()`**
9. **文件变更协调 `runExternalFileMutation()`**

从代码上看，初始化时已经明确挂载：

- `TagMemoEngine`
- `TagMemoV10Engine`
- `RiverMemoEngine`

所以如果只问“VCP 原生记忆底层有没有高级引擎”，答案是：**有，而且已经真实接入 `KnowledgeBaseManager` 主链**。

### 5.2 TagMemo

TagMemo 是当前 VCP 原生长期记忆增强的核心生产能力之一。

它不是独立存储系统，而是“对已有记忆候选进行增强、扩散、加权、重排”的算法层。

从现状看：

- `RAGDiaryPlugin` 会消费 TagMemo 能力
- `LightMemo` 也直接暴露 TagMemo 检索模式
- `KnowledgeBaseManager.applyTagBoostAsync()` 是核心入口

### 5.3 RiverMemo

RiverMemo 也是原生记忆能力的一部分，但角色更像：

- 高阶连续记忆重排内核
- 在候选事实域上做拓扑排序增强

它**已存在于生产代码中**，但并不是像 `DailyNote` 那样独立负责存储；它属于更深一层的记忆读出内核。

## 6. 工具化记忆能力

### 6.1 `LightMemo`

`LightMemo` 是 VCP 原生对外暴露的“轻量回忆工具”。

它支持：

- 普通日记检索
- `enginemode=rivermemo`
- `enginemode=tagmemo`
- `enginemode=knn`
- `TagMemo A/B` 对照
- 冷知识库分流
- Rerank
- AIMemo 总结桥接

它的定位不是替代 `RAGDiaryPlugin`，而是：

- 作为工具调用入口，给 AI 一个更直接的“回忆接口”
- 适合主动检索、比对不同记忆内核、做分析型调用

### 6.2 `DailyNoteSearcher`

这是 Rust 实现的高性能文本搜索器。

它提供：

- 普通文本搜索
- 正则搜索
- BM25 正文召回
- BM25 Tag 行召回
- 在 `dailynote/` 与 `knowledge/` 中做快速文本检索

它更偏“文本级记忆查找器”，通常被 `RAGDiaryPlugin` 的纯文本链路复用。

## 7. 记忆管理与整理能力

### 7.1 `DailyNoteManager`

这是 VCP 原生“记忆管理器”。

当前代码明确有三项能力：

1. `list`：按文件夹和时间范围列出日记
2. `organize`：合并多篇日记，生成新日记，并把旧文件归档到 `已整理/`
3. `associate`：以一篇或多篇日记为源，发现关联记忆

这意味着 VCP 不只是“能写、能搜”，还支持：

- 记忆归档
- 记忆重组
- 记忆联想发现

这部分是很明确的 **记忆治理能力**。

## 8. 工作记忆与反思能力

### 8.1 `FoldingStore`：工作记忆 / 上下文折叠记忆

`FoldingStore` 不属于长期记忆库，但它确实属于 VCP 原生记忆体系。

它保存：

- 内容哈希
- 文本预览
- 向量
- 摘要
- 摘要状态

用途是：

- 给上下文折叠系统提供可复用的“短期工作记忆”
- 避免长对话里重复计算和重复摘要

它更接近“工作记忆缓存”，不是 `DailyNote` 那种长期记忆。

### 8.2 `MetaThinkingManager`：反思型记忆检索

元思考链不是单纯搜索某个日记本，而是：

1. 选定思维链/思维簇
2. 在每一阶段检索对应簇
3. 把上一阶段结果向量再用于下一阶段
4. 最终形成递归反思式召回

所以它属于 **基于记忆库进行多阶段反思推演** 的能力。

## 9. 边界判断

### 9.1 算“VCP 原生记忆能力”的

- `DailyNote`
- `DailyNoteWrite` 自动落记忆
- `KnowledgeBaseManager`
- `RAGDiaryPlugin`
- `TagMemo`
- `RiverMemo`
- `LightMemo`
- `DailyNoteSearcher`
- `DailyNoteManager`
- `FoldingStore`
- `MetaThinkingManager`
- `AIMemo`

### 9.2 不计入本文范围的

- `agent-gateway` 暴露出的 `memory/search`、`memory/write`、`context/assemble`、`recall/run`
- 任何依赖 `agent-gateway` policy/profile/ACL 的记忆接口

## 10. 最终结论

如果只用一句话概括：

**VCP 原生记忆系统已经具备“写入长期记忆、自动增量索引、语义/全文/BM25 召回、TagMemo/RiverMemo 增强、记忆整理归档、联想发现、工作记忆折叠、AI 总结提炼”这一整套完整能力。**

如果拆成最核心的能力清单，就是这 8 类：

1. **长期记忆写入**
2. **长期记忆增量索引**
3. **语义记忆召回**
4. **全文/BM25 记忆召回**
5. **TagMemo / RiverMemo 高阶增强**
6. **记忆整理、归档与联想发现**
7. **工作记忆折叠**
8. **AI 总结与反思型记忆读出**

## 11. 代码依据

主要依据文件：

- `server.js`
- `KnowledgeBaseManager.js`
- `Plugin/DailyNote/dailynote.js`
- `Plugin/RAGDiaryPlugin/RAGDiaryPlugin.js`
- `Plugin/RAGDiaryPlugin/DirectDiaryTextProcessor.js`
- `Plugin/RAGDiaryPlugin/AIMemoHandler.js`
- `Plugin/RAGDiaryPlugin/FoldingStore.js`
- `Plugin/RAGDiaryPlugin/MetaThinkingManager.js`
- `Plugin/LightMemo/LightMemo.js`
- `Plugin/DailyNoteManager/daily-note-manager.js`
- `Plugin/DailyNoteSearcher/plugin-manifest.json`

---

生成时间：2026-07-28  
生成原则：按当前仓库代码状态人工梳理
