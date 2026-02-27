# TagMemo 参数配置（rag_params.json）

**创新摘要**  
用于控制 TagMemo 动态参数：动态 Beta、TagBoost、去重阈值与语言惩罚。

---

## 完整配置

```json
{
  "RAGDiaryPlugin": {
    "noise_penalty": 0.05,
    "tagWeightRange": [0.05, 0.45],
    "tagTruncationBase": 0.6,
    "tagTruncationRange": [0.5, 0.9]
  },
  "KnowledgeBaseManager": {
    "activationMultiplier": [0.5, 1.5],
    "dynamicBoostRange": [0.3, 2.0],
    "coreBoostRange": [1.20, 1.40],
    "deduplicationThreshold": 0.88,
    "techTagThreshold": 0.08,
    "normalTagThreshold": 0.015,
    "languageCompensator": {
      "penaltyUnknown": 0.05,
      "penaltyCrossDomain": 0.1
    }
  }
}
```
