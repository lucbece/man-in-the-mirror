import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test, { describe } from 'node:test';

import { config, CONFIG_PATH } from '../src/config.js';
import { ROOT_DIR } from '../src/paths.js';

/**
 * The file this whole suite must never touch, whatever it does to `config`.
 * Read before any test runs, compared again once every test has: see the
 * 'data directory isolation' suite at the bottom of this file.
 */
const REAL_CONFIG_PATH = path.join(ROOT_DIR, 'data', 'config.json');
const realConfigBefore = readRealConfig();

function readRealConfig() {
  return fs.existsSync(REAL_CONFIG_PATH) ? fs.readFileSync(REAL_CONFIG_PATH, 'utf8') : null;
}

/**
 * Run a mutation against a snapshot of the config and roll it back, so one
 * test's seed values don't leak into the next. Persisting is left alone —
 * test/setup.mjs points CONFIG_PATH at a throwaway directory for the whole
 * run, so there is no real file here left to protect.
 */
function withConfig(seed, fn) {
  const snapshot = { ...config.values };
  try {
    Object.assign(config.values, seed);
    return fn();
  } finally {
    config.values = snapshot;
  }
}

describe('secrets', () => {
  test('a blank submission keeps the stored secret', () => {
    // The UI never receives the secret, so its field always renders empty.
    // Treating that as "erase" means saving any unrelated setting on the same
    // card silently destroys the key.
    withConfig({ openaiApiKey: 'sk-stored' }, () => {
      config.update({ sttProvider: 'openai', openaiApiKey: '' });
      assert.equal(config.get('openaiApiKey'), 'sk-stored');
    });
  });

  test('whitespace counts as blank', () => {
    withConfig({ anthropicApiKey: 'sk-ant-stored' }, () => {
      config.update({ anthropicApiKey: '   ' });
      assert.equal(config.get('anthropicApiKey'), 'sk-ant-stored');
    });
  });

  test('a real value replaces the stored one, trimmed', () => {
    withConfig({ openaiApiKey: 'sk-old' }, () => {
      config.update({ openaiApiKey: '  sk-new  ' });
      assert.equal(config.get('openaiApiKey'), 'sk-new');
    });
  });

  test('the Discord token follows the same rule', () => {
    withConfig({ token: 'discord-token' }, () => {
      config.update({ token: '' });
      assert.equal(config.get('token'), 'discord-token');
    });
  });

  test('publicView never exposes a raw secret', () => {
    withConfig(
      {
        // Realistic lengths — short fakes would mask entirely and prove nothing.
        token: 'MTUzMzYxNzQzNDM5MTYxMzUyMg.GxXxXx.longdiscordtokenvalue',
        openaiApiKey: 'sk-proj-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        anthropicApiKey: 'sk-ant-api03-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      },
      () => {
        const view = config.publicView();
        const serialised = JSON.stringify(view);
        for (const secret of [
          'MTUzMzYxNzQzNDM5MTYxMzUyMg.GxXxXx.longdiscordtokenvalue',
          'sk-proj-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
          'sk-ant-api03-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
        ]) {
          assert.ok(!serialised.includes(secret), 'raw secret leaked into publicView');
        }
        assert.equal(view.hasOpenaiApiKey, true);
        assert.equal(view.hasAnthropicApiKey, true);
        assert.equal(view.hasToken, true);
      },
    );
  });

  test('a suspiciously short secret is masked completely', () => {
    // Head-and-tail previews reveal everything when the value is short.
    withConfig({ openaiApiKey: 'sk-short' }, () => {
      const preview = config.publicView().openaiApiKeyPreview;
      assert.ok(!preview.includes('short'), 'short secret leaked via its preview');
      assert.match(preview, /^•+$/);
    },
    );
  });
});

describe('clamping', () => {
  test('buffer length is held to a sane range', () => {
    withConfig({}, () => {
      config.update({ bufferSeconds: 5 });
      assert.equal(config.get('bufferSeconds'), 10);
      config.update({ bufferSeconds: 99999 });
      assert.equal(config.get('bufferSeconds'), 600);
    });
  });

  test('an unknown provider falls back rather than breaking at runtime', () => {
    withConfig({}, () => {
      config.update({ sttProvider: 'nonsense', brainProvider: 'nonsense' });
      assert.equal(config.get('sttProvider'), 'openai');
      assert.equal(config.get('brainProvider'), 'anthropic');
    });
  });

  test('an unknown voice falls back to a real one', () => {
    withConfig({}, () => {
      config.update({ ttsVoice: 'not-a-voice' });
      assert.equal(config.get('ttsVoice'), 'onyx');
      config.update({ sttModel: 'gpt-4o-transcribe' });
      assert.equal(config.get('sttModel'), 'gpt-4o-transcribe');
      config.update({ sttModel: 'whisper-2' });
      assert.equal(config.get('sttModel'), 'whisper-1');
      config.update({ ttsModel: 'tts-1' });
      assert.equal(config.get('ttsModel'), 'tts-1');
      config.update({ ttsModel: 'not-a-model' });
      assert.equal(config.get('ttsModel'), 'gpt-4o-mini-tts');
      config.update({ notebook: '- uno\n\n  dos  \n' });
      assert.equal(config.get('notebook'), 'uno\ndos');
      config.update({ ttsSpeed: '1.25' });
      assert.equal(config.get('ttsSpeed'), 1.25);
      config.update({ ttsSpeed: 9 });
      assert.equal(config.get('ttsSpeed'), 1.6);
      config.update({ ttsSpeed: 'fast' });
      assert.equal(config.get('ttsSpeed'), 1);
    });
  });
});

describe('data directory isolation', () => {
  // Must run last: it checks what every test above this point did, not just
  // its own mutation.
  test('this suite persists under MIRROR_DATA_DIR, never into the real data/config.json', () => {
    assert.ok(process.env.MIRROR_DATA_DIR, 'test/setup.mjs should have set this before anything imported config.js');
    assert.equal(
      CONFIG_PATH,
      path.join(process.env.MIRROR_DATA_DIR, 'config.json'),
      'config.js must derive CONFIG_PATH from MIRROR_DATA_DIR via dataPath()',
    );
    assert.notEqual(CONFIG_PATH, REAL_CONFIG_PATH, 'the test config path must not be the developer\'s real one');

    // withConfig() above no longer stubs out persist(), so a real
    // config.update() call really does write — proving it lands in the
    // throwaway directory rather than nowhere.
    withConfig({}, () => {
      config.update({ bufferSeconds: 123 });
    });
    const onDisk = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    assert.equal(onDisk.bufferSeconds, 123, 'config.update() persisted to CONFIG_PATH under MIRROR_DATA_DIR');

    // And, the actual point: whatever every test above did, the developer's
    // real file is exactly what it was before this file ran a single test.
    assert.equal(
      readRealConfig(),
      realConfigBefore,
      'the real repo\'s data/config.json must be byte-identical to before this suite ran',
    );
  });
});
