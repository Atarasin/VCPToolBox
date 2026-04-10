export async function renderOutlinePage(container, store, api, storyId) {
    if (!container.querySelector('.outline-page')) {
        container.innerHTML = '<div class="loading">正在加载阶段2大纲...</div>';
    }

    try {
        const [storyResponse, outlineResponse, chaptersResponse] = await Promise.all([
            api.getStory(storyId).catch(() => null),
            api.getStoryOutline(storyId).catch(() => null),
            api.getStoryChapters(storyId).catch(() => null)
        ]);

        if (!outlineResponse?.success && !storyResponse?.success) {
            throw new Error(outlineResponse?.error || storyResponse?.error || '加载故事失败');
        }

        const story = storyResponse?.story || {};
        const phase2 = story.phase2 || {};
        const outline = normalizeOutlineData(outlineResponse?.outline || phase2.outline || {});
        const chapters = outline.chapterCards || [];
        const turningPoints = outline.turningPoints || [];
        const foreshadowing = outline.foreshadowing || [];
        const totalTargetWordCount = outline.totalTargetWordCount || chapters.reduce((sum, chapter) => sum + (chapter.targetWordCount || 0), 0);
        const phase2Status = outlineResponse?.phase2Status || phase2.status;
        const checkpointId = phase2.checkpointId || story.workflow?.activeCheckpoint?.id || null;
        const currentChapter = phase2.currentChapter || (story.workflow?.currentPhase === 'phase2' ? '处理中' : null);
        const chapterProgress = getChapterProgress(story, outline, phase2Status, chaptersResponse?.chapters || []);

        const scrollState = {
            windowX: window.scrollX || 0,
            windowY: window.scrollY || 0,
            containerTop: container ? (container.scrollTop || 0) : 0,
            outlineMainTop: container.querySelector('.outline-main')?.scrollTop || 0,
            outlineSidebarTop: container.querySelector('.outline-sidebar')?.scrollTop || 0
        };

        container.innerHTML = `
            <div class="outline-page">
                <style>
                    .outline-page { padding: 20px; color: var(--text-color); display: flex; flex-direction: column; gap: 20px; }
                    .outline-hero { display: flex; justify-content: space-between; gap: 20px; padding: 24px; border-radius: 18px; background: linear-gradient(135deg, rgba(88, 166, 255, 0.12), rgba(139, 92, 246, 0.12)); border: 1px solid var(--border-color); }
                    .outline-hero h2 { margin: 0; color: var(--accent-color); font-size: 1.9rem; }
                    .outline-hero p { margin: 10px 0 0; color: #8b949e; line-height: 1.8; max-width: 780px; }
                    .hero-meta { display: flex; gap: 10px; flex-wrap: wrap; align-items: flex-start; justify-content: flex-end; min-width: 280px; }
                    .hero-badge { padding: 8px 14px; border-radius: 999px; background: rgba(255,255,255,0.08); border: 1px solid var(--border-color); font-size: 0.85rem; }
                    .summary-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 14px; }
                    .summary-card, .outline-section, .chapter-card, .mini-card { background: var(--sidebar-bg); border: 1px solid var(--border-color); border-radius: 16px; }
                    .summary-card { padding: 18px; }
                    .summary-label, .mini-label, .section-kicker { display: block; font-size: 0.78rem; letter-spacing: 0.08em; text-transform: uppercase; color: #8b949e; margin-bottom: 10px; }
                    .summary-value { font-size: 1.35rem; font-weight: 700; color: var(--text-color); }
                    .summary-desc { margin-top: 8px; line-height: 1.75; color: #8b949e; font-size: 0.92rem; }
                    .outline-layout { display: grid; grid-template-columns: minmax(0, 1.45fr) minmax(320px, 0.95fr); gap: 20px; align-items: start; }
                    .outline-main { display: flex; flex-direction: column; gap: 20px; }
                    .outline-sidebar { display: flex; flex-direction: column; gap: 20px; }
                    .outline-section { padding: 22px; }
                    .outline-section h3 { margin: 0 0 14px; color: var(--accent-color); font-size: 1.15rem; }
                    .section-text { line-height: 1.95; color: var(--text-color); }
                    .chapter-list { display: grid; gap: 16px; }
                    .chapter-card { padding: 20px; background: linear-gradient(180deg, rgba(255,255,255,0.03), rgba(255,255,255,0.01)); }
                    .chapter-head { display: flex; justify-content: space-between; gap: 14px; align-items: flex-start; margin-bottom: 12px; }
                    .chapter-index { flex: none; width: 44px; height: 44px; border-radius: 14px; display: inline-flex; align-items: center; justify-content: center; background: rgba(88, 166, 255, 0.14); color: var(--accent-color); font-weight: 700; }
                    .chapter-title-group { min-width: 0; flex: 1; }
                    .chapter-title-group h4 { margin: 0; font-size: 1.1rem; color: var(--text-color); }
                    .chapter-subtitle { margin-top: 6px; color: #8b949e; font-size: 0.9rem; }
                    .chapter-target { padding: 6px 10px; border-radius: 999px; background: rgba(139, 148, 158, 0.14); color: #c9d1d9; font-size: 0.82rem; }
                    .chapter-summary { margin: 0; line-height: 1.85; color: var(--text-color); }
                    .chip-row { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 14px; }
                    .chip { display: inline-flex; align-items: center; gap: 6px; padding: 6px 10px; border-radius: 999px; background: rgba(139, 148, 158, 0.1); color: #c9d1d9; font-size: 0.82rem; }
                    .mini-grid { display: grid; gap: 12px; }
                    .mini-card { padding: 16px; }
                    .mini-card p, .mini-card li { margin: 0; line-height: 1.8; color: var(--text-color); }
                    .mini-card ul { margin: 0; padding-left: 18px; }
                    .mini-card li + li { margin-top: 8px; }
                    .empty-state { color: #8b949e; font-style: italic; margin: 0; }
                    .progress-section { padding: 20px 22px; border-radius: 16px; background: linear-gradient(135deg, rgba(56, 139, 253, 0.12), rgba(46, 160, 67, 0.14)); border: 1px solid rgba(88, 166, 255, 0.24); }
                    .progress-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; margin-bottom: 14px; }
                    .progress-kicker { display: block; margin-bottom: 8px; font-size: 0.78rem; letter-spacing: 0.08em; text-transform: uppercase; color: #8b949e; }
                    .progress-head h3 { margin: 0; color: var(--text-color); font-size: 1.15rem; }
                    .progress-percent { color: #3fb950; font-size: 1.5rem; font-weight: 700; line-height: 1; }
                    .progress-message { margin: 0; color: var(--text-color); line-height: 1.75; }
                    .progress-bar { width: 100%; height: 12px; border-radius: 999px; background: rgba(255,255,255,0.08); overflow: hidden; margin: 14px 0; }
                    .progress-fill { height: 100%; border-radius: inherit; background: linear-gradient(90deg, #1f6feb, #3fb950); transition: width 0.3s ease; box-shadow: 0 0 18px rgba(63, 185, 80, 0.28); }
                    .progress-meta { display: flex; flex-wrap: wrap; gap: 10px; }
                    .progress-meta span { display: inline-flex; align-items: center; padding: 6px 10px; border-radius: 999px; background: rgba(255,255,255,0.08); color: #c9d1d9; font-size: 0.82rem; }
                    .progress-chapter-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(120px, 1fr)); gap: 10px; margin-top: 16px; }
                    .progress-chapter-item { padding: 12px; border-radius: 14px; border: 1px solid rgba(255,255,255,0.08); background: rgba(255,255,255,0.04); }
                    .progress-chapter-item strong { display: block; color: var(--text-color); margin-bottom: 6px; }
                    .progress-chapter-item span { color: #8b949e; font-size: 0.82rem; }
                    .progress-chapter-item.completed { border-color: rgba(63, 185, 80, 0.28); background: rgba(63, 185, 80, 0.12); }
                    .progress-chapter-item.current { border-color: rgba(88, 166, 255, 0.32); background: rgba(88, 166, 255, 0.14); }
                    @media (max-width: 960px) {
                        .outline-hero, .outline-layout { grid-template-columns: 1fr; display: grid; }
                        .hero-meta { justify-content: flex-start; min-width: 0; }
                    }
                </style>
                <section class="outline-hero">
                    <div>
                        <h2>阶段2 · 故事大纲</h2>
                        <p>集中查看章节规划、节奏结构、关键转折与伏笔安排，判断大纲是否已经具备进入正文生产的稳定性。</p>
                    </div>
                    <div class="hero-meta">
                        <span class="hero-badge">阶段状态：${escapeHtml(getPhaseStatusLabel(phase2Status))}</span>
                        <span class="hero-badge">当前章节：${currentChapter || '未开始'}</span>
                        <span class="hero-badge">检查点：${escapeHtml(checkpointId || '无')}</span>
                    </div>
                </section>

                ${chapterProgress.visible ? `
                    <section class="progress-section">
                        <div class="progress-head">
                            <div>
                                <span class="progress-kicker">章节生成进度</span>
                                <h3>${chapterProgress.title}</h3>
                            </div>
                            <div class="progress-percent">${chapterProgress.percent}%</div>
                        </div>
                        <p class="progress-message">${chapterProgress.message}</p>
                        <div class="progress-bar">
                            <div class="progress-fill" style="width: ${chapterProgress.percent}%;"></div>
                        </div>
                        <div class="progress-meta">
                            <span>总章节：${chapterProgress.total}</span>
                            <span>已完成：${chapterProgress.completed}</span>
                            <span>已生成：${chapterProgress.generated}</span>
                            <span>当前章节：${chapterProgress.currentLabel}</span>
                            <span>当前步骤：${chapterProgress.stepLabel}</span>
                        </div>
                        ${chapterProgress.items.length > 0 ? `
                            <div class="progress-chapter-grid">
                                ${chapterProgress.items.map((item) => `
                                    <div class="progress-chapter-item ${item.state}">
                                        <strong>第 ${item.number} 章</strong>
                                        <span>${item.label}</span>
                                    </div>
                                `).join('')}
                            </div>
                        ` : ''}
                    </section>
                ` : ''}

                <section class="summary-grid">
                    <div class="summary-card">
                        <span class="summary-label">章节规模</span>
                        <div class="summary-value">${chapters.length}</div>
                        <div class="summary-desc">当前大纲共规划 ${chapters.length} 个章节节点</div>
                    </div>
                    <div class="summary-card">
                        <span class="summary-label">目标字数</span>
                        <div class="summary-value">${formatWordCount(totalTargetWordCount)}</div>
                        <div class="summary-desc">汇总所有章节目标字数后的阶段预估</div>
                    </div>
                    <div class="summary-card">
                        <span class="summary-label">关键转折</span>
                        <div class="summary-value">${turningPoints.length}</div>
                        <div class="summary-desc">用于检查节奏起伏与高潮位置是否明确</div>
                    </div>
                    <div class="summary-card">
                        <span class="summary-label">伏笔回收</span>
                        <div class="summary-value">${foreshadowing.length}</div>
                        <div class="summary-desc">用于检查铺垫与后续兑现是否有提前设计</div>
                    </div>
                </section>

                <section class="outline-layout">
                    <div class="outline-main">
                        <section class="outline-section">
                            <span class="section-kicker">结构总览</span>
                            <h3>整体故事结构</h3>
                            <div class="section-text">${formatRichText(outline.structure || outline.summary || '当前尚未生成整体结构说明。')}</div>
                        </section>

                        <section class="outline-section">
                            <span class="section-kicker">章节拆解</span>
                            <h3>分章推进卡片</h3>
                            <div class="chapter-list">
                                ${chapters.length > 0 ? chapters.map((chapter, index) => renderChapterCard(chapter, storyId, index)).join('') : '<p class="empty-state">当前还没有章节大纲数据。</p>'}
                            </div>
                        </section>
                    </div>

                    <div class="outline-sidebar">
                        <section class="outline-section">
                            <span class="section-kicker">节奏锚点</span>
                            <h3>关键转折</h3>
                            <div class="mini-grid">
                                ${turningPoints.length > 0 ? turningPoints.map((point, index) => `
                                    <div class="mini-card">
                                        <span class="mini-label">转折 ${index + 1}${point.chapter ? ` · 第${point.chapter}章` : ''}</span>
                                        <p>${escapeHtml(point.title || point.description || '未命名转折')}</p>
                                        ${point.description && point.title !== point.description ? `<p style="margin-top: 8px; color: #8b949e;">${escapeHtml(point.description)}</p>` : ''}
                                    </div>
                                `).join('') : '<p class="empty-state">暂无关键转折数据。</p>'}
                            </div>
                        </section>

                        <section class="outline-section">
                            <span class="section-kicker">铺垫设计</span>
                            <h3>伏笔与回收</h3>
                            <div class="mini-grid">
                                ${foreshadowing.length > 0 ? foreshadowing.map((item, index) => `
                                    <div class="mini-card">
                                        <span class="mini-label">伏笔 ${index + 1}</span>
                                        <ul>
                                            <li>铺设：${escapeHtml(item.setup || item.description || '未说明')}</li>
                                            <li>回收：${escapeHtml(item.payoff || '待补充')}</li>
                                        </ul>
                                    </div>
                                `).join('') : '<p class="empty-state">暂无伏笔与回收设计。</p>'}
                            </div>
                        </section>
                    </div>
                </section>
            </div>
        `;

        window.scrollTo(scrollState.windowX, scrollState.windowY);
        container.scrollTop = scrollState.containerTop;
        const newOutlineMain = container.querySelector('.outline-main');
        if (newOutlineMain) newOutlineMain.scrollTop = scrollState.outlineMainTop;
        const newOutlineSidebar = container.querySelector('.outline-sidebar');
        if (newOutlineSidebar) newOutlineSidebar.scrollTop = scrollState.outlineSidebarTop;

        if (chapterProgress.active) {
            if (container.__storyRetryPollingTimer) {
                clearTimeout(container.__storyRetryPollingTimer);
            }
            container.__storyRetryPollingTimer = setTimeout(() => {
                if (window.location.hash !== `#/stories/${storyId}/outline`) {
                    container.__storyRetryPollingTimer = null;
                    return;
                }
                renderOutlinePage(container, store, api, storyId);
            }, 5000);
        }
    } catch (error) {
        container.innerHTML = `
            <div class="outline-page">
                <div class="error-state" style="padding: 40px; text-align: center; background: var(--sidebar-bg); border-radius: 8px; border: 1px solid var(--border-color);">
                    <h2 style="color: #f85149;">加载大纲失败</h2>
                    <p style="color: #8b949e; margin-bottom: 20px;">${escapeHtml(error.message)}</p>
                    <a href="#/stories/${storyId}" style="display: inline-block; padding: 8px 16px; background: rgba(139, 148, 158, 0.2); color: var(--text-color); text-decoration: none; border-radius: 4px;">返回故事概览</a>
                </div>
            </div>
        `;
    }
}

function renderChapterCard(chapter, storyId, index) {
    const coreEvents = normalizeArray(chapter.coreEvents || []);
    const summary = chapter.summary || coreEvents[0] || '暂无章节摘要';
    const scenes = normalizeArray(chapter.scenes || []);
    const characters = normalizeArray(chapter.appearingCharacters || []);

    return `
        <article class="chapter-card">
            <div class="chapter-head">
                <div class="chapter-index">${String(chapter.number || index + 1).padStart(2, '0')}</div>
                <div class="chapter-title-group">
                    <h4>${escapeHtml(chapter.title || `第${index + 1}章`)}</h4>
                    <div class="chapter-subtitle">章节定位已拆分为核心事件、出场角色与场景调度</div>
                </div>
                <span class="chapter-target">${formatWordCount(chapter.targetWordCount)}</span>
            </div>
            <p class="chapter-summary">${escapeHtml(summary)}</p>
            ${coreEvents.length > 1 ? `
                <div class="mini-grid" style="margin-top: 14px;">
                    <div class="mini-card">
                        <span class="mini-label">事件节点</span>
                        <ul>
                            ${coreEvents.map((event) => `<li>${escapeHtml(event)}</li>`).join('')}
                        </ul>
                    </div>
                </div>
            ` : ''}
            <div class="chip-row">
                ${scenes.map((scene) => `<span class="chip">场景 · ${escapeHtml(scene)}</span>`).join('')}
                ${characters.map((character) => `<span class="chip">角色 · ${escapeHtml(character)}</span>`).join('')}
            </div>
            <div style="margin-top: 16px;">
                <a href="#/stories/${storyId}/chapters/${chapter.number || index + 1}" style="display: inline-flex; align-items: center; gap: 6px; color: var(--accent-color); text-decoration: none;">查看该章正文页 →</a>
            </div>
        </article>
    `;
}

function getPhaseStatusLabel(status) {
    const labels = {
        pending: '待生成',
        running: '生成中',
        pending_confirmation: '等待大纲确认',
        content_pending_confirmation: '等待正文确认',
        content_production: '正文生产中',
        completed: '已完成'
    };
    return labels[status] || status || '未知';
}

function normalizeArray(value) {
    if (value == null) return [];
    return Array.isArray(value) ? value : [value];
}

function normalizeOutlineData(outline) {
    if (!outline || typeof outline !== 'object') {
        return {
            chapterCards: [],
            turningPoints: [],
            foreshadowing: [],
            structure: '',
            summary: '',
            totalTargetWordCount: 0
        };
    }

    const chapterCards = normalizeArray(outline.chapterCards || outline.chapters || outline.chapterOutline || []).map((chapter, index) => {
        const coreEvents = normalizeArray(chapter?.coreEvents || chapter?.events || chapter?.keyEvents || chapter?.coreEvent || chapter?.summary || []);
        return {
            number: chapter?.number || chapter?.chapterNum || chapter?.chapterNumber || index + 1,
            title: chapter?.title || chapter?.chapterTitle || `第${index + 1}章`,
            summary: chapter?.summary || chapter?.description || chapter?.coreEvent || coreEvents[0] || '',
            coreEvents,
            scenes: normalizeArray(chapter?.scenes || chapter?.sceneList || []),
            appearingCharacters: normalizeArray(chapter?.appearingCharacters || chapter?.characters || []),
            targetWordCount: Number(chapter?.targetWordCount || chapter?.wordCountTarget || chapter?.targetWords || 0) || 0
        };
    });

    const turningPoints = normalizeArray(outline.turningPoints || outline.keyTurningPoints || outline.turning_points || []).map((item) => {
        if (typeof item === 'string') {
            return { title: item, description: item, chapter: 0 };
        }

        return {
            title: item?.title || item?.name || item?.description || '未命名转折',
            description: item?.description || item?.summary || item?.title || '',
            chapter: item?.chapter || item?.chapterNumber || 0
        };
    });

    const foreshadowing = normalizeArray(outline.foreshadowing || outline.foreshadow || []).map((item) => {
        if (typeof item === 'string') {
            return { setup: item, payoff: '', description: item };
        }

        return {
            setup: item?.setup || item?.description || '',
            payoff: item?.payoff || item?.payoffChapter || '',
            description: item?.description || item?.hint || ''
        };
    });

    return {
        chapterCards,
        turningPoints,
        foreshadowing,
        structure: outline.structure || outline.storyStructure || outline.summary || '',
        summary: outline.summary || '',
        totalTargetWordCount: chapterCards.reduce((sum, chapter) => sum + (chapter.targetWordCount || 0), 0)
    };
}

function getChapterProgress(story, outline, phase2Status, apiChapters = []) {
    const phase2 = story.phase2 || {};
    const outlineCards = outline.chapterCards || [];
    const chapters = normalizePhase2ChapterList(apiChapters.length > 0 ? apiChapters : (phase2.chapters || []));
    const total = phase2.plannedChapterCount || outlineCards.length || chapters.length || 0;
    const completed = phase2.completedChapterCount || chapters.filter((chapter) => isCompletedChapterStatus(chapter.status)).length;
    const generated = phase2.generatedChapterCount || chapters.filter((chapter) => {
        return Boolean((chapter.content && chapter.content.trim()) || chapter.wordCount || chapter.metrics?.counts?.actualCount);
    }).length;
    const current = Number(phase2.currentChapter) || 0;
    const checkpointPending = story.workflow?.activeCheckpoint?.status === 'pending';
    const waitingForReview = checkpointPending && (story.workflow?.activeCheckpoint?.phase === 'phase2' || String(phase2Status || '').includes('confirmation'));
    const active = (story.workflow?.currentPhase === 'phase2' && story.workflow?.state === 'running')
        || phase2Status === 'content_production'
        || phase2Status === 'running';
    const started = active && total > 0
        ? Math.max(generated, Math.max(0, Math.min(total, current - 1)))
        : generated;
    let percent = total > 0 ? Math.round((completed / total) * 100) : 0;
    if (active && total > 0) {
        percent = Math.round(((started + 0.5) / total) * 100);
    }
    if (waitingForReview && total > 0) {
        percent = 100;
    }
    const stepLabel = getPhase2StepLabel(story.workflow?.currentStep, phase2Status, waitingForReview);

    let title = '正文尚未开始生成';
    let message = '当前页面会在章节生成期间自动刷新，方便持续观察阶段2执行进度。';

    if (waitingForReview) {
        title = '正文生成完成，等待正文确认';
        message = `已完成 ${completed}/${total || completed} 章正文，流程当前暂停，等待您在检查点页面完成审核。`;
    } else if (active && total > 0) {
        title = `正在生成第 ${current || Math.min(completed + 1, total)} 章`;
        message = `系统正在按大纲顺序逐章写作，当前已完成 ${completed}/${total} 章。`;
    } else if (generated > 0 && total > 0) {
        title = '已有部分章节完成';
        message = `当前已生成 ${generated}/${total} 章，其中 ${completed} 章达到完成状态，可进入章节正文页查看已生成内容。`;
    }

    return {
        visible: active || waitingForReview || (completed > 0 && total > 0),
        active,
        total,
        completed,
        generated,
        current,
        currentLabel: current > 0 ? `第 ${current} 章` : (completed >= total && total > 0 ? '已完成' : '未开始'),
        percent: Math.min(100, Math.max(percent, 0)),
        stepLabel,
        title,
        message,
        items: Array.from({ length: total }, (_, index) => {
            const number = outlineCards[index]?.number || index + 1;
            let state = 'pending';
            let label = '待生成';
            if (index < generated) {
                state = 'completed';
                label = index < completed ? '已完成' : '已生成';
            } else if (current > 0 && number === current && active) {
                state = 'current';
                label = '生成中';
            }
            return { number, state, label };
        })
    };
}

function getPhase2StepLabel(currentStep, phase2Status, waitingForReview) {
    if (waitingForReview) return '等待正文确认';

    const labels = {
        outline_drafting: '正在生成大纲',
        approved_transition: '准备进入正文阶段',
        checkpoint: '等待检查点处理',
        retrying_after_rejection: '根据反馈重写中'
    };

    if (labels[currentStep]) {
        return labels[currentStep];
    }

    if (phase2Status === 'content_production') return '正在生成正文';
    if (phase2Status === 'running') return '阶段执行中';
    if (phase2Status === 'content_pending_confirmation') return '等待正文确认';
    if (phase2Status === 'pending_confirmation') return '等待大纲确认';
    if (phase2Status === 'completed') return '已完成';
    return '准备中';
}

function isCompletedChapterStatus(status) {
    const value = String(status || '').toLowerCase();
    return value === 'completed' || value === 'final' || value === 'polished' || value === 'revised' || value.startsWith('completed');
}

function normalizePhase2ChapterList(chapters) {
    const list = Array.isArray(chapters) ? chapters : [];
    return list.map((chapter, index) => ({
        ...chapter,
        number: chapter?.number || chapter?.chapterNum || chapter?.chapterNumber || index + 1,
        status: String(chapter?.status || '').toLowerCase(),
        content: chapter?.content || chapter?.text || chapter?.body || '',
        wordCount: chapter?.wordCount || chapter?.metrics?.counts?.actualCount || chapter?.metrics?.counts?.chineseChars || 0
    }));
}

function formatWordCount(value) {
    const count = Number(value) || 0;
    return count > 0 ? `${count.toLocaleString()} 字` : '未设置';
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
