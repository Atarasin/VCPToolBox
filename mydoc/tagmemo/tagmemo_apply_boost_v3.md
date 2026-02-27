# TagMemo V3.7 浪潮增强（applyTagBoostV3）

**创新摘要**  
通过 EPA 分析、残差金字塔、共现矩阵拉回与语义去重，构建“结构同构”增强向量。

**依赖环境**  
- EPAModule  
- ResidualPyramid  
- SQLite（tags、file_tags）  
- rag_params.json  

**运行说明**  
由 KnowledgeBaseManager 在检索前调用：`applyTagBoost()` → `_applyTagBoostV3()`。

---

## 完整代码实现

```javascript
_applyTagBoostV3(vector, baseTagBoost, coreTags = [], coreBoostFactor = 1.33) {
    const debug = true;
    const originalFloat32 = vector instanceof Float32Array ? vector : new Float32Array(vector);
    const dim = originalFloat32.length;

    try {
        const epaResult = this.epa.project(originalFloat32);
        const resonance = this.epa.detectCrossDomainResonance(originalFloat32);
        const queryWorld = epaResult.dominantAxes[0]?.label || 'Unknown';

        const pyramid = this.residualPyramid.analyze(originalFloat32);
        const features = pyramid.features;

        const config = this.ragParams?.KnowledgeBaseManager || {};
        const logicDepth = epaResult.logicDepth;
        const entropyPenalty = epaResult.entropy;
        const resonanceBoost = Math.log(1 + resonance.resonance);

        const actRange = config.activationMultiplier || [0.5, 1.5];
        const activationMultiplier = actRange[0] + features.tagMemoActivation * (actRange[1] - actRange[0]);
        const dynamicBoostFactor = (logicDepth * (1 + resonanceBoost) / (1 + entropyPenalty * 0.5)) * activationMultiplier;

        const boostRange = config.dynamicBoostRange || [0.3, 2.0];
        const effectiveTagBoost = baseTagBoost * Math.max(boostRange[0], Math.min(boostRange[1], dynamicBoostFactor));

        const coreMetric = (logicDepth * 0.5) + ((1 - features.coverage) * 0.5);
        const coreRange = config.coreBoostRange || [1.20, 1.40];
        const dynamicCoreBoostFactor = coreRange[0] + (coreMetric * (coreRange[1] - coreRange[0]));

        if (debug) {
            console.log(`[TagMemo-V3.7] World=${queryWorld}, Depth=${logicDepth.toFixed(3)}, Resonance=${resonance.resonance.toFixed(3)}`);
            console.log(`[TagMemo-V3.7] Coverage=${features.coverage.toFixed(3)}, Explained=${(pyramid.totalExplainedEnergy * 100).toFixed(1)}%`);
            console.log(`[TagMemo-V3.7] Effective Boost: ${effectiveTagBoost.toFixed(3)}, Dynamic Core Boost: ${dynamicCoreBoostFactor.toFixed(3)}`);
        }

        const allTags = [];
        const seenTagIds = new Set();
        const safeCoreTags = Array.isArray(coreTags) ? coreTags.filter(t => typeof t === 'string') : [];
        const coreTagSet = new Set(safeCoreTags.map(t => t.toLowerCase()));

        const levels = Array.isArray(pyramid.levels) ? pyramid.levels : [];

        levels.forEach(level => {
            const tags = Array.isArray(level.tags) ? level.tags : [];

            tags.forEach(t => {
                if (!t || seenTagIds.has(t.id)) return;

                const tagName = t.name ? t.name.toLowerCase() : '';
                const isCore = tagName && coreTagSet.has(tagName);
                const individualRelevance = t.similarity || 0.5;
                const coreBoost = isCore ? (dynamicCoreBoostFactor * (0.95 + individualRelevance * 0.1)) : 1.0;

                let langPenalty = 1.0;
                if (this.config.langConfidenceEnabled) {
                    const tName = t.name || '';
                    const isTechnicalNoise = !/[\u4e00-\u9fa5]/.test(tName) && /^[A-Za-z0-9\-_.\s]+$/.test(tName) && tName.length > 3;
                    const isTechnicalWorld = queryWorld !== 'Unknown' && /^[A-Za-z0-9\-_.]+$/.test(queryWorld);

                    if (isTechnicalNoise && !isTechnicalWorld) {
                        const isSocialWorld = /Politics|Society|History|Economics|Culture/i.test(queryWorld);
                        const comp = config.languageCompensator || {};
                        const basePenalty = queryWorld === 'Unknown'
                            ? (comp.penaltyUnknown ?? this.config.langPenaltyUnknown)
                            : (comp.penaltyCrossDomain ?? this.config.langPenaltyCrossDomain);
                        langPenalty = isSocialWorld ? Math.sqrt(basePenalty) : basePenalty;
                    }
                }

                const layerDecay = Math.pow(0.7, level.level);

                allTags.push({
                    ...t,
                    adjustedWeight: (t.contribution || t.weight || 0) * layerDecay * langPenalty * coreBoost,
                    isCore: isCore
                });
                seenTagIds.add(t.id);
            });
        });

        if (allTags.length > 0 && this.tagCooccurrenceMatrix) {
            const topTags = allTags.slice(0, 5);
            topTags.forEach(parentTag => {
                const related = this.tagCooccurrenceMatrix.get(parentTag.id);
                if (related) {
                    const sortedRelated = Array.from(related.entries())
                        .sort((a, b) => b[1] - a[1])
                        .slice(0, 4);

                    sortedRelated.forEach(([relId, weight]) => {
                        if (!seenTagIds.has(relId)) {
                            allTags.push({
                                id: relId,
                                adjustedWeight: parentTag.adjustedWeight * 0.5,
                                isPullback: true
                            });
                            seenTagIds.add(relId);
                        }
                    });
                }
            });
        }

        if (coreTagSet.size > 0) {
            const missingCoreTags = Array.from(coreTagSet).filter(ct =>
                !allTags.some(at => at.name && at.name.toLowerCase() === ct)
            );

            if (missingCoreTags.length > 0) {
                try {
                    const placeholders = missingCoreTags.map(() => '?').join(',');
                    const rows = this.db.prepare(`SELECT id, name, vector FROM tags WHERE name IN (${placeholders})`).all(...missingCoreTags);

                    const maxBaseWeight = allTags.length > 0 ? Math.max(...allTags.map(t => t.adjustedWeight / 1.33)) : 1.0;

                    rows.forEach(row => {
                        if (!seenTagIds.has(row.id)) {
                            allTags.push({
                                id: row.id,
                                name: row.name,
                                adjustedWeight: maxBaseWeight * dynamicCoreBoostFactor,
                                isCore: true,
                                isVirtual: true
                            });
                            seenTagIds.add(row.id);
                        }
                    });
                } catch (e) {
                    console.warn('[TagMemo-V3] Failed to supplement core tags:', e.message);
                }
            }
        }

        if (allTags.length === 0) return { vector: originalFloat32, info: null };

        const allTagIds = allTags.map(t => t.id);
        const tagRows = this.db.prepare(
            `SELECT id, name, vector FROM tags WHERE id IN (${allTagIds.map(() => '?').join(',')})`
        ).all(...allTagIds);
        const tagDataMap = new Map(tagRows.map(r => [r.id, r]));

        const deduplicatedTags = [];
        const sortedTags = [...allTags].sort((a, b) => b.adjustedWeight - a.adjustedWeight);

        for (const tag of sortedTags) {
            const data = tagDataMap.get(tag.id);
            if (!data || !data.vector) continue;

            const vec = new Float32Array(data.vector.buffer, data.vector.byteOffset, dim);
            let isRedundant = false;

            for (const existing of deduplicatedTags) {
                const existingData = tagDataMap.get(existing.id);
                const existingVec = new Float32Array(existingData.vector.buffer, existingData.vector.byteOffset, dim);

                let dot = 0, normA = 0, normB = 0;
                for (let d = 0; d < dim; d++) {
                    dot += vec[d] * existingVec[d];
                    normA += vec[d] * vec[d];
                    normB += existingVec[d] * existingVec[d];
                }
                const similarity = dot / (Math.sqrt(normA) * Math.sqrt(normB));

                const dedupThreshold = config.deduplicationThreshold ?? 0.88;
                if (similarity > dedupThreshold) {
                    isRedundant = true;
                    existing.adjustedWeight += tag.adjustedWeight * 0.2;
                    if (tag.isCore) existing.isCore = true;
                    break;
                }
            }

            if (!isRedundant) {
                if (!tag.name) tag.name = data.name;
                deduplicatedTags.push(tag);
            }
        }

        const contextVec = new Float32Array(dim);
        let totalWeight = 0;

        for (const t of deduplicatedTags) {
            const data = tagDataMap.get(t.id);
            if (data && data.vector) {
                const v = new Float32Array(data.vector.buffer, data.vector.byteOffset, dim);
                for (let d = 0; d < dim; d++) contextVec[d] += v[d] * t.adjustedWeight;
                totalWeight += t.adjustedWeight;
            }
        }

        if (totalWeight > 0) {
            let mag = 0;
            for (let d = 0; d < dim; d++) {
                contextVec[d] /= totalWeight;
                mag += contextVec[d] * contextVec[d];
            }
            mag = Math.sqrt(mag);
            if (mag > 1e-9) for (let d = 0; d < dim; d++) contextVec[d] /= mag;
        } else {
            return { vector: originalFloat32, info: null };
        }

        const fused = new Float32Array(dim);
        let fusedMag = 0;
        for (let d = 0; d < dim; d++) {
            fused[d] = (1 - effectiveTagBoost) * originalFloat32[d] + effectiveTagBoost * contextVec[d];
            fusedMag += fused[d] * fused[d];
        }

        fusedMag = Math.sqrt(fusedMag);
        if (fusedMag > 1e-9) for (let d = 0; d < dim; d++) fused[d] /= fusedMag;

        return {
            vector: fused,
            info: {
                coreTagsMatched: deduplicatedTags.filter(t => t.isCore && t.name).map(t => t.name),
                matchedTags: (() => {
                    if (deduplicatedTags.length === 0) return [];
                    const maxWeight = Math.max(...deduplicatedTags.map(t => t.adjustedWeight));
                    return deduplicatedTags.filter(t => {
                        if (t.isCore) return true;

                        const tName = t.name || '';
                        const isTech = !/[\u4e00-\u9fa5]/.test(tName) && /^[A-Za-z0-9\-_.\s]+$/.test(tName);
                        if (isTech) {
                            return t.adjustedWeight > maxWeight * (config.techTagThreshold ?? 0.08);
                        }
                        return t.adjustedWeight > maxWeight * (config.normalTagThreshold ?? 0.015);
                    }).map(t => t.name).filter(Boolean);
                })(),
                boostFactor: effectiveTagBoost,
                epa: { logicDepth, entropy: entropyPenalty, resonance: resonance.resonance },
                pyramid: { coverage: features.coverage, novelty: features.novelty, depth: features.depth }
            }
        };

    } catch (e) {
        console.error('[KnowledgeBase] TagMemo V3 CRITICAL FAIL:', e);
        return { vector: originalFloat32, info: null };
    }
}
```

---

## 验证

模块加载验证命令：

```bash
node -e "require('./KnowledgeBaseManager');"
```
