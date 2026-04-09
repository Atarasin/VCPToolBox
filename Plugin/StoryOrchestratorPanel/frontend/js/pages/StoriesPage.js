export async function renderStoriesPage(containerElement, store, api, router) {
  containerElement.innerHTML = `
    <div class="loading">正在加载故事列表...</div>
  `;

  try {
    const response = await api.getStories();
    const stories = response.data || response.stories || response || [];
    
    store.setStories(stories);
    
    if (!stories || stories.length === 0) {
      containerElement.innerHTML = `
        <div class="empty-state">
          <h2>暂无故事</h2>
          <p>请创建一个新的故事项目以开始创作。</p>
        </div>
      `;
      addStyles();
      return;
    }

    const needsReview = [];
    const retrying = [];
    const inProgress = [];
    const completed = [];

    stories.forEach(story => {
      if (story.isRetrying || String(story.status || '').includes('_retrying')) {
        retrying.push(story);
      } else if (story.status === 'checkpoint_pending' || story.checkpointPending) {
        needsReview.push(story);
      } else if (story.status === 'completed' || story.phase === 'completed') {
        completed.push(story);
      } else {
        inProgress.push(story);
      }
    });

    const savedLayout = localStorage.getItem('layout') || 'default';
    const contentClass = savedLayout === 'compact' ? 'stories-content compact' : 'stories-content';

    containerElement.innerHTML = `
      <div class="stories-page">
        <div class="stories-header">
          <h1>短文故事列表</h1>
          <div class="search-bar">
            <input type="text" id="story-search" placeholder="搜索故事名称或题材..." class="search-input">
          </div>
        </div>

        <div id="stories-container" class="${contentClass}">
          ${renderSection('重新生成中', retrying, 'retrying')}
          ${renderSection('待评审', needsReview, 'needs-review')}
          ${renderSection('创作中', inProgress, 'in-progress')}
          ${renderSection('已完成', completed, 'completed')}
        </div>
      </div>
    `;

    addStyles();
    attachEventListeners(containerElement, router, stories);
    attachRetryPolling(containerElement, store, api, router, stories);

  } catch (error) {
    console.error('Failed to load stories:', error);
    containerElement.innerHTML = `
      <div class="error-state">
        <h2>加载故事列表失败</h2>
        <p>${error.message || '发生了未知错误'}</p>
        <button id="retry-btn" class="btn">重试</button>
      </div>
    `;
    
    const retryBtn = containerElement.querySelector('#retry-btn');
    if (retryBtn) {
      retryBtn.addEventListener('click', () => renderStoriesPage(containerElement, store, api, router));
    }
  }
}

function renderSection(title, stories, className) {
  if (stories.length === 0) return '';

  return `
    <div class="story-section ${className}">
      <h2 class="section-title">
        ${title} <span class="badge">${stories.length}</span>
      </h2>
      <div class="story-grid">
        ${stories.map(story => renderStoryCard(story)).join('')}
      </div>
    </div>
  `;
}

function renderStoryCard(story) {
  const progress = calculateProgress(story);
  const shortStoryId = story.shortId || String(story.id || '').replace(/^story-/, '');
  const targetWordCountLabel = story.targetWordCountLabel || formatTargetWordCountLabel(story.targetWordCount);
  const checkpointBadge = (story.status === 'checkpoint_pending' || story.checkpointPending) 
    ? '<div class="card-badge review">需要评审</div>' 
    : '';
  const retryingBadge = story.isRetrying
    ? '<div class="card-badge retrying">重新生成中</div>'
    : '';
  
  // 美化显示阶段名称
  let phaseName = story.currentPhase || story.phase || '初始化';
  if (phaseName === 'phase1') phaseName = '世界观设定';
  if (phaseName === 'phase2') phaseName = '大纲与正文';
  if (phaseName === 'phase3') phaseName = '润色校验';
  if (story.retryingPhase === 'phase1') phaseName = '世界观设定 · 重新生成';
  if (story.retryingPhase === 'phase2') phaseName = '大纲与正文 · 重新生成';
  if (story.retryingPhase === 'phase3') phaseName = '润色校验 · 重新生成';

  const retryingHint = story.isRetrying ? `
    <div class="retrying-hint">
      <span class="retrying-dot"></span>
      正在根据退回意见重新生成内容，请稍候刷新查看结果
    </div>
  ` : '';

  return `
    <div class="story-card ${story.isRetrying ? 'retrying' : ''}" data-id="${story.id}">
      <div class="card-header">
        <div class="card-title-block">
          <h3 class="story-title" title="${story.title || '未命名故事'}">${story.title || '未命名故事'}</h3>
          <div class="story-id-line">
            <span class="story-id-label">ID</span>
            <span class="story-id-value">${shortStoryId || '未知'}</span>
          </div>
        </div>
        <div class="card-badge-group">
          ${retryingBadge}
          ${checkpointBadge}
        </div>
      </div>
      
      <div class="story-meta">
        <span class="meta-item genre">题材: ${story.genre || '未指定'}</span>
        <span class="meta-item phase">阶段: ${phaseName}</span>
        <span class="meta-item target-word-count">目标字数: ${targetWordCountLabel}</span>
      </div>
      ${retryingHint}
      
      <div class="progress-container">
        <div class="progress-bar-bg">
          <div class="progress-bar-fill ${story.isRetrying ? 'retrying' : ''}" style="width: ${progress}%"></div>
        </div>
        <div class="progress-text">${story.isRetrying ? '系统正在重试生成' : `已完成 ${progress}%`}</div>
      </div>
    </div>
  `;
}

function calculateProgress(story) {
  if (story.progress !== undefined) return story.progress;
  
  const phase = (story.currentPhase || story.phase || '').toLowerCase();
  switch (phase) {
    case 'initiation': return 10;
    case 'world_building': return 25;
    case 'character_design': return 40;
    case 'outline_creation': return 55;
    case 'chapter_generation': return 75;
    case 'completed': return 100;
    default: return 0;
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

function attachEventListeners(container, router, allStories) {
  const cards = container.querySelectorAll('.story-card');
  cards.forEach(card => {
    card.addEventListener('click', () => {
      const id = card.getAttribute('data-id');
      if (router && router.navigate) {
        router.navigate(`/stories/${id}`);
      } else {
        window.location.hash = `/stories/${id}`;
      }
    });
  });

  const searchInput = container.querySelector('#story-search');
  if (searchInput) {
    searchInput.addEventListener('input', (e) => {
      const searchTerm = e.target.value.toLowerCase();
      
      cards.forEach(card => {
        const title = card.querySelector('.story-title').textContent.toLowerCase();
        const genre = card.querySelector('.genre').textContent.toLowerCase();
        
        if (title.includes(searchTerm) || genre.includes(searchTerm)) {
          card.style.display = 'flex';
        } else {
          card.style.display = 'none';
        }
      });
      
      const sections = container.querySelectorAll('.story-section');
      sections.forEach(section => {
        const visibleCards = section.querySelectorAll('.story-card[style="display: flex;"], .story-card:not([style*="display: none"])');
        if (visibleCards.length === 0) {
          section.style.display = 'none';
        } else {
          section.style.display = 'block';
        }
      });
    });
  }
}

function attachRetryPolling(containerElement, store, api, router, stories) {
  if (!stories.some(story => story.isRetrying || String(story.status || '').includes('_retrying'))) {
    return;
  }

  if (containerElement.__retryPollingTimer) {
    clearTimeout(containerElement.__retryPollingTimer);
  }

  containerElement.__retryPollingTimer = setTimeout(() => {
    renderStoriesPage(containerElement, store, api, router);
  }, 5000);
}

function addStyles() {
  if (document.getElementById('stories-page-styles')) return;

  const styleEl = document.createElement('style');
  styleEl.id = 'stories-page-styles';
  styleEl.textContent = `
    .stories-page {
      display: flex;
      flex-direction: column;
      gap: 20px;
      height: 100%;
    }

    .stories-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 20px;
    }

    .stories-header h1 {
      margin: 0;
      color: var(--text-color);
    }

    .search-input {
      padding: 8px 12px;
      border-radius: 6px;
      border: 1px solid var(--border-color);
      background-color: var(--sidebar-bg);
      color: var(--text-color);
      width: 250px;
    }

    .search-input:focus {
      outline: none;
      border-color: var(--accent-color);
    }

    .stories-content {
      display: flex;
      flex-direction: column;
      gap: 30px;
    }

    .section-title {
      font-size: 1.2rem;
      color: var(--text-color);
      margin-top: 0;
      margin-bottom: 15px;
      display: flex;
      align-items: center;
      gap: 10px;
    }

    .badge {
      background-color: rgba(139, 148, 158, 0.2);
      color: var(--text-color);
      padding: 2px 8px;
      border-radius: 12px;
      font-size: 0.8rem;
    }

    .story-grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(300px, 1fr));
      gap: 20px;
    }

    .story-card {
      background-color: var(--sidebar-bg);
      border: 1px solid var(--border-color);
      border-radius: 8px;
      padding: 16px;
      cursor: pointer;
      display: flex;
      flex-direction: column;
      gap: 12px;
      transition: transform 0.2s, border-color 0.2s, box-shadow 0.2s;
    }

    .story-card.retrying {
      border-color: rgba(88, 166, 255, 0.35);
      box-shadow: 0 0 0 1px rgba(88, 166, 255, 0.15);
    }

    .story-card:hover {
      transform: translateY(-2px);
      border-color: var(--accent-color);
      box-shadow: 0 4px 12px rgba(0,0,0,0.2);
    }

    .card-header {
      display: flex;
      justify-content: space-between;
      align-items: flex-start;
      gap: 10px;
    }

    .card-title-block {
      min-width: 0;
      display: flex;
      flex-direction: column;
      gap: 8px;
      flex: 1;
    }

    .story-title {
      margin: 0;
      font-size: 1.1rem;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      color: var(--text-color);
    }

    .story-id-line {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      align-self: flex-start;
      max-width: 100%;
      padding: 4px 10px;
      border-radius: 999px;
      background: rgba(88, 166, 255, 0.08);
      border: 1px solid rgba(88, 166, 255, 0.2);
      color: #8b949e;
      font-size: 0.78rem;
    }

    .story-id-label {
      color: var(--accent-color);
      font-weight: 600;
      letter-spacing: 0.04em;
    }

    .story-id-value {
      color: var(--text-color);
      font-family: 'SFMono-Regular', Consolas, 'Liberation Mono', Menlo, monospace;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      max-width: 180px;
    }

    .card-badge {
      font-size: 0.75rem;
      padding: 3px 8px;
      border-radius: 12px;
      white-space: nowrap;
    }

    .card-badge-group {
      display: flex;
      gap: 8px;
      flex-wrap: wrap;
      justify-content: flex-end;
    }

    .card-badge.review {
      background-color: rgba(210, 153, 34, 0.15);
      color: #d29922;
      border: 1px solid rgba(210, 153, 34, 0.4);
    }

    .card-badge.retrying {
      background-color: rgba(88, 166, 255, 0.12);
      color: #79c0ff;
      border: 1px solid rgba(88, 166, 255, 0.35);
    }

    .story-meta {
      display: flex;
      flex-direction: column;
      gap: 4px;
      font-size: 0.85rem;
      color: #8b949e;
    }

    .progress-container {
      margin-top: auto;
      display: flex;
      flex-direction: column;
      gap: 6px;
    }

    .progress-bar-bg {
      height: 6px;
      background-color: rgba(139, 148, 158, 0.2);
      border-radius: 3px;
      overflow: hidden;
    }

    .progress-bar-fill {
      height: 100%;
      background-color: var(--accent-color);
      border-radius: 3px;
    }

    .progress-bar-fill.retrying {
      background: linear-gradient(90deg, #58a6ff, #79c0ff, #58a6ff);
      background-size: 200% 100%;
      animation: retryingProgressShift 1.8s linear infinite;
    }

    .progress-text {
      font-size: 0.8rem;
      color: #8b949e;
      text-align: right;
    }

    .retrying-hint {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 10px 12px;
      border-radius: 10px;
      background: rgba(88, 166, 255, 0.08);
      border: 1px solid rgba(88, 166, 255, 0.18);
      color: #b6d9ff;
      font-size: 0.82rem;
      line-height: 1.6;
    }

    .retrying-dot {
      width: 8px;
      height: 8px;
      border-radius: 50%;
      background: #58a6ff;
      box-shadow: 0 0 0 0 rgba(88, 166, 255, 0.5);
      animation: retryingPulse 1.6s infinite;
      flex: none;
    }

    @keyframes retryingPulse {
      0% { box-shadow: 0 0 0 0 rgba(88, 166, 255, 0.5); }
      70% { box-shadow: 0 0 0 8px rgba(88, 166, 255, 0); }
      100% { box-shadow: 0 0 0 0 rgba(88, 166, 255, 0); }
    }

    @keyframes retryingProgressShift {
      0% { background-position: 0% 50%; }
      100% { background-position: 200% 50%; }
    }

    .stories-content.compact .story-grid {
      grid-template-columns: 1fr;
      gap: 10px;
    }

    .stories-content.compact .story-card {
      flex-direction: row;
      align-items: center;
      padding: 12px 16px;
    }

    .stories-content.compact .card-header {
      flex: 1;
      margin-bottom: 0;
    }

    .stories-content.compact .story-meta {
      flex: 1;
      flex-direction: row;
      gap: 20px;
      justify-content: center;
    }

    .stories-content.compact .progress-container {
      flex: 1;
      margin-top: 0;
    }

    .empty-state, .error-state {
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      height: 100%;
      color: #8b949e;
    }

    .btn {
      padding: 8px 16px;
      background-color: var(--sidebar-bg);
      border: 1px solid var(--border-color);
      color: var(--text-color);
      border-radius: 6px;
      cursor: pointer;
      margin-top: 15px;
      transition: background-color 0.2s;
    }

    .btn:hover {
      background-color: rgba(139, 148, 158, 0.2);
    }
  `;
  document.head.appendChild(styleEl);
}
