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
            renderStoriesPage(this.routerView, store, api);
        });

        router.register('/stories/:id', (params) => {
            renderStorySummaryPage(this.routerView, store, api, params.id);
        });

        router.register('/stories/:id/bible', (params) => {
            renderStoryBiblePage(this.routerView, store, api, params.id);
        });

        router.register('/stories/:id/outline', (params) => {
            renderOutlinePage(this.routerView, store, api, params.id);
        });

        router.register('/stories/:id/chapters', (params) => {
            renderChapterReaderPage(this.routerView, store, api, params.id, 1);
        });

        router.register('/stories/:id/chapters/:num', (params) => {
            renderChapterReaderPage(this.routerView, store, api, params.id, params.num);
        });

        router.register('/stories/:id/quality', (params) => {
            renderQualityPage(this.routerView, store, api, params.id);
        });

        router.register('/stories/:id/final', (params) => {
            renderFinalOutputPage(this.routerView, store, api, params.id);
        });

        router.register('/review-queue', () => {
            renderReviewQueuePage(this.routerView, store, api);
        });

        router.register('/settings', () => {
            this.renderSettingsPlaceholder();
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

    renderSettingsPlaceholder() {
        if (!this.routerView) return;
        this.routerView.innerHTML = `
            <div class="page-header">
                <h2>Settings</h2>
            </div>
            <div class="page-content">
                <p>Settings will be implemented here.</p>
            </div>
        `;
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
