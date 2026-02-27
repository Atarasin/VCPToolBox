# 语义分段与 Shotgun Query（ContextVectorManager）

**创新摘要**  
将上下文切成多个语义段，生成多组查询向量，用于扩展召回范围与避免单一 query 偏差（“Shotgun Query”）。

**依赖环境**  
- Node.js  

**运行说明**  
由 RAGDiaryPlugin 在检索时调用 `segmentContext()` 和 `generateHistorySegments()`。

---

## 完整代码实现

```javascript
class ContextVectorManager {
    constructor(config = {}) {
        this.config = {
            maxSegments: config.maxSegments || 3,
            minSegmentLength: config.minSegmentLength || 20,
            overlapRatio: config.overlapRatio || 0.2,
            semanticWidthWindow: config.semanticWidthWindow || 5,
        };
        this.segmentCache = new Map();
        this.semanticWidthCache = new Map();
    }

    segmentContext(text, queryVector) {
        if (!text || text.length < this.config.minSegmentLength) {
            return [{
                text: text,
                vector: queryVector,
                startIdx: 0,
                endIdx: text ? text.length : 0
            }];
        }

        const cacheKey = `${text.substring(0, 50)}_${text.length}`;
        if (this.segmentCache.has(cacheKey)) {
            return this.segmentCache.get(cacheKey);
        }

        const segments = [];
        const totalLength = text.length;
        const maxSegments = Math.min(this.config.maxSegments, Math.max(1, Math.floor(totalLength / 200)));

        if (maxSegments <= 1) {
            return [{
                text: text,
                vector: queryVector,
                startIdx: 0,
                endIdx: totalLength
            }];
        }

        const segmentLength = Math.ceil(totalLength / maxSegments);
        const overlapSize = Math.floor(segmentLength * this.config.overlapRatio);

        let startIdx = 0;
        for (let i = 0; i < maxSegments; i++) {
            let endIdx = Math.min(totalLength, startIdx + segmentLength + overlapSize);
            if (i === maxSegments - 1) endIdx = totalLength;

            const segmentText = text.substring(startIdx, endIdx);

            segments.push({
                text: segmentText,
                vector: null,
                startIdx,
                endIdx
            });

            startIdx = Math.max(0, endIdx - overlapSize);
            if (startIdx >= totalLength) break;
        }

        this.segmentCache.set(cacheKey, segments);
        return segments;
    }

    computeSemanticWidth(vector, window = this.config.semanticWidthWindow) {
        if (!vector) return 0;

        const vectorKey = Array.from(vector.slice(0, 10)).join(',');
        if (this.semanticWidthCache.has(vectorKey)) {
            return this.semanticWidthCache.get(vectorKey);
        }

        let width = 0;
        for (let i = 0; i < vector.length; i += window) {
            const segment = vector.slice(i, i + window);
            let segmentEnergy = 0;
            for (let j = 0; j < segment.length; j++) {
                segmentEnergy += segment[j] * segment[j];
            }
            width += segmentEnergy > 0.1 ? 1 : 0;
        }

        const normalizedWidth = width / Math.ceil(vector.length / window);
        this.semanticWidthCache.set(vectorKey, normalizedWidth);
        return normalizedWidth;
    }

    generateHistorySegments(messageHistory) {
        if (!messageHistory || messageHistory.length === 0) {
            return [];
        }

        const historySegments = [];
        const maxHistory = Math.min(messageHistory.length, 6);

        for (let i = 0; i < maxHistory; i++) {
            const msg = messageHistory[messageHistory.length - 1 - i];
            if (msg.role === 'user' || msg.role === 'assistant') {
                historySegments.push({
                    text: msg.content,
                    role: msg.role,
                    timestamp: msg.timestamp || Date.now(),
                    weight: 1.0 / (i + 1)
                });
            }
        }

        return historySegments;
    }

    clearCache() {
        this.segmentCache.clear();
        this.semanticWidthCache.clear();
    }
}

module.exports = ContextVectorManager;
```

---

## 验证

```bash
node -e "require('./Plugin/RAGDiaryPlugin/ContextVectorManager');"
```
