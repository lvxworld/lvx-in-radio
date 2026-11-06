const RIFF_HEADER_BYTES = 12;
const CHUNK_HEADER_BYTES = 8;

/** Reads the playback length from a PCM WAV buffer. */
export function wavDurationSeconds(wav) {
  if (wav.length < RIFF_HEADER_BYTES || wav.toString('latin1', 0, 4) !== 'RIFF') {
    throw new Error('Not a WAV file');
  }
  let byteRate = 0;
  let offset = RIFF_HEADER_BYTES;
  while (offset + CHUNK_HEADER_BYTES <= wav.length) {
    const id = wav.toString('latin1', offset, offset + 4);
    const size = wav.readUInt32LE(offset + 4);
    if (id === 'fmt ') byteRate = wav.readUInt32LE(offset + CHUNK_HEADER_BYTES + 8);
    if (id === 'data') {
      if (!byteRate) throw new Error('WAV data chunk precedes its format chunk');
      return size / byteRate;
    }
    offset += CHUNK_HEADER_BYTES + size + (size % 2);
  }
  throw new Error('WAV file has no audio data');
}

/** Decodes PCM 16/24-bit or float32 WAV into one Float32Array per channel. */
export function readWav(wav) {
  if (wav.length < RIFF_HEADER_BYTES || wav.toString('latin1', 0, 4) !== 'RIFF' || wav.toString('latin1', 8, 12) !== 'WAVE') {
    throw new Error('Not a WAV file');
  }
  let format = null;
  let offset = RIFF_HEADER_BYTES;
  while (offset + CHUNK_HEADER_BYTES <= wav.length) {
    const id = wav.toString('latin1', offset, offset + 4);
    const size = wav.readUInt32LE(offset + 4);
    const body = offset + CHUNK_HEADER_BYTES;
    if (id === 'fmt ') {
      if (body + 16 > wav.length) throw new Error('WAV format chunk is truncated');
      format = { tag: wav.readUInt16LE(body), channels: wav.readUInt16LE(body + 2), sampleRate: wav.readUInt32LE(body + 4), bits: wav.readUInt16LE(body + 14) };
      if (format.tag === 0xfffe && size >= 26) format.tag = wav.readUInt16LE(body + 24);
    }
    if (id === 'data') {
      if (!format) throw new Error('WAV data chunk precedes its format chunk');
      const available = Math.min(size, wav.length - body);
      if (available < size) throw new Error('WAV data is truncated');
      return decodeSamples(wav.subarray(body, body + available), format);
    }
    offset = body + size + (size % 2);
  }
  throw new Error('WAV file has no audio data');
}

function decodeSamples(data, { tag, channels, sampleRate, bits }) {
  const bytes = bits / 8;
  const supported = (tag === 1 && (bits === 16 || bits === 24)) || (tag === 3 && bits === 32);
  if (!supported || channels < 1) throw new Error(`Unsupported WAV format (${tag}, ${bits}-bit, ${channels} channels)`);
  const frames = Math.floor(data.length / (bytes * channels));
  const samples = Array.from({ length: channels }, () => new Float32Array(frames));
  for (let frame = 0; frame < frames; frame += 1) {
    for (let channel = 0; channel < channels; channel += 1) {
      const at = (frame * channels + channel) * bytes;
      samples[channel][frame] = tag === 3 ? data.readFloatLE(at) : bits === 16 ? data.readInt16LE(at) / 32768 : data.readIntLE(at, 3) / 8388608;
    }
  }
  return { sampleRate, channels, samples };
}

/** Encodes channels of floats in [-1, 1] as 16-bit PCM. */
export function writeWav({ sampleRate, samples }) {
  const channels = samples.length;
  const frames = samples[0].length;
  const data = Buffer.alloc(frames * channels * 2);
  for (let frame = 0; frame < frames; frame += 1) {
    for (let channel = 0; channel < channels; channel += 1) {
      const clamped = Math.max(-1, Math.min(1, samples[channel][frame]));
      data.writeInt16LE(Math.min(32767, Math.round(clamped * 32768)), (frame * channels + channel) * 2);
    }
  }
  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 'latin1'); header.writeUInt32LE(36 + data.length, 4); header.write('WAVE', 8, 'latin1');
  header.write('fmt ', 12, 'latin1'); header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24); header.writeUInt32LE(sampleRate * channels * 2, 28); header.writeUInt16LE(channels * 2, 32); header.writeUInt16LE(16, 34);
  header.write('data', 36, 'latin1'); header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}
