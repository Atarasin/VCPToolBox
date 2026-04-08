export async function renderOutlinePage(container, store, api, storyId) {
    container.innerHTML = '<div class="loading">Loading outline...</div>';

    try {
        const response = await api.getStoryOutline(storyId);
        if (!response.success) throw new Error(response.error || 'Failed to load outline');

        const outline = response.outline || {};
        const chapters = outline.chapters || [];

        container.innerHTML = `
            <div class="outline-page">
                <div class="page-header">
                    <h2>Story Outline</h2>
                    <div class="outline-stats">
                        <span>${chapters.length} Chapters</span>
                        <span>Target: ${outline.totalWordCount || 0} words</span>
                    </div>
                </div>
                <div class="chapter-rail">
                    ${chapters.map((ch, i) => `
                        <div class="chapter-card" data-chapter="${i + 1}">
                            <div class="chapter-number">${i + 1}</div>
                            <div class="chapter-content">
                                <h4>${ch.title || 'Untitled Chapter'}</h4>
                                <p class="chapter-event">${ch.coreEvent || ch.summary || 'No summary'}</p>
                                <div class="chapter-meta">
                                    ${ch.targetWordCount ? `<span>~${ch.targetWordCount} words</span>` : ''}
                                    ${ch.turningPoint ? '<span class="turning-point">Turning Point</span>' : ''}
                                </div>
                                ${ch.scenes ? `<p class="chapter-scenes">${ch.scenes.length} scenes</p>` : ''}
                            </div>
                        </div>
                    `).join('')}
                </div>
                ${chapters.length === 0 ? '<p class="empty-state">No outline available yet.</p>' : ''}
            </div>
        `;
    } catch (error) {
        container.innerHTML = `<div class="error-state"><p>Error: ${error.message}</p></div>`;
    }
}
