import assert from 'node:assert/strict';
import test, { describe, after, before } from 'node:test';

import { createApp } from '../src/web/server.js';
import { config } from '../src/config.js';

/**
 * The real app on an ephemeral port.
 *
 * Nothing mocked: these go over HTTP, because the thing being checked is what
 * a browser can and cannot get the panel to do, and that lives in headers
 * rather than in any function worth calling directly.
 */
let server;
let base;
let saved;

before(async () => {
  saved = { ...config.values };
  server = createApp().listen(0, '127.0.0.1');
  await new Promise((resolve) => {
    server.once('listening', resolve);
  });
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  // Whatever these tests wrote, put back — this is the developer's real config.
  config.update(saved);
  await new Promise((resolve) => {
    server.close(resolve);
  });
});

const post = (path, { headers = {}, body, raw } = {}) =>
  fetch(`${base}${path}`, {
    method: 'POST',
    headers: raw ? headers : { 'content-type': 'application/json', ...headers },
    body: raw ?? (body === undefined ? undefined : JSON.stringify(body)),
  });

describe('requests from somebody else\'s page', () => {
  test('a cross-site POST that needs no body is refused', async () => {
    // The hole this closes, in the exact shape that worked: an HTML form can
    // send this with no preflight for the browser to block, and
    // /api/bot/:action reads only req.params — so it needed no body at all.
    const res = await post('/api/bot/stop', {
      raw: '',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        origin: 'https://evil.example',
        'sec-fetch-site': 'cross-site',
      },
    });

    assert.equal(res.status, 403);
    assert.match((await res.json()).error, /another site/i);
  });

  test('a foreign Origin is refused even without the fetch-metadata header', async () => {
    const res = await post('/api/bot/stop', {
      raw: '',
      headers: { origin: 'https://evil.example' },
    });
    assert.equal(res.status, 403);
  });

  test('same-site is not good enough — a sibling port is another origin', async () => {
    const res = await post('/api/bot/stop', {
      raw: '',
      headers: { origin: 'http://127.0.0.1:1', 'sec-fetch-site': 'same-site' },
    });
    assert.equal(res.status, 403);
  });

  test('reading state is left alone, since GET changes nothing', async () => {
    const res = await fetch(`${base}/api/state`, {
      headers: { origin: 'https://evil.example', 'sec-fetch-site': 'cross-site' },
    });
    assert.equal(res.status, 200);
    assert.ok((await res.json()).config, 'should still answer');
  });
});

describe('requests the panel itself makes', () => {
  test('its own page can still save', async () => {
    const res = await post('/api/config', {
      headers: {
        origin: base,
        'sec-fetch-site': 'same-origin',
      },
      body: { bufferSeconds: 120 },
    });

    assert.equal(res.status, 200);
    assert.equal((await res.json()).config.bufferSeconds, 120);
  });

  test('curl and the launcher still work, because a page cannot be them', async () => {
    // No Origin and no Sec-Fetch-Site is a non-browser client. Blocking those
    // would break scripting to stop an attack that requires a browser — and a
    // page cannot suppress either header.
    const res = await post('/api/config', { body: { bufferSeconds: 90 } });
    assert.equal(res.status, 200);
  });
});

describe('what the panel refuses to save', () => {
  const sameOrigin = () => ({ 'sec-fetch-site': 'same-origin' });

  test('broken MCP JSON is rejected at save time, naming the field', async () => {
    // Finding out at the first question, mid-conversation, is the worst
    // possible moment.
    const before = config.get('mcpServers');
    const res = await post('/api/config', {
      headers: sameOrigin(),
      body: { mcpServers: '{not json' },
    });

    assert.equal(res.status, 400);
    assert.match((await res.json()).error, /MCP servers:/);
    assert.equal(config.get('mcpServers'), before, 'must not have written anything');
  });

  test('a folder that does not exist is a typo, not a configuration', async () => {
    const res = await post('/api/config', {
      headers: sameOrigin(),
      body: { agentDirectories: '/definitely/not/here/at/all' },
    });
    assert.equal(res.status, 400);
    assert.match((await res.json()).error, /Folders:/);
  });

  test('standing instructions obey the same limits as the voice tool', async () => {
    const tooLong = await post('/api/config', {
      headers: sameOrigin(),
      body: { customInstructions: 'x'.repeat(301) },
    });
    assert.equal(tooLong.status, 400);
    assert.match((await tooLong.json()).error, /301 characters/);

    const tooMany = await post('/api/config', {
      headers: sameOrigin(),
      body: { customInstructions: Array.from({ length: 21 }, (_, i) => `Rule ${i}.`).join('\n') },
    });
    assert.equal(tooMany.status, 400);
    assert.match((await tooMany.json()).error, /21 lines/);
  });
});

describe('the state the panel renders itself from', () => {
  test('carries no secret field at all, and says so instead', async () => {
    // Asserted on the shape rather than by planting a fake key and looking for
    // it: `config.update` writes to the real config file and notifies a
    // running bot, so a test that sets a token would reconfigure the
    // developer's live bot for as long as it ran. Checking that the fields are
    // absent catches the regression that matters — somebody adding the raw
    // value back — without writing anything.
    const { config: view } = await (await fetch(`${base}/api/state`)).json();

    for (const secret of ['token', 'openaiApiKey', 'anthropicApiKey']) {
      assert.ok(!(secret in view), `${secret} must not reach the browser at all`);
    }
    // What it sends instead: enough to render the form, never the value.
    for (const field of ['hasToken', 'tokenPreview', 'hasOpenaiApiKey', 'hasAnthropicApiKey']) {
      assert.ok(field in view, `the panel needs ${field} to render`);
    }
  });
});
