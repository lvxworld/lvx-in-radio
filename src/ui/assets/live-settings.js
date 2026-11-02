/** Settings presentation only. Main-process API/SSE owns every saved setting. */
window.LvxLiveSettings = class {
  constructor({ onChange, onModel, onListen }) {
    this.onChange = onChange; this.onModel = onModel; this.onListen = onListen;
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
          <h1>Settings</h1><p class="lvx-settings-intro">More music, at your own pace.</p>
          <div class="lvx-settings-kicker lvx-settings-section">01 — LISTEN</div>
          <div class="lvx-live-power-row"><button type="button" class="lvx-live-power" aria-label="LVX Live stations" aria-pressed="false"><i></i><b></b></button><div><strong>LVX Live stations</strong><p>Stream new songs. Discover new stations.</p></div><span class="lvx-live-state">OFF</span></div>
          <p class="lvx-live-explanation">Your included stations keep playing. No live catalog requests while this is off.</p>
          <details class="lvx-catalog-details"><summary>Station catalog</summary><label for="lvx-catalog-url">Catalog address</label><input id="lvx-catalog-url" type="url" maxlength="2048" autocomplete="off" spellcheck="false" placeholder="https://…/catalog.json"><p class="lvx-settings-note">The public catalog.json URL. An HTTP address on your local network also works for a LAN test.</p></details>
          <label class="lvx-refresh-label" for="lvx-refresh-minutes">Check for new music</label><select id="lvx-refresh-minutes"><option value="5">Every 5 minutes</option><option value="15">Every 15 minutes</option><option value="30">Every 30 minutes</option><option value="60">Every hour</option><option value="0">Only when I refresh</option></select>
          <div class="lvx-live-status" role="status" aria-live="polite"><i></i><span></span></div>
          <div class="lvx-settings-model"><div><span class="lvx-settings-kicker">02 — CREATE ON THIS MAC</span><strong>Make music with YuE2</strong><p>Optional. Your model and songs stay local.</p></div><button class="lvx-model-open lvx-settings-secondary" type="button">Music setup ↗</button></div>
          <div class="lvx-settings-actions"><button class="lvx-settings-secondary lvx-settings-refresh" type="button" aria-label="Refresh stations"><svg width="17" height="17" viewBox="0 0 32 32" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M7 13a9.5 9.5 0 0 1 16.5-3.2L26 13m0 0-5-.5m5 .5-.2-5M25 19a9.5 9.5 0 0 1-16.5 3.2L6 19m0 0 5 .5M6 19l.2 5"></path></svg><span>Refresh stations</span></button><button class="lvx-settings-primary lvx-settings-save" type="submit">Save settings ↗</button></div>
        </div>
        <p class="lvx-settings-error" role="alert" hidden></p>
      </form>`;
    document.body.append(this.dialog);
    this.find = selector => this.dialog.querySelector(selector);
    this.find('form').addEventListener('submit', event => { event.preventDefault(); void this.save(); });
    this.find('.lvx-settings-close').addEventListener('click', () => this.close());
    this.dialog.addEventListener('cancel', event => { if (!this.value?.choiceMade) { event.preventDefault(); this.welcome(); } });
    this.find('.lvx-keep-local').addEventListener('click', () => void this.save(false, true));
    this.find('.lvx-enable-live').addEventListener('click', () => { this.open(); this.draftEnabled = true; this.renderDraft(); });
    this.find('.lvx-live-power').addEventListener('click', () => { this.draftEnabled = !this.draftEnabled; this.renderDraft(); });
    this.find('.lvx-settings-refresh').addEventListener('click', () => void this.refresh());
    this.find('.lvx-model-open').addEventListener('click', () => { this.dialog.close(); this.onModel(); });
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
    this.find('.lvx-settings-body h1').id = 'lvx-settings-heading';
    this.dialog.setAttribute('aria-labelledby','lvx-settings-heading');
    this.find('.lvx-settings-close').hidden = false;
    this.draftEnabled = !!this.value?.enabled;
    this.find('#lvx-catalog-url').value = this.value?.url ?? '';
    this.find('#lvx-refresh-minutes').value = String(this.value?.refreshMinutes ?? 30);
    this.find('.lvx-catalog-details').open = !this.value?.url;
    this.error(''); this.renderDraft(); this.renderStatus();
    if (!this.dialog.open) this.dialog.showModal();
  };

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

  destroy() { this.dialog.remove(); }
};
