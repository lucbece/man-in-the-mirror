/**
 * Opus packets in, WAV out.
 *
 * Discord sends 48kHz stereo. Whisper wants 16kHz mono, and downmixing before
 * upload matters: three minutes of 48kHz stereo is ~34MB, which is over the
 * OpenAI 25MB request limit. The same audio at 16kHz mono is under 6MB.
 *
 * Decoding happens here and only here, on demand. Nothing decodes while the
 * bot is merely listening.
 */
import OpusScript from 'opusscript';

const DISCORD_RATE = 48_000;
const DISCORD_CHANNELS = 2;
const TARGET_RATE = 16_000;
const DECIMATION = DISCORD_RATE / TARGET_RATE; // 3

let decoder = null;

function getDecoder() {
  // One decoder reused across calls — construction is the expensive part.
  decoder ??= new OpusScript(DISCORD_RATE, DISCORD_CHANNELS, OpusScript.Application.AUDIO);
  return decoder;
}

/**
 * Decode Opus frames to 16kHz mono 16-bit PCM.
 *
 * Averages each group of 3 stereo frames rather than picking 1 in 3. Plain
 * decimation aliases high frequencies down into the speech band, which is
 * audible as a metallic edge and measurably hurts transcription accuracy.
 */
export function decodeToMono16k(packets) {
  const opus = getDecoder();
  const chunks = [];

  for (const packet of packets) {
    let pcm;
    try {
      pcm = opus.decode(packet);
    } catch {
      continue; // a corrupt frame shouldn't sink the whole utterance
    }
    chunks.push(pcm);
  }

  if (chunks.length === 0) return Buffer.alloc(0);

  const stereo = Buffer.concat(chunks);
  const frames = Math.floor(stereo.length / 4); // 2 channels * 2 bytes
  const outFrames = Math.floor(frames / DECIMATION);
  const out = Buffer.alloc(outFrames * 2);

  for (let i = 0; i < outFrames; i++) {
    let sum = 0;
    for (let j = 0; j < DECIMATION; j++) {
      const frame = i * DECIMATION + j;
      const left = stereo.readInt16LE(frame * 4);
      const right = stereo.readInt16LE(frame * 4 + 2);
      sum += (left + right) / 2;
    }
    const avg = Math.round(sum / DECIMATION);
    out.writeInt16LE(Math.max(-32768, Math.min(32767, avg)), i * 2);
  }

  return out;
}

/** Wrap raw PCM in a WAV container. Cheaper than shelling out to ffmpeg. */
export function pcmToWav(pcm, { sampleRate = TARGET_RATE, channels = 1 } = {}) {
  const header = Buffer.alloc(44);
  const byteRate = sampleRate * channels * 2;

  header.write('RIFF', 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16); // PCM chunk size
  header.writeUInt16LE(1, 20); // format: PCM
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(channels * 2, 32); // block align
  header.writeUInt16LE(16, 34); // bits per sample
  header.write('data', 36);
  header.writeUInt32LE(pcm.length, 40);

  return Buffer.concat([header, pcm]);
}

/** Opus packets straight to a WAV buffer ready to upload. */
export function packetsToWav(packets) {
  return pcmToWav(decodeToMono16k(packets));
}

export { TARGET_RATE };
