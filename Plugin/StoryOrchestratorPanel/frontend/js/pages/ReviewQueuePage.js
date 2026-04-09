import { router } from '../core/router.js';

export async function renderReviewQueuePage(containerElement, store, api) {
    containerElement.innerHTML = `
        <div class="review-queue-page">
            <div class="page-header">
                <h2>评审队列</h2>
                <p>等待您审批的创作检查点</p>
            </div>
            <div id="review-queue-content" class="queue-content">
                <div class="loading">正在加载评审队列...</div>
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
        const response = await api.getStories();
        const stories = response.data || response.stories || response || [];
        const pendingStories = stories.filter(story => {
            return story.checkpointPending || 
                   story.status === 'checkpoint_pending' || 
                   story.status === 'pending_confirmation' || 
                   (story.workflow && story.workflow.activeCheckpoint && story.workflow.activeCheckpoint.status === 'pending');
        });

        pendingStories.sort((a, b) => {
            const timeA = a.updatedAt ? new Date(a.updatedAt).getTime() : 0;
            const timeB = b.updatedAt ? new Date(b.updatedAt).getTime() : 0;
            return timeA - timeB;
        });

        if (pendingStories.length === 0) {
            contentEl.innerHTML = `
                <div class="empty-state">
                    <h3>暂无待办事项</h3>
                    <p>目前没有需要您评审的检查点。</p>
                </div>
            `;
            return;
        }

        let html = '<div class="queue-list">';
        
        pendingStories.forEach(story => {
            let phase = story.workflow?.currentPhase || story.currentPhase || '未知阶段';
            let phaseName = phase;
            
            // Check for phase embedded in status if workflow object is missing/incomplete
            if (phase === '未知阶段' && story.status) {
                if (story.status.startsWith('phase1')) phase = 'phase1';
                else if (story.status.startsWith('phase2')) phase = 'phase2';
                else if (story.status.startsWith('phase3')) phase = 'phase3';
            }

            let checkpointType = story.workflow?.activeCheckpoint?.type || '未知检查点';
            
            if (phase === 'phase1') { phaseName = '世界观设定'; checkpointType = checkpointType === '未知检查点' ? '基础设定确认' : checkpointType; }
            else if (phase === 'phase2') { phaseName = '大纲与正文'; checkpointType = checkpointType === '未知检查点' ? '故事大纲确认' : checkpointType; }
            else if (phase === 'phase3') { phaseName = '润色校验'; checkpointType = checkpointType === '未知检查点' ? '内容质量确认' : checkpointType; }
            else if (phase === 'phase4') { phaseName = '已完成'; checkpointType = checkpointType === '未知检查点' ? '最终定稿确认' : checkpointType; }
            
            // Format checkpoint type if it's the raw english string
            if (checkpointType === 'phase1_checkpoint' || checkpointType === 'worldview_confirmation') checkpointType = '世界观设定确认';
            if (checkpointType === 'outline_checkpoint' || checkpointType === 'outline_confirmation') checkpointType = '故事大纲确认';
            if (checkpointType === 'content_checkpoint' || checkpointType === 'content_quality_confirmation') checkpointType = '内容质量确认';
            if (checkpointType === 'final_checkpoint' || checkpointType === 'final_approval') checkpointType = '最终定稿确认';

            let countdownHtml = '';
            let targetTime = story.autoApproveAt || story.workflow?.activeCheckpoint?.expiresAt;
            if (targetTime) {
                const autoApproveTime = new Date(targetTime);
                const now = new Date();
                if (autoApproveTime > now) {
                    const hoursLeft = Math.ceil((autoApproveTime - now) / (1000 * 60 * 60));
                    countdownHtml = `<div class="countdown">将在 ~${hoursLeft} 小时后自动通过</div>`;
                }
            }

            html += `
                <div class="queue-item">
                    <div class="item-details">
                        <h3 class="story-title">${story.title || '未命名故事'}</h3>
                        <div class="meta-info">
                            <span class="badge phase">阶段: ${phaseName}</span>
                            <span class="badge checkpoint-type">${checkpointType}</span>
                            ${countdownHtml}
                        </div>
                    </div>
                    <a href="#/stories/${story.id}/review" class="btn-review" data-id="${story.id}" role="button">立即评审</a>
                </div>
            `;
        });
        
        html += '</div>';
        contentEl.innerHTML = html;

        // Ensure we properly attach click events to all review buttons
        setTimeout(() => {
            const reviewButtons = containerElement.querySelectorAll('.btn-review');
            reviewButtons.forEach(btn => {
                btn.addEventListener('click', (e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    const storyId = e.currentTarget.getAttribute('data-id');
                    window.location.hash = `#/stories/${storyId}/review`;
                });
            });
        }, 0);

    } catch (error) {
        console.error('Failed to load review queue:', error);
        contentEl.innerHTML = `
            <div class="error-state">
                加载评审队列失败，请稍后再试。
                <br><small>${error.message}</small>
            </div>
        `;
    }
}
