export async function renderQualityPage(container, store, api, storyId) {
    container.innerHTML = '<div class="loading">正在加载阶段3质量数据...</div>';

    try {
        const response = await api.getStory(storyId);
        if (!response.success) {
            throw new Error(response.error || '加载故事失败');
        }

        const story = response.story || {};
        const phase3 = story.phase3 || {};
        const quality = phase3.qualityScores || {};
        const dims = quality.dimensions || {};
        const trends = quality.trends || [];
        const overall = Number(quality.overall) || 0;
        const iterations = phase3.iterationCount || quality.iterationCount || 0;
        const finalValidation = phase3.finalValidation || null;
        const validationIssues = finalValidation?.issues || [];
        const validationScoreRows = normalizeValidationScoreRows(finalValidation?.qualityScores || []);
        const polishedChapters = phase3.polishedChapters || [];
        const dimEntries = Object.entries(dims);

        container.innerHTML = `
            <div class="quality-page">
                <style>
                    .quality-page { padding: 20px; color: var(--text-color); display: flex; flex-direction: column; gap: 20px; }
                    .quality-hero { display: flex; justify-content: space-between; gap: 20px; padding: 24px; border-radius: 18px; background: linear-gradient(135deg, rgba(56, 139, 253, 0.12), rgba(46, 160, 67, 0.14)); border: 1px solid var(--border-color); }
                    .quality-hero h2 { margin: 0; color: var(--accent-color); font-size: 1.9rem; }
                    .quality-hero p { margin: 10px 0 0; color: #8b949e; line-height: 1.8; max-width: 760px; }
                    .hero-meta { display: flex; gap: 10px; flex-wrap: wrap; align-items: flex-start; justify-content: flex-end; min-width: 280px; }
                    .hero-badge { padding: 8px 14px; border-radius: 999px; background: rgba(255,255,255,0.08); border: 1px solid var(--border-color); font-size: 0.85rem; }
                    .overview-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 14px; }
                    .overview-card, .quality-section, .dimension-card, .issue-card, .chapter-card { background: var(--sidebar-bg); border: 1px solid var(--border-color); border-radius: 16px; }
                    .overview-card { padding: 18px; }
                    .overview-label, .section-kicker, .score-label { display: block; font-size: 0.78rem; letter-spacing: 0.08em; text-transform: uppercase; color: #8b949e; margin-bottom: 10px; }
                    .overview-value { font-size: 1.45rem; font-weight: 700; }
                    .overview-desc { margin-top: 8px; color: #8b949e; line-height: 1.7; font-size: 0.92rem; }
                    .quality-layout { display: grid; grid-template-columns: minmax(0, 1.3fr) minmax(320px, 0.9fr); gap: 20px; align-items: start; }
                    .quality-main, .quality-side { display: flex; flex-direction: column; gap: 20px; }
                    .quality-section { padding: 22px; }
                    .quality-section h3 { margin: 0 0 14px; color: var(--accent-color); font-size: 1.15rem; }
                    .dimension-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 14px; }
                    .dimension-card { padding: 16px; background: rgba(255,255,255,0.02); }
                    .dim-head { display: flex; justify-content: space-between; gap: 12px; align-items: baseline; margin-bottom: 10px; }
                    .dim-name { font-weight: 600; }
                    .dim-value { color: var(--accent-color); font-size: 0.95rem; }
                    .dim-bar { width: 100%; height: 10px; border-radius: 999px; background: rgba(139, 148, 158, 0.18); overflow: hidden; }
                    .dim-fill { height: 100%; border-radius: inherit; background: linear-gradient(90deg, #1f6feb, #2ea043); }
                    .trend-grid, .issue-list, .chapter-grid, .validation-score-grid { display: grid; gap: 14px; }
                    .trend-grid { grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); }
                    .issue-card, .chapter-card { padding: 16px; }
                    .issue-card p, .chapter-card p { margin: 0; line-height: 1.8; color: var(--text-color); }
                    .issue-card + .issue-card { margin-top: 12px; }
                    .issue-severity { display: inline-flex; padding: 5px 10px; border-radius: 999px; background: rgba(248, 81, 73, 0.12); color: #ffb4ae; font-size: 0.8rem; margin-bottom: 10px; }
                    .issue-severity.notice { background: rgba(139, 148, 158, 0.16); color: #c9d1d9; }
                    .issue-severity.warning { background: rgba(210, 153, 34, 0.18); color: #f2cc60; }
                    .chapter-card h4 { margin: 0 0 10px; font-size: 1rem; }
                    .chapter-card ul { margin: 10px 0 0; padding-left: 18px; line-height: 1.75; color: var(--text-color); }
                    .validation-score-grid { grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); }
                    .empty-state { color: #8b949e; font-style: italic; margin: 0; }
                    @media (max-width: 980px) {
                        .quality-hero, .quality-layout { grid-template-columns: 1fr; display: grid; }
                        .hero-meta { justify-content: flex-start; min-width: 0; }
                    }
                </style>
                <section class="quality-hero">
                    <div>
                        <h2>阶段3 · 质量评估</h2>
                        <p>聚合查看润色迭代成绩、终校校验结果与章节改进点，判断稿件是否达到最终交付标准。</p>
                    </div>
                    <div class="hero-meta">
                        <span class="hero-badge">阶段状态：${escapeHtml(getPhase3StatusLabel(phase3.status))}</span>
                        <span class="hero-badge">润色轮次：${iterations || 0}</span>
                        <span class="hero-badge">终校结果：${finalValidation ? (finalValidation.passed ? '通过' : '待修正') : '未执行'}</span>
                    </div>
                </section>

                <section class="overview-grid">
                    <div class="overview-card">
                        <span class="overview-label">综合评分</span>
                        <div class="overview-value">${overall || '—'}</div>
                        <div class="overview-desc">采用最新一轮质量评估结果，统一按百分制展示。</div>
                    </div>
                    <div class="overview-card">
                        <span class="overview-label">迭代次数</span>
                        <div class="overview-value">${iterations || 0}</div>
                        <div class="overview-desc">反映阶段3为达成质量目标进行的润色次数。</div>
                    </div>
                    <div class="overview-card">
                        <span class="overview-label">终校问题</span>
                        <div class="overview-value">${validationIssues.length}</div>
                        <div class="overview-desc">根据最终校验报告提取出的待关注问题总数。</div>
                    </div>
                    <div class="overview-card">
                        <span class="overview-label">润色章节</span>
                        <div class="overview-value">${polishedChapters.length}</div>
                        <div class="overview-desc">当前已经进入润色稿状态的章节数量。</div>
                    </div>
                </section>

                <section class="quality-layout">
                    <div class="quality-main">
                        <section class="quality-section">
                            <span class="section-kicker">评分拆解</span>
                            <h3>质量维度</h3>
                            <div class="dimension-grid">
                                ${dimEntries.length > 0 ? dimEntries.map(([key, value]) => `
                                    <div class="dimension-card">
                                        <div class="dim-head">
                                            <span class="dim-name">${escapeHtml(getDimensionLabel(key))}</span>
                                            <span class="dim-value">${Number(value) || 0}</span>
                                        </div>
                                        <div class="dim-bar">
                                            <div class="dim-fill" style="width: ${Math.max(0, Math.min(100, Number(value) || 0))}%"></div>
                                        </div>
                                    </div>
                                `).join('') : '<p class="empty-state">当前还没有质量维度评分。</p>'}
                            </div>
                        </section>

                        <section class="quality-section">
                            <span class="section-kicker">润色进度</span>
                            <h3>迭代趋势</h3>
                            <div class="trend-grid">
                                ${trends.length > 0 ? trends.map((item, index) => `
                                    <div class="dimension-card">
                                        <span class="score-label">第 ${item.iteration || index + 1} 轮</span>
                                        <div class="overview-value" style="font-size: 1.2rem;">${item.overall || '—'}</div>
                                        <div class="overview-desc">维度数：${Object.keys(item.dimensions || {}).length}</div>
                                    </div>
                                `).join('') : '<p class="empty-state">当前没有可展示的迭代趋势。</p>'}
                            </div>
                        </section>

                        <section class="quality-section">
                            <span class="section-kicker">章节改进</span>
                            <h3>润色章节与提升点</h3>
                            <div class="chapter-grid">
                                ${polishedChapters.length > 0 ? polishedChapters.map((chapter) => `
                                    <div class="chapter-card">
                                        <h4>第 ${chapter.number || '—'} 章 · ${escapeHtml(chapter.title || '未命名章节')}</h4>
                                        <p>字数：${formatWordCount(chapter.wordCount)}</p>
                                        ${(chapter.improvements || []).length > 0 ? `
                                            <ul>
                                                ${chapter.improvements.map((item) => `<li>${escapeHtml(item)}</li>`).join('')}
                                            </ul>
                                        ` : '<p style="margin-top: 10px; color: #8b949e;">当前没有记录额外改进点。</p>'}
                                    </div>
                                `).join('') : '<p class="empty-state">当前尚未生成润色章节。</p>'}
                            </div>
                        </section>
                    </div>

                    <div class="quality-side">
                        <section class="quality-section">
                            <span class="section-kicker">终校结果</span>
                            <h3>最终校验</h3>
                            ${finalValidation ? `
                                <div class="overview-desc" style="margin-top: 0;">${escapeHtml(finalValidation.summary || '已生成最终校验结果，可根据问题列表继续处理。')}</div>
                                <div class="issue-list" style="margin-top: 16px;">
                                    ${validationIssues.length > 0 ? validationIssues.map((issue) => `
                                        <div class="issue-card">
                                            <span class="issue-severity ${escapeHtml(issue.severity || 'notice')}">${escapeHtml(getSeverityLabel(issue.severity))}</span>
                                            <p>${escapeHtml(issue.description || '未提供问题描述')}</p>
                                        </div>
                                    `).join('') : '<p class="empty-state">终校未发现明显问题。</p>'}
                                </div>
                            ` : '<p class="empty-state">当前还没有终校验证信息。</p>'}
                        </section>

                        <section class="quality-section">
                            <span class="section-kicker">评分记录</span>
                            <h3>终校评分条目</h3>
                            <div class="validation-score-grid">
                                ${validationScoreRows.length > 0 ? validationScoreRows.map((row) => `
                                    <div class="dimension-card">
                                        <div class="dim-head">
                                            <span class="dim-name">${escapeHtml(row.title)}</span>
                                            <span class="dim-value">${row.average}</span>
                                        </div>
                                        <div class="overview-desc">维度 ${row.items.length} 项</div>
                                    </div>
                                `).join('') : '<p class="empty-state">当前没有附带终校评分明细。</p>'}
                            </div>
                        </section>
                    </div>
                </section>
            </div>
        `;
    } catch (error) {
        container.innerHTML = `
            <div class="quality-page">
                <div class="error-state" style="padding: 40px; text-align: center; background: var(--sidebar-bg); border-radius: 8px; border: 1px solid var(--border-color);">
                    <h2 style="color: #f85149;">加载质量评估失败</h2>
                    <p style="color: #8b949e; margin-bottom: 20px;">${escapeHtml(error.message)}</p>
                    <a href="#/stories/${storyId}" style="display: inline-block; padding: 8px 16px; background: rgba(139, 148, 158, 0.2); color: var(--text-color); text-decoration: none; border-radius: 4px;">返回故事概览</a>
                </div>
            </div>
        `;
    }
}

function normalizeValidationScoreRows(rows) {
    const list = Array.isArray(rows) ? rows : [];
    return list.map((row, index) => ({
        title: `第 ${row.iteration || index + 1} 轮`,
        average: row.average ?? '—',
        items: Object.entries(row.scores || {})
    }));
}

function getPhase3StatusLabel(status) {
    const labels = {
        pending: '待开始',
        polishing_complete: '润色完成',
        final_editing_complete: '终校完成',
        waiting_final_acceptance: '等待最终确认',
        completed: '已完成'
    };
    return labels[status] || status || '未知';
}

function getDimensionLabel(key) {
    const labels = {
        coherence: '叙事连贯度',
        engagement: '阅读吸引力',
        consistency: '设定一致性',
        style: '文风统一性',
        dialogue: '对白表现',
        pacing: '节奏控制',
        prose: '文字表现',
        originality: '原创度'
    };
    return labels[key] || key;
}

function getSeverityLabel(severity) {
    const labels = {
        critical: '关键问题',
        major: '主要问题',
        warning: '提醒',
        notice: '提示'
    };
    return labels[severity] || severity || '提示';
}

function formatWordCount(value) {
    const count = Number(value) || 0;
    return count > 0 ? `${count.toLocaleString()} 字` : '未统计';
}

function escapeHtml(unsafe) {
    if (!unsafe && unsafe !== 0) return '';
    return String(unsafe)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}
