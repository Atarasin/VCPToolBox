// Import core modules
import { events } from './core/events.js';
import { store } from './core/store.js';
import { api } from './core/api.js';
import { router } from './core/router.js';
import { wsClient } from './core/ws.js';

// Import page renderers
import { renderStoriesPage } from './pages/StoriesPage.js';
import { renderReviewQueuePage } from './pages/ReviewQueuePage.js';
import { renderStorySummaryPage } from './pages/StorySummaryPage.js';
import { renderStoryBiblePage } from './pages/StoryBiblePage.js';
import { renderOutlinePage } from './pages/OutlinePage.js';
import { renderChapterReaderPage } from './pages/ChapterReaderPage.js';
import { renderQualityPage } from './pages/QualityPage.js';
import { renderFinalOutputPage } from './pages/FinalOutputPage.js';
import { renderCheckpointReviewPanel } from './components/CheckpointReviewPanel.js';

class App {
    constructor() {
        this.initialized = false;
        this.routerView = document.getElementById('router-view');
    }

    async init() {
        if (this.initialized) return;

        try {
            this.setupRoutes();
            this.setupEventListeners();
            
            // Initialize router first
            router.init();
            
            // Connect WebSocket after router is ready
            wsClient.connect();

            this.initialized = true;
            console.log('[App] Initialized successfully');
        } catch (error) {
            console.error('[App] Initialization failed:', error);
            this.showError('Failed to initialize app: ' + error.message);
            throw error;
        }
    }

    setupRoutes() {
        router.register('/', () => {
            router.navigate('/stories');
        });

        router.register('/stories', () => {
            this.renderRoute(() => renderStoriesPage(this.routerView, store, api));
        });

        router.register('/stories/:id', (params) => {
            this.renderRoute(() => renderStorySummaryPage(this.routerView, store, api, params.id));
        });

        router.register('/stories/:id/review', (params) => {
            this.renderRoute(() => this.renderStoryReviewPage(params.id));
        });

        router.register('/stories/:id/bible', (params) => {
            this.renderRoute(() => renderStoryBiblePage(this.routerView, store, api, params.id));
        });

        router.register('/stories/:id/outline', (params) => {
            this.renderRoute(() => renderOutlinePage(this.routerView, store, api, params.id));
        });

        router.register('/stories/:id/chapters', (params) => {
            this.renderRoute(() => renderChapterReaderPage(this.routerView, store, api, params.id, 1));
        });

        router.register('/stories/:id/chapters/:num', (params) => {
            this.renderRoute(() => renderChapterReaderPage(this.routerView, store, api, params.id, params.num));
        });

        router.register('/stories/:id/quality', (params) => {
            this.renderRoute(() => renderQualityPage(this.routerView, store, api, params.id));
        });

        router.register('/stories/:id/final', (params) => {
            this.renderRoute(() => renderFinalOutputPage(this.routerView, store, api, params.id));
        });

        router.register('/review-queue', () => {
            this.renderRoute(() => renderReviewQueuePage(this.routerView, store, api));
        });

        router.register('/settings', () => {
            this.renderRoute(() => this.renderSettingsPlaceholder());
        });
    }

    setupEventListeners() {
        events.on('store:updated', (data) => {
            console.log('[Store] Updated:', data);
        });

        events.on('ws:connected', () => {
            console.log('[WebSocket] Connected');
        });

        events.on('ws:disconnected', () => {
            console.log('[WebSocket] Disconnected');
        });

        events.on('route:change', (routeInfo) => {
            this.updateActiveNavLink(routeInfo.path);
        });
    }

    updateActiveNavLink(path) {
        document.querySelectorAll('.nav-link').forEach(link => {
            link.classList.remove('active');
            if (link.getAttribute('href') === '#' + path) {
                link.classList.add('active');
            }
        });
    }

    renderRoute(renderFn) {
        this.clearRouteTimers();
        renderFn();
    }

    clearRouteTimers() {
        if (!this.routerView) return;

        if (this.routerView.__storyRetryPollingTimer) {
            clearTimeout(this.routerView.__storyRetryPollingTimer);
            this.routerView.__storyRetryPollingTimer = null;
        }

        if (this.routerView.__retryPollingTimer) {
            clearTimeout(this.routerView.__retryPollingTimer);
            this.routerView.__retryPollingTimer = null;
        }
    }

    renderSettingsPlaceholder() {
        if (!this.routerView) return;
        const savedTheme = localStorage.getItem('theme') || 'dark';
        const savedLayout = localStorage.getItem('layout') || 'default';
        
        this.routerView.innerHTML = `
            <div class="page-header" style="border-bottom: 1px solid var(--border-color); padding-bottom: 15px; margin-bottom: 20px;">
                <h2 style="margin: 0; color: var(--accent-color);">系统设置</h2>
            </div>
            <div class="page-content" style="max-width: 600px; display: flex; flex-direction: column; gap: 20px;">
                <div class="setting-group" style="background: var(--sidebar-bg); padding: 20px; border-radius: 8px; border: 1px solid var(--border-color);">
                    <h3 style="margin-top: 0; margin-bottom: 15px; font-size: 1.1rem;">界面外观</h3>
                    
                    <div style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 15px;">
                        <label style="font-weight: 500;">主题模式</label>
                        <select id="theme-select" style="padding: 8px; border-radius: 4px; background: var(--bg-color); color: var(--text-color); border: 1px solid var(--border-color); min-width: 150px;">
                            <option value="dark" ${savedTheme === 'dark' ? 'selected' : ''}>深色模式 (默认)</option>
                            <option value="light" ${savedTheme === 'light' ? 'selected' : ''}>浅色模式</option>
                        </select>
                    </div>

                    <div style="display: flex; align-items: center; justify-content: space-between;">
                        <label style="font-weight: 500;">列表布局</label>
                        <select id="layout-select" style="padding: 8px; border-radius: 4px; background: var(--bg-color); color: var(--text-color); border: 1px solid var(--border-color); min-width: 150px;">
                            <option value="default" ${savedLayout === 'default' ? 'selected' : ''}>网格视图</option>
                            <option value="compact" ${savedLayout === 'compact' ? 'selected' : ''}>紧凑列表</option>
                        </select>
                    </div>
                </div>

                <div class="setting-group" style="background: var(--sidebar-bg); padding: 20px; border-radius: 8px; border: 1px solid var(--border-color);">
                    <h3 style="margin-top: 0; margin-bottom: 15px; font-size: 1.1rem;">系统信息</h3>
                    <p style="margin: 5px 0; color: #8b949e; font-size: 0.9rem;">面板版本: v1.0.0</p>
                    <p style="margin: 5px 0; color: #8b949e; font-size: 0.9rem;">连接状态: <span id="ws-status" style="color: #3fb950;">已连接</span></p>
                </div>
                
                <button id="save-settings-btn" style="padding: 10px 20px; background: var(--accent-color); color: var(--bg-color); border: none; border-radius: 6px; cursor: pointer; font-weight: bold; align-self: flex-start; transition: opacity 0.2s;">
                    保存设置
                </button>
                <div id="save-msg" style="display: none; color: #3fb950; font-size: 0.9rem; margin-top: 10px;">设置已保存并生效！</div>
            </div>
        `;

        document.getElementById('save-settings-btn').addEventListener('click', () => {
            const theme = document.getElementById('theme-select').value;
            const layout = document.getElementById('layout-select').value;
            
            localStorage.setItem('theme', theme);
            localStorage.setItem('layout', layout);
            
            // Apply theme dynamically
            if (theme === 'light') {
                document.documentElement.style.setProperty('--bg-color', '#ffffff');
                document.documentElement.style.setProperty('--text-color', '#24292e');
                document.documentElement.style.setProperty('--sidebar-bg', '#f6f8fa');
                document.documentElement.style.setProperty('--border-color', '#e1e4e8');
            } else {
                document.documentElement.style.setProperty('--bg-color', '#0d1117');
                document.documentElement.style.setProperty('--text-color', '#f0f6fc');
                document.documentElement.style.setProperty('--sidebar-bg', '#161b22');
                document.documentElement.style.setProperty('--border-color', '#30363d');
            }

            // Apply layout dynamically if on stories page
            if (window.location.hash === '#/stories') {
                const storiesContainer = document.getElementById('stories-container');
                if (storiesContainer) {
                    storiesContainer.className = layout === 'compact' ? 'stories-content compact' : 'stories-content';
                }
            }

            const msg = document.getElementById('save-msg');
            msg.style.display = 'block';
            setTimeout(() => { msg.style.display = 'none'; }, 3000);
        });
    }

    async renderStoryReviewPage(storyId) {
        if (!this.routerView) return;

        this.routerView.innerHTML = `
            <div class="page-header" style="display: flex; align-items: center; margin-bottom: 20px; border-bottom: 1px solid var(--border-color); padding-bottom: 15px;">
                <a href="#/stories/${storyId}" style="color: var(--accent-color); text-decoration: none; margin-right: 15px; font-size: 1.2rem;">← 返回</a>
                <h2 style="margin: 0; flex: 1; color: var(--accent-color);">检查点评审</h2>
            </div>
            <div id="story-review-panel" style="height: calc(100vh - 220px); min-height: 640px; background: #ffffff; border-radius: 8px; overflow: hidden; border: 1px solid var(--border-color);">
                <div class="loading" style="padding: 24px;">正在加载审核内容...</div>
            </div>
        `;

        try {
            const response = await api.getStory(storyId);
            if (!response.success) {
                throw new Error(response.error || '加载故事失败');
            }

            const story = response.story || {};
            const checkpoint = story.workflow?.activeCheckpoint;

            if (!checkpoint || checkpoint.status !== 'pending') {
                const reviewContainer = document.getElementById('story-review-panel');
                if (reviewContainer) {
                    reviewContainer.innerHTML = `
                        <div style="padding: 40px; text-align: center; color: var(--text-color);">
                            <h3 style="margin-top: 0; color: var(--accent-color);">当前没有待审核的检查点</h3>
                            <p style="color: #8b949e; margin-bottom: 20px;">该故事目前不在待评审状态，可能已经被处理或工作流已继续执行。</p>
                            <a href="#/stories/${storyId}" style="display: inline-block; padding: 10px 18px; border-radius: 6px; text-decoration: none; background: var(--sidebar-bg); color: var(--text-color); border: 1px solid var(--border-color);">返回故事概览</a>
                        </div>
                    `;
                }
                return;
            }

            const reviewContainer = document.getElementById('story-review-panel');
            if (reviewContainer) {
                const payload = await this.loadReviewCheckpointPayload(api, storyId, checkpoint);
                const reviewCheckpoint = {
                    ...checkpoint,
                    payload
                };
                renderCheckpointReviewPanel(reviewContainer, store, api, storyId, reviewCheckpoint);
            }
        } catch (error) {
            const reviewContainer = document.getElementById('story-review-panel');
            if (reviewContainer) {
                reviewContainer.innerHTML = `
                    <div style="padding: 40px; text-align: center; color: #f85149;">
                        <h3 style="margin-top: 0;">加载审核内容失败</h3>
                        <p style="color: #8b949e; margin-bottom: 20px;">${error.message}</p>
                        <a href="#/stories/${storyId}" style="display: inline-block; padding: 10px 18px; border-radius: 6px; text-decoration: none; background: var(--sidebar-bg); color: var(--text-color); border: 1px solid var(--border-color);">返回故事概览</a>
                    </div>
                `;
            }
        }
    }

    async loadReviewCheckpointPayload(apiClient, storyId, checkpoint) {
        if (!checkpoint) return {};

        const [historyResponse, storyResponse] = await Promise.all([
            apiClient.getStoryHistory(storyId).catch(() => null),
            apiClient.getStory(storyId).catch(() => null)
        ]);
        const history = historyResponse?.history || [];
        const story = storyResponse?.story || {};
        const checkpointEntry = [...history].reverse().find((entry) => {
            return entry.type === 'checkpoint_created' &&
                entry.detail?.checkpointId === checkpoint.id;
        });
        const historyPayload = checkpointEntry?.detail?.data || {};
        const checkpointKind = resolveCheckpointKind(checkpoint.type);

        if (checkpointKind === 'phase1') {
            const [worldviewResponse, charactersResponse] = await Promise.all([
                apiClient.getStoryWorldview(storyId).catch(() => null),
                apiClient.getStoryCharacters(storyId).catch(() => null)
            ]);

            const fallbackCharacters = buildReviewCharacterGroups(charactersResponse?.characters || []);
            const historyCharacters = historyPayload.characters || {};

            return {
                worldview: historyPayload.worldview || worldviewResponse?.worldview || null,
                characters: Object.keys(historyCharacters).length > 0 ? historyCharacters : fallbackCharacters,
                validation: historyPayload.validation || null,
                status: worldviewResponse?.phase1Status || null,
                userConfirmed: worldviewResponse?.userConfirmed || false
            };
        }

        if (checkpointKind === 'phase2-outline') {
            return {
                outline: historyPayload.outline || story.phase2?.outline || null,
                chapters: normalizeReviewChapters(historyPayload.chapters || historyPayload.chapterResults || story.phase2?.chapters || []),
                phase2: story.phase2 || null
            };
        }

        if (checkpointKind === 'phase2-content') {
            return {
                chapters: normalizeReviewChapters(historyPayload.chapters || historyPayload.chapterResults || story.phase2?.chapters || []),
                outline: historyPayload.outline || story.phase2?.outline || null,
                phase2: story.phase2 || null
            };
        }

        if (checkpointKind === 'phase3-final') {
            return {
                chapters: normalizeReviewChapters(historyPayload.chapters || historyPayload.chapterResults || story.phase3?.polishedChapters || story.phase2?.chapters || []),
                polishedChapters: normalizeReviewChapters(historyPayload.polishedChapters || story.phase3?.polishedChapters || []),
                finalValidation: historyPayload.finalValidation || story.phase3?.finalValidation || null,
                finalEditorOutput: historyPayload.finalEditorOutput || story.phase3?.finalEditorOutput || '',
                qualityScores: historyPayload.qualityScores || story.phase3?.qualityScores || null,
                phase3: story.phase3 || null
            };
        }

        return historyPayload || {};
    }

    showError(message) {
        if (!this.routerView) return;
        this.routerView.innerHTML = `
            <div style="padding: 20px; color: #f85149; border: 1px solid #f85149; border-radius: 6px; margin: 20px;">
                <h3>Error</h3>
                <p>${message}</p>
                <p style="font-size: 0.9em; margin-top: 10px;">Check browser console for details.</p>
            </div>
        `;
    }
}

function buildReviewCharacterGroups(characters) {
    const list = Array.isArray(characters) ? characters : [];
    return {
        protagonists: list.filter((item) => item.roleCategory === 'protagonist'),
        supportingCharacters: list.filter((item) => item.roleCategory === 'supporting' || item.roleCategory === 'supportingCharacters'),
        antagonists: list.filter((item) => item.roleCategory === 'antagonist'),
        relationshipNetwork: {
            direct: [],
            hidden: []
        },
        oocRules: {}
    };
}

function normalizeReviewChapters(chapters) {
    const list = Array.isArray(chapters) ? chapters : [];
    return list.map((chapter, index) => ({
        ...chapter,
        number: chapter?.number || chapter?.chapterNum || chapter?.chapterNumber || index + 1,
        chapterNum: chapter?.chapterNum || chapter?.number || chapter?.chapterNumber || index + 1,
        title: chapter?.title || chapter?.chapterTitle || `第${chapter?.chapterNum || chapter?.number || chapter?.chapterNumber || index + 1}章`,
        content: chapter?.content || chapter?.text || chapter?.body || '',
        wordCount: chapter?.wordCount || chapter?.metrics?.counts?.actualCount || chapter?.metrics?.counts?.chineseChars || 0
    }));
}

function resolveCheckpointKind(type) {
    if (type === 'phase1_checkpoint' || type === 'worldview_confirmation') {
        return 'phase1';
    }

    if (type === 'outline_checkpoint' || type === 'outline_confirmation' || type === 'phase2_checkpoint' || type === 'phase2_outline_confirmation') {
        return 'phase2-outline';
    }

    if (type === 'content_checkpoint' || type === 'content_quality_confirmation' || type === 'phase2_content_confirmation') {
        return 'phase2-content';
    }

    if (type === 'final_checkpoint' || type === 'final_approval' || type === 'phase3_checkpoint') {
        return 'phase3-final';
    }

    return 'unknown';
}

// Initialize app
try {
    const app = new App();
    
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => {
            app.init().catch(err => {
                console.error('[App] Failed to initialize:', err);
            });
        });
    } else {
        app.init().catch(err => {
            console.error('[App] Failed to initialize:', err);
        });
    }
} catch (error) {
    console.error('[App] Critical error during setup:', error);
    document.body.innerHTML = `
        <div style="padding: 40px; color: #f85149; text-align: center;">
            <h2>Failed to Load Application</h2>
            <p>${error.message}</p>
            <pre style="text-align: left; background: rgba(0,0,0,0.3); padding: 20px; margin-top: 20px; overflow: auto;">${error.stack}</pre>
        </div>
    `;
}
