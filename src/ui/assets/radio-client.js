/** Browser side of the local radio API. */
window.LvxRadio = {
  async post(path, body) {
    const response = await fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      const { error } = await response.json();
      throw new Error(error);
    }
    return response.json();
  },

  tune(config, options = {}) {
    return this.post('/api/tune', { config, ...options });
  },

  prepare(config, identity) {
    return this.post('/api/prepare', { config, identity });
  },

  cancelPreparation() {
    return this.post('/api/prepare/cancel', {});
  },

  generateNow(trackId) {
    return this.post('/api/generate-now', { trackId });
  },

  dismissArrival() {
    return this.post('/api/arrival/dismiss', {});
  },

  cancelJob() {
    return this.post('/api/job/cancel', {});
  },

  renameStation(id, name) {
    return this.post('/api/station/name', { id, name });
  },

  steer(config) {
    return this.post('/api/steer', { config });
  },

  playback(state) {
    return this.post('/api/playback', state);
  },

  feedback(trackId, type) {
    return this.post('/api/feedback', { trackId, type });
  },

  setGeneration(enabled) {
    return this.post('/api/generation', { enabled });
  },

  async setupStatus() {
    const response = await fetch('/api/setup');
    return response.json();
  },

  downloadModel(acceptLicense) { return this.post('/api/setup/download', { acceptLicense }); },
  pauseModel() { return this.post('/api/setup/pause', {}); },

  async engineStatus() {
    const response = await fetch('/api/engine');
    return response.json();
  },

  async gpuPercent() {
    const response = await fetch('/api/gpu');
    return (await response.json()).percent;
  },

  /** Calls `listener` with each station snapshot. Returns the unsubscribe. */
  subscribe(listener) {
    const events = new EventSource('/api/events');
    events.onmessage = (event) => listener(JSON.parse(event.data));
    return () => events.close();
  },

  audioUrl(trackId) {
    return `/audio/${trackId}`;
  },
};
