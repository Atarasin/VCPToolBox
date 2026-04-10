export async function renderFinalOutputPage(container, store, api, storyId) {
    container.innerHTML = '<div class="loading">正在加载最终成品...</div>';

    try {
        const response = await api.getStory(storyId);
        if (!response.success) {
            throw new Error(response.error || '加载故事失败');
        }

        const story = response.story || {};
        const final = story.finalOutput || {};
        const finalContent = final.content || story.phase3?.finalEditorOutput || buildCombinedContent(story.phase3?.polishedChapters || story.phase2?.chapters || []);
        const chapters = story.phase3?.polishedChapters || story.phase2?.chapters || [];
        const overallQuality = story.phase3?.qualityScores?.overall || null;
        const exportButtons = [
            { format: 'markdown', label: '导出 Markdown' },
            { format: 'txt', label: '导出 TXT' },
            { format: 'json', label: '导出 JSON' }
        ];

        container.innerHTML = `
            <div class="final-output-page">
                <style>
                    .final-output-page { padding: 20px; color: var(--text-color); display: flex; flex-direction: column; gap: 20px; }
                    .final-hero { display: flex; justify-content: space-between; gap: 20px; padding: 24px; border-radius: 18px; background: linear-gradient(135deg, rgba(88, 166, 255, 0.12), rgba(210, 153, 34, 0.14)); border: 1px solid var(--border-color); }
                    .final-hero h2 { margin: 0; color: var(--accent-color); font-size: 1.9rem; }
                    .final-hero p { margin: 10px 0 0; color: #8b949e; line-height: 1.8; max-width: 760px; }
                    .hero-side { display: flex; flex-direction: column; gap: 10px; align-items: flex-end; min-width: 280px; }
                    .hero-badges { display: flex; gap: 10px; flex-wrap: wrap; justify-content: flex-end; }
                    .hero-badge { padding: 8px 14px; border-radius: 999px; background: rgba(255,255,255,0.08); border: 1px solid var(--border-color); font-size: 0.85rem; }
                    .export-buttons { display: flex; gap: 10px; flex-wrap: wrap; justify-content: flex-end; }
                    .btn-export { min-height: 40px; border-radius: 12px; border: 1px solid rgba(88, 166, 255, 0.28); background: rgba(88, 166, 255, 0.12); color: var(--accent-color); padding: 0 14px; cursor: pointer; font-weight: 600; }
                    .btn-export:disabled { opacity: 0.6; cursor: wait; }
                    .summary-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 14px; }
                    .summary-card, .final-section, .chapter-card { background: var(--sidebar-bg); border: 1px solid var(--border-color); border-radius: 16px; }
                    .summary-card { padding: 18px; }
                    .summary-label, .section-kicker, .chapter-label { display: block; font-size: 0.78rem; letter-spacing: 0.08em; text-transform: uppercase; color: #8b949e; margin-bottom: 10px; }
                    .summary-value { font-size: 1.45rem; font-weight: 700; }
                    .summary-desc { margin-top: 8px; color: #8b949e; line-height: 1.75; font-size: 0.92rem; }
                    .final-layout { display: grid; grid-template-columns: minmax(0, 1.25fr) minmax(300px, 0.85fr); gap: 20px; align-items: start; }
                    .final-main, .final-side { display: flex; flex-direction: column; gap: 20px; }
                    .final-section { padding: 22px; }
                    .final-section h3 { margin: 0 0 14px; color: var(--accent-color); font-size: 1.15rem; }
                    .manuscript-block { background: rgba(0, 0, 0, 0.18); border: 1px solid var(--border-color); border-radius: 16px; padding: 18px; }
                    .manuscript-text { line-height: 2; color: var(--text-color); }
                    .manuscript-text p { margin: 0 0 1.15em; }
                    .chapter-grid { display: grid; gap: 14px; }
                    .chapter-card { padding: 16px; }
                    .chapter-card h4 { margin: 0 0 10px; font-size: 1rem; }
                    .chapter-card p { margin: 0; line-height: 1.8; color: var(--text-color); }
                    .empty-state { color: #8b949e; font-style: italic; margin: 0; }
                    @media (max-width: 980px) {
                        .final-hero, .final-layout { grid-template-columns: 1fr; display: grid; }
                        .hero-side, .hero-badges, .export-buttons { align-items: flex-start; justify-content: flex-start; }
                    }
                </style>
                <section class="final-hero">
                    <div>
                        <h2>阶段3 · 最终成品</h2>
                        <p>预览最终稿件、润色后章节与导出结果，确认当前故事是否已经达到可归档、可分发、可发布的交付标准。</p>
                    </div>
                    <div class="hero-side">
                        <div class="hero-badges">
                            <span class="hero-badge">稿件标题：${escapeHtml(story.title || '未命名故事')}</span>
                            <span class="hero-badge">终稿状态：${finalContent ? '可预览' : '未生成'}</span>
                            <span class="hero-badge">质量评分：${overallQuality || '未评估'}</span>
                        </div>
                        <div class="export-buttons">
                            ${exportButtons.map((button) => `<button class="btn-export" data-format="${button.format}">${button.label}</button>`).join('')}
                        </div>
                    </div>
                </section>

                <section class="summary-grid">
                    <div class="summary-card">
                        <span class="summary-label">章节数量</span>
                        <div class="summary-value">${chapters.length}</div>
                        <div class="summary-desc">当前最终成品由 ${chapters.length} 个章节构成。</div>
                    </div>
                    <div class="summary-card">
                        <span class="summary-label">累计字数</span>
                        <div class="summary-value">${formatWordCount(final.wordCount || story.phase2?.totalWordCount || countCharacters(finalContent))}</div>
                        <div class="summary-desc">优先采用阶段统计字数，缺失时回退到正文字符估算。</div>
                    </div>
                    <div class="summary-card">
                        <span class="summary-label">终稿来源</span>
                        <div class="summary-value">${story.phase3?.finalEditorOutput ? '终校整编' : chapters.length > 0 ? '按章节拼接' : '未生成'}</div>
                        <div class="summary-desc">用于判断当前稿件来自完整终校稿还是章节级聚合。</div>
                    </div>
                    <div class="summary-card">
                        <span class="summary-label">导出就绪</span>
                        <div class="summary-value">${finalContent ? '已就绪' : '待完成'}</div>
                        <div class="summary-desc">当稿件有内容时，可直接使用上方导出按钮生成文件。</div>
                    </div>
                </section>

                <section class="final-layout">
                    <div class="final-main">
                        <section class="final-section">
                            <span class="section-kicker">完整预览</span>
                            <h3>最终稿件</h3>
                            ${finalContent ? `
                                <div class="manuscript-block">
                                    <div class="manuscript-text">${formatRichText(finalContent)}</div>
                                </div>
                            ` : '<p class="empty-state">当前还没有可预览的最终稿内容。</p>'}
                        </section>
                    </div>

                    <div class="final-side">
                        <section class="final-section">
                            <span class="section-kicker">章节索引</span>
                            <h3>最终章节列表</h3>
                            <div class="chapter-grid">
                                ${chapters.length > 0 ? chapters.map((chapter) => `
                                    <div class="chapter-card">
                                        <span class="chapter-label">第 ${chapter.number || '—'} 章</span>
                                        <h4>${escapeHtml(chapter.title || '未命名章节')}</h4>
                                        <p>${formatWordCount(chapter.wordCount)}</p>
                                    </div>
                                `).join('') : '<p class="empty-state">当前还没有章节级终稿。</p>'}
                            </div>
                        </section>

                        <section class="final-section">
                            <span class="section-kicker">交付说明</span>
                            <h3>导出与归档</h3>
                            <p style="margin: 0; line-height: 1.85; color: var(--text-color);">如已完成最终校验，建议优先导出 Markdown 作为编辑稿，TXT 作为纯文本交付稿，JSON 用于后续系统回放和结构化存档。</p>
                        </section>
                    </div>
                </section>
            </div>
        `;

        container.querySelectorAll('.btn-export').forEach(btn => {
            btn.addEventListener('click', async () => {
                const format = btn.dataset.format;
                btn.disabled = true;
                const originalLabel = btn.textContent;
                btn.textContent = '导出中...';
                try {
                    const result = await api.exportStory(storyId, format);
                    if (result.downloadUrl) {
                        const a = document.createElement('a');
                        a.href = result.downloadUrl;
                        a.download = `${story.title || 'story'}.${format}`;
                        a.click();
                    }
                } catch (e) {
                    alert('导出失败: ' + e.message);
                }
                btn.disabled = false;
                btn.textContent = originalLabel;
            });
        });
    } catch (error) {
        container.innerHTML = `
            <div class="final-output-page">
                <div class="error-state" style="padding: 40px; text-align: center; background: var(--sidebar-bg); border-radius: 8px; border: 1px solid var(--border-color);">
                    <h2 style="color: #f85149;">加载最终成品失败</h2>
                    <p style="color: #8b949e; margin-bottom: 20px;">${escapeHtml(error.message)}</p>
                    <a href="#/stories/${storyId}" style="display: inline-block; padding: 8px 16px; background: rgba(139, 148, 158, 0.2); color: var(--text-color); text-decoration: none; border-radius: 4px;">返回故事概览</a>
                </div>
            </div>
        `;
    }
}

function buildCombinedContent(chapters) {
    const list = Array.isArray(chapters) ? chapters : [];
    return list
        .map((chapter) => {
            const title = chapter?.title || (chapter?.number ? `第${chapter.number}章` : '未命名章节');
            const content = chapter?.content || '';
            return content ? `${title}\n\n${content}` : '';
        })
        .filter(Boolean)
        .join('\n\n');
}

function countCharacters(text) {
    return String(text || '').replace(/\s/g, '').length;
}

function formatWordCount(value) {
    const count = Number(value) || 0;
    return count > 0 ? `${count.toLocaleString()} 字` : '未统计';
}

function formatRichText(text) {
    return escapeHtml(text || '')
        .split(/\n{2,}/)
        .map((paragraph) => `<p>${paragraph.replace(/\n/g, '<br>')}</p>`)
        .join('');
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
