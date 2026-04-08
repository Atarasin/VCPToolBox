const initialState = {
  stories: [],
  currentStory: null,
  timeline: [],
  reviewQueue: [],
  chapterMap: {},
  liveConnection: false,
  ui: {
    loading: false,
    error: null,
    activeModal: null
  },
  pendingActions: []
};

class Store {
  constructor() {
    this._state = { ...initialState };
    this._listeners = [];
  }

  getState() {
    return this._state;
  }

  setState(partial) {
    this._state = { ...this._state, ...partial };
    this._listeners.forEach(fn => fn(this._state));
  }

  subscribe(fn) {
    this._listeners.push(fn);
    return () => {
      this._listeners = this._listeners.filter(listener => listener !== fn);
    };
  }
  
  setStories(stories) {
    this.setState({ stories });
  }

  setCurrentStory(currentStory) {
    this.setState({ currentStory });
  }

  setTimeline(timeline) {
    this.setState({ timeline });
  }

  setReviewQueue(reviewQueue) {
    this.setState({ reviewQueue });
  }

  setChapterMap(chapterMap) {
    this.setState({ chapterMap });
  }

  setLiveConnection(liveConnection) {
    this.setState({ liveConnection });
  }

  setUiState(partialUiState) {
    this.setState({
      ui: { ...this._state.ui, ...partialUiState }
    });
  }

  setPendingActions(pendingActions) {
    this.setState({ pendingActions });
  }

  addPendingAction(action) {
    this.setState({
      pendingActions: [...this._state.pendingActions, action]
    });
  }

  removePendingAction(actionId) {
    this.setState({
      pendingActions: this._state.pendingActions.filter(a => a.id !== actionId)
    });
  }

  reset() {
    this.setState({ ...initialState });
  }
}

export const store = new Store();