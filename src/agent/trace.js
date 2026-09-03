/**
 * Opt-in trace of what the models are doing, written to its own file so it
 * can be watched without the operational log ([stt], [wake], [agent]…) mixed
 * in. Off unless `MIRROR_TRACE` is set, because it records the conversation —
 * the very thing the answers register in `answers.js` deliberately does not.
 *
 *   MIRROR_TRACE=1 npm start            → data/trace.log
 *   MIRROR_TRACE=/some/where/trace.log  → that file
 *   MIRROR_TRACE=stdout                 → the process's own stdout, every
 *                                         line prefixed `[trace] ` so it can
 *                                         be told apart from the operational
 *                                         log it now shares a stream with.
 *                                         For containers, where stdout is
 *                                         the log and files are not kept.
 *
 * Every entry is classified by a fixed vocabulary so the file can be grepped
 * by kind:
 *
 *   INPUT     what a model was given (the agent's turn, the fast leg's message)
 *   THINKING  the agent's extended-thinking blocks, as they stream
 *   OUTPUT    text a model produced to be spoken
 *   TOOL      a call the agent made, with its full input
 *   TOOL ←    what that call returned
 *   TURN      how the turn ended: outcome, rounds, time, cost
 *   ROUTE     the cascade's decision: answered by the fast leg, or escalated
 */

import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from '../paths.js';

const setting = process.env.MIRROR_TRACE ?? '';
const enabled = setting !== '' && !/^(0|false|no|off)$/i.test(setting);
const toStdout = /^(stdout|-)$/i.test(setting);
const file = toStdout
  ? null
  : /^(1|true|yes|on)$/i.test(setting)
    ? path.join(DATA_DIR, 'trace.log')
    : setting;

/** Longest single entry; tool results and transcripts can be huge. */
const MAX_CHARS = Number(process.env.MIRROR_TRACE_MAX ?? 4000);

let out = null;
if (enabled && toStdout) {
  // Only non-empty lines get the prefix: the blank line that closes each
  // entry stays blank, so `grep -A` context reads the same as in the file.
  out = {
    write(chunk) {
      process.stdout.write(String(chunk).replace(/^(?=.)/gm, '[trace] '));
    },
  };
} else if (enabled) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  out = fs.createWriteStream(file, { flags: 'a' });
  out.write(`\n===== trace started ${new Date().toISOString()} =====\n`);
}

function stamp() {
  return new Date().toISOString().slice(11, 19);
}

function clip(text) {
  const s = typeof text === 'string' ? text : JSON.stringify(text, null, 2);
  if (s === undefined) return '';
  return s.length > MAX_CHARS ? `${s.slice(0, MAX_CHARS)}… (${s.length - MAX_CHARS} more)` : s;
}

/**
 * One entry: a header line `HH:MM:SS  KIND  label`, then the body indented.
 * `kind` is one of the words above; `label` is free text (a tool name, an
 * outcome); `body` is whatever was said, given or returned.
 */
function trace(kind, label, body) {
  if (!out) return;
  const text = clip(body ?? '')
    .split('\n')
    .map((line) => `    ${line}`)
    .join('\n');
  out.write(`${stamp()}  ${kind.padEnd(8)} ${label}\n${text}\n\n`);
}

/**
 * Collects streamed deltas of one content block so thinking is written as a
 * paragraph rather than a word per line. Call `push` for each delta and
 * `flush` when the block closes.
 */
class BlockCollector {
  constructor(kind, label) {
    this.kind = kind;
    this.label = label;
    this.buf = '';
  }
  push(text) {
    this.buf += text;
  }
  flush() {
    if (this.buf.trim()) trace(this.kind, this.label, this.buf);
    this.buf = '';
  }
}

export { enabled as traceEnabled, file as traceFile, trace, BlockCollector };
