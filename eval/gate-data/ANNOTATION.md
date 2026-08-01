# Gate-v1 标注说明

每行表示“某条查询面对某个目标库是否应放行”，不是查询分类。标签定义、来源与拆分规则以实施方案 §8 为准。

- 标注者先核对 `sourceRefs`，再判断目标库能否提供有效回答证据。
- `hard` negative 与 `ambiguous` 必须由两名人工独立复核；其余样本至少抽查 20%。
- 同一语义及改写必须保留相同 `intentGroup`，不得跨 `calibration` / `holdout`。
- `pending` 是候选，不是金标。只有 `status=verified` 且满足复核数量的数据才能达到 development/decision 质量。
- 不得把 LLM 生成标签、文件归属或脚本推断伪装成人工复核。
- 冲突无法解决时改为 `ambiguous`；ambiguous 不参与拟合。

`gate-v1.jsonl` 当前是待人工标注队列。candidate-2 使用自然问题改写，同一语义共享
`intentGroup`，同一源文档固定在一个 split。它有完整数量和 split 结构，但 manifest 明确标为
`candidate`；校准 CLI 默认拒绝用未验证标签生成正式产物。

## 双人复核工作流

第一名审阅者复核全部样本；第二名审阅者至少复核 `hard negative` 与 `ambiguous`。大数据集可按稳定分片分派：

```bash
node eval/vcp-eval.js gate review export --dataset eval/gate-data/gate-v1.jsonl \
  --reviewer reviewer-a --scope all --batch-count 4 --batch-index 0 --out /tmp/reviewer-a-0.jsonl

node eval/vcp-eval.js gate review export --dataset eval/gate-data/gate-v1.jsonl \
  --reviewer reviewer-b --scope double-review --out /tmp/reviewer-b.jsonl
```

审阅者逐行填写 `label`，并在首行填写 `reviewedAt` 与完全一致的 `requiredAttestation`。工具不会自动生成这份声明。汇总时传入所有分片和第二审文件：

```bash
node eval/vcp-eval.js gate review merge --dataset eval/gate-data/gate-v1.jsonl \
  --reviews /tmp/reviewer-a-0.jsonl,/tmp/reviewer-a-1.jsonl,/tmp/reviewer-a-2.jsonl,/tmp/reviewer-a-3.jsonl,/tmp/reviewer-b.jsonl \
  --out eval/gate-data/gate-v1.reviewed.jsonl --json
```

不同审阅者必须使用不同 `reviewerId`；同一 case 标签冲突、缺少复核或声明不完整都会保留为 pending。manifest 只保存脱敏 reviewer ID、时间与证据文件哈希。
