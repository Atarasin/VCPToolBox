# agentGateway 记忆/RAG 能力接入方案（含 MCP 工具面与 skill 导出面同步）

> 版本：v1 | 日期：2026-10-09 | 状态：已定稿 | 评审轮次：4 轮 + 定稿轮
> 人读版（评审草图存档）：`.doc-visualizer-output/2026-10-09_agentGateway记忆RAG接入方案.html`
> 执行方式：本文档第 4 节任务分解可直接作为 execute-plan 的执行计划。

## 1. 目标与范围

### 1.1 背景（代码级核验的差距）

agentGateway 的记忆底座（DailyNote 写入、profile 驱动召回管线、AIMemo）已完整，但检索质量与 VCPChat 生产路径存在代差：

1. **引擎代差（核心）**：网关召回管线的语义检索绑定 `knowledgeBaseManager.search`（`modules/agentGateway/composition/vcpPortBindings.js:128-133`），即 RAGDiaryPlugin 的非 RiverMemo 回退路径（KNN + TagMemo boost + 可选 geodesic rerank）；VCPChat 生产默认已是 RiverMemo 原生联合查询（`kbm.executeNativeRiverQuery`，`nativeRiverQueryEnabled` 默认 true，全部在 Rust N-API 一次完成）。`modules/agentGateway/` 内对 `executeNativeRiverQuery` 零引用。
2. **检索参数保守**：`core/recall/ragRetriever.js` 中 `MAX_RAG_K = 20`、默认 `k = 5`、`TAG_BOOST = 0.15`、rerank 默认关闭。
3. **重排缺陷**：RAGDiaryPlugin 的 Jev 重排因默认参数（候选 255 × 单篇 6000 字符，中文约 1.5 token/字符）顶爆 Jev 单请求 32k token 上限，必现 HTTP 400，从未真正生效；本机 `Plugin/RAGDiaryPlugin/config.env` 当前开着 `JevAdvancedRerank=true`（即生效的是坏路径）。
4. **冷知识库未接入**：通用知识库由独立管理器 `TDBKnowledge.js`（TDBKnowledgeManager，TriviumDB 引擎，内容根 `knowledge/`）管理，与日记本（KBM，`dailynote/`）是两套体系；网关 memory 面只覆盖日记本。

### 1.2 目标

- 外部 MCP 客户端经网关的召回质量与 VCPChat 对齐（RiverMemo）。
- 修复重排，使其真正生效。
- 冷知识库以新 MCP 工具对外提供，权限按角色隔离。
- 所有接口变化只做加法；既有 7 个 MCP 工具不移除、不破坏既有调用方式；M2/M3 升级对外部客户端与 skill 导出面零改动。

### 1.3 范围外（明确不做）

- M5 associativeDiscovery 工具化：本期观望，仅留档（D4）。
- 不动 chatCompletionHandler 对话通道、不暴露 VCP 插件工具面、不做 WorkflowKernel。
- 不移除或重命名任何既有 MCP 工具；`gateway_agent_render` 保持 prompt 形态。

## 2. 总体设计 / 架构

### 2.1 分层与动刀位置

```
外部 MCP 客户端（Claude Code / Codex / Trae / DSH 等）
  ↓ 7+1 个 MCP 工具（既有签名不变；M4 新增第 8 个）
网关层 agentGateway：召回管线（resolveProfile → precomputeVector → executeRules → merge → budget → AIMemo）+ skill 导出
  ↓ 端口绑定（唯一宿主耦合层，本次动刀处）
ports 层：现绑 kbm.search（KNN 回退路径）→ 新增 riverQuery（executeNativeRiverQuery）+ knowledgeSearch（TDB）
  ↓
VCP 内核：KnowledgeBaseManager / Rust 向量引擎（rust-vexus-lite）/ RAGDiaryPlugin / TDBKnowledgeManager
```

升级发生在管线内部：M2/M3 完成后，`gateway_recall_run` / `gateway_memory_search` / `gateway_context_assemble` 结果质量提升，调用方（MCP 客户端与 skill 文本）零改动。

### 2.2 消费者画像（Q1）与能力对应

| Agent | 画像 | 主要受益 |
|---|---|---|
| Midas | 量化研究员，查询多为精确术语与指标名 | M3.S3 BM25 关键词混合检索 |
| FuPeng | 宏观金融顾问，重知识广度与观点沉淀 | M4 冷知识库（付鹏观点库为其专属） |
| Yui | 陪伴型智能体，重长期记忆连贯与关联 | M2 River 拓扑关联、M3.S2 多查询向量 |
| Nexus | 编码助手 | 全部召回质量提升 |

### 2.3 skill 导出面影响（R4 补充）

skill 包（SKILL.md + INSTALL.md + manifest.json）由 `services/skillGeneratorService.js` 按 `config/agent_guidance.json`（按角色维护）渲染生成，改配置后重新导出；预生成包：`modules/agentGateway/skills/{MCPFuPeng, MCPMidas, midas-vcp}`。

- M2：零变更（工具签名与调用语义不变）。
- M3：审计 guidance/skill 中「最多 N 条」类行为描述，失真处同步（M3.S1 审计，M4.S4 重导出生效）。
- M4：必须同步——guidance 增补 `gateway_knowledge_search` 使用说明 + 重导出预生成包 + manifest 版本提升（M4.S4）。

## 3. 详细设计

### 3.1 M1 重排修复（D5·方案A）

**改动**：`Plugin/RAGDiaryPlugin/config.env` 中 `JevRerankMaxChoices` 255→10、`JevRerankMaxDocumentChars` 6000→1500（10 × 1500 × 1.5 ≈ 22.5k token，压进约 28k 安全预算）。

**后备**：该文件已有可用传统重排服务配置（Q3）——若 Jev 修复后仍有问题，关闭 `JevAdvancedRerank` 切传统路径（`_rerankDocuments` 的非 Jev 分支自带分批预算 `RerankMaxTokensPerBatch`）。

**验证**：在 recall profile 中开启 rerank，确认（a）日志无 Jev HTTP 400；（b）开关前后召回排序发生变化。

### 3.2 M2 RiverMemo 接入（核心）

**3.2.1 openspec 立项**：新增 openspec change，定义 recall profile 的检索模式字段（`mode: "knn" | "river"`）及网关侧全局开关的契约语义。

**3.2.2 riverQuery 端口**（`modules/agentGateway/ports/`，窄接口）：

- 绑定于 `composition/vcpPortBindings.js`，目标 `kbm.executeNativeRiverQuery(query, options)`。
- 生产调用形状参照 `Plugin/RAGDiaryPlugin/RAGDiaryPlugin.js:3307-3342`：`query = { text, vector }`；`options` 含 `diaryNames`、`preparedMemoObservation`（复用 `applyTagBoostAsync` 的返回，省一次 sensing）、`topK`、`candidateK`、`coreTags`、`supplementalQueryVectors`、`hybridPlan`。
- **失败降级（D1·方案A）**：river 抛错时捕获 → 回退现有 `searchDiary`（KNN）绑定 → 写审计日志与指标（operabilityService），不向外部客户端透传上游异常。KNN 路径的 1.33 融合系数保持不动（历史约定，见 §8 R3）。

**3.2.3 管线接入**（`core/recall/ragRetriever.js`）：语义检索阶段增加 mode 分支。

- **启用方式（D2·方案B）**：全局默认 `river`；提供全局一键回退开关（配置项，如 `AGENT_GATEWAY_RECALL_MODE`，可设回 `knn`）。档案级 mode 覆盖不进本期。

**3.2.4 对比验证**：≥20 条真实 query 人工抽查，覆盖 Midas（术语精确）/ FuPeng（宏观观点）/ Yui（长期记忆关联）三类场景；产出对比报告，river 不劣于 knn（预期更好）。

### 3.3 M3 检索预算与混合检索对齐

- **3.3.1 参数暴露（D6·方案A）**：`ragRetriever.js` 常量 `MAX_RAG_K` 20→50、默认 `k` 5→8；`k` / 上限 / `tagBoost` 暴露到 `config/recall_profiles.json` 档案字段。同步审计 guidance/skill 中行为描述（见 §2.3）。
- **3.3.2 多查询向量**：`precomputeVector` 阶段支持从 `recentMessages` 提取辅助向量，作为 `supplementalQueryVectors` 传入 river 查询。
- **3.3.3 BM25 混合计划**：将全文检索文件候选（现 fullTextRetriever 路径）融入 river 查询的 `hybridPlan.fileCandidates`（参照 RAGDiaryPlugin 生产端打法），含 `timeLimits` 透传。

### 3.4 M4 冷知识库接入

- **3.4.1 knowledge 端口**：`ports/` 新增绑定 `TDBKnowledgeManager`（实例化于 `server.js:114`，注入链 `Plugin.js:1014` → RAGDiaryPlugin）。可用查询面：`search` / `searchWithVector` / `searchGraphFirst` / `queryTql`。不经过 ContextBridge（那是插件间注入面）。
- **3.4.2 新 MCP 工具（D3·方案A）**：`gateway_knowledge_search`——检索冷知识库；工具目录 7→8，经 openspec 契约变更更新 `contracts/operations/mcpOperations.json`、生成的 mcpDescriptors 与 `policy/discoverySnapshot.js` 冻结目录。
- **3.4.3 权限（Q2）**：付鹏观点库仅对 FuPeng 开放，其余冷知识库对全体 agent（Midas/FuPeng/Yui/Nexus）开放；服务端按角色强制（复用日记本 `diaryScopeGuard` 白名单思路），未授权返回 403。
- **3.4.4 guidance 与 skill 同步**：`agent_guidance.json` 增补 `gateway_knowledge_search` 使用说明（何时用、参数口径、受限库 403 现象的解释——以服务端权限为准）；经 skillGeneratorService 重导出 3 个预生成包并提升 manifest 版本；签名下载链路回归（生成器自带 secret scan 必须通过）。

### 3.5 M5 associativeDiscovery（留档，本期不做）

`modules/associativeDiscovery.js`（跨日记拓扑关联回溯，基于 `executeNativeRiverQuery`，已有测试 `tests/associativeDiscoveryRiverMemo.test.js`）。M2 稳定运行后再评估纳入（D4·方案B）。

## 4. 任务分解

> 编号连续不复用；task 用 §x.x 引用详细设计；每个 slice 末尾为验收（DoD）。

### M1：重排修复（独立，可立即执行）
依赖：无。目标：Jev 重排真正生效。

#### M1.S1 重排修复与验证
依赖：无
- [x] T1 按 §3.1 修改 `Plugin/RAGDiaryPlugin/config.env` 两个 Jev 参数并热载
- [x] T2 按 §3.1 验证网关 rerank 生效（日志无 400、排序变化）
- [x] 验收：rerank 开启后召回排序发生变化且日志无 Jev HTTP 400

### M2：RiverMemo 接入召回管线（核心）
依赖：无（与 M1 并行可行）。目标：召回质量与 VCPChat 生产对齐，外部零改动。

#### M2.S1 openspec 立项
依赖：无
- [ ] T1 建立 openspec change：recall profile `mode` 字段与全局开关的契约定义（§3.2.1）
- [ ] 验收：spec 变更目录建立并通过评审

#### M2.S2 riverQuery 端口绑定与失败降级
依赖：M2.S1
- [ ] T1 `ports/` 新增 riverQuery 端口定义（§3.2.2）
- [ ] T2 `vcpPortBindings.js` 绑定 `kbm.executeNativeRiverQuery`（含 preparedMemoObservation 复用与生产参数对齐）
- [ ] T3 失败降级包装：river 失败→KNN 回退+审计/指标（§3.2.2，D1）
- [ ] 验收：端口单测通过；人为制造 river 失败时降级路径有审计记录

#### M2.S3 管线接入 river 模式
依赖：M2.S2
- [ ] T1 `ragRetriever.js` 语义检索阶段增加 `mode: knn|river` 分支（§3.2.3）
- [ ] T2 全局默认切 river + 全局一键回退开关（§3.2.3，D2；档案级覆盖不做）
- [ ] 验收：同一 query 两模式均可召回；日志可见 river 模式走了 executeNativeRiverQuery

#### M2.S4 新旧引擎召回质量对比
依赖：M2.S3
- [ ] T1 ≥20 条真实 query 人工抽查，覆盖 Midas/FuPeng/Yui 三类场景（§3.2.4、§2.2）
- [ ] 验收：对比报告产出，river 不劣于 knn

里程碑门禁：外部客户端与 skill 导出面零改动即可获得新引擎收益。

### M3：检索预算与混合检索对齐
依赖：M2 全部。目标：取数规模与生产对齐（保守档）。

#### M3.S1 参数暴露到召回档案
依赖：M2.S3
- [ ] T1 `MAX_RAG_K` 20→50、默认 k 5→8、tagBoost 暴露到档案配置（§3.3.1，D6）
- [ ] T2 审计 guidance/skill 行为描述并标记差异（§2.3、§3.3.1；差异在 M4.S4 重导出生效）
- [ ] 验收：改档案配置后取数行为随之变化；行为描述差异清单产出

#### M3.S2 多查询向量
依赖：M3.S1
- [ ] T1 从 recentMessages 提取 supplementalQueryVectors（§3.3.2）
- [ ] 验收：多向量模式召回覆盖面有可测提升（对比用例）

#### M3.S3 BM25 混合计划
依赖：M3.S2
- [ ] T1 全文检索文件候选融入 river 查询 hybridPlan（§3.3.3）
- [ ] 验收：含明确关键词的 query 命中改善（对比用例）

### M4：冷知识库（TDB）接入
依赖：M4.S1 可与 M2 并行；S2 起依赖 M2.S1 的契约流程经验。目标：冷知识库以第 8 个工具对外，权限隔离。

#### M4.S1 knowledge 端口
依赖：无（可与 M2 并行）
- [ ] T1 `ports/` 绑定 TDBKnowledgeManager 查询面（§3.4.1）
- [ ] 验收：网关进程内可查询 TDB 库（单测覆盖）

#### M4.S2 新工具 gateway_knowledge_search
依赖：M4.S1（D3 已定）
- [ ] T1 经 openspec 新增 `gateway_knowledge_search`：mcpOperations.json、mcpDescriptors、discoverySnapshot（§3.4.2）
- [ ] T2 契约与 MCP 工具目录更新及测试
- [ ] 验收：外部客户端可经 MCP 调用检索冷知识库

#### M4.S3 权限边界
依赖：M4.S2（Q2 已回答）
- [ ] T1 付鹏观点库仅 FuPeng、其余全员；服务端按角色强制（§3.4.3）
- [ ] 验收：未授权角色查不到未开放的知识库（403）

#### M4.S4 guidance 增补与 skill 重导出
依赖：M4.S2（R4 新增）
- [ ] T1 `agent_guidance.json` 增补新工具使用说明与 403 解释口径（§3.4.4）
- [ ] T2 重导出 3 个预生成 skill 包 + manifest 版本提升 + 签名下载回归；M3.S1 差异一并生效（§3.4.4、§2.3）
- [ ] 验收：导出 SKILL.md 含新工具说明、通过 secret scan、下载链路可领取

### M5：associativeDiscovery 工具化（留档，本期不执行）
依赖：M2.S2。目标：M2 稳定运行后再评估纳入（D4·方案B）。

#### M5.S1 associativeDiscovery 网关化（留档）
依赖：M2.S2（复用 river 端口）
- [ ] T1 将跨日记拓扑关联回溯（`modules/associativeDiscovery.js`，已有测试 `tests/associativeDiscoveryRiverMemo.test.js`）包成网关工具或 REST（§3.5；届时另立 openspec 变更）
- [ ] 验收：给定种子日记能返回跨日记关联链（现成测试可参照）

## 5. 约束与红线

1. **宿主耦合隔离**：一切新内核绑定只进 `composition/vcpPortBindings.js`；`services/`、`core/` 出现直接内核引用即违规（网关 M4 闭包已验证的纪律）。
2. **契约变更走 openspec**：MCP 工具目录（discoverySnapshot 冻结）、recall profile 字段均为已发布契约，必须先立正式变更再动代码。
3. **只做加法**：不移除既有 7 个工具、不破坏既有调用方式；外部已有真实消费者（Nexus 全套在用）。
4. **不静默吞错**：river 失败按 D1 降级并留痕（审计+指标）；禁止静默返回空/旧结果而无痕迹。
5. **KNN 路径 1.33 融合系数锁定**：`searchDiary` 绑定注释明确「宿主搜索 API 要求历史 1.33 系数」，接入新引擎时不改动旧路径该系数。
6. **TagMemo 只用异步门面**：绑定仅可用 `applyTagBoostAsync` / `prepareUnifiedMemoObservation`；同步 `applyTagBoost` 已退休（会抛 `TAGMEMO_JS_GRAPH_RUNTIME_RETIRED`）。

## 6. 验收标准（总体）

1. recall profile 中开启 rerank 后，网关日志无 Jev HTTP 400 且召回排序可见变化（M1）。
2. 全局 river 模式下，`gateway_recall_run` / `gateway_memory_search` / `gateway_context_assemble` 三个工具调用方式不变、可正常返回，日志可见走 `executeNativeRiverQuery`；人为制造 river 失败时自动降级 KNN 且审计有记录（M2）。
3. 一键回退开关切回 knn 后行为立即回退，无需重启代码变更（M2）。
4. M2.S4 对比报告产出且 river 不劣于 knn（≥20 条、三类角色场景覆盖）（M2）。
5. 档案配置 k=8 生效、上限 50 可达（构造大召回场景验证）（M3）。
6. 外部 MCP 客户端可调用 `gateway_knowledge_search` 检索非受限冷知识库；以非 FuPeng 身份查付鹏观点库得到 403（M4）。
7. 重导出的 3 个 skill 包含新工具说明、通过 secret scan、manifest 版本提升、签名下载可领取（M4）。
8. 既有 7 个工具的既有调用（Nexus 全套）回归通过（全程）。

## 7. 已确认的决策记录

| # | 决策 | 选择 | 理由 / 备注 | 轮次 |
|---|---|---|---|---|
| D1 | river 失败策略 | A：降级 KNN + 审计留痕 | 外部三角色体验优先；留痕保证可观测 | R2 |
| D2 | 启用方式 | B：全局默认切 river | 用户选择（非默认建议）；兜底＝全局一键回退开关 + D1 降级留痕 | R2 |
| D3 | 冷知识库暴露形态 | A：新工具 gateway_knowledge_search | 冻结面变更最小、日记/知识库语义边界清晰 | R2 |
| D4 | M5 关联发现 | B：本期观望 | 聚焦主线；实现已有现成代码与测试，纳入成本低 | R2 |
| D5 | 重排修复路线 | A：修 Jev 参数（10×1500） | 两行配置即可验证；传统重排配置就位可作后备（Q3） | R2 |
| D6 | 检索预算幅度 | A：保守放开（5→8 / 20→50） | 先观察三角色延迟反馈，再考虑对齐生产 | R2 |
| Q1 | 消费者画像 | Midas/FuPeng/Yui（+Nexus） | 已映射到 §2.2 能力对应与 M2.S4 用例 | R2 |
| Q2 | 知识库边界 | 付鹏观点库仅 FuPeng；其余全员 | 落入 §3.4.3 权限设计 | R3 |
| Q3 | 重排服务配置 | config.env 已有可用传统重排 | D5 之后备保障 | R2 |
| — | skill 导出面纳入 | 随 M2（零变更）/M3（审计）/M4（必须同步） | 评审补充意见，非编号决策 | R4 |

## 8. 风险与开放问题

| # | 风险/坑 | 说明 | 缓解 |
|---|---|---|---|
| R1 | Jev 重排必现 400 | 根因：255×6000×1.5 ≫ 32k token 上限；400 不在重试白名单，快速失败后退回检索原序 | M1 修复；验证看日志 |
| R2 | river 入口失败即抛错 | 上游语义不静默回退（DreamWave/VCPTimeLine 除外） | 端口绑定层按 D1 显式包装 |
| R3 | 1.33 融合系数 | KNN 绑定的历史约定，勿顺手"优化" | 红线 5 |
| R4 | rag_params.json riverMemo.enabled 是死键 | 无代码读取，管理面板有开关但勿据此判断引擎状态 | 以代码与日志为准 |
| R5 | TagMemo 同步门面已退休 | 同步调用抛 TAGMEMO_JS_GRAPH_RUNTIME_RETIRED | 红线 6 |
| O1 | 开放问题：Yui 是否需要预生成 skill 包 | guidance 已有 MCPYui 条目，但预生成包无 Yui；非本期范围 | M4.S4 重导出时可顺带评估 |
