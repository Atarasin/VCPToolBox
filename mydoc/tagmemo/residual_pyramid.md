# 残差金字塔（Residual Pyramid）

**创新摘要**  
基于 Gram-Schmidt 正交投影，多层分解查询向量的残差能量，生成覆盖率与新颖度信号，指导 TagMemo 增强强度。

**依赖环境**  
- Node.js  
- Rust 投影加速（可选）  
- SQLite tags  

**运行说明**  
由 KnowledgeBaseManager 在检索时调用 `residualPyramid.analyze(queryVector)`。

---

## 完整代码实现（ResidualPyramid.js）

```javascript
/**
 * ResidualPyramid.js
 * 残差金字塔模块 (Physics-Optimized Edition)
 * 功能：基于 Gram-Schmidt 正交化计算多层级语义残差，精确分析语义能量谱。
 */

class ResidualPyramid {
    constructor(tagIndex, db, config = {}) {
        this.tagIndex = tagIndex;
        this.db = db;
        this.config = {
            maxLevels: config.maxLevels || 3,
            topK: config.topK || 10,
            minEnergyRatio: config.minEnergyRatio || 0.1, 
            dimension: config.dimension || 3072,
            ...config
        };
    }

    analyze(queryVector) {
        const dim = this.config.dimension;
        const pyramid = {
            levels: [],
            totalExplainedEnergy: 0,
            finalResidual: null,
            features: {}
        };

        let currentVector = queryVector instanceof Float32Array ? queryVector : new Float32Array(queryVector);
        
        const originalMagnitude = this._magnitude(currentVector);
        const originalEnergy = originalMagnitude * originalMagnitude;
        
        if (originalEnergy < 1e-12) {
            return this._emptyResult(dim);
        }

        let currentResidual = new Float32Array(currentVector);

        for (let level = 0; level < this.config.maxLevels; level++) {
            const searchBuffer = Buffer.from(currentResidual.buffer, currentResidual.byteOffset, currentResidual.byteLength);
            let tagResults;
            try {
                tagResults = this.tagIndex.search(searchBuffer, this.config.topK);
            } catch (e) {
                console.warn(`[Residual] Search failed at level ${level}:`, e.message);
                break;
            }
            
            if (!tagResults || tagResults.length === 0) break;

            const tagIds = tagResults.map(r => r.id);
            const rawTags = this._getTagVectors(tagIds);
            if (rawTags.length === 0) break;
            
            const { projection, residual, orthogonalBasis, basisCoefficients } = this._computeOrthogonalProjection(
                currentResidual, rawTags
            );
            
            const residualMagnitude = this._magnitude(residual);
            const residualEnergy = residualMagnitude * residualMagnitude;
            const currentEnergy = this._magnitude(currentResidual) ** 2;
            
            const energyExplainedByLevel = Math.max(0, currentEnergy - residualEnergy) / originalEnergy;
            const handshakes = this._computeHandshakes(currentResidual, rawTags);

            pyramid.levels.push({
                level,
                tags: rawTags.map((t, i) => {
                    const res = tagResults.find(r => r.id === t.id);
                    return {
                        id: t.id,
                        name: t.name,
                        similarity: res ? res.score : 0,
                        contribution: basisCoefficients[i] || 0, 
                        handshakeMagnitude: handshakes.magnitudes[i]
                    };
                }),
                projectionMagnitude: this._magnitude(projection),
                residualMagnitude,
                residualEnergyRatio: residualEnergy / originalEnergy,
                energyExplained: energyExplainedByLevel,
                handshakeFeatures: this._analyzeHandshakes(handshakes, dim)
            });
            
            pyramid.totalExplainedEnergy += energyExplainedByLevel;
            currentResidual = residual;

            if ((residualEnergy / originalEnergy) < this.config.minEnergyRatio) {
                break;
            }
        }
        
        pyramid.finalResidual = currentResidual;
        pyramid.features = this._extractPyramidFeatures(pyramid);
        
        return pyramid;
    }

    _computeOrthogonalProjection(vector, tags) {
        const dim = this.config.dimension;
        const n = tags.length;

        if (this.tagIndex && typeof this.tagIndex.computeOrthogonalProjection === 'function') {
            try {
                const flattenedTags = new Float32Array(n * dim);
                for (let i = 0; i < n; i++) {
                    const buf = tags[i].vector;
                    const tagVec = new Float32Array(dim);
                    new Uint8Array(tagVec.buffer).set(buf);
                    flattenedTags.set(tagVec, i * dim);
                }

                const result = this.tagIndex.computeOrthogonalProjection(
                    Buffer.from(vector.buffer, vector.byteOffset, vector.byteLength),
                    Buffer.from(flattenedTags.buffer, flattenedTags.byteOffset, flattenedTags.byteLength),
                    n
                );

                return {
                    projection: new Float32Array(result.projection.map(x => x)),
                    residual: new Float32Array(result.residual.map(x => x)),
                    basisCoefficients: new Float32Array(result.basisCoefficients.map(x => x))
                };
            } catch (e) {
                console.warn('[Residual] Rust projection failed, falling back to JS:', e.message);
            }
        }

        const basis = [];
        const basisCoefficients = new Float32Array(n);
        
        for (let i = 0; i < n; i++) {
            const buf = tags[i].vector;
            const tagVec = new Float32Array(dim);
            new Uint8Array(tagVec.buffer).set(buf);
            
            let v = new Float32Array(tagVec);
            
            for (let j = 0; j < basis.length; j++) {
                const u = basis[j];
                const dot = this._dotProduct(v, u);
                for (let d = 0; d < dim; d++) {
                    v[d] -= dot * u[d];
                }
            }
            
            const mag = this._magnitude(v);
            if (mag > 1e-6) {
                for (let d = 0; d < dim; d++) v[d] /= mag;
                basis.push(v);
                
                const coeff = this._dotProduct(vector, v);
                basisCoefficients[i] = Math.abs(coeff);
            } else {
                basisCoefficients[i] = 0;
            }
        }

        const projection = new Float32Array(dim);
        for (let i = 0; i < basis.length; i++) {
            const u = basis[i];
            const dot = this._dotProduct(vector, u);
            for (let d = 0; d < dim; d++) {
                projection[d] += dot * u[d];
            }
        }

        const residual = new Float32Array(dim);
        for (let d = 0; d < dim; d++) {
            residual[d] = vector[d] - projection[d];
        }

        return { projection, residual, orthogonalBasis: basis, basisCoefficients };
    }

    _computeHandshakes(query, tags) {
        const dim = this.config.dimension;
        const n = tags.length;

        if (this.tagIndex && typeof this.tagIndex.computeHandshakes === 'function') {
            try {
                const flattenedTags = new Float32Array(n * dim);
                for (let i = 0; i < n; i++) {
                    const buf = tags[i].vector;
                    const tagVec = new Float32Array(dim);
                    new Uint8Array(tagVec.buffer).set(buf);
                    flattenedTags.set(tagVec, i * dim);
                }

                const result = this.tagIndex.computeHandshakes(
                    Buffer.from(query.buffer, query.byteOffset, query.byteLength),
                    Buffer.from(flattenedTags.buffer, flattenedTags.byteOffset, flattenedTags.byteLength),
                    n
                );

                const directions = [];
                for (let i = 0; i < n; i++) {
                    directions.push(new Float32Array(
                        result.directions.slice(i * dim, (i + 1) * dim).map(x => x)
                    ));
                }

                return { magnitudes: result.magnitudes.map(x => x), directions };
            } catch (e) {
                console.warn('[Residual] Rust handshakes failed, falling back to JS:', e.message);
            }
        }

        const magnitudes = [];
        const directions = [];
        
        for (let i = 0; i < n; i++) {
            const buf = tags[i].vector;
            const tagVec = new Float32Array(dim);
            new Uint8Array(tagVec.buffer).set(buf);
            const delta = new Float32Array(dim);
            let magSq = 0;
            for (let d = 0; d < dim; d++) {
                delta[d] = query[d] - tagVec[d];
                magSq += delta[d] * delta[d];
            }
            const mag = Math.sqrt(magSq);
            magnitudes.push(mag);
            
            const dir = new Float32Array(dim);
            if (mag > 1e-9) {
                for (let d = 0; d < dim; d++) dir[d] = delta[d] / mag;
            }
            directions.push(dir);
        }
        return { magnitudes, directions };
    }

    _analyzeHandshakes(handshakes, dim) {
        const n = handshakes.magnitudes.length;
        if (n === 0) return null;
        
        const avgDirection = new Float32Array(dim);
        for (let i = 0; i < n; i++) {
            for (let d = 0; d < dim; d++) avgDirection[d] += handshakes.directions[i][d];
        }
        for (let d = 0; d < dim; d++) avgDirection[d] /= n;
        
        const directionCoherence = this._magnitude(avgDirection);
        
        let pairwiseSimSum = 0;
        let pairCount = 0;
        const limit = Math.min(n, 5); 
        for (let i = 0; i < limit; i++) {
            for (let j = i + 1; j < limit; j++) {
                pairwiseSimSum += Math.abs(this._dotProduct(handshakes.directions[i], handshakes.directions[j]));
                pairCount++;
            }
        }
        const avgPairwiseSim = pairCount > 0 ? pairwiseSimSum / pairCount : 0;
        
        return {
            directionCoherence, 
            patternStrength: avgPairwiseSim,
            noveltySignal: directionCoherence,
            noiseSignal: (1 - directionCoherence) * (1 - avgPairwiseSim)
        };
    }

    _extractPyramidFeatures(pyramid) {
        if (pyramid.levels.length === 0) {
            return { depth: 0, coverage: 0, novelty: 1, coherence: 0, tagMemoActivation: 0 };
        }

        const level0 = pyramid.levels[0];
        const handshake = level0.handshakeFeatures;
        
        const coverage = Math.min(1.0, pyramid.totalExplainedEnergy);
        const coherence = handshake ? handshake.patternStrength : 0;

        const residualRatio = 1 - coverage;
        const directionalNovelty = handshake ? handshake.noveltySignal : 0;
        const novelty = (residualRatio * 0.7) + (directionalNovelty * 0.3);

        return {
            depth: pyramid.levels.length,
            coverage,
            novelty,
            coherence,
            tagMemoActivation: coverage * coherence * (1 - (handshake?.noiseSignal || 0)),
            expansionSignal: novelty
        };
    }

    _getTagVectors(ids) {
        const placeholders = ids.map(() => '?').join(',');
        return this.db.prepare(`
            SELECT id, name, vector FROM tags WHERE id IN (${placeholders})
        `).all(...ids);
    }

    _magnitude(vec) {
        let sum = 0;
        for (let i = 0; i < vec.length; i++) sum += vec[i] * vec[i];
        return Math.sqrt(sum);
    }

    _dotProduct(v1, v2) {
        let sum = 0;
        for (let i = 0; i < v1.length; i++) sum += v1[i] * v2[i];
        return sum;
    }

    _emptyResult(dim) {
        return {
            levels: [],
            totalExplainedEnergy: 0,
            finalResidual: new Float32Array(dim),
            features: { depth: 0, coverage: 0, novelty: 1, coherence: 0, tagMemoActivation: 0 }
        };
    }
}

module.exports = ResidualPyramid;
```

---

## 验证

```bash
node -e "require('./ResidualPyramid');"
```
