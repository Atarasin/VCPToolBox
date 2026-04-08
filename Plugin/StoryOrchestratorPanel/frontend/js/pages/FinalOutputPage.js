export async function renderFinalOutputPage(container, store, api, storyId) {
    container.innerHTML = '<div class="loading">Loading final output...</div>';

    try {
        const response = await api.getStory(storyId);
        if (!response.success) throw new Error(response.error || 'Failed to load story');

        const story = response.story || {};
        const final = story.finalOutput || story.phase3?.finalEditorOutput || {};
        const chapters = story.phase3?.polishedChapters || story.phase2?.chapters || [];

        container.innerHTML = `
            <div class="final-output-page">
                <div class="page-header">
                    <h2>Final Output</h2>
                    <div class="export-buttons">
                        <button class="btn-export" data-format="markdown">Export Markdown</button>
                        <button class="btn-export" data-format="txt">Export TXT</button>
                        <button class="btn-export" data-format="json">Export JSON</button>
                    </div>
                </div>
                <div class="final-meta">
                    <p><strong>Title:</strong> ${story.title || 'Untitled'}</p>
                    <p><strong>Chapters:</strong> ${chapters.length}</p>
                    <p><strong>Total Words:</strong> ${story.phase2?.totalWordCount || final.wordCount || 'N/A'}</p>
                    <p><strong>Quality:</strong> ${story.phase3?.qualityScores?.overall || 'N/A'}</p>
                </div>
                ${final.content ? `
                    <div class="final-content narrative">
                        ${final.content.replace(/\n/g, '<br>')}
                    </div>
                ` : '<p class="empty-state">Final output not available yet.</p>'}
            </div>
        `;

        container.querySelectorAll('.btn-export').forEach(btn => {
            btn.addEventListener('click', async () => {
                const format = btn.dataset.format;
                btn.disabled = true;
                btn.textContent = 'Exporting...';
                try {
                    const result = await api.exportStory(storyId);
                    if (result.downloadUrl) {
                        const a = document.createElement('a');
                        a.href = result.downloadUrl;
                        a.download = `${story.title || 'story'}.${format}`;
                        a.click();
                    }
                } catch (e) {
                    alert('Export failed: ' + e.message);
                }
                btn.disabled = false;
                btn.textContent = `Export ${format.toUpperCase()}`;
            });
        });
    } catch (error) {
        container.innerHTML = `<div class="error-state"><p>Error: ${error.message}</p></div>`;
    }
}
