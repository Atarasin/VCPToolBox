# StoryOrchestrator E2E 测试指南

> **目标读者**: 刚接触 VCPToolBox 的开发者，需要验证 StoryOrchestrator 的 WorkflowKernel 集成是否正常工作。
>
> **测试性质**: 真实端到端测试（非 mock），每次运行消耗真实 LLM API 额度。

---

## 目录

1. [前置条件](#前置条件)
2. [快速运行](#快速运行)
3. [环境变量详解](#环境变量详解)
4. [模型选择与成本控制](#模型选择与成本控制)
5. [CI 缩短模式](#ci-缩短模式)
6. [两阶段提取配置](#两阶段提取配置)
7. [故障排查](#故障排查)
8. [高级配置](#高级配置)

---

## 前置条件

### 1. 服务就绪

| 组件 | 要求 | 验证命令 |
|------|------|----------|
| VCP 主服务 | 必须运行 | `curl http://127.0.0.1:6005/v1/models` |
| 上游 LLM | 可达且模型可用 | 通过 VCP 管理面板或 API 测试 |
| Node.js | ≥ 18 (支持 `--test`) | `node --version` |

### 2. 配置文件

根目录 `config.env` 必须包含以下关键项：

```env
# VCP 自身鉴权
Key=your-vcp-key-min-16-chars

# 上游 LLM 服务鉴权
API_Key=your-llm-provider-key

# VCP 监听端口与地址
PORT=6005
AGENT_ASSISTANT_URL=http://127.0.0.1:6005

# --- 以下模型配置决定测试费用与质量 ---
# 如果设置了 E2E_AGENT_MODEL，以下配置会被统一覆盖
AGENT_WORLD_BUILDER_MODEL_ID=gpt-4o-mini
AGENT_CHARACTER_DESIGNER_MODEL_ID=gpt-4o-mini
AGENT_PLOT_ARCHITECT_MODEL_ID=gpt-4o-mini
AGENT_CHAPTER_WRITER_MODEL_ID=gpt-4o-mini
AGENT_DETAIL_FILLER_MODEL_ID=gpt-4o-mini
AGENT_LOGIC_VALIDATOR_MODEL_ID=gpt-4o-mini
AGENT_STYLE_POLISHER_MODEL_ID=gpt-4o-mini
AGENT_FINAL_EDITOR_MODEL_ID=gpt-4o-mini
```

> **注意**: 插件配置文件中也可以设置这些值，但根目录 `config.env` 优先级更高（e2e 测试会同时读取两者并合并）。

---

## 快速运行

项目提供了快捷命令，也可使用完整 `node --test` 命令：

```bash
# 快捷方式（推荐）
npm run e2e                  # 使用默认配置运行
npm run e2e:short            # 缩短模式：300 字 / 5 分钟上限

# 完整命令（如需自定义环境变量）
RUN_E2E_TESTS=1 E2E_AGENT_MODEL=gpt-4o-mini \
  node --test Plugin/StoryOrchestrator/tests/e2e-real.test.js
```

### 标准运行（推荐首次使用）

使用低价模型降低成本：

```bash
# 使用 gpt-4o-mini（或你上游可用的等价模型）
RUN_E2E_TESTS=1 E2E_AGENT_MODEL=gpt-4o-mini \
  node --test Plugin/StoryOrchestrator/tests/e2e-real.test.js
```

### 最小化验证（最快、最便宜）

```bash
RUN_E2E_TESTS=1 \
  E2E_AGENT_MODEL=gpt-4o-mini \
  E2E_TARGET_WORD_COUNT=300 \
  E2E_MAX_WAIT_MS=300000 \
  node --test Plugin/StoryOrchestrator/tests/e2e-real.test.js
```

### 完整默认配置运行

```bash
RUN_E2E_TESTS=1 node --test Plugin/StoryOrchestrator/tests/e2e-real.test.js
```

默认配置：
- 目标字数: 500 字
- 最大等待: 10 分钟
- 使用 WorkflowKernel 路径
- 测试后自动清理故事数据

---

## 环境变量详解

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `RUN_E2E_TESTS` | *(未设置)* | **必需**。设为 `1` 才运行测试，防止 CI 误触发 |
| `E2E_TARGET_WORD_COUNT` | `500` | 目标字数。300-800 范围内测试稳定。超过 2000 字会显著增加运行时间和费用 |
| `E2E_MAX_WAIT_MS` | `600000` | 最大等待毫秒数。默认 10 分钟。慢模型/高字数需增加 |
| `E2E_POLL_INTERVAL_MS` | `3000` | 状态轮询间隔。默认 3 秒。不需要频繁调整 |
| `E2E_USE_KERNEL_PATH` | `true` | `true`=使用 WorkflowKernel 路径，`false`=回退到旧版 Legacy 路径 |
| `E2E_AGENT_MODEL` | *(空)* | 统一覆盖所有 8 个 Agent 的模型 ID。设为空则使用 config.env 中各 Agent 独立配置 |
| `E2E_CLEANUP` | `true` | 测试结束后是否删除生成的故事数据。设为 `false` 可保留用于人工检查 |

---

## 模型选择与成本控制

### 推荐模型矩阵

| 场景 | 推荐模型 | 预估费用(500字) | 预估时间 | 稳定性 |
|------|----------|-----------------|----------|--------|
| 日常开发验证 | `gpt-4o-mini` | $0.02–$0.08 | 3–8 min | ⭐⭐⭐⭐ |
| CI 快速检查 | `gpt-4o-mini` (300字) | $0.01–$0.04 | 2–5 min | ⭐⭐⭐⭐ |
| 质量回归测试 | `gpt-4o` | $0.20–$0.60 | 2–6 min | ⭐⭐⭐⭐⭐ |
| 完整能力验证 | `gpt-4o` / `claude-3-5-sonnet` | $0.30–$1.00 | 3–8 min | ⭐⭐⭐⭐⭐ |

> **费用说明**: 上表基于 2025 年 OpenAI 官方定价估算。实际费用取决于:
> - 上游服务商加价（NewAPI、OpenRouter 等可能有额外费用）
> - 输出 token 量（与目标字数和模型输出风格有关）
> - 重试次数（格式解析失败时工作流会自动重试）

### 成本优化技巧

1. **统一模型覆盖**: 使用 `E2E_AGENT_MODEL` 一次性覆盖所有 Agent，避免在 config.env 中维护 8 个独立模型 ID。

2. **降低字数**: `E2E_TARGET_WORD_COUNT=300` 可将费用和时间降低约 40%。

3. **保留测试产物**: 设置 `E2E_CLEANUP=false`，一次运行后检查生成的故事质量，避免重复运行。

4. **使用轻量上游**: 如果本地部署了轻量模型（如 Ollama + qwen2.5），可以指向本地端点，费用为零（但稳定性可能下降）。

---

## CI 缩短模式

### 当前限制

本测试 **目前仍调用真实 LLM API**。这意味着:
- 每次 CI 运行会产生真实费用
- 运行时间受 LLM 延迟影响，不够确定
- 不适合作为每次 commit 的阻塞式检查

### 推荐的 CI 策略

**策略 A: 定时触发（推荐）**

```yaml
# .github/workflows/e2e.yml 示例片段
name: E2E Test
on:
  schedule:
    - cron: '0 2 * * *'  # 每天凌晨 2 点运行
  workflow_dispatch:       # 支持手动触发

jobs:
  e2e:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '20'
      - run: npm ci
      - run: npm run build:rust
      - name: Start VCP
        run: node server.js &
        env:
          Key: ${{ secrets.VCP_KEY }}
          API_Key: ${{ secrets.API_KEY }}
      - name: Wait for VCP
        run: npx wait-on http://127.0.0.1:6005/v1/models --timeout 30000
      - name: Run E2E (shortened)
        run: |
          E2E_AGENT_MODEL=${{ vars.E2E_MODEL || 'gpt-4o-mini' }} \
            npm run e2e:short
```

**策略 B: 仅 Release 前运行**

将 e2e 测试绑定到 release 分支或 tag，而非每个 PR。

**策略 C: Mock LLM 模式（未来方向）**

实现一个 mock LLM provider，返回预设的结构化输出，用于验证工作流编排逻辑而不调用真实 API。这需要:
1. 在 `config.env` 中支持 `MOCK_LLM_MODE=true`
2. 提供预设的世界观/角色/大纲/章节 JSON 响应
3. 覆盖所有 Agent 调用为本地 mock 服务

> 目前未实现 mock 模式。如需此功能，请在项目中提交 feature request。

### 缩短配置速查

```bash
# 快捷方式（已内置缩短参数）
npm run e2e:short

# 或手动指定完整参数
RUN_E2E_TESTS=1 \
  E2E_AGENT_MODEL=gpt-4o-mini \
  E2E_TARGET_WORD_COUNT=300 \
  E2E_MAX_WAIT_MS=300000 \
  E2E_POLL_INTERVAL_MS=5000 \
  node --test Plugin/StoryOrchestrator/tests/e2e-real.test.js
```

---

## 两阶段提取配置

StoryOrchestrator 的 WorkflowKernel 集成使用 **ExtractionLayer** 从 LLM 的自由格式输出中提取结构化数据。

### 配置位置

- 工作流定义: `Plugin/StoryOrchestrator/config/workflow-definition.js`
- 提取 Schema: `Plugin/StoryOrchestrator/config/extraction-schemas.js`
- 提取引擎: `modules/workflowKernel/extraction/ExtractionLayer.js`

### 提取流程

```
┌─────────────────┐     ┌──────────────────┐     ┌─────────────────┐
│  Phase 1: Agent │     │  Phase 2:        │     │  Phase 3:       │
│  输出 markdown   │────▶│  ExtractionLayer │────▶│  验证与后续步骤  │
│  (自由格式)      │     │  解析结构化数据   │     │  (schemaValidate│
│                 │     │                  │     │   storyValidate)│
└─────────────────┘     └──────────────────┘     └─────────────────┘
```

### 解析器优先级

默认解析器按以下顺序尝试：

| 优先级 | 解析器 | 说明 |
|--------|--------|------|
| 1 | `jsonBlock` | 提取 ```json ... ``` 代码块 |
| 2 | `jsonObject` | 在文本中查找 `{...}` JSON 对象 |
| 3 | `xml` | 解析 XML 标签包裹的数据 |
| 4 | `fallbackRaw` | 返回原始文本作为兜底 |

### Schema 配置示例（世界观提取）

```javascript
// Plugin/StoryOrchestrator/config/extraction-schemas.js
const extWorldview = {
  parserOrder: ['jsonBlock', 'jsonObject', 'xml', 'fallbackRaw'],
  maxAttempts: 2,
  throwOnFailure: false,      // 解析失败不抛错，返回 defaultValue
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
};
```

### 错误处理策略

- `throwOnFailure: false` + `defaultValue: null`: 解析失败不中断工作流
- 下游 `schemaValidate` 步骤检查提取结果的数据质量
- `storyValidate` 进行业务级一致性校验
- 工作流全局配置了 `globalRetryPolicy: { maxAttempts: 3, backoffDelays: [0, 250, 1000] }`

---

## 故障排查

### 1. 超时 — `Story did not complete within 600000ms`

**症状**: 测试运行超过最大等待时间仍未完成。

**可能原因与解决**:

| 原因 | 判断 | 解决 |
|------|------|------|
| 上游 LLM 缓慢 | 日志中显示 agent 调用间隔很长 | 增加 `E2E_MAX_WAIT_MS=900000` |
| 目标字数过高 | 设置了 >1000 字 | 减少到 `E2E_TARGET_WORD_COUNT=500` |
| 检查点卡住 | 状态长期 `checkpoint_pending` | 检查 StoryOrchestrator 日志是否有 approval 处理异常 |
| 工作流死锁 | 某步骤失败后未正确重试 | 检查 `modules/workflowKernel/core/StateMachine.js` 日志 |

### 2. 解析错误 / 验证失败

**症状**: `schemaValidate` 或 `storyValidate` 报告失败，工作流重试后仍失败。

**可能原因与解决**:

| 原因 | 判断 | 解决 |
|------|------|------|
| 模型输出格式不稳定 | 使用过于便宜的模型 | 升级到 `gpt-4o-mini` 或更高 |
| JSON 格式损坏 | 日志中 `parseAgentJson` 输出 `null` | 检查 extraction-schemas 的 parserOrder |
| Schema 过严 | 新版本增加了必填字段 | 检查 extraction-schemas.js 的 required 配置 |

> **重要**: 偶尔的失败是正常现象。测试已配置 3 次重试，如果 3 次都失败才报告错误。

### 3. 模型不可用 — `404 model not found`

**症状**: Agent 调用返回 404 或类似错误。

**解决步骤**:
1. 确认模型 ID 拼写正确（区分大小写）
2. 通过上游服务商面板确认模型可用
3. 使用 `E2E_AGENT_MODEL=确定可用的模型ID` 统一覆盖

### 4. VCP 服务不可达

**症状**: `VCP service not reachable at http://127.0.0.1:6005`

**解决步骤**:
1. `ps aux | grep "node server.js"` — 确认服务在运行
2. `curl http://127.0.0.1:6005/v1/models` — 手动验证可达性
3. 检查 `config.env` 中的 `PORT` 是否与实际监听端口一致
4. 检查防火墙规则（云服务器安全组、本地防火墙）

### 5. 密钥错误 — `401 Unauthorized` / `403 Forbidden`

**症状**: VCP 或上游服务返回鉴权错误。

**解决步骤**:
1. 确认根目录 `config.env` 中 `Key` 存在且 ≥ 16 字符
2. 确认 `API_Key` 存在且有效（可在上游服务商测试）
3. 注意 `Key` 是 VCP 内部鉴权，`API_Key` 是上游 LLM 鉴权，用途不同

### 6. 检查点未自动批准

**症状**: 状态卡在 `checkpoint_pending`，测试日志中没有 `Auto-approving checkpoint`。

**可能原因**:
- `QueryStoryStatus` 返回的 `checkpoint_pending` 字段为 false 但 `checkpoint_id` 存在（格式变化）
- 批准调用返回错误但测试未正确捕获

**调试**:
1. 设置 `E2E_CLEANUP=false` 保留故事数据
2. 手动调用 `UserConfirmCheckpoint` API 检查响应
3. 查看 StoryOrchestrator 和 WorkflowKernel 的详细日志

### 7. 内存 / 性能问题

**症状**: Node.js 内存溢出或 CPU 占用过高。

**解决**:
- 减少 `E2E_TARGET_WORD_COUNT`
- 增加 Node.js 内存限制: `node --max-old-space-size=4096 --test ...`

---

## 高级配置

### 单独控制每个 Agent 的模型

不设置 `E2E_AGENT_MODEL`，而是在 `config.env` 中为每个 Agent 指定模型：

```env
AGENT_WORLD_BUILDER_MODEL_ID=gpt-4o-mini
AGENT_CHARACTER_DESIGNER_MODEL_ID=gpt-4o-mini
AGENT_PLOT_ARCHITECT_MODEL_ID=gpt-4o
AGENT_CHAPTER_WRITER_MODEL_ID=gpt-4o
AGENT_DETAIL_FILLER_MODEL_ID=gpt-4o-mini
AGENT_LOGIC_VALIDATOR_MODEL_ID=gpt-4o-mini
AGENT_STYLE_POLISHER_MODEL_ID=gpt-4o
AGENT_FINAL_EDITOR_MODEL_ID=gpt-4o
```

这样可以让关键 Agent（大纲、写作、润色）使用更强的模型，辅助 Agent 使用便宜模型，平衡质量与成本。

### 禁用内核路径（回退到 Legacy）

```bash
RUN_E2E_TESTS=1 E2E_USE_KERNEL_PATH=false \
  node --test Plugin/StoryOrchestrator/tests/e2e-real.test.js
```

用于对比内核路径与旧版路径的行为差异。

### 调试模式

测试配置自动启用了 `ORCHESTRATOR_DEBUG_MODE=true`，会在控制台输出详细的工作流状态。如需更底层的 WorkflowKernel 日志，可在启动 VCP 前设置：

```bash
DEBUG=workflow-kernel:* node server.js
```

### 保留测试产物进行人工检查

```bash
RUN_E2E_TESTS=1 E2E_CLEANUP=false \
  node --test Plugin/StoryOrchestrator/tests/e2e-real.test.js
```

测试结束后，使用以下方式查看生成的故事：

```bash
# 查询故事 ID
ls dailynote/storyOrchestrator/

# 通过 API 导出
curl -X POST http://127.0.0.1:6005/api/orchestrator/story/export \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $Key" \
  -d '{"story_id": "YOUR_STORY_ID", "format": "markdown"}'
```

---

## 相关文档

- [workflow-authoring-guide.md](./workflow-authoring-guide.md) — 如何编写新的工作流定义
- [workflow-migration-guide.md](./workflow-migration-guide.md) — 从旧版 Phase 系统迁移到 WorkflowKernel
- [workflow-kernel-api.md](./workflow-kernel-api.md) — WorkflowKernel API 参考
- `modules/workflowKernel/extraction/ExtractionLayer.js` — 提取引擎源码
- `Plugin/StoryOrchestrator/config/workflow-definition.js` — 故事工作流定义
- `Plugin/StoryOrchestrator/config/extraction-schemas.js` — 提取 Schema 定义

---

*文档版本: 1.0.0 | 对应 WorkflowKernel v1.x*
