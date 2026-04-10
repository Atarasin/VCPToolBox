export async function renderChapterReaderPage(container, store, api, storyId, chapterNum) {
    const num = parseInt(chapterNum) || 1;
    if (!container.querySelector('.chapter-reader')) {
        container.innerHTML = '<div class="loading">正在加载章节正文...</div>';
    }

    try {
        const [storyResponse, chaptersResponse, chapterResponse] = await Promise.all([
            api.getStory(storyId).catch(() => null),
            api.getStoryChapters(storyId).catch(() => null),
            api.getStoryChapter(storyId, num).catch(() => null)
        ]);

        if (!storyResponse?.success && !chaptersResponse?.success && !chapterResponse?.success) {
            throw new Error(storyResponse?.error || chaptersResponse?.error || chapterResponse?.error || '加载故事失败');
        }

        const story = storyResponse?.story || {};
        const chapters = normalizeChapters(story.phase2?.chapters || []);
        const chapterList = buildChapterList(story, chaptersResponse?.chapters || [], chapters);
        const polishedChapters = story.phase3?.polishedChapters || [];
        const chapter = normalizeChapterData(chapterResponse?.chapter || chapters.find((item) => Number(item.number) === num) || chapters[0] || {}, num);
        const polishedChapter = polishedChapters.find((item) => Number(item.number) === Number(chapter.number));
        const currentNumber = Number(chapter.number) || num;
        const content = chapter.content || '暂无正文内容。';
        const previousChapter = chapterList.find((item) => Number(item.number) === currentNumber - 1);
        const nextChapter = chapterList.find((item) => Number(item.number) === currentNumber + 1);
        const validation = chapter.validation || null;
        const issues = validation?.allIssues || validation?.issues || [];
        const warnings = validation?.warnings || [];
        const suggestions = validation?.allSuggestions || validation?.suggestions || [];
        const checkNames = Object.keys(validation?.checks || {});
        const paragraphCount = countParagraphs(content);
        const chapterProgress = getChapterProgress(story, chapterList, currentNumber);
        const monitorBuckets = buildMonitorBuckets(chapterList, story.phase2?.currentChapter, chapterProgress.active);

        const scrollState = {
            windowX: window.scrollX || 0,
            windowY: window.scrollY || 0,
            containerTop: container ? (container.scrollTop || 0) : 0,
            chapterListTop: container.querySelector('.chapter-list')?.scrollTop || 0
        };

        container.innerHTML = `
            <div class="chapter-reader">
                <style>
                    .chapter-reader { padding: 20px; color: var(--text-color); display: flex; flex-direction: column; gap: 20px; }
                    .chapter-hero { display: flex; justify-content: space-between; gap: 20px; padding: 24px; border-radius: 18px; background: linear-gradient(135deg, rgba(88, 166, 255, 0.12), rgba(46, 160, 67, 0.12)); border: 1px solid var(--border-color); }
                    .chapter-hero h2 { margin: 0; color: var(--accent-color); font-size: 1.9rem; }
                    .chapter-hero p { margin: 10px 0 0; color: #8b949e; line-height: 1.8; max-width: 780px; }
                    .hero-badges { display: flex; gap: 10px; flex-wrap: wrap; justify-content: flex-end; align-items: flex-start; min-width: 260px; }
                    .hero-badge { padding: 8px 14px; border-radius: 999px; background: rgba(255,255,255,0.08); border: 1px solid var(--border-color); font-size: 0.85rem; }
                    .chapter-layout { display: grid; grid-template-columns: 260px minmax(0, 1fr) 300px; gap: 20px; align-items: start; }
                    .chapter-sidebar, .chapter-content-panel, .chapter-meta-sidebar { background: var(--sidebar-bg); border: 1px solid var(--border-color); border-radius: 16px; }
                    .chapter-sidebar, .chapter-meta-sidebar { padding: 18px; }
                    .chapter-content-panel { padding: 24px; }
                    .panel-title, .meta-label, .chapter-kicker { display: block; font-size: 0.78rem; letter-spacing: 0.08em; text-transform: uppercase; color: #8b949e; margin-bottom: 10px; }
                    .chapter-list { display: flex; flex-direction: column; gap: 10px; max-height: 720px; overflow: auto; }
                    .chapter-link { display: block; text-decoration: none; color: inherit; border: 1px solid var(--border-color); border-radius: 14px; padding: 14px; background: rgba(255,255,255,0.02); transition: border-color 0.2s, transform 0.2s, background 0.2s; }
                    .chapter-link:hover { transform: translateY(-1px); border-color: rgba(88, 166, 255, 0.28); }
                    .chapter-link.active { background: rgba(88, 166, 255, 0.1); border-color: rgba(88, 166, 255, 0.32); }
                    .chapter-link strong { display: block; font-size: 0.98rem; margin-bottom: 6px; }
                    .chapter-link span { color: #8b949e; font-size: 0.85rem; line-height: 1.6; }
                    .chapter-nav { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; margin-top: 16px; }
                    .btn-nav { min-height: 40px; border-radius: 12px; border: 1px solid var(--border-color); background: rgba(139, 148, 158, 0.12); color: var(--text-color); cursor: pointer; }
                    .btn-nav:disabled { opacity: 0.45; cursor: not-allowed; }
                    .progress-strip { padding: 16px 18px; border-radius: 14px; background: linear-gradient(135deg, rgba(56, 139, 253, 0.12), rgba(46, 160, 67, 0.14)); border: 1px solid rgba(88, 166, 255, 0.24); margin-bottom: 18px; }
                    .progress-strip-head { display: flex; align-items: center; justify-content: space-between; gap: 14px; margin-bottom: 10px; }
                    .progress-strip-title { font-weight: 700; color: var(--text-color); }
                    .progress-strip-percent { color: #3fb950; font-weight: 700; }
                    .progress-strip-message { margin: 0; color: var(--text-color); line-height: 1.7; }
                    .progress-strip-bar { width: 100%; height: 10px; border-radius: 999px; background: rgba(255,255,255,0.08); overflow: hidden; margin-top: 12px; }
                    .progress-strip-fill { height: 100%; border-radius: inherit; background: linear-gradient(90deg, #1f6feb, #3fb950); }
                    .monitor-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 14px; margin-bottom: 18px; }
                    .monitor-card { border: 1px solid var(--border-color); border-radius: 14px; padding: 16px; background: rgba(255,255,255,0.02); min-height: 180px; }
                    .monitor-card.current { background: linear-gradient(135deg, rgba(56, 139, 253, 0.12), rgba(46, 160, 67, 0.12)); border-color: rgba(88, 166, 255, 0.24); }
                    .monitor-title { display: block; margin-bottom: 12px; font-size: 0.78rem; letter-spacing: 0.08em; text-transform: uppercase; color: #8b949e; }
                    .monitor-item { padding: 10px 12px; border-radius: 12px; border: 1px solid rgba(255,255,255,0.06); background: rgba(255,255,255,0.03); }
                    .monitor-item + .monitor-item { margin-top: 10px; }
                    .monitor-item strong { display: block; color: var(--text-color); margin-bottom: 6px; }
                    .monitor-item span { color: #8b949e; font-size: 0.84rem; line-height: 1.65; }
                    .monitor-placeholder { display: flex; flex-direction: column; justify-content: center; gap: 12px; min-height: 120px; color: var(--text-color); }
                    .monitor-pulse { width: 100%; height: 10px; border-radius: 999px; background: linear-gradient(90deg, rgba(31,111,235,0.18), rgba(63,185,80,0.35), rgba(31,111,235,0.18)); background-size: 200% 100%; animation: monitorPulse 1.6s linear infinite; }
                    .monitor-queue { display: flex; flex-direction: column; gap: 10px; }
                    @keyframes monitorPulse {
                        0% { background-position: 0% 0; }
                        100% { background-position: 200% 0; }
                    }
                    .chapter-header { display: flex; justify-content: space-between; gap: 16px; align-items: flex-start; margin-bottom: 22px; }
                    .chapter-header h3 { margin: 0; font-size: 1.6rem; }
                    .chapter-tag-row { display: flex; flex-wrap: wrap; gap: 8px; }
                    .chapter-tag { display: inline-flex; align-items: center; padding: 6px 10px; border-radius: 999px; background: rgba(139, 148, 158, 0.12); color: #c9d1d9; font-size: 0.82rem; }
                    .manuscript-block { background: rgba(0, 0, 0, 0.18); border: 1px solid var(--border-color); border-radius: 16px; padding: 18px; }
                    .manuscript-block + .manuscript-block { margin-top: 16px; }
                    .chapter-text { line-height: 2; color: var(--text-color); }
                    .chapter-text p { margin: 0 0 1.15em; }
                    .meta-card { border: 1px solid var(--border-color); border-radius: 14px; padding: 16px; background: var(--bg-color); }
                    .meta-card + .meta-card { margin-top: 12px; }
                    .meta-value { font-size: 1.2rem; font-weight: 700; color: var(--text-color); }
                    .meta-desc { margin-top: 8px; color: #8b949e; line-height: 1.75; font-size: 0.92rem; }
                    .issue-list { margin: 12px 0 0; padding-left: 18px; color: var(--text-color); line-height: 1.8; }
                    .issue-list li + li { margin-top: 8px; }
                    .improvement-list { display: flex; flex-direction: column; gap: 10px; }
                    .improvement-item { padding: 12px 14px; border-radius: 12px; border: 1px solid var(--border-color); background: rgba(255,255,255,0.02); color: var(--text-color); line-height: 1.75; }
                    @media (max-width: 1080px) {
                        .chapter-layout { grid-template-columns: 1fr; }
                        .chapter-hero { flex-direction: column; }
                        .hero-badges { justify-content: flex-start; min-width: 0; }
                        .monitor-grid { grid-template-columns: 1fr; }
                    }
                </style>
                <section class="chapter-hero">
                    <div>
                        <h2>阶段2 · 章节正文</h2>
                        <p>按章节检查当前已生成的正文内容、状态与校验结果。如阶段3已有润色稿，也会在这里同步对照展示。</p>
                    </div>
                    <div class="hero-badges">
                        <span class="hero-badge">当前章节：第 ${currentNumber} 章</span>
                        <span class="hero-badge">正文状态：${escapeHtml(getChapterStatusLabel(chapter.status))}</span>
                        <span class="hero-badge">${polishedChapter ? '已有润色版本' : '尚未进入润色'}</span>
                    </div>
                </section>

                <section class="chapter-layout">
                    <aside class="chapter-sidebar">
                        <span class="panel-title">章节导航</span>
                        ${chapterProgress.visible ? `
                            <div class="progress-strip">
                                <div class="progress-strip-head">
                                    <span class="progress-strip-title">${chapterProgress.title}</span>
                                    <span class="progress-strip-percent">${chapterProgress.percent}%</span>
                                </div>
                                <p class="progress-strip-message">${chapterProgress.message}</p>
                                <div class="progress-strip-bar">
                                    <div class="progress-strip-fill" style="width: ${chapterProgress.percent}%;"></div>
                                </div>
                            </div>
                        ` : ''}
                        <div class="chapter-list">
                            ${chapterList.length > 0 ? chapterList.map((item) => `
                                <a href="#/stories/${storyId}/chapters/${item.number}" class="chapter-link ${Number(item.number) === currentNumber ? 'active' : ''}">
                                    <strong>第 ${item.number} 章 · ${escapeHtml(item.title || `第${item.number}章`)}</strong>
                                    <span>${escapeHtml(getChapterStatusLabel(item.status))} · ${formatWordCount(item.wordCount)}</span>
                                </a>
                            `).join('') : '<p style="color: #8b949e;">当前还没有章节正文。</p>'}
                        </div>
                        <div class="chapter-nav">
                            <button class="btn-nav" data-dir="prev" ${!previousChapter ? 'disabled' : ''}>← 上一章</button>
                            <button class="btn-nav" data-dir="next" ${!nextChapter ? 'disabled' : ''}>下一章 →</button>
                        </div>
                    </aside>

                    <main class="chapter-content-panel">
                        ${chapterProgress.visible ? `
                            <section class="monitor-grid">
                                <div class="monitor-card">
                                    <span class="monitor-title">已完成章节</span>
                                    ${monitorBuckets.completed.length > 0 ? monitorBuckets.completed.map((item) => `
                                        <div class="monitor-item">
                                            <strong>第 ${item.number} 章 · ${escapeHtml(item.title || `第${item.number}章`)}</strong>
                                            <span>${escapeHtml(getChapterStatusLabel(item.status))} · ${formatWordCount(item.wordCount)}</span>
                                        </div>
                                    `).join('') : '<div class="monitor-placeholder"><span>当前还没有已完成章节。</span></div>'}
                                </div>
                                <div class="monitor-card current">
                                    <span class="monitor-title">当前生成章节</span>
                                    ${monitorBuckets.current ? `
                                        <div class="monitor-placeholder">
                                            <strong>第 ${monitorBuckets.current.number} 章 · ${escapeHtml(monitorBuckets.current.title || `第${monitorBuckets.current.number}章`)}</strong>
                                            <span>系统正在写作该章正文，生成完成后会自动出现在左侧已完成列表中。</span>
                                            <div class="monitor-pulse"></div>
                                        </div>
                                    ` : `
                                        <div class="monitor-placeholder">
                                            <strong>${chapterProgress.active ? '当前章节准备中' : '当前没有活跃生成章节'}</strong>
                                            <span>${chapterProgress.active ? '系统正在准备正文上下文与校验环境。' : '当前处于查看或待确认状态。'}</span>
                                        </div>
                                    `}
                                </div>
                                <div class="monitor-card">
                                    <span class="monitor-title">待生成队列</span>
                                    <div class="monitor-queue">
                                        ${monitorBuckets.pending.length > 0 ? monitorBuckets.pending.map((item) => `
                                            <div class="monitor-item">
                                                <strong>第 ${item.number} 章 · ${escapeHtml(item.title || `第${item.number}章`)}</strong>
                                                <span>排队中 · 目标 ${formatWordCount(item.targetWordCount)}</span>
                                            </div>
                                        `).join('') : '<div class="monitor-placeholder"><span>当前没有待生成章节。</span></div>'}
                                    </div>
                                </div>
                            </section>
                        ` : ''}

                        <div class="chapter-header">
                            <div>
                                <span class="chapter-kicker">正文试读</span>
                                <h3>${escapeHtml(chapter.title || `第${currentNumber}章`)}</h3>
                            </div>
                            <div class="chapter-tag-row">
                                <span class="chapter-tag">${formatWordCount(chapter.wordCount)}</span>
                                <span class="chapter-tag">${paragraphCount} 段</span>
                                ${validation ? `<span class="chapter-tag">${validation.passed ? '校验通过' : '校验待修正'}</span>` : ''}
                            </div>
                        </div>

                        <article class="manuscript-block">
                            <span class="chapter-kicker">阶段2 草稿</span>
                            <div class="chapter-text">${content ? formatRichText(content) : '<p>当前章节正文尚未落盘。若系统正在生成，请先查看上方监控区中的“当前生成章节”。</p>'}</div>
                        </article>

                        ${polishedChapter ? `
                            <article class="manuscript-block">
                                <span class="chapter-kicker">阶段3 润色稿</span>
                                <div class="chapter-text">${formatRichText(polishedChapter.content || '暂无润色内容')}</div>
                            </article>
                        ` : ''}

                        ${chapter.originalContent ? `
                            <article class="manuscript-block">
                                <span class="chapter-kicker">初始版本</span>
                                <div class="chapter-text">${formatRichText(chapter.originalContent)}</div>
                            </article>
                        ` : ''}
                    </main>

                    <aside class="chapter-meta-sidebar">
                        <span class="panel-title">章节指标</span>
                        <div class="meta-card">
                            <span class="meta-label">字数</span>
                            <div class="meta-value">${formatWordCount(chapter.wordCount)}</div>
                            <div class="meta-desc">基于章节统计字段与正文内容综合计算。</div>
                        </div>
                        <div class="meta-card">
                            <span class="meta-label">创建状态</span>
                            <div class="meta-value">${escapeHtml(getChapterStatusLabel(chapter.status))}</div>
                            <div class="meta-desc">用于判断该章仍在草稿、已完成，或已进入润色阶段。</div>
                        </div>
                        <div class="meta-card">
                            <span class="meta-label">综合校验结论</span>
                            <div class="meta-value">${validation ? (validation.passed ? '通过' : '待修改') : '未提供'}</div>
                            ${validation ? `
                                <div class="meta-desc">问题 ${issues.length} 项，提醒 ${warnings.length} 项，维度 ${checkNames.length} 项。</div>
                                ${(issues.length > 0 || warnings.length > 0) ? `
                                    <ul class="issue-list">
                                        ${issues.map((item) => `<li>${escapeHtml(getIssueText(item))}</li>`).join('')}
                                        ${warnings.map((item) => `<li>${escapeHtml(getIssueText(item))}</li>`).join('')}
                                    </ul>
                                ` : ''}
                                ${suggestions.length > 0 ? `
                                    <div class="meta-desc" style="margin-top: 12px;">综合修正建议</div>
                                    <ul class="issue-list">
                                        ${suggestions.map((item) => `<li>${escapeHtml(getIssueText(item))}</li>`).join('')}
                                    </ul>
                                ` : ''}
                            ` : '<div class="meta-desc">当前没有附带章节校验结果。</div>'}
                        </div>
                        ${validation && Object.entries(validation.checks || {}).length > 0 ? `
                            ${Object.entries(validation.checks).map(([key, item]) => {
                                const isPassed = item.passed;
                                const statusLabel = isPassed ? (item.hasWarnings ? '有条件通过' : '通过') : '待修正';
                                const statusColor = isPassed ? (item.hasWarnings ? '#d29922' : '#3fb950') : '#f85149';
                                
                                return `
                                    <div class="meta-card" style="border-left: 3px solid ${statusColor};">
                                        <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px;">
                                            <span class="meta-label" style="margin: 0; color: var(--text-color); font-weight: 600;">${escapeHtml(getValidationCheckLabel(key))}校验</span>
                                            <span style="font-size: 0.75rem; font-weight: 600; color: ${statusColor}; padding: 2px 6px; border: 1px solid ${statusColor}40; border-radius: 4px; background: ${statusColor}10;">${statusLabel}</span>
                                        </div>
                                        ${(item.issues && item.issues.length > 0) ? `
                                            <ul class="issue-list" style="margin-top: 8px; font-size: 0.9rem;">
                                                ${item.issues.map(issue => `<li>${escapeHtml(issue.description || issue)}</li>`).join('')}
                                            </ul>
                                        ` : '<div class="meta-desc" style="margin-top: 4px; font-size: 0.85rem;">未发现明显问题。</div>'}
                                        ${(item.suggestions && item.suggestions.length > 0) ? `
                                            <div class="meta-desc" style="margin-top: 10px; color: var(--text-color); font-size: 0.85rem;">建议：</div>
                                            <ul class="issue-list" style="margin-top: 4px; font-size: 0.9rem;">
                                                ${item.suggestions.map(sugg => `<li>${escapeHtml(sugg)}</li>`).join('')}
                                            </ul>
                                        ` : ''}
                                    </div>
                                `;
                            }).join('')}
                        ` : ''}
                        ${(chapter.improvements || polishedChapter?.improvements || []).length > 0 ? `
                            <div class="meta-card">
                                <span class="meta-label">润色改进点</span>
                                <div class="improvement-list">
                                    ${(chapter.improvements || polishedChapter.improvements || []).map((item) => `<div class="improvement-item">${escapeHtml(item)}</div>`).join('')}
                                </div>
                            </div>
                        ` : ''}
                    </aside>
                </section>
            </div>
        `;

        window.scrollTo(scrollState.windowX, scrollState.windowY);
        container.scrollTop = scrollState.containerTop;
        const newChapterList = container.querySelector('.chapter-list');
        if (newChapterList) {
            newChapterList.scrollTop = scrollState.chapterListTop;
        }

        container.querySelector('.btn-nav[data-dir="prev"]')?.addEventListener('click', () => {
            if (previousChapter) {
                window.location.hash = `#/stories/${storyId}/chapters/${previousChapter.number}`;
            }
        });
        container.querySelector('.btn-nav[data-dir="next"]')?.addEventListener('click', () => {
            if (nextChapter) {
                window.location.hash = `#/stories/${storyId}/chapters/${nextChapter.number}`;
            }
        });

        if (chapterProgress.active) {
            if (container.__storyRetryPollingTimer) {
                clearTimeout(container.__storyRetryPollingTimer);
            }
            container.__storyRetryPollingTimer = setTimeout(() => {
                if (!window.location.hash.startsWith(`#/stories/${storyId}/chapters`)) {
                    container.__storyRetryPollingTimer = null;
                    return;
                }
                renderChapterReaderPage(container, store, api, storyId, currentNumber);
            }, 5000);
        }
    } catch (error) {
        container.innerHTML = `
            <div class="chapter-reader">
                <div class="error-state" style="padding: 40px; text-align: center; background: var(--sidebar-bg); border-radius: 8px; border: 1px solid var(--border-color);">
                    <h2 style="color: #f85149;">加载章节失败</h2>
                    <p style="color: #8b949e; margin-bottom: 20px;">${escapeHtml(error.message)}</p>
                    <a href="#/stories/${storyId}" style="display: inline-block; padding: 8px 16px; background: rgba(139, 148, 158, 0.2); color: var(--text-color); text-decoration: none; border-radius: 4px;">返回故事概览</a>
                </div>
            </div>
        `;
    }
}

function buildChapterList(story, apiChapters, fallbackChapters) {
    const outlineChapters = story.phase2?.outline?.chapterCards || [];
    const base = Array.isArray(apiChapters) && apiChapters.length > 0
        ? apiChapters
        : fallbackChapters;
    const total = outlineChapters.length || base.length;

    return Array.from({ length: total }, (_, index) => {
        const number = outlineChapters[index]?.number || base[index]?.number || index + 1;
        const fallback = fallbackChapters.find((item) => Number(item.number) === Number(number)) || {};
        const apiItem = base.find((item) => Number(item.number) === Number(number)) || {};
        return normalizeChapterData({
            ...outlineChapters[index],
            ...fallback,
            ...apiItem,
            number
        }, number);
    });
}

function normalizeChapters(chapters) {
    const list = Array.isArray(chapters) ? chapters : [];
    return list.map((chapter, index) => normalizeChapterData(chapter, index + 1));
}

function normalizeChapterData(chapter, fallbackNumber) {
    const validation = normalizeValidation(chapter.validation);
    const fallbackTitle = `第${fallbackNumber || 1}章`;
    return {
        ...chapter,
        number: chapter?.number || chapter?.chapterNum || chapter?.chapterNumber || fallbackNumber,
        title: sanitizeChapterTitle(chapter?.title || chapter?.chapterTitle, fallbackTitle),
        content: chapter?.content || chapter?.text || chapter?.body || '',
        wordCount: chapter?.wordCount || chapter?.metrics?.counts?.actualCount || chapter?.metrics?.counts?.chineseChars || 0,
        status: normalizeChapterStatus(chapter?.status),
        validation
    };
}

function sanitizeChapterTitle(title, fallbackTitle) {
    const raw = String(title || '').trim();
    if (!raw) return fallbackTitle;
    if (/undefined|null/i.test(raw)) return fallbackTitle;
    return raw;
}

function normalizeValidation(validation) {
    if (!validation || typeof validation !== 'object') {
        return null;
    }

    const directIssues = normalizeValidationIssueList(validation.issues || validation.problems || []);
    const directWarnings = normalizeValidationIssueList(validation.warnings || validation.alerts || []);
    const checkEntries = validation.checks && typeof validation.checks === 'object'
        ? Object.entries(validation.checks)
        : [];
    const checks = Object.fromEntries(checkEntries.map(([key, item]) => {
        return [key, {
            passed: item?.passed ?? item?.success ?? true,
            hasWarnings: item?.hasWarnings ?? false,
            issues: normalizeValidationIssueList(item?.issues || item?.problems || []),
            suggestions: normalizeList(item?.suggestions || item?.recommendations || []),
            rawReport: item?.rawReport || item?.report || ''
        }];
    }));
    const checkIssues = Object.values(checks).flatMap((item) => item.issues);
    const checkWarnings = Object.values(checks)
        .filter((item) => item.hasWarnings)
        .flatMap((item) => item.issues);
    const allIssues = normalizeValidationIssueList(validation.allIssues || []);
    const allSuggestions = normalizeList(validation.allSuggestions || validation.suggestions || validation.recommendations || []);

    return {
        passed: validation.passed ?? validation.success ?? validation.overall?.passed ?? true,
        overall: {
            passed: validation.overall?.passed ?? validation.passed ?? validation.success ?? true,
            hasCriticalIssues: validation.overall?.hasCriticalIssues ?? false,
            criticalCount: validation.overall?.criticalCount ?? 0
        },
        checks,
        issues: directIssues.length > 0 ? directIssues : checkIssues,
        warnings: [...directWarnings, ...checkWarnings],
        suggestions: allSuggestions,
        allIssues: allIssues.length > 0 ? allIssues : [...directIssues, ...checkIssues],
        allSuggestions,
        rawReport: validation.rawReport || ''
    };
}

function normalizeValidationIssueList(issues) {
    const list = Array.isArray(issues) ? issues : [issues].filter(Boolean);
    return list.map((issue) => {
        if (typeof issue === 'string') {
            return { description: issue, severity: 'notice' };
        }
        return {
            description: issue?.description || issue?.message || issue?.issue || '',
            severity: issue?.severity || issue?.level || 'notice'
        };
    }).filter((issue) => issue.description);
}

function normalizeList(value) {
    if (value == null) return [];
    return Array.isArray(value) ? value : [value];
}

function getValidationCheckLabel(name) {
    const labels = {
        worldview: '世界观',
        characters: '人物',
        plot: '情节'
    };
    return labels[name] || name;
}

function getChapterProgress(story, chapterList, currentNumber) {
    const total = chapterList.length;
    const completed = chapterList.filter((item) => isCompletedChapterStatus(item.status)).length;
    const current = Number(story.phase2?.currentChapter) || currentNumber || 0;
    const waitingForReview = story.workflow?.activeCheckpoint?.status === 'pending' && story.workflow?.activeCheckpoint?.phase === 'phase2';
    const active = story.workflow?.state === 'running' && story.workflow?.currentPhase === 'phase2';
    let percent = total > 0 ? Math.round((completed / total) * 100) : 0;
    if (active && total > 0) {
        const started = Math.max(0, Math.min(total, current - 1));
        percent = Math.round(((started + 0.5) / total) * 100);
    }
    if (waitingForReview && total > 0) {
        percent = 100;
    }

    let title = '章节生成进度';
    let message = `已完成 ${completed}/${total || 0} 章。`;
    if (waitingForReview) {
        title = '正文生成完成，等待正文确认';
        message = `当前 ${total} 章正文都已生成完成，等待检查点审核。`;
    } else if (active && total > 0) {
        title = `正在生成第 ${current || currentNumber || 1} 章`;
        message = `系统正在逐章写作，已完成 ${completed}/${total} 章。`;
    }

    return {
        visible: active || waitingForReview || completed > 0,
        active,
        percent: Math.min(100, Math.max(percent, 0)),
        title,
        message
    };
}

function buildMonitorBuckets(chapterList, currentChapter, isActive) {
    const list = Array.isArray(chapterList) ? chapterList : [];
    const currentNumber = Number(currentChapter) || 0;
    const completed = list.filter((item) => isCompletedChapterStatus(item.status));
    const current = isActive ? list.find((item) => Number(item.number) === currentNumber && !isCompletedChapterStatus(item.status)) || null : null;
    const pending = list.filter((item) => {
        if (current && Number(item.number) === Number(current.number)) return false;
        return !isCompletedChapterStatus(item.status) && (!currentNumber || Number(item.number) > currentNumber || !isActive);
    });

    return {
        completed,
        current,
        pending
    };
}

function normalizeChapterStatus(status) {
    const value = String(status || '').toLowerCase();
    if (!value) return 'draft';
    if (value === 'completed' || value === 'done' || value === 'final' || value.startsWith('completed')) return 'completed';
    if (value === 'revised' || value === '已修改') return 'revised';
    if (value === 'polished' || value === '已润色') return 'polished';
    if (value === 'review' || value === '审核中') return 'review';
    return value === 'draft' || value === '草稿' ? 'draft' : status;
}

function isCompletedChapterStatus(status) {
    const value = String(status || '').toLowerCase();
    return value === 'completed' || value === 'final' || value.startsWith('completed') || value === 'polished' || value === 'revised';
}

function getChapterStatusLabel(status) {
    const labels = {
        draft: '草稿',
        completed: '已完成',
        revised: '已修订',
        polished: '已润色',
        review: '待审阅'
    };
    return labels[status] || status || '未知';
}

function getIssueText(issue) {
    if (!issue && issue !== 0) return '';
    if (typeof issue === 'string') return issue;
    return issue.description || issue.message || issue.issue || '未说明问题';
}

function formatWordCount(value) {
    const count = Number(value) || 0;
    return count > 0 ? `${count.toLocaleString()} 字` : '未统计';
}

function countParagraphs(text) {
    return String(text || '')
        .split(/\n{2,}/)
        .map((item) => item.trim())
        .filter(Boolean)
        .length;
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
