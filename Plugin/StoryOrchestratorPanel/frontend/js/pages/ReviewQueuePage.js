import { router } from '../core/router.js';

export async function renderReviewQueuePage(containerElement, store, api) {
    containerElement.innerHTML = `
        <div class="review-queue-page">
            <div class="page-header">
                <h2>Review Queue</h2>
                <p>Checkpoints waiting for your approval</p>
            </div>
            <div id="review-queue-content" class="queue-content">
                <div class="loading">Loading review queue...</div>
            </div>
        </div>
        <style>
            .review-queue-page {
                display: flex;
                flex-direction: column;
                gap: 20px;
                height: 100%;
            }
            .page-header {
                padding-bottom: 10px;
                border-bottom: 1px solid var(--border-color);
            }
            .page-header h2 {
                margin: 0 0 5px 0;
                color: var(--accent-color);
            }
            .page-header p {
                margin: 0;
                color: #8b949e;
                font-size: 0.9em;
            }
            .queue-content {
                flex: 1;
                overflow-y: auto;
            }
            .queue-list {
                display: flex;
                flex-direction: column;
                gap: 15px;
            }
            .queue-item {
                background-color: var(--sidebar-bg);
                border: 1px solid var(--border-color);
                border-radius: 6px;
                padding: 15px;
                display: flex;
                justify-content: space-between;
                align-items: center;
                transition: border-color 0.2s;
            }
            .queue-item:hover {
                border-color: var(--accent-color);
            }
            .item-details {
                display: flex;
                flex-direction: column;
                gap: 8px;
            }
            .story-title {
                font-size: 1.1em;
                font-weight: 600;
                margin: 0;
            }
            .meta-info {
                display: flex;
                gap: 10px;
                align-items: center;
                font-size: 0.85em;
                color: #8b949e;
            }
            .badge {
                padding: 2px 6px;
                border-radius: 4px;
                font-size: 0.9em;
                font-weight: 500;
            }
            .badge.phase {
                background-color: rgba(139, 148, 158, 0.2);
                color: #c9d1d9;
            }
            .badge.checkpoint-type {
                background-color: rgba(88, 166, 255, 0.2);
                color: var(--accent-color);
            }
            .countdown {
                display: flex;
                align-items: center;
                gap: 5px;
                color: #d29922;
                font-size: 0.85em;
            }
            .countdown::before {
                content: '⏳';
            }
            .btn-review {
                background-color: var(--accent-color);
                color: var(--bg-color);
                border: none;
                padding: 8px 16px;
                border-radius: 4px;
                cursor: pointer;
                font-weight: 600;
                transition: opacity 0.2s;
            }
            .btn-review:hover {
                opacity: 0.9;
            }
            .empty-state {
                display: flex;
                flex-direction: column;
                align-items: center;
                justify-content: center;
                height: 200px;
                color: #8b949e;
                background-color: rgba(139, 148, 158, 0.05);
                border-radius: 6px;
                border: 1px dashed var(--border-color);
            }
            .empty-state h3 {
                color: var(--text-color);
                margin-bottom: 5px;
            }
            .error-state {
                color: #f85149;
                padding: 15px;
                background-color: rgba(248, 81, 73, 0.1);
                border: 1px solid rgba(248, 81, 73, 0.4);
                border-radius: 6px;
            }
        </style>
    `;

    const contentEl = containerElement.querySelector('#review-queue-content');

    try {
        const stories = await api.getStories();
        const pendingStories = stories.filter(story => story.checkpointPending);

        pendingStories.sort((a, b) => {
            const timeA = a.updatedAt ? new Date(a.updatedAt).getTime() : 0;
            const timeB = b.updatedAt ? new Date(b.updatedAt).getTime() : 0;
            return timeA - timeB;
        });

        if (pendingStories.length === 0) {
            contentEl.innerHTML = `
                <div class="empty-state">
                    <h3>All caught up!</h3>
                    <p>There are no checkpoints waiting for your review.</p>
                </div>
            `;
            return;
        }

        let html = '<div class="queue-list">';
        
        pendingStories.forEach(story => {
            const phase = story.currentPhase || 'Unknown Phase';
            let checkpointType = 'Unknown Checkpoint';
            if (phase === 'phase1') checkpointType = 'Foundation';
            else if (phase === 'phase2') checkpointType = 'Outline';
            else if (phase === 'phase3') checkpointType = 'Content';
            else if (phase === 'phase4') checkpointType = 'Final';

            let countdownHtml = '';
            if (story.autoApproveAt) {
                const autoApproveTime = new Date(story.autoApproveAt);
                const now = new Date();
                if (autoApproveTime > now) {
                    const hoursLeft = Math.ceil((autoApproveTime - now) / (1000 * 60 * 60));
                    countdownHtml = `<div class="countdown">Auto-approves in ~${hoursLeft}h</div>`;
                }
            }

            html += `
                <div class="queue-item">
                    <div class="item-details">
                        <h3 class="story-title">\${story.title || 'Untitled Story'}</h3>
                        <div class="meta-info">
                            <span class="badge phase">Phase: \${phase}</span>
                            <span class="badge checkpoint-type">\${checkpointType}</span>
                            \${countdownHtml}
                        </div>
                    </div>
                    <button class="btn-review" data-id="\${story.id}">Review Now</button>
                </div>
            `;
        });
        
        html += '</div>';
        contentEl.innerHTML = html;

        const reviewButtons = contentEl.querySelectorAll('.btn-review');
        reviewButtons.forEach(btn => {
            btn.addEventListener('click', (e) => {
                const storyId = e.target.getAttribute('data-id');
                router.navigate(\`/stories/\${storyId}/review\`);
            });
        });

    } catch (error) {
        console.error('Failed to load review queue:', error);
        contentEl.innerHTML = `
            <div class="error-state">
                Failed to load review queue. Please try again later.
                <br><small>\${error.message}</small>
            </div>
        `;
    }
}
