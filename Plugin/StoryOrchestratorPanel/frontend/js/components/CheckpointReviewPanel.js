export function renderCheckpointReviewPanel(containerElement, store, api, storyId, checkpoint) {
    if (!containerElement || !checkpoint) return;

    ensureReviewPanelStyles();

    const wrapper = document.createElement('div');
    wrapper.className = 'checkpoint-review-shell';

    let currentArtifactIndex = 0;
    const artifacts = parseArtifacts(checkpoint);
    const checkpointMeta = getCheckpointMeta(checkpoint);

    render();

    function parseArtifacts(currentCheckpoint) {
        const result = [];
        const type = currentCheckpoint.type;
        const checkpointKind = resolveCheckpointKind(type);
        const payload = currentCheckpoint.payload || {};

        if (checkpointKind === 'phase1') {
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
            if (payload.validation) {
                result.push({
                    id: 'validation',
                    title: '一致性校验',
                    type: 'validation',
                    data: payload.validation
                });
            }
        } else if (checkpointKind === 'phase2-outline') {
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
                    title: '章节推进预览',
                    type: 'chapters',
                    data: payload.chapters
                });
            }
        } else if (checkpointKind === 'phase2-content') {
            if (payload.outline) {
                result.push({
                    id: 'outline',
                    title: '大纲回看',
                    type: 'outline',
                    data: payload.outline
                });
            }
            if (Array.isArray(payload.chapters)) {
                payload.chapters.forEach((chapter) => {
                    const normalizedChapter = normalizeArtifactChapter(chapter);
                    result.push({
                        id: `chapter-${normalizedChapter.chapterNum || normalizedChapter.number}`,
                        title: normalizedChapter.title,
                        type: 'chapter',
                        data: normalizedChapter
                    });
                });
            }
        } else if (checkpointKind === 'phase3-final') {
            if (payload.finalEditorOutput) {
                result.push({
                    id: 'final-manuscript',
                    title: '最终整编稿',
                    type: 'final-manuscript',
                    data: {
                        content: payload.finalEditorOutput
                    }
                });
            }
            if (payload.finalValidation) {
                result.push({
                    id: 'validation',
                    title: '终校结论',
                    type: 'validation',
                    data: payload.finalValidation
                });
            }
            if (payload.qualityScores) {
                result.push({
                    id: 'quality-scores',
                    title: '评分记录',
                    type: 'quality-scores',
                    data: payload.qualityScores
                });
            }
            const chapters = Array.isArray(payload.polishedChapters) && payload.polishedChapters.length > 0
                ? payload.polishedChapters
                : payload.chapters;
            if (Array.isArray(chapters)) {
                chapters.forEach((chapter) => {
                    const normalizedChapter = normalizeArtifactChapter(chapter);
                    result.push({
                        id: `chapter-${normalizedChapter.chapterNum || normalizedChapter.number}`,
                        title: normalizedChapter.title,
                        type: 'chapter',
                        data: normalizedChapter
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
        const currentArtifact = artifacts[currentArtifactIndex];
        const feedbackPresets = getFeedbackPresets(checkpoint.type);
        const summaryCards = getSummaryCards(currentArtifact);

        wrapper.innerHTML = `
            <section class="review-hero">
                <div>
                    <div class="review-eyebrow">创作审阅台</div>
                    <div style="display: flex; align-items: center; gap: 16px;">
                        <button type="button" id="btn-review-back" style="background: none; border: none; cursor: pointer; padding: 6px; border-radius: 8px; display: inline-flex; align-items: center; justify-content: center; color: var(--review-gold); transition: background 0.2s;" title="返回概览">
                            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M19 12H5M12 19l-7-7 7-7"/></svg>
                        </button>
                        <h1 class="review-title">${escapeHtml(checkpointMeta.title)}</h1>
                    </div>
                    <p class="review-subtitle">${escapeHtml(checkpointMeta.subtitle)}</p>
                </div>
                <div class="review-hero-meta">
                    <span class="review-badge phase">${escapeHtml(checkpointMeta.phaseLabel)}</span>
                    <span class="review-badge type">${escapeHtml(checkpointMeta.typeLabel)}</span>
                    <span class="review-badge count">共 ${artifacts.length} 份审阅材料</span>
                </div>
            </section>

            <section class="review-layout">
                <aside class="review-sidebar">
                    <div class="review-panel-header">
                        <span class="review-panel-title">审阅目录</span>
                        <span class="review-panel-meta">逐项检查</span>
                    </div>
                    <div class="review-artifact-list">
                        ${artifacts.map((artifact, index) => `
                            <button type="button" class="review-artifact-item ${index === currentArtifactIndex ? 'active' : ''}" data-index="${index}">
                                <span class="artifact-index">${String(index + 1).padStart(2, '0')}</span>
                                <span class="artifact-text">
                                    <strong>${escapeHtml(artifact.title)}</strong>
                                    <small>${escapeHtml(getArtifactLabel(artifact.type))}</small>
                                </span>
                            </button>
                        `).join('')}
                    </div>
                </aside>

                <main class="review-content">
                    <div class="review-content-header">
                        <div>
                            <div class="review-content-kicker">${escapeHtml(getArtifactLabel(currentArtifact?.type))}</div>
                            <h2>${escapeHtml(currentArtifact?.title || '待审内容')}</h2>
                        </div>
                        <div class="review-summary-strip">
                            ${summaryCards.map((card) => `
                                <div class="summary-pill">
                                    <span>${escapeHtml(card.label)}</span>
                                    <strong>${escapeHtml(card.value)}</strong>
                                </div>
                            `).join('')}
                        </div>
                    </div>
                    <div class="review-reader-surface">
                        ${renderArtifactContent(currentArtifact)}
                    </div>
                </main>

                <aside class="review-actions">
                    <div class="review-panel-header">
                        <span class="review-panel-title">评审结论</span>
                        <span class="review-panel-meta">影响后续工作流</span>
                    </div>

                    <div class="review-actions-inner">
                        <div class="decision-card highlight compact">
                            <div class="decision-label">当前阶段</div>
                            <div class="decision-value">${escapeHtml(checkpointMeta.phaseLabel)}</div>
                            <p>${escapeHtml(checkpointMeta.hint)}</p>
                        </div>

                        <div class="decision-card compact">
                            <div class="decision-label">审阅重点</div>
                            <ol class="review-checklist">
                                ${getReviewChecklist(checkpoint.type).map((item) => `<li>${escapeHtml(item)}</li>`).join('')}
                            </ol>
                        </div>

                        <div class="decision-card compact">
                            <div class="decision-label">快捷反馈</div>
                            <div class="feedback-chip-group">
                                ${feedbackPresets.map((chip) => `
                                    <button type="button" class="feedback-chip">${escapeHtml(chip)}</button>
                                `).join('')}
                            </div>
                        </div>

                        <div class="decision-card grow compact">
                            <label class="decision-label" for="feedback-text">修改意见</label>
                            <textarea id="feedback-text" class="review-textarea" placeholder="若需要退回修改，请明确指出问题、影响范围与期望调整方向。"></textarea>
                            <div class="decision-tip">通过时可留空；拒绝时必须填写具体修改意见。</div>
                        </div>
                    </div>

                    <div class="review-action-bar">
                        <button id="btn-approve" class="review-btn approve">通过检查点</button>
                        <button id="btn-reject" class="review-btn reject">退回修改</button>
                    </div>
                </aside>
            </section>
        `;

        wrapper.querySelectorAll('.review-artifact-item').forEach((button) => {
            button.addEventListener('click', (event) => {
                currentArtifactIndex = parseInt(event.currentTarget.getAttribute('data-index'), 10);
                render();
            });
        });

        const btnBack = wrapper.querySelector('#btn-review-back');
        if (btnBack) {
            btnBack.addEventListener('click', () => {
                window.location.hash = `#/stories/${storyId}`;
            });
            btnBack.addEventListener('mouseenter', () => { btnBack.style.background = 'rgba(161, 113, 54, 0.12)'; });
            btnBack.addEventListener('mouseleave', () => { btnBack.style.background = 'none'; });
        }

        const feedbackText = wrapper.querySelector('#feedback-text');
        wrapper.querySelectorAll('.feedback-chip').forEach((chip) => {
            chip.addEventListener('click', () => {
                const text = chip.textContent;
                feedbackText.value = feedbackText.value
                    ? `${feedbackText.value}\n- ${text}`
                    : `- ${text}`;
                feedbackText.focus();
            });
        });

        const btnApprove = wrapper.querySelector('#btn-approve');
        const btnReject = wrapper.querySelector('#btn-reject');

        btnApprove.addEventListener('click', async () => {
            try {
                setDecisionPendingState(btnApprove, btnReject, 'approve');
                const result = await api.approveCheckpoint(storyId, checkpoint.id);
                const isBackgroundContinuation = result?.result?.background;
                alert(isBackgroundContinuation ? '审核已通过，工作流已在后台继续执行。' : '审核已通过，工作流将继续。');
                window.location.hash = `#/stories/${storyId}`;
            } catch (error) {
                alert(`批准失败: ${error.message}`);
                resetDecisionState(btnApprove, btnReject);
            }
        });

        btnReject.addEventListener('click', async () => {
            const feedback = feedbackText.value.trim();
            if (!feedback) {
                alert('退回修改时必须提供修改意见。');
                feedbackText.focus();
                return;
            }

            try {
                setDecisionPendingState(btnApprove, btnReject, 'reject');
                const result = await api.rejectCheckpoint(storyId, checkpoint.id, feedback);
                const isBackgroundRetry = result?.result?.background;
                alert(isBackgroundRetry ? '已退回该检查点，系统正在后台根据反馈重新生成。' : '已退回该检查点，工作流将根据反馈重新生成。');
                window.location.hash = `#/stories/${storyId}`;
            } catch (error) {
                alert(`拒绝失败: ${error.message}`);
                resetDecisionState(btnApprove, btnReject);
            }
        });

        containerElement.innerHTML = '';
        containerElement.appendChild(wrapper);
    }

    function renderArtifactContent(artifact) {
        if (!artifact) {
            return '<div class="empty-review-state">没有可展示的审核内容。</div>';
        }

        if (artifact.type === 'worldview') {
            const worldview = artifact.data || {};
            return `
                <article class="manuscript-block">
                    <section class="manuscript-section">
                        <div class="section-heading">世界观总览</div>
                        <p class="manuscript-paragraph">${formatParagraphs(worldview.setting || worldview.background || '暂无设定')}</p>
                    </section>
                    <section class="manuscript-grid">
                        ${renderInfoCard('时代氛围', worldview.era || worldview.timePeriod || worldview.tone || '未提供')}
                        ${renderInfoCard('核心冲突', worldview.coreConflict || worldview.conflict || '未提供')}
                        ${renderInfoCard('规则约束', worldview.rules?.limitations || worldview.constraints || '未提供')}
                    </section>
                    ${worldview.rules ? `
                        <section class="manuscript-section">
                            <div class="section-heading">规则与代价</div>
                            <div class="manuscript-grid">
                                ${renderInfoCard('物理规则', worldview.rules.physical || '未提供')}
                                ${renderInfoCard('特殊设定', worldview.rules.special || '未提供')}
                                ${renderInfoCard('限制与代价', worldview.rules.limitations || '未提供')}
                            </div>
                        </section>
                    ` : ''}
                    ${(worldview.factions || []).length > 0 ? `
                        <section class="manuscript-section">
                            <div class="section-heading">势力设定</div>
                            <div class="character-board">
                                ${worldview.factions.map((faction) => `
                                    <div class="character-card">
                                        <div class="character-card-top">
                                            <div>
                                                <h3>${escapeHtml(faction.name || '未命名势力')}</h3>
                                                <div class="character-role">势力</div>
                                            </div>
                                        </div>
                                        <p>${escapeHtml(faction.description || '暂无描述')}</p>
                                        ${(faction.relationships || []).length > 0 ? `
                                            <ul class="bullet-list">
                                                ${faction.relationships.map((item) => `<li>${escapeHtml(item)}</li>`).join('')}
                                            </ul>
                                        ` : ''}
                                    </div>
                                `).join('')}
                            </div>
                        </section>
                    ` : ''}
                    ${(worldview.history?.keyEvents || []).length > 0 || (worldview.history?.coreConflicts || []).length > 0 ? `
                        <section class="manuscript-section">
                            <div class="section-heading">历史与核心矛盾</div>
                            <div class="chapter-summary-list">
                                <div class="chapter-summary-card">
                                    <div class="chapter-summary-head">
                                        <span class="chapter-tag">关键历史事件</span>
                                    </div>
                                    ${(worldview.history?.keyEvents || []).length > 0 ? `
                                        <ul class="bullet-list">
                                            ${worldview.history.keyEvents.map((item) => `<li>${escapeHtml(item)}</li>`).join('')}
                                        </ul>
                                    ` : '<p>暂无历史事件。</p>'}
                                </div>
                                <div class="chapter-summary-card">
                                    <div class="chapter-summary-head">
                                        <span class="chapter-tag">核心矛盾</span>
                                    </div>
                                    ${(worldview.history?.coreConflicts || []).length > 0 ? `
                                        <ul class="bullet-list">
                                            ${worldview.history.coreConflicts.map((item) => `<li>${escapeHtml(item)}</li>`).join('')}
                                        </ul>
                                    ` : '<p>暂无核心矛盾。</p>'}
                                </div>
                            </div>
                        </section>
                    ` : ''}
                    ${(worldview.sceneNorms || []).length > 0 || (worldview.secrets || []).length > 0 ? `
                        <section class="manuscript-section">
                            <div class="section-heading">场景规范与伏笔</div>
                            <div class="chapter-summary-list">
                                <div class="chapter-summary-card">
                                    <div class="chapter-summary-head">
                                        <span class="chapter-tag">场景规范</span>
                                    </div>
                                    ${(worldview.sceneNorms || []).length > 0 ? `
                                        <ul class="bullet-list">
                                            ${worldview.sceneNorms.map((item) => `<li>${escapeHtml(item)}</li>`).join('')}
                                        </ul>
                                    ` : '<p>暂无场景规范。</p>'}
                                </div>
                                <div class="chapter-summary-card">
                                    <div class="chapter-summary-head">
                                        <span class="chapter-tag">隐藏秘密 / 伏笔</span>
                                    </div>
                                    ${(worldview.secrets || []).length > 0 ? `
                                        <ul class="bullet-list">
                                            ${worldview.secrets.map((item) => `<li>${escapeHtml(item)}</li>`).join('')}
                                        </ul>
                                    ` : '<p>暂无伏笔信息。</p>'}
                                </div>
                            </div>
                        </section>
                    ` : ''}
                </article>
            `;
        }

        if (artifact.type === 'characters') {
            const characterGroups = getCharacterGroups(artifact.data);
            return `
                <article class="manuscript-block">
                    ${renderCharacterSection('人物档案 · 主角', characterGroups.protagonists, '主角')}
                    ${renderCharacterSection('人物档案 · 配角', characterGroups.supportingCharacters, '配角')}
                    ${renderCharacterSection('人物档案 · 反派', characterGroups.antagonists, '反派')}
                    ${(characterGroups.relationshipNetwork.direct || []).length > 0 || (characterGroups.relationshipNetwork.hidden || []).length > 0 ? `
                        <section class="manuscript-section">
                            <div class="section-heading">关系网络与行为边界</div>
                            <div class="chapter-summary-list">
                                <div class="chapter-summary-card">
                                    <div class="chapter-summary-head">
                                        <span class="chapter-tag">显性关系</span>
                                    </div>
                                    ${(characterGroups.relationshipNetwork.direct || []).length > 0 ? `
                                        <ul class="bullet-list">
                                            ${characterGroups.relationshipNetwork.direct.map((item) => `<li>${escapeHtml(item.from)} → ${escapeHtml(item.to)}：${escapeHtml(item.type)}</li>`).join('')}
                                        </ul>
                                    ` : '<p>暂无显性关系。</p>'}
                                </div>
                                <div class="chapter-summary-card">
                                    <div class="chapter-summary-head">
                                        <span class="chapter-tag">隐藏关系</span>
                                    </div>
                                    ${(characterGroups.relationshipNetwork.hidden || []).length > 0 ? `
                                        <ul class="bullet-list">
                                            ${characterGroups.relationshipNetwork.hidden.map((item) => `<li>${escapeHtml(item.from)} → ${escapeHtml(item.to)}：${escapeHtml(item.secret)}</li>`).join('')}
                                        </ul>
                                    ` : '<p>暂无隐藏关系。</p>'}
                                </div>
                            </div>
                        </section>
                    ` : ''}
                    ${Object.keys(characterGroups.oocRules || {}).length > 0 ? `
                        <section class="manuscript-section">
                            <div class="section-heading">行为边界</div>
                            <div class="character-board">
                                ${Object.entries(characterGroups.oocRules).map(([name, rules]) => `
                                    <div class="character-card">
                                        <div class="character-card-top">
                                            <div>
                                                <h3>${escapeHtml(name)}</h3>
                                                <div class="character-role">OOC 规则</div>
                                            </div>
                                        </div>
                                        <ul class="bullet-list">
                                            ${normalizeList(rules).map((item) => `<li>${escapeHtml(item)}</li>`).join('')}
                                        </ul>
                                    </div>
                                `).join('')}
                            </div>
                        </section>
                    ` : ''}
                </article>
            `;
        }

        if (artifact.type === 'outline') {
            const cards = artifact.data.chapterCards || artifact.data.cards || artifact.data.chapters || [];
            const turningPoints = artifact.data.turningPoints || artifact.data.keyTurningPoints || [];
            const foreshadowing = artifact.data.foreshadowing || [];
            return `
                <article class="manuscript-block">
                    ${artifact.data.structure ? `
                        <section class="manuscript-section">
                            <div class="section-heading">整体结构</div>
                            <div class="chapter-text">${formatParagraphs(artifact.data.structure)}</div>
                        </section>
                    ` : ''}
                    <section class="outline-timeline">
                        ${cards.length > 0 ? cards.map((card, index) => renderOutlineCard(card, index)).join('') : '<div class="empty-review-state">没有大纲卡片数据。</div>'}
                    </section>
                    ${(turningPoints.length > 0 || foreshadowing.length > 0) ? `
                        <section class="manuscript-section">
                            <div class="section-heading">节奏与伏笔</div>
                            <div class="chapter-summary-list">
                                <div class="chapter-summary-card">
                                    <div class="chapter-summary-head">
                                        <span class="chapter-tag">关键转折</span>
                                    </div>
                                    ${turningPoints.length > 0 ? `
                                        <ul class="bullet-list">
                                            ${turningPoints.map((item) => `<li>${escapeHtml(formatTurningPoint(item))}</li>`).join('')}
                                        </ul>
                                    ` : '<p>暂无关键转折。</p>'}
                                </div>
                                <div class="chapter-summary-card">
                                    <div class="chapter-summary-head">
                                        <span class="chapter-tag">伏笔回收</span>
                                    </div>
                                    ${foreshadowing.length > 0 ? `
                                        <ul class="bullet-list">
                                            ${foreshadowing.map((item) => `<li>${escapeHtml(formatForeshadowing(item))}</li>`).join('')}
                                        </ul>
                                    ` : '<p>暂无伏笔设计。</p>'}
                                </div>
                            </div>
                        </section>
                    ` : ''}
                </article>
            `;
        }

        if (artifact.type === 'chapters') {
            const chapters = Array.isArray(artifact.data) ? artifact.data.map((chapter, index) => normalizeArtifactChapter(chapter, index + 1)) : [];
            return `
                <article class="manuscript-block">
                    <section class="chapter-summary-list">
                        ${chapters.length > 0 ? chapters.map((chapter, index) => `
                            <div class="chapter-summary-card">
                                <div class="chapter-summary-head">
                                    <span class="chapter-tag">第 ${chapter.chapterNum || chapter.number || index + 1} 章</span>
                                    <h3>${escapeHtml(chapter.title || '未命名章节')}</h3>
                                </div>
                                <p>${escapeHtml(chapter.summary || chapter.description || chapter.content?.slice(0, 160) || '暂无章节摘要')}</p>
                                <div class="chip-cloud">
                                    ${Number(chapter.wordCount || chapter.wordCountTarget || 0) > 0 ? `<span class="meta-chip">${formatWordCount(chapter.wordCount || chapter.wordCountTarget)}</span>` : ''}
                                    ${chapter.status ? `<span class="meta-chip">${escapeHtml(getReadableChapterStatus(chapter.status))}</span>` : ''}
                                </div>
                            </div>
                        `).join('') : '<div class="empty-review-state">没有章节数据。</div>'}
                    </section>
                </article>
            `;
        }

        if (artifact.type === 'chapter') {
            const text = artifact.data.content || artifact.data.text || '';
            const originalText = artifact.data.originalContent || '';
            const improvements = normalizeList(artifact.data.improvements);
            const validation = artifact.data.validation || null;
            const validationIssues = normalizeValidationIssues(validation?.allIssues || validation?.issues || validation?.warnings || validation || []);
            const validationSuggestions = normalizeList(validation?.allSuggestions || validation?.suggestions || []);
            const validationCheckEntries = Object.entries(validation?.checks || {});
            return `
                <article class="manuscript-block">
                    <section class="chapter-manuscript">
                        <div class="chapter-kicker">${originalText || improvements.length > 0 ? '润色稿试读' : '正文试读'}</div>
                        <div class="manuscript-grid">
                            ${renderInfoCard('章节', `第${artifact.data.chapterNum || artifact.data.number || '—'}章`)}
                            ${renderInfoCard('字数', formatWordCount(artifact.data.wordCount || artifact.data.metrics?.counts?.actualCount || countCharacters(text)))}
                            ${renderInfoCard('状态', getReadableChapterStatus(artifact.data.status))}
                        </div>
                        <div class="chapter-text">${formatParagraphs(text || '暂无正文')}</div>
                    </section>
                    ${originalText ? `
                        <section class="manuscript-section">
                            <div class="section-heading">原始正文</div>
                            <div class="chapter-text">${formatParagraphs(originalText)}</div>
                        </section>
                    ` : ''}
                    ${improvements.length > 0 ? `
                        <section class="manuscript-section">
                            <div class="section-heading">润色改进点</div>
                            <ul class="bullet-list">
                                ${improvements.map((item) => `<li>${escapeHtml(item)}</li>`).join('')}
                            </ul>
                        </section>
                    ` : ''}
                    ${validation ? `
                        <section class="manuscript-section">
                            <div class="section-heading">章节校验</div>
                            ${validationCheckEntries.length > 0 ? `
                                <div class="validation-cards-container" style="display: flex; flex-direction: column; gap: 16px; margin-bottom: 20px;">
                                    ${validationCheckEntries.map(([key, item]) => {
                                        const isPassed = item.passed;
                                        const statusLabel = isPassed ? (item.hasWarnings ? '有条件通过' : '通过') : '待修正';
                                        const statusColor = isPassed ? (item.hasWarnings ? '#d29922' : '#3fb950') : '#f85149';
                                        const statusBg = isPassed ? (item.hasWarnings ? 'rgba(210, 153, 34, 0.1)' : 'rgba(63, 185, 80, 0.1)') : 'rgba(248, 81, 73, 0.1)';
                                        
                                        return `
                                        <div class="validation-card" style="border: 1px solid var(--border-color); border-radius: 12px; padding: 16px; background: rgba(255,255,255,0.02);">
                                            <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px;">
                                                <strong style="font-size: 1.1rem; color: var(--text-color);">${escapeHtml(getValidationCheckLabel(key))}</strong>
                                                <span style="padding: 4px 10px; border-radius: 999px; font-size: 0.85rem; font-weight: 600; color: ${statusColor}; background: ${statusBg}; border: 1px solid ${statusColor}40;">
                                                    ${escapeHtml(statusLabel)}
                                                </span>
                                            </div>
                                            ${(item.issues && item.issues.length > 0) ? `
                                                <div style="margin-bottom: 12px;">
                                                    <span style="display: block; font-size: 0.85rem; color: #8b949e; margin-bottom: 6px;">发现问题：</span>
                                                    <ul style="margin: 0; padding-left: 20px; color: var(--text-color); font-size: 0.95rem; line-height: 1.6;">
                                                        ${item.issues.map(issue => `<li>${escapeHtml(issue.description || issue)}</li>`).join('')}
                                                    </ul>
                                                </div>
                                            ` : ''}
                                            ${(item.suggestions && item.suggestions.length > 0) ? `
                                                <div style="margin-bottom: 12px;">
                                                    <span style="display: block; font-size: 0.85rem; color: #8b949e; margin-bottom: 6px;">修改建议：</span>
                                                    <ul style="margin: 0; padding-left: 20px; color: var(--text-color); font-size: 0.95rem; line-height: 1.6;">
                                                        ${item.suggestions.map(sugg => `<li>${escapeHtml(sugg)}</li>`).join('')}
                                                    </ul>
                                                </div>
                                            ` : ''}
                                            ${item.rawReport ? `
                                                <div>
                                                    <span style="display: block; font-size: 0.85rem; color: #8b949e; margin-bottom: 6px;">详细报告：</span>
                                                    <div style="color: var(--text-color); font-size: 0.95rem; line-height: 1.7; background: rgba(139, 148, 158, 0.1); border: 1px solid rgba(139, 148, 158, 0.2); padding: 12px; border-radius: 8px;">
                                                        ${formatParagraphs(item.rawReport)}
                                                    </div>
                                                </div>
                                            ` : (!item.issues?.length && !item.suggestions?.length ? '<p style="color: #8b949e; margin: 0; font-size: 0.95rem;">未发现明显问题。</p>' : '')}
                                        </div>
                                    `}).join('')}
                                </div>
                            ` : ''}
                            <div class="validation-list">
                                ${validationIssues.length > 0 ? validationIssues.map((issue) => `
                                    <div class="validation-item severity-${escapeHtml(issue.severity)}">
                                        <div class="validation-item-head">
                                            <strong>${escapeHtml(getSeverityLabel(issue.severity))}</strong>
                                        </div>
                                        <p>${escapeHtml(issue.description)}</p>
                                    </div>
                                `).join('') : '<div class="empty-review-state">暂无综合校验问题。</div>'}
                            </div>
                            ${validationSuggestions.length > 0 ? `
                                <div class="section-heading" style="margin-top: 20px;">综合修正建议</div>
                                <ul class="bullet-list">
                                    ${validationSuggestions.map((item) => `<li>${escapeHtml(item)}</li>`).join('')}
                                </ul>
                            ` : ''}
                        </section>
                    ` : ''}
                </article>
            `;
        }

        if (artifact.type === 'validation') {
            const issues = normalizeValidationIssues(artifact.data.issues || []);
            const rawReport = artifact.data.rawReport || artifact.data.summary || '';
            const suggestions = normalizeList(artifact.data.suggestions);
            return `
                <article class="manuscript-block">
                    <section class="manuscript-section">
                        <div class="section-heading">校验结论</div>
                        <div class="validation-overview">
                            <div class="info-card">
                                <span>通过状态</span>
                                <strong>${artifact.data.passed ? '通过' : '待修正'}</strong>
                            </div>
                            <div class="info-card">
                                <span>问题数量</span>
                                <strong>${issues.length}</strong>
                            </div>
                            <div class="info-card">
                                <span>评分条目</span>
                                <strong>${normalizeValidationScoreRows(artifact.data.qualityScores).length}</strong>
                            </div>
                        </div>
                    </section>
                    <section class="manuscript-section">
                        <div class="section-heading">问题清单</div>
                        <div class="validation-list">
                            ${issues.length > 0 ? issues.map((issue) => `
                                <div class="validation-item severity-${escapeHtml(issue.severity || 'unknown')}">
                                    <div class="validation-item-head">
                                        <strong>${escapeHtml(getSeverityLabel(issue.severity || 'notice'))}</strong>
                                    </div>
                                    <p>${escapeHtml(issue.description || '暂无描述')}</p>
                                </div>
                            `).join('') : '<div class="empty-review-state">暂无校验问题。</div>'}
                        </div>
                    </section>
                    ${normalizeValidationScoreRows(artifact.data.qualityScores).length > 0 ? `
                        <section class="manuscript-section">
                            <div class="section-heading">评分记录</div>
                            <div class="quality-trend-grid">
                                ${normalizeValidationScoreRows(artifact.data.qualityScores).map((row) => `
                                    <div class="quality-score-card">
                                        <div class="quality-score-head">
                                            <strong>${escapeHtml(row.title)}</strong>
                                            <span>${escapeHtml(row.average)}</span>
                                        </div>
                                        <ul class="bullet-list">
                                            ${row.items.map((item) => `<li>${escapeHtml(item.label)}：${escapeHtml(item.value)}</li>`).join('')}
                                        </ul>
                                    </div>
                                `).join('')}
                            </div>
                        </section>
                    ` : ''}
                    ${suggestions.length > 0 ? `
                        <section class="manuscript-section">
                            <div class="section-heading">修正建议</div>
                            <ul class="bullet-list">
                                ${suggestions.map((item) => `<li>${escapeHtml(item)}</li>`).join('')}
                            </ul>
                        </section>
                    ` : ''}
                    ${rawReport ? `
                        <section class="manuscript-section">
                            <div class="section-heading">完整报告</div>
                            <div class="chapter-text">${formatParagraphs(rawReport)}</div>
                        </section>
                    ` : ''}
                </article>
            `;
        }

        if (artifact.type === 'quality-scores') {
            const rows = normalizeQualityTrendRows(artifact.data);
            return `
                <article class="manuscript-block">
                    <section class="manuscript-section">
                        <div class="section-heading">质量迭代</div>
                        <div class="quality-trend-grid">
                            ${rows.length > 0 ? rows.map((row) => `
                                <div class="quality-score-card">
                                    <div class="quality-score-head">
                                        <strong>${escapeHtml(row.title)}</strong>
                                        <span>${escapeHtml(row.overall)}</span>
                                    </div>
                                    <ul class="bullet-list">
                                        ${row.items.map((item) => `<li>${escapeHtml(item.label)}：${escapeHtml(item.value)}</li>`).join('')}
                                    </ul>
                                </div>
                            `).join('') : '<div class="empty-review-state">暂无评分记录。</div>'}
                        </div>
                    </section>
                </article>
            `;
        }

        if (artifact.type === 'final-manuscript') {
            return `
                <article class="manuscript-block">
                    <section class="chapter-manuscript">
                        <div class="chapter-kicker">最终整编稿</div>
                        <div class="chapter-text">${formatParagraphs(artifact.data.content || '暂无终稿')}</div>
                    </section>
                </article>
            `;
        }

        return `
            <article class="manuscript-block">
                <pre class="raw-payload-block"><code>${escapeHtml(JSON.stringify(artifact.data, null, 2))}</code></pre>
            </article>
        `;
    }
}

function flattenCharacters(charactersData) {
    if (Array.isArray(charactersData)) {
        return charactersData;
    }

    const source = charactersData?.characters || charactersData || {};
    const groups = [
        { items: source.protagonists, roleType: '主角' },
        { items: source.supporting, roleType: '配角' },
        { items: source.supportingCharacters, roleType: '配角' },
        { items: source.antagonists, roleType: '反派' }
    ];

    return groups.flatMap(({ items, roleType }) =>
        Array.isArray(items) ? items.map((item) => ({ ...item, roleType: item.roleType || roleType })) : []
    );
}

function getCharacterGroups(charactersData) {
    if (Array.isArray(charactersData)) {
        return {
            protagonists: charactersData,
            supportingCharacters: [],
            antagonists: [],
            relationshipNetwork: { direct: [], hidden: [] },
            oocRules: {}
        };
    }

    const source = charactersData?.characters || charactersData || {};
    return {
        protagonists: normalizeList(source.protagonists),
        supportingCharacters: normalizeList(source.supportingCharacters || source.supporting),
        antagonists: normalizeList(source.antagonists),
        relationshipNetwork: source.relationshipNetwork || { direct: [], hidden: [] },
        oocRules: source.oocRules || {}
    };
}

function renderCharacterSection(title, items, roleLabel) {
    if (!items || items.length === 0) return '';
    return `
        <section class="manuscript-section">
            <div class="section-heading">${escapeHtml(title)}</div>
            <div class="character-board">
                ${items.map((character) => `
                    <div class="character-card">
                        <div class="character-card-top">
                            <div>
                                <h3>${escapeHtml(character.name || '未知角色')}</h3>
                                <div class="character-role">${escapeHtml(roleLabel)}</div>
                            </div>
                            <span class="mini-badge">${escapeHtml(character.identity || character.role || '角色')}</span>
                        </div>
                        ${renderCharacterDetails(character)}
                    </div>
                `).join('')}
            </div>
        </section>
    `;
}

function renderCharacterDetails(character) {
    const fields = [
        ['身份描述', character.identity],
        ['外貌特征', character.appearance],
        ['背景故事', character.background],
        ['核心动机', character.motivation],
        ['内在矛盾', character.innerConflict],
        ['成长弧线', character.growthArc],
        ['功能定位', character.role],
        ['与主角关系', character.relationship]
    ];

    const parts = fields
        .filter(([, value]) => value)
        .map(([label, value]) => `<p><strong>${escapeHtml(label)}：</strong>${escapeHtml(value)}</p>`);

    if (Array.isArray(character.personality) && character.personality.length > 0) {
        parts.push(`<p><strong>性格关键词：</strong>${character.personality.map((item) => escapeHtml(item)).join('、')}</p>`);
    }

    return parts.length > 0 ? parts.join('') : '<p>暂无人物详情。</p>';
}

function normalizeList(value) {
    if (value == null) return [];
    return Array.isArray(value) ? value : [value];
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

function resolveCheckpointKind(type) {
    if (type === 'phase1_checkpoint' || type === 'worldview_confirmation') {
        return 'phase1';
    }

    if (type === 'outline_checkpoint' || type === 'outline_confirmation' || type === 'phase2_checkpoint' || type === 'phase2_outline_confirmation') {
        return 'phase2-outline';
    }

    if (type === 'content_checkpoint' || type === 'content_quality_confirmation' || type === 'phase2_content_confirmation') {
        return 'phase2-content';
    }

    if (type === 'final_checkpoint' || type === 'final_approval' || type === 'phase3_checkpoint') {
        return 'phase3-final';
    }

    return 'unknown';
}

function getCheckpointMeta(checkpoint) {
    const map = {
        phase1: {
            title: '设定审阅',
            subtitle: '确认世界观、角色与故事基础框架是否稳定可用。',
            phaseLabel: '阶段一 · 世界观设定',
            typeLabel: '基础设定确认',
            hint: '重点检查设定是否自洽、人物是否立得住、后续能否顺畅展开。'
        },
        'phase2-outline': {
            title: '大纲审阅',
            subtitle: '确认章节推进、情节转折、伏笔布局与总体结构是否已经稳定。',
            phaseLabel: '阶段二 · 大纲规划',
            typeLabel: '故事大纲确认',
            hint: '重点检查结构完整性、章节顺序与故事张力。'
        },
        'phase2-content': {
            title: '正文审阅',
            subtitle: '确认章节正文是否已达到进入润色阶段的基础质量要求。',
            phaseLabel: '阶段二 · 正文生产',
            typeLabel: '正文内容确认',
            hint: '重点检查章节完整度、情绪推进、场景调度与上下文衔接。'
        },
        'phase3-final': {
            title: '定稿审阅',
            subtitle: '确认润色稿、终校结果与最终整编稿是否达到交付标准。',
            phaseLabel: '阶段三 · 润色定稿',
            typeLabel: '最终定稿确认',
            hint: '重点检查整体一致性、可读性与最终完成质量。'
        }
    };

    return map[resolveCheckpointKind(checkpoint.type)] || {
        title: '检查点审阅',
        subtitle: '请逐项检查当前生成内容并给出明确结论。',
        phaseLabel: '待确认阶段',
        typeLabel: checkpoint.type || '未知类型',
        hint: '重点检查是否满足当前阶段的创作目标。'
    };
}

function getArtifactLabel(type) {
    const labelMap = {
        worldview: '设定文本',
        characters: '角色档案',
        outline: '结构卡片',
        chapters: '章节概览',
        chapter: '正文内容',
        validation: '一致性校验',
        'quality-scores': '评分记录',
        'final-manuscript': '最终稿件',
        raw: '原始数据'
    };
    return labelMap[type] || '审阅材料';
}

function getSummaryCards(artifact) {
    if (!artifact) {
        return [{ label: '状态', value: '待加载' }];
    }

    if (artifact.type === 'characters') {
        const characters = flattenCharacters(artifact.data);
        const protagonists = characters.filter((item) => item.roleType === '主角').length;
        const supporting = characters.filter((item) => item.roleType === '配角').length;
        return [
            { label: '角色总数', value: `${characters.length}` },
            { label: '主角', value: `${protagonists}` },
            { label: '配角', value: `${supporting}` }
        ];
    }

    if (artifact.type === 'outline') {
        const cards = artifact.data.chapterCards || artifact.data.cards || artifact.data.chapters || [];
        return [
            { label: '章节卡片', value: `${cards.length}` },
            { label: '关键转折', value: `${(artifact.data.turningPoints || artifact.data.keyTurningPoints || []).length}` },
            { label: '审阅重点', value: '结构节奏' }
        ];
    }

    if (artifact.type === 'chapters') {
        const chapters = Array.isArray(artifact.data) ? artifact.data : [];
        return [
            { label: '章节数量', value: `${chapters.length}` },
            { label: '审阅重点', value: '摘要衔接' }
        ];
    }

    if (artifact.type === 'chapter') {
        const text = artifact.data.content || artifact.data.text || '';
        return [
            { label: '字数估计', value: `${countCharacters(text)}` },
            { label: '段落数', value: `${countParagraphs(text)}` },
            { label: '状态', value: getReadableChapterStatus(artifact.data.status) }
        ];
    }

    if (artifact.type === 'validation') {
        const issues = normalizeValidationIssues(artifact.data.issues || []);
        const critical = issues.filter((item) => item.severity === 'critical').length;
        return [
            { label: '问题数', value: `${issues.length}` },
            { label: '关键问题', value: `${critical}` }
        ];
    }

    if (artifact.type === 'quality-scores') {
        const rows = normalizeQualityTrendRows(artifact.data);
        return [
            { label: '迭代轮次', value: `${rows.length}` },
            { label: '审阅重点', value: '质量走势' }
        ];
    }

    if (artifact.type === 'final-manuscript') {
        return [
            { label: '字数估计', value: `${countCharacters(artifact.data.content || '')}` },
            { label: '审阅重点', value: '交付可读性' }
        ];
    }

    return [
        { label: '材料类型', value: getArtifactLabel(artifact.type) },
        { label: '审阅重点', value: '完整性' }
    ];
}

function getFeedbackPresets(checkpointType) {
    const presets = {
        phase1: ['设定逻辑还不够闭环', '人物关系需要更清晰', '世界观规则需要补充', '核心冲突还不够明确'],
        'phase2-outline': ['章节推进略显平', '转折需要更集中', '高潮位置不够突出', '伏笔与回收需要强化'],
        'phase2-content': ['语气还不够统一', '情绪递进可以更强', '场景描写需要更具体', '人物对白还可更自然'],
        'phase3-final': ['整体完成度良好', '建议统一术语表达', '个别段落仍可精简', '发布前建议再通读一轮']
    };
    return presets[resolveCheckpointKind(checkpointType)] || ['表达尚可再收束', '信息密度可以再平衡', '建议补充关键细节', '建议明确阶段目标'];
}

function getReviewChecklist(checkpointType) {
    const checklist = {
        phase1: ['设定自洽', '角色成立', '可继续展开'],
        'phase2-outline': ['主线清晰', '结构合理', '冲突升级'],
        'phase2-content': ['语言顺畅', '角色统一', '章节衔接稳定'],
        'phase3-final': ['达到交付', '无明显漏洞', '适合导出']
    };
    return checklist[resolveCheckpointKind(checkpointType)] || ['确认内容完整性', '确认表达清晰度', '确认是否可推进'];
}

function renderInfoCard(label, value) {
    return `
        <div class="info-card">
            <span>${escapeHtml(label)}</span>
            <strong>${escapeHtml(value)}</strong>
        </div>
    `;
}

function normalizeArtifactChapter(chapter, fallbackNumber = 1) {
    const number = chapter?.chapterNum || chapter?.number || chapter?.chapterNumber || fallbackNumber;
    const fallbackTitle = `第${number || fallbackNumber || 1}章`;
    return {
        ...chapter,
        number,
        chapterNum: number,
        title: sanitizeChapterTitle(chapter?.title || chapter?.chapterTitle, fallbackTitle),
        content: chapter?.content || chapter?.text || chapter?.body || '',
        wordCount: chapter?.wordCount || chapter?.metrics?.counts?.actualCount || chapter?.metrics?.counts?.chineseChars || 0,
        status: String(chapter?.status || '').toLowerCase(),
        validation: normalizeChapterValidationPayload(chapter?.validation)
    };
}

function sanitizeChapterTitle(title, fallbackTitle) {
    const raw = String(title || '').trim();
    if (!raw) return fallbackTitle;
    if (/undefined|null/i.test(raw)) return fallbackTitle;
    return raw;
}

function renderOutlineCard(card, index) {
    const scenes = normalizeList(card.scenes || []);
    const characters = normalizeList(card.appearingCharacters || card.characters || []);
    const events = normalizeList(card.coreEvents || card.events || []);

    return `
        <div class="outline-card">
            <div class="outline-index">${String(card.number || index + 1).padStart(2, '0')}</div>
            <div class="outline-body">
                <h3>${escapeHtml(card.title || `第${card.number || index + 1}章`)}</h3>
                <p>${escapeHtml(card.summary || events[0] || '暂无大纲')}</p>
                <div class="chip-cloud">
                    ${Number(card.targetWordCount || card.wordCountTarget || 0) > 0 ? `<span class="meta-chip">${formatWordCount(card.targetWordCount || card.wordCountTarget)}</span>` : ''}
                    ${scenes.map((scene) => `<span class="meta-chip">场景 · ${escapeHtml(scene)}</span>`).join('')}
                    ${characters.map((character) => `<span class="meta-chip">角色 · ${escapeHtml(character)}</span>`).join('')}
                </div>
                ${events.length > 1 ? `
                    <ul class="bullet-list">
                        ${events.map((event) => `<li>${escapeHtml(event)}</li>`).join('')}
                    </ul>
                ` : ''}
            </div>
        </div>
    `;
}

function formatTurningPoint(item) {
    if (typeof item === 'string') return item;
    return [item.chapter ? `第${item.chapter}章` : '', item.title || item.description || '未命名转折']
        .filter(Boolean)
        .join(' · ');
}

function formatForeshadowing(item) {
    if (typeof item === 'string') return item;
    const setup = item.setup || item.description || '未说明';
    const payoff = item.payoff || '待回收';
    return `${setup} → ${payoff}`;
}

function normalizeValidationIssues(issues) {
    return normalizeList(issues)
        .map((issue) => {
            if (typeof issue === 'string') {
                return {
                    severity: 'notice',
                    description: issue
                };
            }

            return {
                severity: issue?.severity || issue?.level || 'notice',
                description: issue?.description || issue?.message || issue?.issue || ''
            };
        })
        .filter((issue) => issue.description);
}

function normalizeChapterValidationPayload(validation) {
    if (!validation || typeof validation !== 'object') {
        return validation || null;
    }

    const checkEntries = validation.checks && typeof validation.checks === 'object'
        ? Object.entries(validation.checks)
        : [];
    const checks = Object.fromEntries(checkEntries.map(([key, item]) => {
        return [key, {
            passed: item?.passed ?? item?.success ?? true,
            hasWarnings: item?.hasWarnings ?? false,
            issues: normalizeValidationIssues(item?.issues || item?.problems || []),
            suggestions: normalizeList(item?.suggestions || item?.recommendations || []),
            rawReport: item?.rawReport || item?.report || ''
        }];
    }));
    const allIssues = normalizeValidationIssues(validation.allIssues || validation.issues || validation.problems || []);
    const allSuggestions = normalizeList(validation.allSuggestions || validation.suggestions || validation.recommendations || []);

    return {
        passed: validation.passed ?? validation.success ?? validation.overall?.passed ?? true,
        overall: {
            passed: validation.overall?.passed ?? validation.passed ?? validation.success ?? true,
            hasCriticalIssues: validation.overall?.hasCriticalIssues ?? false,
            criticalCount: validation.overall?.criticalCount ?? 0
        },
        checks,
        issues: allIssues,
        warnings: normalizeValidationIssues(validation.warnings || validation.alerts || []),
        suggestions: allSuggestions,
        allIssues,
        allSuggestions,
        rawReport: validation.rawReport || ''
    };
}

function getValidationCheckLabel(key) {
    const labels = {
        worldview: '世界观',
        characters: '人物',
        plot: '情节'
    };
    return labels[key] || key;
}

function normalizeValidationScoreRows(rows) {
    return normalizeList(rows).map((row, index) => ({
        title: `第 ${row?.iteration || index + 1} 轮`,
        average: row?.average ?? '—',
        items: Object.entries(row?.scores || {}).map(([label, value]) => ({
            label,
            value
        }))
    }));
}

function normalizeQualityTrendRows(qualityScores) {
    const rows = Array.isArray(qualityScores?.trends)
        ? qualityScores.trends
        : Array.isArray(qualityScores)
            ? qualityScores
            : [];

    return rows.map((row, index) => ({
        title: `第 ${row?.iteration || index + 1} 轮`,
        overall: row?.overall ?? row?.average ?? '—',
        items: Object.entries(row?.dimensions || row?.scores || {}).map(([label, value]) => ({
            label,
            value: typeof value === 'object' && value !== null ? value.value ?? '—' : value
        }))
    }));
}

function getReadableChapterStatus(status) {
    const labels = {
        draft: '草稿',
        completed: '已完成',
        completed_with_warnings: '已完成（有警告）',
        revised: '已修订',
        polished: '已润色',
        review: '待审阅'
    };
    return labels[status] || status || '未标记';
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

function formatParagraphs(text) {
    const safeText = escapeHtml(text || '');
    return safeText
        .split(/\n{2,}/)
        .map((paragraph) => `<p>${paragraph.replace(/\n/g, '<br>')}</p>`)
        .join('');
}

function countCharacters(text) {
    return String(text || '').replace(/\s/g, '').length;
}

function countParagraphs(text) {
    return String(text || '')
        .split(/\n{2,}/)
        .map((item) => item.trim())
        .filter(Boolean)
        .length;
}

function formatWordCount(value) {
    const count = Number(value) || 0;
    return count > 0 ? `${count.toLocaleString()} 字` : '未统计';
}

function setDecisionPendingState(btnApprove, btnReject, action) {
    btnApprove.disabled = true;
    btnReject.disabled = true;
    btnApprove.textContent = action === 'approve' ? '通过中...' : '通过检查点';
    btnReject.textContent = action === 'reject' ? '退回中...' : '退回修改';
}

function resetDecisionState(btnApprove, btnReject) {
    btnApprove.disabled = false;
    btnReject.disabled = false;
    btnApprove.textContent = '通过检查点';
    btnReject.textContent = '退回修改';
}

function ensureReviewPanelStyles() {
    if (document.getElementById('checkpoint-review-panel-styles')) return;

    const style = document.createElement('style');
    style.id = 'checkpoint-review-panel-styles';
    style.textContent = `
        .checkpoint-review-shell {
            --review-paper: #f7f1e3;
            --review-ink: #201a16;
            --review-muted: #6d6257;
            --review-line: rgba(89, 70, 50, 0.16);
            --review-gold: #a17136;
            --review-red: #8f3a2f;
            --review-green: #2b6a4d;
            
            position: absolute;
            top: 0;
            left: 0;
            right: 0;
            bottom: 0;
            display: flex;
            flex-direction: column;
            gap: 18px;
            color: var(--review-ink);
            background:
                radial-gradient(circle at top right, rgba(161, 113, 54, 0.18), transparent 28%),
                linear-gradient(180deg, #f9f5eb 0%, #f2ead9 100%);
            padding: 20px;
            overflow: hidden;
        }

        .review-hero {
            flex: none;
            display: flex;
            justify-content: space-between;
            gap: 24px;
            padding: 22px 24px;
            border: 1px solid var(--review-line);
            border-radius: 24px;
            background: linear-gradient(135deg, rgba(255, 250, 241, 0.94), rgba(246, 238, 220, 0.92));
            box-shadow: 0 20px 45px rgba(70, 47, 19, 0.12);
        }

        .review-eyebrow {
            font-size: 12px;
            letter-spacing: 0.28em;
            text-transform: uppercase;
            color: var(--review-gold);
            margin-bottom: 10px;
        }

        .review-title {
            margin: 0;
            font-size: 34px;
            line-height: 1.12;
            font-weight: 700;
        }

        .review-subtitle {
            margin: 10px 0 0;
            color: var(--review-muted);
            font-size: 15px;
            line-height: 1.8;
            max-width: 720px;
        }

        .review-hero-meta {
            display: flex;
            align-items: flex-start;
            justify-content: flex-end;
            gap: 10px;
            flex-wrap: wrap;
            min-width: 260px;
        }

        .review-badge {
            padding: 8px 14px;
            border-radius: 999px;
            font-size: 12px;
            letter-spacing: 0.04em;
            background: rgba(255, 255, 255, 0.78);
            border: 1px solid var(--review-line);
        }

        .review-badge.phase {
            background: rgba(161, 113, 54, 0.12);
            color: #7f561e;
        }

        .review-badge.type {
            background: rgba(43, 106, 77, 0.12);
            color: var(--review-green);
        }

        .review-layout {
            min-height: 0;
            flex: 1;
            display: grid;
            grid-template-columns: 230px minmax(0, 1fr) 290px;
            gap: 18px;
            align-items: stretch;
        }

        .review-sidebar,
        .review-content,
        .review-actions {
            display: flex;
            flex-direction: column;
            border: 1px solid var(--review-line);
            border-radius: 24px;
            background: rgba(255, 251, 244, 0.92);
            box-shadow: 0 14px 30px rgba(77, 52, 29, 0.08);
            height: 100%;
            min-height: 0;
            overflow: hidden;
        }

        .review-panel-header {
            flex: none;
            display: flex;
            justify-content: space-between;
            align-items: baseline;
            padding: 16px 16px 12px;
            border-bottom: 1px solid var(--review-line);
        }

        .review-panel-title {
            font-size: 16px;
            font-weight: 700;
        }

        .review-panel-meta {
            color: var(--review-muted);
            font-size: 12px;
        }

        .review-artifact-list {
            display: flex;
            flex-direction: column;
            gap: 8px;
            padding: 12px;
            overflow: auto;
        }

        .review-artifact-item {
            display: flex;
            gap: 12px;
            align-items: center;
            padding: 12px;
            border-radius: 16px;
            border: 1px solid transparent;
            background: rgba(255, 255, 255, 0.76);
            color: var(--review-ink);
            cursor: pointer;
            transition: transform 0.18s ease, border-color 0.18s ease, box-shadow 0.18s ease;
        }

        .review-artifact-item:hover {
            transform: translateY(-1px);
            border-color: rgba(161, 113, 54, 0.28);
            box-shadow: 0 10px 18px rgba(84, 58, 31, 0.08);
        }

        .review-artifact-item.active {
            background: linear-gradient(135deg, rgba(161, 113, 54, 0.16), rgba(255, 249, 240, 0.98));
            border-color: rgba(161, 113, 54, 0.38);
        }

        .artifact-index {
            width: 30px;
            height: 30px;
            border-radius: 12px;
            display: inline-flex;
            align-items: center;
            justify-content: center;
            background: rgba(161, 113, 54, 0.12);
            color: #7b5320;
            font-weight: 700;
            flex: none;
        }

        .artifact-text {
            display: flex;
            flex-direction: column;
            align-items: flex-start;
            gap: 4px;
            min-width: 0;
        }

        .artifact-text strong,
        .artifact-text small {
            white-space: nowrap;
            overflow: hidden;
            text-overflow: ellipsis;
            max-width: 138px;
        }

        .artifact-text small {
            color: var(--review-muted);
        }

        .review-content {
            display: flex;
            flex-direction: column;
            overflow: hidden;
        }

        .review-content-header {
            flex: none;
            padding: 18px 20px 16px;
            border-bottom: 1px solid var(--review-line);
            display: flex;
            justify-content: space-between;
            gap: 20px;
            align-items: flex-start;
        }

        .review-content-header h2 {
            margin: 4px 0 0;
            font-size: 28px;
        }

        .review-content-kicker {
            font-size: 12px;
            letter-spacing: 0.22em;
            text-transform: uppercase;
            color: var(--review-gold);
        }

        .review-summary-strip {
            display: flex;
            gap: 10px;
            flex-wrap: wrap;
            justify-content: flex-end;
        }

        .summary-pill {
            min-width: 90px;
            padding: 10px 12px;
            border-radius: 16px;
            background: rgba(255, 255, 255, 0.72);
            border: 1px solid var(--review-line);
            display: flex;
            flex-direction: column;
            gap: 4px;
        }

        .summary-pill span {
            font-size: 12px;
            color: var(--review-muted);
        }

        .summary-pill strong {
            font-size: 16px;
        }

        .review-reader-surface {
            flex: 1;
            display: flex;
            flex-direction: column;
            overflow-y: auto;
            overflow-x: hidden;
            padding: 20px;
        }

        .manuscript-block {
            background:
                linear-gradient(180deg, rgba(255, 253, 247, 0.98), rgba(248, 242, 228, 0.98));
            border: 1px solid rgba(98, 74, 44, 0.14);
            border-radius: 24px;
            padding: 30px;
            box-shadow: inset 0 1px 0 rgba(255,255,255,0.6), 0 18px 40px rgba(65, 42, 15, 0.08);
            width: 100%;
            min-height: 100%;
            flex: 1 0 auto;
        }

        .manuscript-section + .manuscript-section,
        .manuscript-section + .manuscript-grid,
        .manuscript-grid + .manuscript-section {
            margin-top: 24px;
        }

        .section-heading,
        .chapter-kicker {
            font-size: 12px;
            letter-spacing: 0.22em;
            text-transform: uppercase;
            color: var(--review-gold);
            margin-bottom: 12px;
        }

        .manuscript-paragraph,
        .chapter-text {
            font-size: 17px;
            line-height: 2;
            color: #2a221b;
        }

        .manuscript-paragraph p,
        .chapter-text p {
            margin: 0 0 1.1em;
        }

        .manuscript-grid {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
            gap: 14px;
        }

        .info-card,
        .chapter-summary-card,
        .character-card,
        .outline-card {
            border: 1px solid rgba(112, 86, 52, 0.14);
            background: rgba(255, 255, 255, 0.76);
            border-radius: 18px;
            padding: 18px;
        }

        .info-card span,
        .decision-label {
            font-size: 12px;
            color: var(--review-muted);
            letter-spacing: 0.08em;
            text-transform: uppercase;
        }

        .info-card strong {
            display: block;
            margin-top: 10px;
            font-size: 15px;
            line-height: 1.7;
        }

        .character-board,
        .chapter-summary-list {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(230px, 1fr));
            gap: 16px;
        }

        .character-card-top,
        .chapter-summary-head {
            display: flex;
            justify-content: space-between;
            gap: 12px;
            align-items: flex-start;
            margin-bottom: 12px;
        }

        .character-card h3,
        .chapter-summary-card h3,
        .outline-card h3 {
            margin: 0;
            font-size: 20px;
        }

        .character-role,
        .chapter-tag,
        .mini-badge {
            display: inline-flex;
            align-items: center;
            justify-content: center;
            padding: 6px 10px;
            border-radius: 999px;
            background: rgba(161, 113, 54, 0.12);
            color: #815620;
            font-size: 12px;
        }

        .character-card p,
        .chapter-summary-card p,
        .outline-card p {
            margin: 0;
            line-height: 1.85;
            color: #40342a;
        }

        .chip-cloud {
            display: flex;
            flex-wrap: wrap;
            gap: 8px;
            margin-top: 12px;
        }

        .meta-chip {
            display: inline-flex;
            align-items: center;
            padding: 5px 10px;
            border-radius: 999px;
            background: rgba(89, 70, 50, 0.08);
            color: #6a5238;
            font-size: 12px;
        }

        .bullet-list {
            margin: 10px 0 0;
            padding-left: 18px;
            line-height: 1.85;
            color: #40342a;
        }

        .bullet-list li {
            margin-bottom: 8px;
        }

        .outline-timeline {
            display: flex;
            flex-direction: column;
            gap: 16px;
        }

        .outline-card {
            display: grid;
            grid-template-columns: 56px minmax(0, 1fr);
            gap: 16px;
            align-items: flex-start;
        }

        .outline-index {
            width: 56px;
            height: 56px;
            border-radius: 18px;
            background: linear-gradient(135deg, rgba(161, 113, 54, 0.16), rgba(161, 113, 54, 0.06));
            display: inline-flex;
            align-items: center;
            justify-content: center;
            font-size: 18px;
            font-weight: 700;
            color: #7b5320;
        }

        .raw-payload-block {
            margin: 0;
            white-space: pre-wrap;
            font-size: 13px;
            line-height: 1.7;
            color: #362b22;
        }

        .review-actions {
            padding-bottom: 14px;
        }

        .validation-overview {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
            gap: 14px;
        }

        .validation-list {
            display: flex;
            flex-direction: column;
            gap: 12px;
        }

        .validation-item {
            border-radius: 16px;
            padding: 16px;
            background: rgba(255, 255, 255, 0.78);
            border: 1px solid rgba(112, 86, 52, 0.14);
        }

        .validation-item-head {
            margin-bottom: 8px;
        }

        .validation-item.severity-critical {
            border-color: rgba(143, 58, 47, 0.26);
            background: rgba(143, 58, 47, 0.06);
        }

        .validation-item.severity-warning,
        .validation-item.severity-major {
            border-color: rgba(161, 113, 54, 0.28);
            background: rgba(161, 113, 54, 0.08);
        }

        .validation-item.severity-notice {
            border-color: rgba(89, 70, 50, 0.16);
            background: rgba(255, 255, 255, 0.68);
        }

        .validation-item p {
            margin: 0;
            line-height: 1.8;
            color: #43372d;
        }

        .quality-trend-grid {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
            gap: 14px;
        }

        .quality-score-card {
            border-radius: 18px;
            padding: 16px;
            border: 1px solid rgba(112, 86, 52, 0.14);
            background: rgba(255, 255, 255, 0.78);
        }

        .quality-score-head {
            display: flex;
            justify-content: space-between;
            gap: 12px;
            align-items: baseline;
        }

        .decision-card {
            margin: 12px 12px 0;
            padding: 14px;
            border-radius: 18px;
            border: 1px solid rgba(112, 86, 52, 0.14);
            background: rgba(255, 255, 255, 0.74);
        }

        .decision-card.compact p {
            margin-top: 8px;
            font-size: 13px;
            line-height: 1.7;
        }

        .decision-card.highlight {
            background: linear-gradient(135deg, rgba(161, 113, 54, 0.14), rgba(255, 255, 255, 0.78));
        }

        .decision-card p {
            margin: 10px 0 0;
            line-height: 1.8;
            color: #4b3d31;
        }

        .decision-value {
            margin-top: 6px;
            font-size: 19px;
            font-weight: 700;
        }

        .review-checklist {
            margin: 8px 0 0;
            padding-left: 18px;
            line-height: 1.75;
            color: #43372d;
            font-size: 14px;
        }

        .feedback-chip-group {
            display: flex;
            flex-wrap: wrap;
            gap: 6px;
            margin-top: 10px;
        }

        .feedback-chip {
            padding: 8px 12px;
            border-radius: 999px;
            border: 1px solid rgba(161, 113, 54, 0.18);
            background: rgba(255, 250, 242, 0.96);
            color: #775024;
            cursor: pointer;
            transition: transform 0.18s ease, background 0.18s ease;
        }

        .feedback-chip:hover {
            transform: translateY(-1px);
            background: rgba(161, 113, 54, 0.12);
        }

        .review-actions-inner {
            display: flex;
            flex-direction: column;
            flex: 1;
            min-height: 0;
            overflow-y: auto;
            padding-bottom: 12px;
        }

        .review-textarea {
            margin-top: 10px;
            flex: 1;
            min-height: 132px;
            resize: vertical;
            border-radius: 16px;
            border: 1px solid rgba(112, 86, 52, 0.2);
            background: rgba(255, 255, 255, 0.94);
            padding: 14px 16px;
            line-height: 1.8;
            color: #2c241e;
            overflow-y: auto;
        }

        .review-textarea:focus {
            outline: none;
            border-color: rgba(161, 113, 54, 0.45);
            box-shadow: 0 0 0 4px rgba(161, 113, 54, 0.12);
        }

        .decision-tip {
            margin-top: 8px;
            color: var(--review-muted);
            font-size: 12px;
            line-height: 1.7;
        }

        .review-action-bar {
            flex: none;
            display: grid;
            grid-template-columns: 1fr;
            gap: 8px;
            padding: 12px 12px 0;
            background: linear-gradient(180deg, rgba(247, 241, 227, 0), rgba(247, 241, 227, 0.96) 32%, rgba(247, 241, 227, 0.98) 100%);
        }

        .review-btn {
            min-height: 48px;
            border-radius: 16px;
            border: none;
            font-size: 15px;
            font-weight: 700;
            cursor: pointer;
            transition: transform 0.18s ease, opacity 0.18s ease, box-shadow 0.18s ease;
        }

        .review-btn:hover:not(:disabled) {
            transform: translateY(-1px);
        }

        .review-btn:disabled {
            cursor: wait;
            opacity: 0.72;
        }

        .review-btn.approve {
            background: linear-gradient(135deg, #2b6a4d, #388a63);
            color: #fff;
            box-shadow: 0 12px 20px rgba(43, 106, 77, 0.2);
        }

        .review-btn.reject {
            background: linear-gradient(135deg, #8f3a2f, #b24b3d);
            color: #fff;
            box-shadow: 0 12px 20px rgba(143, 58, 47, 0.2);
        }

        .empty-review-state {
            padding: 40px 24px;
            border-radius: 18px;
            background: rgba(255, 255, 255, 0.72);
            text-align: center;
            color: var(--review-muted);
        }

        @media (max-width: 1280px) {
            .review-layout {
                grid-template-columns: 220px minmax(0, 1fr);
            }

            .review-actions {
                grid-column: 1 / -1;
            }
        }

        @media (max-width: 900px) {
            .checkpoint-review-shell {
                padding: 14px;
                min-height: auto;
            }

            .review-hero,
            .review-content-header {
                flex-direction: column;
            }

            .review-layout {
                grid-template-columns: 1fr;
            }

            .review-action-bar {
                grid-template-columns: 1fr;
            }
        }
    `;
    document.head.appendChild(style);
}
