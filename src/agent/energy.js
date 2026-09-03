/**
 * How loud a clip is, before anyone pays to transcribe it.
 *
 * Discord starts a stream whenever a client decides its user is speaking, and
 * clients decide that on breath, keyboards and a chair creaking. Every such
 * burst used to become a Whisper request, and Whisper, handed near-silence,
 * answers with the subtitle boilerplate it was trained on: four of every five
 * requests in a real evening came back as "Subtítulos realizados por la
 * comunidad de Amara.org" and were thrown away after being paid for.
 *
 * The numbers here are the only thing known about a clip before that request:
 * its loudest moment, its average level, and how much of it is above a floor
 * that breath does not reach. They are computed on the same 16 kHz mono PCM
 * that is sent, so they describe exactly what Whisper would have heard.
 *
 * Units are dBFS: 0 is the loudest a 16-bit sample can be, speech in a call
 * peaks between -20 and -5, and a muted room sits below -60.
 */

const WINDOW_SAMPLES = 320; // 20 ms at 16 kHz, one Opus frame
const FULL_SCALE = 32768;

/** dBFS of a linear amplitude, floored so silence is a number, not -Infinity. */
const db = (amplitude) => (amplitude <= 0 ? -100 : Math.max(-100, 20 * Math.log10(amplitude / FULL_SCALE)));

/**
 * Measure a 16-bit mono PCM buffer.
 *
 * `activeRatio` is the share of 20 ms windows whose RMS is above `activeDb`:
 * a word is a run of such windows, a breath is one or two, and a clip that
 * has none is nothing at all.
 */
export function measureEnergy(pcm, { activeDb = -40 } = {}) {
  const samples = Math.floor(pcm.length / 2);
  if (samples === 0) return { ms: 0, peakDb: -100, rmsDb: -100, activeRatio: 0 };

  let peak = 0;
  let sumSquares = 0;
  let windows = 0;
  let active = 0;
  for (let start = 0; start < samples; start += WINDOW_SAMPLES) {
    const end = Math.min(samples, start + WINDOW_SAMPLES);
    let windowSquares = 0;
    for (let i = start; i < end; i++) {
      const v = pcm.readInt16LE(i * 2);
      const a = Math.abs(v);
      if (a > peak) peak = a;
      windowSquares += v * v;
    }
    sumSquares += windowSquares;
    windows += 1;
    if (db(Math.sqrt(windowSquares / (end - start))) > activeDb) active += 1;
  }

  return {
    ms: Math.round((samples / 16_000) * 1000),
    peakDb: Math.round(db(peak)),
    rmsDb: Math.round(db(Math.sqrt(sumSquares / samples))),
    activeRatio: Number((active / windows).toFixed(2)),
  };
}

/**
 * The gate, deliberately loose: it only refuses clips whose loudest moment
 * never reaches `peakDb`, which is well below any voice that meant to be
 * heard. A quiet speaker with a bad microphone still peaks above -40 on the
 * stressed syllable; a breath does not. Tightening it is a matter of reading
 * the `[stt] clip` lines for a few evenings, which is why every clip is
 * logged with its numbers, kept or not.
 *
 * `MIRROR_STT_GATE_DB` overrides the threshold without a release; `off`
 * disables the gate.
 */
export const DEFAULT_GATE_DB = -40;

export function gateThreshold(env = process.env) {
  const raw = env.MIRROR_STT_GATE_DB;
  if (raw === undefined || raw === '') return DEFAULT_GATE_DB;
  if (/^(off|none|0)$/i.test(raw)) return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : DEFAULT_GATE_DB;
}

export function tooQuiet(energy, threshold = gateThreshold()) {
  if (threshold === null) return false;
  return energy.peakDb < threshold;
}

/** One line per clip, in the log's own style. */
export function describeEnergy(energy) {
  return `${(energy.ms / 1000).toFixed(1)}s peak ${energy.peakDb}dB rms ${energy.rmsDb}dB active ${Math.round(energy.activeRatio * 100)}%`;
}
