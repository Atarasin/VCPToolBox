VCP元思考整理（结合代码与文档）

## 1. 功能定位
VCP元思考是RAGDiaryPlugin中的递归推理链机制，作用是把“元逻辑模块”按多阶段检索与向量融合组织成结构化的推理链，并将其注入系统提示词。触发入口是系统提示词里出现 `[[VCP元思考...]]` 占位符。

相关实现位置：
- Plugin/RAGDiaryPlugin/RAGDiaryPlugin.js：解析占位符并触发元思考链
- Plugin/RAGDiaryPlugin/MetaThinkingManager.js：执行元思考链与格式化输出
- Plugin/RAGDiaryPlugin/meta_thinking_chains.json：链与K序列配置
- Plugin/RAGDiaryPlugin/META_THINKING_GUIDE.md：机制与使用说明

## 2. 触发语法与解析规则

### 2.1 文档语法（说明用）
```
[[VCP元思考:<链名称>::<修饰符>:<k1-k2-k3-k4-k5>]]
```
示例：
- `[[VCP元思考::Group]]`
- `[[VCP元思考::Auto::Group]]`

### 2.2 代码解析规则（实际行为）
入口函数：`RAGDiaryPlugin._processSingleSystemMessage`
- `chainName` 默认 `default`
- `::Group` 开启语义组增强 `useGroup`
- `::Auto` 开启自动主题选择 `isAutoMode`，阈值 `autoThreshold` 默认 0.65，可写成 `Auto:0.7`
- 额外片段会被当作链名（Auto模式除外）
- `kSequence` 不再从占位符传入，改为由 `meta_thinking_chains.json` 提供

## 3. 数据来源与“提示词”注入方式

### 3.1 链与簇定义
`meta_thinking_chains.json` 定义每条链的簇顺序与 K 序列。默认链：
前思维簇 → 逻辑推理簇 → 反思簇 → 结果辩证簇 → 陈词总结梳理簇  
默认 K 序列为 `[2, 1, 1, 1, 1]`。

### 3.2 元逻辑模块来源
每个“簇”对应 `dailynote/` 下同名文件夹，文件夹中的 `.txt/.md` 内容被切块并向量化，作为该簇的“元逻辑模块”参与检索。

示例目录结构（文档）：
```
dailynote/
├── 前思维簇/
├── 逻辑推理簇/
├── 反思簇/
├── 结果辩证簇/
└── 陈词总结梳理簇/
```

### 3.3 注入方式
元思考链执行完成后，会生成一段结构化文本（包含链名、簇路径、每阶段召回内容），并替换 system prompt 中的 `[[VCP元思考...]]` 占位符。

## 4. 运行逻辑（代码级流程）

### 4.1 初始化与依赖注入
- `server.js` 初始化 `KnowledgeBaseManager` 并注入 `PluginManager`
- `Plugin.js` 在初始化 `RAGDiaryPlugin` 时注入 `vectorDBManager`
- `RAGDiaryPlugin.initialize` 加载配置与缓存

### 4.2 元思考链执行流程
1) 解析占位符参数（链名/Auto/Group/阈值）
2) `MetaThinkingManager.loadConfig` 加载链配置与主题向量缓存
3) Auto 模式：用 queryVector 与主题向量比较，超过阈值则切换链名
4) Group 模式：通过 `semanticGroups.detectAndActivateGroups` 增强查询向量
5) 逐簇检索：`vectorDBManager.search(clusterName, currentQueryVector, k)`
6) 向量融合：`currentQueryVector = weightedAverage([queryVector, avgResultVector], [0.8, 0.2])`
7) 格式化输出与缓存，并替换占位符

### 4.3 检索结果来源
`vectorDBManager.search` 最终落在 `KnowledgeBaseManager._searchSpecificIndex`，返回结果文本来自 SQLite 的 `chunks.content` 字段。

## 5. 输出结构
输出文本大致结构如下：
```
[--- VCP元思考链: "链名" ---]
[推理链路径: 前思维簇 → 逻辑推理簇 → ...]

【阶段1: 前思维簇】
  * 元逻辑模块文本...

...
[--- 元思考链结束 ---]
```
当某阶段无召回结果时会标注“降级模式”，并继续后续阶段。

## 6. 自定义思维簇与链配置

### 6.1 新增思维簇的原则
- 每个簇对应一个“思维阶段”，职责清晰且不重叠
- 簇内模块应围绕该阶段的目标编写，避免跨阶段杂糅
- 簇名称应稳定，便于长期维护与检索

### 6.2 新增链与簇步骤（配置与内容双向配套）
1) 在 `meta_thinking_chains.json` 中新增链定义，配置 `clusters` 与 `kSequence`
2) 在 `dailynote/` 下创建对应簇文件夹，并填充元逻辑模块文本
3) 如果需要自动路由，可在链名上构建主题向量（Auto 模式会使用链名向量）

示例配置（示意）：
```
{
  "chains": {
    "novel_longform": {
      "clusters": [
        "前期定位簇",
        "核心设定簇",
        "分层大纲簇",
        "正文推进簇",
        "节奏校准簇"
      ],
      "kSequence": [2, 2, 2, 2, 1]
    }
  }
}
```

示例簇目录：
```
dailynote/
├── 前期定位簇/
├── 核心设定簇/
├── 分层大纲簇/
├── 正文推进簇/
└── 节奏校准簇/
```

## 7. 最佳实践

### 7.1 K 序列设计
- 前期宽度、后期收敛：`3-2-1-1-1`
- 均衡探索：`2-2-2-2-2`
- 快速推理：`1-1-1-1-1`
要求：K 序列长度必须与簇数量一致。

### 7.2 元逻辑模块内容规范
- 单元独立、可复用、避免依赖其他模块上下文
- 长度建议 200–500 字，确保可直接注入系统提示词
- 明确表达可执行的推理步骤、判断模式或结构化视角

### 7.3 语义组（::Group）使用建议
- 输入包含领域术语、情感或明确主题时启用
- 泛化或探索性问题可不启用

### 7.4 Auto 模式使用建议
- Auto 会比较 queryVector 与“主题名向量”
- 默认阈值 0.65，可用 `Auto:0.7` 调整
- 适合存在多条链主题、且希望自动路由的场景

### 7.5 文档与代码差异提示
- 文档示例提到向量融合权重 0.4/0.6
- 代码实现使用 0.8/0.2（queryVector 占 0.8）
实际行为以代码为准，必要时同步修正文档或配置策略。

## 8. 简要案例（长篇小说创作）

目标：将长篇小说创作拆分为多个阶段，不同阶段调用不同思维簇。

建议链：`novel_longform`
阶段与思维簇示意：
- 前期定位筹备阶段 → 前期定位簇：定位题材、受众、风格、篇幅上限、核心主题
- 核心设定创作阶段 → 核心设定簇：世界观、规则、角色关系网、主线矛盾
- 分层大纲搭建阶段 → 分层大纲簇：卷/部/章的层级结构与推进节奏
- 正文创作与连载节奏把控阶段 → 正文推进簇、节奏校准簇：章内节奏、悬念点分布、回收伏笔

使用方式（示意）：
```
[[VCP元思考:novel_longform::Group]]
```

## 9. 详细使用案例索引
详见：`mydoc/dailynote/VCP元思考_长篇小说创作详细案例.md`
