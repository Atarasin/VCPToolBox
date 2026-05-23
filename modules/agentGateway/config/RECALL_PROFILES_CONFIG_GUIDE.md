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
      "allowedProfiles": ["profile-name"],
      "targets": ["DiaryName日记本"]
    }
  },
  "profiles": {
    "profile-name": {
      "rules": [
        { /* rule 对象 */ }
      ]
    }
  }
}
```

| 字段 | 必填 | 说明 | 默认值 / 缺省行为 |
|------|------|------|------------------|
| `agents` | 是 | 顶层 Agent 绑定映射，键为 Agent 名称或别名。 | 无默认值。缺失时视为没有任何 Agent 绑定。 |
| `defaultProfile` | 否 | 默认使用的 profile 名称。 | 未设置时，优先取 `allowedProfiles` 的第一项；若也未设置，则回退到顶层 `profiles` 中的第一个可用项。 |
| `allowedProfiles` | 否 | Agent 允许使用的 profile 名称列表。 | 未设置时，表示允许使用该 Agent 可见的全部 profile。 |
| `targets` | 否 | Agent 允许访问的 diary 白名单。 | 未设置时，不额外限制 diary 访问范围。 |
| `profiles` | 是 | 顶层共享 profile 映射，Agent 通过 `defaultProfile/allowedProfiles` 绑定。 | 无默认值。缺失时视为没有可用 profile。 |
| `rules` | 是 | 单个 profile 内的召回规则数组，**至少一条**。 | 无默认值。空数组或全部 rule 归一化失败时，该 profile 视为无效。 |

### 2.1 Targets 语义说明

配置中有两层 `targets`，名称相同，但职责不同：

- `agents[].targets` 是 **Agent 级 diary 白名单**，表示这个 Agent 最多允许访问哪些 diary。
- `rules[].targets.diaries` 是 **rule 级实际检索目标**，表示这条 rule 本次要去哪些 diary 上执行召回。

可以把它们理解成：

- `agents[].targets` 管“**允许去哪**”
- `rules[].targets.diaries` 管“**这条 rule 实际去哪**”

两者关系：

1. `rules[].targets.diaries` 必须落在 `agents[].targets` 允许的范围内。
2. 如果 Agent 没有配置 `targets`，则不额外做 diary 白名单限制。
3. 如果 Agent 配了 `targets`，而 rule 使用了超出范围的 diary，resolver 会在前置校验阶段返回 `RECALL_INVALID_DIARY`。

示例：

```json
{
  "agents": {
    "Metis": {
      "defaultProfile": "metis-default",
      "allowedProfiles": ["metis-default"],
      "targets": ["Metis日记本", "公共知识库日记本"]
    }
  },
  "profiles": {
    "metis-default": {
      "rules": [
        {
          "baseMode": "rag",
          "targets": {
            "diaries": ["Metis日记本"],
            "kMultiplier": 1.0
          }
        }
      ]
    }
  }
}
```

上面的含义是：

- `Metis` 最多允许访问 `Metis日记本` 和 `公共知识库日记本`
- 当前这条 rule 实际只在 `Metis日记本` 上做召回

注意：

- `agents[].targets` 是访问控制边界，不是默认检索目标列表。
- `rules[].targets.diaries` 才是 recall profile 主链里真正决定检索落点的配置。
- 在 `memory/search`、`context/assemble` 这类兼容入口中，请求体里的 `diary/diaries` 也会参与目标选择，但仍然受 Agent 允许范围约束。

### 2.2 Diary 名称与“日记本”后缀

系统在**运行时检索阶段**会对 diary 名做别名归一化，并尽量对齐到系统里实际存在的 diary 名：

- 若输入与现有 diary 名完全一致，则直接使用该名称
- 若输入和某个现有 diary 名只差一个 `日记本` 后缀，则会自动视为等价
- 若当前拿不到可用 diary 列表，则内部 canonical 规范名会优先去掉 `日记本` 后缀保存

这意味着：

- `"Yui"` 和 `"Yui日记本"` 在运行时通常会被视为同一个 diary
- 但真正用于执行检索的最终名称，会尽量以系统里实际存在的 diary 名为准
- 项目里也可能存在**本身就不带 `日记本` 后缀**的真实 diary 名，例如某些业务专题库或学习笔记库

但要注意：

- 配置解析与 resolver 前置校验阶段，不应依赖运行时再去“帮你改名”
- 尤其在 `agents[].targets` 和 `rules[].targets.diaries` 中，如果两边命名风格不一致，前置校验仍可能把它们视为不一致配置

因此，**配置文件中建议始终使用系统里实际登记的 diary 名称**。大多数 diary 往往带有 `日记本` 后缀，但这不是强制规则。

例如，如果系统里真实存在的是：

```json
"targets": ["Yui日记本"]
```

那么 rule 中也写：

```json
"targets": {
  "diaries": ["Yui日记本"],
  "kMultiplier": 1.0
}
```

如果系统里真实存在的是一个**不带后缀**的名称，例如：

```json
"targets": ["迈达斯量化小论坛学习笔记"]
```

那么 rule 中也应保持同样写法，而不是机械补成：

```json
"targets": {
  "diaries": ["迈达斯量化小论坛学习笔记"],
  "kMultiplier": 1.0
}
```

推荐做法：

- API / MCP 请求入口里可以把带后缀或不带后缀的名称都视为“用户输入”，运行时通常会做等价匹配
- 配置文件里不要依赖这种补全行为，统一复用系统里**实际存在**的 diary 名称
- 最稳妥的方法是先从可用 diary 列表或现有配置中复制名称，而不是手写猜测

### 2.3 Profile 字段

| 字段 | 必填 | 类型 | 说明 | 默认值 / 缺省行为 |
|------|------|------|------|------------------|
| `rules` | 是 | `object[]` | 当前 profile 包含的 recall rules。 | 无默认值；至少需要一条有效 rule。 |
| `merge` | 否 | `string` | 多条 rule 结果的合并策略。 | 未设置时走默认合并逻辑：去重后按 score 排序。 |
| `aggregate` | 否 | `string` | 去重后重复条目的 score 聚合方式。 | 未设置时默认按 `max` 聚合。 |
| `projection` | 否 | `string \| object` | profile 级结果视图偏好。 | 未设置时回退到 rule-level `projection`；若 rule 也未设置，则运行时自动推断。 |
| `truncateTo` | 否 | `number` | profile 级最终结果上限。 | 未设置时不做 profile 级额外截断。 |
| `tokenBudget` | 否 | `number` | profile 级上下文 token 预算。 | 未设置时不启用 profile 级 budget 过滤。 |
| `maxTokenRatio` | 否 | `number` | 允许注入上下文占 `tokenBudget` 的最大比例。 | 未设置时不单独生效；只有与 `tokenBudget` 一起提供时才参与预算裁剪。 |
| `minScore` | 否 | `number` | profile 级最低分阈值。 | 未设置时不按 score 额外过滤。 |
| `metadata` | 否 | `object` | profile 级透传元数据。 | 未设置时不输出。 |
| `aiMemo` | 否 | `boolean \| object` | profile 级 AI 摘要配置。 | 未设置或为 `false` 时关闭；对象写法未指定 `preset` 时默认使用 `default` 预设。 |

### 2.4 Merge / Aggregate 说明

`merge` 和 `aggregate` 都作用在 **profile 级多 rule 合并阶段**，但职责不同：

- `merge` 决定多条 rule 的结果**如何排布**。
- `aggregate` 决定跨 rule 命中的**重复条目如何合成 score**。
- 运行顺序上，系统会先按 `aggregate` 处理重复条目，再按 `merge` 决定最终输出顺序。

#### `merge` 的可能取值

| 取值 | 含义 | 默认行为 | 适合场景 |
|------|------|----------|----------|
| `"interleave"` | 按 rule 轮转交错输出结果。 | 否 | 希望多条 rule 都保留曝光机会，避免单一路径完全淹没其他路径。 |
| 未设置 | 走默认合并逻辑。 | 是 | 去重后按 score 全局排序，形成统一排行榜。 |

补充说明：

- 当前实现只对 `"interleave"` 做显式特判。
- 其他未知字符串目前会退回默认合并逻辑，但不建议依赖这种隐式回退。
- `merge: "interleave"` 时，仍会先做一次全局去重；它不是简单的“原样穿插数组”。

示例：

```json
{
  "merge": "interleave",
  "aggregate": "max",
  "rules": [
    { "baseMode": "rag", "targets": { "diaries": ["核心日记本"], "kMultiplier": 1.0 } },
    { "baseMode": "full_text", "targets": { "diaries": ["归档日记本"], "kMultiplier": 1.0 } }
  ]
}
```

如果两条 rule 分别返回：

- rule1: `a1`, `a2`
- rule2: `b1`, `b2`

则 `merge: "interleave"` 的输出顺序类似：

- `a1`
- `b1`
- `a2`
- `b2`

而未设置 `merge` 时，会在去重后直接按 score 降序输出。

#### `aggregate` 的可能取值

| 取值 | 含义 | 公式 | 适合场景 |
|------|------|------|----------|
| `"max"` | 重复条目的最终分数取最大值。 | `max(scores)` | 最稳妥，避免重复命中过度放大。 |
| `"sum"` | 重复条目的最终分数取总和。 | `score1 + score2 + ...` | 强调“被多条 rule 同时命中”的证据累积。 |
| `"mean"` | 重复条目的最终分数取平均值。 | `(score1 + score2 + ...)/n` | 希望参考多条 rule 的共同判断，但不想像 `sum` 那样线性放大。 |
| 未设置 | 默认使用 `max`。 | `max(scores)` | 默认行为。 |

补充说明：

- 这里的“重复条目”按 `sourceDiary + sourceFile + text` 三元组判断。
- `aggregate` 只在**跨 rule 出现重复条目**时有意义；没有重复时，它不会影响结果。
- 当前实现对未知字符串会回退到 `max`，但文档上应只把 `max / sum / mean` 视为正式取值。

示例：

同一条内容如果被两条 rule 同时命中：

- ruleA score = `0.9`
- ruleB score = `0.6`

则：

- `aggregate: "max"` -> 最终分数 `0.9`
- `aggregate: "sum"` -> 最终分数 `1.5`
- `aggregate: "mean"` -> 最终分数 `0.75`

选型建议：

- 默认优先使用 `aggregate: "max"`，结果最稳定、最容易解释。
- 需要强化“多路同时命中”信号时，再考虑 `aggregate: "sum"`。
- 既想参考多条 rule，又不想放大过头时，用 `aggregate: "mean"`。
- 想保留多条 rule 的多样性时，搭配 `merge: "interleave"`。

### 2.5 单 rule 多 diary vs 多 rule 单 diary

下面以当前 `Midas-default` 的配置意图为例。

#### 写法 A：单 rule，多 diary

```json
{
  "rules": [
    {
      "baseMode": "rag",
      "targets": {
        "diaries": [
          "迈达斯日记本",
          "迈达斯因子与策略库日记本",
          "迈达斯量化工程日记本",
          "迈达斯量化小论坛学习笔记"
        ],
        "aggregate": true,
        "kMultiplier": 1.0
      },
      "modifiers": {
        "time": true,
        "rerank": true,
        "tagMemo": true,
        "truncate": 20
      }
    }
  ]
}
```

#### 写法 B：拆成 4 个 rule，每个 rule 只写 1 个 diary

```json
{
  "rules": [
    {
      "baseMode": "rag",
      "targets": {
        "diaries": ["迈达斯日记本"],
        "kMultiplier": 1.0
      },
      "modifiers": {
        "time": true,
        "rerank": true,
        "tagMemo": true,
        "truncate": 20
      }
    },
    {
      "baseMode": "rag",
      "targets": {
        "diaries": ["迈达斯因子与策略库日记本"],
        "kMultiplier": 1.0
      },
      "modifiers": {
        "time": true,
        "rerank": true,
        "tagMemo": true,
        "truncate": 20
      }
    },
    {
      "baseMode": "rag",
      "targets": {
        "diaries": ["迈达斯量化工程日记本"],
        "kMultiplier": 1.0
      },
      "modifiers": {
        "time": true,
        "rerank": true,
        "tagMemo": true,
        "truncate": 20
      }
    },
    {
      "baseMode": "rag",
      "targets": {
        "diaries": ["迈达斯量化小论坛学习笔记"],
        "kMultiplier": 1.0
      },
      "modifiers": {
        "time": true,
        "rerank": true,
        "tagMemo": true,
        "truncate": 20
      }
    }
  ]
}
```

#### 两种写法的预期效果差异

1. **执行粒度不同**
   - 写法 A 只执行 1 条 rule。
   - 写法 B 会执行 4 条独立 rule，再进入 profile 级合并。

2. **`truncate` 的作用范围不同**
   - 写法 A 中，`truncate: 20` 作用在“4 个 diary 合并后的这一条 rule 结果”上，整体最多保留 20 条。
   - 写法 B 中，每条 rule 都各自 `truncate: 20`，合并前最多可能保留 80 条；如果还想限制最终总量，需要额外配置 profile-level `truncateTo`。

3. **多样性与配额不同**
   - 写法 A 更像“把 4 个 diary 视为一个大池子统一排序”，高分 diary 更容易占满前 20 条。
   - 写法 B 更像“每个 diary 先各自出结果再合并”，不容易让某一个 diary 完全淹没其他 diary。

4. **后续调参与诊断粒度不同**
   - 写法 A 只有 1 条 rule diagnostics，适合简单配置。
   - 写法 B 每个 diary 都有独立 diagnostics，更容易观察哪个 diary 命中质量更高，也更方便后续给不同 diary 配不同的 `baseMode`、`modifiers` 或 `gateThreshold`。

5. **profile-level merge 能力只在写法 B 更有意义**
   - 写法 A 只有 1 条 rule，`merge` 基本没有发挥空间。
   - 写法 B 可以继续结合 `merge: "interleave"`，让不同 diary 的结果轮流出现，增强结果多样性。

#### 选型建议

- 选择写法 A，如果你的意图是：
  - 把多个 diary 当成一个统一知识池
  - 所有 diary 共享同一套召回策略
  - 希望最终总结果数被统一控制在一个较小范围内

- 选择写法 B，如果你的意图是：
  - 希望每个 diary 都有独立的结果配额
  - 希望后续按 diary 单独调参
  - 希望结合 `merge: "interleave"` 保留多路召回的多样性
  - 希望 diagnostics 能精确到每个 diary 对应的 rule

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

| 字段 | 必填 | 类型 | 说明 | 默认值 / 缺省行为 |
|------|------|------|------|------------------|
| `baseMode` | 是 | `string` | 规则类型，见下方「规则类型详解」。 | 无默认值。缺失或非法时该 rule 无效。 |
| `targets` | 是 | `object` | 召回目标配置，必须包含 `diaries` 数组。 | 无默认值。缺失时该 rule 无效。 |
| `targets.diaries` | 是 | `string[]` | 要检索的日记本名称列表。 | 无默认值。空数组会导致该 rule 无法产生有效目标。 |
| `targets.kMultiplier` | 否 | `number` | 召回倍率乘数。大于 1 扩大召回量，小于 1 缩小。 | 默认 `1.0`。非法值会回退到 `1.0`。 |
| `targets.aggregate` | 否 | `boolean` | 是否对该 rule 的结果做聚合去重。 | 单 diary 时可省略；结构化多 diary rule 未显式设为 `true` 时，不会自动聚合，并会在运行时视为无效配置。 |
| `projection` | 否 | `string \| object` | 结果视图偏好。字符串如 `"items"`；对象写法 `{ "emit": "items" }`。它影响对外返回时推荐使用的结果视图，不改变底层检索策略。 | 未显式指定时，先回退到 profile-level / rule-level 汇总结果，再由运行时自动推断。 |
| `gateThreshold` | 条件必填 | `number` | **门控阈值**，仅 `gated_rag` / `gated_full_text` 需要。范围建议 `0.2 ~ 0.5`。 | 默认 `null`。省略时等价于不做门控，但对 gated 类型应显式配置。 |
| `modifiers` | 否 | `object` | 召回修饰符配置，见下方「修饰符详解」。 | 默认空对象 `{}`，表示不启用任何修饰符。 |
| `meta` | 否 | `object` | 自定义元数据，透传给诊断信息。 | 未设置时不输出。 |
| `id` | 否 | `string` | Rule 标识，用于诊断与日志追踪。 | 未设置时不自动生成。 |

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

### 3.4 Projection 投影说明

`projection` 用来声明这条 rule 或整个 profile 的**结果视图偏好**，它回答的是“召回完成后，调用方应该优先按什么形式消费结果”，而不是“底层该怎么检索”。

- `baseMode` 决定检索路径，例如 `rag`、`full_text`、`gated_rag`。
- `projection` 决定结果呈现偏好，例如扁平条目、上下文块、全文分段。
- 当前实现会保留完整结果结构，并额外给出 `activeProjection` 作为推荐视图；它不是强制裁剪开关。

支持的常见值：

| 值 | 推荐消费方式 | 适合场景 |
|----|--------------|----------|
| `"items"` | 扁平条目列表 | 语义召回后直接消费片段内容 |
| `"recallBlocks"` | 上下文块列表 | 需要注入上下文块给下游模型 |
| `"fullTextSections"` | 按 diary 聚合的全文段落 | 全文型召回，需要按来源分组浏览 |
| `"attachments"` | 附件列表 | 重点关注 `base64Memo` 提取的附件 |
| `"hybrid"` | 混合视图 | 多条 rule 的视图偏好冲突，需要调用方自行决策 |

写法示例：

```json
{
  "baseMode": "rag",
  "targets": {
    "diaries": ["Nexus日记本"],
    "kMultiplier": 1.0
  },
  "projection": "items"
}
```

```json
{
  "baseMode": "full_text",
  "targets": {
    "diaries": ["Aemeath日记本"],
    "kMultiplier": 1.0
  },
  "projection": { "emit": "fullTextSections" }
}
```

优先级与默认行为：

1. profile-level `projection` 优先级最高。
2. 若 profile 未设置，则收集各 rule 的 `projection`。
3. 若所有 rule 的投影一致，则使用该值。
4. 若多条 rule 的投影冲突，则标记为 `hybrid`。
5. 若完全未设置，运行时会自动推断：
   - 含 `full_text` / `gated_full_text` 的规则默认倾向 `fullTextSections`
   - 其他情况默认倾向 `items`

建议：

- 把 `projection` 当成“消费层提示”而不是“检索层配置”。
- 想控制检索行为时优先改 `baseMode`、`targets`、`modifiers`。
- 想让 `gateway_recall_run` 的调用方更容易消费结果时，再显式设置 `projection`。

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

| 修饰符 | 取值类型 | 说明 | 默认值 / 缺省行为 |
|--------|----------|------|------------------|
| `time` | `boolean` | 启用**时间感知排序**，近期条目获得更高权重。 | 默认 `false`，即关闭。 |
| `group` | `boolean` | 启用**语义组增强**，利用语义分组提升相关度。 | 默认 `false`，即关闭。 |
| `rerank` | `boolean` | 启用**重排序**，对初筛结果做二次精排。 | 默认 `false`，即关闭。 |
| `tagMemo` | `boolean` | 启用 **TagMemo** 标签增强，融入标签关联信息。 | 默认 `false`，即关闭。 |

### 4.2 S02 修饰符（后处理）

这些修饰符在 `collectRagItems` 返回后、结果合并前运行。

| 修饰符 | 取值类型 | 说明 | 默认值 / 缺省行为 |
|--------|----------|------|------------------|
| `timeDecay` | `object \| boolean` | **时间衰减**，对 score 按指数衰减重新加权。配置为对象时：`{ "halfLifeDays": 30 }` 表示半衰期 30 天。 | 默认关闭。仅对象写法且提供有效 `halfLifeDays` 时生效；布尔 `true` 当前等价于不生效。 |
| `roleValve` | `string[] \| object` | **角色过滤 / 表达式门控**，只保留指定角色的条目，或按表达式判断是否放行。例如 `["user", "assistant"]`。无 role 元数据的条目默认通过。 | 默认关闭。数组写法默认使用 `OR`；对象写法未显式禁用时 `enabled=true`。 |
| `base64Memo` | `boolean` | **Base64 附件提取**，扫描条目中嵌入的 base64 数据（图片、文件等），提取到 `diagnostics.attachments`，原文替换为 `[base64-attachment]` 占位符。 | 默认 `false`，即关闭。 |

### 4.3 全局修饰符

| 修饰符 | 取值类型 | 说明 | 默认值 / 缺省行为 |
|--------|----------|------|------------------|
| `truncate` | `number` | **结果截断**，指定最终返回的最大条目数。建议设置正整数如 `20`；非数字值（如 `true`）等价于不截断。**每条 rule 的 truncate 独立作用于该 rule 的召回结果**，不再取第一条 rule 的值作为全局截断。 | 默认关闭，不截断。 |
| `aiMemo` | `boolean \| object` | **AI 摘要**，在召回结果上调用外部 LLM 生成结构化中文摘要。需配置环境变量 `AIMemoUrl`、`AIMemoApi`、`AIMemoModel`。摘要结果放在 `diagnostics.summary`。 | 默认关闭；对象写法未指定 `preset` 时默认使用 `default`。 |

---

## 5. 完整配置示例

### 示例 1：标准语义召回（Nexus）

```json
{
  "agents": {
    "Nexus": {
      "defaultProfile": "nexus-default",
      "allowedProfiles": ["nexus-default"],
      "targets": ["Nexus日记本"]
    }
  },
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
```

### 示例 2：门控召回 + 全文召回组合（Aemeath）

```json
{
  "agents": {
    "Aemeath": {
      "defaultProfile": "aemeath-gated",
      "allowedProfiles": [
        "aemeath-gated",
        "aemeath-fulltext",
        "aemeath-gated-fulltext"
      ],
      "targets": ["Aemeath日记本"]
    }
  },
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
```

### 示例 3：多日记本联合召回

```json
{
  "agents": {
    "Metis": {
      "defaultProfile": "metis-combined",
      "allowedProfiles": ["metis-combined"],
      "targets": ["Metis日记本", "公共知识库", "归档日记本"]
    }
  },
  "profiles": {
    "metis-combined": {
      "rules": [
        {
          "baseMode": "rag",
          "targets": {
            "diaries": ["Metis日记本", "公共知识库"],
            "aggregate": true,
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
      "allowedProfiles": ["default"],
      "targets": ["通用日记本"]
    }
  },
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
  "profile": "aemeath-fulltext"
}
```

- `profile` 可省略，使用 `defaultProfile`。
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
> `rag` 走向量召回主链；`full_text` / `gated_full_text` 走独立的全文检索路径，不是简单的高 K 值 RAG 变体。`full_text` 更适合需要覆盖更完整原文片段的场景。

**Q: 可以同时给同一个 Agent 配置多个 profile 吗？**
> 可以。通过 `profile` 参数在调用时切换；未指定时使用 `defaultProfile`。

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
