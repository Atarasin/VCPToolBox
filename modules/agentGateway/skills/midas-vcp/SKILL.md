---
name: midas-vcp
description: Use Agent Gateway MCP as Midas's durable recall and memory layer. Use when Codex needs project history, prior decisions, VCP diary context, quant strategy or factor research context, forum-learning notes, user preference recall, or durable memory writes through vcp-agent-gateway tools such as gateway_recall_run, gateway_memory_search, and gateway_memory_write.
---

# Midas VCP

## Overview

Use this skill to retrieve Midas context from Agent Gateway before work that may depend on history, and to write concise durable memory after work that should survive the current conversation.

Default agent id: `MCPMidas`.

## Recall Workflow

1. Build a short, task-specific query from the user's request, repository name, filenames, strategy/factor names, issue ids, and any relevant error text.
2. Use `gateway_recall_run` as the single default recall entry point:

```json
{
  "agentId": "MCPMidas",
  "query": "<task-specific query>"
}
```

3. Let the configured Midas recall profile decide retrieval details such as diary routing, rerank, tag memo, truncation, and scoring.
4. Use `gateway_memory_search` only for targeted lookups in known diaries, exact names, or narrow historical questions.
5. Summarize only the useful recalled context in the working response. Do not paste long raw memory blocks unless the user explicitly asks.
6. If Agent Gateway fails or returns no useful context, proceed with local repository context and mention the gap only when it affects confidence.

## Diary Routing

- `迈达斯`: Midas identity, user preferences, agent behavior, cross-project rules.
- `迈达斯量化工程`: engineering decisions, bugs, APIs, project workflows, tool usage, repository conventions.
- `迈达斯因子与策略库`: factors, strategies, backtests, research conclusions, validated parameters.
- `迈达斯量化小论坛学习笔记`: Quantclass forum-learning notes, reproductions, distilled lessons.

## Memory Write Workflow

Write memory when the session produced reusable knowledge, not for every small action. Good candidates:

- User preferences or corrections that should change future Midas behavior.
- Decisions about architecture, configuration, project workflow, or tool boundaries.
- Root causes and fixes for non-obvious bugs.
- Validated commands, scripts, backtest findings, factor conclusions, or strategy caveats.
- Forum-learning summaries that have been reproduced or distilled.

Before writing, read `references/memory-policy.md` if the memory target or payload shape is unclear.

Use `gateway_memory_write` with a concise text payload, useful tags, and project metadata:

```json
{
  "agentId": "MCPMidas",
  "target": {"diary": "迈达斯量化工程"},
  "memory": {
    "text": "<1-3 concise paragraphs of durable knowledge>",
    "tags": ["codex", "select-stock-pro", "<topic>"],
    "metadata": {
      "project": "quant-select-stock-pro",
      "repo": "select-stock-pro-dev",
      "source": "codex"
    }
  }
}
```

## Bootstrap Boundary

Do not call `gateway_agent_bootstrap` for routine SessionStart-style prompt injection. Use it only when diagnosing Agent Gateway prompt rendering or explicitly refreshing Midas bootstrap content for comparison. Codex identity should come from `AGENTS.md` and this skill.
