export async function renderStoriesPage(containerElement, store, api, router) {
  containerElement.innerHTML = `
    <div class="loading">Loading stories...</div>
  `;

  try {
    const response = await api.getStories();
    const stories = response.data || response.stories || response || [];
    
    store.setStories(stories);
    
    if (!stories || stories.length === 0) {
      containerElement.innerHTML = `
        <div class="empty-state">
          <h2>No stories yet</h2>
          <p>Create a new story to get started.</p>
        </div>
      `;
      addStyles();
      return;
    }

    const needsReview = [];
    const inProgress = [];
    const completed = [];

    stories.forEach(story => {
      if (story.status === 'checkpoint_pending' || story.checkpointPending) {
        needsReview.push(story);
      } else if (story.status === 'completed' || story.phase === 'completed') {
        completed.push(story);
      } else {
        inProgress.push(story);
      }
    });

    containerElement.innerHTML = `
      <div class="stories-page">
        <div class="stories-header">
          <h1>Stories</h1>
          <div class="search-bar">
            <input type="text" id="story-search" placeholder="Search stories..." class="search-input">
          </div>
        </div>

        <div class="stories-content" id="stories-container">
          ${renderSection('Needs Review', needsReview, 'needs-review')}
          ${renderSection('In Progress', inProgress, 'in-progress')}
          ${renderSection('Completed', completed, 'completed')}
        </div>
      </div>
    `;

    addStyles();
    attachEventListeners(containerElement, router, stories);

  } catch (error) {
    console.error('Failed to load stories:', error);
    containerElement.innerHTML = `
      <div class="error-state">
        <h2>Failed to load stories</h2>
        <p>${error.message || 'Unknown error occurred'}</p>
        <button id="retry-btn" class="btn">Retry</button>
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
  const checkpointBadge = (story.status === 'checkpoint_pending' || story.checkpointPending) 
    ? '<div class="card-badge review">Needs Review</div>' 
    : '';

  return `
    <div class="story-card" data-id="${story.id}">
      <div class="card-header">
        <h3 class="story-title" title="${story.title || 'Untitled'}">${story.title || 'Untitled'}</h3>
        ${checkpointBadge}
      </div>
      
      <div class="story-meta">
        <span class="meta-item genre">${story.genre || 'Unspecified genre'}</span>
        <span class="meta-item phase">Phase: ${story.currentPhase || story.phase || 'Initiation'}</span>
      </div>
      
      <div class="progress-container">
        <div class="progress-bar-bg">
          <div class="progress-bar-fill" style="width: ${progress}%"></div>
        </div>
        <div class="progress-text">${progress}% Completed</div>
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

    .story-title {
      margin: 0;
      font-size: 1.1rem;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      color: var(--text-color);
    }

    .card-badge {
      font-size: 0.75rem;
      padding: 3px 8px;
      border-radius: 12px;
      white-space: nowrap;
    }

    .card-badge.review {
      background-color: rgba(210, 153, 34, 0.15);
      color: #d29922;
      border: 1px solid rgba(210, 153, 34, 0.4);
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

    .progress-text {
      font-size: 0.8rem;
      color: #8b949e;
      text-align: right;
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
