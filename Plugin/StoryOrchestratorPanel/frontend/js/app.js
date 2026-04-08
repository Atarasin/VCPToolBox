import { events } from './core/events.js';
import { store } from './core/store.js';
import { api } from './core/api.js';
import { router } from './core/router.js';
import { wsClient } from './core/ws.js';
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

        this.setupRoutes();
        
        wsClient.connect();

        this.setupEventListeners();

        router.init();

        this.initialized = true;
        console.log('App initialized');
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
            console.log('Store updated:', data);
        });

        events.on('ws:connected', () => {
            console.log('WebSocket connected');
        });

        events.on('ws:disconnected', () => {
            console.log('WebSocket disconnected');
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
}

const app = new App();

document.addEventListener('DOMContentLoaded', () => {
    app.init().catch(err => {
        console.error('Failed to initialize app:', err);
    });
});
