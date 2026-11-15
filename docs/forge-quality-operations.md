# forge 质量运维手册（M5：告警、复核、回滚、再发布与规则变更重验）

> 配套设计：[docs/design/2026-11-14_砚尺知识库质量优化设计.md](../design/2026-11-14_砚尺知识库质量优化设计.md) §3.8.4 / §6。
> 工具入口：`scripts/forge_quality.js`（inventory / golden / disposition / regress）、`scripts/forge_maintenance.js`（lock / backup / verify-backup / audit / estimate-rebuild / smoke）。
> **原生模块命令一律用生产 Node 22 运行**：`NODE22=~/.nvm/versions/node/v22.15.1/bin/node`。

## 1. 定期质量回归（每周或每次发布后）

```bash
NODE22=~/.nvm/versions/node/v22.15.1/bin/node
$NODE22 scripts/forge_quality.js regress --expert yanchi_ui --json
```

一次 regress 依次执行并出机器可读报告（任一失败非零退出）：

1. **三层一致性审计**（磁盘 ↔ SQLite ↔ TriviumDB，任一差异/孤儿/队列残留即失败）；
2. **strict 金标回归**（59+ 探针：required 100%、隔离负例零命中、preview 无来源头）；
3. **趋势对比**：与上一条趋势记录比较 MRR/nDCG——无故下降 >0.02 即回归告警；负例泄漏、审计差异同样入告警。

趋势追加写入 `Agent/forge/yanchi_ui/golden-baselines/trend.jsonl`（每行一条：时间、审计结论、金标摘要、provenance、告警、最后成功 active 发布点）。

## 2. 告警处置对照表

| 告警 | 含义 | 第一步 | 回滚/修复 |
|---|---|---|---|
| `MRR 回归` / `nDCG 回归` | 检索质量无故下降（语料/索引/normalizer 变更） | `$NODE22 scripts/forge_maintenance.js audit --json` 查三层 | 近期知识变更走 §3 回滚；无变更则查 `git log TDBKnowledge.js IndexNormalizer.js TextChunker.js` 是否动了 provenance |
| `隔离负例泄漏 N 条` | 偏题内容重回活动检索路径 | `grep -r <泄漏文件> knowledge/` 确认是否被移回 | 用处置台账（`Agent/forge/<expert>/disposition-ledger.jsonl`）的 restoreHint 反向操作移出 |
| `三层审计差异` | 磁盘/SQLite/TriviumDB 不一致 | 看 report.issues 定位层（L1 磁盘↔SQLite / L2 chunks / L3 节点） | watcher 自动重试可自愈 L1-new；L2/L3 差异按 §4 重建 |
| `索引就绪门禁未通过`（forge job 内） | distill/trial fail closed（§3.6.1） | 查 job 错误详情 `indexReady.reasons` | 队列堆积等收敛后 resume；store 状态非 compatible 走 §4 重建 |
| `forge.learn.write_paused` / `FORGE_EXPERT_WRITE_PAUSED` | 维护租约生效中 | `forge_maintenance.js lease-status --json` | 维护完成后 `unlock`；租约损坏用 `lock --force` 接管 |

## 3. 知识内容回滚与再发布

- **处置台账**（`Agent/forge/<expert>/disposition-ledger.jsonl`）是唯一回滚依据：每条 move/revise 记录 from→to、理由、恢复提示；revise 记录旧内容哈希（配合 `backups/forge-maintenance/` 备份可整文件还原）。
- **批量回滚**：`rollback-pairing.json`（备份目录内）给出代码 ↔ store 成对回滚命令——代码与 store 必须成对回滚，不得只回滚其一。
- **再发布**：修复后重跑处置（disposition 幂等：已处置条目自动跳过）→ regress 通过 → 学习水位按"最后一次成功 active 发布"自然推进（失败批次不会推过新增内容）。
- **回滚演练**（T23 已建，发布后每季度一次）：取备份目录 → 临时目录试恢复 → `verify-backup` 全量哈希 → 演练后删除临时目录。

## 4. 索引重建（§3.1.2 流程不变）

```bash
$NODE22 scripts/forge_maintenance.js backup --json && $NODE22 scripts/forge_maintenance.js verify-backup --backup <dir> --json
$NODE22 scripts/forge_maintenance.js estimate-rebuild --json          # 演练计时（临时 store）
# 30 分钟窗口内完成才可执行（见 docs/forge-maintenance-runbook.md §2）：
$NODE22 scripts/forge_maintenance.js lock --expert yanchi_ui --mode rebuild --owner <id> --ttl-ms 3600000 --json
pm2 stop vcp-main && rm -rf VectorStoreTDB && mkdir VectorStoreTDB && pm2 start vcp-main
# 摄取收敛后：停服 audit + golden --strict-negatives + smoke → 重启 → unlock
```

## 5. 规则变更后的重验清单

任何改动以下文件/配置都必须重跑第 1 节的 regress（provenance 变更会触发 store 重建要求）：

| 变更 | 影响 | 必跑 |
|---|---|---|
| `IndexNormalizer.js` / `TextChunker.js`（含 `WhitelistEmbeddingModelMaxToken`） | store provenance v2 哈希变化 → `rebuild_required` | §4 全量重建 + regress |
| `modules/.../golden/*.json` 金标集 | 探针/阈值变化 | regress（新旧 MRR/nDCG 基线对照说明在 golden 文件 note） |
| 蓝图 `scope`/`subskills` | 主题门禁词廓变化 | 对 yanchi 跑一次 `inventory` 抽查分诊漂移 + regress |
| 质量规则（qualityGate.js） | 判定口径变化 | 全量 forge 测试 + regress；必要时 M3 处置计划重审 |

## 6. 时效验收（开放项，如实未完成）

Tavily `start_date/end_date` 与 BrowserSearch `timeRange=week` 已按 §3.4.2 接入（增量链 Tavily → Browser → Any），但**尚未通过已知发布日期样本的时效验收**（§6.3 对应验收条目保持未勾选）。验收方法：选两个已知发布日期的页面（一新一旧），设 `since` 为两者之间，确认增量链只命中新页面；通过后在 §6.3 勾选并把本节改为"已验收"。

## 7. 责任边界提醒

- 高风险事实修订与内容型合并的最终发布权在用户（红线 7）：`disposition` 只执行机器可判定类别，mergeProposals 一律留复核。
- 备份保留至下一次全量重建成功之后；每季度抽查一次 `verify-backup`。
- 生产模板（`Agent/forge/templates/*.md`）与内置 fallback 必须同步修改——改模板后跑对应 forge 测试防假绿（§3.8.2）。
