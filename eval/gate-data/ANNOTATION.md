# Gate-v1 标注说明

每行表示“某条查询面对某个目标库是否应放行”，不是查询分类。标签定义、来源与拆分规则以实施方案 §8 为准。

- 标注者先核对 `sourceRefs`，再判断目标库能否提供有效回答证据。
- `hard` negative 与 `ambiguous` 必须由两名人工独立复核；其余样本至少抽查 20%。
- 同一语义及改写必须保留相同 `intentGroup`，不得跨 `calibration` / `holdout`。
- `pending` 是候选，不是金标。只有 `status=verified` 且满足复核数量的数据才能达到 development/decision 质量。
- 不得把 LLM 生成标签、文件归属或脚本推断伪装成人工复核。
- 冲突无法解决时改为 `ambiguous`；ambiguous 不参与拟合。

`gate-v1.jsonl` 当前是待人工标注队列。它有完整数量和 split 结构，但 manifest 明确标为 `candidate`；校准 CLI 默认拒绝用未验证标签生成正式产物。
