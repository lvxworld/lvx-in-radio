/** What the screen does about the hourly news. Pure, so it is tested without a browser. */

/** A new bulletin always asks; the listener decides whether to listen. */
export function nextNewsAction({ due, handledId, active }) {
  if (!due || due === handledId || active) return { type: 'none' };
  return { type: 'popup', id: due };
}

/** The story being read at this position, or null in the intro, a pause or the outro. */
export function currentStory(stories, seconds) {
  return (stories ?? []).find((story) => seconds >= story.startSec && seconds < story.endSec) ?? null;
}

const MISSING_WORDS = { 'news-voice': 'The news voice is not installed yet' };

/** The one line under the switch. */
export function newsCaption({ enabled, status, missing = [], nextAt, error }) {
  if (missing.length) return missing.map((name) => MISSING_WORDS[name] ?? `Missing: ${name}`).join(' · ');
  if (!enabled) return 'Hourly headlines';
  if (status === 'producing') return 'Making the bulletin…';
  if (status === 'error') return error || 'The bulletin could not be made';
  const time = nextAt ? new Date(nextAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '';
  return time ? `Next bulletin ${time}` : 'Waiting for the next hour';
}
