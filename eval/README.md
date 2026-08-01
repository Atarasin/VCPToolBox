# VCP RAG / 记忆能力评估

评估 VCP 原生 RAG 与记忆能力的工具链：占位符全链路、TagMemo、RiverMemo、::Time、::Group、
BM25、去重、门控、LightMemo、DailyNoteSearcher、冷知识库。

```bash
node eval/vcp-eval.js doctor          # 环境自检
node eval/vcp-eval.js corpus build    # 生成语料
node eval/vcp-eval.js run             # 执行评估
node eval/vcp-eval.js runs show latest
```

---

## 为什么重建

上一版评估（现冻结在 `eval/legacy/`）产出的数字**没有信息量**。这不是"过时"，是失效。
以下每一条都经过代码或产物验证：

| 问题 | 证据 |
| --- | --- |
| candidate 向量库 **0 个 tag** | `select count(*) from tags` → 0，TagMemo 根本不可能生效 |
| baseline 向量库缺 `tagmemo_artifacts` / `rivermemo_artifacts` 表 | schema 与当前代码不兼容 |
| 语料 7 篇、主库仅 5 篇，而动态 K ∈ [3,10] | top-5 直接返回整个库；Precision@5 恒为 0.2，MRR 恒为 1.0 |
| ::Time 查询用相对表达，语料却写死 2026-01~03 | 存档结果里 case_001 解析出 `2026-04-04 ~ 2026-04-11`，命中 0 条 |
| `gatePassed = content.trim().length > 0` | 零命中时插件仍输出 `VCP_RAG_BLOCK` 包裹，40/40 全部 true，指标恒为常数 |
| 门禁 5 项中 3 项数学上不可达 | `pass` 恒为 false；且脚本永远 exit 0，CI 拦不住任何东西 |
| gate_expect:false 的用例同时带 gold_snippets | 门控**正确拦截**时反而扣 Recall/MRR |
| 噪声率测的是语料布局不是检索器 | hard negative 就在会被整库返回的同一个库里 → 任何系统恒为 0.15 |
| topk 提取有 3 层语义不兼容的兜底 | baseline 30 event/10 blob vs candidate 34 event/6 blob——**两个 arm 用了不同的测量仪器** |

所以那份报告里 `recall 0.875→0.975` 的"提升"只是冷启动与时间窗口的假象，
**不能据此得出任何关于 embedding 模型的结论**。

---

## 设计要点

### 1. 语料是生成的，不是提交的

`corpus-spec/*.jsonl` 是源头（提交进 git），`eval/dailynote_eval/` 是生成物（gitignore）。

`corpus build` 会：
- 把 `dayOffset` / `dateRule` 按**运行日**落地成真实日期 → 相对时间表达（今天／上周／N天前）永不漂移
- 生成 `[YYYY-MM-DD] - 评测助手` 首行（月日补零，否则该文件对 `::Time` 完全不可见）
- 标签行只写一行 `Tag: …`（末行），与生产语料格式完全一致。
  历史上 Rust searcher 的 marker bug 曾迫使语料双写 `Tags:` + `Tag:`；修复后实测
  发现 `Tags:` 行是**死行**——两套引擎都自底向上取最后一条标签行，排在 `Tag:`
  前面的行永远读不到。变体写法的兼容性由 Rust 单元测试钉住，语料不再双写
- 按 `mtimeRank` 钉死文件时间戳，且**刻意让 mtime 顺序 ≠ 日期顺序 ≠ 文件名顺序**，
  否则 `::LastN` 与 `{{}}` 全量模式产出相同结果，等于没测

> **mtime 必须设到未来。** `getRecentDiaryFileMetas` 的排序键是
> `max(mtimeMs, birthtimeMs, ctimeMs)`，而 `fs.utimes()` 会把 ctime 刷成当前时刻且无法调早。
> mtime 设成过去时 `max()` 永远选中 ctime，`mtimeRank` 完全失效。这个坑踩过一次，
> `corpus verify` 现在有一条 `ctime-dominates-sort-key` 断言专门守它。

### 2. 插件侧配置会被自动装入（只增不改）

`corpus build` 会往 `Plugin/RAGDiaryPlugin/` 写两处配置，因为它们的路径硬编码在
`path.join(__dirname, …)`，没有环境变量可以改指向：

| 文件 | 写入内容 | 不写的后果 |
| --- | --- | --- |
| `rag_tags.json` | 四个评测日记本的 `threshold` | 未注册的日记本用**硬编码 0.6** 阈值，门控用例两个方向都测不出来 |
| `semantic_groups.json` | `评测容量组` / `评测叙事组` | 组不存在时 `::Group` 静默返回原向量，等于没生效 |

写入是**只增不改**的：只碰评测自己命名空间的键，原有条目一律保留，首次写入前留备份
（`*.eval-backup`）。反向操作：`node eval/vcp-eval.js corpus uninstall-config`。
不想让它动这两个文件就加 `--no-plugin-config`（但 `::Group` 与门控用例会因此失效）。

`run` 会在启动前检查这些配置是否就位，缺失则**直接中止**——否则跑出来的失败是误导性的。

### 3. 双臂对照

每条用例分 `treatment` 与 `control` 两臂：同语料、同查询，**只差一个修饰符**。

```json
"arms": {
  "treatment": "[[评测运维技术库日记本::TagMemo]]",
  "control":   "[[评测运维技术库日记本]]"
}
```

单臂指标只能说"返回了东西"，说不了"这个能力有没有用"——
一个完全没生效的修饰符，单臂指标看起来和生效了一模一样。
对照臂让我们能直接测量**金标排名位移、Top-K 重合、Kendall τ、ΔnDCG**。

### 4. 真值是文档级的

`relevant` / `irrelevant` 引用文档（`日记本/slug`），不是子串。
旧实现用 `String.includes` 匹配 gold_snippets，五种脆法叠在一起：`Tag:` 行也在被匹配的文本里
（tag 词汇能满足正文金标）、没有归一化、不看命中位置、两个金标是 OR 而非 AND、
连 `[EVAL_ERROR]` 都能被当成正常文本匹配。

用例引用不到实际文档时**直接报错**，而不是静默算 miss。

### 5. 深度不硬编码

被测系统的 K 是 `clamp(k_base + adjustment, 3, 10)` 再乘倍率。
硬编码 precision@5 会惩罚"正确地只返回 3 条"（3/3 相关 → 0.6）。
现在在 {1,3,5,10} 与**实际 K** 上都出指标，且 recall / MRR / 噪声率用同一深度
（旧实现 noiseRate 扫 10 条而 recall 只看 5 条，同一次运行用两个深度评判）。

### 6. 检索指标只在门控放行的用例上算

门控拦截是**正确行为**，不该被记成召回失败。门控用例单独用三态判定：
`blocked` / `passed_empty` / `passed` / `not_recognized`，并独立统计准确率。

### 7. 静默失效必须被看见

VCP 的 RAG 能力几乎全是静默降级的：缺一行 `Tag:`、月份没补零、`::group` 写成小写、
Rerank 未配置、artifact 未就绪 —— 对应能力悄悄变成 no-op，不报错、不告警。
`search()` 更是把一切包在 try/catch 里返回 `[]`，维度不匹配和 Rust ABI 错误都表现为"零结果"。

因此：
- 每条用例扫描日志里的降级标记（`🛡️ Fallback to original order`、`tag_knn_fallback` …），
  出现即在报告中标注"该用例结论不可信"
- 运行前做**索引真值核对**（chunk 数、tag 数、`file_tags.position=0` 计数、artifact 表是否存在），
  不通过就**中止而不出报告**
- 依赖缺失时用例标记 **SKIPPED 而非 PASSED**

---

## 目录结构

```
eval/
├── vcp-eval.js           唯一 CLI 入口
├── lib/                  实现（profile / runtime / probes / metrics / runner / compare / report …）
├── corpus-spec/          语料源头（提交）：books.json + 四个日记本的 jsonl
├── suites/               用例集：tier1-offline / tier2-retrieval / tier4-coldkb
├── profiles/             运行构型：embedding 模型、维度、rag_params 路径、env 覆盖
├── dailynote_eval/       生成的语料（gitignore）
├── runs/                 每次运行的完整产物（gitignore）
└── legacy/               冻结的上一版评估
```

### 一次运行留下什么

```
eval/runs/<runId>/
├── manifest.json              运行身份、git sha、模型、corpusHash、耗时、状态
├── config/
│   ├── resolved.json          完整配置快照（凭据已折叠成 sha256 指纹）
│   ├── rag_params.json        本次实际生效的 rag_params
│   └── corpus.manifest.json   语料清单：每篇的路径/哈希/日期/tag/mtime
├── VectorStore/               ← 本次运行的向量数据
├── results/raw.jsonl          每条用例每个臂的完整原始记录
├── metrics/{metrics,per-case} 指标
├── logs/run.log               完整日志（降级标记扫描的依据）
└── report.md                  人读报告
```

`runId = <时间戳>-<profile>-<configHash>`，其中 configHash 由
profile + rag_params + 语料 + 用例集共同决定 —— 同配置重跑与换配置一眼可辨。
`compare` 会先检查 corpusHash / suiteHash 是否一致，不一致则**拒绝判定**
（语料变了的话任何 delta 都没有意义）。

---

## 语料结构

四个日记本，89 篇，81 个唯一 tag。每一族都是为了让某个能力"可被证伪"而设计的。

| 日记本 | 篇数 | 阈值 | 作用 |
| --- | --- | --- | --- |
| `评测运维技术库` | 59 | 0.44 | 技术运维主线，全部对抗族都在这里 |
| `评测幻想设定库` | 14 | 0.50 | 小说设定与音乐，门控负样本与噪声率 |
| `评测容量运营库` | 12 | 0.44 | 与主库共享实体：聚合索引、跨库 ::Associate、::Group 目标 |
| `vcp知识库` | 4 | 0.40 | 钉住 `[[vcp知识库日记本]]` 的日记本 vs 冷知识库命名冲突 |

> **日记本的名字是门控的一部分。** `<<>>` / `《《》》` 的门控算的是
> `max(cos(查询, 日记本名向量), cos(查询, 增强向量))`——**日记本名会直接参与打分**。
> 这套语料最初叫 `RAG评测主库` / `RAG评测干扰库`，结果实测出现了倒挂：
> 一个技术查询对 "RAG评测干扰库" 的相似度是 **0.5765**，而它自己的主题查询（梦境潮汐）
> 只有 **0.3917** —— 因为两个名字里都是"RAG评测"这类技术词汇，名字根本不描述内容。
> `max()` 让名字向量成为不可逾越的下限，**任何阈值都无法同时放行正样本、拦住负样本**。
> 改成描述内容的名字之后分离度立刻正常（技术库 0.49 vs 0.39/0.36；设定库 0.57 vs 0.43），
> 上表的阈值就取自这两个区间的中段。
> 结论：**给日记本起能描述其内容的名字**，否则门控行为会与直觉相反。

主要对抗族：

- **`tagmemo_tagonly`** — gold 正文**零查询词**，只能靠 Tag 向量被捞出；
  hardneg 正文**含完整查询词**但 tag 无交集。这一对产生 TagMemo 的严格胜出。
- **`tagmemo_position`** — tag 集合相同、顺序相反，隔离"tag 序号"这一个变量。
- **`tagmemo_closure_fail`** — 正文相关但 tag 与正文语义正交，断言 TagMemo **不**加分。
- **`rivermemo_order`** — 8 篇讲同一因果链，3 篇 Tag 行按真实因果序、3 篇倒序、2 篇插入外来概念。
- **`rivermemo_corroboration`** — 因果边被 3 篇印证 vs 只在 1 篇出现，隔离反自证机制。
- **`rivermemo_anchor`** — 唯一一篇带稀有 tag，走直锚通道。
- **`hub_dilution`** — 20+ 篇共享 `通用记录`，让 hub 惩罚成为可测量的量。
- **`dedup`** — 逐字节相同对 + NFKC 可折叠的全角变体 + 余弦落在 [0.92,0.97) 的复述对。
- **`timedecay`** — 同主题写在 -3d / -40d / -120d，共享 ASCII tag `boxDecay`。

### 写语料时必须守住的规则

违反任何一条，对应能力会**静默失效**（不报错）：

- 每篇最后一行必须是 `Tag: …`，2-8 个 tag
- 含中文的 tag ≤15 字，纯西文 ≤30 字，**不能形似日期**（会被 `extractTags` 丢弃）
- tag 要跨 ≥3 篇复现，否则共现图没有边、场熵过不了 `minFieldEntropy 0.12` 的门
- 首行 `[YYYY-MM-DD]` 月日必须补零
- `::BM25+` 的判别词要在正文里（body 模式会剔除第 1 行与所有标签行，包括 `Tag:`）
- 语义组的组词**只能出现在查询里，不能出现在语料正文里** ——
  否则测的是词面重叠而不是向量混合

`corpus verify` 会逐条检查这些，包括日记本目录名不能互为前缀
（LightMemo 的 folder 过滤是 SQL `LIKE '%name%'` 子串匹配，会串味）。

---

## 命令

```bash
node eval/vcp-eval.js doctor                    # 环境自检
node eval/vcp-eval.js corpus build [--anchor YYYY-MM-DD]
node eval/vcp-eval.js corpus verify
node eval/vcp-eval.js corpus spec               # 只校验 spec，离线
node eval/vcp-eval.js run [--suite tier1,tier2] [--tier 2] [--family tagmemo]
                          [--filter <正则>] [--label <文本>] [--profile <名称>]
node eval/vcp-eval.js score <runId|latest>
node eval/vcp-eval.js compare <baseline> <candidate>
node eval/vcp-eval.js gate <baseline> <candidate> [--rules <file>]
node eval/vcp-eval.js runs list | show [runId] | prune --keep N
node eval/vcp-eval.js suite list [--coverage]
```

所有命令都支持 `--json`（便于其它 agent 消费）。`gate` 未通过时**非零退出**。

npm 快捷方式：`npm run eval:doctor` / `eval:corpus` / `eval:run` / `eval:tier1` /
`eval:compare` / `eval:gate` / `eval:coverage`。

### 对比两个 embedding 模型

复制 `profiles/default.json` 改 `embedding.model` 与 `dimension`（仓库已带两个现成的：
`gemini3072` = jy-gemini-embedding-001 @ 3072、`qwen8b4096` = Qwen/Qwen3-Embedding-8B @ 4096），然后：

```bash
node eval/vcp-eval.js doctor --profile gemini3072      # 先探端点与维度
node eval/vcp-eval.js run --profile gemini3072 --label baseline
node eval/vcp-eval.js run --profile qwen8b4096 --label candidate
node eval/vcp-eval.js compare <runA> <runB>
```

两次运行各自持有独立的 `VectorStore/`，不会互相污染 —— 旧实现共用 committed 的
`VectorStore_baseline/` 与 `VectorStore_candidate/`，一个陈旧索引就能悄悄带偏整轮对比。

profile 里 `embedding.model`/`dimension` 留 `null` 表示沿用根 `config.env` 的当前值；
显式填写即覆盖。**dimension 必须与模型实际输出一致**——doctor 会真发一次探针请求核对，
不一致直接中止（否则 `search()` 会静默返回空数组）。候选模型走另一个网关时在
profile 的 `env` 里覆盖 `API_URL`/`API_Key`。RAG 参数同理：把改过的 rag_params
副本存成文件、用 `ragParamsPath` 指向它（注意 doctor 会提示的死键调了没有效果）。

### ⚠️ 不要同时跑多个 run（串行约束）

每次 run 的向量库确实互相隔离，但以下**跨进程共享的可变状态**没有隔离，
并发跑会互相破坏：

| 共享点 | 位置 | 并发后果 |
| --- | --- | --- |
| 插件向量缓存 | `Plugin/RAGDiaryPlugin/vector_cache.json`（路径硬编码 `__dirname`） | 两个进程各自读-改-写整个文件，后写覆盖先写；**换模型对比时最危险**——不同维度的日记本名向量会互相污染对方缓存 |
| 语义组向量 | `SemanticGroupManager` 写 `semantic_groups.json` + `semantic_vectors/*.json` | 不同维度的进程互相删改对方刚算好的组向量 |
| DailyNoteSearcher 常驻服务 | 固定端口 38765 | 第二个进程绑定失败，或复用第一个进程起的服务导致生命周期归属混乱 |
| 冷知识库（tier4） | `Plugin/TDBKnowledge/VectorStoreTDB/` 单一 `.tdb` + meta SQLite + 摄取队列 | 两进程撞锁；TDBKnowledge 的"发现锁文件尝试清理"逻辑会把**活着的**另一进程的锁清掉 |

另有两个软性问题：embedding 端点被双倍并发打（gemini 网关已实测出现过 429）；
两个进程抢 CPU 会让 `latencyMs` 失真，跨 run 的成本对比失去意义。

**这条约束由工具强制**：`run` 启动时会在 `eval/runs/.lock` 上取原子并发锁
（在任何触碰共享状态的步骤之前）。已有 run 在跑时，第二个 `run` 会**立即拒绝并
非零退出**，错误信息里带持有者的 pid / profile / label / 开始时间。被 `kill -9`
留下的陈旧锁靠 PID 探活自动清理，不需要人工干预；只有在确认持有进程已不存在而
锁仍未被清掉的极端情况下，才需要手动删除 `eval/runs/.lock`。

串行链式执行即可：

```bash
node eval/vcp-eval.js run --profile gemini3072 --label baseline && \
node eval/vcp-eval.js run --profile qwen8b4096 --label candidate
```

---

## 覆盖范围与边界

**Tier 1（纯离线，可进 CI）** — 不启动知识库，不发网络请求：
`{{}}` 全量／`::LastN`／`::RandomN`／`::BM25`／`::BM25+`、TimeExpressionParser、
ResultDeduplicator、DailyNoteSearcher（text／regex／AND／bm25-body／bm25-tag／安全）。

**Tier 2（需要 embedding）** — RAG 主体：
`[[]]`、`<<>>`、`《《》》` 三种门控、`::Time` / `::Time0.x`、`::TimeDecay`（白名单命中/未命中）、
`::Group`（全激活／部分激活／未激活／小写负控）、`::TagMemo` / `::TagMemo+` / 权重、
`::RiverMemo`（narrative vs atomic、印证 vs 孤证、与 TagMemo 互斥）、`::Rerank` / `::Rerank+`、
`::Truncate` / `::Expand` / `::Associate`、聚合虚拟索引、`::RoleValve` 括号形式负控、
命名冲突、LightMemo 三种 enginemode + `tagmemo_ab`。

**Tier 4（冷知识库）** — `[[X知识库]]` / `《《X知识库》》` / 多库聚合 / LightMemo `[知识库:X]` 语法。

**不在范围内（Tier 3）** — AIMemo / AIMemo+ / MetaThinking / ContextFoldingV2。
它们需要真实 chat API 调用且结果不确定，schema 已预留 `tier: 3`，可增量接入。

### 已知前置条件

| 项 | 状态 | 影响 |
| --- | --- | --- |
| `triviumdb` | **未安装**（package.json 声明 `^0.7.1`） | Tier4 全部 SKIP。装上即可：`npm i triviumdb` |
| DailyNoteSearcher 二进制 | 仓库只带 `.exe` 与 aarch64-musl | 其它平台需 `cd Plugin/DailyNoteSearcher/src && cargo build --release` |
| Rerank 端点 | 需 `RerankUrl`/`RerankApi`/`RerankModel`（读自 `Plugin/RAGDiaryPlugin/config.env`） | 未配置时 rerank 静默变成 `slice(0,K)`，相关用例会 SKIP 而非伪装通过 |

### 两个会让整轮评测失真的 VCP 行为

评测已经内建绕过，写在这里是因为它们不写下来就一定会再被踩一次：

**1. `KNOWLEDGEBASE_DERIVED_STARTUP_COOLDOWN_MS` 传 `0` 等于没传。**
`KnowledgeBaseManager.js:90` 是
`parseInt(process.env.KNOWLEDGEBASE_DERIVED_STARTUP_COOLDOWN_MS, 10) || 5 * 60 * 1000`，
而 `parseInt('0') === 0` 是 falsy，会被 `||` 吞掉落回 5 分钟默认值。
冷却不清掉，首轮 artifact 构建拿不到 Rust 写租约，预热必然超时，
于是 **TagMemo 全线返回空结果、RiverMemo 直接抛错**——
而 `search()` 把一切包在 try/catch 里返回 `[]`，表现出来就是"检索质量很差"。
profile 因此传 `'1'` 而不是 `'0'`。

**2. TagMemo 与 RiverMemo 的失败形态不同。**
TagMemo artifact 不可用时 `applyTagBoostAsync` 抛 `MEMO_ARTIFACT_UNAVAILABLE`，
被 `searchService` 吞掉 → 该次检索返回 **0 条**（事件照常发出，`useTagMemo: true`，只是没结果）。
RiverMemo 则是**彻底抛出**，连 `RAG_RETRIEVAL_DETAILS` 事件都不发 → 占位符被置空、`engine` 为 `null`。
所以带 `requiresArtifact` 的用例必须断言 artifact 就绪，否则这两种失效都会被误读成"召回质量问题"。

### `Tag:` vs `Tags:` 实现分歧（bug，已于 2026-07-31 修复）

`::BM25` 的 tag 行召回曾有两条不一致的实现：JS 参照（`extractTagLine:572`）用
`/^tags?\s*[:：]/i`（`s` 可选，兼容 `Tag:`），Rust 加速路径只认 `tags:`/`标签:` ——
而生产语料 100% 只写 `Tag:`（写入端 `DailyNote` 插件产出的就是它）。
后果是装了 Rust searcher 的机器上，tag 行召回对整个生产语料恒返回 0 条并静默回落
`::LastN`（实测 `dailynote/Nexus架构设计` 35 篇：修复前 tag 模式 `total=0`，修复后 `total=1`）。

**修复**：`main.rs` 新增 `tag_line_value()`，与 JS 正则逐点对齐（`Tag`/`Tags`/`标签`
大小写不敏感、半角/全角冒号、marker 与冒号间允许空白），`extract_tag_line` 与
`extract_body_for_bm25` 共用它 —— 顺带修掉了两个连带问题：
`Tags：`（大写 + 全角冒号）两个分支各漏一半也匹配不上；`Tag:` 行泄漏进 body 模式打分。
带 4 个单元测试（`cargo test`，`tag_line_tests`）。

回归防线：`t1_searcher_production_tag_invisible`（生产格式文件必须被 tag 模式召回）
与 `t1_searcher_tagline_leaks_into_body`（`Tag:` 行必须被 body 模式过滤，total=0）。
修复落地后语料也随之简化：不再双写 `Tags:` 行 —— 实测它被末行 `Tag:` 完全遮蔽
（两套引擎都只取最后一条标签行），是读不到的死行；`corpus verify` 现在反过来
用 `multiple-tag-lines` 断言每篇**只有一条**标签行，防止死行再被引入。

> ⚠️ 仓库里提交的 `DailyNoteSearcher.exe` 与 aarch64-musl 二进制**仍是修复前的旧版**，
> 本机无法交叉编译。Windows / ARM 机器上需各自 `cargo build --release` 后行为才一致
> （wrapper 的候选顺序里平台预编译二进制优先于 `src/target/release/`）。

### 关于 rag_params 里的死键

`doctor` 会提示这些：`riverMemo.enabled: false` **没有任何代码读取**（RiverMemo 照常运行）；
`dstc.topologyV2RoleCaps` / `topologyV2RoleMultipliers` 是装饰性的，实际值硬编码在 Rust 的
match 分支里。调这些参数不会有任何效果。

---

## 加一条用例

1. 需要新文档就先加到 `corpus-spec/<book>.jsonl`，然后 `corpus build` + `corpus verify`
2. 在 `suites/tier2-retrieval.jsonl` 加一行：

```json
{"id":"t2_xxx","tier":2,"mode":"placeholder","family":"tagmemo","capability":"::TagMemo",
 "query":"…","arms":{"treatment":"[[X日记本::TagMemo]]","control":"[[X日记本]]"},
 "relevant":["X/某篇slug"],"irrelevant":["Y/另一篇slug"],
 "expect":{"engine":"TagMemo","flags":{"useTagMemo":true},"requiresArtifact":true,
           "effect":{"minGoldRankGain":1}}}
```

3. `node eval/vcp-eval.js run --filter t2_xxx` 单跑验证

`expect` 支持：`engine`、`flags.*`、`minResults`、`gate`、`timeRangesParsed`、
`minBm25Matched`、`directRecallAction`、`groupBlended`、`requiresArtifact`、
`effect.{rankingChanged,minGoldRankGain,maxTopKOverlap}`、`noDegradation`。

**写新用例时最重要的一条**：想清楚"这个能力如果完全没生效，这条用例会不会照样通过"。
如果会，就还缺一个断言 —— 那正是旧评估的通病。

同样重要的一条：**真值里不要混入"不需要该能力也能命中"的文档**。
`t2_tagmemo_tagonly` 最初把 `接口错误码` 也列为 relevant，而那篇正文里就有查询词，
纯 KNN 在两个臂里都把它排第 1 —— 金标排名恒为 1，效应指标彻底失去分辨力。
真值只应包含"该能力生效才拿得到"的那些文档。
