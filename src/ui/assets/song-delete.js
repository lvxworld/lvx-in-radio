export function storageSize(bytes) {
  if (!(bytes > 0)) return '';
  const mb = bytes / 1_000_000;
  return mb >= 1 ? `${mb.toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1000))} KB`;
}

/** Native modal semantics, styled as part of the radio, with no deletion until confirmation. */
export class SongDeleteDialog {
  constructor({ remove, onDeleted, document = globalThis.document }) {
    this.remove = remove;
    this.onDeleted = onDeleted;
    this.dialog = document.createElement('dialog');
    this.dialog.className = 'song-delete-dialog';
    this.dialog.setAttribute('aria-labelledby', 'song-delete-title');
    this.dialog.setAttribute('aria-describedby', 'song-delete-detail');
    this.dialog.innerHTML = `<p class="song-delete-kicker">Your library</p>
      <h2 id="song-delete-title">Delete this song?</h2>
      <p class="song-delete-name"></p>
      <p id="song-delete-detail"></p>
      <p class="song-delete-error" role="alert" hidden></p>
      <div class="song-delete-actions"><button type="button" class="song-delete-cancel" autofocus>Cancel</button><button type="button" class="song-delete-confirm">Delete song</button></div>`;
    document.body.append(this.dialog);
    this.cancel = this.dialog.querySelector('.song-delete-cancel');
    this.confirm = this.dialog.querySelector('.song-delete-confirm');
    this.error = this.dialog.querySelector('.song-delete-error');
    this.cancel.onclick = () => { if (!this.busy) this.dialog.close(); };
    this.confirm.onclick = () => this.delete();
    this.dialog.addEventListener('cancel', event => { if (this.busy) event.preventDefault(); });
    this.dialog.addEventListener('close', () => { this.song = null; if (this.focusBefore?.isConnected) this.focusBefore.focus(); });
  }

  open(song) {
    if (this.dialog.open) return;
    this.song = { ...song };
    this.focusBefore = this.dialog.ownerDocument.activeElement;
    this.dialog.querySelector('.song-delete-name').textContent = song.title;
    const size = storageSize(song.sizeBytes);
    this.dialog.querySelector('#song-delete-detail').textContent = `This permanently removes the song from your library${size ? ` and frees about ${size}` : ' and deletes its files from your Mac'}.`;
    this.error.hidden = true;
    this.dialog.showModal();
    this.cancel.focus();
  }

  async delete() {
    if (this.busy || !this.song) return;
    this.busy = true;
    this.confirm.disabled = this.cancel.disabled = true;
    this.confirm.textContent = 'Deleting…';
    this.error.hidden = true;
    try {
      const song = this.song;
      const result = await this.remove(song.id);
      this.dialog.close();
      this.onDeleted(result, song);
    } catch (error) {
      this.error.textContent = error.message || 'Could not delete this song. Try again.';
      this.error.hidden = false;
    } finally {
      this.busy = false;
      this.confirm.disabled = this.cancel.disabled = false;
      this.confirm.textContent = 'Delete song';
    }
  }

  destroy() { this.dialog.close(); this.dialog.remove(); }
}
