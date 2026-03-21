---
name: "upstream-merge-preserve-local"
description: "Sync fork with upstream using merge while preserving local changes. Invoke when user asks to merge upstream updates into a fork and keep existing modifications."
---

# Upstream Merge Preserve Local

## 目标

在 fork 仓库中使用 merge 同步上游分支更新，同时保留当前仓库已有修改，并确保流程可恢复、可追踪。

## 适用场景

- 用户明确说“合并上游提交到当前 fork”
- 用户强调“保留我现有修改”
- 用户接受 merge 方案（非 rebase）

## 强制规则

- 发生冲突时，必须立即停止自动处理，并要求用户手动解决冲突。
- 禁止自动编辑冲突文件来“代替用户解决冲突”。
- 禁止在冲突未解决时继续执行提交与推送。

## 标准流程

1. 检查当前状态与远程配置
   - `git status --short --branch`
   - `git remote -v`
   - `git branch --show-current`

2. 创建安全备份
   - 若存在未提交改动，先提交一次备份提交，或执行 `git stash -u`
   - 额外创建备份分支：`backup/pre-merge-YYYYmmdd-HHMMSS`

3. 更新上游引用
   - 若没有 upstream，添加 upstream
   - `git fetch upstream`

4. 执行 merge
   - `git checkout <工作分支>`
   - `git merge upstream/<上游主分支>`

5. 冲突门禁（必须执行）
   - 检查是否在 merge 中：`git rev-parse -q --verify MERGE_HEAD`
   - 检查未合并文件：`git diff --name-only --diff-filter=U`
   - 若有冲突：
     - 输出冲突文件清单
     - 明确提示用户“请手动解决冲突后告知我继续”
     - 停止后续动作，不执行 commit / push

6. 冲突解决后继续
   - 再次确认无未合并文件
   - 执行质量校验（若项目存在对应脚本）
   - 完成 merge 提交（若 Git 未自动完成）
   - 推送到 origin

7. 最终复核
   - `git status --short --branch`
   - `git log --oneline --decorate -n 3`
   - 输出：merge 提交哈希、推送结果、剩余未提交改动

## 质量校验策略

- 优先执行仓库已有校验命令（lint、typecheck、test）。
- 若命令不存在，明确记录“脚本缺失”并继续流程，不虚构通过结果。

## 输出模板

- 已完成：备份、fetch、merge、commit、push 的状态
- 冲突状态：是否存在冲突文件
- 下一步动作：
  - 有冲突：请用户手动解决后继续
  - 无冲突：给出最终同步状态与可选清理建议
