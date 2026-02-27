# 向量索引匹配（VexusIndex / USearch HNSW）

**创新摘要**  
基于 USearch HNSW 的 Rust N-API 索引引擎，提供高性能向量检索与数学算子（SVD、正交投影、握手分析、EPA 投影）。

**依赖环境**  
- Rust + napi  
- usearch / nalgebra  
- Node.js (N-API 加载)  

---

## 完整代码实现（关键算法部分）

以下为 lib.rs 中与向量索引和数学算子直接相关的实现：

```rust
#[napi]
pub struct VexusIndex {
    index: Arc<RwLock<Index>>,
    dimensions: u32,
}

#[napi]
impl VexusIndex {
    #[napi(constructor)]
    pub fn new(dim: u32, capacity: u32) -> Result<Self> {
        let index = Index::new(&usearch::IndexOptions {
            dimensions: dim as usize,
            metric: usearch::MetricKind::L2sq,
            quantization: usearch::ScalarKind::F32,
            connectivity: 16,
            expansion_add: 128,
            expansion_search: 64,
            multi: false,
        })
        .map_err(|e| Error::from_reason(format!("Failed to create index: {:?}", e)))?;

        index
            .reserve(capacity as usize)
            .map_err(|e| Error::from_reason(format!("Failed to reserve capacity: {:?}", e)))?;

        Ok(Self {
            index: Arc::new(RwLock::new(index)),
            dimensions: dim,
        })
    }

    #[napi]
    pub fn add(&self, id: u32, vector: Buffer) -> Result<()> {
        let index = self.index.write()
            .map_err(|e| Error::from_reason(format!("Lock failed: {}", e)))?;

        let vec_slice: &[f32] = unsafe {
            std::slice::from_raw_parts(
                vector.as_ptr() as *const f32,
                vector.len() / std::mem::size_of::<f32>(),
            )
        };

        if vec_slice.len() != self.dimensions as usize {
            return Err(Error::from_reason(format!(
                "Dimension mismatch: expected {}, got {}",
                self.dimensions,
                vec_slice.len()
            )));
        }

        if index.size() + 1 >= index.capacity() {
             let new_cap = (index.capacity() as f64 * 1.5) as usize;
             let _ = index.reserve(new_cap);
        }

        index
            .add(id as u64, vec_slice)
            .map_err(|e| Error::from_reason(format!("Add failed: {:?}", e)))?;

        Ok(())
    }

    #[napi]
    pub fn add_batch(&self, ids: Vec<u32>, vectors: Buffer) -> Result<()> {
        let index = self.index.write()
            .map_err(|e| Error::from_reason(format!("Lock failed: {}", e)))?;

        let count = ids.len();
        let dim = self.dimensions as usize;
        
        let vec_slice: &[f32] = unsafe {
            std::slice::from_raw_parts(
                vectors.as_ptr() as *const f32,
                vectors.len() / std::mem::size_of::<f32>(),
            )
        };

        if vec_slice.len() != count * dim {
             return Err(Error::from_reason("Batch size mismatch".to_string()));
        }

        if index.size() + count >= index.capacity() {
            let new_cap = ((index.size() + count) as f64 * 1.5) as usize;
            let _ = index.reserve(new_cap);
        }

        for (i, id) in ids.iter().enumerate() {
            let start = i * dim;
            let v = &vec_slice[start..start+dim];
            index.add(*id as u64, v)
                .map_err(|e| Error::from_reason(format!("Batch add failed idx {}: {:?}", i, e)))?;
        }

        Ok(())
    }

    #[napi]
    pub fn search(&self, query: Buffer, k: u32) -> Result<Vec<SearchResult>> {
        let index = self.index.read()
            .map_err(|e| Error::from_reason(format!("Lock failed: {}", e)))?;

        let query_slice: &[f32] = unsafe {
            std::slice::from_raw_parts(
                query.as_ptr() as *const f32,
                query.len() / std::mem::size_of::<f32>(),
            )
        };

        if query_slice.len() != self.dimensions as usize {
            return Err(Error::from_reason(format!(
                "Search dimension mismatch: expected {}, got {}. (Check your JS Buffer slicing!)",
                self.dimensions,
                query_slice.len()
            )));
        }

        let matches = index
            .search(query_slice, k as usize)
            .map_err(|e| Error::from_reason(format!("Search failed: {:?}", e)))?;

        let mut results = Vec::with_capacity(matches.keys.len());
        
        for (key, &dist) in matches.keys.iter().zip(matches.distances.iter()) {
            results.push(SearchResult {
                id: *key as u32,
                score: 1.0 - dist as f64,
            });
        }

        Ok(results)
    }

    #[napi]
    pub fn compute_svd(&self, flattened_vectors: Buffer, n: u32, max_k: u32) -> Result<SvdResult> {
        let dim = self.dimensions as usize;
        let n = n as usize;
        let max_k = max_k as usize;

        let vec_slice: &[f32] = unsafe {
            std::slice::from_raw_parts(
                flattened_vectors.as_ptr() as *const f32,
                flattened_vectors.len() / std::mem::size_of::<f32>(),
            )
        };

        if vec_slice.len() != n * dim {
            return Err(Error::from_reason(format!(
                "Flattened vectors length mismatch: expected {}, got {}",
                n * dim,
                vec_slice.len()
            )));
        }

        use nalgebra::DMatrix;
        let matrix = DMatrix::from_row_slice(n, dim, vec_slice);
        
        let svd = matrix.svd(false, true);
        
        let s = svd.singular_values.as_slice().iter().map(|&x| x as f64).collect::<Vec<_>>();
        let v_t = svd.v_t.ok_or_else(|| Error::from_reason("Failed to compute V^T matrix".to_string()))?;
        
        let k = std::cmp::min(s.len(), max_k);
        let mut u_flattened = Vec::with_capacity(k * dim);
        
        for i in 0..k {
            let row = v_t.row(i);
            for &val in row.iter() {
                u_flattened.push(val as f64);
            }
        }

        Ok(SvdResult {
            u: u_flattened,
            s: s[..k].to_vec(),
            k: k as u32,
            dim: dim as u32,
        })
    }

    #[napi]
    pub fn compute_orthogonal_projection(
        &self,
        vector: Buffer,
        flattened_tags: Buffer,
        n_tags: u32,
    ) -> Result<OrthogonalProjectionResult> {
        let dim = self.dimensions as usize;
        let n = n_tags as usize;

        let query: &[f32] = unsafe {
            std::slice::from_raw_parts(vector.as_ptr() as *const f32, vector.len() / 4)
        };
        let tags_slice: &[f32] = unsafe {
            std::slice::from_raw_parts(flattened_tags.as_ptr() as *const f32, flattened_tags.len() / 4)
        };

        if query.len() != dim || tags_slice.len() != n * dim {
            return Err(Error::from_reason("Dimension mismatch".to_string()));
        }

        let mut basis: Vec<Vec<f64>> = Vec::with_capacity(n);
        let mut basis_coefficients = vec![0.0; n];
        let mut projection = vec![0.0; dim];

        for i in 0..n {
            let start = i * dim;
            let tag_vec = &tags_slice[start..start + dim];
            let mut v: Vec<f64> = tag_vec.iter().map(|&x| x as f64).collect();

            for u in &basis {
                let mut dot = 0.0;
                for d in 0..dim {
                    dot += v[d] * u[d];
                }
                for d in 0..dim {
                    v[d] -= dot * u[d];
                }
            }

            let mut mag_sq = 0.0;
            for d in 0..dim {
                mag_sq += v[d] * v[d];
            }
            let mag = mag_sq.sqrt();

            if mag > 1e-6 {
                for d in 0..dim {
                    v[d] /= mag;
                }
                
                let mut coeff = 0.0;
                for d in 0..dim {
                    coeff += (query[d] as f64) * v[d];
                }
                basis_coefficients[i] = coeff.abs();
                
                for d in 0..dim {
                    projection[d] += coeff * v[d];
                }
                basis.push(v);
            }
        }

        let mut residual = vec![0.0; dim];
        for d in 0..dim {
            residual[d] = (query[d] as f64) - projection[d];
        }

        Ok(OrthogonalProjectionResult {
            projection,
            residual,
            basis_coefficients,
        })
    }

    #[napi]
    pub fn compute_handshakes(&self, query: Buffer, flattened_tags: Buffer, n_tags: u32) -> Result<HandshakeResult> {
        let dim = self.dimensions as usize;
        let n = n_tags as usize;

        let q: &[f32] = unsafe {
            std::slice::from_raw_parts(query.as_ptr() as *const f32, query.len() / 4)
        };
        let tags: &[f32] = unsafe {
            std::slice::from_raw_parts(flattened_tags.as_ptr() as *const f32, flattened_tags.len() / 4)
        };

        let mut magnitudes = Vec::with_capacity(n);
        let mut directions = Vec::with_capacity(n * dim);

        for i in 0..n {
            let start = i * dim;
            let tag_vec = &tags[start..start + dim];
            let mut mag_sq = 0.0;
            let mut delta = vec![0.0; dim];

            for d in 0..dim {
                let diff = (q[d] - tag_vec[d]) as f64;
                delta[d] = diff;
                mag_sq += diff * diff;
            }

            let mag = mag_sq.sqrt();
            magnitudes.push(mag);

            if mag > 1e-9 {
                for d in 0..dim {
                    directions.push(delta[d] / mag);
                }
            } else {
                for _ in 0..dim {
                    directions.push(0.0);
                }
            }
        }

        Ok(HandshakeResult {
            magnitudes,
            directions,
        })
    }

    #[napi]
    pub fn project(
        &self,
        vector: Buffer,
        flattened_basis: Buffer,
        mean_vector: Buffer,
        k: u32,
    ) -> Result<ProjectResult> {
        let dim = self.dimensions as usize;
        let k = k as usize;

        let vec: &[f32] = unsafe {
            std::slice::from_raw_parts(vector.as_ptr() as *const f32, vector.len() / 4)
        };
        let basis_slice: &[f32] = unsafe {
            std::slice::from_raw_parts(flattened_basis.as_ptr() as *const f32, flattened_basis.len() / 4)
        };
        let mean: &[f32] = unsafe {
            std::slice::from_raw_parts(mean_vector.as_ptr() as *const f32, mean_vector.len() / 4)
        };

        if vec.len() != dim || basis_slice.len() != k * dim || mean.len() != dim {
            return Err(Error::from_reason("Dimension mismatch".to_string()));
        }

        let mut centered = vec![0.0; dim];
        for d in 0..dim {
            centered[d] = (vec[d] - mean[d]) as f64;
        }

        let mut projections = vec![0.0; k];
        let mut total_energy = 0.0;

        for i in 0..k {
            let start = i * dim;
            let b = &basis_slice[start..start + dim];
            let mut dot = 0.0;
            for d in 0..dim {
                dot += centered[d] * (b[d] as f64);
            }
            projections[i] = dot;
            total_energy += dot * dot;
        }

        let mut probabilities = vec![0.0; k];
        let mut entropy = 0.0;

        if total_energy > 1e-12 {
            for i in 0..k {
                let p = (projections[i] * projections[i]) / total_energy;
                probabilities[i] = p;
                if p > 1e-9 {
                    entropy -= p * p.log2();
                }
            }
        }

        Ok(ProjectResult {
            projections,
            probabilities,
            entropy,
            total_energy,
        })
    }
}
```

完整源文件参考：
- [lib.rs](file:///home/zh/projects/VCPToolBox/rust-vexus-lite/src/lib.rs)

---

## 验证

```bash
node -e "const { VexusIndex } = require('./rust-vexus-lite'); const idx = new VexusIndex(8, 10); const v = new Float32Array(8).fill(0.1); idx.add(1, Buffer.from(v.buffer)); const res = idx.search(Buffer.from(v.buffer), 1); console.log(res);"
```
