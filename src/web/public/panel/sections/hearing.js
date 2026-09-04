import { h } from '../dom.js';
import { t } from '../i18n.js';
import { SettingsForm, field, seg, selected } from '../form.js';

/**
 * Hearing: the transcription provider, and the local model when it applies.
 *
 * `sttModels` comes from the server (`config.sttModels`), filled into the
 * select on every write so a model added there shows up without a code
 * change here.
 */
export function mount(root) {
  let sttModels = [];

  const warning = h('p.help.warn', { hidden: true });

  const provider = seg({
    name: 'sttProvider',
    options: ['openai', 'local'].map((value) => ({ value, label: t(`hearing.provider.${value}`) })),
  });
  const providerHelp = h('p.help');
  const providerField = h('div.field', h('span.label', t('hearing.provider')), provider, providerHelp);

  const localModel = h('select.select', { name: 'sttLocalModel' });
  const localField = field({
    label: t('hearing.localModel'),
    control: localModel,
    help: t('hearing.localModel.help'),
    more: { summary: t('hearing.localModel.more.summary'), text: t('hearing.localModel.more.text') },
  });

  const card = h('div.card', warning, providerField, localField);
  root.append(h('header', h('p', t('hearing.intro'))), card);

  function layout() {
    const p = selected(provider);
    providerHelp.textContent = t(`hearing.provider.${p}.help`);
    localField.hidden = p !== 'local';
  }
  provider.addEventListener('change', layout);

  function fillModels(value) {
    localModel.replaceChildren(...sttModels.map((m) => new Option(m.label, m.id, false, m.id === value)));
  }

  function read() {
    return {
      sttProvider: selected(provider),
      sttLocalModel: localModel.value,
    };
  }

  function write(cfg) {
    for (const r of provider.querySelectorAll('input')) r.checked = r.value === cfg.sttProvider;
    fillModels(cfg.sttLocalModel);
    layout();

    const missing = cfg.sttProvider === 'openai' && !cfg.hasOpenaiApiKey;
    warning.hidden = !missing;
    warning.textContent = missing ? t('hearing.noKey') : '';
  }

  const form = new SettingsForm({ section: root, read, write });

  return {
    update(state) {
      if (Array.isArray(state.config?.sttModels)) sttModels = state.config.sttModels;
      form.update(state.config);
    },
  };
}
