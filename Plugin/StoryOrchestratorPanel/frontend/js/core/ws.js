import { events } from './events.js';
import { store } from './store.js';

class WebSocketClient {
  constructor() {
    this.socket = null;
    this.reconnectTimer = null;
    this.reconnectAttempts = 0;
    this.maxReconnectAttempts = 10;
    this.baseReconnectDelay = 1000;
  }

  connect() {
    if (this.socket && (this.socket.readyState === WebSocket.OPEN || this.socket.readyState === WebSocket.CONNECTING)) {
      return;
    }

    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${protocol}//${window.location.host}/ws`;
    
    try {
      this.socket = new WebSocket(wsUrl);
      
      this.socket.onopen = this._handleOpen.bind(this);
      this.socket.onmessage = this._handleMessage.bind(this);
      this.socket.onclose = this._handleClose.bind(this);
      this.socket.onerror = this._handleError.bind(this);
    } catch (error) {
      console.error('Failed to create WebSocket connection:', error);
      this._scheduleReconnect();
    }
  }

  disconnect() {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    
    if (this.socket) {
      this.socket.close();
      this.socket = null;
    }
  }

  _handleOpen() {
    console.log('WebSocket connected');
    this.reconnectAttempts = 0;
    store.setLiveConnection(true);
    events.emit('ws:connected');
    
    this._subscribeToStoryEvents();
  }

  _handleMessage(event) {
    try {
      const data = JSON.parse(event.data);
      
      if (data.type === 'story_orchestrator_event') {
        this._processStoryEvent(data.payload);
      }
    } catch (error) {
      console.error('Error parsing WebSocket message:', error);
    }
  }

  _handleClose(event) {
    console.log(`WebSocket closed: ${event.code} ${event.reason}`);
    store.setLiveConnection(false);
    events.emit('ws:disconnected');
    
    this._scheduleReconnect();
  }

  _handleError(error) {
    console.error('WebSocket error:', error);
  }

  _scheduleReconnect() {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
    }
    
    if (this.reconnectAttempts < this.maxReconnectAttempts) {
      const delay = Math.min(
        this.baseReconnectDelay * Math.pow(1.5, this.reconnectAttempts),
        10000
      );
      
      console.log(`Scheduling WebSocket reconnect in ${delay}ms...`);
      
      this.reconnectTimer = setTimeout(() => {
        this.reconnectAttempts++;
        this.connect();
      }, delay);
    } else {
      console.error('WebSocket max reconnect attempts reached');
      events.emit('ws:reconnect_failed');
    }
  }

  _subscribeToStoryEvents() {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) return;
    
    const message = {
      type: 'subscribe',
      channel: 'story_orchestrator'
    };
    
    this.socket.send(JSON.stringify(message));
  }

  _processStoryEvent(payload) {
    if (!payload || !payload.type) return;
    
    events.emit('story:event', payload);
    events.emit(`story:${payload.type}`, payload);
    
    const currentState = store.getState();
    const currentStoryId = currentState.currentStory?.id;
    
    if (payload.storyId && currentStoryId === payload.storyId) {
      events.emit('story:current:updated', payload);
    }
  }
}

export const wsClient = new WebSocketClient();