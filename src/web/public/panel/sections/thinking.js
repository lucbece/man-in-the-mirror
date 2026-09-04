import { h } from '../dom.js';
import { t } from '../i18n.js';
import { SettingsForm, field, seg, selected, switchRow } from '../form.js';

/**
 * Thinking: the mode, the models, the provider in chat mode, web search.
 *
 * Model selects come from the server's known list (`state.models`) with a
 * Custom entry for anything else; a saved id not in the list shows as Custom
 * with the id filled in, so nothing typed is ever lost to the select.
 */
const FALLBACK_MODELS = [
  { id: 'claude-sonnet-5', provider: 'anthropic', role: ['agent', 'fast', 'chat'], note: '' },
  { id: 'claude-haiku-4-5', provider: 'anthropic', role: ['fast', 'chat'], note: '' },
  { id: 'gpt-4.1', provider: 'openai', role: ['chat'], note: '' },
];
const DEFAULTS = { agent: 'claude-sonnet-5', fast: 'claude-haiku-4-5', anthropic: 'claude-sonnet-5', openai: 'gpt-4.1' };

export function mount(root) {
  let models = FALLBACK_MODELS;

  const mode = seg({
    name: 'brainKind',
    options: ['agent', 'cascade', 'chat'].map((value) => ({ value, label: t(`thinking.mode.${value}`) })),
  });
  const modeHelp = h('p.help');

  const agentModel = modelPicker('brainModel');
  const fastModel = modelPicker('fastModel');
  const provider = seg({
    name: 'brainProvider',
    options: ['anthropic', 'openai'].map((value) => ({ value, label: t(`thinking.provider.${value}`) })),
  });
  const providerHelp = h('p.help');
  const web = switchRow({ name: 'webSearch', label: t('thinking.web'), help: t('thinking.web.help') });

  const agentField = field({ label: t('thinking.agentModel'), control: agentModel.el, help: t('thinking.model.help') });
  const fastField = field({ label: t('thinking.fastModel'), control: fastModel.el, help: t('thinking.fastModel.help') });
  const providerField = h('div.field', h('span.label', t('thinking.provider')), provider, providerHelp);
  const warning = h('p.help.warn', { hidden: true });

  const card = h(
    'div.card',
    h('div.field', h('span.label', t('thinking.mode')), mode, modeHelp),
    warning,
    h('div.fields-2', fastField, agentField),
    providerField,
    web,
  );
  root.append(h('header', h('p', t('thinking.intro'))), card);

  function modelPicker(name) {
    const sel = h('select.select', { name });
    const custom = h('input.input.mono', { name: `${name}Custom`, placeholder: t('thinking.customId'), hidden: true, autocomplete: 'off', spellcheck: 'false' });
    sel.addEventListener('change', () => {
      custom.hidden = sel.value !== '__custom';
      if (!custom.hidden) custom.focus();
    });
    const el = h('div.stack', sel, custom);
    return {
      el,
      fill(role, providers, value, defaultId) {
        const list = models.filter((m) => m.role.includes(role) && providers.includes(m.provider));
        const option = (m) => new Option(m.note ? `${m.id} · ${m.note}` : m.id, m.id);
        sel.replaceChildren(new Option(t('thinking.default', { id: defaultId }), ''));
        if (providers.length > 1) {
          // One group per provider, so the choice reads as "which company" first.
          for (const p of providers) {
            const group = h('optgroup', { label: t(`thinking.provider.${p}`) });
            for (const m of list.filter((m) => m.provider === p)) group.append(option(m));
            if (group.childElementCount) sel.append(group);
          }
        } else {
          for (const m of list) sel.append(option(m));
        }
        sel.append(new Option(t('thinking.custom'), '__custom'));
        const known = !value || list.some((m) => m.id === value);
        sel.value = known ? value : '__custom';
        custom.hidden = known;
        custom.value = known ? '' : value;
      },
      read() {
        return sel.value === '__custom' ? custom.value.trim() : sel.value;
      },
    };
  }

  function layout() {
    const kind = selected(mode);
    modeHelp.textContent = t(`thinking.mode.${kind}.help`);
    fastField.hidden = kind !== 'cascade';
    providerField.hidden = kind !== 'chat';
    agentField.querySelector('label').textContent = kind === 'chat' ? t('thinking.model') : t('thinking.agentModel');
    agentField.querySelector('p.help').textContent = kind === 'chat' ? t('thinking.chatModel.help') : t('thinking.model.help');
    providerHelp.textContent = t(`thinking.provider.${selected(provider)}.help`);
  }
  mode.addEventListener('change', () => {
    layout();
    refill(read());
  });
  provider.addEventListener('change', () => {
    layout();
    refill(read());
  });

  function refill(values) {
    const kind = values.brainKind;
    const providerId = kind === 'chat' ? values.brainProvider : 'anthropic';
    agentModel.fill(kind === 'chat' ? 'chat' : 'agent', [providerId], values.brainModel, DEFAULTS[kind === 'chat' ? providerId : 'agent']);
    fastModel.fill('fast', ['anthropic', 'openai'], values.fastModel, DEFAULTS.fast);
  }

  function read() {
    return {
      brainKind: selected(mode),
      brainProvider: selected(provider),
      brainModel: agentModel.read(),
      fastModel: fastModel.read(),
      webSearch: web.querySelector('input').checked,
    };
  }

  function write(cfg) {
    for (const r of mode.querySelectorAll('input')) r.checked = r.value === cfg.brainKind;
    for (const r of provider.querySelectorAll('input')) r.checked = r.value === cfg.brainProvider;
    web.querySelector('input').checked = Boolean(cfg.webSearch);
    layout();
    refill(cfg);

    const agentish = cfg.brainKind !== 'chat';
    const usingClaude = agentish || cfg.brainProvider === 'anthropic';
    const missing = usingClaude ? !cfg.hasAnthropicApiKey : !cfg.hasOpenaiApiKey;
    warning.hidden = !missing;
    warning.textContent = missing ? t('thinking.noKey', { provider: usingClaude ? 'Anthropic' : 'OpenAI' }) : '';
  }

  const form = new SettingsForm({
    section: root,
    read,
    write,
    note: () => t('form.note.agentRestart'),
  });

  return {
    update(state) {
      if (Array.isArray(state.models) && state.models.length) models = state.models;
      form.update(state.config);
    },
  };
}
