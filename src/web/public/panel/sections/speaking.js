import { h, toast } from '../dom.js';
import { t } from '../i18n.js';
import { SettingsForm, field, seg, selected, callout } from '../form.js';

/**
 * Speaking: the voice provider, the voice itself, and a "Hear it" preview
 * that plays the currently selected voice — saved or not — through
 * `GET /api/tts/preview`.
 */
export function mount(root) {
  let voices = [];
  let localVoices = [];

  const provider = seg({
    name: 'ttsProvider',
    options: ['openai', 'local'].map((value) => ({ value, label: t(`speaking.provider.${value}`) })),
  });
  const providerHelp = h('p.help');
  const providerField = h('div.field', h('span.label', t('speaking.provider')), provider, providerHelp);

  const openaiVoice = h('select.select', { name: 'ttsVoice' });
  const openaiBtn = h('button.btn', { type: 'button' }, t('speaking.hearIt'));
  const openaiField = field({
    label: t('speaking.voice.openai'),
    control: h('div.input-row', openaiVoice, openaiBtn),
  });
  const model = seg({
    name: 'ttsModel',
    options: ['gpt-4o-mini-tts', 'tts-1'].map((value) => ({ value, label: t(`speaking.model.${value}`) })),
  });
  const modelField = field({ label: t('speaking.model'), control: model, help: t('speaking.model.help') });

  const localVoice = h('select.select', { name: 'ttsLocalVoice' });
  const localBtn = h('button.btn', { type: 'button' }, t('speaking.hearIt'));
  const localField = field({
    label: t('speaking.voice.local'),
    control: h('div.input-row', localVoice, localBtn),
  });

  const card = h('div.card', providerField, openaiField, modelField, localField, callout(t('speaking.callout')));
  root.append(h('header', h('p', t('speaking.intro'))), card);

  async function hearIt(providerId, select, btn) {
    const voice = select.value;
    if (!voice) return;
    btn.disabled = true;
    try {
      const query = `provider=${providerId}&voice=${encodeURIComponent(voice)}&model=${encodeURIComponent(selected(model))}`;
      const res = await fetch(`/api/tts/preview?${query}`);
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || `${res.status} ${res.statusText}`);
      }
      const blob = await res.blob();
      const audio = new Audio(URL.createObjectURL(blob));
      await new Promise((resolve) => {
        audio.addEventListener('ended', resolve, { once: true });
        audio.addEventListener('error', resolve, { once: true });
        audio.play().catch(resolve);
      });
    } catch (err) {
      toast(err.message, 'error');
    } finally {
      btn.disabled = false;
    }
  }
  openaiBtn.addEventListener('click', () => hearIt('openai', openaiVoice, openaiBtn));
  localBtn.addEventListener('click', () => hearIt('local', localVoice, localBtn));

  function layout() {
    const p = selected(provider);
    providerHelp.textContent = t(`speaking.provider.${p}.help`);
    openaiField.hidden = p !== 'openai';
    modelField.hidden = p !== 'openai';
    localField.hidden = p !== 'local';
  }
  provider.addEventListener('change', layout);

  function fillVoices(cfg) {
    openaiVoice.replaceChildren(...voices.map((v) => new Option(v, v, false, v === cfg.ttsVoice)));
    localVoice.replaceChildren(...localVoices.map((v) => new Option(v.label, v.id, false, v.id === cfg.ttsLocalVoice)));
  }

  function read() {
    return {
      ttsProvider: selected(provider),
      ttsVoice: openaiVoice.value,
      ttsModel: selected(model),
      ttsLocalVoice: localVoice.value,
    };
  }

  function write(cfg) {
    for (const r of provider.querySelectorAll('input')) r.checked = r.value === cfg.ttsProvider;
    for (const r of model.querySelectorAll('input')) r.checked = r.value === (cfg.ttsModel || 'gpt-4o-mini-tts');
    fillVoices(cfg);
    layout();
  }

  const form = new SettingsForm({ section: root, read, write });

  return {
    update(state) {
      if (Array.isArray(state.config?.voices)) voices = state.config.voices;
      if (Array.isArray(state.config?.localVoices)) localVoices = state.config.localVoices;
      form.update(state.config);
    },
  };
}
