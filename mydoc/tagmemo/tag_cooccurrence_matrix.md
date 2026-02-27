# Tag 共现矩阵

**创新摘要**  
基于所有文档的 Tag 共现统计构建“逻辑星座图”，用于 TagMemo 拉回与逻辑扩张。

**依赖环境**  
- SQLite 表：file_tags、tags  
- Node.js / better-sqlite3  

**运行说明**  
在 KnowledgeBaseManager 初始化与索引更新后异步重建。  

---

## 完整代码实现

```javascript
// KnowledgeBaseManager._buildCooccurrenceMatrix()
_buildCooccurrenceMatrix() {
    console.log('[KnowledgeBase] 🧠 Building tag co-occurrence matrix...');
    try {
        const stmt = this.db.prepare(`
            SELECT ft1.tag_id as tag1, ft2.tag_id as tag2, COUNT(ft1.file_id) as weight
            FROM file_tags ft1
            JOIN file_tags ft2 ON ft1.file_id = ft2.file_id AND ft1.tag_id < ft2.tag_id
            GROUP BY ft1.tag_id, ft2.tag_id
        `);

        const matrix = new Map();
        for (const row of stmt.iterate()) {
            if (!matrix.has(row.tag1)) matrix.set(row.tag1, new Map());
            if (!matrix.has(row.tag2)) matrix.set(row.tag2, new Map());

            matrix.get(row.tag1).set(row.tag2, row.weight);
            matrix.get(row.tag2).set(row.tag1, row.weight);
        }
        this.tagCooccurrenceMatrix = matrix;
        console.log(`[KnowledgeBase] ✅ Tag co-occurrence matrix built. (${matrix.size} tags)`);
    } catch (e) {
        console.error('[KnowledgeBase] ❌ Failed to build tag co-occurrence matrix:', e);
        this.tagCooccurrenceMatrix = new Map();
    }
}
```

---

## 依赖与上下文说明

- Tag 从日记文本末尾的 `Tag:` 行中抽取并清洗  
- 通过 `file_tags` 将文件与 tags 关联  
- 共现矩阵用于 TagMemo 的 “逻辑拉回”  

---

## 验证

该方法依赖已初始化的数据库连接，模块加载验证命令：

```bash
node -e "require('./KnowledgeBaseManager');"
```
