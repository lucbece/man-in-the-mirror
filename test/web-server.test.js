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

  test('carries the known models, so the selects are not free text', async () => {
    const { models } = await (await fetch(`${base}/api/state`)).json();
    assert.ok(Array.isArray(models) && models.length > 0);
    assert.ok(models.some((m) => m.id === 'claude-sonnet-5'));
  });
});

describe('the music mode switch on a session card', () => {
  // The panel's route, exercised over HTTP against a session in the registry:
  // what is being checked is that the flag reaches a session already in a
  // channel and comes back in the status the card is drawn from.
  const panel = (path, body) =>
    post(path, { headers: { 'sec-fetch-site': 'same-origin' }, body });

  test('flips the flag and answers with the session status', async (t) => {
    const { sessionManager } = await import('../src/voice/manager.js');
    const session = {
      quiet: false,
      setQuiet(value) {
        session.quiet = value;
      },
      status: () => ({ guildId: 'panel-guild', quiet: session.quiet }),
    };
    sessionManager.sessions.set('panel-guild', session);
    t.after(() => sessionManager.sessions.delete('panel-guild'));

    const on = await panel('/api/voice/quiet', { guildId: 'panel-guild', quiet: true });
    assert.deepEqual(await on.json(), { guildId: 'panel-guild', quiet: true });

    const off = await panel('/api/voice/quiet', { guildId: 'panel-guild', quiet: false });
    assert.equal((await off.json()).quiet, false);
  });

  test('a guild the bot is not in is a 404, not a silent no-op', async () => {
    const res = await panel('/api/voice/quiet', { guildId: 'nowhere', quiet: true });
    assert.equal(res.status, 404);
  });
});

describe('the music strip on a session card', () => {
  const panel = (path, body) =>
    post(path, { headers: { 'sec-fetch-site': 'same-origin' }, body });

  /** A session whose player just records what it was asked to do. */
  function fakeMusicSession(guildId = 'music-guild') {
    const calls = [];
    let current = null;
    return {
      guildId,
      calls,
      music: {
        add: async (query, requestedBy) => {
          calls.push(['add', query, requestedBy]);
          current = { title: query };
        },
        skip: () => calls.push(['skip']),
        pause: () => calls.push(['pause']),
        resume: () => calls.push(['resume']),
        stop: () => {
          calls.push(['stop']);
          current = null;
        },
        status: () => ({
          playing: Boolean(current),
          paused: false,
          title: current?.title ?? null,
          queued: 0,
          volume: 100,
        }),
      },
    };
  }

  test('play reaches the player with the query, and answers with the new status', async (t) => {
    const { sessionManager } = await import('../src/voice/manager.js');
    const session = fakeMusicSession();
    sessionManager.sessions.set(session.guildId, session);
    t.after(() => sessionManager.sessions.delete(session.guildId));

    const res = await panel('/api/voice/music/play', { guildId: session.guildId, query: 'thriller' });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.music.title, 'thriller');
    assert.deepEqual(session.calls, [['add', 'thriller', 'the control panel']]);
  });

  test('play with no query is a 400, not a call to the player', async (t) => {
    const { sessionManager } = await import('../src/voice/manager.js');
    const session = fakeMusicSession();
    sessionManager.sessions.set(session.guildId, session);
    t.after(() => sessionManager.sessions.delete(session.guildId));

    const res = await panel('/api/voice/music/play', { guildId: session.guildId });
    assert.equal(res.status, 400);
    assert.deepEqual(session.calls, []);
  });

  test('skip, pause, resume and stop reach the player, no query needed', async (t) => {
    const { sessionManager } = await import('../src/voice/manager.js');
    const session = fakeMusicSession();
    sessionManager.sessions.set(session.guildId, session);
    t.after(() => sessionManager.sessions.delete(session.guildId));

    for (const action of ['skip', 'pause', 'resume', 'stop']) {
      const res = await panel(`/api/voice/music/${action}`, { guildId: session.guildId });
      assert.equal(res.status, 200, action);
    }
    assert.deepEqual(session.calls.map((c) => c[0]), ['skip', 'pause', 'resume', 'stop']);
  });

  test('an action that is not one of the five is a 400', async () => {
    const res = await panel('/api/voice/music/dance', { guildId: 'whatever' });
    assert.equal(res.status, 400);
  });

  test('a guild the bot is not in is a 404, not a silent no-op', async () => {
    const res = await panel('/api/voice/music/skip', { guildId: 'nowhere' });
    assert.equal(res.status, 404);
  });

  test('the same-origin guard covers this route like every other mutating one', async () => {
    const res = await post('/api/voice/music/skip', {
      raw: '',
      headers: { origin: 'https://evil.example', 'sec-fetch-site': 'cross-site' },
    });
    assert.equal(res.status, 403);
  });
});

describe('the voice preview button', () => {
  /** A second app, with its collaborators replaced, on its own ephemeral port. */
  async function withServer(t, deps) {
    const app = createApp(deps);
    const srv = app.listen(0, '127.0.0.1');
    await new Promise((resolve) => {
      srv.once('listening', resolve);
    });
    t.after(() => new Promise((resolve) => {
      srv.close(resolve);
    }));
    return `http://127.0.0.1:${srv.address().port}`;
  }

  test('an unknown provider is a 400', async (t) => {
    const url = await withServer(t, {});
    const res = await fetch(`${url}/api/tts/preview?provider=carrier-pigeon&voice=onyx`);
    assert.equal(res.status, 400);
  });

  test('an unknown voice is a 400', async (t) => {
    const url = await withServer(t, {});
    const res = await fetch(`${url}/api/tts/preview?provider=openai&voice=not-a-real-voice`);
    assert.equal(res.status, 400);
  });

  test('Piper missing is a 503, checked before the synthesiser is ever built', async (t) => {
    let built = false;
    const url = await withServer(t, {
      isPiperInstalled: () => false,
      createTts: () => {
        built = true;
        return { synthesize: async () => Buffer.from('x') };
      },
    });

    const res = await fetch(`${url}/api/tts/preview?provider=local&voice=es_ES-davefx-medium`);
    assert.equal(res.status, 503);
    assert.equal(built, false, 'must never make a network call for it');
  });

  test('a synthesiser that refuses (no key) is a 503 carrying its message', async (t) => {
    const url = await withServer(t, {
      createTts: () => {
        throw new Error('No OpenAI API key configured.');
      },
    });

    const res = await fetch(`${url}/api/tts/preview?provider=openai&voice=onyx`);
    assert.equal(res.status, 503);
    assert.match((await res.json()).error, /No OpenAI API key/);
  });

  test('synthesises the fixed sentence once, serves the audio, and caches it', async (t) => {
    let synthCount = 0;
    const url = await withServer(t, {
      isPiperInstalled: () => true,
      createTts: ({ provider, voice }) => {
        assert.equal(provider, 'local');
        assert.equal(voice, 'es_ES-davefx-medium');
        return {
          synthesize: async (text) => {
            synthCount += 1;
            assert.match(text, /Hola, soy el espejo/);
            return Buffer.from('fake audio bytes');
          },
        };
      },
    });

    const first = await fetch(`${url}/api/tts/preview?provider=local&voice=es_ES-davefx-medium`);
    assert.equal(first.status, 200);
    assert.equal(first.headers.get('content-type'), 'audio/ogg');
    assert.equal(Buffer.from(await first.arrayBuffer()).toString(), 'fake audio bytes');

    const second = await fetch(`${url}/api/tts/preview?provider=local&voice=es_ES-davefx-medium`);
    assert.equal(await second.text(), 'fake audio bytes');
    assert.equal(synthCount, 1, 'the second request must be served from cache, not synthesised again');
  });
});
