# forge/TDB 维护窗口 Runbook（M1：冻结、备份与 TDB 安全恢复）

> 配套设计：[docs/design/2026-11-14_砚尺知识库质量优化设计.md](./design/2026-11-14_砚尺知识库质量优化设计.md) §3.1.2、§3.2.2、§3.6.2。
> 工具：`scripts/forge_maintenance.js`（下称 `FM`）。**原生模块子命令必须用 Node 22 运行**（与生产一致；Node 24 报 NODE_MODULE_VERSION 不匹配）。

```bash
NODE22=~/.nvm/versions/node/v22.15.1/bin/node
FM="$NODE22 scripts/forge_maintenance.js"
```

## 0. 前置条件（一次）

- [ ] 主分支已合并 M1 代码，`pm2 restart vcp-main` 已让租约检查生效。
- [ ] 磁盘空间 ≥ 源数据总量 × 2（当前 knowledge+store+forge ≈ 50MB）。
- [ ] `pm2 list` 中 `vcp-main` 在线；`$FM lease-status --json` 无活动租约。

## 1. 窗口外准备（不在 30 分钟窗口内）

1. **备份**（§3.1.2 步骤 1/3）：
   ```bash
   $FM backup --json            # 默认 backups/forge-maintenance/<ts>/
   $FM verify-backup --backup <上一步 backupDir> --json
   ```
   `verify-backup` 全量哈希校验通过才可继续。
2. **耗时测算 + 恢复演练**（临时 store，不动生产）：
   ```bash
   $FM estimate-rebuild --timeout-ms 1500000 --json
   ```
   记录 `elapsedMs`。**预计 清空+重建+验证+回滚 总时长 > 30 分钟时，不得开始清空**（红线 2）。总时长估算：重建 elapsedMs + audit/smoke（≈2 分钟）+ 回滚余量（备份恢复 ≈ backup durationMs + 一次重启）。
3. **记录回滚配对**：`backup/rollback-pairing.json` 已随备份生成（代码 commit ↔ store manifest ↔ 备份位置）。

## 2. 维护窗口（≤30 分钟，计时！）

```bash
date +%s   # 窗口起点
```

1. **独占锁**（暂停同专家手动/自动/定期进修；§3.6.2）：
   ```bash
   $FM lock --expert yanchi_ui --mode rebuild --owner m1_rebuild_$(date +%s) --ttl-ms 3600000 --json
   ```
   > 注意：其他专家（如有）逐一加锁；store 重建影响全部冷库，原则上所有 forge 专家都应持锁。
2. **复核备份仍与现状一致**（窗口外到窗口内若有过写入则重备份）：
   ```bash
   $FM verify-backup --backup <backupDir> --json
   ```
   同时抽查磁盘侧无新增：`$FM audit` 在**旧 store** 上跑会因 chunker 哈希不匹配的历史索引差异报错——这是预期（旧 store 本就是损坏基线），此处只看 L1 的 new/missing 是否为空。
3. **停止生产**：`pm2 stop vcp-main`
4. **清空原 storePath**（保留 manifest 重建所需的空目录）：
   ```bash
   rm -rf VectorStoreTDB && mkdir VectorStoreTDB
   ```
5. **启动生产触发全量摄取**：`pm2 start vcp-main`，跟踪日志：
   ```bash
   pm2 logs vcp-main --lines 0 | grep -E 'TDBKnowledge|Initial scan'
   ```
   等待 `Initial scan queued N file(s)` → 逐文件 `✅ Indexed ...` → 队列排空（日志安静）。
6. **正常关闭重开**（§3.1.2 步骤 6）：`pm2 restart vcp-main`，确认 `[TDBKnowledge] ✅ Ready. state=compatible`。
7. **三层审计**（生产停止态可跑；运行态亦可读，但优先无并发）：
   ```bash
   pm2 stop vcp-main
   $FM audit --json
   pm2 start vcp-main
   ```
   **任一 issue 非零退出 = 门禁失败**。
8. **查询冒烟（完整重启后的生产验证，§3.1.2 步骤 7）**：
   ```bash
   $FM smoke --json        # 每库 文本+向量 检索，全部 ok
   ```
9. **释放锁**：
   ```bash
   $FM unlock --expert yanchi_ui --owner <锁 owner> --json
   date +%s   # 窗口终点
   ```

## 3. 失败回滚（窗口内，红线 1/2）

任一门禁失败或窗口将超时：

```bash
pm2 stop vcp-main
rm -rf VectorStoreTDB knowledge Agent/forge
cp -r <backupDir>/VectorStoreTDB <backupDir>/knowledge <backupDir>/Agent/forge .
cp <backupDir>/config.env config.env
git checkout <rollback-pairing.json 的 codeVersion>   # 代码与 store 成对回滚
pm2 start vcp-main
$FM smoke --json   # 旧库可查即恢复成功
```

> 代码与 store 必须成对回滚；不得只回滚其中一个。
> 回滚后仍处于"索引损坏基线"（TDB_STORE_REBUILD_REQUIRED），检索退回不可用是**如实状态**，不冒充兼容。

## 4. 收尾

- [ ] 窗口总时长记录（≤30 分钟）。
- [ ] 四库 audit 全绿 + smoke 全绿。
- [ ] 解锁、`pm2 list` 全在线。
- [ ] 备份保留至 M3 结束（存量清洗的回滚依赖）。
- [ ] 设计文档 M1 里程碑门禁勾选。
