export async function renderStorySummaryPage(container, store, api, storyId) {
    container.innerHTML = `
        <div class="story-summary-page">
            <div class="loading">正在加载故事详情...</div>
        </div>
    `;

    try {
        const response = await api.getStory(storyId);
        if (!response.success) {
            throw new Error(response.error || '加载故事失败');
        }

        const story = response.story;
        store.setCurrentStory(story);
        const shortStoryId = story.shortId || String(story.id || storyId || '').replace(/^story-/, '');
        const targetWordCountLabel = story.targetWordCountLabel || formatTargetWordCountLabel(story.targetWordCount);

        const phaseOrder = ['phase1', 'phase2', 'phase3'];
        const phaseLabels = {
            phase1: '世界观与人设',
            phase2: '大纲与正文生成',
            phase3: '内容润色与校验'
        };

        const currentPhaseIndex = phaseOrder.indexOf(story.workflow?.currentPhase || 'phase1');
        const retryingInfo = getRetryingInfo(story);
        const runningInfo = getRunningInfo(story);

        const phaseRail = phaseOrder.map((phase, index) => {
            let state = 'pending';
            if (story.status === 'completed' || index < currentPhaseIndex) state = 'completed';
            else if (index === currentPhaseIndex) state = 'current';
            if (retryingInfo.active && retryingInfo.phase === phase) state = 'current';

            return `
                <div class="phase-step ${state}">
                    <div class="phase-icon">${state === 'completed' ? '✓' : index + 1}</div>
                    <div class="phase-label">${phaseLabels[phase]}</div>
                </div>
            `;
        }).join('');

        const checkpointCard = story.workflow?.activeCheckpoint && story.workflow.activeCheckpoint.status === 'pending' ? `
            <div class="checkpoint-card active">
                <div class="checkpoint-header">
                    <span class="checkpoint-badge">需要评审</span>
                    <span class="checkpoint-type">${getCheckpointTypeName(story.workflow.activeCheckpoint.type) || '审批'}</span>
                </div>
                <p class="checkpoint-message">当前流程已暂停，等待您的评审意见以继续创作。</p>
                <a href="#/stories/${storyId}/review" class="btn-review-now" data-story-id="${storyId}" role="button">立即评审</a>
            </div>
        ` : '';

        const retryingCard = retryingInfo.active ? `
            <div class="retrying-card active">
                <div class="retrying-header">
                    <span class="retrying-badge">重新生成中</span>
                    <span class="retrying-type">${retryingInfo.label}</span>
                </div>
                <p class="retrying-message">系统已收到退回意见，正在根据最新反馈重新生成内容。您可以停留在当前页面，系统会自动刷新状态。</p>
                ${story.lastRejectionFeedback ? `<div class="retrying-feedback">最近一次退回意见：${story.lastRejectionFeedback}</div>` : ''}
            </div>
        ` : '';

        const runningCard = runningInfo.active ? `
            <div class="retrying-card active" style="border-color: rgba(63, 185, 80, 0.35); background: rgba(63, 185, 80, 0.08);">
                <div class="retrying-header">
                    <span class="retrying-badge" style="background: rgba(63, 185, 80, 0.18); color: #3fb950;">流程继续中</span>
                    <span class="retrying-type">${runningInfo.label}</span>
                </div>
                <p class="retrying-message">审核结果已提交成功，系统正在继续执行后续创作流程。当前页面会自动刷新状态。</p>
            </div>
        ` : '';

        container.innerHTML = `
            <div class="story-summary-page">
                <div class="page-header" style="display: flex; align-items: center; margin-bottom: 20px; border-bottom: 1px solid var(--border-color); padding-bottom: 15px;">
                    <a href="#/stories" style="color: var(--accent-color); text-decoration: none; margin-right: 15px; font-size: 1.2rem;">← 返回</a>
                    <h2 style="margin: 0; flex: 1;">故事概览</h2>
                </div>

                <div class="story-hero" style="background: var(--sidebar-bg); padding: 25px; border-radius: 8px; border: 1px solid var(--border-color); margin-bottom: 25px;">
                    <div class="story-title-row" style="display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 15px;">
                        <div style="display: flex; flex-direction: column; gap: 8px; min-width: 0;">
                            <h1 style="margin: 0; color: var(--accent-color); font-size: 1.8rem; word-break: break-all;">${story.title || '未命名故事'}</h1>
                            <div class="story-id-chip" style="display: inline-flex; align-items: center; gap: 8px; width: fit-content; max-width: 100%; padding: 6px 12px; border-radius: 999px; background: rgba(88, 166, 255, 0.08); border: 1px solid rgba(88, 166, 255, 0.24); color: #8b949e; font-size: 0.85rem;">
                                <span style="color: var(--accent-color); font-weight: 600;">故事ID</span>
                                <span style="font-family: 'SFMono-Regular', Consolas, 'Liberation Mono', Menlo, monospace; color: var(--text-color);">${shortStoryId || '未知'}</span>
                            </div>
                        </div>
                        <span class="status-chip ${story.phaseClass || ''}" style="padding: 4px 12px; border-radius: 12px; font-size: 0.9rem; font-weight: bold; background: rgba(88, 166, 255, 0.1); color: var(--accent-color); border: 1px solid var(--accent-color);">${story.phaseDisplay || '未知状态'}</span>
                    </div>
                    <div class="story-meta" style="display: flex; gap: 20px; color: #8b949e; font-size: 0.95rem; margin-bottom: 20px;">
                        <span class="genre" style="display: flex; align-items: center; gap: 5px;">
                            <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor"><path fill-rule="evenodd" d="M1.5 14.25c0 .138.112.25.25.25H4v-1.25a.75.75 0 01.75-.75h2.5a.75.75 0 01.75.75v1.25h2.25a.25.25 0 00.25-.25V1.75a.25.25 0 00-.25-.25h-8.5a.25.25 0 00-.25.25v12.5zM1.75 0h8.5C11.216 0 12 .784 12 1.75v12.5A1.75 1.75 0 0110.25 16h-8.5A1.75 1.75 0 010 14.25V1.75C0 .784.784 0 1.75 0zM3 3.5a.5.5 0 01.5-.5h5a.5.5 0 01.5.5v1a.5.5 0 01-.5.5h-5a.5.5 0 01-.5-.5v-1zM3 7.5a.5.5 0 01.5-.5h5a.5.5 0 01.5.5v1a.5.5 0 01-.5.5h-5a.5.5 0 01-.5-.5v-1z"></path></svg>
                            题材: ${story.genre || '未分类'}
                        </span>
                        <span class="word-count" style="display: flex; align-items: center; gap: 5px;">
                            <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor"><path fill-rule="evenodd" d="M1.5 2.75a.25.25 0 01.25-.25h8.5a.25.25 0 01.25.25v5.5a.75.75 0 001.5 0v-5.5A1.75 1.75 0 0010.25 1h-8.5A1.75 1.75 0 000 2.75v10.5C0 14.216.784 15 1.75 15h8.5A1.75 1.75 0 0012 13.25v-1.5a.75.75 0 00-1.5 0v1.5a.25.25 0 01-.25.25h-8.5a.25.25 0 01-.25-.25V2.75z"></path></svg>
                            目标字数: ${targetWordCountLabel}
                        </span>
                    </div>
                    
                    <div class="story-prompt-section" style="background: rgba(0,0,0,0.2); padding: 15px; border-radius: 6px; border-left: 4px solid var(--accent-color);">
                        <h3 style="margin-top: 0; margin-bottom: 10px; font-size: 1rem; color: #c9d1d9;">创作提示词 (Prompt)</h3>
                        <p class="story-prompt" style="margin: 0; line-height: 1.6; color: var(--text-color); font-style: italic;">"${story.storyPrompt || '无提示词'}"</p>
                    </div>
                </div>

                <div class="phase-rail" style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 30px; position: relative; padding: 0 20px;">
                    <div style="position: absolute; top: 15px; left: 40px; right: 40px; height: 2px; background: var(--border-color); z-index: 0;"></div>
                    ${phaseRail}
                </div>

                ${retryingCard}
                ${runningCard}
                ${checkpointCard}

                <div class="navigation-cards" style="display: grid; grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); gap: 20px; margin-bottom: 30px;">
                    <a href="#/stories/${storyId}/bible" class="nav-card" style="text-decoration: none; color: inherit; background: var(--sidebar-bg); border: 1px solid var(--border-color); border-radius: 8px; padding: 20px; transition: transform 0.2s, border-color 0.2s, box-shadow 0.2s;">
                        <h4 style="margin-top: 0; margin-bottom: 8px; color: var(--accent-color); font-size: 1.2rem; display: flex; align-items: center; gap: 8px;">
                            <span>📚</span> 故事设定集 (Bible)
                        </h4>
                        <p style="margin: 0; color: #8b949e; font-size: 0.9rem;">世界观、角色设定、核心规则等基础框架</p>
                        <div style="margin-top: 15px; font-size: 0.8rem; color: ${story.hasWorldview ? '#3fb950' : '#8b949e'};">${story.hasWorldview ? '✓ 已生成' : '○ 待生成'}</div>
                    </a>
                    
                    <a href="#/stories/${storyId}/outline" class="nav-card" style="text-decoration: none; color: inherit; background: var(--sidebar-bg); border: 1px solid var(--border-color); border-radius: 8px; padding: 20px; transition: transform 0.2s, border-color 0.2s, box-shadow 0.2s;">
                        <h4 style="margin-top: 0; margin-bottom: 8px; color: var(--accent-color); font-size: 1.2rem; display: flex; align-items: center; gap: 8px;">
                            <span>📝</span> 故事大纲 (Outline)
                        </h4>
                        <p style="margin: 0; color: #8b949e; font-size: 0.9rem;">章节结构、情节走向、关键转折点</p>
                        <div style="margin-top: 15px; font-size: 0.8rem; color: ${story.hasOutline ? '#3fb950' : '#8b949e'};">${story.hasOutline ? '✓ 已生成' : '○ 待生成'}</div>
                    </a>
                    
                    <a href="#/stories/${storyId}/chapters" class="nav-card" style="text-decoration: none; color: inherit; background: var(--sidebar-bg); border: 1px solid var(--border-color); border-radius: 8px; padding: 20px; transition: transform 0.2s, border-color 0.2s, box-shadow 0.2s;">
                        <h4 style="margin-top: 0; margin-bottom: 8px; color: var(--accent-color); font-size: 1.2rem; display: flex; align-items: center; gap: 8px;">
                            <span>📖</span> 章节正文 (Chapters)
                        </h4>
                        <p style="margin: 0; color: #8b949e; font-size: 0.9rem;">查看和编辑具体章节的详细内容</p>
                        <div style="margin-top: 15px; font-size: 0.8rem; color: #8b949e;">共 ${story.chapterStats?.total || 0} 章 | 已完成 ${story.chapterStats?.completed || 0} 章</div>
                    </a>
                    
                    <a href="#/stories/${storyId}/quality" class="nav-card" style="text-decoration: none; color: inherit; background: var(--sidebar-bg); border: 1px solid var(--border-color); border-radius: 8px; padding: 20px; transition: transform 0.2s, border-color 0.2s, box-shadow 0.2s;">
                        <h4 style="margin-top: 0; margin-bottom: 8px; color: var(--accent-color); font-size: 1.2rem; display: flex; align-items: center; gap: 8px;">
                            <span>⚖️</span> 质量评估 (Quality)
                        </h4>
                        <p style="margin: 0; color: #8b949e; font-size: 0.9rem;">内容逻辑校验、风格一致性评估及迭代记录</p>
                    </a>
                    
                    <a href="#/stories/${storyId}/timeline" class="nav-card" style="text-decoration: none; color: inherit; background: var(--sidebar-bg); border: 1px solid var(--border-color); border-radius: 8px; padding: 20px; transition: transform 0.2s, border-color 0.2s, box-shadow 0.2s;">
                        <h4 style="margin-top: 0; margin-bottom: 8px; color: var(--accent-color); font-size: 1.2rem; display: flex; align-items: center; gap: 8px;">
                            <span>⏱️</span> 工作流时间线
                        </h4>
                        <p style="margin: 0; color: #8b949e; font-size: 0.9rem;">查看各Agent的协作历史与执行流转过程</p>
                    </a>
                    
                    <a href="#/stories/${storyId}/final" class="nav-card" style="text-decoration: none; color: inherit; background: var(--sidebar-bg); border: 1px solid var(--border-color); border-radius: 8px; padding: 20px; transition: transform 0.2s, border-color 0.2s, box-shadow 0.2s;">
                        <h4 style="margin-top: 0; margin-bottom: 8px; color: var(--accent-color); font-size: 1.2rem; display: flex; align-items: center; gap: 8px;">
                            <span>📦</span> 最终成品 (Export)
                        </h4>
                        <p style="margin: 0; color: #8b949e; font-size: 0.9rem;">预览完整故事并导出为多种格式 (Markdown/TXT/JSON)</p>
                    </a>
                </div>
            </div>
        `;

        addStyles();

        // Add event listener for Review Now button
        const reviewBtn = container.querySelector('.btn-review-now');
        if (reviewBtn) {
            reviewBtn.addEventListener('click', (e) => {
                e.preventDefault();
                e.stopPropagation();
                window.location.hash = `#/stories/${storyId}/review`;
            });
        }

        if (retryingInfo.active || runningInfo.active) {
            if (container.__storyRetryPollingTimer) {
                clearTimeout(container.__storyRetryPollingTimer);
            }
            container.__storyRetryPollingTimer = setTimeout(() => {
                renderStorySummaryPage(container, store, api, storyId);
            }, 5000);
        }

    } catch (error) {
        container.innerHTML = `
            <div class="story-summary-page">
                <div class="error-state" style="padding: 40px; text-align: center; color: #f85149; background: rgba(248, 81, 73, 0.1); border: 1px solid rgba(248, 81, 73, 0.4); border-radius: 8px;">
                    <h2 style="margin-top: 0;">加载故事详情失败</h2>
                    <p style="margin-bottom: 20px;">${error.message}</p>
                    <a href="#/stories" class="btn" style="display: inline-block; padding: 10px 20px; background: var(--sidebar-bg); color: var(--text-color); text-decoration: none; border-radius: 6px; border: 1px solid var(--border-color);">返回故事列表</a>
                </div>
            </div>
        `;
    }
}

function formatTargetWordCountLabel(targetWordCount) {
    if (typeof targetWordCount === 'number' && Number.isFinite(targetWordCount) && targetWordCount > 0) {
        return `${targetWordCount.toLocaleString()} 字`;
    }

    const min = Number(targetWordCount?.min ?? targetWordCount?.minimum ?? targetWordCount?.target ?? 0) || 0;
    const max = Number(targetWordCount?.max ?? targetWordCount?.maximum ?? targetWordCount?.target ?? min) || min;

    if (min > 0 && max > 0) {
        return min === max
            ? `${min.toLocaleString()} 字`
            : `${Math.min(min, max).toLocaleString()} - ${Math.max(min, max).toLocaleString()} 字`;
    }

    return '未设置';
}

function getCheckpointTypeName(type) {
    if (!type) return '审批';
    const types = {
        'worldview_confirmation': '世界观设定确认',
        'outline_confirmation': '故事大纲确认',
        'content_quality_confirmation': '内容质量确认',
        'final_approval': '最终定稿确认'
    };
    return types[type] || type;
}

function getRetryingInfo(story) {
    const retryingPhase = story.retryingPhase || ['phase1', 'phase2', 'phase3'].find((phase) => {
        return story.status === `${phase}_retrying`;
    });

    if (!retryingPhase) {
        return {
            active: false,
            phase: null,
            label: ''
        };
    }

    const labels = {
        phase1: '阶段一 · 正在重建设定',
        phase2: '阶段二 · 正在重写大纲与正文',
        phase3: '阶段三 · 正在重新润色与校验'
    };

    return {
        active: true,
        phase: retryingPhase,
        label: labels[retryingPhase] || '正在重新生成'
    };
}

function getRunningInfo(story) {
    if (story.workflow?.state !== 'running' || getRetryingInfo(story).active) {
        return {
            active: false,
            phase: null,
            label: ''
        };
    }

    const labels = {
        phase1: '阶段一 · 正在搭建世界观与人设',
        phase2: '阶段二 · 正在生成大纲与正文',
        phase3: '阶段三 · 正在润色与校验'
    };
    const phase = story.workflow?.currentPhase || story.phase || 'phase1';

    return {
        active: true,
        phase,
        label: labels[phase] || '系统正在继续执行'
    };
}

function addStyles() {
    if (document.getElementById('story-summary-styles')) return;

    const styleEl = document.createElement('style');
    styleEl.id = 'story-summary-styles';
    styleEl.textContent = `
        .phase-step {
            display: flex;
            flex-direction: column;
            align-items: center;
            z-index: 1;
            width: 120px;
        }
        
        .phase-icon {
            width: 32px;
            height: 32px;
            border-radius: 50%;
            background: var(--bg-color);
            border: 2px solid var(--border-color);
            display: flex;
            align-items: center;
            justify-content: center;
            font-weight: bold;
            margin-bottom: 8px;
            color: #8b949e;
            transition: all 0.3s;
        }
        
        .phase-label {
            font-size: 0.9rem;
            color: #8b949e;
            text-align: center;
        }
        
        .phase-step.completed .phase-icon {
            background: #238636;
            border-color: #238636;
            color: #ffffff;
        }
        
        .phase-step.completed .phase-label {
            color: var(--text-color);
        }
        
        .phase-step.current .phase-icon {
            border-color: var(--accent-color);
            color: var(--accent-color);
            box-shadow: 0 0 0 4px rgba(88, 166, 255, 0.2);
        }
        
        .phase-step.current .phase-label {
            color: var(--accent-color);
            font-weight: 600;
        }
        
        .checkpoint-card {
            background: rgba(210, 153, 34, 0.1);
            border: 1px solid rgba(210, 153, 34, 0.4);
            border-radius: 8px;
            padding: 20px;
            margin-bottom: 30px;
            display: flex;
            flex-direction: column;
            align-items: flex-start;
        }
        
        .checkpoint-header {
            display: flex;
            align-items: center;
            gap: 12px;
            margin-bottom: 10px;
        }
        
        .checkpoint-badge {
            background: #d29922;
            color: #ffffff;
            padding: 4px 10px;
            border-radius: 12px;
            font-size: 0.8rem;
            font-weight: bold;
        }
        
        .checkpoint-type {
            color: #d29922;
            font-weight: 600;
        }
        
        .checkpoint-message {
            margin: 0 0 15px 0;
            color: var(--text-color);
        }
        
        .btn-review-now {
            background: #d29922;
            color: #ffffff;
            border: none;
            padding: 8px 20px;
            border-radius: 6px;
            font-weight: bold;
            cursor: pointer;
            transition: background 0.2s;
            text-decoration: none;
            display: inline-flex;
            align-items: center;
        }
        
        .btn-review-now:hover {
            background: #e3b341;
        }

        .retrying-card {
            background: rgba(88, 166, 255, 0.08);
            border: 1px solid rgba(88, 166, 255, 0.3);
            border-radius: 12px;
            padding: 20px;
            margin-bottom: 24px;
            display: flex;
            flex-direction: column;
            gap: 12px;
        }

        .retrying-header {
            display: flex;
            align-items: center;
            gap: 12px;
            flex-wrap: wrap;
        }

        .retrying-badge {
            background: #58a6ff;
            color: #0d1117;
            padding: 4px 10px;
            border-radius: 999px;
            font-size: 0.8rem;
            font-weight: 700;
        }

        .retrying-type {
            color: #79c0ff;
            font-weight: 600;
        }

        .retrying-message,
        .retrying-feedback {
            margin: 0;
            color: var(--text-color);
            line-height: 1.7;
        }

        .retrying-feedback {
            padding: 12px 14px;
            border-radius: 10px;
            background: rgba(255, 255, 255, 0.04);
            border: 1px solid rgba(88, 166, 255, 0.16);
            color: #c9d1d9;
        }
        
        .nav-card:hover {
            transform: translateY(-3px) !important;
            border-color: var(--accent-color) !important;
            box-shadow: 0 6px 12px rgba(0,0,0,0.2) !important;
        }
    `;
    document.head.appendChild(styleEl);
}
