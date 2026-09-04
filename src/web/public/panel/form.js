import { h, toast } from './dom.js';
import { post } from './api.js';
import { t } from './i18n.js';

/**
 * A settings section's form: reads the controls into a config patch, writes a
 * config into the controls, and keeps the two-second poll from overwriting
 * what someone is typing.
 *
 * Once edited, the section stops taking updates from the server until it is
 * saved or discarded; the save bar appears to say so. That does mean a value
 * changed by voice will not show while there are unsaved edits here, which is
 * the right way round: a half-written config outranks a refresh.
 */
export class SettingsForm {
  /**
   * `section`: the `.section` element, which receives the save bar.
   * `read()`: the patch to POST. `write(cfg)`: fill the controls.
   * `note(patch)`: optional, a sentence for the bar about what saving does.
   */
  constructor({ section, read, write, note = null, onSaved = null }) {
    this.section = section;
    this.read = read;
    this.write = write;
    this.note = note;
    this.onSaved = onSaved;
    this.unsaved = false;
    this.last = null;

    this.noteEl = h('span.note');
    this.bar = h(
      'div.savebar',
      { hidden: true },
      this.noteEl,
      h(
        'div.row',
        h('button.btn.quiet', { type: 'button', onclick: () => this.discard() }, t('form.discard')),
        h('button.btn.primary', { type: 'button', onclick: () => this.save() }, t('form.save')),
      ),
    );
    section.append(this.bar);

    const dirty = (event) => {
      if (event.target.closest?.('.savebar') || event.target.closest?.('[data-live]')) return;
      this.markDirty();
    };
    section.addEventListener('input', dirty);
    section.addEventListener('change', dirty);
  }

  isEditing() {
    const active = document.activeElement;
    return this.unsaved || (active && active !== document.body && this.section.contains(active));
  }

  update(cfg) {
    this.last = cfg;
    if (!this.isEditing()) this.write(cfg);
  }

  markDirty() {
    this.unsaved = true;
    this.bar.hidden = false;
    const extra = this.note?.(this.read());
    this.noteEl.textContent = extra ? `${t('form.unsaved')}. ${extra}` : `${t('form.unsaved')}.`;
  }

  async save() {
    try {
      const result = await post('/api/config', this.read());
      this.unsaved = false;
      this.bar.hidden = true;
      toast(t('form.saved'));
      if (result.config) this.write(result.config);
      this.onSaved?.(result);
    } catch (err) {
      // The typed values stay, protected from the poll, so the error is
      // something to fix rather than something to retype.
      toast(err.message, 'error');
    }
  }

  discard() {
    this.unsaved = false;
    this.bar.hidden = true;
    if (this.last) this.write(this.last);
  }
}

/**
 * Builders for the controls a section is made of. They return elements that
 * use only the component classes; sections never write class names of their
 * own.
 */

export function field({ label, help = null, more = null, control, id = null }) {
  const el = h('div.field');
  if (label) el.append(h('label', { for: id }, label));
  el.append(control);
  if (help) el.append(h('p.help', help));
  if (more) el.append(h('details.more', h('summary', more.summary), h('p', more.text)));
  return el;
}

export function seg({ name, options, value = null }) {
  return h(
    'div.seg',
    { role: 'radiogroup' },
    options.map((opt) =>
      h('label', h('input', { type: 'radio', name, value: opt.value, checked: opt.value === value }), opt.label),
    ),
  );
}

export function selected(segEl) {
  return segEl.querySelector('input:checked')?.value ?? null;
}

export function select({ id, name, options, value = null }) {
  const el = h('select.select', { id, name });
  for (const opt of options) el.append(new Option(opt.label, opt.value, false, opt.value === value));
  return el;
}

export function switchRow({ name, label, help = null, checked = false, live = false }) {
  const input = h('input', { type: 'checkbox', name, checked, role: 'switch' });
  const text = h('span', label);
  if (help) text.append(h('span.help', help));
  return h('label.switch', { data: live ? { live: '1' } : {} }, text, input);
}

export function callout(text, kind = '') {
  return h(`div.callout${kind ? `.${kind}` : ''}`, h('p', text));
}
