export async function renderQualityPage(container, store, api, storyId) {
    container.innerHTML = '<div class="loading">Loading quality data...</div>';

    try {
        const response = await api.getStory(storyId);
        if (!response.success) throw new Error(response.error || 'Failed to load story');

        const story = response.story || {};
        const phase3 = story.phase3 || {};
        const quality = phase3.qualityScores || {};

        const dims = quality.dimensions || {};
        const dimKeys = ['coherence', 'engagement', 'consistency', 'style', 'pacing', 'prose'];
        const overall = quality.overall || 0;
        const iterations = quality.iterationCount || quality.iterations || 0;

        container.innerHTML = `
            <div class="quality-page">
                <div class="page-header">
                    <h2>Quality Metrics</h2>
                </div>
                <div class="quality-overview">
                    <div class="overall-score">
                        <span class="score-value">${overall}</span>
                        <span class="score-label">Overall Score</span>
                    </div>
                    <div class="iteration-count">
                        <span class="iter-value">${iterations}</span>
                        <span class="iter-label">Iterations</span>
                    </div>
                </div>
                <div class="dimension-grid">
                    ${dimKeys.map(key => {
                        const val = dims[key] || 0;
                        return `<div class="dimension-card">
                            <span class="dim-name">${key}</span>
                            <div class="dim-bar"><div class="dim-fill" style="width:${val}%"></div></div>
                            <span class="dim-value">${val}</span>
                        </div>`;
                    }).join('')}
                </div>
                ${phase3.finalValidation ? `
                    <div class="validation-section">
                        <h3>Final Validation</h3>
                        <p>${phase3.finalValidation.summary || 'Validation complete.'}</p>
                    </div>
                ` : ''}
            </div>
        `;
    } catch (error) {
        container.innerHTML = `<div class="error-state"><p>Error: ${error.message}</p></div>`;
    }
}
