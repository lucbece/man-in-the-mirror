import assert from 'node:assert/strict';
import test, { describe } from 'node:test';

import { config } from '../src/config.js';

/**
 * Run a mutation against a snapshot of the config and roll it back, so these
 * tests can't clobber a real key sitting in data/config.json.
 */
function withConfig(seed, fn) {
  const snapshot = { ...config.values };
  const persist = config.persist;
  config.persist = () => {}; // don't write to disk during tests
  try {
    Object.assign(config.values, seed);
    return fn();
  } finally {
    config.persist = persist;
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
