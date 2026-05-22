# VCP Agent Gateway Recall Profile 配置指南

> **版本**: M001 | **生成日期**: 2026-05-22 | **语言**: 中文

---

## 概述

### Recall Profile 是什么

Recall Profile 是 VCP Agent Gateway 的**召回策略配置文件**，以结构化 JSON 格式定义每个 Agent 从日记本中检索记忆的规则。它替代了此前分散在 Agent System Prompt 中的 DSL 表达式（如 `[[角色日记本::Time::Group::Rerank]]`），将召回策略集中管理为可版本控制、可自动迁移的配置。

### 为什么需要 Recall Profile

| 问题 | Recall Profile 解决方案 |
|------|------------------------|
| DSL 表达式散落在多个 Agent 的 System Prompt 中，难以维护 | 集中在 `recall_profiles.json`，一个文件管理所有 Agent 的召回规则 |
| 新增 Agent 或修改召回策略需要手工编辑 System Prompt | 修改 Profile 配置即可，无需触碰 Prompt 模板 |
| 无法为同一 Agent 提供多套召回策略（如快速模式 vs 深度检索） | 每个 Agent 可拥有多个 Profile，通过 `defaultProfile` 切换 |
| 从旧配置 (`mcp_agent_memory_policy.json`) 迁移成本高 | 提供 `migrate-to-recall-profiles.js` 自动迁移脚本 |

### 系统架构位置

```
agentGateway/
├── config/
│   ├── recall_profiles.json          ← Profile 配置（本指南核心）
│   ├── recall_profiles.json.example  ← 配置模板
│   └── mcp_agent_memory_policy.json  ← 旧配置（迁移源）
├── recallProfileResolver.js          ← Profile 解析与规则规范化
└── recallRuntimeService.js           ← Profile 运行时执行引擎
```

---

## DSL 语法速查

VCPToolBox 回忆系统使用 4 种括号模式和 9 种修饰符构建召回表达式。

### 四种括号模式

| 语法 | 类型 | 说明 | 门控阈值 |
|------|------|------|---------|
| `{{日记本名}}` | `full_text` | 无条件全文注入该日记本全部内容 | 无 |
| `[[日记本名]]` | `rag` | 基于向量相似度的 RAG 片段检索 | 无 |
| `<<日记本名>>` | `gated_full_text` | 先判断相关性，达标后再注入全文 | 默认 0.35 |
| `《《日记本名》》` | `gated_rag` | 先判断相关性，达标后执行 RAG 检索 | 默认 0.35 |

**gated 模式说明**：`gated_full_text` 和 `gated_rag` 先计算用户查询与被召回日记本的向量相似度，仅当相似度 ≥ `gateThreshold`（默认 0.35）时才执行实际召回，避免无关日记本的干扰。

### 多日记本聚合

使用 `|` 分隔多个日记本名称，同时从多个日记本中检索：

```
[[日记本1|日记本2|日记本3]]
《《日记本1|日记本2:1.5》》
```

### K 值乘数

使用 `:数字` 调整 RAG 检索的片段数量：

```
[[日记本:1.5]]     # 检索量 ×1.5
[[日记本:0.5]]     # 检索量减半
[[日记本1|日记本2:1.2]]  # 多日记本聚合 + 乘数
```

> K 乘数仅在 `rag` 和 `gated_rag` 模式中有实际效果，但对所有模式均可语法解析。

### 九种修饰符

| 修饰符 | 语法示例 | 说明 |
|--------|---------|------|
| **Time** | `::Time` | 时间感知检索：解析用户 query 中的时间表达（如"上周"、"三个月前"），执行时间-语义双路召回 |
| **Group** | `::Group` | 语义组增强：将查询向量与预定义语义组向量加权融合，提升概念级检索精度 |
| **Rerank** | `::Rerank` / `::Rerank+0.7` | 外部 Rerank 模型精排；`+` 变体使用 RRF 加权融合（数值为 Reranker 权重） |
| **TimeDecay** | `::TimeDecay30/0.5/box归档` | 时间衰减评分：对旧内容施加指数衰减（半衰期天/最低分/标签白名单） |
| **TagMemo** | `::TagMemo` / `::TagMemo+0.3` | Tag 匹配加权 Boost；`+` 变体额外激活测地线重排 |
| **Truncate** | `::Truncate0.4` | 截断过滤：剔除分数低于阈值的检索结果 |
| **AIMemo** | `::AIMemo` / `::AIMemo:Preset` | AI 驱动记忆召回：将候选片段发送给外部 AI 模型进行推理筛选 |
| **RoleValve** | `::RoleValve(@User>=2&@Assistant<5)` | 角色阀门：基于对话中角色消息数量进行条件阻断 |
| **Base64Memo** | `::Base64Memo` | 从检索结果中提取 Base64 附件链接 |

### 完整组合示例

```
[[小克日记本:1.2::Time::Group::TagMemo+0.3::Rerank+0.7::Truncate0.4]]
```

含义：从"小克日记本"检索，K 值 ×1.2，启用时间感知 + 语义组增强 + TagMemo（权重 0.3，测地线重排）+ RRF 加权 Rerank（α=0.7）+ 截断阈值 0.4。

---

## DSL→Profile 映射表

以下展示 DSL 表达式与对应 JSON Profile Rule 输出的对照关系。

| # | DSL 表达式 | 编译后的 Profile Rule |
|---|-----------|----------------------|
| 1 | `{{角色日记本}}` | `{ "type": "full_text", "diaries": ["角色日记本"], "kMultiplier": 1.0, "modifiers": {} }` |
| 2 | `[[角色日记本]]` | `{ "type": "rag", "diaries": ["角色日记本"], "kMultiplier": 1.0, "modifiers": {} }` |
| 3 | `<<角色日记本>>` | `{ "type": "gated_full_text", "diaries": ["角色日记本"], "gateThreshold": 0.35, "kMultiplier": 1.0, "modifiers": {} }` |
| 4 | `《《角色日记本》》` | `{ "type": "gated_rag", "diaries": ["角色日记本"], "gateThreshold": 0.35, "kMultiplier": 1.0, "modifiers": {} }` |
| 5 | `[[角色日记本::Time::Group::Rerank]]` | `{ "type": "rag", "diaries": ["角色日记本"], "kMultiplier": 1.0, "modifiers": { "time": true, "group": true, "rerank": { "enabled": true, "weight": 0.5 } } }` |
| 6 | `[[小克日记本:1.2::Time::Group::TagMemo+0.3::Rerank+0.7::Truncate0.4]]` | `{ "type": "rag", "diaries": ["小克日记本"], "kMultiplier": 1.2, "modifiers": { "time": true, "group": true, "tagMemo": { "enabled": true, "weight": 0.3, "geodesic": true }, "rerank": { "enabled": true, "weight": 0.7 }, "truncate": { "enabled": true, "threshold": 0.4 } } }` |
| 7 | `[[Diary1\|Diary2\|Diary3]]` | `{ "type": "rag", "diaries": ["Diary1", "Diary2", "Diary3"], "kMultiplier": 1.0, "modifiers": {} }` |
| 8 | `《《Diary1\|Diary2:0.5》》` | `{ "type": "gated_rag", "diaries": ["Diary1", "Diary2"], "gateThreshold": 0.35, "kMultiplier": 0.5, "modifiers": {} }` |

---

## DSL 编译器用法

DSL 编译器位于 `scripts/recall-dsl-compiler.js`，提供 4 个导出函数。

### 程序化 API

```javascript
const {
  parseDslExpression,
  dslToProfile,
  dslExpressionsToConfig,
  dslSyntaxToProfile,
} = require('./scripts/recall-dsl-compiler.js');
```

### parseDslExpression(dslString)

解析单个 DSL 表达式为结构化 rule 对象。

```javascript
// 成功 → { rule: {...}, error: null }
const result = parseDslExpression('[[角色日记本::Time::Group::Rerank]]');
console.log(result.rule.type);       // "rag"
console.log(result.rule.diaries);    // ["角色日记本"]
console.log(result.rule.modifiers);  // { time: true, group: true, rerank: { enabled: true, weight: 0.5 } }

// 失败 → { rule: null, error: "..." }
const bad = parseDslExpression('{{未闭合');
console.log(bad.error);  // "Unclosed brackets: expected "}}" to close "{{""
```

**返回值**：`{ rule: object | null, error: string | null }`

- 成功：`rule` 包含 `{ type, diaries, kMultiplier, gateThreshold?, modifiers, meta }`
- 失败：`rule` 为 `null`，`error` 为描述性错误信息

### dslToProfile(expressions, agentName)

将 DSL 表达式数组编译为完整 agent profile 配置段。

```javascript
const result = dslToProfile(
  ['[[Nexus日记本::Time::Group]]', '[[Nexus架构设计日记本]]'],
  'Nexus'
);

console.log(result);
// {
//   "Nexus": {
//     "defaultProfile": "nexus-default",
//     "profiles": {
//       "nexus-default": {
//         "rules": [
//           { "type": "rag", "diaries": ["Nexus日记本"], "modifiers": { "time": true, "group": true }, ... },
//           { "type": "rag", "diaries": ["Nexus架构设计日记本"], "modifiers": {}, ... }
//         ]
//       }
//     }
//   },
//   "warnings": []
// }
```

**返回值**：`{ [agentName]: config, warnings: [{ index, expression, error }] }`

- `warnings` 数组记录解析失败的表达式（索引、原始表达式、错误信息），不阻断整体编译

### dslExpressionsToConfig(expressions, agentName)

`dslToProfile` 的便利包装，直接返回 agent config 对象。

```javascript
const config = dslExpressionsToConfig(
  ['[[Diary1]]', '[[Diary2]]'],
  'MyAgent'
);

// config = {
//   defaultProfile: "myagent-default",
//   profiles: {
//     "myagent-default": { rules: [...] }
//   }
// }
```

### dslSyntaxToProfile(dslString, agentName)

快速将单个 DSL 字符串转换为 profile 配置。

```javascript
const result = dslSyntaxToProfile('{{角色日记本}}', 'RoleAgent');

// 成功 → { RoleAgent: { ... }, rules: [...] }
// 失败 → { error: "..." }
```

### 命令行快速验证

编译器模块可在 Node.js REPL 中快速验证：

```bash
$ node -e "
const { parseDslExpression } = require('./scripts/recall-dsl-compiler.js');
const r = parseDslExpression('[[日记本::Time::Group::Rerank+0.7]]');
console.log(JSON.stringify(r.rule, null, 2));
"
```

---

## 配置迁移指南

### 从 mcp_agent_memory_policy.json 迁移

旧配置文件 `modules/agentGateway/config/mcp_agent_memory_policy.json` 使用 `defaultDiaries` 字段定义每个 Agent 可用日记本。迁移脚本自动将这些配置转换为 `recall_profiles.json` 结构。

### 迁移步骤

#### 步骤 1：预览迁移结果（dry-run）

```bash
node scripts/migrate-to-recall-profiles.js --dry-run
```

此命令仅输出迁移报告到 stdout，**不写入任何文件**。报告包含每个 Agent 的当前配置摘要和推荐 Profile 预览。

输出示例：

```
━━━ Migration Report (dry-run) ━━━

Agent: Nexus
  Current defaultDiaries:
    - Nexus日记本
    - Nexus架构设计日记本
    - Nexus工程方法论日记本
    - Nexus避坑指南日记本
  Recommended Profile: nexus-default
  Rules: 1 rule (rag) covering 4 diaries
  Recommended modifiers: Time, Group, Rerank

Agent: MCPMidas
  Current defaultDiaries:
    - 迈达斯日记本
  Recommended Profile: mcpmidas-default
  Rules: 1 rule (rag) covering 1 diary
  Recommended modifiers: Time, Group, Rerank

━━━ End of Report ━━━
```

#### 步骤 2：写入建议配置

```bash
node scripts/migrate-to-recall-profiles.js --write
```

生成 `modules/agentGateway/config/recall_profiles.json.suggested` 文件。**不会覆盖现有的 `recall_profiles.json`**。

#### 步骤 3：人工审核与合并

1. 打开 `recall_profiles.json.suggested`，检查自动生成的规则
2. 根据实际需求调整 `modifiers`（默认全部禁用，需手动启用推荐修饰符）
3. 如需多个 Profile（如 `default` + `deep-search`），手动添加
4. 将审核后的配置合并到 `recall_profiles.json`

#### 步骤 4：指定单个 Agent 迁移

```bash
# 仅迁移 Nexus
node scripts/migrate-to-recall-profiles.js --agent Nexus --write

# 迁移多个指定 Agent
node scripts/migrate-to-recall-profiles.js --agent Nexus --agent MCPMidas --dry-run
```

### CLI 参数一览

| 参数 | 说明 | 默认 |
|------|------|------|
| `--dry-run` | 仅输出迁移报告，不写文件 | 默认行为 |
| `--write` | 写入 `recall_profiles.json.suggested` | 不启用 |
| `--agent <name>` | 仅迁移指定 Agent（可多次使用） | 迁移全部 |

---

## Profile 配置结构

### recall_profiles.json Schema

```json
{
  "agents": {
    "<AgentName>": {
      "defaultProfile": "<profile-name>",
      "profiles": {
        "<profile-name>": {
          "rules": [
            {
              "type": "<rule-type>",
              "diaries": ["<diary-name>"],
              "kMultiplier": 1.0,
              "gateThreshold": 0.35,
              "modifiers": {
                "time": true | false,
                "group": true | false,
                "rerank": { "enabled": true, "weight": 0.5 },
                "tagMemo": { "enabled": true, "weight": 0.5, "geodesic": false },
                "timeDecay": { "enabled": true, "halfLife": 30, "minScore": 0, "whitelistTags": [] },
                "truncate": { "enabled": true, "threshold": 0.5 },
                "aiMemo": { "enabled": true, "preset": "default" },
                "roleValve": { "enabled": true, "expression": "@User>=2&@Assistant<5" },
                "base64Memo": true | false
              }
            }
          ]
        }
      }
    }
  }
}
```

### 字段说明

#### 顶层结构

| 字段 | 类型 | 必需 | 说明 |
|------|------|------|------|
| `agents` | object | 是 | 以 Agent 名为 key 的配置映射 |

#### Agent 配置

| 字段 | 类型 | 必需 | 说明 |
|------|------|------|------|
| `defaultProfile` | string | 是 | 默认使用的 Profile 名称，必须存在于 `profiles` 中 |
| `profiles` | object | 是 | 该 Agent 的所有 Profile，以 Profile 名为 key |

#### Profile 配置

| 字段 | 类型 | 必需 | 说明 |
|------|------|------|------|
| `rules` | array | 是 | 召回规则数组，按顺序执行 |

#### Rule 配置

| 字段 | 类型 | 必需 | 说明 |
|------|------|------|------|
| `type` | string | 是 | 召回类型：`full_text`、`rag`、`gated_full_text`、`gated_rag` |
| `diaries` | string[] | 是 | 目标日记本名称数组，至少包含 1 个 |
| `kMultiplier` | number | 否 | K 值乘数，默认 `1.0`，必须 > 0 |
| `gateThreshold` | number | 条件 | 门控阈值，仅 `gated_*` 类型需要，范围 `0.0` ~ `1.0`，默认 `0.35` |
| `modifiers` | object | 否 | 修饰符配置，未指定的修饰符视为禁用 |
| `meta` | object | 否 | 元数据，包含 `warnings` 数组 |

#### 修饰符详情

**布尔类型修饰符**（`time`、`group`、`base64Memo`）：

```json
"time": true
"group": false
"base64Memo": true
```

**Rerank 修饰符**：

```json
"rerank": {
  "enabled": true,
  "weight": 0.7     // RRF 权重，范围 0.0-1.0，仅 Rerank+ 变体有意义
}
```

**TagMemo 修饰符**：

```json
"tagMemo": {
  "enabled": true,
  "weight": 0.3,     // Tag 匹配权重，范围 0.0-1.0
  "geodesic": true   // 是否激活测地线重排
}
```

**TimeDecay 修饰符**：

```json
"timeDecay": {
  "enabled": true,
  "halfLife": 30,              // 半衰期天数
  "minScore": 0.5,             // 衰减后最低保留分数
  "whitelistTags": ["box归档"]  // 仅对指定标签生效（空数组 = 全部生效）
}
```

**Truncate 修饰符**：

```json
"truncate": {
  "enabled": true,
  "threshold": 0.4    // 截断阈值，范围 0.0-1.0
}
```

**AIMemo 修饰符**：

```json
"aiMemo": {
  "enabled": true,
  "preset": "default"   // AIMemo 预设名称，对应 MoreAIMemoPresets/*.json
}
```

**RoleValve 修饰符**：

```json
"roleValve": {
  "enabled": true,
  "expression": "@User>=2&@Assistant<5"   // 角色消息数量条件表达式
}
```

**RoleValve 表达式语法**：
- 比较运算符：`<`、`>`、`<=`、`>=`、`=`
- 逻辑运算符：`&`（AND）、`|`（OR）
- 角色标识：`@User`、`@Assistant`、`@System`

### 配置约束

| 约束 | 说明 |
|------|------|
| `type` 必须是 4 种之一 | `full_text`、`rag`、`gated_full_text`、`gated_rag` |
| `diaries` 不可为空 | 至少包含 1 个日记本名称 |
| `gateThreshold` 仅限 gated 类型 | `full_text` 和 `rag` 类型不应包含此字段 |
| `gateThreshold` 范围 | `0.0` ~ `1.0` |
| `kMultiplier` > 0 | K 乘数必须为正数 |
| `defaultProfile` 必须存在 | Agent 的默认 Profile 名称必须在 `profiles` 中注册 |

### 完整配置示例

```json
{
  "agents": {
    "Nexus": {
      "defaultProfile": "nexus-default",
      "profiles": {
        "nexus-default": {
          "rules": [
            {
              "type": "rag",
              "diaries": ["Nexus日记本", "Nexus架构设计日记本"],
              "kMultiplier": 1.0,
              "modifiers": {
                "time": true,
                "group": true,
                "rerank": { "enabled": true, "weight": 0.5 },
                "tagMemo": { "enabled": true, "weight": 0.5, "geodesic": false },
                "truncate": { "enabled": true, "threshold": 0.3 }
              }
            }
          ]
        },
        "nexus-deep": {
          "rules": [
            {
              "type": "rag",
              "diaries": ["Nexus日记本", "Nexus架构设计日记本", "Nexus工程方法论日记本", "Nexus避坑指南日记本"],
              "kMultiplier": 2.0,
              "modifiers": {
                "time": true,
                "group": true,
                "rerank": { "enabled": true, "weight": 0.7 },
                "tagMemo": { "enabled": true, "weight": 0.5, "geodesic": true }
              }
            }
          ]
        }
      }
    },
    "Aemeath": {
      "defaultProfile": "aemeath-gated",
      "profiles": {
        "aemeath-gated": {
          "rules": [
            {
              "type": "gated_rag",
              "diaries": ["Aemeath日记本"],
              "gateThreshold": 0.35,
              "modifiers": {
                "group": true,
                "tagMemo": { "enabled": true, "weight": 0.5, "geodesic": false },
                "truncate": { "enabled": true, "threshold": 0.3 }
              }
            }
          ]
        }
      }
    }
  }
}
```

---

## 相关文件

| 文件 | 用途 |
|------|------|
| `scripts/recall-dsl-compiler.js` | DSL 编译器（parseDslExpression + Profile 生成器） |
| `scripts/migrate-to-recall-profiles.js` | 配置迁移脚本 |
| `tests/s04/test-dsl-compiler.js` | DSL 编译器测试（91 个用例） |
| `tests/s04/test-migration.js` | 迁移脚本测试（20 个用例） |
| `modules/agentGateway/config/recall_profiles.json` | 实际 Profile 配置 |
| `modules/agentGateway/config/recall_profiles.json.example` | Profile 配置模板 |
| `modules/agentGateway/config/mcp_agent_memory_policy.json` | 旧配置（迁移源） |
| `Plugin/RAGDiaryPlugin/RECALL_METHODS.md` | DSL 语法完整参考 |
