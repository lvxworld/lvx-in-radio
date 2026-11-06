const GENRES_SOUND = {
  Pop: {
    label: 'pop',
    sounds: ['glossy synth hooks', 'punchy pop drums', 'bright plucked guitar', 'warm sub bass'],
  },
  Rock: {
    label: 'rock',
    sounds: ['driving electric guitars', 'live rock drums', 'anthemic guitar riffs', 'overdriven bass'],
  },
  Country: {
    label: 'country',
    sounds: ['twangy telecaster guitar', 'weeping pedal steel', 'steady country drums', 'warm upright bass'],
  },
  Metal: {
    label: 'metal',
    sounds: ['heavy distorted riffs', 'double kick drums', 'soaring guitar lead', 'palm-muted chugs'],
  },
  EDM: {
    label: 'melodic techno',
    sounds: ['huge analog lead', 'epic supersaw chords', 'four-on-the-floor kick', 'ethereal atmospheric pads'],
  },
  Techno: {
    label: 'dark progressive house',
    sounds: ['pulsing rolling bassline', 'hypnotic synth arpeggios', 'four-on-the-floor kick', 'futuristic analog textures'],
  },
  'Progressive metal': {
    label: 'progressive metal',
    sounds: ['intricate odd-meter riffs', 'virtuosic polyrhythmic drums', 'soaring melodic guitar solo', 'atmospheric keyboard layers'],
  },
  'Hip-hop': {
    label: 'hip-hop',
    sounds: ['deep 808 bass', 'crisp boom bap drums', 'chopped soul samples', 'laid-back groove'],
  },
  'R&B': {
    label: 'R&B',
    sounds: ['smooth Rhodes chords', 'silky neo-soul groove', 'warm round bass', 'soft finger snaps'],
  },
  Jazz: {
    label: 'jazz',
    sounds: ['warm upright bass', 'brushed drums', 'jazzy electric piano', 'muted trumpet'],
  },
  Classical: {
    label: 'classical',
    sounds: ['soaring strings', 'grand piano', 'gentle woodwinds', 'french horns'],
  },
  Folk: {
    label: 'folk',
    sounds: ['fingerpicked acoustic guitar', 'warm acoustic strings', 'light hand percussion', 'gentle upright bass'],
  },
  'Lo-fi': {
    label: 'lo-fi',
    sounds: ['dusty electric piano', 'soft tape-saturated drums', 'mellow nylon guitar', 'vinyl crackle'],
  },
  Ambient: {
    label: 'ambient',
    sounds: ['atmospheric pads', 'slow evolving textures', 'soft shimmering drones', 'airy reverb'],
  },
};

const SCENARIO_MOOD = {
  'Have fun': 'playful, feel-good',
  Relax: 'relaxed, cozy',
  Concentrate: 'focused, steady',
  Workout: 'driving, motivating',
  Party: 'euphoric, danceable',
  'Road trip': 'open-road, nostalgic',
  Sleep: 'dreamy, soothing',
  Romance: 'intimate, tender',
  'Get lost': 'immersive, adventurous, cinematic, intricate evolving arrangement',
};

const FLAVORS = {
  'pop-stadium': 'stadium pop anthem',
  'pop-bedroom': 'intimate bedroom pop',
  'pop-neon': '80s neon synth-pop',
  'pop-sun': 'sunny summer radio pop',
  'pop-hook': 'instant catchy hook',
  'pop-dream': 'hazy dream pop',
  'rock-garage': 'raw garage rock fuzz',
  'rock-arena': 'huge arena rock',
  'rock-blues': 'worn blues rock',
  'rock-alt': 'restless alternative rock',
  'rock-riff': 'riff-driven rock',
  'rock-soar': 'soaring guitar layers',
  'metal-doom': 'slow crushing doom',
  'metal-thrash': 'fast thrash energy',
  'metal-epic': 'epic symphonic metal',
  'metal-groove': 'heavy groove metal',
  'metal-black': 'icy tremolo atmosphere',
  'metal-fire': 'molten sludge tone',
  'prog-odyssey': 'long multi-part odyssey',
  'prog-crush': 'crushing odd-meter groove',
  'prog-virtuoso': 'dazzling virtuosic runs',
  'prog-atmosphere': 'dark atmospheric interludes',
  'prog-classic': 'classic symphonic prog grandeur',
  'prog-modern': 'modern djent precision',
  'edm-festival': 'sunrise festival euphoria',
  'edm-warehouse': 'dark warehouse rave',
  'edm-ethereal': 'ethereal weightless atmosphere',
  'edm-heavy': 'heavy physical low end',
  'edm-drop': 'explosive drop',
  'edm-journey': 'long progressive journey',
  'techno-hypnotic': 'hypnotic repeating loop',
  'techno-melodic': 'emotional melodic lines',
  'techno-berlin': 'industrial concrete techno',
  'techno-space': 'deep space atmosphere',
  'techno-acid': 'squelching acid lines',
  'techno-analog': 'warm analog hardware',
  'hiphop-boom': 'old school boom bap',
  'hiphop-trap': 'dark modern trap',
  'hiphop-soul': 'dusty soul samples',
  'hiphop-synth': 'spacey synth hip-hop',
  'hiphop-street': 'gritty night street mood',
  'hiphop-chill': 'mellow rooftop sunset',
  'rnb-velvet': 'velvet slow jam',
  'rnb-future': 'glassy future R&B',
  'rnb-90s': 'classic 90s R&B',
  'rnb-neosoul': 'live neo-soul band',
  'rnb-candle': 'candlelit intimacy',
  'rnb-city': 'after midnight city mood',
  'jazz-smoky': 'smoky jazz club',
  'jazz-modal': 'open modal jazz',
  'jazz-bebop': 'quick bebop runs',
  'jazz-ballad': 'late night jazz ballad',
  'jazz-fusion': 'electric jazz fusion',
  'jazz-acoustic': 'acoustic jazz trio',
  'classical-orchestra': 'full symphony orchestra',
  'classical-chamber': 'intimate string quartet',
  'classical-romantic': 'sweeping romantic strings',
  'classical-minimal': 'modern minimalism',
  'classical-piano': 'solo piano in the dark',
  'classical-film': 'cinematic film score',
  'country-honky': 'honky-tonk twang',
  'country-ballad': 'front porch country ballad',
  'country-outlaw': 'dusty outlaw country',
  'country-pop': 'polished modern country pop',
  'country-steel': 'weeping pedal steel guitar',
  'country-road': 'open dirt road storytelling',
  'folk-fingerpick': 'close fingerpicked acoustic guitar',
  'folk-campfire': 'campfire singalong',
  'folk-indie': 'hushed indie folk',
  'folk-celtic': 'spirited celtic reels',
  'folk-dark': 'dark old ballad',
  'folk-sunny': 'sunlit pastoral',
  'lofi-rain': 'rainy window ambience',
  'lofi-cafe': 'slow morning cafe warmth',
  'lofi-tape': 'warped old tape',
  'lofi-clean': 'soft clean lo-fi',
  'lofi-study': 'quiet study mood',
  'lofi-night': 'late train melancholy',
  'ambient-ocean': 'slow ocean swells',
  'ambient-space': 'distant starlit shimmer',
  'ambient-forest': 'forest dawn textures',
  'ambient-ice': 'glassy icy tones',
  'ambient-drone': 'deep sustained drone',
  'ambient-light': 'floating warm light',
};

const MAX_FLAVORS = 2;

export const GENRES = Object.keys(GENRES_SOUND);

const DANCE_GENRES = ['EDM', 'Techno'];
const SOUND_SLOTS = 6;
const DOMINANT_SHARE = 0.6;
const MAJOR_SHARE = 0.25;
const MAX_MOOD_CHARS = 1000;
const MIN_BPM = 30;
const MAX_BPM = 300;

function arcWords(energy, isDance) {
  if (isDance) return energy < 60 ? 'long hypnotic build-up, emotional breakdown' : 'emotional build-up, massive festival drop';
  if (energy < 30) return 'slow gentle evolution';
  if (energy < 60) return 'gradual uplifting build';
  if (energy < 80) return 'emotional build-up, big chorus';
  return 'relentless build-up, massive drop';
}

function colorWords(dark) {
  if (dark > 65) return 'dark, moody';
  if (dark < 25) return 'bright, open';
  return 'warm';
}

/** Rejects anything the style prompt cannot honestly represent. */
export function validateConfig(config) {
  const { mix, energy, bpm, dark, melody, mood, scenario, flavors = [], hint, seed, instrumental } = config ?? {};
  const names = Object.keys(mix ?? {});
  if (!names.length || names.some((name) => !GENRES.includes(name) || !(mix[name] > 0))) {
    throw new TypeError('The mix needs at least one known genre');
  }
  if (!(energy >= 0 && energy <= 100)) throw new TypeError('Energy must be between 0 and 100');
  if (!(dark >= 0 && dark <= 100)) throw new TypeError('Darkness must be between 0 and 100');
  if (!(bpm >= MIN_BPM && bpm <= MAX_BPM)) {
    throw new TypeError(`BPM must be between ${MIN_BPM} and ${MAX_BPM}`);
  }
  if (typeof melody !== 'boolean') throw new TypeError('Melody must be on or off');
  if (instrumental !== undefined && typeof instrumental !== 'boolean') throw new TypeError('Instrumental must be on or off');
  if (typeof mood !== 'string') throw new TypeError('Mood must be text');
  if (scenario !== undefined && !SCENARIO_MOOD[scenario]) throw new TypeError('Unknown scenario');
  if (!Array.isArray(flavors) || flavors.some((flavor) => !FLAVORS[flavor])) {
    throw new TypeError('Unknown flavor');
  }
  if (hint !== undefined && !GENRES.includes(hint)) throw new TypeError('Unknown genre hint');
  if (seed !== undefined && (!Number.isSafeInteger(seed) || seed < 0)) throw new TypeError('Invalid seed');
}

function sharesOf(mix) {
  const total = Object.values(mix).reduce((sum, weight) => sum + weight, 0);
  return Object.entries(mix)
    .map(([name, weight]) => ({ name, share: weight / total }))
    .sort((a, b) => b.share - a.share);
}

/** A dominant genre leads and the others colour it; close genres blend. */
function genreLine(shares) {
  const labels = (list) => list.map(({ name }) => GENRES_SOUND[name].label);
  const join = (words) => words.join(' and ');
  const [top, ...rest] = shares;
  if (!rest.length) return labels([top])[0];
  if (top.share >= DOMINANT_SHARE) return `${labels([top])[0]} with ${join(labels(rest))} influences`;
  const major = shares.filter(({ share }) => share >= MAJOR_SHARE);
  const minor = shares.filter(({ share }) => share < MAJOR_SHARE);
  const words = labels(major);
  const blend = words.join(words.some((word) => word.includes(' ')) ? ', ' : ' ');
  return minor.length ? `${blend} with hints of ${join(labels(minor))}` : blend;
}

/** Splits the sound slots by largest remainder, so percentages set the palette. */
function soundWords(shares) {
  const slots = shares.map(({ name, share }) => {
    const exact = share * SOUND_SLOTS;
    return { name, count: Math.floor(exact), remainder: exact - Math.floor(exact) };
  });
  let left = SOUND_SLOTS - slots.reduce((sum, slot) => sum + slot.count, 0);
  for (const slot of [...slots].sort((a, b) => b.remainder - a.remainder)) {
    if (left === 0) break;
    slot.count += 1;
    left -= 1;
  }
  return slots.flatMap(({ name, count }) => {
    const { sounds } = GENRES_SOUND[name];
    return sounds.slice(0, Math.min(count, sounds.length));
  });
}

/**
 * Translates radio controls into a YuE2 style prompt: genre, tempo, instruments
 * in proportion to the mix, then melody, arc and mix. The length stays bounded
 * because the sound slots are fixed.
 */
export function buildStyle({ mix, energy, bpm, dark, melody, mood, scenario, flavors = [], hint, instrumental }) {
  const shares = sharesOf(mix);
  const isDance = DANCE_GENRES.includes(shares[0].name);
  return [
    /* YuE2 takes the language from the first tag; without it some songs came out in Japanese or Chinese. */
    instrumental ? null : 'English',
    'instrumental',
    genreLine(shares),
    isDance ? 'cinematic' : null,
    SCENARIO_MOOD[scenario],
    mood.trim().slice(0, MAX_MOOD_CHARS),
    `${Math.round(bpm)} BPM`,
    ...[...new Set(soundWords(shares))],
    ...flavors.slice(0, MAX_FLAVORS).map((flavor) => FLAVORS[flavor]),
    hint && !mix[hint] ? `a touch of ${GENRES_SOUND[hint].label}` : null,
    melody ? 'memorable melodic lead' : 'no lead melody',
    arcWords(energy, isDance),
    colorWords(dark),
    isDance ? 'airy reverb, wide stereo, polished club master' : 'wide stereo, polished master',
  ]
    .filter(Boolean)
    .join(', ');
}
