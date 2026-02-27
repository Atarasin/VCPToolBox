# EPA-SVD 模块

**创新摘要**  
EPA 模块通过加权 PCA（SVD 近似）构建正交语义基，输出逻辑深度与跨域共振信号，为 TagMemo 动态增强提供驱动。

**依赖环境**  
- Node.js  
- SQLite tags/kv_store  
- Rust 投影加速（可选）  

**运行说明**  
由 KnowledgeBaseManager 初始化后调用 `epa.project()` 与 `epa.detectCrossDomainResonance()`。

---

## 完整代码实现（EPAModule.js）

```javascript
/**
 * EPAModule.js (Physics-Optimized Edition)
 * 嵌入投影分析模块
 * 优化点：加权中心化 PCA、鲁棒 K-Means、基于能量共现的共振检测
 */

class EPAModule {
    constructor(db, config = {}) {
        this.db = db;
        this.config = {
            maxBasisDim: config.maxBasisDim || 64,
            minVarianceRatio: config.minVarianceRatio || 0.01,
            clusterCount: config.clusterCount || 32,
            dimension: config.dimension || 3072,
            strictOrthogonalization: config.strictOrthogonalization !== undefined ? config.strictOrthogonalization : true,
            vexusIndex: config.vexusIndex || null,
            ...config
        };
        
        this.orthoBasis = null;
        this.basisMean = null;
        this.basisLabels = null;
        this.basisEnergies = null;
        
        this.initialized = false;
    }

    async initialize() {
        console.log('[EPA] 🧠 Initializing orthogonal basis (Weighted PCA)...');
        
        try {
            if (await this._loadFromCache()) {
                console.log(`[EPA] 💾 Loaded basis from cache.`);
                this.initialized = true;
                return true;
            }

            const tags = this.db.prepare(`SELECT id, name, vector FROM tags WHERE vector IS NOT NULL`).all();
            if (tags.length < 8) return false;

            const clusterData = this._clusterTags(tags, Math.min(tags.length, this.config.clusterCount));
            const svdResult = this._computeWeightedPCA(clusterData);
            
            const { U, S, meanVector, labels } = svdResult;
            const K = this._selectBasisDimension(S);
            
            this.orthoBasis = U.slice(0, K);
            this.basisEnergies = S.slice(0, K);
            this.basisMean = meanVector;
            this.basisLabels = labels ? labels.slice(0, K) : clusterData.labels.slice(0, K);
            
            await this._saveToCache();
            this.initialized = true;
            return true;
        } catch (e) {
            console.error('[EPA] ❌ Init failed:', e);
            return false;
        }
    }

    project(vector) {
        if (!this.initialized || !this.orthoBasis) return this._emptyResult();
        
        const vec = vector instanceof Float32Array ? vector : new Float32Array(vector);
        const dim = vec.length;
        const K = this.orthoBasis.length;

        let projections, probabilities, entropy, totalEnergy;

        if (this.config.vexusIndex && typeof this.config.vexusIndex.project === 'function') {
            try {
                const flattenedBasis = new Float32Array(K * dim);
                for (let k = 0; k < K; k++) {
                    flattenedBasis.set(this.orthoBasis[k], k * dim);
                }

                const result = this.config.vexusIndex.project(
                    Buffer.from(vec.buffer, vec.byteOffset, vec.byteLength),
                    Buffer.from(flattenedBasis.buffer, flattenedBasis.byteOffset, flattenedBasis.byteLength),
                    Buffer.from(this.basisMean.buffer, this.basisMean.byteOffset, this.basisMean.byteLength),
                    K
                );
                
                projections = new Float32Array(result.projections.map(x => x));
                probabilities = new Float32Array(result.probabilities.map(x => x));
                entropy = result.entropy;
                totalEnergy = result.totalEnergy;
            } catch (e) {
                console.warn('[EPA] Rust projection failed, falling back to JS:', e.message);
            }
        }

        if (!projections) {
            const centeredVec = new Float32Array(dim);
            for(let i=0; i<dim; i++) centeredVec[i] = vec[i] - this.basisMean[i];

            projections = new Float32Array(K);
            totalEnergy = 0;
            
            for (let k = 0; k < K; k++) {
                let dot = 0;
                const basis = this.orthoBasis[k];
                for (let d = 0; d < dim; d++) {
                    dot += centeredVec[d] * basis[d];
                }
                projections[k] = dot;
                totalEnergy += dot * dot;
            }
            
            if (totalEnergy < 1e-12) return this._emptyResult();
            
            probabilities = new Float32Array(K);
            entropy = 0;
            for (let k = 0; k < K; k++) {
                probabilities[k] = (projections[k] * projections[k]) / totalEnergy;
                if (probabilities[k] > 1e-9) {
                    entropy -= probabilities[k] * Math.log2(probabilities[k]);
                }
            }
        }
        
        const normalizedEntropy = K > 1 ? entropy / Math.log2(K) : 0;
        
        const dominantAxes = [];
        for (let k = 0; k < K; k++) {
            if (probabilities[k] > 0.05) { 
                dominantAxes.push({
                    index: k,
                    label: this.basisLabels[k],
                    energy: probabilities[k],
                    projection: projections[k]
                });
            }
        }
        dominantAxes.sort((a, b) => b.energy - a.energy);
        
        return {
            projections,
            probabilities,
            entropy: normalizedEntropy,
            logicDepth: 1 - normalizedEntropy,
            dominantAxes
        };
    }

    detectCrossDomainResonance(vector) {
        const { dominantAxes } = this.project(vector);
        if (dominantAxes.length < 2) return { resonance: 0, bridges: [] };
        
        const bridges = [];
        const topAxis = dominantAxes[0];
        
        for (let i = 1; i < dominantAxes.length; i++) {
            const secondaryAxis = dominantAxes[i];
            const coActivation = Math.sqrt(topAxis.energy * secondaryAxis.energy);
            if (coActivation > 0.15) { 
                bridges.push({
                    from: topAxis.label,
                    to: secondaryAxis.label,
                    strength: coActivation,
                    balance: Math.min(topAxis.energy, secondaryAxis.energy) / Math.max(topAxis.energy, secondaryAxis.energy)
                });
            }
        }
        
        const resonance = bridges.reduce((sum, b) => sum + b.strength, 0);
        return { resonance, bridges };
    }

    _clusterTags(tags, k) {
        const dim = this.config.dimension;
        const vectors = tags.map(t => {
            const buf = t.vector;
            const aligned = new Float32Array(dim);
            new Uint8Array(aligned.buffer).set(buf);
            return aligned;
        });
        
        let centroids = [];
        const indices = new Set();
        while(indices.size < k) indices.add(Math.floor(Math.random() * vectors.length));
        centroids = Array.from(indices).map(i => new Float32Array(vectors[i]));

        let clusterSizes = new Float32Array(k);
        const maxIter = 50;
        const tolerance = 1e-4;

        for (let iter = 0; iter < maxIter; iter++) {
            const clusters = Array.from({ length: k }, () => []);
            let movement = 0;
            
            vectors.forEach(v => {
                let maxSim = -Infinity, bestK = 0;
                centroids.forEach((c, i) => {
                    let dot = 0;
                    for(let d=0; d<dim; d++) dot += v[d] * c[d];
                    if (dot > maxSim) { maxSim = dot; bestK = i; }
                });
                clusters[bestK].push(v);
            });
            
            const newCentroids = clusters.map((cvs, i) => {
                if (cvs.length === 0) return centroids[i];
                const newC = new Float32Array(dim);
                cvs.forEach(v => { for(let d=0; d<dim; d++) newC[d] += v[d]; });
                
                let mag = 0;
                for(let d=0; d<dim; d++) mag += newC[d]**2;
                mag = Math.sqrt(mag);
                if (mag > 1e-9) for(let d=0; d<dim; d++) newC[d] /= mag;
                
                let distSq = 0;
                for(let d=0; d<dim; d++) distSq += (newC[d] - centroids[i][d])**2;
                movement += distSq;
                
                return newC;
            });
            
            clusterSizes = clusters.map(c => c.length);
            centroids = newCentroids;
            
            if (movement < tolerance) {
                break;
            }
        }
        
        const labels = centroids.map(c => {
            let maxSim = -Infinity, closest = 'Unknown';
            vectors.forEach((v, i) => {
                let dot = 0;
                for(let d=0; d<dim; d++) dot += c[d] * v[d];
                if (dot > maxSim) { maxSim = dot; closest = tags[i].name; }
            });
            return closest;
        });
        
        return { vectors: centroids, labels, weights: clusterSizes };
    }

    _computeWeightedPCA(clusterData) {
        const { vectors, weights } = clusterData;
        const n = vectors.length;
        const dim = this.config.dimension;
        const totalWeight = weights.reduce((a,b) => a+b, 0);
        
        const meanVector = new Float32Array(dim);
        for (let i = 0; i < n; i++) {
            const w = weights[i];
            for (let d = 0; d < dim; d++) {
                meanVector[d] += vectors[i][d] * w;
            }
        }
        for (let d = 0; d < dim; d++) meanVector[d] /= totalWeight;
        
        const centeredScaledVectors = vectors.map((v, i) => {
            const vec = new Float32Array(dim);
            const scale = Math.sqrt(weights[i]);
            for (let d = 0; d < dim; d++) {
                vec[d] = (v[d] - meanVector[d]) * scale;
            }
            return vec;
        });

        const gram = new Float32Array(n * n);
        for (let i = 0; i < n; i++) {
            for (let j = i; j < n; j++) {
                let dot = 0;
                for (let d = 0; d < dim; d++) dot += centeredScaledVectors[i][d] * centeredScaledVectors[j][d];
                gram[i * n + j] = gram[j * n + i] = dot;
            }
        }

        const eigenvectors = [];
        const eigenvalues = [];
        const gramCopy = new Float32Array(gram);
        
        const maxBasis = Math.min(n, this.config.maxBasisDim);
        
        for (let k = 0; k < maxBasis; k++) {
            const { vector: v, value } = this._powerIteration(gramCopy, n, eigenvectors);
            if (value < 1e-6) break;
            
            eigenvectors.push(v);
            eigenvalues.push(value);
            
            for (let i = 0; i < n; i++) {
                for (let j = 0; j < n; j++) {
                    gramCopy[i * n + j] -= value * v[i] * v[j];
                }
            }
        }

        const U = eigenvectors.map((ev, idx) => {
            const basis = new Float32Array(dim);
            
            for (let i = 0; i < n; i++) {
                const weight = ev[i];
                if (Math.abs(weight) > 1e-9) {
                    for (let d = 0; d < dim; d++) {
                        basis[d] += weight * centeredScaledVectors[i][d];
                    }
                }
            }
            
            let mag = 0;
            for(let d=0; d<dim; d++) mag += basis[d]**2;
            mag = Math.sqrt(mag);
            if (mag > 1e-9) for(let d=0; d<dim; d++) basis[d] /= mag;
            
            return basis;
        });

        return { U, S: eigenvalues, meanVector, labels: clusterData.labels };
    }

    _powerIteration(matrix, n, existingBasis) {
        let v = new Float32Array(n).map(() => Math.random() - 0.5);
        let lastVal = 0;
        
        for (let iter = 0; iter < 100; iter++) {
            const w = new Float32Array(n);
            
            for (let r = 0; r < n; r++) {
                for (let c = 0; c < n; c++) w[r] += matrix[r * n + c] * v[c];
            }
            
            let val = 0;
            for(let i=0; i<n; i++) val += v[i] * w[i];
            
            if (this.config.strictOrthogonalization && existingBasis && existingBasis.length > 0) {
                 for (const prevV of existingBasis) {
                     let dot = 0;
                     for(let i=0; i<n; i++) dot += w[i] * prevV[i];
                     for(let i=0; i<n; i++) w[i] -= dot * prevV[i];
                 }
            }

            let mag = 0;
            for(let i=0; i<n; i++) mag += w[i]**2;
            mag = Math.sqrt(mag);
            
            if (mag < 1e-9) break;
            
            for(let i=0; i<n; i++) v[i] = w[i] / mag;
            
            if (Math.abs(val - lastVal) < 1e-6) {
                lastVal = val;
                break;
            }
            lastVal = val;
        }
        return { vector: v, value: lastVal };
    }

    _selectBasisDimension(S) {
        const total = S.reduce((a, b) => a + b, 0);
        let cum = 0;
        for (let i = 0; i < S.length; i++) {
            cum += S[i];
            if (cum / total > 0.95) return Math.max(i + 1, 8);
        }
        return S.length;
    }

    async _saveToCache() {
        try {
            const data = {
                basis: this.orthoBasis.map(b => Buffer.from(b.buffer).toString('base64')),
                mean: Buffer.from(this.basisMean.buffer).toString('base64'),
                energies: Array.from(this.basisEnergies),
                labels: this.basisLabels,
                timestamp: Date.now(),
                tagCount: this.db.prepare("SELECT COUNT(*) as count FROM tags").get().count
            };
            this.db.prepare("INSERT OR REPLACE INTO kv_store (key, value) VALUES (?, ?)").run('epa_basis_cache', JSON.stringify(data));
        } catch (e) { console.error('[EPA] Save cache error:', e); }
    }

    async _loadFromCache() {
        try {
            const row = this.db.prepare("SELECT value FROM kv_store WHERE key = ?").get('epa_basis_cache');
            if (!row) return false;
            const data = JSON.parse(row.value);
            
            if (!data.mean) return false;

            this.orthoBasis = data.basis.map(b64 => {
                const buf = Buffer.from(b64, 'base64');
                const aligned = new Float32Array(buf.length / 4);
                new Uint8Array(aligned.buffer).set(buf);
                return aligned;
            });
            const meanBuf = Buffer.from(data.mean, 'base64');
            this.basisMean = new Float32Array(meanBuf.length / 4);
            new Uint8Array(this.basisMean.buffer).set(meanBuf);
            
            this.basisEnergies = new Float32Array(data.energies);
            this.basisLabels = data.labels;
            return true;
        } catch (e) { return false; }
    }

    _emptyResult() {
        return { projections: null, probabilities: null, entropy: 1, logicDepth: 0, dominantAxes: [] };
    }
}

module.exports = EPAModule;
```

---

## 验证

```bash
node -e "require('./EPAModule');"
```
