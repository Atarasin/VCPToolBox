export async function renderChapterReaderPage(container, store, api, storyId, chapterNum) {
    const num = parseInt(chapterNum) || 1;
    container.innerHTML = '<div class="loading">Loading chapter...</div>';

    try {
        const response = await api.getStoryChapter(storyId, num);
        if (!response.success) throw new Error(response.error || 'Failed to load chapter');

        const chapter = response.chapter || {};
        const content = chapter.content || chapter.draft || 'No content available.';

        container.innerHTML = `
            <div class="chapter-reader">
                <div class="chapter-sidebar">
                    <h4>Chapters</h4>
                    <div class="chapter-nav">
                        <button class="btn-nav" data-dir="prev" ${num <= 1 ? 'disabled' : ''}>← Previous</button>
                        <span class="current-chapter">Chapter ${num}</span>
                        <button class="btn-nav" data-dir="next">Next →</button>
                    </div>
                </div>
                <div class="chapter-content narrative">
                    <h2>${chapter.title || 'Chapter ' + num}</h2>
                    <div class="chapter-text">${content.replace(/\n/g, '<br>')}</div>
                </div>
                <div class="chapter-meta-sidebar">
                    <h4>Chapter Info</h4>
                    <p><strong>Words:</strong> ${chapter.wordCount || chapter.actualWordCount || 'N/A'}</p>
                    <p><strong>Status:</strong> ${chapter.status || 'Unknown'}</p>
                    ${chapter.validation ? `<p><strong>Validation:</strong> ${chapter.validation.passed ? '✓ Passed' : '⚠ Issues'}</p>` : ''}
                </div>
            </div>
        `;

        container.querySelector('.btn-nav[data-dir="prev"]')?.addEventListener('click', () => {
            if (num > 1) window.location.hash = `/stories/${storyId}/chapters/${num - 1}`;
        });
        container.querySelector('.btn-nav[data-dir="next"]')?.addEventListener('click', () => {
            window.location.hash = `/stories/${storyId}/chapters/${num + 1}`;
        });
    } catch (error) {
        container.innerHTML = `<div class="error-state"><p>Error: ${error.message}</p></div>`;
    }
}
