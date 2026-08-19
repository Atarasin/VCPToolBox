# Nexus 跨项目记忆改造方案

> 版本：v1 | 日期：2026-08-19 | 状态：已定稿 | 评审轮次：2 轮
> 人读版（评审草图）：.doc-visualizer-output/2026-08-19_Nexus跨项目记忆改造.html

## 1. 目标与范围

**目标**：将编码助理 Nexus（人格文件 `Agent/coding/Nexus.txt`，经 Agent Gateway 的 MCP 链路使用）的记忆体系从"仅 4 本按知识类型划分的通用日记"改造为"项目日记 + 通用日记"双轨分层，消除跨项目工作时的记忆互串。

**范围内**：

- M1：重写 `Agent/coding/Nexus.txt`（提示词 2.0）
- M2：Agent Gateway 日记白名单的尾通配支持（代码改动 + 测试）
- M3：接入首个项目 VCPToolBox，更新两份配置并验证完整闭环

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

## 4. 任务分解

| 编号 | 任务 | 类型 | 依赖 |
|---|---|---|---|
| M1 | 重写 `Agent/coding/Nexus.txt` 2.0（§1~§5） | 文档 | 无 |
| M2 | 通配符改造 + 测试（3.1） | 代码 | 无（可与 M1 并行） |
| M3 | 接入 VCPToolBox 验证闭环（3.2 全部配置 + `.nexus-project` + 实际会话验证） | 配置+验证 | M1、M2 |
| ~~M4~~ | ~~存量迁移~~ | — | 已取消（D5：不做迁移，用户自行清理） |

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

## 7. 已确认的决策记录

- **D1 = 方案 B（第 2 轮）**：直接实现白名单通配，不做"纯配置过渡"。落选：A（白名单随项目数膨胀）、C（分两趟无必要）。
- **D2 = 方案 B（第 2 轮）**：通用日记精简为 2 本——`Nexus工程经验日记本`（方法论 + 避坑 + 协作偏好）、`Nexus架构设计日记本`（纯架构）。注：与草图原分组（"架构 + 个人"）有出入——协作偏好归入工程经验本；该微调在第 2 轮草图中已向用户明示，定稿前未收到异议。
- **D3 = 方案 A（第 2 轮）**：项目日记命名 `Nexus项目-<项目名>日记本`。落选：B（`Nexus-*` 前缀会罩住通用本）、C（无前缀无法收敛白名单）。
- **D4 = 方案 C（第 2 轮）**：项目根 `.nexus-project` 标记文件；缺失时 git 根目录名推导 + 建议补建。落选：A（目录名不规范时推错）、B（每次显式告知易遗漏）。
- **D5 = 方案 B（第 2 轮）**：不做存量迁移；用户备注自行全部清理 → 原 M4 取消。
- **Q1 = VCPToolBox（第 2 轮）**：首个接入项目。
- **Q2 = 仅 MCP 链路（第 2 轮）**：不改聊天链路配置。

## 8. 风险与开放问题

**已排查雷区（实现时规避）**：

1. `gateway_recall_run` 的 profile 为静态名单，无法含项目日记 → prompt 铁律：项目召回必须走显式 `diaries` 的两个工具。
2. 日记名精确匹配，错字即 403 → 报错携带允许清单，prompt 教 Nexus 照清单改名自愈。
3. "日记本"后缀自动等价仅限运行时，配置交叉校验不吃这套 → 配置文件统一带"日记本"后缀。
4. 标记文件缺失或中途换目录 → 推导 + 建议补建；目录变化重新定位项目。
5. 混搜时通用本分数易盖过项目本 → 固定分两次召回，项目本先行。

**开放问题**：

- 多项目并行会话时通用本的召回噪音（项目本隔离已解决；通用本混搜暂可接受，后续可按需调 `minScore`）。
- `.nexus-project` 是否提交进 git 由各项目自行决定（建议提交，团队共享同一项目名）。
