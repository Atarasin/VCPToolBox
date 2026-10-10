# 专家铸造炉（Agent 自学习专家生成流水线）设计文档

> 版本：v1 | 日期：2026-10-10 | 状态：已定稿 | 评审轮次：3 轮
> 人读版（评审草图）：.doc-visualizer-output/2026-10-10_专家铸造炉.html

## 1. 目标与范围

### 1.1 目标

为 VCPToolBox 增加「专家生成」能力：用户以一句话需求描述目标专家（首个试点：UI 设计专家），系统自动完成：

1. **专家画像制定**（构思）：铸造师 agent 与用户确认职责边界、子技能清单、考纲；
2. **网络资料采集**（采集）：按子技能逐项检索抓取，原始材料永久存档；
3. **知识蒸馏入库**（提炼）：原始材料蒸馏为结构化知识文件，写入 `knowledge/<库名>/`，由 TDB 冷知识库自动索引；
4. **人设合成与注册**（合成）：生成 `Agent/<名字>.txt`，登记 `agent_map.json`，绑定知识库权限与引导配置；
5. **试岗验收**（试岗）：出题官按考纲出题，新专家盲测（只准查自己的库），LLM 判卷出报告，及格后请用户抽查，不及格定向补课；
6. **持续学习**（进修）：缺口标记、手动进修指令、定时进修三种触发，增量入库并留学习档案。

**核心原则（红线 1）**：专业技能只进 TDB 冷知识库，绝不写入任何记忆日记本。记忆本存「经历」，知识库存「本事」，两者永不交叉。铸造流程全程禁止调用任何写日记工具，审计日志可证明。

### 1.2 范围

**In scope**：
- 铸造流水线编排（跑在 agentGateway 现有 job 运行时之上）；
- 专家画像 JSON schema 与读写校验；
- 检索抓取（复用现有搜索插件，多插件 fallback）、蒸馏（复用 llmCompletion 端口）、知识文件写入 `knowledge/`；
- 人设合成、`agent_map.json` 自动登记、知识库权限绑定（`mcp_agent_knowledge_policy.json`）、引导配置（`agent_guidance.json`）；
- 试岗出题 / 盲测 / LLM 判卷 / Jev 对照试点 / 缺口回填；
- 缺口登记（新增 MCP 工具 `gateway_gap_report`）、手动进修、定时进修（taskScheduler）、学习档案；
- 预算护栏：每次铸造的模型调用费用上限 10 元（画像内可配，默认 10）。

**Out of scope**（明确不做，来自已确认决策）：
- AdminPanel 进度展示页（D1 定：本期不做，将来需要再补）；
- VCP 内部对话渠道的人设适配（Q3：主要使用渠道为外部 MCP 客户端，人设按 MCP 客户端规范写）；
- 多专家并行铸造调度（单 job 串行即可）。

### 1.3 试点验收对象

「UI 设计专家」：及格线样例（Q5 已确认）——**能给出一份眼前一亮、去 AI 味的 UI 设计图**。

## 2. 总体设计 / 架构

### 2.1 流水线总览

```
[用户一句话需求]
      │
      ▼
① 构思 blueprint ──(用户确认画像)──► ② 采集 harvest ──► ③ 提炼 distill
      ▲                                                        │
      │                                                        ▼
      │              ⑥ 持续学习 lifelong ◄──缺口── ⑤ 试岗 trial ◄── ④ 合成 synthesize
      └──────────── 增量学习（小型采集→提炼） ◄──────────────┘
```

六步中 ②③ 复用同一套「采集→提炼」能力：初次铸造全量跑，缺口回填与持续学习以缺口/主题为 scope 增量跑。

### 2.2 组件分层（上层只读下层，禁止反向依赖）

| 层 | 组件 | 说明 |
|---|---|---|
| 入口层 | 铸造师 agent（`Agent/forge/ForgeMaster.txt`） | 对话式下订单（D1 已定）；解析需求、生成画像初稿、推进确认、汇报结果 |
| 编排层 | forge job 状态机（`forge.expert.create` / `forge.expert.learn`） | 五步状态机 + 断点续跑 + 预算护栏，跑在 agentGateway job 运行时（可查进度/取消/重试，红线 5） |
| 能力层 | 检索端口 / 蒸馏端口 / 合成端口 / 判卷端口 | 检索走 toolInvoker 调搜索插件；蒸馏/合成/判卷走 llmCompletion + 提示词模板；Jev 对照走 typesafe-ai |
| 存储层 | 画像 JSON / 原始材料存档 / `knowledge/` TDB / `Agent/*.txt` + `agent_map.json` / 权限与引导配置 / 学习档案 | 见 §3 各数据结构 |

### 2.3 复用清单（零/极少改动）

| 现有能力 | 用途 |
|---|---|
| TDBKnowledge 文件监听（`upsertFile`） | 知识文件写入 `knowledge/` 后自动索引，**不需要新写入通道** |
| AgentManager 热更新（`agent_map.json` watcher） | 注册新 agent 不重启、不写新代码 |
| `mcp_agent_knowledge_policy.json` 受限库白名单 | 新知识库默认只对新专家开放（D5 已定），沿用付鹏观点库模式 |
| agentGateway job 运行时（`gateway_job_get/cancel`） | 长任务进度查询/取消/重试 |
| `ports/llmCompletion.js` | 蒸馏、合成、出题、判卷的 LLM 调用 |
| `ports/toolInvoker.js` | 调用搜索插件 |
| AnySearch / FlashDeepSearch / BrowserSearch 等插件 | 检索与网页抓取，多插件 fallback |
| taskScheduler（`routes/taskScheduler.js`） | 定期进修的定时触发 |
| infra/auditLogger | 全流程审计事件 |

### 2.4 新建清单

1. 专家画像 schema + 读写校验（§3.1）；
2. forge job 编排：五步状态机 + 断点续跑 + 预算护栏（§3.2）；
3. 五个提示词模板：蒸馏 / 出题 / 判卷 / 人设合成 / （Jev 维度定义）（§3.4–§3.7）；
4. 铸造师 agent 人设（对话入口角色）；
5. 缺口登记：新 MCP 工具 `gateway_gap_report` + 缺口数据文件（§3.8）；
6. 学习档案与定时进修任务（§3.8）。

## 3. 详细设计

### 3.1 专家画像（blueprint）

**文件位置**：`Agent/forge/blueprints/<name>.json`

**Schema**：

```json
{
  "name": "UIDesigner",                  // 专家名 = agent 名 = agent_map 键；知识库名派生自 name
  "displayName": "UI 设计专家",
  "scope": {
    "responsibilities": ["落地页/UI 界面设计评审", "组件规范建议", "配色与排版方案"],
    "boundaries": ["不做前端代码实现", "不做人机交互研究"]
  },
  "subskills": [
    {
      "id": "color-theory",
      "title": "配色理论",
      "searchQueries": ["color theory UI design", "配色理论 界面设计"],
      "sourceHints": ["官方文档优先", "经典书籍优先"]
    }
  ],
  "sourcePolicy": {
    "preferOfficialDocs": true,
    "minDomainsPerSubskill": 3,
    "qualityFilter": "丢弃营销软文/无实质内容/严重过时内容，丢弃理由留档"
  },
  "examOutline": [
    { "subskillId": "color-theory", "conceptQuestions": 1, "appliedQuestions": 1 }
  ],
  "practicalExam": {
    "prompt": "为一个 SaaS 落地页产出设计方案",
    "gradingDimensions": ["眼前一亮", "去 AI 味", "可落地"]
  },
  "acceptanceSample": "能给出一份眼前一亮、去AI味的 UI 设计图",
  "budget": { "maxModelCostCny": 10 }
}
```

**校验规则**：
- `name` 非空、合法文件名字符，且**不得与 `agent_map.json` 现有条目或现有 `Agent/` 文件冲突**（冲突即暂停待人工确认，红线 3）；
- `subskills` 非空，每项 `searchQueries` 非空；
- `budget.maxModelCostCny` 缺省取默认值 10（Q2 已确认）；
- `examOutline` 必须覆盖全部 `subskills`。

### 3.2 铸造 job 编排

**job 类型**：
- `forge.expert.create`：全量铸造（五步）；
- `forge.expert.learn`：增量学习（scope = 缺口或主题，仅跑采集→提炼，可带时间过滤）。

**五步状态机**（`forge.expert.create`）：

| 步骤 | 名称 | 产物 | 用户门禁 |
|---|---|---|---|
| 1 | blueprint | 画像 JSON | **是**：画像初稿生成后 job 转 `pending_confirm`，用户确认后才继续 |
| 2 | harvest | `raw/` 原始材料 + meta | 否 |
| 3 | distill | `knowledge/<库名>/` 知识文件 | 否 |
| 4 | synthesize | `Agent/<name>.txt` + agent_map 行 + 权限/引导配置 | 重名冲突时暂停待确认 |
| 5 | trial | 考卷 + 答卷 + 判分报告 + 缺口清单 | 及格后提示用户抽查（D3） |

**断点续跑**：每步产物落盘即视为完成；job 重试时检测已完成步骤并跳过，**只重跑失败步骤**（不从头烧钱重来）。

**进度上报**：复用 job 运行时的 progress 事件，事件体携带 `{step, detail, costSoFarCny}`。

**预算护栏**（Q2 已确认，M1.S2 T3）：
- 每次 llmCompletion / toolInvoker 调用后，按模型单价表累计估算费用；
- 累计 ≥ 90% 上限：发 `budget.warning` 审计事件，继续执行；
- 累计 ≥ 100% 上限：job 自动转 `paused_budget`，携带已花费明细，等待用户确认续跑（可上调本次预算）或终止。

### 3.3 检索与抓取（harvest）

- **插件调用**：toolInvoker 端口，优先顺序 AnySearch → FlashDeepSearch → BrowserSearch，前一个失败/空结果时 fallback 到下一个；
- **来源多样性**：同一 subskill 至少 `minDomainsPerSubskill`（默认 3）个不同域名来源，官方文档域名优先加权；
- **原始材料存档**（D6 已定：永久保留）：forge 工作目录（`Agent/forge/runs/<jobId>/raw/<subskillId>/`）下每份材料一个文件 + 元数据：

```json
{ "url": "https://...", "fetchedAt": "2026-10-10T21:00:00+08:00", "contentHash": "sha256:...", "plugin": "AnySearch" }
```

- **抓取礼貌**（红线 6）：同域名请求间隔 ≥ 2 秒；优先使用搜索插件返回的摘要/正文，不做整站爬取。

### 3.4 蒸馏（distill）

- **模板**：`Agent/forge/templates/distill.md`。输入：subskill 定义 + 该 subskill 的原始材料集合；输出：知识单元 JSON 数组（`type ∈ {concept, methodology, checklist, case, pitfall}`）。
- **分流规则**（D2 已定：混合）：
  - `methodology` / 体系性内容 → 系列长文档：`knowledge/<库名>/NN_<主题>.md`（如 `01_设计原则.md`，同「VCP知识」库的组织方式）；
  - `concept` / `checklist` / `case` / `pitfall` → 知识卡：`knowledge/<库名>/K_<subskillId>_<slug>.md`。
- **知识卡文件头**（红线 4：可溯源）：

```markdown
---
title: 一句话标题
oneLiner: 一句话摘要
type: checklist
subskill: color-theory
sources:
  - url: https://...
    fetchedAt: 2026-10-10T21:00:00+08:00
tags: [配色, 对比度]
---
（正文）
```

- **去重合并**：标题相似 + LLM 同义判断 → 合并为一张卡，`sources` 取并集（多来源同义 → 一卡多出处）；
- **质量过滤**：每来源 LLM 评估质量分，低于阈值丢弃，丢弃记录 `{url, reason}` 留档；
- **入库验证**：文件写入后由 TDB watcher 自动索引（`upsertFile` 路径）；验证方式为写后用 `gateway_knowledge_search` 冒烟查询新库。

### 3.5 人设合成（synthesize）

- **模板**：`Agent/forge/templates/synthesize.txt`。生成结构（对齐 `Agent/coding/Nexus.txt` 的成熟范式）：
  1. 身份定义（name/role/version，作者标注 ForgeMaster 铸造）；
  2. 核心设定（职责边界，来自画像 `scope`）；
  3. **MCP 工具调用强制规范**（Q3 已定：外部 MCP 客户端）：所有 gateway 工具调用显式传 `agentId: "<name>"`；
  4. **知识库调用纪律**：接手问题先 `gateway_knowledge_search`（显式 `libraries: ["<库名>"]`），答完标注知识出处；发现知识不足时调用 `gateway_gap_report` 登记缺口（§3.8）；
  5. 子技能清单与考试标准（来自画像）。
- **重名门禁**（红线 3）：`agent_map.json` 已存在同名键或 `Agent/` 下已有同名文件 → job 暂停 `pending_confirm`，提示改名或人工明确覆盖；**默认绝不覆盖**。

### 3.6 注册与配置绑定

| 目标 | 操作 | 验证 |
|---|---|---|
| `agent_map.json` | 追加 `"<name>": "forge/<name>.txt"` | 不重启 server，AgentManager watcher 生效 |
| 知识库权限（D5 已定：默认受限） | `modules/agentGateway/config/mcp_agent_knowledge_policy.json` 增 `restrictedLibraries["<库名>"] = { "allowedAgents": ["<name>"] }` | 其他 agentId 检索该库返回 403 |
| 引导配置 | `agent_guidance.json` 增新专家条目，绑定专属知识库 | bootstrap 渲染包含知识库指引 |

### 3.7 试岗与判卷（trial）

- **出题**（模板 `templates/examine.md`）：按考纲每个 subskill ≥ 2 题（1 概念 + 1 应用），另加 1 道**实操题**（Q5 已确认）——「为 SaaS 落地页产出设计方案/设计图」，评分维度含**眼前一亮、去 AI 味、可落地**；
- **盲测执行**：被考 agent 的可用工具白名单只含 `gateway_knowledge_search`（禁一切记忆读写工具，呼应红线 1）；
- **判卷**（D3 + D7 已定）：
  - 主判：LLM 模板 `templates/grade.md`，维度 = 正确性 / 完整性 / 专业性 / 去 AI 味 / 可落地，各 0–5 分 + 评语 + 引用到的知识卡；
  - 及格线：总分 80%；**到线才请用户抽查**，不及格不推送用户、直接进回填；
- **Jev 对照试点**（D7 方案 C，M4.S2 T2）：同一批考卷用 typesafe-ai Jev 做类型化复判——维度定义为类型化判断 `isProfessional / isAiFlavored / isActionable`（各带置信概率）；LLM 分数与 Jev 判决**双双落档**：`Agent/forge/runs/<jobId>/exams/comparison.json`；对比数据稳定且确有收益后再切换主判引擎（本期不切换）；
- **缺口回填**：不及格维度映射为缺口清单 → 生成 `forge.expert.learn` 定向任务（scope = 缺口 subskills）→ 回填后对同一套考题重测。

### 3.8 持续学习（lifelong）

- **缺口登记**：新增 MCP 工具 `gateway_gap_report`（第 9 个 gateway 工具）：

```
参数：{ agentId, subskillId, question, whyInsufficient }
行为：向 forge/<name>/gaps.json 追加一条缺口（id/时间/status=open），并触发审计事件 gap.reported
```

  专家人设中的知识库调用纪律写明：低置信或答不好时调用该工具登记缺口。三种进修触发（D4 已定：三种都要）：

| 触发 | 实现 | 里程碑 |
|---|---|---|
| a. 缺口驱动 | gaps.json 中 status=open 的条目 → `forge.expert.learn`（scope=gap） | M5.S1 |
| b. 手动指令 | 用户对铸造师说「去学一下 XX」→ 解析为增量学习任务 | M5.S1 |
| c. 定期进修 | taskScheduler 周任务（默认 weekly，配置项可调），带时间过滤（只检索上次学习后的新增内容） | M5.S2 |

- **增量入库纪律**（红线 3）：增量学习只新增/合并知识卡，**不删除、不修改既有旧卡**（除非来源明确撤回）；
- **学习档案**：`forge/<name>/learning-history.jsonl` 追加 `{ts, trigger, scope, sources, distilledFiles}`——读过什么、学过什么、为什么学，全部可查。

### 3.9 审计与安全

- **审计事件**（沿用 auditLogger）：`forge.job.started / forge.step.completed / forge.budget.warning / forge.budget.paused / forge.agent.registered / forge.library.restricted / forge.exam.graded / forge.gap.reported / forge.learn.completed`；
- **红线 1 的技术保障**：铸造 job 与盲测的工具白名单均不含 `gateway_memory_write` 等记忆写工具；审计日志可证明全程零记忆写入；
- **零 secret 校验**（红线 2）：人设 txt、知识卡、报告落盘前过模式检查（`sk-[A-Za-z0-9]{20,}`、`Bearer `、`token=`、`.env` 内容形态），命中即阻断落盘并告警。

## 4. 任务分解

> 编号连续不复用；task 中 §x.x 指向本文档详细设计章节，执行者必须回读原章节。

### M1：铸造流水线骨架——先有图纸和车间
依赖：无。目标：画像格式定稿，铸造任务可在 job 运行时上运行（查进度/取消/重试/预算护栏）。

#### M1.S1 专家画像（蓝图）定义与落盘
依赖：无
- [ ] T1 定义画像 JSON schema 与校验规则（§3.1）
- [ ] T2 画像文件读写与校验工具函数（§3.1）
- [ ] 验收：给定「UI 设计专家」一句话需求，能产出一份通过全部校验规则的画像文件（含默认预算 10 元）

#### M1.S2 铸造任务编排（复用 job 运行时）
依赖：M1.S1
- [ ] T1 `forge.expert.create` 五步状态机：blueprint → harvest → distill → synthesize → trial（§3.2）
- [ ] T2 进度上报 + 步骤产物落盘判定 + 失败步骤单独重试（断点续跑，§3.2）
- [ ] T3 预算护栏：逐环节累计模型调用费用，≥90% 告警、≥100% 自动暂停并附已花费明细（§3.2，Q2）
- [ ] 验收：发起只跑 blueprint 步骤的测试 job，能查询进度、能取消、失败后能只重试该步骤；预算护栏触发时 job 自动转 `paused_budget` 且事件携带费用明细

### M2：知识采集与提炼——专家的「课本」从无到有
依赖：M1 全部。目标：单 subskill 关键词端到端完成 搜索→抓取→蒸馏→入库，入库后语义可查。

#### M2.S1 检索与抓取端口
依赖：M1.S2
- [ ] T1 搜索插件调用封装：AnySearch → FlashDeepSearch → BrowserSearch 顺序 fallback + 来源多样性约束（每 subskill ≥3 域名）（§3.3）
- [ ] T2 原始材料永久存档：URL + 时间戳 + 内容哈希 + 插件名（D6，§3.3）
- [ ] 验收：对一个 subskill 关键词取回 ≥3 个不同域名的原始材料并落盘，每份带完整元数据

#### M2.S2 蒸馏器：原始材料 → 知识文件 → 自动上架
依赖：M2.S1
- [ ] T1 蒸馏提示词模板，按内容性质分流（D2 混合）：methodology/体系 → 系列长文档；concept/checklist/case/pitfall → 知识卡（§3.4）
- [ ] T2 去重合并（多来源同义 → 一卡多出处）+ 质量过滤（差源丢弃、理由留档）（§3.4）
- [ ] T3 知识文件写入 `knowledge/<库名>/`，验证 TDB watcher 自动索引生效（§3.4）
- [ ] 验收：蒸馏完成后 `gateway_knowledge_search` 在新库中查到知识点，每个知识卡带 ≥1 条出处（URL + 抓取时间）

**里程碑门禁**：
- [ ] 用真实小领域（如「配色理论」）完整跑一遍 采集→提炼→入库→可检索

### M3：专家合成与注册——专家「入职」
依赖：M2 全部。目标：第一个「UI 设计专家」端到端可对话、可查库、权限边界正确。

#### M3.S1 人设合成
依赖：M2.S2
- [ ] T1 人设合成模板：身份 + 职责边界 + MCP 强制规范（显式 agentId）+ 知识库调用纪律章节（按外部 MCP 客户端规范，同 Nexus.txt 模式）（§3.5，Q3）
- [ ] T2 重名冲突检测与人工确认门禁（默认绝不覆盖已有 agent，§3.5、红线 3）
- [ ] 验收：生成的 txt 含「知识库调用纪律」章节且 agentId 规范正确；`gateway_agent_bootstrap` 后自我介绍与画像 scope 一致

#### M3.S2 注册与配置绑定
依赖：M3.S1
- [ ] T1 `agent_map.json` 自动登记，验证热更新生效（不重启，§3.6）
- [ ] T2 知识库权限绑定（默认只对新专家开放，D5）+ 引导配置写入（§3.6）
- [ ] 验收：新专家经 MCP 完成一次 `gateway_knowledge_search` 成功；换任一其他 agentId 检索该受限库返回 403

**里程碑门禁**：
- [ ] 「UI 设计专家」端到端：对话可用 + 查到自己的知识库 + 权限边界正确

### M4：试岗验收——上岗考试与定向补课
依赖：M3 全部。目标：专家的专业度可被考试证明，判卷链路含 Jev 对照试点。

#### M4.S1 出题与盲测
依赖：M3.S2
- [ ] T1 出题官模板：按考纲生成考题（每 subskill ≥1 概念题 + 1 应用题），含实操题「产出 SaaS 落地页设计方案」，评分维度含「眼前一亮、去 AI 味」（§3.7，Q5）
- [ ] T2 盲测执行：被考 agent 工具白名单仅 `gateway_knowledge_search`（§3.7）
- [ ] T3 打分报告：LLM 判卷（D7 第一步），维度 0–5 分 + 评语 + 知识卡引用；到及格线（80%）才请用户抽查（D3）（§3.7）
- [ ] 验收：一份含每题得分、依据、缺口清单的验收报告落盘且用户可读

#### M4.S2 缺口回填与 Jev 对照试点
依赖：M4.S1
- [ ] T1 缺口清单 → `forge.expert.learn` 定向学习任务（只补缺口，不推倒重来）（§3.7）
- [ ] T2 Jev 对照试点：同一批考卷用 Jev 类型化复判（isProfessional / isAiFlavored / isActionable + 置信概率），LLM 与 Jev 分数双双留档 `exams/comparison.json`（D7 方案 C，§3.7）
- [ ] 验收：回填后对同一套考题重测弱项分数提升；Jev 对照判分的对比档案落盘可查

### M5：持续学习——上岗后越用越强
依赖：M4 全部。目标：学习闭环成立——发现不足 → 定向进修 → 增量入库 → 留档可查。

#### M5.S1 缺口标记与手动进修
依赖：M4.S2
- [ ] T1 新增 MCP 工具 `gateway_gap_report` + gaps.json 登记格式（§3.8）
- [ ] T2 手动学习指令：「去学一下 XX」→ 铸造师解析为 `forge.expert.learn` 增量任务（§3.8，D4）
- [ ] 验收：对话中标记的一个缺口生成并完成一次增量学习；新增知识卡入库且既有旧卡未被删除/修改

#### M5.S2 定期进修与学习档案
依赖：M5.S1
- [ ] T1 定时进修任务（taskScheduler，默认 weekly 可配），带「上次学习后新增内容」时间过滤（§3.8，D4）
- [ ] T2 学习历史档案 `learning-history.jsonl`：时间/触发/范围/来源/产出文件（§3.8）
- [ ] 验收：手动触发一次「周更」，知识库出现新增知识卡且学习历史有对应记录

## 5. 约束与红线

1. **专业技能只进冷知识库，绝不写进记忆日记本**：铸造流程与盲测的工具白名单均不含记忆写工具；记忆本记「经历」，知识库存「本事」，两条线永不交叉（技术保障见 §3.9）。
2. **生成物零密钥**：人设 txt、知识卡、验收报告中不得出现任何 API key / token / 密码 / .env 内容；落盘前过模式检查并阻断（§3.9）。
3. **绝不自动覆盖已有 agent / 已有知识库**：重名冲突暂停待人工确认；增量学习只新增/合并知识卡，不删旧卡（除非来源明确撤回）。
4. **来源可追溯，无法溯源不入库**：每张知识卡必须带出处链接与抓取时间；LLM 自生成无来源的「知识」不允许入库——宁可缺，不可编。
5. **长任务必须可停、可查、可重试**：铸造/进修一律跑 job 运行时；随时查进度、取消；失败步骤单独重试，不从头烧钱重来。
6. **抓取讲礼貌**：遵守目标站点 robots 与频率限制（同域 ≥2s 间隔），不做压力爬虫；优先复用搜索插件的摘要/正文。

## 6. 验收标准（系统级，全部可判定）

1. 一句话「造一个 UI 设计专家」→ `forge.expert.create` 全流程完成，产物齐全：画像 JSON、原始材料存档、`knowledge/` 知识文件、`Agent/<name>.txt`、agent_map 登记行、权限与引导配置；
2. `gateway_knowledge_search(agentId=<新专家>, libraries=[<新库>])` 返回带出处（URL + 时间）的知识条目；
3. 任选其他 agentId 检索该受限库，返回 403；
4. 试岗验收报告落盘：每题得分 + 依据 + 缺口清单；实操题评分维度含「眼前一亮、去 AI 味」；
5. 审计日志证明全程零 `gateway_memory_write` 调用（红线 1 可证）；
6. 模拟费用超限场景：job 在预算上限处自动转 `paused_budget` 且事件携带费用明细；
7. 对全部生成物执行 secret 模式扫描，零命中；
8. 手动进修指令触发一次增量学习：新增知识卡入库、既有旧卡 diff 为空；
9. Jev 对照判分档案存在且与 LLM 分数并排可查。

## 7. 已确认的决策记录

| # | 决策 | 结论 | 理由 | 轮次 |
|---|---|---|---|---|
| D1 | 操作入口形态 | 方案 A：对话式（铸造师 agent） | 与现有 MCP 工具形态最搭，见效最快；面板后补 | R2 |
| D2 | 知识格式与粒度 | 方案 C：混合——方法论/体系用长文档，事实/清单/案例/常见错误用知识卡 | 两种内容性质不同，按性质选容器 | R2 |
| D3 | 试岗验收判卷 | 方案 C：先自动判卷、到及格线才请用户抽查 | 自动过滤不合格候选，用户时间只花在值得看的候选上 | R2 |
| D4 | 持续学习触发 | 方案 A：缺口驱动 + 定期刷新 + 手动指令三种都要 | 覆盖即时缺口与领域动态；分两步实现（M5.S1 → M5.S2） | R2 |
| D5 | 新知识库默认权限 | 方案 A：默认只对生成的新专家开放 | 沿用受限库白名单模式；避免未验收知识污染其他 agent；验收后可显式开放 | R2 |
| D6 | 原始材料保留 | 方案 A：全部永久保留 | 可追溯、可复检；蒸馏配方升级可「重熬」不用重新爬 | R2 |
| D7 | 打分引擎 | 方案 C：先 LLM 判卷跑通，Jev 做类型化对照试点，分数留档对比后再决定切换 | 不赌技术路线，数据说话（来自用户 D3 备注） | R3 |

**需求画像补充确认（R2）**：首个试点 = UI 设计专家（Q1）；费用护栏 = ≤10 元/次（Q2）；主要渠道 = 外部 MCP 客户端（Q3）；来源策略 = 系统自动找 + 质量过滤兜底（Q4 未填写，按默认落实）；及格线样例 = 眼前一亮、去 AI 味的设计图（Q5）。

## 8. 风险与开放问题

**风险**：

| # | 风险 | 缓解 |
|---|---|---|
| R1 | LLM 蒸馏失真/幻觉知识混入库 | 红线 4 强制出处；质量过滤丢弃留档；判卷引用知识卡可回查；用户抽查兜底 |
| R2 | 搜索/蒸馏费用超预算 | 预算护栏逐环节累计，≥100% 自动暂停（§3.2） |
| R3 | 单一搜索插件失效 | 检索端口多插件 fallback（§3.3） |
| R4 | Jev 试点效果不确定 | D7 方案 C 本身即对照实验设计，对比档案落盘，数据说话 |
| R5 | TDB watcher 索引延迟或失败 | M2.S2 T3 与门禁（可检索冒烟）覆盖；失败时重试 upsertFile |
| R6 | 判卷维度中「去 AI 味」主观性强 | LLM 维度定义 + Jev 类型化复判双轨留档，长期校准 |

**开放问题**：
1. 定期进修默认周期（weekly）为配置项默认值，上线后按实际效果调整；
2. Jev 对照试点若证明稳定，主判引擎切换的判定标准（一致性阈值）在 M4.S2 试点时用对比数据现场确定；
3. 铸造师 agent 人设（ForgeMaster）的具体措辞在 M1 实现时以 Nexus.txt 为范式起草，首版上线前人工审阅一次。
