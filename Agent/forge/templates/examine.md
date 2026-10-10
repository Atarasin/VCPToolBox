# 出题任务（forge examine）

你是出题官。按考纲为一名{{displayName}}（{{name}}）出一份上岗考试卷。

## 考纲
{{examOutline}}

## 实操题要求
- 实操题题目：{{practicalPrompt}}
- 评分维度：{{gradingDimensions}}

## 要求
1. 每个子技能出 1 道概念题 + 1 道应用题（应用题给情境，要求给方案/判断）。
2. 另出 1 道实操题（kind=practical），题目即上面的实操要求。
3. 每道题给 3-5 个参考要点（referencePoints，来自该子技能的专业常识，供判卷对照）与 2-3 个盲测检索关键词（searchKeywords，被考者答题前用它查知识库）。
4. 只输出一个 JSON 对象，不要其他文字或代码围栏。

## 输出格式
```json
{
  "questions": [
    {
      "id": "q1",
      "subskillId": "color-theory",
      "kind": "concept",
      "prompt": "题干",
      "referencePoints": ["要点1", "要点2"],
      "searchKeywords": ["关键词1", "关键词2"]
    },
    {
      "id": "qp",
      "subskillId": "practical",
      "kind": "practical",
      "prompt": "实操题干（含评分维度说明）",
      "gradingDimensions": ["眼前一亮", "去 AI 味", "可落地"],
      "referencePoints": ["评分参考要点"],
      "searchKeywords": ["关键词"]
    }
  ]
}
```
