# Recall Profile 配置指南

本文档说明 `recall_profiles.json` 的配置格式、规则类型、修饰符语义与最佳实践。

---

## 1. 文件位置与加载机制

| 项目 | 路径 |
|------|------|
| 运行时配置 | `modules/agentGateway/config/recall_profiles.json` |
| 示例模板 | `modules/agentGateway/config/recall_profiles.json.example` |

**加载特性：**
- 文件变更后**无需重启服务**，解析器按修改时间（mtime）自动缓存刷新。
- 配置缺失或 JSON 解析失败时，系统返回空配置（不会崩溃）。
- Agent ID 支持**别名解析**：resolver 会自动尝试 Agent 的多个别名映射，找不到时再回退到通配符 `*`。

---

## 2. 顶层结构

```json
{
  "agents": {
    "AgentName": {
      "defaultProfile": "profile-name",
      "profiles": {
        "profile-name": {
          "rules": [
            { /* rule 对象 */ }
          ]
        }
      }
    }
  }
}
```

| 字段 | 必填 | 说明 |
|------|------|------|
| `agents` | 是 | 顶层映射，键为 Agent 名称或别名。 |
| `defaultProfile` | 否 | 默认使用的 profile 名称；省略时取第一个 profile。 |
| `profiles` | 是 | 该 Agent 拥有的所有 profile 映射。 |
| `rules` | 是 | 单个 profile 内的召回规则数组，**至少一条**。 |

---

## 3. Rule 规则对象

每条 rule 定义一次召回行为。支持两种写法：

### 3.1 主推荐模式（Primary）— 结构化模型

```json
{
  "baseMode": "rag",
  "targets": {
    "diaries": ["日记本A", "日记本B"],
    "kMultiplier": 1.0
  },
  "projection": "items",
  "gateThreshold": 0.35,
  "modifiers": {
    "time": true,
    "group": true,
    "rerank": false,
    "tagMemo": true,
    "truncate": 20
  }
}
```

| 字段 | 必填 | 类型 | 说明 |
|------|------|------|------|
| `baseMode` | 是 | `string` | 规则类型，见下方「规则类型详解」。 |
| `targets` | 是 | `object` | 召回目标配置，必须包含 `diaries` 数组。 |
| `targets.diaries` | 是 | `string[]` | 要检索的日记本名称列表。 |
| `targets.kMultiplier` | 否 | `number` | 召回倍率乘数，默认 `1.0`。大于 1 扩大召回量，小于 1 缩小。 |
| `targets.aggregate` | 否 | `boolean` | 是否对该 rule 的结果做聚合去重。 |
| `projection` | 否 | `string \| object` | 结果投影模式。字符串如 `"items"`；对象写法 `{ "emit": "items" }`。默认不投影。 |
| `gateThreshold` | 条件必填 | `number` | **门控阈值**，仅 `gated_rag` / `gated_full_text` 需要。范围建议 `0.2 ~ 0.5`。 |
| `modifiers` | 否 | `object` | 召回修饰符配置，见下方「修饰符详解」。 |
| `meta` | 否 | `object` | 自定义元数据，透传给诊断信息。 |
| `id` | 否 | `string` | Rule 标识，用于诊断与日志追踪。 |

### 3.2 兼容 fallback（Legacy compatibility）

以下旧字段仍被兼容解析，但运行时会输出 **deprecation warning**：

| 旧字段 | 替代字段 | 说明 |
|--------|----------|------|
| `type` | `baseMode` | 规则类型，功能等价。 |
| `diaries` | `targets.diaries` | 日记本列表，功能等价。 |
| `kMultiplier` | `targets.kMultiplier` | 召回倍率，功能等价。 |

Legacy 示例（仍可用但不推荐）：
```json
{
  "type": "rag",
  "diaries": ["日记本A"],
  "modifiers": { "truncate": 20 }
}
```

### 3.3 规则类型详解

| 类型 | 召回深度 | 门控 | 适用场景 |
|------|----------|------|----------|
| `rag` | baseK=5（语义召回 Top 5） | ❌ | 标准语义检索，精确、快速。 |
| `gated_rag` | baseK=5 | ✅ | 先做 query 与日记本概念向量的余弦相似度判定，低于阈值则跳过该规则。 |
| `full_text` | baseK=20（更广覆盖） | ❌ | 需要更大范围内容召回，降低遗漏。 |
| `gated_full_text` | baseK=20 | ✅ | 大范围召回 + 门控过滤，兼顾覆盖与相关性。 |

**门控（Gate）机制：**
- 计算用户 query 的 embedding 与各日记本 concept vector 的余弦相似度。
- 取最大相似度与 `gateThreshold` 比较，**低于阈值则该规则不执行**（返回空结果）。
- 若日记本没有 concept vector（未建立或缓存缺失），门控**自动通过**（避免误杀）。
- 门控判定结果会写入诊断信息（`diagnostics.rules[].gatePassed`、`gateSimilarity`）。

---

## 4. Modifiers 修饰符详解

修饰符按固定流水线顺序执行，分为三个阶段：

```
[S01] collectRagItems 阶段修饰符
    → time → group → tagMemo → rerank
[S02] 后处理修饰符（在 collectRagItems 结果上运行）
    → timeDecay → roleValve → base64Memo
[全局] 结果合并与收尾
    → truncate（截断） → aiMemo（AI 摘要）
```

### 4.1 S01 修饰符（影响 collectRagItems）

这些修饰符映射到 `collectRagItems` 的 `ragOptions`，在向量检索阶段生效。

| 修饰符 | 取值类型 | 说明 |
|--------|----------|------|
| `time` | `boolean` | 启用**时间感知排序**，近期条目获得更高权重。 |
| `group` | `boolean` | 启用**语义组增强**，利用语义分组提升相关度。 |
| `rerank` | `boolean` | 启用**重排序**，对初筛结果做二次精排。 |
| `tagMemo` | `boolean` | 启用 **TagMemo** 标签增强，融入标签关联信息。 |

### 4.2 S02 修饰符（后处理）

这些修饰符在 `collectRagItems` 返回后、结果合并前运行。

| 修饰符 | 取值类型 | 说明 |
|--------|----------|------|
| `timeDecay` | `object \| boolean` | **时间衰减**，对 score 按指数衰减重新加权。配置为对象时：`{ "halfLifeDays": 30 }` 表示半衰期 30 天。 |
| `roleValve` | `string[]` | **角色过滤**，只保留指定角色的条目。例如 `["user", "assistant"]`。无 role 元数据的条目默认通过。 |
| `base64Memo` | `boolean` | **Base64 附件提取**，扫描条目中嵌入的 base64 数据（图片、文件等），提取到 `diagnostics.attachments`，原文替换为 `[base64-attachment]` 占位符。 |

### 4.3 全局修饰符

| 修饰符 | 取值类型 | 说明 |
|--------|----------|------|
| `truncate` | `number` | **结果截断**，指定最终返回的最大条目数。建议设置正整数如 `20`；非数字值（如 `true`）等价于不截断。**每条 rule 的 truncate 独立作用于该 rule 的召回结果**，不再取第一条 rule 的值作为全局截断。 |
| `aiMemo` | `boolean` | **AI 摘要**，在召回结果上调用外部 LLM 生成结构化中文摘要。需配置环境变量 `AIMemoUrl`、`AIMemoApi`、`AIMemoModel`。摘要结果放在 `diagnostics.summary`。 |

---

## 5. 完整配置示例

### 示例 1：标准语义召回（Nexus）

```json
{
  "agents": {
    "Nexus": {
      "defaultProfile": "nexus-default",
      "profiles": {
        "nexus-default": {
          "rules": [
            {
              "baseMode": "rag",
              "targets": {
                "diaries": ["Nexus日记本"],
                "kMultiplier": 1.0
              },
              "modifiers": {
                "time": true,
                "group": true,
                "rerank": true,
                "tagMemo": true,
                "truncate": 20
              }
            }
          ]
        }
      }
    }
  }
}
```

### 示例 2：门控召回 + 全文召回组合（Aemeath）

```json
{
  "agents": {
    "Aemeath": {
      "defaultProfile": "aemeath-gated",
      "profiles": {
        "aemeath-gated": {
          "rules": [
            {
              "baseMode": "gated_rag",
              "targets": {
                "diaries": ["Aemeath日记本"],
                "kMultiplier": 1.0
              },
              "gateThreshold": 0.35,
              "modifiers": {
                "group": true,
                "tagMemo": true,
                "truncate": 15
              }
            }
          ]
        },
        "aemeath-fulltext": {
          "rules": [
            {
              "baseMode": "full_text",
              "targets": {
                "diaries": ["Aemeath日记本"],
                "kMultiplier": 1.0
              },
              "modifiers": {
                "timeDecay": { "halfLifeDays": 30 },
                "roleValve": ["user", "assistant"],
                "base64Memo": true,
                "truncate": 50
              }
            }
          ]
        },
        "aemeath-gated-fulltext": {
          "rules": [
            {
              "baseMode": "gated_full_text",
              "targets": {
                "diaries": ["Aemeath日记本"],
                "kMultiplier": 1.0
              },
              "gateThreshold": 0.35,
              "modifiers": {
                "timeDecay": true,
                "base64Memo": true,
                "truncate": 50
              }
            }
          ]
        }
      }
    }
  }
}
```

### 示例 3：多日记本联合召回

```json
{
  "agents": {
    "Metis": {
      "defaultProfile": "metis-combined",
      "profiles": {
        "metis-combined": {
          "rules": [
            {
              "baseMode": "rag",
              "targets": {
                "diaries": ["Metis日记本", "公共知识库"],
                "kMultiplier": 1.0
              },
              "modifiers": {
                "time": true,
                "rerank": true,
                "truncate": 20
              }
            },
            {
              "baseMode": "full_text",
              "targets": {
                "diaries": ["归档日记本"],
                "kMultiplier": 1.0
              },
              "modifiers": {
                "timeDecay": { "halfLifeDays": 90 },
                "truncate": 10
              }
            }
          ]
        }
      }
    }
  }
}
```

**多 rule 的执行逻辑：**
- 各 rule **独立执行**，结果去重后合并。
- 所有 rule 共享同一个 query vector（预计算一次）。
- 每条 rule 的 `truncate` **独立作用于该 rule 的召回结果**。

### 示例 4：通配符 Fallback

```json
{
  "agents": {
    "*": {
      "defaultProfile": "default",
      "profiles": {
        "default": {
          "rules": [
            {
              "baseMode": "rag",
              "targets": {
                "diaries": ["通用日记本"],
                "kMultiplier": 1.0
              },
              "modifiers": {
                "time": true,
                "truncate": 10
              }
            }
          ]
        }
      }
    }
  }
}
```

当特定 Agent 没有配置时，回退到 `*` 的默认 profile。

---

## 6. 触发方式

配置完成后，Recall Profile 可通过以下方式触发：

### 6.1 HTTP API

```http
POST /api/agent-gateway/recall/run
Content-Type: application/json

{
  "agentId": "Aemeath",
  "query": "用户输入的查询内容",
  "profileName": "aemeath-fulltext"
}
```

- `profileName` 可省略，使用 `defaultProfile`。
- 返回结果中包含 `items`（召回条目）和 `diagnostics`（执行诊断）。

### 6.2 MCP 工具

通过 `gateway_recall_run` MCP 工具调用，参数与 HTTP API 一致。

---

## 7. 诊断信息解读

每次召回都会在 `diagnostics` 中返回详细诊断：

```json
{
  "diagnostics": {
    "totalDurationMs": 1250,
    "rules": [
      {
        "ruleIndex": 0,
        "type": "gated_rag",
        "status": "ok",
        "itemCount": 12,
        "gatePassed": true,
        "gateSimilarity": 0.62,
        "modifierDetails": [
          { "modifier": "timeDecay", "durationMs": 3, "inputCount": 12, "outputCount": 12 }
        ]
      }
    ],
    "pipelineStages": [
      { "name": "resolveProfile", "durationMs": 2, "status": "ok" },
      { "name": "precomputeVector", "durationMs": 450, "status": "ok" },
      { "name": "ruleExecution", "ruleIndex": 0, "durationMs": 780, "status": "ok" },
      { "name": "mergeResults", "durationMs": 5, "status": "ok" }
    ],
    "profileMeta": {
      "profileName": "aemeath-gated",
      "ruleCount": 1,
      "modifierKeys": ["group", "tagMemo", "truncate"]
    },
    "vectorPrecomputed": true,
    "attachments": [],
    "summary": null
  }
}
```

| 字段 | 含义 |
|------|------|
| `rules[].status` | `ok` / `gated`（被门控拦截）/ `error` |
| `rules[].gateSimilarity` | 门控计算的最大余弦相似度 |
| `pipelineStages` | 各阶段耗时，用于性能分析 |
| `vectorPrecomputed` | query vector 是否成功预计算 |
| `attachments` | base64Memo 提取的附件列表 |
| `summary` | aiMemo 生成的摘要（如启用） |

---

## 8. 最佳实践

1. **从简单开始**：先用 `rag` + `time` + `truncate` 验证基础链路，再逐步添加复杂修饰符。
2. **门控阈值调优**：`gateThreshold` 建议从 `0.35` 开始，根据实际拦截率调整。太高会过度拦截，太低失去门控意义。
3. **truncate 用整数**：推荐写成 `"truncate": 20` 这样的正整数；`true` 当前行为等价于不截断。
4. **full_text 慎用**：baseK=20 覆盖面广但可能引入噪声，建议搭配 `rerank` 或 `timeDecay` 做精排/衰减。
5. **多 rule 组合**：不同 diary 可用不同 rule 类型，例如核心日记本用 `gated_rag`，归档用 `full_text`。
6. **监控诊断**：关注 `diagnostics.rules[].status` 和 `gateSimilarity`，及时发现配置或数据问题。
7. **AI Memo 配置**：如需启用 `aiMemo`，在 `config.env` 中设置 `AIMemoUrl`、`AIMemoApi`、`AIMemoModel`。

---

## 9. 常见问题

**Q: 修改配置后需要重启服务吗？**
> 不需要。解析器按文件 mtime 自动刷新缓存。

**Q: `gateThreshold` 为 0 时门控还有效吗？**
> 任何 query 的余弦相似度都 ≥ 0，因此 `gateThreshold: 0` 等价于门控永远通过。

**Q: 为什么某条 rule 返回了 0 条结果？**
> 检查 diagnostics：
> - `status: "gated"` → query 与日记本概念向量相似度低于阈值。
> - `status: "error"` → collectRagItems 执行失败（如日记本不存在、权限不足）。

**Q: `full_text` 和 `rag` 有什么区别？**
> 两者都走相同的 `collectRagItems` 检索管线，区别在于 `full_text` 的 `baseK=20`（召回 20 条初筛结果），`rag` 的 `baseK=5`。`full_text` 覆盖面更大，适合需要更全面上下文但对精确度要求稍低的场景。

**Q: 可以同时给同一个 Agent 配置多个 profile 吗？**
> 可以。通过 `profileName` 参数在调用时切换；未指定时使用 `defaultProfile`。

---

## 10. 校验行为与错误码

Resolver 在解析 recall profile 时会对原始配置执行**前置校验**，非法配置不会静默降级为 `RECALL_NO_PROFILE`，而是返回明确的错误码与定位信息。

### 10.1 校验时机与范围

当 `resolveForAgent(agentId, profileName)` 被调用时，resolver 在规则归一化（normalization）之前先检查原始 rule 对象：

1. **Rule type 校验**：检查 `baseMode`（或兼容字段 `type`）是否为允许值。
2. **Modifier 校验**：检查 `modifiers` 中的每个键是否在允许列表内。
3. **Diary access 校验**：检查 rule 引用的日记本是否在 Agent 的 `targets` 白名单内（若 Agent 配置了 `targets`）。
4. **Profile 整体校验**：若以上单项校验全部通过，但归一化后 profile 没有任何有效 rule，则判定为 profile 级错误。

### 10.2 错误码列表

| 错误码 | 含义 | HTTP 映射 | 诊断字段 |
|--------|------|-----------|----------|
| `RECALL_INVALID_PROFILE` | Profile 整体无效（所有 rule 均非法或归一化失败） | `400` | `details.message` |
| `RECALL_INVALID_RULE` | 某条 rule 的 `type`/`baseMode` 不在允许列表 | `400` | `details.ruleIndex`, `details.ruleType`, `details.message` |
| `RECALL_INVALID_MODIFIER` | 某条 rule 包含未知 modifier 键 | `400` | `details.ruleIndex`, `details.invalidModifiers`, `details.message` |
| `RECALL_INVALID_DIARY` | 某条 rule 引用了 Agent 无权访问的日记本 | `403` | `details.ruleIndex`, `details.forbidden`, `details.message` |

### 10.3 错误响应示例

**非法 rule type：**
```json
{
  "resolved": false,
  "code": "RECALL_INVALID_RULE",
  "agentId": "AgentName",
  "profileName": "profile-name",
  "details": {
    "ruleIndex": 0,
    "ruleType": "semantic_search",
    "message": "Rule type \"semantic_search\" is not allowed"
  },
  "rules": []
}
```

**非法 modifier：**
```json
{
  "resolved": false,
  "code": "RECALL_INVALID_MODIFIER",
  "agentId": "AgentName",
  "profileName": "profile-name",
  "details": {
    "ruleIndex": 1,
    "invalidModifiers": ["unknownMod", "badFlag"],
    "message": "Invalid modifiers: unknownMod, badFlag"
  },
  "rules": []
}
```

**非法 diary：**
```json
{
  "resolved": false,
  "code": "RECALL_INVALID_DIARY",
  "agentId": "AgentName",
  "profileName": "profile-name",
  "details": {
    "ruleIndex": 0,
    "forbidden": ["Secret日记本"],
    "message": "Forbidden diaries: Secret日记本"
  },
  "rules": []
}
```

### 10.4 与 legacy 行为对比

在 S04 之前，非法 rule type 或未知 modifier 会在归一化阶段被**静默丢弃**（`normalizeRule` 返回 `null`），最终可能导致空 rules 数组，进而触发模糊的 `RECALL_NO_PROFILE`。现在这些错误在解析早期就被拦截，并返回**可预测的错误码和定位信息**，方便运维与配置调试。
