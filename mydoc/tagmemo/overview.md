# 创新点总览与对照表

**来源文档**：[TagMemo-浪潮RAG 开发回忆录.md](file:///home/zh/projects/VCPToolBox/TagMemo-浪潮RAG%20开发回忆录.md)  

---

## 1. 创新点识别清单

| 创新/算法 | 回忆录位置 | 实现状态 | 实现文件 |
|---|---|---|---|
| 中文时域解析器 | 1.2 时间的打捞者 | 已实现 | TimeExpressionParser.js, timeExpressions.config.js |
| Group 词元组网系统 | 1.3 Group 词元组网 | 已实现 | SemanticGroupManager.js, semantic_groups.json.example |
| Tag 共现矩阵 | 第二章 共现矩阵 | 已实现 | KnowledgeBaseManager._buildCooccurrenceMatrix |
| EPA-SVD | 第三章 SVD 降临 | 已实现 | EPAModule.js + Rust compute_svd |
| 残差金字塔 | 第三章 残差金字塔 | 已实现 | ResidualPyramid.js |
| CoreTagBoost | 3.3 直觉与补全 | 已实现 | KnowledgeBaseManager._applyTagBoostV3 |
| 动态 Beta 参数 | 浪潮算法含义 | 已实现 | RAGDiaryPlugin._calculateDynamicParams |
| Tag 拓扑检测 | 浪潮算法含义 | 部分实现 | Tag 共现矩阵 + TagMemo 去重 |
| 语义分段 / Shotgun Query | RAGDiaryPlugin V4 语义分段 | 已实现 | ContextVectorManager.js |
| 偏振语义舵 | 第四章 偏振语义舵 | 未在代码中发现 | 无 |
| 能量尾（Energy Tail） | 3.3 直觉与补全 | 未在代码中发现 | 无 |
| 投影分叉 / 辩证检索 | 第四章 辩证与偏振 | 未在代码中发现 | 无 |

---

## 2. 说明

- “部分实现”表示有对应机制，但未见命名为回忆录中的原术语  
- “未在代码中发现”表示当前代码库未包含对应算法实现或配置  
