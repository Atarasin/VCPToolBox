export async function renderTimelinePage(container, store, api, storyId) {
    if (!container.querySelector('.timeline-page')) {
        container.innerHTML = '<div class="loading">正在加载工作流时间线...</div>';
    }

    try {
        const [historyResponse, storyResponse] = await Promise.all([
            api.getStoryHistory(storyId).catch(() => null),
            api.getStory(storyId).catch(() => null)
        ]);

        if (!historyResponse?.success) {
            throw new Error(historyResponse?.error || '加载时间线历史失败');
        }

        const history = historyResponse.history || [];
        const story = storyResponse?.story || {};
        const currentState = historyResponse.currentState || 'idle';
        const currentPhase = historyResponse.currentPhase || '未知阶段';

        const scrollState = {
            windowX: window.scrollX || 0,
            windowY: window.scrollY || 0,
            containerTop: container ? (container.scrollTop || 0) : 0
        };

        container.innerHTML = `
            <div class="timeline-page">
                <style>
                    .timeline-page { padding: 20px; color: var(--text-color); display: flex; flex-direction: column; gap: 20px; }
                    .timeline-hero { display: flex; justify-content: space-between; gap: 20px; padding: 24px; border-radius: 18px; background: linear-gradient(135deg, rgba(88, 166, 255, 0.12), rgba(139, 92, 246, 0.12)); border: 1px solid var(--border-color); }
                    .timeline-hero h2 { margin: 0; color: var(--accent-color); font-size: 1.9rem; }
                    .timeline-hero p { margin: 10px 0 0; color: #8b949e; line-height: 1.8; max-width: 780px; }
                    .hero-badges { display: flex; gap: 10px; flex-wrap: wrap; justify-content: flex-end; align-items: flex-start; min-width: 260px; }
                    .hero-badge { padding: 8px 14px; border-radius: 999px; background: rgba(255,255,255,0.08); border: 1px solid var(--border-color); font-size: 0.85rem; }
                    .timeline-container { position: relative; margin-top: 20px; padding-left: 30px; }
                    .timeline-container::before { content: ''; position: absolute; top: 0; bottom: 0; left: 9px; width: 2px; background: var(--border-color); }
                    .timeline-item { position: relative; margin-bottom: 30px; padding: 20px; background: var(--sidebar-bg); border: 1px solid var(--border-color); border-radius: 12px; }
                    .timeline-item::before { content: ''; position: absolute; top: 24px; left: -26px; width: 12px; height: 12px; border-radius: 50%; background: var(--sidebar-bg); border: 2px solid var(--accent-color); z-index: 1; }
                    .timeline-item.status-error::before { border-color: #f85149; }
                    .timeline-item.status-success::before { border-color: #3fb950; }
                    .timeline-header { display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 12px; }
                    .timeline-title { font-size: 1.1rem; font-weight: 600; color: var(--text-color); margin: 0; }
                    .timeline-time { font-size: 0.85rem; color: #8b949e; }
                    .timeline-content { color: #c9d1d9; font-size: 0.95rem; line-height: 1.6; }
                    .timeline-meta { margin-top: 12px; padding-top: 12px; border-top: 1px solid var(--border-color); display: flex; gap: 10px; flex-wrap: wrap; }
                    .meta-tag { padding: 4px 8px; border-radius: 6px; background: rgba(255,255,255,0.05); font-size: 0.8rem; color: #8b949e; border: 1px solid var(--border-color); }
                    .empty-state { color: #8b949e; text-align: center; padding: 40px; background: var(--sidebar-bg); border-radius: 12px; border: 1px solid var(--border-color); }
                </style>

                <section class="timeline-hero">
                    <div>
                        <h2>工作流时间线</h2>
                        <p>查看各 Agent 的协作历史、状态变更与执行流转过程，追踪整个故事创作的生命周期。</p>
                    </div>
                    <div class="hero-badges">
                        <span class="hero-badge">当前状态：${escapeHtml(getReadableState(currentState))}</span>
                        <span class="hero-badge">当前阶段：${escapeHtml(getReadablePhase(currentPhase))}</span>
                        <span class="hero-badge">事件总数：${history.length}</span>
                    </div>
                </section>

                <div class="timeline-container">
                    ${history.length > 0 ? history.map(entry => renderTimelineItem(entry)).join('') : '<div class="empty-state">暂无时间线记录。</div>'}
                </div>
            </div>
        `;

        window.scrollTo(scrollState.windowX, scrollState.windowY);
        if (container) container.scrollTop = scrollState.containerTop;

        // Auto-refresh if running
        if (currentState === 'running' || currentState === 'recovering') {
            if (container.__storyTimelinePollingTimer) {
                clearTimeout(container.__storyTimelinePollingTimer);
            }
            container.__storyTimelinePollingTimer = setTimeout(() => {
                if (window.location.hash !== `#/stories/${storyId}/timeline`) {
                    container.__storyTimelinePollingTimer = null;
                    return;
                }
                renderTimelinePage(container, store, api, storyId);
            }, 5000);
        }

    } catch (error) {
        container.innerHTML = `
            <div class="timeline-page">
                <div class="error-state" style="padding: 40px; text-align: center; background: var(--sidebar-bg); border-radius: 8px; border: 1px solid var(--border-color);">
                    <h2 style="color: #f85149;">加载时间线失败</h2>
                    <p style="color: #8b949e; margin-bottom: 20px;">${escapeHtml(error.message)}</p>
                    <a href="#/stories/${storyId}" style="display: inline-block; padding: 8px 16px; background: rgba(139, 148, 158, 0.2); color: var(--text-color); text-decoration: none; border-radius: 4px;">返回故事概览</a>
                </div>
            </div>
        `;
    }
}

function renderTimelineItem(entry) {
    const type = entry.type || 'unknown';
    const timestamp = entry.timestamp ? new Date(entry.timestamp).toLocaleString() : '未知时间';
    const detail = entry.detail || {};
    
    let title = getReadableEventType(type);
    let content = '';
    let statusClass = 'status-default';
    let tags = [];

    if (entry.phase) tags.push(`阶段: ${getReadablePhase(entry.phase)}`);
    if (entry.step) tags.push(`步骤: ${entry.step}`);

    switch (type) {
        case 'phase_started':
            content = `开始执行阶段：${getReadablePhase(detail.phase)}`;
            statusClass = 'status-success';
            break;
        case 'phase_completed':
            content = `阶段 ${getReadablePhase(detail.phase)} 已完成。耗时 ${detail.duration ? Math.round(detail.duration/1000) + '秒' : '未知'}`;
            statusClass = 'status-success';
            break;
        case 'step_started':
            content = `开始执行步骤：${detail.step}`;
            break;
        case 'step_completed':
            content = `步骤 ${detail.step} 执行完毕。`;
            break;
        case 'checkpoint_created':
            title = '生成检查点';
            content = `创建了审批检查点 [${detail.checkpointType || detail.type}]，等待用户确认。`;
            statusClass = 'status-warning';
            if (detail.checkpointId) tags.push(`ID: ${detail.checkpointId}`);
            break;
        case 'checkpoint_approved':
            title = '检查点已通过';
            content = detail.feedback ? `用户审批通过。附言：${detail.feedback}` : '用户审批通过。';
            statusClass = 'status-success';
            break;
        case 'checkpoint_rejected':
            title = '检查点被退回';
            content = `用户拒绝了当前产物，退回理由：${detail.feedback || '未填写'}`;
            statusClass = 'status-error';
            break;
        case 'error':
        case 'workflow_error':
            title = '执行发生错误';
            content = `错误信息：${detail.error || detail.message || '未知错误'}`;
            statusClass = 'status-error';
            break;
        case 'chapter_generated':
            content = `成功生成第 ${detail.chapterNum || detail.chapterNumber || '?'} 章正文。`;
            if (detail.wordCount) tags.push(`字数: ${detail.wordCount}`);
            break;
        case 'chapter_polished':
            content = `第 ${detail.chapterNum || detail.chapterNumber || '?'} 章已完成润色。`;
            break;
        default:
            content = JSON.stringify(detail, null, 2);
            if (content === '{}') content = '无详细信息';
            break;
    }

    const tagsHtml = tags.length > 0 ? `<div class="timeline-meta">${tags.map(t => `<span class="meta-tag">${escapeHtml(t)}</span>`).join('')}</div>` : '';

    return `
        <div class="timeline-item ${statusClass}">
            <div class="timeline-header">
                <h3 class="timeline-title">${escapeHtml(title)}</h3>
                <span class="timeline-time">${escapeHtml(timestamp)}</span>
            </div>
            <div class="timeline-content">${escapeHtml(content)}</div>
            ${tagsHtml}
        </div>
    `;
}

function getReadableEventType(type) {
    const map = {
        'workflow_started': '工作流启动',
        'workflow_completed': '工作流完成',
        'workflow_paused': '工作流暂停',
        'workflow_error': '工作流异常',
        'phase_started': '阶段开始',
        'phase_completed': '阶段完成',
        'step_started': '步骤开始',
        'step_completed': '步骤完成',
        'checkpoint_created': '检查点已创建',
        'checkpoint_approved': '检查点通过',
        'checkpoint_rejected': '检查点退回',
        'chapter_generated': '章节生成完成',
        'chapter_polished': '章节润色完成',
        'error': '发生错误'
    };
    return map[type] || type;
}

function getReadablePhase(phase) {
    const map = {
        'phase1': '世界观设定',
        'phase2': '大纲与正文',
        'phase3': '润色与校验'
    };
    return map[phase] || phase;
}

function getReadableState(state) {
    const map = {
        'idle': '空闲',
        'running': '运行中',
        'paused': '已暂停 (等待人工)',
        'completed': '已完成',
        'error': '异常中止',
        'recovering': '恢复中'
    };
    return map[state] || state;
}

function escapeHtml(unsafe) {
    if (unsafe == null) return '';
    return String(unsafe)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}
