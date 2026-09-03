import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { describe } from 'node:test';

// trace.js reads MIRROR_TRACE once, at import. Each test imports a fresh copy
// through a query string so the module cache does not hand back the previous
// test's setting.
async function load(setting) {
  process.env.MIRROR_TRACE = setting;
  try {
    return await import(`../src/agent/trace.js?setting=${encodeURIComponent(setting)}`);
  } finally {
    delete process.env.MIRROR_TRACE;
  }
}

function captureStdout(fn) {
  const chunks = [];
  const original = process.stdout.write;
  process.stdout.write = (chunk) => {
    chunks.push(String(chunk));
    return true;
  };
  try {
    fn();
  } finally {
    process.stdout.write = original;
  }
  return chunks.join('');
}

describe('trace', () => {
  test('off unless MIRROR_TRACE is set', async () => {
    const { traceEnabled } = await load('');
    assert.equal(traceEnabled, false);
  });

  test('a path writes entries to that file, category first', async () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'mitm-trace-')), 'trace.log');
    const { trace, traceFile } = await load(file);
    assert.equal(traceFile, file);
    trace('THINKING', 'agent', 'first line\nsecond line');
    await new Promise((resolve) => {
      setTimeout(resolve, 50);
    });
    const text = fs.readFileSync(file, 'utf8');
    assert.match(text, /THINKING\s+agent\n {4}first line\n {4}second line\n\n/);
    assert.doesNotMatch(text, /\[trace\]/);
  });

  test('stdout mode prefixes every non-empty line and keeps the categories', async () => {
    const { trace, traceEnabled, traceFile } = await load('stdout');
    assert.equal(traceEnabled, true);
    assert.equal(traceFile, null);
    const text = captureStdout(() => trace('TOOL', 'search_web', { query: 'hola' }));
    const lines = text.split('\n');
    // Header, the two lines of the JSON body, then the blank separator.
    assert.match(lines[0], /^\[trace\] \d\d:\d\d:\d\d {2}TOOL {5}search_web$/);
    assert.match(lines[1], /^\[trace\] {5}\{$/);
    assert.equal(lines.at(-1), '');
    for (const line of lines.filter((l) => l !== '')) assert.match(line, /^\[trace\] /);
    // The grep filters documented for the file mode keep working.
    assert.match(text, /TOOL/);
  });
});
