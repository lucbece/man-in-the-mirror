import { h, toast } from '../dom.js';
import { post } from '../api.js';
import { t } from '../i18n.js';
import { callout } from '../form.js';

const DEVELOPER_PORTAL = 'https://discord.com/developers/applications';
const OPENAI_KEYS = 'https://platform.openai.com/api-keys';
const ANTHROPIC_KEYS = 'https://platform.claude.com/settings/keys';

/**
 * Keys: the three secrets the bot runs on. Every row replaces at once —
 * nothing here goes through the save bar — so `update(state)` only ever
 * touches the status pills, never the inputs, and never while one has
 * focus: a value being typed is never at risk of being overwritten by the
 * poll.
 */
export function mount(root, ctx) {
  const rows = [
    keyRow({
      configKey: 'token',
      hasKey: 'hasToken',
      preview: 'tokenPreview',
      label: t('keys.token'),
      help: t('keys.token.help'),
      placeholder: t('keys.token.placeholder'),
      more: {
        summary: t('keys.token.more.summary'),
        text: t('keys.token.more.text'),
        link: t('keys.token.more.link'),
        href: DEVELOPER_PORTAL,
      },
      replacedToast: t('keys.token.replaced'),
    }),
    keyRow({
      configKey: 'openaiApiKey',
      hasKey: 'hasOpenaiApiKey',
      preview: 'openaiApiKeyPreview',
      label: t('keys.openai'),
      help: t('keys.openai.help'),
      placeholder: t('keys.openai.placeholder'),
      more: {
        summary: t('keys.openai.more.summary'),
        text: t('keys.openai.more.text'),
        link: t('keys.openai.more.link'),
        href: OPENAI_KEYS,
      },
      replacedToast: t('keys.openai.replaced'),
    }),
    keyRow({
      configKey: 'anthropicApiKey',
      hasKey: 'hasAnthropicApiKey',
      preview: 'anthropicApiKeyPreview',
      label: t('keys.anthropic'),
      help: t('keys.anthropic.help'),
      placeholder: t('keys.anthropic.placeholder'),
      more: {
        summary: t('keys.anthropic.more.summary'),
        text: t('keys.anthropic.more.text'),
        link: t('keys.anthropic.more.link'),
        href: ANTHROPIC_KEYS,
      },
      replacedToast: t('keys.anthropic.replaced'),
    }),
  ];

  const card = h('div.card', ...rows.map((row) => row.field));
  root.append(h('header', h('p', t('keys.intro'))), card, callout(t('keys.callout')));

  function keyRow({ configKey, hasKey, preview, label, help, placeholder, more, replacedToast }) {
    const pill = h('span.pill', { data: { state: 'warn' } }, h('span.dot'), t('keys.missing'));
    const input = h('input.input', { type: 'password', autocomplete: 'off', spellcheck: 'false', placeholder });
    const replace = h('button.btn', { type: 'button', disabled: true }, t('keys.replace'));
    input.addEventListener('input', () => {
      replace.disabled = !input.value.trim();
    });
    let busy = false;
    replace.addEventListener('click', async () => {
      const value = input.value.trim();
      if (!value || busy) return;
      busy = true;
      replace.disabled = true;
      try {
        await post('/api/config', { [configKey]: value });
        toast(replacedToast);
        input.value = '';
        input.blur();
        await ctx.refresh();
      } catch (err) {
        toast(err.message, 'error');
      } finally {
        busy = false;
        replace.disabled = !input.value.trim();
      }
    });

    const fieldEl = h(
      'div.field',
      { data: { live: '1' } },
      h('div.label.row', label, pill),
      h('div.input-row', input, replace),
      h('p.help', help),
      h(
        'details.more',
        h('summary', more.summary),
        h('p', more.text, ' ', h('a', { href: more.href, target: '_blank', rel: 'noopener' }, more.link), '.'),
      ),
    );

    return {
      field: fieldEl,
      refresh(cfg) {
        pill.dataset.state = cfg[hasKey] ? 'ok' : 'warn';
        pill.replaceChildren(h('span.dot'), cfg[hasKey] ? t('keys.set', { preview: cfg[preview] }) : t('keys.missing'));
      },
    };
  }

  return {
    update(state) {
      for (const row of rows) row.refresh(state.config);
    },
  };
}
