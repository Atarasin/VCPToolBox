import { events } from '../core/events.js';

export async function renderWorkflowTimeline(containerElement, store, api, storyId) {
  if (!containerElement || !storyId) return;

  containerElement.innerHTML = `
    <div class="workflow-timeline">
      <div class="timeline-header">
        <h3>Workflow History</h3>
        <div class="live-indicator">
          <span class="pulse-dot"></span> Live
        </div>
      </div>
      <div class="timeline-content" id="timeline-events-${storyId}">
        <div class="timeline-loading">Loading history...</div>
      </div>
    </div>
  `;

  const timelineContent = containerElement.querySelector(`#timeline-events-${storyId}`);
  let eventHistory = [];

  const getEventIcon = (eventType) => {
    switch (eventType) {
      case 'story_started':
      case 'started':
        return '<i class="fas fa-play-circle text-primary"></i>';
      case 'phase_started':
        return '<i class="fas fa-hourglass-half text-info"></i>';
      case 'phase_completed':
        return '<i class="fas fa-check-circle text-success"></i>';
      case 'phase_failed':
      case 'error':
        return '<i class="fas fa-times-circle text-danger"></i>';
      case 'checkpoint_pending':
        return '<i class="fas fa-hand-paper text-warning"></i>';
      case 'checkpoint_approved':
        return '<i class="fas fa-thumbs-up text-success"></i>';
      case 'checkpoint_rejected':
        return '<i class="fas fa-thumbs-down text-danger"></i>';
      case 'chapter_generated':
        return '<i class="fas fa-book-open text-primary"></i>';
      default:
        return '<i class="fas fa-info-circle text-secondary"></i>';
    }
  };

  const getEventColorClass = (eventType) => {
    if (eventType.includes('completed') || eventType.includes('approved') || eventType.includes('success')) return 'event-success';
    if (eventType.includes('failed') || eventType.includes('error') || eventType.includes('rejected')) return 'event-error';
    if (eventType.includes('pending') || eventType.includes('waiting')) return 'event-warning';
    return 'event-info';
  };

  const formatTimestamp = (timestamp) => {
    if (!timestamp) return '';
    const date = new Date(timestamp);
    return date.toLocaleString();
  };

  const renderPayload = (payload) => {
    if (!payload || Object.keys(payload).length === 0) return '';
    const payloadStr = JSON.stringify(payload, null, 2);
    return `
      <div class="timeline-payload-container mt-2">
        <button class="btn btn-sm btn-outline-secondary toggle-payload">
          <i class="fas fa-code"></i> Details
        </button>
        <pre class="timeline-payload d-none mt-2 p-2 bg-dark text-light rounded" style="font-size: 0.8rem; overflow-x: auto;"><code>${payloadStr}</code></pre>
      </div>
    `;
  };

  const createEventHTML = (event, isNew = false) => {
    const { type, timestamp, message, payload, phase } = event;
    const animationClass = isNew ? 'slide-down-fade-in' : '';
    
    const displayMessage = message || `Event: ${type} ${phase ? `(${phase})` : ''}`;

    return `
      <div class="timeline-item ${getEventColorClass(type)} ${animationClass}">
        <div class="timeline-icon">
          ${getEventIcon(type)}
        </div>
        <div class="timeline-body">
          <div class="timeline-meta">
            <span class="timeline-time text-muted small">${formatTimestamp(timestamp)}</span>
            <span class="badge bg-secondary timeline-type-badge ml-2">${type}</span>
          </div>
          <div class="timeline-message mt-1">
            ${displayMessage}
          </div>
          ${renderPayload(payload)}
        </div>
      </div>
    `;
  };

  const bindPayloadToggles = (container) => {
    const toggleBtns = container.querySelectorAll('.toggle-payload');
    toggleBtns.forEach(btn => {
      const newBtn = btn.cloneNode(true);
      btn.parentNode.replaceChild(newBtn, btn);
      
      newBtn.addEventListener('click', (e) => {
        const pre = e.target.closest('.timeline-payload-container').querySelector('.timeline-payload');
        if (pre.classList.contains('d-none')) {
          pre.classList.remove('d-none');
          e.target.innerHTML = '<i class="fas fa-chevron-up"></i> Hide';
        } else {
          pre.classList.add('d-none');
          e.target.innerHTML = '<i class="fas fa-code"></i> Details';
        }
      });
    });
  };

  const renderEvents = () => {
    if (eventHistory.length === 0) {
      timelineContent.innerHTML = '<div class="timeline-empty text-muted p-3 text-center">No events yet</div>';
      return;
    }

    const sortedEvents = [...eventHistory].sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
    
    timelineContent.innerHTML = sortedEvents.map(event => createEventHTML(event)).join('');
    bindPayloadToggles(timelineContent);
  };

  try {
    const historyData = await api.getStoryHistory(storyId);
    eventHistory = historyData || [];
    renderEvents();
  } catch (error) {
    console.error('Failed to fetch story history:', error);
    timelineContent.innerHTML = `<div class="alert alert-danger">Failed to load history: ${error.message}</div>`;
  }

  const unsubscribe = events.on('story:event', (eventData) => {
    if (eventData.storyId === storyId || eventData.story_id === storyId) {
      const normalizedEvent = {
        type: eventData.type || eventData.event_type || 'unknown',
        timestamp: eventData.timestamp || new Date().toISOString(),
        message: eventData.message,
        payload: eventData.payload || eventData.data || {},
        phase: eventData.phase
      };

      eventHistory.push(normalizedEvent);
      
      if (timelineContent.querySelector('.timeline-item')) {
        const eventHTML = createEventHTML(normalizedEvent, true);
        timelineContent.insertAdjacentHTML('afterbegin', eventHTML);
        bindPayloadToggles(timelineContent);
      } else {
        renderEvents();
      }
    }
  });

  return () => {
    if (unsubscribe) unsubscribe();
  };
}
