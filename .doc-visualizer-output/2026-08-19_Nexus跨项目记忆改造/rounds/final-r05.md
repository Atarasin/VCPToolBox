# Nexus 跨项目记忆改造方案

> 版本：v3 | 日期：2026-08-21 | 状态：已定稿 | 评审轮次：4 轮
> 人读版（评审草图）：.doc-visualizer-output/2026-08-19_Nexus跨项目记忆改造.html
> v2 变更：第 3 轮补上"提示词分发链路"（2.5 / 3.4 / M4 / AC7）——Nexus.txt 不会自动进入编码客户端的模型上下文，必须显式分发。
> v3 变更：第 4 轮补上"skill 生成器对通配日记的呈现"（3.5 / M5 / AC8 / 雷区 7）——M2 只让门禁认识通配符，生成器仍把 `Nexus项目-*` 当固定日记名渲染，配置层无解。

## 1. 目标与范围

**目标**：将编码助理 Nexus（人格文件 `Agent/coding/Nexus.txt`，经 Agent Gateway 的 MCP 链路使用）的记忆体系从"仅 4 本按知识类型划分的通用日记"改造为"项目日记 + 通用日记"双轨分层，消除跨项目工作时的记忆互串。

**范围内**：

- M1：重写 `Agent/coding/Nexus.txt`（提示词 2.0）
- M2：Agent Gateway 日记白名单的尾通配支持（代码改动 + 测试）
- M3：接入首个项目 VCPToolBox，更新两份配置并验证完整闭环
- M4：提示词分发链路接入（v2 新增）——`agent_guidance.json` 条目 + 客户端 skill 生成安装 + 凭据绑定验证，解决"模型如何拿到 Nexus.txt"
- M5：skill 生成器通配呈现（v3 新增）——让导出的 SKILL.md 把项目日记表达为"按项目实例化的模板"，而不是一个字面固定名

**范围外**：

- 存量日记清理：由用户自行全部处理（D5），本方案不碰任何既有日记
- VCP 聊天链路（系统提示词 + 占位符自动召回）：Q2 已确认 Nexus 仅走 MCP 链路，不在本次范围

## 2. 总体设计 / 架构

### 2.1 分层结构（自上而下）

| 层 | 组成 | 职责 |
|---|---|---|
| 提示词层 | `Agent/coding/Nexus.txt` 2.0 | 项目定位 → 显式召回 → 双轨写入路由 |
| 工具层 | Agent Gateway MCP 工具 | `gateway_memory_write` / `gateway_memory_search` / `gateway_context_assemble` / `gateway_recall_run` |
| 门禁层 | `modules/agentGateway/config/mcp_agent_memory_policy.json` | 每 agent 可访问日记的白名单；mtime 热加载；本次新增尾通配支持 |
| 存储层 | `dailynote/<日记名>/` | 每本日记一个目录；DailyNote 插件写入时 `fs.mkdir(recursive)` 自动建目录 |

### 2.2 日记分层与命名

| 类别 | 名称 | 内容 |
|---|---|---|
| 项目日记 | `Nexus项目-<项目名>日记本` | 项目架构事实、构建/测试命令、代码约定、历史决策及理由、环境坑、进行中的工作 |
| 通用日记 | `Nexus工程经验日记本` | 跨项目可复用的工程方法论、避坑经验、协作偏好（合并原：工程方法论 + 避坑指南 + 个人经历） |
| 通用日记 | `Nexus架构设计日记本` | 系统架构、设计模式、模块划分、技术选型（纯架构） |

项目名来源：项目根目录的 `.nexus-project` 标记文件（单行文本，仅含项目名）。

### 2.3 写入路由（双轨分流）

产出一条经验时：

1. 判断"离开本项目是否还有用"：
   - **仅本项目有意义** → 写入 `Nexus项目-<项目名>日记本`，记具体事实。
   - **跨项目可复用** → 先泛化（剥离项目名、路径、端口等具体细节，提炼为模式/方法论），写入通用本（"怎么干活"→ 工程经验本；"怎么设计"→ 架构设计本）；项目内的具体上下文值得留档时，可双写一份到项目本。
2. 通用本禁止出现项目细节（红线 R1）。

### 2.4 召回路由（固定顺序）

1. 读 `<项目根>/.nexus-project` 得项目名；文件缺失时以 `git rev-parse --show-toplevel` 的 basename 推导，并建议用户补建标记文件。
2. 第一次召回：`gateway_memory_search`（或 `gateway_context_assemble`），显式 `diaries=["Nexus项目-<项目名>日记本"]`——项目事实优先。
3. 第二次召回：显式 `diaries=["Nexus工程经验日记本","Nexus架构设计日记本"]`——通用经验补充。
4. `gateway_recall_run` 仅用于通用泛检索（其 profile 为静态名单，不含项目日记）。

### 2.5 提示词分发链路（Nexus.txt 如何到达模型，v2 新增）

Nexus.txt **不会被自动注入**编码客户端的模型上下文；到达模型的完整链路为四环节：

| 环节 | 机制 | 现状 |
|---|---|---|
| 源文件 | `agent_map.json` 映射 `"Nexus": "coding/Nexus.txt"`，`agentRegistryService` 加载源文件 | 已就绪 |
| 渲染 | bootstrap/render 操作时 `agentPromptRenderer` 渲染：变量替换 + 按 `query` 从日记本/冷知识库检索片段注入 | 已就绪 |
| 模型调用入口 | `gateway_agent_bootstrap`（MCP 工具，模型可自行调用）返回 `renderedPrompt`；`gateway_agent_render` 是 MCP prompt 面（用户手打的斜杠命令，模型无法主动调用），不用作正门 | 已就绪 |
| 触发面（让模型知道该调） | ① MCP 握手 `initialize.instructions` per-request 摘要（凭据绑定 Nexus 后含专属指引，由 `agentGuidanceService` 驱动）；② 客户端 skill：`GET /agent_gateway/agents/Nexus/integration/skill?format=claude\|codex\|kimi` 生成（产物 SKILL.md + INSTALL.md + manifest.json；触发词来自 `agent_guidance.json` 的 `agents.Nexus.skill` 配置块）。skill 生成器对通配日记的呈现由 M5 补齐（3.5） | 触发面已接入（M4），生成器呈现缺陷待 M5 修复 |

模型侧标准动作（skill 正文约定）：会话首次实质回答前调 `gateway_agent_bootstrap { "query": "<用户问题原文>" }`；返回以 `GATEWAY NOTICE` 开头 = 渲染降级，带 `query` 重调一次；话题切换时重调（检索按问题重跑）。

## 3. 详细设计

### 3.1 代码改动（M2）：白名单尾通配

**文件**：`modules/agentGateway/policy/mcpAgentMemoryPolicy.js`
**函数**：`areDiaryNamesEquivalent(left, right)`

**现状**：仅支持"日记本"后缀等价（`buildDiaryAliasCandidates` 生成带/不带后缀两个候选）。

**改法**：任一参数以 `*` 结尾时，将该侧视为模式：模式侧与匹配侧分别经 `normalizeDiaryCanonicalName` 归一化（剥离"日记本"后缀）后执行前缀匹配。例：模式 `Nexus项目-*` → 前缀 `Nexus项目-`；`Nexus项目-VCPToolBox日记本` 归一化为 `Nexus项目-VCPToolBox`，`startsWith` 命中。

**实现注意**：

- 两个调用点传参顺序不一致：`diaryScopeGuard.isDiaryAllowed` 以 `(allowed, requested)` 调用；`diaryPolicyGate.applyDiaryPolicyGate` 以 `(requested, allowed)` 调用。因此匹配逻辑必须对"哪一侧带 `*` 哪一侧是模式"做对称处理。
- 前缀收敛（红线 R4）：通配模式仅允许 `Nexus项目-` 前缀。在 `mcpAgentMemoryPolicy.js` 内实现允许前缀常量（如 `ALLOWED_WILDCARD_PREFIXES = ['Nexus项目-']`），模式不在白名单内则不匹配任何名字；不扩散到其他文件。
- 模块约定遵循 `modules/AGENTS.md`：CommonJS 导出，错误边界显式，不引入 ESM-only 依赖。
- 已知遗漏面：M2 只让门禁认识通配符，skill 生成器的呈现未同步 → 见 3.5（M5）。

**不需要改动的文件**：

- `modules/agentGateway/protocols/mcp/diaryPolicyGate.js`（搜索门禁）与 `modules/agentGateway/policy/diaryScopeGuard.js`（写入门禁）：均只调用 `areDiaryNamesEquivalent`，自动继承新能力。
- 召回配置校验链（`recallProfileResolver`）：项目日记不进 profile rule，无需改动。

**测试**（`tests/agent-gateway/policy/` 下新增或扩展）：

1. 精确匹配回归：原有等价与后缀行为不变；
2. `Nexus项目-*` 放行 `Nexus项目-VCPToolBox日记本`（带后缀与不带后缀两种写法均覆盖）；
3. 跨前缀拒绝：`Nexus项目X-Foo日记本` 不匹配 `Nexus项目-*`；
4. 非白名单前缀通配拒绝：`Nexus-*` 不匹配任何名字；
5. 既有 policy 测试套件整体通过（403 报错仍携带允许清单，自愈提示不回归）。

### 3.2 配置变更（M3）

**① `modules/agentGateway/config/mcp_agent_memory_policy.json`**：

```json
"Nexus": {
  "maid": "Nexus",
  "allowedDiaries": [
    "Nexus工程经验日记本",
    "Nexus架构设计日记本",
    "Nexus项目-*"
  ],
  "defaultDiaries": [
    "Nexus工程经验日记本",
    "Nexus架构设计日记本"
  ]
}
```

`Nexus项目-*` 一行覆盖所有现在和未来的项目日记（新项目零配置）；`defaultDiaries` 只放 2 本通用本，项目召回永远显式指定（见 8.1 雷区 1）。

**② `modules/agentGateway/config/recall_profiles.json`**：

- `agents.Nexus.targets` 改为 `["Nexus工程经验日记本", "Nexus架构设计日记本"]`；
- `profiles.nexus-default.rules[0].targets.diaries` 同步改为这两本；其余 modifiers 不动。

**③ 项目根标记文件**：`<项目根>/.nexus-project`，内容为单行项目名。VCPToolBox 项目内容为 `VCPToolBox`。

以上两份 JSON 配置均按 mtime 热加载，保存即生效，无需重启服务。

### 3.3 Nexus.txt 2.0（M1）

章节结构（完整重写 `Agent/coding/Nexus.txt`）：

- **§1 项目定位**：开工先读 `<项目根>/.nexus-project`（单行项目名）；文件缺失则从 git 根目录名推导，并建议用户补建该文件；对话中途工作目录变化 = 重新定位。
- **§2 回忆纪律**：先单独翻项目本、再翻 2 本通用本，分两次显式调用（`gateway_memory_search` / `gateway_context_assemble`，携带 `agentId: "Nexus"`）；`gateway_recall_run` 仅用于通用泛检索。
- **§3 写入分流**：双轨路由（2.3）；通用本 2 选 1；双写条款；通用本禁项目细节（红线 R1）。
- **§4 命名规范**：项目日记固定 `Nexus项目-<项目名>日记本`；被门禁拒绝（403）时按报错中 `allowedDiaries` 清单改名重试。
- **§5 标签规范**：项目日记条目带类型标签：`#架构` `#命令` `#约定` `#决策` `#坑`。
- **删除**：旧版"必须脱离具体项目局限"条款，及旧的 4 本日记路由表（`Nexus日记本` / `Nexus架构设计` / `Nexus工程方法论` / `Nexus避坑指南`）。

### 3.4 提示词分发链路接入（M4，v2 新增）

**① `modules/agentGateway/config/agent_guidance.json` 增加 Nexus 条目**（驱动 `initialize.instructions` 摘要与 skill 生成）：

```json
"Nexus": {
  "displayName": "Nexus",
  "memoryDefaults": {
    "tags": ["nexus", "coding"],
    "metadata": { "project": "multi-project", "source": "mcp-client" }
  },
  "workflow": [
    "新会话首次实质回答前、以及话题切换时，先调 gateway_agent_bootstrap 并把用户当前问题原文放进 query；返回带 GATEWAY NOTICE 时带 query 重调一次。",
    "按 Nexus.txt §1 完成项目定位（读 .nexus-project）后，先翻项目日记本再翻通用日记本，分两次显式调用 gateway_memory_search / gateway_context_assemble。",
    "会话收尾或得出确定结论时按双轨路由写入：项目事实进项目本，泛化经验进通用本。"
  ],
  "skill": {
    "domain": "跨项目编码辅助",
    "triggers": [
      "在任意代码仓库中做开发、调试、重构或架构设计",
      "需要 Nexus 既往的项目约定、决策记录或踩坑记录"
    ],
    "notFor": ["与编码无关的纯聊天或一次性问答"],
    "writeTargets": [
      { "diary": "Nexus项目-<项目名>日记本", "when": "沉淀仅本项目有意义的架构事实、命令、约定、决策与坑时" },
      { "diary": "Nexus工程经验日记本", "when": "得出跨项目可复用的方法论、避坑经验或协作偏好时（先泛化）" },
      { "diary": "Nexus架构设计日记本", "when": "做出可复用的架构决策、设计模式或技术选型结论时（先泛化）" }
    ]
  }
}
```

注意：`writeTargets` 是生成 skill 路由表的**指引文本**，门禁判定仍以 `mcp_agent_memory_policy.json` 为准；两套配置职责不同（见 8.2 开放问题）。项目日记行的 `diary` 故意写成模板名 `Nexus项目-<项目名>日记本`：它通过等价匹配挂到通配条目 `Nexus项目-*` 上，M5 修复后会被渲染为"动态模板行"（3.5）。

**② 生成并安装客户端 skill**：`GET /agent_gateway/agents/Nexus/integration/skill?format=<claude|codex|kimi>`（需绑定 Nexus 的凭据，或具 `allowedAgents`/`admin` scope 的凭据）。**导出必须在 M5 完成后进行**——否则路由表会出现字面 `Nexus项目-*` 行（3.5）。产物固定三文件：

| 文件 | 读者 | 内容 |
|---|---|---|
| `SKILL.md` | 模型 | 触发条件、标准动作（bootstrap → recall → write）与可照抄的调用体、日记本路由、失败语义、红线 |
| `INSTALL.md` | 人 | 放置路径、三客户端 MCP 注册片段、凭据从 secret store 取、`initialize` 验证 |
| `manifest.json` | 校验 | 文件哈希与 artifactId |

按 INSTALL.md 安装到目标编码客户端。生成物不含任何明文 token。

**③ 凭据绑定**：编码客户端连接 MCP 使用的凭据必须绑定 agentId `Nexus`。绑定后：所有 `gateway_*` 工具不传 `agentId`（传了也必须逐字一致）；`initialize.instructions` 才会渲染 Nexus 专属摘要。

**④ 验证**：连接后 `initialize.instructions` 应出现 `Nexus` 指引字样；出现的是通用文案说明凭据没有绑定该 agent。

### 3.5 skill 生成器的通配日记呈现（M5，v3 新增）

**问题确诊**（用当前真实配置在进程内复演 `renderDiaryRouting` 的输出）：

```
| 日记本 | 默认 | 什么时候写 |
| --- | --- | --- |
| Nexus工程经验 | ✓ | 得出跨项目可复用的方法论…… |
| Nexus架构设计 | ✓ | 做出可复用的架构决策…… |
| Nexus项目-* |  | 沉淀仅本项目有意义的架构事实…… |   ← 字面通配符被当成固定日记名
```

三处硬伤（`modules/agentGateway/services/skillGeneratorService.js`）：

1. **路由表按 `allowedDiaries` 全量原样渲染**（`renderDiaryRouting`）：通配条目 `Nexus项目-*` 以字面形式出现在表里，模型无法得知"项目名要按 `.nexus-project` 实例化"。
2. **硬编码尾注与动态命名直接矛盾**："写入表外的日记本会被拒（`AGW_FORBIDDEN`）……不要在调用里换名字重试"——项目日记的按项目实例化恰恰是"换名字"，且是合法行为。
3. **次生风险（雷区 7）**：字面名 `Nexus项目-*` 与通配条目精确等价，门禁会放行——模型若照表写入，会真实创建一本叫 `Nexus项目-*` 的垃圾日记本。

配置层无解（路由表数据源是门禁白名单本身），必须改生成器。

**改法**（仅 `skillGeneratorService.js`）：

- `renderDiaryRouting`：`allowedDiaries` 中以 `*` 结尾的条目不渲染为普通行；改用匹配到的 `writeTargets` 模板名（`Nexus项目-<项目名>日记本`）作行标签，标注"（动态：按 `.nexus-project` 的项目名实例化）"；无匹配模板时以通配前缀派生标签。
- 表尾注：存在通配条目时追加说明——"项目日记按命名规则实例化（`Nexus项目-<项目名>日记本`）属合法写入，实例化后的名字落在通配范围内即放行，不视为换名重试"。
- `renderHardRules` 的红线"不要……换日记本名重试"与 `renderFailureSemantics` 的 `AGW_FORBIDDEN` 行：存在通配条目时补同样的实例化例外（两个函数需传入通配感知参数）。
- 非通配 agent（如 MCPMidas）的输出必须逐字回归不变。

**测试**（`tests/agent-gateway/services/` 下 skill 生成相关用例）：

1. 含通配条目的 guidance：路由表项目日记行为模板形态 `Nexus项目-<项目名>日记本`，带"按项目实例化"标注；
2. 表尾注含实例化合法说明，且不再出现字面 `Nexus项目-*` 行；
3. 非通配 agent（MCPMidas）的生成输出逐字回归不变；
4. `writeTargets` 模板名能正确挂到通配条目上（`when` 文案不丢失）。

## 4. 任务分解

| 编号 | 任务 | 类型 | 依赖 |
|---|---|---|---|
| M1 | 重写 `Agent/coding/Nexus.txt` 2.0（§1~§5） | 文档 | 无 |
| M2 | 通配符改造 + 测试（3.1） | 代码 | 无（可与 M1 并行） |
| M3 | 接入 VCPToolBox 验证闭环（3.2 全部配置 + `.nexus-project` + 实际会话验证） | 配置+验证 | M1、M2 |
| M4 | 提示词分发链路接入（3.4：guidance 条目 + 凭据绑定；skill 导出安排在 M5 之后） | 配置+验证 | M1（bootstrap 渲染的源文件是 Nexus.txt，须先定稿） |
| M5 | skill 生成器通配呈现 + 测试（3.5） | 代码 | M2（通配匹配函数） |
| ~~M4 旧~~ | ~~存量迁移~~ | — | 已取消（D5：不做迁移，用户自行清理） |

## 5. 约束与红线

- **R1**：通用日记本禁止出现项目细节（具体路径、端口、内部命名、项目特有命令）；经验必须泛化后才能写入通用本。
- **R2**：日记命名固定为 `Nexus项目-<项目名>日记本`，禁止自造名称；名字不匹配白名单即 403，等于写入失败。
- **R3**：密钥、敏感信息禁止写入任何日记（Agent Gateway 全局规范）。
- **R4**：通配符仅允许 `Nexus项目-` 前缀；不得对其他 agent 放开，不得使用更宽模式（如 `Nexus-*`）。
- **R5**：不碰存量日记——不做删除或批量改写；存量清理由用户自行执行。

## 6. 验收标准

- **AC1（代码）**：`tests/agent-gateway/policy/` 相关测试全部通过，含 3.1 新增通配用例。
- **AC2（配置）**：两份配置保存后无需重启，`gateway_memory_write` 写入 `Nexus项目-VCPToolBox日记本` 返回成功（不 403）。
- **AC3（闭环）**：在 VCPToolBox 项目会话中写入项目本后，显式召回应命中刚写入的项目条目。
- **AC4（隔离）**：写入一条含项目细节的经验后，通用本召回结果中不出现该细节；通用本无新增项目细节条目。
- **AC5（定位）**：缺失 `.nexus-project` 时 Nexus 推导项目名并提示补建；创建后严格使用文件中的项目名。
- **AC6（prompt）**：Nexus.txt 2.0 不再存在"必须脱离具体项目局限"条款，包含 §1~§5 全部章节。
- **AC7（分发，v2 新增）**：绑定 Nexus 凭据连接后 `initialize.instructions` 含 Nexus 专属指引；编码客户端新会话中，模型在无手工指令时主动调用 `gateway_agent_bootstrap` 并取得含 §1~§5 的 `renderedPrompt`；skill 的 description 触发词命中编码场景。
- **AC8（skill 呈现，v3 新增）**：导出的 SKILL.md 路由表中项目日记以模板形态 `Nexus项目-<项目名>日记本` 呈现并明确"按项目实例化"；表尾注含实例化合法说明；全文不出现字面 `Nexus项目-*` 行；非通配 agent 的导出逐字回归不变。

## 7. 已确认的决策记录

- **D1 = 方案 B（第 2 轮）**：直接实现白名单通配，不做"纯配置过渡"。落选：A（白名单随项目数膨胀）、C（分两趟无必要）。
- **D2 = 方案 B（第 2 轮）**：通用日记精简为 2 本——`Nexus工程经验日记本`（方法论 + 避坑 + 协作偏好）、`Nexus架构设计日记本`（纯架构）。注：与草图原分组（"架构 + 个人"）有出入——协作偏好归入工程经验本；该微调在第 2 轮草图中已向用户明示，定稿前未收到异议。
- **D3 = 方案 A（第 2 轮）**：项目日记命名 `Nexus项目-<项目名>日记本`。落选：B（`Nexus-*` 前缀会罩住通用本）、C（无前缀无法收敛白名单）。
- **D4 = 方案 C（第 2 轮）**：项目根 `.nexus-project` 标记文件；缺失时 git 根目录名推导 + 建议补建。落选：A（目录名不规范时推错）、B（每次显式告知易遗漏）。
- **D5 = 方案 B（第 2 轮）**：不做存量迁移；用户备注自行全部清理 → 原 M4 取消。
- **Q1 = VCPToolBox（第 2 轮）**：首个接入项目。
- **Q2 = 仅 MCP 链路（第 2 轮）**：不改聊天链路配置。
- **第 3 轮（定稿后迭代）**：用户指出缺少"agent 如何获得 Nexus.txt 内容"的分发设计 → 补齐 2.5 / 3.4 / 新 M4 / AC7。机制采用 Agent Gateway 现成的 bootstrap + skill 生成体系，无新增待定决策。
- **第 4 轮（定稿后迭代）**：用户指出导出的 skill 中项目日记是写死的固定名 → 进程内复演确诊：生成器把通配条目当固定日记名渲染，且硬编码尾注禁止换名，配置层无解 → 新增 3.5 / M5 / AC8 / 雷区 7。无新增待定决策。

## 8. 风险与开放问题

**已排查雷区（实现时规避）**：

1. `gateway_recall_run` 的 profile 为静态名单，无法含项目日记 → prompt 铁律：项目召回必须走显式 `diaries` 的两个工具。
2. 日记名精确匹配，错字即 403 → 报错携带允许清单，prompt 教 Nexus 照清单改名自愈。
3. "日记本"后缀自动等价仅限运行时，配置交叉校验不吃这套 → 配置文件统一带"日记本"后缀。
4. 标记文件缺失或中途换目录 → 推导 + 建议补建；目录变化重新定位项目。
5. 混搜时通用本分数易盖过项目本 → 固定分两次召回，项目本先行。
6. `initialize.instructions` 只是增强而非唯一正确性机制（harness 注释明示，失败时回退通用文案）→ 触发的主承重墙是客户端 skill：`SKILL.md` 第一条指令必须是 bootstrap，description 触发词必须覆盖编码场景，否则客户端不加载 skill 时模型永远不知道要取回人格。
7. 字面名 `Nexus项目-*` 与通配条目精确等价、门禁会放行（v3 新增）→ 模型照字面写入会创建名为 `Nexus项目-*` 的垃圾日记本；M5 修复完成前不要导出/安装 Nexus 的 skill；若已有导出物在用，检查是否已产生该字面日记本。

**开放问题**：

- 多项目并行会话时通用本的召回噪音（项目本隔离已解决；通用本混搜暂可接受，后续可按需调 `minScore`）。
- `.nexus-project` 是否提交进 git 由各项目自行决定（建议提交，团队共享同一项目名）。
- `agent_guidance.json`（skill/instructions 指引文本）与 `mcp_agent_memory_policy.json`（门禁白名单）是两套配置：日记改名时两处都要改。
