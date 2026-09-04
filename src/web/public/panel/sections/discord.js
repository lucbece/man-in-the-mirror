import { h, toast } from '../dom.js';
import { post } from '../api.js';
import { t } from '../i18n.js';
import { SettingsForm, field, callout } from '../form.js';

const DEVELOPER_PORTAL = 'https://discord.com/developers/applications';

/**
 * Discord: the bot token, the server it registers slash commands on
 * instantly, and the link that invites it.
 *
 * The token replaces at once, like Keys; the server ID is the one saved
 * setting here, through `SettingsForm`. The token field carries
 * `data-live` so typing into it never opens the save bar meant for the
 * server ID.
 */
export function mount(root, ctx) {
  // --- bot token (at once) --------------------------------------------------

  const tokenPill = h('span.pill', { data: { state: 'warn' } }, h('span.dot'), t('discord.token.missing'));
  const tokenInput = h('input.input', {
    type: 'password',
    autocomplete: 'off',
    spellcheck: 'false',
    placeholder: t('discord.token.placeholder'),
  });
  const tokenReplace = h('button.btn', { type: 'button', disabled: true }, t('discord.token.replace'));
  tokenInput.addEventListener('input', () => {
    tokenReplace.disabled = !tokenInput.value.trim();
  });
  let tokenBusy = false;
  tokenReplace.addEventListener('click', async () => {
    const value = tokenInput.value.trim();
    if (!value || tokenBusy) return;
    tokenBusy = true;
    tokenReplace.disabled = true;
    try {
      await post('/api/config', { token: value });
      toast(t('discord.token.replaced'));
      tokenInput.value = '';
      tokenInput.blur();
      await ctx.refresh();
    } catch (err) {
      toast(err.message, 'error');
    } finally {
      tokenBusy = false;
      tokenReplace.disabled = !tokenInput.value.trim();
    }
  });

  const tokenField = h(
    'div.field',
    { data: { live: '1' } },
    h('div.label.row', t('discord.token'), tokenPill),
    h('div.input-row', tokenInput, tokenReplace),
    h('p.help', t('discord.token.help')),
    h(
      'details.more',
      h('summary', t('discord.token.more.summary')),
      h(
        'p',
        t('discord.token.more.text'),
        ' ',
        h('a', { href: DEVELOPER_PORTAL, target: '_blank', rel: 'noopener' }, t('discord.token.more.link')),
        '.',
      ),
    ),
  );

  // --- server id (saved) -----------------------------------------------------

  const guildInput = h('input.input.mono', { name: 'guildId', autocomplete: 'off', spellcheck: 'false' });
  const guildField = field({
    label: t('discord.guildId'),
    control: guildInput,
    help: t('discord.guildId.help'),
    more: { summary: t('discord.guildId.more.summary'), text: t('discord.guildId.more.text') },
  });

  const settingsCard = h('div.card', tokenField, guildField);

  // --- invite link (read-only, shown once the bot is online) -----------------

  const inviteInput = h('input.input.mono', { readonly: true });
  const inviteCopy = h('button.btn', { type: 'button' }, t('discord.invite.copy'));
  inviteCopy.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(inviteInput.value);
      toast(t('discord.invite.copied'));
    } catch {
      toast(t('discord.invite.copyFailed'), 'error');
    }
  });
  const inviteField = field({
    label: t('discord.invite'),
    control: h('div.input-row', inviteInput, inviteCopy),
    help: t('discord.invite.help'),
  });
  inviteField.hidden = true;

  const permsCard = h('div.card', inviteField, callout(t('discord.callout')));

  root.append(h('header', h('p', t('discord.intro'))), settingsCard, permsCard);

  // --- form (server ID only) --------------------------------------------------

  function read() {
    return { guildId: guildInput.value.trim() };
  }
  function write(cfg) {
    guildInput.value = cfg.guildId ?? '';
  }

  const form = new SettingsForm({ section: root, read, write, note: () => t('form.note.restart') });

  function refreshTokenPill(cfg) {
    tokenPill.dataset.state = cfg.hasToken ? 'ok' : 'warn';
    tokenPill.replaceChildren(
      h('span.dot'),
      cfg.hasToken ? t('discord.token.set', { preview: cfg.tokenPreview }) : t('discord.token.missing'),
    );
  }

  return {
    update(state) {
      form.update(state.config);
      refreshTokenPill(state.config);
      const inviteUrl = state.bot?.inviteUrl ?? '';
      inviteField.hidden = !inviteUrl;
      if (inviteUrl) inviteInput.value = inviteUrl;
    },
  };
}
