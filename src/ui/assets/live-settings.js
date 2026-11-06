/** Settings presentation only. Main-process API/SSE owns every saved setting. */
window.LvxLiveSettings = class {
  constructor({ onChange, onModel, onListen, getModel }) {
    this.onChange = onChange; this.onModel = onModel; this.onListen = onListen; this.getModel = getModel;
    this.dialog = document.createElement('dialog');
    this.dialog.className = 'lvx-settings';
    this.dialog.setAttribute('aria-labelledby', 'lvx-settings-title');
    this.dialog.innerHTML = `
      <form class="lvx-settings-form">
        <div class="lvx-settings-top"><span class="lvx-settings-kicker">YOUR RADIO, YOUR WAY</span><button class="lvx-settings-close" type="button" aria-label="Close settings">×</button></div>
        <div class="lvx-welcome">
          <img src="assets/logo-symbol.png" alt="" class="lvx-settings-logo">
          <h1 id="lvx-settings-title">A little choice.<br>A lot of music.</h1>
          <p>The included LVX stations are already yours to enjoy. Add <strong>LVX Live</strong> to hear new songs and discover stations as they are published.</p>
          <div class="lvx-settings-reassurance"><i></i><div><strong>Your music stays.</strong><p>Included and previously downloaded songs are kept. Live streams use your connection, without downloading the whole catalog. Creating your own music stays on your Mac.</p></div></div>
          <div class="lvx-settings-actions"><button class="lvx-settings-secondary lvx-keep-local" type="button">Keep included stations</button><button class="lvx-settings-primary lvx-enable-live" type="button">Set up LVX Live ↗</button></div>
          <p class="lvx-settings-note">You can change this any time in Settings.</p>
        </div>
        <div class="lvx-settings-body" hidden>
          <button class="lvx-settings-back" type="button" hidden>← Settings</button>
          <h1 id="lvx-settings-heading" tabindex="-1">Settings</h1>
          <div class="lvx-settings-menu">
            <button class="lvx-live-open lvx-settings-option" type="button"><span>LVX Live stations</span><span aria-hidden="true">›</span></button>
            <button class="lvx-model-open lvx-settings-option" type="button"><span>Music setup</span><span aria-hidden="true">›</span></button>
            <button class="lvx-voice-open lvx-settings-option" type="button"><span>News</span><span aria-hidden="true">›</span></button>
          </div>
          <div class="lvx-settings-live" hidden>
          <div class="lvx-live-power-row"><button type="button" class="lvx-live-power" aria-label="LVX Live stations" aria-pressed="false"><i></i><b></b></button><div><strong>LVX Live stations</strong><p>Stream new songs. Discover new stations.</p></div><span class="lvx-live-state">OFF</span></div>
          <p class="lvx-live-explanation">Your included stations keep playing. No live catalog requests while this is off.</p>
          <details class="lvx-catalog-details"><summary>Station catalog</summary><label for="lvx-catalog-url">Catalog address</label><input id="lvx-catalog-url" type="url" maxlength="2048" autocomplete="off" spellcheck="false" placeholder="https://…/catalog.json"><p class="lvx-settings-note">The public catalog.json URL. An HTTP address on your local network also works for a LAN test.</p></details>
          <label class="lvx-refresh-label" for="lvx-refresh-minutes">Check for new music</label><select id="lvx-refresh-minutes"><option value="5">Every 5 minutes</option><option value="15">Every 15 minutes</option><option value="30">Every 30 minutes</option><option value="60">Every hour</option><option value="0">Only when I refresh</option></select>
          <div class="lvx-live-status" role="status" aria-live="polite"><i></i><span></span></div>
          <div class="lvx-settings-actions"><button class="lvx-settings-secondary lvx-settings-refresh" type="button" aria-label="Refresh stations"><svg width="17" height="17" viewBox="0 0 32 32" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M7 13a9.5 9.5 0 0 1 16.5-3.2L26 13m0 0-5-.5m5 .5-.2-5M25 19a9.5 9.5 0 0 1-16.5 3.2L6 19m0 0 5 .5M6 19l.2 5"></path></svg><span>Refresh stations</span></button><button class="lvx-settings-primary lvx-settings-save" type="submit">Save settings ↗</button></div>
          </div>
          <div class="lvx-settings-voice" hidden>
            <h2 class="lvx-news-heading">Sources</h2>
            <p class="lvx-settings-note">Each bulletin takes the newest stories from the sources that are on, up to five in all. Add an RSS or Atom feed you care about.</p>
            <div class="lvx-feed-list"></div>
            <div class="lvx-feed-add"><input class="lvx-feed-url" type="url" maxlength="500" autocomplete="off" spellcheck="false" placeholder="https://…/rss.xml" aria-label="Feed address"><input class="lvx-feed-name" type="text" maxlength="40" autocomplete="off" placeholder="Name (optional)" aria-label="Feed name"><select class="lvx-feed-language" aria-label="Language of the feed"><option value="en">English</option><option value="it">Italian</option></select><button class="lvx-feed-add-button lvx-settings-secondary" type="button">Add source</button></div>
            <p class="lvx-feed-error" role="alert" hidden></p>
            <h2 class="lvx-news-heading">Voice</h2>
            <p class="lvx-voice-status lvx-settings-kicker" role="status" aria-live="polite"></p>
            <p class="lvx-voice-intro">LVX News is read aloud by Qwen3-TTS, a voice that runs on your Mac. It is one download of 4.5 GB, then it works offline.</p>
            <div class="setup-progress lvx-voice-progress" role="progressbar" aria-label="Voice download" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0"><i></i></div>
            <p class="lvx-voice-detail"></p>
            <p class="lvx-voice-error" role="alert" hidden></p>
            <p class="lvx-settings-note">Qwen3-TTS is released under the <a href="https://huggingface.co/Qwen/Qwen3-TTS-12Hz-1.7B-CustomVoice/blob/0c0e3051f131929182e2c023b9537f8b1c68adfe/README.md" target="_blank" rel="noopener">Apache-2.0 licence</a>. The voice is synthetic: say so when you publish a bulletin.</p>
            <div class="lvx-voice-actions">
              <button class="lvx-voice-download lvx-settings-primary" type="button">Download voice</button>
              <button class="lvx-voice-pause lvx-settings-secondary" type="button" hidden>Pause</button>
            </div>
          </div>
          <div class="lvx-settings-music" hidden>
            <p class="lvx-model-status lvx-settings-kicker" role="status" aria-live="polite"></p>
            <p class="lvx-model-intro">Create your own stations with YuE2. Your model and songs stay on your Mac.</p>
            <div class="setup-components lvx-model-files"></div>
            <div class="setup-progress lvx-model-progress" role="progressbar" aria-label="Model download" aria-valuemin="0" aria-valuemax="100"><i></i></div>
            <p class="lvx-model-detail"></p>
            <p class="lvx-model-error" role="alert" hidden></p>
            <button class="lvx-model-retry lvx-settings-secondary" type="button" hidden>Check again</button>
            <label class="setup-license lvx-model-license" hidden><input type="checkbox"><span>I accept the <a href="https://github.com/multimodal-art-projection/YuE/blob/cbb3b060725ddd95ac6e6237cfb709e153da5988/MODEL_LICENSE" target="_blank" rel="noopener">YuE2 model terms</a>. Individuals can monetize their music; commercial use by companies needs a separate license.</span></label>
            <div class="lvx-model-actions">
              <button class="lvx-model-download lvx-settings-primary" type="button" hidden>Download music model</button>
              <button class="lvx-model-choose lvx-settings-secondary" type="button" hidden>I already have the model</button>
              <button class="lvx-model-pause lvx-settings-secondary" type="button" hidden>Pause setup</button>
              <button class="lvx-model-continue lvx-settings-primary" type="button" hidden>Create your station ↗</button>
            </div>
            <p class="setup-playing lvx-model-playing"></p>
          </div>
        </div>
        <p class="lvx-settings-error" role="alert" hidden></p>
      </form>`;
    document.body.append(this.dialog);
    this.find = selector => this.dialog.querySelector(selector);
    this.find('form').addEventListener('submit', event => { event.preventDefault(); if (this.page === 'live') void this.save(); });
    this.find('.lvx-settings-close').addEventListener('click', () => this.close());
    this.dialog.addEventListener('cancel', event => { if (!this.value?.choiceMade) { event.preventDefault(); this.welcome(); } });
    this.find('.lvx-keep-local').addEventListener('click', () => void this.save(false, true));
    this.find('.lvx-enable-live').addEventListener('click', () => { this.open(); this.showPage('live'); this.draftEnabled = true; this.renderDraft(); });
    this.find('.lvx-live-power').addEventListener('click', () => { this.draftEnabled = !this.draftEnabled; this.renderDraft(); });
    this.find('.lvx-settings-refresh').addEventListener('click', () => void this.refresh());
    this.find('.lvx-settings-back').addEventListener('click', () => this.showPage('menu'));
    this.find('.lvx-live-open').addEventListener('click', () => this.showPage('live'));
    this.find('.lvx-model-open').addEventListener('click', () => { this.showPage('music'); this.onModel(); });
    this.find('.lvx-voice-open').addEventListener('click', () => this.showPage('voice'));
    this.find('.lvx-feed-add-button').addEventListener('click', () => void this.addFeed());
    this.find('.lvx-feed-url').addEventListener('keydown', event => { if (event.key === 'Enter') { event.preventDefault(); void this.addFeed(); } });
    this.find('.lvx-voice-download').addEventListener('click', () => void this.voiceAction('download'));
    this.find('.lvx-voice-pause').addEventListener('click', () => void this.voiceAction('pause'));
    this.dialog.addEventListener('close', () => this.stopVoicePoll());
    for (const [name, action] of Object.entries({ download:'setupDownload', choose:'setupChoose', pause:'setupPause', retry:'setupRetry', continue:'setupContinue' })) {
      this.find(`.lvx-model-${name}`).addEventListener('click', () => { if (name === 'continue') this.dialog.close(); this.modelValues?.[action](); });
    }
    this.find('.lvx-model-license input').addEventListener('change', event => this.modelValues?.setupAcceptChange(event));
    for (const selector of ['#lvx-catalog-url','#lvx-refresh-minutes']) this.find(selector).addEventListener('input', () => this.renderDraft());
  }

  update(value) {
    if (!value || this.key === JSON.stringify(value)) return;
    this.key = JSON.stringify(value); this.value = value; this.onChange(value);
    this.renderStatus();
    if (!value.choiceMade && !this.dialog.open) this.welcome();
  }

  welcome() {
    this.find('.lvx-welcome').hidden = false; this.find('.lvx-settings-body').hidden = true;
    this.find('.lvx-settings-close').hidden = true; this.error('');
    this.dialog.setAttribute('aria-labelledby','lvx-settings-title');
    if (!this.dialog.open) this.dialog.showModal();
  }

  open = () => {
    this.find('.lvx-welcome').hidden = true; this.find('.lvx-settings-body').hidden = false;
    this.dialog.setAttribute('aria-labelledby','lvx-settings-heading');
    this.find('.lvx-settings-close').hidden = false;
    this.draftEnabled = !!this.value?.enabled;
    this.find('#lvx-catalog-url').value = this.value?.url ?? '';
    this.find('#lvx-refresh-minutes').value = String(this.value?.refreshMinutes ?? 30);
    this.find('.lvx-catalog-details').open = !this.value?.url;
    this.error(''); this.renderDraft(); this.renderStatus();
    this.showPage('menu', false);
    if (!this.dialog.open) this.dialog.showModal();
  };

  showPage(page, focus = true) {
    const previous = this.page;
    this.page = page;
    this.find('.lvx-settings-menu').hidden = page !== 'menu';
    this.find('.lvx-settings-live').hidden = page !== 'live';
    this.find('.lvx-settings-music').hidden = page !== 'music';
    this.find('.lvx-settings-voice').hidden = page !== 'voice';
    this.find('.lvx-settings-back').hidden = page === 'menu';
    this.find('#lvx-settings-heading').textContent = page === 'live' ? 'LVX Live stations' : page === 'music' ? 'Music setup' : page === 'voice' ? 'News' : 'Settings';
    this.error('');
    if (page === 'music') this.updateModel(this.getModel());
    if (page === 'voice') this.startVoicePoll(); else this.stopVoicePoll();
    this.dialog.scrollTop = 0;
    if (focus) {
      const target = page === 'menu' ? previous === 'music' ? '.lvx-model-open' : previous === 'voice' ? '.lvx-voice-open' : '.lvx-live-open' : '#lvx-settings-heading';
      this.find(target).focus();
    }
  }

  updateModel(values) {
    this.modelValues = values;
    if (this.page !== 'music') return;
    const setText = (selector, text) => { const node = this.find(selector); if (node.textContent !== text) node.textContent = text; };
    setText('.lvx-model-status', values.setupStatus);
    setText('.lvx-model-detail', values.setupDetail);
    setText('.lvx-model-playing', values.setupNowPlaying);
    setText('.lvx-model-error', values.setupError);
    this.find('.lvx-model-error').hidden = !values.hasSetupError;
    this.find('.lvx-model-retry').hidden = !values.hasSetupError;
    const filesKey = JSON.stringify(values.setupFiles);
    if (this.modelFilesKey !== filesKey) {
      this.modelFilesKey = filesKey;
      this.find('.lvx-model-files').replaceChildren(...values.setupFiles.map(file => {
        const row = document.createElement('div'); row.className = `setup-component ${file.className}`;
        const name = document.createElement('span'); name.textContent = file.name;
        const status = document.createElement('strong'); status.textContent = file.status;
        row.append(name, status); return row;
      }));
    }
    this.find('.lvx-model-progress').setAttribute('aria-valuenow', String(parseFloat(values.setupPercent)));
    this.find('.lvx-model-progress i').style.width = values.setupProgress;
    this.find('.lvx-model-license').hidden = !values.setupCanDownload;
    this.find('.lvx-model-license input').checked = values.setupAccept;
    this.find('.lvx-model-license input').disabled = values.setupAcceptDisabled;
    for (const [name, visible] of Object.entries({ download:values.setupCanDownload, choose:values.setupCanChoose, pause:values.setupCanPause, continue:values.setupReady })) this.find(`.lvx-model-${name}`).hidden = !visible;
    for (const name of ['download', 'choose']) this.find(`.lvx-model-${name}`).disabled = values.setupDownloadDisabled;
    setText('.lvx-model-download', values.setupDownloadLabel);
  }

  /** Opens Settings on one page ('live', 'music' or 'voice'); the menu bar of the app calls it. */
  openPage(page) { this.open(); this.showPage(page, false); if (page === 'music') this.onModel(); }

  startVoicePoll() {
    this.stopVoicePoll();
    const tick = async () => {
      try { this.renderVoice(await (await fetch('/api/news/voice')).json()); } catch { /* the next tick tries again */ }
      try { this.renderFeeds((await (await fetch('/api/news')).json()).feeds); } catch { /* the next tick tries again */ }
    };
    void tick();
    this.voiceTimer = setInterval(tick, 1000);
  }

  stopVoicePoll() { clearInterval(this.voiceTimer); this.voiceTimer = null; }

  async voiceAction(name) {
    try { this.renderVoice(await window.LvxRadio.post(name === 'pause' ? '/api/news/voice/pause' : '/api/news/voice/download', {})); }
    catch (error) { this.error(error.message); }
  }

  async feedAction(body) {
    const error = this.find('.lvx-feed-error');
    error.hidden = true;
    try { this.renderFeeds((await window.LvxRadio.post('/api/news/feeds', body)).feeds); return true; }
    catch (failure) { error.textContent = failure.message; error.hidden = false; this.renderFeeds(this.feedsValue, true); return false; }
  }

  async addFeed() {
    const url = this.find('.lvx-feed-url'), name = this.find('.lvx-feed-name'), button = this.find('.lvx-feed-add-button');
    if (!url.value.trim() || button.disabled) return;
    button.disabled = true; button.textContent = 'Checking…';
    if (await this.feedAction({ add: { url: url.value.trim(), name: name.value.trim(), language: this.find('.lvx-feed-language').value } })) { url.value = ''; name.value = ''; }
    button.disabled = false; button.textContent = 'Add source';
  }

  renderFeeds(feeds, force = false) {
    if (!Array.isArray(feeds)) return;
    const key = JSON.stringify(feeds);
    if (!force && key === this.feedsKey) return;
    this.feedsKey = key; this.feedsValue = feeds;
    this.find('.lvx-feed-list').replaceChildren(...feeds.map(feed => {
      const row = document.createElement('div'); row.className = 'lvx-feed-row';
      const label = document.createElement('label');
      const box = document.createElement('input'); box.type = 'checkbox'; box.checked = feed.enabled;
      box.addEventListener('change', () => void this.feedAction({ enable: { id: feed.id, enabled: box.checked } }));
      const text = document.createElement('span');
      const title = document.createElement('strong'); title.textContent = feed.name;
      const address = document.createElement('small'); address.textContent = feed.url;
      text.append(title, address); label.append(box, text); row.append(label);
      if (feed.custom) {
        const language = document.createElement('select'); language.className = 'lvx-feed-row-language'; language.setAttribute('aria-label', `Language of ${feed.name}`);
        for (const [code, label] of [['en', 'English'], ['it', 'Italian']]) { const option = document.createElement('option'); option.value = code; option.textContent = label; language.append(option); }
        language.value = feed.language ?? 'en';
        language.addEventListener('change', () => void this.feedAction({ language: { id: feed.id, language: language.value } }));
        row.append(language);
        const remove = document.createElement('button'); remove.type = 'button'; remove.className = 'lvx-feed-remove'; remove.textContent = '×'; remove.setAttribute('aria-label', `Remove ${feed.name}`);
        remove.addEventListener('click', () => void this.feedAction({ remove: feed.id }));
        row.append(remove);
      }
      return row;
    }));
  }

  renderVoice(voice) {
    if (this.page !== 'voice' || !voice) return;
    const gb = bytes => (bytes / 1e9).toFixed(1), busy = ['downloading', 'verifying'].includes(voice.status);
    const words = { ready: 'INSTALLED', downloading: 'DOWNLOADING', verifying: 'CHECKING THE FILES', paused: 'PAUSED', error: 'NEEDS ATTENTION', idle: 'NOT INSTALLED' };
    const setText = (selector, text) => { const node = this.find(selector); if (node.textContent !== text) node.textContent = text; };
    setText('.lvx-voice-status', words[voice.status] ?? 'NOT INSTALLED');
    setText('.lvx-voice-detail', voice.ready ? `Installed · ${gb(voice.total)} GB · works offline` : voice.status === 'verifying' ? 'Checking the files…' : voice.bytes > 0 ? `${gb(voice.bytes)} of ${gb(voice.total)} GB` : `${gb(voice.total)} GB, downloaded once`);
    setText('.lvx-voice-error', voice.error ?? '');
    this.find('.lvx-voice-error').hidden = !voice.error;
    const percent = voice.total ? Math.min(100, Math.round(voice.bytes / voice.total * 100)) : 0;
    this.find('.lvx-voice-progress').setAttribute('aria-valuenow', String(percent));
    this.find('.lvx-voice-progress i').style.width = `${percent}%`;
    this.find('.lvx-voice-download').hidden = voice.ready || busy;
    this.find('.lvx-voice-pause').hidden = !busy;
    setText('.lvx-voice-download', voice.bytes > 0 ? 'Resume download' : 'Download voice');
  }

  close() { if (!this.value?.choiceMade) this.welcome(); else this.dialog.close(); }

  dirty() {
    return this.draftEnabled !== this.value?.enabled || this.find('#lvx-catalog-url').value.trim() !== (this.value?.url ?? '') || Number(this.find('#lvx-refresh-minutes').value) !== this.value?.refreshMinutes;
  }

  renderDraft() {
    const on = this.draftEnabled;
    this.find('.lvx-live-power').setAttribute('aria-pressed', String(on));
    this.find('.lvx-live-state').textContent = on ? 'ON' : 'OFF';
    this.find('.lvx-live-explanation').textContent = on ? 'Live songs stream as you listen. Included music is kept as a fallback. Turning Live off switches back to included music.' : 'Your included stations keep playing. No live catalog requests while this is off.';
    this.find('#lvx-refresh-minutes').disabled = !on || this.saving;
    this.find('#lvx-catalog-url').disabled = this.saving;
    this.find('.lvx-live-power').disabled = this.saving;
    this.find('.lvx-settings-save').disabled = this.saving;
    this.find('.lvx-keep-local').disabled = this.saving;
    this.find('.lvx-enable-live').disabled = this.saving;
    this.find('.lvx-settings-refresh').disabled = this.saving || !this.value?.enabled || this.value?.refreshing || this.dirty();
    this.find('.lvx-settings-refresh').classList.toggle('is-refreshing', !!this.value?.refreshing);
    this.find('.lvx-settings-refresh').setAttribute('aria-busy', String(!!this.value?.refreshing));
    if (on && !this.find('#lvx-catalog-url').value.trim()) this.find('.lvx-catalog-details').open = true;
    this.writeStatus();
    if (this.dirty() && !this.saving) {
      this.find('.lvx-live-status').dataset.state = 'pending';
      this.find('.lvx-live-status span').textContent = 'Changes not saved · Save settings to apply your choice.';
    }
  }

  writeStatus() {
    if (!this.value) return;
    const v = this.value, text = this.find('.lvx-live-status span');
    this.find('.lvx-live-status').dataset.state = v.status;
    text.textContent = v.error || (!v.enabled ? 'Included music · Live updates off' : v.refreshing ? 'Checking for new music… Your song keeps playing.' : v.overflow ? `${v.overflow} stations could not be added. Your existing stations stay in place.` : v.lastCheckedAt ? `${v.stationCount} live stations · checked at ${new Date(v.lastCheckedAt).toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'})}${v.added ? ` · ${v.added} new` : ''}` : 'Ready to check the catalog.');
  }

  renderStatus() { this.writeStatus(); if (this.dialog.open && this.find('.lvx-welcome').hidden) this.renderDraft(); }

  error(text) { const node = this.find('.lvx-settings-error'); node.textContent = text; node.hidden = !text; }

  async save(enabled = this.draftEnabled, fromWelcome = false) {
    if (this.saving) return;
    const first = !this.value?.choiceMade;
    const settings = { enabled, url: fromWelcome ? this.value?.url ?? '' : this.find('#lvx-catalog-url').value.trim(), refreshMinutes: fromWelcome ? this.value?.refreshMinutes ?? 30 : Number(this.find('#lvx-refresh-minutes').value) };
    this.saving = true; this.error(''); this.renderDraft();
    try {
      const value = await window.LvxRadio.liveSettings(settings); this.update(value); this.dialog.close();
      if (first) this.onListen();
    } catch (error) { this.error(error.message); }
    finally { this.saving = false; this.renderDraft(); }
  }

  refresh = async () => {
    if (!this.value?.enabled || this.value.refreshing) return;
    this.error('');
    try { this.update(await window.LvxRadio.refreshStations()); }
    catch (error) { this.error(error.message); }
  };

  destroy() { this.stopVoicePoll(); this.dialog.remove(); }
};
