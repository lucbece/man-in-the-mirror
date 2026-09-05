#!/usr/bin/env node
/**
 * Latency bench: what each stage of an answer costs with the real providers.
 *
 * Measures the three network stages of the answer path, with the bot's own
 * prompts, so a provider or model is measured before it is chosen:
 *
 *   stt    transcription of a spoken clip, one per model
 *   fast   the fast leg's first sentence, one per candidate model, with the
 *          real fast-leg prompt and the escalate tool, Anthropic cached
 *   tts    first byte of speech, one per model
 *   noise  what each transcription model says about clips nobody spoke into
 *          (breath, room noise): the failure mode the noise guard exists for
 *
 * Keys come from data/config.json (or `CFG=/path/to/config.json`), never from
 * the command line and never printed. Run it where the bot runs, since the
 * network from a laptop is not the network from the server:
 *
 *   docker cp scripts/latency-bench.mjs mirror-mirror-1:/app/scripts/
 *   docker compose exec -e CFG=/app/data/config.json mirror \
 *     node scripts/latency-bench.mjs --runs=3 --only=stt,fast,tts
 *
 * Costs a few cents per run. Numbers are medians over `--runs` (default 3).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { promptWithInstructions } from '../src/agent/brain.js';
import { FAST_PROMPT_EXTRA, ESCALATE_TOOL, ESCALATE_TOOL_OPENAI } from '../src/agent/cascade.js';
import { readSse } from '../src/agent/sse.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, v = 'true'] = a.replace(/^--/, '').split('=');
    return [k, v];
  }),
);
const RUNS = Number(args.runs ?? 3);
const ONLY = new Set((args.only ?? 'stt,fast,tts,noise').split(','));

const cfgPath = process.env.CFG ?? path.join(here, '..', 'data', 'config.json');
const cfg = fs.existsSync(cfgPath) ? JSON.parse(fs.readFileSync(cfgPath, 'utf8')) : {};
const OPENAI = cfg.openaiApiKey ?? process.env.OPENAI_API_KEY ?? '';
const ANTHROPIC = cfg.anthropicApiKey ?? process.env.ANTHROPIC_API_KEY ?? '';
if (!OPENAI) {
  console.error(`no OpenAI key in ${cfgPath} or OPENAI_API_KEY`);
  process.exit(1);
}

const STT_MODELS = (args.stt ?? 'whisper-1,gpt-4o-transcribe,gpt-4o-mini-transcribe').split(',');
const FAST_MODELS = (args.fast ?? 'claude-sonnet-5,claude-haiku-4-5,gpt-4.1,gpt-4.1-mini').split(',');
const TTS_MODELS = (args.tts ?? 'gpt-4o-mini-tts,tts-1').split(',');

// The same shape the fast leg is really asked with: a snippet of the room and
// the question. Placeholder names, as everywhere in this repo.
const ROOM =
  'Said in the channel since your last answer:\n\n' +
  '[18:34:20] Fede: che, qué opinan de la última de batman\n' +
  '[18:34:26] Vero: a mí me gustó\n\n' +
  'Vero is now asking you, out loud: espejo, ¿vos qué opinás de la película?';
const FAST_SYSTEM = promptWithInstructions('bench', FAST_PROMPT_EXTRA);
const SPOKEN = 'Espejo, ¿vos qué opinás de la última película de Batman? A mí me pareció larga.';
const SENTENCE_END = /[.!?…]\s/;

const ms = (t) => Math.round(performance.now() - t);
const median = (xs) => {
  const s = xs.filter((x) => typeof x === 'number').sort((a, b) => a - b);
  return s.length ? s[Math.floor(s.length / 2)] : null;
};
const openaiHeaders = { Authorization: `Bearer ${OPENAI}`, 'content-type': 'application/json' };

async function failing(res) {
  return new Error(`${res.status} ${(await res.text().catch(() => '')).slice(0, 100)}`);
}

// ---------------------------------------------------------------- clips

/** Speech to transcribe, made once with TTS so the bench needs no audio file. */
async function speechClip(text) {
  const res = await fetch('https://api.openai.com/v1/audio/speech', {
    method: 'POST',
    headers: openaiHeaders,
    body: JSON.stringify({ model: 'tts-1', voice: 'nova', input: text, response_format: 'wav' }),
  });
  if (!res.ok) throw await failing(res);
  return Buffer.from(await res.arrayBuffer());
}

/** 16 kHz mono 16-bit WAV from float samples. */
function wav(samples, rate = 16000) {
  const data = Buffer.alloc(samples.length * 2);
  samples.forEach((v, i) => data.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(v * 32767))), i * 2));
  const h = Buffer.alloc(44);
  h.write('RIFF', 0);
  h.writeUInt32LE(36 + data.length, 4);
  h.write('WAVE', 8);
  h.write('fmt ', 12);
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20);
  h.writeUInt16LE(1, 22);
  h.writeUInt32LE(rate, 24);
  h.writeUInt32LE(rate * 2, 28);
  h.writeUInt16LE(2, 32);
  h.writeUInt16LE(16, 34);
  h.write('data', 36);
  h.writeUInt32LE(data.length, 40);
  return Buffer.concat([h, data]);
}

/** Deterministic noise, so two runs hear the same thing. */
function noiseClip(seconds, dbfs, envelope = () => 1) {
  const n = Math.round(16000 * seconds);
  const amp = 10 ** (dbfs / 20);
  const out = new Float32Array(n);
  let seed = 7;
  for (let i = 0; i < n; i++) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    out[i] = ((seed / 0x7fffffff) * 2 - 1) * amp * envelope(i / n);
  }
  return wav(out);
}

const NOISE_CLIPS = {
  'room noise 1.5 s at -45 dBFS': () => noiseClip(1.5, -45),
  'breath-like 0.8 s at -34 dBFS': () => noiseClip(0.8, -34, (x) => Math.sin(Math.PI * x)),
  'near silence 2.0 s at -60 dBFS': () => noiseClip(2.0, -60),
};

// ---------------------------------------------------------------- stages

async function stt(model, clip) {
  const t = performance.now();
  const form = new FormData();
  form.append('file', new Blob([clip], { type: 'audio/wav' }), 'clip.wav');
  form.append('model', model);
  form.append('prompt', 'mirror, espejo');
  const res = await fetch('https://api.openai.com/v1/audio/transcriptions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${OPENAI}` },
    body: form,
  });
  if (!res.ok) throw await failing(res);
  const json = await res.json();
  return { ms: ms(t), text: (json.text ?? '').trim() };
}

async function fastAnthropic(model) {
  if (!ANTHROPIC) throw new Error('no Anthropic key');
  const t = performance.now();
  let first = null;
  let sentence = null;
  let text = '';
  let usage = null;
  let escalated = false;
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': ANTHROPIC, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify({
      model,
      max_tokens: 300,
      stream: true,
      system: [{ type: 'text', text: FAST_SYSTEM, cache_control: { type: 'ephemeral' } }],
      tools: [ESCALATE_TOOL],
      messages: [{ role: 'user', content: ROOM }],
    }),
  });
  if (!res.ok) throw await failing(res);
  for await (const ev of readSse(res)) {
    if (ev.type === 'message_start') usage = ev.message?.usage ?? null;
    if (ev.type === 'content_block_start') {
      first ??= ms(t);
      if (ev.content_block?.type === 'tool_use') escalated = true;
    }
    if (ev.type === 'content_block_delta' && ev.delta?.text) {
      text += ev.delta.text;
      if (sentence === null && text.length >= 24 && SENTENCE_END.test(text)) sentence = ms(t);
    }
  }
  // An escalation has no sentence: the number that matters is when the
  // agent would have been handed the question, which is the first block.
  return {
    firstBlock: first,
    firstSentence: escalated ? undefined : sentence ?? ms(t),
    total: ms(t),
    cached: usage?.cache_read_input_tokens ?? 0,
    escalated,
  };
}

async function fastOpenAI(model) {
  const t = performance.now();
  let first = null;
  let sentence = null;
  let text = '';
  let escalated = false;
  const res = await fetch('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: openaiHeaders,
    body: JSON.stringify({
      model,
      instructions: FAST_SYSTEM,
      input: ROOM,
      tools: [ESCALATE_TOOL_OPENAI],
      max_output_tokens: 300,
      stream: true,
    }),
  });
  if (!res.ok) throw await failing(res);
  for await (const ev of readSse(res)) {
    if (ev.type === 'response.output_item.added') {
      first ??= ms(t);
      if (ev.item?.type === 'function_call') escalated = true;
    }
    if (ev.type === 'response.output_text.delta') {
      text += ev.delta ?? '';
      if (sentence === null && text.length >= 24 && SENTENCE_END.test(text)) sentence = ms(t);
    }
  }
  return { firstBlock: first, firstSentence: escalated ? undefined : sentence ?? ms(t), total: ms(t), cached: 0, escalated };
}

async function tts(model) {
  const t = performance.now();
  const res = await fetch('https://api.openai.com/v1/audio/speech', {
    method: 'POST',
    headers: openaiHeaders,
    body: JSON.stringify({
      model,
      voice: cfg.ttsVoice ?? 'onyx',
      input: 'Me gustó bastante, aunque la segunda mitad se hace un poco larga.',
      response_format: 'opus',
    }),
  });
  if (!res.ok) throw await failing(res);
  const reader = res.body.getReader();
  await reader.read();
  const firstByte = ms(t);
  for (;;) {
    const { done } = await reader.read();
    if (done) break;
  }
  return { firstByte, total: ms(t) };
}

// ---------------------------------------------------------------- runner

const rows = [];
async function measure(stage, label, fn) {
  const runs = [];
  for (let i = 0; i < RUNS; i++) {
    try {
      runs.push(await fn());
    } catch (err) {
      runs.push({ error: String(err.message).slice(0, 80) });
    }
  }
  const ok = runs.filter((r) => !r.error);
  const row = { stage, label, n: ok.length, error: runs.find((r) => r.error)?.error };
  for (const key of ['ms', 'firstBlock', 'firstSentence', 'firstByte', 'total']) {
    if (ok.some((r) => typeof r[key] === 'number')) row[key] = median(ok.map((r) => r[key]));
  }
  if (ok.some((r) => r.cached)) row.cached = Math.max(...ok.map((r) => r.cached ?? 0));
  if (ok.some((r) => r.escalated)) row.escalated = ok.filter((r) => r.escalated).length;
  if (ok[0]?.text !== undefined) row.text = ok[ok.length - 1].text;
  rows.push(row);
  console.log(`${stage.padEnd(5)} ${label.padEnd(26)} ${describe(row)}`);
}

function describe(row) {
  if (!row.n) return `failed: ${row.error}`;
  const parts = [];
  if (row.ms !== undefined) parts.push(`${row.ms} ms`);
  if (row.firstBlock !== undefined) parts.push(`first block ${row.firstBlock} ms`);
  if (row.firstSentence !== undefined) parts.push(`first sentence ${row.firstSentence} ms`);
  if (row.firstByte !== undefined) parts.push(`first byte ${row.firstByte} ms`);
  if (row.total !== undefined) parts.push(`total ${row.total} ms`);
  if (row.cached) parts.push(`cache read ${row.cached} tok`);
  if (row.escalated) parts.push(`escalated ${row.escalated}/${row.n}`);
  if (row.text !== undefined) parts.push(`"${row.text.slice(0, 50)}"`);
  if (row.error) parts.push(`(${RUNS - row.n} failed: ${row.error})`);
  return parts.join(' · ');
}

console.log(`latency bench · ${RUNS} run(s) each · fast prompt ${FAST_SYSTEM.length} chars · ${new Date().toISOString()}`);

if (ONLY.has('stt')) {
  const clip = await speechClip(SPOKEN);
  const short = await speechClip('Espejo.');
  for (const model of STT_MODELS) await measure('stt', `${model} (4 s clip)`, () => stt(model, clip));
  for (const model of STT_MODELS) await measure('stt', `${model} (one word)`, () => stt(model, short));
}
if (ONLY.has('fast')) {
  for (const model of FAST_MODELS) {
    const fn = model.startsWith('claude') ? () => fastAnthropic(model) : () => fastOpenAI(model);
    await measure('fast', model, fn);
  }
}
if (ONLY.has('tts')) {
  for (const model of TTS_MODELS) await measure('tts', model, () => tts(model));
}
if (ONLY.has('noise')) {
  for (const [label, make] of Object.entries(NOISE_CLIPS)) {
    const clip = make();
    for (const model of STT_MODELS) {
      await measure('noise', `${model} · ${label}`, async () => {
        const r = await stt(model, clip);
        return { ms: r.ms, text: r.text || '(nothing)' };
      });
    }
  }
}

if (args.json) fs.writeFileSync(args.json, JSON.stringify(rows, null, 2));
