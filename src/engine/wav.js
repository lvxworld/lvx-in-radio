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
