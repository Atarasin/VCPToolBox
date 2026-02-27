# 动态 Beta / K 震荡 / Tag 截断

**创新摘要**  
基于 EPA 逻辑深度、共振和语义宽度动态调整检索权重与 K 值，配合标签截断抑制噪音。

**依赖环境**  
- RAGDiaryPlugin  
- ContextVectorManager  
- KnowledgeBaseManager.getEPAAnalysis  
- rag_params.json  

---

## 完整代码实现

```javascript
async _calculateDynamicParams(queryVector, userText, aiText) {
    const userLen = userText ? userText.length : 0;
    let k_base = 3;
    if (userLen > 100) k_base = 6;
    else if (userLen > 30) k_base = 4;

    if (aiText) {
        const tokens = aiText.match(/[a-zA-Z0-9]+|[^\s\x00-\xff]/g) || [];
        const uniqueTokens = new Set(tokens).size;
        if (uniqueTokens > 100) k_base = Math.max(k_base, 6);
        else if (uniqueTokens > 40) k_base = Math.max(k_base, 4);
    }

    const epa = await this.vectorDBManager.getEPAAnalysis(queryVector);
    const L = epa.logicDepth;
    const R = epa.resonance;

    const S = this.contextVectorManager.computeSemanticWidth(queryVector);

    const config = this.ragParams?.RAGDiaryPlugin || {};
    const noise_penalty = config.noise_penalty ?? 0.05;
    const betaInput = L * Math.log(1 + R + 1) - S * noise_penalty;
    const beta = this._sigmoid(betaInput);

    const weightRange = config.tagWeightRange || [0.05, 0.45];
    const finalTagWeight = weightRange[0] + beta * (weightRange[1] - weightRange[0]);

    const kAdjustment = Math.round(L * 3 + Math.log1p(R) * 2);
    const finalK = Math.max(3, Math.min(10, k_base + kAdjustment));

    console.log(`[RAGDiaryPlugin][V3] L=${L.toFixed(3)}, R=${R.toFixed(3)}, S=${S.toFixed(3)} => Beta=${beta.toFixed(3)}, TagWeight=${finalTagWeight.toFixed(3)}, K=${finalK}`);

    let tagTruncationRatio = (config.tagTruncationBase ?? 0.6) + (L * 0.3) - (S * 0.2) + (Math.min(R, 1) * 0.1);
    const truncationRange = config.tagTruncationRange || [0.5, 0.9];
    tagTruncationRatio = Math.max(truncationRange[0], Math.min(truncationRange[1], tagTruncationRatio));

    return {
        k: finalK,
        tagWeight: finalTagWeight,
        tagTruncationRatio: tagTruncationRatio,
        metrics: { L, R, S, beta }
    };
}

_truncateCoreTags(tags, ratio, metrics) {
    if (!tags || tags.length <= 5) return tags;

    const targetCount = Math.max(5, Math.ceil(tags.length * ratio));
    const truncated = tags.slice(0, targetCount);

    if (truncated.length < tags.length) {
        console.log(`[RAGDiaryPlugin][Truncation] ${tags.length} -> ${truncated.length} tags (Ratio: ${ratio.toFixed(2)}, L:${metrics.L.toFixed(2)}, S:${metrics.S.toFixed(2)})`);
    }
    return truncated;
}
```

---

## 验证

```bash
node -e "require('./Plugin/RAGDiaryPlugin/RAGDiaryPlugin');"
```
