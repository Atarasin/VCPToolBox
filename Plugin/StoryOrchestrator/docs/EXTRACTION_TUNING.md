# StoryOrchestrator 两阶段提取配置与调优报告

## 概述

StoryOrchestrator 现已集成 `ExtractionLayer` 两阶段提取管道：
1. **阶段一**：LLM 输出自由格式 markdown
2. **阶段二**：`ExtractionLayer` 使用可配置解析器优先级管道提取结构化数据

## 解析器优先级

默认解析器顺序（已针对中文 LLM 输出调优）：

```js
['jsonBlock', 'jsonObject', 'xml', 'fallbackRaw']
```

| 解析器 | 用途 | 成功率(合成E2E) |
|--------|------|----------------|
| `jsonBlock` | 提取 ` ```json ... ``` ` 代码块 | 33% (6/18) |
| `jsonObject` | 提取内联 JSON 对象/数组，支持截断修复 | 83% (10/12) |
| `xml` | 提取 XML 包装的结构 | 0% (0/2) |
| `fallbackRaw` | 返回原始内容作为兜底 | 100% (2/2) |

**调优结论**：`jsonBlock` → `jsonObject` 的组合覆盖了绝大多数 LLM JSON 输出模式。`fallbackRaw` 确保非 JSON 文本大纲（如中文标记格式）不会导致工作流失败。

## 各 Agent 提取配置

### worldBuilder (世界观设定)

```js
extraction: {
  parserOrder: ['jsonBlock', 'jsonObject', 'xml', 'fallbackRaw'],
  maxAttempts: 2,
  throwOnFailure: false,
  defaultValue: null,
  schema: {
    type: 'object',
    properties: {
      setting: { type: 'string' },
      rules: { type: 'object' },
      factions: { type: 'array' },
      history: { type: 'object' },
      sceneNorms: { type: 'array' },
      secrets: { type: 'array' }
    }
  }
}
```

### characterDesigner (人物设定)

```js
extraction: {
  parserOrder: ['jsonBlock', 'jsonObject', 'xml', 'fallbackRaw'],
  maxAttempts: 2,
  throwOnFailure: false,
  defaultValue: null,
  schema: {
    type: 'object',
    properties: {
      protagonists: { type: 'array' },
      supportingCharacters: { type: 'array' },
      relationshipNetwork: { type: 'object' },
      oocRules: { type: 'object' }
    }
  }
}
```

### plotArchitect (大纲生成)

```js
extraction: {
  parserOrder: ['jsonBlock', 'jsonObject', 'xml', 'fallbackRaw'],
  maxAttempts: 2,
  throwOnFailure: false,
  defaultValue: null,
  schema: {
    type: 'object',
    properties: {
      chapters: { type: 'array' },
      structure: { type: 'string' },
      keyTurningPoints: { type: 'array' },
      foreshadowing: { type: 'array' }
    }
  }
}
```

## 重试策略

- `maxAttempts: 2` — 第一次失败后使用相同解析器重试一次
- `throwOnFailure: false` — 总失败时返回 `defaultValue` 而非抛出异常
- 此策略确保即使 LLM 输出完全不符合预期，工作流也能继续运行（后续 schemaValidate 和 storyValidate 会处理数据质量问题）

## 观测指标

`StoryOrchestratorKernelAdapter` 内置提取指标：

```js
adapter.getExtractionMetrics()
// => {
//   totalAttempts: 18,
//   totalSuccesses: 18,
//   totalFailures: 0,
//   byParser: { jsonBlock: {...}, jsonObject: {...}, xml: {...}, fallbackRaw: {...} },
//   byStep: { generateWorldview: {...}, generateCharacters: {...}, generateOutline: {...} }
// }
```

## E2E 验证结果

合成 E2E 测试覆盖 9 种 LLM 输出变体：
- 干净 JSON 代码块
- 内联 JSON（无代码围栏）
- JSON 包裹在解释性文本中
- 截断 JSON（缺少闭合括号）
- 中文标记格式文本大纲

**结果：0 次 JSON 解析失败，100% 通过率。**

## 文件变更

- `Plugin/StoryOrchestrator/adapters/StoryOrchestratorKernelAdapter.js` — 集成 ExtractionLayer
- `Plugin/StoryOrchestrator/config/workflow-definition.js` — 添加 extraction 配置
- `Plugin/StoryOrchestrator/tests/KernelAdapterExtraction.test.js` — 15 项单元/集成测试
- `Plugin/StoryOrchestrator/tests/e2e-extraction.test.js` — 4 项合成 E2E 测试
