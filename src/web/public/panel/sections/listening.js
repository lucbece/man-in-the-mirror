import { h, describeSeconds } from '../dom.js';
import { t } from '../i18n.js';
import { SettingsForm, field, chips, switchRow } from '../form.js';

/** How much conversation is kept, offered in round numbers plus whatever is saved. */
const BUFFER_VALUES = [30, 60, 90, 120, 300, 600];

/**
 * Listening: who it answers to, whether it wakes on its name, how much of
 * the call it keeps in memory, and the eager transcription that notices the
 * name in the first place.
 */
export function mount(root) {
  const names = chips({
    name: 'agentNames',
    removeLabel: (value) => t('listening.names.remove', { name: value }),
  });
  const namesField = field({
    label: t('listening.names'),
    control: names.el,
    help: t('listening.names.help'),
    more: { summary: t('listening.names.more.summary'), text: t('listening.names.more.text') },
  });

  const wake = switchRow({ name: 'wakeEnabled', label: t('listening.wake'), help: t('listening.wake.help') });

  const buffer = h('select.select', { name: 'bufferSeconds' });
  const bufferField = field({ label: t('listening.buffer'), control: buffer, help: t('listening.buffer.help') });

  const eager = switchRow({ name: 'eagerTranscription', label: t('listening.eager'), help: t('listening.eager.help') });
  const advanced = h('details.advanced', h('summary', t('listening.advanced')), eager);

  const card = h('div.card', namesField, wake, bufferField, advanced);
  root.append(h('header', h('p', t('listening.intro'))), card);

  function fillBuffer(value) {
    const values = BUFFER_VALUES.includes(value) ? BUFFER_VALUES : [...BUFFER_VALUES, value].sort((a, b) => a - b);
    buffer.replaceChildren(...values.map((v) => new Option(describeSeconds(v), v, false, v === value)));
  }

  function read() {
    return {
      agentNames: names.read().join(', '),
      wakeEnabled: wake.querySelector('input').checked,
      bufferSeconds: Number(buffer.value),
      eagerTranscription: eager.querySelector('input').checked,
    };
  }

  function write(cfg) {
    names.write(
      (cfg.agentNames ?? '')
        .split(',')
        .map((n) => n.trim())
        .filter(Boolean),
    );
    wake.querySelector('input').checked = Boolean(cfg.wakeEnabled);
    fillBuffer(Number(cfg.bufferSeconds));
    eager.querySelector('input').checked = Boolean(cfg.eagerTranscription);
  }

  const form = new SettingsForm({ section: root, read, write });

  return {
    update(state) {
      form.update(state.config);
    },
  };
}
