/** What the screen shows and does about the DJ. Pure, so it is tested without a browser. */

const gb = (bytes) => ((Number(bytes) || 0) / 1e9).toFixed(1);

const MISSING_WORDS = { llm: 'the script model', voice: 'the News voice' };

/** "Needs the script model and the News voice", or '' when nothing is missing. */
export function missingWords(missing = []) {
  const words = missing.map((name) => MISSING_WORDS[name] ?? name);
  if (!words.length) return '';
  return `Needs ${words.join(' and ')}`;
}

const STATUS_WORDS = { off: 'OFF', waiting: 'WAITING FOR SETUP', ready: 'ON', error: 'NEEDS ATTENTION' };

/** The switch row of Settings -> DJs. */
export function djSwitchView(dj) {
  if (!dj) return { on: false, canToggle: false, state: '…', caption: 'Checking…' };
  const missing = Array.isArray(dj.missing) ? dj.missing : [];
  const ready = dj.ready === true;
  const on = dj.enabled === true;
  let caption;
  if (on && ready) caption = `A DJ speaks ${cadenceWords(dj.minSongs, dj.maxSongs)}, on stations that have one.`;
  else if (!ready && missing.length) caption = `${missingWords(missing)} first. The DJ stays off until both are installed.`;
  else if (dj.status === 'error') caption = 'Something went wrong. The DJ is paused until it works again.';
  else caption = 'A voice introduces the next song now and then. It runs on your Mac.';
  return {
    on,
    // Turning off is always possible; turning on needs both models.
    canToggle: on || ready,
    state: STATUS_WORDS[dj.status] ?? (on ? 'ON' : 'OFF'),
    caption,
  };
}

export function rangeWords(min, max) {
  const lo = Number(min) || 2, hi = Number(max) || 4;
  return lo === hi ? String(lo) : `${lo}–${hi}`;
}

/** "after every song", "every 3 songs" or "every 1–4 songs". */
export function cadenceWords(min, max) {
  const lo = Number(min) || 2, hi = Number(max) || 4;
  return lo === 1 && hi === 1 ? 'after every song' : `every ${rangeWords(lo, hi)} songs`;
}

/** Keeps min <= max when one of the two selects changes. The one the listener touched wins. */
export function nextRange({ min, max }, changed, value) {
  const v = Math.min(4, Math.max(1, Math.round(Number(value)) || 1));
  if (changed === 'min') return { minSongs: v, maxSongs: Math.max(v, max) };
  return { minSongs: Math.min(min, v), maxSongs: v };
}

const MODEL_WORDS = { ready: 'INSTALLED', downloading: 'DOWNLOADING', verifying: 'CHECKING THE FILES', paused: 'PAUSED', error: 'NEEDS ATTENTION', idle: 'NOT INSTALLED' };

/** True when the model folder is the Hugging Face cache or says so (`source: 'cache'`). */
export function fromHuggingFace(model) {
  if (model?.source === 'cache' || model?.source === 'huggingface') return true;
  return /[\\/]models--[^\\/]+[\\/]snapshots[\\/]/.test(String(model?.directory ?? ''));
}

/** The LLM setup block, the same shape as the News voice block. */
export function modelView(model) {
  if (!model) return { word: '…', detail: '', percent: 0, busy: false, ready: false, canDownload: false, canPause: false, canChoose: false, downloadLabel: 'Download script model', error: '' };
  const busy = ['downloading', 'verifying'].includes(model.status);
  const ready = model.ready === true || model.status === 'ready';
  const cache = fromHuggingFace(model);
  let detail;
  if (ready) detail = cache ? 'Using the copy in your Hugging Face cache · works offline' : `Installed${model.total ? ` · ${gb(model.total)} GB` : ''} · works offline`;
  else if (model.status === 'verifying') detail = 'Checking the files…';
  else if (model.bytes > 0 && model.total) detail = `${gb(model.bytes)} of ${gb(model.total)} GB`;
  else detail = model.total ? `${gb(model.total)} GB, downloaded once` : 'One download, then it works offline';
  const percent = model.total ? Math.min(100, Math.round((model.bytes / model.total) * 100)) : ready ? 100 : 0;
  return {
    word: MODEL_WORDS[model.status] ?? 'NOT INSTALLED',
    detail,
    percent,
    busy,
    ready,
    canDownload: !ready && !busy,
    canPause: busy,
    canChoose: !ready && !busy,
    downloadLabel: model.bytes > 0 ? 'Resume download' : 'Download script model',
    error: model.error ?? '',
  };
}

/** The "Voice shared with News" block. */
export function voiceView(voice) {
  if (!voice) return { word: '…', detail: '', ready: false, canDownload: false };
  const ready = voice.ready === true;
  const busy = ['downloading', 'verifying'].includes(voice.status);
  let detail;
  if (ready) detail = 'Shared with News · nothing more to download';
  else if (busy) detail = 'Downloading the News voice…';
  else detail = 'The DJs speak with the same voice as LVX News. It is one download of 4.5 GB, shared by both.';
  return { word: ready ? 'INSTALLED' : busy ? 'DOWNLOADING' : 'NOT INSTALLED', detail, ready, canDownload: !ready && !busy };
}

/** The style a DJ is auditioned in: its first station fit that the catalog knows, else generic. */
export function previewStyle(dj, styles = []) {
  const known = new Set(styles.map((style) => style.id));
  return (dj?.bestFor ?? []).find((id) => known.has(id)) ?? 'generic';
}

/** The word on an audition button for the preview in the snapshot. */
export function previewState(preview, djId, pendingId) {
  if (pendingId !== djId) return { label: 'Listen', busy: false, error: '' };
  // The click was sent but no snapshot has answered yet: still busy, never a dead button.
  if (!preview) return { label: 'Starting…', busy: true, error: '' };
  if (preview.status === 'queued') return { label: 'Waiting for the radio…', busy: true, error: '' };
  if (preview.status === 'producing') return { label: 'Making a sample…', busy: true, error: '' };
  if (preview.status === 'error') return { label: 'Listen', busy: false, error: preview.error || 'The sample could not be made' };
  return { label: 'Listen', busy: false, error: '' };
}

/** Selector rows for a station: None first, then DJs that fit its style, then the rest. */
export function stationDjChoices(djs = [], style = 'generic') {
  // A generic station has no particular fit: nobody is promoted, nobody is labelled.
  const fits = style === 'generic' ? [] : djs.filter((dj) => (dj.bestFor ?? []).includes(style));
  const others = djs.filter((dj) => !fits.includes(dj));
  return [{ id: null, name: 'No DJ', note: 'Just the music' }, ...fits.map((dj) => ({ ...dj, note: noteFor(dj, true) })), ...others.map((dj) => ({ ...dj, note: noteFor(dj, false) }))];
}

function noteFor(dj, fits) {
  const parts = [dj.blurb ?? dj.character, fits ? 'Suits this station' : ''].filter(Boolean);
  return parts.join(' · ');
}

/** The DJ chip is on every station with a record, Lux included (not News), switched on or not. */
export function djSelectorAvailable({ station } = {}) {
  if (!station) return false;
  return !station.news;
}

/** The chip's caption and light. `suffix` is the small word after DJ when it is not on. */
export function djChipView({ dj, station, catalog }) {
  if (!dj?.enabled) return { state: 'off', suffix: 'OFF', caption: dj?.ready === false && dj?.missing?.length ? 'DJ off · ' + missingWords(dj.missing) : 'DJ off' };
  if (!dj.ready) return { state: 'waiting', suffix: 'SETUP', caption: missingWords(dj.missing) || 'Setting up the DJ' };
  const chosen = (catalog?.djs ?? []).find((entry) => entry.id === station?.dj);
  if (dj.status === 'error') return { state: 'error', suffix: '', caption: 'The DJ could not make a line' };
  return chosen ? { state: 'on', suffix: '', caption: `DJ ${chosen.name}` } : { state: 'ready', suffix: '', caption: 'No DJ on this station' };
}

/** What the popover offers while DJs are off or not ready. */
export function djOffView(dj) {
  const missing = Array.isArray(dj?.missing) ? dj.missing : [];
  if (dj?.ready) return { title: 'DJs are off', detail: 'A voice introduces the next song now and then.', action: 'Turn on DJs', go: 'enable' };
  if (dj?.enabled && missing.length) return { title: 'Setting up the DJ', detail: `${missingWords(missing)} first.`, action: 'Open DJ settings', go: 'settings' };
  return { title: 'DJs are off', detail: missing.length ? `${missingWords(missing)} first.` : 'Turn them on in Settings.', action: 'Open DJ settings', go: 'settings' };
}

/**
 * The popover's state line: what the DJ is doing now, or when the radio will let them speak next. Nobody asks the DJ to
 * speak; the radio decides. `dj.introduction` ({stationId, songId, state}) is the automatic slot for this station's current song,
 * `dj.nextSlot.remainingSongs` counts the songs before the next break.
 */
export function djStateLine({ dj, live = '', hasDj = true, stationId, currentSongId } = {}) {
  if (!hasDj) return 'Just the music on this station.';
  if (live === 'speaking') return 'On air now';
  if (live === 'armed') return 'Ready: the DJ speaks before this song ends';
  // The clip has played: the server keeps the slot 'armed' until the song ends, but there is nothing left to wait for.
  const spoken = live === 'done';
  const intro = dj?.introduction && (!stationId || !dj.introduction.stationId || dj.introduction.stationId === stationId) ? dj.introduction : null;
  // A short Lux song: the line is made for the end of the NEXT song (fromTrackId is the song on air now).
  if (!spoken && intro?.fromTrackId && currentSongId && intro.fromTrackId === currentSongId && (intro.state === 'armed' || intro.state === 'preparing')) return 'Next DJ break: after the next song';
  if (intro?.state === 'preparing') return 'Writing the next intro…';
  if (intro?.state === 'armed' && !spoken) return 'Ready: the DJ speaks before this song ends';
  const left = Number(dj?.nextSlot?.remainingSongs);
  if (Number.isFinite(left) && left >= 0) return left === 0 ? 'Next DJ break: after this song' : `Next DJ break in ${left} ${left === 1 ? 'song' : 'songs'}`;
  const min = dj?.minSongs, max = dj?.maxSongs;
  if (min && max) return `Speaks ${cadenceWords(min, max)}`;
  return 'The radio chooses when the DJ speaks';
}

/**
 * The clip that introduces the song after `currentSongId`, or null. The server names the song it introduces
 * (`lastLine.songId`) and arms a slot for the song playing now (`introduction`: armed, this station, `songId` = the current song);
 * the renderer arms the line only for that slot, never from `lastLine` alone.
 */
export function clipToArm({ dj, stationIds, nextSongId, currentSongId }) {
  const line = dj?.lastLine;
  const ids = (Array.isArray(stationIds) ? stationIds : [stationIds]).filter(Boolean);
  if (!line || !line.audioId || !nextSongId || !currentSongId) return null;
  if (!ids.includes(line.stationId) || line.songId !== nextSongId) return null;
  // Radio-only scheduling: lastLine is production history. Only a slot the radio armed for this station and this very song may play.
  const slot = dj?.introduction;
  if (!slot || slot.state !== 'armed' || !ids.includes(slot.stationId) || slot.songId !== currentSongId) return null;
  return {
    id: line.id ?? line.audioId,
    url: `/dj-audio/${encodeURIComponent(line.audioId)}`,
    durationSec: Number(line.durationSec) || null,
    style: line.style ?? null,
    text: line.text ?? '',
  };
}

/** News beats the DJ: no clip starts while a bulletin plays (a card offering one does not stop it). */
export function djMayStart({ newsPlaying, playing }) {
  return playing === true && !newsPlaying;
}

/** Portraits live next to the app's assets; the id is the file name. */
export function djAvatarUrl(id) {
  return /^[a-z0-9_-]+$/i.test(String(id ?? '')) ? `assets/dj/avatars/${String(id).toLowerCase()}.png` : '';
}

/** The letter shown behind (or instead of) a portrait that cannot load. */
export function djInitial(name) {
  const letter = String(name ?? '').trim().charAt(0);
  return letter ? letter.toUpperCase() : '·';
}

/** The small tag under a name in the picker. */
export function djVoiceTag(dj) {
  const kind = { man: 'Man', male: 'Man', woman: 'Woman', female: 'Woman' }[String(dj?.gender ?? '').toLowerCase()] ?? '';
  return [kind, dj?.language && dj.language !== 'en' ? String(dj.language).toUpperCase() : 'EN'].filter(Boolean).join(' · ');
}

/** What the avatar around the chip and the portrait should be doing: speaking, armed (an intro waits for the song's end) or nothing. */
export function djLiveState({ phase, hasPlan } = {}) {
  if (phase === 'speaking' || phase === 'ducking') return 'speaking';
  if (hasPlan && phase === 'idle') return 'armed';
  if (hasPlan && phase === 'done') return 'done';
  return '';
}
