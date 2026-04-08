export function renderCheckpointReviewPanel(containerElement, store, api, storyId, checkpoint) {
    if (!containerElement || !checkpoint) return;

    const wrapper = document.createElement('div');
    wrapper.className = 'checkpoint-review-panel d-flex h-100';
    wrapper.style.backgroundColor = '#f8f9fa';

    let currentArtifactIndex = 0;
    
    const artifacts = parseArtifacts(checkpoint);

    render();

    function parseArtifacts(checkpoint) {
        const result = [];
        const type = checkpoint.type;
        const payload = checkpoint.payload || {};

        if (type === 'phase1_checkpoint') {
            if (payload.worldview) {
                result.push({
                    id: 'worldview',
                    title: '世界观设定',
                    type: 'worldview',
                    data: payload.worldview
                });
            }
            if (payload.characters) {
                result.push({
                    id: 'characters',
                    title: '角色设定',
                    type: 'characters',
                    data: payload.characters
                });
            }
        } else if (type === 'outline_checkpoint') {
            if (payload.outline) {
                result.push({
                    id: 'outline',
                    title: '故事大纲',
                    type: 'outline',
                    data: payload.outline
                });
            }
            if (payload.chapters) {
                 result.push({
                    id: 'chapters',
                    title: '章节列表',
                    type: 'chapters',
                    data: payload.chapters
                });
            }
        } else if (type === 'content_checkpoint' || type === 'final_checkpoint') {
            if (payload.chapters && Array.isArray(payload.chapters)) {
                payload.chapters.forEach(ch => {
                    result.push({
                        id: `chapter-${ch.chapterNum || ch.number}`,
                        title: ch.title || `第${ch.chapterNum || ch.number}章`,
                        type: 'chapter',
                        data: ch
                    });
                });
            }
        }

        if (result.length === 0) {
            result.push({
                id: 'raw-payload',
                title: '检查点数据',
                type: 'raw',
                data: payload
            });
        }
        
        return result;
    }

    function render() {
        wrapper.innerHTML = '';
        
        const leftCol = document.createElement('div');
        leftCol.className = 'border-end bg-white';
        leftCol.style.width = '250px';
        leftCol.style.display = 'flex';
        leftCol.style.flexDirection = 'column';
        leftCol.innerHTML = `
            <div class="p-3 border-bottom bg-light">
                <h6 class="mb-0 fw-bold">产物列表</h6>
            </div>
            <div class="list-group list-group-flush flex-grow-1 overflow-auto">
                ${artifacts.map((a, i) => `
                    <button type="button" class="list-group-item list-group-item-action ${i === currentArtifactIndex ? 'active' : ''}" data-index="${i}">
                        ${escapeHtml(a.title)}
                    </button>
                `).join('')}
            </div>
        `;

        const navButtons = leftCol.querySelectorAll('.list-group-item');
        navButtons.forEach(btn => {
            btn.addEventListener('click', (e) => {
                currentArtifactIndex = parseInt(e.target.getAttribute('data-index'), 10);
                render();
            });
        });

        const centerCol = document.createElement('div');
        centerCol.className = 'flex-grow-1 bg-white p-4 overflow-auto';
        
        const currentArtifact = artifacts[currentArtifactIndex];
        let contentHtml = '';

        if (currentArtifact) {
            if (currentArtifact.type === 'worldview') {
                 contentHtml = `
                    <h4>${escapeHtml(currentArtifact.title)}</h4>
                    <div class="mt-4">
                        <h5>背景设定</h5>
                        <p class="whitespace-pre-wrap">${escapeHtml(currentArtifact.data.setting || '暂无设定')}</p>
                    </div>
                `;
            } else if (currentArtifact.type === 'characters') {
                 const chars = currentArtifact.data.characters || currentArtifact.data;
                 const charList = Array.isArray(chars) ? chars : [];
                 contentHtml = `
                    <h4>${escapeHtml(currentArtifact.title)}</h4>
                    <div class="mt-4 row">
                        ${charList.map(c => `
                            <div class="col-md-6 mb-3">
                                <div class="card h-100">
                                    <div class="card-body">
                                        <h5 class="card-title">${escapeHtml(c.name || '未知角色')}</h5>
                                        <h6 class="card-subtitle mb-2 text-muted">${escapeHtml(c.roleType || '未知定位')}</h6>
                                        <p class="card-text text-sm">${escapeHtml(c.description || c.bio || '暂无简介')}</p>
                                    </div>
                                </div>
                            </div>
                        `).join('')}
                    </div>
                `;
            } else if (currentArtifact.type === 'outline') {
                 const cards = currentArtifact.data.chapterCards || [];
                 contentHtml = `
                    <h4>${escapeHtml(currentArtifact.title)}</h4>
                    <div class="mt-4">
                        ${cards.map(c => `
                            <div class="card mb-3">
                                <div class="card-header bg-light">
                                    <strong>${escapeHtml(c.title || \`第\${c.number}章\`)}</strong>
                                </div>
                                <div class="card-body">
                                    <p class="mb-0">${escapeHtml(c.description || c.summary || '暂无大纲')}</p>
                                </div>
                            </div>
                        `).join('')}
                    </div>
                 `;
            } else if (currentArtifact.type === 'chapter') {
                contentHtml = `
                    <h4>${escapeHtml(currentArtifact.title)}</h4>
                    <div class="mt-4 lh-lg whitespace-pre-wrap" style="font-family: serif; font-size: 1.1rem;">${escapeHtml(currentArtifact.data.content || currentArtifact.data.text || '')}</div>
                `;
            } else {
                 contentHtml = `
                    <h4>${escapeHtml(currentArtifact.title)}</h4>
                    <pre class="bg-light p-3 rounded mt-4"><code>${escapeHtml(JSON.stringify(currentArtifact.data, null, 2))}</code></pre>
                 `;
            }
        }

        centerCol.innerHTML = contentHtml;


        const rightCol = document.createElement('div');
        rightCol.className = 'border-start bg-white';
        rightCol.style.width = '350px';
        rightCol.style.display = 'flex';
        rightCol.style.flexDirection = 'column';

        const chips = [
            "Needs stronger conflict",
            "Pacing uneven",
            "Character motivation unclear",
            "Too descriptive",
            "Dialogue feels unnatural"
        ];

        rightCol.innerHTML = `
            <div class="p-3 border-bottom bg-light">
                <h6 class="mb-0 fw-bold">审核操作</h6>
            </div>
            <div class="p-3 flex-grow-1 d-flex flex-column">
                <div class="alert alert-info py-2 text-sm">
                    请仔细审阅左侧产物。如果通过，工作流将继续进行；如果拒绝，工作流将返回上一阶段重试。
                </div>
                
                <div class="mb-3">
                    <label class="form-label fw-bold text-sm">快捷反馈 (点击添加)</label>
                    <div class="d-flex flex-wrap gap-1" id="feedback-chips">
                        ${chips.map(chip => `
                            <span class="badge bg-light text-dark border feedback-chip" style="cursor:pointer;">${escapeHtml(chip)}</span>
                        `).join('')}
                    </div>
                </div>

                <div class="mb-3 flex-grow-1 d-flex flex-column">
                    <label class="form-label fw-bold text-sm">修改意见 (拒绝时必填)</label>
                    <textarea id="feedback-text" class="form-control flex-grow-1" placeholder="请详细说明需要修改的地方..."></textarea>
                </div>
                
                <div class="d-grid gap-2 mt-auto">
                    <button id="btn-approve" class="btn btn-success btn-lg">
                        <i class="bi bi-check-circle me-1"></i> 批准 (Approve)
                    </button>
                    <button id="btn-reject" class="btn btn-danger btn-lg">
                        <i class="bi bi-x-circle me-1"></i> 拒绝 (Reject)
                    </button>
                </div>
            </div>
        `;

        const feedbackText = rightCol.querySelector('#feedback-text');
        
        rightCol.querySelectorAll('.feedback-chip').forEach(chip => {
            chip.addEventListener('click', () => {
                const text = chip.textContent;
                const current = feedbackText.value;
                feedbackText.value = current ? current + '
- ' + text : '- ' + text;
            });
        });

        const btnApprove = rightCol.querySelector('#btn-approve');
        const btnReject = rightCol.querySelector('#btn-reject');

        btnApprove.addEventListener('click', async () => {
            try {
                btnApprove.disabled = true;
                btnReject.disabled = true;
                btnApprove.innerHTML = '<span class="spinner-border spinner-border-sm" role="status" aria-hidden="true"></span> 处理中...';
                
                await api.approveCheckpoint(storyId, checkpoint.id);
                
                alert('审核已通过！工作流将继续。');
                
                window.location.reload();
            } catch (err) {
                alert('批准失败: ' + err.message);
                btnApprove.disabled = false;
                btnReject.disabled = false;
                btnApprove.innerHTML = '<i class="bi bi-check-circle me-1"></i> 批准 (Approve)';
            }
        });

        btnReject.addEventListener('click', async () => {
            const feedback = feedbackText.value.trim();
            if (!feedback) {
                alert('拒绝时必须提供修改意见！');
                feedbackText.focus();
                return;
            }

            try {
                btnApprove.disabled = true;
                btnReject.disabled = true;
                btnReject.innerHTML = '<span class="spinner-border spinner-border-sm" role="status" aria-hidden="true"></span> 处理中...';
                
                await api.rejectCheckpoint(storyId, checkpoint.id, feedback);
                
                alert('已拒绝该检查点，工作流将根据反馈进行重试。');
                window.location.reload();
            } catch (err) {
                alert('拒绝失败: ' + err.message);
                btnApprove.disabled = false;
                btnReject.disabled = false;
                btnReject.innerHTML = '<i class="bi bi-x-circle me-1"></i> 拒绝 (Reject)';
            }
        });

        wrapper.appendChild(leftCol);
        wrapper.appendChild(centerCol);
        wrapper.appendChild(rightCol);

        containerElement.innerHTML = '';
        containerElement.appendChild(wrapper);
    }

    function escapeHtml(unsafe) {
        if (unsafe == null) return '';
        return String(unsafe)
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;")
            .replace(/'/g, "&#039;");
    }
}
            if (payload.characters) {
                result.push({
                    id: 'characters',
                    title: '角色设定',
                    type: 'characters',
                    data: payload.characters
                });
            }
        } else if (type === 'outline_checkpoint') {
            if (payload.outline) {
                result.push({
                    id: 'outline',
                    title: '故事大纲',
                    type: 'outline',
                    data: payload.outline
                });
            }
            if (payload.chapters) {
                 result.push({
                    id: 'chapters',
                    title: '章节列表',
                    type: 'chapters',
                    data: payload.chapters
                });
            }
        } else if (type === 'content_checkpoint' || type === 'final_checkpoint') {
            if (payload.chapters && Array.isArray(payload.chapters)) {
                payload.chapters.forEach(ch => {
                    result.push({
                        id: `chapter-${ch.chapterNum || ch.number}`,
                        title: ch.title || `第${ch.chapterNum || ch.number}章`,
                        type: 'chapter',
                        data: ch
                    });
                });
            }
        }

        if (result.length === 0) {
            result.push({
                id: 'raw-payload',
                title: '检查点数据',
                type: 'raw',
                data: payload
            });
        }
        
        return result;
    }

    function render() {
        wrapper.innerHTML = '';
        
        const leftCol = document.createElement('div');
        leftCol.className = 'border-end bg-white';
        leftCol.style.width = '250px';
        leftCol.style.display = 'flex';
        leftCol.style.flexDirection = 'column';
        leftCol.innerHTML = `
            <div class="p-3 border-bottom bg-light">
                <h6 class="mb-0 fw-bold">产物列表</h6>
            </div>
            <div class="list-group list-group-flush flex-grow-1 overflow-auto">
                ${artifacts.map((a, i) => `
                    <button type="button" class="list-group-item list-group-item-action ${i === currentArtifactIndex ? 'active' : ''}" data-index="${i}">
                        ${escapeHtml(a.title)}
                    </button>
                `).join('')}
            </div>
        `;

        const navButtons = leftCol.querySelectorAll('.list-group-item');
        navButtons.forEach(btn => {
            btn.addEventListener('click', (e) => {
                currentArtifactIndex = parseInt(e.target.getAttribute('data-index'), 10);
                render();
            });
        });

        const centerCol = document.createElement('div');
        centerCol.className = 'flex-grow-1 bg-white p-4 overflow-auto';
        
        const currentArtifact = artifacts[currentArtifactIndex];
        let contentHtml = '';

        if (currentArtifact) {
            if (currentArtifact.type === 'worldview') {
                 contentHtml = `
                    <h4>${escapeHtml(currentArtifact.title)}</h4>
                    <div class="mt-4">
                        <h5>背景设定</h5>
                        <p class="whitespace-pre-wrap">${escapeHtml(currentArtifact.data.setting || '暂无设定')}</p>
                    </div>
                `;
            } else if (currentArtifact.type === 'characters') {
                 const chars = currentArtifact.data.characters || currentArtifact.data;
                 const charList = Array.isArray(chars) ? chars : [];
                 contentHtml = `
                    <h4>${escapeHtml(currentArtifact.title)}</h4>
                    <div class="mt-4 row">
                        ${charList.map(c => `
                            <div class="col-md-6 mb-3">
                                <div class="card h-100">
                                    <div class="card-body">
                                        <h5 class="card-title">${escapeHtml(c.name || '未知角色')}</h5>
                                        <h6 class="card-subtitle mb-2 text-muted">${escapeHtml(c.roleType || '未知定位')}</h6>
                                        <p class="card-text text-sm">${escapeHtml(c.description || c.bio || '暂无简介')}</p>
                                    </div>
                                </div>
                            </div>
                        `).join('')}
                    </div>
                `;
            } else if (currentArtifact.type === 'outline') {
                 const cards = currentArtifact.data.chapterCards || [];
                 contentHtml = `
                    <h4>${escapeHtml(currentArtifact.title)}</h4>
                    <div class="mt-4">
                        ${cards.map(c => `
                            <div class="card mb-3">
                                <div class="card-header bg-light">
                                    <strong>${escapeHtml(c.title || \`第\${c.number}章\`)}</strong>
                                </div>
                                <div class="card-body">
                                    <p class="mb-0">${escapeHtml(c.description || c.summary || '暂无大纲')}</p>
                                </div>
                            </div>
                        `).join('')}
                    </div>
                 `;
            } else if (currentArtifact.type === 'chapter') {
                contentHtml = `
                    <h4>${escapeHtml(currentArtifact.title)}</h4>
                    <div class="mt-4 lh-lg whitespace-pre-wrap" style="font-family: serif; font-size: 1.1rem;">${escapeHtml(currentArtifact.data.content || currentArtifact.data.text || '')}</div>
                `;
            } else {
                 contentHtml = `
                    <h4>${escapeHtml(currentArtifact.title)}</h4>
                    <pre class="bg-light p-3 rounded mt-4"><code>${escapeHtml(JSON.stringify(currentArtifact.data, null, 2))}</code></pre>
                 `;
            }
        }

        centerCol.innerHTML = contentHtml;


        const rightCol = document.createElement('div');
        rightCol.className = 'border-start bg-white';
        rightCol.style.width = '350px';
        rightCol.style.display = 'flex';
        rightCol.style.flexDirection = 'column';

        const chips = [
            "Needs stronger conflict",
            "Pacing uneven",
            "Character motivation unclear",
            "Too descriptive",
            "Dialogue feels unnatural"
        ];

        rightCol.innerHTML = `
            <div class="p-3 border-bottom bg-light">
                <h6 class="mb-0 fw-bold">审核操作</h6>
            </div>
            <div class="p-3 flex-grow-1 d-flex flex-column">
                <div class="alert alert-info py-2 text-sm">
                    请仔细审阅左侧产物。如果通过，工作流将继续进行；如果拒绝，工作流将返回上一阶段重试。
                </div>
                
                <div class="mb-3">
                    <label class="form-label fw-bold text-sm">快捷反馈 (点击添加)</label>
                    <div class="d-flex flex-wrap gap-1" id="feedback-chips">
                        ${chips.map(chip => `
                            <span class="badge bg-light text-dark border feedback-chip" style="cursor:pointer;">${escapeHtml(chip)}</span>
                        `).join('')}
                    </div>
                </div>

                <div class="mb-3 flex-grow-1 d-flex flex-column">
                    <label class="form-label fw-bold text-sm">修改意见 (拒绝时必填)</label>
                    <textarea id="feedback-text" class="form-control flex-grow-1" placeholder="请详细说明需要修改的地方..."></textarea>
                </div>
                
                <div class="d-grid gap-2 mt-auto">
                    <button id="btn-approve" class="btn btn-success btn-lg">
                        <i class="bi bi-check-circle me-1"></i> 批准 (Approve)
                    </button>
                    <button id="btn-reject" class="btn btn-danger btn-lg">
                        <i class="bi bi-x-circle me-1"></i> 拒绝 (Reject)
                    </button>
                </div>
            </div>
        `;

        const feedbackText = rightCol.querySelector('#feedback-text');
        
        rightCol.querySelectorAll('.feedback-chip').forEach(chip => {
            chip.addEventListener('click', () => {
                const text = chip.textContent;
                const current = feedbackText.value;
                feedbackText.value = current ? current + '
- ' + text : '- ' + text;
            });
        });

        const btnApprove = rightCol.querySelector('#btn-approve');
        const btnReject = rightCol.querySelector('#btn-reject');

        btnApprove.addEventListener('click', async () => {
            try {
                btnApprove.disabled = true;
                btnReject.disabled = true;
                btnApprove.innerHTML = '<span class="spinner-border spinner-border-sm" role="status" aria-hidden="true"></span> 处理中...';
                
                await api.approveCheckpoint(storyId, checkpoint.id);
                
                alert('审核已通过！工作流将继续。');
                
                window.location.reload();
            } catch (err) {
                alert('批准失败: ' + err.message);
                btnApprove.disabled = false;
                btnReject.disabled = false;
                btnApprove.innerHTML = '<i class="bi bi-check-circle me-1"></i> 批准 (Approve)';
            }
        });

        btnReject.addEventListener('click', async () => {
            const feedback = feedbackText.value.trim();
            if (!feedback) {
                alert('拒绝时必须提供修改意见！');
                feedbackText.focus();
                return;
            }

            try {
                btnApprove.disabled = true;
                btnReject.disabled = true;
                btnReject.innerHTML = '<span class="spinner-border spinner-border-sm" role="status" aria-hidden="true"></span> 处理中...';
                
                await api.rejectCheckpoint(storyId, checkpoint.id, feedback);
                
                alert('已拒绝该检查点，工作流将根据反馈进行重试。');
                window.location.reload();
            } catch (err) {
                alert('拒绝失败: ' + err.message);
                btnApprove.disabled = false;
                btnReject.disabled = false;
                btnReject.innerHTML = '<i class="bi bi-x-circle me-1"></i> 拒绝 (Reject)';
            }
        });

        wrapper.appendChild(leftCol);
        wrapper.appendChild(centerCol);
        wrapper.appendChild(rightCol);

        containerElement.innerHTML = '';
        containerElement.appendChild(wrapper);
    }

    function escapeHtml(unsafe) {
        if (unsafe == null) return '';
        return String(unsafe)
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;")
            .replace(/'/g, "&#039;");
    }
}
            if (payload.characters) {
                result.push({
                    id: 'characters',
                    title: '角色设定',
                    type: 'characters',
                    data: payload.characters
                });
            }
        } else if (type === 'outline_checkpoint') {
            if (payload.outline) {
                result.push({
                    id: 'outline',
                    title: '故事大纲',
                    type: 'outline',
                    data: payload.outline
                });
            }
            if (payload.chapters) {
                 result.push({
                    id: 'chapters',
                    title: '章节列表',
                    type: 'chapters',
                    data: payload.chapters
                });
            }
        } else if (type === 'content_checkpoint' || type === 'final_checkpoint') {
            if (payload.chapters && Array.isArray(payload.chapters)) {
                payload.chapters.forEach(ch => {
                    result.push({
                        id: `chapter-${ch.chapterNum || ch.number}`,
                        title: ch.title || `第${ch.chapterNum || ch.number}章`,
                        type: 'chapter',
                        data: ch
                    });
                });
            }
        }

        // Fallback if no specific format found
        if (result.length === 0) {
            result.push({
                id: 'raw-payload',
                title: '检查点数据',
                type: 'raw',
                data: payload
            });
        }
        
        return result;
    }

    function render() {
        wrapper.innerHTML = '';
        
        // Render 3-column layout
        
        // 1. Left Column: Navigator
        const leftCol = document.createElement('div');
        leftCol.className = 'border-end bg-white';
        leftCol.style.width = '250px';
        leftCol.style.display = 'flex';
        leftCol.style.flexDirection = 'column';
        leftCol.innerHTML = `
            <div class="p-3 border-bottom bg-light">
                <h6 class="mb-0 fw-bold">产物列表</h6>
            </div>
            <div class="list-group list-group-flush flex-grow-1 overflow-auto">
                ${artifacts.map((a, i) => `
                    <button type="button" class="list-group-item list-group-item-action ${i === currentArtifactIndex ? 'active' : ''}" data-index="${i}">
                        ${escapeHtml(a.title)}
                    </button>
                `).join('')}
            </div>
        `;

        // Add click events to navigator
        const navButtons = leftCol.querySelectorAll('.list-group-item');
        navButtons.forEach(btn => {
            btn.addEventListener('click', (e) => {
                currentArtifactIndex = parseInt(e.target.getAttribute('data-index'), 10);
                render();
            });
        });

        // 2. Center Column: Content
        const centerCol = document.createElement('div');
        centerCol.className = 'flex-grow-1 bg-white p-4 overflow-auto';
        
        const currentArtifact = artifacts[currentArtifactIndex];
        let contentHtml = '';

        if (currentArtifact) {
            if (currentArtifact.type === 'worldview') {
                 contentHtml = `
                    <h4>${escapeHtml(currentArtifact.title)}</h4>
                    <div class="mt-4">
                        <h5>背景设定</h5>
                        <p class="whitespace-pre-wrap">${escapeHtml(currentArtifact.data.setting || '暂无设定')}</p>
                    </div>
                `;
            } else if (currentArtifact.type === 'characters') {
                 const chars = currentArtifact.data.characters || currentArtifact.data;
                 const charList = Array.isArray(chars) ? chars : [];
                 contentHtml = `
                    <h4>${escapeHtml(currentArtifact.title)}</h4>
                    <div class="mt-4 row">
                        ${charList.map(c => `
                            <div class="col-md-6 mb-3">
                                <div class="card h-100">
                                    <div class="card-body">
                                        <h5 class="card-title">${escapeHtml(c.name || '未知角色')}</h5>
                                        <h6 class="card-subtitle mb-2 text-muted">${escapeHtml(c.roleType || '未知定位')}</h6>
                                        <p class="card-text text-sm">${escapeHtml(c.description || c.bio || '暂无简介')}</p>
                                    </div>
                                </div>
                            </div>
                        `).join('')}
                    </div>
                `;
            } else if (currentArtifact.type === 'outline') {
                 const cards = currentArtifact.data.chapterCards || [];
                 contentHtml = `
                    <h4>${escapeHtml(currentArtifact.title)}</h4>
                    <div class="mt-4">
                        ${cards.map(c => `
                            <div class="card mb-3">
                                <div class="card-header bg-light">
                                    <strong>${escapeHtml(c.title || \`第\${c.number}章\`)}</strong>
                                </div>
                                <div class="card-body">
                                    <p class="mb-0">${escapeHtml(c.description || c.summary || '暂无大纲')}</p>
                                </div>
                            </div>
                        `).join('')}
                    </div>
                 `;
            } else if (currentArtifact.type === 'chapter') {
                contentHtml = `
                    <h4>${escapeHtml(currentArtifact.title)}</h4>
                    <div class="mt-4 lh-lg whitespace-pre-wrap" style="font-family: serif; font-size: 1.1rem;">${escapeHtml(currentArtifact.data.content || currentArtifact.data.text || '')}</div>
                `;
            } else {
                 contentHtml = `
                    <h4>${escapeHtml(currentArtifact.title)}</h4>
                    <pre class="bg-light p-3 rounded mt-4"><code>${escapeHtml(JSON.stringify(currentArtifact.data, null, 2))}</code></pre>
                 `;
            }
        }

        centerCol.innerHTML = contentHtml;


        // 3. Right Column: Review Panel
        const rightCol = document.createElement('div');
        rightCol.className = 'border-start bg-white';
        rightCol.style.width = '350px';
        rightCol.style.display = 'flex';
        rightCol.style.flexDirection = 'column';

        const chips = [
            "Needs stronger conflict",
            "Pacing uneven",
            "Character motivation unclear",
            "Too descriptive",
            "Dialogue feels unnatural"
        ];

        rightCol.innerHTML = `
            <div class="p-3 border-bottom bg-light">
                <h6 class="mb-0 fw-bold">审核操作</h6>
            </div>
            <div class="p-3 flex-grow-1 d-flex flex-column">
                <div class="alert alert-info py-2 text-sm">
                    请仔细审阅左侧产物。如果通过，工作流将继续进行；如果拒绝，工作流将返回上一阶段重试。
                </div>
                
                <div class="mb-3">
                    <label class="form-label fw-bold text-sm">快捷反馈 (点击添加)</label>
                    <div class="d-flex flex-wrap gap-1" id="feedback-chips">
                        ${chips.map(chip => `
                            <span class="badge bg-light text-dark border feedback-chip" style="cursor:pointer;">${escapeHtml(chip)}</span>
                        `).join('')}
                    </div>
                </div>

                <div class="mb-3 flex-grow-1 d-flex flex-column">
                    <label class="form-label fw-bold text-sm">修改意见 (拒绝时必填)</label>
                    <textarea id="feedback-text" class="form-control flex-grow-1" placeholder="请详细说明需要修改的地方..."></textarea>
                </div>
                
                <div class="d-grid gap-2 mt-auto">
                    <button id="btn-approve" class="btn btn-success btn-lg">
                        <i class="bi bi-check-circle me-1"></i> 批准 (Approve)
                    </button>
                    <button id="btn-reject" class="btn btn-danger btn-lg">
                        <i class="bi bi-x-circle me-1"></i> 拒绝 (Reject)
                    </button>
                </div>
            </div>
        `;

        // Bind events for right column
        const feedbackText = rightCol.querySelector('#feedback-text');
        
        rightCol.querySelectorAll('.feedback-chip').forEach(chip => {
            chip.addEventListener('click', () => {
                const text = chip.textContent;
                const current = feedbackText.value;
                feedbackText.value = current ? current + '\n- ' + text : '- ' + text;
            });
        });

        const btnApprove = rightCol.querySelector('#btn-approve');
        const btnReject = rightCol.querySelector('#btn-reject');

        btnApprove.addEventListener('click', async () => {
            try {
                btnApprove.disabled = true;
                btnReject.disabled = true;
                btnApprove.innerHTML = '<span class="spinner-border spinner-border-sm" role="status" aria-hidden="true"></span> 处理中...';
                
                await api.approveCheckpoint(storyId, checkpoint.id);
                
                // Show toast or alert
                alert('审核已通过！工作流将继续。');
                
                // Navigate back (simple reload for now or trigger event)
                window.location.reload();
            } catch (err) {
                alert('批准失败: ' + err.message);
                btnApprove.disabled = false;
                btnReject.disabled = false;
                btnApprove.innerHTML = '<i class="bi bi-check-circle me-1"></i> 批准 (Approve)';
            }
        });

        btnReject.addEventListener('click', async () => {
            const feedback = feedbackText.value.trim();
            if (!feedback) {
                alert('拒绝时必须提供修改意见！');
                feedbackText.focus();
                return;
            }

            try {
                btnApprove.disabled = true;
                btnReject.disabled = true;
                btnReject.innerHTML = '<span class="spinner-border spinner-border-sm" role="status" aria-hidden="true"></span> 处理中...';
                
                await api.rejectCheckpoint(storyId, checkpoint.id, feedback);
                
                alert('已拒绝该检查点，工作流将根据反馈进行重试。');
                window.location.reload();
            } catch (err) {
                alert('拒绝失败: ' + err.message);
                btnApprove.disabled = false;
                btnReject.disabled = false;
                btnReject.innerHTML = '<i class="bi bi-x-circle me-1"></i> 拒绝 (Reject)';
            }
        });

        // Assemble
        wrapper.appendChild(leftCol);
        wrapper.appendChild(centerCol);
        wrapper.appendChild(rightCol);

        containerElement.innerHTML = '';
        containerElement.appendChild(wrapper);
    }

    // Helper to escape HTML and prevent XSS
    function escapeHtml(unsafe) {
        if (unsafe == null) return '';
        return String(unsafe)
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;")
            .replace(/'/g, "&#039;");
    }
}