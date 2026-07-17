# Memory Policy

Use Agent Gateway memory for durable, reusable knowledge. Keep memory short enough to be useful during future recall.

## Write

- Write only facts, decisions, preferences, workflows, and validated findings likely to matter in later sessions.
- Include enough context for future Midas sessions to understand why the memory exists.
- Prefer stable names: repository, project, factor/strategy name, issue id, command, file path, or data range.
- Add tags for retrieval. Include at least `codex`, `select-stock-pro`, and one topic tag.
- Route engineering memories to `迈达斯量化工程`, factor/strategy research to `迈达斯因子与策略库`, forum-learning notes to `迈达斯量化小论坛学习笔记`, and agent behavior or user preferences to `迈达斯`.

## Skip

- Do not write secrets, credentials, private keys, tokens, or raw personally sensitive data.
- Do not write noisy command logs, temporary errors, incomplete speculation, or code dumps.
- Do not write memory for trivial edits that are obvious from git history.
- Do not overwrite user intent with inferred preferences unless the user clearly stated or confirmed them.

## Payload Shape

Prefer this shape:

```json
{
  "agentId": "MCPMidas",
  "target": {"diary": "<diary name>"},
  "memory": {
    "text": "<durable summary>",
    "tags": ["codex", "select-stock-pro", "<topic>"],
    "metadata": {
      "project": "quant-select-stock-pro",
      "repo": "select-stock-pro-dev",
      "source": "codex"
    }
  }
}
```

When writing from a long task, mention the verified outcome and the command or file path that anchors it. When writing a preference, state it as a user preference rather than as a universal rule.
