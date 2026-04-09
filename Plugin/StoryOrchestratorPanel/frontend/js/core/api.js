const API_PREFIX = '/admin_api/story-orchestrator-panel';

class ApiClient {
  async _request(endpoint, options = {}) {
    const url = `${API_PREFIX}${endpoint}`;
    
    const defaultOptions = {
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json'
      }
    };
    
    const mergedOptions = {
      ...defaultOptions,
      ...options,
      headers: {
        ...defaultOptions.headers,
        ...(options.headers || {})
      }
    };
    
    if (mergedOptions.body && typeof mergedOptions.body === 'object') {
      mergedOptions.body = JSON.stringify(mergedOptions.body);
    }
    
    try {
      const response = await fetch(url, mergedOptions);
      
      if (!response.ok) {
        const errorText = await response.text();
        let errorData;
        try {
          errorData = JSON.parse(errorText);
        } catch (e) {
          errorData = { message: errorText };
        }
        
        throw new Error(errorData.error || errorData.message || `API Error: ${response.status}`);
      }
      
      const contentType = response.headers.get('content-type');
      if (contentType && contentType.includes('application/json')) {
        return await response.json();
      }
      
      return await response.text();
    } catch (error) {
      console.error(`API request failed: ${url}`, error);
      throw error;
    }
  }

  async getStories() {
    return this._request('/stories');
  }

  async getStory(id) {
    return this._request(`/stories/${id}`);
  }

  async getStoryChapters(id) {
    return this._request(`/stories/${id}/chapters`);
  }
  
  async getStoryChapter(id, chapterNumber) {
    return this._request(`/stories/${id}/chapters/${chapterNumber}`);
  }

  async getStoryCharacters(id) {
    return this._request(`/stories/${id}/characters`);
  }

  async getStoryWorldview(id) {
    return this._request(`/stories/${id}/worldview`);
  }

  async getStoryOutline(id) {
    return this._request(`/stories/${id}/outline`);
  }

  async getStoryHistory(id) {
    return this._request(`/stories/${id}/history`);
  }

  async approveCheckpoint(storyId, checkpointId) {
    return this._request(`/stories/${storyId}/checkpoints/${checkpointId}/approve`, {
      method: 'POST'
    });
  }

  async rejectCheckpoint(storyId, checkpointId, feedback) {
    return this._request(`/stories/${storyId}/checkpoints/${checkpointId}/reject`, {
      method: 'POST',
      body: { feedback }
    });
  }

  async recoverStory(storyId) {
    return this._request(`/stories/${storyId}/recover`, {
      method: 'POST'
    });
  }

  async retryPhase(storyId) {
    return this._request(`/stories/${storyId}/retry-phase`, {
      method: 'POST'
    });
  }

  async exportStory(storyId) {
    return this._request(`/stories/${storyId}/export`, {
      method: 'POST'
    });
  }
}

export const api = new ApiClient();
