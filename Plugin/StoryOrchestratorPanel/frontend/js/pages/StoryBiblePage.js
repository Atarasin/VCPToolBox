export async function renderStoryBiblePage(container, store, api, storyId) {
    container.innerHTML = `
        <div class="story-bible-page">
            <div class="loading">正在加载故事设定集...</div>
        </div>
    `;

    try {
        const [worldviewResponse, charactersResponse, historyResponse] = await Promise.all([
            api.getStoryWorldview(storyId),
            api.getStoryCharacters(storyId),
            api.getStoryHistory(storyId)
        ]);

        if (!worldviewResponse.success) {
            throw new Error(worldviewResponse.error || '加载世界观失败');
        }

        if (!charactersResponse.success) {
            throw new Error(charactersResponse.error || '加载角色数据失败');
        }

        if (!historyResponse.success) {
            throw new Error(historyResponse.error || '加载工作流历史失败');
        }

        const checkpointEntry = (historyResponse.history || []).findLast?.((entry) => {
            return entry.type === 'checkpoint_created' && entry.phase === 'phase1';
        }) || [...(historyResponse.history || [])].reverse().find((entry) => {
            return entry.type === 'checkpoint_created' && entry.phase === 'phase1';
        });

        const phase1Payload = checkpointEntry?.detail?.data || {};
        const phase1 = {
            worldview: phase1Payload.worldview || worldviewResponse.worldview || {},
            characters: phase1Payload.characters || buildCharacterStructureFromFlatList(charactersResponse.characters || []),
            validation: phase1Payload.validation || null,
            userConfirmed: worldviewResponse.userConfirmed || false,
            checkpointId: historyResponse.activeCheckpoint?.id || null,
            status: worldviewResponse.phase1Status || 'pending'
        };

        const worldview = phase1.worldview || {};
        const characters = phase1.characters || {};
        const tabs = [
            { key: 'protagonists', label: '主角', items: characters.protagonists || [] },
            { key: 'supportingCharacters', label: '配角', items: characters.supportingCharacters || [] },
            { key: 'antagonists', label: '反派', items: characters.antagonists || [] }
        ];
        const activeTab = tabs.find((tab) => tab.items.length > 0)?.key || 'protagonists';

        container.innerHTML = `
            <style>
                .story-bible-page { padding: 20px; color: var(--text-color); display: flex; flex-direction: column; gap: 20px; }
                .bible-hero { display: flex; justify-content: space-between; gap: 20px; padding: 24px; border-radius: 18px; background: linear-gradient(135deg, rgba(88, 166, 255, 0.12), rgba(161, 113, 54, 0.12)); border: 1px solid var(--border-color); }
                .bible-hero h2 { margin: 0; color: var(--accent-color); font-size: 1.9rem; }
                .bible-hero p { margin: 10px 0 0; color: #8b949e; line-height: 1.8; max-width: 780px; }
                .hero-meta { display: flex; gap: 10px; flex-wrap: wrap; align-items: flex-start; justify-content: flex-end; min-width: 240px; }
                .hero-badge { padding: 8px 14px; border-radius: 999px; background: rgba(255,255,255,0.08); border: 1px solid var(--border-color); font-size: 0.85rem; }
                .bible-grid { display: grid; grid-template-columns: minmax(0, 1fr); gap: 20px; }
                .bible-section { background: var(--sidebar-bg); border: 1px solid var(--border-color); border-radius: 16px; padding: 22px; }
                .bible-section h3 { margin: 0 0 16px; color: var(--accent-color); font-size: 1.2rem; }
                .bible-section h4 { margin: 0 0 12px; font-size: 1rem; color: var(--text-color); }
                .setting-block { line-height: 1.95; color: var(--text-color); }
                .info-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 14px; }
                .info-card, .sub-card { background: var(--bg-color); border: 1px solid var(--border-color); border-radius: 14px; padding: 16px; }
                .info-card span, .sub-card-label { display: block; font-size: 0.78rem; letter-spacing: 0.08em; text-transform: uppercase; color: #8b949e; margin-bottom: 10px; }
                .info-card strong { font-size: 0.95rem; line-height: 1.8; }
                .sub-card p, .sub-card li { line-height: 1.8; color: var(--text-color); }
                .rules-grid, .validation-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); gap: 14px; }
                .list-block { margin: 0; padding-left: 18px; }
                .list-block li { margin-bottom: 10px; line-height: 1.8; }
                .cards-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: 14px; }
                .relation-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: 14px; }
                .tabs { display: flex; gap: 10px; flex-wrap: wrap; margin-bottom: 16px; }
                .tab-btn { background: rgba(139, 148, 158, 0.12); border: 1px solid var(--border-color); color: var(--text-color); cursor: pointer; padding: 8px 14px; border-radius: 999px; transition: all 0.2s; }
                .tab-btn.active { background: rgba(88, 166, 255, 0.16); color: var(--accent-color); border-color: rgba(88, 166, 255, 0.36); }
                .tab-pane { display: none; }
                .tab-pane.active { display: grid; }
                .character-card { background: var(--bg-color); border: 1px solid var(--border-color); border-radius: 14px; padding: 18px; }
                .character-card h4 { margin-bottom: 6px; font-size: 1.1rem; }
                .card-meta { display: flex; gap: 8px; flex-wrap: wrap; margin-bottom: 12px; }
                .badge { background: rgba(139, 148, 158, 0.16); padding: 4px 10px; border-radius: 999px; font-size: 0.8rem; }
                .char-detail { margin: 10px 0 0; line-height: 1.8; color: #c9d1d9; }
                .char-detail strong { color: var(--text-color); }
                .empty-state { color: #8b949e; font-style: italic; }
                .validation-item { border-radius: 14px; padding: 16px; border: 1px solid var(--border-color); background: var(--bg-color); }
                .validation-item.critical { border-color: rgba(248, 81, 73, 0.4); }
                .validation-item.major { border-color: rgba(210, 153, 34, 0.45); }
                .report-block { background: rgba(0,0,0,0.16); border: 1px solid var(--border-color); border-radius: 14px; padding: 16px; line-height: 1.9; white-space: pre-wrap; }
                @media (max-width: 900px) {
                    .bible-hero { flex-direction: column; }
                    .hero-meta { justify-content: flex-start; }
                }
            </style>
            <div class="story-bible-page">
                <section class="bible-hero">
                    <div>
                        <h2>故事设定集</h2>
                        <p>完整查看阶段1生成的世界观、人物设定、关系网络与行为边界，作为正式设定资料存档。</p>
                    </div>
                    <div class="hero-meta">
                        <span class="hero-badge">阶段状态：${escapeHtml(phase1.status || 'pending')}</span>
                        <span class="hero-badge">检查点：${escapeHtml(phase1.checkpointId || '无')}</span>
                        <span class="hero-badge">用户确认：${phase1.userConfirmed ? '是' : '否'}</span>
                    </div>
                </section>

                <div class="bible-grid">
                    <section class="bible-section">
                        <h3>世界观总览</h3>
                        <div class="setting-block">${formatRichText(worldview.setting || '暂无世界观描述')}</div>
                    </section>

                    <section class="bible-section">
                        <h3>规则与代价</h3>
                        <div class="rules-grid">
                            ${renderInfoPanel('物理规则', worldview.rules?.physical)}
                            ${renderInfoPanel('特殊设定', worldview.rules?.special)}
                            ${renderInfoPanel('限制与代价', worldview.rules?.limitations)}
                        </div>
                    </section>

                    <section class="bible-section">
                        <h3>势力设定</h3>
                        <div class="cards-grid">
                            ${(worldview.factions || []).length > 0 ? worldview.factions.map((faction) => `
                                <div class="sub-card">
                                    <span class="sub-card-label">${escapeHtml(faction.name || '未命名势力')}</span>
                                    <p>${escapeHtml(faction.description || '暂无描述')}</p>
                                    ${(faction.relationships || []).length > 0 ? `
                                        <h4>关系</h4>
                                        <ul class="list-block">
                                            ${faction.relationships.map((item) => `<li>${escapeHtml(item)}</li>`).join('')}
                                        </ul>
                                    ` : ''}
                                </div>
                            `).join('') : '<p class="empty-state">暂无势力设定。</p>'}
                        </div>
                    </section>

                    <section class="bible-section">
                        <h3>历史与核心矛盾</h3>
                        <div class="info-grid">
                            <div class="sub-card">
                                <span class="sub-card-label">关键历史事件</span>
                                ${(worldview.history?.keyEvents || []).length > 0 ? `
                                    <ul class="list-block">
                                        ${worldview.history.keyEvents.map((item) => `<li>${escapeHtml(item)}</li>`).join('')}
                                    </ul>
                                ` : '<p class="empty-state">暂无关键事件。</p>'}
                            </div>
                            <div class="sub-card">
                                <span class="sub-card-label">核心矛盾</span>
                                ${(worldview.history?.coreConflicts || []).length > 0 ? `
                                    <ul class="list-block">
                                        ${worldview.history.coreConflicts.map((item) => `<li>${escapeHtml(item)}</li>`).join('')}
                                    </ul>
                                ` : '<p class="empty-state">暂无核心矛盾。</p>'}
                            </div>
                        </div>
                    </section>

                    <section class="bible-section">
                        <h3>场景规范与伏笔</h3>
                        <div class="info-grid">
                            <div class="sub-card">
                                <span class="sub-card-label">场景规范</span>
                                ${(worldview.sceneNorms || []).length > 0 ? `
                                    <ul class="list-block">
                                        ${worldview.sceneNorms.map((item) => `<li>${escapeHtml(item)}</li>`).join('')}
                                    </ul>
                                ` : '<p class="empty-state">暂无场景规范。</p>'}
                            </div>
                            <div class="sub-card">
                                <span class="sub-card-label">隐藏秘密 / 伏笔</span>
                                ${(worldview.secrets || []).length > 0 ? `
                                    <ul class="list-block">
                                        ${worldview.secrets.map((item) => `<li>${escapeHtml(item)}</li>`).join('')}
                                    </ul>
                                ` : '<p class="empty-state">暂无伏笔信息。</p>'}
                            </div>
                        </div>
                    </section>

                    <section class="bible-section">
                        <h3>人物档案</h3>
                        <div class="tabs">
                            ${tabs.map((tab) => `
                                <button class="tab-btn ${tab.key === activeTab ? 'active' : ''}" data-target="${tab.key}">
                                    ${tab.label} (${tab.items.length})
                                </button>
                            `).join('')}
                        </div>
                        ${tabs.map((tab) => `
                            <div class="tab-pane cards-grid ${tab.key === activeTab ? 'active' : ''}" id="tab-${tab.key}">
                                ${tab.items.length > 0 ? tab.items.map((character) => renderCharacterCard(character, tab.key)).join('') : '<p class="empty-state">暂无该分类人物。</p>'}
                            </div>
                        `).join('')}
                    </section>

                    <section class="bible-section">
                        <h3>关系网络与行为边界</h3>
                        <div class="relation-grid">
                            <div class="sub-card">
                                <span class="sub-card-label">显性关系</span>
                                ${(characters.relationshipNetwork?.direct || []).length > 0 ? `
                                    <ul class="list-block">
                                        ${characters.relationshipNetwork.direct.map((item) => `<li>${escapeHtml(item.from)} → ${escapeHtml(item.to)}：${escapeHtml(item.type)}</li>`).join('')}
                                    </ul>
                                ` : '<p class="empty-state">暂无显性关系。</p>'}
                            </div>
                            <div class="sub-card">
                                <span class="sub-card-label">隐藏关系</span>
                                ${(characters.relationshipNetwork?.hidden || []).length > 0 ? `
                                    <ul class="list-block">
                                        ${characters.relationshipNetwork.hidden.map((item) => `<li>${escapeHtml(item.from)} → ${escapeHtml(item.to)}：${escapeHtml(item.secret)}</li>`).join('')}
                                    </ul>
                                ` : '<p class="empty-state">暂无隐藏关系。</p>'}
                            </div>
                        </div>
                        <div class="cards-grid" style="margin-top: 14px;">
                            ${Object.keys(characters.oocRules || {}).length > 0 ? Object.entries(characters.oocRules).map(([name, rules]) => `
                                <div class="sub-card">
                                    <span class="sub-card-label">${escapeHtml(name)} 的行为边界</span>
                                    <ul class="list-block">
                                        ${normalizeArray(rules).map((rule) => `<li>${escapeHtml(rule)}</li>`).join('')}
                                    </ul>
                                </div>
                            `).join('') : '<p class="empty-state">暂无 OOC 规则。</p>'}
                        </div>
                    </section>
                </div>
            </div>
        `;

        container.querySelectorAll('.tab-btn').forEach((button) => {
            button.addEventListener('click', () => {
                const target = button.getAttribute('data-target');
                container.querySelectorAll('.tab-btn').forEach((item) => item.classList.remove('active'));
                container.querySelectorAll('.tab-pane').forEach((pane) => pane.classList.remove('active'));
                button.classList.add('active');
                const targetPane = container.querySelector(`#tab-${target}`);
                if (targetPane) {
                    targetPane.classList.add('active');
                }
            });
        });
    } catch (error) {
        container.innerHTML = `
            <div class="story-bible-page">
                <div class="error-state">
                    <h2>加载故事设定集失败</h2>
                    <p>${escapeHtml(error.message)}</p>
                    <a href="#/stories/${storyId}" class="btn">返回故事详情</a>
                </div>
            </div>
            <style>
                .error-state { padding: 40px; text-align: center; background: var(--sidebar-bg); border-radius: 8px; border: 1px solid var(--border-color); }
                .error-state h2 { color: #f85149; }
                .error-state p { color: #8b949e; margin-bottom: 20px; }
                .btn { display: inline-block; padding: 8px 16px; background: rgba(139, 148, 158, 0.2); color: var(--text-color); text-decoration: none; border-radius: 4px; }
            </style>
        `;
    }
}

function renderCharacterCard(character, category) {
    const detailRows = [];
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

    fields.forEach(([label, value]) => {
        if (value) {
            detailRows.push(`<p class="char-detail"><strong>${escapeHtml(label)}：</strong>${escapeHtml(value)}</p>`);
        }
    });

    if (Array.isArray(character.personality) && character.personality.length > 0) {
        detailRows.push(`<p class="char-detail"><strong>性格关键词：</strong>${character.personality.map((item) => escapeHtml(item)).join('、')}</p>`);
    }

    return `
        <div class="character-card">
            <h4>${escapeHtml(character.name || '未命名角色')}</h4>
            <div class="card-meta">
                <span class="badge">${escapeHtml(getCategoryLabel(category))}</span>
                ${character.role ? `<span class="badge">${escapeHtml(character.role)}</span>` : ''}
            </div>
            ${detailRows.length > 0 ? detailRows.join('') : '<p class="empty-state">暂无详细人物信息。</p>'}
        </div>
    `;
}

function renderInfoPanel(title, value) {
    return `
        <div class="info-card">
            <span>${escapeHtml(title)}</span>
            <strong>${escapeHtml(value || '暂无内容')}</strong>
        </div>
    `;
}

function formatRichText(text) {
    return escapeHtml(text || '')
        .split(/\n{2,}/)
        .map((paragraph) => `<p>${paragraph.replace(/\n/g, '<br>')}</p>`)
        .join('');
}

function getCategoryLabel(category) {
    const labelMap = {
        protagonists: '主角',
        supportingCharacters: '配角',
        antagonists: '反派'
    };
    return labelMap[category] || '角色';
}

function buildCharacterStructureFromFlatList(characters) {
    const flatList = Array.isArray(characters) ? characters : [];
    return {
        protagonists: flatList.filter((item) => item.roleCategory === 'protagonist'),
        supportingCharacters: flatList.filter((item) => item.roleCategory === 'supporting' || item.roleCategory === 'supportingCharacters'),
        antagonists: flatList.filter((item) => item.roleCategory === 'antagonist'),
        relationshipNetwork: {
            direct: [],
            hidden: []
        },
        oocRules: {}
    };
}

function normalizeArray(value) {
    if (value == null) return [];
    return Array.isArray(value) ? value : [value];
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
