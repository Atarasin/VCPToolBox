export async function renderStoryBiblePage(container, store, api, storyId) {
    container.innerHTML = `
        <div class="story-bible-page">
            <div class="loading">Loading story bible...</div>
        </div>
    `;

    try {
        const [worldviewResponse, charactersResponse] = await Promise.all([
            api.getStoryWorldview(storyId),
            api.getStoryCharacters(storyId)
        ]);

        if (!worldviewResponse.success) {
            throw new Error(worldviewResponse.error || 'Failed to load worldview');
        }

        if (!charactersResponse.success) {
            throw new Error(charactersResponse.error || 'Failed to load characters');
        }

        const worldview = worldviewResponse.worldview || {};
        const characters = charactersResponse.characters || [];

        const factionsHtml = (worldview.factions || []).length > 0 ? `
            <div class="bible-section factions-section">
                <h3>Factions</h3>
                <div class="cards-grid">
                    ${worldview.factions.map(faction => `
                        <div class="card faction-card">
                            <h4>${escapeHtml(faction.name || 'Unnamed')}</h4>
                            <div class="card-meta">
                                <span class="badge ${getAlignmentClass(faction.alignment)}">${escapeHtml(faction.alignment || 'Unknown')}</span>
                            </div>
                            <p>${escapeHtml(faction.description || 'No description provided.')}</p>
                        </div>
                    `).join('')}
                </div>
            </div>
        ` : '';

        const timelineHtml = (worldview.historyTimeline || []).length > 0 ? `
            <div class="bible-section timeline-section">
                <h3>History Timeline</h3>
                <ul class="timeline-list">
                    ${worldview.historyTimeline.map(item => `
                        <li class="timeline-item">
                            <span class="timeline-era">${escapeHtml(item.era || 'Unknown Era')}</span>
                            <span class="timeline-event">${escapeHtml(item.event || 'Unknown Event')}</span>
                        </li>
                    `).join('')}
                </ul>
            </div>
        ` : '';

        const charactersByRole = {
            protagonist: characters.filter(c => c.role === 'protagonist'),
            supporting: characters.filter(c => c.role === 'supporting'),
            antagonist: characters.filter(c => c.role === 'antagonist'),
            other: characters.filter(c => !['protagonist', 'supporting', 'antagonist'].includes(c.role))
        };

        const generateCharacterCards = (charList) => charList.map(char => `
            <div class="card character-card">
                <h4>${escapeHtml(char.name || 'Unnamed')}</h4>
                <div class="card-meta">
                    <span class="badge">${escapeHtml(char.role || 'Unknown')}</span>
                    ${char.age ? `<span class="badge">Age: ${escapeHtml(String(char.age))}</span>` : ''}
                </div>
                <p class="char-desc">${escapeHtml(char.description || 'No description provided.')}</p>
                ${char.personality ? `<p class="char-detail"><strong>Personality:</strong> ${escapeHtml(char.personality)}</p>` : ''}
                ${char.background ? `<p class="char-detail"><strong>Background:</strong> ${escapeHtml(char.background)}</p>` : ''}
                ${char.motivation ? `<p class="char-detail"><strong>Motivation:</strong> ${escapeHtml(char.motivation)}</p>` : ''}
            </div>
        `).join('');

        const charactersHtml = `
            <div class="bible-section characters-section">
                <h3>Characters</h3>
                <div class="tabs">
                    <button class="tab-btn active" data-target="tab-protagonist">Protagonists (${charactersByRole.protagonist.length})</button>
                    <button class="tab-btn" data-target="tab-supporting">Supporting (${charactersByRole.supporting.length})</button>
                    <button class="tab-btn" data-target="tab-antagonist">Antagonists (${charactersByRole.antagonist.length})</button>
                    ${charactersByRole.other.length > 0 ? `<button class="tab-btn" data-target="tab-other">Other (${charactersByRole.other.length})</button>` : ''}
                </div>
                <div class="tab-content">
                    <div id="tab-protagonist" class="tab-pane active cards-grid">
                        ${charactersByRole.protagonist.length > 0 ? generateCharacterCards(charactersByRole.protagonist) : '<p class="empty-state">No protagonists found.</p>'}
                    </div>
                    <div id="tab-supporting" class="tab-pane cards-grid" style="display:none;">
                        ${charactersByRole.supporting.length > 0 ? generateCharacterCards(charactersByRole.supporting) : '<p class="empty-state">No supporting characters found.</p>'}
                    </div>
                    <div id="tab-antagonist" class="tab-pane cards-grid" style="display:none;">
                        ${charactersByRole.antagonist.length > 0 ? generateCharacterCards(charactersByRole.antagonist) : '<p class="empty-state">No antagonists found.</p>'}
                    </div>
                    ${charactersByRole.other.length > 0 ? `
                        <div id="tab-other" class="tab-pane cards-grid" style="display:none;">
                            ${generateCharacterCards(charactersByRole.other)}
                        </div>
                    ` : ''}
                </div>
            </div>
        `;

        container.innerHTML = `
            <style>
                .story-bible-page { padding: 20px; color: var(--text-color); }
                .story-bible-page h2 { color: var(--accent-color); margin-bottom: 20px; border-bottom: 1px solid var(--border-color); padding-bottom: 10px;}
                .bible-section { margin-bottom: 30px; background: var(--sidebar-bg); padding: 20px; border-radius: 8px; border: 1px solid var(--border-color); }
                .bible-section h3 { margin-top: 0; color: var(--accent-color); margin-bottom: 15px; }
                .cards-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(300px, 1fr)); gap: 15px; }
                .card { background: var(--bg-color); border: 1px solid var(--border-color); border-radius: 6px; padding: 15px; }
                .card h4 { margin: 0 0 10px 0; font-size: 1.1rem; }
                .card-meta { margin-bottom: 10px; display: flex; gap: 5px; flex-wrap: wrap; }
                .badge { background: rgba(139, 148, 158, 0.2); padding: 3px 8px; border-radius: 12px; font-size: 0.8rem; }
                .badge.good { background: rgba(46, 160, 67, 0.2); color: #3fb950; }
                .badge.evil { background: rgba(248, 81, 73, 0.2); color: #ff7b72; }
                .badge.neutral { background: rgba(139, 148, 158, 0.2); color: #8b949e; }
                .rules-list { padding-left: 20px; margin: 0; }
                .rules-list li { margin-bottom: 8px; }
                .timeline-list { list-style: none; padding: 0; margin: 0; border-left: 2px solid var(--border-color); margin-left: 10px; }
                .timeline-item { position: relative; padding-left: 20px; margin-bottom: 15px; }
                .timeline-item::before { content: ''; position: absolute; left: -6px; top: 5px; width: 10px; height: 10px; border-radius: 50%; background: var(--accent-color); }
                .timeline-era { font-weight: bold; display: block; color: var(--accent-color); margin-bottom: 4px; }
                .tabs { display: flex; gap: 10px; margin-bottom: 15px; border-bottom: 1px solid var(--border-color); padding-bottom: 10px; }
                .tab-btn { background: none; border: none; color: var(--text-color); cursor: pointer; padding: 8px 16px; border-radius: 4px; opacity: 0.7; transition: all 0.2s; }
                .tab-btn:hover { opacity: 1; background: rgba(139, 148, 158, 0.1); }
                .tab-btn.active { opacity: 1; background: rgba(88, 166, 255, 0.1); color: var(--accent-color); font-weight: bold; }
                .char-detail { font-size: 0.9rem; margin-top: 8px; color: #8b949e; }
                .char-detail strong { color: var(--text-color); }
                .empty-state { color: #8b949e; font-style: italic; }
            </style>
            <div class="story-bible-page">
                <div class="page-header">
                    <h2>Story Bible</h2>
                </div>

                <div class="bible-section setting-section">
                    <h3>World Setting</h3>
                    <p>${escapeHtml(worldview.setting || 'No setting details provided.')}</p>
                </div>

                <div class="bible-section rules-section">
                    <h3>World Rules</h3>
                    ${(worldview.rules || []).length > 0 ? `
                        <ul class="rules-list">
                            ${worldview.rules.map(rule => `<li>${escapeHtml(rule)}</li>`).join('')}
                        </ul>
                    ` : '<p class="empty-state">No specific world rules defined.</p>'}
                </div>

                ${worldview.oocRules ? `
                    <div class="bible-section ooc-rules-section">
                        <h3>Out-Of-Character (OOC) Rules</h3>
                        <p>${escapeHtml(worldview.oocRules)}</p>
                    </div>
                ` : ''}

                ${factionsHtml}
                
                ${timelineHtml}

                ${charactersHtml}
            </div>
        `;

        const tabBtns = container.querySelectorAll('.tab-btn');
        tabBtns.forEach(btn => {
            btn.addEventListener('click', () => {
                tabBtns.forEach(b => b.classList.remove('active'));
                container.querySelectorAll('.tab-pane').forEach(p => p.style.display = 'none');
                
                btn.classList.add('active');
                const targetId = btn.getAttribute('data-target');
                const targetPane = container.querySelector(`#${targetId}`);
                if (targetPane) {
                    targetPane.style.display = 'grid';
                }
            });
        });

    } catch (error) {
        container.innerHTML = `
            <div class="story-bible-page">
                <div class="error-state">
                    <h2>Error Loading Story Bible</h2>
                    <p>${escapeHtml(error.message)}</p>
                    <a href="#/stories/${storyId}" class="btn">Back to Story</a>
                </div>
            </div>
            <style>
                .error-state { padding: 40px; text-align: center; background: var(--sidebar-bg); border-radius: 8px; border: 1px solid var(--border-color); }
                .error-state h2 { color: #f85149; }
                .error-state p { color: #8b949e; margin-bottom: 20px; }
                .btn { display: inline-block; padding: 8px 16px; background: rgba(139, 148, 158, 0.2); color: var(--text-color); text-decoration: none; border-radius: 4px; }
                .btn:hover { background: rgba(139, 148, 158, 0.3); }
            </style>
        `;
    }
}

function escapeHtml(unsafe) {
    if (!unsafe && unsafe !== 0) return '';
    return String(unsafe)
         .replace(/&/g, "&amp;")
         .replace(/</g, "&lt;")
         .replace(/>/g, "&gt;")
         .replace(/"/g, "&quot;")
         .replace(/'/g, "&#039;");
}

function getAlignmentClass(alignment) {
    if (!alignment) return 'neutral';
    const lower = alignment.toLowerCase();
    if (lower.includes('good') || lower.includes('light')) return 'good';
    if (lower.includes('evil') || lower.includes('dark')) return 'evil';
    return 'neutral';
}
