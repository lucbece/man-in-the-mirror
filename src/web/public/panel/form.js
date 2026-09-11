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
    // The config as last written into the controls — not merely fetched, but
    // actually rendered, since `update()` skips writing while the section is
    // being edited. This is what customInstructions and notebook are diffed
    // against on save (see save() and src/web/merge-lines.js), so a voice
    // line added while this tab sat open survives instead of being replaced
    // by the stale copy the controls have been showing.
    this.loaded = null;

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
    if (!this.isEditing()) this.writeLoaded(cfg);
  }

  /** write(cfg), and remember it as the base the next save's merge diffs against. */
  writeLoaded(cfg) {
    this.loaded = cfg;
    this.write(cfg);
  }

  markDirty() {
    this.unsaved = true;
    this.bar.hidden = false;
    const extra = this.note?.(this.read());
    this.noteEl.textContent = extra ? `${t('form.unsaved')}. ${extra}` : `${t('form.unsaved')}.`;
  }

  async save() {
    try {
      // `base` says what customInstructions/notebook looked like when this
      // form last wrote them into the controls — the copy the person has
      // been editing on top of. The server merges against it rather than
      // overwriting, so a line the bot learned by voice after that point
      // isn't lost under the panel's stale copy. Sections with neither field
      // just send a `base` the server ignores.
      const patch = this.read();
      if (this.loaded) {
        patch.base = { customInstructions: this.loaded.customInstructions, notebook: this.loaded.notebook };
      }
      const result = await post('/api/config', patch);
      this.unsaved = false;
      this.bar.hidden = true;
      toast(t('form.saved'));
      // Re-render from what was actually saved: with a merge on the server,
      // that can differ from what this save sent (a voice line folded back
      // in), and the person should see the result, not their own request.
      if (result.config) this.writeLoaded(result.config);
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
    if (this.last) this.writeLoaded(this.last);
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

/**
 * A short list of words: Enter or comma commits the typed text as a chip,
 * Backspace on an empty input drops the last one, and each chip carries a
 * `×` button to remove it directly. `removeLabel` is the button's
 * aria-label, either a fixed string or a `(value) => string` for one that
 * names the chip.
 *
 * A change to the set fires a bubbling `input` event on the container, the
 * same event a real `<input>` would fire, so `SettingsForm`'s dirty guard
 * picks it up without knowing chips exist.
 */
export function chips({ name, values = [], removeLabel = 'Remove' }) {
  const list = [...values];
  const typed = h('input', { type: 'text', name, autocomplete: 'off', spellcheck: 'false' });
  const container = h('div.chips');

  const labelFor = (value) => (typeof removeLabel === 'function' ? removeLabel(value) : removeLabel);

  function render() {
    container.replaceChildren(
      ...list.map((value, i) =>
        h(
          'span.chip',
          value,
          h('button', { type: 'button', 'aria-label': labelFor(value), onclick: () => removeAt(i) }, '×'),
        ),
      ),
      typed,
    );
  }

  function notify() {
    container.dispatchEvent(new Event('input', { bubbles: true }));
  }

  function removeAt(i) {
    list.splice(i, 1);
    render();
    typed.focus();
    notify();
  }

  function commit(raw) {
    const value = raw.trim();
    typed.value = '';
    if (!value || list.includes(value)) return;
    list.push(value);
    render();
    notify();
  }

  typed.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ',') {
      event.preventDefault();
      commit(typed.value);
    } else if (event.key === 'Backspace' && !typed.value && list.length) {
      list.pop();
      render();
      notify();
    }
  });
  container.addEventListener('click', (event) => {
    if (event.target === container) typed.focus();
  });

  render();

  return {
    el: container,
    read: () => [...list],
    write(next) {
      list.length = 0;
      list.push(...(next ?? []));
      render();
    },
  };
}
