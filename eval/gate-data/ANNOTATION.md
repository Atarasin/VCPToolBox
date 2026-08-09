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

其中 330 条 `source=mined` 的 hard-negative 候选来自 Gemini 3072 与 Qwen 4096 的真实
score-only 结果：在每个目标内分别计算两个模型的分数百分位，取均值最高的 66 条。完整分数、
profile embedding 指纹、输入 score bundle hash 与稳定算法记录在 `gate-v1.mining.json`。
`mined` 只说明候选发现方式，`annotation.status` 仍是 `pending`，不能代替人工判负。

## 双人复核工作流

第一名审阅者复核全部样本；第二名审阅者至少复核 `hard negative` 与 `ambiguous`。大数据集可按稳定分片分派：

```bash
node eval/vcp-eval.js gate review export --dataset eval/gate-data/gate-v1.jsonl \
  --reviewer reviewer-a --scope all --batch-count 4 --batch-index 0 --out /tmp/reviewer-a-0.jsonl

node eval/vcp-eval.js gate review export --dataset eval/gate-data/gate-v1.jsonl \
  --reviewer reviewer-b --scope double-review \
  --reviews /tmp/reviewer-a-0.jsonl,/tmp/reviewer-a-1.jsonl,/tmp/reviewer-a-2.jsonl,/tmp/reviewer-a-3.jsonl \
  --out /tmp/reviewer-b.jsonl
```

先完成第一审，再用其证据导出第二审；这样第一审新增的 `ambiguous` 也会进入第二审，模板不会泄露
第一审的选择。审阅者逐行填写 `label`，并在首行填写 `reviewedAt` 与完全一致的
`requiredAttestation`。工具不会自动生成这份声明。汇总时传入所有分片和第二审文件：

```bash
node eval/vcp-eval.js gate review merge --dataset eval/gate-data/gate-v1.jsonl \
  --reviews /tmp/reviewer-a-0.jsonl,/tmp/reviewer-a-1.jsonl,/tmp/reviewer-a-2.jsonl,/tmp/reviewer-a-3.jsonl,/tmp/reviewer-b.jsonl \
  --out eval/gate-data/gate-v1.reviewed.jsonl --json
```

不同审阅者必须使用不同 `reviewerId`；同一 case 标签冲突、缺少复核或声明不完整都会保留为 pending。manifest 只保存脱敏 reviewer ID、时间与证据文件哈希。

不建议直接手改 1500 行 JSONL。可以启动仓库内的纯静态离线审阅器：

```bash
python3 -m http.server 8765 --directory eval/gate-data
# 浏览器打开 http://127.0.0.1:8765/reviewer.html，再选择待审 JSONL
```

页面不会联网或预填标签/声明；进度只存于当前浏览器 localStorage。全部逐条选择后，审阅者亲自
键入声明，页面导出的 `*.reviewed.jsonl` 可直接传给 `gate review merge`。

服务器没有浏览器或无法做 SSH 端口转发时，直接使用纯终端版本：

```bash
node eval/gate-data/reviewer-terminal.js \
  --input /tmp/reviewer-a-0.jsonl \
  --reviewer <真实审阅者ID>
```

终端逐条显示 query、候选标签和内嵌来源正文；`p/n/a` 选择标签，`c` 表示人工确认候选标签，
`q` 保存退出，之后执行同一命令自动恢复。全部完成后输入 `export`，亲自键入声明并生成
`*.reviewed.jsonl`。进度文件权限为 `0600`，不会写入源模板。

gate-v1 的每个目标决策包含 10 条同 `intentGroup` 的等义改写。输入 `group` 会一次展示整组；
确认所有改写语义和标签一致后，使用 `gp/gn/ga/gc` 整组标注。导出分片按
`targetType + library + intentGroup` 原子分配，同一组不会跨分片。
