import defaults from './prompts/defaults.json' with { type: 'json' };

/** The DJ style preset of a station, from the strongest genre of its mix. */
export function styleFor(config) {
  const lead = Object.entries(config?.mix ?? {}).sort((a, b) => b[1] - a[1])[0]?.[0] ?? '';
  if (/lo-fi|relax|ambient|chill/i.test(lead)) return 'relax';
  if (/edm|techno/i.test(lead)) return 'edm';
  if (/rock|metal|prog/i.test(lead)) return 'rock';
  if (/pop/i.test(lead)) return 'pop';
  return 'generic';
}

export const DJ_IDS = ['serena', 'sohee', 'vivian', 'ryan', 'aiden', 'dylan'];

/** The DJ a station gets when its listener never chose one (data: prompts/defaults.json); generic gets none. */
export const STYLE_DEFAULT_DJ = Object.freeze({ ...defaults });
/** The four bundled LVX stations get a default; other LVX Live stations have none until chosen. */
export const LUX_DEFAULT_STATIONS = ['lux-edm', 'lux-rock', 'lux-pop', 'lux-relax'];

/**
 * A station's DJ: its own choice when it has one (`{ id: null }` is a chosen "No DJ"),
 * otherwise the default of its style. Never another station's pick.
 */
export function stationDj(station) {
  const choice = station?.dj;
  if (choice && typeof choice === 'object' && 'id' in choice && (choice.id === null || DJ_IDS.includes(choice.id))) {
    return { dj: choice.id, djChosen: true };
  }
  return { dj: STYLE_DEFAULT_DJ[styleFor(station?.config)] ?? null, djChosen: false };
}

/** An LVX station's DJ from the choice map in dj-settings.json: djId | null (No DJ) | absent (default). */
export function luxStationDj(station, choices = {}) {
  if (Object.hasOwn(choices, station?.id)) {
    const choice = choices[station.id];
    if (choice === null || DJ_IDS.includes(choice)) return { dj: choice, djChosen: true };
  }
  return { dj: LUX_DEFAULT_STATIONS.includes(station?.id) ? STYLE_DEFAULT_DJ[styleFor(station?.config)] ?? null : null, djChosen: false };
}
