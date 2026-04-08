export async function renderStorySummaryPage(container, store, api, storyId) {
    container.innerHTML = `
        <div class="story-summary-page">
            <div class="loading">Loading story details...</div>
        </div>
    `;

    try {
        const response = await api.getStory(storyId);
        if (!response.success) {
            throw new Error(response.error || 'Failed to load story');
        }

        const story = response.story;
        store.setCurrentStory(story);

        const phaseOrder = ['phase1', 'phase2', 'phase3'];
        const phaseLabels = {
            phase1: 'Worldbuilding',
            phase2: 'Outline & Chapters',
            phase3: 'Refinement'
        };

        const currentPhaseIndex = phaseOrder.indexOf(story.workflow?.currentPhase || 'phase1');

        const phaseRail = phaseOrder.map((phase, index) => {
            let state = 'pending';
            if (index < currentPhaseIndex) state = 'completed';
            else if (index === currentPhaseIndex) state = 'current';

            return `
                <div class="phase-step ${state}">
                    <div class="phase-icon">${state === 'completed' ? '✓' : index + 1}</div>
                    <div class="phase-label">${phaseLabels[phase]}</div>
                </div>
            `;
        }).join('');

        const checkpointCard = story.workflow?.activeCheckpoint ? `
            <div class="checkpoint-card active">
                <div class="checkpoint-header">
                    <span class="checkpoint-badge">Checkpoint Pending</span>
                    <span class="checkpoint-type">${story.workflow.activeCheckpoint.type || 'approval'}</span>
                </div>
                <p class="checkpoint-message">Your review is needed to continue the workflow.</p>
                <button class="btn-review-now" data-story-id="${storyId}">Review Now</button>
            </div>
        ` : '';

        container.innerHTML = `
            <div class="story-summary-page">
                <div class="story-hero">
                    <div class="story-title-row">
                        <h1>${story.title || 'Untitled Story'}</h1>
                        <span class="status-chip ${story.phaseClass || ''}">${story.phaseDisplay || 'Unknown'}</span>
                    </div>
                    <div class="story-meta">
                        <span class="genre">${story.genre || 'General'}</span>
                        <span class="word-count">Target: ${story.targetWordCount?.min || 0} - ${story.targetWordCount?.max || 0} words</span>
                    </div>
                </div>

                <div class="phase-rail">
                    ${phaseRail}
                </div>

                ${checkpointCard}

                <div class="story-prompt-section">
                    <h3>Story Prompt</h3>
                    <p class="story-prompt">${story.storyPrompt || 'No prompt available'}</p>
                </div>

                <div class="navigation-cards">
                    <a href="#/stories/${storyId}/bible" class="nav-card">
                        <h4>Story Bible</h4>
                        <p>Worldview, characters, rules</p>
                    </a>
                    <a href="#/stories/${storyId}/outline" class="nav-card">
                        <h4>Outline</h4>
                        <p>Chapter structure, turning points</p>
                    </a>
                    <a href="#/stories/${storyId}/chapters" class="nav-card">
                        <h4>Chapters</h4>
                        <p>${story.chapterStats?.total || 0} chapters</p>
                    </a>
                    <a href="#/stories/${storyId}/quality" class="nav-card">
                        <h4>Quality</h4>
                        <p>Iteration scores</p>
                    </a>
                    <a href="#/stories/${storyId}/timeline" class="nav-card">
                        <h4>Timeline</h4>
                        <p>Workflow history</p>
                    </a>
                    <a href="#/stories/${storyId}/final" class="nav-card">
                        <h4>Final Output</h4>
                        <p>Export & deliver</p>
                    </a>
                </div>
            </div>
        `;

        // Add event listener for Review Now button
        const reviewBtn = container.querySelector('.btn-review-now');
        if (reviewBtn) {
            reviewBtn.addEventListener('click', () => {
                router.navigate(`/stories/${storyId}/review`);
            });
        }

    } catch (error) {
        container.innerHTML = `
            <div class="story-summary-page">
                <div class="error-state">
                    <h2>Error Loading Story</h2>
                    <p>${error.message}</p>
                    <a href="#/stories" class="btn">Back to Stories</a>
                </div>
            </div>
        `;
    }
}
